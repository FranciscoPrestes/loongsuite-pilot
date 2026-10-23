import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';
import { MODEL_SETTINGS_PASSTHROUGH_KEYS, normalizeModelSettings } from '../normalization/model-settings.js';
import { withSpanAttributes } from './span-enricher.js';

function matches(record: AgentActivityEntry, span: ReadableSpan): boolean {
  const attrs = span.attributes;
  const events = attrs['gen_ai.span.kind'] === 'LLM' ? ['llm.request', 'llm.response'] : ['tool.call', 'tool.result'];
  if (!events.includes(record['event.name'])) return false;
  for (const key of ['gen_ai.session.id', 'gen_ai.turn.id'] as const) {
    if (record[key] && attrs[key] && record[key] !== attrs[key]) return false;
  }
  if (record.span_id && record.span_id === span.spanContext().spanId
    && (!record.trace_id || record.trace_id === span.spanContext().traceId)) return true;
  if (!record['gen_ai.session.id'] || record['gen_ai.session.id'] !== attrs['gen_ai.session.id']
    || !record['gen_ai.turn.id'] || record['gen_ai.turn.id'] !== attrs['gen_ai.turn.id']) return false;
  const key = attrs['gen_ai.span.kind'] === 'LLM' ? 'gen_ai.response.id' : 'gen_ai.tool.call.id';
  return typeof record[key] === 'string' && record[key] !== '' && record[key] === attrs[key];
}

const MODEL_NAME_KEYS = ['gen_ai.request.model', 'gen_ai.response.model'] as const;

function explicitModels(records: AgentActivityEntry[]): Attributes {
  return Object.fromEntries(MODEL_NAME_KEYS.flatMap(key => {
    const values = [...new Set(records.map(record => record[key]).filter(value => typeof value === 'string'
      && value.length > 0 && value.length <= 256 && value !== 'unknown' && !/[\u0000-\u001f\u007f-\u009f]/.test(value)))];
    return values.length === 1 ? [[key, values[0]]] : [];
  })) as Attributes;
}

const callKey = (prefix: string, session: unknown, turn: unknown, id: unknown): string | undefined =>
  typeof id === 'string' && id !== '' ? `${prefix}\u0000${String(session)}\u0000${String(turn)}\u0000${id}` : undefined;

function indexRecords(records: AgentActivityEntry[]): Map<string, AgentActivityEntry[]> {
  const index = new Map<string, AgentActivityEntry[]>();
  const add = (key: string | undefined, record: AgentActivityEntry) => {
    if (key) index.set(key, [...(index.get(key) ?? []), record]);
  };
  for (const record of records) {
    add(typeof record.span_id === 'string' && record.span_id ? `s\u0000${record.span_id}` : undefined, record);
    add(callKey('r', record['gen_ai.session.id'], record['gen_ai.turn.id'], record['gen_ai.response.id']), record);
    add(callKey('c', record['gen_ai.session.id'], record['gen_ai.turn.id'], record['gen_ai.tool.call.id']), record);
  }
  return index;
}

/** The converter's turn-level passthrough would leak settings into later calls. */
export function attachModelSettings(records: AgentActivityEntry[], spans: ReadableSpan[]): ReadableSpan[] {
  const index = indexRecords(records);
  return spans.map(span => {
    const kind = span.attributes['gen_ai.span.kind'];
    if (kind !== 'LLM' && kind !== 'TOOL') return span;
    const a = span.attributes;
    const keys = [`s\u0000${span.spanContext().spanId}`, kind === 'LLM'
      ? callKey('r', a['gen_ai.session.id'], a['gen_ai.turn.id'], a['gen_ai.response.id'])
      : callKey('c', a['gen_ai.session.id'], a['gen_ai.turn.id'], a['gen_ai.tool.call.id'])];
    const candidates = [...new Set(keys.flatMap(key => (key && index.get(key)) || []))]
      .filter(record => matches(record, span));
    const settings = candidates.map(record => normalizeModelSettings(record));
    const updates = Object.fromEntries(MODEL_SETTINGS_PASSTHROUGH_KEYS.flatMap(key => {
      const values = [...new Set(settings.map(s => s[key]).filter(v => v !== undefined))];
      return values.length === 1 ? [[key, values[0]]] : [];
    })) as Attributes;
    const hasSource = settings.some(record => typeof record['gen_ai.request.model_settings.source'] === 'string');
    if (Object.keys(updates).length === 0 && !hasSource) return span;
    const retained = hasSource ? Object.fromEntries(Object.entries(span.attributes)
      .filter(([key]) => !(MODEL_NAME_KEYS as readonly string[]).includes(key))) : span.attributes;
    return withSpanAttributes(span, { ...retained, ...updates, ...(hasSource ? explicitModels(candidates) : {}) });
  });
}
