import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/internal/webtracking-post.js', () => ({
  buildWebTrackingUrl: vi.fn(() => 'x'),
  postWebTracking: vi.fn(async () => undefined),
}));

describe('statistic (NTConsult build)', () => {
  it('never posts running status anywhere', async () => {
    const { sendRunningStatus } = await import('../../../src/internal/statistic.js');
    const post = await import('../../../src/internal/webtracking-post.js');
    for (let i = 0; i < 200; i++) sendRunningStatus({ cpu: '1', hostname: 'h', ip: '1.2.3.4' });
    expect(post.postWebTracking).not.toHaveBeenCalled();
  });
});
