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
  it('installs prod deps without optional and checks native modules', () => {
    expect(build).toContain('npm ci --omit=dev --omit=optional');
    expect(build).toContain("require('sqlite3')");
    expect(build).toContain("import('zstd-napi')");
  });
  it('is strict bash and portable (no GNU-only flags)', () => {
    expect(build).toMatch(/set -euo pipefail/);
    expect(build).toContain('tar -czf');
    expect(build).not.toMatch(/sha256sum -b|--sort=|--owner/);
  });
});
