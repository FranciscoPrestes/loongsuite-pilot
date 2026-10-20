import type { EnrichmentHandler, EnrichmentScheduler } from '../enrichment/scheduler.js';
import { buildRepoSnapshotObservation, snapshotRepository, type RepoSnapshotPayload } from '../enrichment/repo-snapshot.js';
import type { Observation } from '../analytics/observation.js';

export interface HandlerDeps {
  snapshot?: (workspacePath: string, signal: AbortSignal) => Promise<RepoSnapshotPayload>;
  now?: () => Date;
}

/**
 * A job yields exactly one observation and the store requires `observationId === job.id`;
 * handlers whose builders mint a derived id (local_report) are rebound here so a
 * result can never be rejected as foreign or collide with a sibling kind's job.
 */
export function boundToJob(observation: Observation, jobId: string): Observation {
  return observation.observationId === jobId ? observation : { ...observation, observationId: jobId };
}

/**
 * Compiled handlers only (no central command/code). Only `repo_snapshot` can run from a LocalJob:
 * `command_context` needs the command string and `local_report` a report path, and the strict
 * LocalJob deliberately carries neither (C4 "no raw command"). They stay unregistered, so those
 * kinds are deferred without burning attempts, until a contract ruling provides their input.
 */
export function registerEnrichmentHandlers(scheduler: EnrichmentScheduler, deps: HandlerDeps = {}): void {
  const snapshot = deps.snapshot ?? snapshotRepository;
  const repoSnapshot: EnrichmentHandler = async (job, signal) => {
    const payload = await snapshot(job.workspacePath, signal);
    if (signal.aborted) throw new Error('snapshot aborted');
    return boundToJob(buildRepoSnapshotObservation(job, payload, (deps.now?.() ?? new Date()).toISOString()), job.id);
  };
  scheduler.register('repo_snapshot', repoSnapshot);
}
