// NTConsult: rewrite Alibaba download origins to the NTConsult blob.
//
// Exact forms found in the real files (read with grep, contract is the real-file test):
//   installer-opensource.sh
//     _OSS_BASE_URL="https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"
//     NODE_DEPS_BASE="${LOONGSUITE_PILOT_NODE_DEPS_URL:-https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node}"
//     NODE_MODULES_BASE="${LOONGSUITE_PILOT_NODE_MODULES_URL:-https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node-modules}"
//     PACKAGE_URL="${_OSS_BASE_URL}/${INSTALL_VERSION}/${PACKAGE_NAME}.tar.gz"
//     PACKAGE_URL="${_OSS_BASE_URL}/latest/${PACKAGE_NAME}.tar.gz"
//   installer-opensource.ps1
//     $_OSS_BASE_URL = "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot"
//     ... else { $script:NODE_DEPS_BASE = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node" }
//     ... else { $script:NODE_MODULES_BASE = "https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node-modules" }
//     $PackageUrl = "$_OSS_BASE_URL/$Version/$PACKAGE_NAME.zip"
//     $PackageUrl = "$_OSS_BASE_URL/latest/$PACKAGE_NAME.zip"
//   scripts/loongsuite-pilot.sh   OPEN_SOURCE_INSTALLER_URL="https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.sh"
//   scripts/loongsuite-pilot.ps1  $OPEN_SOURCE_INSTALLER_URL = "https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/installer.ps1"
//   src/updater/updater.ts (baked into dist) 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node[-modules]'
//   assets/skills/loongsuite-pilot-ops/SKILL.md  https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/<internal script>
//     (internal-only helper scripts the fork does not publish; replaced by a literal note)

const ALIYUN_RELEASE = 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com';
const COMMUNITY = 'https://loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com';

const UNAVAILABLE = '(not available in the NTConsult build)';

const FORBIDDEN = /loongcollector-community-edition|aliyun-observability-release|loongsuite-community-edition/g;

/**
 * Rules in order of specificity. `blob` is substituted into the replacement.
 * @param {string} blob base URL without trailing slash
 * @returns {Array<[RegExp, string]>}
 */
function rulesFor(blob) {
  // Replacement strings use a function-free form, so escape `$` for String.replace.
  const b = blob.replace(/\$/g, '$$$$');
  return [
    [new RegExp(`${ALIYUN_RELEASE}/loongsuite-pilot/deps/node-modules`, 'g'), `${b}/deps/node-modules`],
    [new RegExp(`${ALIYUN_RELEASE}/loongsuite-pilot/deps/node`, 'g'), `${b}/deps/node`],
    // Release packages live under releases/ (sh and ps1 forms).
    [/\$\{_OSS_BASE_URL\}\/\$\{INSTALL_VERSION\}\//g, '${_OSS_BASE_URL}/releases/${INSTALL_VERSION}/'],
    [/\$_OSS_BASE_URL\/\$Version\//g, '$$_OSS_BASE_URL/releases/$$Version/'],
    [/\$\{_OSS_BASE_URL\}\/latest\//g, '${_OSS_BASE_URL}/releases/latest/'],
    [/\$_OSS_BASE_URL\/latest\//g, '$$_OSS_BASE_URL/releases/latest/'],
    [new RegExp(`${COMMUNITY}/loongsuite-pilot`, 'g'), b],
    // Internal helper scripts the NTConsult build does not publish (SKILL.md): no dead links.
    [new RegExp(`${ALIYUN_RELEASE}/loongsuite/loongsuite-pilot/[A-Za-z0-9_.-]+`, 'g'), UNAVAILABLE],
  ];
}

/**
 * @param {string} text
 * @param {string} blobBase blob URL without trailing slash
 * @returns {string}
 */
export function rewriteOrigins(text, blobBase) {
  const blob = blobBase.replace(/\/+$/, '');
  return rulesFor(blob).reduce((acc, [re, to]) => acc.replace(re, to), text);
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function findForbiddenOrigins(text) {
  return text.match(FORBIDDEN) ?? [];
}
