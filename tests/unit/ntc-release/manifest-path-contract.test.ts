import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Contract: the updater URLs written into every machine's config (deploy/ntc/apply-config.mjs)
// must be the paths the release tooling publishes and reads.
const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const BLOB = 'https://blob.example.test/pilot';

const { applyNtcConfig } = await import(join(ROOT, 'deploy/ntc/apply-config.mjs'));
const result = applyNtcConfig({}, {
  blobUrl: BLOB, key: 'ntcp_' + 'A'.repeat(32), endpoint: 'https://beat.ntconsult.ai/api/ingest/otlp',
});
const cfg = (result.config ?? result) as { autoUpdate: { manifestUrl: string; packageUrl: string } };
const strip = (u: string) => u.replace(`${BLOB}/`, '');
const MANIFEST_PATH = strip(cfg.autoUpdate.manifestUrl);
const PACKAGE_ALIAS = strip(cfg.autoUpdate.packageUrl);

describe('manifest and package paths agree with apply-config', () => {
  it('derives the expected paths', () => {
    expect(MANIFEST_PATH).toBe('manifest/latest.json');
    expect(PACKAGE_ALIAS).toBe('releases/latest/loongsuite-pilot.tar.gz');
  });

  it.each([
    'tools/ntc-release/fetch-manifest.sh',
    'tools/ntc-release/publish-manifest.sh',
    'tools/ntc-release/check-channels.mjs',
  ])('%s references the manifest path', (file) => {
    expect(read(file)).toContain(MANIFEST_PATH);
  });

  it('publishers and consumers never use a root-level latest.json blob path', () => {
    for (const file of [
      'tools/ntc-release/fetch-manifest.sh', 'tools/ntc-release/publish-manifest.sh',
      'tools/ntc-release/check-channels.mjs', 'tools/ntc-release/assemble-stage.mjs',
      '.github/workflows/ntc-release.yml', '.github/workflows/ntc-promote.yml',
    ]) {
      expect(read(file), file).not.toMatch(/\$BLOB\/latest\.json|\$\{base\}\/latest\.json|--name latest\.json|name latest\.json|stage\/latest\.json|"\$DIR\/latest\.json"/);
    }
  });

  it('assemble-stage places latest.json at the path the updater reads', () => {
    expect(read('tools/ntc-release/assemble-stage.mjs')).toContain("join(out, 'manifest', 'latest.json')");
    expect(read('.github/workflows/ntc-release.yml')).toContain(`stage/${MANIFEST_PATH}`);
    expect(read('.github/workflows/ntc-promote.yml')).toContain(`promote-stage/${MANIFEST_PATH}`);
  });

  it('promote writes the package alias the updater downloads from', () => {
    const promote = read('.github/workflows/ntc-promote.yml');
    expect(promote).toContain(`alias_copy "$rel/loongsuite-pilot.tar.gz" ${PACKAGE_ALIAS} `);
  });
});
