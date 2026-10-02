#!/usr/bin/env node
// Consistency check of the published manifest: manifest/stable.txt and manifest/canary.txt must
// agree with latest.json (version, package_url, sha256, git_commit). Reads the blob anonymously.
// Usage: check-channels.mjs --blob <base-url>
import { pathToFileURL } from 'node:url';

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

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--blob') throw new Error('usage: check-channels.mjs --blob <base-url>');
  const base = argv[1].replace(/\/+$/, '');
  const latestText = await get(`${base}/latest.json`);
  if (latestText === null) throw new Error('latest.json is missing');
  const problems = checkChannels({
    latest: JSON.parse(latestText),
    stable: await get(`${base}/manifest/stable.txt`),
    canary: await get(`${base}/manifest/canary.txt`),
  });
  if (problems.length > 0) {
    process.stderr.write(`::error::published channel files disagree with latest.json:\n- ${problems.join('\n- ')}\n`);
    process.stderr.write('Recovery: latest.json is the source of truth. Rerun the same workflow (release uploads are resumable) ' +
      'or rewrite the txt files from latest.json with tools/ntc-release/cli.mjs manifest; do not leave channels split.\n');
    process.exit(1);
  }
  process.stdout.write('channels consistent with latest.json\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { process.stderr.write(`error: ${err.message}\n`); process.exit(1); });
}
