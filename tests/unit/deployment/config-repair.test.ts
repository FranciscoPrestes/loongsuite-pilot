import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';import * as os from 'node:os';import * as path from 'node:path';
import { updateJsonConfig } from '../../../src/deployment/config-repair.js';
import { PluginInjectStrategy } from '../../../src/deployment/plugin-inject-strategy.js';
import type { AgentDefinition } from '../../../src/types/index.js';
let tmp:string;beforeEach(async()=>{tmp=await fs.mkdtemp(path.join(os.tmpdir(),'c2-config-'));});afterEach(async()=>{await fs.rm(tmp,{recursive:true,force:true});});
describe('owned configuration repair',()=>{
 it('refuses invalid bytes and malformed hook paths without creating backup',async()=>{const file=path.join(tmp,'settings.json');const raw='{bad bytes';await fs.writeFile(file,raw);
 await expect(updateJsonConfig(file,v=>({...v,env:{x:'y'}}))).rejects.toThrow('invalid');expect(await fs.readFile(file,'utf8')).toBe(raw); });
 it('retains JSONC comments and user plugin marker lookalikes over ten cycles',async()=>{const file=path.join(tmp,'settings.jsonc');const user='file:///user/loongsuite-pilot-opencode-user/plugin.mjs';
 await fs.writeFile(file,'{// user comment\n"plugin":['+JSON.stringify(user)+'],"custom":true}');
 const def:AgentDefinition={id:'fixture',displayName:'fixture',deployMode:'plugin-inject',detection:{paths:[],commands:[]},pluginInject:{configPaths:[file],pluginSpec:'file://'+tmp+'/owned.mjs',pluginId:'loongsuite-pilot-opencode'}};
 const strategy=new PluginInjectStrategy(tmp,tmp);for(let i=0;i<10;i++)expect((await strategy.deploy(def)).success).toBe(true);
 const raw=await fs.readFile(file,'utf8');expect(raw).toContain('// user comment');expect(raw).toContain(user);expect(raw.match(/owned.mjs/g)).toHaveLength(1);
 expect((await fs.readFile(file+'.bak','utf8'))).toContain(user);
 expect(await strategy.undeploy(def)).toBe(true);expect(await fs.readFile(file,'utf8')).toContain(user);
 });
});
