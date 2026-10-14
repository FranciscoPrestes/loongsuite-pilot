import { z } from 'zod';
import type { AgentDefinition, HarnessAnalyticsDeclaration } from '../types/deployment.js';
import { getInputAdapterInventory } from '../inputs/input-adapter-inventory.js';

const nonempty = z.string().trim().min(1);
const support = z.enum(['conditional', 'unavailable', 'validated']);
const eventClass = z.enum(['message', 'tool_call', 'tool_result', 'llm_usage', 'hook_health']);
const declarationSchema = z.object({
  version: z.literal(1),
  lifecycle: z.enum(['supported', 'deprecated', 'retired', 'unavailable']),
  platforms: z.array(z.enum(['darwin', 'linux', 'win32'])).min(1),
  versionRange: nonempty.nullable(),
  mechanisms: z.array(nonempty).min(1),
  adapters: z.array(z.object({ id: nonempty, role: z.enum(['primary', 'fallback', 'supplement', 'shared', 'retired']),
    whenPrimaryDisabled: nonempty.optional(), reason: nonempty.optional() }).strict()),
  sourceRules: z.array(z.object({ eventClass, primary: nonempty, secondary: z.array(nonempty),
    equivalence: z.literal('native-id-or-validated-rule'), unresolvedSecondary: z.literal('exclude-additive-volumes'),
    usageSemantics: z.enum(['delta', 'cumulative', 'unavailable']).optional(),
    variantPrimaries: z.array(z.object({ variant: z.enum(['cli', 'ide']), primary: nonempty, secondary: z.array(nonempty) }).strict()).optional() }).strict()).min(1),
  capabilities: z.object({ messages: support, tools: support, results: support, tokens: support, subagents: support }).strict(),
  gaps: z.array(nonempty).min(1),
}).strict();

export interface CapabilityManifest extends HarnessAnalyticsDeclaration {
  harnessId: string;
  displayName: string;
  retiredHookEvents: string[];
}

/** Custom PI SDK definitions retain their native harness identity on the shared stream. */
function piSdkDeclaration(): HarnessAnalyticsDeclaration {
  return {
    version: 1, lifecycle: 'supported', platforms: ['darwin', 'linux', 'win32'], versionRange: null,
    mechanisms: ['local-extension-jsonl'], adapters: [{ id: 'pi-coding-agent-log', role: 'shared' }],
    sourceRules: (['message', 'tool_call', 'tool_result', 'llm_usage'] as const).map(eventClass => ({
      eventClass, primary: 'pi-coding-agent.extension.native-agent-id', secondary: [],
      equivalence: 'native-id-or-validated-rule', unresolvedSecondary: 'exclude-additive-volumes',
      ...(eventClass === 'llm_usage' ? { usageSemantics: 'delta' as const } : {}),
    })),
    capabilities: { messages: 'conditional', tools: 'conditional', results: 'conditional', tokens: 'conditional', subagents: 'conditional' },
    gaps: ['Live execution validation pending', 'Availability depends on extension version and native fields'],
  };
}

export function loadCapabilityManifest(definition: AgentDefinition): CapabilityManifest {
  const raw = definition.analytics ?? (definition.piSdk?.schemaVersion === 1 ? piSdkDeclaration() : undefined);
  const parsed = declarationSchema.parse(raw);
  const inventory = getInputAdapterInventory();
  const ids = new Set(parsed.adapters.map(adapter => adapter.id));
  if (ids.size !== parsed.adapters.length) throw new Error(`Duplicate adapters for ${definition.id}`);
  for (const binding of parsed.adapters) {
    const adapter = inventory.find(item => item.id === binding.id);
    if (!adapter) throw new Error(`Undeclared input adapter ${binding.id} for ${definition.id}`);
    if (adapter.disposition === 'retired' && binding.role !== 'retired') throw new Error(`Retired input ${binding.id} cannot collect`);
    if (binding.role === 'fallback' && (!binding.whenPrimaryDisabled ||
      !parsed.adapters.some(primary => primary.id === binding.whenPrimaryDisabled && primary.role === 'primary'))) {
      throw new Error(`Fallback ${binding.id} requires a declared primary`);
    }
  }
  return { ...parsed, harnessId: definition.id, displayName: definition.displayName,
    retiredHookEvents: [...(definition.hook?.retiredEvents ?? [])] };
}

/** Inventory follows actual loaded definitions, including local PI SDK additions. */
export function listCapabilities(definitions: readonly AgentDefinition[]): CapabilityManifest[] {
  return definitions.map(loadCapabilityManifest);
}
