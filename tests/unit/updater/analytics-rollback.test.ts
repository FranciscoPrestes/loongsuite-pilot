import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Updater } from '../../../src/updater/updater.js';
import { canonicalManifestBytes, verifySignedManifest } from '../../../src/deployment/manifest-signature.js';
const pair = generateKeyPairSync('ed25519');
const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
let root: string;
let enabled = true;
let healthy = true;
let desired = '1.0.0';
const options = () => ({ collectorVersion: '1.2.0', trustedKeys: { schemaVersion: 1 as const, revision: 1, keys: { fixture: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() } }, authorization: async () => ({ enabled, desiredBundle: desired, cohort: 'test' }), inspect: async () => healthy });
const updater = () => new Updater({ enabled: true, checkIntervalMs: 60000, manifestUrl: 'https://invalid.test/latest' }, root, options());
async function fixture(version: string) {
  const dir = path.join(root, 'fixture-' + version); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'worker.mjs'), 'export const version=' + JSON.stringify(version));
  const archive = path.join(root, version + '.tgz');
  await promisify(execFile)('tar', ['-czf', archive, '-C', dir, 'worker.mjs']);
  const payload = { schemaVersion: 1, protocolVersion: 1, keyId: 'fixture', version, collectorRange: '>=1.0.0 <2.0.0', archiveSha256: hash(await fs.readFile(archive)), assets: { 'worker.mjs': hash(await fs.readFile(path.join(dir, 'worker.mjs'))) } };
  const bytes = canonicalManifestBytes(payload);
  return { archive, envelope: { payload, signature: sign(null, bytes, pair.privateKey).toString('base64') } };
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'analytics-c3-')); enabled = healthy = true; desired = '1.0.0'; });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });
describe('analytics updater transaction', () => {
  it('rollback_preserves_queue_and_user_hooks', async () => {
    const first = await fixture('1.0.0'); const next = await fixture('1.1.0'); const instance = updater();
    await instance.installAnalyticsBundle(first.envelope, first.archive);
    await fs.writeFile(path.join(root, 'queue.jsonl'), 'pending-event');
    await fs.writeFile(path.join(root, 'user-hooks.json'), '{"mine":true}');
    const queueBefore = await fs.readFile(path.join(root, 'queue.jsonl'));
    desired = '1.1.0'; healthy = false;
    await expect(instance.installAnalyticsBundle(next.envelope, next.archive)).rejects.toThrow();
    desired = '1.0.0'; healthy = true;
    const restarted = updater();
    const activeVersion = (await restarted.resolveAnalyticsBundle())?.version;
    const previousVersion = '1.0.0';
    expect(activeVersion).toBe(previousVersion);
    const queueAfter = await fs.readFile(path.join(root, 'queue.jsonl'));
    expect(queueAfter).toEqual(queueBefore);
    expect(await fs.readFile(path.join(root, 'user-hooks.json'), 'utf8')).toBe('{"mine":true}');
  });
  it('rejects archive tampering and unsigned envelopes without activation', async () => {
    const f = await fixture('1.0.0'); await fs.appendFile(f.archive, 'tamper');
    await expect(updater().installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow();
    await expect(updater().installAnalyticsBundle({ ...f.envelope, signature: '' }, f.archive)).rejects.toThrow();
    expect(await updater().resolveAnalyticsBundle()).toBeNull();
  });
  it('honors opt out at activation and consumption', async () => {
    const f = await fixture('1.0.0'); const instance = updater();
    await instance.installAnalyticsBundle(f.envelope, f.archive); enabled = false;
    expect(await instance.resolveAnalyticsBundle()).toBeNull();
    await expect(instance.installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow();
  });
  it('reverifies active assets and trusted keys after restart', async () => {
    const f = await fixture('1.0.0'); const instance = updater(); await instance.installAnalyticsBundle(f.envelope, f.archive);
    const active = await instance.resolveAnalyticsBundle();
    await fs.writeFile(active!.assets['worker.mjs'], 'tampered');
    await expect(updater().resolveAnalyticsBundle()).rejects.toThrow();
  });
  it('local signing pipeline produces verifiable bytes and rejects modification', async () => {
    const f = await fixture('1.0.0');
    const payload = path.join(root, 'payload.json'); const privateKey = path.join(root, 'fixture-key.pem'); const output = path.join(root, 'signed.json');
    await fs.writeFile(payload, JSON.stringify(f.envelope.payload));
    await fs.writeFile(privateKey, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    await promisify(execFile)(process.execPath, [path.resolve('scripts/sign-analytics-manifest.mjs'), payload, privateKey, output]);
    const signed = JSON.parse(await fs.readFile(output, 'utf8'));
    const keys = new Map(Object.entries(options().trustedKeys.keys));
    expect(verifySignedManifest(canonicalManifestBytes(signed.payload), Buffer.from(signed.signature, 'base64'), 'fixture', keys)).toBe(true);
    expect(verifySignedManifest(canonicalManifestBytes({ ...signed.payload, version: '9.0.0' }), Buffer.from(signed.signature, 'base64'), 'fixture', keys)).toBe(false);
    expect(await fs.readFile(output, 'utf8')).not.toContain('PRIVATE KEY');
  });
  it('crash recovery restores both current and previous and revalidates last good', async () => {
    const first = await fixture('1.0.0'); await updater().installAnalyticsBundle(first.envelope, first.archive);
    const second = await fixture('1.1.0'); desired = '1.1.0'; await updater().installAnalyticsBundle(second.envelope, second.archive);
    const stateFile = path.join(root, 'analytics', 'bundle-state.json');
    const before = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    const interrupted = { ...before, current: '1.2.0_00000000-0000-0000-0000-000000000000', previous: before.current, pending: true, rollback: before };
    await fs.writeFile(stateFile, JSON.stringify(interrupted));
    expect((await updater().resolveAnalyticsBundle())?.version).toBe('1.1.0');
    expect(JSON.parse(await fs.readFile(stateFile, 'utf8'))).toEqual(before);
  });
  it('concurrent updater cannot expose or revert candidate awaiting evidence', async () => {
    const f = await fixture('1.0.0'); let release!: () => void;
    let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    const instance = new Updater({ enabled: true, checkIntervalMs: 60000, manifestUrl: 'https://invalid.test/latest' }, root, { ...options(), inspect: async () => { entered(); await new Promise<void>(r => { release = r; }); return true; } });
    const installing = instance.installAnalyticsBundle(f.envelope, f.archive); await ready;
    try { await expect(updater().resolveAnalyticsBundle()).rejects.toThrow(/busy/); }
    finally { release(); await installing; }
    expect((await updater().resolveAnalyticsBundle())?.version).toBe('1.0.0');
  });
  it('opt out while checking evidence restores pointers and keeps consumption disabled', async () => {
    const f = await fixture('1.0.0');
    const instance = new Updater({ enabled: true, checkIntervalMs: 60000, manifestUrl: 'https://invalid.test/latest' }, root, { ...options(), inspect: async () => { enabled = false; return true; } });
    await expect(instance.installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow();
    expect(await instance.resolveAnalyticsBundle()).toBeNull();
    expect(JSON.parse(await fs.readFile(path.join(root, 'analytics', 'bundle-state.json'), 'utf8')).current).toBeNull();
  });

  it('rejects oversized inflated assets before writing them', async () => {
    const f = await fixture('1.0.0');
    const dir = path.join(root, 'large'); await fs.mkdir(dir);
    const large = Buffer.alloc(3 * 1024 * 1024, 'a'); await fs.writeFile(path.join(dir, 'worker.mjs'), large);
    await promisify(execFile)('tar', ['-czf', f.archive, '-C', dir, 'worker.mjs']);
    f.envelope.payload.assets['worker.mjs'] = hash(large); f.envelope.payload.archiveSha256 = hash(await fs.readFile(f.archive));
    f.envelope.signature = sign(null, canonicalManifestBytes(f.envelope.payload), pair.privateKey).toString('base64');
    await expect(updater().installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow();
    expect(await updater().resolveAnalyticsBundle()).toBeNull();
  });

  it('existing updater check routes signed analytics and leaves collector pointers alone', async () => {
    const f = await fixture('1.0.0'); const archive = await fs.readFile(f.archive);
    await fs.writeFile(path.join(root, 'current'), 'collector-old');
    const release = { version: '1.0.0', git_commit: 'fixture', package_url: 'https://invalid.test/bundle', sha256: f.envelope.payload.archiveSha256, analyticsBundle: f.envelope };
    vi.stubGlobal('fetch', async (url: string) => url.endsWith('latest') ? new Response(JSON.stringify(release), { headers: { 'Content-Type': 'application/json' } }) : new Response(archive));
    const instance = new Updater({ enabled: true, checkIntervalMs: 60000, installId: 'fixture-id', manifestUrl: 'https://invalid.test/latest' }, root, options());
    await instance.check();
    expect((await instance.resolveAnalyticsBundle())?.version).toBe('1.0.0');
    const before = await fs.readFile(path.join(root, 'analytics', 'bundle-state.json'), 'utf8');
    await instance.check();
    expect(await fs.readFile(path.join(root, 'analytics', 'bundle-state.json'), 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(root, 'current'), 'utf8')).toBe('collector-old');
  });
  it('trusted local key overlap survives rotation but removed key stops resolution', async () => {
    const f = await fixture('1.0.0'); const instance = new Updater({ enabled: true, checkIntervalMs: 60000 }, root, { ...options(), trustedKeys: undefined });
    await fs.mkdir(path.join(root, 'analytics'));
    const keysFile = path.join(root, 'analytics', 'trusted-keys.json');
    await expect(instance.installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow();
    await fs.writeFile(keysFile, JSON.stringify(options().trustedKeys));
    await instance.installAnalyticsBundle(f.envelope, f.archive);
    await fs.writeFile(keysFile, JSON.stringify({ schemaVersion: 1, revision: 2, keys: {} }));
    await expect(instance.resolveAnalyticsBundle()).rejects.toThrow();
  });
  it('rejects archive symlinks before any external target is touched', async () => {
    const f = await fixture('1.0.0'); const dir = path.join(root, 'symlink'); await fs.mkdir(dir);
    const external = path.join(root, 'outside'); await fs.writeFile(external, 'keep');
    await fs.symlink(external, path.join(dir, 'worker.mjs'));
    await promisify(execFile)('tar', ['-czf', f.archive, '-C', dir, 'worker.mjs']);
    f.envelope.payload.archiveSha256 = hash(await fs.readFile(f.archive));
    f.envelope.signature = sign(null, canonicalManifestBytes(f.envelope.payload), pair.privateKey).toString('base64');
    await expect(updater().installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow();
    expect(await fs.readFile(external, 'utf8')).toBe('keep');
  });

  it('times out missing instrumentation evidence and rolls back', async () => {
    const f = await fixture('1.0.0'); let signal: AbortSignal | undefined;
    const instance = new Updater({ enabled: true, checkIntervalMs: 60000 }, root, { ...options(), inspect: async (_bundle, _manifest, abort) => { signal = abort; return new Promise<boolean>(() => {}); } });
    await expect(instance.installAnalyticsBundle(f.envelope, f.archive)).rejects.toThrow(/timed out/);
    expect(signal?.aborted).toBe(true);
    expect(await instance.resolveAnalyticsBundle()).toBeNull();
  });

  it('accepts stable all-device policy without a cohort ID', async () => {
    const f = await fixture('1.0.0');
    const instance = new Updater({ enabled: true, checkIntervalMs: 60000 }, root, { ...options(), authorization: async () => ({ enabled: true, desiredBundle: '1.0.0', cohort: null }) });
    await instance.installAnalyticsBundle(f.envelope, f.archive);
    expect((await instance.resolveAnalyticsBundle())?.version).toBe('1.0.0');
  });

});
