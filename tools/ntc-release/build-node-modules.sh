#!/usr/bin/env bash
# Build the prebuilt production node_modules archive for one platform.
#
# Usage: build-node-modules.sh <os> <arch> <app-version> <dest> <package-dir> [node-version]
#   os in darwin|linux|win, arch in x64|arm64 (same names as managed_node_platform
#   in the installers). Run with the managed Node already active on PATH.
#   package-dir (required) is the extracted release package; it must contain
#   package.json and package-lock.json.
#   The running node must be v<NTC_NODE_VERSION> (default 22.22.2); the optional
#   6th argument overrides the env var. The build fails on any other version.
#   Writes <dest>/node-modules-<os>-<arch>.tar.gz and a single line in
#   <dest>/SHASUMS256.txt.<os>-<arch> (the final job concatenates them into
#   SHASUMS256.txt).
set -euo pipefail

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
  echo "usage: build-node-modules.sh <darwin|linux|win> <x64|arm64> <app-version> <dest> <package-dir> [node-version]" >&2
  exit 2
fi
OS="$1"
ARCH="$2"
APP_VERSION="$3"
DEST="$4"
PKG_DIR="$5"
NODE_WANT="${6:-${NTC_NODE_VERSION:-22.22.2}}"

case "$OS" in darwin|linux|win) ;; *) echo "build-node-modules: bad os '$OS' (darwin|linux|win)" >&2; exit 2 ;; esac
case "$ARCH" in x64|arm64) ;; *) echo "build-node-modules: bad arch '$ARCH' (x64|arm64)" >&2; exit 2 ;; esac
if ! [[ "$APP_VERSION" =~ ^[0-9A-Za-z._+-]+$ ]] || [ "$APP_VERSION" = "." ] || [ "$APP_VERSION" = ".." ]; then
  echo "build-node-modules: invalid app version '$APP_VERSION'" >&2
  exit 2
fi
if ! [[ "$NODE_WANT" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-node-modules: invalid node version '$NODE_WANT'" >&2
  exit 2
fi
[ -f "$PKG_DIR/package.json" ] && [ -f "$PKG_DIR/package-lock.json" ] || {
  echo "build-node-modules: $PKG_DIR needs package.json and package-lock.json" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

NODE_HAVE="$(node -v)"
if [ "$NODE_HAVE" != "v${NODE_WANT}" ]; then
  echo "build-node-modules: node is $NODE_HAVE, expected v${NODE_WANT}" >&2
  exit 1
fi

mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd)"
ARCHIVE="node-modules-${OS}-${ARCH}.tar.gz"

cd "$PKG_DIR"
rm -rf node_modules
npm ci --omit=dev --omit=optional --ignore-scripts=false

# Fail the build if the SQLite compat shim or the Node builtin it relies on do not load.
node -e "require('sqlite3'); require('node:sqlite')"

COPYFILE_DISABLE=1 tar -czf "$DEST_ABS/$ARCHIVE" node_modules

HASH="$(sha256_of "$DEST_ABS/$ARCHIVE")"
printf '%s  %s\n' "$HASH" "$ARCHIVE" > "$DEST_ABS/SHASUMS256.txt.${OS}-${ARCH}"
echo "build-node-modules: $ARCHIVE (app v${APP_VERSION}) -> $DEST_ABS"
