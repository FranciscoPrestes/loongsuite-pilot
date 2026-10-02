import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(__dirname, '../../../tools/ntc-release/cli.mjs');
const SHA = 'b'.repeat(64);
let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ntc-cli-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

const manifestArgs = (action: string, version: string, prev: string, extra: string[] = []) => [
  'manifest', '--action', action, '--prev', prev, '--version', version,
  '--git-commit', 'abc1234', '--package-url', `https://example.test/${version}.tgz`,
  '--sha256', SHA, '--released-at', '2026-10-02T12:00:00Z', '--out-dir', dir, ...extra,
];

describe('cli next-version', () => {
  it('prints the next version from a tags file', () => {
    const f = join(dir, 'tags.txt');
    writeFileSync(f, 'ntc-v1.2.0-ntc.1\nntc-v1.2.0-ntc.2\nv1.2.0\n');
    const r = run(['next-version', '--base', '1.2.0', '--tags-file', f]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('1.2.0-ntc.3\n');
  });

  it('fails on a bad base', () => {
    const f = join(dir, 'tags.txt');
    writeFileSync(f, '');
    const r = run(['next-version', '--base', '1.2', '--tags-file', f]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/X\.Y\.Z/);
  });
});

describe('cli manifest', () => {
  it('canary with no prev writes latest.json, stable.txt and canary.txt', () => {
    const r = run(manifestArgs('canary', '1.2.0-ntc.1', '-', ['--rollout', '20']));
    expect(r.status).toBe(0);
    const m = JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8'));
    expect(m.version).toBe('1.2.0-ntc.1');
    expect(m.canary).toMatchObject({ rollout_percentage: 20, hotfix_version: 0 });
    expect(readFileSync(join(dir, 'stable.txt'), 'utf8')).toContain('version=1.2.0-ntc.1');
    expect(readFileSync(join(dir, 'canary.txt'), 'utf8')).toContain('sha256=' + SHA);
  });

  it('promote with prev JSON clears canary and removes canary.txt', () => {
    run(manifestArgs('canary', '1.2.0-ntc.1', '-'));
    const prev = readFileSync(join(dir, 'latest.json'), 'utf8');
    const r = run(manifestArgs('promote', '1.2.0-ntc.1', prev));
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).canary).toBeUndefined();
    expect(existsSync(join(dir, 'canary.txt'))).toBe(false);
  });

  it('refuses a downgrade unless --allow-downgrade', () => {
    run(manifestArgs('promote', '1.2.0-ntc.5', '-'));
    const prev = readFileSync(join(dir, 'latest.json'), 'utf8');
    const bad = run(manifestArgs('promote', '1.2.0-ntc.4', prev));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/downgrade/);
    const ok = run(manifestArgs('promote', '1.2.0-ntc.4', prev, ['--allow-downgrade']));
    expect(ok.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'latest.json'), 'utf8')).version).toBe('1.2.0-ntc.4');
  });

  it('fails on a missing required flag', () => {
    const r = run(['manifest', '--action', 'promote']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/missing/);
  });
});
