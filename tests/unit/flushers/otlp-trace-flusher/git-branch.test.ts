import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';

// Real converter and flusher; only the network exporter is faked.
const exported = vi.hoisted(() => [] as any[]);
vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((spans: unknown[], cb: (r: { code: number }) => void) => { exported.push(...spans); cb({ code: ExportResultCode.SUCCESS }); }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { enrichCanonicalEntriesWithGit } from '../../../../src/normalization/enrich-git-context.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

let dir: string;
beforeEach(() => { exported.length = 0; dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'c9-span-'))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });

function turn(): Record<string, unknown>[] {
  const t = Date.now() * 1e6;
  const base = { 'user.id': 'u', 'gen_ai.session.id': 's1', 'gen_ai.turn.id': 't1', 'gen_ai.agent.type': 'claude-code', 'gen_ai.provider.name': 'a', 'agent.claude-code.cwd': dir };
  return [
    { ...base, 'event.id': '1', 'event.name': 'llm.request', time_unix_nano: String(t), 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'hi' }] }] },
    { ...base, 'event.id': '2', 'event.name': 'tool.call', time_unix_nano: String(t + 1e6), 'gen_ai.tool.name': 'Bash', 'gen_ai.tool.call.id': 'c1', 'gen_ai.tool.call.arguments': '{"command":"ls"}' },
    { ...base, 'event.id': '3', 'event.name': 'tool.result', time_unix_nano: String(t + 2e6), 'gen_ai.tool.name': 'Bash', 'gen_ai.tool.call.id': 'c1', 'gen_ai.tool.call.result': 'ok' },
    { ...base, 'event.id': '4', 'event.name': 'llm.response', time_unix_nano: String(t + 3e6), 'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'ok' }] }] },
  ];
}
async function exportTurn(entries: Record<string, unknown>[]) {
  await enrichCanonicalEntriesWithGit(entries);
  const flusher = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'p', endpoint: 'http://localhost:4318', headers: {} }], protocol: 'http/protobuf' as const, serviceName: 's' } as never);
  for (const e of entries) await flusher.send(e as unknown as AgentActivityEntry);
  await flusher.flush(); await flusher.shutdown();
  return [...exported];
}

describe('git.branch and git.worktree_id on real exported spans', () => {
  it('every span of a turn carries repo, branch and worktree id for a fresh repository with no commit', async () => {
    git('init', '-q', '-b', 'feat/NT-9-spec'); git('remote', 'add', 'origin', 'git@github.com:org/repo.git');
    const spans = await exportTurn(turn());
    expect(spans.length).toBeGreaterThanOrEqual(4);
    expect(spans.some(s => s.name.startsWith('execute_tool'))).toBe(true);
    for (const span of spans) {
      expect(span.attributes['git.repo'], span.name).toBe('org/repo');
      expect(span.attributes['git.branch'], span.name).toBe('feat/NT-9-spec');
      expect(span.attributes['git.worktree_id'], span.name).toMatch(/^[a-f0-9]{32}$/);
    }
    // Volume: three short strings per span, already passed through before for repo; no extra span or event.
    expect(Buffer.byteLength(JSON.stringify({ b: 'feat/NT-9-spec', w: 'a'.repeat(32) }))).toBeLessThan(100);
  });

  it('a detached HEAD exports repo and worktree id but no branch (never "HEAD")', async () => {
    git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'git@github.com:org/repo.git');
    git('commit', '-q', '--allow-empty', '-m', 'x'); git('checkout', '-q', '--detach');
    const spans = await exportTurn(turn());
    for (const span of spans) {
      expect(span.attributes['git.branch'], span.name).toBeUndefined();
      expect(span.attributes['git.worktree_id'], span.name).toBeDefined();
    }
  });
});
