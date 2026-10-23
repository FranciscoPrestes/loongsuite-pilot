import { describe, expect, it } from 'vitest';
import { buildAgentActivityEntry, projectLogEntry } from '../../../src/normalization/entry-builder.js';
const projectSettings = (settings: Record<string, unknown>) => projectLogEntry(buildAgentActivityEntry({
  ...base, ...settings,
} as Parameters<typeof buildAgentActivityEntry>[0]));

const base = { 'event.name': 'llm.request', 'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 'session' } as const;

describe('model settings at the normalization boundary', () => {
  it('preserves explicit request, thinking and routed settings without mutating the source', () => {
    const input = Object.freeze({
      ...base,
      'gen_ai.request.reasoning.level': 'high',
      'gen_ai.request.reasoning.budget_tokens': 4096,
      'gen_ai.request.thinking.type': 'enabled',
      'gen_ai.request.model_settings.source': 'native_request',
      'gen_ai.request.model_settings.scope': 'request',
      'gen_ai.request.router.name': 'ccr',
      'gen_ai.request.router.selected_model': 'routed-model',
      'gen_ai.request.router.provider': 'configured-provider',
      'gen_ai.request.router.reasoning.level': 'medium',
      'gen_ai.request.router.reasoning.budget_tokens': 2048,
    });
    expect(projectLogEntry(buildAgentActivityEntry(input))).toMatchObject(input);
    expect(projectSettings(input)['gen_ai.request.reasoning.level']).toBe('high');
    expect(input['gen_ai.request.router.reasoning.level']).toBe('medium');
  });

  it('does not invent default effort or budget when the source omits them', () => {
    const output = projectLogEntry(buildAgentActivityEntry(base));
    expect(Object.keys(output).filter(k => k.includes('reasoning') || k.includes('thinking'))).toEqual([]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4096', { value: 4096 }])('rejects non-native budgets: %j', value => {
    const output = projectSettings({ 'gen_ai.request.reasoning.budget_tokens': value });
    expect(output['gen_ai.request.reasoning.budget_tokens']).toBeUndefined();
  });

  it.each(['', 'high\n', 'x'.repeat(257), 123, { api_key: 'DO_NOT_SERIALIZE' }])('does not serialize invalid effort metadata: %j', value => {
    const output = projectSettings({ 'gen_ai.request.reasoning.level': value });
    expect(output['gen_ai.request.reasoning.level']).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('DO_NOT_SERIALIZE');
  });

  it('does not add absent setting keys to entries and rejects C1 control characters like the hooks', () => {
    const entry = buildAgentActivityEntry(base as Parameters<typeof buildAgentActivityEntry>[0]);
    expect(Object.keys(entry).filter(k => k.includes('reasoning') || k.includes('router') || k.includes('model_settings'))).toEqual([]);
    expect(projectSettings({ 'gen_ai.request.reasoning.level': 'hi\u0085gh' })['gen_ai.request.reasoning.level']).toBeUndefined();
  });

  it('preserves explicit zero without confusing it with an omitted budget', () => {
    expect(projectSettings({ 'gen_ai.request.reasoning.budget_tokens': 0 })['gen_ai.request.reasoning.budget_tokens']).toBe(0);
  });

  it('rejects forged object metadata even if a raw hook bypasses compile-time types', () => {
    const input = { ...base, 'gen_ai.request.reasoning.level': { value: 'DO_NOT_SERIALIZE' } };
    const output = projectLogEntry(buildAgentActivityEntry(input as unknown as Parameters<typeof buildAgentActivityEntry>[0]));
    expect(output['gen_ai.request.reasoning.level']).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain('DO_NOT_SERIALIZE');
  });
});
