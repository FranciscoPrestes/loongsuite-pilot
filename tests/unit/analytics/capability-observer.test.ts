import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadCapabilityManifest } from '../../../src/analytics/capabilities.js';
import { observeCapabilities } from '../../../src/analytics/capability-observer.js';
import type { CapabilityStatus } from '../../../src/deployment/desired-state-reconciler.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import type { AgentDefinition } from '../../../src/types/deployment.js';

const manifest = loadCapabilityManifest(JSON.parse(readFileSync('agents.d/claude-code.json', 'utf8')) as AgentDefinition);
const now = new Date('2026-10-16T12:00:00Z');
const at = (msAgo: number) => String((now.getTime() - msAgo) * 1_000_000);
const entry = (over: Partial<AgentActivityEntry> = {}): AgentActivityEntry => ({
  time_unix_nano: at(10_000), 'event.id': 'e1', 'user.id': 'u', 'event.name': 'tool.call',
  'gen_ai.session.id': 's1', 'gen_ai.agent.type': 'claude-code', 'gen_ai.provider.name': 'anthropic', ...over,
}) as AgentActivityEntry;
const base = (over: Partial<CapabilityStatus> = {}): CapabilityStatus => ({
  harnessId: 'claude-code', state: 'configured', observedAt: now.getTime(), detected: true, repairResult: 'not_needed',
  configurationInstalled: true, ...over,
});
const one = (entries: AgentActivityEntry[], status?: CapabilityStatus) => observeCapabilities([manifest], entries, now, status ? [status] : [])[0]!;

describe('capability observer (D4)', () => {
  it('healthy_process_without_events_is_partial', () => {
    const status = one([], base({ processAlive: true }));
    expect(status.state).toBe('partial');
    expect(status.reason).toBe('no_valid_event_during_activity');
    expect(status.activity).toBe('unobserved');
  });

  it('unused_harness_stays_unobserved_not_partial', () => {
    const status = one([], base({ processAlive: false }));
    expect(status.state).toBe('configured');
    expect(status.activity).toBe('unobserved');
  });

  it('disabled_is_not_no_activity', () => {
    const status = one([], base({ state: 'disabled', repairResult: 'disabled', reason: 'native_disabled' }));
    expect(status.state).toBe('disabled');
    expect(status.activity).toBe('disabled');
    expect(status.activity).not.toBe('unobserved');
  });

  it('valid_recent_event_makes_it_healthy_and_reports_received_fields', () => {
    const status = one([entry(), entry({ 'event.id': 'e2', 'event.name': 'tool.result' })], base({ processAlive: true }));
    expect(status.state).toBe('healthy');
    expect(status.activity).toBe('observed');
    expect(status.receivedFields).toEqual(['tool_call', 'tool_result']);
    expect(status.lastEventAt).toBe(now.getTime() - 10_000);
    expect(status.missingPairs).toBe(0);
  });

  it('events_older_than_the_window_do_not_prove_health', () => {
    const status = one([entry({ time_unix_nano: at(600_000) })], base({ processAlive: true }));
    expect(status.state).toBe('partial');
    expect(status.activity).toBe('observed');
  });

  it('valid_events_that_went_quiet_are_partial_even_without_a_process_probe', () => {
    // The reconciler never supplies processAlive: known activity is inferred from real events in the window.
    const status = one([entry({ time_unix_nano: at(300_000) })], base());
    expect(status.state).toBe('partial');
    expect(status.reason).toBe('no_valid_event_during_activity');
    expect(one([], base()).state).toBe('configured');
  });

  it('rejects_invalid_future_foreign_and_collector_generated_events_as_evidence', () => {
    const bad = [entry({ 'event.id': '' }), entry({ 'gen_ai.session.id': '' }), entry({ time_unix_nano: at(-600_000) }),
      entry({ 'gen_ai.agent.type': 'codex' }), entry({ 'ntconsult.analytics.kind': 'hook_health' })];
    const status = one(bad, base({ processAlive: true }));
    expect(status.lastEventAt).toBeNull();
    expect(status.state).toBe('partial');
  });

  it('counts_tool_calls_without_a_matching_result_as_missing_pairs', () => {
    const status = one([entry({ 'gen_ai.tool.call.id': 'c1' }), entry({ 'event.id': 'e2', 'gen_ai.tool.call.id': 'c2' }),
      entry({ 'event.id': 'e3', 'event.name': 'tool.result', 'gen_ai.tool.call.id': 'c1' })], base());
    expect(status.missingPairs).toBe(1);
  });

  it('never_upgrades_unsupported_or_error_states_from_events', () => {
    expect(one([entry()], base({ state: 'unsupported_version' })).state).toBe('unsupported_version');
    expect(one([entry()], base({ state: 'error', repairResult: 'failed' })).state).toBe('error');
  });
});
