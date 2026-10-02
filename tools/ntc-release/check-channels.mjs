#!/usr/bin/env node
// Consistency check of the published manifest: manifest/stable.txt and manifest/canary.txt must
// agree with latest.json (version, package_url, sha256, git_commit). Reads the blob anonymously.
// Usage: check-channels.mjs --blob <base-url> [--repair <dir>]
//   --repair writes <dir>/manifest/stable.txt (and canary.txt when latest.json has a canary) FROM latest.json;
//   upload them with: NTC_TXT_ONLY=1 bash tools/ntc-release/publish-manifest.sh <dir>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderChannelEnv } from './manifest.mjs';

const KEYS = ['version', 'package_url', 'sha256', 'git_commit'];

export function parseChannelEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function diff(label, file, expected) {
  if (file === null) return [`${label} is missing`];
  const got = parseChannelEnv(file);
  return KEYS.filter((k) => got[k] !== expected[k])
    .map((k) => `${label} ${k} is ${JSON.stringify(got[k])}, latest.json says ${JSON.stringify(expected[k])}`);
}

/** latest: parsed latest.json; stable/canary: file text, or null when the blob does not exist. Returns problems. */
export function checkChannels({ latest, stable, canary }) {
  const problems = diff('manifest/stable.txt', stable, latest);
  if (latest.canary) problems.push(...diff('manifest/canary.txt', canary, latest.canary));
  else if (canary !== null) problems.push('manifest/canary.txt exists but latest.json has no canary (stale file)');
  return problems;
}

async function get(url) {
  let last = '';
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 404) return null;
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
    } catch (err) { last = String(err.message ?? err); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`could not fetch ${url}: ${last}`);
}

/** Write the channel files for `latest` under dir/manifest/ (canary.txt removed when there is no canary). */
export function writeChannelFiles(latest, dir) {
  mkdirSync(join(dir, 'manifest'), { recursive: true });
  writeFileSync(join(dir, 'manifest', 'stable.txt'), renderChannelEnv(latest));
  if (latest.canary) writeFileSync(join(dir, 'manifest', 'canary.txt'), renderChannelEnv(latest.canary));
  else rmSync(join(dir, 'manifest', 'canary.txt'), { force: true });
}

async function main(argv) {
  const usage = 'usage: check-channels.mjs --blob <base-url> [--repair <dir>]';
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== '--blob' || (argv.length === 4 && argv[2] !== '--repair')) throw new Error(usage);
  const base = argv[1].replace(/\/+$/, '');
  const repairDir = argv[3];
  const latestText = await get(`${base}/manifest/latest.json`);
  if (latestText === null) throw new Error('latest.json is missing');
  const latest = JSON.parse(latestText);
  if (repairDir) {
    writeChannelFiles(latest, repairDir);
    process.stdout.write(`channel files for ${latest.version} written under ${repairDir}/manifest\n`);
    return;
  }
  const problems = checkChannels({
    latest,
    stable: await get(`${base}/manifest/stable.txt`),
    canary: await get(`${base}/manifest/canary.txt`),
  });
  if (problems.length > 0) {
    process.stderr.write(`::error::published channel files disagree with latest.json:\n- ${problems.join('\n- ')}\n`);
    process.stderr.write('Recovery: latest.json is the source of truth. If it already points at this release, repair the txt files from it ' +
      '(check-channels.mjs --blob <url> --repair <dir>, then NTC_TXT_ONLY=1 publish-manifest.sh <dir>; the workflow tries this automatically) ' +
      'and push the ntc-v<version> tag by hand. Do not leave the channels split.\n');
    process.exit(1);
  }
  process.stdout.write('channels consistent with latest.json\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { process.stderr.write(`error: ${err.message}\n`); process.exit(1); });
}
