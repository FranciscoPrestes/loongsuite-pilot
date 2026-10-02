import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve('deploy/ntc/install.sh');
const KEY = `ntcp_${'a'.repeat(40)}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const INSTALLER = `#!/usr/bin/env bash
echo "$@" > "$T_MARK/installer-args"
env | grep -c ntcp_ > "$T_MARK/installer-keycount" || true
`;
const PKG = 'fake-package-bytes';
const APPLY = `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.T_MARK + '/apply-ran', JSON.stringify({ args: process.argv.slice(2), hasKey: !!process.env.NTC_PILOT_CHAVE, canary: process.env.NTC_PILOT_CANARY ?? '' }));
`;

let server: Server;
let base: string;
let files: Record<string, string>;
let mark: string;

function buildBlob(tamper = false) {
  const sums = `${sha(INSTALLER)}  installer.sh\n${sha(APPLY)}  apply-config.mjs\n`;
  files = {
    '/manifest/stable.txt': `version=1.2.0-ntc.1\npackage_url=${base}/pkg/stable.tgz\nsha256=${sha(PKG)}\ngit_commit=abc\n`,
    '/manifest/canary.txt': `version=1.3.0-ntc.1\npackage_url=${base}/pkg/canary.tgz\nsha256=${sha(PKG)}\ngit_commit=def\n`,
    '/pkg/stable.tgz': PKG,
    '/pkg/canary.tgz': PKG,
  };
  for (const v of ['1.2.0-ntc.1', '1.3.0-ntc.1']) {
    files[`/releases/${v}/installer.sh`] = tamper ? `${INSTALLER}# evil\n` : INSTALLER;
    files[`/releases/${v}/apply-config.mjs`] = APPLY;
    files[`/releases/${v}/SHA256SUMS`] = sums;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); });
beforeEach(() => { buildBlob(); mark = mkdtempSync(join(tmpdir(), 'ntc-mark-')); });

function run(env: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), 'ntc-home-'));
  return new Promise<{ code: number | null; out: string }>((resolveRun) => {
    // detached: own session, so the child has no controlling terminal and /dev/tty cannot be opened.
    const child = spawn('bash', [SCRIPT], {
      detached: true,
      env: {
        PATH: process.env.PATH ?? '', HOME: home, T_MARK: mark,
        NTC_PILOT_BLOB_URL: base, NTC_PILOT_SKIP_RESTART: '1', NTC_PILOT_ALLOW_LOOPBACK_HTTP: '1',
        NTC_PILOT_TTY: join(tmpdir(), 'ntc-no-such-tty'),
        ...env,
      },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolveRun({ code, out }));
  });
}
const ok = { NTC_PILOT_CHAVE: KEY, NTC_PILOT_EMAIL: 'a@b' };

describe('deploy/ntc/install.sh', () => {
  it('happy path: installer gets the expected args and never the key', async () => {
    const r = await run(ok);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Configurando o SDLC NTConsult e o coletor de métricas.');
    const args = readFileSync(join(mark, 'installer-args'), 'utf8').trim();
    expect(args).toMatch(/^install --version 1\.2\.0-ntc\.1 --package-url file:\/\/\S+\/loongsuite-pilot\.tar\.gz --all-agents --userId a@b --collect-log false --interceptor-mode all$/);
    expect(args).not.toContain('ntcp_');
    expect(readFileSync(join(mark, 'installer-keycount'), 'utf8').trim()).toBe('0');
    const apply = JSON.parse(readFileSync(join(mark, 'apply-ran'), 'utf8'));
    expect(apply.hasKey).toBe(true);
    expect(apply.args).toContain('--allow-loopback-http');
    expect(r.out).not.toContain(KEY);
  });

  it('tampered installer aborts before running anything', async () => {
    buildBlob(true);
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
    expect(existsSync(join(mark, 'apply-ran'))).toBe(false);
  });

  it('missing key aborts naming NTC_PILOT_CHAVE', async () => {
    const r = await run({});
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('NTC_PILOT_CHAVE');
  });

  it('without NTC_PILOT_CHAVE and without a terminal the prompt is skipped and the old error stays', async () => {
    const r = await run({ NTC_PILOT_TTY: '' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('defina NTC_PILOT_CHAVE');
    expect(r.out).not.toContain('Chave NTConsult (ntcp_...)');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('prompts for the key on the terminal when it is not in the environment', async () => {
    const tty = join(mark, 'fake-tty');
    writeFileSync(tty, `${KEY}\n`);
    const r = await run({ NTC_PILOT_TTY: tty, NTC_PILOT_EMAIL: 'a@b' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Chave NTConsult (ntcp_...)');
    expect(r.out).not.toContain(KEY);
    expect(readFileSync(join(mark, 'installer-args'), 'utf8')).not.toContain('ntcp_');
    expect(readFileSync(join(mark, 'installer-keycount'), 'utf8').trim()).toBe('0');
    expect(JSON.parse(readFileSync(join(mark, 'apply-ran'), 'utf8')).hasKey).toBe(true);
  });

  it('a malformed key typed at the prompt is rejected without echoing it', async () => {
    const tty = join(mark, 'fake-tty');
    writeFileSync(tty, 'digitei-errado\n');
    const r = await run({ NTC_PILOT_TTY: tty });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('digitei-errado');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('the environment variable wins over the terminal (no prompt)', async () => {
    const tty = join(mark, 'fake-tty');
    writeFileSync(tty, 'ignored\n');
    const r = await run({ ...ok, NTC_PILOT_TTY: tty });
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain('Chave NTConsult (ntcp_...)');
  });

  it('invalid key aborts without echoing the value', async () => {
    const r = await run({ NTC_PILOT_CHAVE: 'segredo-invalido-123' });
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain('segredo-invalido-123');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('canary channel reads canary.txt and flags apply-config', async () => {
    const r = await run({ ...ok, NTC_PILOT_CHANNEL: 'canary' });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(mark, 'installer-args'), 'utf8')).toContain('--version 1.3.0-ntc.1');
    expect(JSON.parse(readFileSync(join(mark, 'apply-ran'), 'utf8')).canary).toBe('1');
  });

  it('dry run executes nothing', async () => {
    const r = await run({ ...ok, NTC_PILOT_DRY_RUN: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('1.2.0-ntc.1');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
    expect(existsSync(join(mark, 'apply-ran'))).toBe(false);
  });

  it('omits --userId when no email is given', async () => {
    const r = await run({ NTC_PILOT_CHAVE: KEY });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(mark, 'installer-args'), 'utf8')).not.toContain('--userId');
  });

  it('refuses a non-https blob without the loopback flag, before any fetch', async () => {
    const r = await run({ ...ok, NTC_PILOT_BLOB_URL: 'http://example.test/pilot' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('https');
    const r2 = await run({ ...ok, NTC_PILOT_ALLOW_LOOPBACK_HTTP: '', NTC_PILOT_BLOB_URL: base });
    expect(r2.code).not.toBe(0);
    const r3 = await run({ ...ok, NTC_PILOT_BLOB_URL: 'http://example.test/pilot' });
    expect(r3.code).not.toBe(0);
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('rejects a loopback lookalike with userinfo even when the loopback flag is set', async () => {
    const r = await run({ ...ok, NTC_PILOT_BLOB_URL: 'http://localhost:80@evil.test/pilot' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('https');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('restart runs without the key in its environment', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ntc-home-'));
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    const stub = join(home, '.local', 'bin', 'loongsuite-pilot');
    writeFileSync(stub, '#!/usr/bin/env bash\necho "$1" >> "$T_MARK/cli-calls"\nenv | grep -c ntcp_ >> "$T_MARK/cli-keycount" || true\n');
    chmodSync(stub, 0o755);
    const r = await run({ ...ok, HOME: home, NTC_PILOT_SKIP_RESTART: '' });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(mark, 'cli-calls'), 'utf8')).toContain('restart');
    const counts = readFileSync(join(mark, 'cli-keycount'), 'utf8').trim().split('\n');
    expect(counts.every((c) => c === '0')).toBe(true);
  });

  it.each(['.', '..'])('rejects the dot-segment version %j before fetching the release', async (v) => {
    files['/manifest/stable.txt'] = `version=${v}\npackage_url=${base}/pkg/stable.tgz\nsha256=${sha(PKG)}\n`;
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('versao invalida');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('refuses a non-https package_url from the manifest', async () => {
    files['/manifest/stable.txt'] = `version=1.2.0-ntc.1\npackage_url=http://example.test/p.tgz\nsha256=${sha(PKG)}\n`;
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('package_url');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('aborts when the package sha256 does not match the manifest', async () => {
    files['/pkg/stable.tgz'] = 'other-bytes';
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('pacote');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('aborts with a clear message when SHA256SUMS lacks an entry', async () => {
    files['/releases/1.2.0-ntc.1/SHA256SUMS'] = `${sha(INSTALLER)}  installer.sh\n`;
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('ausente em SHA256SUMS');
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
  });

  it('tampered apply-config.mjs aborts before executing anything', async () => {
    files['/releases/1.2.0-ntc.1/apply-config.mjs'] = `${APPLY}// evil\n`;
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(mark, 'installer-args'))).toBe(false);
    expect(existsSync(join(mark, 'apply-ran'))).toBe(false);
  });

  it('manifest missing a field gives a clear message', async () => {
    files['/manifest/stable.txt'] = 'version=1.2.0-ntc.1\n';
    const r = await run(ok);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('incompleto');
  });
});
