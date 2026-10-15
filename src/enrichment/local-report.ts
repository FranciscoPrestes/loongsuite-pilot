/**
 * Local verification report evidence (C6).
 *
 * Reads EXISTING local verification reports (JUnit XML / TRX / JSON runner)
 * and produces a bounded `LocalReportSummary` for the `local_report`
 * observation kind. The collector never runs tests or builds to produce a
 * report — it only reads what a runner already wrote.
 *
 * Linkage is proven by identity, never by recency: correlation uses the
 * execution identity (embedded id or delimited file-name token) and the report
 * content hash. mtime alone does NOT prove linkage; a stale leftover report or
 * a merely fresh file stays `association: 'unresolved'` with `executionId: null`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Observation } from '../analytics/observation.js';
import { validateObservation } from '../analytics/observation.js';
import { sanitizeSnippetText } from '../mask/entry-masker.js';
import { isPathInside } from '../normalization/enrich-git-context.js';
import { digest, type LocalJob } from './job-contract.js';
import { parseJUnitReport } from './report-readers/junit.js';
import { parseJsonRunnerReport } from './report-readers/json-runner.js';
import { parseTrxReport } from './report-readers/trx.js';

/** Reports larger than 2 MiB are rejected before any summary is extracted. */
export const reportBytesLimit = 2_097_152;

export interface LocalReportSummary {
  runner: string;
  cases: number | null;
  passed: number | null;
  failed: number | null;
  durationMs: number | null;
  sourceHash: string;
  executionId: string | null;
  association: 'explicit' | 'unresolved';
}

interface ParsedReportFields {
  runner: string;
  cases: number | null;
  passed: number | null;
  failed: number | null;
  durationMs: number | null;
  linkedExecutionId: string | null;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal?.aborted) throw new Error('aborted');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Explicit association requires hard identity. The report's own embedded
 * execution id is the authoritative identity claim: when present it must match
 * the candidate exactly — a contradicting file name can never override it (that
 * would attribute a foreign run's counts to the candidate execution). With no
 * embedded id, the file name may carry the execution id as a delimited token.
 * A report stamped with another execution (a stale leftover from an earlier
 * run) is never re-linked. Returns false for anything weaker.
 */
function hasExplicitLink(linkedExecutionId: string | null, filePath: string, candidate: string | null): boolean {
  if (!candidate || candidate.length === 0 || candidate.length > 500) return false;
  if (linkedExecutionId) return linkedExecutionId === candidate;
  const base = path.basename(filePath, path.extname(filePath));
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(candidate)}([^A-Za-z0-9]|$)`).test(base);
}

function parseReport(filePath: string, text: string): ParsedReportFields | null {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.json') return parseJsonRunnerReport(text);
  const root = /^<([A-Za-z_][\w.:-]*)\b/.exec(text.replace(/<\?[\s\S]*?\?>/g, '').trimStart())?.[1] ?? null;
  if (root === 'TestRun') return parseTrxReport(text);
  if (root === 'testsuites' || root === 'testsuite') return parseJUnitReport(text);
  return null;
}

/**
 * Read one existing local verification report and summarize it.
 *
 * Fail-open and bounded: any read/parse problem returns `null` (inconclusive)
 * and never throws except on cancellation (`aborted`), which must never yield
 * a summary. The file must live inside `workspacePath` (realpath-contained).
 */
export async function readLocalReport(
  filePath: string,
  workspacePath: string,
  executionId: string | null,
  signal: AbortSignal,
): Promise<LocalReportSummary | null> {
  throwIfAborted(signal);
  let resolved: string;
  let root: string;
  try {
    resolved = path.resolve(filePath);
    root = path.resolve(workspacePath);
  } catch {
    return null;
  }
  if (!isPathInside(root, resolved)) return null;

  let size: number;
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return null;
    size = stat.size;
  } catch {
    return null; // the runner never produced a report here
  }
  if (size > reportBytesLimit) return null; // oversize rejected before extraction

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(resolved);
  } catch {
    return null;
  }
  throwIfAborted(signal);
  if (bytes.byteLength > reportBytesLimit) return null;

  // Symlink/path escape: the real file must also stay inside the real root.
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(resolved);
    if (!isPathInside(realRoot, realFile)) return null;
  } catch {
    return null;
  }

  const parsed = parseReport(resolved, bytes.toString('utf8'));
  if (!parsed) return null; // malformed XML / unknown runner: inconclusive

  const linked = hasExplicitLink(parsed.linkedExecutionId, resolved, executionId);
  return {
    runner: sanitizeSnippetText(parsed.runner).slice(0, 100),
    cases: parsed.cases,
    passed: parsed.passed,
    failed: parsed.failed,
    durationMs: parsed.durationMs,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    executionId: linked ? executionId : null,
    association: linked ? 'explicit' : 'unresolved',
  };
}

/**
 * Wrap a report summary into a correlated `local_report` observation.
 *
 * The supplement always references the ORIGINAL call (`toolCallId` and
 * `sourceRefs` come from the triggering job): it is evidence about that call
 * and never emits a second call. `executionId` is kept only when the report
 * proved a link to that same original call; otherwise it degrades to
 * `null` + `association: 'unresolved'`.
 */
export function buildLocalReportObservation(
  job: LocalJob,
  summary: LocalReportSummary,
  capturedAt: string = new Date().toISOString(),
): Observation {
  const explicit = summary.executionId !== null && summary.executionId === job.nativeCallId;
  const missingFields: string[] = [];
  if (summary.cases === null) missingFields.push('cases');
  if (summary.passed === null) missingFields.push('passed');
  if (summary.failed === null) missingFields.push('failed');
  if (summary.durationMs === null) missingFields.push('durationMs');
  if (!explicit) missingFields.push('executionId');
  const observation = {
    schemaVersion: '1' as const,
    observationId: digest(JSON.stringify([job.id, summary.sourceHash, 'local_report'])),
    harnessId: job.harnessId,
    harnessVersion: job.harnessVersion,
    collectorVersion: job.collectorVersion,
    deviceId: job.deviceId,
    sessionId: job.sessionId,
    capabilitiesVersion: job.capabilitiesVersion,
    occurredAt: capturedAt,
    missingFields,
    truncated: false,
    sourceRefs: job.sourceRefs,
    generatedBy: 'collector' as const,
    kind: 'local_report' as const,
    payload: {
      runner: sanitizeSnippetText(summary.runner).slice(0, 100),
      cases: summary.cases,
      passed: summary.passed,
      failed: summary.failed,
      durationMs: summary.durationMs,
      sourceHash: summary.sourceHash,
      executionId: explicit ? job.nativeCallId : null,
      association: explicit ? ('explicit' as const) : ('unresolved' as const),
    },
    ...(job.turnId ? { turnId: job.turnId } : {}),
    ...(job.parentCallId ? { parentCallId: job.parentCallId } : {}),
    ...(job.nativeCallId ? { toolCallId: job.nativeCallId } : {}),
  };
  return validateObservation(observation);
}
