/**
 * JSON runner report reader (jest/vitest/mocha-style JSON or a plain summary).
 *
 * Pure parse of an existing report file: nothing is executed and no external
 * resource is consulted. Malformed or unrecognizable JSON yields `null`
 * (inconclusive), never a fabricated summary. Counters that are absent stay
 * `null`; a declared `0` is preserved (never coerced).
 */

interface JsonReportFields {
  runner: string;
  cases: number | null;
  passed: number | null;
  failed: number | null;
  durationMs: number | null;
  linkedExecutionId: string | null;
}

const COUNT_KEYS: Record<'cases' | 'passed' | 'failed', readonly string[]> = {
  cases: ['cases', 'tests', 'total', 'numTotalTests'],
  passed: ['passed', 'passes', 'numPassedTests'],
  failed: ['failed', 'failures', 'numFailedTests'],
};

const DURATION_KEYS = ['durationMs', 'duration_ms', 'duration', 'time'] as const;
const LINK_KEYS = ['executionId', 'execution_id', 'execId', 'toolCallId', 'tool_call_id'] as const;
const RUNNER_PATTERN = /^[A-Za-z0-9_.:-]{1,100}$/;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function pickCount(sources: readonly Record<string, unknown>[], keys: readonly string[]): number | null {
  for (const source of sources) {
    for (const key of keys) {
      if (key in source) {
        const value = count(source[key]);
        if (value !== null) return value;
      }
    }
  }
  return null;
}

function pickDurationMs(sources: readonly Record<string, unknown>[]): number | null {
  for (const source of sources) {
    for (const key of DURATION_KEYS) {
      const value = source[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.round(value);
    }
  }
  const first = sources[0];
  if (first && typeof first.startTime === 'number' && typeof first.endTime === 'number'
    && Number.isFinite(first.startTime) && Number.isFinite(first.endTime) && first.endTime >= first.startTime) {
    return Math.round(first.endTime - first.startTime);
  }
  return null;
}

function pickLink(sources: readonly Record<string, unknown>[]): string | null {
  for (const source of sources) {
    for (const key of LINK_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && value.length > 0 && value.length <= 500) return value;
    }
  }
  return null;
}

/**
 * Parse a JSON runner report. Top-level counters win; a nested `stats` object
 * (mocha style) is consulted as a fallback. At least one recognizable counter
 * is required — a JSON document without runner evidence is inconclusive.
 */
export function parseJsonRunnerReport(text: string): JsonReportFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const root = object(parsed);
  if (!root) return null;
  const stats = object(root.stats);
  const sources = stats ? [root, stats] : [root];

  const cases = pickCount(sources, COUNT_KEYS.cases);
  const passed = pickCount(sources, COUNT_KEYS.passed);
  const failed = pickCount(sources, COUNT_KEYS.failed);
  if (cases === null && passed === null && failed === null) return null;

  const declared = typeof root.runner === 'string' && RUNNER_PATTERN.test(root.runner) ? root.runner : 'json';
  return {
    runner: declared,
    cases,
    passed,
    failed,
    durationMs: pickDurationMs(sources),
    linkedExecutionId: pickLink(sources),
  };
}
