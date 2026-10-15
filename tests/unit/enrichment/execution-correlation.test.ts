import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentActivityEntry, JsonValue } from '../../../src/types/index.js';
import {
  correlateExecution,
  resetExecutionCorrelator,
} from '../../../src/enrichment/execution-correlation.js';

interface EntryOverrides {
  event?: 'tool.call' | 'tool.result' | 'other';
  sessionId?: string;
  namespace?: string;
  callId?: string;
  execId?: string | null;
  phase?: 'spawned' | 'exited';
  parentCallId?: string;
  result?: JsonValue;
  status?: string;
}

function entry(overrides: EntryOverrides = {}): AgentActivityEntry {
  const {
    event = 'tool.call',
    sessionId = 'session-a',
    namespace = 'proc-1',
    callId = 'call-1',
    execId,
    phase,
    parentCallId,
    result,
    status,
  } = overrides;
  return {
    time_unix_nano: '1760430000000000000',
    'event.id': `event-${Math.random().toString(16).slice(2)}`,
    'event.name': event,
    'user.id': 'user-1',
    'gen_ai.session.id': sessionId,
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.provider.name': 'anthropic',
    'gen_ai.data_source.id': namespace,
    'gen_ai.tool.name': 'Bash',
    'gen_ai.tool.call.id': callId,
    ...(execId === null ? {} : { 'gen_ai.tool.call.exec.id': execId ?? callId }),
    ...(phase ? { 'gen_ai.tool.call.exec.phase': phase } : {}),
    ...(parentCallId ? { 'gen_ai.subagent.parent_tool_call.id': parentCallId } : {}),
    ...(result !== undefined ? { 'gen_ai.tool.call.result': result } : {}),
    ...(status ? { 'tool.result.status': status } : {}),
  };
}

beforeEach(() => {
  resetExecutionCorrelator();
});

describe('execution correlation', () => {
  it('async_poll_joins_original_execution', () => {
    // The async spawn starts the execution under a process handle.
    const start = correlateExecution(entry({
      callId: 'call-spawn',
      execId: 'bg-task-1',
      result: { status: 'running' },
    }));
    expect(start.executionId).not.toBeNull();
    expect(start.terminal).toBe(false);

    // A later async poll is a different tool call but the SAME process handle:
    // it joins the original execution instead of minting a second one.
    const final = correlateExecution(entry({
      event: 'tool.result',
      callId: 'call-poll',
      execId: 'bg-task-1',
      result: { output: 'done', exit_code: 0 },
    }));
    expect(final.executionId).toBe(start.executionId);
    expect(final.terminal).toBe(true);
    expect(final.exitCode).toBe(0);
  });

  it('same_handle_other_session_not_joined', () => {
    const start = correlateExecution(entry({ callId: 'call-1', execId: 'pid-42' }));
    const other = correlateExecution(entry({
      sessionId: 'session-b',
      callId: 'call-2',
      execId: 'pid-42',
    }));
    expect(other.executionId).not.toBeNull();
    expect(other.executionId).not.toBe(start.executionId);
  });

  it('never_promotes_tool_completion_to_runner_approval', () => {
    // A completed tool result with only a declared status carries NO exit code:
    // tool completion is never runner approval, and nothing is fabricated.
    const result = correlateExecution(entry({
      event: 'tool.result',
      callId: 'call-2',
      status: 'success',
      result: 'all good',
    }));
    expect(result.terminal).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Object.keys(result).sort()).toEqual(['executionId', 'exitCode', 'parentExecutionId', 'terminal']);
  });

  it('composite_command_with_single_exitcode', () => {
    const start = correlateExecution(entry({
      callId: 'call-comp',
      execId: 'shell-1',
      result: { command: 'npm test && npm build' },
    }));
    // The single aggregate exit code belongs to the whole execution.
    const final = correlateExecution(entry({
      event: 'tool.result',
      callId: 'call-comp',
      execId: 'shell-1',
      result: { command: 'npm test && npm build', exit_code: 2 },
    }));
    expect(final.exitCode).toBe(2);
    expect(final.executionId).toBe(start.executionId);

    // A composite command is never split into sub-executions: a segment record
    // without its own exit evidence never inherits (is never projected) the
    // aggregate exit code.
    const sub = correlateExecution(entry({
      event: 'other',
      callId: 'call-comp',
      execId: 'shell-1',
    }));
    expect(sub.executionId).toBe(final.executionId);
    expect(sub.exitCode).toBeNull();
  });

  it('pid_handle_reuse_starts_a_new_execution', () => {
    const first = correlateExecution(entry({ callId: 'call-a', execId: 'pid-7' }));
    const firstResult = correlateExecution(entry({
      event: 'tool.result',
      callId: 'call-a',
      execId: 'pid-7',
      result: { exit_code: 1 },
    }));
    expect(firstResult.executionId).toBe(first.executionId);
    expect(firstResult.exitCode).toBe(1);

    // The same PID/handle is reused by a NEW call after the first is terminal.
    const reused = correlateExecution(entry({ callId: 'call-b', execId: 'pid-7' }));
    expect(reused.executionId).not.toBeNull();
    expect(reused.executionId).not.toBe(first.executionId);

    // A late poll still identifiable by its call id stays with the ORIGINAL.
    const late = correlateExecution(entry({
      event: 'tool.result',
      callId: 'call-a',
      execId: 'pid-7',
    }));
    expect(late.executionId).toBe(first.executionId);
  });

  it('subagent_execution_links_to_the_parent_call', () => {
    const parent = correlateExecution(entry({ callId: 'agent-call-1', execId: 'agent-call-1' }));
    const child = correlateExecution(entry({
      callId: 'sub-call-1',
      execId: 'sub-handle-1',
      parentCallId: 'agent-call-1',
    }));
    expect(child.executionId).not.toBe(parent.executionId);
    expect(child.parentExecutionId).toBe(parent.executionId);

    // Without an explicit parent link the relation is inconclusive, never guessed.
    const orphan = correlateExecution(entry({ callId: 'sub-call-2', execId: 'sub-handle-2' }));
    expect(orphan.parentExecutionId).toBeNull();
  });

  it('missing_identity_is_inconclusive', () => {
    const unknown = correlateExecution(entry({ callId: 'call-x', execId: null, sessionId: '' , event: 'tool.result' }));
    expect(unknown.executionId).toBeNull();
    expect(unknown.parentExecutionId).toBeNull();
    expect(unknown.terminal).toBe(true);
    expect(unknown.exitCode).toBeNull();
  });
});
