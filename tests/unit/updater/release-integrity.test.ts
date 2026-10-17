import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalManifestBytes } from '../../../src/deployment/manifest-signature.js';
import { assessRelease, canonicalReleaseBytes, resolveIntegrityPolicy, type ReleaseDescriptor } from '../../../src/updater/release-integrity.js';
import { buildAutoUpdateConfig } from '../../../src/core/config-loader.js';

const pair = generateKeyPairSync('ed25519');
const keys = { schemaVersion: 1 as const, revision: 1, keys: { owner: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString() } };
const sha = 'a'.repeat(64);
const base = (over: Partial<ReleaseDescriptor> = {}): ReleaseDescriptor => ({ version: '1.2.3', git_commit: 'abc', package_url: 'https://blob.example.com/pilot/releases/1.2.3/pkg.tgz', sha256: sha, ...over });
const signed = (release: ReleaseDescriptor, keyId = 'owner'): ReleaseDescriptor =>
  ({ ...release, signatureKeyId: keyId, signature: sign(null, canonicalReleaseBytes(release), pair.privateKey).toString('base64') });
const policy = (over = {}) => ({ mode: 'enforce' as const, allowedHosts: ['blob.example.com'], trustedKeys: keys, ...over });
const problems = (release: ReleaseDescriptor, p = policy()) => assessRelease(release, release.package_url, p);

describe('release integrity assessment', () => {
  it('a signed, https, allow-listed release with a sha256 has no problem', () => {
    expect(problems(signed(base()))).toEqual([]);
  });

  it.each([
    ['sha256 missing', base({ sha256: undefined }), 'sha256_missing'],
    ['sha256 malformed', base({ sha256: 'xyz' }), 'sha256_malformed'],
    ['sha256 too short', base({ sha256: 'a'.repeat(63) }), 'sha256_malformed'],
  ])('%s', (_name, release, code) => { expect(problems(signed(release))).toContain(code); });

  it.each([
    ['http', 'http://blob.example.com/pilot/pkg.tgz'],
    ['file', 'file:///tmp/pkg.tgz'],
    ['ftp', 'ftp://blob.example.com/pkg.tgz'],
    ['credentials in the url', 'https://user:pw@blob.example.com/pkg.tgz'],
    ['garbage', 'not a url'],
    ['relative', '/releases/pkg.tgz'],
  ])('rejects a %s package_url', (_name, url) => {
    expect(problems(signed(base({ package_url: url })))).toContain('package_url_not_https');
  });

  it('rejects a host that is not on the allow-list (including look-alikes) and accepts an exact match', () => {
    expect(problems(signed(base({ package_url: 'https://evil.example.net/pkg.tgz' })))).toContain('package_host_not_allowed');
    expect(problems(signed(base({ package_url: 'https://blob.example.com.evil.net/pkg.tgz' })))).toContain('package_host_not_allowed');
    expect(problems(signed(base({ package_url: 'https://BLOB.example.com/pkg.tgz' })))).toEqual([]);
  });

  it('requires a valid signature over version, commit, url and sha256', () => {
    expect(problems(base())).toContain('signature_missing');
    const good = signed(base());
    expect(problems({ ...good, sha256: 'b'.repeat(64) })).toContain('signature_invalid');
    expect(problems({ ...good, package_url: 'https://blob.example.com/pilot/other.tgz' })).toContain('signature_invalid');
    expect(problems({ ...good, version: '9.9.9' })).toContain('signature_invalid');
    expect(problems({ ...good, git_commit: 'zzz' })).toContain('signature_invalid');
    expect(problems({ ...good, signature: 'AAAA' })).toContain('signature_invalid');
    expect(problems(signed(base(), 'unknown-key'))).toContain('signature_invalid');
  });

  it('is domain separated: a signature over the bare canonical fields (any other protocol) is not a release signature', () => {
    const release = base();
    const bare = sign(null, canonicalManifestBytes({ version: release.version, git_commit: release.git_commit, package_url: release.package_url, sha256: release.sha256 }), pair.privateKey).toString('base64');
    expect(problems({ ...release, signatureKeyId: 'owner', signature: bare })).toContain('signature_invalid');
  });

  it('fails closed when no trusted key is provisioned (owner gate), never "valid by default"', () => {
    const empty = { schemaVersion: 1 as const, revision: 1, keys: {} };
    expect(problems(signed(base()), policy({ trustedKeys: empty }))).toContain('no_trusted_key');
  });

  it('reports every problem at once', () => {
    const found = problems(base({ sha256: undefined, package_url: 'http://evil.net/x.tgz' }));
    expect(found).toEqual(expect.arrayContaining(['sha256_missing', 'package_url_not_https', 'signature_missing']));
  });
});

describe('integrity policy resolution', () => {
  it('defaults to warn, with the manifest host and the NTConsult blob host allowed', () => {
    const resolved = resolveIntegrityPolicy({ enabled: true, checkIntervalMs: 1, manifestUrl: 'https://mirror.example.org/latest.json' });
    expect(resolved.mode).toBe('warn');
    expect(resolved.allowedHosts).toEqual(expect.arrayContaining(['mirror.example.org', 'stntconsultpilot.blob.core.windows.net']));
  });

  it('enforce comes only from an explicit, valid setting; anything else stays warn', () => {
    const cfg = (integrity: unknown) => resolveIntegrityPolicy({ enabled: true, checkIntervalMs: 1, integrity: integrity as never });
    expect(cfg({ mode: 'enforce' }).mode).toBe('enforce');
    for (const bad of [{ mode: 'ENFORCE' }, { mode: 'strict' }, { mode: true }, {}, undefined, 'enforce']) expect(cfg(bad).mode, JSON.stringify(bad)).toBe('warn');
  });

  it('extra allowed hosts are normalized and bounded', () => {
    const resolved = resolveIntegrityPolicy({ enabled: true, checkIntervalMs: 1, integrity: { mode: 'warn', allowedHosts: ['CDN.Example.com', 'bad host', '', 5 as never] } });
    expect(resolved.allowedHosts).toContain('cdn.example.com');
    expect(resolved.allowedHosts).not.toContain('bad host');
  });

  it('config loader reads the mode from the file and the environment, default warn', () => {
    expect(buildAutoUpdateConfig(null).integrity?.mode ?? 'warn').toBe('warn');
    expect(buildAutoUpdateConfig({ autoUpdate: { integrity: { mode: 'enforce', allowedHosts: ['a.example.com'] } } } as never).integrity).toEqual({ mode: 'enforce', allowedHosts: ['a.example.com'] });
    expect(buildAutoUpdateConfig({ autoUpdate: { integrity: { mode: 'nonsense' } } } as never).integrity?.mode ?? 'warn').toBe('warn');
  });
});
