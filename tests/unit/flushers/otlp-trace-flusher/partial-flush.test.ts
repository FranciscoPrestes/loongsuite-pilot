import { afterEach, describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { IDLE_WAIT_MS, finalStep, firstStep, internals, llmSpans, makeFlusher, toolSpans, turn, wait } from './held-orphans-fixtures.js';

// NTConsult: turnos longos (minutos de ferramentas) só chegavam ao TES no fim do turno; o envio parcial
// periódico manda o que já está pronto a cada `turnPartialFlushMs`, sem fechar o turno (painel "ao vivo").
describe('OtlpTraceFlusher - envio parcial periódico de turno aberto', () => {
  let flusher: OtlpTraceFlusher | undefined;
  const t = turn({ turn: 'parcial-turn', session: 'parcial-session' });
  afterEach(async () => { await flusher?.shutdown(); flusher = undefined; });

  async function turnoCompleto(f: OtlpTraceFlusher, pausaNoMeio: number): Promise<void> {
    await f.send(t.prompt());
    for (const r of firstStep({ turn: 'parcial-turn', session: 'parcial-session' })) await f.send(r);
    await f.send(t.toolCall());
    if (pausaNoMeio) await wait(pausaNoMeio);
    await f.send(t.toolResult());
    for (const r of finalStep({ turn: 'parcial-turn', session: 'parcial-session' })) await f.send(r);
    await f.flush();
  }

  it('envia a parte pronta antes do fim do turno, mesmo com o turno ainda ativo', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported, { turnIdleTimeoutMs: 0, turnPartialFlushMs: 1_000 });
    await flusher.send(t.prompt());
    for (const r of firstStep({ turn: 'parcial-turn', session: 'parcial-session' })) await flusher.send(r);
    await flusher.send(t.toolCall());
    await wait(IDLE_WAIT_MS);
    expect(exported.length).toBeGreaterThan(0);
    expect(toolSpans(exported, 'c1')).toHaveLength(0); // chamada sem resultado fica guardada
    expect(internals(flusher).heldOrphans.size).toBe(1);
  });

  it('o turno inteiro sai com os mesmos spans de LLM e ferramenta, sem duplicar', async () => {
    const semParcial: ReadableSpan[] = [];
    flusher = makeFlusher(semParcial, { turnIdleTimeoutMs: 0 });
    await turnoCompleto(flusher, 0);
    await flusher.shutdown();
    const comParcial: ReadableSpan[] = [];
    flusher = makeFlusher(comParcial, { turnIdleTimeoutMs: 0, turnPartialFlushMs: 1_000 });
    await turnoCompleto(flusher, IDLE_WAIT_MS);
    expect(llmSpans(comParcial)).toHaveLength(llmSpans(semParcial).length);
    expect(toolSpans(comParcial, 'c1')).toHaveLength(1);
  });

  it('desligado (0 ou ausente) não envia nada antes do fim do turno', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported, { turnIdleTimeoutMs: 0 });
    await flusher.send(t.prompt());
    for (const r of firstStep({ turn: 'parcial-turn', session: 'parcial-session' })) await flusher.send(r);
    await wait(IDLE_WAIT_MS);
    expect(exported).toHaveLength(0);
  });
});
