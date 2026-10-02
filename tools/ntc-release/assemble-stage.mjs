#!/usr/bin/env node
// Assemble the blob stage directory for a NTConsult release (task 9 of the phase-1 plan).
//   stage:          assemble-stage.mjs stage --version V --pkg-dir D --thin-dir deploy/ntc
//                     [--node-modules-dir D2] --out STAGE
//                   Prints the tar.gz sha256 on stdout.
//   place-manifest: assemble-stage.mjs place-manifest --manifest-dir M --out STAGE
// Plain ESM, no dependencies. Layout (relative to the container root):
//   releases/<v>/{loongsuite-pilot.tar.gz,loongsuite-pilot.zip,installer.sh,installer.ps1,apply-config.mjs,SHA256SUMS}
//   deps/node-modules/<v>/{node-modules-<os>-<arch>.tar.gz,SHASUMS256.txt}
//   install.sh, install.ps1, latest.json, manifest/{stable,canary}.txt
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-ntc\.[0-9]+)?$/;
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64'];
export const RELEASE_FILES = [
  'loongsuite-pilot.tar.gz', 'loongsuite-pilot.zip', 'installer.sh', 'installer.ps1', 'apply-config.mjs',
];

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`missing ${label}: ${path}`);
}

/** SHA256SUMS text (sha256sum format, two spaces) for the given files in `dir`, in the given order. */
export function renderSha256Sums(dir, names) {
  return names.map((n) => `${sha256File(join(dir, n))}  ${n}\n`).join('');
}

function assembleNodeModules(nmDir, destDir, platforms) {
  mkdirSync(destDir, { recursive: true });
  const lines = [];
  for (const p of platforms) {
    const archive = `node-modules-${p}.tar.gz`;
    const fragment = join(nmDir, `SHASUMS256.txt.${p}`);
    requireFile(join(nmDir, archive), `node-modules archive for ${p}`);
    requireFile(fragment, `shasum fragment for ${p}`);
    const m = /^([0-9a-f]{64})  (\S+)\n?$/.exec(readFileSync(fragment, 'utf8'));
    if (!m || m[2] !== archive) throw new Error(`bad shasum fragment for ${p}`);
    if (m[1] !== sha256File(join(nmDir, archive))) throw new Error(`shasum fragment does not match archive for ${p}`);
    copyFileSync(join(nmDir, archive), join(destDir, archive));
    lines.push(`${m[1]}  ${archive}\n`);
  }
  writeFileSync(join(destDir, 'SHASUMS256.txt'), lines.join(''));
}

/** Build the stage tree. Returns { sha256 } of the package tar.gz. */
export function assembleStage({ version, pkgDir, thinDir, nodeModulesDir, out, platforms = PLATFORMS }) {
  if (!VERSION_RE.test(version ?? '')) throw new Error(`invalid version: ${JSON.stringify(version)}`);
  for (const f of RELEASE_FILES) requireFile(join(pkgDir, f), f);
  for (const f of ['install.sh', 'install.ps1']) requireFile(join(thinDir, f), `thin installer ${f}`);
  rmSync(out, { recursive: true, force: true });
  const rel = join(out, 'releases', version);
  mkdirSync(rel, { recursive: true });
  for (const f of RELEASE_FILES) copyFileSync(join(pkgDir, f), join(rel, f));
  writeFileSync(join(rel, 'SHA256SUMS'), renderSha256Sums(rel, RELEASE_FILES));
  for (const f of ['install.sh', 'install.ps1']) copyFileSync(join(thinDir, f), join(out, f));
  if (nodeModulesDir) assembleNodeModules(nodeModulesDir, join(out, 'deps', 'node-modules', version), platforms);
  return { sha256: sha256File(join(rel, 'loongsuite-pilot.tar.gz')) };
}

/** Copy the manifest CLI output into the stage: latest.json at the root, channel files under manifest/. */
export function placeManifest({ manifestDir, out }) {
  requireFile(join(manifestDir, 'latest.json'), 'latest.json');
  requireFile(join(manifestDir, 'stable.txt'), 'stable.txt');
  mkdirSync(join(out, 'manifest'), { recursive: true });
  copyFileSync(join(manifestDir, 'latest.json'), join(out, 'latest.json'));
  copyFileSync(join(manifestDir, 'stable.txt'), join(out, 'manifest', 'stable.txt'));
  const canary = join(manifestDir, 'canary.txt');
  if (existsSync(canary)) copyFileSync(canary, join(out, 'manifest', 'canary.txt'));
  else rmSync(join(out, 'manifest', 'canary.txt'), { force: true });
}

const VALUE_FLAGS = new Set(['version', 'pkg-dir', 'thin-dir', 'node-modules-dir', 'manifest-dir', 'out']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const key = a.slice(2);
    if (!VALUE_FLAGS.has(key)) throw new Error(`unknown flag: --${key}`);
    if (key in out) throw new Error(`duplicate flag: --${key}`);
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

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (cmd === 'stage') {
    const { sha256 } = assembleStage({
      version: need(args, 'version'), pkgDir: need(args, 'pkg-dir'), thinDir: need(args, 'thin-dir'),
      nodeModulesDir: args['node-modules-dir'], out: need(args, 'out'),
    });
    process.stdout.write(`${sha256}\n`);
  } else if (cmd === 'place-manifest') {
    placeManifest({ manifestDir: need(args, 'manifest-dir'), out: need(args, 'out') });
  } else {
    throw new Error('usage: assemble-stage.mjs <stage|place-manifest> ...');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exit(1); }
}
