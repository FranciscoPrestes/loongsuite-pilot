#!/usr/bin/env bash
# NTConsult fork: install the Pilot from the REAL blob, exactly as a developer would
# (`curl -fsSL <blob>/install.sh | bash`), inside a throwaway Linux container with no Node, no init system and
# the three Alibaba origins mapped to 127.0.0.1. Nothing is installed on the host (never run this install natively:
# the machine runs a production Pilot). The key is a synthetic ntcp_ test key, only ever an env var of this run.
#
# Usage: bash tools/ntc-e2e-blob.sh [blob-url]      (default: the production blob URL)
# PASS/FAIL per scenario; exit 1 on any FAIL. The container is removed on exit unless NTC_E2E_KEEP=1.
set -euo pipefail

BLOB="${1:-https://stntconsultpilot.blob.core.windows.net/pilot}"
NAME="ntc-e2e-blob-$$"
IMAGE="${NTC_E2E_IMAGE:-debian:bookworm-slim}"
KEY="ntcp_E2EBLOB$(printf 'A%.0s' $(seq 1 25))" # ntcp_ + 32 chars, not a credential
EMAIL="e2e@ntconsult.com.br"
ALIBABA="loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com cn-shanghai.log.aliyuncs.com"
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }

hosts=(); for h in $ALIBABA; do hosts+=(--add-host "$h:127.0.0.1"); done
OUT="$(mktemp)"
cleanup() { rm -f "$OUT"; [ "${NTC_E2E_KEEP:-}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" "${hosts[@]}" "$IMAGE" sleep infinity >/dev/null
docker exec "$NAME" bash -c 'apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates procps xz-utils unzip >/dev/null && useradd -m -s /bin/bash pilot'
asuser() { docker exec -u pilot -e HOME=/home/pilot "$@"; }
PD=/home/pilot/.loongsuite-pilot

# 1. install from the blob (ps sampled during the install to catch the key on a command line)
# sampler runs inside the container until a stop file appears (every 50 ms for the whole install)
docker exec -u pilot "$NAME" bash -c 'rm -f /tmp/stop; while [ ! -e /tmp/stop ]; do ps -eo args >> /tmp/ps.samples; sleep 0.05; done' &
SAMPLER=$!
sleep 1
if docker exec -u pilot -e HOME=/home/pilot -e NTC_PILOT_CHAVE="$KEY" -e NTC_PILOT_EMAIL="$EMAIL" -e NTC_PILOT_BLOB_URL="$BLOB" \
     -e NTC_PILOT_SKIP_RESTART=1 "$NAME" bash -c "set -o pipefail; curl -fsSL '$BLOB/install.sh' | bash" >"$OUT" 2>&1; then
  ok "install: curl <blob>/install.sh | bash exits 0"
else
  bad "install exited non-zero"; tail -20 "$OUT" | sed "s/$KEY/<chave>/g"
fi
docker exec -u pilot "$NAME" touch /tmp/stop; wait "$SAMPLER" 2>/dev/null || true

# 2. config.json: 0600, NTConsult fields, every URL points at the blob
mode="$(asuser "$NAME" stat -c '%a' "$PD/config.json" 2>/dev/null || echo none)"
[ "$mode" = 600 ] && ok "config.json mode 0600" || bad "config.json mode is $mode"
cfg="$(asuser "$NAME" cat "$PD/config.json" 2>/dev/null || true)"
chk() { printf '%s' "$cfg" | grep -q "$2" && ok "$1" || bad "$1 (missing: $2)"; }
chk "config: ingest endpoint" 'beat.ntconsult.ai/api/ingest/otlp'
chk "config: updater manifest from the blob" "$BLOB/manifest/latest.json"
chk "config: serviceName" '"serviceName": *"loongsuite-pilot"'
chk "config: turnIdleTimeoutMs" 'turnIdleTimeoutMs'
urls="$(printf '%s' "$cfg" | grep -E 'packageUrl|nodeDepsUrl|nodeModulesUrl' || true)"
[ "$(printf '%s\n' "$urls" | grep -c .)" -ge 3 ] || bad "config: expected packageUrl, nodeDepsUrl and nodeModulesUrl"
if printf '%s\n' "$urls" | grep -v "$BLOB" | grep -q .; then bad "config: an updater URL does not point at the blob"; else ok "config: packageUrl/nodeDepsUrl/nodeModulesUrl all on the blob"; fi

# 3. runtime: Node came from the blob mirror (the image has none), version dir is the release
nodebin="$(asuser "$NAME" head -n1 "$PD/node-bin" 2>/dev/null || true)"
[ -n "$nodebin" ] && asuser "$NAME" test -x "$nodebin" && ok "node from the blob mirror: $nodebin ($(asuser "$NAME" "$nodebin" -v))" || bad "no usable node-bin"
asuser "$NAME" bash -c 'command -v node >/dev/null' && bad "image unexpectedly had system node" || ok "image has no system node (so the mirror was used)"
ver="$(asuser "$NAME" bash -c "ls $PD/versions 2>/dev/null" | head -3 | tr '\n' ' ')"
want="$(curl -fsS "$BLOB/manifest/stable.txt" | sed -n 's/^version=//p')"
case "$ver" in *"${want:-none}"*) ok "version dir is the published stable ($want)" ;; *) bad "versions: $ver (stable is ${want:-unknown})" ;; esac
asuser "$NAME" bash -c "$PD/current/bin/loongsuite-pilot --help >/dev/null 2>&1 || ls $PD/current >/dev/null" && ok "current/ is usable" || bad "current/ not usable"

# 4. key hygiene: never on a command line, never in a file except config.json (by design, 0600)
if docker exec -u pilot "$NAME" grep -q "$KEY" /tmp/ps.samples 2>/dev/null; then bad "key seen in ps args"; else ok "key never in ps args (sampled every 50 ms during the whole install)"; fi
if docker exec "$NAME" bash -c 'grep -l "'"$KEY"'" /proc/[0-9]*/environ 2>/dev/null | head -1' | grep -q .; then bad "key in a process environment"; else ok "key in no process environment after install"; fi
hits="$(docker exec "$NAME" bash -c "grep -rl '$KEY' $PD --exclude-dir=versions 2>/dev/null || true")"
[ "$hits" = "$PD/config.json" ] && ok "key only in config.json" || bad "key found in: ${hits:-<none, config.json should hold it>}"
grep -q "$KEY" "$OUT" && bad "key printed by the installer" || ok "key not printed by the installer"

# 5. no Alibaba origin was contacted or referenced
if grep -qiE 'aliyuncs\.com|alibaba' "$OUT"; then bad "installer output mentions an Alibaba origin"; else ok "installer output has no Alibaba origin"; fi
docker exec "$NAME" bash -c "grep -rIl -iE 'aliyuncs\.com' $PD/config.json $PD/logs 2>/dev/null | head -1" | grep -q . \
  && bad "config/logs reference an Alibaba origin" || ok "config/logs have no Alibaba origin"

echo "----"; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
