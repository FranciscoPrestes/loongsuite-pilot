import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { JobStore } from '../../src/enrichment/job-store.js';
import { EnrichmentScheduler } from '../../src/enrichment/scheduler.js';
import { AnalyticsRuntime } from '../../src/analytics/runtime.js';
import { listCapabilities } from '../../src/analytics/capabilities.js';
import { readObservationEnvelope } from '../../src/analytics/observation-exporter.js';
import type { EffectiveInstrumentationPolicy } from '../../src/analytics/desired-policy-client.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import type { AgentDefinition } from '../../src/types/deployment.js';
import { job, observation } from '../unit/enrichment/fixtures.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-runtime-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const manifests = listCapabilities([JSON.parse(readFileSync('agents.d/claude-code.json', 'utf8')) as AgentDefinition]);
const base = (): EffectiveInstrumentationPolicy => ({ enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true, reason: 'ready', desiredRevision: '3', deletionRevision: '7' });
const page = (revision: string, ids: string[]) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, error: null,
  data: { revision, items: ids.map(i => ({ tombstoneId: 't-' + i, evidenceIds: [i] })), nextCursor: null, hasMore: false } }) }) as Response;

function setup(opts: { policy?: EffectiveInstrumentationPolicy; fetchImpl?: typeof fetch } = {}) {
  const state = { policy: opts.policy ?? base() };
  const store = new JobStore(dir, { policy: () => state.policy });
  const scheduler = new EnrichmentScheduler(store, { policy: () => state.policy });
  const sent: AgentActivityEntry[] = []; const statuses: string[] = [];
  const runtime = new AnalyticsRuntime({ dataDir: dir, collectorVersion: '1.2.0', deviceId: 'device-1', userId: 'u1', portalBaseUrl: 'https://portal.test',
    store, scheduler, policy: () => state.policy, credential: () => 'Bearer k', send: async e => { sent.push(e); }, manifests,
    fetch: opts.fetchImpl ?? (vi.fn().mockResolvedValue(page('7', [])) as never), onStatus: s => statuses.push(s) });
  return { state, store, scheduler, runtime, sent, statuses };
}
async function complete(store: JobStore, scheduler: EnrichmentScheduler, over = {}) {
  await store.enqueue(job({ occurredAt: new Date().toISOString(), ...over }));
  const j = (await store.claim(Date.now(), 2000))!;
  await store.complete(j.id, observation(j), j.leaseToken!);
  void scheduler;
}

describe('analytics runtime', () => {
  it('synchronizes exclusions before delivering, and honours server exclusions by evidence id', async () => {
    const { store, scheduler, runtime, sent } = setup({ fetchImpl: vi.fn().mockResolvedValue(page('7', ['gone'])) as never });
    await complete(store, scheduler, { id: 'keep', dedupeKey: 'keep' });
    await complete(store, scheduler, { id: 'gone', dedupeKey: 'gone' });
    expect(await store.replayEntries()).toEqual([]); // closed until synchronized
    await runtime.tick();
    expect(sent.map(e => readObservationEnvelope(e)!.observationId)).toEqual(['keep']);
  });

  it('keeps replay closed and reports when exclusion synchronization fails', async () => {
    const { store, scheduler, runtime, sent, statuses } = setup({ fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 503 }) as never });
    await complete(store, scheduler);
    await runtime.tick();
    expect(sent).toEqual([]);
    expect(statuses).toContain('exclusion_sync_failed');
  });

  it('does nothing while enrichment is disabled by policy', async () => {
    const fetchImpl = vi.fn();
    const { store, scheduler, runtime, sent } = setup({ fetchImpl: fetchImpl as never });
    await complete(store, scheduler);
    const disabled = { ...base(), enrichmentEnabled: false, replayEnabled: false, reason: 'central_disabled' as const };
    const gated = setup({ policy: disabled, fetchImpl: fetchImpl as never });
    await gated.runtime.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    void runtime;
  });

  it('turns reconciler statuses plus native evidence into a published, locally visible health summary', async () => {
    const { runtime, sent } = setup();
    const now = Date.now();
    runtime.onEntries([{ time_unix_nano: String((now - 2000) * 1_000_000), 'event.id': 'e1', 'user.id': 'u', 'event.name': 'tool.call', 'gen_ai.session.id': 's',
      'gen_ai.agent.type': 'claude-code', 'gen_ai.provider.name': 'p', 'gen_ai.input.messages': 'SECRET-CONTENT' } as AgentActivityEntry]);
    runtime.onStatuses([{ harnessId: 'claude-code', state: 'configured', observedAt: now, detected: true, repairResult: 'not_needed', processAlive: true }]);
    await runtime.stop();
    const summary = runtime.healthSummary()!;
    expect(summary.harnesses[0]).toMatchObject({ harnessId: 'claude-code', state: 'healthy', activity: 'observed', receivedFields: ['tool_call'] });
    expect(sent).toHaveLength(1);
    const envelope = readObservationEnvelope(sent[0]!)!;
    expect(envelope.kind).toBe('hook_health');
    expect(JSON.stringify(sent)).not.toContain('SECRET-CONTENT'); // evidence keeps identity only, never content
    expect(JSON.stringify(summary)).not.toContain('SECRET-CONTENT');
    await expect(fs.readFile(path.join(dir, 'analytics', 'validated-event.json'), 'utf8')).resolves.toContain('claude-code');
  });
});
