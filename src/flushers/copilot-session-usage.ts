import { createHash } from 'node:crypto';
import type { Attributes } from '@opentelemetry/api';
import { normalizeAgentType } from '../utils/agent-type-normalize.js';
import { DEFAULT_GIT_PASSTHROUGH_KEYS } from '../normalization/global-attributes.js';
import type { AgentActivityEntry } from '../types/index.js';

/**
 * Copilot reports session-scope usage (cost checkpoints and per-session token
 * totals) as `other` events with no turn. The EventLog converter ignores such
 * events, so the flusher exports each one as its own span. That span is the
 * ONLY carrier of the Copilot session tokens: turn spans stay token-free, so
 * nothing is counted twice.
 */
export const COPILOT_SESSION_USAGE_SPAN_NAME = 'copilot.session_usage';

const USAGE_SCOPE_KEY = 'agent.copilot.usage.scope';
const USAGE_PREFIXES = ['gen_ai.usage.', 'agent.copilot.usage.'];
const IDENTITY_KEYS = [
  'gen_ai.session.id',
  'gen_ai.agent.type',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  ...DEFAULT_GIT_PASSTHROUGH_KEYS,
];
const TOKEN_KEYS = ['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens'];
const VALID_TRACE_ID_RE = /^[0-9a-f]{32}$/;

export function isCopilotSessionUsage(entry: AgentActivityEntry): boolean {
  return normalizeAgentType(String(entry['gen_ai.agent.type'] ?? '')) === 'copilot'
    && entry[USAGE_SCOPE_KEY] === 'session';
}

function hex(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface SessionUsageIds {
  traceId: string;
  spanId: string;
}

/**
 * traceId comes from the session (a valid `trace_id` is the fallback), spanId
 * from the event id, so a re-sent event reproduces the same span. Returns
 * undefined when the event has nothing to correlate on.
 */
export function deriveSessionUsageIds(entry: AgentActivityEntry): SessionUsageIds | undefined {
  const sessionId = nonEmpty(entry['gen_ai.session.id']);
  const rawTraceId = nonEmpty(entry['trace_id']);
  const traceId = sessionId
    ? hex(`copilot-session:${sessionId}`, 32)
    : rawTraceId && VALID_TRACE_ID_RE.test(rawTraceId) ? rawTraceId : undefined;
  if (!traceId) return undefined;
  const eventId = nonEmpty(entry['event.id'])
    ?? `${entry['time_unix_nano'] ?? ''}:${JSON.stringify(sessionUsageAttributes(entry))}`;
  return { traceId, spanId: hex(`copilot-usage:${eventId}`, 16) };
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

/** Every usage attribute of the event plus the identity ones; no passthrough config needed. */
export function sessionUsageAttributes(entry: AgentActivityEntry): Attributes {
  const attrs: Attributes = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!isScalar(value)) continue;
    if (USAGE_PREFIXES.some(prefix => key.startsWith(prefix))) attrs[key] = value;
  }
  for (const key of IDENTITY_KEYS) {
    const value = (entry as Record<string, unknown>)[key];
    if (isScalar(value)) attrs[key] = value;
  }
  const userId = nonEmpty(entry['gen_ai.user.id']) ?? nonEmpty(entry['user.id']);
  if (userId) attrs['gen_ai.user.id'] = userId;
  // Panels group by the request model; session events only report the response one.
  if (attrs['gen_ai.request.model'] === undefined && attrs['gen_ai.response.model'] !== undefined) {
    attrs['gen_ai.request.model'] = attrs['gen_ai.response.model'];
  }
  // A checkpoint carries cost only; marking it LLM would inflate LLM counts.
  attrs['gen_ai.span.kind'] = TOKEN_KEYS.some(key => isScalar(attrs[key])) ? 'LLM' : 'USAGE';
  return attrs;
}
