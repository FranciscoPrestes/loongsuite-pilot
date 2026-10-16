import type { AgentActivityEntry } from '../types/index.js';
import type { CapabilityStatus } from '../deployment/desired-state-reconciler.js';
import type { CapabilityManifest } from './capabilities.js';

/** Same window the reconciler's InstrumentationHealth uses for "recent valid event". */
export const HEALTHY_EVENT_WINDOW_MS = 120_000;
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Activity is a separate dimension from CollectionState (D4): "no known use" is
 * unobserved, "turned off" is disabled, and neither is an error or a failure.
 */
export type CollectionActivity = 'observed' | 'unobserved' | 'disabled';
type EventClass = 'message' | 'tool_call' | 'tool_result' | 'llm_usage';
export interface ObservedCapability extends CapabilityStatus {
  activity: CollectionActivity;
  supportedFields: string[];
  receivedFields: string[];
  /** Tool calls without a result (or the reverse) seen in the evidence window. */
  missingPairs: number;
}

const CLASS_ORDER: EventClass[] = ['message', 'tool_call', 'tool_result', 'llm_usage'];
const CLASSES_BY_CAPABILITY: Record<string, EventClass[]> = {
  messages: ['message'], tools: ['tool_call'], results: ['tool_result'], tokens: ['llm_usage'],
};

function eventMs(entry: AgentActivityEntry, now: number): number | null {
  try {
    const ms = Number(BigInt(entry.time_unix_nano) / 1_000_000n);
    return Number.isSafeInteger(ms) && ms >= 0 && ms <= now + FUTURE_SKEW_MS ? ms : null;
  } catch { return null; }
}

function classesOf(entry: AgentActivityEntry): EventClass[] {
  const found: EventClass[] = [];
  const name = entry['event.name'];
  if (name === 'agent.input' || name === 'llm.request' || name === 'llm.response') found.push('message');
  if (name === 'tool.call') found.push('tool_call');
  if (name === 'tool.result') found.push('tool_result');
  if (typeof entry['gen_ai.usage.total_tokens'] === 'number' || typeof entry['gen_ai.usage.input_tokens'] === 'number') found.push('llm_usage');
  return found;
}

/**
 * Valid evidence = a native, non-collector entry of this harness with identity
 * and a sane timestamp. Collector-generated annotations are never evidence of
 * harness activity, and a process being alive is not evidence either.
 */
/** Event time (ms) when the entry is structurally valid native evidence, otherwise null. */
export function validEvidenceTime(entry: AgentActivityEntry, nowMs: number): number | null {
  if (entry['ntconsult.analytics.kind'] !== undefined || !entry['gen_ai.agent.type'] || !entry['event.id'] || !entry['gen_ai.session.id']) return null;
  return eventMs(entry, nowMs);
}

function evidenceFor(harnessId: string, entries: readonly AgentActivityEntry[], now: number) {
  const received = new Set<EventClass>();
  const calls = new Set<string>();
  const results = new Set<string>();
  let lastEventAt: number | null = null;
  for (const entry of entries) {
    if (entry['gen_ai.agent.type'] !== harnessId) continue;
    const at = validEvidenceTime(entry, now);
    if (at === null) continue;
    lastEventAt = lastEventAt === null ? at : Math.max(lastEventAt, at);
    classesOf(entry).forEach(c => received.add(c));
    const callId = entry['gen_ai.tool.call.id'];
    if (typeof callId === 'string' && callId) {
      if (entry['event.name'] === 'tool.call') calls.add(callId);
      else if (entry['event.name'] === 'tool.result') results.add(callId);
    }
  }
  const missingPairs = [...calls].filter(id => !results.has(id)).length + [...results].filter(id => !calls.has(id)).length;
  return { received, lastEventAt, missingPairs };
}

function supportedFields(manifest: CapabilityManifest): string[] {
  const out = new Set<EventClass>();
  for (const [capability, support] of Object.entries(manifest.capabilities)) {
    if (support !== 'unavailable') (CLASSES_BY_CAPABILITY[capability] ?? []).forEach(c => out.add(c));
  }
  return CLASS_ORDER.filter(c => out.has(c));
}

/**
 * Every manifest is always visible. `base` carries the reconciler's knowledge
 * (installed/configured/process alive); events can only confirm or downgrade,
 * never upgrade an unsupported/error/disabled state (D4: healthy needs a valid
 * event during known activity, and an unused harness is unobserved, not partial).
 */
export function observeCapabilities(
  manifests: readonly CapabilityManifest[], entries: readonly AgentActivityEntry[], now: Date,
  base: readonly CapabilityStatus[] = [],
): ObservedCapability[] {
  const nowMs = now.getTime();
  return manifests.map((manifest) => {
    const known = base.find(s => s.harnessId === manifest.harnessId);
    const status: CapabilityStatus = known ?? { harnessId: manifest.harnessId, state: 'detected', observedAt: nowMs, detected: false, repairResult: 'not_needed' };
    const evidence = evidenceFor(manifest.harnessId, entries, nowMs);
    const common = {
      ...status, observedAt: nowMs, lastEventAt: evidence.lastEventAt ?? status.lastEventAt ?? null,
      supportedFields: supportedFields(manifest), missingPairs: evidence.missingPairs,
      receivedFields: CLASS_ORDER.filter(c => evidence.received.has(c)),
    };
    if (status.state === 'disabled') return { ...common, activity: 'disabled' as const };
    const activity = evidence.lastEventAt === null ? 'unobserved' as const : 'observed' as const;
    if (status.state === 'unsupported_version' || status.state === 'error') return { ...common, activity };
    const recent = evidence.lastEventAt !== null && nowMs - evidence.lastEventAt <= HEALTHY_EVENT_WINDOW_MS;
    if (recent) return { ...common, state: 'healthy' as const, activity, reason: undefined };
    // Known activity = a live process (when a probe supplies it), a previously healthy state, or valid events seen
    // in the evidence window that have since gone quiet. An unused harness has none of these and stays unobserved.
    const knownUse = status.processAlive === true || status.state === 'healthy' || status.state === 'partial' || evidence.lastEventAt !== null;
    if (knownUse) return { ...common, state: 'partial' as const, activity, reason: 'no_valid_event_during_activity' };
    return { ...common, activity };
  });
}
