#!/usr/bin/env bash
# Download the current latest.json from the blob (anonymous) and capture its ETag.
#
# Usage: fetch-manifest.sh <blob-base-url> <out-file> <require|allow-missing|lenient>
#   require        200 is the only accepted answer (promotion).
#   allow-missing  200 = existing manifest, 404 = first release; anything else aborts.
#   lenient        like allow-missing, but any failure (DNS, 5xx) is treated as "first release"
#                  with a warning. Only for dry runs, before the blob exists.
# Prints `status=<existing|first>` and `etag=<value>` (empty on first); when GITHUB_OUTPUT
# is set they are appended there too. On "first" the out-file is not created.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: fetch-manifest.sh <blob-base-url> <out-file> <require|allow-missing|lenient>" >&2
  exit 2
fi
BLOB="${1%/}"
OUT="$2"
MODE="$3"
case "$MODE" in require|allow-missing|lenient) ;; *) echo "fetch-manifest: bad mode '$MODE'" >&2; exit 2 ;; esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

emit() {
  echo "status=$1"
  echo "etag=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    { echo "status=$1"; echo "etag=$2"; } >> "$GITHUB_OUTPUT"
  fi
}

code=""
if ! code="$(curl -sS --retry "${NTC_CURL_RETRY:-3}" --connect-timeout 20 --max-time 60 \
    -o "$WORK/body" -D "$WORK/headers" -w '%{http_code}' "$BLOB/latest.json")"; then
  if [ "$MODE" = "lenient" ]; then
    echo "fetch-manifest: WARNING could not reach $BLOB/latest.json; assuming first release (dry run)" >&2
    emit first ""
    exit 0
  fi
  echo "fetch-manifest: request to $BLOB/latest.json failed" >&2
  exit 1
fi

case "$code" in
  200)
    etag="$(tr -d '\r' < "$WORK/headers" | awk 'tolower($1) == "etag:" { sub(/^[^:]*:[ \t]*/, ""); print; exit }')"
    [ -n "$etag" ] || { echo "fetch-manifest: latest.json came without an ETag" >&2; exit 1; }
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$WORK/body" \
      || { echo "fetch-manifest: latest.json is not valid JSON" >&2; exit 1; }
    cp "$WORK/body" "$OUT"
    emit existing "$etag"
    ;;
  404)
    if [ "$MODE" = "require" ]; then
      echo "fetch-manifest: latest.json does not exist (HTTP 404); nothing to promote" >&2
      exit 1
    fi
    emit first ""
    ;;
  *)
    if [ "$MODE" = "lenient" ]; then
      echo "fetch-manifest: WARNING HTTP $code from $BLOB/latest.json; assuming first release (dry run)" >&2
      emit first ""
      exit 0
    fi
    echo "fetch-manifest: unexpected HTTP $code from $BLOB/latest.json" >&2
    exit 1
    ;;
esac
