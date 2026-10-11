import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM shared with the Tauri webview
import { buildSnapshot, formatTokens, runtimeStatus } from '../../../app/tray/ui/snapshot.mjs';

const summary = {
  version: 1,
  ranges: {
    today: {
      totalTokens: 1500, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200,
      totalSessions: 3, totalRequests: 10, totalToolCalls: 4, totalEvents: 20,
      agentShares: [{ agentType: 'opencode', sessions: 2, events: 12, tokens: 900, share: 0.6 }],
      providerShares: [{ provider: 'openrouter', totalTokens: 900, share: 1.4 }],
      modelShares: [{ model: 'deepseek-v4', totalTokens: 900, share: 0.6 }],
      repoShares: [{ repo: 'hub-ia', sessions: 2, events: 12 }],
    },
    sevenDays: { totalTokens: 9000 },
  },
  dailyTokens: Array.from({ length: 10 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, value: i })),
  dailySessions: [{ day: '2026-10-09', value: 3 }],
};

describe('buildSnapshot', () => {
  it('maps the selected range into a flat snapshot', () => {
    const s = buildSnapshot(summary, 'today');
    expect(s.totalTokens).toBe(1500);
    expect(s.agents[0]).toEqual({ agentType: 'opencode', sessions: 2, events: 12, tokens: 900, share: 0.6 });
    expect(s.repos[0].repo).toBe('hub-ia');
    expect(s.error).toBeNull();
  });

  it('clamps shares to 0..1', () => {
    expect(buildSnapshot(summary, 'today').providers[0].share).toBe(1);
  });

  it('keeps only the last 7 trend points for today and sevenDays, 30 for thirtyDays', () => {
    expect(buildSnapshot(summary, 'today').dailyTokens).toHaveLength(7);
    expect(buildSnapshot(summary, 'thirtyDays').dailyTokens).toHaveLength(10);
  });

  it('defaults missing fields to zero and unknown names', () => {
    const s = buildSnapshot({ ranges: { today: { agentShares: [{}] } } }, 'today');
    expect(s.totalTokens).toBe(0);
    expect(s.agents[0].agentType).toBe('unknown');
  });

  it('reports an error when the summary file is missing', () => {
    const s = buildSnapshot(null, 'today');
    expect(s.error).toMatch(/metrics-summary\.json/);
    expect(s.totalTokens).toBe(0);
  });
});

describe('formatTokens', () => {
  it.each([[0, '0'], [999, '999'], [1500, '1.5K'], [2_500_000, '2.5M'], [1_639_604_793, '1.64B']])(
    '%s -> %s', (n, out) => expect(formatTokens(n)).toBe(out),
  );
});

describe('runtimeStatus', () => {
  it('is active only when the daemon says active', () => {
    expect(runtimeStatus({ status: 'active', packageVersion: '1.2.0' })).toEqual({ active: true, version: 'v1.2.0' });
    expect(runtimeStatus({ status: 'stopped' }).active).toBe(false);
    expect(runtimeStatus(null)).toEqual({ active: false, version: 'v--' });
  });
});
