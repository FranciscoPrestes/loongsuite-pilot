import { createHash } from 'node:crypto';
import path from 'node:path';
import { inferGitContext } from '../utils/git-context.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('GitContextEnrichment');

const NAMESPACE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  'cursor-cli': ['cursor-cli', 'cursor_cli'],
  cursor_cli: ['cursor_cli', 'cursor-cli'],
  'qoder-cli': ['qoder-cli', 'qoder'],
  'qoder-idea': ['qoder-idea', 'qoder'],
  'qoder-cn': ['qoder-cn', 'qodercn', 'qoder'],
  qodercn: ['qodercn', 'qoder-cn', 'qoder'],
  'qoder-work': ['qoder-work', 'qoderwork'],
  'qoder-work-cn': ['qoder-work-cn', 'qoderwork'],
  'qwen-work-cn': ['qwen-work-cn', 'qwenworkcn'],
};

export async function enrichCanonicalEntryWithGit(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string | readonly string[],
): Promise<void> {
  const probeDir = extractProbeDir(entry, record, namespace);
  if (probeDir && !entry['workspace.path']) entry['workspace.path'] = probeDir;

  if (entry['git.repo'] && entry['git.branch']) return;
  if (!probeDir) return;

  const inferred = await inferGitContext(probeDir);
  if (!entry['git.repo'] && inferred.repo) entry['git.repo'] = inferred.repo;
  if (!entry['git.branch'] && inferred.branch) entry['git.branch'] = inferred.branch;
  if (!entry['git.domain'] && inferred.domain) entry['git.domain'] = inferred.domain;
  // Additive and opaque: distinguishes checkouts of one repository (main vs linked worktree) without exposing the path.
  if (!entry['git.worktree_id'] && inferred.gitDir) entry['git.worktree_id'] = computeWorktreeId(inferred.gitDir);
  if (!entry['workspace.current_root'] && inferred.root) entry['workspace.current_root'] = inferred.root;
}

/**
 * Last-mile enrichment for inputs that emit canonical Agent records directly.
 *
 * Hook-based inputs normally enrich before reaching InputManager. Transcript
 * inputs such as Codex can emit from several recovery/fusion paths, so doing a
 * guarded pass at the shared dispatch boundary keeps those paths consistent.
 * Enrichment only fills missing canonical values, while inferGitContext caches
 * repeated probes (including non-repository directories), so this is safe for
 * entries that were already enriched upstream.
 */
export async function enrichCanonicalEntriesWithGit(
  entries: Record<string, unknown>[],
): Promise<void> {
  for (const entry of entries) {
    try {
      const agentType = normalizeString(entry['gen_ai.agent.type']);
      if (!agentType) continue;
      await enrichCanonicalEntryWithGit(entry, entry, agentType);
    } catch (err) {
      logger.warn('git context enrichment failed for entry (skipped)', {
        error: String(err),
      });
    }
  }
}

function extractProbeDir(
  entry: Record<string, unknown>,
  record: Record<string, unknown>,
  namespace: string | readonly string[],
): string | undefined {
  const workspacePath = normalizeString(entry['workspace.path'])
    ?? normalizeString(record['workspace.path']);
  if (workspacePath && isAbsolutePath(workspacePath)) return workspacePath;

  for (const candidate of expandNamespaces(namespace)) {
    const cwd = normalizeString(entry[`agent.${candidate}.cwd`])
      ?? normalizeString(record[`agent.${candidate}.cwd`]);
    if (cwd && isAbsolutePath(cwd)) return cwd;

    const roots = entry[`agent.${candidate}.workspace_roots`]
      ?? record[`agent.${candidate}.workspace_roots`];
    const rootList = normalizeStringArray(roots);
    if (rootList.length > 0 && isAbsolutePath(rootList[0])) return rootList[0];
  }

  return undefined;
}

function expandNamespaces(namespace: string | readonly string[]): string[] {
  const requested = typeof namespace === 'string' ? [namespace] : namespace;
  const expanded: string[] = [];
  for (const value of requested) {
    for (const candidate of NAMESPACE_ALIASES[value] ?? [value]) {
      if (!expanded.includes(candidate)) expanded.push(candidate);
    }
  }
  return expanded;
}

function isAbsolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    } catch { /* not JSON, treat as single value */ }
    return [value].map(v => v.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map(item => typeof item === 'string' ? item.trim() : undefined)
    .filter((item): item is string => !!item);
}

/**
 * Canonical form used for path containment checks across POSIX and Windows.
 * Collapses backslashes to forward slashes, lowercases drive letters (Windows
 * paths are case-insensitive), and strips a trailing separator. This is a pure
 * lexical normalization; callers resolve symlinks with realpath before using it
 * to decide whether a path escapes a root.
 */
export function normalizePathForCompare(value: string): string {
  let normalized = value.replace(/\\/g, '/');
  // Lowercase only a leading Windows drive letter (e.g. "C:" -> "c:").
  normalized = normalized.replace(/^[A-Za-z]:/, match => match.toLowerCase());
  if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * True when `candidate` is the root itself or lives beneath it. Used to reject
 * symlink/path escapes so enrichment never reads outside the workspace root.
 * Both arguments must already be real (symlink-resolved) absolute paths.
 * Windows drive-letter paths compare case-insensitively; POSIX stays
 * case-sensitive.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const win = /^[a-z]:\//i.test(normalizePathForCompare(root));
  let normRoot = normalizePathForCompare(root);
  let normCandidate = normalizePathForCompare(candidate);
  if (win) {
    normRoot = normRoot.toLowerCase();
    normCandidate = normCandidate.toLowerCase();
  }
  if (normRoot === normCandidate) return true;
  const separator = normRoot.endsWith('/') ? '' : '/';
  return normCandidate.startsWith(normRoot + separator);
}

/**
 * Stable per-worktree identity derived from the worktree's own git directory.
 * Two worktrees of the same repository hash to different ids (the linked
 * worktree git dir is `.git/worktrees/<name>`), while repeated snapshots of the
 * same worktree hash to the same id. The input must already be canonicalized.
 */
export function computeWorktreeId(canonicalGitDir: string): string {
  return createHash('sha256')
    .update(normalizePathForCompare(canonicalGitDir))
    .digest('hex')
    .slice(0, 32);
}

// A git diff (or any local file snapshot) must NEVER be used to attribute human
// vs. AI authorship. Enrichment records repository structure/state only; no
// authorship, blame or commit-identity signal is ever derived or emitted here.
