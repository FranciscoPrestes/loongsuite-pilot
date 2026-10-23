import { describe, expect, it } from 'vitest';
import { SpanKind, SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { attachModelSettings } from '../../../src/flushers/model-settings.js';

const context = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 };
const base = { 'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn' };
const record = (fields: Record<string, unknown>): AgentActivityEntry => ({
  ...base, 'event.name': 'llm.request', 'gen_ai.agent.type': 'codex', 'gen_ai.provider.name': 'openai',
  'event.id': 'event', 'user.id': 'user', time_unix_nano: '1700000000000000000',
  'gen_ai.response.id': 'response', ...fields,
}) as AgentActivityEntry;
const span = (attributes: Attributes = {}): ReadableSpan => ({
  name: 'chat', kind: SpanKind.CLIENT, spanContext: () => context,
  attributes: Object.freeze({ ...base, 'gen_ai.span.kind': 'LLM', 'gen_ai.response.id': 'response', ...attributes }),
  status: { code: SpanStatusCode.UNSET }, startTime: [1700000000, 0], endTime: [1700000001, 0],
  duration: [1, 0], ended: true, links: [], events: [], resource: new Resource({}),
  instrumentationLibrary: { name: 'model-metadata-test' }, droppedAttributesCount: 0,
  droppedEventsCount: 0, droppedLinksCount: 0,
});

describe('model metadata identity and ambiguity', () => {
  it('matches an explicit native span ID and creates an immutable export view', () => {
    const original = span();
    const [result] = attachModelSettings([record({ trace_id: context.traceId, span_id: context.spanId,
      'gen_ai.response.id': 'native', 'gen_ai.request.reasoning.level': 'high' })], [original]);
    expect(result.attributes['gen_ai.request.reasoning.level']).toBe('high');
    expect(original.attributes['gen_ai.request.reasoning.level']).toBeUndefined();
    expect(result.spanContext()).toEqual(original.spanContext());
  });

  it('does not resolve contradictory explicit effort by taking the first record', () => {
    const [result] = attachModelSettings([
      record({ 'gen_ai.request.reasoning.level': 'high', 'gen_ai.request.reasoning.budget_tokens': 4096 }),
      record({ 'event.name': 'llm.response', 'gen_ai.request.reasoning.level': 'low' }),
    ], [span()]);
    expect(result.attributes['gen_ai.request.reasoning.level']).toBeUndefined();
    expect(result.attributes['gen_ai.request.reasoning.budget_tokens']).toBe(4096);
  });

  it('does not attach a different session even when native IDs collide', () => {
    const original = span();
    const [result] = attachModelSettings([record({ 'gen_ai.session.id': 'other', trace_id: context.traceId,
      span_id: context.spanId, 'gen_ai.request.reasoning.level': 'high' })], [original]);
    expect(result).toBe(original);
  });

  it('does not use input/root records as model evidence', () => {
    const original = span();
    const [result] = attachModelSettings([record({ 'event.name': 'other', 'gen_ai.request.reasoning.level': 'high' })], [original]);
    expect(result).toBe(original);
  });

  it('associates explicit tool context without adding model usage', () => {
    const original = span({ 'gen_ai.span.kind': 'TOOL', 'gen_ai.tool.call.id': 'call' });
    const [result] = attachModelSettings([record({ 'event.name': 'tool.call', 'gen_ai.tool.call.id': 'call',
      'gen_ai.request.reasoning.level': 'low', 'gen_ai.request.model_settings.scope': 'turn' })], [original]);
    expect(result.attributes['gen_ai.request.reasoning.level']).toBe('low');
    expect(result.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
  });

  it('removes converter-inferred requested model when the source only observed a response', () => {
    const original = span({ 'gen_ai.request.model': 'reported-only', 'gen_ai.response.model': 'reported-only' });
    const [result] = attachModelSettings([
      record({ 'gen_ai.request.model_settings.source': 'claude.transcript' }),
      record({ 'event.name': 'llm.response', 'gen_ai.response.model': 'reported-only' }),
    ], [original]);
    expect(result.attributes['gen_ai.request.model']).toBeUndefined();
    expect(result.attributes['gen_ai.response.model']).toBe('reported-only');
    expect(original.attributes['gen_ai.request.model']).toBe('reported-only');
  });

  it('does not claim a response model from a failed request without one', () => {
    const [result] = attachModelSettings([
      record({ 'gen_ai.request.model': 'requested-only', 'gen_ai.request.model_settings.source': 'claude.preload' }),
      record({ 'event.name': 'llm.response', 'error.type': 'network_error' }),
    ], [span({ 'gen_ai.request.model': 'requested-only', 'gen_ai.response.model': 'requested-only' })]);
    expect(result.attributes['gen_ai.request.model']).toBe('requested-only');
    expect(result.attributes['gen_ai.response.model']).toBeUndefined();
  });

  it('leaves structural spans and unrelated turns untouched', () => {
    const other = span({ 'gen_ai.turn.id': 'other' });
    const structural = span({ 'gen_ai.span.kind': 'AGENT' });
    const result = attachModelSettings([record({ 'gen_ai.request.reasoning.level': 'high' })], [other, structural]);
    expect(result[0]).toBe(other);
    expect(result[1]).toBe(structural);
  });
});
