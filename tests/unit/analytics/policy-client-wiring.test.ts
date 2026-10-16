import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DesiredPolicyClient } from '../../../src/analytics/desired-policy-client.js';

const fixture = JSON.parse(readFileSync('tests/fixtures/analytics/instrumentation-policy-v1.json', 'utf8'));
const now = Date.parse('2026-10-15T12:00:00Z');
const ok = (body: unknown) => ({ status: 200, ok: true, headers: new Headers({ ETag: '"1"' }), json: async () => body }) as Response;
const client = (extra = {}, body: unknown = fixture) => new DesiredPolicyClient({
  baseUrl: 'https://portal.test', deviceId: 'fixture-device', authorization: () => 'Bearer fixture', fetch: vi.fn().mockResolvedValue(ok(body)), now: () => now, ...extra });

describe('policy client wiring for the bundle resolver', () => {
  it('unwraps the portal envelope', async () => {
    const c = client({}, { success: true, data: fixture, error: null });
    await c.refresh();
    expect(c.getState().policy?.policyId).toBe('fixture-policy');
  });

  it('activation derives from raw policy state, never from the bundle check, and lists no rollback', async () => {
    const c = client({ bundleCompatible: () => { throw new Error('must not be consulted (resolve() would cycle)'); } });
    await c.refresh();
    expect(c.activation(true)).toEqual({ enabled: true, desiredBundle: '1.2.0', cohort: null, allowedRollbackBundles: [] });
    expect(c.activation(false).enabled).toBe(false); // local disable wins
  });

  it('activation is disabled without a policy, after a kill switch, and when unauthorized', async () => {
    expect(client().activation(true)).toMatchObject({ enabled: false, allowedRollbackBundles: [] });
    const killed = client({}, { ...fixture, revision: '11', killSwitch: true });
    await killed.refresh();
    expect(killed.activation(true).enabled).toBe(false);
  });

  it('afterRefresh runs after each attempt and its failure never changes the policy', async () => {
    const after = vi.fn().mockRejectedValue(new Error('verifier down'));
    const c = client({ afterRefresh: after });
    await c.refresh();
    expect(after).toHaveBeenCalledTimes(1);
    expect(c.getState().reason).toBe('ready');
  });

  it('effective still pauses on an incompatible bundle', async () => {
    const c = client({ bundleCompatible: () => false });
    await c.refresh();
    expect(c.effective(true)).toMatchObject({ enrichmentEnabled: false, reason: 'bundle_incompatible' });
  });
});
