import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compareSpanJsonl, exitCodeFor } from '../../../tools/compare-span-jsonl.mjs';

const ev = (id, attrs) => JSON.stringify({ 'event.id': id, 'event.name': 'llm.request', ...attrs });
const span = (attrs) => JSON.stringify({ spanId: 'x', attributes: attrs });

describe('compareSpanJsonl', () => {
  it('counts a prompt as complete only when the full text reaches a span', () => {
    const prompt = [{ role: 'user', parts: [{ type: 'text', content: 'refatore o módulo X '.repeat(500) }] }];
    const report = compareSpanJsonl({
      jsonlLines: [ev('e1', { 'gen_ai.input.messages': JSON.stringify(prompt) })],
      spanLines: [span({ 'gen_ai.input.messages': JSON.stringify(prompt) })],
    });
    expect(report.entradas).toBe(1);
    expect(report.entradasCompletas).toBe(1);
    expect(report.faltando).toEqual([]);
  });

  it('matches real prompts with quotes, newlines and backslashes', () => {
    const prompt = [{ role: 'user', parts: [{ type: 'text', content: 'diga "oi"\nlinha 2\tC:\\temp\\x.ts' }] }];
    const report = compareSpanJsonl({
      jsonlLines: [ev('e3', { 'gen_ai.input.messages': JSON.stringify(prompt) })],
      spanLines: [span({ 'gen_ai.input.messages': JSON.stringify(prompt) })],
    });
    expect(report.entradasCompletas).toBe(1);
    expect(report.faltando).toEqual([]);
  });

  it('flags a truncated output and a missing system prompt', () => {
    const out = [{ role: 'assistant', parts: [{ type: 'text', content: 'resposta longa '.repeat(300) }] }];
    const sys = [{ type: 'text', content: 'você é um assistente' }];
    const report = compareSpanJsonl({
      jsonlLines: [ev('e2', { 'gen_ai.output.messages': JSON.stringify(out), 'gen_ai.system_instructions': JSON.stringify(sys) })],
      spanLines: [span({ 'gen_ai.output.messages': JSON.stringify(out).slice(0, 200) })],
    });
    expect(report.saidasCompletas).toBe(0);
    expect(report.sistemaNoSpan).toBe(0);
    expect(report.faltando).toEqual([
      { eventId: 'e2', campo: 'gen_ai.output.messages' },
      { eventId: 'e2', campo: 'gen_ai.system_instructions' },
    ]);
  });

  // Real events (e.g. claude-code llm.request) carry the prompt as
  // gen_ai.input.messages_delta, as an object (not a JSON string).
  it('checks the prompt carried as gen_ai.input.messages_delta', () => {
    const delta = [{ role: 'user', parts: [{ type: 'text', content: 'prompt só no delta, com texto suficiente' }] }];
    const full = [{ role: 'user', parts: [{ type: 'text', content: 'prompt só no delta, com texto suficiente' }] }];
    const ok = compareSpanJsonl({
      jsonlLines: [ev('d1', { 'gen_ai.input.messages_delta': delta })],
      spanLines: [span({ 'gen_ai.input.messages': JSON.stringify(full) })],
    });
    expect(ok.entradas).toBe(1);
    expect(ok.entradasCompletas).toBe(1);

    const lost = compareSpanJsonl({
      jsonlLines: [ev('d2', { 'gen_ai.input.messages_delta': delta })],
      spanLines: [],
    });
    expect(lost.entradas).toBe(1);
    expect(lost.faltando).toEqual([{ eventId: 'd2', campo: 'gen_ai.input.messages_delta' }]);
  });

  it('ignores empty marker events and does not count them as complete', () => {
    const report = compareSpanJsonl({
      jsonlLines: [ev('m1', { 'gen_ai.input.messages_delta': [] })],
      spanLines: [],
    });
    expect(report.entradas).toBe(0);
    expect(report.entradasCompletas).toBe(0);
    expect(report.faltando).toEqual([]);
  });
});

const msgs = (role, text) => [{ role, parts: [{ type: 'text', content: text }] }];
const evS = (id, sid, attrs) => JSON.stringify({ 'event.id': id, 'event.name': 'llm.request', 'gen_ai.session.id': sid, ...attrs });
const spanS = (sid, attrs, traceId = 't') => JSON.stringify({ traceId, spanId: 'x', attributes: { 'gen_ai.session.id': sid, ...attrs } });

describe('compareSpanJsonl per session', () => {
  const texto = 'texto longo o bastante para valer como evidência';

  it('does not accept a text that only exists in another session', () => {
    const report = compareSpanJsonl({
      jsonlLines: [evS('e1', 'A', { 'gen_ai.input.messages_delta': msgs('user', texto) })],
      spanLines: [spanS('B', { 'gen_ai.input.messages': JSON.stringify(msgs('user', texto)) })],
    });
    expect(report.entradasCompletas).toBe(0);
    expect(report.faltando).toEqual([{ eventId: 'e1', campo: 'gen_ai.input.messages_delta' }]);
  });

  it('accepts the text in its own session and attributes sessionless spans via traceId', () => {
    const report = compareSpanJsonl({
      jsonlLines: [evS('e1', 'A', { 'gen_ai.output.messages': msgs('assistant', texto) })],
      spanLines: [
        spanS('A', {}, 't1'),
        JSON.stringify({ traceId: 't1', attributes: { 'gen_ai.output.messages': JSON.stringify(msgs('assistant', texto)) } }),
      ],
    });
    expect(report.saidasCompletas).toBe(1);
    expect(report.faltando).toEqual([]);
  });

  it('reports short texts matched only outside their session as inconclusive, not complete', () => {
    const report = compareSpanJsonl({
      jsonlLines: [evS('e1', 'A', { 'gen_ai.input.messages_delta': msgs('user', 'ok') })],
      spanLines: [spanS('B', { 'gen_ai.input.messages': JSON.stringify(msgs('user', 'ok')) })],
    });
    expect(report.entradas).toBe(1);
    expect(report.entradasCompletas).toBe(0);
    expect(report.inconclusivos).toBe(1);
    expect(report.faltando).toEqual([]);
  });

  it('does not accept a truncated text as a substring of a longer one', () => {
    const report = compareSpanJsonl({
      jsonlLines: [evS('e1', 'A', { 'gen_ai.input.messages_delta': msgs('user', texto) })],
      spanLines: [spanS('A', { 'gen_ai.input.messages': JSON.stringify(msgs('user', `${texto} e mais coisas`)) })],
    });
    expect(report.faltando).toHaveLength(1);
  });

  it('ignores empty content strings like empty plain strings', () => {
    const report = compareSpanJsonl({
      jsonlLines: [evS('e1', 'A', { 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: '' }] }] })],
      spanLines: [],
    });
    expect(report.entradas).toBe(0);
    expect(report.faltando).toEqual([]);
  });

  it('counts events without session id and unparseable lines', () => {
    const report = compareSpanJsonl({
      jsonlLines: [ev('e1', { 'gen_ai.input.messages_delta': msgs('user', texto) }), '{quebrado'],
      spanLines: [span({ 'gen_ai.input.messages': JSON.stringify(msgs('user', texto)) }), 'lixo'],
    });
    expect(report.semSessao).toBe(1);
    expect(report.entradasCompletas).toBe(1);
    expect(report.linhasInvalidas).toEqual({ eventos: 1, spans: 1 });
    expect(report.naoComparados).toContain('gen_ai.tool.call.result');
  });
});

describe('exitCodeFor', () => {
  const ok = { exists: true, lines: 3 };
  const rep = (o) => ({ entradas: 1, saidas: 1, entradasCompletas: 1, saidasCompletas: 1, inconclusivos: 0, faltando: [], ...o });

  it('is inconclusive (3) when a file is missing or empty or nothing was compared', () => {
    expect(exitCodeFor(rep(), { jsonl: { exists: false, lines: 0 }, spans: ok })).toBe(3);
    expect(exitCodeFor(rep(), { jsonl: ok, spans: { exists: true, lines: 0 } })).toBe(3);
    expect(exitCodeFor(rep({ entradas: 0 }), { jsonl: ok, spans: ok })).toBe(3);
    expect(exitCodeFor(rep({ saidas: 0 }), { jsonl: ok, spans: ok })).toBe(3);
  });

  it('is inconclusive (3) when anything is inconclusive or a side has no complete item', () => {
    const f = { jsonl: ok, spans: ok };
    expect(exitCodeFor(rep({ inconclusivos: 1 }), f)).toBe(3);
    expect(exitCodeFor(rep({ entradasCompletas: 0, inconclusivos: 1 }), f)).toBe(3); // all inconclusive
    expect(exitCodeFor(rep({ entradasCompletas: 0 }), f)).toBe(3);
    expect(exitCodeFor(rep({ saidasCompletas: 0 }), f)).toBe(3);
    expect(exitCodeFor(rep({ inconclusivos: 1, faltando: [{}] }), f)).toBe(1); // faltando wins
  });

  it('is 1 with missing content and 0 when conclusive and complete', () => {
    expect(exitCodeFor(rep({ faltando: [{}] }), { jsonl: ok, spans: ok })).toBe(1);
    expect(exitCodeFor(rep(), { jsonl: ok, spans: ok })).toBe(0);
  });
});

describe('compare-span-jsonl CLI', () => {
  const script = path.resolve(__dirname, '../../../tools/compare-span-jsonl.mjs');
  const texto = 'texto longo o bastante para valer como evidência';
  const dirs = [];
  afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
  const run = (dir, extra = []) =>
    spawnSync(process.execPath, [script, '--agent', 'fake', '--date', '2026-01-01', '--data-dir', dir, ...extra], { encoding: 'utf8' });
  const setup = ({ spans, events }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmp-span-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, 'logs', 'output'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs', 'otlp-debug'), { recursive: true });
    if (events) fs.writeFileSync(path.join(dir, 'logs', 'output', 'fake-2026-01-01.jsonl'), events.join('\n') + '\n');
    if (spans) fs.writeFileSync(path.join(dir, 'logs', 'otlp-debug', 'loongsuite-pilot-fake-2026-01-01.jsonl'), spans.join('\n') + '\n');
    return dir;
  };
  const events = [
    evS('a', 'S', { 'gen_ai.input.messages_delta': msgs('user', texto) }),
    evS('b', 'S', { 'gen_ai.output.messages': msgs('assistant', texto) }),
  ];
  const goodSpans = [spanS('S', {
    'gen_ai.input.messages': JSON.stringify(msgs('user', texto)),
    'gen_ai.output.messages': JSON.stringify(msgs('assistant', texto)),
  })];

  it('exits 0 with JSON when everything matches', () => {
    const r = run(setup({ spans: goodSpans, events }));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.entradasCompletas).toBe(1);
    expect(out.arquivos.spans).toEqual({ exists: true, lines: 1 });
  });

  it('exits 1 when content is missing', () => {
    const r = run(setup({ spans: [spanS('S', {})], events }));
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).faltando).toHaveLength(2);
  });

  it('exits 3 when the otlp-debug file is missing', () => {
    const r = run(setup({ events }));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/INCONCLUSIVO/);
    expect(JSON.parse(r.stdout).arquivos.spans.exists).toBe(false);
  });

  it('exits 3 when there are no outputs to compare', () => {
    expect(run(setup({ spans: goodSpans, events: [events[0]] })).status).toBe(3);
  });

  it('exits 3 and explains when everything is inconclusive (short texts outside the session)', () => {
    const curto = [
      evS('a', 'S', { 'gen_ai.input.messages_delta': msgs('user', 'ok') }),
      evS('b', 'S', { 'gen_ai.output.messages': msgs('assistant', 'sim') }),
    ];
    const outra = [spanS('OUTRA', {
      'gen_ai.input.messages': JSON.stringify(msgs('user', 'ok')),
      'gen_ai.output.messages': JSON.stringify(msgs('assistant', 'sim')),
    })];
    const r = run(setup({ spans: outra, events: curto }));
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/inconclusiv/i);
  });

  it('exits 2 without --agent/--date', () => {
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
  });
});
