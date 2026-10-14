import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRuntimePolicyClient } from '../../../src/analytics/instrumentation-runtime.js';
import { buildInstrumentationConfig } from '../../../src/core/config-loader.js';
import type { AnalyticsConfig } from '../../../src/types/index.js';
afterEach(()=>vi.unstubAllGlobals());
const config = (origin='https://portal.test', endpoint='https://portal.test/api/ingest/otlp/v1/traces') => ({
 instrumentation:{localEnabled:true,portalBaseUrl:origin,deviceId:'device'},otlpTrace:{endpoint,headers:{Authorization:'Bearer fixture'}}
}) as AnalyticsConfig;
describe('configured collector policy runtime',()=>{
 it('constructs real client from explicit origin and only reuses matching-origin machine auth',async()=>{const fetcher=vi.fn().mockResolvedValue({status:401});vi.stubGlobal('fetch',fetcher);
 const client=createRuntimePolicyClient(config(),'1.2.0');expect(client).toBeDefined();await client!.refresh();
 expect(fetcher.mock.calls[0][0]).toBe('https://portal.test/api/coletor/analytics-config');expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer fixture');
 expect(createRuntimePolicyClient(config('https://other.test'),'1.2.0')).toBeUndefined(); });
 it('does not derive portal URL and rejects credential-bearing or non-TLS URLs',()=>{
 expect(createRuntimePolicyClient({otlpTrace:config().otlpTrace} as AnalyticsConfig,'1.2.0')).toBeUndefined();
 for(const portalBaseUrl of ['http://portal.test','https://user:pass@portal.test','https://portal.test/path','https://portal.test?x=1'])
 expect(buildInstrumentationConfig({instrumentation:{localEnabled:true,portalBaseUrl,deviceId:'device'}})).toBeUndefined(); });
 it('respects local disable and explicit auth without modifying unrelated pipeline config',()=>{const original=config();original.instrumentation!.localEnabled=false;original.instrumentation!.authorization='Bearer explicit';
 const snapshot=structuredClone(original);const client=createRuntimePolicyClient(original,'1.2.0');expect(client?.effective(false).enrichmentEnabled).toBe(false);expect(original).toEqual(snapshot); });
});
