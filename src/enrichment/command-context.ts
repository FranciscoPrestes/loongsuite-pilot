import type { Observation } from '../analytics/observation.js';
import { validateObservation } from '../analytics/observation.js';
import { sanitizeSnippetText } from '../mask/entry-masker.js';
import type { LocalJob } from './job-contract.js';
import { buildModuleMap, collectPackageScripts } from './repo-module-map.js';

export interface CommandContextPayload {
  readonly resolvedCommand: string | null;
  readonly scriptChain: readonly string[];
  readonly modulePaths: readonly string[];
  readonly reason: string | null;
}

export const MAX_SCRIPT_DEPTH = 5;

/**
 * Matches a package-manager script invocation (`npm run build`, `pnpm test`,
 * `yarn lint`, `bun run x`). Used only to STATICALLY locate a script body in a
 * manifest; nothing here ever executes the matched command.
 */
const RUN_INVOCATION = /^(?:npm|pnpm|yarn|bun)\s+(?:(?:run|run-script)\s+)?([A-Za-z0-9:_.-]+)\s*$/;

function asScriptName(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve a command's npm-script chain purely by reading local manifests. This
 * NEVER executes any command or script body (`shellExecuteCalls` stays empty);
 * it only follows `run` wrappers through `scripts` with bounded depth and cycle
 * detection. Paths are never masked (they are locators); command bodies are
 * sanitized before being returned for persistence.
 */
export async function resolveCommandContext(
  command: string,
  workspacePath: string,
  signal: AbortSignal,
): Promise<CommandContextPayload> {
  const modulePaths = (await buildModuleMap(workspacePath, signal)).modulePaths;
  const invocation = RUN_INVOCATION.exec(command.trim());
  if (!invocation) {
    // Not a script invocation: it is already a concrete command. Return it
    // sanitized as-is (it may embed a secret) with no chain to resolve.
    return {
      resolvedCommand: sanitizeSnippetText(command),
      scriptChain: [],
      modulePaths,
      reason: null,
    };
  }

  const scripts = await collectPackageScripts(workspacePath, signal);
  if (!scripts) {
    return { resolvedCommand: null, scriptChain: [], modulePaths, reason: 'manifest_unreadable' };
  }

  const chain: string[] = [];
  const visited = new Set<string>();
  let current = asScriptName(invocation[1]);

  for (let depth = 0; depth < MAX_SCRIPT_DEPTH; depth += 1) {
    if (signal?.aborted) throw new Error('aborted');
    if (!current) break;
    if (visited.has(current)) {
      return { resolvedCommand: null, scriptChain: chain, modulePaths, reason: 'cycle_detected' };
    }
    visited.add(current);
    chain.push(current);

    const body = scripts[current];
    if (typeof body !== 'string') {
      return { resolvedCommand: null, scriptChain: chain, modulePaths, reason: 'script_not_found' };
    }

    const nested = RUN_INVOCATION.exec(body.trim());
    const nestedName = nested ? asScriptName(nested[1]) : undefined;
    if (nestedName && Object.prototype.hasOwnProperty.call(scripts, nestedName)) {
      current = nestedName;
      continue;
    }
    return {
      resolvedCommand: sanitizeSnippetText(body),
      scriptChain: chain,
      modulePaths,
      reason: null,
    };
  }

  return { resolvedCommand: null, scriptChain: chain, modulePaths, reason: 'depth_exceeded' };
}

/**
 * Wrap a resolved command context into a correlated, schema-valid
 * command_context observation carrying a REAL capture timestamp (never
 * back-dated to fill a missing earlier slot).
 */
export function buildCommandContextObservation(
  job: LocalJob,
  payload: CommandContextPayload,
  capturedAt: string = new Date().toISOString(),
): Observation {
  const observation = {
    schemaVersion: '1' as const,
    observationId: job.id,
    harnessId: job.harnessId,
    harnessVersion: job.harnessVersion,
    collectorVersion: job.collectorVersion,
    deviceId: job.deviceId,
    sessionId: job.sessionId,
    capabilitiesVersion: job.capabilitiesVersion,
    occurredAt: capturedAt,
    missingFields: [] as string[],
    truncated: false,
    sourceRefs: job.sourceRefs,
    generatedBy: 'collector' as const,
    kind: 'command_context' as const,
    payload,
    ...(job.turnId ? { turnId: job.turnId } : {}),
    ...(job.parentCallId ? { parentCallId: job.parentCallId } : {}),
    ...(job.nativeCallId ? { toolCallId: job.nativeCallId } : {}),
  };
  return validateObservation(observation);
}
