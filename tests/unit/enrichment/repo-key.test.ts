import { describe, expect, it } from 'vitest';
import { jobFromEntry } from '../../../src/enrichment/job-contract.js';
import { buildRepoSnapshotObservation } from '../../../src/enrichment/repo-snapshot.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { job } from './fixtures.js';

const payload = { head: 'abc', branch: 'main', worktreeId: 'wt-1', dirtyFingerprint: 'fp', files: [], truncated: false };
const entry = (extra: Record<string, unknown> = {}) => ({
  'event.id': 'native-event', time_unix_nano: '1791972000000000000', 'gen_ai.session.id': 'session-1', 'gen_ai.agent.type': 'claude-code',
  'workspace.path': '/tmp/example', ...extra,
}) as unknown as AgentActivityEntry;

// The Hub resolves a snapshot's scope from (repoKey, worktreeId); without repoKey it can only keep the branch.
describe('repoKey on repo snapshots', () => {
  it('a job remembers the repository the native event reported, and a snapshot observation carries it', () => {
    const queued = jobFromEntry(entry({ 'git.repo': 'org/the-repo' }), 'input', 'device', '1');
    expect(queued?.repoKey).toBe('org/the-repo');
    expect(buildRepoSnapshotObservation(queued!, payload, '2026-10-19T12:00:00.000Z')).toMatchObject({ repoKey: 'org/the-repo', worktreeId: 'wt-1' });
  });

  it('without git.repo nothing is invented', () => {
    const queued = jobFromEntry(entry(), 'input', 'device', '1');
    expect(queued).not.toBeNull();
    expect(queued).not.toHaveProperty('repoKey');
    expect(buildRepoSnapshotObservation(job(), payload, '2026-10-19T12:00:00.000Z')).not.toHaveProperty('repoKey');
  });
});
