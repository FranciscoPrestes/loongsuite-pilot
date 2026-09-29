import { describe, expect, it } from 'vitest';
import { buildCopilotEvents } from '../../../../src/inputs/copilot/copilot-event-builder.js';
import { applyAgentContentPolicy } from '../../../../src/normalization/agent-content-policy.js';
import type { AgentsConfig } from '../../../../src/types/index.js';
import { ev, resetFixtureIds, shutdownEvent, T0, textOnlyTurn, toolTurn } from '../../../fixtures/copilot/events.js';

const opts = { sessionId: 's-1' };
const summaries = (events: ReturnType<typeof textOnlyTurn>) =>
  buildCopilotEvents(events, opts).filter(e => e['event.name'] === 'other');

describe('session.shutdown usage summary', () => {
  it('emits one session-scoped summary for a single model', () => {
    const events = [...textOnlyTurn(), shutdownEvent(T0 + 9_000, {
      'model-a': { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 10, reasoningTokens: 7, totalNanoAiu: 123 },
    })];
    const [summary] = summaries(events);
    expect(summary['gen_ai.response.model']).toBe('model-a');
    expect(summary['gen_ai.usage.input_tokens']).toBe(1000);
    expect(summary['gen_ai.usage.output_tokens']).toBe(50);
    expect(summary['gen_ai.usage.cache_read.input_tokens']).toBe(800);
    expect(summary['gen_ai.usage.cache_creation.input_tokens']).toBe(10);
    expect(summary['agent.copilot.usage.reasoning_tokens']).toBe(7);
    expect(summary['agent.copilot.usage.nano_aiu']).toBe(123);
    expect(summary['agent.copilot.usage.scope']).toBe('session');
    expect(summary['gen_ai.turn.id']).toBeUndefined();
    expect(summary['gen_ai.step.id']).toBeUndefined();
    expect(summary['gen_ai.session.id']).toBe('s-1');
  });

  it('emits one summary per model', () => {
    const events = [...toolTurn(), shutdownEvent(T0 + 9_000, {
      'model-a': { inputTokens: 10, outputTokens: 1 },
      'model-b': { inputTokens: 20, outputTokens: 2 },
    })];
    const found = summaries(events);
    expect(found.map(e => e['gen_ai.response.model']).sort()).toEqual(['model-a', 'model-b']);
    expect(new Set(found.map(e => e['event.id'])).size).toBe(2);
  });

  it('emits nothing when modelMetrics is empty or there is no shutdown', () => {
    expect(summaries([...textOnlyTurn(), shutdownEvent(T0 + 9_000, {})])).toEqual([]);
    expect(summaries(textOnlyTurn())).toEqual([]);
  });

  it('never emits zero placeholders for fields the source omits', () => {
    resetFixtureIds();
    const bare = ev('session.shutdown', {
      shutdownType: 'routine', totalApiDurationMs: 1, sessionStartTime: T0, codeChanges: {},
      modelMetrics: { 'model-a': { usage: { inputTokens: 5, outputTokens: 1 } } },
    }, T0);
    const [summary] = buildCopilotEvents([bare], opts);
    expect(summary['gen_ai.usage.input_tokens']).toBe(5);
    expect(summary['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    expect(summary['agent.copilot.usage.nano_aiu']).toBeUndefined();
  });
});

describe('content policy', () => {
  it('strips prompt, text, arguments and results but keeps model, ids and tokens', () => {
    const events = [...toolTurn(), shutdownEvent(T0 + 9_000, { 'model-a': { inputTokens: 10, outputTokens: 1 } })];
    const config = { copilot: { captureMessageContent: false } } as unknown as AgentsConfig;
    const stripped = buildCopilotEvents(events, opts).map(e => applyAgentContentPolicy(e, config));
    const serialized = JSON.stringify(stripped);
    for (const secret of ['read a.txt', 'file body', 'a.txt', 'done']) {
      expect(serialized).not.toContain(secret);
    }
    const response = stripped.find(e => e['event.name'] === 'llm.response')!;
    expect(response['gen_ai.response.model']).toBe('model-a');
    const summary = stripped.find(e => e['event.name'] === 'other')!;
    expect(summary['gen_ai.usage.input_tokens']).toBe(10);
  });
});
