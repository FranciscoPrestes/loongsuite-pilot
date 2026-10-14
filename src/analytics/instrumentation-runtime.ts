import type { AnalyticsConfig } from '../types/index.js';
import { buildInstrumentationConfig } from '../core/config-loader.js';
import * as path from 'node:path';
import { readJsonFile, writeTextFileAtomic, resolveHome } from '../utils/fs-utils.js';
import { DesiredPolicyClient } from './desired-policy-client.js';
/** Reuse an existing machine key only for the explicitly configured portal origin. */
export function createRuntimePolicyClient(config: AnalyticsConfig, installedBundleVersion: string | null): DesiredPolicyClient | undefined {
  const instrumentation = buildInstrumentationConfig({ instrumentation: config.instrumentation });
  if (!instrumentation) return undefined;
  let authorization = instrumentation.authorization;
  if (!authorization) {
    const endpoints = [config.otlpTrace, ...(config.innerTrace?.otlp ?? [])];
    for (const endpoint of endpoints) {
      if (!endpoint?.endpoint) continue;
      try {
        if (new URL(endpoint.endpoint).origin !== instrumentation.portalBaseUrl) continue;
        const value = Object.entries(endpoint.headers ?? {}).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
        if (value && /^Bearer [^\r\n]+$/.test(value)) { authorization = value; break; }
      } catch { /* invalid endpoint is not a credential source */ }
    }
  }
  if (!authorization) return undefined;
  const credential = authorization;
  return new DesiredPolicyClient({ baseUrl: instrumentation.portalBaseUrl, deviceId: instrumentation.deviceId,
    authorization: () => credential, bundleCompatible: desired => installedBundleVersion !== null && desired === installedBundleVersion,
    ...(config.dataDir ? { cache: { load: () => readJsonFile(path.join(resolveHome(config.dataDir), 'analytics-policy.json')),
      save: (state: import('./desired-policy-client.js').PolicyCache) => writeTextFileAtomic(path.join(resolveHome(config.dataDir), 'analytics-policy.json'), JSON.stringify(state) + '\n', { mode: 0o600 }) } } : {}) });
}
