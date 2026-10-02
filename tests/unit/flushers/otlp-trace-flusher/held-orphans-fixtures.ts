// Shared fixtures for the held-unpaired-records tests (reopened turns).
// Real converter, captured exporter: assertions read exported span
// attributes, not what a mocked converter received.
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { TraceRuntimeSnapshot } from '../../../../src/metrics/trace-runtime-types.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const FIXTURE_EPOCH_MS = Date.parse('2026-10-02T10:00:00.000Z');
export const IDLE_MS = 100;
// The idle tick runs every second; wait past one tick plus the idle window.
export const IDLE_WAIT_MS = 1_300;
export const HOUR_MS = 3_600_000;

export interface TurnIds {
  turn: string;
  session: string;
}

const DEFAULT_IDS: TurnIds = { turn: 'reopen-turn', session: 'reopen-session' };

function record(
  ids: TurnIds,
  eventName: AgentActivityEntry['event.name'],
  eventId: string,
  millis: number,
  fields: Record<string, unknown> = {},
): AgentActivityEntry {
  return {
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.session.id': ids.session,
    'gen_ai.turn.id': ids.turn,
    time_unix_nano: `${FIXTURE_EPOCH_MS + millis}000000`,
    'event.id': `${ids.turn}-${eventId}`,
    'event.name': eventName,
    ...fields,
  } as AgentActivityEntry;
}

/** Record builders for one claude-code turn: prompt, a tool step, a final step. */
export function turn(ids: TurnIds = DEFAULT_IDS) {
  return {
    prompt: (content = 'run it'): AgentActivityEntry => record(ids, 'other', 'prompt', 0, {
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content }] }],
    }),
    llmRequest: (step: string, ms: number, content = 'REQ-MARK'): AgentActivityEntry =>
      record(ids, 'llm.request', `req-${step}`, ms, {
        'gen_ai.step.id': step,
        'gen_ai.request.model': 'm',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content }] }],
      }),
    llmResponse: (step: string, ms: number, finish: string): AgentActivityEntry =>
      record(ids, 'llm.response', `resp-${step}`, ms, {
        'gen_ai.step.id': step,
        'gen_ai.request.model': 'm',
        'gen_ai.response.finish_reasons': [finish],
        'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'ok' }] }],
      }),
    toolCall: (callId = 'c1'): AgentActivityEntry => record(ids, 'tool.call', `call-${callId}`, 300, {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.id': callId,
      'gen_ai.tool.call.arguments': { cmd: 'sleep 600' },
    }),
    toolResult: (callId = 'c1'): AgentActivityEntry => record(ids, 'tool.result', `result-${callId}`, 600_300, {
      'gen_ai.step.id': 'step-1',
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.id': callId,
      'gen_ai.tool.call.result': 'done',
    }),
  };
}

/** step-1 (request + tool_use response) for the default turn shape. */
export function firstStep(ids: TurnIds = DEFAULT_IDS): AgentActivityEntry[] {
  const t = turn(ids);
  return [t.llmRequest('step-1', 100), t.llmResponse('step-1', 200, 'tool_use')];
}

/** step-2 ending the turn with `stop` (terminal: triggers the final flush). */
export function finalStep(ids: TurnIds = DEFAULT_IDS): AgentActivityEntry[] {
  const t = turn(ids);
  return [t.llmRequest('step-2', 600_400, 'step-2-input'), t.llmResponse('step-2', 600_500, 'stop')];
}

export function makeFlusher(
  exported: ReadableSpan[],
  overrides: { turnIdleTimeoutMs?: number } = {},
): OtlpTraceFlusher {
  return new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf',
    serviceName: 'reopen-unit',
    turnIdleTimeoutMs: overrides.turnIdleTimeoutMs ?? IDLE_MS,
    failedReplayIntervalMs: 0,
  }, undefined, () => ({
    export: (spans, callback) => {
      exported.push(...spans);
      callback({ code: ExportResultCode.SUCCESS });
    },
    shutdown: async () => {},
  }));
}

export const toolSpans = (spans: ReadableSpan[], callId: string): ReadableSpan[] =>
  spans.filter(s => s.attributes['gen_ai.tool.call.id'] === callId);

export const llmSpans = (spans: ReadableSpan[]): ReadableSpan[] =>
  spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');

export const internals = (f: OtlpTraceFlusher) => f as unknown as {
  turnBuffers: Map<string, unknown>;
  heldOrphans: Map<string, unknown>;
};

export const row = (f: OtlpTraceFlusher): TraceRuntimeSnapshot | undefined =>
  f.getTraceRuntimeSnapshot().find(r => r.agent_type === 'claude-code');

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
