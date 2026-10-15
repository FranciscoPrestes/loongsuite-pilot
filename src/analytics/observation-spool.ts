import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Managed spool for offline replay. Only this spool is ever removed by exclusions. */
export interface ObservationSpool {
  persist(serialized: string): Promise<void>;
  pending(): Promise<string[]>;
  remove(serialized: string): Promise<void>;
  recordFailure(reason: string, observationId: string | null): Promise<void>;
}

export const MAX_SPOOL_BYTES = 8 * 1024 * 1024;

/** Append-only removal mark line for the managed spool records file. */
const REMOVE_MARK_PREFIX = '{"__remove":"';
const REMOVE_MARK_PATTERN = /^\{"__remove":"([0-9a-f]{64})"\}$/;

export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Live records of a records-file text: cancelled records and consumed marks dropped. */
function liveRecordLines(text: string): string[] {
  const records: Array<{ line: string; digest: string; cancelled: boolean }> = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    if (line.startsWith(REMOVE_MARK_PREFIX)) {
      const mark = REMOVE_MARK_PATTERN.exec(line);
      if (!mark) continue; // a torn mark line is dropped, never read as a record
      const target = records.find((r) => !r.cancelled && r.digest === mark[1]);
      if (target) target.cancelled = true;
      continue;
    }
    records.push({ line, digest: sha256hex(line), cancelled: false });
  }
  return records.filter((r) => !r.cancelled).map((r) => r.line);
}

/**
 * The full managed-spool file set of an exporter run (failures never block).
 * The records file is APPEND-ONLY: a removal is a mark line, never a
 * read-modify-write rewrite, so a concurrent persist can never be lost to a
 * stale snapshot. Marks only cancel records that precede them. When dead bytes
 * (cancelled records + consumed marks) crowd the cap, `persist` COMPACTION
 * rewrites the file down to its live records — serialized with all mutating
 * operations and tail-merged, so a concurrent append survives compaction and
 * the cap governs live bytes, never dead ones.
 */
export class FileObservationSpool implements ObservationSpool {
  private readonly recordsPath: string;
  private readonly failuresPath: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.recordsPath = path.join(dir, 'observations.jsonl');
    this.failuresPath = path.join(dir, 'failures.jsonl');
  }

  private async ready(): Promise<void> {
    await fs.mkdir(path.dirname(this.recordsPath), { recursive: true, mode: 0o700 });
  }

  /** Serializes mutating operations so no rewrite can ever lose an append. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async persist(serialized: string): Promise<void> {
    await this.mutate(async () => {
      await this.ready();
      const line = serialized + '\n';
      const bytes = Buffer.byteLength(line);
      let stat = await fs.lstat(this.recordsPath).catch(() => null);
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('unsafe spool record');
      if ((stat?.size ?? 0) + bytes > MAX_SPOOL_BYTES) {
        // Dead bytes never exhaust the cap: compact to live records first and
        // only fail when the LIVE data genuinely does not fit.
        await this.compact();
        stat = await fs.lstat(this.recordsPath).catch(() => null);
        if ((stat?.size ?? 0) + bytes > MAX_SPOOL_BYTES) throw new Error('spool full');
      }
      await fs.appendFile(this.recordsPath, line, { mode: 0o600 });
    });
  }

  /** Pending records with removal marks applied (order preserved). */
  async pending(): Promise<string[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.recordsPath, 'utf8');
    } catch {
      return [];
    }
    return liveRecordLines(raw);
  }

  /** Append-only removal mark; the target is the first unmatched earlier record. */
  async remove(serialized: string): Promise<void> {
    await this.mutate(async () => {
      await this.ready();
      await fs.appendFile(this.recordsPath, `${REMOVE_MARK_PREFIX}${sha256hex(serialized)}"}\n`, { mode: 0o600 });
    });
  }

  async recordFailure(reason: string, observationId: string | null): Promise<void> {
    try {
      await this.ready();
      await fs.appendFile(this.failuresPath,
        JSON.stringify({ reason, observationId, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    } catch { /* failure records never block anything */ }
  }

  /** Must run inside `mutate`: rewrites the file down to its live records. */
  private async compact(): Promise<void> {
    const snapshot = await fs.readFile(this.recordsPath).catch(() => null);
    if (!snapshot) return;
    let out = liveRecordLines(snapshot.toString('utf8')).join('\n');
    if (out.length > 0) out += '\n';
    const tmp = `${this.recordsPath}.${process.pid}.compact.tmp`;
    await fs.writeFile(tmp, out, { mode: 0o600 });
    // Tail-merge: bytes appended to the records file after the snapshot
    // (concurrent persists) are copied into the compacted file before the
    // commit, so they always survive compaction.
    let seenBytes = snapshot.length;
    for (let pass = 0; pass < 2; pass++) {
      const stat = await fs.lstat(this.recordsPath).catch(() => null);
      if (!stat || stat.size <= seenBytes) break;
      const current = await fs.readFile(this.recordsPath).catch(() => null);
      if (!current || current.length <= seenBytes) break;
      await fs.appendFile(tmp, current.subarray(seenBytes).toString('utf8'));
      seenBytes = current.length;
    }
    await fs.rename(tmp, this.recordsPath);
  }
}
