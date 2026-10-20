import '../../helpers/mask-all.js';
import {describe,it,expect} from 'vitest';
import {buildEnrichmentConfig} from '../../../src/core/config-loader.js';
import {jobFromEntry,prepareJob} from '../../../src/enrichment/job-contract.js';
import type {AgentActivityEntry} from '../../../src/types/index.js';
import {job} from './fixtures.js';
describe('enrichment runtime boundaries',()=>{
 it('caps configured limits and uses required defaults',()=>{expect(buildEnrichmentConfig(null)).toEqual({timeoutMs:2000,maxAgeDays:7,maxSpoolBytes:268435456});expect(buildEnrichmentConfig({enrichment:{timeoutMs:9999,maxAgeDays:100,maxSpoolBytes:-1}})).toEqual({timeoutMs:2000,maxAgeDays:7,maxSpoolBytes:268435456});});
 it('uses native entry correlation and never fabricates a missing session or source event',()=>{const entry={'event.id':'native-event','time_unix_nano':'1791972000000000000','gen_ai.session.id':'session','gen_ai.agent.type':'claude-code','workspace.path':'/tmp/repo','gen_ai.tool.call.id':'call'} as AgentActivityEntry;const job=jobFromEntry(entry,'claude-code-log','device','1');expect(job).toMatchObject({nativeCallId:'call',sessionId:'session',occurredAt:'2026-10-14T10:00:00.000Z',sourceRefs:[{nativeId:'native-event',sourceNamespace:'claude-code-log',phase:'event'}]});expect(jobFromEntry({...entry,'event.id':''},'input','device','1')).toBeNull();expect(jobFromEntry({...entry,'gen_ai.session.id':''},'input','device','1')).toBeNull();});
 it('keeps literal unknown versions, native turn and process namespaces without fabrication',()=>{
  const entry={'event.id':'native-event','time_unix_nano':'1791972000000000000','gen_ai.session.id':'session','gen_ai.agent.type':'claude-code','workspace.path':'/tmp/repo'} as AgentActivityEntry;
  const unknown=jobFromEntry(entry,'input','device','1');
  expect(unknown).toMatchObject({harnessVersion:'unknown',processNamespace:'input'});
  expect(unknown!.turnId).toBeUndefined();
  expect(jobFromEntry({...entry,'gen_ai.turn.id':'turn-1','gen_ai.data_source.id':'ds-1'},'input','device','1')).toMatchObject({harnessVersion:'unknown',turnId:'turn-1',processNamespace:'ds-1'});
  expect(jobFromEntry({...entry,'workspace.path':undefined,'workspace.current_root':'/tmp/repo'},'input','device','1')).toMatchObject({workspacePath:'/tmp/repo'});
  expect(jobFromEntry({...entry,'workspace.path':undefined},'input','device','1')).toBeNull();
  expect(jobFromEntry({...entry,'time_unix_nano':'-1000000000000'},'input','device','1')).toBeNull();});
 it('rejects oversized jobs and sensitive workspace locators before persistence',()=>{
  const big={...job(),sourceRefs:Array.from({length:100},()=>({sourceNamespace:'x'.repeat(500),nativeId:'y'.repeat(500),phase:'event' as const}))};
  expect(()=>prepareJob(big)).toThrow('too large');
  expect(()=>prepareJob(job({workspacePath:'/tmp/api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890'}))).toThrow('sensitive');
  expect(()=>prepareJob({...job(),command:'rm -rf /'})).toThrow();});
});
