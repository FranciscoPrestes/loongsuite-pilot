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

const GIT_COMMIT = /^[0-9a-f]{7,40}$/i;
const RELEASED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Any whitespace or control character (checked on the raw string, since URL() strips \n and \t).
const URL_FORBIDDEN = /[\s\u0000-\u001f\u007f]/;

// Note: X.Y.Z-ntc.0 compares equal to the bare X.Y.Z, so nextNtcVersion never emits ntc.0.
function validateRelease(release, label = 'release') {
  if (!release || typeof release !== 'object') throw new Error(`${label} is required`);
  for (const k of RELEASE_KEYS) {
    if (typeof release[k] !== 'string' || release[k] === '') {
      throw new Error(`${label}.${k} is required`);
    }
  }
  if (!NTC_VERSION.test(release.version)) {
    throw new Error(`${label}.version must be X.Y.Z or X.Y.Z-ntc.N: ${JSON.stringify(release.version)}`);
  }
  if (!SHA256.test(release.sha256)) {
    throw new Error(`${label}.sha256 must be 64 lowercase hex characters`);
  }
  if (!GIT_COMMIT.test(release.git_commit)) {
    throw new Error(`${label}.git_commit must be 7-40 hex characters`);
  }
  if (!RELEASED_AT.test(release.released_at)) {
    throw new Error(`${label}.released_at must be ISO-8601 UTC (YYYY-MM-DDTHH:MM:SSZ)`);
  }
  if (URL_FORBIDDEN.test(release.package_url)) {
    throw new Error(`${label}.package_url must not contain whitespace or control characters`);
  }
  let url;
  try {
    url = new URL(release.package_url);
  } catch {
    throw new Error(`${label}.package_url is not a valid URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${label}.package_url must use https:`);
}

function validatePrev(prev) {
  if (!prev) return;
  validateRelease(prev, 'prev');
  const c = prev.canary;
  if (c !== undefined) {
    validateRelease(c, 'prev.canary');
    if (!Number.isInteger(c.rollout_percentage) || c.rollout_percentage < 1 || c.rollout_percentage > 100) {
      throw new Error('prev.canary.rollout_percentage must be an integer in [1,100]');
    }
    if (c.hotfix_version !== undefined && (!Number.isInteger(c.hotfix_version) || c.hotfix_version < 0)) {
      throw new Error('prev.canary.hotfix_version must be a non-negative integer');
    }
  }
}

function copyCanary(c) {
  return { ...pickRelease(c), rollout_percentage: c.rollout_percentage, hotfix_version: c.hotfix_version ?? 0 };
}

export function buildManifest(prev, action, options = {}) {
  if (!action || typeof action !== 'object') throw new Error('action is required');
  const { release } = action;
  validateRelease(release);
  validatePrev(prev);
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
    if (canary && compareNtc(canary.version, info.version) > 0) next.canary = copyCanary(canary);
    return next;
  }

  throw new Error(`unknown action kind: ${action.kind}`);
}

export function renderChannelEnv(info) {
  for (const k of ['version', 'package_url', 'sha256', 'git_commit']) {
    if (typeof info[k] !== 'string' || /[\r\n]/.test(info[k])) {
      throw new Error(`refusing to render ${k}: missing or contains a line break`);
    }
  }
  return [
    `version=${info.version}`,
    `package_url=${info.package_url}`,
    `sha256=${info.sha256}`,
    `git_commit=${info.git_commit}`,
    '',
  ].join('\n');
}
