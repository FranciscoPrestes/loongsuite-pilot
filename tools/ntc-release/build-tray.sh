#!/usr/bin/env bash
# Build the NT TES tray app (Tauri, app/tray) for one platform and archive it.
#
# Usage: build-tray.sh <os> <arch> <app-version> <dest> [repo-root]
#   os in darwin|linux|win, arch in x64|arm64 (same names as build-node-modules.sh).
#   Run on a runner of that os/arch with Rust and Node installed; on Linux the
#   webkit2gtk / appindicator dev packages must be present.
#   Writes <dest>/tray-<os>-<arch>.tar.gz and one line in
#   <dest>/SHASUMS256.txt.<os>-<arch> (assemble-stage.mjs --tray-dir concatenates them).
#
#   darwin  tar of "NT TES.app"
#   linux   tar of ntc-tes-tray + icon.png (the installer writes the desktop entry)
#   win     tar of ntc-tes-tray.exe
set -euo pipefail

if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
  echo "usage: build-tray.sh <darwin|linux|win> <x64|arm64> <app-version> <dest> [repo-root]" >&2
  exit 2
fi
OS="$1"
ARCH="$2"
APP_VERSION="$3"
DEST="$4"
ROOT="${5:-$(cd "$(dirname "$0")/../.." && pwd)}"

case "$OS" in darwin|linux|win) ;; *) echo "build-tray: bad os '$OS' (darwin|linux|win)" >&2; exit 2 ;; esac
case "$ARCH" in x64|arm64) ;; *) echo "build-tray: bad arch '$ARCH' (x64|arm64)" >&2; exit 2 ;; esac
if ! [[ "$APP_VERSION" =~ ^[0-9A-Za-z._+-]+$ ]] || [ "$APP_VERSION" = "." ] || [ "$APP_VERSION" = ".." ]; then
  echo "build-tray: invalid app version '$APP_VERSION'" >&2
  exit 2
fi
TRAY_DIR="$ROOT/app/tray"
[ -f "$TRAY_DIR/package.json" ] && [ -f "$TRAY_DIR/src-tauri/Cargo.toml" ] || {
  echo "build-tray: $TRAY_DIR is not the tray app (package.json / src-tauri/Cargo.toml missing)" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

mkdir -p "$DEST"
DEST_ABS="$(cd "$DEST" && pwd)"
ARCHIVE="tray-${OS}-${ARCH}.tar.gz"
RELEASE_DIR="$TRAY_DIR/src-tauri/target/release"

cd "$TRAY_DIR"
npm ci

case "$OS" in
  darwin)
    npx tauri build --bundles app --ci
    COPYFILE_DISABLE=1 tar -czf "$DEST_ABS/$ARCHIVE" -C "$RELEASE_DIR/bundle/macos" "NT TES.app"
    ;;
  linux)
    npx tauri build --no-bundle --ci
    STAGE="$(mktemp -d)"
    trap 'rm -rf "$STAGE"' EXIT
    cp "$RELEASE_DIR/ntc-tes-tray" "$STAGE/ntc-tes-tray"
    cp "$TRAY_DIR/src-tauri/icons/128x128.png" "$STAGE/icon.png"
    tar -czf "$DEST_ABS/$ARCHIVE" -C "$STAGE" ntc-tes-tray icon.png
    ;;
  win)
    npx tauri build --no-bundle --ci
    tar -czf "$DEST_ABS/$ARCHIVE" -C "$RELEASE_DIR" ntc-tes-tray.exe
    ;;
esac

HASH="$(sha256_of "$DEST_ABS/$ARCHIVE")"
printf '%s  %s\n' "$HASH" "$ARCHIVE" > "$DEST_ABS/SHASUMS256.txt.${OS}-${ARCH}"
echo "build-tray: $ARCHIVE (app v${APP_VERSION}) -> $DEST_ABS"
