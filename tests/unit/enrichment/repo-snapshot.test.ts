import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildRepoSnapshotObservation,
  GIT_SAFE_CONFIG,
  MAX_SNAPSHOT_FILES,
  READONLY_GIT_SUBCOMMANDS,
  snapshotRepository,
} from '../../../src/enrichment/repo-snapshot.js';
import { buildModuleMap, MAX_SNIPPET_BYTES } from '../../../src/enrichment/repo-module-map.js';
import {
  computeWorktreeId,
  isPathInside,
  normalizePathForCompare,
} from '../../../src/normalization/enrich-git-context.js';
import { job } from './fixtures.js';

let dir: string;
const signal = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c5-snapshot-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-C', repo, '-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args],
    { encoding: 'utf8' },
  );
}

function initRepo(repo: string): void {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
}

function commitAll(repo: string, message: string): void {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', message);
}

describe('repo snapshot', () => {
  it('separate_worktrees get distinct worktree ids', async () => {
    const main = path.join(dir, 'main');
    initRepo(main);
    fs.writeFileSync(path.join(main, 'a.txt'), 'a');
    commitAll(main, 'init');

    const linked = path.join(dir, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'feature', linked);

    const a = await snapshotRepository(main, signal());
    const b = await snapshotRepository(linked, signal());
    expect(a.worktreeId).not.toBe(b.worktreeId);
  });

  it('dirty_without_commit changes the fingerprint and reports tracked + untracked', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    commitAll(repo, 'init');

    const clean = await snapshotRepository(repo, signal());
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new');
    const dirty = await snapshotRepository(repo, signal());

    expect(dirty.dirtyFingerprint).not.toBe(clean.dirtyFingerprint);
    const byPath = new Map(dirty.files.map(f => [f.path, f.status]));
    expect(byPath.get('a.txt')).toBe('modified');
    expect(byPath.get('new.txt')).toBe('untracked');
  });

  it('symlink_escape_rejected excludes a path whose target leaves the root', async () => {
    const repo = path.join(dir, 'repo');
    const outside = path.join(dir, 'outside');
    initRepo(repo);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET');
    fs.writeFileSync(path.join(repo, 'ok.txt'), 'ok');
    commitAll(repo, 'init');

    fs.writeFileSync(path.join(repo, 'fine.txt'), 'fine');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak'));

    const snap = await snapshotRepository(repo, signal());
    const paths = snap.files.map(f => f.path);
    expect(paths).toContain('fine.txt');
    expect(paths).not.toContain('leak');
  });

  it('limits_record_truncation caps files and snippet bytes', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    for (let i = 0; i < 150; i += 1) {
      fs.writeFileSync(path.join(repo, `f${i}.ts`), 'export const x = 1;');
    }
    fs.writeFileSync(path.join(repo, 'README.md'), 'A'.repeat(200 * 1024));

    const snapshot = await snapshotRepository(repo, signal());
    expect(snapshot.files.length).toBeLessThanOrEqual(100);
    expect(snapshot.files.length).toBeLessThanOrEqual(MAX_SNAPSHOT_FILES);
    expect(snapshot.truncated).toBe(true);

    const { snippetBytes, truncated } = await buildModuleMap(repo, signal());
    expect(snippetBytes).toBeLessThanOrEqual(65_536);
    expect(snippetBytes).toBeLessThanOrEqual(MAX_SNIPPET_BYTES);
    expect(truncated).toBe(true);
  });

  it('a git status failure never fabricates a clean snapshot (#1)', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty'); // real dirty state

    // Corrupt the index so `git status` fails (exit 128) instead of reporting.
    // The snapshot must reject — never report the tree as clean on a probe error.
    fs.writeFileSync(path.join(repo, '.git', 'index'), 'GARBAGEGARBAGE');
    await expect(snapshotRepository(repo, signal())).rejects.toThrow();
  });

  it('an abort never fabricates a clean snapshot (#1)', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty');

    const aborted = new AbortController();
    aborted.abort();
    await expect(snapshotRepository(repo, aborted.signal)).rejects.toThrow();
  });

  it('out-of-root workspace patterns cannot escape into modulePaths (#2)', async () => {
    const repo = path.join(dir, 'repo');
    const sibling = path.join(dir, 'sibling');
    initRepo(repo);
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'package.json'), JSON.stringify({ name: 'evil' }));
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['../*'] }),
    );

    const map = await buildModuleMap(repo, signal());
    expect(map.modulePaths.some(p => p.startsWith('..') || path.isAbsolute(p))).toBe(false);
    expect(map.modulePaths).not.toContain('../sibling');
  });

  it('snippet byte bound holds across multibyte UTF-8 truncation (#4)', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    // "€" is 3 bytes; a large multibyte doc forces the budget cut to land
    // mid-codepoint (65_536 = 21845*3 + 1).
    fs.writeFileSync(path.join(repo, 'README.md'), '€'.repeat(25_000));

    const map = await buildModuleMap(repo, signal());
    expect(map.snippetBytes).toBeLessThanOrEqual(65_536);
    for (const snippet of map.snippets) {
      expect(snippet.content).not.toContain('\uFFFD');
    }
  });

  it('monorepo workspace packages are discovered as modules', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'], scripts: { build: 'npm run compile' } }),
    );
    fs.mkdirSync(path.join(repo, 'packages', 'a'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: 'a', scripts: { compile: 'tsc' } }),
    );
    fs.mkdirSync(path.join(repo, 'packages', 'b'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b' }));

    const map = await buildModuleMap(repo, signal());
    expect(map.modulePaths).toContain('packages/a');
    expect(map.modulePaths).toContain('packages/b');
    expect(map.modulePaths).toContain('.');
  });

  it('repo with no remote and no HEAD snapshots without inventing state', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo); // no commit => no HEAD; no remote configured

    const snap = await snapshotRepository(repo, signal());
    expect(snap.head).toBeNull();
    expect(snap.worktreeId).toBeTruthy();
    expect(typeof snap.dirtyFingerprint).toBe('string');
  });

  it('rename is reported with the renamed status', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'old.txt'), 'x');
    commitAll(repo, 'init');

    git(repo, 'mv', 'old.txt', 'new.txt');
    const snap = await snapshotRepository(repo, signal());
    const renamed = snap.files.find(f => f.status === 'renamed');
    expect(renamed).toBeDefined();
    expect(renamed?.path).toBe('new.txt');
  });

  it('a nested repository or submodule boundary never breaks the snapshot', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    commitAll(repo, 'init');

    const sub = path.join(repo, 'sub');
    initRepo(sub);
    fs.writeFileSync(path.join(sub, 'inner.txt'), 'inner');
    commitAll(sub, 'sub init');

    const snap = await snapshotRepository(repo, signal());
    expect(snap.worktreeId).toBeTruthy();
    expect(Number.isFinite(snap.files.length)).toBe(true);
    // The nested git directory is never recursed into as its own repository.
    expect(snap.files.every(f => !f.path.includes('sub/.git'))).toBe(true);
  });

  it('a listed path whose target is gone at read time never crashes the snapshot', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'ok.txt'), 'ok');
    commitAll(repo, 'init');

    // Dangling symlink: `git status` lists it, but its realpath fails at read.
    fs.symlinkSync(path.join(dir, 'does-not-exist'), path.join(repo, 'gone'));

    const snap = await snapshotRepository(repo, signal());
    expect(snap.worktreeId).toBeTruthy();
    // Graceful: reported via lexical containment (or skipped), never a crash.
    expect(Number.isFinite(snap.files.length)).toBe(true);
  });

  it('Windows path forms are canonicalized and containment is case/drive aware', () => {
    expect(normalizePathForCompare('C:\\Repo\\File.ts')).toBe('c:/Repo/File.ts');
    expect(normalizePathForCompare('C:/Repo/Sub/')).toBe('c:/Repo/Sub');
    expect(isPathInside('C:\\Repo', 'C:\\Repo\\sub\\a.ts')).toBe(true);
    expect(isPathInside('C:\\Repo', 'C:\\repo\\a.ts')).toBe(true);
    expect(isPathInside('C:\\Repo', 'D:\\Other\\a.ts')).toBe(false);
    expect(isPathInside('C:\\Repo', 'C:\\Other\\a.ts')).toBe(false);
  });

  it('a diff never attributes human or AI authorship', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    commitAll(repo, 'init');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed');

    const snap = await snapshotRepository(repo, signal());
    const observation = buildRepoSnapshotObservation(job(), snap);
    const serialized = JSON.stringify(observation);
    expect(serialized).not.toMatch(/authorship|"author"|human[_-]?author|ai[_-]?author/i);
    expect(Object.keys(observation.payload).sort()).toEqual(
      ['branch', 'dirtyFingerprint', 'files', 'head', 'truncated', 'worktreeId'].sort(),
    );
  });

  it('records a real capture timestamp and never back-fills an earlier slot', async () => {
    const repo = path.join(dir, 'repo');
    initRepo(repo);
    const snap = await snapshotRepository(repo, signal());

    const before = Date.now();
    const observation = buildRepoSnapshotObservation(job(), snap);
    const after = Date.now();
    const captured = Date.parse(observation.occurredAt);
    expect(captured).toBeGreaterThanOrEqual(before - 5);
    expect(captured).toBeLessThanOrEqual(after + 5);
  });

  it('a snapshot can never execute target-repo code (#5)', () => {
    // The allowlist must stay trimmed to non-executing subcommands: `diff`/`log`/
    // `show`/`config` are textconv/external-diff/config execution vectors.
    expect([...READONLY_GIT_SUBCOMMANDS].sort()).toEqual(['rev-parse', 'status', 'symbolic-ref']);
    for (const forbidden of ['config', 'diff', 'log', 'show', 'ls-files']) {
      expect(READONLY_GIT_SUBCOMMANDS.has(forbidden)).toBe(false);
    }
    // Every invocation forces off repo-configured code execution (fsmonitor hook).
    expect(GIT_SAFE_CONFIG).toContain('core.fsmonitor=false');
    expect(GIT_SAFE_CONFIG).toContain('core.untrackedCache=false');
  });
});
