#!/usr/bin/env node
// NTConsult packaging overlay.
// Usage: node deploy/ntc/overlay.mjs --stage <PKG_DIR> --blob <URL> --installers-out <DIR>
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findForbiddenOrigins, rewriteOrigins } from './rewrite-origins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BINARY_EXT = new Set(['.node', '.png', '.gz', '.tgz', '.icns', '.zip']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`invalid arguments near "${key ?? ''}"`);
    }
    out[key.slice(2)] = value;
  }
  for (const k of ['stage', 'blob', 'installers-out']) {
    if (!out[k]) throw new Error(`missing --${k}`);
  }
  return out;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.isFile()) yield p;
  }
}

function isBinary(path, buf) {
  return BINARY_EXT.has(extname(path).toLowerCase()) || buf.includes(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const stage = resolve(args.stage);
  const blob = args.blob.replace(/\/+$/, '');
  const installersOut = resolve(args['installers-out']);
  const problems = [];
  let rewritten = 0;

  const check = (path, text) => {
    for (const hit of new Set(findForbiddenOrigins(text))) problems.push(`${path}: ${hit}`);
  };

  for (const file of walk(stage)) {
    const buf = readFileSync(file);
    if (isBinary(file, buf)) continue;
    const before = buf.toString('utf8');
    const after = rewriteOrigins(before, blob);
    if (after !== before) {
      writeFileSync(file, after);
      rewritten += 1;
    }
    check(file, after);
  }

  mkdirSync(installersOut, { recursive: true });
  for (const ext of ['sh', 'ps1']) {
    const src = join(REPO, 'deploy', `installer-opensource.${ext}`);
    const dest = join(installersOut, `installer.${ext}`);
    const text = rewriteOrigins(readFileSync(src, 'utf8'), blob);
    writeFileSync(dest, text);
    check(dest, text);
  }

  // Task 5 creates apply-config.mjs; until then the copy is optional.
  const applyConfig = join(HERE, 'apply-config.mjs');
  if (existsSync(applyConfig)) {
    mkdirSync(join(stage, 'scripts'), { recursive: true });
    copyFileSync(applyConfig, join(stage, 'scripts', 'ntc-apply-config.mjs'));
  }

  if (problems.length > 0) {
    console.error('Forbidden origins remain after rewrite:');
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`    ✅ NTConsult overlay: ${rewritten} files rewritten, installers in ${installersOut}`);
}

try {
  main();
} catch (err) {
  console.error(`overlay failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
