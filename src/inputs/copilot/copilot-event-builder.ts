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
  /** Pending request delta per agent scope: '' is the main agent, otherwise the parent tool call id. */
  deltas: Map<string, JsonValue[]>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const scopeOf = (d: Record<string, unknown>): string => str(d.parentToolCallId) ?? '';
const json = (v: unknown): JsonValue | undefined => (v === undefined ? undefined : v as JsonValue);

/** Copilot stores tool output as text; JSON-looking text becomes a native value (schema gate). */
function nativeValue(v: unknown): JsonValue | undefined {
  if (typeof v !== 'string') return json(v);
  const head = v.trimStart()[0];
  if (head !== '{' && head !== '[') return v;
  try {
    return JSON.parse(v) as JsonValue;
  } catch {
    return v;
  }
}

export function buildCopilotEvents(events: CopilotEvent[], opts: CopilotBuildOptions): AgentActivityEntry[] {
  const ctx: Ctx = {
    opts, out: [], steps: new Map(), toolSteps: new Map(), tools: new Map(),
    selectedModel: opts.selectedModel, autoModel: opts.autoModel, cwd: opts.cwd,
    interactionId: '', firstStep: false, deltas: new Map(),
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
    case 'session.shutdown': emitUsageSummary(ctx, event, at); break;
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
  ctx.deltas = new Map([['', [{ role: 'user', parts: [{ type: 'text', content: str(d.content) ?? '' }] }]]]);
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
  const scope = scopeOf(d);
  const subagent = scope !== '';
  const known = ctx.steps.get(nativeTurnId) ?? newStep(nativeTurnId, turnId, at, event.id);
  // A subagent restarts native turn numbering: keep its step id distinct from the parent's.
  const step = subagent ? { ...known, stepId: `${known.turnId}:${scope}:s${nativeTurnId}` } : known;
  const delta = ctx.deltas.get(scope) ?? [];
  const { parts, toolParts } = assistantParts(d);
  const identity = { sessionId: ctx.opts.sessionId, turnId: step.turnId, stepId: step.stepId };
  const responseModel = str(d.model) ?? ctx.autoModel ?? ctx.selectedModel;

  const request = baseEntry('llm.request', identity, `request:${step.seed}`, step.startMs);
  request['gen_ai.request.id'] = str(d.apiCallId) ?? step.stepId;
  const requested = ctx.selectedModel ?? responseModel;
  if (requested) request['gen_ai.request.model'] = requested;
  if (ctx.firstStep && !subagent) request['gen_ai.turn.start'] = true;
  if (delta.length > 0) request['gen_ai.input.messages_delta'] = delta;

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
  ctx.deltas.set(scope, toolParts.length > 0 ? [{ role: 'assistant', parts: toolParts }] : []);
  if (!subagent) ctx.firstStep = false;
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
  const content = nativeValue(obj(d.result)?.content);
  if (content !== undefined) entry['gen_ai.tool.call.result'] = content;
  if (!success) {
    entry['error.type'] = 'tool_execution_failed';
    const message = str(obj(d.error)?.message);
    if (message) entry['error.message'] = message;
  }
  const duration = at - start.startMs;
  if (duration > 0) entry['gen_ai.tool.call.duration'] = duration;
  push(ctx, entry, str(d.parentToolCallId) !== undefined);
  const scope = scopeOf(d);
  ctx.deltas.set(scope, [...(ctx.deltas.get(scope) ?? []), {
    role: 'tool', parts: [{ type: 'tool_call_response', id: callId, response: content ?? null }],
  }]);
  ctx.tools.delete(callId);
}

const numeric = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** One session-level `other` entry per model; only fields the source actually persists. */
function emitUsageSummary(ctx: Ctx, event: CopilotEvent, at: number): void {
  const metrics = obj(event.data.modelMetrics);
  if (!metrics) return;
  for (const [model, raw] of Object.entries(metrics)) {
    const metric = obj(raw);
    const usage = obj(metric?.usage);
    if (!metric || !usage) continue;
    const entry = baseEntry('other', { sessionId: ctx.opts.sessionId }, `usage:${event.id}:${model}`, at);
    entry['gen_ai.response.model'] = model;
    entry['agent.copilot.usage.scope'] = 'session';
    const fields: Array<[string, number | undefined]> = [
      ['gen_ai.usage.input_tokens', numeric(usage.inputTokens)],
      ['gen_ai.usage.output_tokens', numeric(usage.outputTokens)],
      ['gen_ai.usage.cache_read.input_tokens', numeric(usage.cacheReadTokens)],
      ['gen_ai.usage.cache_creation.input_tokens', numeric(usage.cacheWriteTokens)],
      ['agent.copilot.usage.reasoning_tokens', numeric(usage.reasoningTokens)],
      ['agent.copilot.usage.nano_aiu', numeric(metric.totalNanoAiu)],
    ];
    for (const [key, value] of fields) {
      if (value !== undefined) entry[key] = value;
    }
    push(ctx, entry);
  }
}
