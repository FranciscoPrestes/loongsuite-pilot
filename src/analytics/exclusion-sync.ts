import { z } from 'zod';

const MAX_PAGES = 100;
const MAX_TOMBSTONES = 20_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const id = z.string().min(1).max(500);
const pageSchema = z.object({
  revision: id,
  items: z.array(z.object({ tombstoneId: id, evidenceIds: z.array(id).max(10_000) }).passthrough()).max(200),
  nextCursor: z.string().nullable(), hasMore: z.boolean(),
}).passthrough();
const envelopeSchema = z.object({ success: z.literal(true), data: pageSchema }).passthrough();

export interface ExclusionFetchOptions {
  baseUrl: string; authorization: () => string | undefined; fetch?: typeof fetch;
}

/**
 * Pages the device's exclusions to completion. The caller applies them only after ALL pages of ONE
 * revision were read (a revision change mid-read aborts: replay stays closed). Server tombstones are
 * id-scoped: the tombstone id and every excluded evidence id are returned as plain ids (the runtime
 * fences them by exact observation id; a device-scoped tombstone would silence the whole device).
 * Window-scoped exclusions (source namespace + time window) have no collector equivalent and are not
 * expressible here; the observation ids they list are, which is the only conservative mapping.
 */
export async function fetchExclusions(options: ExclusionFetchOptions): Promise<{ revision: string; ids: string[] }> {
  const authorization = options.authorization();
  if (!authorization) throw new Error('exclusion sync requires a credential');
  const fetcher = options.fetch ?? fetch;
  const ids = new Set<string>();
  let revision: string | null = null;
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL('/api/coletor/analytics-exclusions', options.baseUrl);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetcher(url.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { Authorization: authorization, Accept: 'application/json' } });
    if (!response.ok) throw new Error(`exclusion fetch failed: ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('exclusion page too large');
    const body = envelopeSchema.parse(JSON.parse(text)).data;
    if (revision !== null && body.revision !== revision) throw new Error('exclusion revision changed while paging');
    revision = body.revision;
    for (const item of body.items) {
      for (const identifier of [item.tombstoneId, ...item.evidenceIds]) ids.add(identifier);
      if (ids.size > MAX_TOMBSTONES) throw new Error('too many tombstones');
    }
    if (!body.hasMore) return { revision, ids: [...ids] };
    if (!body.nextCursor) throw new Error('exclusion paging stalled');
    cursor = body.nextCursor;
  }
  throw new Error('exclusion paging exceeded the page limit');
}
