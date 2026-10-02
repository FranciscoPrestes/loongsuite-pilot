import { afterEach, describe, expect, it } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

// Real converter, captured exporter: the assertions read exported span
// attributes, not what a mocked converter received.
const FIXTURE_EPOCH_MS = Date.parse('2026-10-02T10:00:00.000Z');
const IDLE_MS = 100;
// The idle tick runs every second; wait past one tick plus the idle window.
const IDLE_WAIT_MS = 1_300;

const base = {
  'gen_ai.agent.type': 'claude-code',
  'gen_ai.session.id': 'reopen-session',
  'gen_ai.turn.id': 'reopen-turn',
} as const;

function record(
  eventName: AgentActivityEntry['event.name'],
  eventId: string,
  millis: number,
  fields: Record<string, unknown> = {},
): AgentActivityEntry {
  return {
    ...base,
    time_unix_nano: `${FIXTURE_EPOCH_MS + millis}000000`,
    'event.id': eventId,
    'event.name': eventName,
    ...fields,
  } as AgentActivityEntry;
}

const prompt = (): AgentActivityEntry => record('other', 'prompt', 0, {
  'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'run it' }] }],
});

const firstStep = (): AgentActivityEntry[] => [
  record('llm.request', 'req-1', 100, { 'gen_ai.step.id': 'step-1', 'gen_ai.request.model': 'm' }),
  record('llm.response', 'resp-1', 200, {
    'gen_ai.step.id': 'step-1',
    'gen_ai.request.model': 'm',
    'gen_ai.response.finish_reasons': ['tool_use'],
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'c1', name: 'Bash', arguments: {} }] }],
  }),
];

const toolCall = (): AgentActivityEntry => record('tool.call', 'call-c1', 300, {
  'gen_ai.step.id': 'step-1',
  'gen_ai.tool.name': 'Bash',
  'gen_ai.tool.call.id': 'c1',
  'gen_ai.tool.call.arguments': { cmd: 'sleep 600' },
});

const toolResult = (): AgentActivityEntry => record('tool.result', 'result-c1', 600_300, {
  'gen_ai.step.id': 'step-1',
  'gen_ai.tool.name': 'Bash',
  'gen_ai.tool.call.id': 'c1',
  'gen_ai.tool.call.result': 'done',
});

const finalStep = (): AgentActivityEntry[] => [
  record('llm.request', 'req-2', 600_400, { 'gen_ai.step.id': 'step-2', 'gen_ai.request.model': 'm' }),
  record('llm.response', 'resp-2', 600_500, {
    'gen_ai.step.id': 'step-2',
    'gen_ai.request.model': 'm',
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'ok' }] }],
  }),
];

function makeFlusher(exported: ReadableSpan[]): OtlpTraceFlusher {
  return new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf',
    serviceName: 'reopen-unit',
    turnIdleTimeoutMs: IDLE_MS,
    failedReplayIntervalMs: 0,
  }, undefined, () => ({
    export: (spans, callback) => {
      exported.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  }));
}

const toolSpans = (spans: ReadableSpan[], callId: string): ReadableSpan[] =>
  spans.filter(s => s.attributes['gen_ai.tool.call.id'] === callId);

const internals = (f: OtlpTraceFlusher) => f as unknown as {
  turnBuffers: Map<string, unknown>;
  heldOrphans: Map<string, unknown>;
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('OtlpTraceFlusher - tool call arguments across a reopened turn', () => {
  let flusher: OtlpTraceFlusher | undefined;

  afterEach(async () => {
    await flusher?.shutdown();
    flusher = undefined;
  });

  it('keeps an unpaired tool.call through an idle flush so the reopened turn exports its arguments', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(prompt());
    for (const r of firstStep()) await flusher.send(r);
    await flusher.send(toolCall());
    await wait(IDLE_WAIT_MS);

    // The early (idle) flush sent the convertible part of the turn, but no
    // orphan TOOL span for the still-running call.
    expect(exported.length).toBeGreaterThan(0);
    expect(toolSpans(exported, 'c1')).toHaveLength(0);
    const firstExportCount = exported.length;

    // The tool finishes later; the turn reopens and then ends normally.
    await flusher.send(toolResult());
    for (const r of finalStep()) await flusher.send(r);
    await flusher.flush();

    expect(exported.length).toBeGreaterThan(firstExportCount);
    const c1 = toolSpans(exported, 'c1');
    expect(c1).toHaveLength(1);
    expect(String(c1[0].attributes['gen_ai.tool.call.arguments'])).toContain('sleep 600');
    expect(String(c1[0].attributes['gen_ai.tool.call.result'])).toContain('done');
  });

  it('moves the held call bytes with it instead of counting them as removed twice', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(prompt(), 10);
    await flusher.send(toolCall(), 70);
    await wait(IDLE_WAIT_MS);

    const afterIdle = flusher.getTraceRuntimeSnapshot().find(r => r.agent_type === 'claude-code');
    expect(afterIdle?.removed_logical_bytes_total).toBe(10);
    expect(afterIdle?.pending_buffers).toBe(0);

    await flusher.send(toolResult(), 5);
    const reopened = flusher.getTraceRuntimeSnapshot().find(r => r.agent_type === 'claude-code');
    expect(reopened?.pending_records).toBe(2);
    expect(reopened?.pending_logical_bytes).toBe(75);
    expect(reopened?.pending_unmeasured_records).toBe(0);
  });

  it('drops a tool.call that never gets a result at the final flush and leaves no buffer behind', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(prompt(), 10);
    for (const r of firstStep()) await flusher.send(r, 20);
    await flusher.send(toolCall(), 70);
    await wait(IDLE_WAIT_MS);
    expect(toolSpans(exported, 'c1')).toHaveLength(0);
    expect(internals(flusher).heldOrphans.size).toBe(1);

    // Shutdown is the final flush: the interrupted call is discarded, not
    // emitted as an empty TOOL span, and nothing is retained afterwards.
    await flusher.flush();

    expect(toolSpans(exported, 'c1')).toHaveLength(0);
    expect(internals(flusher).turnBuffers.size).toBe(0);
    expect(internals(flusher).heldOrphans.size).toBe(0);
    // Every accepted byte is counted as removed exactly once, held ones included.
    const row = flusher.getTraceRuntimeSnapshot().find(r => r.agent_type === 'claude-code');
    expect(row?.removed_logical_bytes_total).toBe(120);
    expect(row?.removed_unmeasured_records_total).toBe(0);
  });
});
