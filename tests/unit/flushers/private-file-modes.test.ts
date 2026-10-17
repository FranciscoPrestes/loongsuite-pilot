import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileObservationSpool } from '../../../src/analytics/observation-spool.js';
import { replayFailedSpans } from '../../../src/flushers/otlp-failed-replayer.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { appendPrivateLine } from '../../../src/utils/fs-utils.js';

const posix = process.platform !== 'win32';
const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;
let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c10-modes-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe.skipIf(!posix)('spool and failed-log files stay private (0700 dirs, 0600 files) on EVERY write, not only at creation', () => {
  it('the observation spool tightens a pre-existing loose directory and files', async () => {
    const spoolDir = path.join(dir, 'spool');
    await fs.mkdir(spoolDir, { mode: 0o755 }); await fs.chmod(spoolDir, 0o755);
    for (const name of ['observations.jsonl', 'failures.jsonl']) { await fs.writeFile(path.join(spoolDir, name), ''); await fs.chmod(path.join(spoolDir, name), 0o644); }
    const spool = new FileObservationSpool(spoolDir);
    await spool.persist('{"a":1}');
    await spool.remove('{"a":1}');
    await spool.recordFailure('x', null);
    expect(await mode(spoolDir)).toBe(0o700);
    expect(await mode(path.join(spoolDir, 'observations.jsonl'))).toBe(0o600);
    expect(await mode(path.join(spoolDir, 'failures.jsonl'))).toBe(0o600);
  });

  it('a single persist already tightens a loose records file (no later operation needed)', async () => {
    const spoolDir = path.join(dir, 'spool-persist');
    await fs.mkdir(spoolDir);
    await fs.writeFile(path.join(spoolDir, 'observations.jsonl'), ''); await fs.chmod(path.join(spoolDir, 'observations.jsonl'), 0o644);
    await new FileObservationSpool(spoolDir).persist('{"a":1}');
    expect(await mode(path.join(spoolDir, 'observations.jsonl'))).toBe(0o600);
  });

  it('a compacted spool file keeps 0600', async () => {
    const spoolDir = path.join(dir, 'spool2');
    const spool = new FileObservationSpool(spoolDir);
    const big = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 7; i += 1) { await spool.persist(JSON.stringify({ i, big })); await spool.remove(JSON.stringify({ i, big })); }
    await spool.persist(JSON.stringify({ last: true, big })); // forces compaction near the cap
    expect(await mode(path.join(spoolDir, 'observations.jsonl'))).toBe(0o600);
  });

  it('appendPrivateLine creates 0700/0600 and tightens what already exists', async () => {
    const d = path.join(dir, 'private'); const f = path.join(d, 'a.jsonl');
    await appendPrivateLine(f, 'one');
    expect([await mode(d), await mode(f)]).toEqual([0o700, 0o600]);
    await fs.chmod(d, 0o755); await fs.chmod(f, 0o644);
    await appendPrivateLine(f, 'two');
    expect([await mode(d), await mode(f)]).toEqual([0o700, 0o600]);
    expect((await fs.readFile(f, 'utf8'))).toBe('one\ntwo\n');
  });

  it('the failed-span log written by the OTLP flusher is private even when its directory pre-exists loose', async () => {
    const failedDir = path.join(dir, 'logs', 'otlp-failed');
    await fs.mkdir(failedDir, { recursive: true }); await fs.chmod(failedDir, 0o755);
    const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }], protocol: 'http/protobuf', serviceName: 's', dataDir: dir } as never);
    const span = { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }), name: 'n', kind: 0, startTime: [1000, 0], endTime: [1001, 0], attributes: { 'gen_ai.input.messages': 'diagnostic payload' },
      status: { code: 2 }, resource: { attributes: { 'service.name': 's' } }, events: [], links: [], duration: [1, 0], ended: true, instrumentationLibrary: { name: 't' }, droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0 };
    await (flusher as any).writeFailedLog('claude-code', 'primary', [span], { code: 14, message: 'down' });
    await flusher.shutdown();
    const files = await fs.readdir(failedDir);
    expect(files.length).toBeGreaterThan(0);
    expect(await mode(failedDir)).toBe(0o700);
    for (const file of files) expect(await mode(path.join(failedDir, file))).toBe(0o600);
  });

  it('replay rewrites and quarantine files are private as well', async () => {
    const failedDir = path.join(dir, 'failed');
    await fs.mkdir(failedDir, { recursive: true });
    const record = JSON.stringify({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'n', startTimeUnixNano: String(Date.now() * 1e6), endTimeUnixNano: '2', attributes: {} });
    await fs.writeFile(path.join(failedDir, 'svc__primary-2026-10-14.jsonl'), `${record}\n{broken json\n`, { mode: 0o644 });
    // An unreachable backend: the good record stays (rewritten), the broken line is quarantined.
    await replayFailedSpans(failedDir, { name: 'primary', url: 'http://ingest.test/v1/traces', headers: {} }, async () => new Response('x', { status: 503 }));
    const rejected = path.join(failedDir, 'rejected');
    expect(await mode(rejected)).toBe(0o700);
    for (const file of await fs.readdir(rejected)) expect(await mode(path.join(rejected, file))).toBe(0o600);
    for (const file of (await fs.readdir(failedDir)).filter(f => f.endsWith('.jsonl'))) expect(await mode(path.join(failedDir, file)), file).toBe(0o600);
  });
});

describe.skipIf(!posix)('C11 minors: debug log, SLS failure log and legacy claimed files are private as well', () => {
  it('the OTLP debug log (full prompts in the spans) is 0700/0600 even when its directory pre-exists loose', async () => {
    const debugDir = path.join(dir, 'logs', 'otlp-debug');
    await fs.mkdir(debugDir, { recursive: true }); await fs.chmod(debugDir, 0o755);
    const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }], protocol: 'http/protobuf', serviceName: 's', dataDir: dir, debug: true } as never);
    const span = { spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }), name: 'n', kind: 0, startTime: [1000, 0], endTime: [1001, 0], attributes: { 'gen_ai.input.messages': 'prompt text' },
      status: { code: 0 }, resource: { attributes: { 'service.name': 's' } }, events: [], links: [], duration: [1, 0], ended: true, instrumentationLibrary: { name: 't' }, droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0 };
    await (flusher as any).writeDebugLog('claude-code', [span]);
    await flusher.shutdown();
    const files = await fs.readdir(debugDir);
    expect(files.length).toBeGreaterThan(0);
    expect(await mode(debugDir)).toBe(0o700);
    for (const file of files) expect(await mode(path.join(debugDir, file))).toBe(0o600);
  });

  it('the SLS failure log is 0700/0600 and tightened on every write', async () => {
    const { SlsFailureLogWriter } = await import('../../../src/flushers/sls-failure-log-writer.js');
    const failedDir = path.join(dir, 'sls-failed');
    await fs.mkdir(failedDir, { recursive: true }); await fs.chmod(failedDir, 0o755);
    const writer = new SlsFailureLogWriter(failedDir);
    const input = { endpoint: 'e', mode: 'webtracking', project: 'p', logstore: 'l', kind: 'agentActivity', batchCount: 1, batchBytes: 10, error: new Error('x') };
    expect(await writer.write(input)).toBe(true);
    const file = (await fs.readdir(failedDir)).find(f => f.endsWith('.jsonl'))!;
    await fs.chmod(path.join(failedDir, file), 0o644); await fs.chmod(failedDir, 0o755);
    expect(await writer.write(input)).toBe(true);
    expect(await mode(failedDir)).toBe(0o700);
    expect(await mode(path.join(failedDir, file))).toBe(0o600);
  });

  it('a legacy claimed file left loose is re-tightened when the replayer appends to it', async () => {
    const failedDir = path.join(dir, 'failed-legacy');
    await fs.mkdir(failedDir, { recursive: true });
    const record = JSON.stringify({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'n', startTimeUnixNano: String(Date.now() * 1e6), endTimeUnixNano: '2', attributes: {} });
    const claimed = path.join(failedDir, 'svc__primary.replaying-2026-10-14.jsonl');
    await fs.writeFile(claimed, `${record}\n`, { mode: 0o644 }); await fs.chmod(claimed, 0o644);
    // A concurrent writer left an unclaimed file of the same day: it is appended onto the claimed one (appendTerminated).
    await fs.writeFile(path.join(failedDir, 'svc__primary-2026-10-14.jsonl'), `${record}\n`, { mode: 0o644 });
    await replayFailedSpans(failedDir, { name: 'primary', url: 'http://ingest.test/v1/traces', headers: {} }, async () => new Response('x', { status: 503 }));
    for (const file of (await fs.readdir(failedDir)).filter(f => f.endsWith('.jsonl'))) expect(await mode(path.join(failedDir, file)), file).toBe(0o600);
  });
});
