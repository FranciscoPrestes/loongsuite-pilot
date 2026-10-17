/**
 * Hardened flags for every read-only git invocation made by the collector (repository snapshot, git context):
 * - `--no-optional-locks` stops `git status` from writing the refreshed index (no `.git/index` change, no
 *   `post-index-change` hook);
 * - `core.hooksPath=` points hook lookup at an empty location, so no repo-installed hook can run;
 * - `core.fsmonitor=false` / `core.untrackedCache=false` disable the repo's fsmonitor daemon/hook;
 * - `core.pager=cat` avoids a pager.
 * Shared by `enrichment/repo-snapshot.ts` and `utils/git-context.ts`; this module imports nothing (no cycles).
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  '--no-optional-locks',
  '-c', 'core.hooksPath=',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.pager=cat',
];
