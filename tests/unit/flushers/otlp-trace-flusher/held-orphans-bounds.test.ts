import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import type { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import {
  HOUR_MS, finalStep, firstStep, internals, makeFlusher, row, toolSpans, turn,
} from './held-orphans-fixtures.js';

const MIB = 1024 * 1024;
// Past the 100 ms idle window plus one 1 s idle tick.
const IDLE_FIRE_MS = 1_100;

describe('OtlpTraceFlusher - bounds on held unpaired records', () => {
  let flusher: OtlpTraceFlusher | undefined;

  beforeEach(() => {
    // Only the idle tick and the clock; the converter's own promises stay real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await flusher?.shutdown();
    flusher = undefined;
  });

  it('keeps a held call alive at 59 minutes and still pairs it with a late result', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);
    const t = turn();

    await flusher.send(t.prompt());
    for (const r of firstStep()) await flusher.send(r);
    await flusher.send(t.toolCall(), 70);
    vi.advanceTimersByTime(IDLE_FIRE_MS);
    expect(internals(flusher).heldOrphans.size).toBe(1);

    vi.advanceTimersByTime(59 * 60_000);
    expect(row(flusher)).toMatchObject({ held_orphan_turns: 1, held_orphan_logical_bytes: 70 });

    await flusher.send(t.toolResult());
    for (const r of finalStep()) await flusher.send(r);
    await flusher.flush();

    const c1 = toolSpans(exported, 'c1');
    expect(c1).toHaveLength(1);
    expect(String(c1[0].attributes['gen_ai.tool.call.arguments'])).toContain('sleep 600');
  });

  it('expires a held call after one hour and credits its bytes as removed', async () => {
    const exported: ReadableSpan[] = [];
    flusher = makeFlusher(exported);
    const t = turn();

    await flusher.send(t.prompt(), 10);
    await flusher.send(t.toolCall(), 70);
    vi.advanceTimersByTime(IDLE_FIRE_MS);
    expect(row(flusher)).toMatchObject({ held_orphan_turns: 1, removed_logical_bytes_total: 10 });

    vi.advanceTimersByTime(HOUR_MS);
    expect(internals(flusher).heldOrphans.size).toBe(0);
    expect(row(flusher)).toMatchObject({
      held_orphan_turns: 0, held_orphan_logical_bytes: 0, removed_logical_bytes_total: 80,
    });

    // A result arriving after expiry has no call to pair with: no arguments.
    await flusher.send(t.toolResult());
    for (const r of finalStep()) await flusher.send(r);
    await flusher.flush();
    const c1 = toolSpans(exported, 'c1');
    expect(c1.every(s => s.attributes['gen_ai.tool.call.arguments'] === undefined)).toBe(true);
  });

  it('evicts the oldest held turn when held bytes exceed the 32 MiB ceiling', async () => {
    flusher = makeFlusher([]);
    const a = turn({ turn: 'turn-a', session: 'session-a' });
    const b = turn({ turn: 'turn-b', session: 'session-b' });

    await flusher.send(a.toolCall(), 20 * MIB);
    vi.advanceTimersByTime(IDLE_FIRE_MS);
    expect(row(flusher)).toMatchObject({ held_orphan_turns: 1, held_orphan_logical_bytes: 20 * MIB });

    await flusher.send(b.toolCall(), 20 * MIB);
    vi.advanceTimersByTime(IDLE_FIRE_MS);

    expect([...internals(flusher).heldOrphans.keys()]).toEqual(['turn:turn-b']);
    expect(row(flusher)).toMatchObject({
      held_orphan_turns: 1, held_orphan_logical_bytes: 20 * MIB, removed_logical_bytes_total: 20 * MIB,
    });
  });

  it('evicts the oldest held turn beyond the 64-turn cap and credits its bytes as removed', async () => {
    flusher = makeFlusher([]);
    for (let i = 0; i < 65; i++) {
      await flusher.send(turn({ turn: `turn-${i}`, session: `session-${i}` }).toolCall(), 1);
    }
    vi.advanceTimersByTime(IDLE_FIRE_MS);

    const held = internals(flusher).heldOrphans;
    expect(held.size).toBe(64);
    expect(held.has('turn:turn-0')).toBe(false);
    expect(row(flusher)).toMatchObject({
      held_orphan_turns: 64, held_orphan_logical_bytes: 64, removed_logical_bytes_total: 1,
    });
  });
});
