import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const SESSION_A = 'aaf5e1f0-14d5-42c1-aaa8-e7a5a14fcfed';
const SESSION_B = '99cea161-6b4b-461f-bdbf-fc7128e971de';

// The two real shapes of Copilot session-scope usage (prompt content removed).
function checkpointEvent(overrides: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1790895233085000000',
    observed_time_unix_nano: '1790895233203000000',
    'event.id': '4ab8ca27-2d97-f6c2-d3b8-4a82c7ef0aa8',
    'event.name': 'other',
    'user.id': 'francisco.prestes@ntconsult.com.br',
    'gen_ai.session.id': SESSION_A,
    'gen_ai.agent.type': 'copilot',
    'gen_ai.provider.name': 'github-copilot',
    'agent.copilot.usage.scope': 'session',
    'agent.copilot.usage.source': 'checkpoint',
    'agent.copilot.usage.turn_id': '869d53fd-52bb-4ad4-9572-52e15004a9ec',
    'agent.copilot.usage.nano_aiu': 449094500,
    'agent.copilot.usage.premium_requests': 1,
    'git.repo': 'ntconsult/verificacao5-teste',
    'git.branch': 'main',
    ...overrides,
  } as AgentActivityEntry;
}

function tokensEvent(overrides: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1790895233113000000',
    observed_time_unix_nano: '1790895233203000000',
    'event.id': 'ef294b43-e19b-c07a-ffed-f7a2aede3509',
    'event.name': 'other',
    'user.id': 'francisco.prestes@ntconsult.com.br',
    'gen_ai.session.id': SESSION_A,
    'gen_ai.agent.type': 'copilot',
    'gen_ai.provider.name': 'github-copilot',
    'gen_ai.response.model': 'gpt-6-luna',
    'agent.copilot.usage.scope': 'session',
    'gen_ai.usage.input_tokens': 60327,
    'gen_ai.usage.output_tokens': 817,
    'gen_ai.usage.cache_read.input_tokens': 30072,
    'gen_ai.usage.cache_creation.input_tokens': 30249,
    'agent.copilot.usage.reasoning_tokens': 602,
    'agent.copilot.usage.model_nano_aiu': 449094500,
    'git.repo': 'ntconsult/verificacao5-teste',
    'git.branch': 'main',
    ...overrides,
  } as AgentActivityEntry;
}

function makeFlusher(extra: Record<string, unknown> = {}, provider?: unknown) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    serviceName: 'test',
    protocol: 'http/protobuf',
    dataDir: '/nonexistent-pilot-data-dir',
    captureMessageContent: false,
    endpoints: [{ name: 'primary', endpoint: 'http://unused:4318' }],
    ...extra,
  } as never, provider as never, () => ({
    export(batch, cb) {
      spans.push(...batch);
      cb({ code: 0 });
    },
    shutdown: async () => {},
  }));
  return { flusher, spans };
}

const usageSpans = (spans: ReadableSpan[]) => spans.filter(s => s.name === 'copilot.session_usage');

describe('Copilot session-scope usage span', () => {
  it('turns the token event into an LLM span carrying every usage attribute', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch([tokensEvent()]);
    await flusher.flush();

    const [span] = usageSpans(spans);
    expect(span).toBeDefined();
    expect(span.attributes['gen_ai.span.kind']).toBe('LLM');
    expect(span.attributes['gen_ai.usage.input_tokens']).toBe(60327);
    expect(span.attributes['gen_ai.usage.output_tokens']).toBe(817);
    expect(span.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(30072);
    expect(span.attributes['gen_ai.usage.cache_creation.input_tokens']).toBe(30249);
    expect(span.attributes['agent.copilot.usage.scope']).toBe('session');
    expect(span.attributes['agent.copilot.usage.reasoning_tokens']).toBe(602);
    expect(span.attributes['agent.copilot.usage.model_nano_aiu']).toBe(449094500);
    expect(span.attributes['gen_ai.session.id']).toBe(SESSION_A);
    expect(span.attributes['gen_ai.agent.type']).toBe('copilot');
    expect(span.attributes['gen_ai.response.model']).toBe('gpt-6-luna');
    expect(span.attributes['gen_ai.user.id']).toBe('francisco.prestes@ntconsult.com.br');
    expect(span.attributes['git.repo']).toBe('ntconsult/verificacao5-teste');
    expect(span.resource.attributes['service.name']).toBe('test-copilot');
    expect(span.resource.attributes['gen_ai.agent.type']).toBe('copilot');
    await flusher.shutdown();
  });

  it('turns the cost checkpoint into a USAGE span (not LLM) without tokens', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch([checkpointEvent()]);
    await flusher.flush();

    const [span] = usageSpans(spans);
    expect(span).toBeDefined();
    expect(span.attributes['gen_ai.span.kind']).toBe('USAGE');
    expect(span.attributes['agent.copilot.usage.source']).toBe('checkpoint');
    expect(span.attributes['agent.copilot.usage.turn_id']).toBe('869d53fd-52bb-4ad4-9572-52e15004a9ec');
    expect(span.attributes['agent.copilot.usage.nano_aiu']).toBe(449094500);
    expect(span.attributes['agent.copilot.usage.premium_requests']).toBe(1);
    expect(span.attributes['gen_ai.usage.input_tokens']).toBeUndefined();
    await flusher.shutdown();
  });

  it('uses the event timestamp as start and end', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch([tokensEvent()]);
    await flusher.flush();

    const [span] = usageSpans(spans);
    expect(span.startTime).toEqual([1790895233, 113000000]);
    expect(span.endTime).toEqual([1790895233, 113000000]);
    await flusher.shutdown();
  });

  it('derives deterministic ids: same event -> same spanId, sessions -> traceId', async () => {
    const first = makeFlusher();
    const second = makeFlusher();
    await first.flusher.sendBatch([tokensEvent(), checkpointEvent(), tokensEvent({
      'event.id': 'ace4621f-fd6e-1b16-bb90-1dfca40f1547',
      'gen_ai.session.id': SESSION_B,
    })]);
    await first.flusher.flush();
    await second.flusher.sendBatch([tokensEvent()]);
    await second.flusher.flush();

    const a = usageSpans(first.spans);
    expect(a).toHaveLength(3);
    const [tokensA, checkpointA, tokensB] = a.map(s => s.spanContext());
    expect(tokensA.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(tokensA.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(usageSpans(second.spans)[0].spanContext().spanId).toBe(tokensA.spanId);
    expect(usageSpans(second.spans)[0].spanContext().traceId).toBe(tokensA.traceId);
    expect(checkpointA.traceId).toBe(tokensA.traceId);
    expect(checkpointA.spanId).not.toBe(tokensA.spanId);
    expect(tokensB.traceId).not.toBe(tokensA.traceId);
    expect(tokensB.spanId).not.toBe(tokensA.spanId);
    expect(a[0].parentSpanId).toBeUndefined();
    await first.flusher.shutdown();
    await second.flusher.shutdown();
  });

  it('exports the session tokens exactly once across all spans', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch([checkpointEvent(), tokensEvent()]);
    await flusher.flush();

    const total = (key: string) => spans.reduce((sum, s) => {
      const v = s.attributes[key];
      return sum + (typeof v === 'number' ? v : 0);
    }, 0);
    expect(total('gen_ai.usage.input_tokens')).toBe(60327);
    expect(total('gen_ai.usage.output_tokens')).toBe(817);
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    await flusher.shutdown();
  });

  it('applies resource attributes and global attributes like other spans', async () => {
    const { flusher, spans } = makeFlusher(
      { resourceAttributeKeys: ['user.email'] },
      { resolve: () => ({ team: 'plataforma' }), keys: () => ['team'] },
    );
    await flusher.sendBatch([tokensEvent({ 'user.email': 'francisco.prestes@ntconsult.com.br' })]);
    await flusher.flush();

    const [span] = usageSpans(spans);
    expect(span.resource.attributes['user.email']).toBe('francisco.prestes@ntconsult.com.br');
    expect(span.attributes.team).toBe('plataforma');
    await flusher.shutdown();
  });

  it('does not give other agents a usage span', async () => {
    const { flusher, spans } = makeFlusher();
    const other = tokensEvent({ 'gen_ai.agent.type': 'claude-code' });
    const copilotNoScope = tokensEvent({ 'agent.copilot.usage.scope': undefined });
    await flusher.sendBatch([other, copilotNoScope]);
    await flusher.flush();

    expect(usageSpans(spans)).toHaveLength(0);
    expect(spans.filter(s => typeof s.attributes['gen_ai.usage.input_tokens'] === 'number')).toHaveLength(0);
    await flusher.shutdown();
  });

  it('survives an event without a session id and keeps flushing the rest', async () => {
    const { flusher, spans } = makeFlusher();
    const noSession = tokensEvent({ 'gen_ai.session.id': undefined });
    await expect(flusher.sendBatch([noSession, checkpointEvent()])).resolves.toBeUndefined();
    await flusher.flush();

    const usage = usageSpans(spans);
    expect(usage).toHaveLength(1);
    expect(usage[0].attributes['gen_ai.span.kind']).toBe('USAGE');
    await flusher.shutdown();
  });

  it('falls back to a valid trace_id when the session id is missing', async () => {
    const { flusher, spans } = makeFlusher();
    const traceId = 'c'.repeat(32);
    await flusher.sendBatch([tokensEvent({ 'gen_ai.session.id': undefined, trace_id: traceId })]);
    await flusher.flush();

    const [span] = usageSpans(spans);
    expect(span.spanContext().traceId).toBe(traceId);
    await flusher.shutdown();
  });

  it('fills gen_ai.request.model from the response model without overwriting', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch([
      tokensEvent(),
      tokensEvent({
        'event.id': 'keep-request-model',
        'gen_ai.request.model': 'gpt-requested',
      }),
    ]);
    await flusher.flush();

    const [filled, kept] = usageSpans(spans);
    expect(filled.attributes['gen_ai.request.model']).toBe('gpt-6-luna');
    expect(kept.attributes['gen_ai.request.model']).toBe('gpt-requested');
    await flusher.shutdown();
  });
});

function turnEntries(agentType: string, turnId: string): AgentActivityEntry[] {
  const base = {
    'gen_ai.session.id': SESSION_A,
    'gen_ai.agent.type': agentType,
    'gen_ai.turn.id': turnId,
    'gen_ai.step.id': `${turnId}-s1`,
    'user.id': 'francisco.prestes@ntconsult.com.br',
  };
  return [
    {
      ...base, 'event.id': `${turnId}-req`, 'event.name': 'llm.request',
      time_unix_nano: '1790895233000000000', 'gen_ai.request.id': `${turnId}-r`,
      'gen_ai.request.model': 'gpt-6-luna', 'gen_ai.turn.start': true,
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'x' }] }],
    },
    {
      ...base, 'event.id': `${turnId}-res`, 'event.name': 'llm.response',
      time_unix_nano: '1790895233100000000', 'gen_ai.response.id': `${turnId}-r`,
      'gen_ai.response.model': 'gpt-6-luna', 'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.turn.end': true, 'gen_ai.usage.output_tokens': 500,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'y' }], finish_reason: 'stop' }],
    },
  ] as AgentActivityEntry[];
}

const llmOutputTotal = (spans: ReadableSpan[]) => spans
  .filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')
  .reduce((sum, s) => sum + (Number(s.attributes['gen_ai.usage.output_tokens']) || 0), 0);

describe('Copilot session usage is the single source of tokens', () => {
  it('counts a turn output_tokens plus the session event exactly once', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch([
      ...turnEntries('copilot', 'turn-1'),
      tokensEvent({ 'gen_ai.usage.output_tokens': 500 }),
    ]);
    await flusher.flush();

    expect(spans.some(s => s.name !== 'copilot.session_usage' && s.attributes['gen_ai.span.kind'] === 'LLM')).toBe(true);
    expect(llmOutputTotal(spans)).toBe(500);
    expect(usageSpans(spans)[0].attributes['gen_ai.usage.output_tokens']).toBe(500);
    for (const s of spans.filter(x => x.name !== 'copilot.session_usage')) {
      expect(Object.keys(s.attributes).filter(k => k.startsWith('gen_ai.usage.'))).toEqual([]);
    }
    await flusher.shutdown();
  });

  it('keeps gen_ai.usage.* on turn spans of other agents', async () => {
    const { flusher, spans } = makeFlusher();
    await flusher.sendBatch(turnEntries('claude-code', 'turn-2'));
    await flusher.flush();

    expect(llmOutputTotal(spans)).toBe(500);
    await flusher.shutdown();
  });
});
