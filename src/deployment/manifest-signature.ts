import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { compareVersions } from '../updater/version-utils.js';

// Version 1 canonical JSON: recursively sorted UTF-16 object keys, JSON strings,
// finite numbers, no whitespace, UTF-8 (no BOM). Arrays retain their order.
export function canonicalManifestBytes(value: unknown): Buffer {
  function canonical(v: unknown): string {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (typeof v === 'object' && v && Object.getPrototypeOf(v) === Object.prototype) {
      return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
    }
    throw new Error('Unsupported canonical JSON value');
  }
  return Buffer.from(canonical(value), 'utf8');
}
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-ntc\.\d+)?$/).max(80);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const assetName = z.string().max(240).refine(v => /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(v) && v.split('/').every(p => p !== '.' && p !== '..') && !['manifest.json', 'archive.tgz'].includes(v));
const manifestSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), version,
  collectorRange: z.string().min(1).max(240), keyId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  archiveSha256: digest, assets: z.record(assetName, digest).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 100),
}).strict();
export type AnalyticsManifest = z.infer<typeof manifestSchema>;
export interface SignedAnalyticsManifest { payload: AnalyticsManifest; signature: string }
export interface TrustedAnalyticsKeys { schemaVersion: 1; revision: number; keys: Record<string, string> }
// Release keys are provisioned by trusted local administration, never by a bundle.
// An empty packaged default disables installation until keys are provisioned.
export const DEFAULT_ANALYTICS_KEYS: TrustedAnalyticsKeys = { schemaVersion: 1, revision: 1, keys: {} };
export function trustedKeyMap(value: unknown): ReadonlyMap<string, string> {
  const parsed = z.object({ schemaVersion: z.literal(1), revision: z.number().int().positive(), keys: z.record(z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), z.string().max(4096)) }).strict().parse(value);
  for (const pem of Object.values(parsed.keys)) if (createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 public key required');
  return new Map(Object.entries(parsed.keys));
}
/** Deliberately bounded range grammar: exact or space-separated < <= > >= = comparators. */
export function versionSatisfies(installed: string, range: string): boolean {
  if (!version.safeParse(installed).success || !range.trim()) return false;
  return range.trim().split(/\s+/).every(part => {
    const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-ntc\.\d+)?)$/.exec(part);
    if (!m) return false;
    const cmp = compareVersions(installed, m[2]);
    return m[1] === '>=' ? cmp >= 0 : m[1] === '<=' ? cmp <= 0 : m[1] === '>' ? cmp > 0 : m[1] === '<' ? cmp < 0 : cmp === 0;
  });
}
export function validateAnalyticsManifest(value: unknown, collectorVersion: string): AnalyticsManifest {
  const manifest = manifestSchema.parse(value);
  if (!versionSatisfies(collectorVersion, manifest.collectorRange)) throw new Error('Incompatible collector version');
  return manifest;
}
export function verifySignedManifest(bytes: Uint8Array, signature: Uint8Array, keyId: string, trustedKeys: ReadonlyMap<string, string>): boolean {
  try {
    if (bytes.length > 65536 || signature.length !== 64) return false;
    const pem = trustedKeys.get(keyId);
    if (!pem) return false;
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    const parsed = manifestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (parsed.keyId !== keyId || !Buffer.from(bytes).equals(canonicalManifestBytes(parsed))) return false;
    return verify(null, bytes, key, signature);
  } catch { return false; }
}
