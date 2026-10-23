import { describe, expect, it } from 'vitest';
import { extractCodexPartialTurn } from '../../../../src/inputs/codex-transcript/codex-transcript-extractor.js';
import { buildCodexTranscriptEntries } from '../../../../src/inputs/codex-transcript/codex-transcript-builder.js';

function record(timestamp: string, type: string, payload: Record<string, unknown>) {
  return { timestamp, type, payload };
}

describe('Codex native effort extraction and propagation', () => {
  it('extracts turn effort and propagates it only to that turn requests and responses', () => {
    const records = [
      record('2026-10-23T00:00:00.000Z', 'turn_context', { turn_id: 'turn-1', model: 'gpt-5.5', effort: 'high' }),
      record('2026-10-23T00:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-1' }),
      record('2026-10-23T00:00:02.000Z', 'response_item', {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: 'solve this' }],
      }),
      record('2026-10-23T00:00:03.000Z', 'response_item', {
        type: 'message', role: 'assistant', content: [{ type: 'text', text: 'working' }],
      }),
      record('2026-10-23T00:00:04.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-1' }),
    ];
    const extracted = extractCodexPartialTurn(records, null, 'sess', 'turn-1');
    expect(extracted?.effort).toBe('high');
    const entries = buildCodexTranscriptEntries(extracted!);
    const req = entries.find(e => e['event.name'] === 'llm.request')!;
    const resp = entries.find(e => e['event.name'] === 'llm.response')!;
    expect(req['gen_ai.request.reasoning.level']).toBe('high');
    expect(resp['gen_ai.request.reasoning.level']).toBe('high');
    expect(req['gen_ai.request.model']).toBe('gpt-5.5');
    expect(resp['gen_ai.response.model']).toBeUndefined();
  });

  it('snapshots model and effort per wave instead of applying the last context retroactively', () => {
    const at = (n: number) => new Date(Date.parse('2026-10-23T00:00:00Z') + n * 1000).toISOString();
    const contexts = [
      { model: 'model-high', effort: 'high' },
      { model: 'model-low', effort: 'low' },
      { model: 'model-no-effort' },
    ];
    const waves = contexts.flatMap((context, i) => [
      record(at(i * 10 + 1), 'turn_context', { turn_id: 'multi', ...context }),
      ...(i < 2 ? [
        record(at(i * 10 + 2), 'response_item', { type: 'function_call', call_id: `call-${i}`, name: 'exec_command', arguments: '{}' }),
        record(at(i * 10 + 3), 'response_item', { type: 'function_call_output', call_id: `call-${i}`, output: 'diagnostic' }),
      ] : [record(at(i * 10 + 2), 'event_msg', { type: 'agent_message', message: 'done', phase: 'final' })]),
      record(at(i * 10 + 4), 'event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }),
    ]);
    const turn = extractCodexPartialTurn([
      record(at(0), 'event_msg', { type: 'task_started', turn_id: 'multi' }),
      ...waves, record(at(30), 'event_msg', { type: 'task_complete', turn_id: 'multi', last_agent_message: 'done' }),
    ], null, 'session', 'multi')!;
    const requests = buildCodexTranscriptEntries(turn).filter(e => e['event.name'] === 'llm.request');
    expect(requests.map(e => e['gen_ai.request.reasoning.level'])).toEqual(['high', 'low', undefined]);
    expect(requests.map(e => e['gen_ai.request.model'])).toEqual(['model-high', 'model-low', 'model-no-effort']);
    const tools = buildCodexTranscriptEntries(turn).filter(e => e['event.name'] === 'tool.call');
    expect(tools.map(e => e['gen_ai.request.reasoning.level'])).toEqual(['high', 'low']);
    expect(tools.every(e => e['gen_ai.request.model'] === undefined)).toBe(true);
  });

  it('keeps effort undefined when turn_context omits it and does not invent defaults', () => {
    const records = [
      record('2026-10-23T00:00:00.000Z', 'turn_context', { turn_id: 'turn-2', model: 'gpt-5' }),
      record('2026-10-23T00:00:01.000Z', 'event_msg', { type: 'task_started', turn_id: 'turn-2' }),
      record('2026-10-23T00:00:02.000Z', 'response_item', {
        type: 'message', role: 'assistant', content: [{ type: 'text', text: 'plain' }],
      }),
      record('2026-10-23T00:00:03.000Z', 'event_msg', { type: 'task_complete', turn_id: 'turn-2' }),
    ];
    const extracted = extractCodexPartialTurn(records, null, 'sess', 'turn-2');
    expect(extracted?.effort).toBeUndefined();
    const entries = buildCodexTranscriptEntries(extracted!);
    const req = entries.find(e => e['event.name'] === 'llm.request')!;
    expect(req['gen_ai.request.reasoning.level']).toBeUndefined();
  });
});
