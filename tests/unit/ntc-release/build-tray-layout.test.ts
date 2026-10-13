import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../tools/ntc-release/build-tray.sh');
const build = readFileSync(SCRIPT, 'utf8');
const run = (args: string[]) => spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' });

describe('build-tray.sh arguments', () => {
  const dest = mkdtempSync(join(tmpdir(), 'ntc-tray-'));
  const ok = ['darwin', 'arm64', '1.2.0-ntc.6', dest];

  it('needs four arguments', () => {
    const r = run(ok.slice(0, 3));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage/);
  });
  it('rejects an unknown os or arch', () => {
    expect(run(['plan9', 'x64', '1.2.0', dest]).status).toBe(2);
    expect(run(['linux', 'mips', '1.2.0', dest]).status).toBe(2);
  });
  it('rejects a path-like or empty version', () => {
    for (const v of ['..', '.', '../x', 'a b', '']) {
      expect(run(['linux', 'x64', v, dest]).status, `version "${v}"`).toBe(2);
    }
  });
  rmSync(dest, { recursive: true, force: true });
});

describe('build-tray.sh layout', () => {
  it('is strict bash and portable (no GNU-only flags)', () => {
    expect(build).toMatch(/set -euo pipefail/);
    expect(build).toContain('tar -czf');
    expect(build).not.toMatch(/sha256sum -b|--sort=|--owner/);
  });
  it('names the archive like the node-modules ones: tray-<os>-<arch>.tar.gz', () => {
    expect(build).toContain('tray-${OS}-${ARCH}.tar.gz');
  });
  it('writes a single-line checksum fragment per platform', () => {
    expect(build).toContain('SHASUMS256.txt.${OS}-${ARCH}');
    expect(build).toMatch(/printf '%s  %s\\n'/);
  });
  it('builds with Tauri, an .app bundle on macOS and a bare binary elsewhere', () => {
    expect(build).toContain('npm ci');
    expect(build).toMatch(/tauri build --bundles app/);
    expect(build).toMatch(/tauri build --no-bundle/);
    expect(build).toContain('ntc-tes-tray.exe');
    expect(build).toContain('NT TES.app');
  });
  it('ships the icon next to the Linux binary for the desktop entry', () => {
    expect(build).toContain('icon.png');
  });
});
