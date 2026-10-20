import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadCapabilityManifest, listCapabilities } from '../../../src/analytics/capabilities.js';
import { createInputAdapter, createInputAdapters, getInputAdapterInventory, getCollectionProducerInventory } from '../../../src/inputs/input-adapter-registry.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import { AgentDefLoader } from '../../../src/deployment/agent-def-loader.js';

const definitions = readdirSync('agents.d').filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(join('agents.d', name), 'utf8')) as AgentDefinition);
const find = (id: string) => definitions.find(def => def.id === id)!;

describe('governed harness capabilities', () => {
  it('all_manifests_resolve_adapters', () => {
    const registered = new Set(getInputAdapterInventory().map(adapter => adapter.id));
    const unmappedInputs = listCapabilities(definitions).flatMap(manifest =>
      manifest.adapters.filter(adapter => !registered.has(adapter.id)).map(adapter => adapter.id));
    expect(unmappedInputs).toEqual([]);
    expect(listCapabilities(definitions).map(manifest => manifest.harnessId)).toContain('wukong');
  });

  it('additional_input_requires_manifest', () => {
    const concretePaths = readdirSync('src/inputs', { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== 'base')
      .flatMap(entry => readdirSync(join('src/inputs', entry.name)).filter(name => name.endsWith('.ts'))
        .map(name => join('src/inputs', entry.name, name)))
      .filter(file => /export class \w+ extends (?:Base\w*Input)/.test(readFileSync(file, 'utf8')));
    const inventory = getInputAdapterInventory();
    const declared = new Set(listCapabilities(definitions).flatMap(manifest => manifest.adapters.map(adapter => adapter.id)));
    const unmappedInputs = concretePaths.filter(file => !inventory.some(adapter => adapter.sourcePath === file && declared.has(adapter.id)));
    expect(unmappedInputs).toEqual([]);
    expect(() => loadCapabilityManifest({ ...find('codex'), analytics: undefined, id: 'new-input' })).toThrow();
    expect(() => loadCapabilityManifest({ ...find('codex'), analytics: { ...find('codex').analytics!, adapters: [{ id: 'undeclared', role: 'primary' }] } })).toThrow();
  });

  it('declares retired Codex hooks without retiring its active transcript', () => {
    const manifest = loadCapabilityManifest(find('codex'));
    expect(manifest.lifecycle).toBe('supported');
    expect(manifest.adapters.find(adapter => adapter.id === 'codex-transcript')?.role).toBe('primary');
    expect(manifest.adapters.find(adapter => adapter.id === 'codex-log')?.role).toBe('retired');
    expect(manifest.retiredHookEvents).toEqual(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
    expect(manifest).not.toHaveProperty('active');
  });

  it('discovers an additional PI SDK harness through definitions without a UI catalogue edit', () => {
    const extra: AgentDefinition = { id: 'fixture-agent', displayName: 'Fixture Agent', deployMode: 'plugin-inject',
      detection: { paths: ['/fixture'], commands: [] }, piSdk: { schemaVersion: 1, agentDir: '/fixture' },
      input: { type: 'pi-sdk-jsonl' } };
    const result = listCapabilities([...definitions, extra]);
    expect(result.find(manifest => manifest.harnessId === 'fixture-agent')?.adapters).toEqual([{ id: 'pi-coding-agent-log', role: 'shared' }]);
    expect(result.find(manifest => manifest.harnessId === 'fixture-agent')?.gaps).toContain('Live execution validation pending');
  });

  it('selects the merger or its fallbacks without activating retired inputs', () => {
    const stateStore = new StateStore('/unused-fixture-state.json');
    const deps = { stateStore, dataDir: '/fixture/pilot', homeDir: '/fixture/home' };
    expect(createInputAdapters(find('qoder-work-cn'), deps).map(input => input.id)).toEqual(['qoder-work-cn-trace']);
    expect(createInputAdapters(find('qoder-work-cn'), { ...deps, isEnabled: (id: string) => id !== 'qoder-work-cn-trace' }).map(input => input.id))
      .toEqual(['qoder-work-cn-hook', 'qoder-work-cn-log', 'qoder-work-cn-sqlite']);
    expect(createInputAdapters(find('codex'), deps).map(input => input.id)).toEqual(['codex-transcript']);
    expect(createInputAdapters(find('cursor-cli'), deps)).toEqual([]);
  });

  it('rejects an invalid declared catalogue at the loader boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-manifests-'));
    try {
      await mkdir(join(dir, 'builtin'));
      await mkdir(join(dir, 'local'));
      const invalid = { ...find('codex'), analytics: { ...find('codex').analytics, adapters: [{ id: 'rogue', role: 'primary' }] } };
      await writeFile(join(dir, 'builtin', 'codex.json'), JSON.stringify(invalid));
      const loader = new AgentDefLoader({ builtinDir: join(dir, 'builtin'), localDir: join(dir, 'local'), pilotDir: dir, dataDir: dir });
      expect(await loader.load()).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('creates the physical adapter IDs declared by each manifest', () => {
    const deps = { stateStore: new StateStore('/unused-fixture-state.json'), dataDir: '/fixture/pilot', homeDir: '/fixture/home', platform: 'darwin' as const };
    for (const definition of definitions) {
      const manifest = loadCapabilityManifest(definition);
      const expected = manifest.adapters.filter(adapter => adapter.role === 'primary' || adapter.role === 'supplement').map(adapter => adapter.id);
      expect(createInputAdapters(definition, deps).map(input => input.id)).toEqual(expected);
    }
  });

  it('constructs the CN variant from its adapter identity rather than the class default', () => {
    const stateStore = new StateStore('/unused-fixture-state.json');
    expect(createInputAdapter('qoder-work-cn-hook', { stateStore }).id).toBe('qoder-work-cn-hook');
    expect(createInputAdapter('qoder-work-cn-log', { stateStore }).id).toBe('qoder-work-cn-log');
    expect(createInputAdapter('qoder-work-cn-sqlite', { stateStore }).id).toBe('qoder-work-cn-sqlite');
  });

  it('requires fallbacks to name a primary adapter rather than a retired source', () => {
    const codex = find('codex');
    expect(() => loadCapabilityManifest({ ...codex, analytics: { ...codex.analytics!, adapters: [
      { id: 'codex-transcript', role: 'fallback', whenPrimaryDisabled: 'codex-log' },
      { id: 'codex-log', role: 'retired' },
    ] } })).toThrow();
  });

  it('keeps independent remote pipeline outside governed harness collection', () => {
    expect(getCollectionProducerInventory().find(producer => producer.id === 'qoder-api-pipeline')?.disposition).toBe('excluded');
    expect(getCollectionProducerInventory().find(producer => producer.id === 'interceptor')?.disposition).toBe('local-supplement');
  });

  it('records primary source by event class and conservative capability gaps', () => {
    for (const manifest of listCapabilities(definitions)) {
      expect(manifest.sourceRules.length).toBeGreaterThan(0);
      expect(manifest.gaps.length).toBeGreaterThan(0);
      expect(manifest.capabilities.tools).not.toBe('validated');
    }
    const copilot = loadCapabilityManifest(find('copilot'));
    expect(copilot.sourceRules.find(rule => rule.eventClass === 'llm_usage')?.primary).toContain('copilot.session_usage');
    expect(loadCapabilityManifest(find('wukong')).mechanisms).toContain('local-cli-daemon');
  });

  it('declares managed hook JSONL as merger activity authority', () => {
    for (const id of ['qoder', 'qoder-cn', 'qwen-work-cn']) {
      const rules = loadCapabilityManifest(find(id)).sourceRules;
      for (const eventClass of ['message', 'tool_call', 'tool_result']) {
        expect(rules.find(rule => rule.eventClass === eventClass)?.primary).toBe(`${id}.managed-hook-jsonl`);
      }
    }
  });

  it('declares distinct CLI intercept and IDE SQLite token authority', () => {
    for (const id of ['qoder', 'qoder-cn']) {
      const rule = loadCapabilityManifest(find(id)).sourceRules.find(source => source.eventClass === 'llm_usage');
      expect(rule?.variantPrimaries?.find(source => source.variant === 'cli')?.primary).toBe(`${id}.cli-token-intercept`);
      expect(rule?.variantPrimaries?.find(source => source.variant === 'ide')?.primary).toBe(`${id}.ide-sqlite`);
    }
  });
});
