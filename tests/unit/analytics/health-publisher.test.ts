import { describe, expect, it, vi } from 'vitest';
import { buildHealthObservations, configureHealthPublisher, createHealthPublisher, publishCollectionHealth, summarizeHealth, type HealthContext, type HealthStatus } from '../../../src/analytics/health-publisher.js';
import { readObservationEnvelope } from '../../../src/analytics/observation-exporter.js';
import type { EffectiveInstrumentationPolicy } from '../../../src/analytics/desired-policy-client.js';

const now = new Date('2026-10-16T12:00:00Z');
const policy = (over: Partial<EffectiveInstrumentationPolicy> = {}): EffectiveInstrumentationPolicy => ({ enrichmentEnabled: true, replayEnabled: true,
  baseTelemetryEnabled: true, reason: 'ready', desiredRevision: '5', deletionRevision: '9', ...over });
const ctx = (p = policy()): HealthContext => ({ deviceId: 'dev', userId: 'u', collectorVersion: '1.2.0', now: () => now, policy: () => p });
const status = (over: Partial<HealthStatus> = {}): HealthStatus => ({ harnessId: 'claude-code', state: 'configured', observedAt: now.getTime(), detected: true, repairResult: 'not_needed', ...over });
const ackOf = (s: HealthStatus, p = policy()) => {
  const o = buildHealthObservations([s], ctx(p), false)[0]!;
  return o.kind === 'hook_health' ? o.payload : null;
};

describe('hook_health publication (D4 ACK)', () => {
  it('acknowledges desired and applied revision plus the bundle/deletion revision when configured', () => {
    expect(ackOf(status())!.ack).toMatchObject({ desiredRevision: '5', appliedRevision: '5', deletionRevision: '9', repairResult: 'not_needed', installedVersion: null });
  });

  it('never claims an applied revision for failed, pending, unsupported, errored, detected-only or disabled harnesses', () => {
    for (const s of [status({ repairResult: 'failed' }), status({ repairResult: 'pending' }), status({ state: 'unsupported_version' }), status({ state: 'error' }),
      status({ state: 'detected' }), status({ state: 'disabled', repairResult: 'disabled' })]) {
      expect(ackOf(s)!.ack!.appliedRevision, JSON.stringify(s)).toBeNull();
    }
  });

  it('carries real evidence only: lastEventAt from a valid event, listed as missing otherwise', () => {
    const none = buildHealthObservations([status()], ctx(), false)[0]!;
    expect(none.missingFields).toContain('lastEventAt');
    const seen = buildHealthObservations([status({ lastEventAt: now.getTime() - 5000, state: 'healthy' })], ctx(), false)[0]!;
    expect(seen.missingFields).toEqual([]);
    expect(seen.kind === 'hook_health' && seen.payload.lastEventAt).toBe('2026-10-16T11:59:55.000Z');
  });

  it('publishes disabled and divergent states instead of omitting them, but nothing without an authoritative policy', () => {
    expect(buildHealthObservations([status({ state: 'disabled' })], ctx(policy({ reason: 'central_disabled' })), false)).toHaveLength(1);
    for (const reason of ['local_disabled', 'unauthorized', 'no_policy'] as const) {
      expect(buildHealthObservations([status()], ctx(policy({ reason })), false)).toEqual([]);
    }
  });

  it('marks truncation and keeps one observation per harness with a stable per-minute identity', () => {
    const a = buildHealthObservations([status(), status({ harnessId: 'codex' })], ctx(), true);
    expect(a.map(o => o.truncated)).toEqual([true, true]);
    expect(new Set(a.map(o => o.observationId)).size).toBe(2);
    expect(buildHealthObservations([status()], ctx(), true)[0]!.observationId).toBe(a[0]!.observationId);
  });

  it('local summary reports lag, drift, drops and parser version; unknown drops stay unknown', () => {
    const summary = summarizeHealth([status({ state: 'healthy', lastEventAt: now.getTime() - 4000, activity: 'observed', receivedFields: ['tool_call'], missingPairs: 2 }),
      status({ harnessId: 'codex', state: 'unsupported_version' })], ctx(), { expired: 1, quota: 0, busy: 2, total: 3 });
    expect(summary).toMatchObject({ policyReason: 'ready', desiredRevision: '5', parserVersion: 'analytics-observation/1', truncated: true, dropped: { total: 3 } });
    expect(summary.harnesses[0]).toMatchObject({ lagMs: 4000, missingPairs: 2, drift: false, activity: 'observed' });
    expect(summary.harnesses[1]).toMatchObject({ lagMs: null, drift: true, activity: 'unobserved' });
    expect(summarizeHealth([], ctx(), null).dropped).toBeNull();
  });

  it('publisher attaches an analytics envelope, survives send and loss failures, and exposes the summary', async () => {
    const sent: unknown[] = [];
    const publisher = createHealthPublisher({ ...ctx(), losses: async () => { throw new Error('manifest unreadable'); } }, async entry => {
      if (sent.length === 0) { sent.push(entry); return; }
      throw new Error('offline');
    });
    await publisher.publishCollectionHealth([status(), status({ harnessId: 'codex' })]);
    expect(sent).toHaveLength(1);
    expect(readObservationEnvelope(sent[0] as never)!.kind).toBe('hook_health');
    expect(publisher.summary()!.dropped).toBeNull();
  });

  it('module-level publish is a no-op until configured and never throws', async () => {
    await expect(publishCollectionHealth([status()])).resolves.toBeUndefined();
    const send = vi.fn().mockResolvedValue(undefined);
    configureHealthPublisher(createHealthPublisher(ctx(), send));
    await publishCollectionHealth([status()]);
    expect(send).toHaveBeenCalledTimes(1);
    configureHealthPublisher({ publishCollectionHealth: async () => { throw new Error('x'); }, summary: () => null });
    await expect(publishCollectionHealth([status()])).resolves.toBeUndefined();
    configureHealthPublisher(null);
  });
});
