import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TRACEPARENT_RE = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PENDING = 1000;
const MAX_STREAM_SCAN_BYTES = 64 * 1024;

function text(value, max = 256) {
  return typeof value === 'string' && value.trim() && value.length <= max && !CONTROL_RE.test(value) ? value : undefined;
}

function header(headers, name, pattern) {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name] ?? headers?.[name.toLowerCase()];
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
}

function settings(body, prefix = '') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const efforts = [body.output_config?.effort, body.reasoning?.effort, body.reasoning_effort].filter(v => v !== undefined);
  const effort = text(efforts[0], 64);
  const budget = body.thinking?.budget_tokens ?? body.generationConfig?.thinkingConfig?.thinkingBudget;
  const model = text(body.model);
  return {
    ...(model ? { [`${prefix}model`]: model } : {}),
    ...(effort && efforts.every(v => v === effort) ? { [`${prefix}reasoning_effort`]: effort } : {}),
    ...(Number.isSafeInteger(budget) && budget >= 0 ? { [`${prefix}thinking_budget_tokens`]: budget } : {}),
  };
}

function writeRecord(root, record) {
  const dir = path.join(root, 'router', 'ccr');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${crypto.createHash('sha256').update(record.request_id).digest('hex')}.json`);
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function responseIdentity(payload) {
  const message = payload?.message ?? payload?.response ?? payload;
  const id = text(message?.id);
  const model = text(message?.model ?? payload?.modelVersion);
  return { ...(id ? { response_id: id } : {}), ...(model ? { response_model: model } : {}) };
}

function observeStream(response, onIdentity, onEnd) {
  if (!response.body) return response;
  const decoder = new TextDecoder();
  let scanned = 0;
  let pending = '';
  let found = false;
  const scan = (final) => {
    const lines = pending.split(/\r?\n/);
    pending = final ? '' : lines.pop() ?? '';
    for (const line of lines) {
      if (found || !line.startsWith('data:')) continue;
      try {
        const identity = responseIdentity(JSON.parse(line.slice(5).trim()));
        if (identity.response_id || identity.response_model) { found = true; onIdentity(identity); }
      } catch {}
    }
  };
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (found || scanned >= MAX_STREAM_SCAN_BYTES) return;
      // Only a bounded prefix is inspected; the bytes passed through are never altered.
      const part = chunk.subarray(0, MAX_STREAM_SCAN_BYTES - scanned);
      scanned += part.byteLength;
      pending += decoder.decode(part, { stream: true });
      scan(false);
    },
    flush() {
      if (!found) { pending += decoder.decode(); scan(true); }
      onEnd();
    },
  }));
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function createGatewayPlugin({ plugin } = {}) {
  const root = text(plugin?.config?.dataDir, 4096) ?? process.env.LOONGSUITE_PILOT_DATA_DIR ?? path.join(os.homedir(), '.loongsuite-pilot');
  const originals = new Map();
  const remember = request => {
    const id = text(request?.id);
    // Claude Code's inference client bypasses the fetch preload, so its session header is the usual correlation.
    const upstream_traceparent = header(request?.headers, 'traceparent', TRACEPARENT_RE);
    const session_id = header(request?.headers, 'x-claude-code-session-id', SESSION_RE);
    if (!id || (!upstream_traceparent && !session_id)) return;
    if (originals.size >= MAX_PENDING) originals.delete(originals.keys().next().value);
    originals.set(id, { ...(upstream_traceparent ? { upstream_traceparent } : {}), ...(session_id ? { session_id } : {}), ...Object.fromEntries(Object.entries(settings(request.body)).map(([k, v]) => [k === 'model' ? 'request_model' : k, v])) });
  };
  const persist = (input, identity) => {
    try {
      const id = text(input?.request?.id);
      const original = id ? originals.get(id) : undefined;
      if (!id || !original) return;
      const routed = settings(input.upstreamRequest?.body, 'router_');
      const record = { schema_version: 1, request_id: id, ...original,
        ...(text(input.model ?? routed.router_model) ? { selected_model: text(input.model ?? routed.router_model) } : {}),
        ...(text(input.targetProvider) ? { provider: input.targetProvider } : {}),
        ...Object.fromEntries(Object.entries(routed).filter(([k]) => k !== 'router_model')), ...identity };
      writeRecord(root, record);
      originals.delete(id);
    } catch {}
  };
  const forget = input => { try { const id = text(input?.request?.id); if (id) originals.delete(id); } catch {} };
  return {
    requestHooks: [{ key: 'ntconsult-router-original', beforeAuth(input) { try { remember(input?.request); } catch {} return { ok: true }; } }],
    responseHooks: [{ key: 'ntconsult-router-response', transformResponse(input) { persist(input, responseIdentity(input?.responsePayload)); } }],
    streamHooks: [{ key: 'ntconsult-router-stream', transformResponse(input) {
      try {
        return observeStream(input.upstreamResponse, identity => persist(input, identity), () => forget(input));
      } catch { return input.upstreamResponse; }
    } }],
  };
}

export default createGatewayPlugin;
