import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { JobStore } from '../../src/enrichment/job-store.js';
import { EnrichmentScheduler } from '../../src/enrichment/scheduler.js';
import { AnalyticsRuntime } from '../../src/analytics/runtime.js';
import { listCapabilities } from '../../src/analytics/capabilities.js';
import { attachObservation, readObservationEnvelope } from '../../src/analytics/observation-exporter.js';
import { carrierFor } from '../../src/analytics/observation-pump.js';
import { gunzipSync } from 'node:zlib';
import { replayFailedSpans } from '../../src/flushers/otlp-failed-replayer.js';
import type { EffectiveInstrumentationPolicy } from '../../src/analytics/desired-policy-client.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import type { AgentDefinition } from '../../src/types/deployment.js';
import { job, observation } from '../unit/enrichment/fixtures.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-runtime-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const manifests = listCapabilities([JSON.parse(readFileSync('agents.d/claude-code.json', 'utf8')) as AgentDefinition]);
const base = (): EffectiveInstrumentationPolicy => ({ enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true, reason: 'ready', desiredRevision: '3', deletionRevision: '7' });
let WINDOW = { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' };
const page = (revision: string, ids: string[], items?: Array<{ tombstoneId: string; evidenceIds: string[] }>) => ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, error: null,
  data: { revision, items: (items ?? ids.map(i => ({ tombstoneId: 't-' + i, evidenceIds: [i] }))).map(i => ({ ...i, window: WINDOW })), nextCursor: null, hasMore: false } }) }) as Response;

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

  it('derives D4 partial from real events through the wired path with reconciler-shaped statuses (no process probe)', async () => {
    const { runtime } = setup();
    const quiet = Date.now() - 5 * 60_000;
    runtime.onEntries([{ time_unix_nano: String(quiet * 1_000_000), 'event.id': 'e1', 'user.id': 'u', 'event.name': 'tool.call', 'gen_ai.session.id': 's',
      'gen_ai.agent.type': 'claude-code', 'gen_ai.provider.name': 'p' } as AgentActivityEntry]);
    // Exactly what DesiredStateReconciler emits: configured, no processAlive.
    runtime.onStatuses([{ harnessId: 'claude-code', state: 'configured', observedAt: Date.now(), detected: true, repairResult: 'not_needed' }]);
    await runtime.stop();
    expect(runtime.healthSummary()!.harnesses[0]).toMatchObject({ state: 'partial', activity: 'observed' });
    const idle = setup().runtime;
    idle.onStatuses([{ harnessId: 'claude-code', state: 'configured', observedAt: Date.now(), detected: true, repairResult: 'not_needed' }]);
    await idle.stop();
    expect(idle.healthSummary()!.harnesses[0]).toMatchObject({ state: 'configured', activity: 'unobserved' });
  });

  it('fences a window-only server exclusion for observations inside the window and delivers those outside', async () => {
    for (const [inside, expected] of [[true, []], [false, ['w-1']]] as const) {
      WINDOW = inside ? { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() }
        : { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' };
      const { store, runtime, sent } = setup({ fetchImpl: vi.fn().mockResolvedValue(page('7', [], [{ tombstoneId: 'w', evidenceIds: [] }])) as never });
      await complete(store, undefined as never, { id: 'w-1', dedupeKey: 'w-1' });
      await runtime.tick();
      expect(sent.map(e => readObservationEnvelope(e)!.observationId), inside ? 'inside window' : 'outside window').toEqual(expected);
    }
  });

  it('the flusher failed-log replay obeys the same fence: held before sync, dropped when excluded, sent otherwise', async () => {
    const { store, scheduler, runtime } = setup({ fetchImpl: vi.fn().mockResolvedValue(page('7', ['obs-excluded'])) as never });
    const failedDir = path.join(dir, 'otlp-failed'); await fs.mkdir(failedDir, { recursive: true });
    const record = (id: string) => {
      const o = observation(job({ id, occurredAt: new Date().toISOString() }));
      const entry = attachObservation(carrierFor(o, '/tmp/example', 'u'), o);
      return JSON.stringify({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'obs', startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: entry }) + '\n';
    };
    const file = path.join(failedDir, 'pilot__primary-2026-10-14.jsonl');
    await fs.writeFile(file, record('obs-excluded') + record('obs-ok'));
    const base = '{"traceId":"' + 'c'.repeat(32) + '","spanId":"' + 'd'.repeat(16) + '","name":"base","startTimeUnixNano":"1","endTimeUnixNano":"2","attributes":{"event.id":"plain"}}\n';
    await fs.appendFile(file, base);
    const sentIds: string[] = [];
    const post = async (_u: unknown, init: { body: Buffer }) => { sentIds.push(...[...gunzipSync(init.body).toString('utf8').matchAll(/"stringValue":"(obs-[a-z]+|plain)"/g)].map(m => m[1]!)); return new Response('{}', { status: 200 }); };
    const target = { name: 'primary', url: 'http://ingest.test/v1/traces', headers: {} };
    const fence = runtime.replayFence();
    // Before any exclusion synchronization the analytics records are held: only base telemetry may go out.
    await replayFailedSpans(failedDir, target, post as never, undefined, undefined, { isExcluded: fence.isExcluded, isHeld: fence.isHeld });
    expect(sentIds).toEqual(['plain']);
    expect(await fs.readdir(failedDir)).toHaveLength(1);
    expect((await fs.readFile(path.join(failedDir, (await fs.readdir(failedDir))[0]!), 'utf8')).match(/"name":"obs"/g)).toHaveLength(2);
    // After synchronization the excluded record is dropped from the spool without a send, the other one is delivered.
    await runtime.tick();
    sentIds.length = 0;
    const result = await replayFailedSpans(failedDir, target, post as never, undefined, undefined, { isExcluded: fence.isExcluded, isHeld: fence.isHeld });
    expect(result.excluded).toBe(1);
    expect(sentIds.join()).not.toContain('obs-excluded');
    expect(sentIds.join()).toContain('obs-ok');
    void store; void scheduler;
  });
});
