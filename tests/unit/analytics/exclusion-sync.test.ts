import { describe, expect, it, vi } from 'vitest';
import { fetchExclusions } from '../../../src/analytics/exclusion-sync.js';

const W = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
const page = (revision: string, items: Array<{ tombstoneId: string; evidenceIds: string[] }>, next: string | null) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { revision, items: items.map(i => ({ ...i, window: W })), nextCursor: next, hasMore: next !== null }, error: null }) }) as Response;
const opts = (fetcher: typeof fetch, auth: string | null = 'Bearer k') => ({ baseUrl: 'https://portal.test', authorization: () => auth ?? undefined, fetch: fetcher });

describe('exclusion sync fetch', () => {
  it('reads every page of one revision and returns tombstone and evidence ids', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(page('r1', [{ tombstoneId: 't1', evidenceIds: ['o1', 'o2'] }], 'c1'))
      .mockResolvedValueOnce(page('r1', [{ tombstoneId: 't2', evidenceIds: ['o2'] }], null));
    const result = await fetchExclusions(opts(fetcher as never));
    expect(result.revision).toBe('r1');
    expect(result.ids.sort()).toEqual(['o1', 'o2', 't1', 't2']);
    expect(fetcher.mock.calls[1]![0]).toContain('cursor=c1');
    expect(fetcher.mock.calls[0]![1].headers.Authorization).toBe('Bearer k');
    expect(fetcher.mock.calls[0]![1].redirect).toBe('error');
  });

  it('fences the whole window of every tombstone because portal evidence ids are not collector ids', async () => {
    const result = await fetchExclusions(opts(vi.fn().mockResolvedValue(page('r1', [{ tombstoneId: 'w1', evidenceIds: [] }, { tombstoneId: 't2', evidenceIds: ['o9'] }], null)) as never));
    expect(result.windows).toEqual(Array(2).fill({ fromMs: Date.parse(W.from), toMs: Date.parse(W.to) }));
    expect(result.ids.sort()).toEqual(['o9', 't2', 'w1']);
  });

  it('aborts when the revision changes mid-read, a page stalls or the credential is missing', async () => {
    await expect(fetchExclusions(opts(vi.fn().mockResolvedValueOnce(page('r1', [], 'c')).mockResolvedValueOnce(page('r2', [], null)) as never))).rejects.toThrow('revision changed');
    await expect(fetchExclusions(opts(vi.fn().mockResolvedValue({ ...page('r1', [], null), text: async () => JSON.stringify({ success: true, data: { revision: 'r', items: [], nextCursor: null, hasMore: true } }) }) as never))).rejects.toThrow('stalled');
    await expect(fetchExclusions(opts(vi.fn() as never, null))).rejects.toThrow('credential');
  });

  it('rejects errors, foreign shapes and unbounded paging', async () => {
    await expect(fetchExclusions(opts(vi.fn().mockResolvedValue({ ok: false, status: 403 }) as never))).rejects.toThrow('403');
    await expect(fetchExclusions(opts(vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '{"success":true,"data":{"revision":1}}' }) as never))).rejects.toThrow();
    const endless = vi.fn().mockImplementation(async () => page('r', [], 'again'));
    await expect(fetchExclusions(opts(endless as never))).rejects.toThrow('page limit');
    expect(endless).toHaveBeenCalledTimes(100);
  });
});
