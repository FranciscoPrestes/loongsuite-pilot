import type { AgentActivityEntry } from '../types/index.js';
import { isAnalyticsAnnotationKey } from '../types/index.js';

/**
 * Message content is always collected, so there is no content stripping here.
 * What remains is the allowlist for the reserved analytics annotations: only the
 * collector-authored `ntconsult.analytics.*` keys are accepted; anything else
 * claiming that namespace is untrusted input and is dropped.
 */
export function applyAgentContentPolicy(entry: AgentActivityEntry): AgentActivityEntry {
  const next: AgentActivityEntry = { ...entry };
  for (const field of Object.keys(next)) {
    if (field.startsWith('ntconsult.analytics.') && !isAnalyticsAnnotationKey(field)) {
      delete next[field];
    }
  }
  return next;
}
