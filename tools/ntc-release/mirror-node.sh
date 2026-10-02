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
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "mirror-node: version must look like 22.22.2" >&2; exit 2 ;;
esac

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
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "${BASE_URL}/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"

OUT="${DEST%/}/${VERSION}"
mkdir -p "$OUT"

# Copy src to dst unless dst already exists; an existing file must be identical.
place() {
  local src="$1" dst="$2"
  if [ -e "$dst" ]; then
    if [ "$(sha256_of "$src")" = "$(sha256_of "$dst")" ]; then
      echo "mirror-node: $(basename "$dst") already present, identical"
      return 0
    fi
    echo "mirror-node: refusing to overwrite $dst with different content" >&2
    return 1
  fi
  cp "$src" "$dst"
}

for os_arch in $TARGETS; do
  name="$(archive_name "$os_arch")"
  expected="$(awk -v n="$name" '$2 == n {print $1}' "$TMP/SHASUMS256.txt")"
  [ -n "$expected" ] || { echo "mirror-node: SHASUMS256.txt has no entry for $name" >&2; exit 1; }
  echo "mirror-node: downloading $name"
  curl -fsSL "${BASE_URL}/${name}" -o "$TMP/$name"
  actual="$(sha256_of "$TMP/$name")"
  if [ "$actual" != "$expected" ]; then
    echo "mirror-node: checksum mismatch for $name" >&2
    exit 1
  fi
  place "$TMP/$name" "$OUT/$name"
done

# SHASUMS256.txt is the official file, served as-is for the installer to verify.
place "$TMP/SHASUMS256.txt" "$OUT/SHASUMS256.txt"
echo "mirror-node: done -> $OUT"
