import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import {
  IDLE_WAIT_MS, finalStep, firstStep, internals, llmSpans, makeFlusher, row, toolSpans, turn, wait,
} from './held-orphans-fixtures.js';

describe('OtlpTraceFlusher - tool call arguments across a reopened turn', () => {
  let flusher: OtlpTraceFlusher | undefined;
  const t = turn();

  afterEach(async () => {
    vi.restoreAllMocks();
    await flusher?.shutdown();
    flusher = undefined;
  });

  it('keeps an unpaired tool.call through an idle flush so the reopened turn exports its arguments', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(t.prompt());
    for (const r of firstStep()) await flusher.send(r);
    await flusher.send(t.toolCall());
    await wait(IDLE_WAIT_MS);

    // The early (idle) flush sent the convertible part of the turn, but no
    // orphan TOOL span for the still-running call.
    expect(exported.length).toBeGreaterThan(0);
    expect(toolSpans(exported, 'c1')).toHaveLength(0);
    const firstExportCount = exported.length;

    // The tool finishes later; the turn reopens and then ends normally.
    await flusher.send(t.toolResult());
    for (const r of finalStep()) await flusher.send(r);
    await flusher.flush();

    expect(exported.length).toBeGreaterThan(firstExportCount);
    const c1 = toolSpans(exported, 'c1');
    expect(c1).toHaveLength(1);
    expect(String(c1[0].attributes['gen_ai.tool.call.arguments'])).toContain('sleep 600');
    expect(String(c1[0].attributes['gen_ai.tool.call.result'])).toContain('done');
  });

  it('moves the held call bytes with it instead of counting them as removed twice', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(t.prompt(), 10);
    await flusher.send(t.toolCall(), 70);
    await wait(IDLE_WAIT_MS);

    expect(row(flusher)).toMatchObject({
      removed_logical_bytes_total: 10, pending_buffers: 0,
      held_orphan_turns: 1, held_orphan_logical_bytes: 70,
    });

    await flusher.send(t.toolResult(), 5);
    expect(row(flusher)).toMatchObject({
      pending_records: 2, pending_logical_bytes: 75, pending_unmeasured_records: 0,
      held_orphan_turns: 0, held_orphan_logical_bytes: 0,
    });
  });

  it('drops a tool.call that never gets a result at the final flush and leaves no buffer behind', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(t.prompt(), 10);
    for (const r of firstStep()) await flusher.send(r, 20);
    await flusher.send(t.toolCall(), 70);
    await wait(IDLE_WAIT_MS);
    expect(toolSpans(exported, 'c1')).toHaveLength(0);
    expect(internals(flusher).heldOrphans.size).toBe(1);
    expect(row(flusher)).toMatchObject({ held_orphan_turns: 1, held_orphan_logical_bytes: 70 });

    // Shutdown is the final flush: the interrupted call is discarded, not
    // emitted as an empty TOOL span, and nothing is retained afterwards.
    await flusher.flush();

    expect(toolSpans(exported, 'c1')).toHaveLength(0);
    expect(internals(flusher).turnBuffers.size).toBe(0);
    expect(internals(flusher).heldOrphans.size).toBe(0);
    // Every accepted byte is counted as removed exactly once, held ones included.
    expect(row(flusher)).toMatchObject({
      removed_logical_bytes_total: 120, removed_unmeasured_records_total: 0,
      held_orphan_turns: 0, held_orphan_logical_bytes: 0,
    });
  });

  it('an early flush holding only orphans never calls the converter', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);
    const convert = vi.spyOn(flusher as unknown as { doConvertAndExport: () => Promise<void> }, 'doConvertAndExport');

    await flusher.send(t.toolCall(), 70);
    await wait(IDLE_WAIT_MS);

    expect(convert).not.toHaveBeenCalled();
    expect(exported).toHaveLength(0);
    expect(row(flusher)).toMatchObject({ held_orphan_turns: 1, held_orphan_logical_bytes: 70 });
  });

  it('a second early flush of the reopened turn holds the still-unpaired call again', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(t.prompt());
    await flusher.send(t.toolCall());
    await wait(IDLE_WAIT_MS);
    expect(internals(flusher).heldOrphans.size).toBe(1);

    // New content reopens the turn (restoring the call); it idles out again.
    await flusher.send(t.prompt('still running'));
    expect(internals(flusher).heldOrphans.size).toBe(0);
    await wait(IDLE_WAIT_MS);
    expect(internals(flusher).heldOrphans.size).toBe(1);
    expect(toolSpans(exported, 'c1')).toHaveLength(0);

    await flusher.send(t.toolResult());
    for (const r of finalStep()) await flusher.send(r);
    await flusher.flush();

    const c1 = toolSpans(exported, 'c1');
    expect(c1).toHaveLength(1);
    expect(String(c1[0].attributes['gen_ai.tool.call.arguments'])).toContain('sleep 600');
  });

  it('holds the call when a same-session successor turn flushes the turn early', async () => {
    const exported: ReadableSpan[] = [];
    // No idle timer: only the successor signal flushes early here.
    flusher = makeFlusher(exported, { turnIdleTimeoutMs: 0 });
    const a = { turn: 'turn-a', session: 'shared-session' };
    const ta = turn(a);
    const tb = turn({ turn: 'turn-b', session: 'shared-session' });

    await flusher.send(ta.prompt());
    for (const r of firstStep(a)) await flusher.send(r);
    await flusher.send(ta.toolCall());
    await flusher.send(tb.prompt('next prompt'));
    expect(internals(flusher).heldOrphans.size).toBe(1);

    await flusher.send(ta.toolResult());
    for (const r of finalStep(a)) await flusher.send(r);
    await flusher.flush();

    const c1 = toolSpans(exported, 'c1');
    expect(c1).toHaveLength(1);
    expect(String(c1[0].attributes['gen_ai.tool.call.arguments'])).toContain('sleep 600');
  });

  it('holds an unanswered llm.request and pairs it with the response after the reopen', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);

    await flusher.send(t.prompt());
    await flusher.send(t.llmRequest('step-1', 100));
    await wait(IDLE_WAIT_MS);
    expect(internals(flusher).heldOrphans.size).toBe(1);
    expect(llmSpans(exported)).toHaveLength(0);

    await flusher.send(t.llmResponse('step-1', 5_000, 'stop'));
    await flusher.flush();

    const llm = llmSpans(exported);
    expect(llm).toHaveLength(1);
    // The input comes from the held request, so the pair was really rebuilt.
    expect(String(llm[0].attributes['gen_ai.input.messages'])).toContain('REQ-MARK');
  });
});
