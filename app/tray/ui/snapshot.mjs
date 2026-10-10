// Pure data layer for the tray panel: turns the Pilot's metrics-summary.json and
// runtime.json into the flat shape the UI renders. No DOM access here.

export const RANGES = ['today', 'sevenDays', 'thirtyDays'];

const MISSING_SUMMARY_MESSAGE =
  'metrics-summary.json nao encontrado. Inicie o daemon do loongsuite-pilot.';

const clamp01 = (raw) => Math.min(1, Math.max(0, Number(raw) || 0));
const num = (raw) => Number(raw) || 0;

function trendDays(range) {
  return range === 'thirtyDays' ? 30 : 7;
}

function dailyPoints(points, lastN) {
  const valid = (points ?? []).filter((p) => typeof p?.day === 'string' && p.day);
  const mapped = valid.map((p) => ({ day: p.day, value: num(p.value) }));
  return mapped.length > lastN ? mapped.slice(mapped.length - lastN) : mapped;
}

export function buildSnapshot(summary, range) {
  const empty = {
    range,
    totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    totalEvents: 0, totalSessions: 0, totalRequests: 0, totalToolCalls: 0,
    dailyTokens: [], dailySessions: [], agents: [], providers: [], models: [], repos: [],
    error: null,
  };
  if (!summary) return { ...empty, error: MISSING_SUMMARY_MESSAGE };

  const rd = summary.ranges?.[range] ?? {};
  const days = trendDays(range);
  return {
    ...empty,
    totalTokens: num(rd.totalTokens),
    inputTokens: num(rd.inputTokens),
    outputTokens: num(rd.outputTokens),
    cacheReadTokens: num(rd.cacheReadTokens),
    totalEvents: num(rd.totalEvents),
    totalSessions: num(rd.totalSessions),
    totalRequests: num(rd.totalRequests),
    totalToolCalls: num(rd.totalToolCalls),
    dailyTokens: dailyPoints(summary.dailyTokens, days),
    dailySessions: dailyPoints(summary.dailySessions, days),
    agents: (rd.agentShares ?? []).map((a) => ({
      agentType: a.agentType ?? 'unknown',
      sessions: num(a.sessions), events: num(a.events), tokens: num(a.tokens), share: clamp01(a.share),
    })),
    providers: (rd.providerShares ?? []).map((p) => ({
      provider: p.provider ?? 'unknown', tokens: num(p.totalTokens), share: clamp01(p.share),
    })),
    models: (rd.modelShares ?? []).map((m) => ({
      model: m.model ?? 'unknown', tokens: num(m.totalTokens), share: clamp01(m.share),
    })),
    repos: (rd.repoShares ?? []).map((r) => ({
      repo: r.repo ?? 'unknown', sessions: num(r.sessions), events: num(r.events),
    })),
  };
}

export function formatTokens(n) {
  const v = num(n);
  const trim = (x, digits) => String(Number(x.toFixed(digits)));
  if (v >= 1e9) return `${trim(v / 1e9, 2)}B`;
  if (v >= 1e6) return `${trim(v / 1e6, 2)}M`;
  if (v >= 1e3) return `${trim(v / 1e3, 1)}K`;
  return String(Math.round(v));
}

export function runtimeStatus(runtime) {
  return {
    active: runtime?.status === 'active',
    version: runtime?.packageVersion ? `v${runtime.packageVersion}` : 'v--',
  };
}
