import { describe, expect, it } from 'vitest';
import { buildCopilotEvents } from '../../../../src/inputs/copilot/copilot-event-builder.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import {
  ev, failedToolTurn, parallelToolTurn, resetFixtureIds, T0, textOnlyTurn, toolTurn,
} from '../../../fixtures/copilot/events.js';

const opts = { sessionId: 's-1' };
const names = (entries: AgentActivityEntry[]) => entries.map(e => e['event.name']);
const usageKeys = (e: AgentActivityEntry) => Object.keys(e).filter(k => k.startsWith('gen_ai.usage.'));

describe('text-only turn', () => {
  const entries = buildCopilotEvents(textOnlyTurn(), opts);
  const [request, response] = entries;

  it('emits one request/response pair', () => {
    expect(names(entries)).toEqual(['llm.request', 'llm.response']);
  });

  it('puts the prompt in the request delta and marks the turn start', () => {
    expect(request['gen_ai.turn.start']).toBe(true);
    expect(request['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello world' }] },
    ]);
  });

  it('reports requested and answered model separately', () => {
    expect(request['gen_ai.request.model']).toBe('auto');
    expect(response['gen_ai.response.model']).toBe('model-a');
  });

  it('closes the turn with stop and the assistant text', () => {
    expect(response['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(response['gen_ai.turn.end']).toBe(true);
    expect(response['gen_ai.output.messages']).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'hi there' }], finish_reason: 'stop' },
    ]);
  });

  it('carries identity fields and never invents per-call tokens', () => {
    for (const e of entries) {
      expect(e['gen_ai.agent.type']).toBe('copilot');
      expect(e['gen_ai.provider.name']).toBe('github-copilot');
      expect(e['gen_ai.session.id']).toBe('s-1');
      expect(e['gen_ai.turn.id']).toBe('i-1');
      expect(e['workspace.path']).toBe('/work/demo');
      expect(usageKeys(e)).toEqual([]);
    }
  });

  it('is deterministic across replays', () => {
    const again = buildCopilotEvents(textOnlyTurn(), opts);
    expect(again.map(e => e['event.id'])).toEqual(entries.map(e => e['event.id']));
    expect(new Set(entries.map(e => e['event.id'])).size).toBe(entries.length);
  });
});

describe('tool turn', () => {
  const entries = buildCopilotEvents(toolTurn(), opts);

  it('orders request, response, call, result, then the next step', () => {
    expect(names(entries)).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
  });

  it('marks the tool-requesting response as tool_call without ending the turn', () => {
    const response = entries[1];
    expect(response['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(response['gen_ai.turn.end']).toBeUndefined();
    expect(response['gen_ai.output.messages']).toEqual([{
      role: 'assistant',
      parts: [{ type: 'tool_call', id: 'call-1', name: 'view', arguments: { path: 'a.txt' } }],
      finish_reason: 'tool_call',
    }]);
  });

  it('pairs call and result by id with a positive duration', () => {
    const call = entries[2];
    const result = entries[3];
    expect(call['gen_ai.tool.call.id']).toBe('call-1');
    expect(call['gen_ai.tool.name']).toBe('view');
    expect(call['gen_ai.tool.call.arguments']).toEqual({ path: 'a.txt' });
    expect(result['gen_ai.tool.call.id']).toBe('call-1');
    expect(result['gen_ai.tool.call.result']).toBe('file body');
    expect(result['tool.result.status']).toBe('success');
    expect(result['gen_ai.tool.call.duration']).toBe(200);
  });

  it('feeds the tool result into the next request and ends the turn on the last response', () => {
    expect(entries[4]['gen_ai.turn.start']).toBeUndefined();
    expect(entries[4]['gen_ai.input.messages_delta']).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call-1', name: 'view', arguments: { path: 'a.txt' } }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-1', response: 'file body' }] },
    ]);
    expect(entries[5]['gen_ai.turn.end']).toBe(true);
    expect(entries[4]['gen_ai.step.id']).not.toBe(entries[0]['gen_ai.step.id']);
  });
});

describe('parallel tools', () => {
  it('matches out-of-order results by toolCallId', () => {
    const results = buildCopilotEvents(parallelToolTurn(), opts).filter(e => e['event.name'] === 'tool.result');
    expect(results.map(e => [e['gen_ai.tool.call.id'], e['gen_ai.tool.call.result']])).toEqual([
      ['call-b', 'B'], ['call-a', 'A'],
    ]);
    expect(new Set(results.map(e => e['event.id'])).size).toBe(2);
  });
});

describe('failed tool', () => {
  it('reports failure with the error and no result payload', () => {
    const result = buildCopilotEvents(failedToolTurn(), opts).find(e => e['event.name'] === 'tool.result')!;
    expect(result['tool.result.status']).toBe('failure');
    expect(result['error.type']).toBe('tool_execution_failed');
    expect(result['error.message']).toBe('boom');
    expect(result['gen_ai.tool.call.result']).toBeUndefined();
  });
});

describe('robustness', () => {
  it('ignores a tool result that has no earlier start', () => {
    resetFixtureIds();
    const orphan = [ev('tool.execution_complete', { toolCallId: 'x', success: true, result: { content: 'r' } }, T0)];
    expect(buildCopilotEvents(orphan, opts)).toEqual([]);
  });

  it('ignores unknown event types and events with invalid timestamps', () => {
    resetFixtureIds();
    const noise = [ev('session.mystery', {}, T0), { ...ev('user.message', { content: 'x' }, T0), timestamp: 'garbage' }];
    expect(buildCopilotEvents(noise, opts)).toEqual([]);
  });

  it('tags subagent steps so they do not corrupt the parent turn', () => {
    resetFixtureIds();
    const events = [
      ev('user.message', { content: 'p', interactionId: 'i-1', messageId: 'm' }, T0),
      ev('assistant.turn_start', { turnId: '0', interactionId: 'i-1' }, T0 + 10),
      ev('assistant.message', {
        messageId: 'am', content: 'sub', model: 'model-a', apiCallId: 'a1', turnId: '0', parentToolCallId: 'parent-1',
      }, T0 + 20),
    ];
    const entries = buildCopilotEvents(events, opts);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e['gen_ai.agent.scope'] === 'subagent')).toBe(true);
  });

  it('falls back to opts models when the span lacks session.start', () => {
    const span = textOnlyTurn().slice(2);
    const entries = buildCopilotEvents(span, { sessionId: 's-1', selectedModel: 'auto', autoModel: 'model-a', cwd: '/work/demo' });
    expect(entries[0]['gen_ai.request.model']).toBe('auto');
    expect(entries[0]['workspace.path']).toBe('/work/demo');
  });
});
