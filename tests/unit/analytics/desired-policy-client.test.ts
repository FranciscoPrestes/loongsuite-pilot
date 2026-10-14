import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DesiredPolicyClient, instrumentationPolicySchema } from '../../../src/analytics/desired-policy-client.js';
const now = Date.parse('2026-10-14T12:00:00Z');
const policy = (revision = '1') => ({policyId:'policy',revision,desiredBundleVersion:'1.2.0',enabled:true,killSwitch:false,deviceId:'device',cohortId:null,reasons:[],deletionRevision:'0',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+72*3600_000).toISOString(),limits:{reconcileIntervalMs:60_000,hookTargetP95Ms:100,workerTimeoutMs:2000,maxMetadataFiles:100,maxSnippetBytes:65536,maxReportBytes:2097152}});
function response(body: unknown, status=200, etag='"1"') { return {status,ok:status===200,headers:new Headers({ETag:etag}),json:async()=>body} as Response; }
describe('DesiredPolicyClient',()=>{
 it('authenticated GET uses ETag and monotonically increasing revision', async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(null,304)).mockResolvedValueOnce(response(policy('0')));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>now});
 await client.refresh(); await client.refresh(); expect(fetcher.mock.calls[0][0]).toBe('https://portal.test/api/coletor/analytics-config');
 expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture'); expect(fetcher.mock.calls[1][1].headers['If-None-Match']).toBe('"1"');
 await client.refresh(); expect(client.getState().policy?.revision).toBe('1'); expect(client.getState().reason).toBe('invalid_policy'); });
 it('centralEnableOverLocalDisable is false and offline >72h pauses enrichment only',async()=>{let clock=now; const fetcher=vi.fn().mockResolvedValueOnce(response(policy())).mockRejectedValue(new Error('offline'));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>clock});
 await client.refresh(); const centralEnableOverLocalDisable=client.effective(false).enrichmentEnabled; expect(centralEnableOverLocalDisable).toBe(false);
 expect(client.effective(true).enrichmentEnabled).toBe(true); clock+=72*3600_000+1; await client.refresh(); expect(client.effective(true)).toMatchObject({enrichmentEnabled:false,baseTelemetryEnabled:true,reason:'policy_expired'}); });
 it('rejects foreign device, commands, expired/future policy, revision reuse and insecure transport',async()=>{expect(()=>new DesiredPolicyClient({baseUrl:'http://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture'})).toThrow('HTTPS');
 expect(instrumentationPolicySchema.safeParse({...policy(),commands:['run']}).success).toBe(false);
 const fetcher=vi.fn().mockResolvedValueOnce(response({...policy(),deviceId:'other'})).mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response({...policy(),enabled:false}));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>now});
 await client.refresh(); expect(client.effective(true).enrichmentEnabled).toBe(false); await client.refresh(); await client.refresh(); expect(client.getState().policy?.enabled).toBe(true);
 });
 it('revoked authentication and central kill switch pause immediately',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(null,401)).mockResolvedValueOnce(response({...policy('2'),killSwitch:true}));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>now}); await client.refresh();await client.refresh();expect(client.effective(true).enrichmentEnabled).toBe(false);await client.refresh();expect(client.effective(true).enrichmentEnabled).toBe(false); });
 it('replay waits for full exclusion synchronization',async()=>{const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:vi.fn().mockResolvedValue(response({...policy(),deletionRevision:'2'})),now:()=>now});
 await client.refresh();expect(client.effective(true).replayEnabled).toBe(false); client.markExclusionsSynchronized('2');expect(client.effective(true).replayEnabled).toBe(true); });
 it('orders 9 to 10 with BigInt, rejects revision rollback and oversized operational revision',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(policy('9'))).mockResolvedValueOnce(response(policy('10'))).mockResolvedValueOnce(response(policy('9'))).mockResolvedValueOnce(response(policy('1'.repeat(501))));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>now});
 await client.refresh();await client.refresh();expect(client.getState().policy?.revision).toBe('10');await client.refresh();await client.refresh();expect(client.getState().policy?.revision).toBe('10');expect(client.getState().reason).toBe('invalid_policy');
 expect(fetcher.mock.calls[0][1].redirect).toBe('error');
 });
 it('missing authentication does not send request and incompatible bundle pauses analytics',async()=>{
 const fetcher=vi.fn().mockResolvedValue(response(policy()));const noAuth=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=>'',fetch:fetcher,now:()=>now});
 await noAuth.refresh();expect(fetcher).not.toHaveBeenCalled();const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>now,bundleCompatible:()=>false});
 await client.refresh();expect(client.effective(true).reason).toBe('bundle_incompatible');
 });

 it('validates shared producer fixture, large response and future/expired policies',async()=>{
 const fixture=JSON.parse(readFileSync(new URL('../../fixtures/analytics/instrumentation-policy-v1.json',import.meta.url),'utf8'));
 expect(instrumentationPolicySchema.parse(fixture)).toEqual(fixture);
 for(const body of [{...policy(),issuedAt:new Date(now+1).toISOString()}, {...policy(),expiresAt:new Date(now-1).toISOString()}, {...policy(),reasons:['x'.repeat(65536)]}]){
  const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:vi.fn().mockResolvedValue(response(body)),now:()=>now});
  await client.refresh();expect(client.getState().policy).toBeNull();
 }
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:vi.fn().mockResolvedValue(new Response('x'.repeat(65537))),now:()=>now});
 await client.refresh();expect(client.getState().reason).toBe('invalid_policy');
 });
 it('restores last good policy on offline restart and blocks replay until sync',async()=>{
 const stored={policy:policy(),etag:'"1"',lastHealthyAt:now,portalOrigin:'https://portal.test',credentialFingerprint:createHash('sha256').update('Bearer fixture').digest('hex')};
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:vi.fn().mockRejectedValue(new Error('offline')),now:()=>now,cache:{load:async()=>stored,save:vi.fn()}});
 await client.refresh();expect(client.effective(true)).toMatchObject({enrichmentEnabled:true,replayEnabled:false,baseTelemetryEnabled:true});
 });
 it('authorization revocation remains blocked while disconnected',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(response(policy())).mockResolvedValueOnce(response(null,401)).mockRejectedValue(new Error('offline'));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',deviceId:'device',authorization:()=> 'Bearer fixture',fetch:fetcher,now:()=>now});
 await client.refresh();await client.refresh();await client.refresh();expect(client.effective(true).reason).toBe('unauthorized');
 });

 it('binds server device identity and cached state to portal and machine key without storing token',async()=>{
 let credential='Bearer fixture';let cache:any=null;const fetcher=vi.fn().mockResolvedValueOnce(response({...policy(),deviceId:'collector-key:17'})).mockRejectedValue(new Error('offline'));
 const client=new DesiredPolicyClient({baseUrl:'https://portal.test',authorization:()=>credential,fetch:fetcher,now:()=>now,cache:{load:async()=>cache,save:async state=>{cache=state;}}});
 await client.refresh();expect(client.getState().policy?.deviceId).toBe('collector-key:17');expect(JSON.stringify(cache)).not.toContain(credential);
 credential='Bearer another-key';await client.refresh();expect(client.getState().policy).toBeNull();expect(client.effective(true).enrichmentEnabled).toBe(false);
 });

});
