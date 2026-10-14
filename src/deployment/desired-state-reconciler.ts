import type { AgentDefinition } from '../types/index.js';
import type { DeploymentManager } from './deployment-manager.js';
import type { DesiredPolicyClient, EffectiveInstrumentationPolicy } from '../analytics/desired-policy-client.js';
export type CollectionState = 'detected' | 'configured' | 'healthy' | 'partial' | 'unsupported_version' | 'disabled' | 'error';
export interface CapabilityStatus {
  harnessId: string; state: CollectionState; observedAt: number; detected: boolean;
  repairResult: 'not_needed' | 'repaired' | 'failed' | 'disabled' | 'pending'; reason?: string;
}
export interface DesiredStateReconcilerOptions {
  definitions: readonly AgentDefinition[]; deployment: DeploymentManager; intervalMs: number; now: () => number;
  agentEnabled?: (id: string) => boolean; policyClient?: DesiredPolicyClient;
  localEnabled?: () => boolean; compatible?: (def: AgentDefinition) => Promise<boolean>;
  onStatuses?: (statuses: CapabilityStatus[]) => void;
}
/** Existing base capture remains independent of analytics policy expiry/disable. */
export class DesiredStateReconciler {
  readonly nextTickMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<CapabilityStatus[]> | null = null;
  private stopping = false;
  private statuses: CapabilityStatus[] = [];
  constructor(private readonly options: DesiredStateReconcilerOptions) {
    if (options.intervalMs !== 60_000) throw new Error('Reconciliation interval must be 60000ms');
    this.nextTickMs = options.intervalMs;
  }
  async start(): Promise<void> {
    if (this.timer) return;
    this.stopping = false;
    await this.reconcile('startup');
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.reconcile('timer'); }, this.nextTickMs);
    this.timer.unref?.();
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.pending; }
  getStatuses(): CapabilityStatus[] { return this.statuses.map(v => ({ ...v })); }
  getEffectivePolicy(): EffectiveInstrumentationPolicy {
    return this.options.policyClient?.effective(this.options.localEnabled?.() ?? false) ?? {
      enrichmentEnabled: false, replayEnabled: false, baseTelemetryEnabled: true, reason: 'no_policy', desiredRevision: null, deletionRevision: null,
    };
  }
  reconcile(_trigger: 'startup' | 'discovery' | 'timer'): Promise<CapabilityStatus[]> {
    if (this.pending) return this.pending;
    this.pending = this.reconcileOnce().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async reconcileOnce(): Promise<CapabilityStatus[]> {
    await this.options.policyClient?.refresh();
    const statuses: CapabilityStatus[] = [];
    for (const def of this.options.definitions) {
      let status: CapabilityStatus = { harnessId: def.id, state: 'detected', observedAt: this.options.now(), detected: false, repairResult: 'not_needed' };
      try {
        if (this.options.agentEnabled && !this.options.agentEnabled(def.id)) {
          status = { ...status, state: 'disabled', repairResult: 'disabled' };
        } else if (await this.options.deployment.isInstrumentationExplicitlyDisabled(def)) {
          status = { ...status, state: 'disabled', repairResult: 'disabled', reason: 'native_disabled' };
        } else if (def.analytics && (!def.analytics.platforms.includes(process.platform as 'darwin' | 'linux' | 'win32') || def.analytics.lifecycle === 'retired')) {
          status = { ...status, state: 'unsupported_version', reason: 'manifest_incompatible' };
        } else if (this.options.compatible && !(await this.options.compatible(def))) {
          status = { ...status, state: 'unsupported_version', reason: 'version_incompatible' };
        } else if (await this.options.deployment.isAgentDetected(def)) {
          status = { ...status, detected: true };
          if (await this.options.deployment.needsRedeploy(def)) {
            const result = await this.options.deployment.deploySingle(def);
            status = { ...status, state: result.reason === 'disabled' ? 'disabled' : result.success && result.reason !== 'not-detected' ? 'configured' : 'error', repairResult: result.success ? 'repaired' : 'failed',
              ...(result.error ? { reason: result.error } : {}) };
          } else {
            status = { ...status, state: def.deployMode === 'detection-only' ? 'detected' : 'configured' };
          }
        } else { status = { ...status, reason: 'not_detected' }; }
      } catch { status = { ...status, state: 'error', repairResult: 'failed', reason: 'reconciliation_failed' }; }
      statuses.push(status);
    }
    this.statuses = statuses;
    try { this.options.onStatuses?.(this.getStatuses()); } catch { /* observers cannot stop reconciliation */ }
    return this.getStatuses();
  }
}
