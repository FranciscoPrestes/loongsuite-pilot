#!/usr/bin/env bash
# Fail unless the blob's latest.json still has the ETag read at assemble time.
# Usage: assert-etag.sh <blob-base-url> <expected-etag>   (empty expected = first release: latest.json must not exist)
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: assert-etag.sh <blob-base-url> <expected-etag>" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
out="$(bash "$HERE/fetch-manifest.sh" "$1" "$TMP/latest.json" allow-missing)"
etag="$(printf '%s\n' "$out" | sed -n 's/^etag=//p')"
if [ "$etag" != "$2" ]; then
  echo "::error::latest.json changed since this run read it (was ${2:-absent}, now ${etag:-absent}); nothing was written by this step. A new dispatch rebuilds different bytes: first run tools/ntc-release/purge-unreleased.sh <version> to clear this run partial uploads (if any), then dispatch again."
  exit 1
fi
echo "latest.json unchanged (${etag:-absent})"
