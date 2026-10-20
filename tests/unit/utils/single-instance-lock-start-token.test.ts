import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readProcessStartToken = vi.hoisted(() => vi.fn(() => 'token'));
vi.mock('../../../src/utils/pid-utils.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/utils/pid-utils.js')>()),
  readProcessStartToken,
}));

import { acquireSingleInstanceLock } from '../../../src/utils/single-instance-lock.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sil-token-')); readProcessStartToken.mockClear(); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('single-instance lock start token', () => {
  it('reads the process start token once, however often waiters retry (it spawns ps on macOS)', () => {
    const lockPath = path.join(dir, 'x.lock');
    const first = acquireSingleInstanceLock(lockPath);
    expect(first.lock).not.toBeNull();
    for (let i = 0; i < 50; i += 1) expect(acquireSingleInstanceLock(lockPath).lock).toBeNull();
    first.lock?.release();
    expect(acquireSingleInstanceLock(lockPath).lock).not.toBeNull();
    expect(readProcessStartToken).toHaveBeenCalledTimes(1);
  });
});
