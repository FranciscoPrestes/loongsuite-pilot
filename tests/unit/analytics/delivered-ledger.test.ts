import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileLedger, recordEventMs } from '../../../src/analytics/runtime.js';

let dir: string; let file: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-ledger-')); file = path.join(dir, 'analytics', 'delivered-ids.json'); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('delivered-id ledger', () => {
  it('round-trips across two instances over the same file', async () => {
    const a = fileLedger(file); await a.ready!();
    a.add('obs-1'); a.add('obs-2');
    await a.flush();
    const b = fileLedger(file); await b.ready!();
    expect(b.has('obs-1')).toBe(true);
    expect(b.has('obs-2')).toBe(true);
    expect(b.has('obs-3')).toBe(false);
  });

  it('flush writes nothing when nothing changed and survives a missing directory', async () => {
    const a = fileLedger(file); await a.ready!();
    await a.flush();
    await expect(fs.stat(file)).rejects.toThrow();
    a.add('x'); await a.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(['x']);
  });

  it('evicts the oldest ids first at the 20,000 limit, in memory and on disk', async () => {
    const a = fileLedger(file); await a.ready!();
    for (let i = 0; i <= 20_000; i += 1) a.add('id-' + i);
    expect(a.has('id-0')).toBe(false);
    expect(a.has('id-1')).toBe(true);
    expect(a.has('id-20000')).toBe(true);
    await a.flush();
    const saved = JSON.parse(await fs.readFile(file, 'utf8')) as string[];
    expect(saved).toHaveLength(20_000);
    expect(saved[0]).toBe('id-1');
    const b = fileLedger(file); await b.ready!();
    expect(b.has('id-0')).toBe(false);
    expect(b.has('id-20000')).toBe(true);
  });

  it.each(['{corrupt', '{"not":"an array"}', '', '[1, {"x":2}, null]'])('a damaged file (%s) starts empty without blocking and is replaced on flush', async (content) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    const a = fileLedger(file); await a.ready!();
    expect(a.has('obs-1')).toBe(false);
    a.add('obs-1'); await a.flush();
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toContain('obs-1');
  });
});

describe('failed-log event time', () => {
  it('uses the span start time, and falls back (undefined) when absent, blank, zero or garbage', () => {
    expect(recordEventMs({ startTimeUnixNano: '1792000000000000000' })).toBe(1_792_000_000_000);
    for (const bad of [undefined, '', '0', '1.5', 'abc', 12, null, '-5']) expect(recordEventMs({ startTimeUnixNano: bad }), String(bad)).toBeUndefined();
  });
});
