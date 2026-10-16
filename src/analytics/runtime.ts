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
import { FileObservationSpool, createExclusionFence, synchronizeExclusions } from './observation-exporter.js';
import { ObservationPump } from './observation-pump.js';
import { ValidatedEventRecorder } from './validated-event.js';

const EVIDENCE_WINDOW_MS = 10 * 60_000;
const MAX_EVIDENCE = 2000;
const DEFAULT_INTERVAL_MS = 15_000;
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
    this.health = this.health.then(async () => {
      const observed = observeCapabilities(this.deps.manifests, this.ring, this.deps.now?.() ?? new Date(), statuses);
      await this.publisher.publishCollectionHealth(observed);
    }).catch(() => undefined);
  }

  healthSummary(): CollectionHealthSummary | null { return this.publisher.summary(); }

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
      this.pump.setFence(createExclusionFence(fetched.ids.map(id => ({ id, deviceId: ID_SCOPE_SENTINEL })),
        { recordLimit: () => this.deps.onStatus?.('exclusion_limit_reached') }));
      this.pump.bindCredential();
      this.lastSynced = fetched.revision;
    } catch {
      this.lastSynced = null;
      this.deps.onStatus?.('exclusion_sync_failed'); // replay stays closed until a full synchronization succeeds
    }
  }
}
