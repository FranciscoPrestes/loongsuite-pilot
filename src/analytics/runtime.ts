import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../types/index.js';
import type { CapabilityStatus } from '../deployment/desired-state-reconciler.js';
import type { JobStore } from '../enrichment/job-store.js';
import type { EnrichmentScheduler } from '../enrichment/scheduler.js';
import type { DesiredPolicyClient, EffectiveInstrumentationPolicy } from './desired-policy-client.js';
import { loadCapabilityManifest, type CapabilityManifest } from './capabilities.js';
import type { AgentDefinition } from '../types/deployment.js';
import { observeCapabilities } from './capability-observer.js';
import { registerEnrichmentHandlers } from './enrichment-handlers.js';
import { fetchExclusions } from './exclusion-sync.js';
import { createHealthPublisher, type CollectionHealthSummary, type HealthPublisher } from './health-publisher.js';
import { FileObservationSpool, createExclusionFence, readObservationEnvelope, resolveWorkspacePath, synchronizeExclusions, type ExclusionFence } from './observation-exporter.js';
import { readJsonFile, writeTextFileAtomic } from '../utils/fs-utils.js';
import { resolveEventTimeMs } from './observation-exporter.js';
import type { DeliveredLedger } from './observation-pump.js';
import type { BaseFlusher } from '../flushers/base-flusher.js';
import type { FailedSpanRecord } from '../flushers/otlp-failed-replayer.js';
import { ObservationPump } from './observation-pump.js';
import { ValidatedEventRecorder } from './validated-event.js';

const EVIDENCE_WINDOW_MS = 10 * 60_000;
const MAX_EVIDENCE = 2000;
const DEFAULT_INTERVAL_MS = 15_000;
const LEDGER_MAX_IDS = 20_000;

/** True when the closed interval [startMs, endMs] (source event .. capture) overlaps any [fromMs, toMs) exclusion window. */
export function windowHit(windows: ReadonlyArray<{ fromMs: number; toMs: number }>, startMs: number, endMs: number): boolean {
  const lo = Math.min(startMs, endMs); const hi = Math.max(startMs, endMs);
  return windows.some(w => lo < w.toMs && hi >= w.fromMs);
}

/** File-backed delivered-id ledger (bounded FIFO). Read once, written atomically on flush. */
export function fileLedger(file: string): DeliveredLedger {
  const ids = new Set<string>(); let loaded = false; let dirty = false;
  const load = (): Promise<void> => loaded ? Promise.resolve() : readJsonFile<string[]>(file).then(v => { (Array.isArray(v) ? v : []).forEach(i => ids.add(String(i))); loaded = true; });
  void load().catch(() => undefined);
  return {
    has: id => ids.has(id),
    add: id => { ids.add(id); dirty = true; while (ids.size > LEDGER_MAX_IDS) ids.delete(ids.values().next().value as string); },
    flush: async () => { await load(); if (!dirty) return; dirty = false; await writeTextFileAtomic(file, JSON.stringify([...ids]), { mode: 0o600 }); },
  };
}
const ID_SCOPE_SENTINEL = '\u0000id-scope';

export interface AnalyticsRuntimeDeps {
  dataDir: string; collectorVersion: string; deviceId: string; userId: string; portalBaseUrl: string;
  store: JobStore; scheduler: EnrichmentScheduler; policyClient?: DesiredPolicyClient;
  policy: () => EffectiveInstrumentationPolicy;
  /** Raw Authorization header value (never logged or persisted here). */
  credential: () => string | undefined;
  /** The existing flusher pipeline; a throw means "not delivered" and the observation is spooled. */
  send: (entry: AgentActivityEntry) => Promise<void>;
  manifests: readonly CapabilityManifest[];
  fetch?: typeof fetch; now?: () => Date; intervalMs?: number;
  onStatus?: (reason: string) => void;
}

/** A definition without (or with an invalid) analytics declaration is skipped, never fatal to the others. */
export function tolerantManifests(definitions: readonly AgentDefinition[]): CapabilityManifest[] {
  const manifests: CapabilityManifest[] = [];
  for (const definition of definitions) {
    try { manifests.push(loadCapabilityManifest(definition)); } catch { /* undeclared local definition */ }
  }
  return manifests;
}

/** Only the identity/shape fields the observer needs; message content is never retained. */
function evidenceView(entry: AgentActivityEntry): AgentActivityEntry {
  const view: AgentActivityEntry = {
    time_unix_nano: entry.time_unix_nano, 'event.id': entry['event.id'], 'user.id': '', 'event.name': entry['event.name'],
    'gen_ai.session.id': entry['gen_ai.session.id'], 'gen_ai.agent.type': entry['gen_ai.agent.type'], 'gen_ai.provider.name': '',
  };
  const callId = entry['gen_ai.tool.call.id'];
  if (typeof callId === 'string') view['gen_ai.tool.call.id'] = callId;
  if (typeof entry['gen_ai.usage.total_tokens'] === 'number') view['gen_ai.usage.total_tokens'] = entry['gen_ai.usage.total_tokens'];
  return view;
}

/**
 * Orchestrator-facing assembly of the analytics runtime: handlers on the C4 scheduler, exclusion
 * synchronization, authorized replay through the C7 exporter, validated-event evidence and health.
 * Everything here is fail-open with respect to base capture.
 */
export class AnalyticsRuntime {
  readonly pump: ObservationPump;
  private readonly publisher: HealthPublisher;
  private readonly evidence: ValidatedEventRecorder;
  private readonly ring: AgentActivityEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<void> | null = null;
  private health: Promise<void> = Promise.resolve();
  private evidenceWrite: Promise<void> = Promise.resolve();
  private lastSynced: string | null = null;
  private stopped = false;

  constructor(private readonly deps: AnalyticsRuntimeDeps) {
    this.evidence = new ValidatedEventRecorder(deps.dataDir);
    registerEnrichmentHandlers(deps.scheduler);
    this.pump = new ObservationPump({
      store: deps.store, policy: deps.policy, userId: deps.userId,
      ledger: fileLedger(path.join(deps.dataDir, 'analytics', 'delivered-ids.json')),
      spool: new FileObservationSpool(path.join(deps.dataDir, 'analytics', 'spool')),
      credential: () => { const value = deps.credential(); return value ? createHash('sha256').update(value).digest('hex') : null; },
      transport: { send: async (serialized) => { await deps.send(JSON.parse(serialized) as AgentActivityEntry); return { status: 200 }; } },
    });
    this.publisher = createHealthPublisher({ deviceId: deps.deviceId, userId: deps.userId, collectorVersion: deps.collectorVersion,
      now: deps.now ?? (() => new Date()), policy: deps.policy, losses: () => this.pump.lossSummary() }, deps.send);
  }

  /** Post-mask native entries (InputManager signal): evidence only, no content retained. */
  onEntries(entries: readonly AgentActivityEntry[]): void {
    try {
      const nowMs = (this.deps.now?.() ?? new Date()).getTime();
      for (const entry of entries) {
        this.evidenceWrite = this.evidence.record(entry);
        if (entry['ntconsult.analytics.kind'] === undefined) this.ring.push(evidenceView(entry));
      }
      const cutoff = (nowMs - EVIDENCE_WINDOW_MS) * 1_000_000;
      while (this.ring.length > MAX_EVIDENCE || (this.ring.length > 0 && Number(this.ring[0]!.time_unix_nano) < cutoff)) this.ring.shift();
    } catch { /* evidence is best effort */ }
  }

  /** Reconciler statuses -> D4 observation -> published health (serialized, fail-open). */
  onStatuses(statuses: readonly CapabilityStatus[]): void {
    if (this.stopped) return;
    this.health = this.health.then(async () => {
      // Window by the clock at read time: after idleness old events must not read as "known activity" (D4).
      const now = this.deps.now?.() ?? new Date();
      const cutoff = (now.getTime() - EVIDENCE_WINDOW_MS) * 1_000_000;
      while (this.ring.length > 0 && Number(this.ring[0]!.time_unix_nano) < cutoff) this.ring.shift();
      const observed = observeCapabilities(this.deps.manifests, this.ring, now, statuses);
      await this.publisher.publishCollectionHealth(observed);
    }).catch(() => undefined);
  }

  healthSummary(): CollectionHealthSummary | null { return this.publisher.summary(); }

  /**
   * The flusher's own failed-log replay is a second way out: it must obey the same fence. Analytics records
   * are held (kept untouched) until exclusions are synchronized for the current credential, then fenced.
   * Records without analytics annotations are base telemetry and never touched here.
   */
  replayFence(): { isExcluded: (record: FailedSpanRecord) => boolean; isHeld: (record: FailedSpanRecord) => boolean } {
    const annotated = (record: FailedSpanRecord) => record.attributes?.['ntconsult.analytics.kind'] !== undefined
      || record.attributes?.['ntconsult.analytics.observation'] !== undefined;
    return {
      isHeld: record => annotated(record) && !this.pump.isAuthorized(),
      isExcluded: (record) => {
        if (!annotated(record)) return false;
        const attributes = record.attributes as AgentActivityEntry;
        const envelope = readObservationEnvelope(attributes);
        // An annotated record whose envelope cannot be read cannot be proven outside the fence.
        return envelope === null || this.pump.fenceIsExcluded(envelope.observation, resolveWorkspacePath(attributes),
          Number.isFinite(Number(record.startTimeUnixNano)) ? Number(BigInt(record.startTimeUnixNano) / 1_000_000n) : undefined);
      },
    };
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending?.catch(() => undefined);
    await this.health;
    await this.evidenceWrite;
    this.deps.store.invalidateReplay();
  }

  tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.tickOnce().catch(() => this.deps.onStatus?.('analytics_tick_failed')).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async tickOnce(): Promise<void> {
    const policy = this.deps.policy();
    if (this.stopped || !policy.enrichmentEnabled) return;
    if (!policy.replayEnabled || !this.pump.isBound() || this.lastSynced !== policy.deletionRevision) await this.synchronize();
    await this.pump.drain();
    await this.pump.replaySpool();
  }

  /** Fetch ALL pages of one revision, make them durable deletion authority, only then open replay. */
  private async synchronize(): Promise<void> {
    try {
      const fetched = await fetchExclusions({ baseUrl: this.deps.portalBaseUrl,
        authorization: this.deps.credential, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}) });
      // The store only represents device/session/workspace scopes, so it records the revision (no tombstones);
      // exact-id exclusions are enforced at the single egress, the pump fence, where the sentinel device can
      // never match a real one: only the listed observation ids are excluded, not the whole device.
      await synchronizeExclusions(fetched.revision, [],
        { store: this.deps.store, ...(this.deps.policyClient ? { policy: this.deps.policyClient } : {}) });
      const byId = createExclusionFence(fetched.ids.map(id => ({ id, deviceId: ID_SCOPE_SENTINEL })),
        { recordLimit: () => this.deps.onStatus?.('exclusion_limit_reached') });
      // Window fence over the whole interval source event .. capture: a job parked for days is captured outside
      // the window but its source event is inside it.
      this.pump.setFence({ isExcluded: (observation, context) => byId.isExcluded(observation, context)
        || windowHit(fetched.windows, context?.eventTimeMs ?? Date.parse(observation.occurredAt), Date.parse(observation.occurredAt)) });
      this.pump.bindCredential();
      this.lastSynced = fetched.revision;
    } catch {
      this.lastSynced = null;
      this.deps.onStatus?.('exclusion_sync_failed'); // replay stays closed until a full synchronization succeeds
    }
  }
}

/** Connect the runtime fence to every OTLP flusher that owns a failed-log replay. Returns how many were connected. */
export function connectReplayFence(flusher: BaseFlusher, fence: ReturnType<AnalyticsRuntime['replayFence']>): number {
  const candidates: BaseFlusher[] = typeof (flusher as { getFlushers?: () => BaseFlusher[] }).getFlushers === 'function'
    ? (flusher as unknown as { getFlushers: () => BaseFlusher[] }).getFlushers() : [flusher];
  let connected = 0;
  for (const candidate of candidates) {
    const target = candidate as Partial<{ setReplayExclusionFilter: (f: typeof fence.isExcluded) => void; setReplayHold: (f: typeof fence.isHeld) => void }>;
    if (typeof target.setReplayExclusionFilter === 'function' && typeof target.setReplayHold === 'function') {
      target.setReplayExclusionFilter(fence.isExcluded);
      target.setReplayHold(fence.isHeld);
      connected += 1;
    }
  }
  return connected;
}
