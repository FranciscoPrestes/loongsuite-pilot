import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JobStore } from '../../src/enrichment/job-store.js';
import { EnrichmentScheduler } from '../../src/enrichment/scheduler.js';
import { registerEnrichmentHandlers } from '../../src/analytics/enrichment-handlers.js';
import { ObservationPump } from '../../src/analytics/observation-pump.js';
import { createExclusionFence, FileObservationSpool, readObservationEnvelope } from '../../src/analytics/observation-exporter.js';
import type { EffectiveInstrumentationPolicy } from '../../src/analytics/desired-policy-client.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { job } from '../unit/enrichment/fixtures.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-flow-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const state = { policy: { enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true as const, reason: 'ready' as const, desiredRevision: '3', deletionRevision: '7' } as EffectiveInstrumentationPolicy, credential: 'fp-1' as string | null };
const payload = { head: 'abc', branch: 'main', worktreeId: 'wt', dirtyFingerprint: 'fp', files: [], truncated: false };
const fresh = (over = {}) => job({ occurredAt: new Date().toISOString(), ...over });

async function harness() {
  const store = new JobStore(dir, { policy: () => state.policy });
  const scheduler = new EnrichmentScheduler(store, { policy: () => state.policy });
  const capturedAt = new Date(Date.now() + 1000); // fixed clock: a re-capture of the same source event is byte-identical
  registerEnrichmentHandlers(scheduler, { snapshot: async () => payload, now: () => capturedAt });
  const sent: AgentActivityEntry[] = [];
  const pump = new ObservationPump({
    store, spool: new FileObservationSpool(path.join(dir, 'spool')), policy: () => state.policy, credential: () => state.credential,
    transport: { send: async serialized => { sent.push(JSON.parse(serialized) as AgentActivityEntry); return { status: 200 }; } },
  });
  await store.synchronizeTombstones('7', []);
  pump.bindCredential();
  return { store, scheduler, pump, sent };
}
// Consumer fixture: facts keyed by the preserved observation identity (idempotent upsert).
const factsOf = (sent: AgentActivityEntry[]) => Object.fromEntries(sent.map(e => {
  const env = readObservationEnvelope(e)!; return [env.observationId, env.observation];
}));

describe('analytics observation flow', () => {
  it('full_replay_flow_idempotent', async () => {
    const { store, scheduler, pump, sent } = await harness();
    await store.enqueue(fresh());
    await scheduler.tick();
    const first = await pump.drain();
    expect(first).toMatchObject({ exported: 1, excluded: 0 });
    const factsBeforeReplay = factsOf(sent);
    expect(Object.keys(factsBeforeReplay)).toEqual(['job-1']);
    // Delivered journals are acknowledged: a second drain resends nothing.
    expect(await pump.drain()).toMatchObject({ exported: 0 });
    // Replay of the same source event (crash window / re-enqueue) keeps identity.
    await store.enqueue(fresh());
    await scheduler.tick();
    await pump.drain();
    expect(sent).toHaveLength(2);
    expect(factsOf(sent)).toEqual(factsBeforeReplay);
  });

  it('handler_result_is_bound_to_the_job_identity_and_wire_carries_the_real_workspace', async () => {
    const { store, scheduler, pump, sent } = await harness();
    await store.enqueue(fresh({ id: 'job-ws', dedupeKey: 'n-ws', workspacePath: '/tmp/ws-a' }));
    await scheduler.tick();
    await pump.drain();
    expect(sent[0]!['workspace.path']).toBe('/tmp/ws-a');
    expect(readObservationEnvelope(sent[0]!)!.observationId).toBe('job-ws');
  });

  it('workspace_tombstone_excludes_only_that_workspace', async () => {
    const { store, scheduler, pump, sent } = await harness();
    pump.setFence(createExclusionFence([{ id: 'other', deviceId: 'device-1', workspacePath: '/tmp/ws-a' }]));
    await store.enqueue(fresh({ id: 'a', dedupeKey: 'a', workspacePath: '/tmp/ws-a' }));
    await store.enqueue(fresh({ id: 'b', dedupeKey: 'b', workspacePath: '/tmp/ws-b' }));
    await scheduler.tick(); await scheduler.tick();
    const outcome = await pump.drain();
    expect(outcome).toMatchObject({ exported: 1, excluded: 1 });
    expect(sent.map(e => readObservationEnvelope(e)!.observationId)).toEqual(['b']);
  });

  it('credential_change_invalidates_replay_until_resynchronized', async () => {
    const { store, scheduler, pump, sent } = await harness();
    await store.enqueue(fresh());
    await scheduler.tick();
    state.credential = 'fp-2';
    expect(await pump.drain()).toMatchObject({ exported: 0, blocked: 'credential_changed' });
    expect(sent).toHaveLength(0);
    // Even restoring the old credential does not re-enable without a new synchronization.
    state.credential = 'fp-1';
    expect(await pump.drain()).toMatchObject({ exported: 0 });
    await store.synchronizeTombstones('7', []);
    pump.bindCredential();
    expect(await pump.drain()).toMatchObject({ exported: 1 });
    state.credential = 'fp-1';
  });

  it('transport_failure_spools_durably_and_replays_after_recovery', async () => {
    const { store, scheduler } = await harness();
    let up = false; const delivered: string[] = [];
    const pump = new ObservationPump({ store, spool: new FileObservationSpool(path.join(dir, 'spool2')), policy: () => state.policy, credential: () => state.credential,
      transport: { send: async s => { if (!up) throw new Error('offline'); delivered.push(s); return { status: 200 }; } } });
    pump.bindCredential();
    await store.enqueue(fresh());
    await scheduler.tick();
    expect(await pump.drain()).toMatchObject({ exported: 0, spooled: 1 });
    expect(await pump.drain()).toMatchObject({ spooled: 0 }); // acknowledged into the spool, not re-spooled
    up = true;
    expect((await pump.replaySpool()).sent).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('losses_are_summarised_for_health_without_losing_reasons', async () => {
    const { store, pump } = await harness();
    expect(await pump.lossSummary()).toEqual({ expired: 0, quota: 0, busy: 0, total: 0 });
    // Expired ingress is rejected but recorded as a durable loss, never silently dropped.
    await expect(store.enqueue(fresh({ occurredAt: '2020-01-01T00:00:00Z', id: 'old', dedupeKey: 'old' }))).rejects.toThrow();
    expect(await pump.lossSummary()).toEqual({ expired: 1, quota: 0, busy: 0, total: 1 });
  });
});
