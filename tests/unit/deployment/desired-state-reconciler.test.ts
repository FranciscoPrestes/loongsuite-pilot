import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesiredStateReconciler } from '../../../src/deployment/desired-state-reconciler.js';
import { DeploymentManager } from '../../../src/deployment/deployment-manager.js';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import * as io from '../../../src/utils/fs-utils.js';
import type { AgentDefinition } from '../../../src/types/index.js';
vi.mock('../../../src/deployment/detect-utils.js', () => ({ detectAgent: vi.fn(async () => true) }));
vi.mock('../../../src/utils/logger.js', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
let tmp: string;
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'c2-')); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await fs.rm(tmp, { recursive: true, force: true }); });
function definition(nested = false): AgentDefinition { return { id: 'fixture', displayName: 'Fixture', deployMode: 'hook',
  detection: { paths: [], commands: ['fixture-cli'] }, hook: { settingsPath: path.join(tmp, 'settings.json'),
  events: ['Stop'], hookCommand: path.join(tmp, 'owned-hook.sh'), format: nested ? 'nested' : 'flat' } }; }
function runtime(def = definition(), enabled = () => true) { const deployment = new DeploymentManager({ dataDir: path.join(tmp, 'data'), pilotDir: tmp });
 return { deployment, reconciler: new DesiredStateReconciler({ definitions: [def], deployment, intervalMs: 60_000, now: Date.now, agentEnabled: enabled }) }; }
describe('DesiredStateReconciler', () => {
 it('command_only_discovery_after_start', async () => { vi.useFakeTimers(); const {deployment, reconciler} = runtime();
  const detection = vi.spyOn(deployment, 'isAgentDetected').mockResolvedValue(false);
  await reconciler.start(); detection.mockResolvedValue(true); await vi.advanceTimersByTimeAsync(60_000); await reconciler.reconcile('timer');
  expect(reconciler.nextTickMs).toBe(60_000); expect(reconciler.getStatuses()[0].state).toBe('configured');
  await reconciler.stop(); });
 it.each([false, true])('repair_preserves_user_hook nested=%s and ten cycles are idempotent', async nested => {
  const def = definition(nested); const userHookBefore = { command: '/user/keep.sh', type: 'command', matcher: 'user' };
  await fs.writeFile(def.hook!.settingsPath, JSON.stringify({ custom: { keep: 7 }, hooks: { Stop: [userHookBefore] } }));
  const {reconciler} = runtime(def); for (let i = 0; i < 10; i++) await reconciler.reconcile('timer');
  const result = JSON.parse(await fs.readFile(def.hook!.settingsPath, 'utf8'));
  const userHookAfter = result.hooks.Stop.find((v: any) => v.command === userHookBefore.command);
  const ownedHooks = result.hooks.Stop.filter((v: any) => v.command === def.hook!.hookCommand || v.hooks?.some((h: any) => h.command === def.hook!.hookCommand));
  expect(userHookAfter).toEqual(userHookBefore); expect(ownedHooks).toHaveLength(1); expect(result.custom).toEqual({keep: 7});
  expect(await fs.readFile(def.hook!.settingsPath + '.loongsuite-pilot.bak', 'utf8')).toContain('/user/keep.sh');
  result.hooks.Stop = [userHookBefore]; await fs.writeFile(def.hook!.settingsPath, JSON.stringify(result));
  expect((await reconciler.reconcile('discovery'))[0].repairResult).toBe('repaired');
 });
 it('concurrent_write_retries', async () => { const def = definition(); await fs.writeFile(def.hook!.settingsPath, '{"hooks":{"Stop":[]}}');
  const original = io.writeTextFileAtomic; let attempts = 0;
  vi.spyOn(io, 'writeTextFileAtomic').mockImplementation(async (...args) => { if (args[0] === def.hook!.settingsPath && attempts++ === 0) {
    await fs.writeFile(args[0], '{"hooks":{"Stop":[{"command":"/user/concurrent.sh"}]}}'); throw new Error('file changed before write'); }
    return original(...args); });
  expect((await runtime(def).reconciler.reconcile('timer'))[0].state).toBe('configured');
  expect(await fs.readFile(def.hook!.settingsPath, 'utf8')).toContain('/user/concurrent.sh'); expect(attempts).toBe(2);
 });
 it('disabled_not_reinstalled', async () => { const {deployment, reconciler} = runtime(definition(), () => false);
  const deploy = vi.spyOn(deployment, 'deploySingle'); expect((await reconciler.reconcile('timer'))[0].state).toBe('disabled'); expect(deploy).not.toHaveBeenCalled(); });
 it('invalid_json_untouched', async () => { const def = definition(); const invalidBytesBefore = Buffer.from('{ invalid \x00 bytes');
  await fs.writeFile(def.hook!.settingsPath, invalidBytesBefore); expect((await runtime(def).reconciler.reconcile('timer'))[0].state).toBe('error');
  const invalidBytesAfter = await fs.readFile(def.hook!.settingsPath); expect(invalidBytesAfter).toEqual(invalidBytesBefore); });
 it('jsonc comments and Windows commands with spaces survive repair', async () => { const manager = new HookManager(path.join(tmp,'hooks'),path.join(tmp,'logs'));
  const settingsPath = path.join(tmp,'settings.jsonc'); const command = 'powershell.exe -File "C:\\User Space\\pilot\\hook.ps1"';
  await fs.writeFile(settingsPath, '{// user comment\n "hooks":{"Stop":[{"command":"keep"}]},"custom":true}');
  const def = { agentId:'fixture', settingsPath, settingsSyntax:'jsonc' as const, hookJsonPath:['hooks','Stop'], hookCommand:command };
  for(let i=0;i<10;i++) expect(await manager.installHook(def)).toBe(true);
  const raw = await fs.readFile(settingsPath,'utf8'); expect(raw).toContain('// user comment'); expect(await manager.isHookInstalled(def)).toBe(true);
 });
 it('coalesces concurrent cycles and never claims healthy from configuration', async () => { const {deployment,reconciler} = runtime();
  const deploy = vi.spyOn(deployment, 'deploySingle'); const cycles = await Promise.all([reconciler.reconcile('startup'),reconciler.reconcile('discovery'),reconciler.reconcile('timer')]);
  expect(deploy).toHaveBeenCalledTimes(1); expect(cycles.every(v => v[0].state === 'configured')).toBe(true); });
 it('unsupported_version never deploys', async () => { const {deployment} = runtime(); const deploy = vi.spyOn(deployment,'deploySingle');
  const reconciler = new DesiredStateReconciler({definitions:[definition()],deployment,intervalMs:60_000,now:Date.now, compatible:async()=>false});
  expect((await reconciler.reconcile('timer'))[0].state).toBe('unsupported_version'); expect(deploy).not.toHaveBeenCalled(); });
 it('native explicit disable is preserved without deploying',async()=>{
  const file=path.join(tmp,'openclaw.jsonc');await fs.writeFile(file,'{// retained\n"plugins":{"entries":{"owned":{"enabled":false}}}}');
  const def:AgentDefinition={id:'fixture',displayName:'fixture',deployMode:'plugin-inject',detection:{paths:[],commands:[]},pluginInject:{configPaths:[file],pluginSpec:'file://'+tmp+'/owned.mjs',pluginId:'owned',configShape:'openclaw-nested'}};
  const {deployment,reconciler}=runtime(def);const deploy=vi.spyOn(deployment,'deploySingle');const before=await fs.readFile(file);
  expect((await reconciler.reconcile('timer'))[0].state).toBe('disabled');expect(deploy).not.toHaveBeenCalled();expect(await fs.readFile(file)).toEqual(before);
 });

});
