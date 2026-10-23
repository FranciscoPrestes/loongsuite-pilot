import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayPlugin } from '../../../assets/plugins/ccr/router-observer.mjs';

const traceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
let dataDir;

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-observer-test-')); });
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

function records() {
  const dir = path.join(dataDir, 'router', 'ccr');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : [];
}

async function plugin() {
  return createGatewayPlugin({ plugin: { config: { dataDir } }, config: {} });
}

function request(id, body = {}, headers = {}) {
  return { id, headers: { traceparent, authorization: 'Bearer DO_NOT_PERSIST', ...headers }, body };
}

describe('CCR router observer', () => {
  it('records original and upstream settings for non-streaming calls without storing secrets or content', async () => {
    const hooks = await plugin();
    const req = request('ccr-1', { model: 'virtual-model', output_config: { effort: 'high', note: 'DO_NOT_PERSIST' },
      messages: [{ content: 'DO_NOT_PERSIST' }] });
    expect(hooks.requestHooks[0].beforeAuth({ request: req })).toEqual({ ok: true });
    const result = await hooks.responseHooks[0].transformResponse({
      request: req, model: 'provider-model', targetProvider: 'openai',
      upstreamRequest: { body: { model: 'provider-model', reasoning: { effort: 'medium' } } },
      responsePayload: { id: 'response-1', model: 'reported-model', content: 'DO_NOT_PERSIST' },
    });
    expect(result).toBeUndefined();
    expect(records()).toEqual([expect.objectContaining({
      schema_version: 1, request_id: 'ccr-1', upstream_traceparent: traceparent,
      request_model: 'virtual-model', reasoning_effort: 'high', selected_model: 'provider-model',
      provider: 'openai', router_reasoning_effort: 'medium', response_id: 'response-1', response_model: 'reported-model',
    })]);
    expect(JSON.stringify(records())).not.toContain('DO_NOT_PERSIST');
  });

  it('observes fragmented streaming metadata while returning the original bytes unchanged', async () => {
    const hooks = await plugin();
    const req = request('ccr-stream', { model: 'virtual-model' });
    hooks.requestHooks[0].beforeAuth({ request: req });
    const chunks = ['event: message_start\ndata: {"type":"message_start","message":{"id":"msg-1",', '"model":"stream-model"}}\n\n', 'data: [DONE]\n\n'];
    const upstreamResponse = new Response(new ReadableStream({
      start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); },
    }), { status: 202, headers: { 'x-test': 'kept' } });
    const replaced = await hooks.streamHooks[0].transformResponse({
      request: req, model: 'routed-stream', targetProvider: 'anthropic',
      upstreamRequest: { body: { model: 'routed-stream', thinking: { budget_tokens: 4096 } } }, upstreamResponse,
    });
    expect(replaced.status).toBe(202);
    expect(replaced.headers.get('x-test')).toBe('kept');
    expect(await replaced.text()).toBe(chunks.join(''));
    expect(records()).toEqual([expect.objectContaining({
      request_id: 'ccr-stream', request_model: 'virtual-model', selected_model: 'routed-stream',
      router_thinking_budget_tokens: 4096, response_id: 'msg-1', response_model: 'stream-model',
    })]);
  });

  it('finds identity inside a large first chunk and in a final line without newline', async () => {
    const hooks = await plugin();
    for (const [id, payload] of [
      ['ccr-big', `data: {"id":"big-1","model":"big-model"}\n${'x'.repeat(70 * 1024)}`],
      ['ccr-tail', 'data: {"id":"tail-1","model":"tail-model"}'],
    ]) {
      const req = request(id, { model: 'requested' });
      hooks.requestHooks[0].beforeAuth({ request: req });
      const response = await hooks.streamHooks[0].transformResponse({ request: req, upstreamRequest: { body: {} }, upstreamResponse: new Response(payload) });
      expect(await response.text()).toBe(payload);
    }
    expect(records().map(r => [r.request_id, r.response_id, r.response_model]).sort()).toEqual([
      ['ccr-big', 'big-1', 'big-model'], ['ccr-tail', 'tail-1', 'tail-model']]);
  });

  it('correlates by Claude session header when no traceparent reaches the gateway', async () => {
    const hooks = await plugin();
    const req = request('ccr-session', { model: 'requested-model', output_config: { effort: 'high' } },
      { traceparent: undefined, 'x-claude-code-session-id': '4c4c0455-2871-41d9-8909-ebf52728f0fc' });
    delete req.headers.traceparent;
    hooks.requestHooks[0].beforeAuth({ request: req });
    await hooks.responseHooks[0].transformResponse({ request: req, model: 'routed', upstreamRequest: { body: { model: 'routed' } }, responsePayload: { id: 'msg-session' } });
    expect(records()).toEqual([expect.objectContaining({ session_id: '4c4c0455-2871-41d9-8909-ebf52728f0fc',
      request_model: 'requested-model', reasoning_effort: 'high', response_id: 'msg-session' })]);
    expect(records()[0]).not.toHaveProperty('upstream_traceparent');
  });

  it('ignores malformed session identifiers', async () => {
    const hooks = await plugin();
    const req = request('ccr-bad-session', { model: 'm' }, { 'x-claude-code-session-id': 'bad id\nx' });
    delete req.headers.traceparent;
    hooks.requestHooks[0].beforeAuth({ request: req });
    await hooks.responseHooks[0].transformResponse({ request: req, upstreamRequest: { body: {} }, responsePayload: { id: 'x' } });
    expect(records()).toEqual([]);
  });

  it('does not join metadata without a valid final trace context or explicit response identity', async () => {
    const hooks = await plugin();
    const req = request('ccr-no-trace', { model: 'requested' }, { traceparent: 'invalid' });
    hooks.requestHooks[0].beforeAuth({ request: req });
    await hooks.responseHooks[0].transformResponse({ request: req, model: 'routed', upstreamRequest: { body: { model: 'routed' } }, responsePayload: {} });
    expect(records()).toEqual([]);
  });

  it('accepts Headers objects, Gemini budgets and model versions from non-streaming responses', async () => {
    const hooks = await plugin();
    const req = request('ccr-gemini', { model: 'gemini-alias', reasoning: { effort: 'low' } });
    req.headers = new Headers({ traceparent });
    hooks.requestHooks[0].beforeAuth({ request: req });
    await hooks.responseHooks[0].transformResponse({
      request: req, targetProvider: 'gemini',
      upstreamRequest: { body: { model: 'gemini-real', generationConfig: { thinkingConfig: { thinkingBudget: 0 } } } },
      responsePayload: { modelVersion: 'gemini-reported' },
    });
    expect(records()[0]).toMatchObject({ request_model: 'gemini-alias', reasoning_effort: 'low', selected_model: 'gemini-real',
      router_thinking_budget_tokens: 0, response_model: 'gemini-reported' });
  });

  it('passes through streams without bodies, malformed or late metadata', async () => {
    const hooks = await plugin();
    const empty = new Response(null, { status: 204 });
    expect(await hooks.streamHooks[0].transformResponse({ upstreamResponse: empty })).toBe(empty);
    const req = request('ccr-late', { model: 'requested' });
    hooks.requestHooks[0].beforeAuth({ request: req });
    const payload = `${'x'.repeat(65 * 1024)}\ndata: {bad json}\ndata: {"id":"late","model":"late-model"}\n`;
    const response = await hooks.streamHooks[0].transformResponse({ request: req, upstreamRequest: { body: {} }, upstreamResponse: new Response(payload) });
    expect(await response.text()).toBe(payload);
    expect(records()).toEqual([]);
    const fallback = { body: null };
    expect(await hooks.streamHooks[0].transformResponse({ upstreamResponse: fallback })).toBe(fallback);
  });

  it('bounds pending originals and never lets storage errors break the request', async () => {
    const hooks = await createGatewayPlugin({ plugin: { config: { dataDir: '/dev/null/not-writable' } } });
    for (let i = 0; i < 1002; i++) hooks.requestHooks[0].beforeAuth({ request: request(`bounded-${i}`, { model: 'requested' }) });
    expect(hooks.responseHooks[0].transformResponse({ request: request('bounded-1001'), responsePayload: { id: 'ok' } })).toBeUndefined();
    expect(hooks.requestHooks[0].beforeAuth({ request: { get id() { throw new Error('boom'); } } })).toEqual({ ok: true });
    expect(hooks.requestHooks[0].beforeAuth({ request: { id: 'array-body', headers: { traceparent }, body: [] } })).toEqual({ ok: true });
  });

  it('drops conflicting effort spellings instead of choosing precedence', async () => {
    const hooks = await plugin();
    const req = request('ccr-conflict', { model: 'requested', output_config: { effort: 'high' }, reasoning_effort: 'low' });
    hooks.requestHooks[0].beforeAuth({ request: req });
    await hooks.responseHooks[0].transformResponse({ request: req, model: 'routed', upstreamRequest: { body: { model: 'routed' } }, responsePayload: { id: 'response-conflict' } });
    expect(records()[0]).not.toHaveProperty('reasoning_effort');
  });
});
