#!/usr/bin/env bash
# Upload staged files to immutable blob paths, resumably.
# Usage: upload-immutable.sh <stage-dir> <prefix>...     e.g. stage releases/1.2.0-ntc.1 deps/node-modules/1.2.0-ntc.1
# A blob that does not exist is uploaded with --overwrite false. A blob that already exists is
# accepted only if its content equals the staged file (Content-MD5, else download + compare);
# otherwise the run fails. Rerunning after a partial publish therefore resumes. Files named
# SHA256SUMS / SHASUMS256.txt go last in each prefix (completeness markers).
# Env (required): NTC_STORAGE_ACCOUNT, AZURE_SUBSCRIPTION_ID. Optional: CONTAINER (default pilot).
set -euo pipefail
[ "$#" -ge 2 ] || { echo "usage: upload-immutable.sh <stage-dir> <prefix>..." >&2; exit 2; }
STAGE="${1%/}"; shift
: "${NTC_STORAGE_ACCOUNT:?NTC_STORAGE_ACCOUNT is required}"
: "${AZURE_SUBSCRIPTION_ID:?AZURE_SUBSCRIPTION_ID is required}"
CONTAINER="${CONTAINER:-pilot}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

az_blob() {
  az storage blob "$@" --auth-mode login --account-name "$NTC_STORAGE_ACCOUNT" \
    --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors
}

md5_b64() { openssl md5 -binary "$1" | base64; }

same_content() {
  local file="$1" name="$2" remote
  remote="$(az_blob show --container-name "$CONTAINER" --name "$name" --query properties.contentSettings.contentMd5 --output tsv </dev/null || true)"
  if [ -n "$remote" ] && [ "$remote" != "None" ]; then
    [ "$remote" = "$(md5_b64 "$file")" ]
    return
  fi
  rm -f "$TMP/dl"
  az_blob download --container-name "$CONTAINER" --name "$name" --file "$TMP/dl" --overwrite true --output none </dev/null
  cmp -s "$TMP/dl" "$file"
}

put() {
  local file="$1" name="$2" exists
  exists="$(az_blob exists --container-name "$CONTAINER" --name "$name" --query exists --output tsv </dev/null)"
  if [ "$exists" = "true" ]; then
    if same_content "$file" "$name"; then
      echo "upload-immutable: $name already present, identical"
      return
    fi
    echo "::error::$name exists with different content; releases are immutable"
    exit 1
  fi
  az_blob upload --container-name "$CONTAINER" --file "$file" --name "$name" --overwrite false --output none </dev/null
  echo "upload-immutable: uploaded $name"
}

for prefix in "$@"; do
  [ -d "$STAGE/$prefix" ] || { echo "upload-immutable: $STAGE/$prefix is not a directory" >&2; exit 1; }
  last=()
  while IFS= read -r f; do
    rel="${f#"$STAGE"/}"
    case "$(basename "$f")" in
      SHA256SUMS|SHASUMS256.txt) last+=("$rel") ;;
      *) put "$f" "$rel" ;;
    esac
  done < <(find "$STAGE/$prefix" -type f | sort)
  for rel in ${last[@]+"${last[@]}"}; do put "$STAGE/$rel" "$rel"; done
done
