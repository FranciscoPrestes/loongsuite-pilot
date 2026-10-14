import type {LocalJob} from '../../../src/enrichment/job-contract.js';
import type {Observation} from '../../../src/analytics/observation.js';
export function job(overrides: Partial<LocalJob> = {}): LocalJob {
  return { id: 'job-1', dedupeKey: 'native-1', kind: 'repo_snapshot', sourceRefs: [{sourceNamespace:'claude:hook',nativeId:'event-1',phase:'event'}], workspacePath:'/tmp/example', occurredAt:'2026-10-14T10:00:00Z', deviceId:'device-1',sessionId:'session-1',nativeCallId:null,processNamespace:'claude:process-1',harnessId:'claude-code',harnessVersion:'1',collectorVersion:'1',capabilitiesVersion:'1',notBefore:0,attempt:0,...overrides };
}
export function observation(j: LocalJob): Observation { return {schemaVersion:'1',observationId:j.id,kind:'repo_snapshot',harnessId:j.harnessId,harnessVersion:j.harnessVersion,collectorVersion:j.collectorVersion,deviceId:j.deviceId,sessionId:j.sessionId,capabilitiesVersion:j.capabilitiesVersion,occurredAt:j.occurredAt,sourceRefs:j.sourceRefs,missingFields:[],truncated:false,payload:{head:null,branch:null,worktreeId:'wt',dirtyFingerprint:'fp',files:[],truncated:false}}; }

export async function observationsFor(dir:string,id:string):Promise<Observation[]> { const fs=await import('node:fs/promises');const path=await import('node:path');const files=await fs.readdir(path.join(dir,'enrichment'));const records=await Promise.all(files.filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(async f=>JSON.parse(await fs.readFile(path.join(dir,'enrichment',f),'utf8'))));return records.filter(r=>r.job.id===id&&r.result).map(r=>r.result);}
