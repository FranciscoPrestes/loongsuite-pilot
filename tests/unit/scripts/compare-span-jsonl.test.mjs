import { describe, expect, it } from 'vitest';
import { compareSpanJsonl } from '../../../tools/compare-span-jsonl.mjs';

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
    const delta = [{ role: 'user', parts: [{ type: 'text', content: 'prompt só no delta' }] }];
    const full = [{ role: 'user', parts: [{ type: 'text', content: 'prompt só no delta' }] }];
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
