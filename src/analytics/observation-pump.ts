import type { AgentActivityEntry } from '../types/index.js';
import type { Observation } from './observation.js';
import type { EffectiveInstrumentationPolicy } from './desired-policy-client.js';
import type { LossState } from '../enrichment/job-store.js';
import {
  ObservationExporter, attachObservation,
  type ExclusionFence, type ObservationSpool, type ObservationTransport, type ReplayOutcome,
} from './observation-exporter.js';

/** What the pump needs from the C4 store (a JobStore satisfies it structurally). */
export interface ReplaySource {
  replayEntries(limit?: number): Promise<{ observation: Observation; workspacePath: string; signalAt?: string }[]>;
  acknowledge(ids: readonly string[]): Promise<number>;
  losses(): Promise<LossState[]>;
  invalidateReplay(): void;
}
/** Persistent record of delivered observation ids, so a re-seen source event is never re-exported with new content. */
export interface DeliveredLedger { ready?(): Promise<void>; has(id: string): boolean; add(id: string): void; flush(): Promise<void> }
export function memoryLedger(): DeliveredLedger {
  const ids = new Set<string>();
  return { has: id => ids.has(id), add: id => { ids.add(id); }, flush: async () => undefined };
}

export interface ObservationPumpOptions {
  ledger?: DeliveredLedger;
  store: ReplaySource;
  transport: ObservationTransport;
  spool: ObservationSpool;
  policy: () => EffectiveInstrumentationPolicy;
  /** Opaque identity of the credential in use (fingerprint); replay is bound to the one that synchronized exclusions. */
  credential: () => string | null;
  userId?: string;
}
export interface DrainOutcome {
  exported: number; spooled: number; excluded: number; failed: number; duplicates: number;
  blocked: 'not_synchronized' | 'credential_changed' | 'replay_disabled' | null;
}
export interface LossSummary { expired: number; quota: number; busy: number; total: number }

/**
 * Carriers are not harness activity: a harness id here would make every installed-but-unused harness look
 * active in summaries and adoption. The real harness identity lives in the observation payload.
 */
export const COLLECTOR_AGENT_TYPE = 'ntconsult-collector';

/** Failures that retrying can never fix: they are recorded by the exporter and the result is released. */
const PERMANENT_FAILURE = /^(rejected:|redaction|envelope_too_large|missing_envelope)/;

/** Minimal auxiliary carrier for a store result: identity comes from the observation, never from payload text. */
export function carrierFor(o: Observation, workspacePath: string | undefined, userId: string, signalAt?: string): AgentActivityEntry {
  // The entry time is the SOURCE event time when known (capture can happen days later), so fences see the whole interval.
  const signalMs = signalAt ? Date.parse(signalAt) : Number.NaN;
  const at = Number.isFinite(signalMs) ? Math.min(signalMs, Date.parse(o.occurredAt)) : Date.parse(o.occurredAt);
  return {
    time_unix_nano: String(BigInt(at) * 1_000_000n), 'event.id': o.observationId, 'user.id': userId,
    'event.name': 'other', 'gen_ai.session.id': o.sessionId ?? `device:${o.deviceId}`, 'gen_ai.agent.type': COLLECTOR_AGENT_TYPE,
    'gen_ai.provider.name': 'ntconsult-collector', ...(workspacePath ? { 'workspace.path': workspacePath } : {}),
  };
}

/**
 * Drains completed C4 results into the C7 exporter. Authorization (current policy + the credential that
 * synchronized the exclusions) is rechecked immediately before every send; any change invalidates the
 * store's replay gate so a new synchronization is required. The fence is matched against the REAL
 * workspace of each job, never a missing/derived one.
 */
export class ObservationPump {
  private fence: ExclusionFence = { isExcluded: () => false };
  private bound: string | null | undefined;
  private ledger?: DeliveredLedger;
  private readonly exporter: ObservationExporter;

  constructor(private readonly options: ObservationPumpOptions) {
    this.exporter = new ObservationExporter({
      transport: options.transport, spool: options.spool,
      exclusions: { isExcluded: (observation, context) => this.fence.isExcluded(observation, context) },
      authorized: () => this.isAuthorized(),
    });
  }

  /** Called after exclusions were synchronized with the current credential. */
  bindCredential(): void { this.bound = this.options.credential(); }
  isBound(): boolean { return this.bound != null; }
  setFence(fence: ExclusionFence): void { this.fence = fence; }
  fenceIsExcluded(observation: Observation, workspacePath: string | undefined, eventTimeMs?: number): boolean {
    return this.fence.isExcluded(observation, { workspacePath, eventTimeMs });
  }

  /** True only while exclusions are synchronized for the CURRENT credential and policy still allows replay. */
  isAuthorized(): boolean {
    return this.bound != null && this.options.credential() === this.bound && this.options.policy().replayEnabled;
  }

  private block(reason: NonNullable<DrainOutcome['blocked']>): DrainOutcome {
    return { exported: 0, spooled: 0, excluded: 0, failed: 0, duplicates: 0, blocked: reason };
  }

  async drain(limit = 100): Promise<DrainOutcome> {
    if (this.bound === undefined || this.bound === null) return this.block('not_synchronized');
    if (this.options.credential() !== this.bound) {
      this.bound = undefined; this.options.store.invalidateReplay();
      return this.block('credential_changed');
    }
    if (!this.options.policy().replayEnabled) { this.options.store.invalidateReplay(); return this.block('replay_disabled'); }
    const outcome = this.block('replay_disabled'); outcome.blocked = null;
    const done: string[] = [];
    const ledger = this.options.ledger ?? (this.ledger ??= memoryLedger());
    await ledger.ready?.(); // persisted ids must be loaded before the first duplicate check
    for (const { observation, workspacePath, signalAt } of await this.options.store.replayEntries(limit)) {
      if (ledger.has(observation.observationId)) { outcome.duplicates += 1; done.push(observation.observationId); continue; }
      try {
        const entry = attachObservation(carrierFor(observation, workspacePath, this.options.userId ?? observation.deviceId, signalAt), observation);
        const result = await this.exporter.exportWithOutcome(entry);
        if (result.exported) { outcome.exported += 1; ledger.add(observation.observationId); }
        else if (result.spooled) { outcome.spooled += 1; ledger.add(observation.observationId); }
        else if (result.excluded) outcome.excluded += 1;
        else {
          outcome.failed += 1;
          // A transient local failure (e.g. the spool could not persist) keeps the result in the store for the next tick.
          if (!PERMANENT_FAILURE.test(result.failed ?? '')) continue;
        }
      } catch (error) {
        // Redaction that would rewrite identity: fail closed, record, and stop retrying this result.
        outcome.failed += 1;
        await this.options.spool.recordFailure(error instanceof Error ? error.message : String(error), observation.observationId);
      }
      done.push(observation.observationId);
    }
    await ledger.flush().catch(() => undefined);
    if (done.length > 0) await this.options.store.acknowledge(done);
    return outcome;
  }

  replaySpool(limit = 100): Promise<ReplayOutcome> { return this.exporter.replay(limit); }

  async lossSummary(): Promise<LossSummary> {
    const summary: LossSummary = { expired: 0, quota: 0, busy: 0, total: 0 };
    for (const loss of await this.options.store.losses()) { summary[loss.reason] += loss.count; summary.total += loss.count; }
    return summary;
  }
}
