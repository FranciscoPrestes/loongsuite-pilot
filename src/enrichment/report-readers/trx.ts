/**
 * TRX (Visual Studio / vstest) report reader.
 *
 * Same XXE posture as the JUnit reader: bounded non-validating scan, entities
 * never expanded, DTD/entity declarations refused outright. Unknown or
 * malformed input yields `null` (inconclusive), never a fabricated summary.
 */
import {
  hasUnsafeXmlConstructs,
  xmlAttr,
  xmlAttrInt,
  xmlLinkedExecutionId,
  xmlRootName,
  xmlTags,
} from './junit.js';

interface TrxReportFields {
  runner: string;
  cases: number | null;
  passed: number | null;
  failed: number | null;
  durationMs: number | null;
  linkedExecutionId: string | null;
}

const COUNTER_INT = /^\d{1,12}$/;

function counter(counters: string, name: string): number {
  const raw = xmlAttr(counters, name);
  return raw !== null && COUNTER_INT.test(raw) ? Number(raw) : 0;
}

function requiredCounter(counters: string, name: string): number | null {
  return xmlAttrInt(counters, name);
}

/** TRX `Times` carry ISO-8601 instants; duration falls back to `HH:MM:SS.fffffff`. */
function trxDurationMs(timesTag: string | null): number | null {
  if (!timesTag) return null;
  const creation = xmlAttr(timesTag, 'creation');
  const finish = xmlAttr(timesTag, 'finish');
  if (creation && finish) {
    const start = Date.parse(creation);
    const end = Date.parse(finish);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return end - start;
  }
  const duration = xmlAttr(timesTag, 'duration');
  if (duration) {
    const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?$/.exec(duration);
    if (m) {
      const fraction = m[4] ? Number(`0.${m[4]}`) : 0;
      return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + fraction) * 1000);
    }
  }
  return null;
}

/**
 * Parse a TRX document. Totals come from `<ResultSummary><Counters>`: `cases`
 * is the executed (falling back to total) count; `failed` aggregates the
 * failure-class counters (failed/error/timeout/aborted) because every one of
 * them means the run did not pass. `passed` is the runner's own counter — it
 * is never computed from a missing counter. Missing information stays null.
 */
export function parseTrxReport(text: string): TrxReportFields | null {
  if (hasUnsafeXmlConstructs(text)) return null;
  if (xmlRootName(text) !== 'TestRun') return null;
  if (!/<\/TestRun\s*>/i.test(text)) return null; // truncated / malformed

  const counters = xmlTags(text, 'Counters')[0]?.tag ?? null;
  if (!counters) return null; // no summary to read: inconclusive

  const executed = requiredCounter(counters, 'executed');
  const total = requiredCounter(counters, 'total');
  const cases = executed ?? total;
  const passed = requiredCounter(counters, 'passed');
  const failedClass = ['failed', 'error', 'timeout', 'aborted'].map(name => counter(counters, name));
  const failed = xmlAttr(counters, 'failed') !== null
    ? failedClass.reduce((acc, v) => acc + v, 0)
    : null;
  const timesTag = xmlTags(text, 'Times')[0]?.tag ?? null;

  const rootTag = xmlTags(text, 'TestRun')[0]?.tag ?? null;
  return {
    runner: 'trx',
    cases,
    passed,
    failed,
    durationMs: trxDurationMs(timesTag),
    linkedExecutionId: xmlLinkedExecutionId(text, rootTag),
  };
}
