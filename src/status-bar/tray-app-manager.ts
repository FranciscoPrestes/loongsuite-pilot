import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn as nodeSpawn, execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const execFile = promisify(execFileCb);
const logger = createLogger('TrayAppManager');

const FETCH_TIMEOUT_MS = 30_000;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-ntc\.[0-9]+)?$/;
const MANIFEST_SUFFIX = '/manifest/latest.json';
const PROCESS_NAME = 'ntc-tes-tray';

/** Release platform key for the tray archive; macOS keeps its native Swift menu bar app. */
export function trayPlatform(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'linux' && arch === 'arm64') return 'linux-arm64';
  return null;
}

export interface TrayUrls {
  archiveUrl: string;
  sumsUrl: string;
  archiveName: string;
}

/** `<root>/manifest/latest.json` -> `<root>/deps/tray/<version>/...`. Null for anything else. */
export function resolveTrayUrls(
  manifestUrl: string | undefined,
  version: string,
  platformKey: string,
): TrayUrls | null {
  if (!manifestUrl || !manifestUrl.startsWith('https://') || !manifestUrl.endsWith(MANIFEST_SUFFIX)) return null;
  if (!VERSION_RE.test(version)) return null;
  const root = manifestUrl.slice(0, -MANIFEST_SUFFIX.length);
  const archiveName = `tray-${platformKey}.tar.gz`;
  const base = `${root}/deps/tray/${version}`;
  return { archiveUrl: `${base}/${archiveName}`, sumsUrl: `${base}/SHASUMS256.txt`, archiveName };
}

/** Hash of `name` in sha256sum-format text, or null. */
export function parseSums(text: string, name: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64}) {2}(\S+)\s*$/.exec(line.trim());
    if (m && m[2] === name) return m[1];
  }
  return null;
}

type SpawnedChild = { pid?: number; unref(): void };
type SpawnFn = (cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; detached?: boolean; stdio?: 'ignore' }) => SpawnedChild;

export interface TrayAppManagerOptions {
  dataDir: string;
  manifestUrl?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchFn?: typeof fetch;
  extractFn?: (archivePath: string, destDir: string) => Promise<void>;
  spawnFn?: SpawnFn;
  isAlive?: (pid: number) => boolean | Promise<boolean>;
  killFn?: (pid: number) => void;
  /** Environment used to detect a graphical session on Linux (default process.env). */
  env?: NodeJS.ProcessEnv;
}

export type TrayStartResult = { status: 'started' | 'already-running'; pid: number };
export type TrayStopResult = { status: 'stopped' | 'already-stopped'; pid: number | null };

async function tarExtract(archivePath: string, destDir: string): Promise<void> {
  // bsdtar ships with Windows 10+, GNU tar with every Linux we support.
  await execFile('tar', ['-xzf', archivePath, '-C', destDir], { timeout: 60_000 });
}

/** True only when `pid` is alive AND is the tray app (guards against pid reuse). */
async function defaultIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    if (process.platform === 'linux') {
      return (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim().startsWith(PROCESS_NAME);
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeout: 5000 });
      return stdout.toLowerCase().includes(`${PROCESS_NAME}.exe`);
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Installs and runs the cross-platform NT TES tray panel (app/tray) on Windows and Linux.
 * The release publishes it under deps/tray/<version>/; the collector fetches it from the same
 * blob as the manifest, verifies the checksum and starts it. Everything is best effort: a
 * missing or broken tray never affects collection.
 */
export class TrayAppManager {
  private readonly trayDir: string;
  private readonly platformKey: string | null;
  private readonly exeName: string;
  private readonly platform: NodeJS.Platform;
  private readonly opts: TrayAppManagerOptions;

  constructor(options: TrayAppManagerOptions) {
    this.opts = options;
    this.trayDir = path.join(options.dataDir, 'tray');
    const platform = options.platform ?? process.platform;
    this.platform = platform;
    this.platformKey = trayPlatform(platform, options.arch ?? process.arch);
    this.exeName = platform === 'win32' ? `${PROCESS_NAME}.exe` : PROCESS_NAME;
  }

  async syncDesiredState(enabled: boolean): Promise<void> {
    try {
      if (enabled) await this.start();
      else await this.stop();
    } catch (err) {
      logger.warn('tray app sync failed (non-fatal)', { error: String(err) });
    }
  }

  /** Path of the installed executable for the manifest's current version, installing it if needed. */
  async ensureInstalled(): Promise<string | null> {
    const resolved = await this.resolveRelease();
    if (!resolved) return null;
    return this.install(resolved.version, resolved.urls);
  }

  async start(): Promise<TrayStartResult | null> {
    const resolved = await this.resolveRelease();
    if (!resolved) return null;
    const exe = await this.install(resolved.version, resolved.urls);
    if (!exe) return null;

    const running = await this.readRunning();
    if (running) {
      if (running.version === resolved.version) return { status: 'already-running', pid: running.pid };
      await this.stop(); // an older version is running: replace it
    }

    const spawnFn = this.opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
    const child = spawnFn(exe, [], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: this.opts.dataDir },
    });
    child.unref();
    if (!child.pid) throw new Error('tray app did not report a pid');
    await fs.mkdir(this.trayDir, { recursive: true });
    await fs.writeFile(path.join(this.trayDir, 'tray.pid'), String(child.pid));
    await fs.writeFile(path.join(this.trayDir, 'tray.version'), resolved.version);
    logger.info('tray app started', { pid: child.pid, version: resolved.version });
    return { status: 'started', pid: child.pid };
  }

  async stop(): Promise<TrayStopResult> {
    const running = await this.readRunning();
    await this.clearRunning();
    if (!running) return { status: 'already-stopped', pid: null };
    (this.opts.killFn ?? ((pid: number) => process.kill(pid)))(running.pid);
    logger.info('tray app stopped', { pid: running.pid });
    return { status: 'stopped', pid: running.pid };
  }

  private async resolveRelease(): Promise<{ version: string; urls: TrayUrls } | null> {
    if (!this.platformKey || !this.opts.manifestUrl) return null;
    if (this.platform === 'linux' && !this.hasDisplay()) return null; // headless server: nothing to show
    try {
      const resp = await (this.opts.fetchFn ?? fetch)(this.opts.manifestUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) return null;
      const version = String(((await resp.json()) as { version?: unknown }).version ?? '');
      const urls = resolveTrayUrls(this.opts.manifestUrl, version, this.platformKey);
      return urls ? { version, urls } : null;
    } catch (err) {
      logger.debug('tray manifest lookup failed', { error: String(err) });
      return null;
    }
  }

  private hasDisplay(): boolean {
    const env = this.opts.env ?? process.env;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
  }

  private async install(version: string, urls: TrayUrls): Promise<string | null> {
    const versionDir = path.join(this.trayDir, version);
    const exe = path.join(versionDir, this.exeName);
    if (await exists(exe)) return exe;

    const tmp = path.join(this.trayDir, `.tmp-${randomBytes(4).toString('hex')}`);
    try {
      const get = this.opts.fetchFn ?? fetch;
      const sumsResp = await get(urls.sumsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!sumsResp.ok) return null; // this release has no tray
      const expected = parseSums(await sumsResp.text(), urls.archiveName);
      if (!expected) return null;
      const archResp = await get(urls.archiveUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 4) });
      if (!archResp.ok) return null;
      const bytes = Buffer.from(await archResp.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== expected) {
        logger.warn('tray archive checksum mismatch; not installing', { version });
        return null;
      }

      const stage = path.join(tmp, 'stage');
      await fs.mkdir(stage, { recursive: true });
      const archivePath = path.join(tmp, urls.archiveName);
      await fs.writeFile(archivePath, bytes);
      await (this.opts.extractFn ?? tarExtract)(archivePath, stage);
      if (!(await exists(path.join(stage, this.exeName)))) {
        logger.warn('tray archive has no executable; not installing', { version });
        return null;
      }
      await fs.rm(versionDir, { recursive: true, force: true });
      await fs.rename(stage, versionDir);
      if (process.platform !== 'win32') await fs.chmod(exe, 0o755);
      await this.pruneOldVersions(version);
      logger.info('tray app installed', { version });
      return exe;
    } catch (err) {
      logger.warn('tray app install failed (non-fatal)', { error: String(err) });
      return null;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async pruneOldVersions(keep: string): Promise<void> {
    for (const name of await fs.readdir(this.trayDir).catch(() => [] as string[])) {
      if (name !== keep && VERSION_RE.test(name)) {
        await fs.rm(path.join(this.trayDir, name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async readRunning(): Promise<{ pid: number; version: string | null } | null> {
    const raw = await fs.readFile(path.join(this.trayDir, 'tray.pid'), 'utf8').catch(() => null);
    const pid = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!(await (this.opts.isAlive ?? defaultIsAlive)(pid))) return null;
    const version = (await fs.readFile(path.join(this.trayDir, 'tray.version'), 'utf8').catch(() => '')).trim();
    return { pid, version: version || null };
  }

  private async clearRunning(): Promise<void> {
    await Promise.all(['tray.pid', 'tray.version'].map((f) =>
      fs.rm(path.join(this.trayDir, f), { force: true }).catch(() => undefined)));
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}
