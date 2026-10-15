import type {
  AgentActivityEntry,
  AgentsConfig,
  JsonValue,
} from '../types/index.js';
import { isAnalyticsAnnotationKey } from '../types/index.js';
import { resolveAgentConfig } from './agent-config.js';

const MESSAGE_CONTENT_FIELDS = new Set([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.input.multimodal_metadata',
  'gen_ai.input.multimodal_metadata_delta',
  'gen_ai.output.messages',
  'gen_ai.output.multimodal_metadata',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

const MESSAGE_CONTENT_ATTRIBUTE_FIELDS = new Set([
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

export function applyAgentContentPolicy(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): AgentActivityEntry {
  const { agentConfig } = resolveAgentConfig(entry, config);

  // Allowlist policy for the reserved analytics annotations: the five
  // collector-authored keys are additive metadata and are excluded from both
  // content stripping and masking decisions here; anything else that claims the
  // `ntconsult.analytics.*` namespace is untrusted and excluded.
  const next: AgentActivityEntry = { ...entry };
  for (const field of Object.keys(next)) {
    if (field.startsWith('ntconsult.analytics.') && !isAnalyticsAnnotationKey(field)) {
      delete next[field];
    }
  }

  if (agentConfig.captureMessageContent) return next;

  for (const field of MESSAGE_CONTENT_FIELDS) {
    delete next[field];
  }

  if (next.attributes && typeof next.attributes === 'object' && !Array.isArray(next.attributes)) {
    const attributes = { ...next.attributes };
    for (const field of MESSAGE_CONTENT_ATTRIBUTE_FIELDS) {
      delete attributes[field];
    }
    next.attributes = attributes as { [key: string]: JsonValue };
  }

  return next;
}
