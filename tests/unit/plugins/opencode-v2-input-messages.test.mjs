import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regressão: no caminho v2 (session.step.started) o primeiro llm.request do turn
// precisa carregar gen_ai.input.messages; sem isso o prompt nunca chega no TES.
async function runTurn() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-v2-'));
  process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
  const { default: plugin } = await import('../../../assets/plugins/opencode/plugin.mjs');

  const hookFns = {};
  const queue = [];
  let waiter = null;
  const iter = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      while (queue.length === 0) await new Promise((r) => (waiter = r));
      return { done: false, value: queue.shift() };
    },
  };
  const push = (ev) => {
    queue.push(ev);
    waiter?.();
  };

  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'session') return { hook: async (n, fn) => { hookFns[n] = fn; } };
        if (prop === 'tool') return { hook: async () => {} };
        if (prop === 'event') return { subscribe: () => iter };
        if (prop === 'worktree') return '/tmp/oc-v2-worktree';
        return { hook: async () => {} };
      },
    },
  );

  await plugin.setup(ctx);

  const sessionID = 'ses_regressao';
  await hookFns.context({ sessionID, system: { text: 'SISTEMA-XYZ' } });
  await hookFns.prompt({ sessionID, prompt: { text: 'PROMPT-USUARIO-XYZ' } });

  const step = (n) =>
    push({
      type: 'session.step.started',
      data: { sessionID, started: Date.now(), model: { id: 'modelo' }, assistantMessageID: `m${n}` },
    });
  step(1);
  await new Promise((r) => setTimeout(r, 150));
  step(2);
  await new Promise((r) => setTimeout(r, 150));

  const dir = path.join(dataDir, 'logs', 'opencode');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  const rows = fs
    .readFileSync(path.join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const reqs = rows.filter((r) => r['event.name'] === 'llm.request');

  delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
  return reqs;
}

describe('opencode plugin v2', () => {
  // Um único turno por arquivo: o plugin só se auto-conecta uma vez por processo.
  it('anexa o prompt no primeiro llm.request do turn e não repete nos seguintes', async () => {
    const reqs = await runTurn();
    expect(reqs[0]).toBeDefined();
    expect(JSON.stringify(reqs[0]['gen_ai.input.messages'])).toContain('PROMPT-USUARIO-XYZ');
    expect(JSON.stringify(reqs[0]['gen_ai.system_instructions'])).toContain('SISTEMA-XYZ');
    expect(reqs[1]).toBeDefined();
    expect(reqs[1]['gen_ai.input.messages']).toBeUndefined();
  });
});
