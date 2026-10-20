import { readJsonDocument, editJsonc, type JsonSyntax } from '../utils/json-document.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
/** Each retry composes against freshly read valid bytes, retaining unrelated text. */
export async function updateJsonConfig(file: string, change: (value: Record<string, unknown>) => Record<string, unknown>, syntax: JsonSyntax = 'json', backupSuffix = '.loongsuite-pilot.bak'): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const document = await readJsonDocument<Record<string, unknown>>(file, syntax);
    if (document.status === 'error') throw new Error('refusing to overwrite invalid settings');
    const before = document.status === 'ok' ? document.data : {};
    if (!before || typeof before !== 'object' || Array.isArray(before)) throw new Error('settings root must be an object');
    const after = change(structuredClone(before));
    const raw = document.status === 'missing' || document.status === 'empty' ? '{}\n' : document.raw;
    let next = raw;
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) next = editJsonc(next, [key], after[key]);
    }
    if (next === raw && document.status === 'ok') return;
    try {
      await writeTextFileAtomic(file, next, { expected: document.status === 'missing' ? {exists:false} : {exists:true,content:document.raw},
        backupPath: document.status === 'missing' ? undefined : file + backupSuffix });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('file changed before write') || attempt === 2) throw error;
    }
  }
}
