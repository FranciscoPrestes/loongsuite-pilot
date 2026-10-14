import type { Observation } from '../analytics/observation.js';
import type { EffectiveInstrumentationPolicy } from '../analytics/desired-policy-client.js';
import type { LocalJob, ObservationKind } from './job-contract.js';
import { JobStore } from './job-store.js';
export interface OwnedProcess { kill(signal?:NodeJS.Signals):unknown }
export interface JobContext { ownProcess(child:OwnedProcess):void }
export type EnrichmentHandler=(job:LocalJob,signal:AbortSignal,context:JobContext)=>Promise<Observation>;
export interface SchedulerOptions { policy:()=>EffectiveInstrumentationPolicy;timeoutMs?:number;onError?:(reason:string)=>void }
/** Only trusted compiled handlers. No command strings or code from central policy. */
export class EnrichmentScheduler {
 readonly config:{timeoutMs:number};private handlers=new Map<ObservationKind,EnrichmentHandler>();
 private timer:ReturnType<typeof setInterval>|null=null;private pending:Promise<void>|null=null;private active:AbortController|null=null;private stopping=false;
 constructor(private readonly store:JobStore,private readonly options:SchedulerOptions){this.config={timeoutMs:options.timeoutMs??2000};if(this.config.timeoutMs<=0||this.config.timeoutMs>2000)throw new Error('invalid worker timeout');}
 register(kind:ObservationKind,handler:EnrichmentHandler):void{this.handlers.set(kind,handler);}
 start():void{if(this.timer)return;this.stopping=false;this.timer=setInterval(()=>{void this.tick();},250);this.timer.unref?.();void this.tick();}
 async stop():Promise<void>{this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.active?.abort();await this.pending;}
 tick():Promise<void>{if(this.pending)return this.pending;this.pending=this.tickOnce().catch(()=>{try{this.options.onError?.('enrichment_queue_unavailable');}catch{/* observer cannot stop capture */}}).finally(()=>{this.pending=null;});return this.pending;}
 private async tickOnce():Promise<void>{
  if(this.stopping||!this.options.policy().enrichmentEnabled)return;
  const job=await this.store.claim(Date.now(),this.config.timeoutMs+1000,[...this.handlers.keys()]);if(!job)return;
  const controller=new AbortController();this.active=controller;
  try{const result=await this.run(job,controller.signal);if(!this.stopping&&!controller.signal.aborted&&this.options.policy().enrichmentEnabled)await this.store.complete(job.id,result,job.leaseToken!);}
  catch{ // A stop-initiated abort is a shutdown, not a failed attempt; only real failures burn retries.
   if(!this.stopping)await this.store.retry(job.id,job.leaseToken!).catch(()=>{});}
  finally{this.active=null;}
 }
 async run(job:LocalJob,signal:AbortSignal):Promise<Observation>{
  const handler=this.handlers.get(job.kind);if(!handler)throw new Error('handler deferred');
  const controller=new AbortController();const children=new Set<OwnedProcess>();
  const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([
   new Promise<never>((_,reject)=>{const stopped=()=>{for(const child of children){try{child.kill('SIGKILL');}catch{/* own child already gone */}}reject(new Error('worker aborted'));};controller.signal.addEventListener('abort',stopped,{once:true});if(controller.signal.aborted)stopped();timer=setTimeout(abort,this.config.timeoutMs);}),
   Promise.resolve().then(()=>{if(controller.signal.aborted)throw new Error('worker aborted');return handler(job,controller.signal,{ownProcess:child=>{if(controller.signal.aborted)child.kill('SIGKILL');else children.add(child);}});}),
  ]);}finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
 }
}
