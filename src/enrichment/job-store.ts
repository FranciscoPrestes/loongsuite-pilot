import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';
import { validateObservation, type Observation } from '../analytics/observation.js';
import { operationalRevision, type EffectiveInstrumentationPolicy } from '../analytics/desired-policy-client.js';
import { digest, jobKey, jobSchema, maskEvidence, prepareJob, type LocalJob, type ObservationKind } from './job-contract.js';

export interface QueueConfig { timeoutMs: number; maxAgeDays: number; maxSpoolBytes: number }
export const DEFAULT_QUEUE_CONFIG: QueueConfig = { timeoutMs: 2000, maxAgeDays: 7, maxSpoolBytes: 268435456 };
export interface JobStoreOptions { now?: () => number; policy: () => EffectiveInstrumentationPolicy; maxAgeDays?: number; maxSpoolBytes?: number }

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
/** Strict whole-record schema: a journal is accepted only in this exact shape. */
const recordSchema = z.object({
  key: hex64,
  job: jobSchema,
  state: z.enum(['pending', 'leased', 'complete', 'dead']),
  leaseUntil: z.number().finite().optional(),
  result: z.unknown().optional(),
}).strict().refine(value => (value.state === 'complete') === (value.result !== undefined), { message: 'result state mismatch' });
interface JournalRecord {
  key: string;
  job: LocalJob;
  state: 'pending' | 'leased' | 'complete' | 'dead';
  leaseUntil?: number;
  result?: Observation;
}

export interface LossState { reason: 'expired' | 'quota'; count: number; from: string; to: string; unreported: false }
const lossSchema = z.object({
  reason: z.enum(['expired', 'quota']), count: z.number().int().positive(),
  from: z.string().min(1), to: z.string().min(1), unreported: z.literal(false),
}).strict();

const tombstoneSchema = z.object({ id: z.string().min(1).max(500), deviceId: z.string().min(1).max(500), sessionId: z.string().min(1).max(500).optional(), workspacePath: z.string().max(4096).optional() }).strict();
export type Tombstone = z.infer<typeof tombstoneSchema>;

const exclusionEntrySchema = z.object({ id: hex64, deviceId: hex64, sessionId: hex64.optional(), workspacePath: hex64.optional() }).strict();
const exclusionsSchema = z.object({ revision: z.string().min(1).max(500).nullable(), tombstones: z.array(exclusionEntrySchema).max(10000) }).strict();
type Exclusions = z.infer<typeof exclusionsSchema>;

const usageSchema = z.object({ bytes: z.number().int().nonnegative() }).strict();
const idIndexSchema = z.object({ key: hex64 }).strict();

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_QUARANTINED = 20;
const TMP_NAME = /^\.[a-f0-9-]{36}\.tmp$/;
const JOURNAL_NAME = /^[a-f0-9]{64}\.json$/;

/**
 * Private atomic per-job journals. Result and lease transitions are one
 * fsync+rename. Quota bytes cover journals plus the derived id index; the
 * control plane (queue lock, exclusions, loss manifest, bounded quarantine) is
 * a separate bounded reserve and is never counted as a hard overall disk bound.
 *
 * Steady-state enqueue/complete/retry/claim bookkeeping is bounded: O(1) lookups
 * through the per-job id index and the durable usage reservation. The full spool
 * scan runs only in worker maintenance and in crash recovery (once per instance,
 * before its first operation).
 */
export class JobStore {
  readonly config: QueueConfig;
  private readonly root: string;
  private readonly idsDir: string;
  private readonly quarantineDir: string;
  private readonly now: () => number;
  // Session-scoped: restart or credential rotation must synchronize again before replay.
  private synchronizedRevision: string | null = null;
  private recovered = false;
  private exclusionsUntrusted = false;
  private exclusionsCache: { mtimeMs: number; size: number; data: Exclusions } | null = null;

  constructor(dataDir: string, private readonly options: JobStoreOptions) {
    this.root = path.join(dataDir, 'enrichment');
    this.idsDir = path.join(this.root, 'ids');
    this.quarantineDir = path.join(this.root, 'quarantine');
    this.now = options.now ?? Date.now;
    this.config = { ...DEFAULT_QUEUE_CONFIG, maxAgeDays: options.maxAgeDays ?? 7, maxSpoolBytes: options.maxSpoolBytes ?? 268435456 };
    if (!Number.isInteger(this.config.maxSpoolBytes) || this.config.maxSpoolBytes <= 0 || this.config.maxSpoolBytes > 268435456 || !Number.isFinite(this.config.maxAgeDays) || this.config.maxAgeDays <= 0 || this.config.maxAgeDays > 7) throw new Error('invalid queue limits');
  }

  private ensure(): void {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe queue directory');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('queue directory must be private');
    fs.accessSync(this.root, fs.constants.W_OK);
  }

  private async locked<T>(operation: () => T): Promise<T> {
    this.ensure();
    const deadline = Date.now() + 80;
    while (true) {
      const { lock, error } = acquireSingleInstanceLock(path.join(this.root, 'queue.lock'));
      if (lock) {
        try {
          // Crash recovery lives in the worker side: one bounded rebuild per
          // instance, before any operation trusts the derived bookkeeping.
          if (!this.recovered) { this.recoverLocked(); this.recovered = true; }
          return operation();
        } finally { lock.release(); }
      }
      if (error) throw error;
      if (Date.now() >= deadline) throw new Error('queue busy');
      await new Promise(r => setTimeout(r, 5));
    }
  }

  private file(name: string): string { return path.join(this.root, name); }
  private idFile(id: string): string { return path.join(this.idsDir, digest(id) + '.json'); }
  private fileBytes(file: string): number {
    try { return fs.lstatSync(file).size; } catch { return 0; }
  }

  /** Atomic durable write for source-of-truth records (journals, loss manifest, tombstones). */
  private write(name: string, value: unknown): void {
    const file = this.file(name);
    const tmp = this.file('.' + randomUUID() + '.tmp');
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(tmp, file);
      if (process.platform !== 'win32') {
        const dir = fs.openSync(this.root, 'r');
        try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      }
    } finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
  }

  /**
   * Derived bookkeeping (quota usage, id index) is rebuildable by recovery, so
   * it needs only atomic visibility, not power-loss durability. Reservations are
   * written before the artifacts they account for; releases after. A crash can
   * therefore only overcount until recovery recomputes, never undercount.
   */
  private writeDerived(file: string, value: unknown): void {
    const tmp = path.join(path.dirname(file), '.' + randomUUID() + '.tmp');
    try { fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
    finally { try { fs.unlinkSync(tmp); } catch { /* renamed */ } }
  }

  private readBounded(file: string): unknown {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw new Error('unsafe queue record');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** Quarantine keeps corrupt bytes as evidence; it never follows a link to its target. */
  private quarantine(file: string): boolean {
    try {
      fs.mkdirSync(this.quarantineDir, { recursive: true, mode: 0o700 });
      const stamped = fs.readdirSync(this.quarantineDir).filter(f => f.endsWith('.json')).sort();
      while (stamped.length >= MAX_QUARANTINED) {
        try { fs.unlinkSync(path.join(this.quarantineDir, stamped.shift()!)); } catch { /* already gone */ }
      }
      fs.renameSync(file, path.join(this.quarantineDir, `${Date.now()}-${path.basename(file)}`));
      return true;
    } catch { return false; }
  }

  private readRecord(key: string): JournalRecord | null {
    const file = this.file(key + '.json');
    try {
      const parsed = recordSchema.parse(this.readBounded(file)) as JournalRecord;
      if (parsed.key !== key) throw new Error('invalid queue journal');
      if (parsed.result !== undefined) validateObservation(parsed.result);
      return parsed;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // A corrupt journal is quarantined, never trusted and never crash the store.
      if (!this.quarantine(file)) throw new Error('corrupt queue journal');
      return null;
    }
  }

  private records(): JournalRecord[] {
    return fs.readdirSync(this.root)
      .filter(f => JOURNAL_NAME.test(f))
      .map(f => this.readRecord(f.slice(0, -5)))
      .filter((r): r is JournalRecord => r !== null);
  }

  private readIdIndex(id: string): string | null {
    const file = this.idFile(id);
    try { return idIndexSchema.parse(this.readBounded(file)).key; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.quarantine(file);
      return null;
    }
  }

  /** Rebuilds the derived id index and quota usage from the journals (source of truth). */
  private recoverLocked(): void {
    fs.mkdirSync(this.idsDir, { recursive: true, mode: 0o700 });
    const kept = new Map<string, JournalRecord>();
    const byId = new Map<string, JournalRecord>();
    for (const name of fs.readdirSync(this.root)) {
      if (TMP_NAME.test(name)) { try { fs.unlinkSync(this.file(name)); } catch { /* residue */ } continue; }
      if (!JOURNAL_NAME.test(name)) continue;
      const record = this.readRecord(name.slice(0, -5));
      if (!record) continue;
      const duplicate = byId.get(record.job.id);
      if (duplicate) {
        // Two journals must never publish the same observation id. Keep one
        // deterministically and quarantine the loser instead of double-publishing.
        const winner = record.key < duplicate.key ? record : duplicate;
        const loser = record.key < duplicate.key ? duplicate : record;
        kept.delete(loser.key);
        kept.set(winner.key, winner);
        byId.set(winner.job.id, winner);
        this.quarantine(this.file(loser.key + '.json'));
        continue;
      }
      kept.set(record.key, record);
      byId.set(record.job.id, record);
    }
    const owners = new Map<string, string>();
    for (const record of kept.values()) owners.set(digest(record.job.id), record.key);
    for (const name of fs.readdirSync(this.idsDir)) {
      const file = path.join(this.idsDir, name);
      if (TMP_NAME.test(name)) { try { fs.unlinkSync(file); } catch { /* residue */ } continue; }
      if (!JOURNAL_NAME.test(name)) continue;
      let key: string | null = null;
      try { key = idIndexSchema.parse(this.readBounded(file)).key; }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.quarantine(file);
        continue;
      }
      if (owners.get(name.slice(0, -5)) !== key) fs.unlinkSync(file);
    }
    for (const [idDigest, key] of owners) {
      const file = path.join(this.idsDir, idDigest + '.json');
      if (this.readIdIndexKey(file) !== key) this.writeDerived(file, { key });
    }
    this.writeDerived(this.file('usage.json'), { bytes: this.sumSpoolBytes() });
  }

  private readIdIndexKey(file: string): string | null {
    try { return idIndexSchema.parse(this.readBounded(file)).key; } catch { return null; }
  }

  /** Exact quota accounting over journals plus id index (crash-recovery recompute). */
  private sumSpoolBytes(): number {
    let total = 0;
    for (const name of fs.readdirSync(this.root)) if (JOURNAL_NAME.test(name)) total += this.fileBytes(this.file(name));
    for (const name of fs.readdirSync(this.idsDir)) if (JOURNAL_NAME.test(name)) total += this.fileBytes(path.join(this.idsDir, name));
    return total;
  }

  private usageLocked(): number {
    try { return usageSchema.parse(this.readBounded(this.file('usage.json'))).bytes; }
    catch { return this.sumSpoolBytes(); }
  }

  /** Reserve-before-write when growing; the loss manifest records quota rejections. */
  private reserveLocked(bytes: number, lossJob: LocalJob | null): void {
    const usage = this.usageLocked();
    if (lossJob && usage + bytes > this.config.maxSpoolBytes) {
      this.loss('quota', [lossJob]);
      throw new Error('queue quota exceeded');
    }
    this.writeDerived(this.file('usage.json'), { bytes: usage + bytes });
  }

  private releaseLocked(bytes: number): void {
    this.writeDerived(this.file('usage.json'), { bytes: Math.max(0, this.usageLocked() - bytes) });
  }

  private commitJournalLocked(key: string, record: JournalRecord, lossJob: LocalJob | null): void {
    const delta = Buffer.byteLength(JSON.stringify(record)) - this.fileBytes(this.file(key + '.json'));
    if (delta > 0) this.reserveLocked(delta, lossJob);
    this.write(key + '.json', record);
    if (delta < 0) this.releaseLocked(-delta);
  }

  private deleteRecordLocked(record: JournalRecord): void {
    const journal = this.file(record.key + '.json');
    const idFile = this.idFile(record.job.id);
    let freed = this.fileBytes(journal);
    fs.unlinkSync(journal);
    if (this.readIdIndex(record.job.id) === record.key) {
      freed += this.fileBytes(idFile);
      fs.unlinkSync(idFile);
    }
    if (freed > 0) this.releaseLocked(freed);
  }

  private readLosses(): LossState[] {
    try { return z.array(lossSchema).parse(this.readBounded(this.file('loss-manifest.json'))); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private loss(reason: LossState['reason'], jobs: LocalJob[]): void {
    // Strict read: an unusable loss manifest must fail closed and block any
    // discard, never be healed into a fresh manifest that drops earlier losses.
    const losses = this.readLosses();
    const dates = jobs.map(j => j.occurredAt).sort();
    const old = losses.find(l => l.reason === reason);
    const next: LossState = {
      reason,
      count: (old?.count ?? 0) + jobs.length,
      from: [old?.from, ...dates].filter((v): v is string => !!v).sort()[0]!,
      to: [old?.to, ...dates].filter((v): v is string => !!v).sort().at(-1)!,
      unreported: false,
    };
    this.write('loss-manifest.json', [...losses.filter(l => l.reason !== reason), next]);
  }

  private maintainLocked(now: number): void {
    const expired = this.records().filter(r => Date.parse(r.job.occurredAt) < now - this.config.maxAgeDays * 86400000);
    if (expired.length) {
      // D5: the loss manifest is durably recorded before any expired spool is discarded.
      this.loss('expired', expired.map(r => r.job));
      for (const r of expired) this.deleteRecordLocked(r);
    }
    // A crashed atomic write never owns source data. Only our named temp files are removed.
    for (const name of fs.readdirSync(this.root)) if (TMP_NAME.test(name)) { try { fs.unlinkSync(this.file(name)); } catch { /* residue */ } }
    for (const name of fs.readdirSync(this.idsDir)) if (TMP_NAME.test(name)) { try { fs.unlinkSync(path.join(this.idsDir, name)); } catch { /* residue */ } }
  }

  async maintain(now = this.now()): Promise<void> { await this.locked(() => this.maintainLocked(now)); }

  async enqueue(value: LocalJob): Promise<'created' | 'existing'> {
    const job = prepareJob(value);
    if (job.leaseToken || job.attempt !== 0) throw new Error('new job cannot carry lease or attempt');
    return this.locked(() => {
      const time = Date.parse(job.occurredAt);
      if (time > this.now() + 300000) throw new Error('future occurrence');
      if (time < this.now() - this.config.maxAgeDays * 86400000) {
        this.loss('expired', [job]);
        throw new Error('expired signal');
      }
      const key = jobKey(job);
      if (this.excluded(job) || this.readRecord(key)) return 'existing';
      const conflictKey = this.readIdIndex(job.id);
      if (conflictKey) {
        if (this.readRecord(conflictKey)) throw new Error('job id conflict');
        // Pointer orphaned by a crash between index and journal writes.
      }
      const record: JournalRecord = { key, job, state: 'pending' };
      const indexBytes = Buffer.byteLength(JSON.stringify({ key }));
      this.reserveLocked(Buffer.byteLength(JSON.stringify(record)) + indexBytes, job);
      this.writeDerived(this.idFile(job.id), { key });
      this.write(key + '.json', record);
      return 'created';
    });
  }

  async claim(now: number, leaseMs: number, kinds?: readonly ObservationKind[]): Promise<LocalJob | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 10000) throw new Error('invalid lease');
    return this.locked(() => {
      this.maintainLocked(now);
      if (!this.options.policy().enrichmentEnabled) return null;
      let exclusions: Exclusions;
      // Corrupt tombstone state fails closed: the worker idles until C7 reinstalls it.
      try { exclusions = this.exclusions(); } catch { return null; }
      for (const r of this.records()) {
        if ((kinds && !kinds.includes(r.job.kind)) || this.excluded(r.job, exclusions) || r.job.notBefore > now
          || r.state === 'complete' || r.state === 'dead' || (r.state === 'leased' && (r.leaseUntil ?? 0) > now)) continue;
        const job = { ...r.job, leaseToken: randomUUID() };
        this.commitJournalLocked(r.key, { ...r, job, state: 'leased', leaseUntil: now + leaseMs }, null);
        return job;
      }
      return null;
    });
  }

  private claimed(id: string, token: string): JournalRecord {
    const key = this.readIdIndex(id);
    const record = key ? this.readRecord(key) : null;
    if (!record || record.job.id !== id || !token || record.job.leaseToken !== token
      || (record.state !== 'leased' && record.state !== 'complete')
      || (record.state === 'leased' && (record.leaseUntil ?? 0) <= this.now())) throw new Error('stale lease');
    return record;
  }

  async complete(id: string, value: Observation, leaseToken: string): Promise<void> {
    const observation = validateObservation(maskEvidence(validateObservation(value)));
    if (Buffer.byteLength(JSON.stringify(observation)) > 65536) throw new Error('observation too large');
    await this.locked(() => {
      const r = this.claimed(id, leaseToken);
      if (r.state === 'complete') return;
      if (!this.options.policy().enrichmentEnabled || this.excluded(r.job)) throw new Error('enrichment disabled');
      if (observation.observationId !== id || observation.kind !== r.job.kind || observation.deviceId !== r.job.deviceId
        || observation.sessionId !== r.job.sessionId || observation.occurredAt !== r.job.occurredAt
        || observation.harnessId !== r.job.harnessId || observation.harnessVersion !== r.job.harnessVersion
        || observation.collectorVersion !== r.job.collectorVersion || observation.capabilitiesVersion !== r.job.capabilitiesVersion
        || (observation.toolCallId ?? null) !== r.job.nativeCallId || observation.turnId !== r.job.turnId
        || observation.parentCallId !== r.job.parentCallId || JSON.stringify(observation.sourceRefs) !== JSON.stringify(r.job.sourceRefs)) {
        throw new Error('observation provenance mismatch');
      }
      this.commitJournalLocked(r.key, { ...r, state: 'complete', result: observation }, r.job);
    });
  }

  async retry(id: string, token: string): Promise<void> {
    await this.locked(() => {
      const r = this.claimed(id, token);
      if (r.state === 'complete') return;
      const attempt = r.job.attempt + 1;
      this.commitJournalLocked(r.key, {
        ...r,
        state: attempt >= 5 ? 'dead' : 'pending',
        job: { ...r.job, attempt, leaseToken: undefined, notBefore: this.now() + Math.min(60000, 1000 * 2 ** attempt) },
        leaseUntil: undefined,
      }, null);
    });
  }

  async losses(): Promise<LossState[]> { return this.locked(() => this.readLosses()); }

  /** Only the authenticated C7 deletion synchronizer may call this after fetching current exclusions. */
  async synchronizeTombstones(revision: string, values: readonly Tombstone[]): Promise<void> {
    operationalRevision(revision);
    if (values.length > 10000) throw new Error('too many tombstones');
    const parsed = values.map(v => tombstoneSchema.parse(v));
    await this.locked(() => {
      const policy = this.options.policy();
      if (!policy.enrichmentEnabled || policy.deletionRevision !== revision) throw new Error('exclusion revision mismatch');
      // A quarantined corrupt tombstone state loses no authority: the server
      // pages for the current revision are the durable source and reinstall it.
      const previous = this.exclusionsUntrusted ? { revision: null, tombstones: [] } : this.exclusions();
      if (previous.revision && operationalRevision(revision) < operationalRevision(previous.revision)) throw new Error('exclusion revision regression');
      const map = new Map(previous.tombstones.map(t => [t.id, t]));
      for (const t of parsed) map.set(digest(t.id), {
        id: digest(t.id),
        deviceId: digest(t.deviceId),
        ...(t.sessionId ? { sessionId: digest(t.sessionId) } : {}),
        ...(t.workspacePath ? { workspacePath: digest(t.workspacePath) } : {}),
      });
      if (map.size > 10000) throw new Error('tombstone capacity exceeded');
      const exclusions: Exclusions = { revision, tombstones: [...map.values()] };
      this.write('exclusions.json', exclusions); // Durable authority precedes deletion, including crash recovery.
      this.exclusionsCache = null;
      this.exclusionsUntrusted = false;
      for (const r of this.records()) if (this.excluded(r.job, exclusions)) this.deleteRecordLocked(r);
      if (this.options.policy().deletionRevision !== revision) throw new Error('exclusion revision changed');
      this.synchronizedRevision = revision;
    });
  }

  invalidateReplay(): void { this.synchronizedRevision = null; }

  async replayBatch(limit = 100): Promise<Observation[]> {
    return this.locked(() => {
      const p = this.options.policy();
      if (!p.replayEnabled || !p.deletionRevision || this.synchronizedRevision !== p.deletionRevision) return [];
      let exclusions: Exclusions;
      try { exclusions = this.exclusions(); } catch { return []; }
      if (exclusions.revision !== p.deletionRevision) return [];
      this.maintainLocked(this.now());
      return this.records()
        .filter(r => r.state === 'complete' && r.result && !this.excluded(r.job, exclusions))
        .slice(0, Math.max(0, Math.min(100, limit)))
        .map(r => r.result!);
    });
  }

  private exclusions(): Exclusions {
    const file = this.file('exclusions.json');
    try {
      const stat = fs.lstatSync(file);
      const cached = this.exclusionsCache;
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.data;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) throw new Error('unsafe queue record');
      const data = exclusionsSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))) as Exclusions;
      this.exclusionsCache = { mtimeMs: stat.mtimeMs, size: stat.size, data };
      return data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.exclusionsCache = null;
        // Once tombstone state is known-corrupt it stays fail-closed (even after
        // quarantine removed the file) until the synchronizer reinstalls it.
        if (this.exclusionsUntrusted) throw new Error('exclusions unavailable');
        return { revision: null, tombstones: [] };
      }
      // Corrupt tombstone state is quarantined and fails closed until the C7
      // synchronizer reinstalls the current revision.
      this.quarantine(file);
      this.exclusionsCache = null;
      this.exclusionsUntrusted = true;
      throw new Error('exclusions unavailable');
    }
  }

  private excluded(job: LocalJob, exclusions = this.exclusions()): boolean {
    return exclusions.tombstones.some(t => t.deviceId === digest(job.deviceId)
      && (!t.sessionId || t.sessionId === digest(job.sessionId))
      && (!t.workspacePath || t.workspacePath === digest(job.workspacePath)));
  }
}
