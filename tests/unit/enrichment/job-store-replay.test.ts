import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobStore } from '../../../src/enrichment/job-store.js';
import { job, observation } from './fixtures.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-store-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const policy = () => ({ enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true as const, reason: 'ready' as const, desiredRevision: '1', deletionRevision: '1' });
const fresh = (over = {}) => job({ occurredAt: new Date().toISOString(), ...over });
async function completed(store: JobStore, over = {}, capturedAt?: string) {
  const j = fresh(over);
  await store.enqueue(j);
  const claimed = (await store.claim(Date.now(), 2000))!;
  await store.complete(j.id, { ...observation(j), ...(capturedAt ? { occurredAt: capturedAt } : {}) }, claimed.leaseToken!);
  return j;
}

describe('C8 store seams', () => {
  it('accepts a real capture time at or after the signal and refuses earlier or future ones', async () => {
    const store = new JobStore(dir, { policy });
    const j = fresh();
    await store.enqueue(j);
    const claimed = (await store.claim(Date.now(), 2000))!;
    const before = new Date(Date.parse(j.occurredAt) - 1000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    await expect(store.complete(j.id, { ...observation(j), occurredAt: before }, claimed.leaseToken!)).rejects.toThrow('provenance');
    await expect(store.complete(j.id, { ...observation(j), occurredAt: future }, claimed.leaseToken!)).rejects.toThrow('provenance');
    await store.complete(j.id, { ...observation(j), occurredAt: new Date(Date.parse(j.occurredAt) + 500).toISOString() }, claimed.leaseToken!);
  });

  it('replayEntries pairs every result with the real workspace and acknowledge drains only completed records', async () => {
    const store = new JobStore(dir, { policy });
    await store.synchronizeTombstones('1', []);
    await completed(store, { id: 'a', dedupeKey: 'a', workspacePath: '/tmp/ws-a' });
    await store.enqueue(fresh({ id: 'pending', dedupeKey: 'p' }));
    const entries = await store.replayEntries();
    expect(entries.map(e => [e.observation.observationId, e.workspacePath])).toEqual([['a', '/tmp/ws-a']]);
    expect((await store.replayBatch()).map(o => o.observationId)).toEqual(['a']);
    expect(await store.acknowledge(['pending', 'missing', 'a'])).toBe(1);
    expect(await store.replayEntries()).toEqual([]);
    expect(await store.claim(Date.now(), 2000)).toMatchObject({ id: 'pending' }); // still pending, untouched
  });

  it('does not expose results before exclusions are synchronized', async () => {
    const store = new JobStore(dir, { policy });
    await completed(store);
    expect(await store.replayEntries()).toEqual([]);
  });
});
