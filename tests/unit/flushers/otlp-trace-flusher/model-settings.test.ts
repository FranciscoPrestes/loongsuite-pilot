import { describe, expect, it } from 'vitest';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const common = {
  'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn',
  'gen_ai.provider.name': 'openai', 'user.id': 'diagnostic',
};

function wave(n: number, settings: Record<string, string | number>): AgentActivityEntry[] {
  const base = { ...common, 'gen_ai.step.id': `step-${n}`, 'gen_ai.response.id': `response-${n}` };
  return [{ ...base, ...settings, 'event.id': `req-${n}`, 'event.name': 'llm.request',
    time_unix_nano: String(1700000000000000000n + BigInt(n * 2) * 1000000000n),
    'gen_ai.request.model': 'requested-model',
  }, { ...base, 'event.id': `resp-${n}`, 'event.name': 'llm.response',
    time_unix_nano: String(1700000000000000000n + BigInt(n * 2 + 1) * 1000000000n),
    'gen_ai.response.model': 'reported-model', 'gen_ai.response.finish_reasons': [n === 3 ? 'stop' : 'tool_call'],
    'gen_ai.usage.input_tokens': 14, 'gen_ai.usage.output_tokens': 2,
  }] as AgentActivityEntry[];
}

describe('model settings on actual converted OTLP spans', () => {
  it('keeps request settings per call and does not fill missing values from another wave', async () => {
    let captured: ReadableSpan[] = [];
    const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'model-settings-test', protocol: 'http/protobuf',
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }],
    }, undefined, () => ({
      export: (spans: ReadableSpan[], cb: (r: ExportResult) => void) => {
        captured = [...captured, ...spans]; cb({ code: ExportResultCode.SUCCESS });
      }, shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch([
        ...wave(1, { 'gen_ai.request.reasoning.level': 'high', 'gen_ai.request.reasoning.budget_tokens': 4096,
          'gen_ai.request.router.selected_model': 'upstream-first', 'gen_ai.request.router.reasoning.level': 'medium' }),
        ...wave(2, { 'gen_ai.request.reasoning.level': 'low', 'gen_ai.request.reasoning.budget_tokens': 0 }),
        ...wave(3, {}),
      ]);
    } finally { await flusher.shutdown(); }
    const llm = captured.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llm).toHaveLength(3);
    const attrs = (n: number) => llm.find(s => s.attributes['gen_ai.response.id'] === `response-${n}`)!.attributes;
    expect(attrs(1)).toMatchObject({ 'gen_ai.request.reasoning.level': 'high', 'gen_ai.request.reasoning.budget_tokens': 4096,
      'gen_ai.request.router.selected_model': 'upstream-first', 'gen_ai.request.router.reasoning.level': 'medium',
      'gen_ai.request.model': 'requested-model', 'gen_ai.response.model': 'reported-model' });
    expect(attrs(2)).toMatchObject({ 'gen_ai.request.reasoning.level': 'low', 'gen_ai.request.reasoning.budget_tokens': 0 });
    expect(attrs(2)['gen_ai.request.router.selected_model']).toBeUndefined();
    expect(attrs(3)['gen_ai.request.reasoning.level']).toBeUndefined();
    expect(attrs(3)['gen_ai.request.reasoning.budget_tokens']).toBeUndefined();
    expect(llm.reduce((sum, s) => sum + Number(s.attributes['gen_ai.usage.input_tokens'] ?? 0), 0)).toBe(42);
  });
});
