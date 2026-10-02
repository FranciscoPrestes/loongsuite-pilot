import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// No yaml package is installed, so the workflow is split into job blocks with a regex.
const text = readFileSync(join(__dirname, '../../../.github/workflows/ntc-release.yml'), 'utf8');
const [head, jobsText] = text.split(/^jobs:\n/m);
const jobs = new Map<string, string>();
for (const m of jobsText.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)) jobs.set(m[1], m[2]);

describe('ntc-release.yml publish guards', () => {
  it('finds the expected jobs', () => {
    expect([...jobs.keys()]).toEqual(['prepare', 'test', 'package', 'node-modules', 'assemble', 'publish']);
  });

  it('publish only runs for an explicit workflow_dispatch with dry_run == false', () => {
    const cond = /^    if: (.*)$/m.exec(jobs.get('publish')!)?.[1] ?? '';
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain('inputs.dry_run == false');
    expect(cond).not.toMatch(/\|\|/);
  });

  it('the in-job guard re-checks event and dry_run', () => {
    const publish = jobs.get('publish')!;
    expect(publish).toMatch(/\[ "\$EVENT_NAME" = "workflow_dispatch" \] && \[ "\$DRY_RUN" = "false" \]/);
  });

  it('computes dry-run so that a missing input never means publish', () => {
    const exprs = [...text.matchAll(/DRY_RUN: (\$\{\{.*\}\})/g)].map((m) => m[1]);
    expect(exprs.length).toBeGreaterThan(0);
    for (const e of exprs) expect(e).toBe("${{ github.event_name != 'workflow_dispatch' || inputs.dry_run }}");
  });

  it('no other job, nor the workflow level, has id-token: write or azure login', () => {
    expect(head).not.toMatch(/id-token/);
    for (const [name, body] of jobs) {
      if (name === 'publish') continue;
      expect(body, name).not.toMatch(/id-token/);
      expect(body, name).not.toMatch(/azure\/login/);
      expect(body, name).not.toMatch(/az storage/);
    }
    expect(jobs.get('publish')).toMatch(/id-token: write/);
  });

  it('marks the temporary push trigger and limits it to the feature branch', () => {
    expect(head).toContain('# TEMPORARY: dry-run from the feature branch; remove before merging into NTConsult-main');
    expect(head).toMatch(/push:\n    branches: \[feat\/ntc-fase1-distribuicao\]/);
  });
});
