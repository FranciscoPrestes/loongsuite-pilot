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
 * - Tool completion is NEVER runner approval: `terminal` only says the tool's
 *   final result was captured. No pass/fail/approval is derived here (that is
 *   the central ActionFact classifier's job, plan B6).
 * - `exitCode` is reported ONLY from observed exit evidence on the entry's own
 *   result — never inferred from `tool.result.status`, never fabricated, and
 *   never projected from a composite command onto subcommands.
 * - The same handle in another session is NOT joined. PID/handle reuse after a
 *   terminal result mints a NEW execution; a poll that can still be identified
 *   by its call id stays with its original execution.
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
  callIds: Set<string>;
  terminalSeen: boolean;
}

const MAX_TRACKED_HANDLES = 256;
const MAX_GENERATIONS_PER_HANDLE = 4;

/** Bounded per-process registry: handle key -> generations (oldest first). */
const registry = new Map<string, ExecutionGeneration[]>();

/** Test seam / C8 session reset: drop all correlated execution state. */
export function resetExecutionCorrelator(): void {
  registry.clear();
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 ? value : null;
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

function generationFor(key: string, callId: string | null, isStart: boolean, marksTerminal: boolean): ExecutionGeneration | null {
  let generations = registry.get(key);
  if (!generations) {
    const created: ExecutionGeneration = {
      executionId: executionIdFor(key, 1),
      generation: 1,
      callIds: new Set(callId ? [callId] : []),
      terminalSeen: marksTerminal,
    };
    registry.set(key, [created]);
    pruneRegistry();
    return created;
  }
  if (callId) {
    for (let i = generations.length - 1; i >= 0; i -= 1) {
      if (generations[i].callIds.has(callId)) {
        if (marksTerminal) generations[i].terminalSeen = true;
        return generations[i];
      }
    }
  }
  const current = generations[generations.length - 1];
  if (isStart) {
    if (current.terminalSeen) {
      // PID/handle reuse: the handle names a NEW process/execution.
      const created: ExecutionGeneration = {
        executionId: executionIdFor(key, current.generation + 1),
        generation: current.generation + 1,
        callIds: new Set(callId ? [callId] : []),
        terminalSeen: marksTerminal,
      };
      generations.push(created);
      while (generations.length > MAX_GENERATIONS_PER_HANDLE) generations.shift();
      return created;
    }
    if (callId) current.callIds.add(callId);
    return current;
  }
  if (current.terminalSeen) {
    // A non-identifiable record after a terminal result on a reused handle is
    // genuinely ambiguous: inconclusive instead of a guessed join.
    return null;
  }
  // Async polling on a live execution joins the ORIGINAL execution.
  if (callId) current.callIds.add(callId);
  if (marksTerminal) current.terminalSeen = true;
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

function parentLink(entry: AgentActivityEntry, namespace: string, session: string): string | null {
  const parentCall = text(entry['gen_ai.subagent.parent_tool_call.id']);
  if (!parentCall || !session) return null;
  // Find the parent generation by its call id across handles (the parent's
  // handle may differ from its call id).
  for (const generations of registry.values()) {
    for (let i = generations.length - 1; i >= 0; i -= 1) {
      if (generations[i].callIds.has(parentCall)) return generations[i].executionId;
    }
  }
  // Deterministic first-generation derivation: correct when the parent's
  // handle is its call id (or no reuse has been observed). Never guessed from
  // timing or text.
  const key = `${session}\0${namespace}\0${parentCall}`;
  return executionIdFor(key, 1);
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
  // An async launch acknowledgement ("spawned") is not the final result even
  // though it arrives on a tool.result record: tool completion is never
  // promoted to runner approval.
  const terminal = isResult && phase !== 'spawned';
  const exitCode = isResult ? observedExitCode(entry['gen_ai.tool.call.result']) : null;

  if (!session || !handle) {
    return { executionId: null, parentExecutionId: null, terminal, exitCode };
  }

  const key = `${session}\0${namespace}\0${handle}`;
  const generation = generationFor(key, callId, isStart, terminal);
  return {
    executionId: generation ? generation.executionId : null,
    parentExecutionId: parentLink(entry, namespace, session),
    terminal,
    exitCode,
  };
}
