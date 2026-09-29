import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { CopilotInput } from '../../../../src/inputs/copilot/copilot-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import { shutdownEvent, T0, textOnlyTurn, toJsonl, toolTurn } from '../../../fixtures/copilot/events.js';

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'copilot-root-'));
  dataDir = await mkdtemp(path.join(tmpdir(), 'copilot-data-'));
  await mkdir(path.join(root, 'session-state'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
});

async function makeInput(grace = 60_000): Promise<{ input: CopilotInput; run: () => Promise<AgentActivityEntry[]> }> {
  const store = new StateStore(path.join(dataDir, 'state.json'));
  await store.load();
  const input = new CopilotInput({
    stateStore: store, copilotRoot: root, wakeupDir: path.join(dataDir, 'wakeups'), deadSessionGraceMs: grace,
  });
  const run = async () => {
    const entries = await (input as unknown as { collect(): Promise<AgentActivityEntry[]> }).collect();
    await store.save();
    return entries;
  };
  return { input, run };
}

async function sessionFile(id: string): Promise<string> {
  const dir = path.join(root, 'session-state', id);
  await mkdir(dir, { recursive: true });
  return path.join(dir, 'events.jsonl');
}

describe('CopilotInput', () => {
  it('does not replay history that predates the first run', async () => {
    const file = await sessionFile('old');
    await writeFile(file, toJsonl(textOnlyTurn()));
    const { run } = await makeInput();
    expect(await run()).toEqual([]);
  });

  it('reads sessions created after the baseline from the start', async () => {
    const { run } = await makeInput();
    await run();
    await writeFile(await sessionFile('new'), toJsonl(textOnlyTurn()));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
    expect(entries[0]['gen_ai.session.id']).toBe('new');
  });

  it('emits appended data once and tolerates a partial trailing line', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    const full = toJsonl(toolTurn());
    const cut = full.length - 30;
    await writeFile(file, full.slice(0, cut));
    const first = await run();
    await appendFile(file, full.slice(cut));
    const second = await run();
    const all = [...first, ...second];
    const ids = all.map(e => e['event.id']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(all.map(e => e['event.name'])).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
  });

  it('emits later steps of an open interaction without duplicating earlier ones', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    const events = toolTurn();
    await writeFile(file, toJsonl(events.slice(0, 7)));
    const first = await run();
    await appendFile(file, toJsonl(events.slice(7)));
    const second = await run();
    expect(first.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response', 'tool.call', 'tool.result']);
    expect(second.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });

  it('does not duplicate entries after a restart', async () => {
    const a = await makeInput();
    await a.run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl(toolTurn()));
    const before = await a.run();
    expect(before.length).toBe(6);
    const b = await makeInput();
    expect(await b.run()).toEqual([]);
  });

  it('restarts cleanly when the transcript is truncated and rewritten smaller', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl(toolTurn()));
    await run();
    // Rewritten file is smaller than what was already consumed: restart from the top
    // and emit the new content in the same cycle that detects the shrink.
    await truncate(file, 0);
    await writeFile(file, toJsonl(textOnlyTurn()));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });

  it('emits the usage summary on shutdown and stops watching that session', async () => {
    const { run } = await makeInput();
    await run();
    const file = await sessionFile('s');
    await writeFile(file, toJsonl([
      ...textOnlyTurn(),
      shutdownEvent(T0 + 9_000, { 'model-a': { inputTokens: 5, outputTokens: 1 } }),
    ]));
    const entries = await run();
    expect(entries.filter(e => e['event.name'] === 'other')).toHaveLength(1);
    await appendFile(file, '{"type":"user.message","id":"late","timestamp":"2026-01-01T00:00:10.000Z","parentId":null,"data":{"content":"x"}}\n');
    expect(await run()).toEqual([]);
  });

  it('tolerates a missing session-state directory', async () => {
    await rm(path.join(root, 'session-state'), { recursive: true, force: true });
    const { run } = await makeInput();
    await expect(run()).resolves.toEqual([]);
  });

  it('closes a session with no growth and no live lock after the grace period', async () => {
    const { run } = await makeInput(0);
    await run();
    const file = await sessionFile('dead');
    await writeFile(file, toJsonl(textOnlyTurn()));
    await run();
    // No growth on this cycle, grace 0 and no inuse lock: the session is closed.
    await run();
    await appendFile(file, toJsonl(toolTurn().slice(2, 6)));
    expect(await run()).toEqual([]);
  });

  it('keeps watching an idle session while its lock belongs to a live process', async () => {
    const { run } = await makeInput(0);
    await run();
    const file = await sessionFile('live');
    await writeFile(path.join(path.dirname(file), `inuse.${process.pid}.lock`), String(process.pid));
    await writeFile(file, toJsonl(textOnlyTurn().slice(0, 4)));
    await run();
    await run();
    await appendFile(file, toJsonl(textOnlyTurn().slice(4)));
    const entries = await run();
    expect(entries.map(e => e['event.name'])).toEqual(['llm.request', 'llm.response']);
  });
});
