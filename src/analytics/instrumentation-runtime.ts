import type { AnalyticsConfig } from '../types/index.js';
import { buildInstrumentationConfig } from '../core/config-loader.js';
import * as path from 'node:path';
import { readJsonFile, writeTextFileAtomic, resolveHome } from '../utils/fs-utils.js';
import { DesiredPolicyClient } from './desired-policy-client.js';
export type PolicyRuntimeConfig = Pick<AnalyticsConfig, 'instrumentation' | 'otlpTrace' | 'innerTrace' | 'dataDir'>;
type BundleVersionSource = string | null | (() => string | null);

/** Reuse an existing machine key only for the explicitly configured portal origin. */
export function resolveRuntimeAuthorization(config: PolicyRuntimeConfig): string | undefined {
  const instrumentation = buildInstrumentationConfig({ instrumentation: config.instrumentation });
  if (!instrumentation) return undefined;
  if (instrumentation.authorization) return instrumentation.authorization;
  for (const endpoint of [config.otlpTrace, ...(config.innerTrace?.otlp ?? [])]) {
    if (!endpoint?.endpoint) continue;
    try {
      if (new URL(endpoint.endpoint).origin !== instrumentation.portalBaseUrl) continue;
      const value = Object.entries(endpoint.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
      if (value && /^Bearer [^\r\n]+$/.test(value)) return value;
    } catch { /* invalid endpoint is not a credential source */ }
  }
  return undefined;
}

/**
 * `bundleVersion` is the VERIFIED bundle (C3 resolver), read lazily on every evaluation: a pending,
 * rolled-back or unverified bundle must never count as compatible.
 */
export function createRuntimePolicyClient(config: PolicyRuntimeConfig, bundleVersion: BundleVersionSource,
  afterRefresh?: () => Promise<void>): DesiredPolicyClient | undefined {
  const instrumentation = buildInstrumentationConfig({ instrumentation: config.instrumentation });
  const credential = resolveRuntimeAuthorization(config);
  if (!instrumentation || !credential) return undefined;
  const current = () => (typeof bundleVersion === 'function' ? bundleVersion() : bundleVersion);
  return new DesiredPolicyClient({ baseUrl: instrumentation.portalBaseUrl, deviceId: instrumentation.deviceId,
    authorization: () => credential, bundleCompatible: desired => current() !== null && desired === current(),
    ...(afterRefresh ? { afterRefresh } : {}),
    ...(instrumentation.healthyTtlHours ? { healthyTtlMs: instrumentation.healthyTtlHours * 3600_000 } : {}),
    ...(config.dataDir ? { cache: { load: () => readJsonFile(path.join(resolveHome(config.dataDir), 'analytics-policy.json')),
      save: (state: import('./desired-policy-client.js').PolicyCache) => writeTextFileAtomic(path.join(resolveHome(config.dataDir), 'analytics-policy.json'), JSON.stringify(state) + '\n', { mode: 0o600 }) } } : {}) });
}
