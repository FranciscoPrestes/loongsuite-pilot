import { describe, it, expect } from 'vitest';
// @ts-expect-error .mjs
import { buildManifest, renderChannelEnv, compareNtc } from '../../../tools/ntc-release/manifest.mjs';
import { compareVersions } from '../../../src/updater/version-utils.js';

const SHA = 'a'.repeat(64);
const rel = (version: string, over: Record<string, string> = {}) => ({
  version,
  git_commit: 'abc1234',
  package_url: `https://stntconsultpilot.blob.core.windows.net/pilot/${version}.tar.gz`,
  sha256: SHA,
  released_at: '2026-10-02T12:00:00Z',
  ...over,
});

describe('compareNtc', () => {
  const cases: Array<[string, string]> = [
    ['1.2.0', '1.2.0'], ['1.2.0-ntc.1', '1.2.0'], ['1.2.0', '1.2.0-ntc.1'],
    ['1.2.0-ntc.10', '1.2.0-ntc.9'], ['1.2.0-ntc.2', '1.2.0-ntc.10'],
    ['1.3.0', '1.2.0-ntc.99'], ['1.2.0-ntc.1', '1.10.0'], ['2.0.0', '1.99.99'],
    ['1.2', '1.2.0'], ['abc', 'abd'], ['1.2.0-rc1', '1.2.0'],
  ];
  it.each(cases)('matches compareVersions(%s, %s)', (a, b) => {
    expect(compareNtc(a, b)).toBe(compareVersions(a, b));
  });
});

describe('buildManifest', () => {
  it('first canary release becomes stable too', () => {
    const m = buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 });
    expect(m.version).toBe('1.2.0-ntc.1');
    expect(m.canary).toMatchObject({ version: '1.2.0-ntc.1', rollout_percentage: 10, hotfix_version: 0 });
  });

  it('second canary keeps the previous stable', () => {
    const first = buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 });
    const m = buildManifest(first, { kind: 'canary', release: rel('1.2.0-ntc.2'), rolloutPercentage: 25 });
    expect(m.version).toBe('1.2.0-ntc.1');
    expect(m.canary).toMatchObject({ version: '1.2.0-ntc.2', rollout_percentage: 25, hotfix_version: 0 });
  });

  it('republishing the same canary version bumps hotfix_version', () => {
    const a = buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 });
    const b = buildManifest(a, { kind: 'canary', release: rel('1.2.0-ntc.1', { git_commit: 'def5678' }), rolloutPercentage: 10 });
    const c = buildManifest(b, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 });
    expect(b.canary.hotfix_version).toBe(1);
    expect(c.canary.hotfix_version).toBe(2);
  });

  it('promote clears the equivalent canary', () => {
    const prev = buildManifest(buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 }),
      { kind: 'canary', release: rel('1.2.0-ntc.2'), rolloutPercentage: 10 });
    const m = buildManifest(prev, { kind: 'promote', release: rel('1.2.0-ntc.2') });
    expect(m.version).toBe('1.2.0-ntc.2');
    expect(m.canary).toBeUndefined();
  });

  it('promote keeps a newer canary', () => {
    const prev = buildManifest(buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 }),
      { kind: 'canary', release: rel('1.2.0-ntc.3'), rolloutPercentage: 10 });
    const m = buildManifest(prev, { kind: 'promote', release: rel('1.2.0-ntc.2') });
    expect(m.version).toBe('1.2.0-ntc.2');
    expect(m.canary.version).toBe('1.2.0-ntc.3');
  });

  it('promote of a lower version throws unless allowDowngrade', () => {
    const prev = buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.5'), rolloutPercentage: 10 });
    const action = { kind: 'promote', release: rel('1.2.0-ntc.4') } as const;
    expect(() => buildManifest(prev, action)).toThrow(/downgrade/);
    expect(buildManifest(prev, action, { allowDowngrade: true }).version).toBe('1.2.0-ntc.4');
  });

  it('promote without prev works', () => {
    expect(buildManifest(null, { kind: 'promote', release: rel('1.2.0-ntc.1') }).version).toBe('1.2.0-ntc.1');
  });

  it('rejects invalid sha256 and non-https package_url', () => {
    expect(() => buildManifest(null, { kind: 'promote', release: rel('1.2.0', { sha256: 'ABC' }) })).toThrow(/sha256/);
    expect(() => buildManifest(null, { kind: 'promote', release: rel('1.2.0', { sha256: 'A'.repeat(64) }) })).toThrow(/sha256/);
    expect(() => buildManifest(null, { kind: 'promote', release: rel('1.2.0', { package_url: 'http://x/y.tgz' }) })).toThrow(/https/);
  });

  it('rejects rollout outside [1,100]', () => {
    for (const pct of [0, 101, 1.5]) {
      expect(() => buildManifest(null, { kind: 'canary', release: rel('1.2.0'), rolloutPercentage: pct })).toThrow(/rollout/);
    }
  });

  it('does not mutate prev', () => {
    const prev = buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 });
    const snapshot = JSON.stringify(prev);
    buildManifest(prev, { kind: 'promote', release: rel('1.2.0-ntc.1') });
    expect(JSON.stringify(prev)).toBe(snapshot);
  });
});

describe('injection and input hardening', () => {
  const promote = (over: Record<string, string>) => () =>
    buildManifest(null, { kind: 'promote', release: rel('1.2.0', over) });

  it('rejects the git_commit newline injection payload', () => {
    expect(promote({ git_commit: `abc1234\nsha256=${'f'.repeat(64)}` })).toThrow(/git_commit/);
    expect(promote({ git_commit: 'xyz' })).toThrow(/git_commit/);
  });
  it('rejects package_url with trailing newline, spaces or control chars', () => {
    expect(promote({ package_url: 'https://x.test/a.tgz\n' })).toThrow(/package_url/);
    expect(promote({ package_url: 'https://x.test/a b.tgz' })).toThrow(/package_url/);
    expect(promote({ package_url: 'https://x.test/a\tb' })).toThrow(/package_url/);
  });
  it('rejects a malformed released_at', () => {
    expect(promote({ released_at: 'yesterday' })).toThrow(/released_at/);
    expect(promote({ released_at: '2026-10-02T12:00:00Z\nx=1' })).toThrow(/released_at/);
  });
  it('renderChannelEnv refuses line breaks', () => {
    expect(() => renderChannelEnv(rel('1.2.0', { git_commit: 'abc\nsha256=ff' }))).toThrow(/line break/);
    expect(() => renderChannelEnv(rel('1.2.0', { package_url: 'https://x\r' }))).toThrow(/line break/);
  });
  it('validates prev and prev.canary with a clear error', () => {
    expect(() => buildManifest({ version: '1.0.0' } as never, { kind: 'promote', release: rel('1.2.0') }))
      .toThrow(/prev\./);
    const good = buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 });
    const bad = { ...good, canary: { ...good.canary, sha256: 'zz' } };
    expect(() => buildManifest(bad, { kind: 'promote', release: rel('1.2.0-ntc.1') })).toThrow(/prev\.canary\.sha256/);
  });
  it('copies a kept canary instead of aliasing prev', () => {
    const prev = buildManifest(buildManifest(null, { kind: 'canary', release: rel('1.2.0-ntc.1'), rolloutPercentage: 10 }),
      { kind: 'canary', release: rel('1.2.0-ntc.3'), rolloutPercentage: 10 });
    const m = buildManifest(prev, { kind: 'promote', release: rel('1.2.0-ntc.2') });
    expect(m.canary).toEqual(prev.canary);
    expect(m.canary).not.toBe(prev.canary);
  });
});

describe('renderChannelEnv', () => {
  it('renders the four lines', () => {
    const out = renderChannelEnv(rel('1.2.0-ntc.1'));
    expect(out.trim().split('\n')).toEqual([
      'version=1.2.0-ntc.1',
      'package_url=https://stntconsultpilot.blob.core.windows.net/pilot/1.2.0-ntc.1.tar.gz',
      `sha256=${SHA}`,
      'git_commit=abc1234',
    ]);
  });
});
