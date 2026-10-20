/** Source-backed ledger; importing metadata never loads or starts native inputs. */
export interface InputAdapterDescriptor {
  id: string;
  sourcePath: string;
  disposition: 'registered' | 'retired';
  reason?: string;
}
const retired: readonly InputAdapterDescriptor[] = [
  { id: 'qoder', sourcePath: 'src/inputs/qoder/qoder-input.ts', disposition: 'retired', reason: 'Legacy IDE input superseded by qoder-trace; no validated dual-stream deduplication' },
  { id: 'codex-log', sourcePath: 'src/inputs/codex-log/codex-log-input.ts', disposition: 'retired', reason: 'Retired Codex tool hooks; native transcript is primary' },
  { id: 'codex-aborted-turn', sourcePath: 'src/inputs/codex-aborted-turn/codex-aborted-turn-input.ts', disposition: 'retired', reason: 'Recovery is owned by active codex-transcript' },
];
const sourcePaths: Record<string, string> = {
  'qoder-cn-sqlite': 'src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.ts',
  'qoder-cn': 'src/inputs/qoder-cn/qoder-cn-input.ts',
  'qoder-cn-trace': 'src/inputs/qoder-cn-trace/qoder-cn-trace-input.ts',
  'qoder-work-hook': 'src/inputs/qoder-work/qoder-work-input.ts',
  'qoder-work-log': 'src/inputs/qoder-work-log/qoder-work-log-input.ts',
  'qoder-work-sqlite': 'src/inputs/qoder-work-sqlite/qoder-work-sqlite-input.ts',
  'qoder-work-trace': 'src/inputs/qoder-work-trace/qoder-work-trace-input.ts',
  'qoder-work-cn-trace': 'src/inputs/qoder-work-log/qoder-work-trace-input.ts',
  'qoder-work-cn-hook': 'src/inputs/qoder-work/qoder-work-input.ts',
  'qoder-work-cn-log': 'src/inputs/qoder-work-log/qoder-work-log-input.ts',
  'qoder-work-cn-sqlite': 'src/inputs/qoder-work-sqlite/qoder-work-sqlite-input.ts',
  'qwen-work-cn-hook': 'src/inputs/qwen-work-cn/qwen-work-cn-input.ts',
  'qwen-work-cn-trace': 'src/inputs/qwen-work-cn/qwen-work-cn-trace-input.ts',
  'qwen-work-cn-sqlite': 'src/inputs/qwen-work-cn/qwen-work-cn-sqlite-input.ts',
  'qoder-trace': 'src/inputs/qoder-trace/qoder-trace-input.ts',
  'cursor-hook': 'src/inputs/cursor-hook/cursor-hook-input.ts',
  'claude-code-log': 'src/inputs/claude-code-log/claude-code-log-input.ts',
  'grok-build-log': 'src/inputs/grok-build-log/grok-build-log-input.ts',
  'codex-transcript': 'src/inputs/codex-transcript/codex-transcript-input.ts',
  'kiro-cli-log': 'src/inputs/kiro-cli-log/kiro-cli-log-input.ts',
  'kiro-cli-session': 'src/inputs/kiro-cli-session/kiro-cli-session-input.ts',
  'opencode-log': 'src/inputs/opencode-log/opencode-log-input.ts',
  'pi-coding-agent-log': 'src/inputs/pi-coding-agent-log/pi-coding-agent-log-input.ts',
  'mimo-code-log': 'src/inputs/mimo-code-log/mimo-code-log-input.ts',
  'qwen-code-cli-log': 'src/inputs/qwen-code-cli-log/qwen-code-cli-log-input.ts',
  'hermes-agent-log': 'src/inputs/hermes-log/hermes-log-input.ts',
  'dsh-log': 'src/inputs/dsh-log/dsh-log-input.ts',
  'openclaw-plugin-log': 'src/inputs/openclaw-plugin/openclaw-plugin-input.ts',
  'wukong': 'src/inputs/wukong/wukong-input.ts',
  'workbuddy': 'src/inputs/workbuddy/workbuddy-input.ts',
  'copilot': 'src/inputs/copilot/copilot-input.ts',
};

export function getInputAdapterInventory(): InputAdapterDescriptor[] {
  return [...Object.entries(sourcePaths).map(([id, sourcePath]) => ({ id, sourcePath, disposition: 'registered' as const })), ...retired.map(item => ({ ...item }))];
}

