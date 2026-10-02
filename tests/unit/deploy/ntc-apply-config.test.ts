import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without types
import { applyNtcConfig } from '../../../deploy/ntc/apply-config.mjs';

const SCRIPT = resolve('deploy/ntc/apply-config.mjs');
const KEY = `ntcp_${'a1B2c3D4'.repeat(4)}`;
const SENTINEL = `ntcp_SENTINEL${'Z9y8X7w6'.repeat(4)}`;
const BLOB = 'https://stntconsultpilot.blob.core.windows.net/pilot';
const EP = 'https://beat.ntconsult.ai/api/ingest/otlp';
const base = { key: KEY, endpoint: EP, blobUrl: BLOB };

describe('applyNtcConfig', () => {
  it('1: builds otlpTrace and keeps other keys', () => {
    const existing = {
      otlpTrace: { failedReplayIntervalMs: 5000, extra: 1, headers: { 'X-A': 'b' }, endpoint: 'https://old.example/x' },
    };
    const { config } = applyNtcConfig(existing, base) as any;
    expect(config.otlpTrace).toEqual({
      failedReplayIntervalMs: 5000,
      extra: 1,
      endpoint: EP,
      headers: { 'X-A': 'b', Authorization: `Bearer ${KEY}` },
      captureMessageContent: true,
      spanAttributePassthroughPrefixes: ['agent.copilot.'],
      maxExportBatchBytes: 8388608,
      turnIdleTimeoutMs: 300000,
    });
  });

  it('2: without key keeps Authorization; without any it throws', () => {
    const first = applyNtcConfig({}, base).config;
    const again = applyNtcConfig(first, { endpoint: EP, blobUrl: BLOB }).config as any;
    expect(again.otlpTrace.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(() => applyNtcConfig({}, { endpoint: EP, blobUrl: BLOB })).toThrow('NTC_PILOT_CHAVE is required on first install');
  });

  it('M2: a new key replaces a different Authorization and removes lowercase variants', () => {
    const existing = { otlpTrace: { headers: { Authorization: 'Bearer old', authorization: 'Bearer old2', AUTHORIZATION: 'x', 'X-A': 'b' } } };
    const { config } = applyNtcConfig(existing, base) as any;
    expect(config.otlpTrace.headers).toEqual({ 'X-A': 'b', Authorization: `Bearer ${KEY}` });
    const kept = applyNtcConfig({ otlpTrace: { headers: { authorization: 'Bearer keep' } } }, { endpoint: EP, blobUrl: BLOB }).config as any;
    expect(kept.otlpTrace.headers).toEqual({ Authorization: 'Bearer keep' });
  });

  it('3: invalid key throws without echoing it', () => {
    for (const bad of ['ntcp_short', 'xxxx_' + 'a'.repeat(40), `ntcp_${'a'.repeat(32)}!`]) {
      try {
        applyNtcConfig({}, { ...base, key: bad });
        expect.unreachable();
      } catch (e) {
        expect((e as Error).message).not.toContain(bad);
      }
    }
  });

  it('4: serviceName, retention and autoUpdate', () => {
    const { config } = applyNtcConfig(
      { retention: { keep: 1 }, autoUpdate: { checkIntervalMs: 9 } },
      { ...base, blobUrl: `${BLOB}/` },
    ) as any;
    expect(config.serviceName).toBe('loongsuite-pilot');
    expect(config.retention).toEqual({ keep: 1, otlpFailedDays: 30, otlpFailedMaxTotalMiB: 2048 });
    expect(config.autoUpdate).toEqual({
      checkIntervalMs: 9,
      enabled: true,
      manifestUrl: `${BLOB}/manifest/latest.json`,
      packageUrl: `${BLOB}/releases/latest/loongsuite-pilot.tar.gz`,
      nodeDepsUrl: `${BLOB}/deps/node`,
      nodeModulesUrl: `${BLOB}/deps/node-modules`,
    });
  });

  it('5: canary sets policy latest keeping the rest; absent leaves canary alone', () => {
    const c1 = applyNtcConfig({ canary: { hotfix_version: 2 } }, { ...base, canary: true }).config as any;
    expect(c1.canary).toEqual({ hotfix_version: 2, policy: 'latest' });
    const c2 = applyNtcConfig({ canary: { policy: 'x' } }, base).config as any;
    expect(c2.canary).toEqual({ policy: 'x' });
    expect('canary' in (applyNtcConfig({}, base).config as object)).toBe(false);
  });

  it('6: rejects non-https, empty strings; loopback http only when allowed', () => {
    expect(() => applyNtcConfig({}, { ...base, endpoint: 'http://beat.ntconsult.ai/x' })).toThrow();
    expect(() => applyNtcConfig({}, { ...base, blobUrl: 'http://x.example/p' })).toThrow();
    expect(() => applyNtcConfig({}, { ...base, endpoint: '' })).toThrow();
    expect(() => applyNtcConfig({}, { ...base, blobUrl: '' })).toThrow();
    expect(() => applyNtcConfig({}, { ...base, endpoint: 'http://127.0.0.1:9/x' })).toThrow();
    expect(() => applyNtcConfig({}, { ...base, endpoint: 'http://127.0.0.1:9/x', blobUrl: 'http://localhost:9/p', allowLoopbackHttp: true })).not.toThrow();
    expect(() => applyNtcConfig({}, { ...base, endpoint: 'http://evil.example/x', allowLoopbackHttp: true })).toThrow();
  });

  it('I1: previousEndpoint undefined counts as changed', () => {
    const r = applyNtcConfig({}, base);
    expect(r.previousEndpoint).toBeUndefined();
    expect(r.endpointChanged).toBe(true);
  });

  it('7: idempotent, preserves installId/userId/agents/dataDir, does not mutate input', () => {
    const existing = { installId: 'i', userId: 'u', agents: { a: 1 }, dataDir: '/d' };
    const snap = JSON.stringify(existing);
    const first = applyNtcConfig(existing, base);
    expect(JSON.stringify(existing)).toBe(snap);
    expect(first.config).toMatchObject(existing);
    const second = applyNtcConfig(first.config, base);
    expect(second.config).toEqual(first.config);
    expect(second.endpointChanged).toBe(false);
    expect(second.previousEndpoint).toBe(EP);
  });
});

describe('apply-config CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ntc-apply-'));
  });
  const run = (env: Record<string, string>, extra: string[] = []) =>
    spawnSync('node', [SCRIPT, '--data-dir', dir, ...extra], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
  const cfg = () => JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));

  it.skipIf(process.platform === 'win32')('(a) writes config.json with mode 0600', () => {
    const r = run({ NTC_PILOT_CHAVE: KEY });
    expect(r.status).toBe(0);
    expect(statSync(join(dir, 'config.json')).mode & 0o777).toBe(0o600);
    expect(cfg().otlpTrace.headers.Authorization).toBe(`Bearer ${KEY}`);
  });

  it('(b) never prints the key, even on failure', () => {
    const ok = run({ NTC_PILOT_CHAVE: SENTINEL });
    const bad = run({ NTC_PILOT_CHAVE: SENTINEL, NTC_PILOT_ENDPOINT: 'http://insecure.example/x' });
    const badKey = run({ NTC_PILOT_CHAVE: `${SENTINEL}!` });
    for (const r of [ok, bad, badKey]) {
      expect(r.stdout + r.stderr).not.toContain('SENTINEL');
    }
    expect(bad.status).toBe(1);
    expect(badKey.status).toBe(1);
  });

  it('does not leak the key through an unparsable existing config', () => {
    writeFileSync(join(dir, 'config.json'), `{"k": "${SENTINEL}" oops`);
    const r = run({ NTC_PILOT_CHAVE: SENTINEL });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toContain('SENTINEL');
  });

  it('(c) endpoint change moves otlp-failed into otlp-superseded/<ts>', () => {
    expect(run({ NTC_PILOT_CHAVE: KEY, NTC_PILOT_ENDPOINT: 'http://127.0.0.1:1/old' }, ['--allow-loopback-http']).status).toBe(0);
    const failed = join(dir, 'logs', 'otlp-failed');
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(failed, 'x__ntc-2026-10-02.jsonl'), '{}\n');
    const r = run({ NTC_PILOT_CHAVE: KEY });
    expect(r.status).toBe(0);
    expect(readdirSync(failed)).toEqual([]);
    const [ts] = readdirSync(join(dir, 'logs', 'otlp-superseded'));
    expect(existsSync(join(dir, 'logs', 'otlp-superseded', ts, 'x__ntc-2026-10-02.jsonl'))).toBe(true);
  });

  it('I1: config without endpoint plus leftover otlp-failed files moves them; clean dir moves nothing', () => {
    const failed = join(dir, 'logs', 'otlp-failed');
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(failed, 'a__user-otlp-2026-10-01.jsonl'), '{}\n');
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ userId: 'u', otlpTrace: { headers: { Authorization: 'Bearer k' } } }));
    expect(run({}).status).toBe(0);
    expect(readdirSync(failed)).toEqual([]);
    const clean = mkdtempSync(join(tmpdir(), 'ntc-apply-clean-'));
    const r = spawnSync('node', [SCRIPT, '--data-dir', clean], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NTC_PILOT_CHAVE: KEY } });
    expect(r.status).toBe(0);
    expect(existsSync(join(clean, 'logs'))).toBe(false);
  });

  it('M3: loopback http prints a warning without key or URL', () => {
    const r = run({ NTC_PILOT_CHAVE: KEY, NTC_PILOT_ENDPOINT: 'http://127.0.0.1:7/zz' }, ['--allow-loopback-http']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('loopback http');
    expect(r.stderr).not.toContain('127.0.0.1');
    expect(r.stderr).not.toContain(KEY);
  });

  it('(d) same endpoint moves nothing; env var enables loopback http', () => {
    expect(run({ NTC_PILOT_CHAVE: KEY }).status).toBe(0);
    const failed = join(dir, 'logs', 'otlp-failed');
    mkdirSync(failed, { recursive: true });
    writeFileSync(join(failed, 'y.jsonl'), '{}\n');
    expect(run({}).status).toBe(0);
    expect(readdirSync(failed)).toEqual(['y.jsonl']);
    expect(existsSync(join(dir, 'logs', 'otlp-superseded'))).toBe(false);
    const lb = run({ NTC_PILOT_ENDPOINT: 'http://localhost:9/x', NTC_PILOT_ALLOW_LOOPBACK_HTTP: '1' });
    expect(lb.status).toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('applies icacls on Windows (file stays readable by owner)', () => {
    expect(run({ NTC_PILOT_CHAVE: KEY, USERNAME: process.env.USERNAME ?? '' }).status).toBe(0);
    expect(existsSync(join(dir, 'config.json'))).toBe(true);
  });
});
