import '../helpers/mask-all.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { InputManager } from '../../src/core/input-manager.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';
import { ClientType, CollectionMethod } from '../../src/types/index.js';
import { attachObservation, FileObservationSpool, ObservationExporter } from '../../src/analytics/observation-exporter.js';
import { maskEvidence } from '../../src/enrichment/job-contract.js';
import { JobStore } from '../../src/enrichment/job-store.js';
import { job } from '../unit/enrichment/fixtures.js';
import { validateObservation } from '../../src/analytics/observation.js';

vi.mock('../../src/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

/** Credential forms the old rules did not cover; none may appear anywhere a record can leave the process. */
const SECRETS = {
  bearer: 'Zq8vN3xL1pR7tY2wK5mB9cD4fG6hJ0aS',
  password: 'hunter2-SEKRET-pw',
  npm: 'npm_' + 'aB3dE5gH7jK9mN1pQ4sT6vW8yZ2cF0hLaB3d',
  stripe: 'sk_live_' + 'aB3dE5gH7jK9mN1pQ4sT6vW8',
  cookie: 'sess-SEKRET-cookie-value',
};
const LEAKY_TEXT = [
  `curl -H "Authorization: Bearer ${SECRETS.bearer}" https://api.example.com/v1?token=${SECRETS.bearer}`,
  `mysql://root:${SECRETS.password}@db/app`,
  `//registry.npmjs.org/:_authToken=${SECRETS.npm}`,
  `STRIPE=${SECRETS.stripe}`,
  `Cookie: sid=${SECRETS.cookie}; theme=dark`,
].join('\n');
const assertNoSecrets = (text: string, where: string) => {
  for (const [name, secret] of Object.entries(SECRETS)) expect(text, `${name} leaked in ${where}`).not.toContain(secret);
};

class StubInput extends EventEmitter {
  setWorkspacePolicy() {}
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.IdeSnapshotPolling;
  running = false;
  constructor(readonly id: string) { super(); }
  async start() { this.running = true; }
  async stop() { this.running = false; }
}

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c10-order-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('masking happens before every way out', () => {
  it('base capture: tool arguments, results and errors reach the flusher (and so OTLP and the failed log) already masked', async () => {
    const manager = new InputManager();
    const flusher = new MockFlusher();
    manager.setFlusher(flusher);
    manager.setMaskConfig({ mode: 'custom', types: ['cloudAccessKey', 'apiKey', 'privateKey', 'databaseUrl'] });
    const input = new StubInput('order');
    manager.registerInput(input as never);
    input.emit('entries', [buildTestEntry({
      'event.name': 'tool.call', 'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.arguments': JSON.stringify({ command: LEAKY_TEXT }),
      'gen_ai.tool.call.result': LEAKY_TEXT, 'error.message': LEAKY_TEXT,
    })]);
    await manager.stopAll();
    const dispatched = flusher.batchCalls.flat();
    expect(dispatched.length).toBeGreaterThan(0);
    assertNoSecrets(JSON.stringify(dispatched), 'dispatched entries');
  });

  it('enrichment queue: evidence persisted by the C4 store is masked before it touches disk', async () => {
    const masked = maskEvidence({ text: LEAKY_TEXT });
    assertNoSecrets(JSON.stringify(masked), 'maskEvidence');
    const store = new JobStore(dir, { policy: () => ({ enrichmentEnabled: true, replayEnabled: true, baseTelemetryEnabled: true as const, reason: 'ready' as const, desiredRevision: '1', deletionRevision: '1' }) });
    await store.enqueue(job({ occurredAt: new Date().toISOString(), sourceRefs: [{ sourceNamespace: 'ns', nativeId: `n ${LEAKY_TEXT.replace(/\n/g, ' ')}`.slice(0, 480), phase: 'event' }] }));
    const files = (await fs.readdir(path.join(dir, 'enrichment'))).filter(f => f.endsWith('.json'));
    for (const file of files) assertNoSecrets(await fs.readFile(path.join(dir, 'enrichment', file), 'utf8'), `journal ${file}`);
  });

  it('export, spool and replay: the sent bytes, the spooled bytes and the replayed bytes carry no credential', async () => {
    const observation = validateObservation({
      schemaVersion: '1', observationId: 'obs-secret', kind: 'command_context', harnessId: 'claude-code', harnessVersion: '1', collectorVersion: '1',
      deviceId: 'dev', sessionId: 's', capabilitiesVersion: '1', occurredAt: new Date().toISOString(), missingFields: [], truncated: false,
      sourceRefs: [{ sourceNamespace: 'ns', nativeId: 'n', phase: 'event' }], generatedBy: 'collector',
      payload: { resolvedCommand: LEAKY_TEXT, scriptChain: [LEAKY_TEXT], modulePaths: [], reason: null },
    });
    const entry = attachObservation(buildTestEntry({}), observation);
    assertNoSecrets(JSON.stringify(entry), 'attached entry');
    const sent: string[] = [];
    let online = false;
    const spool = new FileObservationSpool(path.join(dir, 'spool'));
    const exporter = new ObservationExporter({ spool, transport: { send: async s => { if (!online) throw new Error('offline'); sent.push(s); return { status: 200 }; } } });
    await exporter.exportWithOutcome(entry);            // offline: spooled
    for (const record of await spool.pending()) assertNoSecrets(record, 'spool');
    for (const file of await fs.readdir(path.join(dir, 'spool'))) assertNoSecrets(await fs.readFile(path.join(dir, 'spool', file), 'utf8'), `spool file ${file}`);
    online = true;
    expect((await exporter.replay()).sent).toHaveLength(1);
    online = true;
    await exporter.exportWithOutcome(entry);            // direct send
    expect(sent).toHaveLength(2);
    sent.forEach(s => assertNoSecrets(s, 'transport payload'));
  });
});
