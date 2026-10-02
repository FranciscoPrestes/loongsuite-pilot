import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanupTempDir, createTempDir } from '../../helpers/fixture-builder.js';
import { anySignal, replayFailedSpans, toOtlpJsonRequest } from '../../../src/flushers/otlp-failed-replayer.js';

const TARGET = { name: 'ntc', url: 'https://beat.example/api/ingest/otlp/v1/traces', headers: { Authorization: 'Bearer k' } };
const MiB = 1024 * 1024;

function record(i: number, pad = '') {
  return {
    traceId: 'a'.repeat(32), spanId: i.toString(16).padStart(16, '0'), name: `span-${i}`, kind: 0,
    startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000',
    attributes: { 'gen_ai.input.messages': `prompt ${i}${pad}`, 'gen_ai.usage.input_tokens': 12, ratio: 0.5, ok: true },
    status: { code: 0 },
    resource: { 'service.name': 'loongsuite-pilot' },
    events: [{ name: 'e', timeUnixNano: '1500000000', attributes: { k: 'v' } }],
    _error: { code: 1, message: 'ECONNREFUSED' },
  };
}

function spansIn(init: RequestInit): number {
  const body = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
  return body.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans)).length;
}

let dir: string;
beforeEach(async () => { dir = await createTempDir('otlp-replay-'); });
afterEach(async () => { await cleanupTempDir(dir); });

async function writeFailed(name: string, n: number, pad = '', from = 0) {
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify(record(from + i, pad))).join('\n') + '\n';
  await fs.writeFile(path.join(dir, name), lines);
}

describe('toOtlpJsonRequest', () => {
  it('builds a valid OTLP/JSON body with typed attributes and events', () => {
    const body: any = toOtlpJsonRequest([record(1)]);
    const rs = body.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'loongsuite-pilot' } }]);
    const span = rs.scopeSpans[0].spans[0];
    expect(span.kind).toBe(1); // SDK INTERNAL(0) -> OTLP SPAN_KIND_INTERNAL(1)
    expect(span.attributes).toContainEqual({ key: 'gen_ai.usage.input_tokens', value: { intValue: '12' } });
    expect(span.attributes).toContainEqual({ key: 'ratio', value: { doubleValue: 0.5 } });
    expect(span.attributes).toContainEqual({ key: 'ok', value: { boolValue: true } });
    expect(span.events[0]).toEqual({ name: 'e', timeUnixNano: '1500000000', attributes: [{ key: 'k', value: { stringValue: 'v' } }] });
    expect(JSON.stringify(body)).not.toContain('_error');
  });
});

describe('replayFailedSpans', () => {
  it('sends every span of the endpoint files gzipped and removes them', async () => {
    await writeFailed('loongsuite-pilot-claude-code__ntc-2026-09-20.jsonl', 3);
    await writeFailed('loongsuite-pilot-claude-code__other-2026-09-20.jsonl', 2);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await replayFailedSpans(dir, TARGET, fetchMock);
    expect(result).toEqual({ sent: 3, rejected: 0, kept: 0, authFailed: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TARGET.url);
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k', 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    expect(spansIn(init)).toBe(3);
    expect(await fs.readdir(dir)).toEqual(['loongsuite-pilot-claude-code__other-2026-09-20.jsonl']);
  });

  it('splits large spans into requests of at most 8 MiB raw and sends them all', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 5, 'x'.repeat(3 * MiB));
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 5, rejected: 0, kept: 0, authFailed: false });
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(gunzipSync(init.body as Buffer).length).toBeLessThanOrEqual(9 * MiB);
    }
  });

  it('halves a batch on 413 instead of dropping it', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 4);
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) =>
      new Response('', { status: spansIn(init) > 1 ? 413 : 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 4, rejected: 0, kept: 0, authFailed: false });
  });

  it('rejects only a single span that is too large on its own', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 1);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 413 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 0, rejected: 1, kept: 0, authFailed: false });
    expect(await fs.readdir(path.join(dir, 'rejected'))).toEqual(['svc-a__ntc-2026-09-20.jsonl']);
  });

  it('moves the batch to rejected/ on 400', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 2);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 0, rejected: 2, kept: 0, authFailed: false });
  });

  it('bisects a 400 batch to isolate the single bad span', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 4);
    const badId = (2).toString(16).padStart(16, '0');
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(gunzipSync(init.body as Buffer).toString('utf8'));
      const ids = body.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans.map((sp: any) => sp.spanId)));
      return new Response('', { status: ids.includes(badId) ? 400 : 200 });
    });
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 3, rejected: 1, kept: 0, authFailed: false });
    const rejected = await fs.readFile(path.join(dir, 'rejected', 'svc-a__ntc-2026-09-20.jsonl'), 'utf8');
    const lines = rejected.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).spanId).toBe(badId);
  });

  it('rejects a lone span answered 400', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 1);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 0, rejected: 1, kept: 0, authFailed: false });
  });

  it('keeps unsent spans on network error and does not resend accepted ones', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 3, 'x'.repeat(3 * MiB)); // requests: [2 spans], [1 span]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockRejectedValueOnce(new Error('ENETUNREACH'));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 2, rejected: 0, kept: 1, authFailed: false });
    const files = await fs.readdir(dir);
    expect(files).toEqual(['svc-a__ntc.replaying-2026-09-20.jsonl']);
    const left = (await fs.readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n');
    expect(left.map((l) => JSON.parse(l).spanId)).toEqual([(2).toString(16).padStart(16, '0')]);

    const ok = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, ok)).toEqual({ sent: 1, rejected: 0, kept: 0, authFailed: false });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('merges a new failure of the same day into a half-sent claimed file without losing either', async () => {
    await writeFailed('svc-a__ntc.replaying-2026-09-20.jsonl', 2, '', 0);
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 3, '', 10);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 5, rejected: 0, kept: 0, authFailed: false });
    expect(fetchMock.mock.calls.reduce((n, [, init]) => n + spansIn(init), 0)).toBe(5);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it.each([401, 403, 404, 405, 408, 410, 415, 422, 429, 503])('keeps the file and stops the run on %i', async (status) => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 2);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({
      sent: 0, rejected: 0, kept: 2, authFailed: status === 401 || status === 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips unparseable lines into rejected/ and sends the rest', async () => {
    await fs.writeFile(path.join(dir, 'svc-a__ntc-2026-09-20.jsonl'), `${JSON.stringify(record(1))}\n{broken\n`);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 1, rejected: 1, kept: 0, authFailed: false });
  });

  it('leaves the claimed file untouched when nothing was sent (no rewrite while offline)', async () => {
    await writeFailed('svc-a__ntc.replaying-2026-09-20.jsonl', 2);
    const file = path.join(dir, 'svc-a__ntc.replaying-2026-09-20.jsonl');
    const old = new Date('2026-09-20T00:00:00Z');
    await fs.utimes(file, old, old);
    const before = await fs.readFile(file, 'utf8');
    const fetchMock = vi.fn().mockRejectedValue(new Error('ENETUNREACH'));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 0, rejected: 0, kept: 2, authFailed: false });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await fs.stat(file)).mtimeMs).toBe(old.getTime());
    expect(await fs.readdir(dir)).toEqual(['svc-a__ntc.replaying-2026-09-20.jsonl']);
  });

  it('recovers a staging file left by a crash between the claim rename and the append', async () => {
    await writeFailed('svc-a__ntc.replaying-2026-09-20.jsonl', 1, '', 0);
    await writeFailed('svc-a__ntc.replaying-2026-09-20.jsonl.4242.1790000000000.tmp', 2, '', 10);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 3, rejected: 0, kept: 0, authFailed: false });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('recovers a staging file even when the claimed file is gone', async () => {
    await writeFailed('svc-a__ntc.replaying-2026-09-20.jsonl.4242.1790000000000.tmp', 2);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 2, rejected: 0, kept: 0, authFailed: false });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('does not glue a new failure onto a claimed file whose last line is unterminated', async () => {
    await fs.writeFile(path.join(dir, 'svc-a__ntc.replaying-2026-09-20.jsonl'), JSON.stringify(record(1)));
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 1, '', 10);
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 2, rejected: 0, kept: 0, authFailed: false });
  });

  it('stops before the next request when shouldStop turns true and keeps the rest', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 3, 'x'.repeat(3 * MiB)); // requests: [2 spans], [1 span]
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await replayFailedSpans(dir, TARGET, fetchMock, () => fetchMock.mock.calls.length >= 1);
    expect(result).toEqual({ sent: 2, rejected: 0, kept: 1, authFailed: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(dir)).toEqual(['svc-a__ntc.replaying-2026-09-20.jsonl']);
  });

  it('counts kept only for the file being processed', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 2);
    await writeFailed('svc-a__ntc-2026-09-21.jsonl', 3, '', 10);
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
    expect(await replayFailedSpans(dir, TARGET, fetchMock)).toEqual({ sent: 0, rejected: 0, kept: 2, authFailed: false });
  });

  it('aborts the request in flight and keeps the file consistent', async () => {
    await writeFailed('svc-a__ntc-2026-09-20.jsonl', 2);
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const run = replayFailedSpans(dir, TARGET, fetchMock, undefined, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await run).toEqual({ sent: 0, rejected: 0, kept: 2, authFailed: false });
    const files = await fs.readdir(dir);
    expect(files).toEqual(['svc-a__ntc.replaying-2026-09-20.jsonl']);
    expect((await fs.readFile(path.join(dir, files[0]), 'utf8')).trim().split('\n')).toHaveLength(2);
  });
});

describe('anySignal', () => {
  const nativeAny = (AbortSignal as any).any;
  afterEach(() => { (AbortSignal as any).any = nativeAny; });

  it.each([['native', true], ['fallback', false]])('aborts when any input aborts (%s)', (_n, native) => {
    if (!native) delete (AbortSignal as any).any;
    const a = new AbortController();
    const b = new AbortController();
    const sig = anySignal([a.signal, b.signal]);
    expect(sig.aborted).toBe(false);
    b.abort(new Error('boom'));
    expect(sig.aborted).toBe(true);
    a.abort();
    expect(sig.aborted).toBe(true);
  });

  it('fallback handles an already-aborted input', () => {
    delete (AbortSignal as any).any;
    const a = new AbortController();
    a.abort();
    expect(anySignal([new AbortController().signal, a.signal]).aborted).toBe(true);
  });
});
