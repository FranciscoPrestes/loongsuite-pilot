import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeDomain } from '../normalization/source-context.js';

const execFile = promisify(execFileCb);

const GIT_CONTEXT_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 256;

export interface GitContextResult {
  repo?: string;
  branch?: string;
  root?: string;
  domain?: string;
  /** Absolute git dir of this checkout (a linked worktree has its own); basis of the worktree id. */
  gitDir?: string;
}

interface GitContextCacheEntry extends GitContextResult {
  expiresAt: number;
}

const gitContextCache = new Map<string, GitContextCacheEntry>();

function evictStaleEntries(cache: Map<string, { expiresAt: number }>): void {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Still over limit: remove oldest entries
  const entries = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toRemove = entries.slice(0, cache.size - MAX_CACHE_ENTRIES);
  for (const [key] of toRemove) cache.delete(key);
}

/**
 * Infer git context (repo, branch, domain, root) for a given directory.
 * Uses per-command catch for partial success: e.g. if rev-parse succeeds
 * but remote fails, the available fields are still cached and returned.
 */
export async function inferGitContext(probeDir: string): Promise<GitContextResult> {
  const now = Date.now();
  const cached = gitContextCache.get(probeDir);
  if (cached && cached.expiresAt > now) {
    return { repo: cached.repo, branch: cached.branch, root: cached.root, domain: cached.domain, gitDir: cached.gitDir };
  }

  // One shared time budget for every git call of a probe (each call is also capped by GIT_CALL_TIMEOUT_MS).
  const deadline = now + GIT_PROBE_BUDGET_MS;
  const top = (await runGit(probeDir, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], deadline))?.split('\n').map(l => l.trim());
  const gitRoot = top?.[0] || undefined;
  const gitDir = top?.[1] || undefined;
  // symbolic-ref also answers for an unborn branch (no commit yet); a detached HEAD has no branch and yields none.
  const branch = normalizeBranch(await runGit(gitRoot ?? probeDir, ['symbolic-ref', '--short', '-q', 'HEAD'], deadline));
  const remote = await runGit(gitRoot ?? probeDir, ['config', '--get', 'remote.origin.url'], deadline);
  const repo = normalizeRepo(remote);
  const domain = normalizeDomain(remote);

  evictStaleEntries(gitContextCache);
  gitContextCache.set(probeDir, {
    expiresAt: now + GIT_CONTEXT_TTL_MS,
    repo,
    branch,
    root: gitRoot,
    domain,
    gitDir,
  });
  return { repo, branch, root: gitRoot, domain, gitDir };
}

/** Same read-only hardening as the repository snapshot reader (C5): never write the index or run repo-defined code. */
const GIT_SAFE_CONFIG = ['--no-optional-locks', '-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.pager=cat'];
const GIT_CALL_TIMEOUT_MS = 1500;
const GIT_PROBE_BUDGET_MS = 2500;

async function runGit(root: string, args: string[], deadline: number): Promise<string | undefined> {
  const remaining = Math.min(GIT_CALL_TIMEOUT_MS, deadline - Date.now());
  if (remaining <= 0) return undefined;
  try {
    const { stdout } = await execFile('git', ['-C', root, ...GIT_SAFE_CONFIG, ...args], {
      timeout: remaining,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    const text = stdout.trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBranch(raw: string | undefined): string | undefined {
  if (!raw || raw === 'HEAD') return undefined;
  return raw;
}

export function normalizeRepo(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const source = sshMatch ? sshMatch[1] : trimmed;
  return source
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Bounded Map that evicts expired and oldest entries when capacity is exceeded.
 */
export class BoundedTtlCache<V extends { expiresAt: number }> {
  private readonly map = new Map<string, V>();
  private readonly maxEntries: number;

  constructor(maxEntries = MAX_CACHE_ENTRIES) {
    this.maxEntries = maxEntries;
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: V): void {
    this.map.set(key, value);
    if (this.map.size > this.maxEntries) {
      evictStaleEntries(this.map);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
