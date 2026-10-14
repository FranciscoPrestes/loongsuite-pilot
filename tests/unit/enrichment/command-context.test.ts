import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildCommandContextObservation,
  MAX_SCRIPT_DEPTH,
  resolveCommandContext,
} from '../../../src/enrichment/command-context.js';
import { job } from './fixtures.js';

// Track every attempt to cross the shell/process execution boundary. Static
// script resolution must never make it non-empty.
const shellExecuteCalls = vi.hoisted(() => [] as unknown[][]);

vi.mock('node:child_process', () => {
  const record = (...args: unknown[]): void => {
    shellExecuteCalls.push(args);
  };
  const callbackStyle = (...args: unknown[]): void => {
    record(...args);
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb(new Error('shell execution is forbidden in static resolution'));
  };
  const throwing = (...args: unknown[]): never => {
    record(...args);
    throw new Error('shell execution is forbidden in static resolution');
  };
  return {
    execFile: callbackStyle,
    exec: callbackStyle,
    execSync: throwing,
    spawn: throwing,
    spawnSync: throwing,
    fork: throwing,
    default: { execFile: callbackStyle, exec: callbackStyle, spawn: throwing },
  };
});

// Simulate a manifest that disappears during processing: realpath succeeds but
// the subsequent read fails with ENOENT (the file was deleted mid-read).
const failReadFor = vi.hoisted(() => ({ suffix: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const enoent = (): Error => {
    const err = new Error('ENOENT: simulated delete mid-read');
    (err as NodeJS.ErrnoException).code = 'ENOENT';
    return err;
  };
  const open = (async (...args: unknown[]) => {
    const target = args[0];
    if (failReadFor.suffix && typeof target === 'string' && target.endsWith(failReadFor.suffix)) throw enoent();
    return (actual.open as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.open;
  const readFile = (async (...args: unknown[]) => {
    const target = args[0];
    if (failReadFor.suffix && typeof target === 'string' && target.endsWith(failReadFor.suffix)) throw enoent();
    return (actual.readFile as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.readFile;
  return { ...actual, open, readFile };
});

let dir: string;
const signal = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-command-'));
  shellExecuteCalls.length = 0;
  failReadFor.suffix = '';
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writePackage(repo: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg));
}

describe('command context resolution', () => {
  it('static_scripts_never_execute and resolves npm scripts from manifests', async () => {
    writePackage(dir, {
      name: 'root',
      scripts: { build: 'npm run compile', compile: 'tsc -p .' },
    });

    const result = await resolveCommandContext('npm run build', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.resolvedCommand).toBe('tsc -p .');
    expect(result.scriptChain).toEqual(['build', 'compile']);
    expect(result.reason).toBeNull();
    expect(result.modulePaths).toContain('.');
  });

  it('never executes even for a direct non-script command', async () => {
    writePackage(dir, { name: 'root', scripts: {} });
    const result = await resolveCommandContext('tsc -p .', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.resolvedCommand).toBe('tsc -p .');
    expect(result.reason).toBeNull();
  });

  it('detects a script cycle without executing anything', async () => {
    writePackage(dir, { name: 'root', scripts: { a: 'npm run b', b: 'npm run a' } });
    const result = await resolveCommandContext('npm run a', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.resolvedCommand).toBeNull();
    expect(result.reason).toBe('cycle_detected');
    expect(result.scriptChain).toEqual(['a', 'b']);
  });

  it('bounds resolution depth', async () => {
    writePackage(dir, {
      name: 'root',
      scripts: {
        a: 'npm run b', b: 'npm run c', c: 'npm run d', d: 'npm run e',
        e: 'npm run f', f: 'npm run g', g: 'tsc',
      },
    });
    const result = await resolveCommandContext('npm run a', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.reason).toBe('depth_exceeded');
    expect(result.scriptChain.length).toBeLessThanOrEqual(MAX_SCRIPT_DEPTH);
  });

  it('reports a missing script', async () => {
    writePackage(dir, { name: 'root', scripts: { build: 'tsc' } });
    const result = await resolveCommandContext('npm run missing', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.resolvedCommand).toBeNull();
    expect(result.reason).toBe('script_not_found');
  });

  it('resolves scripts across monorepo workspaces', async () => {
    writePackage(dir, { name: 'root', workspaces: ['packages/*'], scripts: { build: 'npm run compile' } });
    writePackage(path.join(dir, 'packages', 'a'), { name: 'a', scripts: { compile: 'tsc -w' } });

    const result = await resolveCommandContext('npm run build', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.resolvedCommand).toBe('tsc -w');
    expect(result.scriptChain).toEqual(['build', 'compile']);
    expect(result.modulePaths).toContain('packages/a');
  });

  it('reports manifest_unreadable when the manifest is deleted mid-read', async () => {
    writePackage(dir, { name: 'root', scripts: { build: 'tsc' } });
    failReadFor.suffix = 'package.json';

    const result = await resolveCommandContext('npm run build', dir, signal());
    expect(shellExecuteCalls).toHaveLength(0);
    expect(result.resolvedCommand).toBeNull();
    expect(result.reason).toBe('manifest_unreadable');
  });

  it('sanitizes secret-bearing command bodies before returning them', async () => {
    writePackage(dir, {
      name: 'root',
      scripts: { build: 'API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890 tsc' },
    });
    const result = await resolveCommandContext('npm run build', dir, signal());
    expect(result.resolvedCommand).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234567890');
  });

  it('builds a correlated command_context observation with a real timestamp', async () => {
    writePackage(dir, { name: 'root', scripts: { build: 'tsc' } });
    const payload = await resolveCommandContext('npm run build', dir, signal());
    const observation = buildCommandContextObservation(job(), payload);
    expect(observation.kind).toBe('command_context');
    expect(observation.payload).toEqual(payload);
    expect(observation.sourceRefs).toEqual(job().sourceRefs);
    expect(Date.parse(observation.occurredAt)).toBeGreaterThan(Date.now() - 10_000);
  });
});
