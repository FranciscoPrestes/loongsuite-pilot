import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const PLUGIN_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../assets/plugins/opencode/plugin.mjs',
);

const SESSION_ID = 'ses_v2prompt';

async function bootV2() {
  const capture = [];
  const hooks = {};
  vi.resetModules();
  vi.spyOn(fs, 'appendFileSync').mockImplementation((_target, data) => {
    try { capture.push(JSON.parse(String(data))); } catch { /* non-record write */ }
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'openSync').mockImplementation(() => { throw new Error('no lock'); });
  const plugin = (await import(PLUGIN_PATH)).default;
  await plugin.setup({
    worktree: os.tmpdir(),
    session: { hook: async (name, fn) => { hooks[`session.${name}`] = fn; } },
    tool: { hook: async (name, fn) => { hooks[`tool.${name}`] = fn; } },
  });
  return { capture, hooks };
}

const userPrompts = (capture) =>
  capture.filter(r => r['gen_ai.input.messages_delta']?.some(m => m.role === 'user'));

describe('opencode plugin v2 prompt capture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('registers a session prompt hook', async () => {
    const { hooks } = await bootV2();
    expect(typeof hooks['session.prompt']).toBe('function');
  });

  it('records the user prompt from the prompt hook', async () => {
    const { capture, hooks } = await bootV2();
    await hooks['session.prompt']({
      sessionID: SESSION_ID,
      messageID: 'msg_1',
      prompt: { text: 'ola mundo' },
    });
    const prompts = userPrompts(capture);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]['gen_ai.session.id']).toBe(SESSION_ID);
    expect(prompts[0]['gen_ai.input.messages_delta'][0].parts[0].content).toBe('ola mundo');
  });

  it('opens a new turn for each prompt', async () => {
    const { capture, hooks } = await bootV2();
    await hooks['session.prompt']({ sessionID: SESSION_ID, messageID: 'm1', prompt: { text: 'um' } });
    await hooks['session.prompt']({ sessionID: SESSION_ID, messageID: 'm2', prompt: { text: 'dois' } });
    const turns = userPrompts(capture).map(r => r['gen_ai.turn.id']);
    expect(new Set(turns).size).toBe(2);
  });

  it('ignores a prompt event without text', async () => {
    const { capture, hooks } = await bootV2();
    await hooks['session.prompt']({ sessionID: SESSION_ID, messageID: 'm1', prompt: {} });
    expect(userPrompts(capture)).toHaveLength(0);
  });
});
