import { describe, expect, it, vi } from 'vitest';
import { ObservationPump, type ReplaySource } from '../../../src/analytics/observation-pump.js';
import type { Observation } from '../../../src/analytics/observation.js';
import type { EffectiveInstrumentationPolicy } from '../../../src/analytics/desired-policy-client.js';
import { job, observation } from '../enrichment/fixtures.js';

const policy = (over: Partial<EffectiveInstrumentationPolicy> = {}): EffectiveInstrumentationPolicy => ({ enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true, reason: 'ready', desiredRevision: '1', deletionRevision: '1', ...over });
const fakeStore = (entries: Array<{ observation: Observation; workspacePath: string }> = [], losses: Awaited<ReturnType<ReplaySource['losses']>> = []) => ({
  replayEntries: vi.fn(async () => entries), acknowledge: vi.fn(async (ids: readonly string[]) => ids.length), losses: vi.fn(async () => losses), invalidateReplay: vi.fn(),
});
const spool = () => { const records: string[] = []; const failures: string[] = []; return { records, failures,
  persist: async (s: string) => { records.push(s); }, pending: async () => [...records], remove: async () => undefined, recordFailure: async (r: string) => { failures.push(r); } }; };
const entry = () => ({ observation: observation(job({ occurredAt: new Date().toISOString() })), workspacePath: '/tmp/ws' });

describe('observation pump', () => {
  it('sends carriers that are not harness activity (agent type is the collector, never the harness)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const pump = new ObservationPump({ store: fakeStore([entry()]), spool: spool(), policy: () => policy(), credential: () => 'fp',
      transport: { send: async s => { sent.push(JSON.parse(s)); return { status: 200 }; } } });
    pump.bindCredential();
    await pump.drain();
    expect(sent[0]!['gen_ai.agent.type']).toBe('ntconsult-collector');
    expect(sent[0]!['gen_ai.agent.type']).not.toBe(entry().observation.harnessId);
  });

  it('sends nothing before exclusions were synchronized and the credential bound', async () => {
    const store = fakeStore([entry()]); const send = vi.fn(async () => ({ status: 200 }));
    const pump = new ObservationPump({ store, spool: spool(), policy: () => policy(), credential: () => 'fp', transport: { send } });
    expect(await pump.drain()).toMatchObject({ exported: 0, blocked: 'not_synchronized' });
    expect(store.replayEntries).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('closes and invalidates replay when the policy stops allowing it', async () => {
    const store = fakeStore([entry()]); let allowed = true;
    const pump = new ObservationPump({ store, spool: spool(), policy: () => policy({ replayEnabled: allowed }), credential: () => 'fp', transport: { send: async () => ({ status: 200 }) } });
    pump.bindCredential(); allowed = false;
    expect(await pump.drain()).toMatchObject({ blocked: 'replay_disabled' });
    expect(store.invalidateReplay).toHaveBeenCalled();
    expect(store.acknowledge).not.toHaveBeenCalled();
  });

  it('rechecks authorization immediately before the send: a credential change mid-drain spools instead of sending', async () => {
    const store = fakeStore([entry()]); const send = vi.fn(async () => ({ status: 200 })); const kept = spool(); let calls = 0;
    const pump = new ObservationPump({ store, spool: kept, policy: () => policy(), credential: () => (++calls <= 2 ? 'fp-1' : 'fp-2'), transport: { send } });
    pump.bindCredential();
    expect(await pump.drain()).toMatchObject({ exported: 0, spooled: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(kept.records).toHaveLength(1);
  });

  it('fails closed on identity-rewriting redaction: recorded, never sent, and acknowledged so it cannot loop', async () => {
    const bad = { ...entry(), observation: { ...entry().observation, sessionId: 'someone@example.com' } as Observation };
    const store = fakeStore([bad]); const send = vi.fn(async () => ({ status: 200 })); const kept = spool();
    const pump = new ObservationPump({ store, spool: kept, policy: () => policy(), credential: () => 'fp', transport: { send } });
    pump.bindCredential();
    expect(await pump.drain()).toMatchObject({ exported: 0, failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(kept.failures.join()).toContain('redaction');
    expect(store.acknowledge).toHaveBeenCalledWith([bad.observation.observationId]);
  });

  it('keeps a result in the store when neither the transport nor the spool could take it, and releases permanent rejections', async () => {
    const full = { ...spool(), persist: async () => { throw new Error('spool full'); } };
    const store = fakeStore([entry()]);
    const pump = new ObservationPump({ store, spool: full, policy: () => policy(), credential: () => 'fp', transport: { send: async () => { throw new Error('offline'); } } });
    pump.bindCredential();
    expect(await pump.drain()).toMatchObject({ exported: 0, spooled: 0, failed: 1 });
    expect(store.acknowledge).not.toHaveBeenCalled(); // retried next tick, never lost
    const rejected = fakeStore([entry()]);
    const pump2 = new ObservationPump({ store: rejected, spool: spool(), policy: () => policy(), credential: () => 'fp', transport: { send: async () => ({ status: 422 }) } });
    pump2.bindCredential();
    expect(await pump2.drain()).toMatchObject({ failed: 1 });
    expect(rejected.acknowledge).toHaveBeenCalledTimes(1); // permanent: recorded by the exporter, then released
  });

  it('summarises every loss reason including busy spills', async () => {
    const store = fakeStore([], [
      { reason: 'expired', count: 2, from: 'a', to: 'b', unreported: false }, { reason: 'busy', count: 5, from: 'a', to: 'b', unreported: false }, { reason: 'quota', count: 1, from: 'a', to: 'b', unreported: false }]);
    const pump = new ObservationPump({ store, spool: spool(), policy: () => policy(), credential: () => 'fp', transport: { send: async () => ({ status: 200 }) } });
    expect(await pump.lossSummary()).toEqual({ expired: 2, quota: 1, busy: 5, total: 8 });
  });
});
