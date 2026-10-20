/**
 * Execution correlation (C6).
 *
 * Derives a stable, session-scoped execution identity from captured telemetry
 * entries so async polling joins the ORIGINAL execution and supplementary
 * evidence (`local_report` / `command_context`) can reference the original call
 * — never a second call.
 *
 * Entry fields consumed (all pre-existing or additive `gen_ai.*` conventions):
 * - `gen_ai.session.id`            session scope (required for identity)
 * - `gen_ai.data_source.id`        process namespace
 * - `gen_ai.tool.call.exec.id`     process/execution handle (primary join key)
 * - `gen_ai.tool.call.id`          call identity / handle fallback / reuse key
 * - `gen_ai.tool.call.exec.phase`  `spawned` marks an async launch ack (not final)
 * - `gen_ai.subagent.parent_tool_call.id`  parent call for subagent executions
 * - `gen_ai.tool.call.result`      structured exit evidence (`exit_code`/`exitCode`)
 *
 * Hard rules:
 * - Tool completion is NEVER runner approval: `terminal` only says the
 *   execution's final result was captured. No pass/fail/approval is derived
 *   here (that is the central ActionFact classifier's job, plan B6). A poll
 *   call completing on a running async execution is progress, not final.
 * - `exitCode` is reported ONLY from observed exit evidence on the entry's own
 *   result — never inferred from `tool.result.status`, never fabricated, and
 *   never projected from a composite command onto subcommands.
 * - The same handle in another session is NOT joined (parent links are scoped
 *   by session/namespace too). Continued polling of a live async execution
 *   keeps joining the ORIGINAL execution; only a genuine PID/handle reuse — a
 *   new start after the previous execution's result was observed final — mints
 *   a new execution. A poll that can still be identified by its call id stays
 *   with its original execution even after reuse.
 * - A parent that cannot be resolved to a KNOWN execution is `null`
 *   (inconclusive) — a parent id is never fabricated from the call id.
 */
import { createHash } from 'node:crypto';
import type { AgentActivityEntry, JsonValue } from '../types/index.js';

export interface ExecutionCorrelation {
  executionId: string | null;
  parentExecutionId: string | null;
  terminal: boolean;
  exitCode: number | null;
}

interface ExecutionGeneration {
  executionId: string;
  generation: number;
  /** Call id whose observation created this generation (the spawn/original). */
  originCallId: string | null;
  callIds: Set<string>;
  /** An async launch ack (`exec.phase: 'spawned'`) was observed for it. */
  asyncDeclared: boolean;
  /** The execution's final result was observed (exit evidence / own result). */
  terminalSeen: boolean;
}

interface HandleRecord {
  session: string;
  namespace: string;
  handle: string;
  generations: ExecutionGeneration[];
}

const MAX_TRACKED_HANDLES = 256;
const MAX_GENERATIONS_PER_HANDLE = 4;

/** Bounded per-process registry: handle key -> session-scoped handle record. */
const registry = new Map<string, HandleRecord>();

/** Test seam / C8 session reset: drop all correlated execution state. */
export function resetExecutionCorrelator(): void {
  registry.clear();
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !value.includes('\0')
    ? value
    : null;
}

function executionIdFor(key: string, generation: number): string {
  return `exec_${createHash('sha256').update(`${key}\0${generation}`).digest('hex').slice(0, 32)}`;
}

function pruneRegistry(): void {
  while (registry.size > MAX_TRACKED_HANDLES) {
    const oldest = registry.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    registry.delete(oldest);
  }
}

function mintGeneration(record: HandleRecord, callId: string | null, generation: number): ExecutionGeneration {
  const key = handleKey(record.session, record.namespace, record.handle);
  const created: ExecutionGeneration = {
    executionId: executionIdFor(key, generation),
    generation,
    originCallId: callId,
    callIds: new Set(callId ? [callId] : []),
    asyncDeclared: false,
    terminalSeen: false,
  };
  record.generations.push(created);
  while (record.generations.length > MAX_GENERATIONS_PER_HANDLE) record.generations.shift();
  return created;
}

function handleKey(session: string, namespace: string, handle: string): string {
  return `${session}\0${namespace}\0${handle}`;
}

function findGenerationByCall(record: HandleRecord, callId: string): ExecutionGeneration | null {
  for (let i = record.generations.length - 1; i >= 0; i -= 1) {
    if (record.generations[i].callIds.has(callId)) return record.generations[i];
  }
  return null;
}

/**
 * Resolve the generation an entry belongs to without yet committing any
 * terminal state (finality is computed afterwards and needs the generation).
 */
function resolveGeneration(record: HandleRecord, callId: string | null, isStart: boolean): ExecutionGeneration | null {
  if (callId) {
    const known = findGenerationByCall(record, callId);
    if (known) return known;
  }
  const current = record.generations[record.generations.length - 1];
  if (!current) return mintGeneration(record, callId, 1);
  if (isStart) {
    if (current.terminalSeen) {
      // Genuine PID/handle reuse: the handle now names a NEW process/execution.
      return mintGeneration(record, callId, current.generation + 1);
    }
    // Continued polling / a parallel call on the live execution: join it.
    if (callId) current.callIds.add(callId);
    return current;
  }
  if (current.terminalSeen) {
    // A non-identifiable record after a final result on a reused handle is
    // genuinely ambiguous: inconclusive instead of a guessed join.
    return null;
  }
  // Async polling on a live execution joins the ORIGINAL execution.
  if (callId) current.callIds.add(callId);
  return current;
}

/** Exit code observed on the entry's own result payload, when explicitly present. */
function observedExitCode(result: JsonValue | undefined): number | null {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, JsonValue | undefined>;
  for (const key of ['exit_code', 'exitCode']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2_147_483_647) {
      return value;
    }
  }
  return null;
}

/**
 * Is this entry the execution's FINAL result?
 *
 * - `spawned` (async launch ack) is never final; `exited` always is.
 * - Observed exit evidence is final (the poll that reports the exit code).
 * - On an async execution, a poll call completing without exit evidence is
 *   progress — NOT final (tool completion is never runner approval).
 * - Otherwise a result of the execution's ORIGIN call is that call's own final
 *   result; a later call's bare result is treated as progress.
 */
function isFinalResult(
  generation: ExecutionGeneration | null,
  isResult: boolean,
  phase: string | null,
  callId: string | null,
  exitCode: number | null,
): boolean {
  if (!isResult) return false;
  if (phase === 'spawned') return false;
  if (phase === 'exited') return true;
  if (exitCode !== null) return true;
  if (!generation) return true;
  if (generation.asyncDeclared) return false;
  if (callId && generation.originCallId && callId !== generation.originCallId) return false;
  return true;
}

/**
 * Resolve the parent execution of a subagent record. Scoped to the SAME
 * session/namespace (a same-named parent call in another session is never
 * joined). Only a KNOWN execution id is returned; an unobserved parent is
 * inconclusive (`null`), never a fabricated derived id.
 */
function parentLink(entry: AgentActivityEntry, namespace: string, session: string): string | null {
  const parentCall = text(entry['gen_ai.subagent.parent_tool_call.id']);
  if (!parentCall || !session) return null;
  for (const record of registry.values()) {
    if (record.session !== session || record.namespace !== namespace) continue;
    const known = findGenerationByCall(record, parentCall);
    if (known) return known.executionId;
  }
  return null;
}

/**
 * Correlate one captured entry to its execution. Pure per entry except for the
 * bounded handle registry that disambiguates PID/handle reuse and joins async
 * polls to the original execution.
 */
export function correlateExecution(entry: AgentActivityEntry): ExecutionCorrelation {
  const session = text(entry['gen_ai.session.id']) ?? '';
  const namespace = text(entry['gen_ai.data_source.id']) ?? '';
  const callId = text(entry['gen_ai.tool.call.id']);
  const handle = text(entry['gen_ai.tool.call.exec.id']) ?? callId;
  const phase = text(entry['gen_ai.tool.call.exec.phase']);
  const isStart = entry['event.name'] === 'tool.call';
  const isResult = entry['event.name'] === 'tool.result';
  const exitCode = isResult ? observedExitCode(entry['gen_ai.tool.call.result']) : null;

  if (!session || !handle) {
    // Identity inconclusive: report only what the entry itself proves.
    return {
      executionId: null,
      parentExecutionId: null,
      terminal: isFinalResult(null, isResult, phase, callId, exitCode),
      exitCode,
    };
  }

  const key = handleKey(session, namespace, handle);
  let record = registry.get(key);
  if (!record) {
    record = { session, namespace, handle, generations: [] };
    registry.set(key, record);
    pruneRegistry();
  }
  const generation = resolveGeneration(record, callId, isStart);
  const terminal = isFinalResult(generation, isResult, phase, callId, exitCode);
  if (generation) {
    if (phase === 'spawned') generation.asyncDeclared = true;
    if (terminal) generation.terminalSeen = true;
    if (callId) generation.callIds.add(callId);
  }
  return {
    executionId: generation ? generation.executionId : null,
    parentExecutionId: parentLink(entry, namespace, session),
    terminal,
    exitCode,
  };
}
