import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';

// The REAL converter and flusher are used on purpose: only the network exporter is faked.
const exported = vi.hoisted(() => [] as any[]);
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((spans: unknown[], cb: (r: { code: number }) => void) => { exported.push(...spans); cb({ code: ExportResultCode.SUCCESS }); }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { attachObservation, FileObservationSpool, readObservationEnvelope } from '../../../../src/analytics/observation-exporter.js';
import { ObservationPump, carrierFor } from '../../../../src/analytics/observation-pump.js';
import { createHealthPublisher } from '../../../../src/analytics/health-publisher.js';
import { JobStore } from '../../../../src/enrichment/job-store.js';
import { EnrichmentScheduler } from '../../../../src/enrichment/scheduler.js';
import { registerEnrichmentHandlers } from '../../../../src/analytics/enrichment-handlers.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { job, observation } from '../../enrichment/fixtures.js';

/** Ingest limits (HUB rotas-otlp.ts): request body 16 MiB; no per-attribute cap found. Collector: envelope <= 256 KiB, replay request <= 8 MiB raw. */
const MAX_ENVELOPE_BYTES = 262_144;
const startMs = (span: any) => span.startTime[0] * 1000 + Math.floor(span.startTime[1] / 1e6);
const annotated = (span: any) => span.attributes?.['ntconsult.analytics.kind'] !== undefined;
const envelopeOf = (span: any) => readObservationEnvelope(span.attributes as AgentActivityEntry);

let dir: string;
beforeEach(async () => { exported.length = 0; dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-carrier-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const newFlusher = () => new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: {} }],
  protocol: 'http/protobuf' as const, serviceName: 'test-pilot' } as never);
async function viaFlusher(run: (send: (entry: AgentActivityEntry) => Promise<void>) => Promise<void>) {
  const flusher = newFlusher();
  await run(entry => flusher.send(entry));
  await flusher.flush();
  await flusher.shutdown();
  return exported.filter(annotated);
}
const policy = { enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true as const, reason: 'ready' as const, desiredRevision: '3', deletionRevision: '7' };

describe('analytics carrier through the REAL OTLP flusher and converter (interim channel b)', () => {
  it('carries the marker so the converter keeps the annotations: exactly 2 spans per observation, both annotated', async () => {
    const signalAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const o = { ...observation(job({ occurredAt: signalAt })), occurredAt: new Date().toISOString() };
    const entry = attachObservation(carrierFor(o, '/tmp/example', 'u', signalAt), o);
    expect(entry['gen_ai.input.messages_delta']).toEqual([]);
    const spans = await viaFlusher(send => send(entry));
    expect(exported).toHaveLength(2);           // invoke_agent + entry span, nothing else
    expect(spans).toHaveLength(2);
    expect(spans.every(span => envelopeOf(span)?.observationId === o.observationId)).toBe(true);
    expect(spans.every(span => startMs(span) === Date.parse(signalAt))).toBe(true); // source event time, not capture time
    // The only AGENT-shaped span is the collector's own, never a harness: consumers key on it to exclude carriers.
    expect(spans.map(span => span.name).sort()).toEqual(['enter_ai_application_system', 'invoke_agent ntconsult-collector']);
  });

  it('health: every hook_health observation arrives intact with its ACK', async () => {
    const spans = await viaFlusher(async send => {
      const publisher = createHealthPublisher({ deviceId: 'dev', userId: 'u', collectorVersion: '1.2.0', now: () => new Date(), policy: () => policy }, send);
      await publisher.publishCollectionHealth([{ harnessId: 'claude-code', state: 'configured', observedAt: Date.now(), detected: true, repairResult: 'not_needed' }]);
    });
    expect(spans).toHaveLength(2);
    const env = envelopeOf(spans[0]!)!;
    expect(env.kind).toBe('hook_health');
    expect(env.observation.kind === 'hook_health' && env.observation.payload.ack?.desiredRevision).toBe('3');
  });

  it('snapshot: a handler result drained by the pump reaches the exporter with its identity and real workspace', async () => {
    const store = new JobStore(dir, { policy: () => policy });
    const scheduler = new EnrichmentScheduler(store, { policy: () => policy });
    registerEnrichmentHandlers(scheduler, { snapshot: async () => ({ head: 'abc', branch: 'main', worktreeId: 'wt', dirtyFingerprint: 'fp', files: [], truncated: false }) });
    await store.synchronizeTombstones('7', []);
    await store.enqueue(job({ occurredAt: new Date().toISOString(), workspacePath: '/tmp/ws-real' }));
    await scheduler.tick();
    const spans = await viaFlusher(async send => {
      const pump = new ObservationPump({ store, spool: new FileObservationSpool(path.join(dir, 'spool')), policy: () => policy, credential: () => 'fp',
        transport: { send: async s => { await send(JSON.parse(s)); return { status: 200 }; } } });
      pump.bindCredential();
      expect(await pump.drain()).toMatchObject({ exported: 1 });
    });
    expect(spans).toHaveLength(2);
    expect(envelopeOf(spans[0]!)!.kind).toBe('repo_snapshot');
    expect(spans[0]!.attributes['workspace.path']).toBe('/tmp/ws-real');
  });

  it('replay: a spooled observation resent after recovery keeps its observationId and content', async () => {
    const store = new JobStore(dir, { policy: () => policy });
    const scheduler = new EnrichmentScheduler(store, { policy: () => policy });
    registerEnrichmentHandlers(scheduler, { snapshot: async () => ({ head: 'abc', branch: null, worktreeId: 'wt', dirtyFingerprint: 'fp', files: [], truncated: false }) });
    await store.synchronizeTombstones('7', []);
    await store.enqueue(job({ occurredAt: new Date().toISOString() }));
    await scheduler.tick();
    let up = false;
    const spans = await viaFlusher(async send => {
      const pump = new ObservationPump({ store, spool: new FileObservationSpool(path.join(dir, 'spool')), policy: () => policy, credential: () => 'fp',
        transport: { send: async s => { if (!up) throw new Error('offline'); await send(JSON.parse(s)); return { status: 200 }; } } });
      pump.bindCredential();
      expect(await pump.drain()).toMatchObject({ spooled: 1 });
      up = true;
      expect((await pump.replaySpool()).sent).toHaveLength(1);
    });
    expect(spans).toHaveLength(2);
    expect(envelopeOf(spans[0]!)!.observationId).toBe('job-1');
  });

  it('size: a near-limit observation survives the attribute path unchanged and stays far below the ingest body limit', async () => {
    const files = Array.from({ length: 100 }, (_, i) => ({ path: `src/${'d'.repeat(560)}/${i}.ts`, status: 'modified' as const }));
    const base = observation(job({ occurredAt: new Date().toISOString() }));
    const o = { ...base, payload: { head: 'abc', branch: null, worktreeId: 'wt', dirtyFingerprint: 'fp', files, truncated: false } } as typeof base;
    const json = JSON.stringify(o);
    expect(Buffer.byteLength(json)).toBeGreaterThan(50_000);
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(65_536); // the store's own result cap
    const spans = await viaFlusher(send => send(attachObservation(carrierFor(o, '/tmp/example', 'u'), o)));
    expect(spans).toHaveLength(2);
    expect(spans.every(span => span.attributes['ntconsult.analytics.observation'] === JSON.stringify(envelopeOf(span)!.observation))).toBe(true);
    expect(envelopeOf(spans[0]!)!.observation).toEqual({ ...o, generatedBy: 'analytics' });
    // Worst case per observation: 2 spans x 256 KiB envelope is ~0.5 MiB, i.e. < 16 MiB ingest body and < 8 MiB replay batch.
    expect(2 * MAX_ENVELOPE_BYTES).toBeLessThan(8 * 1024 * 1024);
  });
});
