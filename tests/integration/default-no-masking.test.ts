import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { InputManager } from '../../src/core/input-manager.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';
import { ClientType, CollectionMethod } from '../../src/types/index.js';
import { attachObservation, FileObservationSpool, ObservationExporter } from '../../src/analytics/observation-exporter.js';
import { sanitizeEnrichedPayload, sanitizeSnippetText } from '../../src/mask/entry-masker.js';
import { maskEvidence, prepareJob } from '../../src/enrichment/job-contract.js';
import { setActiveMaskConfig } from '../../src/mask/active-mask.js';
import { validateObservation } from '../../src/analytics/observation.js';
import { createReadableSpanToOtlpSpanJsonArray } from '../../src/flushers/otlp-json-serializer.js';
import { toOtlpJsonRequest } from '../../src/flushers/otlp-failed-replayer.js';
import { job } from '../unit/enrichment/fixtures.js';

vi.mock('../../src/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

// The owner's rule: with the shipped defaults nothing is masked or anonymised; each mask is an explicit opt-in.
const PROMPT = 'use senha=abc123 and write to maria.silva@example.com; token sk-Zq8vN3xL1pR7tY2wK5mB9cD4fG6h';

class StubInput extends EventEmitter {
  setWorkspacePolicy() {}
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.IdeSnapshotPolling;
  running = false;
  constructor(readonly id: string) { super(); }
  async start() { this.running = true; }
  async stop() { this.running = false; }
}

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c13-default-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); setActiveMaskConfig(undefined); });

describe('defaults mask and anonymise nothing', () => {
  it('a prompt with a password and an e-mail leaves in the OTLP span whole', async () => {
    const manager = new InputManager(); // no setMaskConfig: the defaults of the orchestrator are mask mode none
    const flusher = new MockFlusher();
    manager.setFlusher(flusher);
    const input = new StubInput('default');
    manager.registerInput(input as never);
    const messages = JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: PROMPT }] }]);
    input.emit('entries', [buildTestEntry({ 'event.name': 'user.prompt', 'gen_ai.input.messages_delta': messages })]);
    await manager.stopAll();
    const [entry] = flusher.batchCalls.flat();
    expect(entry['gen_ai.input.messages_delta']).toBe(messages);
    const [line] = createReadableSpanToOtlpSpanJsonArray([{
      spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }), parentSpanId: undefined,
      name: 'prompt', kind: 0, startTime: [1, 0] as [number, number], endTime: [2, 0] as [number, number],
      attributes: { 'gen_ai.input.messages_delta': entry['gen_ai.input.messages_delta'] }, status: { code: 0 }, resource: { attributes: {} }, events: [], links: [],
      duration: [1, 0] as [number, number], ended: true,
      instrumentationLibrary: { name: 'test', version: '1.0.0' }, droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
    } as never]);
    const body = JSON.stringify(toOtlpJsonRequest([JSON.parse(line)]));
    for (const part of ['senha=abc123', 'maria.silva@example.com', 'sk-Zq8vN3xL1pR7tY2wK5mB9cD4fG6h']) expect(body).toContain(part);
    expect(body).not.toMatch(/_MASKED/);
  });

  it('enrichment evidence, the job store and the exported observation keep their text as well', async () => {
    expect(sanitizeSnippetText(PROMPT)).toBe(PROMPT);
    expect(sanitizeEnrichedPayload({ a: [PROMPT] })).toEqual({ a: [PROMPT] });
    expect(maskEvidence({ text: PROMPT })).toEqual({ text: PROMPT });
    expect(prepareJob(job({ workspacePath: '/tmp/work/password=hunter2xyz' })).workspacePath).toBe('/tmp/work/password=hunter2xyz');
    const observation = validateObservation({
      schemaVersion: '1', observationId: 'obs-default', kind: 'command_context', harnessId: 'claude-code', harnessVersion: '1', collectorVersion: '1',
      deviceId: 'dev', sessionId: 's', capabilitiesVersion: '1', occurredAt: new Date().toISOString(), missingFields: [], truncated: false,
      sourceRefs: [{ sourceNamespace: 'ns', nativeId: 'n', phase: 'event' }], generatedBy: 'collector',
      payload: { resolvedCommand: PROMPT, scriptChain: [], modulePaths: [], reason: null },
    });
    const sent: string[] = [];
    const exporter = new ObservationExporter({ spool: new FileObservationSpool(path.join(dir, 'spool')), transport: { send: async s => { sent.push(s); return { status: 200 }; } } });
    await exporter.exportWithOutcome(attachObservation(buildTestEntry({}), observation));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('senha=abc123');
    expect(sent[0]).not.toMatch(/_MASKED/);
  });
});
