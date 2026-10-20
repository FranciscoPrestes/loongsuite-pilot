// Generated from the canonical JSON Schema; do not edit by hand.
// SHA-256: 1cff99671d1a696c7e1b856b8ee1119cd99166a80876f7c0b9edca28e053f9d0
export type Observation = {
  "schemaVersion": "1";
  "observationId": string;
  "harnessId": string;
  "harnessVersion": string;
  "collectorVersion": string;
  "deviceId": string;
  "turnId"?: string;
  "parentCallId"?: string;
  "occurredAt": string;
  "occurredAtNs"?: string;
  "sequence"?: string;
  "workspaceId"?: string;
  "repoKey"?: string;
  "worktreeId"?: string;
  "capabilitiesVersion": string;
  "missingFields": Array<string>;
  "truncated": boolean;
  "sourceRefs": Array<{
    "sourceNamespace": string;
    "nativeId": string;
    "phase": "started" | "progress" | "completed" | "cancelled" | "event";
    "traceId"?: string;
    "spanId"?: string;
    "eventId"?: string;
    "contentHash"?: string;
  }>;
  "generatedBy"?: "collector" | "analytics";
  "sessionId"?: string;
  "toolCallId"?: string;
  "kind": "capability";
  "payload": {
    "state": "detected" | "configured" | "healthy" | "partial" | "unsupported_version" | "disabled" | "error";
    "platform": string;
    "configured": boolean;
    "supportedFields": Array<string>;
    "receivedFields": Array<string>;
    "primarySources": Array<{
      "eventClass": "message" | "tool_call" | "tool_result" | "llm_usage" | "capability" | "repo_snapshot" | "command_context" | "local_report" | "hook_health";
      "sourceNamespace": string;
    }>;
    "aliases": Array<{
      "sourceNamespace": string;
      "nativeId": string;
      "primaryNativeId": string;
      "eventClass": "message" | "tool_call" | "tool_result" | "llm_usage" | "capability" | "repo_snapshot" | "command_context" | "local_report" | "hook_health";
    }>;
    "usageSemantics": "delta" | "cumulative" | "unavailable";
    "reason": string | null;
  };
} | {
  "schemaVersion": "1";
  "observationId": string;
  "harnessId": string;
  "harnessVersion": string;
  "collectorVersion": string;
  "deviceId": string;
  "turnId"?: string;
  "parentCallId"?: string;
  "occurredAt": string;
  "occurredAtNs"?: string;
  "sequence"?: string;
  "workspaceId"?: string;
  "repoKey"?: string;
  "worktreeId"?: string;
  "capabilitiesVersion": string;
  "missingFields": Array<string>;
  "truncated": boolean;
  "sourceRefs": Array<{
    "sourceNamespace": string;
    "nativeId": string;
    "phase": "started" | "progress" | "completed" | "cancelled" | "event";
    "traceId"?: string;
    "spanId"?: string;
    "eventId"?: string;
    "contentHash"?: string;
  }>;
  "generatedBy"?: "collector" | "analytics";
  "sessionId": string;
  "toolCallId"?: string;
  "kind": "repo_snapshot";
  "payload": {
    "head": string | null;
    "branch": string | null;
    "worktreeId": string;
    "dirtyFingerprint": string;
    "files": Array<{
      "path": string;
      "status": "added" | "modified" | "deleted" | "renamed" | "untracked" | "unchanged" | "unknown";
    }>;
    "truncated": boolean;
  };
} | {
  "schemaVersion": "1";
  "observationId": string;
  "harnessId": string;
  "harnessVersion": string;
  "collectorVersion": string;
  "deviceId": string;
  "turnId"?: string;
  "parentCallId"?: string;
  "occurredAt": string;
  "occurredAtNs"?: string;
  "sequence"?: string;
  "workspaceId"?: string;
  "repoKey"?: string;
  "worktreeId"?: string;
  "capabilitiesVersion": string;
  "missingFields": Array<string>;
  "truncated": boolean;
  "sourceRefs": Array<{
    "sourceNamespace": string;
    "nativeId": string;
    "phase": "started" | "progress" | "completed" | "cancelled" | "event";
    "traceId"?: string;
    "spanId"?: string;
    "eventId"?: string;
    "contentHash"?: string;
  }>;
  "generatedBy"?: "collector" | "analytics";
  "sessionId": string;
  "toolCallId"?: string;
  "kind": "command_context";
  "payload": {
    "resolvedCommand": string | null;
    "scriptChain": Array<string>;
    "modulePaths": Array<string>;
    "reason": string | null;
  };
} | {
  "schemaVersion": "1";
  "observationId": string;
  "harnessId": string;
  "harnessVersion": string;
  "collectorVersion": string;
  "deviceId": string;
  "turnId"?: string;
  "parentCallId"?: string;
  "occurredAt": string;
  "occurredAtNs"?: string;
  "sequence"?: string;
  "workspaceId"?: string;
  "repoKey"?: string;
  "worktreeId"?: string;
  "capabilitiesVersion": string;
  "missingFields": Array<string>;
  "truncated": boolean;
  "sourceRefs": Array<{
    "sourceNamespace": string;
    "nativeId": string;
    "phase": "started" | "progress" | "completed" | "cancelled" | "event";
    "traceId"?: string;
    "spanId"?: string;
    "eventId"?: string;
    "contentHash"?: string;
  }>;
  "generatedBy"?: "collector" | "analytics";
  "sessionId": string;
  "toolCallId"?: string;
  "kind": "local_report";
  "payload": {
    "runner": string;
    "cases": number | null;
    "passed": number | null;
    "failed": number | null;
    "durationMs": number | null;
    "sourceHash": string;
    "executionId": string | null;
    "association": "explicit" | "unresolved";
  };
} | {
  "schemaVersion": "1";
  "observationId": string;
  "harnessId": string;
  "harnessVersion": string;
  "collectorVersion": string;
  "deviceId": string;
  "turnId"?: string;
  "parentCallId"?: string;
  "occurredAt": string;
  "occurredAtNs"?: string;
  "sequence"?: string;
  "workspaceId"?: string;
  "repoKey"?: string;
  "worktreeId"?: string;
  "capabilitiesVersion": string;
  "missingFields": Array<string>;
  "truncated": boolean;
  "sourceRefs": Array<{
    "sourceNamespace": string;
    "nativeId": string;
    "phase": "started" | "progress" | "completed" | "cancelled" | "event";
    "traceId"?: string;
    "spanId"?: string;
    "eventId"?: string;
    "contentHash"?: string;
  }>;
  "generatedBy"?: "collector" | "analytics";
  "sessionId"?: string;
  "toolCallId"?: string;
  "kind": "hook_health";
  "payload": {
    "state": "detected" | "configured" | "healthy" | "partial" | "unsupported_version" | "disabled" | "error";
    "lastEventAt": string | null;
    "ack": {
      "desiredRevision": string;
      "appliedRevision": string | null;
      "installedVersion": string | null;
      "repairResult": "not_needed" | "repaired" | "failed" | "disabled" | "pending";
      "lastEventAt": string | null;
      "deletionRevision": string;
      "acknowledgedAt": string;
    } | null;
    "reason": string | null;
  };
};
