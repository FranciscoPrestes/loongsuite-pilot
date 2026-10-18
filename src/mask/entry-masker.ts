import type { AgentActivityEntry, MaskConfig } from '../types/index.js';
import { shouldMaskField } from './field-whitelist.js';
import { activeMaskPlan, isMaskActive } from './active-mask.js';
import { loadMaskPlan } from './rule-loader.js';
import { maskString } from './string-masker.js';
import type {
  CompiledMaskRule,
  MaskPlan,
  StringMaskOptions,
} from './types.js';

type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | JsonSafeValue[]
  | { [key: string]: JsonSafeValue };

const MAX_MASK_JSON_DEPTH = 32;

export function maskAgentActivityEntry(
  entry: AgentActivityEntry,
  config: MaskConfig,
  planOrRules: MaskPlan | readonly CompiledMaskRule[] = loadMaskPlan(config),
  options: StringMaskOptions = {},
): AgentActivityEntry {
  const plan = resolveMaskPlan(planOrRules);
  if (plan.rules.length === 0 && plan.piiTypes.size === 0) return entry;

  let maskedEntry: AgentActivityEntry | undefined;

  for (const [field, value] of Object.entries(entry)) {
    if (!shouldMaskField(field)) continue;
    const maskedValue = maskJsonSafeValue(value as JsonSafeValue, plan, options);
    if (maskedValue !== value) {
      maskedEntry ??= { ...entry };
      maskedEntry[field] = maskedValue;
    }
  }

  return maskedEntry ?? entry;
}

function maskJsonSafeValue(
  value: JsonSafeValue,
  plan: MaskPlan,
  options: StringMaskOptions,
  depth = 0,
): JsonSafeValue {
  if (depth >= MAX_MASK_JSON_DEPTH) return value;

  if (typeof value === 'string') {
    return maskString(value, plan, options);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const maskedItems = value.map(item => {
      const maskedItem = maskJsonSafeValue(item, plan, options, depth + 1);
      if (maskedItem !== item) changed = true;
      return maskedItem;
    });
    return changed ? maskedItems : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const maskedObject: Record<string, JsonSafeValue> = {};
    for (const [key, child] of Object.entries(value)) {
      const maskedChild = maskJsonSafeValue(child, plan, options, depth + 1);
      maskedObject[key] = maskedChild;
      if (maskedChild !== child) changed = true;
    }
    return changed ? maskedObject : value;
  }
  return value;
}

function resolveMaskPlan(planOrRules: MaskPlan | readonly CompiledMaskRule[]): MaskPlan {
  if (Array.isArray(planOrRules)) {
    return {
      rules: planOrRules,
      piiTypes: new Set(),
      replacementMode: 'placeholder',
    };
  }
  return planOrRules as MaskPlan;
}

/**
 * Sanitize a single evidence snippet (local manifest / documentation / command
 * body) before persistence. Bounding the byte size is the caller's job; this
 * only removes sensitive material. Paths are locators and must never be masked.
 */
export function sanitizeSnippetText(text: string): string {
  const plan = activeMaskPlan();
  return isMaskActive(plan) ? maskString(text, plan) : text;
}

/**
 * Sanitize an enriched payload (e.g. a whole analytics observation) before it
 * is persisted or exported. Deep-masks every string leaf with the full
 * sensitive + PII plan; bounding is the caller's job. Structural identity that
 * masking would rewrite (ids, versions, refs) must make the caller fail closed
 * instead of emitting a corrupted record.
 */
export function sanitizeEnrichedPayload<T>(value: T): T {
  const plan = activeMaskPlan();
  return isMaskActive(plan) ? (maskJsonSafeValue(value as JsonSafeValue, plan, {}) as T) : value;
}
