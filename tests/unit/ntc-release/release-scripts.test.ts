import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOLS = join(__dirname, '../../../tools/ntc-release');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ntc-rs-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function runAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, NTC_CURL_RETRY: '0', ...env } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('fetch-manifest.sh', () => {
  let server: Server;
  let base: string;
  let respond: (res: import('node:http').ServerResponse) => void;

  beforeEach(async () => {
    server = createServer((_req, res) => respond(res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/pilot`;
  });
  afterEach(() => { server.close(); });

  const fetchIt = (mode: string, b = base) =>
    runAsync('bash', [join(TOOLS, 'fetch-manifest.sh'), b, join(dir, 'prev.json'), mode]);

  it('200: saves the body and reports the ETag', async () => {
    respond = (res) => { res.writeHead(200, { ETag: '"0xABC"' }); res.end('{"version":"1.0.0"}'); };
    const r = await fetchIt('allow-missing');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('status=existing');
    expect(r.stdout).toContain('etag="0xABC"');
    expect(readFileSync(join(dir, 'prev.json'), 'utf8')).toBe('{"version":"1.0.0"}');
  });

  it('404: first release unless mode is require', async () => {
    respond = (res) => { res.writeHead(404); res.end(); };
    const ok = await fetchIt('allow-missing');
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain('status=first');
    expect(existsSync(join(dir, 'prev.json'))).toBe(false);
    expect((await fetchIt('require')).code).toBe(1);
  });

  it('500 aborts, except in lenient mode', async () => {
    respond = (res) => { res.writeHead(500); res.end(); };
    expect((await fetchIt('allow-missing')).code).toBe(1);
    const l = await fetchIt('lenient');
    expect(l.code).toBe(0);
    expect(l.stdout).toContain('status=first');
  });

  it('connection failure aborts, except in lenient mode', async () => {
    const dead = 'http://127.0.0.1:1/pilot';
    expect((await fetchIt('allow-missing', dead)).code).toBe(1);
    expect((await fetchIt('lenient', dead)).code).toBe(0);
  });

  it('rejects a 200 without ETag or with invalid JSON', async () => {
    respond = (res) => { res.writeHead(200); res.end('{}'); };
    expect((await fetchIt('require')).code).toBe(1);
    respond = (res) => { res.writeHead(200, { ETag: '"x"' }); res.end('not json'); };
    expect((await fetchIt('require')).code).toBe(1);
  });
});

describe('publish-manifest.sh', () => {
  const env = (extra: Record<string, string> = {}) => ({
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    NTC_STORAGE_ACCOUNT: 'acct', AZURE_SUBSCRIPTION_ID: 'sub', AZ_LOG: join(dir, 'az.log'), ...extra,
  });

  function setup(opts: { canary: boolean; azScript?: string }) {
    mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'm', 'manifest'), { recursive: true });
    writeFileSync(join(dir, 'm', 'manifest', 'latest.json'), '{}');
    writeFileSync(join(dir, 'm', 'manifest', 'stable.txt'), 's');
    if (opts.canary) writeFileSync(join(dir, 'm', 'manifest', 'canary.txt'), 'c');
    writeFileSync(join(dir, 'bin', 'az'), opts.azScript ?? '#!/bin/sh\necho "$@" >> "$AZ_LOG"\n[ "$3" = exists ] && echo true\nexit 0\n');
    chmodSync(join(dir, 'bin', 'az'), 0o755);
  }
  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(TOOLS, 'publish-manifest.sh'), join(dir, 'm')], { encoding: 'utf8', env: { ...process.env, ...env(extra) } });
  const log = () => readFileSync(join(dir, 'az.log'), 'utf8').trim().split('\n');

  it('writes latest.json first with If-Match and no-cache, then the channel files', () => {
    setup({ canary: true });
    const r = run({ NTC_ETAG: '"0x1"' });
    expect(r.status).toBe(0);
    const l = log();
    expect(l).toHaveLength(3);
    expect(l[0]).toContain('--name manifest/latest.json');
    expect(l[0]).toContain('--if-match "0x1"');
    expect(l[0]).toContain('--overwrite true');
    expect(l[0]).toContain('--content-cache-control no-cache');
    expect(l[0]).toContain('--auth-mode login');
    expect(l[1]).toContain('--name manifest/stable.txt');
    expect(l[2]).toContain('--name manifest/canary.txt');
  });

  it('uses If-None-Match on a first release', () => {
    setup({ canary: true });
    run({ NTC_ETAG: '' });
    expect(log()[0]).toContain("--if-none-match *");
  });

  it('deletes canary.txt when the manifest has no canary', () => {
    setup({ canary: false });
    expect(run({ NTC_ETAG: '"0x1"' }).status).toBe(0);
    expect(log().some((x) => x.startsWith('storage blob delete') && x.includes('manifest/canary.txt'))).toBe(true);
  });

  it('aborts with a rerun message when If-Match fails, writing nothing else', () => {
    setup({ canary: true, azScript: '#!/bin/sh\necho "$@" >> "$AZ_LOG"\necho "ConditionNotMet 412" >&2\nexit 1\n' });
    const r = run({ NTC_ETAG: '"0x1"' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/purge-unreleased/);
    expect(log()).toHaveLength(1);
  });

  it('NTC_TXT_ONLY writes only the channel files and does not need latest.json', () => {
    setup({ canary: true });
    rmSync(join(dir, 'm', 'manifest', 'latest.json'));
    expect(run({ NTC_TXT_ONLY: '1' }).status).toBe(0);
    const l = log();
    expect(l).toHaveLength(2);
    expect(l.some((x) => x.includes('--name manifest/latest.json'))).toBe(false);
  });

  it('requires the account and subscription variables', () => {
    setup({ canary: true });
    expect(run({ NTC_STORAGE_ACCOUNT: '' }).status).not.toBe(0);
  });
});

describe('promote-args.mjs', () => {
  const latest = {
    version: '1.2.0-ntc.1',
    canary: { version: '1.2.0-ntc.2', git_commit: 'abc1234', package_url: 'https://x.test/p.tgz', sha256: 'a'.repeat(64), released_at: '2026-10-02T12:00:00Z', rollout_percentage: 10, hotfix_version: 0 },
  };
  const run = (v: string, obj: unknown = latest) => {
    writeFileSync(join(dir, 'l.json'), JSON.stringify(obj));
    return spawnSync(process.execPath, [join(TOOLS, 'promote-args.mjs'), '--latest', join(dir, 'l.json'), '--version', v], { encoding: 'utf8' });
  };

  it('prints the canary fields of the matching version', () => {
    const r = run('1.2.0-ntc.2');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('git_commit=abc1234\n');
    expect(r.stdout).toContain(`sha256=${'a'.repeat(64)}\n`);
  });

  it('rejects a non-canary version, a missing canary and a malformed version', () => {
    expect(run('1.2.0-ntc.1').status).toBe(1);
    expect(run('1.2.0-ntc.2', { version: '1.2.0-ntc.2' }).status).toBe(1);
    expect(run('1.2.0').status).toBe(1);
    expect(run('1.2.0-ntc.2\nx=1').status).toBe(1);
  });

  it('rejects whitespace in a field', () => {
    expect(run('1.2.0-ntc.2', { ...latest, canary: { ...latest.canary, package_url: 'https://x.test/a b' } }).status).toBe(1);
  });
});
