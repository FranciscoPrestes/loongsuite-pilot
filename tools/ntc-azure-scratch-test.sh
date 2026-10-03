#!/usr/bin/env bash
# Exercise the real Azure write path of the release tooling against a DISPOSABLE container:
# anonymous fetch (404 first release, ETag with quotes), immutable upload (idempotent, mismatch refused),
# If-None-Match/If-Match on latest.json (concurrent first write and stale ETag lose with 412),
# channel files, check-channels, the promote alias copies (server-side copy + polling), purge-unreleased.
#
# Usage: NTC_STORAGE_ACCOUNT=<scratch account> AZURE_SUBSCRIPTION_ID=<id> bash tools/ntc-azure-scratch-test.sh
# The account must allow public blob access and Entra data access for the caller; the container is created here
# and deleted at the end. NEVER point this at the production account.
set -euo pipefail

: "${NTC_STORAGE_ACCOUNT:?}"; : "${AZURE_SUBSCRIPTION_ID:?}"
[ "$NTC_STORAGE_ACCOUNT" != "stntconsultpilot" ] || { echo "refusing to run against the production account" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REL="$HERE/ntc-release"
export CONTAINER="pilot"
BLOB="https://${NTC_STORAGE_ACCOUNT}.blob.core.windows.net/${CONTAINER}"
export NTC_BLOB_BASE_URL="$BLOB"
W="$(mktemp -d)"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
check() { local name="$1"; shift; if "$@" >"$W/out" 2>&1; then ok "$name"; else bad "$name"; sed 's/^/      /' "$W/out" | tail -8; fi; }
expect_fail() { local name="$1" pat="$2"; shift 2; if "$@" >"$W/out" 2>&1; then bad "$name (should have failed)"; else grep -Eqi "$pat" "$W/out" && ok "$name" || { bad "$name (wrong error)"; tail -5 "$W/out"; }; fi; }
az_blob() { az storage blob "$@" --auth-mode login --account-name "$NTC_STORAGE_ACCOUNT" --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors; }

cleanup() { az storage container delete -n "$CONTAINER" --account-name "$NTC_STORAGE_ACCOUNT" --auth-mode login --subscription "$AZURE_SUBSCRIPTION_ID" -o none 2>/dev/null || true; rm -rf "$W"; }
trap cleanup EXIT

# a container deleted by a previous run stays "being deleted" for a while: retry until it exists
for _ in $(seq 1 40); do
  az storage container create -n "$CONTAINER" --public-access blob --account-name "$NTC_STORAGE_ACCOUNT" --auth-mode login --subscription "$AZURE_SUBSCRIPTION_ID" --only-show-errors -o none 2>/dev/null \
    && [ "$(az storage container exists -n "$CONTAINER" --account-name "$NTC_STORAGE_ACCOUNT" --auth-mode login --subscription "$AZURE_SUBSCRIPTION_ID" --query exists -o tsv)" = true ] && break
  sleep 6
done

# --- fake release stage (layout of assemble-stage.mjs)
mkrel() { # <version> <dir>
  local v="$1" d="$2/releases/$1"
  mkdir -p "$d/thin" "$2/deps/node-modules/$v"
  for f in loongsuite-pilot.tar.gz loongsuite-pilot.zip installer.sh installer.ps1 apply-config.mjs thin/install.sh thin/install.ps1; do head -c 4096 /dev/urandom > "$d/$f"; done
  ( cd "$d" && shasum -a 256 loongsuite-pilot.tar.gz loongsuite-pilot.zip installer.sh installer.ps1 apply-config.mjs thin/install.sh thin/install.ps1 | sed 's/  / /' > SHA256SUMS )
  head -c 4096 /dev/urandom > "$2/deps/node-modules/$v/node-modules-linux-x64.tar.gz"
  ( cd "$2/deps/node-modules/$v" && shasum -a 256 node-modules-linux-x64.tar.gz > SHASUMS256.txt )
}
manifest() { # <kind> <version> <prev-file|-> <outdir>
  local sha; sha="$(shasum -a 256 "$W/stage/releases/$2/loongsuite-pilot.tar.gz" | cut -d' ' -f1)"
  node "$REL/cli.mjs" manifest --action "$1" --prev "$(if [ "$3" = - ]; then echo -; else cat "$3"; fi)" --version "$2" \
    --git-commit 0123456789abcdef0123456789abcdef01234567 --package-url "$BLOB/releases/$2/loongsuite-pilot.tar.gz" \
    --sha256 "$sha" --released-at 2026-10-03T00:00:00Z --out-dir "$4.raw"
  node "$REL/assemble-stage.mjs" place-manifest --manifest-dir "$4.raw" --out "$4"
}

V1=1.2.0-ntc.1; V2=1.2.0-ntc.2
mkrel $V1 "$W/stage"; mkrel $V2 "$W/stage"

# 1. first release: nothing published yet
out="$(bash "$REL/fetch-manifest.sh" "$BLOB" "$W/l0.json" allow-missing)"
case "$out" in *status=first*) ok "fetch: first release when latest.json is absent" ;; *) bad "fetch first: $out" ;; esac

# 2. immutable upload, resume and mismatch
check "upload-immutable: first upload" bash "$REL/upload-immutable.sh" "$W/stage" releases/$V1 deps/node-modules/$V1
check "upload-immutable: rerun is a no-op (contentMd5 compare)" bash "$REL/upload-immutable.sh" "$W/stage" releases/$V1 deps/node-modules/$V1
cp "$W/stage/releases/$V1/installer.sh" "$W/orig.sh"; echo tamper >> "$W/stage/releases/$V1/installer.sh"
expect_fail "upload-immutable: different bytes at the same path are refused" "immutable|different content" bash "$REL/upload-immutable.sh" "$W/stage" releases/$V1
cp "$W/orig.sh" "$W/stage/releases/$V1/installer.sh"
check "upload-immutable: second version" bash "$REL/upload-immutable.sh" "$W/stage" releases/$V2 deps/node-modules/$V2

# 3. first manifest write (If-None-Match: *)
manifest canary $V1 - "$W/m1"
NTC_ETAG="" check "publish-manifest: first write" bash "$REL/publish-manifest.sh" "$W/m1"
NTC_ETAG="" expect_fail "publish-manifest: concurrent first write loses" "If-Match failed|ConditionNotMet|412|BlobAlreadyExists" bash "$REL/publish-manifest.sh" "$W/m1"

# 4. ETag with quotes, assert-etag, stale ETag
out="$(bash "$REL/fetch-manifest.sh" "$BLOB" "$W/l1.json" require)"
ETAG1="$(printf '%s\n' "$out" | sed -n 's/^etag=//p')"
[ -n "$ETAG1" ] && ok "fetch: ETag captured as served by Azure ($ETAG1)" || bad "no ETag captured"
raw="${ETAG1#\"}"; raw="${raw%\"}"
check "assert-etag: unchanged ETag passes" bash "$REL/assert-etag.sh" "$BLOB" "$ETAG1"
manifest canary $V2 "$W/l1.json" "$W/m2"
NTC_ETAG="$ETAG1" check "publish-manifest: If-Match with the quoted ETag" bash "$REL/publish-manifest.sh" "$W/m2"
expect_fail "assert-etag: stale ETag fails" "changed since" bash "$REL/assert-etag.sh" "$BLOB" "$ETAG1"
NTC_ETAG="$ETAG1" expect_fail "publish-manifest: stale ETag loses (412)" "If-Match failed|ConditionNotMet|412" bash "$REL/publish-manifest.sh" "$W/m2"
out="$(bash "$REL/fetch-manifest.sh" "$BLOB" "$W/l2.json" require)"; ETAG2="$(printf '%s\n' "$out" | sed -n 's/^etag=//p')"

# the same guard accepts the ETag with or without surrounding quotes
rawq="${ETAG2#\"}"; rawq="${rawq%\"}"
check "If-Match accepts the quoted form of the current ETag" az_blob upload --container-name "$CONTAINER" --file "$W/m2/manifest/latest.json" --name manifest/latest.json --overwrite true --if-match "\"$rawq\"" --content-type application/json --content-cache-control no-cache --output none
out="$(bash "$REL/fetch-manifest.sh" "$BLOB" "$W/l2.json" require)"; ETAG2="$(printf '%s\n' "$out" | sed -n 's/^etag=//p')"

# 5. channel files agree with latest.json
check "check-channels: consistent" node "$REL/check-channels.mjs" --blob "$BLOB"
# canary.txt of the V2 manifest holds a different version than stable (V1): as stable.txt it is stale
az_blob upload --container-name "$CONTAINER" --file "$W/m2/manifest/canary.txt" --name manifest/stable.txt --overwrite true --output none
expect_fail "check-channels: detects a stale stable.txt" "stable|differ|mismatch|missing" node "$REL/check-channels.mjs" --blob "$BLOB"
mkdir -p "$W/repair"; node "$REL/check-channels.mjs" --blob "$BLOB" --repair "$W/repair" >/dev/null 2>&1 || true
NTC_TXT_ONLY=1 check "check-channels --repair + publish-manifest TXT_ONLY" bash "$REL/publish-manifest.sh" "$W/repair"
check "check-channels: consistent after repair" node "$REL/check-channels.mjs" --blob "$BLOB"

# 6. promotion: alias copies (same code as ntc-promote.yml), wait for each copy
alias_copy() {
  local src="$1" dst="$2" ctype="$3" status="" i
  az_blob copy start --destination-container "$CONTAINER" --destination-blob "$dst" --source-uri "$BLOB/$src" --output none
  for i in $(seq 1 60); do
    status="$(az_blob show --container-name "$CONTAINER" --name "$dst" --query properties.copy.status --output tsv)"
    [ "$status" = "success" ] && break
    case "$status" in failed|aborted) return 1 ;; esac; sleep 2
  done
  [ "$status" = "success" ]
  az_blob update --container-name "$CONTAINER" --name "$dst" --content-type "$ctype" --content-cache-control "no-cache" --output none
}
promote_all() { local rel="releases/$V2"
  alias_copy "$rel/loongsuite-pilot.tar.gz" releases/latest/loongsuite-pilot.tar.gz application/gzip
  alias_copy "$rel/installer.sh" installer.sh "text/plain; charset=utf-8"
  alias_copy "$rel/thin/install.sh" install.sh "text/plain; charset=utf-8"; }
check "promote: alias copies + content-type update" promote_all
want="$(shasum -a 256 "$W/stage/releases/$V2/thin/install.sh" | cut -d' ' -f1)"
got="$(curl -fsS "$BLOB/install.sh" | shasum -a 256 | cut -d' ' -f1)"
[ "$want" = "$got" ] && ok "promote: anonymous GET of install.sh returns the promoted bytes" || bad "install.sh bytes differ"
ct="$(curl -sSI "$BLOB/install.sh" | tr -d '\r' | awk 'tolower($1)=="content-type:"{print $2,$3}')"
[ "$ct" = "text/plain; charset=utf-8" ] && ok "promote: content-type of install.sh ($ct)" || bad "content-type: $ct"
manifest promote $V2 "$W/l2.json" "$W/m3"
NTC_ETAG="$ETAG2" check "publish-manifest: promote write" bash "$REL/publish-manifest.sh" "$W/m3"
check "check-channels: consistent after promote" node "$REL/check-channels.mjs" --blob "$BLOB"

# 7. purge-unreleased: refuses a live version, deletes an unreleased one
V3=1.2.0-ntc.3; mkrel $V3 "$W/stage"; bash "$REL/upload-immutable.sh" "$W/stage" releases/$V3 deps/node-modules/$V3 >/dev/null
expect_fail "purge: refuses the version latest.json references" "refusing" bash "$REL/purge-unreleased.sh" $V2 --yes
check "purge: dry listing" bash "$REL/purge-unreleased.sh" $V3
check "purge: delete unreleased" bash "$REL/purge-unreleased.sh" $V3 --yes
n="$(az_blob list --container-name "$CONTAINER" --prefix "releases/$V3/" --query 'length(@)' --output tsv)"
[ "$n" = "0" ] && ok "purge: nothing left under releases/$V3/" || bad "purge left $n blobs"

echo "----"; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
