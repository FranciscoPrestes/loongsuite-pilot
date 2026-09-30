import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { Updater, resolveManagedDepsBases } from '../../../src/updater/updater.js';
import type { AutoUpdateConfig } from '../../../src/types/index.js';

const OURS = 'https://pilot.example/manifest/latest.json';

function cfg(extra: Partial<AutoUpdateConfig> = {}): AutoUpdateConfig {
  return { enabled: true, checkIntervalMs: 60_000, manifestUrl: OURS, packageUrl: 'https://pilot.example/p.tar.gz', ...extra };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('manifest source', () => {
  it('fetches only the configured manifest, also when it fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const updater = new Updater(cfg(), '/tmp/pilot-manifest-test');
    const manifest = await (updater as any).fetchManifest();
    expect(manifest).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(OURS);
  });
});

describe('resolveManagedDepsBases', () => {
  it('uses the config mirror and strips trailing slashes', () => {
    expect(resolveManagedDepsBases(cfg({
      nodeDepsUrl: 'https://pilot.example/deps/node/',
      nodeModulesUrl: 'https://pilot.example/deps/node-modules//',
    }))).toEqual({
      nodeDepsBase: 'https://pilot.example/deps/node',
      nodeModulesBase: 'https://pilot.example/deps/node-modules',
    });
  });

  it('falls back to the upstream defaults when nothing is configured', () => {
    const bases = resolveManagedDepsBases(cfg());
    expect(bases.nodeDepsBase).toMatch(/aliyuncs\.com\/loongsuite-pilot\/deps\/node$/);
  });
});
