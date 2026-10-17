import { describe, expect, it, vi } from 'vitest';
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
