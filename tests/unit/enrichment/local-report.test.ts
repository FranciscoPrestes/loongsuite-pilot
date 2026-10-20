import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildLocalReportObservation,
  readLocalReport,
  reportBytesLimit,
} from '../../../src/enrichment/local-report.js';
import { buildCommandContextObservation } from '../../../src/enrichment/command-context.js';
import { job } from './fixtures.js';

let dir: string;
const signal = (): AbortSignal => new AbortController().signal;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-report-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function junit(overrides: Partial<Record<string, string>> = {}, properties = ''): string {
  const attrs: Record<string, string> = {
    tests: '3',
    failures: '1',
    errors: '0',
    skipped: '0',
    time: '1.25',
    ...overrides,
  };
  const attrText = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  const cases = attrs.tests === '0'
    ? ''
    : `<testcase name="a" classname="C"/>\n    <testcase name="b" classname="C"><failure message="boom"/></testcase>\n    <testcase name="c" classname="C"/>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="suite" ${attrText}>\n    ${properties}\n    ${cases}\n  </testsuite>\n</testsuites>\n`;
}

describe('local verification report reading', () => {
  it('stale_report_not_associated', async () => {
    // A leftover report from an earlier run carries a DIFFERENT embedded
    // execution id: mtime or recency never links it to the current execution.
    const oldPath = write(
      'junit-old.xml',
      junit({}, '<property name="executionId" value="call-old"/>'),
    );
    const oldReport = (await readLocalReport(oldPath, dir, 'call-new', signal()))!;
    expect(oldReport).not.toBeNull();
    expect(oldReport.executionId).toBeNull();
    expect(oldReport.association).toBe('unresolved');

    // mtime alone does NOT prove linkage: a fresh report without any embedded
    // execution identity stays unresolved even for the current execution.
    const freshPath = write('junit-fresh.xml', junit());
    const fresh = Date.now();
    fs.utimesSync(freshPath, new Date(fresh), new Date(fresh));
    const freshReport = await readLocalReport(freshPath, dir, 'call-new', signal());
    expect(freshReport!.executionId).toBeNull();
    expect(freshReport!.association).toBe('unresolved');
  });

  it('zero_cases_preserved', async () => {
    const zeroPath = write('zero.xml', junit({
      tests: '0', failures: '0', errors: '0', skipped: '0', time: '0',
    }, ''));
    const zero = (await readLocalReport(zeroPath, dir, null, signal()))!;
    expect(zero).not.toBeNull();
    expect(zero.cases).toBe(0);
    expect(zero.passed).toBe(0);
    expect(zero.failed).toBe(0);

    const jsonZero = await readLocalReport(
      write('zero.json', JSON.stringify({ runner: 'vitest', cases: 0, passed: 0, failed: 0 })),
      dir, null, signal(),
    );
    expect(jsonZero!.cases).toBe(0);
  });

  it('oversize_report_rejected', async () => {
    expect(reportBytesLimit).toBe(2_097_152);
    const oversize = write('big.xml', Buffer.alloc(reportBytesLimit + 1, 0x20));
    const report = await readLocalReport(oversize, dir, 'call-1', signal());
    expect(report).toBeNull();
  });

  it('explicit_association_by_execution_identity', async () => {
    const xmlPath = write('ok.xml', junit({}, '<property name="executionId" value="call-1"/>'));
    const xml = await readLocalReport(xmlPath, dir, 'call-1', signal());
    expect(xml!.association).toBe('explicit');
    expect(xml!.executionId).toBe('call-1');
    expect(xml!.runner).toBe('junit');
    expect(xml!.cases).toBe(3);
    expect(xml!.passed).toBe(2);
    expect(xml!.failed).toBe(1);
    expect(xml!.durationMs).toBe(1250);
    expect(xml!.sourceHash).toBe(createHash('sha256').update(fs.readFileSync(xmlPath)).digest('hex'));

    // The file name can carry the execution identity as a delimited token.
    const byName = write('junit-call-77.xml', junit());
    const named = await readLocalReport(byName, dir, 'call-77', signal());
    expect(named!.association).toBe('explicit');
    expect(named!.executionId).toBe('call-77');
  });

  it('external_entities_are_disabled', async () => {
    const secret = write('secret.txt', 'XXE-MARKER-CONTENT');
    const xxe = write('xxe.xml',
      `<?xml version="1.0"?>\n<!DOCTYPE testsuites [<!ENTITY xxe SYSTEM "file://${secret}">]>\n<testsuites><testsuite tests="&xxe;" failures="0" errors="0" skipped="0" time="0"></testsuite></testsuites>\n`);
    const report = await readLocalReport(xxe, dir, 'call-1', signal());
    // Documents declaring entities are refused outright: nothing is expanded.
    expect(report).toBeNull();

    const entityRef = write('entity.xml', junit({ name: '&xxe;' }));
    const second = await readLocalReport(entityRef, dir, null, signal());
    if (second) expect(JSON.stringify(second)).not.toContain('XXE-MARKER-CONTENT');

    // The entity guard itself: a document that reaches the readers but
    // declares an entity must still be refused (never parsed, never expanded).
    const lateEntity = write(
      'late-entity.xml',
      `<testsuites><!ENTITY xxe SYSTEM "file://${secret}"><testsuite tests="1" failures="0" errors="0" skipped="0" time="0"></testsuite></testsuites>`,
    );
    expect(await readLocalReport(lateEntity, dir, null, signal())).toBeNull();
  });

  it('malformed_xml_is_inconclusive', async () => {
    const truncated = write('truncated.xml', '<testsuite tests="2"');
    expect(await readLocalReport(truncated, dir, null, signal())).toBeNull();

    const garbage = write('garbage.xml', 'this is not xml at all');
    expect(await readLocalReport(garbage, dir, null, signal())).toBeNull();

    const badJson = write('bad.json', '{ not json');
    expect(await readLocalReport(badJson, dir, null, signal())).toBeNull();
  });

  it('cancellation_never_produces_a_summary', async () => {
    const p = write('cancel.xml', junit());
    const controller = new AbortController();
    controller.abort();
    await expect(readLocalReport(p, dir, 'call-1', controller.signal)).rejects.toThrow(/aborted/);
  });

  it('nonexistent_runner_output_is_inconclusive', async () => {
    // No report at all: the runner never produced one.
    expect(await readLocalReport(path.join(dir, 'missing.xml'), dir, 'call-1', signal())).toBeNull();
    // Outside the workspace (another worktree) is never read.
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'c6-outside-'));
    try {
      const outside = path.join(outsideRoot, 'other.xml');
      fs.writeFileSync(outside, junit());
      expect(await readLocalReport(outside, dir, 'call-1', signal())).toBeNull();
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
    // Unknown runner/format is inconclusive, never a success.
    expect(await readLocalReport(write('note.txt', 'runner: unknown'), dir, null, signal())).toBeNull();
  });

  it('trx_and_json_runner_reports_are_summarized', async () => {
    const trxPath = write('results.trx', `<?xml version="1.0" encoding="UTF-8"?>
<TestRun id="run-1" name="test" xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">
  <Times creation="2026-10-14T10:00:00.0000000Z" finish="2026-10-14T10:00:02.5000000Z"/>
  <TestSettings name="default"><Properties><Property name="executionId" value="call-9"/></Properties></TestSettings>
  <ResultSummary outcome="Completed"><Counters total="4" executed="4" passed="3" failed="1" error="0" timeout="0" aborted="0" notRunnable="0" notExecuted="0" inconclusive="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"/></ResultSummary>
</TestRun>`);
    const trx = await readLocalReport(trxPath, dir, 'call-9', signal());
    expect(trx!.runner).toBe('trx');
    expect(trx!.cases).toBe(4);
    expect(trx!.passed).toBe(3);
    expect(trx!.failed).toBe(1);
    expect(trx!.durationMs).toBe(2500);
    expect(trx!.association).toBe('explicit');
    expect(trx!.executionId).toBe('call-9');

    const jsonPath = write('run.json', JSON.stringify({
      numTotalTests: 5,
      numPassedTests: 4,
      numFailedTests: 1,
      startTime: 1_000,
      endTime: 3_400,
    }));
    const json = await readLocalReport(jsonPath, dir, null, signal());
    expect(json!.runner).toBe('json');
    expect(json!.cases).toBe(5);
    expect(json!.passed).toBe(4);
    expect(json!.failed).toBe(1);
    expect(json!.durationMs).toBe(2400);
  });

  it('embedded_id_conflict_is_never_associated', async () => {
    // The report embeds another execution's id while the FILE NAME carries the
    // candidate: the embedded identity claim is authoritative, so the conflict
    // stays unresolved — never attributed to the filename's execution.
    const conflictPath = write(
      'junit-call-new.xml',
      junit({}, '<property name="executionId" value="call-old"/>'),
    );
    const conflict = await readLocalReport(conflictPath, dir, 'call-new', signal());
    expect(conflict).not.toBeNull();
    expect(conflict!.association).toBe('unresolved');
    expect(conflict!.executionId).toBeNull();
  });

  it('supplements_reference_the_original_call_without_a_second_call', async () => {
    const summary = {
      runner: 'junit',
      cases: 3,
      passed: 2,
      failed: 1,
      durationMs: 1250,
      sourceHash: 'a'.repeat(64),
      executionId: 'call-1',
      association: 'explicit' as const,
    };
    const original = job({ id: 'job-9', kind: 'local_report', nativeCallId: 'call-1' });
    const observation = buildLocalReportObservation(original, summary);
    // The supplement references the ORIGINAL call; it never mints a second one.
    expect(observation.kind).toBe('local_report');
    expect(observation.toolCallId).toBe('call-1');
    expect(observation.sourceRefs).toEqual(original.sourceRefs);
    expect(observation.observationId).not.toBe(original.id);
    expect(observation.payload).toMatchObject({ runner: 'junit', cases: 3, executionId: 'call-1', association: 'explicit' });

    // The command_context supplement follows the same original-call rule.
    const commandObservation = buildCommandContextObservation(
      job({ id: 'job-10', kind: 'command_context', nativeCallId: 'call-2' }),
      { resolvedCommand: 'npm test', scriptChain: ['test'], modulePaths: [], reason: null, truncated: false },
    );
    expect(commandObservation.toolCallId).toBe('call-2');
    expect(commandObservation.sourceRefs).toEqual(job({ id: 'job-10' }).sourceRefs);
  });
});
