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
    for (const e of exprs) expect(e).toBe('${{ inputs.dry_run != false }}');
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

  it('is triggered by workflow_dispatch only (no push, pull_request or schedule)', () => {
    const on = /^on:\n([\s\S]*?)(?=^\S)/m.exec(head)?.[1] ?? '';
    const triggers = [...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]);
    expect(triggers).toEqual(['workflow_dispatch']);
    expect(text).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule|workflow_run):/m);
    expect(text).not.toContain('TEMPORARY');
  });

  it('release never overwrites the root thin installers; promotion owns them', () => {
    const publish = jobs.get('publish')!;
    expect(publish).not.toMatch(/--overwrite true/);
    expect(publish).toMatch(/--overwrite false[^\n]*\\?\n?[^\n]*content-type/);
    const promote = readFileSync(join(__dirname, '../../../.github/workflows/ntc-promote.yml'), 'utf8');
    expect(promote).toMatch(/alias_copy "\$rel\/thin\/install\.sh" install\.sh/);
    expect(promote).toMatch(/alias_copy "\$rel\/thin\/install\.ps1" install\.ps1/);
  });

  it('checks the ETag before and after the uploads and the channels afterwards', () => {
    const publish = jobs.get('publish')!;
    expect(publish.match(/assert-etag\.sh/g)).toHaveLength(2);
    expect(publish.indexOf('assert-etag.sh')).toBeLessThan(publish.indexOf('upload-immutable.sh'));
    expect(publish.lastIndexOf('assert-etag.sh')).toBeGreaterThan(publish.indexOf('upload-immutable.sh'));
    expect(publish.indexOf('check-channels.mjs')).toBeGreaterThan(publish.indexOf('publish-manifest.sh'));
    expect(publish.indexOf('git push origin')).toBeGreaterThan(publish.indexOf('check-channels.mjs'));
  });

  it('pins every action by commit sha and persists credentials only in publish', () => {
    for (const m of text.matchAll(/uses: (\S+)@(\S+)/g)) expect(m[2], m[1]).toMatch(/^[0-9a-f]{40}$/);
    for (const [name, body] of jobs) {
      const hasFalse = /persist-credentials: false/.test(body);
      if (name === 'publish') expect(hasFalse).toBe(false);
      else expect(hasFalse, name).toBe(true);
    }
  });

  it('prepare only accepts commits reachable from NTConsult-main', () => {
    const prepare = jobs.get('prepare')!;
    expect(prepare).toContain('git -C src merge-base --is-ancestor "$sha" refs/remotes/origin/NTConsult-main');
    expect(prepare.indexOf('merge-base --is-ancestor')).toBeLessThan(prepare.indexOf('next-version'));
  });

  it('publish and assemble run the tooling from the workflow commit, never from source_ref', () => {
    for (const name of ['prepare', 'assemble', 'publish']) {
      const body = jobs.get(name)!;
      expect(body, name).toMatch(/ref: \$\{\{ github\.sha \}\}\n\s+path: tooling/);
      // every script path goes through tooling/
      for (const m of body.matchAll(/(?:bash|node) (\S*tools\/ntc-release\/\S+)/g)) expect(m[1], name).toMatch(/^tooling\//);
    }
    const publish = jobs.get('publish')!;
    expect(publish).not.toContain('needs.prepare.outputs.sha }}\n          path');
    expect(publish).not.toMatch(/ref: \$\{\{ inputs\.source_ref/);
  });
});

describe('ntc-install-smoke.yml', () => {
  const smoke = readFileSync(join(__dirname, '../../../.github/workflows/ntc-install-smoke.yml'), 'utf8');
  it('is manual only and pins its actions by commit sha', () => {
    expect(smoke).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(smoke).toMatch(/^on:\n  workflow_dispatch:\n/m);
    for (const m of smoke.matchAll(/uses: (\S+)@(\S+)/g)) expect(m[2], m[1]).toMatch(/^[0-9a-f]{40}$/);
  });
});
