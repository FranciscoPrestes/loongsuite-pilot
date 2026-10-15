import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { cleanupTempDir, createTempDir } from '../helpers/fixture-builder.js';
import { AgentActivityEntrySchema } from './agent-activity-schema.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { SUPPORTED_MASK_TYPES } from '../../src/types/index.js';
import { validateObservation, type Observation } from '../../src/analytics/observation.js';
import {
  ANALYTICS_ANNOTATION_KEYS,
  FileObservationSpool,
  ObservationExporter,
  attachObservation,
  configureObservationExporter,
  createExclusionFence,
  exportObservation,
  readObservationEnvelope,
  synchronizeExclusions,
  type ObservationTransport,
} from '../../src/analytics/observation-exporter.js';
import { maskAgentActivityEntry } from '../../src/mask/entry-masker.js';
import { applyAgentContentPolicy } from '../../src/normalization/agent-content-policy.js';
import { sanitizeAttributes } from '../../src/normalization/global-attributes.js';
import { createReadableSpanToOtlpSpanJsonArray } from '../../src/flushers/otlp-json-serializer.js';
import { replayFailedSpans, toOtlpJsonRequest } from '../../src/flushers/otlp-failed-replayer.js';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: ['trace-1'], spanCount: 1, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_s: unknown, cb: (r: { code: number }) => void) => cb({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

const secretFixture = `sk-or-v1-${'a1b2c3d4'.repeat(6)}`;
const deviceId = 'device-c7';

function ref(nativeId: string, sourceNamespace = 'claude-code.hook') {
  return { sourceNamespace, nativeId, phase: 'event' as const };
}

function makeObservation(overrides: Record<string, unknown> = {}): Observation {
  return validateObservation({
    schemaVersion: '1',
    observationId: 'obs-1',
    harnessId: 'claude-code',
    harnessVersion: '2.0.0',
    collectorVersion: '1.2.3',
    capabilitiesVersion: '1',
    deviceId,
    sessionId: 'session-1',
    occurredAt: '2026-10-14T12:00:00.000Z',
    missingFields: [],
    truncated: false,
    sourceRefs: [ref('call-1')],
    kind: 'command_context',
    payload: {
      resolvedCommand: null,
      scriptChain: [],
      modulePaths: ['package.json'],
      reason: 'derived from TES evidence',
    },
    ...overrides,
  });
}

function baseEntry(extra: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1760443200000000000',
    'event.id': 'evt-1',
    'event.name': 'other',
    'user.id': 'user-1',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.provider.name': 'anthropic',
    ...extra,
  } as unknown as AgentActivityEntry;
}

function captureTransport() {
  const sent: string[] = [];
  const state = { failNetwork: false, status: 200 };
  const transport: ObservationTransport = {
    async send(serialized: string) {
      if (state.failNetwork) throw new TypeError('fetch failed');
      sent.push(serialized);
      return { status: state.status };
    },
  };
  return { sent, state, transport };
}

async function allFilesUnder(dir: string): Promise<string> {
  try {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      out.push(await fs.readFile(path.join(entry.parentPath ?? dir, entry.name), 'utf8'));
    }
    return out.join('\n');
  } catch {
    return '';
  }
}

describe('sanitized analytics observation export', () => {
  let dataDir: string;
  let spoolDir: string;

  beforeEach(async () => {
    dataDir = await createTempDir('analytics-export-');
    spoolDir = path.join(dataDir, 'spool');
  });

  afterEach(async () => {
    await cleanupTempDir(dataDir);
  });

  it('masked_before_spool_and_export', async () => {
    const { sent, state, transport } = captureTransport();
    const exporter = new ObservationExporter({ transport, spool: new FileObservationSpool(spoolDir) });
    const observation = makeObservation({
      observationId: 'obs-secret-1',
      payload: { resolvedCommand: `deploy --token ${secretFixture}`, scriptChain: [], modulePaths: [], reason: null },
    });
    const entry = attachObservation(baseEntry(), observation);
    // Masking happens at attach, before any enriched payload is persisted.
    expect(JSON.stringify(entry)).not.toContain(secretFixture);
    state.failNetwork = true;
    await exporter.exportObservation(entry); // lands in the managed spool
    // A hand-built envelope that bypassed attach is masked before the spool too.
    const handObservation = makeObservation({
      observationId: 'obs-hand-1',
      payload: { resolvedCommand: `deploy --token ${secretFixture}`, scriptChain: [], modulePaths: [], reason: null },
    });
    await exporter.exportObservation({
      ...baseEntry({ 'event.id': 'evt-hand' }),
      'ntconsult.analytics.schema_version': '1',
      'ntconsult.analytics.observation_id': handObservation.observationId,
      'ntconsult.analytics.kind': handObservation.kind,
      'ntconsult.analytics.observation': JSON.stringify(handObservation),
      'ntconsult.analytics.generated_by': 'analytics',
    } as unknown as AgentActivityEntry);
    expect(await allFilesUnder(spoolDir)).not.toContain(secretFixture);
    state.failNetwork = false;
    await exporter.replay(); // leaves through the export transport
    const serialized = sent[0];
    expect(serialized).not.toContain(secretFixture);
    expect(sent.join('\n')).not.toContain(secretFixture);
    // The standard entry masker masks the persisted annotation (allowlisted field).
    const injected = baseEntry({
      'ntconsult.analytics.observation': JSON.stringify({
        ...observation,
        payload: { ...observation.payload, resolvedCommand: `deploy --token ${secretFixture}` },
      }),
    });
    const masked = maskAgentActivityEntry(injected, { mode: 'all', types: [...SUPPORTED_MASK_TYPES], replacementMode: 'placeholder' });
    expect(JSON.stringify(masked)).not.toContain(secretFixture);
  });

  it('offline_replay_preserves_id', async () => {
    const original = makeObservation({
      observationId: 'obs-replay-1',
      missingFields: ['payload.executionId'],
      truncated: true,
      sourceRefs: [ref('call-9'), ref('call-9', 'claude-code.log')],
    });
    const { sent, state, transport } = captureTransport();
    const exporter = new ObservationExporter({ transport, spool: new FileObservationSpool(spoolDir) });
    state.failNetwork = true;
    await exporter.exportObservation(attachObservation(baseEntry(), original));
    expect(sent).toHaveLength(0);
    state.failNetwork = false;
    const replay = await exporter.replay();
    expect(replay.sent).toHaveLength(1);
    const replayed = readObservationEnvelope(JSON.parse(replay.sent[0]) as AgentActivityEntry)!.observation;
    expect(replayed.observationId).toBe(original.observationId);
    expect(replayed.missingFields).toEqual(original.missingFields);
    expect(replayed.truncated).toBe(original.truncated);
    expect(replayed.sourceRefs).toEqual(original.sourceRefs);
    expect(replayed.schemaVersion).toBe(original.schemaVersion);
    // The OTLP failed-log replay path preserves the very same envelope.
    const failedDir = path.join(dataDir, 'otlp-failed');
    await fs.mkdir(failedDir, { recursive: true });
    const spanRecord = {
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'analytics.observation', kind: 0,
      startTimeUnixNano: '1', endTimeUnixNano: '2',
      attributes: Object.fromEntries(ANALYTICS_ANNOTATION_KEYS.map((key) => [key, JSON.parse(replay.sent[0])[key]])),
    };
    await fs.writeFile(path.join(failedDir, 'pilot__primary-2026-10-14.jsonl'), JSON.stringify(spanRecord) + '\n');
    const bodies: string[] = [];
    await replayFailedSpans(failedDir, { name: 'primary', url: 'http://ingest.test/v1/traces', headers: {} },
      async (_url, init) => { bodies.push(gunzipSync(init.body as Buffer).toString('utf8')); return new Response('{}', { status: 200 }); });
    const replayedFromOtlp = JSON.parse(JSON.parse(bodies[0]).resourceSpans[0].scopeSpans[0].spans[0].attributes
      .find((a: { key: string }) => a.key === 'ntconsult.analytics.observation').value.stringValue);
    expect(replayedFromOtlp.observationId).toBe(original.observationId);
  });

  it('reserved_attributes_survive_otlp', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    const { OtlpTraceFlusher } = await import('../../src/flushers/otlp-trace-flusher.js');
    const annotated = attachObservation(baseEntry({ 'event.name': 'llm.response', 'gen_ai.turn.id': 't1', 'gen_ai.response.finish_reasons': ['stop'] }),
      makeObservation({ observationId: 'obs-otlp-1', missingFields: ['payload.reason'], truncated: true }));
    const flusher = new OtlpTraceFlusher({
      enabled: true, protocol: 'http/protobuf', serviceName: 'test-pilot',
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: {} }],
    });
    try {
      await flusher.send(baseEntry({ 'event.name': 'llm.request', 'gen_ai.turn.id': 't1' }));
      await flusher.send(annotated);
      const callArgs = vi.mocked(convertEventLogToTrace).mock.calls.at(-1)!;
      for (const key of ANALYTICS_ANNOTATION_KEYS) expect(callArgs[1].passthroughKeys).toContain(key);
    } finally {
      await flusher.shutdown();
    }
    // The serialized envelope survives the OTLP span record round trip verbatim.
    const source = readObservationEnvelope(annotated)!.observation;
    const envelopeAttributes = Object.fromEntries(ANALYTICS_ANNOTATION_KEYS.map((key) => [key, annotated[key]]));
    const [line] = createReadableSpanToOtlpSpanJsonArray([{
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }), parentSpanId: undefined,
      name: 'analytics.observation', kind: 0, startTime: [1, 0] as [number, number], endTime: [2, 0] as [number, number],
      attributes: envelopeAttributes, status: { code: 0 }, resource: { attributes: {} }, events: [], links: [],
      duration: [1, 0] as [number, number], ended: true,
      instrumentationLibrary: { name: 'test', version: '1.0.0' }, droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    } as never]);
    const request = JSON.parse(JSON.stringify(toOtlpJsonRequest([JSON.parse(line)])));
    const survived: Record<string, string> = {};
    for (const attribute of request.resourceSpans[0].scopeSpans[0].spans[0].attributes) survived[attribute.key] = attribute.value.stringValue;
    const roundTripped = JSON.parse(survived['ntconsult.analytics.observation']);
    expect(survived['ntconsult.analytics.observation_id']).toBe('obs-otlp-1');
    expect(roundTripped.sourceRefs).toEqual(source.sourceRefs);
    expect(roundTripped.missingFields).toEqual(source.missingFields);
    expect(roundTripped.truncated).toBe(source.truncated);
    expect(roundTripped.schemaVersion).toBe(source.schemaVersion);
  });

  it('analytics_annotations_excluded', async () => {
    const original = baseEntry({ 'gen_ai.tool.call.arguments': { cmd: 'ls' } });
    const aux = attachObservation(original, makeObservation());
    // Client identity stays auxiliary: never rewritten, never promoted.
    expect(aux['user.id']).toBe(original['user.id']);
    expect(aux['gen_ai.session.id']).toBe(original['gen_ai.session.id']);
    // The content policy strips message content but excludes the annotations.
    const stripped = applyAgentContentPolicy(aux, { 'claude-code': { captureMessageContent: false } });
    expect(stripped['gen_ai.tool.call.arguments']).toBeUndefined();
    for (const key of ANALYTICS_ANNOTATION_KEYS) expect(stripped[key]).toBe(aux[key]);
    // Untrusted surfaces cannot inject analytics annotations (allowlist only).
    const forged = baseEntry({
      'ntconsult.analytics.schema_version': '1',
      'ntconsult.analytics.observation_id': 'forged',
      'ntconsult.analytics.kind': 'command_context',
      'ntconsult.analytics.observation': JSON.stringify(makeObservation({ observationId: 'obs-real-id' })),
      'ntconsult.analytics.generated_by': 'analytics',
      'ntconsult.analytics.evil': 'x',
    });
    const sanitized = applyAgentContentPolicy(forged, { 'claude-code': { captureMessageContent: true } });
    expect(sanitized['ntconsult.analytics.evil']).toBeUndefined();
    // A forged/mismatched envelope is excluded from export (id must match the observation).
    expect(readObservationEnvelope(sanitized)).toBeNull();
    expect(sanitizeAttributes({ 'ntconsult.analytics.observation': 'forged', 'custom.key': 'v' })).toEqual({ 'custom.key': 'v' });
  });

  it('no_central_secret_in_bundle', async () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    const sources: string[] = [];
    for (const entry of await fs.readdir(srcRoot, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.ts')) {
        sources.push(await fs.readFile(path.join(entry.parentPath ?? srcRoot, entry.name), 'utf8'));
      }
    }
    const bundle = sources.join('\n');
    expect(bundle).not.toContain('sk-or-v1');
    expect(bundle).not.toContain('OPENROUTER_API_KEY');
    expect(bundle).not.toMatch(/api\.openrouter\.ai/i);
    const enrichment = readObservationEnvelope(attachObservation(baseEntry(), makeObservation()))!.observation;
    expect(enrichment.generatedBy).toBe('analytics');
  });

  it('network_unavailable_persists_failure_without_blocking_the_hook', async () => {
    const { state, transport } = captureTransport();
    state.failNetwork = true;
    const spool = new FileObservationSpool(spoolDir);
    const exporter = new ObservationExporter({ transport, spool });
    const outcome = await exporter.exportWithOutcome(attachObservation(baseEntry(), makeObservation({ observationId: 'obs-offline-1' })));
    expect(outcome).toEqual({ exported: false, spooled: true, excluded: false, failed: null });
    await expect(exporter.exportObservation(attachObservation(baseEntry(), makeObservation({ observationId: 'obs-offline-2' })))).resolves.toBeUndefined();
    expect(await spool.pending()).toHaveLength(2);
  });

  it('duplicate_replay_sends_each_record_at_most_once', async () => {
    const { sent, state, transport } = captureTransport();
    const spool = new FileObservationSpool(spoolDir);
    const exporter = new ObservationExporter({ transport, spool });
    state.failNetwork = true;
    const duplicated = attachObservation(baseEntry({ 'event.id': 'dup-1' }), makeObservation({ observationId: 'obs-dup-1' }));
    await exporter.exportObservation(duplicated);
    await exporter.exportObservation(duplicated); // crash window: same record spooled twice
    state.failNetwork = false;
    const replay = await exporter.replay();
    expect(replay.sent).toHaveLength(1);
    expect(replay.duplicates).toBe(1);
    expect(await spool.pending()).toHaveLength(0);
    expect(await exporter.replay()).toMatchObject({ sent: [], kept: 0 });
  });

  it('adversarial_text_cannot_inject_or_break_the_envelope', async () => {
    const adversarial = `x","ntconsult.analytics.observation_id":"forged','''\u0000\n${'n'.repeat(120)}`;
    const observation = makeObservation({
      observationId: 'obs-adv-1',
      payload: { resolvedCommand: null, scriptChain: [], modulePaths: [], reason: adversarial },
    });
    const forgedEntry = baseEntry({ 'ntconsult.analytics.observation_id': 'forged-1', 'ntconsult.analytics.extra': 'injected' });
    const entry = attachObservation(forgedEntry, observation);
    expect(Object.keys(entry).filter((key) => key.startsWith('ntconsult.analytics.'))).toEqual([...ANALYTICS_ANNOTATION_KEYS]);
    const { sent, transport } = captureTransport();
    await new ObservationExporter({ transport, spool: new FileObservationSpool(spoolDir) }).exportObservation(entry);
    const parsed = JSON.parse(sent[0]) as AgentActivityEntry;
    expect(readObservationEnvelope(parsed)!.observation.observationId).toBe('obs-adv-1');
    expect(parsed['ntconsult.analytics.observation_id']).toBe('obs-adv-1');
  });

  it('redaction_that_removes_a_required_field_fails_closed', async () => {
    const corrupted = makeObservation({ observationId: 'obs-redact-1', harnessId: secretFixture });
    const envelope = {
      'ntconsult.analytics.schema_version': '1',
      'ntconsult.analytics.observation_id': corrupted.observationId,
      'ntconsult.analytics.kind': corrupted.kind,
      'ntconsult.analytics.observation': JSON.stringify(corrupted),
      'ntconsult.analytics.generated_by': 'analytics',
    } as unknown as AgentActivityEntry;
    const { sent, transport } = captureTransport();
    const spool = new FileObservationSpool(spoolDir);
    const outcome = await new ObservationExporter({ transport, spool })
      .exportWithOutcome({ ...baseEntry(), ...envelope } as AgentActivityEntry);
    expect(outcome.exported).toBe(false);
    expect(outcome.spooled).toBe(false);
    expect(outcome.failed).toContain('redaction_removed_required_field');
    expect(sent).toHaveLength(0);
    expect(await spool.pending()).toHaveLength(0);
    expect(await allFilesUnder(dataDir)).not.toContain(secretFixture);
    // attach fails closed too, instead of emitting a corrupt envelope.
    expect(() => attachObservation(baseEntry(), corrupted)).toThrow();
  });

  it('v0_consumer_ignores_analytics_annotations', () => {
    const original = baseEntry({ 'gen_ai.tool.name': 'Read' });
    const aux = attachObservation(original, makeObservation());
    const stripped = { ...aux };
    for (const key of ANALYTICS_ANNOTATION_KEYS) delete stripped[key];
    expect(AgentActivityEntrySchema.safeParse(stripped).success).toBe(true);
    expect(stripped).toEqual(original);
    expect(original['ntconsult.analytics.kind']).toBeUndefined();
  });

  it('server_exclusion_prevents_resend_by_source_and_replay', async () => {
    const { sent, state, transport } = captureTransport();
    const spool = new FileObservationSpool(spoolDir);
    state.failNetwork = true;
    await new ObservationExporter({ transport, spool })
      .exportObservation(attachObservation(baseEntry(), makeObservation({ observationId: 'obs-excluded-1' })));
    const originalSource = path.join(dataDir, 'originals', 'transcript.jsonl');
    await fs.mkdir(path.dirname(originalSource), { recursive: true });
    await fs.writeFile(originalSource, '{"event.id":"evt-1","observationId":"obs-excluded-1"}\n');
    const policySyncs: string[] = [];
    const storeSyncs: Array<{ revision: string; count: number }> = [];
    const fence = await synchronizeExclusions('3', [{ id: 'obs-excluded-1', deviceId }], {
      store: { synchronizeTombstones: (revision, tombstones) => { storeSyncs.push({ revision, count: tombstones.length }); } },
      policy: { markExclusionsSynchronized: (revision) => { policySyncs.push(revision); } },
    });
    expect(policySyncs).toEqual(['3']);
    expect(storeSyncs).toEqual([{ revision: '3', count: 1 }]);
    state.failNetwork = false;
    const fenced = new ObservationExporter({ transport, spool, exclusions: fence });
    const outcome = await fenced.exportWithOutcome(attachObservation(baseEntry(), makeObservation({ observationId: 'obs-excluded-1' })));
    const exportedExcludedEvent = outcome.exported;
    expect(exportedExcludedEvent).toBe(false);
    const replay = await fenced.replay();
    expect(replay.sent).toEqual([]);
    expect(replay.excluded).toBe(1);
    expect(sent).toEqual([]);
    expect(await spool.pending()).toEqual([]);
    expect(await fs.readFile(originalSource, 'utf8')).toContain('obs-excluded-1');
    expect(createExclusionFence([]).isExcluded(makeObservation())).toBe(false);
    // The OTLP failed-log replay honours the same fence: no resend, only the managed spool is removed.
    const failedDir = path.join(dataDir, 'otlp-failed');
    await fs.mkdir(failedDir, { recursive: true });
    await fs.writeFile(path.join(failedDir, 'pilot__primary-2026-10-14.jsonl'), JSON.stringify({
      traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'obs', kind: 0,
      startTimeUnixNano: '1', endTimeUnixNano: '2',
      attributes: { 'ntconsult.analytics.observation_id': 'obs-excluded-1' },
    }) + '\n');
    let otlpSends = 0;
    const otlpResult = await replayFailedSpans(failedDir, { name: 'primary', url: 'http://ingest.test/v1/traces', headers: {} },
      async () => { otlpSends += 1; return new Response('{}', { status: 200 }); }, undefined, undefined,
      { isExcluded: () => true });
    expect(otlpSends).toBe(0);
    expect(otlpResult.excluded).toBe(1);
    expect((await fs.readdir(failedDir)).filter((file) => file.endsWith('.jsonl'))).toEqual([]);
    expect(await fs.readFile(originalSource, 'utf8')).toContain('obs-excluded-1');
  });

  it('primary_source_per_class_and_explicit_aliases_never_merge_by_text_or_time', async () => {
    const capability = makeObservation({
      observationId: 'obs-capability-1',
      kind: 'capability',
      sourceRefs: [ref('call-1'), ref('call-1', 'claude-code.log')],
      payload: {
        state: 'healthy', platform: 'darwin', configured: true,
        supportedFields: ['tool_call'], receivedFields: ['tool_call'],
        primarySources: [
          { eventClass: 'tool_call', sourceNamespace: 'claude-code.hook' },
          { eventClass: 'tool_result', sourceNamespace: 'claude-code.hook' },
          { eventClass: 'llm_usage', sourceNamespace: 'codex.transcript' },
        ],
        aliases: [{ sourceNamespace: 'claude-code.log', nativeId: 'call-1#log', primaryNativeId: 'call-1', eventClass: 'tool_call' }],
        usageSemantics: 'delta',
        reason: null,
      },
    });
    const { sent, transport } = captureTransport();
    const exporter = new ObservationExporter({ transport, spool: new FileObservationSpool(spoolDir) });
    await exporter.exportObservation(attachObservation(baseEntry(), capability));
    const exported = readObservationEnvelope(JSON.parse(sent[0]) as AgentActivityEntry)!.observation as Extract<Observation, { kind: 'capability' }>;
    expect(exported.sourceRefs).toHaveLength(2);
    expect(exported.sourceRefs).toEqual(capability.sourceRefs);
    expect(exported.payload.primarySources.map((source) => source.eventClass))
      .toEqual(['tool_call', 'tool_result', 'llm_usage']);
    expect(exported.payload.aliases).toEqual((capability as Extract<Observation, { kind: 'capability' }>).payload.aliases);
    // Two identical texts at adjacent times stay two observations: never merged by text or time.
    await exporter.exportObservation(attachObservation(baseEntry({ 'event.id': 'evt-2' }), makeObservation({ observationId: 'obs-text-1', occurredAt: '2026-10-14T12:00:01.000Z' })));
    await exporter.exportObservation(attachObservation(baseEntry({ 'event.id': 'evt-3' }), makeObservation({ observationId: 'obs-text-2', occurredAt: '2026-10-14T12:00:02.000Z' })));
    const ids = sent.map((line) => readObservationEnvelope(JSON.parse(line) as AgentActivityEntry)!.observation.observationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('cumulative_usage_counters_do_not_double_count_deltas', async () => {
    const declaration = makeObservation({
      observationId: 'obs-usage-decl',
      kind: 'capability',
      payload: {
        state: 'healthy', platform: 'darwin', configured: true,
        supportedFields: ['llm_usage'], receivedFields: ['llm_usage'],
        primarySources: [{ eventClass: 'llm_usage', sourceNamespace: 'codex.transcript' }],
        aliases: [], usageSemantics: 'cumulative', reason: null,
      },
    });
    const { sent, state, transport } = captureTransport();
    const exporter = new ObservationExporter({ transport, spool: new FileObservationSpool(spoolDir) });
    await exporter.exportObservation(attachObservation(baseEntry({ 'event.id': 'usage-decl' }), declaration));
    state.failNetwork = true;
    const usage1 = attachObservation(baseEntry({ 'event.id': 'usage-1', 'gen_ai.usage.total_tokens': 100 }), makeObservation({ observationId: 'obs-usage-1' }));
    const usage2 = attachObservation(baseEntry({ 'event.id': 'usage-2', 'gen_ai.usage.total_tokens': 150 }), makeObservation({ observationId: 'obs-usage-2' }));
    await exporter.exportObservation(usage1);
    await exporter.exportObservation(usage2);
    await exporter.exportObservation(usage2); // crash-window duplicate resend
    state.failNetwork = false;
    await exporter.replay();
    const received = sent.map((line) => JSON.parse(line) as AgentActivityEntry);
    const semantics = (readObservationEnvelope(received[0])!.observation as Extract<Observation, { kind: 'capability' }>).payload.usageSemantics;
    expect(semantics).toBe('cumulative');
    const seen = new Set<string>();
    const totals = { cumulative: 0, delta: 0 };
    for (const entry of received) {
      const key = String(entry['event.id']);
      if (seen.has(key)) continue;
      seen.add(key);
      const tokens = Number(entry['gen_ai.usage.total_tokens'] ?? 0);
      totals.cumulative = Math.max(totals.cumulative, tokens);
      totals.delta += tokens;
    }
    expect(totals.cumulative).toBe(150);
    expect(totals.delta).toBe(250);
    expect(seen.size).toBe(3);
  });

  it('module level exportObservation matches the brief interface', async () => {
    const { sent, transport } = captureTransport();
    configureObservationExporter({ transport, spool: new FileObservationSpool(spoolDir) });
    await expect(exportObservation(attachObservation(baseEntry(), makeObservation({ observationId: 'obs-module-1' }))))
      .resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(typeof exportObservation).toBe('function');
  });
});
