#!/usr/bin/env node
// Usage: node scripts/sign-analytics-manifest.mjs payload.json private-key.pem envelope.json
// Private key is a local/pipeline input. Never copied into the artifact or logged.
import { readFile, writeFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  throw new Error('Unsupported JSON');
}
try {
  const [payloadFile, keyFile, outputFile, ...extra] = process.argv.slice(2);
  if (!payloadFile || !keyFile || !outputFile || extra.length) throw new Error('Invalid arguments');
  const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
  if (payload.schemaVersion !== 1 || payload.protocolVersion !== 1 || !payload.keyId || !payload.archiveSha256 || !payload.collectorRange || !payload.assets) throw new Error('Invalid payload');
  const key = createPrivateKey(await readFile(keyFile));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 required');
  const signature = sign(null, Buffer.from(canonical(payload), 'utf8'), key).toString('base64');
  await writeFile(outputFile, JSON.stringify({ payload, signature }) + '\n', { mode: 0o600, flag: 'wx' });
} catch { process.stderr.write('Analytics manifest signing failed; check local inputs.\n'); process.exitCode = 1; }
