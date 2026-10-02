#!/usr/bin/env node
// Read the release fields to promote from the current latest.json (its canary entry).
// Usage: promote-args.mjs --latest <file> --version <v>
// Prints key=value lines (git_commit, package_url, sha256, released_at) after validating each
// value has no whitespace. Fails unless latest.json.canary.version equals <v>.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+-ntc\.[0-9]+$/;
const FIELDS = ['git_commit', 'package_url', 'sha256', 'released_at'];

export function promoteArgs(latest, version) {
  if (!VERSION_RE.test(version ?? '')) throw new Error(`invalid version: ${JSON.stringify(version)}`);
  const canary = latest?.canary;
  if (!canary || canary.version !== version) {
    throw new Error(`${version} is not the current canary (canary is ${canary?.version ?? 'absent'}); only the canary can be promoted`);
  }
  const out = {};
  for (const k of FIELDS) {
    if (typeof canary[k] !== 'string' || canary[k] === '' || /\s/.test(canary[k])) {
      throw new Error(`canary.${k} is missing or contains whitespace`);
    }
    out[k] = canary[k];
  }
  return out;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k !== '--latest' && k !== '--version') throw new Error(`unknown argument: ${k}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${k}`);
    args[k.slice(2)] = argv[i + 1];
  }
  const latest = JSON.parse(readFileSync(args.latest ?? '', 'utf8'));
  const out = promoteArgs(latest, args.version);
  process.stdout.write(FIELDS.map((k) => `${k}=${out[k]}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); } catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exit(1); }
}
