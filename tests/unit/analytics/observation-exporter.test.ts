import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { cleanupTempDir, createTempDir } from '../../helpers/fixture-builder.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { validateObservation, type Observation } from '../../../src/analytics/observation.js';
import {
  FileObservationSpool,
  ObservationExporter,
  attachObservation,
  createExclusionFence,
  synchronizeExclusions,
  type ObservationTransport,
} from '../../../src/analytics/observation-exporter.js';

/** Wrapper over the real fs: records rewrites and injects a concurrent append
 *  exactly into the removal window (the dangerous read-modify-write case). */
const fsHooks = vi.hoisted(() => ({
  armed: false,
  rewrites: [] as string[],
  concurrentLine: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    writeFile: (async (...args: unknown[]) => {
      fsHooks.rewrites.push('writeFile');
      return (actual.writeFile as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.writeFile,
    rename: (async (...args: unknown[]) => {
      fsHooks.rewrites.push('rename');
      return (actual.rename as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.rename,
    appendFile: (async (...args: unknown[]) => {
      const data = String(args[1] ?? '');
      if (fsHooks.armed && data.includes('"__remove"') && fsHooks.concurrentLine) {
        fsHooks.armed = false;
        // A concurrent persist lands right before the removal is applied.
        await (actual.appendFile as (...a: unknown[]) => unknown)(args[0], fsHooks.concurrentLine + '\n', args[2]);
      }
      return (actual.appendFile as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.appendFile,
  };
});

const secretFixture = `sk-or-v1-${'a1b2c3d4'.repeat(6)}`;
const deviceId = 'device-c7';

function makeObservation(overrides: Record<string, unknown> = {}): Observation {
  return validateObservation({
    schemaVersion: '1',
    observationId: 'obs-1',
    harnessId: 'claude-code',
    harnessVersion: '2.0.0',
    collectorVersion: '1.2.3',
    capabilitiesVersion: '1',
    deviceId,
    sessionId: 'session-1',
    occurredAt: '2026-10-14T12:00:00.000Z',
    missingFields: [],
    truncated: false,
    sourceRefs: [{ sourceNamespace: 'claude-code.hook', nativeId: 'call-1', phase: 'event' }],
    kind: 'command_context',
    payload: { resolvedCommand: null, scriptChain: [], modulePaths: ['package.json'], reason: null },
    ...overrides,
  });
}

function baseEntry(extra: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    time_unix_nano: '1760443200000000000',
    'event.id': 'evt-1',
    'event.name': 'other',
    'user.id': 'user-1',
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'claude-code',
    'gen_ai.provider.name': 'anthropic',
    ...extra,
  } as unknown as AgentActivityEntry;
}

function captureTransport() {
  const sent: string[] = [];
  const state = { failNetwork: false };
  const transport: ObservationTransport = {
    async send(serialized: string) {
      if (state.failNetwork) throw new TypeError('fetch failed');
      sent.push(serialized);
      return { status: 200 };
    },
  };
  return { sent, state, transport };
}

describe('observation exporter hardening (fix round 1)', () => {
  let dataDir: string;
  let spoolDir: string;

  beforeEach(async () => {
    dataDir = await createTempDir('analytics-export-fix1-');
    spoolDir = path.join(dataDir, 'spool');
    fsHooks.armed = false;
    fsHooks.concurrentLine = '';
    fsHooks.rewrites = [];
  });

  afterEach(async () => {
    await cleanupTempDir(dataDir);
  });

  it('workspace_scoped_exclusion_blocks_resend_by_source_and_replay', async () => {
    const { sent, state, transport } = captureTransport();
    const spool = new FileObservationSpool(spoolDir);
    // The tombstone id refers to another record: only the workspace scope can fence these.
    const fence = await synchronizeExclusions('7', [{ id: 'obs-deleted-source', deviceId, workspacePath: '/tmp/example-ws' }], {
      policy: { markExclusionsSynchronized: () => undefined },
    });
    const exporter = new ObservationExporter({ transport, spool, exclusions: fence });
    const entry = attachObservation(
      baseEntry({ 'workspace.path': '/tmp/example-ws' }),
      makeObservation({ observationId: 'obs-ws-1' }),
    );
    const outcome = await exporter.exportWithOutcome(entry);
    const exportedExcludedEvent = outcome.exported;
    expect(exportedExcludedEvent).toBe(false);
    // A second observation from the same excluded workspace is spooled while
    // offline, BEFORE the exclusion reaches the device...
    state.failNetwork = true;
    await new ObservationExporter({ transport, spool })
      .exportObservation(attachObservation(
        baseEntry({ 'workspace.path': '/tmp/example-ws' }),
        makeObservation({ observationId: 'obs-ws-2' }),
      ));
    state.failNetwork = false;
    // ...then the synced fence must stop the replay from resending it.
    const replay = await exporter.replay();
    expect(replay.sent).toEqual([]);
    expect(replay.excluded).toBe(1);
    expect(await spool.pending()).toEqual([]);
    expect(sent).toEqual([]);
    // When no workspace can be resolved the workspace-scoped exclusion fails closed.
    expect(fence.isExcluded(makeObservation({ observationId: 'obs-unrelated' }))).toBe(true);
    // The real C4 scope key is the workspace path, not an unpopulated workspace id.
    expect(fence.isExcluded(makeObservation({ observationId: 'obs-unrelated-2' }), { workspacePath: '/tmp/other-ws' })).toBe(false);
  });

  it('redaction_rewrite_of_identity_fields_fails_closed', async () => {
    const { sent, transport } = captureTransport();
    const spool = new FileObservationSpool(spoolDir);
    const exporter = new ObservationExporter({ transport, spool });
    for (const field of ['sessionId', 'workspaceId', 'turnId', 'parentCallId', 'toolCallId'] as const) {
      const corrupted = makeObservation({ [field]: secretFixture });
      // attach fails closed instead of emitting a rewritten identity.
      expect(() => attachObservation(baseEntry(), corrupted), field).toThrow(new RegExp(`redaction removed required field: ${field}`));
      // export fails closed and records the field, without sending or spooling.
      const outcome = await exporter.exportWithOutcome({
        ...baseEntry({ 'event.id': `evt-${field}` }),
        'ntconsult.analytics.schema_version': '1',
        'ntconsult.analytics.observation_id': corrupted.observationId,
        'ntconsult.analytics.kind': corrupted.kind,
        'ntconsult.analytics.observation': JSON.stringify(corrupted),
        'ntconsult.analytics.generated_by': 'analytics',
      } as unknown as AgentActivityEntry);
      expect(outcome, field).toEqual({ exported: false, spooled: false, excluded: false, failed: `redaction_removed_required_field:${field}` });
    }
    expect(sent).toEqual([]);
    expect(await spool.pending()).toEqual([]);
  });

  it('exclusion_overflow_is_recorded_and_fails_closed', async () => {
    const recorded: Array<{ limit: number; received: number }> = [];
    const overflow = Array.from({ length: 10_001 }, (_unused, index) => ({ id: `t-${index}`, deviceId }));
    const fence = createExclusionFence(overflow, { recordLimit: (info) => recorded.push(info) });
    expect(recorded).toEqual([{ limit: 10_000, received: 10_001 }]);
    // Exclusions that cannot be tracked may cover anything: nothing is resent.
    expect(fence.isExcluded(makeObservation({ observationId: 'obs-overflow-1' }))).toBe(true);
    const { sent, transport } = captureTransport();
    const exporter = new ObservationExporter({ transport, spool: new FileObservationSpool(spoolDir), exclusions: fence });
    const outcome = await exporter.exportWithOutcome(attachObservation(baseEntry(), makeObservation({ observationId: 'obs-overflow-2' })));
    const exportedExcludedEvent = outcome.exported;
    expect(exportedExcludedEvent).toBe(false);
    expect(sent).toEqual([]);
    // The synchronizer threads the recorder to the fence.
    const synced: Array<{ limit: number; received: number }> = [];
    await synchronizeExclusions('7', overflow, { policy: { markExclusionsSynchronized: () => undefined } },
      { recordLimit: (info) => synced.push(info) });
    expect(synced).toEqual([{ limit: 10_000, received: 10_001 }]);
  });

  it('a_concurrent_persist_during_remove_survives', async () => {
    const spool = new FileObservationSpool(spoolDir);
    const p1 = JSON.stringify({ 'event.id': 'p1' });
    const p2 = JSON.stringify({ 'event.id': 'p2' });
    const p3 = JSON.stringify({ 'event.id': 'p3' });
    const concurrent = JSON.stringify({ 'event.id': 'concurrent-1' });
    await spool.persist(p1);
    await spool.persist(p2);
    await spool.persist(p3);
    fsHooks.concurrentLine = concurrent;
    fsHooks.armed = true;
    await spool.remove(p1);
    expect(await spool.pending()).toEqual([p2, p3, concurrent]);
    // Removal must not be a read-modify-write rewrite: no window exists at all.
    expect(fsHooks.rewrites).toEqual([]);
    expect(fsHooks.armed).toBe(false);
    // A removal mark never cancels a later re-persist of the same record.
    await spool.persist(p1);
    expect(await spool.pending()).toEqual([p2, p3, concurrent, p1]);
  });
});
