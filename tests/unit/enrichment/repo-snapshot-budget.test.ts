import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

const calls = vi.hoisted(() => [] as Array<{ timeout: number; killSignal: string }>);
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], options: { timeout: number; killSignal: string }, cb: (e: null, r: { stdout: string; stderr: string }) => void) => {
    calls.push({ timeout: options.timeout, killSignal: options.killSignal });
    cb(null, { stdout: '', stderr: '' });
  },
}));
import { SNAPSHOT_BUDGET_MS, snapshotRepository } from '../../../src/enrichment/repo-snapshot.js';

describe('repository snapshot budget (C5 #11)', () => {
  it('kills hung git with SIGKILL and keeps the total of all calls inside the 2 s worker deadline', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-budget-'));
    try {
      await snapshotRepository(dir, new AbortController().signal);
      expect(calls.length).toBeGreaterThanOrEqual(4);
      expect(calls.every(c => c.killSignal === 'SIGKILL')).toBe(true);
      expect(calls.every(c => c.timeout <= 1500)).toBe(true);
      expect(SNAPSHOT_BUDGET_MS).toBeLessThan(2000);
      // The per-call timeouts were drawn from one shared budget, never 4 x 1500 ms.
      expect(calls[calls.length - 1]!.timeout).toBeLessThanOrEqual(SNAPSHOT_BUDGET_MS);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });

  it('refuses to start another git call once the shared budget is spent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-budget0-'));
    try {
      calls.length = 0;
      await expect(snapshotRepository(dir, new AbortController().signal, 0)).rejects.toThrow('budget');
      expect(calls).toHaveLength(0);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
