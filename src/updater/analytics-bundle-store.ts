import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';
import { canonicalManifestBytes, DEFAULT_ANALYTICS_KEYS, trustedKeyMap, validateAnalyticsManifest, verifySignedManifest, type AnalyticsManifest, type SignedAnalyticsManifest, type TrustedAnalyticsKeys } from '../deployment/manifest-signature.js';

export interface AnalyticsBundleAuthorization { enabled: boolean; desiredBundle: string; cohort: string | null }
export interface VerifiedAnalyticsBundle { version: string; directory: string; assets: Readonly<Record<string, string>> }
export interface AnalyticsBundleOptions {
  collectorVersion: string;
  trustedKeys?: TrustedAnalyticsKeys;
  /** Must reevaluate current local/native disable, fresh desired policy and cohort. */
  authorization: () => Promise<AnalyticsBundleAuthorization>;
  /** True means instrumentation evidence was observed, not just process/install success. */
  inspect: (bundle: VerifiedAnalyticsBundle, manifest: AnalyticsManifest, signal: AbortSignal) => Promise<boolean>;
}
const pointer = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-ntc\.[0-9]+)?_[a-f0-9-]{36}$/).nullable();
const stableStateSchema = z.object({ schemaVersion: z.literal(1), current: pointer, previous: pointer, lastGood: pointer, pending: z.literal(false) }).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), current: pointer, previous: pointer, lastGood: pointer, pending: z.boolean(), rollback: stableStateSchema.optional() }).strict().refine(v => v.pending === Boolean(v.rollback), 'Pending state requires rollback record');
type BundleState = z.infer<typeof stateSchema>;
const emptyState: BundleState = { schemaVersion: 1, current: null, previous: null, lastGood: null, pending: false };
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const exec = promisify(execFile);

/** Collector-owned immutable assets only. No queue, hook settings or user files are restored. */
export class AnalyticsBundleStore {
  private readonly root: string;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(dataDir: string, private readonly options: AnalyticsBundleOptions) { this.root = path.join(dataDir, 'analytics'); }
  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    const { lock } = acquireSingleInstanceLock(path.join(this.root, 'update.lock'));
    if (!lock) throw new Error('Analytics updater busy');
    try { return await operation(); } finally { lock.release(); }
  }
  private async keys(): Promise<ReadonlyMap<string, string>> {
    if (this.options.trustedKeys) return trustedKeyMap(this.options.trustedKeys);
    try { return trustedKeyMap(JSON.parse(await fs.readFile(path.join(this.root, 'trusted-keys.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return trustedKeyMap(DEFAULT_ANALYTICS_KEYS); throw error; }
  }
  private async verifiedManifest(envelope: SignedAnalyticsManifest): Promise<AnalyticsManifest> {
    const manifest = validateAnalyticsManifest(envelope?.payload, this.options.collectorVersion);
    if (typeof envelope.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)
      || !verifySignedManifest(canonicalManifestBytes(manifest), Buffer.from(envelope.signature, 'base64'), manifest.keyId, await this.keys())) throw new Error('Invalid analytics manifest signature');
    return manifest;
  }
  private async readState(): Promise<BundleState> {
    try { return stateSchema.parse(JSON.parse(await fs.readFile(path.join(this.root, 'bundle-state.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...emptyState }; throw error; }
  }
  private async writeState(state: BundleState): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const file = path.join(this.root, 'bundle-state.json'); const tmp = file + '.' + randomUUID();
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
  }
  private async verifyDirectory(name: string): Promise<VerifiedAnalyticsBundle> {
    const directory = path.join(this.root, 'versions', name);
    const envelope = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')) as SignedAnalyticsManifest;
    const manifest = await this.verifiedManifest(envelope);
    const archive = path.join(directory, 'archive.tgz');
    if (!(await fs.lstat(archive)).isFile() || sha(await fs.readFile(archive)) !== manifest.archiveSha256) throw new Error('Analytics archive checksum mismatch');
    const assets: Record<string, string> = {};
    for (const [name, digest] of Object.entries(manifest.assets)) {
      const file = path.join(directory, name);
      const relative = path.relative(await fs.realpath(directory), await fs.realpath(file));
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.lstat(file)).isFile() || sha(await fs.readFile(file)) !== digest) throw new Error('Analytics asset checksum mismatch');
      assets[name] = file;
    }
    return { version: manifest.version, directory, assets };
  }
  private async recover(): Promise<BundleState> {
    const state = await this.readState();
    if (!state.pending) return state;
    // No candidate is last-known-good until the evidence check completed durably.
    if (state.lastGood) await this.verifyDirectory(state.lastGood);
    const restored = state.rollback!;
    await this.writeState(restored);
    return restored;
  }
  async resolve(): Promise<VerifiedAnalyticsBundle | null> {
    // Serialize readers with activation so a pending candidate cannot escape.
    await this.tail;
    return this.locked(async () => {
      const state = await this.recover();
      if (!(await this.options.authorization()).enabled || !state.current) return null;
      return this.verifyDirectory(state.current);
    });
  }
  install(envelope: SignedAnalyticsManifest, archive: string): Promise<void> {
    const run = this.tail.then(() => this.locked(() => this.installOnce(envelope, archive)));
    this.tail = run.catch(() => {});
    return run;
  }
  private async inspect(bundle: VerifiedAnalyticsBundle, manifest: AnalyticsManifest): Promise<boolean> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.inspect(bundle, manifest, abort.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('Analytics evidence check timed out')); }, 2000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async installOnce(envelope: SignedAnalyticsManifest, archive: string): Promise<void> {
    const manifest = await this.verifiedManifest(envelope);
    const authorize = async () => {
      const policy = await this.options.authorization();
      if (!policy.enabled || policy.desiredBundle !== manifest.version || (policy.cohort !== null && (typeof policy.cohort !== 'string' || !policy.cohort))) throw new Error('Analytics bundle activation not authorized');
      return policy;
    };
    const policy = await authorize();
    if ((await fs.stat(archive)).size > 32 * 1024 * 1024) throw new Error('Analytics archive exceeds limit');
    const bytes = await fs.readFile(archive);
    if (bytes.length > 32 * 1024 * 1024 || sha(bytes) !== manifest.archiveSha256) throw new Error('Analytics archive checksum mismatch');
    const old = await this.recover();
    if (old.current) {
      const active = await this.verifyDirectory(old.current);
      const installed = JSON.parse(await fs.readFile(path.join(active.directory, 'manifest.json'), 'utf8')) as SignedAnalyticsManifest;
      if (canonicalManifestBytes(installed.payload).equals(canonicalManifestBytes(manifest))) return;
    }
    const name = manifest.version + '_' + randomUUID();
    const directory = path.join(this.root, 'versions', name);
    await fs.mkdir(directory, { recursive: true });
    try {
      const localArchive = path.join(directory, 'archive.tgz');
      await fs.writeFile(localArchive, bytes, { mode: 0o600 });
      // Reject links and non-file entries BEFORE extraction. Only exact signed paths
      // may be extracted, which prevents archive traversal and unlisted executables.
      const { stdout: names } = await exec('tar', ['-tzf', localArchive], { timeout: 30000, maxBuffer: 65536 });
      const entries = names.trim().split('\n');
      if (entries.length !== Object.keys(manifest.assets).length || new Set(entries).size !== entries.length || entries.some(v => !Object.hasOwn(manifest.assets, v))) throw new Error('Unexpected archive assets');
      const { stdout: details } = await exec('tar', ['-tvzf', localArchive], { timeout: 30000, maxBuffer: 65536 });
      if (details.trim().split('\n').some(v => !v.startsWith('-'))) throw new Error('Archive links or special files rejected');
      let inflatedBytes = 0;
      for (const asset of entries) {
        // Stream one named regular file to a bounded buffer; never let tar write
        // paths or materialize an arbitrarily large compressed payload on disk.
        const { stdout } = await exec('tar', ['-xOf', localArchive, asset], { timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
        inflatedBytes += stdout.length;
        if (inflatedBytes > 32 * 1024 * 1024) throw new Error('Inflated analytics bundle exceeds limit');
        const destination = path.join(directory, asset);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, stdout, { mode: 0o600, flag: 'wx' });
      }
      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(envelope), { mode: 0o600 });
      const bundle = await this.verifyDirectory(name);
      const fresh = await authorize();
      if (fresh.cohort !== policy.cohort) throw new Error('Analytics cohort changed during installation');
      await this.writeState({ schemaVersion: 1, current: name, previous: old.current, lastGood: old.lastGood, pending: true, rollback: stableStateSchema.parse(old) });
      if (!await this.inspect(bundle, manifest)) throw new Error('Analytics instrumentation evidence missing');
      const finalPolicy = await authorize();
      if (finalPolicy.cohort !== policy.cohort) throw new Error('Analytics cohort changed during verification');
      await this.verifyDirectory(name);
      await this.writeState({ schemaVersion: 1, current: name, previous: old.current, lastGood: name, pending: false });
    } catch (error) {
      await this.writeState(old);
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
}
