import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ValidatedEventRecorder, inspectValidatedEvent, VALIDATED_EVENT_FILE } from '../../../src/analytics/validated-event.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c8-evidence-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const file = () => path.join(dir, ...VALIDATED_EVENT_FILE);
const nowMs = 1_800_000_000_000;
const entry = (over: Partial<AgentActivityEntry> = {}) => ({ time_unix_nano: String((nowMs - 1000) * 1_000_000), 'event.id': 'e', 'user.id': 'u', 'event.name': 'tool.call',
  'gen_ai.session.id': 's', 'gen_ai.agent.type': 'claude-code', 'gen_ai.provider.name': 'x', ...over }) as AgentActivityEntry;
const read = async () => JSON.parse(await fs.readFile(file(), 'utf8'));

describe('validated event evidence', () => {
  it('records only structurally valid native events and throttles writes', async () => {
    let clock = nowMs; const rec = new ValidatedEventRecorder(dir, () => clock);
    await rec.record(entry({ 'event.id': '' })); await rec.record(entry({ 'ntconsult.analytics.kind': 'hook_health' }));
    await expect(fs.stat(file())).rejects.toThrow();
    await rec.record(entry());
    expect(await read()).toEqual({ at: nowMs - 1000, harnessId: 'claude-code' });
    clock += 1000; await rec.record(entry({ time_unix_nano: String((clock - 10) * 1_000_000) }));
    expect((await read()).at).toBe(nowMs - 1000); // within the throttle window
    clock += 6000; await rec.record(entry({ time_unix_nano: String((clock - 10) * 1_000_000) }));
    expect((await read()).at).toBe(clock - 10);
  });

  it('inspect accepts a recent marker, rejects a stale or future one, and waits for a late one inside the deadline', async () => {
    const write = (at: number) => fs.mkdir(path.dirname(file()), { recursive: true }).then(() => fs.writeFile(file(), JSON.stringify({ at, harnessId: 'h' })));
    let clock = nowMs; const sleep = async (ms: number) => { clock += ms; if (clock >= nowMs + 500) await write(clock); };
    const signal = new AbortController().signal;
    await write(nowMs - 10_000);
    expect(await inspectValidatedEvent(dir, signal, { now: () => clock, sleep })).toBe(true);
    await write(nowMs - 600_000);
    clock = nowMs; // stale marker: nothing newer arrives before the deadline (sleep is inert here)
    expect(await inspectValidatedEvent(dir, signal, { now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 300 })).toBe(false);
    await write(nowMs + 60_000);
    clock = nowMs;
    expect(await inspectValidatedEvent(dir, signal, { now: () => clock, sleep: async ms => { clock += ms; }, deadlineMs: 300 })).toBe(false);
    await write(nowMs - 600_000); clock = nowMs;
    expect(await inspectValidatedEvent(dir, signal, { now: () => clock, sleep, deadlineMs: 1800 })).toBe(true); // arrives during the window
  });

  it('inspect stops immediately when aborted', async () => {
    const ac = new AbortController(); ac.abort();
    expect(await inspectValidatedEvent(dir, ac.signal)).toBe(false);
  });
});
