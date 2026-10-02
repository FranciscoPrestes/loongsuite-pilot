import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TOOLS = join(__dirname, '../../../tools/ntc-release');
const { checkChannels, writeChannelFiles } = await import(join(TOOLS, 'check-channels.mjs'));
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ntc-cu-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const rel = (v: string, extra = '') => ({
  version: v, package_url: `https://x.test/${v}.tgz`, sha256: 'a'.repeat(64), git_commit: 'abc1234', released_at: '2026-10-02T12:00:00Z', ...(extra ? { x: extra } : {}),
});
const env = (r: ReturnType<typeof rel>) =>
  `version=${r.version}\npackage_url=${r.package_url}\nsha256=${r.sha256}\ngit_commit=${r.git_commit}\n`;

describe('checkChannels', () => {
  const stable = rel('1.2.0-ntc.1');
  const canary = rel('1.2.0-ntc.2');
  const latest = { ...stable, canary: { ...canary, rollout_percentage: 10, hotfix_version: 0 } };

  it('is clean when the txt files agree with latest.json', () => {
    expect(checkChannels({ latest, stable: env(stable), canary: env(canary) })).toEqual([]);
    expect(checkChannels({ latest: stable, stable: env(stable), canary: null })).toEqual([]);
  });
  it('reports a drifted version', () => {
    const p = checkChannels({ latest, stable: env(rel('1.2.0-ntc.0')), canary: env(canary) });
    expect(p.join('\n')).toMatch(/stable\.txt version/);
  });
  it('reports a sha256 or url drift on the canary', () => {
    const bad = { ...canary, sha256: 'b'.repeat(64), package_url: 'https://x.test/other.tgz' };
    const p = checkChannels({ latest, stable: env(stable), canary: env(bad) });
    expect(p.join('\n')).toMatch(/canary\.txt sha256/);
    expect(p.join('\n')).toMatch(/canary\.txt package_url/);
  });
  it('reports a missing canary.txt when a canary exists', () => {
    expect(checkChannels({ latest, stable: env(stable), canary: null }).join('\n')).toMatch(/canary\.txt is missing/);
  });
  it('reports a stale canary.txt when there is no canary', () => {
    expect(checkChannels({ latest: stable, stable: env(stable), canary: env(canary) }).join('\n')).toMatch(/stale/);
  });
  it('reports a missing stable.txt', () => {
    expect(checkChannels({ latest: stable, stable: null, canary: null }).join('\n')).toMatch(/stable\.txt is missing/);
  });
});

describe('writeChannelFiles / --repair', () => {
  const stable = rel('1.2.0-ntc.1');
  const canary = rel('1.2.0-ntc.2');

  it('renders stable.txt and canary.txt from latest.json, and removes a stale canary.txt', () => {
    const latest = { ...stable, canary: { ...canary, rollout_percentage: 10, hotfix_version: 0 } };
    writeChannelFiles(latest, dir);
    expect(readFileSync(join(dir, 'manifest', 'stable.txt'), 'utf8')).toBe(env(stable));
    expect(readFileSync(join(dir, 'manifest', 'canary.txt'), 'utf8')).toBe(env(canary));
    writeChannelFiles(stable, dir);
    expect(existsSync(join(dir, 'manifest', 'canary.txt'))).toBe(false);
  });

  it('written files pass checkChannels', () => {
    const latest = { ...stable, canary: { ...canary, rollout_percentage: 10, hotfix_version: 0 } };
    writeChannelFiles(latest, dir);
    const read = (n: string) => readFileSync(join(dir, 'manifest', n), 'utf8');
    expect(checkChannels({ latest, stable: read('stable.txt'), canary: read('canary.txt') })).toEqual([]);
  });
});

function runAsync(cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, NTC_CURL_RETRY: '0', ...env } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('check-channels.mjs and assert-etag.sh against a loopback blob', () => {
  let server: Server;
  let base: string;
  let files: Record<string, { body: string; etag?: string }>;
  beforeEach(async () => {
    files = {};
    server = createServer((req, res) => {
      const f = files[(req.url ?? '').replace(/^\/pilot/, '')];
      if (!f) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, f.etag ? { ETag: f.etag } : {}); res.end(f.body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/pilot`;
  });
  afterEach(() => { server.close(); });

  it('check-channels: ok when consistent, loud failure on drift', async () => {
    const s = rel('1.2.0-ntc.1');
    files['/manifest/latest.json'] = { body: JSON.stringify(s) };
    files['/manifest/stable.txt'] = { body: env(s) };
    expect((await runAsync('node', [join(TOOLS, 'check-channels.mjs'), '--blob', base])).code).toBe(0);
    files['/manifest/canary.txt'] = { body: env(rel('1.2.0-ntc.2')) };
    const r = await runAsync('node', [join(TOOLS, 'check-channels.mjs'), '--blob', base]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Recovery/);
  });

  it('assert-etag: passes when unchanged, fails when changed or when a first release appears', async () => {
    files['/manifest/latest.json'] = { body: '{}', etag: '"e1"' };
    const run = (e: string) => runAsync('bash', [join(TOOLS, 'assert-etag.sh'), base, e]);
    expect((await run('"e1"')).code).toBe(0);
    const bad = await run('"e0"');
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/purge-unreleased/);
    expect((await run('')).code).toBe(1);
    delete files['/manifest/latest.json'];
    expect((await run('')).code).toBe(0);
  });
});

describe('upload-immutable.sh with a fake az (remote = local directory)', () => {
  let remote: string;
  let stage: string;
  const REL = 'releases/1.0.0-ntc.1';

  beforeEach(() => {
    remote = join(dir, 'remote'); stage = join(dir, 'stage');
    mkdirSync(remote); mkdirSync(join(dir, 'bin'));
    mkdirSync(join(stage, REL, 'thin'), { recursive: true });
    writeFileSync(join(stage, REL, 'a.tar.gz'), 'aaa');
    writeFileSync(join(stage, REL, 'thin', 'install.sh'), 'thin');
    writeFileSync(join(stage, REL, 'SHA256SUMS'), 'sums');
    writeFileSync(join(dir, 'bin', 'az'), `#!/bin/bash
echo "$@" >> "$AZ_LOG"
args=("$@"); name=""; file=""; ow=""
for ((i=0;i<\${#args[@]};i++)); do
  case "\${args[i]}" in --name) name="\${args[i+1]}";; --file) file="\${args[i+1]}";; --overwrite) ow="\${args[i+1]}";; esac
done
dst="$REMOTE/$name"
case "$3" in
  exists) [ -f "$dst" ] && echo true || echo false;;
  show) [ -n "$NO_MD5" ] && echo None || openssl md5 -binary "$dst" | base64;;
  download) cp "$dst" "$file";;
  upload) if [ -f "$dst" ] && [ "$ow" = false ]; then echo BlobAlreadyExists >&2; exit 1; fi; mkdir -p "$(dirname "$dst")"; cp "$file" "$dst";;
esac
`);
    chmodSync(join(dir, 'bin', 'az'), 0o755);
  });

  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(TOOLS, 'upload-immutable.sh'), stage, REL], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, NTC_STORAGE_ACCOUNT: 'a', AZURE_SUBSCRIPTION_ID: 's', AZ_LOG: join(dir, 'az.log'), REMOTE: remote, ...extra },
    });
  const uploads = () => readFileSync(join(dir, 'az.log'), 'utf8').split('\n').filter((l) => l.includes('storage blob upload'));

  it('uploads everything, SHA256SUMS last, nested files included', () => {
    expect(run().status).toBe(0);
    expect(readFileSync(join(remote, REL, 'thin', 'install.sh'), 'utf8')).toBe('thin');
    const u = uploads();
    expect(u).toHaveLength(3);
    expect(u[2]).toContain('SHA256SUMS');
    expect(u.every((l) => l.includes('--overwrite false'))).toBe(true);
  });

  it('resumes: identical existing blobs are skipped, only the missing ones are uploaded', () => {
    mkdirSync(join(remote, REL), { recursive: true });
    cpSync(join(stage, REL, 'a.tar.gz'), join(remote, REL, 'a.tar.gz'));
    expect(run().status).toBe(0);
    expect(uploads()).toHaveLength(2);
  });

  it('resumes by download+compare when the remote has no MD5', () => {
    mkdirSync(join(remote, REL), { recursive: true });
    cpSync(join(stage, REL, 'a.tar.gz'), join(remote, REL, 'a.tar.gz'));
    expect(run({ NO_MD5: '1' }).status).toBe(0);
    expect(uploads()).toHaveLength(2);
  });

  it('fails when an existing blob differs', () => {
    mkdirSync(join(remote, REL), { recursive: true });
    writeFileSync(join(remote, REL, 'a.tar.gz'), 'different');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/different content/);
    expect(existsSync(join(remote, REL, 'SHA256SUMS'))).toBe(false);
    expect(readFileSync(join(remote, REL, 'a.tar.gz'), 'utf8')).toBe('different');
  });

  it('with NO_MD5 a differing blob also fails', () => {
    mkdirSync(join(remote, REL), { recursive: true });
    writeFileSync(join(remote, REL, 'a.tar.gz'), 'different');
    expect(run({ NO_MD5: '1' }).status).toBe(1);
  });
});

describe('purge-unreleased.sh with fake az and git', () => {
  const V = '1.2.0-ntc.3';
  let server: Server;
  let base: string;
  let latest: unknown;

  beforeEach(async () => {
    latest = undefined;
    server = createServer((_req, res) => {
      if (latest === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { ETag: '"e"' }); res.end(JSON.stringify(latest));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/pilot`;
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'az'), `#!/bin/bash
echo "$@" >> "$AZ_LOG"
case "$3" in
  list) for a in "$@"; do case "$a" in releases/*|deps/*) prefix="$a";; esac; done
        grep "^$prefix" "$BLOBS" || true;;
esac
`);
    writeFileSync(join(dir, 'bin', 'git'), '#!/bin/bash\n[ -n "$TAGGED" ] && echo "abc\trefs/tags/ntc-v1.2.0-ntc.3"\nexit 0\n');
    for (const f of ['az', 'git']) chmodSync(join(dir, 'bin', f), 0o755);
    writeFileSync(join(dir, 'blobs.txt'), `releases/${V}/a.tar.gz\nreleases/${V}/SHA256SUMS\ndeps/node-modules/${V}/x.tar.gz\nreleases/9.9.9-ntc.1/keep\n`);
  });
  afterEach(() => { server.close(); });

  const purge = (args: string[], extra: Record<string, string> = {}) =>
    runAsync('bash', [join(TOOLS, 'purge-unreleased.sh'), ...args], {
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`, NTC_STORAGE_ACCOUNT: 'a', AZURE_SUBSCRIPTION_ID: 's',
      NTC_BLOB_BASE_URL: base, AZ_LOG: join(dir, 'az.log'), BLOBS: join(dir, 'blobs.txt'), ...extra,
    });
  const azLog = () => (existsSync(join(dir, 'az.log')) ? readFileSync(join(dir, 'az.log'), 'utf8') : '');

  it('refuses a bad version', async () => {
    expect((await purge(['1.2.0'])).code).toBe(2);
  });

  it('refuses when latest.json references the version as canary or stable', async () => {
    latest = { version: '1.2.0-ntc.1', canary: { version: V } };
    const r = await purge([V, '--yes']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/latest\.json references/);
    latest = { version: V };
    expect((await purge([V, '--yes'])).code).toBe(1);
    expect(azLog()).not.toMatch(/delete/);
  });

  it('refuses when the tag exists on origin', async () => {
    latest = { version: '1.2.0-ntc.1' };
    const r = await purge([V, '--yes'], { TAGGED: '1' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/tag ntc-v1\.2\.0-ntc\.3 exists/);
    expect(azLog()).not.toMatch(/delete/);
  });

  it('lists without deleting when --yes is absent (first release: no latest.json)', async () => {
    const r = await purge([V]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`releases/${V}/a.tar.gz`);
    expect(r.stdout).toContain(`deps/node-modules/${V}/x.tar.gz`);
    expect(r.stdout).not.toContain('keep');
    expect(r.stdout).toMatch(/dry listing/);
    expect(azLog()).not.toMatch(/delete/);
  });

  it('deletes exactly the listed blobs with --yes', async () => {
    latest = { version: '1.2.0-ntc.1' };
    const r = await purge([V, '--yes']);
    expect(r.code).toBe(0);
    const dels = azLog().split('\n').filter((l) => l.includes('storage blob delete'));
    expect(dels).toHaveLength(3);
    expect(dels.every((l) => l.includes('--auth-mode login'))).toBe(true);
    expect(azLog()).not.toContain('keep');
  });
});
