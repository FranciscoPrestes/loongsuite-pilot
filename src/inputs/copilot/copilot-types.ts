export const COPILOT_PROVIDER = 'github-copilot';

/** One line of ~/.copilot/session-state/<id>/events.jsonl. */
export interface CopilotEvent {
  type: string;
  id: string;
  timestamp: string;
  parentId: string | null;
  data: Record<string, unknown>;
}

/** Facts from the top of a transcript that later spans still need. */
export interface CopilotSessionHead {
  cwd?: string;
  selectedModel?: string;
  autoModel?: string;
}

export interface CopilotBuildOptions extends CopilotSessionHead {
  sessionId: string;
}

export interface ReadEventsResult {
  events: CopilotEvent[];
  /** Byte offset where each event starts, aligned with `events`. */
  offsets: number[];
  /** Offset just past the last complete line consumed. */
  nextOffset: number;
  /** True when the file is now smaller than the requested offset. */
  truncated: boolean;
  malformed: number;
}
