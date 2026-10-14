import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonicalManifestBytes, verifySignedManifest, validateAnalyticsManifest, trustedKeyMap, versionSatisfies } from '../../../src/deployment/manifest-signature.js';
const key = generateKeyPairSync('ed25519');
const next = generateKeyPairSync('ed25519');
const pem = (k: typeof key) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const manifest = { schemaVersion: 1, protocolVersion: 1, version: '1.1.0', collectorRange: '>=1.0.0 <2.0.0', keyId: 'old', archiveSha256: 'a'.repeat(64), assets: { 'worker.mjs': createHash('sha256').update('ok').digest('hex') } };
describe('signed analytics manifests', () => {
  it('tampered_bundle_rejected', () => {
    const bytes = canonicalManifestBytes(manifest); const signature = sign(null, bytes, key.privateKey);
    const tampered = canonicalManifestBytes({ ...manifest, version: '9.0.0' });
    expect(verifySignedManifest(tampered, signature, 'old', new Map([['old', pem(key)]]))).toBe(false);
  });
  it('unknown_key_rejected', () => {
    const bytes = canonicalManifestBytes(manifest);
    expect(verifySignedManifest(bytes, sign(null, bytes, key.privateKey), 'unknown', new Map([['old', pem(key)]]))).toBe(false);
  });
  it('rotation_overlap_accepted', () => {
    const keys = trustedKeyMap({ schemaVersion: 1, revision: 2, keys: { old: pem(key), next: pem(next) } });
    for (const [id, pair] of [['old', key], ['next', next]] as const) {
      const bytes = canonicalManifestBytes({ ...manifest, keyId: id });
      expect(verifySignedManifest(bytes, sign(null, bytes, pair.privateKey), id, keys)).toBe(true);
    }
  });
  it('rejects noncanonical bytes and key ID substitution', () => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    expect(verifySignedManifest(bytes, sign(null, bytes, key.privateKey), 'old', new Map([['old', pem(key)]]))).toBe(false);
    const canonical = canonicalManifestBytes(manifest);
    expect(verifySignedManifest(canonical, sign(null, canonical, key.privateKey), 'next', new Map([['next', pem(key)]]))).toBe(false);
  });
  it('signed_incompatible_manifest_rejected', () => {
    expect(() => validateAnalyticsManifest(manifest, '2.0.0')).toThrow();
    expect(() => validateAnalyticsManifest({ ...manifest, protocolVersion: 2 }, '1.2.0')).toThrow();
    expect(() => validateAnalyticsManifest({ ...manifest, assets: { '../queue': 'a'.repeat(64) } }, '1.2.0')).toThrow();
    expect(() => validateAnalyticsManifest({ ...manifest, archiveSha256: '' }, '1.2.0')).toThrow();
    expect(validateAnalyticsManifest(manifest, '1.2.0').version).toBe('1.1.0');
  });
  it('fails closed on unknown range syntax and prereleases', () => {
    expect(versionSatisfies('1.2.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(versionSatisfies('1.2.0', '*')).toBe(false);
    expect(versionSatisfies('1.2.0-beta', '>=1.0.0')).toBe(false);
    expect(() => trustedKeyMap({ schemaVersion: 2, revision: 1, keys: {} })).toThrow();
  });
});
