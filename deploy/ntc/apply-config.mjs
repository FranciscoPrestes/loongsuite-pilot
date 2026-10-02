#!/usr/bin/env node
// NTConsult config merger. Standalone (node builtins only): shipped in the
// package as scripts/ntc-apply-config.mjs.
// Usage: node apply-config.mjs --data-dir <dir> [--allow-loopback-http]
// Env: NTC_PILOT_CHAVE, NTC_PILOT_ENDPOINT, NTC_PILOT_BLOB_URL, NTC_PILOT_CANARY=1,
//      NTC_PILOT_ALLOW_LOOPBACK_HTTP=1
// The key is never printed, logged or placed in an error message.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENDPOINT = 'https://beat.ntconsult.ai/api/ingest/otlp';
const DEFAULT_BLOB = 'https://stntconsultpilot.blob.core.windows.net/pilot';
const KEY_RE = /^ntcp_[0-9A-Za-z]{32,}$/;

function checkUrl(name, value, allowLoopbackHttp) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must not be empty`);
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (u.protocol === 'https:') return;
  if (allowLoopbackHttp && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return;
  throw new Error(`${name} must use https://`);
}

export function applyNtcConfig(existing, opts) {
  const { key, endpoint, canary, allowLoopbackHttp } = opts;
  checkUrl('endpoint', endpoint, allowLoopbackHttp);
  checkUrl('blobUrl', opts.blobUrl, allowLoopbackHttp);
  const blob = opts.blobUrl.replace(/\/+$/, '');

  const prev = existing.otlpTrace ?? {};
  // Drop every case variant of the authorization header so a stale one cannot coexist.
  const prevHeaders = Object.fromEntries(
    Object.entries(prev.headers ?? {}).filter(([k]) => k.toLowerCase() !== 'authorization'),
  );
  let authorization;
  if (key !== undefined && key !== '') {
    if (!KEY_RE.test(key)) throw new Error('NTC_PILOT_CHAVE has an invalid format');
    authorization = `Bearer ${key}`;
  } else {
    authorization = Object.entries(prev.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1];
    if (!authorization) throw new Error('NTC_PILOT_CHAVE is required on first install');
  }

  const config = {
    ...existing,
    serviceName: 'loongsuite-pilot',
    otlpTrace: {
      ...prev,
      endpoint,
      headers: { ...prevHeaders, Authorization: authorization },
      captureMessageContent: true,
      spanAttributePassthroughPrefixes: ['agent.copilot.'],
      maxExportBatchBytes: 8388608,
      turnIdleTimeoutMs: 300000,
    },
    retention: { ...existing.retention, otlpFailedDays: 30, otlpFailedMaxTotalMiB: 2048 },
    autoUpdate: {
      ...existing.autoUpdate,
      enabled: true,
      manifestUrl: `${blob}/manifest/latest.json`,
      packageUrl: `${blob}/releases/latest/loongsuite-pilot.tar.gz`,
      nodeDepsUrl: `${blob}/deps/node`,
      nodeModulesUrl: `${blob}/deps/node-modules`,
    },
  };
  if (canary) config.canary = { ...existing.canary, policy: 'latest' };

  const previousEndpoint = prev.endpoint;
  return { config, previousEndpoint, endpointChanged: previousEndpoint !== endpoint };
}

function readExisting(file) {
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through; never echo parser output (it may quote file content)
  }
  throw new Error(`existing config.json is not a valid JSON object: ${file}`);
}

function winPrincipal(env) {
  if (!env.USERNAME) throw new Error('USERNAME is not set; cannot restrict file permissions on Windows');
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
}

// Windows only: the Pilot rewrites config.json via tmp+rename and the new file inherits the
// directory ACL, so the data dir itself gets an inheritable owner/SYSTEM-only grant.
function restrictWindowsDir(dir, env) {
  execFileSync(
    'icacls',
    [dir, '/inheritance:r', '/grant:r', `${winPrincipal(env)}:(OI)(CI)F`, '/grant:r', 'SYSTEM:(OI)(CI)F'],
    { stdio: 'ignore' },
  );
}

function writeConfig0600(file, config, env) {
  const tmp = `${file}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  if (process.platform === 'win32') {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${winPrincipal(env)}:F`], { stdio: 'ignore' });
  }
}

function supersedeFailed(dataDir) {
  const failed = join(dataDir, 'logs', 'otlp-failed');
  if (!existsSync(failed)) return 0;
  const names = readdirSync(failed);
  if (names.length === 0) return 0;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(dataDir, 'logs', 'otlp-superseded', stamp);
  mkdirSync(dest, { recursive: true });
  for (const n of names) renameSync(join(failed, n), join(dest, n));
  return names.length;
}

function main(argv, env) {
  const i = argv.indexOf('--data-dir');
  const dataDir = i >= 0 ? argv[i + 1] : undefined;
  if (!dataDir) throw new Error('missing --data-dir');
  const allowLoopbackHttp = argv.includes('--allow-loopback-http') || env.NTC_PILOT_ALLOW_LOOPBACK_HTTP === '1';
  const file = join(resolve(dataDir), 'config.json');
  const { config, endpointChanged } = applyNtcConfig(readExisting(file), {
    key: env.NTC_PILOT_CHAVE,
    endpoint: env.NTC_PILOT_ENDPOINT || DEFAULT_ENDPOINT,
    blobUrl: env.NTC_PILOT_BLOB_URL || DEFAULT_BLOB,
    canary: env.NTC_PILOT_CANARY === '1',
    allowLoopbackHttp,
  });
  if ([env.NTC_PILOT_ENDPOINT, env.NTC_PILOT_BLOB_URL].some((u) => u?.startsWith('http:'))) {
    console.error('warning: loopback http is allowed for this run (testing only)');
  }
  const root = resolve(dataDir);
  mkdirSync(root, { recursive: true });
  if (process.platform === 'win32') restrictWindowsDir(root, env);
  // Supersede old batches first: a crash in between must not leave the new endpoint with old batches.
  const moved = endpointChanged ? supersedeFailed(root) : 0;
  writeConfig0600(file, config, env);
  console.log(`NTConsult config applied: ${file}${moved ? ` (${moved} failed batches moved to otlp-superseded)` : ''}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`ntc-apply-config failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exit(1);
  }
}
