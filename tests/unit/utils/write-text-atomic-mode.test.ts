import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeJsonFile, writeTextFileAtomic } from '../../../src/utils/fs-utils.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atomic-mode-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const modeOf = async (p: string) => (await fs.stat(p)).mode & 0o777;

describe('writeTextFileAtomic mode', () => {
  it.skipIf(process.platform === 'win32')('keeps the existing file mode', async () => {
    const f = path.join(dir, 'config.json');
    await fs.writeFile(f, '{}', { mode: 0o600 });
    await fs.chmod(f, 0o600);
    await writeJsonFile(f, { a: 1 });
    expect(await modeOf(f)).toBe(0o600);
    expect(JSON.parse(await fs.readFile(f, 'utf8'))).toEqual({ a: 1 });
  });

  it.skipIf(process.platform === 'win32')('explicit options.mode wins over the existing mode', async () => {
    const f = path.join(dir, 'x.json');
    await fs.writeFile(f, '{}');
    await fs.chmod(f, 0o600);
    await writeTextFileAtomic(f, '{}', { mode: 0o640 });
    expect(await modeOf(f)).toBe(0o640);
  });

  it('without a previous file, writes with the default mode', async () => {
    const f = path.join(dir, 'new.json');
    await writeJsonFile(f, { b: 2 });
    expect(JSON.parse(await fs.readFile(f, 'utf8'))).toEqual({ b: 2 });
  });
});
