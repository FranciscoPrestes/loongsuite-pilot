import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const installerSh = read('deploy/installer-opensource.sh');
const installerPs1 = read('deploy/installer-opensource.ps1');
const mirror = read('tools/ntc-release/mirror-node.sh');
const build = read('tools/ntc-release/build-node-modules.sh');

describe('installer name patterns (source of truth)', () => {
  it('.sh expects node-v<ver>-<os>-<arch>.<ext> and node-modules-<os>-<arch>.tar.gz', () => {
    expect(installerSh).toContain('archive="node-v${NODE_VERSION}-${os}-${arch}.${ext}"');
    expect(installerSh).toContain('archive="node-modules-${os}-${arch}.tar.gz"');
    expect(installerSh).toContain('ext="tar.gz"');
    expect(installerSh).toContain('ext="zip"');
  });
  it('.ps1 expects the same names with Os=win Arch=x64', () => {
    expect(installerPs1).toContain('"node-v$($script:NODE_VERSION)-$($platform.Os)-$($platform.Arch).zip"');
    expect(installerPs1).toContain('"node-modules-$($platform.Os)-$($platform.Arch).tar.gz"');
    expect(installerPs1).toMatch(/Os = "win"; Arch = "x64"/);
  });
  it('.sh platform tuples are darwin|linux|win x arm64|x64', () => {
    for (const t of ['os="darwin"', 'os="linux"', 'os="win"', 'arch="arm64"', 'arch="x64"']) {
      expect(installerSh).toContain(t);
    }
  });
});

describe('mirror-node.sh', () => {
  it('produces node archives with the installer naming', () => {
    expect(mirror).toContain('node-v${VERSION}-${os_arch}.tar.gz');
    expect(mirror).toContain('node-v${VERSION}-win-x64.zip');
    for (const t of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']) {
      expect(mirror).toContain(t);
    }
  });
  it('downloads from nodejs.org/dist and verifies against SHASUMS256.txt', () => {
    expect(mirror).toContain('https://nodejs.org/dist/v${VERSION}');
    expect(mirror).toContain('SHASUMS256.txt');
  });
  it('is strict bash', () => expect(mirror).toMatch(/set -euo pipefail/));
});

describe('build-node-modules.sh', () => {
  it('produces node-modules-<os>-<arch>.tar.gz like the installer', () => {
    expect(build).toContain('node-modules-${OS}-${ARCH}.tar.gz');
    expect(build).toContain('SHASUMS256.txt.${OS}-${ARCH}');
  });
  it('accepts exactly the installer platform vocabulary', () => {
    expect(build).toMatch(/darwin\|linux\|win/);
    expect(build).toMatch(/x64\|arm64/);
  });
  it('installs prod deps without optional and checks the sqlite shim and builtin', () => {
    expect(build).toContain('npm ci --omit=dev --omit=optional');
    expect(build).toContain("require('sqlite3')");
    expect(build).toContain("require('node:sqlite')");
    expect(build).not.toContain('zstd-napi');
  });
  it('is strict bash and portable (no GNU-only flags)', () => {
    expect(build).toMatch(/set -euo pipefail/);
    expect(build).toContain('tar -czf');
    expect(build).not.toMatch(/sha256sum -b|--sort=|--owner/);
  });
});

// ---- behavioural tests with stubbed curl / npm / node (no network) ----
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readdirSync, readFileSync as rf } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VER = '22.22.2';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sh = (p: string, body: string) => { writeFileSync(p, `#!/bin/bash\n${body}\n`); chmodSync(p, 0o755); };

function makeStubs(nodeVersion = `v${VER}`) {
  const dir = mkdtempSync(join(tmpdir(), 'ntc-stub-'));
  const bin = join(dir, 'bin');
  const fix = join(dir, 'fix');
  mkdirSync(bin); mkdirSync(fix);
  sh(join(bin, 'curl'), `out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
f="${fix}/$(basename "$url")"; [ -f "$f" ] || exit 22; cp "$f" "$out"`);
  sh(join(bin, 'npm'), `mkdir -p node_modules/pkg && echo ok > node_modules/pkg/index.js`);
  sh(join(bin, 'node'), `if [ "$1" = "-v" ]; then echo ${nodeVersion}; exit 0; fi; exit 0`);
  return { dir, bin, fix };
}
const run = (script: string, args: string[], bin: string) =>
  spawnSync('bash', [resolve(root, script), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

const NAMES = [`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`].map((t) => `node-v${VER}-${t}.tar.gz`)
  .concat(`node-v${VER}-win-x64.zip`);

function seedMirror(fix: string, corrupt?: string) {
  const lines: string[] = [];
  for (const n of NAMES) {
    const content = `archive ${n}`;
    writeFileSync(join(fix, n), n === corrupt ? 'tampered' : content);
    lines.push(`${sha(content)}  ${n}`);
  }
  writeFileSync(join(fix, 'SHASUMS256.txt'), lines.join('\n') + '\n');
}

describe('mirror-node.sh behaviour (stubbed curl)', () => {
  it('places all archives and SHASUMS256.txt', () => {
    const s = makeStubs(); seedMirror(s.fix);
    const dest = join(s.dir, 'out');
    const r = run('tools/ntc-release/mirror-node.sh', [VER, dest], s.bin);
    expect(r.status).toBe(0);
    expect(readdirSync(join(dest, VER)).sort()).toEqual([...NAMES, 'SHASUMS256.txt'].sort());
  });
  it('checksum mismatch: non-zero and nothing placed', () => {
    const s = makeStubs(); seedMirror(s.fix, NAMES[4]);
    const dest = join(s.dir, 'out');
    const r = run('tools/ntc-release/mirror-node.sh', [VER, dest], s.bin);
    expect(r.status).not.toBe(0);
    expect(readdirSync(join(dest, VER))).toEqual([]);
  });
  it('refuses to overwrite a differing file and places nothing else', () => {
    const s = makeStubs(); seedMirror(s.fix);
    const dest = join(s.dir, 'out');
    mkdirSync(join(dest, VER), { recursive: true });
    writeFileSync(join(dest, VER, NAMES[0]), 'different');
    const r = run('tools/ntc-release/mirror-node.sh', [VER, dest], s.bin);
    expect(r.status).not.toBe(0);
    expect(rf(join(dest, VER, NAMES[0]), 'utf8')).toBe('different');
    expect(readdirSync(join(dest, VER))).toEqual([NAMES[0]]);
  });
  it('rejects a malicious version with exit 2 and writes nothing outside dest', () => {
    const s = makeStubs(); seedMirror(s.fix);
    const dest = join(s.dir, 'out');
    const r = run('tools/ntc-release/mirror-node.sh', ['2/../../x.1.1', dest], s.bin);
    expect(r.status).toBe(2);
    expect(existsSync(dest)).toBe(false);
  });
});

describe('build-node-modules.sh behaviour (stubbed npm/node)', () => {
  function pkg(s: { dir: string }) {
    const p = join(s.dir, 'pkg'); mkdirSync(p);
    writeFileSync(join(p, 'package.json'), '{}'); writeFileSync(join(p, 'package-lock.json'), '{}');
    return p;
  }
  it('produces a tarball rooted at node_modules/ and an installer-compatible SHASUMS line', () => {
    const s = makeStubs(); const p = pkg(s); const dest = join(s.dir, 'dest');
    const r = run('tools/ntc-release/build-node-modules.sh', ['linux', 'x64', '1.2.0-ntc.1', dest, p], s.bin);
    expect(r.status).toBe(0);
    const name = 'node-modules-linux-x64.tar.gz';
    const list = spawnSync('tar', ['-tzf', join(dest, name)], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(list.every((l) => l === 'node_modules' || l.startsWith('node_modules/'))).toBe(true);
    const line = rf(join(dest, 'SHASUMS256.txt.linux-x64'), 'utf8').trim();
    expect(line).toBe(`${sha(rf(join(dest, name)))}  ${name}`);
    expect(line).toMatch(new RegExp(`[[:space:]][*]?${name}$`.replace('[[:space:]]', '\\s')));
  });
  it('rejects bad app versions with exit 2', () => {
    const s = makeStubs(); const p = pkg(s);
    for (const v of ['.', '..', '2/../../x', 'a b']) {
      const r = run('tools/ntc-release/build-node-modules.sh', ['linux', 'x64', v, join(s.dir, 'd'), p], s.bin);
      expect(r.status).toBe(2);
    }
    expect(existsSync(join(s.dir, 'd'))).toBe(false);
  });
  it('fails when the running node is not the expected version', () => {
    const s = makeStubs('v20.0.0'); const p = pkg(s); const dest = join(s.dir, 'dest');
    const r = run('tools/ntc-release/build-node-modules.sh', ['linux', 'x64', '1.0.0', dest, p], s.bin);
    expect(r.status).toBe(1);
    expect(existsSync(join(dest, 'node-modules-linux-x64.tar.gz'))).toBe(false);
  });
  it('requires a package dir with package.json and package-lock.json', () => {
    const s = makeStubs();
    expect(run('tools/ntc-release/build-node-modules.sh', ['linux', 'x64', '1.0.0', join(s.dir, 'd')], s.bin).status).toBe(2);
    const empty = join(s.dir, 'empty'); mkdirSync(empty);
    expect(run('tools/ntc-release/build-node-modules.sh', ['linux', 'x64', '1.0.0', join(s.dir, 'd'), empty], s.bin).status).toBe(2);
  });
});
