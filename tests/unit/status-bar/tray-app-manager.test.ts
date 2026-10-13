import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import {
  TrayAppManager,
  trayPlatform,
  resolveTrayUrls,
  parseSums,
  installHint,
} from '../../../src/status-bar/tray-app-manager.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ROOT = 'https://blob.example/pilot';
const MANIFEST = `${ROOT}/manifest/latest.json`;
const VERSION = '1.2.0-ntc.6';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

describe('trayPlatform', () => {
  it('maps Windows and Linux; macOS keeps its native Swift app', () => {
    expect(trayPlatform('win32', 'x64')).toBe('win-x64');
    expect(trayPlatform('linux', 'x64')).toBe('linux-x64');
    expect(trayPlatform('linux', 'arm64')).toBe('linux-arm64');
    expect(trayPlatform('darwin', 'arm64')).toBeNull();
    expect(trayPlatform('win32', 'arm64')).toBeNull();
    expect(trayPlatform('freebsd', 'x64')).toBeNull();
  });
});

describe('resolveTrayUrls', () => {
  it('derives the archive and checksum urls from the manifest url', () => {
    expect(resolveTrayUrls(MANIFEST, VERSION, 'linux-x64')).toEqual({
      archiveUrl: `${ROOT}/deps/tray/${VERSION}/tray-linux-x64.tar.gz`,
      sumsUrl: `${ROOT}/deps/tray/${VERSION}/SHASUMS256.txt`,
      archiveName: 'tray-linux-x64.tar.gz',
    });
  });
  it('returns null for a manifest url that is not <root>/manifest/latest.json', () => {
    expect(resolveTrayUrls('https://x/y/latest.json', VERSION, 'linux-x64')).toBeNull();
    expect(resolveTrayUrls(undefined, VERSION, 'linux-x64')).toBeNull();
  });
  it('rejects a path-like version', () => {
    expect(resolveTrayUrls(MANIFEST, '../x', 'linux-x64')).toBeNull();
    expect(resolveTrayUrls(MANIFEST, '', 'linux-x64')).toBeNull();
  });
  it('requires https', () => {
    expect(resolveTrayUrls('http://blob.example/pilot/manifest/latest.json', VERSION, 'linux-x64')).toBeNull();
  });
});

describe('parseSums', () => {
  it('finds the hash of one file in sha256sum format', () => {
    const text = `${'a'.repeat(64)}  tray-linux-x64.tar.gz\n${'b'.repeat(64)}  tray-win-x64.tar.gz\n`;
    expect(parseSums(text, 'tray-win-x64.tar.gz')).toBe('b'.repeat(64));
    expect(parseSums(text, 'nope.tar.gz')).toBeNull();
  });
});

describe('installHint', () => {
  it('maps missing libraries to Debian/Ubuntu packages', () => {
    const hint = installHint(['libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0']);
    expect(hint).toContain('sudo apt install');
    expect(hint).toContain('libwebkit2gtk-4.1-0');
    expect(hint).toContain('libgtk-3-0');
    expect(hint).toContain('libayatana-appindicator3-1');
  });
});

describe('TrayAppManager', () => {
  let dir: string;
  const archive = Buffer.from('fake archive bytes');

  function makeFetch(overrides: Record<string, () => Response> = {}) {
    const calls: string[] = [];
    const fn = vi.fn(async (url: string) => {
      calls.push(url);
      if (overrides[url]) return overrides[url]();
      if (url === MANIFEST) {
        return new Response(JSON.stringify({
          version: '1.2.0-ntc.5', git_commit: '6812573',
          canary: { version: VERSION, git_commit: '5055741' },
        }));
      }
      if (url.endsWith('tray-linux-x64.tar.gz')) return new Response(archive);
      if (url.endsWith('SHASUMS256.txt')) return new Response(`${sha(archive)}  tray-linux-x64.tar.gz\n`);
      return new Response('nope', { status: 404 });
    });
    return { fn, calls };
  }

  function makeManager(opts: Partial<ConstructorParameters<typeof TrayAppManager>[0]> = {}) {
    const fetched = makeFetch();
    const extract = vi.fn(async (_archive: string, dest: string) => {
      await fs.writeFile(path.join(dest, 'ntc-tes-tray'), 'binary');
    });
    const spawned: Array<{ cmd: string; env?: NodeJS.ProcessEnv }> = [];
    const spawnFn = vi.fn((cmd: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => {
      spawned.push({ cmd, env: o.env });
      return { pid: 4242, unref: vi.fn() } as never;
    });
    const alive = new Set<number>();
    const kill = vi.fn((pid: number) => { alive.delete(pid); });
    const manager = new TrayAppManager({
      dataDir: dir,
      manifestUrl: MANIFEST,
      gitCommit: '5055741a1b2c3d4e',
      platform: 'linux',
      arch: 'x64',
      fetchFn: fetched.fn as never,
      extractFn: extract,
      spawnFn: spawnFn as never,
      isAlive: (pid) => alive.has(pid),
      killFn: kill,
      env: { DISPLAY: ':0' },
      checkLibs: async () => [],
      ...opts,
    });
    return { manager, fetched, extract, spawned, spawnFn, alive, kill };
  }

  beforeEach(async () => { dir = await createTempDir('tray-mgr'); });
  afterEach(async () => { await cleanupTempDir(dir); });

  it('downloads, verifies and installs the tray under <dataDir>/tray/<version>', async () => {
    const { manager, extract } = makeManager();
    const exe = await manager.ensureInstalled();
    expect(exe).toBe(path.join(dir, 'tray', VERSION, 'ntc-tes-tray'));
    expect(await fs.readFile(exe!, 'utf8')).toBe('binary');
    expect(extract).toHaveBeenCalledOnce();
  });

  it('does not download again when that version is already installed', async () => {
    const { manager, fetched } = makeManager();
    await manager.ensureInstalled();
    const firstRound = fetched.calls.length;
    await manager.ensureInstalled();
    expect(fetched.calls.slice(firstRound).filter((u) => u.includes('/deps/tray/'))).toEqual([]);
  });

  it('refuses an archive whose checksum does not match, installing nothing', async () => {
    const bad = makeFetch({
      [`${ROOT}/deps/tray/${VERSION}/tray-linux-x64.tar.gz`]: () => new Response('tampered'),
    });
    const { manager, extract } = makeManager({ fetchFn: bad.fn as never });
    expect(await manager.ensureInstalled()).toBeNull();
    expect(extract).not.toHaveBeenCalled();
    await expect(fs.access(path.join(dir, 'tray', VERSION))).rejects.toThrow();
  });

  it('returns null on a 404 (release without a tray) without throwing', async () => {
    const none = makeFetch({
      [`${ROOT}/deps/tray/${VERSION}/SHASUMS256.txt`]: () => new Response('missing', { status: 404 }),
    });
    const { manager } = makeManager({ fetchFn: none.fn as never });
    await expect(manager.ensureInstalled()).resolves.toBeNull();
  });

  it('follows the release the collector runs: the canary entry when the commit matches it', async () => {
    const { manager } = makeManager({ gitCommit: '5055741' });
    expect(await manager.ensureInstalled()).toBe(path.join(dir, 'tray', VERSION, 'ntc-tes-tray'));
  });

  it('uses the stable entry when the running commit is the stable release (which has no tray yet)', async () => {
    const noTray = makeFetch({
      [`${ROOT}/deps/tray/1.2.0-ntc.5/SHASUMS256.txt`]: () => new Response('missing', { status: 404 }),
    });
    const { manager, fetched } = makeManager({ gitCommit: '6812573deadbeef', fetchFn: noTray.fn as never });
    expect(await manager.ensureInstalled()).toBeNull(); // ntc.5 shipped no tray: 404
    fetched.calls.push(...noTray.calls);
    expect(fetched.calls.some((u) => u.includes('/deps/tray/1.2.0-ntc.5/'))).toBe(true);
    expect(fetched.calls.some((u) => u.includes(`/deps/tray/${VERSION}/`))).toBe(false);
  });

  it('installs nothing when the running commit is in neither manifest entry or is unknown', async () => {
    const other = makeManager({ gitCommit: 'abcdef1' });
    expect(await other.manager.ensureInstalled()).toBeNull();
    const unknown = makeManager({ gitCommit: undefined });
    expect(await unknown.manager.ensureInstalled()).toBeNull();
    const short = makeManager({ gitCommit: '5055' }); // too short to be trusted
    expect(await short.manager.ensureInstalled()).toBeNull();
    for (const m of [other, unknown, short]) {
      expect(m.fetched.calls.filter((u) => u.includes('/deps/tray/'))).toEqual([]);
    }
  });

  it('does nothing on macOS or without a manifest url', async () => {
    const mac = makeManager({ platform: 'darwin' });
    expect(await mac.manager.ensureInstalled()).toBeNull();
    expect(mac.fetched.fn).not.toHaveBeenCalled();
    const noUrl = makeManager({ manifestUrl: undefined });
    expect(await noUrl.manager.ensureInstalled()).toBeNull();
    expect(noUrl.fetched.fn).not.toHaveBeenCalled();
  });

  it('removes older installed versions after installing a new one', async () => {
    await fs.mkdir(path.join(dir, 'tray', '1.2.0-ntc.5'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tray', '1.2.0-ntc.5', 'ntc-tes-tray'), 'old');
    const { manager } = makeManager();
    await manager.ensureInstalled();
    expect((await fs.readdir(path.join(dir, 'tray'))).sort()).toEqual([VERSION]);
  });

  it('starts the app detached with the data dir in its environment and records the pid', async () => {
    const { manager, spawned, alive } = makeManager();
    const result = await manager.start();
    expect(result).toEqual({ status: 'started', pid: 4242 });
    expect(spawned[0].cmd).toBe(path.join(dir, 'tray', VERSION, 'ntc-tes-tray'));
    expect(spawned[0].env?.LOONGSUITE_PILOT_DATA_DIR).toBe(dir);
    alive.add(4242);
    expect(await fs.readFile(path.join(dir, 'tray', 'tray.pid'), 'utf8')).toBe('4242');
  });

  it('does not start a second copy while the recorded pid is alive', async () => {
    const { manager, spawnFn, alive } = makeManager();
    await manager.start();
    alive.add(4242);
    expect(await manager.start()).toEqual({ status: 'already-running', pid: 4242 });
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('stop kills the recorded pid and clears it; stopping twice is harmless', async () => {
    const { manager, kill, alive } = makeManager();
    await manager.start();
    alive.add(4242);
    expect(await manager.stop()).toEqual({ status: 'stopped', pid: 4242 });
    expect(kill).toHaveBeenCalledWith(4242);
    expect(await manager.stop()).toEqual({ status: 'already-stopped', pid: null });
  });

  it('on Linux, does not start (and says why) when shared libraries are missing', async () => {
    const { manager, spawnFn } = makeManager({
      checkLibs: async () => ['libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0'],
    });
    expect(await manager.start()).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(manager.lastMissingLibs).toEqual(['libwebkit2gtk-4.1.so.0', 'libgtk-3.so.0']);
  });

  it('on Linux, starts once the libraries are present', async () => {
    const { manager, spawnFn } = makeManager({ checkLibs: async () => [] });
    expect(await manager.start()).toEqual({ status: 'started', pid: 4242 });
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(manager.lastMissingLibs).toEqual([]);
  });

  it('does not check libraries on Windows', async () => {
    const checkLibs = vi.fn(async () => ['x']);
    const { manager } = makeManager({ platform: 'win32', checkLibs });
    await manager.start();
    expect(checkLibs).not.toHaveBeenCalled();
  });

  it('replaces a running older version with the current one', async () => {
    await fs.mkdir(path.join(dir, 'tray'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tray', 'tray.pid'), '777');
    await fs.writeFile(path.join(dir, 'tray', 'tray.version'), '1.2.0-ntc.5');
    const { manager, kill, spawnFn, alive } = makeManager();
    alive.add(777);
    expect(await manager.start()).toEqual({ status: 'started', pid: 4242 });
    expect(kill).toHaveBeenCalledWith(777);
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('does not start on a Linux session without a display (headless server)', async () => {
    const headless = makeManager({ env: {} });
    expect(await headless.manager.start()).toBeNull();
    expect(headless.spawnFn).not.toHaveBeenCalled();
    expect(headless.fetched.fn).not.toHaveBeenCalled();
    const wayland = makeManager({ env: { WAYLAND_DISPLAY: 'wayland-0' } });
    expect(await wayland.manager.start()).toEqual({ status: 'started', pid: 4242 });
    const x11 = makeManager({ env: { DISPLAY: ':0' } });
    expect(await x11.manager.start()).toEqual({ status: 'started', pid: 4242 });
  });

  it('installs from a real tar.gz using the system tar (default extractor)', async () => {
    const src = path.join(dir, 'src');
    await fs.mkdir(src);
    await fs.writeFile(path.join(src, 'ntc-tes-tray'), '#!/bin/sh\n');
    await fs.writeFile(path.join(src, 'icon.png'), 'png');
    const tgz = path.join(dir, 'tray-linux-x64.tar.gz');
    execFileSync('tar', ['-czf', tgz, '-C', src, 'ntc-tes-tray', 'icon.png']);
    const bytes = await fs.readFile(tgz);
    const real = makeFetch({
      [`${ROOT}/deps/tray/${VERSION}/tray-linux-x64.tar.gz`]: () => new Response(bytes),
      [`${ROOT}/deps/tray/${VERSION}/SHASUMS256.txt`]: () => new Response(`${sha(bytes)}  tray-linux-x64.tar.gz\n`),
    });
    const manager = new TrayAppManager({
      dataDir: dir, manifestUrl: MANIFEST, gitCommit: '5055741', platform: 'linux', arch: 'x64',
      fetchFn: real.fn as never, env: { DISPLAY: ':0' },
    });
    const exe = await manager.ensureInstalled();
    expect(exe).toBe(path.join(dir, 'tray', VERSION, 'ntc-tes-tray'));
    expect((await fs.stat(exe!)).mode & 0o111).not.toBe(0); // executable
    expect(await fs.readFile(path.join(dir, 'tray', VERSION, 'icon.png'), 'utf8')).toBe('png');
  });

  it('syncDesiredState(false) stops, and never throws when nothing is available', async () => {
    const { manager } = makeManager({ manifestUrl: undefined });
    await expect(manager.syncDesiredState(true)).resolves.toBeUndefined();
    await expect(manager.syncDesiredState(false)).resolves.toBeUndefined();
  });
});
