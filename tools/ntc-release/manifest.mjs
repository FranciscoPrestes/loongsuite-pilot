// Updater manifest (latest.json) builder. Plain ESM, imports nothing from src.
// Format: ReleaseInfo fields at top level (stable channel) + optional `canary`.

const NTC_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-ntc\.(\d+))?$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELEASE_KEYS = ['version', 'git_commit', 'package_url', 'sha256', 'released_at'];

function parseNtc(v) {
  const m = NTC_VERSION.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0)] : null;
}

/** Local equivalent of compareVersions in src/updater/version-utils.ts. */
export function compareNtc(a, b) {
  const pa = parseNtc(a) ?? a.split('.').map(Number);
  const pb = parseNtc(b) ?? b.split('.').map(Number);
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

function pickRelease(src) {
  const out = {};
  for (const k of RELEASE_KEYS) out[k] = src[k];
  return out;
}

function validateRelease(release) {
  if (!release || typeof release !== 'object') throw new Error('release is required');
  for (const k of RELEASE_KEYS) {
    if (typeof release[k] !== 'string' || release[k] === '') {
      throw new Error(`release.${k} is required`);
    }
  }
  if (!NTC_VERSION.test(release.version)) {
    throw new Error(`release.version must be X.Y.Z or X.Y.Z-ntc.N: ${release.version}`);
  }
  if (!SHA256.test(release.sha256)) {
    throw new Error('release.sha256 must be 64 lowercase hex characters');
  }
  let url;
  try {
    url = new URL(release.package_url);
  } catch {
    throw new Error(`release.package_url is not a valid URL: ${release.package_url}`);
  }
  if (url.protocol !== 'https:') throw new Error('release.package_url must use https:');
}

export function buildManifest(prev, action, options = {}) {
  if (!action || typeof action !== 'object') throw new Error('action is required');
  const { release } = action;
  validateRelease(release);
  const info = pickRelease(release);

  if (action.kind === 'canary') {
    const pct = action.rolloutPercentage;
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
      throw new Error(`rolloutPercentage must be an integer in [1,100], got: ${pct}`);
    }
    const stable = prev ? pickRelease(prev) : info;
    const sameVersion = prev?.canary?.version === info.version;
    const hotfix = sameVersion ? (prev.canary.hotfix_version ?? 0) + 1 : 0;
    return { ...stable, canary: { ...info, rollout_percentage: pct, hotfix_version: hotfix } };
  }

  if (action.kind === 'promote') {
    if (prev && compareNtc(info.version, prev.version) < 0 && !options.allowDowngrade) {
      throw new Error(
        `refusing to promote ${info.version}: lower than current stable ${prev.version} ` +
        '(the updater does not downgrade; pass allowDowngrade to force)',
      );
    }
    const next = { ...info };
    const canary = prev?.canary;
    if (canary && compareNtc(canary.version, info.version) > 0) next.canary = canary;
    return next;
  }

  throw new Error(`unknown action kind: ${action.kind}`);
}

export function renderChannelEnv(info) {
  return [
    `version=${info.version}`,
    `package_url=${info.package_url}`,
    `sha256=${info.sha256}`,
    `git_commit=${info.git_commit}`,
    '',
  ].join('\n');
}
