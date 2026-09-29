import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { baseEntry } from './copilot-entry-factory.js';
import type { CopilotBuildOptions, CopilotEvent } from './copilot-types.js';

type Part = Record<string, JsonValue>;

interface Step {
  stepId: string;
  turnId: string;
  startMs: number;
  seed: string;
}

interface ToolStart {
  step: Step;
  startMs: number;
  name: string;
}

interface Ctx {
  opts: CopilotBuildOptions;
  out: AgentActivityEntry[];
  steps: Map<string, Step>;
  toolSteps: Map<string, Step>;
  tools: Map<string, ToolStart>;
  selectedModel?: string;
  autoModel?: string;
  cwd?: string;
  interactionId: string;
  firstStep: boolean;
  pendingDelta: JsonValue[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const json = (v: unknown): JsonValue | undefined => (v === undefined ? undefined : v as JsonValue);

export function buildCopilotEvents(events: CopilotEvent[], opts: CopilotBuildOptions): AgentActivityEntry[] {
  const ctx: Ctx = {
    opts, out: [], steps: new Map(), toolSteps: new Map(), tools: new Map(),
    selectedModel: opts.selectedModel, autoModel: opts.autoModel, cwd: opts.cwd,
    interactionId: '', firstStep: false, pendingDelta: [],
  };
  for (const event of events) {
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) continue;
    handle(ctx, event, at);
  }
  return ctx.out;
}

function handle(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  switch (event.type) {
    case 'session.start':
      ctx.selectedModel = str(d.selectedModel) ?? ctx.selectedModel;
      ctx.cwd = str(obj(d.context)?.cwd) ?? ctx.cwd;
      break;
    case 'session.auto_mode_resolved':
      ctx.autoModel = str(d.chosenModel) ?? ctx.autoModel;
      break;
    case 'user.message': startInteraction(ctx, event); break;
    case 'assistant.turn_start': startStep(ctx, event, at); break;
    case 'assistant.message': emitStep(ctx, event, at); break;
    case 'tool.execution_start': emitToolCall(ctx, event, at); break;
    case 'tool.execution_complete': emitToolResult(ctx, event, at); break;
    default: break;
  }
}

function push(ctx: Ctx, entry: AgentActivityEntry, subagent = false): void {
  if (ctx.cwd) entry['workspace.path'] = ctx.cwd;
  if (subagent) entry['gen_ai.agent.scope'] = 'subagent';
  ctx.out.push(entry);
}

function startInteraction(ctx: Ctx, event: CopilotEvent): void {
  const d = event.data;
  ctx.interactionId = str(d.interactionId) ?? str(d.messageId) ?? event.id;
  ctx.pendingDelta = [{ role: 'user', parts: [{ type: 'text', content: str(d.content) ?? '' }] }];
  ctx.firstStep = true;
  ctx.steps.clear();
  ctx.toolSteps.clear();
  ctx.tools.clear();
}

function newStep(nativeTurnId: string, turnId: string, startMs: number, seed: string): Step {
  return { stepId: `${turnId}:s${nativeTurnId}`, turnId, startMs, seed };
}

function startStep(ctx: Ctx, event: CopilotEvent, at: number): void {
  const nativeTurnId = str(event.data.turnId);
  if (nativeTurnId === undefined) return;
  const turnId = str(event.data.interactionId) ?? ctx.interactionId;
  ctx.steps.set(nativeTurnId, newStep(nativeTurnId, turnId, at, event.id));
}

function assistantParts(d: Record<string, unknown>): { parts: Part[]; toolParts: Part[] } {
  const parts: Part[] = [];
  const reasoning = str(d.reasoningText);
  if (reasoning) parts.push({ type: 'reasoning', content: reasoning });
  const text = str(d.content);
  if (text) parts.push({ type: 'text', content: text });
  const requests = Array.isArray(d.toolRequests) ? d.toolRequests : [];
  const toolParts: Part[] = [];
  for (const raw of requests) {
    const request = obj(raw);
    const id = str(request?.toolCallId);
    const name = str(request?.name);
    if (!request || !id || !name) continue;
    const part: Part = { type: 'tool_call', id, name };
    const args = json(request.arguments);
    if (args !== undefined) part.arguments = args;
    toolParts.push(part);
  }
  return { parts: [...parts, ...toolParts], toolParts };
}

function emitStep(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  const nativeTurnId = str(d.turnId) ?? '';
  const turnId = str(d.interactionId) ?? ctx.interactionId;
  const step = ctx.steps.get(nativeTurnId) ?? newStep(nativeTurnId, turnId, at, event.id);
  const subagent = str(d.parentToolCallId) !== undefined;
  const { parts, toolParts } = assistantParts(d);
  const identity = { sessionId: ctx.opts.sessionId, turnId: step.turnId, stepId: step.stepId };
  const responseModel = str(d.model) ?? ctx.autoModel ?? ctx.selectedModel;

  const request = baseEntry('llm.request', identity, `request:${step.seed}`, step.startMs);
  request['gen_ai.request.id'] = str(d.apiCallId) ?? step.stepId;
  const requested = ctx.selectedModel ?? responseModel;
  if (requested) request['gen_ai.request.model'] = requested;
  if (ctx.firstStep && !subagent) request['gen_ai.turn.start'] = true;
  if (ctx.pendingDelta.length > 0) request['gen_ai.input.messages_delta'] = ctx.pendingDelta;

  const finish = toolParts.length > 0 ? 'tool_call' : 'stop';
  const response = baseEntry('llm.response', identity, `response:${event.id}`, at);
  response['gen_ai.response.id'] = str(d.messageId) ?? event.id;
  if (responseModel) response['gen_ai.response.model'] = responseModel;
  response['gen_ai.response.finish_reasons'] = [finish];
  if (finish === 'stop' && !subagent) response['gen_ai.turn.end'] = true;
  if (parts.length > 0) response['gen_ai.output.messages'] = [{ role: 'assistant', parts, finish_reason: finish }];
  const outputTokens = d.outputTokens;
  if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
    response['gen_ai.usage.output_tokens'] = outputTokens;
  }

  push(ctx, request, subagent);
  push(ctx, response, subagent);
  for (const part of toolParts) ctx.toolSteps.set(String(part.id), step);
  ctx.pendingDelta = toolParts.length > 0 ? [{ role: 'assistant', parts: toolParts }] : [];
  ctx.firstStep = false;
  ctx.steps.delete(nativeTurnId);
}

function emitToolCall(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  const callId = str(d.toolCallId);
  const name = str(d.toolName);
  const step = (callId ? ctx.toolSteps.get(callId) : undefined) ?? ctx.steps.get(str(d.turnId) ?? '');
  if (!callId || !name || !step) return;
  ctx.tools.set(callId, { step, startMs: at, name });
  const entry = baseEntry(
    'tool.call',
    { sessionId: ctx.opts.sessionId, turnId: step.turnId, stepId: step.stepId },
    `tool-call:${callId}`,
    at,
  );
  entry['gen_ai.tool.name'] = name;
  entry['gen_ai.tool.call.id'] = callId;
  const args = json(d.arguments);
  if (args !== undefined) entry['gen_ai.tool.call.arguments'] = args;
  push(ctx, entry, str(d.parentToolCallId) !== undefined);
}

function emitToolResult(ctx: Ctx, event: CopilotEvent, at: number): void {
  const d = event.data;
  const callId = str(d.toolCallId);
  const start = callId ? ctx.tools.get(callId) : undefined;
  if (!callId || !start) return;
  const success = d.success === true;
  const entry = baseEntry(
    'tool.result',
    { sessionId: ctx.opts.sessionId, turnId: start.step.turnId, stepId: start.step.stepId },
    `tool-result:${callId}`,
    at,
  );
  entry['gen_ai.tool.name'] = start.name;
  entry['gen_ai.tool.call.id'] = callId;
  entry['tool.result.status'] = success ? 'success' : 'failure';
  const content = json(obj(d.result)?.content);
  if (content !== undefined) entry['gen_ai.tool.call.result'] = content;
  if (!success) {
    entry['error.type'] = 'tool_execution_failed';
    const message = str(obj(d.error)?.message);
    if (message) entry['error.message'] = message;
  }
  const duration = at - start.startMs;
  if (duration > 0) entry['gen_ai.tool.call.duration'] = duration;
  push(ctx, entry, str(d.parentToolCallId) !== undefined);
  ctx.pendingDelta = [...ctx.pendingDelta, {
    role: 'tool', parts: [{ type: 'tool_call_response', id: callId, response: content ?? null }],
  }];
  ctx.tools.delete(callId);
}
