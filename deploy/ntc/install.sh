#!/usr/bin/env bash
# Thin NTConsult installer: verifies the release, runs the full installer and applies
# the NTConsult config. Usage (interactive: asks for the key on the terminal, without echo):
#   curl -fsSL <blob>/install.sh | bash
# Automation only: set NTC_PILOT_CHAVE in the environment (a key typed on the command line
# or exported in an interactive shell ends up in the shell history; never do that by hand).
# Env: NTC_PILOT_CHAVE (automation; prompted when absent and a terminal exists), NTC_PILOT_EMAIL, NTC_PILOT_BLOB_URL,
#      NTC_PILOT_CHANNEL (stable|canary), NTC_PILOT_INSTALLER (tests), NTC_PILOT_DRY_RUN=1,
#      NTC_PILOT_SKIP_RESTART=1, NTC_PILOT_ALLOW_LOOPBACK_HTTP=1, NTC_PILOT_TTY (tests: file read
#      instead of /dev/tty for the key prompt).
# The key is never echoed nor passed as an argument; only apply-config inherits it.
#
# Trust model: the SHA256SUMS and the manifest come from the same origin (the blob) as
# the files they describe, so the hashes catch corruption and partial uploads, not a
# compromised blob. Transport is HTTPS-only (loopback http only for tests).
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

is_loopback_http() {
  [ "${NTC_PILOT_ALLOW_LOOPBACK_HTTP:-}" = "1" ] || return 1
  printf '%s' "$1" | grep -Eq '^http://(127\.0\.0\.1|localhost)(:[0-9]+)?(/|$)'
}

# require_https <name> <url>: https only, except the loopback test exception.
require_https() {
  case "$2" in https://*) return 0 ;; esac
  is_loopback_http "$2" && return 0
  die "$1 deve usar https://"
}

fetch() { # fetch <url> <dest>
  if is_loopback_http "$1"; then
    curl -fsSL --retry 2 -o "$2" "$1" || die "falha ao baixar $1"
  else
    curl -fsSL --retry 2 --proto '=https' --proto-redir '=https' -o "$2" "$1" \
      || die "falha ao baixar $1"
  fi
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else die "shasum/sha256sum nao encontrado"; fi
}

read_key() { # reads a field from the manifest file: read_key <file> <name>
  { grep "^$2=" "$1" || true; } | head -n1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

# The key prompt reads from the terminal, not from stdin (stdin is the script itself under `curl | bash`).
KEY_TTY="${NTC_PILOT_TTY:-/dev/tty}"

# True when NTC_PILOT_CHAVE is unset and the key can be asked for on a terminal. /dev/tty exists
# even without a controlling terminal, so test that it can actually be opened.
should_prompt_for_key() {
  [ -z "${NTC_PILOT_CHAVE:-}" ] && ( : < "$KEY_TTY" ) 2>/dev/null
}

prompt_for_key() {
  local k=""
  printf 'Chave NTConsult (ntcp_...): ' >&2
  IFS= read -rs k < "$KEY_TTY" || true
  printf '\n' >&2
  NTC_PILOT_CHAVE="$k"
  export NTC_PILOT_CHAVE
}

check_key() {
  if should_prompt_for_key; then prompt_for_key; fi
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
  want="$({ grep -E "^[0-9a-fA-F]{64}[ *]+$3\$" "$1" || true; } | head -n1 | cut -d' ' -f1)"
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
  require_https NTC_PILOT_BLOB_URL "$BLOB"
  case "$CHANNEL" in stable|canary) ;; *) die "NTC_PILOT_CHANNEL deve ser stable ou canary" ;; esac

  WORK="$(mktemp -d)"
  fetch "$BLOB/manifest/$CHANNEL.txt" "$WORK/channel.txt"
  local version package_url package_sha
  version="$(read_key "$WORK/channel.txt" version)"
  package_url="$(read_key "$WORK/channel.txt" package_url)"
  package_sha="$(read_key "$WORK/channel.txt" sha256)"
  [ -n "$version" ] && [ -n "$package_url" ] && [ -n "$package_sha" ] \
    || die "manifesto do canal $CHANNEL incompleto (version, package_url e sha256 sao obrigatorios)"
  printf '%s' "$package_url" | grep -Eq '^[^[:space:]]+$' || die "package_url invalido no manifesto"
  require_https package_url "$package_url"
  printf '%s' "$version" | grep -Eq '^[0-9A-Za-z.+-]+$' || die "versao invalida no manifesto"
  case "$version" in .|..) die "versao invalida no manifesto" ;; esac

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
  local pkg="$WORK/loongsuite-pilot.tar.gz"
  fetch "$package_url" "$pkg"
  [ "$(sha256_of "$pkg")" = "$package_sha" ] || die "sha256 do pacote nao confere com o manifesto; instalacao abortada"

  local installer="${NTC_PILOT_INSTALLER:-}"
  if [ -n "$installer" ]; then
    echo "Aviso: NTC_PILOT_INSTALLER definido; verificacao sha256 do instalador ignorada." >&2
  else
    fetch "$rel/installer.sh" "$WORK/installer.sh"
    verify_against_sums "$WORK/SHA256SUMS" "$WORK" installer.sh
    installer="$WORK/installer.sh"
  fi

  # The installer never sees the key.
  local inst_args=(install --version "$version" --package-url "file://$pkg" --all-agents)
  [ -n "${NTC_PILOT_EMAIL:-}" ] && inst_args+=(--userId "$NTC_PILOT_EMAIL")
  inst_args+=(--collect-log false --interceptor-mode all)
  env -u NTC_PILOT_CHAVE bash "$installer" "${inst_args[@]}" </dev/null

  local node apply_args=(--data-dir "$DATA_DIR")
  node="$(resolve_node)"
  [ "${NTC_PILOT_ALLOW_LOOPBACK_HTTP:-}" = "1" ] && apply_args+=(--allow-loopback-http)
  if [ "$CHANNEL" = "canary" ]; then export NTC_PILOT_CANARY=1; fi
  NTC_PILOT_BLOB_URL="$BLOB" "$node" "$WORK/apply-config.mjs" "${apply_args[@]}"

  # The restarted daemon must not inherit the key.
  unset NTC_PILOT_CHAVE
  if [ "${NTC_PILOT_SKIP_RESTART:-}" != "1" ]; then
    "$HOME/.local/bin/loongsuite-pilot" restart
    "$HOME/.local/bin/loongsuite-pilot" status || true
  fi
  echo "Concluído."
}

main "$@"
