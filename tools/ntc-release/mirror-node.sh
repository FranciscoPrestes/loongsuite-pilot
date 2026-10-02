#!/usr/bin/env bash
# Mirror the official Node.js archives the Pilot installers expect.
#
# Usage: mirror-node.sh [--only <os-arch>] <version> <dest>
#   Writes <dest>/<version>/{node-v<version>-<os-arch>.tar.gz|.zip, SHASUMS256.txt}
#   (the layout served under deps/node/<version>/). Every archive is verified
#   against the official SHASUMS256.txt. An existing destination file with
#   different content is never overwritten.
#   --only limits the download to one platform (e.g. linux-x64, win-x64).
set -euo pipefail

ONLY=""
if [ "${1:-}" = "--only" ]; then
  ONLY="${2:-}"
  [ -n "$ONLY" ] || { echo "mirror-node: --only needs a value" >&2; exit 2; }
  shift 2
fi
if [ "$#" -ne 2 ]; then
  echo "usage: mirror-node.sh [--only <os-arch>] <version> <dest>" >&2
  exit 2
fi
VERSION="$1"
DEST="$2"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "mirror-node: version must look like 22.22.2 (got '$VERSION')" >&2
  exit 2
fi

BASE_URL="https://nodejs.org/dist/v${VERSION}"
TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 win-x64"
if [ -n "$ONLY" ]; then
  case " $TARGETS " in
    *" $ONLY "*) TARGETS="$ONLY" ;;
    *) echo "mirror-node: unknown platform $ONLY (expected one of: $TARGETS)" >&2; exit 2 ;;
  esac
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

archive_name() {
  local os_arch="$1"
  if [ "$os_arch" = "win-x64" ]; then
    echo "node-v${VERSION}-win-x64.zip"
  else
    echo "node-v${VERSION}-${os_arch}.tar.gz"
  fi
}

TMP="$(mktemp -d)"
PENDING=""
cleanup() {
  rm -rf "$TMP"
  [ -z "$PENDING" ] || rm -f $PENDING
}
trap cleanup EXIT

fetch() {
  curl -fsSL --retry 3 --connect-timeout 20 --max-time 600 "$1" -o "$2"
}

fetch "${BASE_URL}/SHASUMS256.txt" "$TMP/SHASUMS256.txt"

OUT="${DEST%/}/${VERSION}"
mkdir -p "$OUT"

# Phase 1: download and verify everything against the official list. Nothing is
# written to the destination until every archive has passed.
for os_arch in $TARGETS; do
  name="$(archive_name "$os_arch")"
  expected="$(awk -v n="$name" '$2 == n {print $1}' "$TMP/SHASUMS256.txt")"
  [ -n "$expected" ] || { echo "mirror-node: SHASUMS256.txt has no entry for $name" >&2; exit 1; }
  echo "mirror-node: downloading $name"
  fetch "${BASE_URL}/${name}" "$TMP/$name"
  actual="$(sha256_of "$TMP/$name")"
  if [ "$actual" != "$expected" ]; then
    echo "mirror-node: checksum mismatch for $name" >&2
    exit 1
  fi
done

# Phase 2: refuse up front if any existing destination file differs.
NAMES=""
for os_arch in $TARGETS; do NAMES="$NAMES $(archive_name "$os_arch")"; done
NAMES="$NAMES SHASUMS256.txt"
for name in $NAMES; do
  dst="$OUT/$name"
  if [ -e "$dst" ] && [ "$(sha256_of "$TMP/$name")" != "$(sha256_of "$dst")" ]; then
    echo "mirror-node: refusing to overwrite $dst with different content" >&2
    exit 1
  fi
done

# Phase 3: place atomically (tmp + mv); SHASUMS256.txt goes last.
for name in $NAMES; do
  dst="$OUT/$name"
  if [ -e "$dst" ]; then
    echo "mirror-node: $name already present, identical"
    continue
  fi
  PENDING="$dst.tmp.$$"
  cp "$TMP/$name" "$PENDING"
  mv "$PENDING" "$dst"
  PENDING=""
done
echo "mirror-node: done -> $OUT"
