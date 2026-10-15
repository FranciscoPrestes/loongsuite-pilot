import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateObservation, type Observation } from './observation.js';
import { maskAgentActivityEntry, sanitizeEnrichedPayload } from '../mask/entry-masker.js';
import {
  ANALYTICS_ANNOTATION_KEYS,
  SUPPORTED_MASK_TYPES,
  type AgentActivityEntry,
  type AnalyticsAnnotationKey,
  type MaskConfig,
} from '../types/index.js';

export { ANALYTICS_ANNOTATION_KEYS };
export type { AnalyticsAnnotationKey };

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

/** Managed spool for offline replay. Only this spool is ever removed by exclusions. */
export interface ObservationSpool {
  persist(serialized: string): Promise<void>;
  pending(): Promise<string[]>;
  remove(serialized: string): Promise<void>;
  recordFailure(reason: string, observationId: string | null): Promise<void>;
}

export interface ExclusionFence {
  isExcluded(observation: Observation): boolean;
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

const EXPORT_MASK_CONFIG: MaskConfig = {
  mode: 'all',
  types: [...SUPPORTED_MASK_TYPES],
  replacementMode: 'placeholder',
};

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

/** The full managed-spool file set of an exporter run (failures never block). */
export class FileObservationSpool implements ObservationSpool {
  private readonly recordsPath: string;
  private readonly failuresPath: string;

  constructor(dir: string) {
    this.recordsPath = path.join(dir, 'observations.jsonl');
    this.failuresPath = path.join(dir, 'failures.jsonl');
  }

  private async ready(): Promise<void> {
    await fs.mkdir(path.dirname(this.recordsPath), { recursive: true, mode: 0o700 });
  }

  async persist(serialized: string): Promise<void> {
    await this.ready();
    const stat = await fs.lstat(this.recordsPath).catch(() => null);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('unsafe spool record');
    if ((stat?.size ?? 0) + Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw new Error('spool full');
    await fs.appendFile(this.recordsPath, serialized + '\n', { mode: 0o600 });
  }

  async pending(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.recordsPath, 'utf8');
      return raw.split('\n').filter((line) => line.trim() !== '');
    } catch {
      return [];
    }
  }

  async remove(serialized: string): Promise<void> {
    const remaining = await this.pending();
    const index = remaining.indexOf(serialized);
    if (index < 0) return;
    remaining.splice(index, 1);
    const tmp = `${this.recordsPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, remaining.length > 0 ? remaining.join('\n') + '\n' : '', { mode: 0o600 });
    await fs.rename(tmp, this.recordsPath);
  }

  async recordFailure(reason: string, observationId: string | null): Promise<void> {
    try {
      await this.ready();
      await fs.appendFile(this.failuresPath,
        JSON.stringify({ reason, observationId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch { /* failure records never block anything */ }
  }
}

/**
 * Exclusion fence over server-recorded tombstones synchronized to the device.
 * Matching mirrors the C4 JobStore (device + optional session/workspace scope)
 * and additionally accepts an exact observation-id tombstone.
 */
export function createExclusionFence(tombstones: readonly ObservationTombstone[]): ExclusionFence {
  const stored = tombstones.slice(0, 10_000).map((t) => ({
    id: sha256hex(t.id),
    deviceId: sha256hex(t.deviceId),
    sessionId: t.sessionId ? sha256hex(t.sessionId) : undefined,
    workspacePath: t.workspacePath ? sha256hex(t.workspacePath) : undefined,
  }));
  return {
    isExcluded(observation: Observation): boolean {
      const observationId = sha256hex(observation.observationId);
      const deviceId = sha256hex(observation.deviceId);
      const sessionId = sha256hex(observation.sessionId ?? '');
      const workspacePath = sha256hex(observation.workspaceId ?? '');
      return stored.some((t) => t.id === observationId
        || (t.deviceId === deviceId
          && (!t.sessionId || t.sessionId === sessionId)
          && (!t.workspacePath || t.workspacePath === workspacePath)));
    },
  };
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
): Promise<ExclusionFence> {
  await targets.store?.synchronizeTombstones(revision, tombstones);
  targets.policy?.markExclusionsSynchronized(revision);
  return createExclusionFence(tombstones);
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
      const masked = maskAgentActivityEntry(entry, EXPORT_MASK_CONFIG);
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
      if (this.options.exclusions?.isExcluded(maskedEnvelope.observation)) {
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
        const envelope = readObservationEnvelope(JSON.parse(serialized) as AgentActivityEntry);
        if (!envelope) throw new Error('unparseable spool record');
        observationId = envelope.observationId;
        if (this.options.exclusions?.isExcluded(envelope.observation)) {
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
