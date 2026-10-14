import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ exec: vi.fn(), copy: vi.fn(), rm: vi.fn(), mkdir: vi.fn(), write: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:util', () => ({ promisify: () => mocks.exec }));
vi.mock('node:fs/promises', () => ({ copyFile: mocks.copy, rm: mocks.rm, mkdir: mocks.mkdir, writeFile: mocks.write }));
vi.mock('node:os', () => ({ tmpdir: () => 'C:\\Users\\张三\\Temp' }));
vi.mock('node:path', async () => { const actual = await vi.importActual<typeof import('node:path')>('node:path'); return actual.win32; });
vi.mock('../../../src/utils/logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
import { withTarGzReader } from '../../../src/utils/win-archive.js';
const platform = process.platform;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  mocks.mkdir.mockResolvedValue(undefined); mocks.copy.mockResolvedValue(undefined); mocks.rm.mockResolvedValue(undefined); mocks.write.mockResolvedValue(undefined);
  mocks.exec.mockResolvedValue({ stdout: Buffer.from([0, 255, 7]), stderr: Buffer.alloc(0) });
});
afterEach(() => { Object.defineProperty(process, 'platform', { value: platform, configurable: true }); vi.unstubAllEnvs(); });
describe('bounded Windows analytics archive reader', () => {
  it.each(['C:\\Users\\lee\\bundle.tgz', 'C:\\Users\\张三\\bundle.tgz'])('stages %s to ASCII and uses system tar for every operation', async source => {
    await withTarGzReader(source, async reader => {
      await reader.list(); await reader.details();
      expect(await reader.readFile('-worker.mjs', 2048)).toEqual(Buffer.from([0, 255, 7]));
    });
    expect(mocks.copy.mock.calls[0][0]).toBe(source);
    const staged = mocks.copy.mock.calls[0][1] as string;
    expect(staged).toMatch(/^[\x20-\x7e]+$/);
    expect(staged).not.toBe(source);
    expect(mocks.exec.mock.calls).toHaveLength(3);
    for (const [binary, args, options] of mocks.exec.mock.calls) {
      expect(binary).toBe('C:\\Windows\\System32\\tar.exe');
      expect(args).toContain(staged); expect(args).not.toContain('--force-local');
      expect(options.encoding).toBe('buffer'); expect(options.timeout).toBe(30000);
    }
    expect(mocks.exec.mock.calls[2][1].slice(-2)).toEqual(['--', '-worker.mjs']);
    expect(mocks.exec.mock.calls[2][2].maxBuffer).toBe(2048);
    expect(mocks.rm).toHaveBeenCalledWith(staged.slice(0, staged.lastIndexOf('\\')), { recursive: true, force: true });
  });
  it('falls back to GNU tar with force-local and preserves binary bytes', async () => {
    mocks.exec.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    await withTarGzReader('D:\\unicode张\\bundle.tgz', async reader => {
      expect(await reader.readFile('worker.mjs', 1024)).toEqual(Buffer.from([0, 255, 7]));
    });
    expect(mocks.exec.mock.calls[1][0]).toBe('tar');
    expect(mocks.exec.mock.calls[1][1][0]).toBe('--force-local');
  });
  it('does not retry an output bound failure and cleans its staging directory', async () => {
    mocks.exec.mockRejectedValue(Object.assign(new Error('too big'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    await expect(withTarGzReader('C:\\Users\\张\\a.tgz', reader => reader.readFile('worker', 10))).rejects.toThrow('too big');
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.rm.mock.calls.some(call => call[1]?.recursive)).toBe(true);
  });
});
