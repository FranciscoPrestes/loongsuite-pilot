import { validateObservation, type Observation } from './observation.js';
import {
  FileObservationSpool,
  sha256hex,
  type ObservationSpool,
} from './observation-spool.js';
import { activeMaskConfig, activeMaskPlan } from '../mask/active-mask.js';
import { maskAgentActivityEntry, sanitizeEnrichedPayload } from '../mask/entry-masker.js';
import {
  ANALYTICS_ANNOTATION_KEYS,
  type AgentActivityEntry,
  type AnalyticsAnnotationKey,
} from '../types/index.js';

export { ANALYTICS_ANNOTATION_KEYS };
export type { AnalyticsAnnotationKey };
// The managed spool lives in its own module; re-exported here for the public
// exporter surface (FileObservationSpool was part of the round-0 contract).
export { FileObservationSpool, MAX_SPOOL_BYTES, sha256hex } from './observation-spool.js';
export type { ObservationSpool } from './observation-spool.js';

/**
 * Sanitized observation exporter — offline replay and central-secret isolation.
 *
 * The exporter NEVER creates any model/LLM client and never holds a central
 * credential: it serializes a collector-generated analytics envelope under the
 * reserved `ntconsult.analytics.*` keys and hands it to an authenticated ingest
 * transport. Authorization, budget and the model stay on the backend; the
 * semantic request is derived centrally from TES evidence, never by asking the
 * developer for commands.
 */
export const ANALYTICS_SCHEMA_VERSION = '1';
export const MAX_ENVELOPE_BYTES = 262_144;

export interface ObservationEnvelope {
  schemaVersion: '1';
  observationId: string;
  kind: Observation['kind'];
  generatedBy: 'collector' | 'analytics';
  observation: Observation;
}

/** Authenticated ingest transport supplied by the deployment (never a model endpoint). */
export interface ObservationTransport {
  send(serialized: string): Promise<{ status: number }>;
}

export interface ExclusionMatchContext {
  /**
   * The true workspace path of the exported entry (`workspace.path` /
   * `workspace.current_root`, the same scope key the C4 JobStore tombstones
   * digest). `Observation.workspaceId` is not produced by any collector
   * pipeline and must not be used as a substitute.
   */
  workspacePath?: string;
  /** Source event time (ms) of the exported entry: may precede `observation.occurredAt` (capture time) by days. */
  eventTimeMs?: number;
}

/** Entry time in ms, or undefined when absent/invalid. */
export function resolveEventTimeMs(entry: AgentActivityEntry): number | undefined {
  try { const ms = Number(BigInt(entry.time_unix_nano) / 1_000_000n); return Number.isSafeInteger(ms) ? ms : undefined; } catch { return undefined; }
}

export interface ExclusionFence {
  /**
   * Scope-aware exclusion check. A scoped tombstone (session/workspace) whose
   * scope cannot be resolved for the observation FAILS CLOSED: unprovable
   * non-exclusion must never resend excluded data.
   */
  isExcluded(observation: Observation, context?: ExclusionMatchContext): boolean;
}

export interface ExclusionFenceOptions {
  /** Recorded when more tombstones arrive than can be tracked (limits reached). */
  recordLimit?: (info: { limit: number; received: number }) => void;
}

export interface ObservationExporterOptions {
  transport: ObservationTransport;
  spool: ObservationSpool;
  exclusions?: ExclusionFence;
  /** Rechecked immediately before every send; authorization must be current. */
  authorized?: () => boolean | Promise<boolean>;
}

export interface ExportOutcome {
  exported: boolean;
  spooled: boolean;
  excluded: boolean;
  failed: string | null;
}

export interface ReplayOutcome {
  sent: string[];
  kept: number;
  excluded: number;
  duplicates: number;
  rejected: number;
}

/** Tombstone as exchanged with the server and synchronized to the device. */
export interface ObservationTombstone {
  id: string;
  deviceId: string;
  sessionId?: string;
  workspacePath?: string;
}

export interface TombstoneSyncTarget {
  synchronizeTombstones(revision: string, tombstones: readonly ObservationTombstone[]): Promise<void> | void;
}

export interface ExclusionSyncTarget {
  markExclusionsSynchronized(revision: string): void;
}

function structuralView(observation: Observation): Record<string, unknown> {
  return {
    schemaVersion: observation.schemaVersion,
    observationId: observation.observationId,
    kind: observation.kind,
    occurredAt: observation.occurredAt,
    harnessId: observation.harnessId,
    harnessVersion: observation.harnessVersion,
    collectorVersion: observation.collectorVersion,
    capabilitiesVersion: observation.capabilitiesVersion,
    deviceId: observation.deviceId,
    // Identity/correlation fields: a mask rewrite here corrupts fence matching
    // or execution correlation, so they are as structural as the ids above.
    sessionId: observation.sessionId,
    workspaceId: observation.workspaceId,
    turnId: observation.turnId,
    parentCallId: observation.parentCallId,
    toolCallId: observation.toolCallId,
    truncated: observation.truncated,
    missingFields: observation.missingFields,
    sourceRefs: observation.sourceRefs,
  };
}

/** First structural field that redaction rewrote, or null when nothing was lost. */
function firstStructuralDifference(before: Observation, after: Observation): string | null {
  const a = structuralView(before);
  const b = structuralView(after);
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return key;
  }
  return null;
}

/**
 * Sanitize an observation for persistence/export. If redaction would rewrite a
 * required structural field the caller must fail closed: never emit a corrupt
 * envelope and never fabricate success.
 */
function sanitizeObservationStrict(observation: Observation): Observation {
  const sanitized = sanitizeEnrichedPayload(observation) as Observation;
  const changed = firstStructuralDifference(observation, sanitized);
  if (changed) throw new Error(`redaction removed required field: ${changed}`);
  return validateObservation(sanitized);
}

/**
 * Attach an analytics observation as reserved additive annotations on a copy of
 * the entry. The input entry (the original native event) is never mutated and
 * stays primary; the auxiliary event is linked back to the originals through
 * the observation's `sourceRefs`. Client identity fields are copied verbatim —
 * auxiliary context, never promoted or merged.
 */
export function attachObservation(entry: AgentActivityEntry, observation: Observation): AgentActivityEntry {
  const stamped = validateObservation({ ...observation, generatedBy: 'analytics' as const });
  const sanitized = sanitizeObservationStrict(stamped);
  const next: AgentActivityEntry = { ...entry };
  for (const key of Object.keys(next)) {
    if (key.startsWith('ntconsult.analytics.')) delete next[key];
  }
  next['ntconsult.analytics.schema_version'] = ANALYTICS_SCHEMA_VERSION;
  next['ntconsult.analytics.observation_id'] = sanitized.observationId;
  next['ntconsult.analytics.kind'] = sanitized.kind;
  next['ntconsult.analytics.observation'] = JSON.stringify(sanitized);
  next['ntconsult.analytics.generated_by'] = 'analytics';
  return next;
}

/** Extract and validate the envelope serialized under `ntconsult.analytics.*`. */
export function readObservationEnvelope(entry: AgentActivityEntry): ObservationEnvelope | null {
  const raw = entry['ntconsult.analytics.observation'];
  const observationId = entry['ntconsult.analytics.observation_id'];
  const kind = entry['ntconsult.analytics.kind'];
  const schemaVersion = entry['ntconsult.analytics.schema_version'];
  const generatedBy = entry['ntconsult.analytics.generated_by'];
  if (typeof raw !== 'string' || typeof observationId !== 'string' || typeof kind !== 'string'
    || schemaVersion !== ANALYTICS_SCHEMA_VERSION) return null;
  try {
    const observation = validateObservation(JSON.parse(raw));
    if (observation.observationId !== observationId || observation.kind !== kind) return null;
    return {
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      observationId,
      kind: observation.kind,
      generatedBy: generatedBy === 'analytics' ? 'analytics' : 'collector',
      observation,
    };
  } catch {
    return null;
  }
}

/** More tombstones than the fence can track: fail closed and record the limit. */
export const MAX_EXCLUSION_TOMBSTONES = 10_000;

/**
 * Exclusion fence over server-recorded tombstones synchronized to the device.
 * Matching mirrors the C4 JobStore (device + optional session/workspace scope,
 * digest keys) and additionally accepts an exact observation-id tombstone. The
 * workspace scope matches the REAL workspace path (`ExclusionMatchContext`);
 * when a scoped tombstone's scope cannot be resolved for the observation the
 * fence fails closed, so excluded data is never resent. More tombstones than
 * `MAX_EXCLUSION_TOMBSTONES` is recorded and fails closed as well.
 */
export function createExclusionFence(
  tombstones: readonly ObservationTombstone[],
  options?: ExclusionFenceOptions,
): ExclusionFence {
  if (tombstones.length > MAX_EXCLUSION_TOMBSTONES) {
    options?.recordLimit?.({ limit: MAX_EXCLUSION_TOMBSTONES, received: tombstones.length });
    return { isExcluded: () => true };
  }
  const stored = tombstones.map((t) => ({
    id: sha256hex(t.id),
    deviceId: sha256hex(t.deviceId),
    sessionId: t.sessionId ? sha256hex(t.sessionId) : undefined,
    workspacePath: t.workspacePath ? sha256hex(t.workspacePath) : undefined,
  }));
  return {
    isExcluded(observation: Observation, context?: ExclusionMatchContext): boolean {
      const observationId = sha256hex(observation.observationId);
      const deviceId = sha256hex(observation.deviceId);
      const sessionResolved = observation.sessionId !== undefined;
      const sessionId = sha256hex(observation.sessionId ?? '');
      const workspace = context?.workspacePath ?? observation.workspaceId;
      const workspaceResolved = workspace !== undefined;
      const workspacePath = sha256hex(workspace ?? '');
      return stored.some((t) => t.id === observationId
        || (t.deviceId === deviceId
          && (!t.sessionId || t.sessionId === sessionId || !sessionResolved)
          && (!t.workspacePath || t.workspacePath === workspacePath || !workspaceResolved)));
    },
  };
}

/**
 * The real workspace scope of an exported entry — the same source the C4
 * `jobFromEntry` uses for `workspacePath`. Never inferred from text or time.
 */
export function resolveWorkspacePath(entry: AgentActivityEntry): string | undefined {
  const value = entry['workspace.path'] ?? entry['workspace.current_root'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Apply a fetched exclusion page set on the device: durable deletion authority
 * first (managed spool records only), then — and only then — the replay gate.
 * The caller owns fetching ALL tombstone pages for the revision before this.
 */
export async function synchronizeExclusions(
  revision: string,
  tombstones: readonly ObservationTombstone[],
  targets: { store?: TombstoneSyncTarget; policy?: ExclusionSyncTarget },
  options?: ExclusionFenceOptions,
): Promise<ExclusionFence> {
  await targets.store?.synchronizeTombstones(revision, tombstones);
  targets.policy?.markExclusionsSynchronized(revision);
  return createExclusionFence(tombstones, options);
}

export class ObservationExporter {
  constructor(private readonly options: ObservationExporterOptions) {}

  /** The brief's export interface: fail-open, never throws, never blocks the hook. */
  async exportObservation(entry: AgentActivityEntry): Promise<void> {
    await this.exportWithOutcome(entry);
  }

  async exportWithOutcome(entry: AgentActivityEntry): Promise<ExportOutcome> {
    const outcome: ExportOutcome = { exported: false, spooled: false, excluded: false, failed: null };
    try {
      const envelope = readObservationEnvelope(entry);
      if (!envelope) {
        outcome.failed = 'missing_envelope';
        await this.options.spool.recordFailure(outcome.failed, null);
        return outcome;
      }
      // Mask before any enriched payload is persisted or exported.
      const masked = maskAgentActivityEntry(entry, activeMaskConfig(), activeMaskPlan());
      const maskedEnvelope = readObservationEnvelope(masked);
      if (!maskedEnvelope) {
        outcome.failed = 'redaction_unparseable_envelope';
        await this.options.spool.recordFailure(outcome.failed, envelope.observationId);
        return outcome;
      }
      const changed = firstStructuralDifference(envelope.observation, maskedEnvelope.observation);
      if (changed) {
        outcome.failed = `redaction_removed_required_field:${changed}`;
        await this.options.spool.recordFailure(outcome.failed, envelope.observationId);
        return outcome;
      }
      const serialized = JSON.stringify(masked);
      if (Buffer.byteLength(serialized) > MAX_ENVELOPE_BYTES) {
        outcome.failed = 'envelope_too_large';
        await this.options.spool.recordFailure(outcome.failed, envelope.observationId);
        return outcome;
      }
      if (this.options.exclusions?.isExcluded(maskedEnvelope.observation, { workspacePath: resolveWorkspacePath(masked), eventTimeMs: resolveEventTimeMs(masked) })) {
        outcome.excluded = true;
        return outcome;
      }
      if (this.options.authorized && !(await this.options.authorized())) {
        await this.options.spool.persist(serialized);
        outcome.spooled = true;
        return outcome;
      }
      let status: number;
      try {
        status = (await this.options.transport.send(serialized)).status;
      } catch {
        // Offline / transport failure is persisted without blocking the caller.
        await this.options.spool.persist(serialized);
        outcome.spooled = true;
        return outcome;
      }
      if (status >= 200 && status < 300) {
        outcome.exported = true;
        return outcome;
      }
      if (status === 400 || status === 404 || status === 422) {
        outcome.failed = `rejected:${status}`;
        await this.options.spool.recordFailure(outcome.failed, envelope.observationId);
        return outcome;
      }
      await this.options.spool.persist(serialized);
      outcome.spooled = true;
      return outcome;
    } catch (error) {
      outcome.failed = error instanceof Error ? error.message : String(error);
      await this.options.spool.recordFailure(outcome.failed, null);
      return outcome;
    }
  }

  /**
   * Offline replay of the managed spool. Observation identity is preserved
   * byte-for-byte (consumers dedupe on it); excluded records are removed from
   * the managed spool only and never resent; a record is sent at most once per
   * run even when a crash left duplicates behind.
   */
  async replay(limit = 100): Promise<ReplayOutcome> {
    const outcome: ReplayOutcome = { sent: [], kept: 0, excluded: 0, duplicates: 0, rejected: 0 };
    const queue = (await this.options.spool.pending()).slice(0, Math.max(0, Math.min(100, limit)));
    const seen = new Set<string>();
    for (const serialized of queue) {
      let observationId: string | null = null;
      try {
        const entry = JSON.parse(serialized) as AgentActivityEntry;
        const envelope = readObservationEnvelope(entry);
        if (!envelope) throw new Error('unparseable spool record');
        observationId = envelope.observationId;
        if (this.options.exclusions?.isExcluded(envelope.observation, { workspacePath: resolveWorkspacePath(entry), eventTimeMs: resolveEventTimeMs(entry) })) {
          await this.options.spool.remove(serialized);
          outcome.excluded += 1;
          continue;
        }
        if (seen.has(envelope.observationId)) {
          await this.options.spool.remove(serialized);
          outcome.duplicates += 1;
          continue;
        }
        if (this.options.authorized && !(await this.options.authorized())) {
          outcome.kept += 1;
          continue;
        }
        let status: number;
        try {
          status = (await this.options.transport.send(serialized)).status;
        } catch {
          outcome.kept += 1;
          continue;
        }
        if (status >= 200 && status < 300) {
          seen.add(envelope.observationId);
          await this.options.spool.remove(serialized);
          outcome.sent.push(serialized);
        } else if (status === 400 || status === 404 || status === 422) {
          await this.options.spool.remove(serialized);
          outcome.rejected += 1;
          await this.options.spool.recordFailure(`rejected:${status}`, envelope.observationId);
        } else {
          outcome.kept += 1;
        }
      } catch (error) {
        await this.options.spool.remove(serialized).catch(() => undefined);
        outcome.rejected += 1;
        await this.options.spool.recordFailure(error instanceof Error ? error.message : String(error), observationId);
      }
    }
    return outcome;
  }
}

let defaultExporter: ObservationExporter | null = null;

/** Configure the process-wide exporter (runtime wiring is C8's). */
export function configureObservationExporter(options: ObservationExporterOptions): ObservationExporter {
  defaultExporter = new ObservationExporter(options);
  return defaultExporter;
}

/** The brief's interface. Fail-open when not yet configured: never blocks. */
export async function exportObservation(entry: AgentActivityEntry): Promise<void> {
  await defaultExporter?.exportObservation(entry);
}
