import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';

/** One line of logs/otlp-failed/*.jsonl, as written by otlp-json-serializer. */
export interface FailedSpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: Record<string, unknown>;
  status?: { code?: number; message?: string };
  resource?: Record<string, unknown>;
  events?: Array<{ name: string; timeUnixNano: string; attributes?: Record<string, unknown> }>;
}

export interface ReplayTarget {
  /** Endpoint name, as used in the failed-log file name. */
  name: string;
  /** Resolved URL ending in /v1/traces. */
  url: string;
  headers: Record<string, string>;
}

export interface ReplayResult {
  sent: number;
  rejected: number;
  kept: number;
  /** True when the run stopped on a 401/403, so the caller can back off. */
  authFailed: boolean;
  /** True when the run stopped after MAX_CONSECUTIVE_REJECTIONS single-span rejections in a row. */
  systemicReject: boolean;
}
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Item { line: string; rec: FailedSpanRecord }

/** Same budget as otlpTrace.maxExportBatchBytes; the NTConsult API accepts 16 MiB. */
const MAX_REQUEST_RAW_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
/** Consecutive single-span 400/413 answers (no 2xx between) that mean the backend rejects everything. */
export const MAX_CONSECUTIVE_REJECTIONS = 8;
const CLAIM_TAG = '.replaying';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function anyValue(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { stringValue: JSON.stringify(v) };
}

function keyValues(attrs: Record<string, unknown> | undefined): Array<{ key: string; value: Record<string, unknown> }> {
  return Object.entries(attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, v]) => ({ key, value: anyValue(v) }));
}

export function toOtlpJsonRequest(records: FailedSpanRecord[]): object {
  const byResource = new Map<string, FailedSpanRecord[]>();
  for (const r of records) {
    const k = JSON.stringify(r.resource ?? {});
    byResource.set(k, [...(byResource.get(k) ?? []), r]);
  }
  return {
    resourceSpans: [...byResource.entries()].map(([k, spans]) => ({
      resource: { attributes: keyValues(JSON.parse(k)) },
      scopeSpans: [{
        scope: { name: 'loongsuite-pilot-otlp-replay' },
        spans: spans.map((r) => ({
          traceId: r.traceId,
          spanId: r.spanId,
          parentSpanId: r.parentSpanId ?? '',
          name: r.name,
          kind: (r.kind ?? 0) + 1,
          startTimeUnixNano: r.startTimeUnixNano,
          endTimeUnixNano: r.endTimeUnixNano,
          attributes: keyValues(r.attributes),
          events: (r.events ?? []).map((e) => ({ name: e.name, timeUnixNano: e.timeUnixNano, attributes: keyValues(e.attributes) })),
          status: { code: r.status?.code ?? 0, message: r.status?.message ?? '' },
        })),
      }],
    })),
  };
}

function batchesBySize(items: Item[]): Item[][] {
  const out: Item[][] = [];
  let current: Item[] = [];
  let size = 0;
  for (const item of items) {
    const n = Buffer.byteLength(item.line);
    if (current.length > 0 && size + n > MAX_REQUEST_RAW_BYTES) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}

interface LinkedSignal { signal: AbortSignal; dispose: () => void }

/** Combines signals; `dispose` removes the listeners from the inputs (fallback only). */
function linkSignals(signals: AbortSignal[]): LinkedSignal {
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return { signal: native.call(AbortSignal, signals), dispose: () => undefined };
  const controller = new AbortController();
  const already = signals.find((s) => s.aborted);
  if (already) {
    controller.abort(already.reason);
    return { signal: controller.signal, dispose: () => undefined };
  }
  const listeners: Array<[AbortSignal, () => void]> = [];
  const dispose = (): void => {
    for (const [sig, fn] of listeners) sig.removeEventListener('abort', fn);
    listeners.length = 0;
  };
  for (const sig of signals) {
    const onAbort = (): void => {
      dispose();
      controller.abort(sig.reason);
    };
    sig.addEventListener('abort', onAbort, { once: true });
    listeners.push([sig, onAbort]);
  }
  return { signal: controller.signal, dispose };
}

/** AbortSignal.any with a listener-based fallback for Node < 18.17. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  return linkSignals(signals).signal;
}

/** Returns the HTTP status, or null on a network error/timeout. */
async function post(target: ReplayTarget, fetchImpl: FetchLike, batch: Item[], abort?: AbortSignal): Promise<number | null> {
  let dispose = (): void => undefined;
  try {
    const body = gzipSync(JSON.stringify(toOtlpJsonRequest(batch.map((b) => b.rec))));
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const linked = abort ? linkSignals([timeout, abort]) : null;
    dispose = linked?.dispose ?? dispose;
    const resp = await fetchImpl(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
      signal: linked?.signal ?? timeout,
    });
    return resp.status;
  } catch {
    return null;
  } finally {
    dispose();
  }
}

async function appendRejected(failedDir: string, claimed: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const dir = path.join(failedDir, 'rejected');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, claimed.replace(CLAIM_TAG, '')), lines.join('\n') + '\n');
}

/** Appends text to a claimed file, first terminating a half-written last line so
 *  the new content never glues onto it. */
async function appendTerminated(claimedPath: string, data: Buffer | string): Promise<void> {
  const existing = await fs.readFile(claimedPath).catch(() => null);
  const prefix = existing && existing.length > 0 && existing[existing.length - 1] !== 0x0a ? '\n' : '';
  await fs.appendFile(claimedPath, Buffer.concat([Buffer.from(prefix), Buffer.from(data)]));
}

/** Moves whatever the flusher wrote to the unclaimed file into the claimed one.
 *  With no claimed file yet the atomic rename is the whole claim. Otherwise the
 *  unclaimed file is renamed to a staging file (a concurrent writer just starts a
 *  fresh unclaimed file), appended, and removed only once it stopped growing. */
async function claimInto(originalPath: string, claimedPath: string): Promise<void> {
  const exists = await fs.access(claimedPath).then(() => true, () => false);
  if (!exists) {
    await fs.rename(originalPath, claimedPath).catch(() => undefined); // nothing new to claim
    return;
  }
  const staging = `${claimedPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.rename(originalPath, staging);
  } catch {
    return; // nothing new to claim
  }
  await appendStaging(claimedPath, staging);
}

/** Appends a staging file into the claimed file, picking up bytes a writer that
 *  still had it open appended meanwhile, then removes it. */
async function appendStaging(claimedPath: string, staging: string): Promise<void> {
  let copied = 0;
  for (;;) {
    const data = await fs.readFile(staging);
    if (data.length <= copied) break;
    await appendTerminated(claimedPath, data.subarray(copied));
    copied = data.length;
  }
  await fs.rm(staging, { force: true });
}

/** Rewrites the claimed file atomically with the lines still pending. */
async function rewriteClaimed(claimedPath: string, lines: string[]): Promise<void> {
  const tmp = `${claimedPath}.rewrite.tmp`;
  await fs.writeFile(tmp, lines.join('\n') + '\n');
  await fs.rename(tmp, claimedPath);
}

/** Resends the failed spans of one endpoint and deletes each file once every line
 *  was accepted or rejected. Lines not accepted yet stay in the claimed file (rewritten
 *  atomically, and only if something changed). On the first retryable failure the run
 *  stops; `kept` counts the unsent lines of the file being processed at that point.
 *  `shouldStop` is checked before each request and `abort` cancels the one in flight (the
 *  aborted request counts as a network error, so the file stays), for a clean shutdown. */
export async function replayFailedSpans(
  failedDir: string,
  target: ReplayTarget,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  shouldStop?: () => boolean,
  abort?: AbortSignal,
): Promise<ReplayResult> {
  let consecutiveRejections = 0;
  const result: ReplayResult = { sent: 0, rejected: 0, kept: 0, authFailed: false, systemicReject: false };
  const safe = target.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const pattern = new RegExp(`__${escapeRegExp(safe)}(${escapeRegExp(CLAIM_TAG)})?-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
  const stagingPattern = new RegExp(`^(.*__${escapeRegExp(safe)}${escapeRegExp(CLAIM_TAG)}-\\d{4}-\\d{2}-\\d{2}\\.jsonl)\\.\\d+\\.\\d+\\.tmp$`);

  let all: string[];
  try {
    all = await fs.readdir(failedDir);
  } catch {
    return result;
  }
  const stagings = all.filter((f) => stagingPattern.test(f));
  const claimedNames = [...new Set([
    ...all.filter((f) => pattern.test(f)).map((f) =>
      f.includes(CLAIM_TAG) ? f : f.replace(`__${safe}-`, `__${safe}${CLAIM_TAG}-`)),
    ...stagings.map((f) => f.replace(stagingPattern, '$1')),
  ])].sort();

  for (const claimed of claimedNames) {
    const claimedPath = path.join(failedDir, claimed);
    // Leftovers of a run that crashed between the claim rename and the append.
    for (const staging of stagings.filter((f) => f.startsWith(`${claimed}.`))) {
      await appendStaging(claimedPath, path.join(failedDir, staging)).catch(() => undefined);
    }
    await fs.rm(`${claimedPath}.rewrite.tmp`, { force: true });
    await claimInto(path.join(failedDir, claimed.replace(CLAIM_TAG, '')), claimedPath);

    const lines = (await fs.readFile(claimedPath, 'utf8').catch(() => ''))
      .split('\n').filter((l) => l.trim() !== '');
    const parsed: Item[] = [];
    const bad: string[] = [];
    for (const line of lines) {
      try { parsed.push({ line, rec: JSON.parse(line) as FailedSpanRecord }); } catch { bad.push(line); }
    }
    await appendRejected(failedDir, claimed, bad);
    result.rejected += bad.length;

    let changed = bad.length > 0;
    const pending = batchesBySize(parsed);
    while (pending.length > 0) {
      const batch = pending.shift()!;
      const status = shouldStop?.() ? null : await post(target, fetchImpl, batch, abort);
      if (status !== null && status >= 200 && status < 300) {
        result.sent += batch.length;
        consecutiveRejections = 0;
        changed = true;
      } else if ((status === 413 || status === 400) && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        pending.unshift(batch.slice(0, mid), batch.slice(mid));
      } else if (status === 400 || status === 413) {
        // Only a single span answered 400 or 413 is quarantined (larger batches were
        // halved above to isolate the bad span). Everything
        // else (401/403 key rotation, 404/415/422 misrouting, 5xx, network) stays.
        await appendRejected(failedDir, claimed, batch.map((b) => b.line));
        result.rejected += batch.length;
        changed = true;
        consecutiveRejections++;
        if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS && pending.length > 0) {
          // The backend rejects everything: keep the rest instead of quarantining the backlog.
          const rest = pending.flat().map((b) => b.line);
          await rewriteClaimed(claimedPath, rest);
          result.kept += rest.length;
          result.systemicReject = true;
          return result;
        }
      } else {
        if (status === 401 || status === 403) result.authFailed = true;
        const rest = [batch, ...pending].flat().map((b) => b.line);
        if (changed) await rewriteClaimed(claimedPath, rest);
        result.kept += rest.length;
        return result;
      }
    }
    await fs.rm(claimedPath, { force: true });
  }
  return result;
}
