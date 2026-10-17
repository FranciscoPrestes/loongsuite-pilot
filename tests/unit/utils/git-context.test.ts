import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inferGitContext } from '../../../src/utils/git-context.js';
import { computeWorktreeId, enrichCanonicalEntriesWithGit } from '../../../src/normalization/enrich-git-context.js';
import { snapshotRepository } from '../../../src/enrichment/repo-snapshot.js';

let dir: string; let n = 0;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString();
// A unique directory per call: inferGitContext caches by path for 30 s.
const repo = (branch = 'feat/NT-123-x') => { const d = path.join(dir, `r${n += 1}`); fs.mkdirSync(d); git(d, 'init', '-q', '-b', branch); git(d, 'remote', 'add', 'origin', 'git@github.com:org/repo.git'); return d; };
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c9-git-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('git context: branch and worktree identity', () => {
  it('reports the branch of a repository that has no commit yet (unborn HEAD)', async () => {
    const d = repo();
    expect(await inferGitContext(d)).toMatchObject({ repo: 'org/repo', branch: 'feat/NT-123-x' });
  });

  it('reports the branch after commits and none for a detached HEAD', async () => {
    const d = repo('main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
    expect((await inferGitContext(d)).branch).toBe('main');
    const detached = repo('main');
    git(detached, 'commit', '-q', '--allow-empty', '-m', 'x');
    git(detached, 'checkout', '-q', '--detach');
    expect((await inferGitContext(detached)).branch).toBeUndefined(); // never the literal "HEAD", never fabricated
  });

  it('gives the main checkout and a linked worktree different, stable worktree ids', async () => {
    const d = repo('main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
    const linked = path.join(dir, 'linked');
    git(d, 'worktree', 'add', '-q', '-b', 'other', linked);
    const a = await inferGitContext(d); const b = await inferGitContext(linked);
    expect(a.gitDir).toBeTruthy(); expect(b.gitDir).toBeTruthy();
    expect(a.gitDir).not.toBe(b.gitDir);
    expect(b.branch).toBe('other');
    const entries = [{ 'gen_ai.agent.type': 'claude-code', 'workspace.path': d }, { 'gen_ai.agent.type': 'claude-code', 'workspace.path': linked }, { 'gen_ai.agent.type': 'claude-code', 'workspace.path': d }] as Record<string, unknown>[];
    await enrichCanonicalEntriesWithGit(entries);
    expect(entries[0]!['git.worktree_id']).toMatch(/^[a-f0-9]{32}$/);
    expect(entries[0]!['git.worktree_id']).not.toBe(entries[1]!['git.worktree_id']);
    expect(entries[0]!['git.worktree_id']).toBe(entries[2]!['git.worktree_id']);
    expect([entries[0]!['git.branch'], entries[1]!['git.branch']]).toEqual(['main', 'other']);
  });

  it('fills branch and worktree id when a hook supplied only the repo, never overwriting what it supplied', async () => {
    const d = repo('main');
    const entry = { 'gen_ai.agent.type': 'claude-code', 'workspace.path': d, 'git.repo': 'hook/repo' } as Record<string, unknown>;
    await enrichCanonicalEntriesWithGit([entry]);
    expect(entry['git.repo']).toBe('hook/repo');
    expect(entry['git.branch']).toBe('main');
    expect(entry['git.worktree_id']).toMatch(/^[a-f0-9]{32}$/);
    const complete = { 'gen_ai.agent.type': 'claude-code', 'workspace.path': d, 'git.repo': 'hook/repo', 'git.branch': 'hook-branch' } as Record<string, unknown>;
    await enrichCanonicalEntriesWithGit([complete]); // fully supplied: no probe, nothing added
    expect(complete['git.branch']).toBe('hook-branch');
    expect(complete['git.worktree_id']).toBeUndefined();
  });

  it('is read-only: no repository hook, fsmonitor or index write is triggered', async () => {
    const d = repo('main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
    const marker = path.join(dir, 'fsmonitor-ran');
    git(d, 'config', 'core.fsmonitor', `touch ${marker}`);
    fs.writeFileSync(path.join(d, 'f.txt'), 'x');
    const indexBefore = fs.existsSync(path.join(d, '.git', 'index')) ? fs.statSync(path.join(d, '.git', 'index')).mtimeMs : null;
    await inferGitContext(d);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(d, '.git', 'index')) ? fs.statSync(path.join(d, '.git', 'index')).mtimeMs : null).toBe(indexBefore);
  });

  it('a non-repository directory yields nothing and does not throw', async () => {
    const plain = path.join(dir, 'plain'); fs.mkdirSync(plain);
    expect(await inferGitContext(plain)).toEqual({ repo: undefined, branch: undefined, root: undefined, domain: undefined, gitDir: undefined });
  });
});

describe('git context parsing robustness', () => {
  it('a directory whose name contains a newline still yields the right root, git dir and worktree id', async () => {
    const d = path.join(dir, 'we\nird'); fs.mkdirSync(d); git(d, 'init', '-q', '-b', 'main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
    const ctx = await inferGitContext(d);
    expect(ctx.root).toBe(d);
    expect(ctx.gitDir).toBe(path.join(d, '.git'));
    const entry = { 'gen_ai.agent.type': 'claude-code', 'workspace.path': d } as Record<string, unknown>;
    await enrichCanonicalEntriesWithGit([entry]);
    expect(entry['git.worktree_id']).toBe(computeWorktreeId(path.join(d, '.git')));
    expect(entry['git.worktree_id']).not.toBe(computeWorktreeId('newline'));
  });

  it('HEAD pointing at a tag ref is not reported as a branch', async () => {
    const d = repo('main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
    git(d, 'tag', 'v1');
    git(d, 'symbolic-ref', 'HEAD', 'refs/tags/v1');
    expect((await inferGitContext(d)).branch).toBeUndefined();
  });

  it('git.worktree_id equals the worktreeId of the C5 repository snapshot for the same directory, main and linked', async () => {
    const d = repo('main');
    git(d, 'commit', '-q', '--allow-empty', '-m', 'x');
    const linked = path.join(dir, 'linked2');
    git(d, 'worktree', 'add', '-q', '-b', 'other2', linked);
    for (const where of [d, linked]) {
      const entry = { 'gen_ai.agent.type': 'claude-code', 'workspace.path': where } as Record<string, unknown>;
      await enrichCanonicalEntriesWithGit([entry]);
      const snapshot = await snapshotRepository(where, new AbortController().signal);
      expect(entry['git.worktree_id'], where).toBe(snapshot.worktreeId);
    }
    // The linked worktree's git dir is not the repository root's: an id derived from the root would differ.
    expect(computeWorktreeId(linked)).not.toBe((await snapshotRepository(linked, new AbortController().signal)).worktreeId);
  });
});
