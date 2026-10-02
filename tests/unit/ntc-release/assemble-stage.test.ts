import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../tools/ntc-release/assemble-stage.mjs');
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64'];
const VERSION = '1.2.0-ntc.1';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let root: string;
let pkg: string;
let thin: string;
let nm: string;
let out: string;

const run = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const stageArgs = (extra: string[] = []) => [
  'stage', '--version', VERSION, '--pkg-dir', pkg, '--thin-dir', thin, '--out', out, ...extra,
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ntc-stage-'));
  pkg = join(root, 'pkg'); thin = join(root, 'thin'); nm = join(root, 'nm'); out = join(root, 'stage');
  for (const d of [pkg, thin, nm]) mkdirSync(d);
  for (const f of ['loongsuite-pilot.tar.gz', 'loongsuite-pilot.zip', 'installer.sh', 'installer.ps1', 'apply-config.mjs']) {
    writeFileSync(join(pkg, f), `content of ${f}`);
  }
  writeFileSync(join(thin, 'install.sh'), 'thin sh');
  writeFileSync(join(thin, 'install.ps1'), 'thin ps1');
  for (const p of PLATFORMS) {
    const name = `node-modules-${p}.tar.gz`;
    writeFileSync(join(nm, name), `archive ${p}`);
    writeFileSync(join(nm, `SHASUMS256.txt.${p}`), `${sha(`archive ${p}`)}  ${name}\n`);
  }
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('assemble-stage stage', () => {
  it('builds the layout, SHA256SUMS and prints the tarball sha', () => {
    const r = run(stageArgs(['--node-modules-dir', nm]));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(sha('content of loongsuite-pilot.tar.gz'));
    const rel = join(out, 'releases', VERSION);
    expect(readdirSync(rel).sort()).toEqual(
      ['SHA256SUMS', 'apply-config.mjs', 'installer.ps1', 'installer.sh', 'loongsuite-pilot.tar.gz', 'loongsuite-pilot.zip'],
    );
    const sums = readFileSync(join(rel, 'SHA256SUMS'), 'utf8').trim().split('\n');
    expect(sums).toHaveLength(5);
    expect(sums).toContain(`${sha('content of loongsuite-pilot.zip')}  loongsuite-pilot.zip`);
    expect(sums.join('\n')).not.toMatch(/SHA256SUMS/);
    expect(readFileSync(join(out, 'install.sh'), 'utf8')).toBe('thin sh');
    expect(readFileSync(join(out, 'install.ps1'), 'utf8')).toBe('thin ps1');
  });

  it('concatenates the five platform fragments into deps/node-modules/<v>/SHASUMS256.txt', () => {
    expect(run(stageArgs(['--node-modules-dir', nm])).status).toBe(0);
    const dir = join(out, 'deps', 'node-modules', VERSION);
    const lines = readFileSync(join(dir, 'SHASUMS256.txt'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    for (const p of PLATFORMS) {
      expect(lines).toContain(`${sha(`archive ${p}`)}  node-modules-${p}.tar.gz`);
      expect(existsSync(join(dir, `node-modules-${p}.tar.gz`))).toBe(true);
    }
  });

  it('fails when a platform is missing or a fragment does not match its archive', () => {
    rmSync(join(nm, 'node-modules-win-x64.tar.gz'));
    expect(run(stageArgs(['--node-modules-dir', nm])).stderr).toMatch(/win-x64/);
    writeFileSync(join(nm, 'node-modules-win-x64.tar.gz'), 'tampered');
    const r = run(stageArgs(['--node-modules-dir', nm]));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not match/);
  });

  it('rejects a bad version, a missing release file and unknown flags', () => {
    expect(run(['stage', '--version', '1.2', '--pkg-dir', pkg, '--thin-dir', thin, '--out', out]).status).toBe(1);
    expect(run(['stage', '--version', '../x', '--pkg-dir', pkg, '--thin-dir', thin, '--out', out]).status).toBe(1);
    rmSync(join(pkg, 'apply-config.mjs'));
    expect(run(stageArgs()).stderr).toMatch(/apply-config\.mjs/);
    expect(run(['stage', '--bogus', 'x']).stderr).toMatch(/unknown flag/);
  });

  it('works without node-modules (smoke-style stage)', () => {
    expect(run(stageArgs()).status).toBe(0);
    expect(existsSync(join(out, 'deps'))).toBe(false);
  });
});

describe('assemble-stage place-manifest', () => {
  const manifestDir = () => join(root, 'm');

  it('puts latest.json at the root and the channel files under manifest/', () => {
    mkdirSync(manifestDir());
    writeFileSync(join(manifestDir(), 'latest.json'), '{}');
    writeFileSync(join(manifestDir(), 'stable.txt'), 's');
    writeFileSync(join(manifestDir(), 'canary.txt'), 'c');
    expect(run(['place-manifest', '--manifest-dir', manifestDir(), '--out', out]).status).toBe(0);
    expect(readFileSync(join(out, 'latest.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(out, 'manifest', 'stable.txt'), 'utf8')).toBe('s');
    expect(readFileSync(join(out, 'manifest', 'canary.txt'), 'utf8')).toBe('c');
  });

  it('omits canary.txt when the manifest has none', () => {
    mkdirSync(manifestDir());
    writeFileSync(join(manifestDir(), 'latest.json'), '{}');
    writeFileSync(join(manifestDir(), 'stable.txt'), 's');
    run(['place-manifest', '--manifest-dir', manifestDir(), '--out', out]);
    expect(existsSync(join(out, 'manifest', 'canary.txt'))).toBe(false);
  });

  it('fails without latest.json', () => {
    mkdirSync(manifestDir());
    expect(run(['place-manifest', '--manifest-dir', manifestDir(), '--out', out]).status).toBe(1);
  });
});
