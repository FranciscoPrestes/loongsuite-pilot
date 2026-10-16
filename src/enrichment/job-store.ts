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

export interface LossState { reason: 'expired' | 'quota' | 'busy'; count: number; from: string; to: string; unreported: false }
const lossSchema = z.object({
  reason: z.enum(['expired', 'quota', 'busy']), count: z.number().int().positive(),
  from: z.string().min(1), to: z.string().min(1), unreported: z.literal(false),
}).strict();

const tombstoneSchema = z.object({ id: z.string().min(1).max(500), deviceId: z.string().min(1).max(500), sessionId: z.string().min(1).max(500).optional(), workspacePath: z.string().max(4096).optional() }).strict();
export type Tombstone = z.infer<typeof tombstoneSchema>;

const exclusionEntrySchema = z.object({ id: hex64, deviceId: hex64, sessionId: hex64.optional(), workspacePath: hex64.optional() }).strict();
const exclusionsSchema = z.object({ revision: z.string().min(1).max(500).nullable(), tombstones: z.array(exclusionEntrySchema).max(10000) }).strict();
type Exclusions = z.infer<typeof exclusionsSchema>;

const usageSchema = z.object({ bytes: z.number().int().nonnegative() }).strict();
const idIndexSchema = z.object({ key: hex64 }).strict();
const markerSchema = z.object({ key: hex64, at: z.number().finite() }).strict();
const spillSchema = z.object({ reason: z.literal('busy'), occurredAt: z.string().min(1) }).strict();

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_QUARANTINED = 20;
const TMP_NAME = /^\.[a-f0-9-]{36}\.tmp$/;
const JOURNAL_NAME = /^[a-f0-9]{64}\.json$/;
const PENDING_NAME = /^(\d{13,})-([a-f0-9]{64})\.json$/;
/** One lock acquisition window for worker operations. */
const LOCK_BUDGET_MS = 80;
/** Enqueue waits out a concurrent worker's bounded maintenance window before recording a loss. */
const ENQUEUE_LOCK_BUDGET_MS = 240;
/** Orphaned index/marker files younger than this may belong to a concurrent in-flight write. */
const ORPHAN_GRACE_MS = 60000;
/** Per-lock-hold bound for expiry discards; batches release the lock between runs. */
const EXPIRY_DELETE_BATCH = 64;
/** Soft cap for pending busy-spill markers; folding bounds the dir, never dropping records. */
const MAX_SPILL = 256;

/**
 * Private atomic per-job journals. Result and lease transitions are one
 * fsync+rename. Quota bytes cover journals plus the derived id index; the
 * control plane (queue lock, exclusions, loss manifest, pending markers, spill
 * markers, bounded quarantine) is a separate bounded reserve and is never
 * counted as a hard overall disk bound.
 *
 * The shared cross-process lock is held only around O(1) work: every full spool
 * scan (crash recovery, expiry sweep, replay reading) runs outside it. The
 * durable `pending/` marker index (wakeAt-keyed, rebuilt by recovery) lets
 * `claim` find runnable jobs without parsing the spool. Enqueue is bounded
 * bookkeeping with a bounded busy budget; if contention still wins, the job is
 * recorded as a durable `busy` loss marker, never dropped silently.
 */
export class JobStore {
  readonly config: QueueConfig;
  private readonly root: string;
  private readonly idsDir: string;
  private readonly pendingDir: string;
  private readonly spillDir: string;
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
    this.pendingDir = path.join(this.root, 'pending');
    this.spillDir = path.join(this.root, 'spill');
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

  private async locked<T>(operation: () => T, busyBudgetMs = LOCK_BUDGET_MS): Promise<T> {
    this.ensure();
    const deadline = Date.now() + busyBudgetMs;
    while (true) {
      const { lock, error } = acquireSingleInstanceLock(path.join(this.root, 'queue.lock'));
      if (lock) {
        try { return operation(); } finally { lock.release(); }
      }
      if (error) throw error;
      if (Date.now() >= deadline) throw new Error('queue busy');
      await new Promise(r => setTimeout(r, 5));
    }
  }

  private recovery: Promise<void> | null = null;
  /** Crash recovery runs once per instance; concurrent callers share one rebuild. */
  private async ready(busyBudgetMs = LOCK_BUDGET_MS): Promise<void> {
    if (this.recovered) return;
    if (!this.recovery) {
      this.recovery = this.recover(busyBudgetMs).catch(e => { this.recovery = null; throw e; });
    }
    await this.recovery;
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
   * Derived bookkeeping (quota usage, id index, pending markers, spill markers)
   * is rebuildable by recovery, so it needs only atomic visibility, not
   * power-loss durability. Reservations are written before the artifacts they
   * account for; releases after. A crash can therefore only overcount until
   * recovery recomputes, never undercount.
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

  // ---- Durable pending marker index (wakeAt-keyed) ----

  private wakeAtOf(record: Pick<JournalRecord, 'job' | 'state' | 'leaseUntil'>): number {
    return record.state === 'leased' ? (record.leaseUntil ?? 0) : record.job.notBefore;
  }

  private markerNameFor(record: Pick<JournalRecord, 'job' | 'state' | 'leaseUntil' | 'key'>): string {
    return `${String(this.wakeAtOf(record)).padStart(13, '0')}-${record.key}.json`;
  }

  private writeMarker(record: Pick<JournalRecord, 'job' | 'state' | 'leaseUntil' | 'key'>): void {
    if (record.state === 'complete' || record.state === 'dead') return;
    this.writeDerived(path.join(this.pendingDir, this.markerNameFor(record)), { key: record.key, at: this.now() });
  }

  private dropMarker(record: Pick<JournalRecord, 'job' | 'state' | 'leaseUntil' | 'key'>): void {
    try { fs.unlinkSync(path.join(this.pendingDir, this.markerNameFor(record))); } catch { /* absent */ }
  }

  /** Marker probe age: only prunes orphans old enough to not race a concurrent enqueue. */
  private markerAge(file: string): number {
    try { return this.now() - markerSchema.parse(this.readBounded(file)).at; } catch { return Number.POSITIVE_INFINITY; }
  }

  /**
   * Lock-free frontier scan over the marker index. Sorted by wake time, so the
   * claimable candidates sit at the head. Stale markers self-heal here (O(1)
   * journal reads); the lease commit itself happens under the shared lock.
   * Age-expired jobs are collected for discard-with-loss, never delivered.
   */
  private scanPending(now: number, kinds: readonly ObservationKind[] | undefined, exclusions: Exclusions): { candidates: string[]; expired: string[] } {
    const candidates: string[] = [];
    const expired: string[] = [];
    if (!fs.existsSync(this.pendingDir)) return { candidates, expired };
    const maxAgeMs = this.config.maxAgeDays * 86400000;
    for (const name of fs.readdirSync(this.pendingDir).sort()) {
      const match = PENDING_NAME.exec(name);
      if (!match) continue;
      if (Number(match[1]) > now) break; // sorted by wake time: nothing later is due
      const key = match[2];
      const file = path.join(this.pendingDir, name);
      const record = this.readRecord(key);
      if (!record) {
        // Orphaned marker (journal never landed or was removed): prune when old.
        if (this.markerAge(file) > ORPHAN_GRACE_MS) { try { fs.unlinkSync(file); } catch { /* gone */ } }
        continue;
      }
      const expected = this.markerNameFor(record);
      if (expected !== name) { // journal is authoritative; heal the wake index
        try { fs.unlinkSync(file); } catch { /* gone */ }
        this.writeMarker(record);
      }
      // D5: an expired job is discarded with an 'expired' loss, never delivered.
      if ((record.state === 'pending' || record.state === 'leased') && Date.parse(record.job.occurredAt) < now - maxAgeMs) {
        expired.push(key);
        continue;
      }
      if ((kinds && !kinds.includes(record.job.kind)) || this.excluded(record.job, exclusions)
        || record.job.notBefore > now || record.state === 'complete' || record.state === 'dead'
        || (record.state === 'leased' && (record.leaseUntil ?? 0) > now)) continue;
      candidates.push(key);
    }
    return { candidates, expired };
  }

  private readRecordTolerant(key: string): JournalRecord | null {
    try { return this.readRecord(key); } catch { return null; }
  }

  /**
   * Crash recovery: the expensive journal validation/parse scan stays OUTSIDE
   * the shared lock. Only the derived rebuild (id index, pending markers),
   * spill folding and the exact quota recompute serialize on it. The rebuild is
   * self-healing, so a scan that raced a concurrent mutation converges through
   * claim probes and the next recovery; the usage recompute runs under the lock
   * and is therefore exact against concurrent reservations.
   */
  private async recover(busyBudgetMs = LOCK_BUDGET_MS): Promise<void> {
    fs.mkdirSync(this.idsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 });
    const kept = new Map<string, JournalRecord>();
    const byId = new Map<string, JournalRecord>();
    for (const name of fs.readdirSync(this.root)) {
      if (!JOURNAL_NAME.test(name)) continue;
      const record = this.readRecordTolerant(name.slice(0, -5));
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
    await this.locked(() => {
      this.sweepTmpLocked();
      const owners = new Map<string, string>();
      for (const record of kept.values()) owners.set(digest(record.job.id), record.key);
      for (const name of fs.readdirSync(this.idsDir)) {
        const file = path.join(this.idsDir, name);
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
      // Reconcile the pending marker index against the journals.
      const expected = new Set<string>();
      for (const record of kept.values()) {
        if (record.state === 'complete' || record.state === 'dead') continue;
        const name = this.markerNameFor(record);
        expected.add(name);
        if (!this.readMarkerKey(path.join(this.pendingDir, name))) this.writeMarker(record);
      }
      for (const name of fs.readdirSync(this.pendingDir)) {
        const file = path.join(this.pendingDir, name);
        if (TMP_NAME.test(name)) { try { fs.unlinkSync(file); } catch { /* residue */ } continue; }
        if (expected.has(name)) continue;
        // Young orphans may be a concurrent process's in-flight enqueue marker.
        if (this.markerAge(file) <= ORPHAN_GRACE_MS && PENDING_NAME.test(name)) continue;
        try { fs.unlinkSync(file); } catch { /* gone */ }
      }
      this.foldSpillsLocked();
      this.writeDerived(this.file('usage.json'), { bytes: this.sumSpoolBytes() });
    }, busyBudgetMs);
    this.recovered = true;
  }

  private readIdIndexKey(file: string): string | null {
    try { return idIndexSchema.parse(this.readBounded(file)).key; } catch { return null; }
  }

  private readMarkerKey(file: string): string | null {
    try { return markerSchema.parse(this.readBounded(file)).key; } catch { return null; }
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
    this.dropMarker(record);
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

  private loss(reason: LossState['reason'], entries: readonly { occurredAt: string }[]): void {
    // Strict read: an unusable loss manifest must fail closed and block any
    // discard, never be healed into a fresh manifest that drops earlier losses.
    const losses = this.readLosses();
    const dates = entries.map(j => j.occurredAt).sort();
    const old = losses.find(l => l.reason === reason);
    const next: LossState = {
      reason,
      count: (old?.count ?? 0) + entries.length,
      from: [old?.from, ...dates].filter((v): v is string => !!v).sort()[0]!,
      to: [old?.to, ...dates].filter((v): v is string => !!v).sort().at(-1)!,
      unreported: false,
    };
    this.write('loss-manifest.json', [...losses.filter(l => l.reason !== reason), next]);
  }

  /** Durable record for a job that contention kept out of the spool; folded into the loss manifest. */
  private async spill(job: LocalJob): Promise<void> {
    try {
      fs.mkdirSync(this.spillDir, { recursive: true, mode: 0o700 });
      // Bounded spill dir: at the soft cap, fold inline when the lock is briefly
      // reachable. A record is never dropped to enforce the cap — the steady-state
      // maintenance fold bounds the dir instead, counting each marker exactly once.
      if (fs.readdirSync(this.spillDir).length >= MAX_SPILL) {
        try { await this.locked(() => this.foldSpillsLocked(), LOCK_BUDGET_MS); } catch { /* still contended */ }
      }
      this.writeDerived(path.join(this.spillDir, `${Date.now()}-${randomUUID()}.json`), { reason: 'busy', occurredAt: job.occurredAt });
    } catch { /* the rethrown busy error remains the truthful signal */ }
  }

  /** Durable loss record before spill markers are removed (D5 ordering). */
  private foldSpillsLocked(): void {
    if (!fs.existsSync(this.spillDir)) return;
    const counted: string[] = [];
    const entries: { occurredAt: string }[] = [];
    for (const name of fs.readdirSync(this.spillDir)) {
      const file = path.join(this.spillDir, name);
      try { entries.push(spillSchema.parse(this.readBounded(file)) as { occurredAt: string }); counted.push(name); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.quarantine(file);
      }
    }
    if (!entries.length) return;
    this.loss('busy', entries);
    // Delete exactly the markers counted above. A marker written after the
    // listing snapshot survives to the next fold and is counted exactly once.
    for (const name of counted) { try { fs.unlinkSync(path.join(this.spillDir, name)); } catch { /* gone */ } }
  }

  private sweepTmpLocked(): void {
    for (const dir of [this.root, this.idsDir, this.pendingDir, this.spillDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) if (TMP_NAME.test(name)) { try { fs.unlinkSync(path.join(dir, name)); } catch { /* residue */ } }
    }
  }

  /**
   * Two-phase maintenance: the full spool scan runs OUTSIDE the shared lock;
   * only bounded per-record revalidation and writes hold it. D5: the loss
   * manifest is durably recorded before any expired spool is discarded.
   */
  async maintain(now = this.now()): Promise<void> {
    await this.ready();
    const maxAgeMs = this.config.maxAgeDays * 86400000;
    const expired = this.records()
      .filter(r => Date.parse(r.job.occurredAt) < now - maxAgeMs)
      .map(r => r.key);
    // Bounded lock holds: expired spool is discarded in batches that release the
    // shared lock between runs; the full scan above stays outside it.
    for (let i = 0; i < expired.length; i += EXPIRY_DELETE_BATCH) {
      const batch = expired.slice(i, i + EXPIRY_DELETE_BATCH);
      await this.locked(() => {
        const doomed: JournalRecord[] = [];
        for (const key of batch) {
          const r = this.readRecord(key);
          if (r && Date.parse(r.job.occurredAt) < now - maxAgeMs) doomed.push(r);
        }
        if (doomed.length) {
          this.loss('expired', doomed.map(r => r.job));
          for (const r of doomed) this.deleteRecordLocked(r);
        }
      });
    }
    await this.locked(() => {
      this.foldSpillsLocked();
      this.sweepTmpLocked();
    });
  }

  async enqueue(value: LocalJob): Promise<'created' | 'existing'> {
    const job = prepareJob(value);
    if (job.leaseToken || job.attempt !== 0) throw new Error('new job cannot carry lease or attempt');
    try {
      await this.ready(ENQUEUE_LOCK_BUDGET_MS);
      return await this.locked(() => {
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
        // Marker before journal: a crash leaves an orphan marker (age-pruned),
        // never a journal invisible to the worker.
        this.writeMarker(record);
        this.write(key + '.json', record);
        return 'created';
      }, ENQUEUE_LOCK_BUDGET_MS);
    } catch (e) {
      // Bounded busy budget exhausted under contention: never drop silently.
      if (e instanceof Error && e.message === 'queue busy') await this.spill(job);
      throw e;
    }
  }

  async claim(now: number, leaseMs: number, kinds?: readonly ObservationKind[]): Promise<LocalJob | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > 10000) throw new Error('invalid lease');
    await this.ready();
    if (!this.options.policy().enrichmentEnabled) return null;
    let exclusions: Exclusions;
    // Corrupt tombstone state fails closed: the worker idles until C7 reinstalls it.
    try { exclusions = this.exclusions(); } catch { return null; }
    const { candidates, expired } = this.scanPending(now, kinds, exclusions);
    // Defense-in-depth D5: expired jobs are discarded with a loss in bounded
    // locked batches — never delivered, even before a maintenance tick runs.
    for (let i = 0; i < expired.length; i += EXPIRY_DELETE_BATCH) {
      const batch = expired.slice(i, i + EXPIRY_DELETE_BATCH);
      await this.locked(() => {
        const doomed: JournalRecord[] = [];
        for (const key of batch) {
          const r = this.readRecord(key);
          if (r && (r.state === 'pending' || r.state === 'leased') && Date.parse(r.job.occurredAt) < now - this.config.maxAgeDays * 86400000) doomed.push(r);
        }
        if (doomed.length) {
          this.loss('expired', doomed.map(r => r.job));
          for (const r of doomed) this.deleteRecordLocked(r);
        }
      });
    }
    for (const key of candidates) {
      const job = await this.locked(() => {
        const r = this.readRecord(key);
        if (!r || (kinds && !kinds.includes(r.job.kind)) || this.excluded(r.job) || r.job.notBefore > now
          || r.state === 'complete' || r.state === 'dead' || (r.state === 'leased' && (r.leaseUntil ?? 0) > now)) return null;
        const leased = { ...r, job: { ...r.job, leaseToken: randomUUID() }, state: 'leased' as const, leaseUntil: now + leaseMs };
        this.commitJournalLocked(r.key, leased, null);
        this.dropMarker(r);
        this.writeMarker(leased);
        return leased.job;
      });
      if (job) return job;
    }
    return null;
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
    await this.ready();
    await this.locked(() => {
      const r = this.claimed(id, leaseToken);
      if (r.state === 'complete') return;
      if (!this.options.policy().enrichmentEnabled || this.excluded(r.job)) throw new Error('enrichment disabled');
      if (observation.observationId !== id || observation.kind !== r.job.kind || observation.deviceId !== r.job.deviceId
        || observation.sessionId !== r.job.sessionId
        // A snapshot carries its REAL capture time (never back-dated to the signal): it cannot predate the signal or lie in the future.
        || Date.parse(observation.occurredAt) < Date.parse(r.job.occurredAt) || Date.parse(observation.occurredAt) > this.now() + 300000
        || observation.harnessId !== r.job.harnessId || observation.harnessVersion !== r.job.harnessVersion
        || observation.collectorVersion !== r.job.collectorVersion || observation.capabilitiesVersion !== r.job.capabilitiesVersion
        || (observation.toolCallId ?? null) !== r.job.nativeCallId || observation.turnId !== r.job.turnId
        || observation.parentCallId !== r.job.parentCallId || JSON.stringify(observation.sourceRefs) !== JSON.stringify(r.job.sourceRefs)) {
        throw new Error('observation provenance mismatch');
      }
      this.commitJournalLocked(r.key, { ...r, state: 'complete', result: observation }, r.job);
      this.dropMarker(r);
    });
  }

  async retry(id: string, token: string): Promise<void> {
    await this.ready();
    await this.locked(() => {
      const r = this.claimed(id, token);
      if (r.state === 'complete') return;
      const attempt = r.job.attempt + 1;
      const next: JournalRecord = {
        ...r,
        state: attempt >= 5 ? 'dead' : 'pending',
        job: { ...r.job, attempt, leaseToken: undefined, notBefore: this.now() + Math.min(60000, 1000 * 2 ** attempt) },
        leaseUntil: undefined,
      };
      this.commitJournalLocked(r.key, next, null);
      this.dropMarker(r);
      this.writeMarker(next);
    });
  }

  async losses(): Promise<LossState[]> { await this.ready(); return this.locked(() => this.readLosses()); }

  /** Only the authenticated C7 deletion synchronizer may call this after fetching current exclusions. */
  async synchronizeTombstones(revision: string, values: readonly Tombstone[]): Promise<void> {
    operationalRevision(revision);
    if (values.length > 10000) throw new Error('too many tombstones');
    const parsed = values.map(v => tombstoneSchema.parse(v));
    await this.ready();
    const exclusions = await this.locked(() => {
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
      const next: Exclusions = { revision, tombstones: [...map.values()] };
      this.write('exclusions.json', next); // Durable authority precedes deletion, including crash recovery.
      this.exclusionsCache = null;
      this.exclusionsUntrusted = false;
      return next;
    });
    // Deletion phase: the scan stays outside the lock; per-record drops are bounded.
    const doomed = this.records().filter(r => this.excluded(r.job, exclusions)).map(r => r.key);
    await this.locked(() => {
      for (const key of doomed) {
        const r = this.readRecord(key);
        if (r && this.excluded(r.job, exclusions)) this.deleteRecordLocked(r);
      }
      if (this.options.policy().deletionRevision !== revision) throw new Error('exclusion revision changed');
      this.synchronizedRevision = revision;
    });
  }

  invalidateReplay(): void { this.synchronizedRevision = null; }

  /** Read-only replay view; maintenance stays bounded and outside the shared lock. */
  async replayBatch(limit = 100): Promise<Observation[]> { return (await this.replayEntries(limit)).map(e => e.observation); }

  /** Replay view plus the real workspace each result belongs to, so the transport fence matches the true scope. */
  async replayEntries(limit = 100): Promise<{ observation: Observation; workspacePath: string }[]> {
    await this.maintain();
    const p = this.options.policy();
    if (!p.replayEnabled || !p.deletionRevision || this.synchronizedRevision !== p.deletionRevision) return [];
    let exclusions: Exclusions;
    try { exclusions = this.exclusions(); } catch { return []; }
    if (exclusions.revision !== p.deletionRevision) return [];
    return this.records()
      .filter(r => r.state === 'complete' && r.result && !this.excluded(r.job, exclusions))
      .slice(0, Math.max(0, Math.min(100, limit)))
      .map(r => ({ observation: r.result!, workspacePath: r.job.workspacePath }));
  }

  /** Delivered (or durably spooled) results leave the journal; only completed records can be acknowledged. */
  async acknowledge(ids: readonly string[]): Promise<number> {
    await this.ready();
    return this.locked(() => {
      let removed = 0;
      for (const id of ids) {
        const key = this.readIdIndex(id);
        const record = key ? this.readRecord(key) : null;
        if (record?.state === 'complete') { this.deleteRecordLocked(record); removed += 1; }
      }
      return removed;
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
