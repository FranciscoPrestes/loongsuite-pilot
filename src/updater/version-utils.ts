import * as crypto from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Compare two version strings numerically.
 * Supports standard semver (X.Y.Z) and NTC builds (X.Y.Z-ntc.N).
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * For NTC builds: X.Y.Z has build 0, X.Y.Z-ntc.N has build N.
 * NTC builds with the same X.Y.Z are greater than the base version.
 * Falls back to string comparison for non-standard formats.
 */
const NTC_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-ntc\.(\d+))?$/;

function parseNtc(v: string): number[] | null {
  const m = NTC_VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null;
}

export function compareVersions(a: string, b: string): number {
  const na4 = parseNtc(a);
  const nb4 = parseNtc(b);
  const pa = na4 ?? a.split('.').map(Number);
  const pb = nb4 ?? b.split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

export function deterministicBucket(installId: string, version: string): number {
  const hash = crypto.createHash('sha256').update(installId + version).digest();
  const num = hash.readUInt32BE(0);
  return num % 100;
}

export async function computeSha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}
