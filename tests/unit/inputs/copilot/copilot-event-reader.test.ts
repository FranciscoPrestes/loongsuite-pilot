import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEventsFrom, readSessionHead } from '../../../../src/inputs/copilot/copilot-event-reader.js';
import { textOnlyTurn, toJsonl } from '../../../fixtures/copilot/events.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'copilot-reader-'));
  file = path.join(dir, 'events.jsonl');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('readEventsFrom', () => {
  it('reads all complete lines and reports start offsets', async () => {
    const events = textOnlyTurn();
    await writeFile(file, toJsonl(events));
    const result = await readEventsFrom(file, 0);
    expect(result.events.map(e => e.id)).toEqual(events.map(e => e.id));
    expect(result.offsets[0]).toBe(0);
    expect(result.offsets[1]).toBe(Buffer.byteLength(JSON.stringify(events[0]) + '\n'));
    expect(result.nextOffset).toBe(Buffer.byteLength(toJsonl(events)));
    expect(result.truncated).toBe(false);
  });

  it('leaves a partial trailing line for the next read', async () => {
    const [first, second] = textOnlyTurn();
    const half = JSON.stringify(second).slice(0, 20);
    await writeFile(file, JSON.stringify(first) + '\n' + half);
    const one = await readEventsFrom(file, 0);
    expect(one.events).toHaveLength(1);
    expect(one.nextOffset).toBe(Buffer.byteLength(JSON.stringify(first) + '\n'));

    await appendFile(file, JSON.stringify(second).slice(20) + '\n');
    const two = await readEventsFrom(file, one.nextOffset);
    expect(two.events.map(e => e.id)).toEqual([second.id]);
  });

  it('skips malformed lines and counts them', async () => {
    const [first] = textOnlyTurn();
    await writeFile(file, 'not json\n' + JSON.stringify(first) + '\n{"type":1}\n');
    const result = await readEventsFrom(file, 0);
    expect(result.events).toHaveLength(1);
    expect(result.malformed).toBe(2);
  });

  it('reports truncation when the file is smaller than the offset', async () => {
    await writeFile(file, toJsonl(textOnlyTurn()));
    const result = await readEventsFrom(file, 10_000_000);
    expect(result).toMatchObject({ events: [], nextOffset: 0, truncated: true });
  });

  it('returns nothing when there is no new data', async () => {
    const text = toJsonl(textOnlyTurn());
    await writeFile(file, text);
    const size = Buffer.byteLength(text);
    const result = await readEventsFrom(file, size);
    expect(result).toMatchObject({ events: [], nextOffset: size, truncated: false });
  });
});

describe('readSessionHead', () => {
  it('extracts cwd, selected model and auto model from the first lines', async () => {
    await writeFile(file, toJsonl(textOnlyTurn()));
    expect(await readSessionHead(file)).toEqual({
      cwd: '/work/demo', selectedModel: 'auto', autoModel: 'model-a',
    });
  });

  it('returns an empty head for a missing file', async () => {
    expect(await readSessionHead(path.join(dir, 'missing.jsonl'))).toEqual({});
  });
});
