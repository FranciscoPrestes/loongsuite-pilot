#!/usr/bin/env bash
# Write the mutable manifest blobs, in this order: latest.json (guarded by If-Match, the lock),
# then manifest/stable.txt and manifest/canary.txt (deleted when the manifest has no canary).
#
# Usage: publish-manifest.sh <dir>     dir has latest.json, manifest/stable.txt, [manifest/canary.txt]
# Env (required): NTC_STORAGE_ACCOUNT, AZURE_SUBSCRIPTION_ID.
#      NTC_ETAG: the ETag read with fetch-manifest.sh; empty means first release, then the
#      write uses If-None-Match: * so a concurrent first release cannot be overwritten.
# Needs an authenticated `az` (OIDC login). Everything uses --auth-mode login.
set -euo pipefail

[ "$#" -eq 1 ] || { echo "usage: publish-manifest.sh <dir>" >&2; exit 2; }
DIR="$1"
: "${NTC_STORAGE_ACCOUNT:?NTC_STORAGE_ACCOUNT is required}"
: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID is required}"
ETAG="${NTC_ETAG:-}"
CONTAINER="pilot"
[ -f "$DIR/latest.json" ] && [ -f "$DIR/manifest/stable.txt" ] || {
  echo "publish-manifest: $DIR needs latest.json and manifest/stable.txt" >&2; exit 1; }

az_blob() {
  az storage blob "$@" --auth-mode login --account-name "$NTC_STORAGE_ACCOUNT" \
    --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors
}

upload_mutable() {
  local file="$1" name="$2" ctype="$3"
  shift 3
  az_blob upload --container-name "$CONTAINER" --file "$file" --name "$name" --overwrite true \
    --content-type "$ctype" --content-cache-control "no-cache" "$@" --output none
}

guard=(--if-none-match '*')
[ -z "$ETAG" ] || guard=(--if-match "$ETAG")

if ! out="$(upload_mutable "$DIR/latest.json" latest.json "application/json" "${guard[@]}" 2>&1)"; then
  echo "$out" >&2
  if printf '%s' "$out" | grep -Eqi 'ConditionNotMet|412|BlobAlreadyExists'; then
    echo "::error::latest.json changed since it was read (If-Match failed). Nothing else was written. Run the workflow again."
  fi
  exit 1
fi

upload_mutable "$DIR/manifest/stable.txt" manifest/stable.txt "text/plain; charset=utf-8"
if [ -f "$DIR/manifest/canary.txt" ]; then
  upload_mutable "$DIR/manifest/canary.txt" manifest/canary.txt "text/plain; charset=utf-8"
else
  exists="$(az_blob exists --container-name "$CONTAINER" --name manifest/canary.txt --query exists --output tsv)"
  if [ "$exists" = "true" ]; then
    az_blob delete --container-name "$CONTAINER" --name manifest/canary.txt --output none
  fi
fi
echo "publish-manifest: latest.json, stable.txt, canary.txt written"
