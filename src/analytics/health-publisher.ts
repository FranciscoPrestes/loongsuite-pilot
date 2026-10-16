import { createHash } from 'node:crypto';
import type { AgentActivityEntry } from '../types/index.js';
import type { CapabilityStatus } from '../deployment/desired-state-reconciler.js';
import type { EffectiveInstrumentationPolicy } from './desired-policy-client.js';
import { attachObservation } from './observation-exporter.js';
import { carrierFor, type LossSummary } from './observation-pump.js';
import { validateObservation, type Observation } from './observation.js';
import type { ObservedCapability } from './capability-observer.js';

export type HealthStatus = CapabilityStatus & Partial<Pick<ObservedCapability, 'activity' | 'receivedFields' | 'missingPairs'>>;
export interface HealthContext {
  deviceId: string; userId: string; collectorVersion: string;
  now: () => Date; policy: () => EffectiveInstrumentationPolicy;
  /** Durable drop counters from the C4 store; absent = unknown, never reported as zero. */
  losses?: () => Promise<LossSummary>;
}
/** Local, in-memory view served by the existing summary file (no second analytics UI). */
export interface CollectionHealthSummary {
  generatedAt: string; policyReason: string; desiredRevision: string | null; collectorVersion: string; parserVersion: string;
  dropped: LossSummary | null; truncated: boolean;
  harnesses: Array<{
    harnessId: string; state: string; activity: string; installedVersion: string | null; lastEventAt: string | null;
    lagMs: number | null; receivedFields: string[]; missingPairs: number; repairResult: string; drift: boolean; reason: string | null;
  }>;
}
const PARSER_VERSION = 'analytics-observation/1';
const WIRE_POLICY_REASONS = new Set(['local_disabled', 'unauthorized', 'no_policy']);
const iso = (ms: number | null | undefined) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);

/** The configuration revision counts as applied only when the harness is really configured and repair did not fail. */
function appliedRevision(status: HealthStatus, desired: string): string | null {
  const configured = status.state === 'configured' || status.state === 'healthy' || status.state === 'partial';
  return configured && status.repairResult !== 'failed' && status.repairResult !== 'pending' ? desired : null;
}

export function buildHealthObservations(statuses: readonly HealthStatus[], ctx: HealthContext, truncated: boolean): Observation[] {
  const policy = ctx.policy();
  if (WIRE_POLICY_REASONS.has(policy.reason)) return []; // no authoritative policy: nothing to acknowledge, nothing leaves the device
  const at = ctx.now();
  return statuses.map((status) => {
    const lastEventAt = iso(status.lastEventAt);
    const desired = policy.desiredRevision;
    const ack = desired !== null && policy.deletionRevision !== null ? {
      desiredRevision: desired, appliedRevision: appliedRevision(status, desired), installedVersion: status.installedVersion ?? null,
      repairResult: status.repairResult, lastEventAt, deletionRevision: policy.deletionRevision, acknowledgedAt: at.toISOString(),
    } : null;
    const bucket = Math.floor(at.getTime() / 60_000);
    return validateObservation({
      schemaVersion: '1', kind: 'hook_health', generatedBy: 'collector',
      observationId: createHash('sha256').update(JSON.stringify([ctx.deviceId, status.harnessId, bucket, status.state, desired, status.repairResult])).digest('hex'),
      harnessId: status.harnessId, harnessVersion: status.installedVersion ?? 'unknown', collectorVersion: ctx.collectorVersion,
      deviceId: ctx.deviceId, capabilitiesVersion: '1', occurredAt: at.toISOString(),
      // Honest gaps instead of fabricated success: absent evidence and dropped work are listed, not hidden.
      missingFields: lastEventAt === null ? ['lastEventAt'] : [],
      truncated, sourceRefs: [{ sourceNamespace: 'collector:health', nativeId: status.harnessId, phase: 'event' }],
      payload: { state: status.state, lastEventAt, ack, reason: status.reason ?? null },
    });
  });
}

export function summarizeHealth(statuses: readonly HealthStatus[], ctx: HealthContext, dropped: LossSummary | null): CollectionHealthSummary {
  const policy = ctx.policy();
  const now = ctx.now().getTime();
  return {
    generatedAt: ctx.now().toISOString(), policyReason: policy.reason, desiredRevision: policy.desiredRevision,
    collectorVersion: ctx.collectorVersion, parserVersion: PARSER_VERSION, dropped, truncated: (dropped?.total ?? 0) > 0,
    harnesses: statuses.map(s => ({
      harnessId: s.harnessId, state: s.state, activity: s.activity ?? 'unobserved', installedVersion: s.installedVersion ?? null,
      lastEventAt: iso(s.lastEventAt), lagMs: typeof s.lastEventAt === 'number' ? Math.max(0, now - s.lastEventAt) : null,
      receivedFields: s.receivedFields ?? [], missingPairs: s.missingPairs ?? 0, repairResult: s.repairResult,
      drift: policy.desiredRevision !== null && appliedRevision(s, policy.desiredRevision) === null && s.state !== 'disabled',
      reason: s.reason ?? null,
    })),
  };
}

export interface HealthPublisher {
  publishCollectionHealth(statuses: readonly HealthStatus[]): Promise<void>;
  summary(): CollectionHealthSummary | null;
}

/** `send` is the existing flusher path; health is regenerated every cycle, so a failed send is simply retried next cycle. */
export function createHealthPublisher(ctx: HealthContext, send: (entry: AgentActivityEntry) => Promise<void>): HealthPublisher {
  let last: CollectionHealthSummary | null = null;
  return {
    summary: () => last,
    async publishCollectionHealth(statuses) {
      let dropped: LossSummary | null = null;
      try { dropped = (await ctx.losses?.()) ?? null; } catch { dropped = null; }
      last = summarizeHealth(statuses, ctx, dropped);
      for (const observation of buildHealthObservations(statuses, ctx, last.truncated)) {
        try { await send(attachObservation(carrierFor(observation, undefined, ctx.userId), observation)); } catch { /* retried next cycle */ }
      }
    },
  };
}

let configured: HealthPublisher | null = null;
export function configureHealthPublisher(publisher: HealthPublisher | null): void { configured = publisher; }
/** Plan interface. Fail-open no-op until the runtime configures a publisher. */
export async function publishCollectionHealth(statuses: readonly HealthStatus[]): Promise<void> {
  try { await configured?.publishCollectionHealth(statuses); } catch { /* health never affects capture */ }
}
