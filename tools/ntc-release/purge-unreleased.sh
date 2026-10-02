#!/usr/bin/env bash
# MANUAL operator tool (no workflow uses it): delete the blobs of a release that never became
# current, so a new dispatch can publish that version again (a new run rebuilds different bytes,
# and releases/<v>/ is immutable).
#
# Usage: purge-unreleased.sh <version> [--yes]
#   Without --yes it only lists what would be deleted.
#   Refuses (exit 1) if latest.json references the version (stable or canary), or if the git tag
#   ntc-v<version> exists on origin: that release is live or complete.
# Env: NTC_STORAGE_ACCOUNT, AZURE_SUBSCRIPTION_ID (required); NTC_BLOB_BASE_URL (default: the planned blob).
# Needs `az login` (data-plane delete) and git access to origin.
set -euo pipefail

YES=""
VERSION=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    -*) echo "purge-unreleased: unknown flag $a" >&2; exit 2 ;;
    *) [ -z "$VERSION" ] || { echo "purge-unreleased: one version only" >&2; exit 2; }; VERSION="$a" ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+-ntc\.[0-9]+$ ]] \
  || { echo "usage: purge-unreleased.sh <X.Y.Z-ntc.N> [--yes]" >&2; exit 2; }
: "${NTC_STORAGE_ACCOUNT:?NTC_STORAGE_ACCOUNT is required}"
: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID is required}"
BLOB="${NTC_BLOB_BASE_URL:-https://stntconsultpilot.blob.core.windows.net/pilot}"
CONTAINER="${CONTAINER:-pilot}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

out="$(bash "$HERE/fetch-manifest.sh" "$BLOB" "$TMP/latest.json" allow-missing)"
if printf '%s\n' "$out" | grep -q '^status=existing'; then
  if node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(m.version === process.argv[2] || (m.canary && m.canary.version === process.argv[2]) ? 0 : 1);
  ' "$TMP/latest.json" "$VERSION"; then
    echo "purge-unreleased: refusing, latest.json references $VERSION (stable or canary)" >&2
    exit 1
  fi
fi

if [ -n "$(git ls-remote --tags origin "refs/tags/ntc-v${VERSION}" </dev/null)" ]; then
  echo "purge-unreleased: refusing, tag ntc-v${VERSION} exists on origin (the release is complete)" >&2
  exit 1
fi

az_blob() {
  az storage blob "$@" --auth-mode login --account-name "$NTC_STORAGE_ACCOUNT" \
    --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors
}

names=""
for prefix in "releases/${VERSION}/" "deps/node-modules/${VERSION}/"; do
  listed="$(az_blob list --container-name "$CONTAINER" --prefix "$prefix" --query '[].name' --output tsv </dev/null)"
  [ -z "$listed" ] || names="${names}${listed}"$'\n'
done
if [ -z "$names" ]; then echo "purge-unreleased: nothing to delete for $VERSION"; exit 0; fi

printf '%s' "$names" | sed 's/^/  /'
if [ -z "$YES" ]; then
  echo "purge-unreleased: dry listing only; rerun with --yes to delete"
  exit 0
fi
while IFS= read -r name; do
  [ -n "$name" ] || continue
  az_blob delete --container-name "$CONTAINER" --name "$name" --output none </dev/null
  echo "purge-unreleased: deleted $name"
done <<< "$names"
