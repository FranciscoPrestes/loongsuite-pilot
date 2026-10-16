import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EnrichmentScheduler } from '../../../src/enrichment/scheduler.js';
import { JobStore } from '../../../src/enrichment/job-store.js';
import { boundToJob, registerEnrichmentHandlers } from '../../../src/analytics/enrichment-handlers.js';
import { buildLocalReportObservation } from '../../../src/enrichment/local-report.js';
import { job, observation } from '../enrichment/fixtures.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-handlers-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const policy = () => ({ enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true as const, reason: 'ready' as const, desiredRevision: '1', deletionRevision: '1' });
const payload = { head: null, branch: null, worktreeId: 'wt', dirtyFingerprint: 'fp', files: [], truncated: false };

describe('enrichment handler registration', () => {
  it('registers only kinds that a LocalJob can feed and leaves the others deferred without burning attempts', async () => {
    const store = new JobStore(dir, { policy });
    const scheduler = new EnrichmentScheduler(store, { policy });
    registerEnrichmentHandlers(scheduler, { snapshot: async () => payload });
    await store.enqueue(job({ occurredAt: new Date().toISOString(), kind: 'command_context', id: 'cc', dedupeKey: 'cc' }));
    await scheduler.tick();
    const claimed = (await store.claim(Date.now() + 5000, 2000, ['command_context']))!;
    expect(claimed.attempt).toBe(0);
  });

  it('a registered snapshot handler produces a result the store accepts end to end', async () => {
    const store = new JobStore(dir, { policy });
    const scheduler = new EnrichmentScheduler(store, { policy });
    registerEnrichmentHandlers(scheduler, { snapshot: async () => payload, now: () => new Date(Date.now() + 10) });
    await store.synchronizeTombstones('1', []);
    await store.enqueue(job({ occurredAt: new Date().toISOString() }));
    await scheduler.tick();
    expect((await store.replayEntries()).map(e => e.observation.kind)).toEqual(['repo_snapshot']);
  });

  it('rebinds derived observation ids to the job id so local_report results cannot be rejected or collide', () => {
    const j = job({ kind: 'local_report', occurredAt: new Date().toISOString() });
    const derived = buildLocalReportObservation(j, { runner: 'vitest', cases: 1, passed: 1, failed: 0, durationMs: 5, sourceHash: 'a'.repeat(64), executionId: null, association: 'unresolved' });
    expect(derived.observationId).not.toBe(j.id);
    expect(boundToJob(derived, j.id).observationId).toBe(j.id);
    expect(boundToJob(observation(j), j.id)).toEqual(observation(j));
  });

  it('a handler that cannot finish inside the deadline never publishes a late result', async () => {
    const store = new JobStore(dir, { policy });
    const scheduler = new EnrichmentScheduler(store, { policy, timeoutMs: 30 });
    registerEnrichmentHandlers(scheduler, { snapshot: (_p, signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    await store.synchronizeTombstones('1', []);
    await store.enqueue(job({ occurredAt: new Date().toISOString() }));
    await scheduler.tick();
    expect(await store.replayEntries()).toEqual([]);
  });
});

describe('job identity and ownership', () => {
  it('derives a distinct job id per kind for the same source event so observation ids can never collide', async () => {
    const { jobFromEntry } = await import('../../../src/enrichment/job-contract.js');
    const entry = { 'event.id': 'native', time_unix_nano: String(BigInt(Date.now()) * 1000000n), 'gen_ai.session.id': 's', 'gen_ai.agent.type': 'claude-code', 'workspace.path': '/tmp/ws' } as never;
    const snapshot = jobFromEntry(entry, 'in', 'dev', '1')!;
    const context = jobFromEntry(entry, 'in', 'dev', '1', 'command_context')!;
    expect(snapshot.kind).toBe('repo_snapshot');
    expect(context.kind).toBe('command_context');
    expect(context.id).not.toBe(snapshot.id);
    expect(jobFromEntry(entry, 'in', 'dev', '1')!.id).toBe(snapshot.id); // stable per kind
  });

  it('refuses a second registration for a kind instead of silently replacing the trusted handler', () => {
    const store = new JobStore(dir, { policy });
    const scheduler = new EnrichmentScheduler(store, { policy });
    registerEnrichmentHandlers(scheduler, { snapshot: async () => payload });
    expect(() => registerEnrichmentHandlers(scheduler)).toThrow('already registered');
  });
});
