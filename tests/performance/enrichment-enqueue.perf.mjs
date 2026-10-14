// C4 durable enrichment queue — isolated enqueue latency benchmark.
//
// Measures ONLY the local store enqueue path (masked + fsync + rename into a
// private spool) inside this Node process. This is NOT an installed-harness
// p95 and NOT the hook lifecycle; it proves bounded enqueue bookkeeping at a
// given spool size, nothing more. Reports every sample plus nearest-rank
// p50/p95/max and the quantity seeded; a mean is never used as approval.
//
// Usage: rtk proxy node tests/performance/enrichment-enqueue.perf.mjs
//        (SEED=2000 MEASURE=300 to override quantities)
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const SEED = Number(process.env.SEED ?? 2000);
const MEASURE = Number(process.env.MEASURE ?? 300);
const OUT = process.env.OUT ?? '/tmp/analytics-c4-benchmark.json';

const now = () => Date.now();
const policy = () => ({ enrichmentEnabled: true, replayEnabled: false, deletionRevision: '1' });

function jobFor(i, dir) {
  return {
    id: `job-${i}`, dedupeKey: `event-${i}`, kind: 'repo_snapshot',
    sourceRefs: [{ sourceNamespace: 'claude-code-log', nativeId: `event-${i}`, phase: 'event' }],
    workspacePath: dir, occurredAt: new Date().toISOString(), deviceId: 'device', sessionId: 'session',
    nativeCallId: null, processNamespace: 'claude-code-log', harnessId: 'claude-code', harnessVersion: '1',
    collectorVersion: '1', capabilitiesVersion: '1', notBefore: 0, attempt: 0,
  };
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const nearest = q => sorted[Math.ceil(sorted.length * q) - 1];
  return {
    sampleCount: samples.length,
    p50Ms: nearest(0.5),
    p95Ms: nearest(0.95),
    maxMs: sorted.at(-1),
    meanMsDescriptiveOnly: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    samples,
  };
}

async function spoolBytes(root) {
  const spool = path.join(root, 'enrichment');
  let total = 0;
  try {
    for (const f of await fs.readdir(spool)) total += (await fs.stat(path.join(spool, f))).size;
    for (const f of await fs.readdir(path.join(spool, 'ids'))) total += (await fs.stat(path.join(spool, 'ids', f))).size;
  } catch { /* fresh spool */ }
  return total;
}

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-bench-'));
  try {
    const outfile = path.join(dir, 'queue.cjs');
    await build({ entryPoints: ['src/enrichment/job-store.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    const { JobStore } = await import(outfile);

    // Phase 1 — grow the spool to the seed quantity with real durable enqueues.
    const seedStore = new JobStore(dir, { policy, now });
    const seedStart = performance.now();
    for (let i = 0; i < SEED; i++) {
      const result = await seedStore.enqueue(jobFor(i, dir));
      if (result !== 'created') throw new Error('seed enqueue was not durable');
    }
    const seedMs = performance.now() - seedStart;
    const bytesBefore = await spoolBytes(dir);

    // Phase 2 — steady-state enqueues into the LARGE spool with the warm store.
    const warmSamples = [];
    for (let i = 0; i < MEASURE; i++) {
      const start = performance.now();
      const result = await seedStore.enqueue(jobFor(SEED + i, dir));
      if (result !== 'created') throw new Error('measured enqueue was not durable');
      warmSamples.push(performance.now() - start);
    }

    // Phase 3 — a fresh instance pays one bounded crash-recovery rebuild first.
    const recoveryStart = performance.now();
    const freshStore = new JobStore(dir, { policy, now });
    await freshStore.enqueue(jobFor(SEED + MEASURE, dir));
    const recoveryFirstOpMs = performance.now() - recoveryStart;
    const postSamples = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await freshStore.enqueue(jobFor(SEED + MEASURE + 1 + i, dir));
      postSamples.push(performance.now() - start);
    }

    // Phase 4 — a real concurrent worker process (claim + complete every ~250ms)
    // contends the shared cross-process lock while enqueues run.
    const workerBundle = path.join(dir, 'queue-worker.cjs');
    const workerCode = `const {JobStore}=require(process.argv[2]);
const dir=process.argv[3];const until=Date.now()+Number(process.argv[4]);
const policy=()=>({enrichmentEnabled:true,replayEnabled:false,deletionRevision:'1'});
const observation=j=>({schemaVersion:'1',observationId:j.id,kind:j.kind,harnessId:j.harnessId,harnessVersion:j.harnessVersion,collectorVersion:j.collectorVersion,deviceId:j.deviceId,sessionId:j.sessionId,capabilitiesVersion:j.capabilitiesVersion,occurredAt:j.occurredAt,sourceRefs:j.sourceRefs,missingFields:[],truncated:false,payload:{head:null,branch:null,worktreeId:'wt',dirtyFingerprint:'fp',files:[],truncated:false}});
(async()=>{const store=new JobStore(dir,{policy});
 while(Date.now()<until){
  // Mirrors the real scheduler tick: a busy claim is a skipped cycle, not a death.
  try{const job=await store.claim(Date.now(),3000);
   if(job){await new Promise(r=>setTimeout(r,15));try{await store.complete(job.id,observation(job),job.leaseToken);process.stdout.write('.');}catch{}}}
  catch{}
  await new Promise(r=>setTimeout(r,200));}})().catch(e=>{console.error(e);process.exitCode=1;});`;
    await fs.writeFile(workerBundle, workerCode);
    const contentionSamples = [];
    const workerRuns = MEASURE >= 150 ? 2 : 1;
    let workerCompleted = 0;
    let contendedCreated = 0;
    let recordedBusyLosses = 0;
    for (let round = 0; round < workerRuns; round++) {
      const perRound = Math.ceil(MEASURE / workerRuns);
      const child = spawn(process.execPath, [workerBundle, outfile, dir, '30000']);
      let workerOut = '';
      let workerErr = '';
      child.stdout.on('data', v => { workerOut += v; });
      child.stderr.on('data', v => { workerErr += v; });
      const childDone = new Promise(resolve => child.on('close', () => resolve()));
      for (let i = 0; i < perRound; i++) {
        const start = performance.now();
        try {
          const result = await seedStore.enqueue(jobFor(SEED + 10_000 + round * perRound + i, dir));
          if (result !== 'created') throw new Error('contended enqueue was not durable');
          contendedCreated++;
        } catch (e) {
          // The contention contract: retried within budget or recorded as a
          // durable busy loss — never dropped. Both are accountable outcomes.
          if (e instanceof Error && e.message === 'queue busy') recordedBusyLosses++;
          else throw e;
        }
        contentionSamples.push(performance.now() - start);
      }
      child.kill('SIGTERM');
      await childDone;
      workerCompleted += workerOut.length;
      if (workerErr) console.error('worker stderr:', workerErr.slice(0, 400));
    }

    // Phase 5 — continuity with the historical empty-spool benchmark (200 jobs).
    const smallDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c4-bench-small-'));
    const smallStore = new JobStore(smallDir, { policy, now });
    const smallSamples = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await smallStore.enqueue(jobFor(i, smallDir));
      smallSamples.push(performance.now() - start);
    }

    const report = {
      what: 'isolated JobStore.enqueue latency (masked + fsync + rename); NOT installed-harness p95, NOT hook lifecycle',
      platform: process.platform, node: process.version,
      seedQuantity: SEED, measuredQuantity: MEASURE, spoolBytesBeforeMeasurement: bytesBefore,
      seedTotalMs: Math.round(seedMs),
      largeSpool: stats(warmSamples),
      freshInstanceFirstOpInclRecoveryMs: Math.round(recoveryFirstOpMs * 100) / 100,
      freshInstanceSteadyState: stats(postSamples),
      largeSpoolUnderWorkerContention: {
        ...stats(contentionSamples),
        what: 'enqueue latency under concurrent worker contention (child process claim+complete on the shared lock); NOT installed-harness p95',
        workerJobsCompletedDuringMeasurement: workerCompleted,
        contendedCreated,
        recordedBusyLosses,
        accountability: `${contendedCreated} created + ${recordedBusyLosses} recorded busy losses = ${contendedCreated + recordedBusyLosses} of ${contentionSamples.length} attempted (none dropped)`,
      },
      emptySpoolContinuity200: stats(smallSamples),
      method: 'every sample retained; nearest-rank percentiles; no warmup discarded; mean labeled descriptive only',
    };
    await fs.writeFile(OUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      ...report,
      largeSpool: { ...report.largeSpool, samples: `${report.largeSpool.sampleCount} samples in file` },
      freshInstanceSteadyState: { ...report.freshInstanceSteadyState, samples: 'omitted' },
      largeSpoolUnderWorkerContention: { ...report.largeSpoolUnderWorkerContention, samples: `${report.largeSpoolUnderWorkerContention.sampleCount} samples in file` },
      emptySpoolContinuity200: { ...report.emptySpoolContinuity200, samples: 'omitted' },
    }, null, 2));
    await fs.rm(smallDir, { recursive: true, force: true });
    if (report.largeSpool.p95Ms > 100 || report.largeSpoolUnderWorkerContention.p95Ms > 100) process.exitCode = 1;
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
