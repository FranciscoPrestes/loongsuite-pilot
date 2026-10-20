import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCapabilities } from '../../src/analytics/capabilities.js';
import { buildCapabilityMatrix, generateCapabilityMatrix } from '../../src/analytics/capability-matrix.js';
import { observeCapabilities } from '../../src/analytics/capability-observer.js';
import type { AgentDefinition } from '../../src/types/deployment.js';

const definitions = readdirSync('agents.d').filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(join('agents.d', name), 'utf8')) as AgentDefinition);
const manifests = listCapabilities(definitions);
const now = new Date('2026-10-16T12:00:00Z');

describe('analytics harness matrix', () => {
  it('all_manifests_visible_without_events', () => {
    const matrix = buildCapabilityMatrix(definitions);
    expect([...matrix.ids].sort()).toEqual(manifests.map(m => m.harnessId).sort());
    const statuses = observeCapabilities(manifests, [], now);
    expect(statuses.map(s => s.harnessId).sort()).toEqual(manifests.map(m => m.harnessId).sort());
    // No event and no known activity: unobserved, never fabricated as healthy or failed.
    expect(statuses.every(s => s.state === 'detected' && s.activity === 'unobserved')).toBe(true);
  });

  it('each_platform_declares_support', () => {
    const matrix = buildCapabilityMatrix(definitions);
    for (const manifest of manifests) {
      for (const platform of ['darwin', 'linux', 'win32'] as const) {
        const rows = matrix.rows.filter(r => r.harnessId === manifest.harnessId && r.platform === platform);
        expect(rows.length, `${manifest.harnessId}/${platform}`).toBeGreaterThan(0);
        expect(rows.every(r => r.versionRange === (manifest.versionRange ?? 'unspecified'))).toBe(true);
        expect(rows.map(r => r.capability).sort()).toEqual(['messages', 'results', 'subagents', 'tokens', 'tools']);
        for (const row of rows) {
          expect(['contract_validated', 'live_validated', 'not_exposed', 'unavailable', 'declared_conditional']).toContain(row.status);
          if (!manifest.platforms.includes(platform)) expect(row.status).toBe('unavailable');
        }
      }
    }
  });

  it('live_validation_is_never_claimed_without_evidence', () => {
    const matrix = buildCapabilityMatrix(definitions);
    expect(matrix.rows.some(r => r.status === 'live_validated')).toBe(false);
    const withEvidence = buildCapabilityMatrix(definitions, [{ harnessId: 'claude-code', platform: 'darwin', capability: 'tools', evidenceId: 'rehearsal-1' }]);
    expect(withEvidence.rows.find(r => r.harnessId === 'claude-code' && r.platform === 'darwin' && r.capability === 'tools')?.status).toBe('live_validated');
    expect(withEvidence.rows.filter(r => r.status === 'live_validated')).toHaveLength(1);
  });

  it('matrix_markdown_lists_every_harness_and_is_deterministic', () => {
    const text = generateCapabilityMatrix(definitions);
    for (const manifest of manifests) expect(text).toContain('`' + manifest.harnessId + '`');
    expect(generateCapabilityMatrix([...definitions].reverse())).toBe(text);
  });
});
