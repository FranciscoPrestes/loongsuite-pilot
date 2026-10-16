import { createHash } from 'node:crypto';
import { z } from 'zod';

export const POLICY_OFFLINE_MAX_AGE_MS = 72 * 3600_000;
const id = z.string().min(1).max(500);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Portable mirror of portal/shared/src/analytics/schemas.ts; no private runtime dependency. */
export const instrumentationPolicySchema = z.object({ policyId: id, revision: id,
  desiredBundleVersion: id, enabled: z.boolean(), killSwitch: z.boolean(), deviceId: id.nullable(),
  cohortId: id.nullable(), reasons: z.array(z.string()), deletionRevision: id,
  issuedAt: timestamp, expiresAt: timestamp,
  limits: z.object({ reconcileIntervalMs: count.positive(), hookTargetP95Ms: count.positive(),
    workerTimeoutMs: count.positive(), maxMetadataFiles: count.positive(), maxSnippetBytes: count.positive(), maxReportBytes: count.positive() }).strict(),
}).strict().refine(v => Date.parse(v.expiresAt) > Date.parse(v.issuedAt) &&
  Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= POLICY_OFFLINE_MAX_AGE_MS, 'Policy expires within 72h');
export type InstrumentationPolicy = z.infer<typeof instrumentationPolicySchema>;
export type PolicyReason = 'ready' | 'no_policy' | 'offline' | 'invalid_policy' | 'unauthorized' | 'policy_expired' | 'local_disabled' | 'central_disabled' | 'bundle_incompatible';
export interface EffectiveInstrumentationPolicy {
  enrichmentEnabled: boolean; replayEnabled: boolean; baseTelemetryEnabled: true;
  reason: PolicyReason; desiredRevision: string | null; deletionRevision: string | null;
}
export interface DesiredPolicyClientOptions {
  baseUrl: string; deviceId?: string; authorization: () => string | Promise<string>;
  fetch?: typeof fetch; now?: () => number; bundleCompatible?: (version: string) => boolean;
  cache?: { load: () => Promise<unknown>; save: (state: PolicyCache) => Promise<void> };
  /** Runs after every refresh attempt (e.g. to re-verify the installed bundle); failures never affect the policy. */
  afterRefresh?: () => Promise<void>;
}
/** What the C3 bundle store needs to authorize consuming a bundle; computed from raw policy state, not from effective(). */
export interface BundleActivation { enabled: boolean; desiredBundle: string; cohort: string | null; allowedRollbackBundles: string[] }
export interface PolicyCache { policy: InstrumentationPolicy | null; etag: string | null; lastHealthyAt: number | null;
  portalOrigin: string; credentialFingerprint: string; authorizationDenied: boolean }
async function boundedPolicyBody(response: Response): Promise<unknown> {
  if (!response.body) return response.json(); // injectable fixture transport
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 64 * 1024) throw new Error('policy too large'); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
/** Operational revision subset: bounded decimal integers, never floating point or lexical ordering. */
export function operationalRevision(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || value.length > 500) throw new Error('invalid operational revision');
  return BigInt(value);
}
export class DesiredPolicyClient {
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private policy: InstrumentationPolicy | null = null;
  private etag: string | null = null;
  private lastHealthyAt: number | null = null;
  private reason: PolicyReason = 'no_policy';
  private syncedDeletionRevision: string | null = null;
  private refreshing: Promise<void> | null = null;
  private cacheLoaded = false;
  private credentialFingerprint: string | null = null;
  private authorizationDenied = false;
  constructor(private readonly options: DesiredPolicyClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
      throw new Error('Policy portal requires an explicit HTTPS origin');
    }
    this.endpoint = new URL('/api/coletor/analytics-config', base).href;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.refreshOnce().then(() => this.options.afterRefresh?.()).catch(() => undefined)
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  private async refreshOnce(): Promise<void> {
    try {
      const authorization = await this.options.authorization();
      if (!/^Bearer [^\r\n]+$/.test(authorization)) { this.reason = 'unauthorized'; this.authorizationDenied = true; return; }
      const fingerprint = createHash('sha256').update(authorization).digest('hex');
      if (this.credentialFingerprint !== null && this.credentialFingerprint !== fingerprint) {
        this.policy = null; this.etag = null; this.lastHealthyAt = null; this.syncedDeletionRevision = null; this.cacheLoaded = false;
      }
      this.credentialFingerprint = fingerprint;
      if (!this.cacheLoaded) {
        this.cacheLoaded = true;
        try {
          const stored = await this.options.cache?.load() as Partial<PolicyCache> | null;
          if (stored && stored.credentialFingerprint === fingerprint && stored.portalOrigin === new URL(this.endpoint).origin) {
            // A denial is authority even without a cached policy, or with an expired/corrupt one.
            this.authorizationDenied = stored.authorizationDenied === true;
            const parsed = instrumentationPolicySchema.parse(stored.policy);
            operationalRevision(parsed.revision); operationalRevision(parsed.deletionRevision);
            if (parsed.deviceId !== null && (!this.options.deviceId || parsed.deviceId === this.options.deviceId) && typeof stored.lastHealthyAt === 'number' &&
              stored.lastHealthyAt <= this.now() && Date.parse(parsed.issuedAt) <= this.now()) {
              this.policy = parsed; this.lastHealthyAt = stored.lastHealthyAt;
              this.etag = typeof stored.etag === 'string' ? stored.etag : null;
            }
          }
        } catch { /* corrupt or foreign cache is never an enable signal */ }
      }
      const response = await this.fetcher(this.endpoint, { method: 'GET', redirect: 'error',
        headers: { Authorization: authorization, Accept: 'application/json', ...(this.etag ? { 'If-None-Match': this.etag } : {}) },
        signal: AbortSignal.timeout(2000) });
      if (response.status === 401 || response.status === 403) {
        this.reason = 'unauthorized'; this.authorizationDenied = true;
        await this.persistAuthority();
        return;
      }
      if (response.status === 304 && this.policy) {
        this.lastHealthyAt = this.now(); this.reason = 'ready'; this.authorizationDenied = false;
        await this.persistAuthority().catch(() => {});
        return;
      }
      if (!response.ok || response.status !== 200) { this.reason = 'offline'; return; }
      const raw: unknown = await boundedPolicyBody(response);
      // The portal wraps every response in its { success, data, error } envelope.
      const body = raw && typeof raw === 'object' && 'success' in raw && 'data' in raw ? (raw as { data: unknown }).data : raw;
      if (Buffer.byteLength(JSON.stringify(body)) > 64 * 1024) throw new Error('policy too large');
      const next = instrumentationPolicySchema.parse(body);
      const revision = operationalRevision(next.revision);
      const deletionRevision = operationalRevision(next.deletionRevision);
      if (next.deviceId === null || (this.options.deviceId !== undefined && next.deviceId !== this.options.deviceId) || Date.parse(next.issuedAt) > this.now() || Date.parse(next.expiresAt) <= this.now()) throw new Error('invalid device or validity');
      if (this.policy && (revision < operationalRevision(this.policy.revision) || deletionRevision < operationalRevision(this.policy.deletionRevision) ||
        (revision === operationalRevision(this.policy.revision) && canonical(next) !== canonical(this.policy)))) throw new Error('policy revision conflict');
      this.policy = next; this.etag = response.headers.get('ETag'); this.lastHealthyAt = this.now(); this.reason = 'ready'; this.authorizationDenied = false;
      await this.persistAuthority().catch(() => {});
    } catch (error) {
      this.reason = error instanceof TypeError || (error instanceof Error && /offline|fetch|timeout|abort/i.test(error.message)) ? 'offline' : 'invalid_policy';
    }
  }
  private async persistAuthority(): Promise<void> {
    if (this.credentialFingerprint === null) return;
    await this.options.cache?.save({ policy: this.policy, etag: this.etag, lastHealthyAt: this.lastHealthyAt,
      portalOrigin: new URL(this.endpoint).origin, credentialFingerprint: this.credentialFingerprint,
      authorizationDenied: this.authorizationDenied });
  }
  getState(): { policy: InstrumentationPolicy | null; reason: PolicyReason; lastHealthyAt: number | null } {
    return { policy: this.policy ? structuredClone(this.policy) : null, reason: this.reason, lastHealthyAt: this.lastHealthyAt };
  }
  markExclusionsSynchronized(revision: string): void {
    operationalRevision(revision);
    if (!this.policy || revision !== this.policy.deletionRevision) throw new Error('exclusion revision must match current policy');
    this.syncedDeletionRevision = revision;
  }
  /** Every gate except bundle compatibility, which needs the (policy-dependent) verified bundle resolver. */
  private baseReason(localEnabled: boolean): PolicyReason {
    const policy = this.policy;
    if (!localEnabled) return 'local_disabled';
    if (this.authorizationDenied) return 'unauthorized';
    if (!policy) return 'no_policy';
    if (this.lastHealthyAt === null || this.now() - this.lastHealthyAt > POLICY_OFFLINE_MAX_AGE_MS || this.now() >= Date.parse(policy.expiresAt)) return 'policy_expired';
    if (!policy.enabled || policy.killSwitch) return 'central_disabled';
    return 'ready';
  }
  /**
   * Bundle activation authority. `allowedRollbackBundles` is explicitly empty: the policy schema (and the
   * portal contract) define no rollback list, so an older bundle is never authorized by this client.
   */
  activation(localEnabled: boolean): BundleActivation {
    const policy = this.policy;
    return { enabled: this.baseReason(localEnabled) === 'ready', desiredBundle: policy?.desiredBundleVersion ?? '0.0.0',
      cohort: policy?.cohortId ?? null, allowedRollbackBundles: [] };
  }
  effective(localEnabled: boolean): EffectiveInstrumentationPolicy {
    const policy = this.policy;
    let reason = this.baseReason(localEnabled);
    if (reason === 'ready' && this.options.bundleCompatible && !this.options.bundleCompatible(policy!.desiredBundleVersion)) reason = 'bundle_incompatible';
    const enrichmentEnabled = reason === 'ready';
    return { enrichmentEnabled, replayEnabled: enrichmentEnabled && this.syncedDeletionRevision === policy?.deletionRevision,
      baseTelemetryEnabled: true, reason, desiredRevision: policy?.revision ?? null, deletionRevision: policy?.deletionRevision ?? null };
  }
}
