import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
// @ts-expect-error módulo .mjs sem tipos
import { rewriteOrigins, findForbiddenOrigins } from '../../../deploy/ntc/rewrite-origins.mjs';

const BLOB = 'https://stntconsultpilot.blob.core.windows.net/pilot';
const files = [
  'deploy/installer-opensource.sh',
  'deploy/installer-opensource.ps1',
  'scripts/loongsuite-pilot.sh',
  'scripts/loongsuite-pilot.ps1',
  'assets/skills/loongsuite-pilot-ops/SKILL.md',
];

describe('rewriteOrigins on the real distribution files', () => {
  it.each(files)('%s has no forbidden origin left and points at the blob', (f) => {
    const out = rewriteOrigins(readFileSync(f, 'utf8'), BLOB);
    expect(findForbiddenOrigins(out)).toEqual([]);
    expect(out).toContain(BLOB);
  });

  it('installer.sh builds release-scoped and latest URLs under releases/', () => {
    const out = rewriteOrigins(readFileSync('deploy/installer-opensource.sh', 'utf8'), BLOB);
    expect(out).toContain('${_OSS_BASE_URL}/releases/${INSTALL_VERSION}/');
    expect(out).toContain('${_OSS_BASE_URL}/releases/latest/');
    expect(out).toContain(`${BLOB}/deps/node-modules`);
    expect(out).toContain(`${BLOB}/deps/node`);
  });

  it('installer.ps1 builds release-scoped and latest URLs under releases/', () => {
    const out = rewriteOrigins(readFileSync('deploy/installer-opensource.ps1', 'utf8'), BLOB);
    expect(out).toContain('$_OSS_BASE_URL/releases/$Version/');
    expect(out).toContain('$_OSS_BASE_URL/releases/latest/');
  });

  it('accepts a blob with a trailing slash', () => {
    expect(rewriteOrigins('x', `${BLOB}/`)).toBe('x');
  });

  it('keeps the SLS suffixes that dist legitimately contains', () => {
    const sample = "const SLS_PUBLIC_HOST_SUFFIX = '.log.aliyuncs.com';";
    expect(rewriteOrigins(sample, BLOB)).toBe(sample);
    expect(findForbiddenOrigins(sample)).toEqual([]);
  });

  it('flags the community-edition telemetry project', () => {
    expect(findForbiddenOrigins("const PROJECT = 'loongsuite-community-edition';")).not.toEqual([]);
  });
});
