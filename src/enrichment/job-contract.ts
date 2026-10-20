import { z } from 'zod';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Observation } from '../analytics/observation.js';
import { activeMaskPlan, isMaskActive } from '../mask/active-mask.js';
import { maskString } from '../mask/string-masker.js';
export type ObservationKind = Observation['kind'];
export type EvidenceRef = Observation['sourceRefs'][number];
const text = z.string().min(1).max(500);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const jobSchema = z.object({
 id:text,dedupeKey:text,kind:z.enum(['capability','repo_snapshot','command_context','local_report','hook_health']),
 sourceRefs:z.array(z.object({sourceNamespace:text,nativeId:text,phase:z.enum(['started','progress','completed','cancelled','event']),traceId:text.optional(),spanId:text.optional(),eventId:text.optional(),contentHash:text.optional()}).strict()).min(1).max(100),
 workspacePath:z.string().min(1).max(4096).refine(v=>path.isAbsolute(v)&&!v.includes('\0')),
 occurredAt:z.string().datetime({offset:true}),deviceId:text,sessionId:text,nativeCallId:text.nullable(),processNamespace:text,
 harnessId:text,harnessVersion:text,collectorVersion:text,capabilitiesVersion:text,
 turnId:text.optional(),parentCallId:text.optional(),repoKey:text.optional(),fingerprint:text.optional(),notBefore:count,attempt:count.max(5),leaseToken:text.optional(),
}).strict();
export type LocalJob = z.infer<typeof jobSchema>;
export const digest = (value:string):string => createHash('sha256').update(value).digest('hex');
/** Persisted evidence strings use the mask the user switched on; with none, they are kept as they are. */
export function maskEvidence<T>(value:T):T {
 if(typeof value==='string'){const maskPlan=activeMaskPlan();return (isMaskActive(maskPlan)?maskString(value,maskPlan):value) as T;}
 if(Array.isArray(value))return value.map(v=>maskEvidence(v)) as T;
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,maskEvidence(v)])) as T;
 return value;
}
export function prepareJob(value:unknown):LocalJob {
 const job=jobSchema.parse(value);
 if(Buffer.byteLength(JSON.stringify(job))>64*1024)throw new Error('job too large');
 // Locators cannot be masked into a different real path. Refuse sensitive paths.
 if(maskEvidence(job.workspacePath)!==job.workspacePath)throw new Error('sensitive workspace locator');
 return jobSchema.parse(maskEvidence(job));
}
export function jobKey(job:LocalJob):string {
 const identity=job.kind==='repo_snapshot'&&job.fingerprint
  ? [job.deviceId,job.workspacePath,job.kind,job.fingerprint]
  : [job.deviceId,job.sessionId,job.processNamespace,job.kind,job.nativeCallId,job.dedupeKey];
 return digest(JSON.stringify(identity));
}

/** Signal-only adapter: no tool arguments/results, subprocesses or source file reads. */
export function jobFromEntry(entry:import('../types/index.js').AgentActivityEntry,inputId:string,deviceId:string,collectorVersion:string,kind:ObservationKind='repo_snapshot'):LocalJob|null {
 try {
  const nativeId=entry['event.id'];const sessionId=entry['gen_ai.session.id'];
  const workspacePath=entry['workspace.path']??entry['workspace.current_root'];
  if(!nativeId||!sessionId||!deviceId||!workspacePath||entry['ntconsult.analytics.kind'])return null;
  const timestamp=BigInt(entry.time_unix_nano)/1000000n;
  if(timestamp<0||timestamp>BigInt(Number.MAX_SAFE_INTEGER))return null;
  const nativeCallId=entry['gen_ai.tool.call.id']??null;
  const processNamespace=typeof entry['gen_ai.data_source.id']==='string'?entry['gen_ai.data_source.id']:inputId;
  return prepareJob({id:digest(JSON.stringify([deviceId,inputId,nativeId,kind])),dedupeKey:nativeId,kind,
   sourceRefs:[{sourceNamespace:inputId,nativeId,phase:'event',...(entry.trace_id?{traceId:entry.trace_id}:{}),...(entry.span_id?{spanId:entry.span_id}:{})}],
   workspacePath,occurredAt:new Date(Number(timestamp)).toISOString(),deviceId,sessionId,nativeCallId,processNamespace,
   harnessId:entry['gen_ai.agent.type'],harnessVersion:typeof entry['gen_ai.agent.version']==='string'?entry['gen_ai.agent.version']:'unknown',
   collectorVersion,capabilitiesVersion:'1',...(entry['gen_ai.turn.id']?{turnId:entry['gen_ai.turn.id']}:{}),...(typeof entry['git.repo']==='string'&&entry['git.repo']?{repoKey:entry['git.repo']}:{}),notBefore:0,attempt:0});
 }catch{return null;}
}
