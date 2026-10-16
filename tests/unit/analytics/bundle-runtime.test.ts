import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { canonicalManifestBytes } from '../../../src/deployment/manifest-signature.js';
import { AnalyticsBundleStore } from '../../../src/updater/analytics-bundle-store.js';
import { createCollectorPolicyRuntime, createUpdaterAnalyticsOptions } from '../../../src/analytics/bundle-runtime.js';

const pair = generateKeyPairSync('ed25519');
const trustedKeys = { schemaVersion: 1 as const, revision: 1, keys: { fixture: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() } };
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
let dir: string;
let desired = '1.0.0';
let killSwitch = false;
let revision = 1; // the client refuses a changed policy under a reused revision
const policyBody = () => ({ policyId: 'p', revision: String(revision), desiredBundleVersion: desired, enabled: true, killSwitch, deviceId: 'dev', cohortId: null, reasons: [],
  deletionRevision: '1', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  limits: { reconcileIntervalMs: 60000, hookTargetP95Ms: 100, workerTimeoutMs: 2000, maxMetadataFiles: 100, maxSnippetBytes: 65536, maxReportBytes: 2097152 } });
const config = () => ({ dataDir: dir, instrumentation: { localEnabled: true, portalBaseUrl: 'https://portal.test', deviceId: 'dev', authorization: 'Bearer fixture' } });

async function bundle(version: string) {
  const src = path.join(dir, 'src-' + version); await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, 'worker.mjs'), 'export const v=' + JSON.stringify(version));
  const archive = path.join(dir, version + '.tgz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', src, 'worker.mjs']);
  const payload = { schemaVersion: 1, protocolVersion: 1, keyId: 'fixture', version, collectorRange: '>=1.0.0 <2.0.0', archiveSha256: hash(await fs.readFile(archive)), assets: { 'worker.mjs': hash(await fs.readFile(path.join(src, 'worker.mjs'))) } };
  return { archive, envelope: { payload, signature: sign(null, canonicalManifestBytes(payload), pair.privateKey).toString('base64') } };
}
const install = async (version: string) => {
  const b = await bundle(version);
  await new AnalyticsBundleStore(dir, { collectorVersion: '1.2.0', trustedKeys, authorization: async () => ({ enabled: true, desiredBundle: version, cohort: null }), inspect: async () => true }).install(b.envelope, b.archive);
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-bundle-')); desired = '1.0.0'; killSwitch = false; revision = 1;
  vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, ok: true, headers: new Headers({ ETag: '"x"' }), json: async () => policyBody() }) as Response));
});
afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(dir, { recursive: true, force: true }); });

describe('collector bundle verification (policy x C3 resolver)', () => {
  it('an unverified bundle is never compatible even when the installed collector version equals the desired one', async () => {
    const rt = createCollectorPolicyRuntime(config(), dir, '1.0.0', trustedKeys)!;
    await rt.client.refresh();
    expect(rt.verifier.version()).toBeNull();
    expect(rt.client.effective(true)).toMatchObject({ enrichmentEnabled: false, reason: 'bundle_incompatible' });
  });

  it('a verified, authorized bundle enables enrichment; kill switch and a different desired version withdraw it', async () => {
    await install('1.0.0');
    const rt = createCollectorPolicyRuntime(config(), dir, '1.2.0', trustedKeys)!;
    await rt.client.refresh();
    expect(rt.verifier.version()).toBe('1.0.0');
    expect(rt.client.effective(true)).toMatchObject({ enrichmentEnabled: true, reason: 'ready' });
    desired = '1.1.0'; revision += 1; // old bundle, and the policy lists no rollback bundle: refused
    await rt.client.refresh();
    expect(rt.verifier.version()).toBeNull();
    expect(rt.client.effective(true).reason).toBe('bundle_incompatible');
    desired = '1.0.0'; killSwitch = true; revision += 1;
    await rt.client.refresh();
    expect(rt.verifier.version()).toBeNull();
    expect(rt.client.effective(true).enrichmentEnabled).toBe(false);
  });

  it('a resolver error withdraws the previously verified bundle instead of keeping it', async () => {
    await install('1.0.0');
    const rt = createCollectorPolicyRuntime(config(), dir, '1.2.0', trustedKeys)!;
    await rt.client.refresh();
    expect(rt.verifier.version()).toBe('1.0.0');
    await fs.writeFile(path.join(dir, 'analytics', 'bundle-state.json'), '{corrupt');
    revision += 1;
    await rt.client.refresh();
    expect(rt.verifier.version()).toBeNull();
    expect(rt.client.effective(true).reason).toBe('bundle_incompatible');
  });

  it('is off without a configured portal credential', () => {
    expect(createCollectorPolicyRuntime({ dataDir: dir }, dir, '1.0.0')).toBeUndefined();
  });
});

describe('updater analytics options', () => {
  it('derives authorization from a fresh policy with an explicit empty rollback list', async () => {
    const options = createUpdaterAnalyticsOptions({ instrumentation: config().instrumentation }, dir, '1.2.0', trustedKeys)!;
    expect(await options.authorization()).toEqual({ enabled: true, desiredBundle: '1.0.0', cohort: null, allowedRollbackBundles: [] });
    killSwitch = true; revision += 1;
    expect((await options.authorization()).enabled).toBe(false);
  });

  it('is undefined (feature off, base updater untouched) without instrumentation', () => {
    expect(createUpdaterAnalyticsOptions(null, dir, '1.2.0')).toBeUndefined();
    expect(createUpdaterAnalyticsOptions({ instrumentation: { localEnabled: true, portalBaseUrl: 'https://portal.test' } }, dir, '1.2.0')).toBeUndefined();
  });

  it('installs a candidate only when the collector recorded a validated event, rolling back otherwise', async () => {
    const options = createUpdaterAnalyticsOptions({ instrumentation: config().instrumentation }, dir, '1.2.0', trustedKeys)!;
    const store = new AnalyticsBundleStore(dir, { ...options, inspect: (b, m, signal) => options.inspect(b, m, signal) });
    const b = await bundle('1.0.0');
    // No marker: the inspect deadline passes and the candidate is rolled back, never half-activated.
    const quick = new AnalyticsBundleStore(dir, { ...options, inspect: async (...a) => { const ac = new AbortController(); ac.abort(); return options.inspect(a[0], a[1], ac.signal); } });
    await expect(quick.install(b.envelope, b.archive)).rejects.toThrow();
    expect(await store.resolve()).toBeNull();
    await fs.mkdir(path.join(dir, 'analytics'), { recursive: true });
    await fs.writeFile(path.join(dir, 'analytics', 'validated-event.json'), JSON.stringify({ at: Date.now() - 1000, harnessId: 'claude-code' }));
    await store.install(b.envelope, b.archive);
    expect((await store.resolve())?.version).toBe('1.0.0');
  });
});
