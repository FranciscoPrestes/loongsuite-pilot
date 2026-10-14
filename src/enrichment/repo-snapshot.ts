import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Observation } from '../analytics/observation.js';
import { validateObservation } from '../analytics/observation.js';
import {
  computeWorktreeId,
  isPathInside,
  normalizePathForCompare,
} from '../normalization/enrich-git-context.js';
import type { LocalJob } from './job-contract.js';

const execFile = promisify(execFileCb);

export interface RepoSnapshotFile {
  readonly path: string;
  readonly status: string;
}

/** Exact C5 interface: read-only repository state, bounded file listing. */
export interface RepoSnapshotPayload {
  readonly head: string | null;
  readonly branch: string | null;
  readonly worktreeId: string;
  readonly dirtyFingerprint: string;
  readonly files: readonly RepoSnapshotFile[];
  readonly truncated: boolean;
}

export const MAX_SNAPSHOT_FILES = 100;

/**
 * Only the read-only git subcommands actually used here are permitted, invoked
 * with argument arrays built here (never shell interpolation). `diff`/`log`/
 * `show`/`config` are deliberately excluded: they can trigger textconv or
 * external-diff filters from the target repo's config. This allowlist prevents
 * code execution and repository mutation by forbidding any command that could
 * run a filter, hook trigger, or write. Note `status` alone would refresh/write
 * the target's index; that is prevented by `--no-optional-locks` below, not by
 * the allowlist.
 */
export const READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set(['rev-parse', 'status', 'symbolic-ref']);

/**
 * Hardened flags for every git invocation. Together these guarantee a target
 * repository can NEVER run code and the snapshot NEVER writes the target's
 * index:
 * - `--no-optional-locks` stops `git status` from writing the refreshed index,
 *   so the target repo's `post-index-change` hook (invoked on index write) never
 *   fires AND `.git/index` stays byte-identical. This is the root fix.
 * - `core.hooksPath=` points hook lookup at an empty location so no
 *   repo-installed hook (e.g. `post-index-change`) can run even if an index
 *   write occurred (defense in depth).
 * - `core.fsmonitor=false` / `core.untrackedCache=false` disable the repo's
 *   fsmonitor daemon/hook; `core.pager=cat` avoids a pager.
 */
export const GIT_SAFE_CONFIG = [
  '--no-optional-locks',
  '-c', 'core.hooksPath=',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.pager=cat',
];

/** Bounded stdout capture: enough for a very large dirty set, never unbounded. */
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;

interface GitErrorLike {
  code?: unknown;
  killed?: boolean;
  signal?: unknown;
  name?: unknown;
  message?: unknown;
}

/**
 * An "infrastructure" failure is one where git did not simply report "no value"
 * (timeout, stdio overflow, spawn error, abort). These must NEVER be silently
 * converted into a clean result — see snapshotRepository. A plain non-zero exit
 * (numeric code, child not killed) is git legitimately saying "there is none".
 */
function isInfrastructureFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  const e = err as GitErrorLike;
  if (e.name === 'AbortError') return true;
  if (e.killed === true) return true;
  if (e.signal != null) return true;
  if (typeof e.code !== 'number') return true;
  return false;
}

function describeGitError(err: unknown): string {
  const e = (err ?? {}) as GitErrorLike;
  return typeof e.message === 'string' ? e.message : String(e.code ?? 'unknown');
}

/**
 * Run a read-only git command with separate arguments and hardened config.
 * Returns the trimmed-free stdout, or `undefined` when `allowMissing` and git
 * exited non-zero ("no such value"). Throws on ANY infrastructure failure or
 * abort so a broken/aborted probe can never masquerade as a clean repository.
 */
async function runGitReadonly(
  cwd: string,
  gitArgs: readonly string[],
  signal?: AbortSignal,
  opts: { allowMissing?: boolean } = {},
): Promise<string | undefined> {
  const sub = gitArgs[0];
  if (!sub || !READONLY_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error(`read-only git violation: ${sub ?? '(none)'}`);
  }
  try {
    const { stdout } = await execFile('git', ['-C', cwd, ...GIT_SAFE_CONFIG, ...gitArgs], {
      shell: false,
      timeout: 1500,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    });
    return stdout.length > 0 ? stdout : undefined;
  } catch (err) {
    if (signal?.aborted) throw new Error('snapshot aborted');
    if (isInfrastructureFailure(err)) {
      throw new Error(`git ${sub} failed: ${describeGitError(err)}`);
    }
    // Plain non-zero exit: git ran and reported "no value".
    if (opts.allowMissing) return undefined;
    throw new Error(`git ${sub} failed: ${describeGitError(err)}`);
  }
}

const SECRET_BASENAME = /(^|[\\/])(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|credentials?|secrets?|\.netrc|\.npmrc|\.pem|.+[.-](key|pem|p12|pfx|jks|keystore))$/i;
const BINARY_EXTENSION = /\.(png|jpe?g|gif|bmp|ico|webp|mp[34]|mov|avi|mkv|wav|flac|ogg|zip|tar|gz|tgz|bz2|xz|7z|rar|exe|dll|so|dylib|o|a|class|jar|war|wasm|pdf|docx?|xlsx?|pptx?|pyc|pyo|woff2?|ttf|eot)$/i;

function isSecretPath(relativePath: string): boolean {
  return SECRET_BASENAME.test(relativePath);
}

function isBinaryPath(relativePath: string): boolean {
  return BINARY_EXTENSION.test(relativePath);
}

function unquoteGitPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\([nrt"\\])/g, (_m, c) => {
      if (c === 'n') return '\n';
      if (c === 'r') return '\r';
      if (c === 't') return '\t';
      return c;
    });
  }
  return trimmed;
}

function statusFromPorcelain(xy: string, path: string): string {
  if (xy === '??') return 'untracked';
  if (xy.includes('R') || xy.includes('C')) return 'renamed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  if (xy.includes('M') || xy.includes('T') || xy.includes('U')) return 'modified';
  return 'unknown';
}

interface RawEntry {
  readonly relativePath: string;
  readonly status: string;
}

function parsePorcelain(output: string): RawEntry[] {
  const entries: RawEntry[] = [];
  for (const line of output.split('\n')) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    if (xy === '!!') continue;
    let rest = line.slice(3);
    let relativePath: string;
    let status: string;
    if ((xy.includes('R') || xy.includes('C')) && rest.includes(' -> ')) {
      const arrow = rest.lastIndexOf(' -> ');
      relativePath = unquoteGitPath(rest.slice(arrow + 4));
      status = 'renamed';
    } else {
      relativePath = unquoteGitPath(rest);
      status = statusFromPorcelain(xy, relativePath);
    }
    if (relativePath) entries.push({ relativePath, status });
  }
  return entries;
}

async function resolveContainedPath(
  realRoot: string,
  relativePath: string,
): Promise<string | null> {
  const absolute = path.resolve(realRoot, relativePath);
  try {
    const real = await fs.realpath(absolute);
    return isPathInside(realRoot, real) ? real : null;
  } catch {
    // Unreadable/dangling entry: fall back to lexical containment so we neither
    // crash on a file deleted mid-read nor follow a path that lexically escapes.
    return isPathInside(realRoot, absolute) ? absolute : null;
  }
}

/** Compute the worktree snapshot. Never mutates the repository. */
export async function snapshotRepository(
  workspacePath: string,
  signal: AbortSignal,
): Promise<RepoSnapshotPayload> {
  if (signal.aborted) throw new Error('snapshot aborted');
  const realRoot = await fs.realpath(workspacePath);
  const stat = await fs.stat(realRoot);
  if (!stat.isDirectory()) throw new Error('workspace is not a directory');

  // Required: repo identity. Fails (throws) for a non-repo — never a silent fallback.
  const gitDirRaw = await runGitReadonly(realRoot, ['rev-parse', '--absolute-git-dir'], signal);
  const gitDir = gitDirRaw?.trim();
  const worktreeId = computeWorktreeId(
    gitDir ? path.resolve(realRoot, gitDir) : realRoot,
  );

  // `HEAD` / branch probes legitimately return "no value" on an empty or
  // detached repo (allowMissing), but any infrastructure failure still throws.
  const headRaw = await runGitReadonly(realRoot, ['rev-parse', 'HEAD'], signal, { allowMissing: true });
  const head = headRaw?.trim() || null;

  let branch: string | null = null;
  const abbrev = await runGitReadonly(realRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], signal, { allowMissing: true });
  const abbrevTrimmed = abbrev?.trim();
  if (abbrevTrimmed && abbrevTrimmed !== 'HEAD') branch = abbrevTrimmed;
  else {
    const symbolic = await runGitReadonly(realRoot, ['symbolic-ref', '--short', 'HEAD'], signal, { allowMissing: true });
    branch = symbolic?.trim() || null;
  }

  // Required: dirty state. A failure here throws rather than reporting a clean
  // tree — "falta de informação nunca vira sucesso". Empty stdout (exit 0) is a
  // genuinely clean repo and only then yields files: [].
  const statusRaw = (await runGitReadonly(realRoot, ['status', '--porcelain'], signal)) ?? '';
  if (signal.aborted) throw new Error('snapshot aborted');
  const rawEntries = parsePorcelain(statusRaw);

  const included: RepoSnapshotFile[] = [];
  const fingerprintLines: string[] = [];
  let totalDirty = 0;
  for (const raw of rawEntries) {
    if (signal?.aborted) throw new Error('aborted');
    const relative = raw.relativePath.replace(/\\/g, '/');
    if (isSecretPath(relative) || isBinaryPath(relative)) continue;
    const contained = await resolveContainedPath(realRoot, relative);
    if (!contained) continue; // symlink/path escape rejected
    totalDirty += 1;
    fingerprintLines.push(`${relative}\0${raw.status}`);
    if (included.length < MAX_SNAPSHOT_FILES) {
      included.push({ path: normalizePathForCompare(relative), status: raw.status });
    }
  }

  fingerprintLines.sort();
  const dirtyFingerprint = hashFingerprint(head, worktreeId, fingerprintLines);
  return {
    head,
    branch,
    worktreeId,
    dirtyFingerprint,
    files: included,
    truncated: totalDirty > MAX_SNAPSHOT_FILES,
  };
}

function hashFingerprint(
  head: string | null,
  worktreeId: string,
  lines: readonly string[],
): string {
  const hasher = createHash('sha256')
    .update(worktreeId)
    .update('\n')
    .update(head ?? '(no-head)')
    .update('\n');
  for (const line of lines) hasher.update(line).update('\n');
  return hasher.digest('hex').slice(0, 32);
}

/**
 * Wrap a snapshot payload into a correlated, schema-valid repo_snapshot
 * observation carrying a REAL capture timestamp. A snapshot generated late uses
 * its own capture time and is never back-dated to fill a missing earlier slot.
 */
export function buildRepoSnapshotObservation(
  job: LocalJob,
  payload: RepoSnapshotPayload,
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
    worktreeId: payload.worktreeId,
    missingFields: [] as string[],
    truncated: payload.truncated,
    sourceRefs: job.sourceRefs,
    generatedBy: 'collector' as const,
    kind: 'repo_snapshot' as const,
    payload,
    ...(job.turnId ? { turnId: job.turnId } : {}),
    ...(job.parentCallId ? { parentCallId: job.parentCallId } : {}),
    ...(job.nativeCallId ? { toolCallId: job.nativeCallId } : {}),
  };
  return validateObservation(observation);
}
