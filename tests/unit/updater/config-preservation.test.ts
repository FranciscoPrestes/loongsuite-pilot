import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { Updater } from '../../../src/updater/updater.js';

const ORIGINAL = {
  userId: 'dev@ntconsult.com.br',
  serviceName: 'loongsuite-pilot',
  otlpTrace: {
    endpoint: 'https://beat.ntconsult.ai/api/ingest/otlp',
    headers: { Authorization: 'Bearer ntcp_teste' },
    captureMessageContent: true,
    spanAttributePassthroughPrefixes: ['agent.copilot.'],
    maxExportBatchBytes: 8388608,
    turnIdleTimeoutMs: 300000,
  },
  autoUpdate: {
    manifestUrl: 'https://pilot.example/manifest/latest.json',
    packageUrl: 'https://pilot.example/releases/1.9.0-ntc.1/loongsuite-pilot.tar.gz',
    nodeDepsUrl: 'https://pilot.example/deps/node',
  },
  retention: { otlpFailedDays: 30 },
};

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-cfg-'));
  configPath = path.join(dir, 'config.json');
  await fs.writeFile(configPath, JSON.stringify(ORIGINAL, null, 2));
  vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', configPath);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function readConfig() {
  return JSON.parse(await fs.readFile(configPath, 'utf8'));
}

describe('update keeps the NTConsult config', () => {
  it('installId and canary writes keep otlpTrace, autoUpdate and retention', async () => {
    const updater = new Updater(
      { enabled: true, checkIntervalMs: 60_000, manifestUrl: ORIGINAL.autoUpdate.manifestUrl },
      dir,
    );
    await (updater as any).ensureInstallId();
    await (updater as any).persistCanaryState(3);
    const after = await readConfig();
    expect(after.otlpTrace).toEqual(ORIGINAL.otlpTrace);
    expect(after.autoUpdate).toEqual(ORIGINAL.autoUpdate);
    expect(after.retention).toEqual(ORIGINAL.retention);
    expect(after.serviceName).toBe('loongsuite-pilot');
    expect(typeof after.installId).toBe('string');
    expect(after.canary).toEqual({ hotfix_version: 3 });
  });

  it('postinstall.js of the package leaves config.json byte-identical', async () => {
    const before = await fs.readFile(configPath, 'utf8');
    execFileSync(process.execPath, ['scripts/postinstall.js'], {
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dir, HOME: dir, USERPROFILE: dir },
      stdio: 'pipe',
    });
    expect(await fs.readFile(configPath, 'utf8')).toBe(before);
  });
});
