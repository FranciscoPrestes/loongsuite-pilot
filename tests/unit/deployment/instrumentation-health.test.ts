import { describe, expect, it } from 'vitest';
import { InstrumentationHealth, probeInstalledCompatibility, inspectInstalledVersion } from '../../../src/deployment/instrumentation-health.js';
import type { AgentDefinition } from '../../../src/types/deployment.js';
const def = { id: 'claude-code', displayName: 'Claude', deployMode: 'hook', detection: { paths: [], commands: ['untrusted; command'] }, analytics: { versionRange: '>=2.0.0 <3.0.0' } } as AgentDefinition;
describe('instrumentation health', () => {
  it('probes allowlisted installed binary instead of trusting manifest commands', async () => {
    const runner = async (command: string, args: string[]) => {
      expect(command).toBe('claude'); expect(args).toEqual(['--version']);
      return '2.1.0 (Claude Code)';
    };
    expect(await probeInstalledCompatibility(def, runner)).toBe(true);
    expect(await probeInstalledCompatibility(def, async () => '1.9.0')).toBe(false);
    expect(await probeInstalledCompatibility(def, async () => { throw Error('missing'); })).toBe(false);
    expect(await probeInstalledCompatibility({ ...def, id: 'unknown' }, runner)).toBe(false);
  });
  it('installation and process alive never imply event health', async () => {
    let event: number | null = null; let enabled = true;
    const health = new InstrumentationHealth({ now: () => 10000, detected: async () => true, configured: async () => true, enabled: async () => enabled, compatible: async () => true, processAlive: async () => true, configuredAt: () => 1000, lastEventAt: () => event });
    expect((await health.inspect(def)).state).toBe('configured');
    event = 500; expect((await health.inspect(def)).state).toBe('configured');
    event = 9000; expect((await health.inspect(def)).state).toBe('healthy');
    enabled = false; expect((await health.inspect(def)).state).toBe('disabled');
  });
  it('unknown versions and absent config cannot become healthy', async () => {
    const health = new InstrumentationHealth({ detected: async () => true, configured: async () => false, compatible: async () => false });
    expect((await health.inspect(def)).state).toBe('unsupported_version');
  });
  it('reports unknown version separately from a known incompatible version', async () => {
    expect(await inspectInstalledVersion(def, async () => 'not available')).toEqual({ compatible: false, installedVersion: null, reason: 'installed_version_unknown' });
    expect(await inspectInstalledVersion(def, async () => '1.9.0')).toEqual({ compatible: false, installedVersion: '1.9.0', reason: 'version_incompatible' });
    expect(await inspectInstalledVersion({ ...def, analytics: { ...def.analytics!, versionRange: null } })).toEqual({ compatible: true, installedVersion: null, reason: 'version_range_unspecified' });
  });

});
