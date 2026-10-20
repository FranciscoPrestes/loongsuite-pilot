import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DesiredPolicyClient, DEFAULT_HEALTHY_TTL_MS } from '../../../src/analytics/desired-policy-client.js';
import { buildInstrumentationConfig } from '../../../src/core/config-loader.js';

const fixture = JSON.parse(readFileSync('tests/fixtures/analytics/instrumentation-policy-v1.json', 'utf8'));
let clock = Date.parse('2026-10-15T12:00:00Z');
const reply = (body: unknown, status = 200) => ({ status, ok: status === 200, headers: new Headers({ ETag: '"x"' }), json: async () => body }) as Response;
const policy = (over: Record<string, unknown> = {}) => ({ ...fixture, ...over });
function make(fetcher: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return new DesiredPolicyClient({ baseUrl: 'https://portal.test', deviceId: 'fixture-device', authorization: () => 'Bearer fixture', fetch: fetcher as never, now: () => clock, ...extra });
}

describe('I6: an invalid policy turns enrichment OFF instead of freezing the last enabled one', () => {
  it('a server field the schema does not know (strict) disables enrichment', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', newServerField: true })));
    const client = make(fetcher);
    await client.refresh();
    expect(client.effective(true)).toMatchObject({ enrichmentEnabled: true, reason: 'ready' });
    await client.refresh();
    expect(client.getState().reason).toBe('invalid_policy');
    expect(client.effective(true)).toMatchObject({ enrichmentEnabled: false, replayEnabled: false, reason: 'invalid_policy', baseTelemetryEnabled: true });
    expect(client.activation(true).enabled).toBe(false);
  });

  it.each([
    ['revision going backwards', { revision: '9' }],
    ['a different device', { deviceId: 'someone-else' }],
    ['an expired validity window', { expiresAt: '2026-10-14T12:00:00Z' }],
    ['a non-numeric revision', { revision: 'abc' }],
  ])('%s disables it as well', async (_name, change) => {
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy(change))));
    await client.refresh(); await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(false);
  });

  it('the next valid policy turns it back on', async () => {
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', extra: 1 }))).mockResolvedValueOnce(reply(policy({ revision: '12' }))));
    await client.refresh(); await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(false);
    await client.refresh();
    expect(client.effective(true)).toMatchObject({ enrichmentEnabled: true, reason: 'ready' });
  });

  it('plain outages still keep the last healthy state for the healthy TTL (offline is not invalid)', async () => {
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(null, 503)).mockRejectedValue(new Error('offline')));
    await client.refresh(); await client.refresh(); await client.refresh();
    expect(client.getState().reason).toBe('offline');
    expect(client.effective(true).enrichmentEnabled).toBe(true);
  });
});

describe('I6: the last healthy state expires after 24 h by default, configurable', () => {
  it('default is 24 hours', () => { expect(DEFAULT_HEALTHY_TTL_MS).toBe(24 * 3600_000); });

  it('enrichment stops 24 h after the last healthy refresh, not 72 h', async () => {
    clock = Date.parse('2026-10-15T12:00:00Z');
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockRejectedValue(new Error('offline')));
    await client.refresh();
    clock += 24 * 3600_000 - 1000; await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(true);
    clock += 2000; await client.refresh();
    expect(client.effective(true)).toMatchObject({ enrichmentEnabled: false, reason: 'policy_expired', baseTelemetryEnabled: true });
  });

  it('a shorter configured TTL applies and the TTL can never exceed the 72 h protocol maximum', async () => {
    clock = Date.parse('2026-10-15T12:00:00Z');
    const short = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockRejectedValue(new Error('offline')), { healthyTtlMs: 3600_000 });
    await short.refresh(); clock += 3600_000 + 1; await short.refresh();
    expect(short.effective(true).reason).toBe('policy_expired');
    clock = Date.parse('2026-10-15T12:00:00Z');
    const long = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockRejectedValue(new Error('offline')), { healthyTtlMs: 1000 * 3600_000 });
    await long.refresh(); clock += 73 * 3600_000; await long.refresh();
    expect(long.effective(true).enrichmentEnabled).toBe(false);
  });

  it('config accepts healthyTtlHours 1..72 and ignores anything else', () => {
    const base = { portalBaseUrl: 'https://portal.test', localEnabled: true };
    expect(buildInstrumentationConfig({ instrumentation: { ...base, healthyTtlHours: 6 } })?.healthyTtlHours).toBe(6);
    for (const bad of [0, -1, 100, 1.5, 'x', undefined]) expect(buildInstrumentationConfig({ instrumentation: { ...base, healthyTtlHours: bad as never } })?.healthyTtlHours, String(bad)).toBeUndefined();
  });
});

describe('C11 I1: failures are classified by TYPE and PHASE, never by message text', () => {
  beforeEach(() => { clock = Date.parse('2026-10-15T12:00:00Z'); }); // earlier tests advance the shared clock
  const streamed = (chunks: Array<string | Error>, status = 200) => {
    const encoder = new TextEncoder();
    let i = 0;
    const body = { getReader: () => ({ read: async () => { const next = chunks[i++]; if (next === undefined) return { done: true, value: undefined }; if (next instanceof Error) throw next; return { done: false, value: encoder.encode(next) }; },
      cancel: async () => undefined, releaseLock: () => undefined }) };
    return { status, ok: status === 200, headers: new Headers({ ETag: '"x"' }), body } as unknown as Response;
  };

  it.each(['fetchBudgetMs', 'offlineGraceMs', 'timeoutPolicy', 'abortOnError', 'networkFetchTimeout', 'offline', 'abort'])(
    'an unknown field named %s after a 200 is invalid_policy and turns enrichment off (message words must not matter)', async (key) => {
      const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', [key]: 1 }))));
      await client.refresh(); await client.refresh();
      expect(client.getState().reason).toBe('invalid_policy');
      expect(client.effective(true)).toMatchObject({ enrichmentEnabled: false, reason: 'invalid_policy' });
    });

  it('a valid kill switch that also carries such a field is not delayed: enrichment is off on the same refresh', async () => {
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', killSwitch: true, timeoutPolicy: 'x' }))));
    await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(true);
    await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(false);
  });

  it('invalid followed by a network outage, a 5xx or a 304-less failure does NOT re-enable the old policy', async () => {
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', bad: 1 })))
      .mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(reply(null, 503)).mockRejectedValue(new Error('offline')));
    await client.refresh(); await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      await client.refresh();
      expect(client.effective(true), `after failure ${i + 1}`).toMatchObject({ enrichmentEnabled: false, reason: 'invalid_policy' });
    }
  });

  it('only a valid policy (or a 304 on the valid etag) ends the invalid state', async () => {
    const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', bad: 1 })))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply(policy({ revision: '12' }))));
    await client.refresh(); await client.refresh(); await client.refresh();
    expect(client.effective(true).enrichmentEnabled).toBe(false);
    await client.refresh();
    expect(client.effective(true)).toMatchObject({ enrichmentEnabled: true, reason: 'ready' });
    const reverted = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockResolvedValueOnce(reply(policy({ revision: '11', bad: 1 }))).mockResolvedValueOnce(reply(null, 304)));
    await reverted.refresh(); await reverted.refresh();
    expect(reverted.effective(true).enrichmentEnabled).toBe(false);
    await reverted.refresh(); // the server serves the last valid policy again
    expect(reverted.effective(true).enrichmentEnabled).toBe(true);
  });

  it('network phase: a failing fetch, an aborted read of the body and a 5xx are offline (state kept), never invalid', async () => {
    for (const second of [() => Promise.reject(new TypeError('anything')), () => Promise.reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })),
      () => Promise.resolve(streamed(['{"policyId":', new Error('socket hang up')])), () => Promise.resolve(reply(null, 502))]) {
      const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockImplementationOnce(second));
      await client.refresh(); await client.refresh();
      expect(client.getState().reason).toBe('offline');
      expect(client.effective(true).enrichmentEnabled).toBe(true);
    }
  });

  it('body phase after a 200: unparseable JSON, an oversized body and a wrong shape are invalid_policy', async () => {
    const big = 'x'.repeat(70 * 1024);
    for (const second of [() => Promise.resolve(streamed(['{not json'])), () => Promise.resolve(streamed([big])), () => Promise.resolve(streamed(['[]'])),
      () => Promise.resolve(({ status: 200, ok: true, headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token'); } }) as unknown as Response)]) {
      const client = make(vi.fn().mockResolvedValueOnce(reply(policy())).mockImplementationOnce(second));
      await client.refresh(); await client.refresh();
      expect(client.getState().reason).toBe('invalid_policy');
      expect(client.effective(true).enrichmentEnabled).toBe(false);
    }
  });
});
