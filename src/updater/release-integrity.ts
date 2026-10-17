import type { AutoUpdateConfig } from '../types/index.js';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalManifestBytes, trustedKeyMap, type TrustedAnalyticsKeys } from '../deployment/manifest-signature.js';

/**
 * Release integrity for the main collector update (package_url is manifest-controlled and its postinstall
 * runs code on every machine, so the manifest cannot be trusted by origin alone).
 *
 *  - `warn` (default): problems are logged, the update proceeds as before (compatible with a server that does
 *    not yet publish sha256/signature).
 *  - `enforce`: any problem refuses the update BEFORE downloading anything.
 *
 * Checks: sha256 present and well-formed, https-only without credentials, exact host allow-list, and an Ed25519
 * signature over {version, git_commit, package_url, sha256} verified with a provisioned key. With no key
 * provisioned, `enforce` fails closed (`no_trusted_key`): turning it on is the owner's gate.
 */
export type IntegrityProblem = 'sha256_missing' | 'sha256_malformed' | 'package_url_not_https' | 'package_host_not_allowed'
  | 'signature_missing' | 'signature_invalid' | 'no_trusted_key';

export interface ReleaseDescriptor {
  version: string; git_commit: string; package_url: string; sha256?: string;
  signature?: string; signatureKeyId?: string;
}
export interface IntegrityPolicy { mode: 'warn' | 'enforce'; allowedHosts: string[]; trustedKeys?: TrustedAnalyticsKeys }

const NTC_BLOB_HOST = 'stntconsultpilot.blob.core.windows.net';
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export function canonicalReleaseBytes(release: Pick<ReleaseDescriptor, 'version' | 'git_commit' | 'package_url' | 'sha256'>): Buffer {
  // Domain-separated: a signature made for an analytics manifest can never validate as a release.
  return Buffer.concat([Buffer.from('ntconsult-release-v1\n', 'utf8'),
    canonicalManifestBytes({ version: release.version, git_commit: release.git_commit, package_url: release.package_url, sha256: release.sha256 ?? '' })]);
}

export function resolveIntegrityPolicy(config: AutoUpdateConfig): IntegrityPolicy {
  const raw = config.integrity;
  const mode = raw && typeof raw === 'object' && raw.mode === 'enforce' ? 'enforce' : 'warn';
  const hosts = new Set<string>([NTC_BLOB_HOST]);
  try { if (config.manifestUrl) hosts.add(new URL(config.manifestUrl).hostname.toLowerCase()); } catch { /* invalid manifest URL adds nothing */ }
  for (const host of Array.isArray(raw?.allowedHosts) ? raw.allowedHosts.slice(0, 20) : []) {
    if (typeof host === 'string' && HOST.test(host.trim().toLowerCase())) hosts.add(host.trim().toLowerCase());
  }
  return { mode, allowedHosts: [...hosts] };
}

export function assessRelease(release: ReleaseDescriptor, packageUrl: string, policy: IntegrityPolicy): IntegrityProblem[] {
  const problems: IntegrityProblem[] = [];
  if (!release.sha256) problems.push('sha256_missing');
  else if (!/^[0-9a-f]{64}$/i.test(release.sha256)) problems.push('sha256_malformed');

  let url: URL | null = null;
  try { url = new URL(packageUrl); } catch { /* handled below */ }
  if (!url || url.protocol !== 'https:' || url.username || url.password) problems.push('package_url_not_https');
  else if (!policy.allowedHosts.includes(url.hostname.toLowerCase())) problems.push('package_host_not_allowed');

  const keys = trustedKeyMap(policy.trustedKeys ?? { schemaVersion: 1, revision: 1, keys: {} });
  if (keys.size === 0) problems.push('no_trusted_key');
  else if (!release.signature || !release.signatureKeyId) problems.push('signature_missing');
  else {
    let valid = false;
    try {
      const pem = keys.get(release.signatureKeyId);
      const signature = Buffer.from(release.signature, 'base64');
      valid = pem !== undefined && signature.length === 64 && verify(null, canonicalReleaseBytes({ ...release, package_url: packageUrl }), createPublicKey(pem), signature);
    } catch { valid = false; }
    if (!valid) problems.push('signature_invalid');
  }
  return problems;
}
