import * as path from 'node:path';
import type { AgentActivityEntry } from '../types/index.js';
import { readJsonFile, writeTextFileAtomic } from '../utils/fs-utils.js';
import { HEALTHY_EVENT_WINDOW_MS, validEvidenceTime } from './capability-observer.js';

/** Cross-process seam: the collector records validated native evidence, the updater process inspects it. */
export const VALIDATED_EVENT_FILE = ['analytics', 'validated-event.json'] as const;
const THROTTLE_MS = 5_000;
export const INSPECT_DEADLINE_MS = 1_800;
const POLL_MS = 100;

interface Marker { at: number; harnessId: string }

export class ValidatedEventRecorder {
  private lastWrite = 0;
  private writing: Promise<void> | null = null;
  constructor(private readonly dataDir: string, private readonly now: () => number = Date.now) {}

  /** Fail-open and throttled: evidence bookkeeping never delays or fails base capture. */
  record(entry: AgentActivityEntry): Promise<void> {
    const nowMs = this.now();
    const at = validEvidenceTime(entry, nowMs);
    if (at === null || nowMs - this.lastWrite < THROTTLE_MS || this.writing) return this.writing ?? Promise.resolve();
    this.lastWrite = nowMs;
    const marker: Marker = { at, harnessId: String(entry['gen_ai.agent.type']) };
    this.writing = writeTextFileAtomic(path.join(this.dataDir, ...VALIDATED_EVENT_FILE), JSON.stringify(marker) + '\n', { mode: 0o600 })
      .catch(() => undefined).finally(() => { this.writing = null; });
    return this.writing;
  }
}

export interface InspectOptions {
  now?: () => number; sleep?: (ms: number) => Promise<void>; windowMs?: number; deadlineMs?: number;
}

/**
 * Evidence check for a candidate bundle: a validated native event inside the health window, either
 * already recorded or arriving within the 2 s inspect deadline. It cannot attribute the event to the
 * candidate bundle itself; it is the strongest evidence available without a live harness (acceptance pending).
 */
export async function inspectValidatedEvent(dataDir: string, signal: AbortSignal, options: InspectOptions = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const window = options.windowMs ?? HEALTHY_EVENT_WINDOW_MS;
  const deadline = now() + (options.deadlineMs ?? INSPECT_DEADLINE_MS);
  const file = path.join(dataDir, ...VALIDATED_EVENT_FILE);
  while (!signal.aborted) {
    const marker = await readJsonFile<Marker>(file).catch(() => null);
    const current = now();
    if (marker && Number.isFinite(marker.at) && marker.at <= current + 5_000 && current - marker.at <= window) return true;
    if (current >= deadline) return false;
    await sleep(POLL_MS);
  }
  return false;
}
