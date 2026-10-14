import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentDefinition } from '../types/deployment.js';
import type { CapabilityStatus } from './desired-state-reconciler.js';
import { versionSatisfies } from './manifest-signature.js';
const execute = promisify(execFile);
// Commands are code-owned, never supplied by an untrusted manifest/range.
const VERSION_COMMANDS: Readonly<Record<string, string>> = {
  'claude-code': 'claude', codex: 'codex', 'cursor-cli': 'cursor-agent',
  'kiro-cli': 'kiro-cli', opencode: 'opencode', 'mimo-code': 'mimo',
  openclaw: 'openclaw', 'pi-coding-agent': 'pi', 'qwen-code-cli': 'qwen',
  dsh: 'dsh', 'hermes-agent': 'hermes', qoder: 'qoder',
};
export type VersionProbeRunner = (command: string, args: string[]) => Promise<string>;
const defaultRunner: VersionProbeRunner = async (command, args) => (await execute(command, args, { timeout: 2000, maxBuffer: 4096, shell: false })).stdout;
export interface InstalledVersionStatus { compatible: boolean; installedVersion: string | null; reason: 'version_range_unspecified' | 'installed_version_unknown' | 'version_incompatible' | 'version_supported' }
export async function inspectInstalledVersion(definition: AgentDefinition, runner: VersionProbeRunner = defaultRunner): Promise<InstalledVersionStatus> {
  const range = definition.analytics?.versionRange;
  if (range == null) return { compatible: true, installedVersion: null, reason: 'version_range_unspecified' };
  const unknown: InstalledVersionStatus = { compatible: false, installedVersion: null, reason: 'installed_version_unknown' };
  const command = VERSION_COMMANDS[definition.id];
  if (!command) return unknown;
  try {
    const output = await runner(command, ['--version']);
    const match = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-ntc\.\d+)?)(?=\s|$)/.exec(output.trim());
    if (!match) return unknown;
    const compatible = versionSatisfies(match[1], range);
    return { compatible, installedVersion: match[1], reason: compatible ? 'version_supported' : 'version_incompatible' };
  } catch { return unknown; }
}
export async function probeInstalledCompatibility(definition: AgentDefinition, runner: VersionProbeRunner = defaultRunner): Promise<boolean> {
  return (await inspectInstalledVersion(definition, runner)).compatible;
}
export interface InstrumentationHealthOptions {
  versionProbeRunner?: VersionProbeRunner;
  detected: (def: AgentDefinition) => Promise<boolean>;
  configured: (def: AgentDefinition) => Promise<boolean>;
  enabled?: (def: AgentDefinition) => Promise<boolean>;
  compatible?: (def: AgentDefinition) => Promise<boolean>;
  processAlive?: (def: AgentDefinition) => Promise<boolean>;
  configuredAt?: (def: AgentDefinition) => number | null;
  lastEventAt?: (def: AgentDefinition) => number | null;
  now?: () => number;
}
export class InstrumentationHealth {
  constructor(private readonly options: InstrumentationHealthOptions) {}
  async inspect(definition: AgentDefinition): Promise<CapabilityStatus> {
    const now = this.options.now?.() ?? Date.now();
    const status: CapabilityStatus = { harnessId: definition.id, state: 'detected', detected: false, observedAt: now, repairResult: 'not_needed', processAlive: false, configurationInstalled: false, lastEventAt: null };
    try {
      if (this.options.enabled && !await this.options.enabled(definition)) return { ...status, state: 'disabled', repairResult: 'disabled' };
      const compatibility = this.options.compatible ? { compatible: await this.options.compatible(definition), installedVersion: null, reason: 'version_incompatible' } : await inspectInstalledVersion(definition, this.options.versionProbeRunner);
      status.installedVersion = compatibility.installedVersion;
      if (!compatibility.compatible) return { ...status, state: 'unsupported_version', reason: compatibility.reason };
      status.detected = await this.options.detected(definition);
      if (!status.detected) return { ...status, reason: 'not_detected' };
      status.processAlive = await this.options.processAlive?.(definition) ?? false;
      status.configurationInstalled = definition.deployMode !== 'detection-only' && await this.options.configured(definition);
      if (!status.configurationInstalled) return status;
      status.state = 'configured';
      const event = this.options.lastEventAt?.(definition);
      const configuredAt = this.options.configuredAt?.(definition);
      if (event != null && configuredAt != null && Number.isFinite(event) && event >= configuredAt && event <= now && now - event <= 120000) {
        status.lastEventAt = event; status.state = 'healthy';
      }
      return status;
    } catch { return { ...status, state: 'error', reason: 'inspection_failed' }; }
  }
}
