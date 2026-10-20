import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('../schemas/ntconsult-analytics/v1/analytics-observation-v1.schema.json', import.meta.url));
const targetPath = fileURLToPath(new URL('../src/analytics/observation-contract.ts', import.meta.url));
const bytes = readFileSync(schemaPath);
const hash = createHash('sha256').update(bytes).digest('hex');

/** This generator handles the JSON-native canonical schema, never validation. */
function typeOf(schema, level = 0) {
  if ('const' in schema) return JSON.stringify(schema.const);
  if ('enum' in schema) return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  if (schema.oneOf || schema.anyOf) return (schema.oneOf ?? schema.anyOf).map(value => typeOf(value, level)).join(' | ');
  if (Array.isArray(schema.type)) return schema.type.map(type => typeOf({ ...schema, type }, level)).join(' | ');
  if (schema.type === 'object') {
    const required = schema.required ?? [];
    const fields = Object.entries(schema.properties ?? {}).map(([key, value]) =>
      `${'  '.repeat(level + 1)}${JSON.stringify(key)}${required.includes(key) ? '' : '?'}: ${typeOf(value, level + 1)};\n`).join('');
    return `{\n${fields}${'  '.repeat(level)}}`;
  }
  if (schema.type === 'array') return `Array<${typeOf(schema.items, level)}>`;
  const primitive = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', null: 'null' }[schema.type];
  if (!primitive) throw new Error(`Unsupported canonical schema shape: ${JSON.stringify(schema)}`);
  return primitive;
}

const generated = `// Generated from the canonical JSON Schema; do not edit by hand.\n// SHA-256: ${hash}\nexport type Observation = ${typeOf(JSON.parse(bytes.toString('utf8')))};\n`;
if (process.argv.includes('--check')) {
  if (readFileSync(targetPath, 'utf8') !== generated) {
    console.error('Generated Observation type differs from canonical schema');
    process.exitCode = 1;
  } else console.log(JSON.stringify({ sha256: hash, generatedTypes: 'matched' }));
} else {
  writeFileSync(targetPath, generated);
  console.log(JSON.stringify({ sha256: hash, generatedTypes: 'written' }));
}
