#!/usr/bin/env bash
# Thin NTConsult installer: verifies the release, runs the full installer and applies
# the NTConsult config. Usage:
#   curl -fsSL <blob>/install.sh | NTC_PILOT_CHAVE="$k" NTC_PILOT_EMAIL="$e" bash
# Env: NTC_PILOT_CHAVE (required), NTC_PILOT_EMAIL, NTC_PILOT_BLOB_URL,
#      NTC_PILOT_CHANNEL (stable|canary), NTC_PILOT_INSTALLER (tests), NTC_PILOT_DRY_RUN=1,
#      NTC_PILOT_SKIP_RESTART=1, NTC_PILOT_ALLOW_LOOPBACK_HTTP=1.
# The key is never echoed nor passed as an argument; only apply-config inherits it.
set -euo pipefail

DEFAULT_BLOB="https://stntconsultpilot.blob.core.windows.net/pilot"
BLOB="${NTC_PILOT_BLOB_URL:-$DEFAULT_BLOB}"
BLOB="${BLOB%/}"
CHANNEL="${NTC_PILOT_CHANNEL:-stable}"
DATA_DIR="$HOME/.loongsuite-pilot"
WORK=""

die() { echo "Erro: $*" >&2; exit 1; }

cleanup() { [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT

fetch() { # fetch <url> <dest>
  curl -fsSL --retry 2 -o "$2" "$1" || die "falha ao baixar $1"
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die "shasum/sha256sum nao encontrado"; fi
}

read_key() { # reads a field from the manifest file: read_key <file> <name>
  grep "^$2=" "$1" | head -n1 | cut -d= -f2- | tr -d '\r'
}

check_key() {
  [ -n "${NTC_PILOT_CHAVE:-}" ] || die "defina NTC_PILOT_CHAVE com a chave fornecida pela NTConsult"
  case "$NTC_PILOT_CHAVE" in
    ntcp_*) ;;
    *) die "NTC_PILOT_CHAVE em formato invalido (esperado ntcp_...)" ;;
  esac
  printf '%s' "$NTC_PILOT_CHAVE" | grep -Eq '^ntcp_[0-9A-Za-z]{32,}$' \
    || die "NTC_PILOT_CHAVE em formato invalido (esperado ntcp_...)"
}

verify_against_sums() { # verify_against_sums <sums> <dir> <name>
  local want got
  want="$(grep -E "^[0-9a-fA-F]{64}[ *]+$3\$" "$1" | head -n1 | cut -d' ' -f1)"
  [ -n "$want" ] || die "$3 ausente em SHA256SUMS"
  got="$(sha256_of "$2/$3")"
  [ "$got" = "$want" ] || die "sha256 de $3 nao confere; instalacao abortada"
}

resolve_node() {
  local n=""
  [ -f "$DATA_DIR/node-bin" ] && n="$(head -n1 "$DATA_DIR/node-bin" | tr -d '\r')"
  if [ -z "$n" ] || [ ! -x "$n" ]; then n="$(command -v node || true)"; fi
  [ -n "$n" ] || die "Node nao encontrado"
  printf '%s' "$n"
}

main() {
  echo "Configurando o SDLC NTConsult e o coletor de métricas."
  check_key
  case "$CHANNEL" in stable|canary) ;; *) die "NTC_PILOT_CHANNEL deve ser stable ou canary" ;; esac

  WORK="$(mktemp -d)"
  fetch "$BLOB/manifest/$CHANNEL.txt" "$WORK/channel.txt"
  local version package_url
  version="$(read_key "$WORK/channel.txt" version)"
  package_url="$(read_key "$WORK/channel.txt" package_url)"
  [ -n "$version" ] && [ -n "$package_url" ] || die "manifesto do canal $CHANNEL incompleto"
  printf '%s' "$version" | grep -Eq '^[0-9A-Za-z.+-]+$' || die "versao invalida no manifesto"

  if [ "${NTC_PILOT_DRY_RUN:-}" = "1" ]; then
    echo "[dry-run] canal=$CHANNEL versao=$version"
    echo "[dry-run] pacote=$package_url"
    echo "[dry-run] nada foi executado"
    return 0
  fi

  local rel="$BLOB/releases/$version"
  fetch "$rel/SHA256SUMS" "$WORK/SHA256SUMS"
  fetch "$rel/apply-config.mjs" "$WORK/apply-config.mjs"
  verify_against_sums "$WORK/SHA256SUMS" "$WORK" apply-config.mjs
  local installer="${NTC_PILOT_INSTALLER:-}"
  if [ -z "$installer" ]; then
    fetch "$rel/installer.sh" "$WORK/installer.sh"
    verify_against_sums "$WORK/SHA256SUMS" "$WORK" installer.sh
    installer="$WORK/installer.sh"
  fi

  # The installer never sees the key.
  env -u NTC_PILOT_CHAVE bash "$installer" install --version "$version" \
    --package-url "$package_url" --all-agents --userId "${NTC_PILOT_EMAIL:-}" \
    --collect-log false --interceptor-mode all

  local node apply_args=(--data-dir "$DATA_DIR")
  node="$(resolve_node)"
  [ "${NTC_PILOT_ALLOW_LOOPBACK_HTTP:-}" = "1" ] && apply_args+=(--allow-loopback-http)
  if [ "$CHANNEL" = "canary" ]; then export NTC_PILOT_CANARY=1; fi
  NTC_PILOT_BLOB_URL="$BLOB" "$node" "$WORK/apply-config.mjs" "${apply_args[@]}"

  if [ "${NTC_PILOT_SKIP_RESTART:-}" != "1" ]; then
    "$HOME/.local/bin/loongsuite-pilot" restart
    "$HOME/.local/bin/loongsuite-pilot" status || true
  fi
  echo "Concluído."
}

main "$@"
