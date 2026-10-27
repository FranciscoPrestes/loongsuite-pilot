import { afterEach, describe, expect, it } from 'vitest';
import { setupV2 } from '../../../assets/plugins/opencode/v2.mjs';

// NTConsult regression: OpenCode 2.x delivers the user prompt as an inbox item of
// type "text" (not only "user"). The prompt must reach the first llm.request of the
// turn and must not be repeated on the following steps.
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

async function harness() {
  const records = [], pending = [];
  let wake, seq = 0;
  const ctx = {
    location: { directory: '/test/project' },
    session: { hook: async () => ({ dispose() {} }) },
    event: { async *subscribe({ signal }) {
      signal.addEventListener('abort', () => wake?.(), { once: true });
      while (!signal.aborted) {
        if (pending.length) yield pending.shift();
        else await new Promise(resolve => { wake = resolve; });
      }
    } },
  };
  cleanups.push(await setupV2(ctx, {
    common: (id, state) => ({ 'gen_ai.session.id': id, 'gen_ai.turn.id': state.currentTurn?.turnId }),
    writeRecord: record => records.push(record), writeError() {},
    inferProviderName: id => id, recordUpstreamEnvOnce() {},
  }));
  const send = async (type, data = {}) => {
    pending.push({ id: `evt_${++seq}`, type, created: 1750000000000 + seq * 10, data: { sessionID: 'ses_a', ...data } });
    wake?.(); await new Promise(resolve => setTimeout(resolve, 0));
  };
  return { records, send };
}

const step = (id) => ({ assistantMessageID: id, agent: 'build', model: { id: 'm', providerID: 'openai' }, started: 1750000000000 });

describe('OpenCode V2 prompt capture (text inbox items)', () => {
  it('attaches the prompt to the first llm.request only', async () => {
    const h = await harness();
    await h.send('session.inbox.enqueued', { inboxID: 'p1', item: { type: 'text', payload: { text: 'ola mundo' } } });
    await h.send('session.inbox.delivered', { inboxID: 'p1' });
    await h.send('session.step.started', step('s1'));
    await h.send('session.step.ended', { assistantMessageID: 's1', finish: 'tool-calls' });
    await h.send('session.step.started', step('s2'));
    const prompts = h.records.filter(r => JSON.stringify(r['gen_ai.input.messages_delta'] ?? '').includes('ola mundo'));
    expect(prompts.length).toBeGreaterThan(0);
    const requests = h.records.filter(r => r['event.name'] === 'llm.request');
    expect(JSON.stringify(requests[0]['gen_ai.input.messages_delta'])).toContain('ola mundo');
    expect(JSON.stringify(requests[1]['gen_ai.input.messages_delta'] ?? '')).not.toContain('ola mundo');
  });
});
