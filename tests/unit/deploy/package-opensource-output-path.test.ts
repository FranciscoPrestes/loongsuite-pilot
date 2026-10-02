import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '../../../deploy/package-opensource.sh');
let cwd: string;
beforeEach(() => { cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pkg-out-'))); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const resolve = (arg: string) =>
  spawnSync('bash', ['-c', `source "${SCRIPT}"; resolve_output_path "$1"`, 'x', arg], {
    cwd, encoding: 'utf8', env: { ...process.env, NTC_SOURCE_ONLY: '1' },
  });

describe('package-opensource.sh resolve_output_path', () => {
  it('makes a relative path absolute against the current directory and creates its parent', () => {
    const r = resolve('out/sub/loongsuite-pilot.tar.gz');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(join(cwd, 'out/sub/loongsuite-pilot.tar.gz'));
    expect(existsSync(join(cwd, 'out/sub'))).toBe(true);
  });

  it('keeps an absolute path unchanged', () => {
    const abs = join(cwd, 'abs', 'p.tar.gz');
    expect(resolve(abs).stdout.trim()).toBe(abs);
  });

  it('handles a bare file name', () => {
    expect(resolve('p.tar.gz').stdout.trim()).toBe(join(cwd, 'p.tar.gz'));
  });

  it('sourcing with NTC_SOURCE_ONLY=1 builds nothing', () => {
    expect(resolve('p.tar.gz').stdout).not.toMatch(/Building|Staging/);
  });
});
