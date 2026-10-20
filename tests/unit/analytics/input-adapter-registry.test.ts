import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInputAdapters } from '../../../src/inputs/input-adapter-registry.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import type { AgentDefinition } from '../../../src/types/deployment.js';
import type { AgentActivityEntry } from '../../../src/types/events.js';

const definition = (id: string): AgentDefinition => JSON.parse(readFileSync(`agents.d/${id}.json`, 'utf8'));
const dependencies = () => ({ stateStore: new StateStore('/fixture/unused-state.json'), dataDir: '/fixture/pilot', homeDir: '/fixture/home' });

describe('input adapter factory policy and native roots', () => {
  it('does not construct an ordinary harness denied by its supplied admission policy', () => {
    expect(createInputAdapters(definition('codex'), { ...dependencies(), agentEnabled: () => false })).toEqual([]);
  });

  it.each(['win32', 'linux'] as const)('does not construct Darwin-only Wukong on %s', platform => {
    expect(createInputAdapters(definition('wukong'), { ...dependencies(), platform })).toEqual([]);
  });

  it('constructs an admitted harness on its declared platform', () => {
    expect(createInputAdapters(definition('wukong'), { ...dependencies(), platform: 'darwin', agentEnabled: id => id === 'wukong' })
      .map(input => input.id)).toEqual(['wukong']);
  });

  it('keeps PI native-record admission after admitting the shared physical input', async () => {
    const sdk: AgentDefinition = { id: 'allowed-sdk', displayName: 'Allowed SDK', deployMode: 'plugin-inject',
      detection: { paths: ['/fixture/sdk'], commands: [] }, piSdk: { schemaVersion: 1, agentDir: '/fixture/sdk' } };
    const [input] = createInputAdapters(sdk, { ...dependencies(), platform: 'linux', agentEnabled: id => id === 'allowed-sdk' });
    const transform = input as unknown as { transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry | null> };
    const record = { 'event.name': 'tool.call', 'gen_ai.session.id': 'session-1', 'gen_ai.tool.name': 'read' };
    expect((await transform.transformRecord({ ...record, 'gen_ai.agent.type': 'allowed-sdk' }))?.['gen_ai.agent.type']).toBe('allowed-sdk');
    expect(await transform.transformRecord({ ...record, 'gen_ai.agent.type': 'denied-sdk' })).toBeNull();
  });

  it.each([
    { id: 'qoder-work', platform: 'win32', env: { APPDATA: '/fixture/custom-roaming' }, root: '/fixture/custom-roaming/QoderWork' },
    { id: 'qoder-work-cn', platform: 'win32', env: { APPDATA: '/fixture/custom-roaming' }, root: '/fixture/custom-roaming/QoderWork CN' },
    { id: 'qoder-work-cn', platform: 'win32', env: {}, root: '/fixture/home/AppData/Roaming/QoderWork CN' },
    { id: 'qoder-work', platform: 'linux', env: { XDG_CONFIG_HOME: '/fixture/custom-xdg' }, root: '/fixture/custom-xdg/QoderWork' },
    { id: 'qoder-work-cn', platform: 'linux', env: { XDG_CONFIG_HOME: '/fixture/custom-xdg' }, root: '/fixture/custom-xdg/QoderWork CN' },
    { id: 'qoder-work-cn', platform: 'linux', env: {}, root: '/fixture/home/.config/QoderWork CN' },
  ] as const)('reads $id $platform SDK and SQLite sources from $root', ({ id, platform, env, root }) => {
    const inputs = createInputAdapters(definition(id), { ...dependencies(), platform, env, isEnabled: adapter => !adapter.endsWith('-trace') });
    const log = inputs.find(input => input.id === `${id}-log`) as unknown as { sessionDir: string };
    const sqlite = inputs.find(input => input.id === `${id}-sqlite`) as unknown as { dbPath: string };
    expect(log.sessionDir).toBe(join(root, 'logs'));
    expect(sqlite.dbPath).toBe(join(root, 'data', 'agents.db'));
  });

  it('preserves explicit constructor source roots over platform defaults', () => {
    const inputs = createInputAdapters(definition('qoder-work-cn'), { ...dependencies(), platform: 'win32', env: {},
      isEnabled: id => !id.endsWith('-trace'), options: {
        'qoder-work-cn-log': { dataRoot: '/fixture/explicit-sdk' },
        'qoder-work-cn-sqlite': { dbPath: '/fixture/explicit-db.sqlite' },
      } });
    expect((inputs.find(input => input.id === 'qoder-work-cn-log') as unknown as { sessionDir: string }).sessionDir).toBe(join('/fixture/explicit-sdk', 'logs'));
    expect((inputs.find(input => input.id === 'qoder-work-cn-sqlite') as unknown as { dbPath: string }).dbPath).toBe('/fixture/explicit-db.sqlite');
  });
});
