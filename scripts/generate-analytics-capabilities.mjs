// Renders docs/analytics-capability-matrix.md from agents.d/*.json. Plain node: the TS renderer is
// bundled in memory with esbuild (a devDependency), so there is a single source of truth for the matrix.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const target = join(root, 'docs', 'analytics-capability-matrix.md');
const evidenceFile = join(root, 'docs', 'analytics-live-evidence.json');

const bundled = await build({
  entryPoints: [join(root, 'src', 'analytics', 'capability-matrix.ts')], bundle: true, write: false,
  platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent',
  define: { __INTERNAL_BUILD__: 'false', __PROPRIETARY_BUILD__: 'false' },
});
const code = bundled.outputFiles[0].text;
const { generateCapabilityMatrix } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));

const dir = join(root, 'agents.d');
const definitions = readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => JSON.parse(readFileSync(join(dir, n), 'utf8')));
const evidence = existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, 'utf8')) : [];
const generated = generateCapabilityMatrix(definitions, evidence) + '\n';

if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8') !== generated) {
    console.error('docs/analytics-capability-matrix.md is out of date; run node scripts/generate-analytics-capabilities.mjs');
    process.exitCode = 1;
  } else console.log(JSON.stringify({ harnesses: definitions.length, matrix: 'matched' }));
} else {
  writeFileSync(target, generated);
  console.log(JSON.stringify({ harnesses: definitions.length, matrix: 'written' }));
}
