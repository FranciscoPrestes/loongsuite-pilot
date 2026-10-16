import type { ConfigFile } from '../core/config-loader.js';
import type { AnalyticsConfig } from '../types/index.js';
import { AnalyticsBundleStore, type AnalyticsBundleOptions } from '../updater/analytics-bundle-store.js';
import type { DesiredPolicyClient } from './desired-policy-client.js';
import { createRuntimePolicyClient } from './instrumentation-runtime.js';
import { inspectValidatedEvent } from './validated-event.js';

export interface BundleVerifier { version(): string | null; refresh(): Promise<void> }
export interface CollectorPolicyRuntime { client: DesiredPolicyClient; verifier: BundleVerifier }

/**
 * Collector side: compatibility is the C3-VERIFIED bundle, re-resolved after every policy refresh.
 * The resolver's authorization comes from raw policy state (`activation`), not `effective()`, so the
 * two cannot wait on each other. Any resolver failure means "no verified bundle" (fail closed).
 */
export function createCollectorPolicyRuntime(config: Pick<AnalyticsConfig, 'instrumentation' | 'otlpTrace' | 'innerTrace' | 'dataDir'>,
  dataDir: string, collectorVersion: string, trustedKeys?: AnalyticsBundleOptions['trustedKeys']): CollectorPolicyRuntime | undefined {
  let verified: string | null = null;
  let store: AnalyticsBundleStore | null = null;
  const verifier: BundleVerifier = {
    version: () => verified,
    refresh: async () => {
      try { verified = (await store?.resolve())?.version ?? null; } catch { verified = null; }
    },
  };
  const client = createRuntimePolicyClient(config, () => verified, () => verifier.refresh());
  if (!client) return undefined;
  const localEnabled = () => config.instrumentation?.localEnabled === true;
  store = new AnalyticsBundleStore(dataDir, {
    collectorVersion, ...(trustedKeys ? { trustedKeys } : {}),
    authorization: async () => client.activation(localEnabled()),
    inspect: async () => false, // the collector only resolves; installation (and evidence) belongs to the updater
  });
  return { client, verifier };
}

/**
 * Updater side (separate process): its own policy client over the same cache file, and an evidence check
 * backed by the marker the collector writes. Without a configured portal credential there is no
 * analytics bundle handling at all (undefined = feature off, base update flow untouched).
 */
export function createUpdaterAnalyticsOptions(file: ConfigFile | null, dataDir: string, collectorVersion: string,
  trustedKeys?: AnalyticsBundleOptions['trustedKeys']): AnalyticsBundleOptions | undefined {
  const client = createRuntimePolicyClient({ instrumentation: file?.instrumentation, otlpTrace: file?.otlpTrace as AnalyticsConfig['otlpTrace'], dataDir }, null);
  if (!client) return undefined;
  const localEnabled = () => file?.instrumentation?.localEnabled === true;
  return {
    collectorVersion, ...(trustedKeys ? { trustedKeys } : {}),
    authorization: async () => { await client.refresh(); return client.activation(localEnabled()); },
    inspect: (_bundle, _manifest, signal) => inspectValidatedEvent(dataDir, signal),
  };
}
