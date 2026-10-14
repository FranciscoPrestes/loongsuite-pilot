import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import * as path from 'node:path';
import * as os from 'node:os';
import { JobStore } from '../../../src/enrichment/job-store.js';
import type { LocalJob } from '../../../src/enrichment/job-contract.js';
import type { Observation } from '../../../src/analytics/observation.js';
import {job,observation,observationsFor} from './fixtures.js';
// True durability boundary: production renames through this exact module. The
// wrapper only fails writes whose destination is the loss manifest.
const renameFailure = vi.hoisted(() => ({ suffix: '' }));
// Spill-write race injector: creates a real spill marker right after the Nth
// readdir of the spill dir (i.e. after a fold's listing snapshot).
const spillRace = vi.hoisted(() => ({ dir: '', calls: 0, injectAt: 0, file: '', content: {} as Record<string, unknown> }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const failingRename = (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]): void => {
    if (renameFailure.suffix && String(to).endsWith(renameFailure.suffix)) throw new Error('disk full');
    actual.renameSync(from, to);
  };
  const readdirSync = ((p: never, opts?: never) => {
    const result = (actual.readdirSync as unknown as (path: unknown, options?: unknown) => unknown)(p, opts);
    if (spillRace.dir && String(p) === spillRace.dir && ++spillRace.calls === spillRace.injectAt) {
      actual.writeFileSync(spillRace.file, JSON.stringify(spillRace.content));
    }
    return result;
  }) as typeof actual.readdirSync;
  return { ...actual, renameSync: failingRename, readdirSync, default: { ...actual.default, renameSync: failingRename, readdirSync } };
});
let dir:string;
beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'c4-queue-'));});
afterEach(async()=>{await fs.chmod(dir,0o700);await fs.rm(dir,{recursive:true,force:true});});
const now=Date.parse('2026-10-14T10:00:00Z');
const policy=()=>({enrichmentEnabled:true,replayEnabled:true,baseTelemetryEnabled:true as const,reason:'ready' as const,desiredRevision:'1',deletionRevision:'1'});
const store=(options={})=>new JobStore(dir,{now:()=>now,policy,...options});
describe('durable enrichment queue',()=>{
 it('crash_after_enqueue_recovers',async()=>{await store().enqueue(job());expect((await store().claim(now,2000))?.sessionId).toBe('session-1');});
 it('crash_before_ack_deduplicates across concurrent stores and retains one observation',async()=>{
  const a=store(),b=store();const results=await Promise.all([a.enqueue(job()),b.enqueue(job({id:'job-2'}))]);expect(results.sort()).toEqual(['created','existing']);
  const claims=await Promise.all([a.claim(now,2000),b.claim(now,2000)]);expect(claims.filter(Boolean)).toHaveLength(1);const c=claims.find(Boolean)!;
  await a.complete(c.id,observation(c),c.leaseToken!);await b.complete(c.id,observation(c),c.leaseToken!);expect(await observationsFor(dir,c.id)).toHaveLength(1);
  expect(await store().enqueue(job())).toBe('existing');
 });
 it('lease_expiry_reclaims and rejects publication by old lease',async()=>{const a=store();await a.enqueue(job());const old=(await a.claim(now,20))!;const fresh=(await store().claim(now+21,2000))!;expect(fresh.leaseToken).not.toBe(old.leaseToken);await expect(a.complete(old.id,observation(old),old.leaseToken!)).rejects.toThrow('lease');await store({now:()=>now+21}).complete(fresh.id,observation(fresh),fresh.leaseToken!);});
 it('rejects arbitrary commands and unbounded source references before persistence',async()=>{await expect(store().enqueue({...job(),command:'rm -rf /'} as LocalJob)).rejects.toThrow();await expect(store().enqueue(job({sourceRefs:Array(101).fill(job().sourceRefs[0])}))).rejects.toThrow();expect((await fs.readdir(dir)).filter(f=>f.endsWith('.json'))).toHaveLength(0);});
 it('masks before persist and preserves original source files',async()=>{const original=path.join(dir,'source.txt');await fs.writeFile(original,'original');await store().enqueue(job({sourceRefs:[{sourceNamespace:'hook',nativeId:'api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890',phase:'event'}]}));const files=await fs.readdir(path.join(dir,'enrichment'));const content=(await Promise.all(files.filter(f=>f.endsWith('.json')).map(f=>fs.readFile(path.join(dir,'enrichment',f),'utf8')))).join('');expect(content).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234567890');expect(await fs.readFile(original,'utf8')).toBe('original');});
 it('disk_quota_emits_loss_state before discard and expires after seven days',async()=>{const a=store({maxSpoolBytes:5000});await a.enqueue(job());await a.maintain(now+8*86400000);expect(await a.claim(now+8*86400000,2000)).toBeNull();const losses=await a.losses();expect(losses[0]).toMatchObject({count:1,reason:'expired',unreported:false});expect(losses[0].from).toBe(job().occurredAt);await expect(store({maxSpoolBytes:10}).enqueue(job({id:'other',dedupeKey:'other'}))).rejects.toThrow('quota');expect((await a.losses()).some(x=>x.reason==='quota')).toBe(true);});
 it('read-only spool fails without removing queued jobs',async()=>{await store().enqueue(job());await fs.chmod(path.join(dir,'enrichment'),0o500);await expect(store().enqueue(job({id:'other',dedupeKey:'other'}))).rejects.toThrow();await fs.chmod(path.join(dir,'enrichment'),0o700);expect(await store().claim(now,2000)).not.toBeNull();});
 it('gates replay until current tombstones synchronize and prevents resurrection after restart',async()=>{let revision='1';const a=store({policy:()=>({...policy(),deletionRevision:revision})});await a.enqueue(job());const c=(await a.claim(now,2000))!;await a.complete(c.id,observation(c),c.leaseToken!);expect(await a.replayBatch()).toEqual([]);await a.synchronizeTombstones('1',[]);expect(await a.replayBatch()).toHaveLength(1);revision='2';expect(await a.replayBatch()).toEqual([]);await expect(a.synchronizeTombstones('1',[])).rejects.toThrow('revision');await a.synchronizeTombstones('2',[{id:'deletion-1',deviceId:'device-1',sessionId:'session-1'}]);expect(await a.replayBatch()).toEqual([]);expect(await store({policy:()=>({...policy(),deletionRevision:'2'})}).enqueue(job())).toBe('existing');});
 it('cannot reenable replay when policy is withdrawn during tombstone synchronization',async()=>{let enabled=true;const a=store({policy:()=>({...policy(),replayEnabled:enabled})});await a.synchronizeTombstones('1',[]);enabled=false;expect(await a.replayBatch()).toEqual([]);});
 it('does not resurrect expired signals or retain future timestamps indefinitely',async()=>{const a=store();await expect(a.enqueue(job({occurredAt:'2026-10-01T00:00:00Z'}))).rejects.toThrow('expired');await expect(a.enqueue(job({occurredAt:'2099-10-01T00:00:00Z'}))).rejects.toThrow('future');expect((await a.losses())[0]).toMatchObject({reason:'expired',count:1,unreported:false});});
 it('requires the complete observation provenance including native call and harness',async()=>{const a=store();await a.enqueue(job({nativeCallId:'call'}));const c=(await a.claim(now,2000))!;await expect(a.complete(c.id,{...observation(c),harnessId:'other'},c.leaseToken!)).rejects.toThrow('provenance');await expect(a.complete(c.id,observation(c),c.leaseToken!)).rejects.toThrow('provenance');});
 it('coalesces only snapshots with matching workspace fingerprint, not separate native calls',async()=>{const a=store();await a.enqueue(job({fingerprint:'fp'}));expect(await a.enqueue(job({id:'second',dedupeKey:'second',fingerprint:'fp'}))).toBe('existing');expect(await a.enqueue(job({id:'third',dedupeKey:'native-1',kind:'command_context',nativeCallId:'call-1'}))).toBe('created');expect(await a.enqueue(job({id:'fourth',dedupeKey:'native-1',kind:'command_context',nativeCallId:'call-2'}))).toBe('created');});
 it('keeps journals when the loss manifest path is incompatible before expiry deletion',async()=>{const a=store();await a.enqueue(job());
  // Real filesystem failure: an incompatible directory occupies the loss manifest path, so the loss record can be neither read nor durably replaced.
  await fs.mkdir(path.join(dir,'enrichment','loss-manifest.json'));
  await expect(a.maintain(now+8*86400000)).rejects.toThrow();expect(await store().claim(now,2000)).not.toBeNull();});
 it('keeps journals when the loss manifest write fails at the durability boundary',async()=>{const a=store();await a.enqueue(job());
  renameFailure.suffix='loss-manifest.json';try{await expect(a.maintain(now+8*86400000)).rejects.toThrow('disk full');}finally{renameFailure.suffix='';}
  expect(await store().claim(now,2000)).not.toBeNull();expect(await a.losses()).toEqual([]);});
 it('rejects symlinked spool and journals without modifying their target',async()=>{const other=path.join(dir,'other');await fs.mkdir(other);await fs.writeFile(path.join(other,'keep'),'original');await fs.symlink(other,path.join(dir,'enrichment'));await expect(store().enqueue(job())).rejects.toThrow('unsafe');expect(await fs.readFile(path.join(other,'keep'),'utf8')).toBe('original');});
 it('retries with backoff, reaches dead state and recovers after a suspended lease',async()=>{let clock=now;const a=store({now:()=>clock});await a.enqueue(job());for(let n=0;n<5;n++){const c=(await a.claim(clock,2000))!;expect(c.attempt).toBe(n);await a.retry(c.id,c.leaseToken!);expect(await a.claim(clock,2000)).toBeNull();clock+=64000;}expect(await a.claim(clock,2000)).toBeNull();});
 it('deduplicates concurrent independent processes using real filesystem locks',async()=>{
  const bundle=path.join(dir,'queue.cjs');await build({entryPoints:['src/enrichment/job-store.ts'],outfile:bundle,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
  const input=JSON.stringify(job());const code=`const {JobStore}=require(process.argv[1]);const job=JSON.parse(process.argv[3]);const policy=()=>({enrichmentEnabled:true,replayEnabled:true,deletionRevision:'1'});(async()=>{const store=new JobStore(process.argv[2],{policy,now:()=>${now}});for(let n=0;n<20;n++){try{console.log(await store.enqueue(job));return;}catch(e){if(!String(e).includes('busy'))throw e;await new Promise(r=>setTimeout(r,10));}}throw new Error('busy');})().catch(e=>{console.error(e);process.exitCode=1;});`;
  const results=await Promise.all(Array.from({length:4},()=>new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,['-e',code,bundle,dir,input]);let out='';let err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(new Error(err)));})));
  expect(results.sort()).toEqual(['created','existing','existing','existing']);expect((await store().claim(now,2000))?.id).toBe('job-1');
 });
 it('quarantines a corrupt journal instead of crashing the store or silently accepting it',async()=>{
  const a=store();await a.enqueue(job());
  const journal=(await fs.readdir(path.join(dir,'enrichment'))).find(f=>/^[a-f0-9]{64}\.json$/.test(f))!;
  await fs.writeFile(path.join(dir,'enrichment',journal),'{"broken":');
  const b=store();expect(await b.claim(now,2000)).toBeNull();
  const quarantined=await fs.readdir(path.join(dir,'enrichment','quarantine'));
  expect(quarantined.some(f=>f.includes(journal))).toBe(true);
  expect(await b.enqueue(job())).toBe('created');});
 it('quarantines journals with malformed state or result instead of trusting them',async()=>{
  await store().enqueue(job());const spool=path.join(dir,'enrichment');
  const key=(await fs.readdir(spool)).find(f=>/^[a-f0-9]{64}\.json$/.test(f))!;
  const valid=JSON.parse(await fs.readFile(path.join(spool,key),'utf8'));
  await fs.writeFile(path.join(spool,key),JSON.stringify({...valid,state:'nonsense'}));
  expect(await store().claim(now,2000)).toBeNull();
  expect(await store().enqueue(job())).toBe('created');
  const key2=(await fs.readdir(spool)).find(f=>/^[a-f0-9]{64}\.json$/.test(f))!;
  const valid2=JSON.parse(await fs.readFile(path.join(spool,key2),'utf8'));
  await fs.writeFile(path.join(spool,key2),JSON.stringify({...valid2,state:'complete',result:{schemaVersion:'1'}}));
  expect(await store().claim(now,2000)).toBeNull();
  expect((await fs.readdir(path.join(spool,'quarantine'))).length).toBe(2);});
 it('fails closed on corrupt tombstone state and repairs from a fresh synchronization',async()=>{
  const a=store();await a.enqueue(job());
  await fs.writeFile(path.join(dir,'enrichment','exclusions.json'),'{');
  await expect(a.enqueue(job({id:'other',dedupeKey:'other'}))).rejects.toThrow();
  expect(await a.claim(now,2000)).toBeNull();
  expect(await a.replayBatch()).toEqual([]);
  await a.synchronizeTombstones('1',[]);
  expect(await store().enqueue(job({id:'third',dedupeKey:'third'}))).toBe('created');});
 it('recovers quota bookkeeping instead of trusting a cached undercount after a crash',async()=>{
  const seed=store();await seed.enqueue(job({id:'j1',dedupeKey:'e1'}));await seed.enqueue(job({id:'j2',dedupeKey:'e2'}));
  const spool=path.join(dir,'enrichment');let total=0;
  for(const f of await fs.readdir(spool)){if(/^[a-f0-9]{64}\.json$/.test(f))total+=(await fs.stat(path.join(spool,f))).size;}
  for(const f of await fs.readdir(path.join(spool,'ids'))){total+=(await fs.stat(path.join(spool,'ids',f))).size;}
  // Simulate crash residue: the durable bookkeeping undercounts the real spool.
  await fs.writeFile(path.join(spool,'usage.json'),JSON.stringify({bytes:0}));
  const tight=store({maxSpoolBytes:total});
  await expect(tight.enqueue(job({id:'j3',dedupeKey:'e3'}))).rejects.toThrow('quota');
  expect((await tight.losses()).some(l=>l.reason==='quota')).toBe(true);});
 it('rebuilds the id index after bookkeeping loss and still rejects duplicate identifiers',async()=>{
  const a=store();await a.enqueue(job());
  await fs.rm(path.join(dir,'enrichment','ids'),{recursive:true,force:true});
  const fresh=store();const claimed=(await fresh.claim(now,2000))!;
  expect(claimed.id).toBe('job-1');
  await fresh.complete(claimed.id,observation(claimed),claimed.leaseToken!);
  expect(await observationsFor(dir,'job-1')).toHaveLength(1);
  await expect(fresh.enqueue(job({id:'job-1',dedupeKey:'other'}))).rejects.toThrow('conflict');});
 it('records a truthful busy loss instead of silently dropping enqueues while a worker holds the lock',async()=>{
  const a=store();await a.enqueue(job());
  const {acquireSingleInstanceLock}=await import('../../../src/utils/single-instance-lock.js');
  // The lock hold simulates a concurrent worker's maintenance window on the shared spool lock.
  const held=acquireSingleInstanceLock(path.join(dir,'enrichment','queue.lock'));
  expect(held.lock).not.toBeNull();
  try{
   const attempts=await Promise.allSettled(Array.from({length:5},(_,i)=>store().enqueue(job({id:`busy-${i}`,dedupeKey:`busy-${i}`}))));
   expect(attempts.every(r=>r.status==='rejected')).toBe(true);
  }finally{held.lock!.release();}
  await store().maintain(now);
  expect((await store().losses()).find(l=>l.reason==='busy')).toMatchObject({count:5,unreported:false});
  // Accounting: attempted = created journals + recorded losses; nothing vanished.
  const journals=(await fs.readdir(path.join(dir,'enrichment'))).filter(f=>/^[a-f0-9]{64}\.json$/.test(f));
  expect(journals).toHaveLength(1);});
 it('recovers transient lock contention in budget instead of losing the job',async()=>{
  const a=store();await a.enqueue(job());
  const {acquireSingleInstanceLock}=await import('../../../src/utils/single-instance-lock.js');
  const held=acquireSingleInstanceLock(path.join(dir,'enrichment','queue.lock'));
  setTimeout(()=>held.lock!.release(),120);
  // Contention outlives one 80ms acquisition window but not the bounded enqueue budget.
  expect(await store().enqueue(job({id:'retry-job',dedupeKey:'retry-event'}))).toBe('created');
  expect((await store().losses()).find(l=>l.reason==='busy')).toBeUndefined();});
 it('never delivers an expired pending job: the claim path discards it with an expired loss',async()=>{
  let clock=now;
  const a=store({now:()=>clock});
  await a.enqueue(job({occurredAt:new Date(clock-6*86400000).toISOString()}));
  clock+=2*86400000;
  expect(await a.claim(clock,2000)).toBeNull();
  expect((await a.losses()).find(l=>l.reason==='expired')).toMatchObject({count:1,unreported:false});
  expect(await a.claim(clock,2000)).toBeNull();});
 it('keeps a spill marker written during a fold for the next fold and counts it exactly once',async()=>{
  const a=store();await a.enqueue(job());
  const {acquireSingleInstanceLock}=await import('../../../src/utils/single-instance-lock.js');
  const held=acquireSingleInstanceLock(path.join(dir,'enrichment','queue.lock'));
  await expect(a.enqueue(job({id:'busy-old',dedupeKey:'busy-old'}))).rejects.toThrow('busy');
  held.lock!.release();
  const spillDir=path.join(dir,'enrichment','spill');
  // A concurrent lock-free spill write lands right after the fold's listing snapshot.
  spillRace.dir=spillDir;spillRace.calls=0;spillRace.injectAt=1;
  spillRace.file=path.join(spillDir,`${Date.now()}-injected.json`);
  spillRace.content={reason:'busy',occurredAt:job().occurredAt};
  try{await a.maintain();}finally{spillRace.dir='';}
  expect(await fs.readdir(spillDir)).toEqual([path.basename(spillRace.file)]);
  expect((await a.losses()).find(l=>l.reason==='busy')).toMatchObject({count:1});
  await a.maintain();
  expect(await fs.readdir(spillDir)).toEqual([]);
  expect((await a.losses()).find(l=>l.reason==='busy')).toMatchObject({count:2,unreported:false});});

});
