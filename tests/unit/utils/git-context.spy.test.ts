import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Call { cmd: string; args: string[]; options: { timeout: number; killSignal: string; maxBuffer: number } }
const h = vi.hoisted(() => ({ calls: [] as any[], clock: 1_800_000_000_000, stepMs: 0, outputs: {} as Record<string, string> }));
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], options: any, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    h.calls.push({ cmd, args, options });
    h.clock += h.stepMs; // simulate a slow git
    const key = args.includes('--show-toplevel') ? 'top' : args.includes('--absolute-git-dir') ? 'gitdir' : args.includes('symbolic-ref') ? 'branch' : 'remote';
    const out = h.outputs[key];
    if (out === undefined) cb(Object.assign(new Error('exit 1'), { code: 1 })); else cb(null, { stdout: out, stderr: '' });
  },
}));
import { GIT_CALL_TIMEOUT_MS, GIT_CONTEXT_TTL_MS, GIT_PROBE_BUDGET_MS, inferGitContext } from '../../../src/utils/git-context.js';
import { GIT_SAFE_CONFIG } from '../../../src/utils/git-safe.js';

let n = 0;
const dirOf = () => `/virtual/repo-${n += 1}`;
const calls = (): Call[] => h.calls;
beforeEach(() => {
  h.calls.length = 0; h.stepMs = 0; h.clock = 1_800_000_000_000;
  h.outputs = { top: '/virtual/root\n', gitdir: '/virtual/root/.git\n', branch: 'refs/heads/main\n', remote: 'git@github.com:org/repo.git\n' };
  vi.spyOn(Date, 'now').mockImplementation(() => h.clock);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('git context command hardening (argv, kill signal, budget, cache)', () => {
  it('every git call carries the full shared hardening flags right after -C <dir>, and only git subcommands that read', async () => {
    await inferGitContext(dirOf());
    expect(calls().length).toBeGreaterThanOrEqual(3);
    for (const call of calls()) {
      expect(call.cmd).toBe('git');
      expect(call.args.slice(0, 1)).toEqual(['-C']);
      expect(call.args.slice(2, 2 + GIT_SAFE_CONFIG.length)).toEqual([...GIT_SAFE_CONFIG]);
      expect(['rev-parse', 'symbolic-ref', 'config']).toContain(call.args[2 + GIT_SAFE_CONFIG.length]);
    }
    // The individually load-bearing flags, spelled out so removing any one is visible.
    const flags = calls()[0]!.args.join(' ');
    for (const flag of ['--no-optional-locks', 'core.hooksPath=', 'core.fsmonitor=false', 'core.untrackedCache=false']) expect(flags).toContain(flag);
  });

  it('kills a timed-out git with SIGKILL, with a bounded buffer and a per-call cap', async () => {
    await inferGitContext(dirOf());
    for (const call of calls()) {
      expect(call.options.killSignal).toBe('SIGKILL');
      expect(call.options.timeout).toBeLessThanOrEqual(GIT_CALL_TIMEOUT_MS);
      expect(call.options.timeout).toBeGreaterThan(0);
      expect(call.options.maxBuffer).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it('shares one time budget: a slow git shrinks later timeouts and finally stops further calls', async () => {
    h.stepMs = 1000;
    await inferGitContext(dirOf());
    const timeouts = calls().map(c => c.options.timeout);
    expect(timeouts[0]).toBe(GIT_CALL_TIMEOUT_MS);
    expect(timeouts.every((t, i) => i === 0 || t <= timeouts[i - 1]!)).toBe(true);
    expect(timeouts.some(t => t < GIT_CALL_TIMEOUT_MS)).toBe(true);
    // Total allowed time never exceeds the probe budget (clock advanced 1 s per call).
    expect(calls().length).toBeLessThan(4);
    expect(h.clock - 1_800_000_000_000).toBeLessThanOrEqual(GIT_PROBE_BUDGET_MS + 1000);
  });

  it('caches per directory: a second probe runs no git, an expired one runs git again', async () => {
    const dir = dirOf();
    await inferGitContext(dir);
    const first = calls().length;
    expect(first).toBeGreaterThan(0);
    await inferGitContext(dir);
    expect(calls().length).toBe(first);
    h.clock += GIT_CONTEXT_TTL_MS + 1;
    await inferGitContext(dir);
    expect(calls().length).toBe(first * 2);
  });

  it('concurrent probes of one directory share a single set of git calls', async () => {
    const dir = dirOf();
    const [a, b, c] = await Promise.all([inferGitContext(dir), inferGitContext(dir), inferGitContext(dir)]);
    expect(calls().length).toBeLessThanOrEqual(4);
    expect(a).toEqual(b); expect(b).toEqual(c);
  });
});
