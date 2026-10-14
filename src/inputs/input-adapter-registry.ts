import { QoderCnSqliteInput } from './qoder-cn-sqlite/qoder-cn-sqlite-input.js';
import { QoderCnInput } from './qoder-cn/qoder-cn-input.js';
import { QoderCnTraceInput } from './qoder-cn-trace/qoder-cn-trace-input.js';
import { QoderWorkInput } from './qoder-work/qoder-work-input.js';
import { QoderWorkLogInput } from './qoder-work-log/qoder-work-log-input.js';
import { QoderWorkTraceInput as QoderWorkCNTraceInput } from './qoder-work-log/qoder-work-trace-input.js';
import { QoderWorkSqliteInput } from './qoder-work-sqlite/qoder-work-sqlite-input.js';
import { QoderWorkTraceInput } from './qoder-work-trace/qoder-work-trace-input.js';
import { QwenWorkCNInput } from './qwen-work-cn/qwen-work-cn-input.js';
import { QwenWorkCNTraceInput } from './qwen-work-cn/qwen-work-cn-trace-input.js';
import { QwenWorkCNSqliteInput } from './qwen-work-cn/qwen-work-cn-sqlite-input.js';
import { QoderTraceInput } from './qoder-trace/qoder-trace-input.js';
import { CursorHookInput } from './cursor-hook/cursor-hook-input.js';
import { ClaudeCodeLogInput } from './claude-code-log/claude-code-log-input.js';
import { GrokBuildLogInput } from './grok-build-log/grok-build-log-input.js';
import { CodexTranscriptInput } from './codex-transcript/codex-transcript-input.js';
import { KiroCliLogInput } from './kiro-cli-log/kiro-cli-log-input.js';
import { KiroCliSessionInput } from './kiro-cli-session/kiro-cli-session-input.js';
import { OpenCodeLogInput } from './opencode-log/opencode-log-input.js';
import { PiCodingAgentLogInput } from './pi-coding-agent-log/pi-coding-agent-log-input.js';
import { MimoCodeLogInput } from './mimo-code-log/mimo-code-log-input.js';
import { QwenCodeCliLogInput } from './qwen-code-cli-log/qwen-code-cli-log-input.js';
import { HermesLogInput } from './hermes-log/hermes-log-input.js';
import { DshLogInput } from './dsh-log/dsh-log-input.js';
import { OpenClawPluginInput } from './openclaw-plugin/openclaw-plugin-input.js';
import { WukongInput } from './wukong/wukong-input.js';
import { WorkBuddyInput } from './workbuddy/workbuddy-input.js';
import { CopilotInput } from './copilot/copilot-input.js';
import * as path from 'node:path';
import type { StateStore } from '../checkpoints/state-store.js';
import type { AgentDefinition } from '../types/deployment.js';
import { ClientType } from '../types/client-type.js';
import type { BaseInput } from './base/base-input.js';
import { loadCapabilityManifest } from '../analytics/capabilities.js';

const constructors = {
  'qoder-cn-sqlite': QoderCnSqliteInput,
  'qoder-cn': QoderCnInput,
  'qoder-cn-trace': QoderCnTraceInput,
  'qoder-work-hook': QoderWorkInput,
  'qoder-work-log': QoderWorkLogInput,
  'qoder-work-sqlite': QoderWorkSqliteInput,
  'qoder-work-trace': QoderWorkTraceInput,
  'qoder-work-cn-trace': QoderWorkCNTraceInput,
  'qoder-work-cn-hook': QoderWorkInput,
  'qoder-work-cn-log': QoderWorkLogInput,
  'qoder-work-cn-sqlite': QoderWorkSqliteInput,
  'qwen-work-cn-hook': QwenWorkCNInput,
  'qwen-work-cn-trace': QwenWorkCNTraceInput,
  'qwen-work-cn-sqlite': QwenWorkCNSqliteInput,
  'qoder-trace': QoderTraceInput,
  'cursor-hook': CursorHookInput,
  'claude-code-log': ClaudeCodeLogInput,
  'grok-build-log': GrokBuildLogInput,
  'codex-transcript': CodexTranscriptInput,
  'kiro-cli-log': KiroCliLogInput,
  'kiro-cli-session': KiroCliSessionInput,
  'opencode-log': OpenCodeLogInput,
  'pi-coding-agent-log': PiCodingAgentLogInput,
  'mimo-code-log': MimoCodeLogInput,
  'qwen-code-cli-log': QwenCodeCliLogInput,
  'hermes-agent-log': HermesLogInput,
  'dsh-log': DshLogInput,
  'openclaw-plugin-log': OpenClawPluginInput,
  'wukong': WukongInput,
  'workbuddy': WorkBuddyInput,
  'copilot': CopilotInput,
} as const;

export type InputAdapterId = keyof typeof constructors;
export type InputAdapterOptions = { [K in InputAdapterId]: NonNullable<ConstructorParameters<typeof constructors[K]>[0]> };
export { getInputAdapterInventory } from './input-adapter-inventory.js';

/** Also name producers outside BaseInput; remote pipeline is explicitly excluded. */
export function getCollectionProducerInventory() {
  return [
    { id: 'interceptor', sourcePath: 'src/core/input-manager.ts', disposition: 'local-supplement', reason: 'flushPreparedEntries uses original native tool identity; not an additional call' },
    { id: 'file-pipeline', sourcePath: 'src/pipeline/input/file', disposition: 'separate-local-pipeline', reason: 'Generic file tailer is not a harness adapter' },
    { id: 'qoder-api-pipeline', sourcePath: 'src/pipeline/input/qoder-api', disposition: 'excluded', reason: 'Remote OpenAPI pipeline is outside governed local analytics policy' },
  ] as const;
}

/** The orchestrator and declarative factory share these exact constructors. No lifecycle is started here. */
export function createInputAdapter<K extends InputAdapterId>(id: K, options: InputAdapterOptions[K]): InstanceType<typeof constructors[K]> {
  const ctor = constructors[id];
  if (!ctor) throw new Error(`Unregistered input adapter: ${id}`);
  // Several CN adapters reuse an international constructor whose default is
  // QoderWork. The registry identity selects the actual native harness variant.
  const resolved = id.startsWith('qoder-work-cn-') ? { ...options, agentType: ClientType.QoderWorkCN } : options;
  return Reflect.construct(ctor, [resolved]) as InstanceType<typeof constructors[K]>;
}

export interface InputAdapterDependencies {
  stateStore: StateStore;
  dataDir: string;
  homeDir: string;
  platform?: NodeJS.Platform;
  isEnabled?: (adapterId: string) => boolean;
  agentEnabled?: (harnessId: string) => boolean;
  /** Exact per-constructor overrides preserve multimodal processors and native paths. */
  options?: Partial<{ [K in InputAdapterId]: Partial<InputAdapterOptions[K]> }>;
}

function defaultOptions(id: InputAdapterId, deps: InputAdapterDependencies): Record<string, unknown> {
  const logAgent = id === 'cursor-hook' ? 'cursor' : id.replace(/-(?:plugin-)?log$/, '').replace(/-(?:trace|hook)$/, '');
  const logDir = path.join(deps.dataDir, 'logs', logAgent,
    /^(?:qoder|qwen-work-cn|cursor)/.test(logAgent) ? 'history' : '');
  const cn = id.startsWith('qoder-work-cn');
  const qoderRoot = (deps.platform ?? process.platform) === 'darwin'
    ? path.join(deps.homeDir, 'Library', 'Application Support', cn ? 'QoderWork CN' : 'QoderWork')
    : path.join(deps.homeDir, '.config', cn ? 'QoderWork CN' : 'QoderWork');
  return {
    stateStore: deps.stateStore, dataDir: deps.dataDir, logDir,
    ...(id.startsWith('qoder-work-') ? { dataRoot: qoderRoot, ...(cn ? { agentType: ClientType.QoderWorkCN } : {}) } : {}),
    ...(id === 'codex-transcript' ? { sessionDir: path.join(deps.homeDir, '.codex', 'sessions'),
      wakeupDir: path.join(deps.dataDir, 'state', 'codex', 'transcript-wakeups'),
      spanContextDir: path.join(deps.dataDir, 'state', 'codex', 'transcript-span-contexts') } : {}),
    ...(id === 'kiro-cli-session' ? { hookProcessorPath: path.join(deps.dataDir, 'hooks', 'kiro-cli-hook-processor.mjs') } : {}),
    ...(id === 'dsh-log' || id === 'hermes-agent-log' ? { sessionDir: logDir } : {}),
    ...(id === 'pi-coding-agent-log' ? { logDir: path.join(deps.dataDir, 'logs', 'pi-coding-agent'), agentEnabled: deps.agentEnabled } : {}),
    ...(id === 'copilot' ? { wakeupDir: path.join(deps.dataDir, 'state', 'copilot', 'wakeups') } : {}),
    ...(id === 'workbuddy' ? { hookEventDir: path.join(deps.dataDir, 'state', 'workbuddy', 'hook-events') } : {}),
  };
}

export function createInputAdapters(definition: AgentDefinition, dependencies: InputAdapterDependencies): BaseInput[] {
  const manifest = loadCapabilityManifest(definition);
  const enabled = dependencies.isEnabled ?? (() => true);
  if (manifest.lifecycle === 'retired' || manifest.lifecycle === 'unavailable') return [];
  return manifest.adapters.filter(binding => binding.role !== 'retired' && binding.role !== 'shared'
    && enabled(binding.id) && !(binding.role === 'fallback' && enabled(binding.whenPrimaryDisabled!)))
    .concat(manifest.adapters.filter(binding => binding.role === 'shared' && !!definition.piSdk && enabled(binding.id)))
    .map(binding => {
      const id = binding.id as InputAdapterId;
      const options = { ...defaultOptions(id, dependencies), ...dependencies.options?.[id] };
      return createInputAdapter(id, options as InputAdapterOptions[typeof id]);
    });
}
