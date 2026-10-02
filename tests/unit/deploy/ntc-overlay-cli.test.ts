import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';

const OVERLAY = resolve('deploy/ntc/overlay.mjs');
const BLOB = 'https://stntconsultpilot.blob.core.windows.net/pilot';
const OLD = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com';

let stage: string;
let out: string;

function run(args: string[]) {
  return spawnSync('node', [OVERLAY, ...args], { encoding: 'utf8' });
}
const full = () => ['--stage', stage, '--blob', BLOB, '--installers-out', out];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'ntc-overlay-'));
  stage = join(root, 'pkg');
  out = join(root, 'installers');
  mkdirSync(join(stage, 'dist'), { recursive: true });
  mkdirSync(join(stage, 'scripts', 'e2e'), { recursive: true });
  writeFileSync(join(stage, 'scripts', 'e2e', 'x.mjs'), 'dev only');
});

describe('overlay.mjs CLI', () => {
  it('rewrites staged text, writes installers, drops scripts/e2e, exits 0', () => {
    writeFileSync(join(stage, 'dist', 'u.js'), `const U = '${OLD}/loongsuite-pilot/deps/node';`);
    const r = run(full());
    expect(r.status).toBe(0);
    expect(readFileSync(join(stage, 'dist', 'u.js'), 'utf8')).toContain(`${BLOB}/deps/node`);
    expect(existsSync(join(out, 'installer.sh'))).toBe(true);
    expect(existsSync(join(out, 'installer.ps1'))).toBe(true);
    expect(existsSync(join(stage, 'scripts', 'e2e'))).toBe(false);
  });

  it('exits 1 with "path: fragment" lines when a forbidden origin is left', () => {
    const f = join(stage, 'dist', 'bad.js');
    writeFileSync(f, "const P = 'loongsuite-community-edition';");
    const r = run(full());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${f}: loongsuite-community-edition`);
  });

  it('refuses to rewrite a file that is not valid UTF-8', () => {
    const f = join(stage, 'dist', 'latin1.js');
    writeFileSync(f, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x61, 0x62, 0x63]));
    const r = run(full());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${f}: not valid UTF-8`);
  });

  it('exits non-zero when an argument is missing', () => {
    const r = run(['--stage', stage, '--blob', BLOB]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('missing --installers-out');
  });
});
