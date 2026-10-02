#!/usr/bin/env bash
# Build the prebuilt production node_modules archive for one platform.
#
# Usage: build-node-modules.sh <os> <arch> <app-version> <dest> [package-dir]
#   os in darwin|linux|win, arch in x64|arm64 (same names as managed_node_platform
#   in the installers). Run with the managed Node already active on PATH.
#   package-dir is the extracted release package (default: current directory).
#   Writes <dest>/node-modules-<os>-<arch>.tar.gz and a single line in
#   <dest>/SHASUMS256.txt.<os>-<arch> (the final job concatenates them into
#   SHASUMS256.txt).
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "usage: build-node-modules.sh <darwin|linux|win> <x64|arm64> <app-version> <dest> [package-dir]" >&2
  exit 2
fi
OS="$1"
ARCH="$2"
APP_VERSION="$3"
DEST="$4"
PKG_DIR="${5:-.}"

case "$OS" in darwin|linux|win) ;; *) echo "build-node-modules: bad os '$OS' (darwin|linux|win)" >&2; exit 2 ;; esac
case "$ARCH" in x64|arm64) ;; *) echo "build-node-modules: bad arch '$ARCH' (x64|arm64)" >&2; exit 2 ;; esac
[ -n "$APP_VERSION" ] || { echo "build-node-modules: empty app version" >&2; exit 2; }
[ -f "$PKG_DIR/package.json" ] && [ -f "$PKG_DIR/package-lock.json" ] || {
  echo "build-node-modules: $PKG_DIR needs package.json and package-lock.json" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd)"
ARCHIVE="node-modules-${OS}-${ARCH}.tar.gz"

cd "$PKG_DIR"
rm -rf node_modules
npm ci --omit=dev --omit=optional --ignore-scripts=false

# Fail the build if the native modules do not load on this platform.
node -e "require('sqlite3'); import('zstd-napi').then(function () {}, function (e) { console.error(e); process.exit(1); })"

tar -czf "$DEST_ABS/$ARCHIVE" node_modules

HASH="$(sha256_of "$DEST_ABS/$ARCHIVE")"
printf '%s  %s\n' "$HASH" "$ARCHIVE" > "$DEST_ABS/SHASUMS256.txt.${OS}-${ARCH}"
echo "build-node-modules: $ARCHIVE (app v${APP_VERSION}) -> $DEST_ABS"
