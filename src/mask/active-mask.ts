import type { MaskConfig } from '../types/index.js';
import { loadMaskPlan } from './rule-loader.js';
import type { MaskPlan } from './types.js';

const OFF: MaskConfig = { mode: 'none', types: [], replacementMode: 'placeholder' };

let config: MaskConfig = OFF;
let plan: MaskPlan = loadMaskPlan(OFF);

/**
 * The mask the user chose, shared by every path that persists or exports evidence (enrichment snippets,
 * job store, observation export). Nothing is masked or anonymised until a mask is switched on explicitly.
 */
export function setActiveMaskConfig(next: MaskConfig | undefined): void {
  config = next ?? OFF;
  plan = loadMaskPlan(config);
}

export function activeMaskConfig(): MaskConfig {
  return config;
}

export function activeMaskPlan(): MaskPlan {
  return plan;
}

export function isMaskActive(maskPlan: MaskPlan = plan): boolean {
  return maskPlan.rules.length > 0 || maskPlan.piiTypes.size > 0;
}
