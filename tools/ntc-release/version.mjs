// Next X.Y.Z-ntc.N version for the NTConsult fork. Plain ESM, no dependencies.
const BASE = /^\d+\.\d+\.\d+$/;
const TAG = /^ntc-v(\d+\.\d+\.\d+)-ntc\.(\d+)$/;

export function nextNtcVersion(baseVersion, existingTags) {
  if (typeof baseVersion !== 'string' || !BASE.test(baseVersion)) {
    throw new Error(`base version must be X.Y.Z, got: ${baseVersion}`);
  }
  let max = 0;
  for (const tag of existingTags ?? []) {
    const m = TAG.exec(String(tag).trim());
    if (m && m[1] === baseVersion) max = Math.max(max, Number(m[2]));
  }
  return `${baseVersion}-ntc.${max + 1}`;
}
