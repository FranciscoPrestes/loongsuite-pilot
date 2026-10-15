/**
 * JUnit XML report reader.
 *
 * XXE safety by construction: this is a bounded, non-validating scanner — it
 * NEVER expands entities, never fetches DTDs and never executes anything. Any
 * document declaring a DTD or entities (`<!DOCTYPE` / `<!ENTITY`) is refused
 * outright so an external-entity payload can never be resolved. Malformed or
 * unrecognizable input yields `null` (inconclusive), never a fabricated summary.
 *
 * The exported XML primitives are shared with the TRX reader.
 */

export interface XmlReportFields {
  runner: string;
  cases: number | null;
  passed: number | null;
  failed: number | null;
  durationMs: number | null;
  /** Execution identity explicitly embedded by the runner, when present. */
  linkedExecutionId: string | null;
}

const MAX_LINK_ID_LENGTH = 500;

/** Fail closed on DTD/entity declarations: external entities stay disabled. */
export function hasUnsafeXmlConstructs(text: string): boolean {
  return /<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text);
}

/** Name of the first real element (skipping declarations and comments). */
export function xmlRootName(text: string): string | null {
  const stripped = text
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trimStart();
  const match = /^<([A-Za-z_][\w.:-]*)\b/.exec(stripped);
  return match ? match[1] : null;
}

/** Attributes of one raw open tag. Entity references are never expanded. */
export function xmlAttr(tag: string, name: string): string | null {
  const double = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  if (double) return double[1];
  const single = new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return single ? single[1] : null;
}

/** Strict bounded non-negative integer attribute; anything else is unknown. */
export function xmlAttrInt(tag: string, name: string): number | null {
  const raw = xmlAttr(tag, name);
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  return Number(raw);
}

/** Strict bounded non-negative float attribute (seconds, e.g. JUnit `time`). */
export function xmlAttrSecondsToMs(tag: string, name: string): number | null {
  const raw = xmlAttr(tag, name);
  if (raw === null || !/^\d{1,9}(\.\d{1,9})?$/.test(raw)) return null;
  return Math.round(Number(raw) * 1000);
}

export interface XmlTagMatch {
  /** The raw open tag, e.g. `<testsuite tests="3">`. */
  tag: string;
  /** Whether the tag closes itself (`<tag ... />`). */
  selfClosing: boolean;
  /** Nesting depth at which this tag opened (0 for top-level). */
  depth: number;
}

/**
 * Scan `<name ...>` / `</name>` tags in document order with a nesting depth,
 * so aggregate counters can be read from top-level suites only.
 */
export function xmlTags(text: string, name: string): XmlTagMatch[] {
  const matches: XmlTagMatch[] = [];
  const re = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const closing = m[1] === '/';
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const selfClosing = /\/>$/.test(raw);
    matches.push({ tag: raw, selfClosing, depth });
    if (!selfClosing) depth += 1;
  }
  return matches;
}

const EXECUTION_ID_PROPERTY = /^(executionid|execution-id|nttes\.executionid|toolcallid|tool-call-id)$/i;

/**
 * Execution identity explicitly embedded by the runner: a stamped property
 * (`<property name="executionId" value="..."/>`) or a root attribute. This is
 * hard identity evidence — never a timestamp.
 */
export function xmlLinkedExecutionId(text: string, rootTag: string | null): string | null {
  for (const { tag } of xmlTags(text, 'property')) {
    const name = xmlAttr(tag, 'name');
    if (!name || !EXECUTION_ID_PROPERTY.test(name)) continue;
    const value = xmlAttr(tag, 'value');
    if (value && value.length > 0 && value.length <= MAX_LINK_ID_LENGTH) return value;
  }
  if (rootTag) {
    const direct = xmlAttr(rootTag, 'execution-id') ?? xmlAttr(rootTag, 'executionId');
    if (direct && direct.length > 0 && direct.length <= MAX_LINK_ID_LENGTH) return direct;
  }
  return null;
}

interface SuiteTotals {
  cases: number | null;
  failures: number | null;
  errors: number | null;
  skipped: number | null;
  durationMs: number | null;
}

function suiteTotals(tag: string): SuiteTotals {
  return {
    cases: xmlAttrInt(tag, 'tests'),
    failures: xmlAttrInt(tag, 'failures'),
    errors: xmlAttrInt(tag, 'errors'),
    skipped: xmlAttrInt(tag, 'skipped'),
    durationMs: xmlAttrSecondsToMs(tag, 'time'),
  };
}

function sumNullable(values: readonly (number | null)[]): number | null {
  if (values.some(v => v === null)) return null;
  return values.reduce<number>((acc, v) => acc + (v as number), 0);
}

/**
 * Parse a JUnit XML document. Counters come from the runner's own attributes:
 * the root `testsuites` aggregate when present, otherwise the top-level
 * `testsuite` elements (nested suites are excluded to avoid double counting).
 * A counter that is absent stays `null` — missing information is never zero.
 */
export function parseJUnitReport(text: string): XmlReportFields | null {
  if (hasUnsafeXmlConstructs(text)) return null;
  const root = xmlRootName(text);
  if (root !== 'testsuites' && root !== 'testsuite') return null;
  const closesRoot = root === 'testsuites' ? /<\/testsuites\s*>/i.test(text) : /<\/testsuite\s*>/i.test(text);
  if (!closesRoot) return null; // truncated / malformed

  const rootTag = xmlTags(text, root)[0]?.tag ?? null;
  let totals: SuiteTotals;
  if (root === 'testsuite') {
    totals = rootTag ? suiteTotals(rootTag) : emptyTotals();
  } else if (rootTag && xmlAttrInt(rootTag, 'tests') !== null) {
    totals = suiteTotals(rootTag);
  } else {
    const topLevel = xmlTags(text, 'testsuite').filter(t => t.depth === 0);
    totals = topLevel.length > 0 ? combine(topLevel.map(t => suiteTotals(t.tag))) : emptyTotals();
  }

  const failed = sumNullable([totals.failures, totals.errors]);
  const passed = totals.cases !== null && failed !== null && totals.skipped !== null
    ? Math.max(0, totals.cases - failed - totals.skipped)
    : null;
  return {
    runner: 'junit',
    cases: totals.cases,
    passed,
    failed,
    durationMs: totals.durationMs,
    linkedExecutionId: xmlLinkedExecutionId(text, rootTag),
  };
}

function emptyTotals(): SuiteTotals {
  return { cases: null, failures: null, errors: null, skipped: null, durationMs: null };
}

function combine(list: readonly SuiteTotals[]): SuiteTotals {
  return {
    cases: sumNullable(list.map(t => t.cases)),
    failures: sumNullable(list.map(t => t.failures)),
    errors: sumNullable(list.map(t => t.errors)),
    skipped: sumNullable(list.map(t => t.skipped)),
    durationMs: sumNullable(list.map(t => t.durationMs)),
  };
}
