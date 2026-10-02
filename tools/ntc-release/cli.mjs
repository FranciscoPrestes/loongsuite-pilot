#!/usr/bin/env node
// CLI: next-version | check-newer | manifest. See task 4/9 of the NTConsult phase-1 plan.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { nextNtcVersion } from './version.mjs';
import { buildManifest, compareNtc, renderChannelEnv } from './manifest.mjs';

const BOOLEAN_FLAGS = new Set(['allow-downgrade']);
const VALUE_FLAGS = new Set([
  'base', 'tags-file', 'action', 'prev', 'version', 'git-commit', 'package-url',
  'sha256', 'released-at', 'rollout', 'out-dir',
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (!BOOLEAN_FLAGS.has(key) && !VALUE_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    if (key in out) throw new Error(`duplicate flag: --${key}`);
    if (BOOLEAN_FLAGS.has(key)) { out[key] = true; continue; }
    const val = argv[++i];
    if (val === undefined) throw new Error(`missing value for --${key}`);
    out[key] = val;
  }
  return out;
}

function need(args, key) {
  if (args[key] === undefined) throw new Error(`missing --${key}`);
  return args[key];
}

function parsePrev(raw) {
  if (raw === undefined || raw === '-' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--prev is not valid JSON: ${err.message}`);
  }
}

function runNextVersion(args) {
  const tags = readFileSync(need(args, 'tags-file'), 'utf8').split(/\r?\n/).filter(Boolean);
  process.stdout.write(`${nextNtcVersion(need(args, 'base'), tags)}\n`);
}

function runCheckNewer(args) {
  const version = need(args, 'version');
  const prev = parsePrev(args.prev);
  if (!prev) return;
  const blockers = [['stable', prev.version], ['canary', prev.canary?.version]]
    .filter(([, v]) => typeof v === 'string' && compareNtc(version, v) <= 0);
  if (blockers.length === 0) return;
  const which = blockers.map(([n, v]) => `${n} ${v}`).join(' and ');
  throw new Error(
    `version ${version} is not strictly above the published ${which}. The updater never downgrades, ` +
    'so a release must beat both current stable and canary. A source_ref rollback only works while the ' +
    "source commit's package.json base version is >= the published one; if upstream bumped the base since, " +
    'publish a revert commit on the CURRENT base so the next -ntc.N is higher.',
  );
}

function runManifest(args) {
  const kind = need(args, 'action');
  const release = {
    version: need(args, 'version'),
    git_commit: need(args, 'git-commit'),
    package_url: need(args, 'package-url'),
    sha256: need(args, 'sha256'),
    released_at: need(args, 'released-at'),
  };
  const action = kind === 'canary'
    ? { kind, release, rolloutPercentage: Number(args.rollout ?? 10) }
    : { kind, release };
  const manifest = buildManifest(parsePrev(args.prev), action, {
    allowDowngrade: args['allow-downgrade'] === true,
  });
  const dir = need(args, 'out-dir');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, 'stable.txt'), renderChannelEnv(manifest));
  if (manifest.canary) writeFileSync(join(dir, 'canary.txt'), renderChannelEnv(manifest.canary));
  else rmSync(join(dir, 'canary.txt'), { force: true });
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'next-version') runNextVersion(args);
  else if (cmd === 'check-newer') runCheckNewer(args);
  else if (cmd === 'manifest') runManifest(args);
  else throw new Error('usage: cli.mjs <next-version|check-newer|manifest> ...');
} catch (err) {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
}
