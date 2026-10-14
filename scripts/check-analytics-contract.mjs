import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  const args = process.argv.slice(2);
  const argument = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const schemaDir = argument('--schema-dir') ?? fileURLToPath(new URL('../schemas/ntconsult-analytics/v1/', import.meta.url));
  const bytes = readFileSync(path.join(schemaDir, 'analytics-observation-v1.schema.json'));
  const fixtureBytes = readFileSync(path.join(schemaDir, 'fixtures/analytics-observation-v1.json'));
  const lock = JSON.parse(readFileSync(path.join(schemaDir, 'contract.lock.json'), 'utf8'));
  if (lock.schemaVersion !== '1' || digest(bytes) !== lock.sha256) throw new Error('Analytics schema mirror hash mismatch');
  if (digest(fixtureBytes) !== lock.fixturesSha256) throw new Error('Canonical fixtures hash mismatch');
  const checksum = readFileSync(path.join(schemaDir, 'analytics-observation-v1.schema.sha256'), 'utf8').split(/\s+/)[0];
  if (checksum !== lock.sha256) throw new Error('Canonical checksum differs from lock');
  const canonical = argument('--canonical');
  if (canonical && digest(readFileSync(canonical)) !== lock.sha256) throw new Error('Backend canonical schema differs from mirror');
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(bytes.toString('utf8')));
  const fixtures = JSON.parse(fixtureBytes.toString('utf8'));
  for (const event of fixtures.valid) if (!validate(event)) throw new Error(`Valid canonical fixture rejected: ${ajv.errorsText(validate.errors)}`);
  for (const fixture of fixtures.invalid) if (validate(fixture.event)) throw new Error(`Invalid canonical fixture accepted: ${fixture.reason}`);
  console.log(JSON.stringify({ schemaVersion: '1', sha256: lock.sha256, valid: fixtures.valid.length, invalid: fixtures.invalid.length, canonicalChecked: !!canonical }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
