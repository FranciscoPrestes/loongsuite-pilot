import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateObservation } from '../../src/analytics/observation.js';

describe('canonical analytics observation mirror', () => {
  const root = 'schemas/ntconsult-analytics/v1/';
  it('invalid_observation_rejected', () => {
    const missingId = { schemaVersion: 1, kind: 'capability' };
    expect(() => validateObservation(missingId)).toThrow();
    expect(() => validateObservation(null)).toThrow();
  });

  it('mirror_hash_matches_lock', () => {
    const hash = createHash('sha256').update(readFileSync(`${root}analytics-observation-v1.schema.json`)).digest('hex');
    const lock = JSON.parse(readFileSync(`${root}contract.lock.json`, 'utf8'));
    expect(hash).toBe(lock.sha256);
    expect(lock.source).toBe('hub-ai-admin/docs/contracts/analytics-observation-v1.schema.json');
  });

  it('accepts every canonical valid kind without changing precision, null or unknown', () => {
    const fixtures = JSON.parse(readFileSync(`${root}fixtures/analytics-observation-v1.json`, 'utf8'));
    for (const event of fixtures.valid) expect(validateObservation(event)).toEqual(event);
    const snapshot = validateObservation(fixtures.valid.find((event: { kind: string }) => event.kind === 'repo_snapshot'));
    expect(snapshot.sequence).toBe('9007199254740993');
  });

  it('rejects every canonical invalid fixture with backend parity', () => {
    const fixtures = JSON.parse(readFileSync(`${root}fixtures/analytics-observation-v1.json`, 'utf8'));
    for (const fixture of fixtures.invalid) expect(() => validateObservation(fixture.event), fixture.reason).toThrow();
  });

  it('detects tampered mirrors and verifies a standalone copied artifact', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'analytics-contract-'));
    try {
      cpSync(root, temporary, { recursive: true });
      const script = join(process.cwd(), 'scripts/check-analytics-contract.mjs');
      expect(spawnSync(process.execPath, [script, '--schema-dir', temporary]).status).toBe(0);
      writeFileSync(join(temporary, 'analytics-observation-v1.schema.json'), '{}\n');
      expect(spawnSync(process.execPath, [script, '--schema-dir', temporary]).status).toBe(1);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
