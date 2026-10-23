import type { JsonValue } from '../types/events.js';

const TEXT_KEYS = [
  'gen_ai.request.reasoning.level',
  'gen_ai.request.thinking.type',
  'gen_ai.request.model_settings.source',
  'gen_ai.request.model_settings.scope',
  'gen_ai.request.router.name',
  'gen_ai.request.router.selected_model',
  'gen_ai.request.router.provider',
  'gen_ai.request.router.reason',
  'gen_ai.request.router.reasoning.level',
] as const;
const BUDGET_KEYS = [
  'gen_ai.request.reasoning.budget_tokens',
  'gen_ai.request.router.reasoning.budget_tokens',
] as const;

export const MODEL_SETTINGS_PASSTHROUGH_KEYS = [...TEXT_KEYS, ...BUDGET_KEYS] as const;
const MAX_TEXT_LENGTH = 256;

export function readReasoningLevel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(value) ? value : undefined;
}

/** Undefined values clear invalid raw fields before the serialization boundary. */
export function normalizeModelSettings(input: Record<string, unknown>): Record<string, JsonValue | undefined> {
  return Object.fromEntries([
    ...TEXT_KEYS.map(key => {
      const value = input[key];
      return [key, typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH
        && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : undefined];
    }),
    ...BUDGET_KEYS.map(key => {
      const value = input[key];
      return [key, typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined];
    }),
  ]);
}
