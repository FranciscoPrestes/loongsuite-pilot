import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathInside, normalizePathForCompare } from '../normalization/enrich-git-context.js';
import { sanitizeSnippetText } from '../mask/entry-masker.js';

export const MAX_SNIPPET_BYTES = 64 * 1024; // 65_536 bytes of snippets per observation
const MAX_WORKSPACE_ENTRIES = 50;
const MAX_MANIFEST_FILES = 40;

export interface ModuleSnippet {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
}

export interface ModuleMapResult {
  readonly modulePaths: readonly string[];
  readonly snippets: readonly ModuleSnippet[];
  readonly snippetBytes: number;
  readonly truncated: boolean;
}

const MODULE_MANIFESTS = [
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'tsconfig.json',
] as const;

const MODULE_DECLARING = new Set(['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml']);

const DOC_FILES = ['README.md', 'README', 'README.rst'] as const;

const SECRET_BASENAME = /(^|[\\/])(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|credentials?|secrets?|\.netrc|\.npmrc|\.pem|.+[.-](key|pem|p12|pfx|jks|keystore))$/i;
const BINARY_EXTENSION = /\.(png|jpe?g|gif|bmp|ico|webp|mp[34]|mov|avi|zip|tar|gz|tgz|exe|dll|so|dylib|o|a|class|jar|wasm|pdf|docx?|xlsx?|pptx?|woff2?|ttf)$/i;

const isSecretPath = (relative: string): boolean => SECRET_BASENAME.test(relative);
const isBinaryName = (relative: string): boolean => BINARY_EXTENSION.test(relative);
const looksBinary = (text: string): boolean => text.includes('\u0000');

function toRelative(realRoot: string, absolute: string): string {
  return normalizePathForCompare(path.relative(realRoot, absolute)) || '.';
}

interface BoundedRead {
  readonly text: string;
  readonly bytesRead: number;
}

/** Read at most `maxBytes` so a huge manifest/doc cannot blow memory. */
async function readTextBounded(absolute: string, maxBytes: number): Promise<BoundedRead | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(absolute, 'r');
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
  } catch {
    return null; // deleted mid-read / unreadable: skip gracefully
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface Manifest {
  readonly relativeDir: string;
  readonly relativeFile: string;
  readonly data: Record<string, unknown> | null;
  readonly text: string | null;
}

async function readManifest(
  realRoot: string,
  relativeFile: string,
  signal?: AbortSignal,
): Promise<Manifest | null> {
  if (signal?.aborted) throw new Error('aborted');
  const absolute = path.resolve(realRoot, relativeFile);
  try {
    const real = await fs.realpath(absolute);
    if (!isPathInside(realRoot, real)) return null; // escape rejected
  } catch {
    return null;
  }
  const read = await readTextBounded(absolute, 64 * 1024);
  if (read === null) return null;
  let data: Record<string, unknown> | null = null;
  if (relativeFile.endsWith('.json')) {
    try {
      const parsed: unknown = JSON.parse(read.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    } catch {
      data = null;
    }
  }
  return {
    relativeDir: toRelative(realRoot, path.dirname(absolute)),
    relativeFile: normalizePathForCompare(path.relative(realRoot, absolute)),
    data,
    text: read.text,
  };
}

function workspacePatterns(data: Record<string, unknown> | null): string[] {
  if (!data) return [];
  const workspaces = data.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((w): w is string => typeof w === 'string');
  if (workspaces && typeof workspaces === 'object') {
    const packages = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((w): w is string => typeof w === 'string');
  }
  return [];
}

async function expandWorkspaceDirs(
  realRoot: string,
  patterns: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (dirs.length >= MAX_WORKSPACE_ENTRIES) break;
    const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.endsWith('/*')) {
      const parent = path.resolve(realRoot, normalized.slice(0, -2));
      let names: string[];
      try {
        names = (await fs.readdir(parent)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        if (dirs.length >= MAX_WORKSPACE_ENTRIES) break;
        const candidate = path.join(parent, name);
        try {
          if (!(await fs.stat(candidate)).isDirectory()) continue;
        } catch {
          continue;
        }
        const hasManifest = await fs
          .access(path.join(candidate, 'package.json'))
          .then(() => true)
          .catch(() => false);
        if (hasManifest) dirs.push(toRelative(realRoot, candidate));
      }
    } else {
      const candidate = path.resolve(realRoot, normalized);
      const hasManifest = await fs
        .access(path.join(candidate, 'package.json'))
        .then(() => true)
        .catch(() => false);
      if (hasManifest) dirs.push(toRelative(realRoot, candidate));
    }
    if (signal?.aborted) throw new Error('aborted');
  }
  return dirs;
}

/**
 * Build a bounded module map from local manifests and documentation. Reads only
 * local files (never executes anything), canonicalizes paths, excludes symlink
 * escapes/secrets/binaries, and sanitizes every snippet before retention. Total
 * retained snippet bytes never exceed MAX_SNIPPET_BYTES; overflow is recorded.
 */
export async function buildModuleMap(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<ModuleMapResult> {
  const realRoot = await fs.realpath(workspacePath);
  const moduleDirs = new Set<string>();
  const snippets: ModuleSnippet[] = [];
  let snippetBytes = 0;
  let truncated = false;
  let manifestCount = 0;

  // Budget-aware snippet retention: sanitize first, then bound the retained
  // bytes so the recorded total is what actually persists.
  const addSnippet = async (relativeFile: string): Promise<void> => {
    if (isSecretPath(relativeFile) || isBinaryName(relativeFile)) return;
    const remaining = MAX_SNIPPET_BYTES - snippetBytes;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    const absolute = path.resolve(realRoot, relativeFile);
    const read = await readTextBounded(absolute, remaining + 1);
    if (read === null) return;
    if (looksBinary(read.text)) return;
    if (read.bytesRead > remaining) truncated = true; // more content than budget
    const sanitized = sanitizeSnippetText(read.text);
    let content = sanitized;
    let bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > remaining) {
      content = Buffer.from(content, 'utf8').subarray(0, remaining).toString('utf8');
      bytes = Buffer.byteLength(content, 'utf8');
      truncated = true;
    }
    snippetBytes += bytes;
    snippets.push({ path: relativeFile, content, bytes });
  };

  const queue: string[] = ['.'];
  const seenDirs = new Set<string>();

  while (queue.length > 0) {
    const relDir = queue.shift() as string;
    if (seenDirs.has(relDir)) continue;
    seenDirs.add(relDir);

    for (const manifestName of MODULE_MANIFESTS) {
      if (manifestCount >= MAX_MANIFEST_FILES) {
        truncated = true;
        break;
      }
      const relativeFile = relDir === '.' ? manifestName : `${relDir}/${manifestName}`;
      const manifest = await readManifest(realRoot, relativeFile, signal);
      if (!manifest) continue;
      manifestCount += 1;
      if (manifest.text !== null) await addSnippet(relativeFile);
      if (MODULE_DECLARING.has(manifestName)) moduleDirs.add(relDir);
      if (manifestName === 'package.json') {
        const workspaceDirs = await expandWorkspaceDirs(realRoot, workspacePatterns(manifest.data), signal);
        for (const dir of workspaceDirs) {
          moduleDirs.add(dir);
          if (!seenDirs.has(dir)) queue.push(dir);
        }
      }
    }

    for (const docName of DOC_FILES) {
      const relativeFile = relDir === '.' ? docName : `${relDir}/${docName}`;
      const absolute = path.resolve(realRoot, relativeFile);
      try {
        const real = await fs.realpath(absolute);
        if (!isPathInside(realRoot, real)) continue; // escape rejected
      } catch {
        continue;
      }
      await addSnippet(relativeFile);
    }

    if (signal?.aborted) throw new Error('aborted');
  }

  return { modulePaths: [...moduleDirs].sort(), snippets, snippetBytes, truncated };
}

/**
 * Collect the merged npm `scripts` index from the root manifest plus any
 * workspace package manifests (root wins on name collision). Returns null when
 * the root manifest is missing/unreadable/unparseable so callers can report
 * `manifest_unreadable`. Reads only local files; never executes anything.
 */
export async function collectPackageScripts(
  workspacePath: string,
  signal?: AbortSignal,
): Promise<Record<string, string> | null> {
  const realRoot = await fs.realpath(workspacePath);
  const root = await readManifest(realRoot, 'package.json', signal);
  if (!root || !root.data) return null;

  const scripts: Record<string, string> = {};
  const addScripts = (data: Record<string, unknown> | null): void => {
    const raw = data?.scripts;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [name, body] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof body === 'string' && !(name in scripts)) scripts[name] = body;
    }
  };

  addScripts(root.data);
  const workspaceDirs = await expandWorkspaceDirs(realRoot, workspacePatterns(root.data), signal);
  for (const dir of workspaceDirs) {
    const relativeFile = dir === '.' ? 'package.json' : `${dir}/package.json`;
    const manifest = await readManifest(realRoot, relativeFile, signal);
    addScripts(manifest?.data ?? null);
    if (signal?.aborted) throw new Error('aborted');
  }
  return scripts;
}
