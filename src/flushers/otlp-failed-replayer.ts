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

export interface ReplayResult { sent: number; rejected: number; kept: number }
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface Item { line: string; rec: FailedSpanRecord }

/** Same budget as otlpTrace.maxExportBatchBytes; the NTConsult API accepts 16 MiB. */
const MAX_REQUEST_RAW_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const CLAIM_TAG = '.replaying';

/** 401/403 stay: the setup skill may re-enrol the machine with a new key. */
function isRetryable(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
}

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

/** Returns the HTTP status, or null on a network error/timeout. */
async function post(target: ReplayTarget, fetchImpl: FetchLike, batch: Item[]): Promise<number | null> {
  try {
    const body = gzipSync(JSON.stringify(toOtlpJsonRequest(batch.map((b) => b.rec))));
    const resp = await fetchImpl(target.url, {
      method: 'POST',
      headers: { ...target.headers, 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return resp.status;
  } catch {
    return null;
  }
}

async function appendRejected(failedDir: string, claimed: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const dir = path.join(failedDir, 'rejected');
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, claimed.replace(CLAIM_TAG, '')), lines.join('\n') + '\n');
}

/** Moves whatever the flusher wrote to the unclaimed file into the claimed one.
 *  The rename is atomic, so a concurrent writer just starts a fresh unclaimed file,
 *  and appending keeps the lines a previous partial run left in the claimed file. */
async function claimInto(originalPath: string, claimedPath: string): Promise<void> {
  const staging = `${claimedPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.rename(originalPath, staging);
  } catch {
    return; // nothing new to claim
  }
  await fs.appendFile(claimedPath, await fs.readFile(staging));
  await fs.rm(staging, { force: true });
}

async function countPending(dir: string, claimedNames: string[]): Promise<number> {
  let n = 0;
  for (const name of claimedNames) {
    for (const f of [name, name.replace(CLAIM_TAG, '')]) {
      const text = await fs.readFile(path.join(dir, f), 'utf8').catch(() => '');
      n += text.split('\n').filter((l) => l.trim() !== '').length;
    }
  }
  return n;
}

/** Resends the failed spans of one endpoint and deletes each file once every line
 *  was accepted or rejected. Lines not accepted yet stay in the claimed file. */
export async function replayFailedSpans(
  failedDir: string,
  target: ReplayTarget,
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<ReplayResult> {
  const result: ReplayResult = { sent: 0, rejected: 0, kept: 0 };
  const safe = target.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const pattern = new RegExp(`__${escapeRegExp(safe)}(${escapeRegExp(CLAIM_TAG)})?-(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);

  let files: string[];
  try {
    files = (await fs.readdir(failedDir)).filter((f) => pattern.test(f));
  } catch {
    return result;
  }
  const claimedNames = [...new Set(files.map((f) =>
    f.includes(CLAIM_TAG) ? f : f.replace(`__${safe}-`, `__${safe}${CLAIM_TAG}-`),
  ))].sort();

  for (let i = 0; i < claimedNames.length; i++) {
    const claimed = claimedNames[i];
    const claimedPath = path.join(failedDir, claimed);
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

    const pending = batchesBySize(parsed);
    while (pending.length > 0) {
      const batch = pending.shift()!;
      const status = await post(target, fetchImpl, batch);
      if (status !== null && status >= 200 && status < 300) {
        result.sent += batch.length;
      } else if (status === 413 && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        pending.unshift(batch.slice(0, mid), batch.slice(mid));
      } else if (status !== null && !isRetryable(status)) {
        await appendRejected(failedDir, claimed, batch.map((b) => b.line));
        result.rejected += batch.length;
      } else {
        const rest = [batch, ...pending].flat().map((b) => b.line);
        await fs.writeFile(claimedPath, rest.join('\n') + '\n');
        result.kept += rest.length + await countPending(failedDir, claimedNames.slice(i + 1));
        return result;
      }
    }
    await fs.rm(claimedPath, { force: true });
  }
  return result;
}
