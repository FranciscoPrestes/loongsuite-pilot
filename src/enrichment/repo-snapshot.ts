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
 * Only read-only git subcommands are ever invoked, and only with argument
 * arrays built here (never shell interpolation). This allowlist is the guard
 * that keeps snapshotRepository from ever mutating a repository.
 */
const READONLY_GIT_SUBCOMMANDS = new Set([
  'rev-parse',
  'status',
  'symbolic-ref',
  'config',
  'ls-files',
  'diff',
  'log',
  'show',
]);

const WRITE_CONFIG_FLAGS = /^--(unset|unset-all|add|replace|remove|remove-section|rename-section)(=|$)/;

async function runGitReadonly(
  cwd: string,
  gitArgs: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  const sub = gitArgs[0];
  if (!sub || !READONLY_GIT_SUBCOMMANDS.has(sub)) {
    throw new Error(`read-only git violation: ${sub ?? '(none)'}`);
  }
  if (sub === 'config' && gitArgs.some(arg => WRITE_CONFIG_FLAGS.test(arg))) {
    throw new Error('read-only git violation: config write');
  }
  try {
    const { stdout } = await execFile('git', ['-C', cwd, ...gitArgs], {
      shell: false,
      timeout: 1500,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      ...(signal ? { signal } : {}),
    });
    return stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
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
  const realRoot = await fs.realpath(workspacePath);
  const stat = await fs.stat(realRoot);
  if (!stat.isDirectory()) throw new Error('workspace is not a directory');

  const gitDirRaw = await runGitReadonly(realRoot, ['rev-parse', '--absolute-git-dir'], signal);
  const gitDir = gitDirRaw?.trim();
  const worktreeId = computeWorktreeId(
    gitDir ? path.resolve(realRoot, gitDir) : realRoot,
  );

  const headRaw = await runGitReadonly(realRoot, ['rev-parse', 'HEAD'], signal);
  const head = headRaw?.trim() || null;

  let branch: string | null = null;
  const abbrev = await runGitReadonly(realRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], signal);
  const abbrevTrimmed = abbrev?.trim();
  if (abbrevTrimmed && abbrevTrimmed !== 'HEAD') branch = abbrevTrimmed;
  else {
    const symbolic = await runGitReadonly(realRoot, ['symbolic-ref', '--short', 'HEAD'], signal);
    branch = symbolic?.trim() || null;
  }

  const statusRaw = (await runGitReadonly(realRoot, ['status', '--porcelain'], signal)) ?? '';
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
