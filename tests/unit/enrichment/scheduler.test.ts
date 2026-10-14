import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';import * as os from 'node:os';import * as path from 'node:path';
import {JobStore} from '../../../src/enrichment/job-store.js';
import {EnrichmentScheduler} from '../../../src/enrichment/scheduler.js';
import {job,observation,observationsFor} from './fixtures.js';
let dir:string;beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'c4-scheduler-'));});afterEach(async()=>{await fs.rm(dir,{recursive:true,force:true});});
const policy=()=>({enrichmentEnabled:true,replayEnabled:true,baseTelemetryEnabled:true as const,reason:'ready' as const,desiredRevision:'1',deletionRevision:'1'});
describe('bounded scheduler',()=>{
 it('deadline_aborts signal and owned processes without publishing a late result',async()=>{const store=new JobStore(dir,{policy});const scheduler=new EnrichmentScheduler(store,{policy,timeoutMs:20});let signal:AbortSignal|undefined;let killed=false;
 scheduler.register('repo_snapshot',async(j,s,context)=>{signal=s;context.ownProcess({kill:()=>{killed=true;}});await new Promise(r=>setTimeout(r,50));return observation(j);});await store.enqueue(job({occurredAt:new Date().toISOString()}));await scheduler.tick();expect(signal?.aborted).toBe(true);expect(killed).toBe(true);await new Promise(r=>setTimeout(r,60));expect(await observationsFor(dir,'job-1')).toHaveLength(0);});
 it('defaults to a two second deadline and defers unregistered handlers without burning attempts',async()=>{const store=new JobStore(dir,{policy});const scheduler=new EnrichmentScheduler(store,{policy});expect(scheduler.config.timeoutMs).toBe(2000);await store.enqueue(job({occurredAt:new Date().toISOString()}));await scheduler.tick();scheduler.register('repo_snapshot',async j=>observation(j));await scheduler.tick();expect(await observationsFor(dir,'job-1')).toHaveLength(1);});
 it('disabled enrichment does not claim and stop aborts a running task',async()=>{let enabled=false;const effective=()=>({...policy(),enrichmentEnabled:enabled});const store=new JobStore(dir,{policy:effective});const scheduler=new EnrichmentScheduler(store,{policy:effective});await store.enqueue(job({occurredAt:new Date().toISOString()}));await scheduler.tick();expect(await observationsFor(dir,'job-1')).toEqual([]);enabled=true;let signal:AbortSignal|undefined;scheduler.register('repo_snapshot',async(j,s)=>{signal=s;await new Promise(()=>{});return observation(j);});const pending=scheduler.tick();await new Promise(r=>setTimeout(r,30));await scheduler.stop();await pending;expect(signal?.aborted).toBe(true);});
 it('rejects unregistered handlers, refuses a pre-aborted signal and shares one pending drain',async()=>{
  const store=new JobStore(dir,{policy});const scheduler=new EnrichmentScheduler(store,{policy});
  const fresh=job({occurredAt:new Date().toISOString()});
  await expect(scheduler.run(fresh,new AbortController().signal)).rejects.toThrow('handler deferred');
  scheduler.register('repo_snapshot',async j=>observation(j));
  const aborted=new AbortController();aborted.abort();
  await expect(scheduler.run(fresh,aborted.signal)).rejects.toThrow('worker aborted');
  const drain=scheduler.tick();expect(scheduler.tick()).toBe(drain);await drain;});
});
