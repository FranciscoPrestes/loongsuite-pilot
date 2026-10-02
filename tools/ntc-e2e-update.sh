#!/usr/bin/env bash
# NTConsult fork: Docker end-to-end test of the live updater swap without any Alibaba origin
# (task 10 of the phase-1 plan). Nothing here installs or starts the Pilot on the host: every
# install runs in a throwaway Linux container without systemd, as an ordinary user, with the
# three Alibaba origins mapped to 127.0.0.1 and no network besides loopback.
#
# Usage:
#   bash tools/ntc-e2e-update.sh --build [--blob-dir DIR] [--keep]   build image, packages and blob, then test
#   bash tools/ntc-e2e-update.sh --blob-dir DIR [--keep]             rerun the scenarios on a cached blob
# --blob-dir  where the built blob lives (default: a temp dir, removed on exit unless --keep)
# --keep      keep the containers and temp dirs for inspection
#
# Scenarios (PASS/FAIL each):
#   1 install 1.2.0-ntc.1 with the thin install.sh from the local blob; config.json 0600 + task-5 fields
#   2 real updater (run-updater, 5 s interval): publishing 1.2.0-ntc.2 as stable swaps `current`
#     within 90 s, runtime and node_modules from the blob, config.json preserved
#   3 manual `loongsuite-pilot upgrade` (no --version) lands on stable via installer.sh + releases/latest/
#   4 no contact with any Alibaba origin (honeypot on 127.0.0.1:80/443 + grep of every log)
#   5 the key never shows in `ps -eo args` (sampled during the install) nor in process environments
# Containers have no init system: scenarios 1-2 run with no sudo (collector/updater started with
# `loongsuite-pilot run` / `run-updater`, restarts use the CLI nohup fallback); scenario 3 grants the
# user passwordless sudo so `start` can register the SysV init.d service the installer needs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="tools/ntc-e2e-update.sh"
NODE_VERSION="22.22.2"
BASE_IMAGE="node:${NODE_VERSION}-bookworm"
IMAGE="ntc-pilot-e2e:${NODE_VERSION}"
V1="1.2.0-ntc.1"
V2="1.2.0-ntc.2"
BLOB_URL="http://127.0.0.1:8080/pilot"
PLACEHOLDER="https://placeholder.invalid/pilot"
TEST_KEY="ntcp_E2EAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" # test key (ntcp_ + 32 chars), not a credential
TEST_EMAIL="e2e@ntconsult.com.br"
ENDPOINT="https://beat.ntconsult.ai/api/ingest/otlp"
PH="/home/pilot"
PD="$PH/.loongsuite-pilot"
ALIBABA_HOSTS="loongcollector-community-edition.oss-cn-shanghai.aliyuncs.com aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com cn-shanghai.log.aliyuncs.com"
SWAP_LIMIT=90

# ───────────────────────── builder (runs inside the image as root) ─────────────────────────
inside_build() {
  local out=/work arch commit v prev="" sha
  case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64) arch=x64 ;; *) echo "unsupported arch" >&2; exit 1 ;; esac
  git config --global --add safe.directory '*'
  git clone -q /src /build/repo
  cd /build/repo
  commit="$(git rev-parse --short HEAD)"
  npm ci --no-audit --no-fund
  mkdir -p "$out/blob/pilot" "$out/manifests"
  for v in "$V1" "$V2"; do
    echo "==> packaging $v"
    npm version "$v" --no-git-tag-version --allow-same-version >/dev/null
    local skip=""; [ "$v" = "$V2" ] && skip="--skip-build" # second version differs only in VERSION
    # shellcheck disable=SC2086
    NTC_BLOB_BASE_URL="$BLOB_URL" NTC_INSTALLERS_OUT="/build/inst-$v" \
      bash deploy/package-opensource.sh -o "/build/pkg-$v/loongsuite-pilot.tar.gz" $skip
    mkdir -p "/build/rel-$v" "/build/x-$v"
    cp "/build/pkg-$v/loongsuite-pilot.tar.gz" "/build/pkg-$v/loongsuite-pilot.zip" "/build/inst-$v/installer.sh" \
      "/build/inst-$v/installer.ps1" deploy/ntc/apply-config.mjs "/build/rel-$v/"
    tar -xzf "/build/rel-$v/loongsuite-pilot.tar.gz" -C "/build/x-$v"
    bash tools/ntc-release/build-node-modules.sh linux "$arch" "$v" "/build/nm-$v" "/build/x-$v/loongsuite-pilot" "$NODE_VERSION"
    sha="$(E2E_V="$v" E2E_ARCH="$arch" node --input-type=module -e "
      import { assembleStage } from '/build/repo/tools/ntc-release/assemble-stage.mjs';
      const v = process.env.E2E_V;
      const r = assembleStage({ version: v, pkgDir: '/build/rel-' + v, thinDir: 'deploy/ntc',
        nodeModulesDir: '/build/nm-' + v, out: '/build/stage-' + v, platforms: ['linux-' + process.env.E2E_ARCH] });
      process.stdout.write(r.sha256);")"
    cp -a "/build/stage-$v/." "$out/blob/pilot/"
    # The manifest CLI insists on https; the placeholder is rewritten to the loopback blob after.
    local prev_args=()
    [ -n "$prev" ] && prev_args=(--prev "$(cat "$out/manifests/$prev-raw/latest.json")")
    node tools/ntc-release/cli.mjs manifest --action promote "${prev_args[@]}" --version "$v" \
      --git-commit "$commit" --package-url "$PLACEHOLDER/releases/$v/loongsuite-pilot.tar.gz" \
      --sha256 "$sha" --released-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --out-dir "$out/manifests/$v-raw"
    mkdir -p "$out/manifests/$v"
    for f in latest.json stable.txt; do
      sed "s#$PLACEHOLDER#$BLOB_URL#g" "$out/manifests/$v-raw/$f" > "$out/manifests/$v/$f"
    done
    prev="$v"
  done
  bash tools/ntc-release/mirror-node.sh --only "linux-$arch" "$NODE_VERSION" "$out/blob/pilot/deps/node"
  printf 'COMMIT=%s\nARCH=%s\n' "$commit" "$arch" > "$out/meta.env"
  chown -R "${HOST_UID:-0}:${HOST_GID:-0}" "$out"
}

if [ "${1:-}" = "--inside-build" ]; then inside_build; exit 0; fi

# ───────────────────────── host side ─────────────────────────
BUILD=0; KEEP=0; WORK=""; OWN_WORK=0; LOGS=""; CONTAINERS=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --build) BUILD=1; shift ;;
    --keep) KEEP=1; shift ;;
    --blob-dir) WORK="${2:?--blob-dir needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cleanup() {
  local rc=$?
  if [ "$KEEP" = 1 ]; then
    echo "kept: containers [${CONTAINERS# }] work $WORK logs $LOGS"
    return "$rc"
  fi
  for c in $CONTAINERS; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  [ "$OWN_WORK" = 1 ] && [ -n "$WORK" ] && rm -rf "$WORK"
  [ "$rc" = 0 ] && [ -n "$LOGS" ] && rm -rf "$LOGS"
  [ "$rc" != 0 ] && [ -n "$LOGS" ] && echo "logs kept in $LOGS"
  return "$rc"
}
trap cleanup EXIT

if [ -z "$WORK" ]; then
  [ "$BUILD" = 1 ] || { echo "without --build, pass --blob-dir of a previous build" >&2; exit 2; }
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/ntc-e2e.XXXXXX")"; OWN_WORK=1
fi
mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
LOGS="$(mktemp -d "${TMPDIR:-/tmp}/ntc-e2e-logs.XXXXXX")"
BLOB="$WORK/blob/pilot"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

build_image() {
  log "building image $IMAGE"
  docker build -q -t "$IMAGE" - >/dev/null <<EOF
FROM $BASE_IMAGE
RUN apt-get update && apt-get install -y --no-install-recommends sudo zip \
 && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash pilot
EOF
}

build_blob() {
  rm -rf "$WORK/blob" "$WORK/manifests" "$WORK/meta.env"
  log "building $V1 and $V2, node_modules and the node mirror in $BASE_IMAGE (takes a few minutes)"
  docker run --rm -v "$REPO:/src:ro" -v "$WORK:/work" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    "$IMAGE" bash "/src/$SELF" --inside-build > "$LOGS/build.log" 2>&1 \
    || { tail -40 "$LOGS/build.log"; echo "build failed (full log: $LOGS/build.log)" >&2; exit 1; }
}

write_helpers() {
  mkdir -p "$WORK/e2e"
  cat > "$WORK/e2e/honeypot.py" <<'EOF'
# Records every connection to 127.0.0.1:80/443 (where the blocked origins resolve). The TLS
# ClientHello carries the SNI, so a hit names the host that was contacted.
import socket, threading, time
def serve(port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('127.0.0.1', port)); s.listen(64)
    while True:
        c, _ = s.accept(); c.settimeout(3)
        try: data = c.recv(4096)
        except Exception: data = b''
        c.close()
        text = ''.join(chr(b) if 32 <= b < 127 else '.' for b in data)
        with open('/var/log/honeypot.log', 'a') as f:
            f.write('%s port=%d bytes=%d %s\n' % (time.strftime('%H:%M:%S'), port, len(data), text[:600]))
for p in (80, 443): threading.Thread(target=serve, args=(p,), daemon=True).start()
while True: time.sleep(3600)
EOF
  cat > "$WORK/e2e/check-config.mjs" <<'EOF'
// snapshot: mode + hashes of otlpTrace/autoUpdate + installId (never prints the key).
// fields: checks the task-5 contract; prints one FIELD line per mismatch.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
const file = `${process.env.HOME}/.loongsuite-pilot/config.json`;
const cfg = JSON.parse(readFileSync(file, 'utf8'));
const mode = (statSync(file).mode & 0o777).toString(8);
const h = (v) => createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16);
if (process.argv[2] === 'snapshot') {
  console.log(`mode=${mode} otlpTrace=${h(cfg.otlpTrace)} autoUpdate=${h(cfg.autoUpdate)} installId=${cfg.installId ?? ''}`);
  process.exit(0);
}
const blob = process.env.E2E_BLOB_URL;
const fails = [];
const eq = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(`${name}=${JSON.stringify(got)} expected ${JSON.stringify(want)}`);
};
const t = cfg.otlpTrace ?? {};
eq('mode', mode, '600');
eq('serviceName', cfg.serviceName, 'loongsuite-pilot');
eq('userId', cfg.userId, process.env.E2E_EMAIL);
eq('otlpTrace.endpoint', t.endpoint, process.env.E2E_ENDPOINT);
if (t.headers?.Authorization !== `Bearer ${process.env.E2E_KEY}`) fails.push('otlpTrace.headers.Authorization does not match the test key');
eq('otlpTrace.captureMessageContent', t.captureMessageContent, true);
eq('otlpTrace.spanAttributePassthroughPrefixes', t.spanAttributePassthroughPrefixes, ['agent.copilot.']);
eq('otlpTrace.maxExportBatchBytes', t.maxExportBatchBytes, 8388608);
eq('otlpTrace.turnIdleTimeoutMs', t.turnIdleTimeoutMs, 300000);
eq('retention.otlpFailedDays', cfg.retention?.otlpFailedDays, 30);
eq('retention.otlpFailedMaxTotalMiB', cfg.retention?.otlpFailedMaxTotalMiB, 2048);
eq('autoUpdate.enabled', cfg.autoUpdate?.enabled, true);
eq('autoUpdate.manifestUrl', cfg.autoUpdate?.manifestUrl, `${blob}/manifest/latest.json`);
eq('autoUpdate.packageUrl', cfg.autoUpdate?.packageUrl, `${blob}/releases/latest/loongsuite-pilot.tar.gz`);
eq('autoUpdate.nodeDepsUrl', cfg.autoUpdate?.nodeDepsUrl, `${blob}/deps/node`);
eq('autoUpdate.nodeModulesUrl', cfg.autoUpdate?.nodeModulesUrl, `${blob}/deps/node-modules`);
for (const f of fails) console.log(`FIELD ${f}`);
process.exit(fails.length ? 1 : 0);
EOF
}

# put <src> <dst>: tmp + rename, so the polling updater never reads a partial file.
put() { mkdir -p "$(dirname "$2")"; cp "$1" "$2.tmp.$$"; mv "$2.tmp.$$" "$2"; }

# Emulates ntc-promote: aliases, root installers and thin entry points, then the manifest (latest.json last).
publish_stable() {
  local v="$1" rel="$BLOB/releases/$1"
  put "$rel/loongsuite-pilot.tar.gz" "$BLOB/releases/latest/loongsuite-pilot.tar.gz"
  put "$rel/loongsuite-pilot.zip" "$BLOB/releases/latest/loongsuite-pilot.zip"
  put "$rel/installer.sh" "$BLOB/installer.sh"
  put "$rel/installer.ps1" "$BLOB/installer.ps1"
  put "$rel/thin/install.sh" "$BLOB/install.sh"
  put "$rel/thin/install.ps1" "$BLOB/install.ps1"
  rm -f "$BLOB/manifest/canary.txt"
  put "$WORK/manifests/$v/stable.txt" "$BLOB/manifest/stable.txt"
  put "$WORK/manifests/$v/latest.json" "$BLOB/manifest/latest.json"
  log "published $v as stable"
}

# ───────────────────────── container helpers ─────────────────────────
ERRORS=""
fail() { ERRORS="${ERRORS}    - $*"$'\n'; }
asu() { docker exec -u pilot "$C" bash -c "$1"; }       # run as the ordinary user
aroot() { docker exec -u root "$C" bash -c "$1"; }
# wait_for <seconds> <bash condition as pilot>; prints the elapsed seconds
wait_for() {
  local start; start=$(date +%s)
  while ! asu "$2" >/dev/null 2>&1; do
    [ $(( $(date +%s) - start )) -ge "$1" ] && return 1
    sleep 1
  done
  echo $(( $(date +%s) - start ))
}
access_has() { aroot "grep -E '\"GET $1 HTTP/1\\.[01]\" 200' /var/log/blob-access.log" >/dev/null 2>&1; }

start_container() {
  C="$1"
  local hosts=() h
  for h in $ALIBABA_HOSTS; do hosts+=(--add-host "$h:127.0.0.1"); done
  docker rm -f "$C" >/dev/null 2>&1 || true
  docker run -d --init --name "$C" --network none "${hosts[@]}" \
    -v "$WORK/blob:/srv/blob:ro" -v "$WORK/e2e:/opt/e2e:ro" "$IMAGE" sleep infinity >/dev/null
  CONTAINERS="$CONTAINERS $C"
  docker exec -d -u root "$C" bash -c 'cd /srv/blob && exec python3 -u -m http.server 8080 --bind 127.0.0.1 >>/var/log/blob-access.log 2>&1'
  docker exec -d -u root "$C" python3 -u /opt/e2e/honeypot.py
  docker exec -d -u root "$C" bash -c 'while :; do ps -eo args >> /var/log/ps-samples.log; sleep 0.2; done'
  wait_for 20 "curl -fsS -o /dev/null $BLOB_URL/manifest/stable.txt" >/dev/null || { echo "blob server did not start in $C" >&2; return 1; }
  # Prove the block and the detector: a deliberate call to a blocked origin must hit the honeypot.
  asu "curl -sS -m 5 -o /dev/null https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/probe" >/dev/null 2>&1 || true
  sleep 1
  aroot "grep -q aliyuncs /var/log/honeypot.log" || { echo "honeypot did not catch the probe in $C" >&2; return 1; }
  aroot ": > /var/log/honeypot.log"
}

thin_install() { # thin_install <log> [extra -e NAME=VALUE...]; the key goes by name, never on a command line
  local logf="$1"; shift
  NTC_PILOT_CHAVE="$TEST_KEY" docker exec -u pilot -e NTC_PILOT_CHAVE -e NTC_PILOT_EMAIL="$TEST_EMAIL" \
    -e NTC_PILOT_BLOB_URL="$BLOB_URL" -e NTC_PILOT_ALLOW_LOOPBACK_HTTP=1 "$@" "$C" \
    bash -c 'curl -fsSL "$NTC_PILOT_BLOB_URL/install.sh" | bash' > "$logf" 2>&1
}

check_fields() {
  local out
  out="$(E2E_KEY="$TEST_KEY" docker exec -u pilot -e E2E_KEY -e E2E_BLOB_URL="$BLOB_URL" -e E2E_EMAIL="$TEST_EMAIL" \
    -e E2E_ENDPOINT="$ENDPOINT" "$C" node /opt/e2e/check-config.mjs fields 2>&1)" || fail "config.json: $(echo "$out" | tr '\n' ';')"
}
snapshot() { asu "node /opt/e2e/check-config.mjs snapshot"; }
# count_procs / pids_of take a bracketed regex ('[u]pdater-daemon') so the bash -c running pgrep never matches itself.
count_procs() { aroot "pgrep -fc '$1'" || true; }
pids_of() { aroot "pgrep -f '$1' | tr '\n' ' '" || true; }

collect() { # collect <name>: copy the container logs to the host logs dir
  mkdir -p "$LOGS/$1"
  docker cp "$C:$PD/logs" "$LOGS/$1/pilot-logs" >/dev/null 2>&1 || true
  for f in blob-access.log honeypot.log; do docker cp "$C:/var/log/$f" "$LOGS/$1/$f" >/dev/null 2>&1 || true; done
}

RESULTS=""
record() { # record <n> <title> [log files to show on failure...]
  local n="$1" title="$2"; shift 2
  if [ -z "$ERRORS" ]; then
    RESULTS="${RESULTS}PASS scenario $n: $title"$'\n'; log "PASS scenario $n: $title"
  else
    RESULTS="${RESULTS}FAIL scenario $n: $title"$'\n'"$ERRORS"
    log "FAIL scenario $n: $title"; printf '%s' "$ERRORS"
    local f; for f in "$@"; do [ -f "$f" ] && { echo "    --- tail $f"; tail -25 "$f" | sed 's/^/    | /'; }; done
  fi
  ERRORS=""
}

# ───────────────────────── scenarios ─────────────────────────
VD1=""; VD2=""; NODE_PIN=""

scenario1() {
  log "scenario 1: thin install of $V1 (container ntc-e2e-a, no init system, no sudo)"
  publish_stable "$V1"
  start_container ntc-e2e-a
  # The default thin install ends with `loongsuite-pilot restart`, which needs a service manager
  # (systemd/launchd/init.d via sudo); here the daemons are started by hand in scenario 2.
  thin_install "$LOGS/a-install.log" -e NTC_PILOT_SKIP_RESTART=1 || fail "install.sh exited non-zero"
  [ "$(asu "cat $PD/current")" = "$VD1" ] || fail "current is '$(asu "cat $PD/current" 2>&1)', expected $VD1"
  check_fields
  [ "$(asu "cat $PD/node-bin")" = "$NODE_PIN" ] || fail "node-bin is '$(asu "cat $PD/node-bin" 2>&1)', expected $NODE_PIN"
  access_has "/pilot/deps/node/$NODE_VERSION/node-v$NODE_VERSION-linux-$ARCH.tar.gz" || fail "managed node not downloaded from the blob"
  access_has "/pilot/deps/node-modules/$V1/node-modules-linux-$ARCH.tar.gz" || fail "node_modules for $V1 not downloaded from the blob"
  grep -qiE 'falling back to npm install|npm install' "$LOGS/a-install.log" && fail "installer fell back to npm install"
  asu "test -f $PD/bin/updater-daemon.js" || fail "bin/updater-daemon.js missing (finding A1)"
  record 1 "thin install of $V1, config.json 0600 + task-5 fields" "$LOGS/a-install.log"
}

scenario2() {
  log "scenario 2: live updater swap $V1 -> $V2"
  C=ntc-e2e-a
  local s0 s1 s2 dt upd0
  s0="$(snapshot)"
  docker exec -d -u pilot "$C" bash -c "exec $PH/.local/bin/loongsuite-pilot run >>$PD/logs/e2e-collector-stdout.log 2>&1"
  wait_for 60 "grep -q '\"status\": *\"active\"' $PD/logs/runtime.json && grep -q '\"packageVersion\": *\"$V1\"' $PD/logs/runtime.json" >/dev/null \
    || fail "collector $V1 did not become active within 60 s"
  docker exec -d -u pilot -e LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS=5000 "$C" \
    bash -c "exec $PH/.local/bin/loongsuite-pilot run-updater >>$PD/logs/e2e-updater-stdout.log 2>&1"
  wait_for 45 "node -e 'process.exit(require(\"$PD/config.json\").installId ? 0 : 1)'" >/dev/null \
    || fail "updater did not complete a first check (no installId) within 45 s"
  s1="$(snapshot)"
  upd0="$(pids_of '[u]pdater-daemon')"
  publish_stable "$V2"
  if dt="$(wait_for "$SWAP_LIMIT" "[ \"\$(cat $PD/current)\" = \"$VD2\" ]")"; then
    log "current -> $VD2 after ${dt}s (brief target 60 s, limit ${SWAP_LIMIT} s)"
    SWAP_SECONDS="$dt"
  else
    fail "current did not swap to $VD2 within ${SWAP_LIMIT} s (it is '$(asu "cat $PD/current" 2>&1)')"
  fi
  wait_for 60 "grep -q '\"packageVersion\": *\"$V2\"' $PD/logs/runtime.json && grep -q '\"status\": *\"active\"' $PD/logs/runtime.json" >/dev/null \
    || fail "collector $V2 not active within 60 s of the swap"
  # The updater hands over to a fresh updater 10 s after the swap (schedule-updater-restart, nohup
  # fallback here): expect a new updater PID, then exactly one collector and one updater.
  wait_for 60 "p=\$(pgrep -f '[u]pdater-daemon' | tr '\n' ' '); [ -n \"\$p\" ] && [ \"\$p\" != '$upd0' ]" >/dev/null \
    || fail "updater was not restarted after the swap (PIDs still '$upd0')"
  sleep 5
  [ "$(count_procs '[c]ollector-daemon')" = 1 ] || fail "expected 1 collector process, found $(count_procs '[c]ollector-daemon')"
  [ "$(count_procs '[u]pdater-daemon')" = 1 ] || fail "expected 1 updater process, found $(count_procs '[u]pdater-daemon')"
  [ "$(asu "cat $PD/previous" 2>/dev/null)" = "$VD1" ] || fail "previous is not $VD1"
  access_has "/pilot/manifest/latest.json" || fail "manifest not fetched from the blob"
  access_has "/pilot/releases/$V2/loongsuite-pilot.tar.gz" || fail "$V2 package not downloaded from the blob"
  access_has "/pilot/deps/node-modules/$V2/node-modules-linux-$ARCH.tar.gz" || fail "$V2 node_modules not downloaded from the blob"
  [ "$(asu "cat $PD/versions/$VD2/node_modules/.pilot-modules-version" 2>/dev/null)" = "$V2 linux $ARCH" ] \
    || fail "versions/$VD2/node_modules is not the prebuilt archive (.pilot-modules-version)"
  asu "grep -rqiE 'falling back to npm install|running npm install' $PD/logs" && fail "updater fell back to npm install"
  [ "$(asu "cat $PD/node-bin")" = "$NODE_PIN" ] || fail "node-bin is not the blob runtime $NODE_PIN"
  s2="$(snapshot)"
  log "config snapshots: install[$s0] first-check[$s1] after-swap[$s2]"
  [ "${s0%% installId=*}" = "${s2%% installId=*}" ] || fail "config.json otlpTrace/autoUpdate/mode changed: [$s0] -> [$s2]"
  case "$s2" in *"mode=600 "*) ;; *) fail "config.json mode is not 600 after the swap: $s2" ;; esac
  [ "${s1##*installId=}" = "${s2##*installId=}" ] && [ -n "${s2##*installId=}" ] || fail "installId not preserved: [$s1] -> [$s2]"
  check_fields
  collect a
  record 2 "live updater swap to $VD2 (${SWAP_SECONDS:-n/a} s)" "$LOGS/a/pilot-logs/e2e-updater-stdout.log" \
    "$LOGS/a/pilot-logs/loongsuite-pilot-updater.log" "$LOGS/a/pilot-logs/e2e-collector-stdout.log"
}

scenario3() {
  log "scenario 3: manual upgrade (container ntc-e2e-b, init.d via passwordless sudo)"
  publish_stable "$V1"
  start_container ntc-e2e-b
  aroot "echo 'pilot ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pilot && chmod 0440 /etc/sudoers.d/pilot"
  log "sudo environment: $(asu 'sudo -n env | grep -E "^(HOME|USER)=" | tr "\n" " "')"
  thin_install "$LOGS/b-install.log" || fail "install.sh (with restart) exited non-zero"
  [ "$(asu "cat $PD/current")" = "$VD1" ] || fail "install did not land on $VD1"
  asu "$PH/.local/bin/loongsuite-pilot stop" > "$LOGS/b-stop.log" 2>&1 || fail "loongsuite-pilot stop failed"
  publish_stable "$V2"
  local mark; mark="$(aroot 'wc -l < /var/log/blob-access.log' | tr -d ' ')"
  asu "$PH/.local/bin/loongsuite-pilot upgrade" > "$LOGS/b-upgrade.log" 2>&1 || fail "loongsuite-pilot upgrade exited non-zero"
  [ "$(asu "cat $PD/current")" = "$VD2" ] || fail "current is '$(asu "cat $PD/current" 2>&1)', expected $VD2"
  aroot "tail -n +$((mark + 1)) /var/log/blob-access.log" > "$LOGS/b-upgrade-access.log"
  grep -qE '"GET /pilot/installer.sh HTTP/1\.[01]" 200' "$LOGS/b-upgrade-access.log" || fail "installer.sh not fetched from the blob"
  grep -qE '"GET /pilot/releases/latest/loongsuite-pilot.tar.gz HTTP/1\.[01]" 200' "$LOGS/b-upgrade-access.log" \
    || fail "releases/latest/loongsuite-pilot.tar.gz not fetched from the blob"
  asu "$PH/.local/bin/loongsuite-pilot status" > "$LOGS/b-status.log" 2>&1 || true
  grep -q "is running" "$LOGS/b-status.log" || fail "collector not running after the upgrade (see b-status.log)"
  check_fields
  collect b
  record 3 "manual upgrade to $VD2 from the blob stable" "$LOGS/b-upgrade.log" "$LOGS/b-install.log"
}

scenario4() {
  log "scenario 4: no Alibaba origin contacted"
  local c hits
  for c in $CONTAINERS; do
    C="$c"
    hits="$(aroot 'cat /var/log/honeypot.log')"
    [ -z "$hits" ] || fail "$c: connection(s) to a blocked origin: $(echo "$hits" | head -3 | tr '\n' ';')"
    hits="$(aroot "grep -rIl -iE 'aliyuncs|ECONNREFUSED 127\\.0\\.0\\.1:(80|443)' $PD/logs /var/log/blob-access.log 2>/dev/null" || true)"
    [ -z "$hits" ] || fail "$c: aliyuncs/refused connection in logs: $(echo "$hits" | tr '\n' ' ')"
  done
  hits="$(grep -lE 'aliyuncs' "$LOGS"/[ab]-*.log 2>/dev/null || true)"
  [ -z "$hits" ] || fail "installer/upgrade output mentions aliyuncs: $hits"
  record 4 "no log or connection to the three Alibaba origins"
}

scenario5() {
  log "scenario 5: the key never appears in process arguments or environments"
  local c out
  for c in $CONTAINERS; do
    C="$c"
    # Stop the sampler first, and search with 'ntc[p]_' so these check commands never match themselves.
    aroot "pkill -f '[p]s-samples.log; sleep' || true; ps -eo args >> /var/log/ps-samples.log"
    out="$(aroot "grep 'ntc[p]_' /var/log/ps-samples.log | sed -E 's/ntc[p]_[0-9A-Za-z]+/ntcp_<redacted>/g' | sort | uniq -c | head -5" || true)"
    [ -z "$out" ] || fail "$c: ntcp_ seen in ps -eo args: $(echo "$out" | tr '\n' ';')"
    out="$(aroot "grep -l 'ntc[p]_' /proc/[0-9]*/environ 2>/dev/null | grep -v '/proc/self/'" || true)"
    [ -z "$out" ] || fail "$c: ntcp_ in a process environment: $out"
    log "$c: $(aroot 'wc -l < /var/log/ps-samples.log' | tr -d ' ') ps lines sampled"
  done
  out="$(grep -l 'ntc[p]_' "$LOGS"/[ab]-*.log 2>/dev/null || true)"
  [ -z "$out" ] || fail "ntcp_ in installer/upgrade output: $out"
  record 5 "no ntcp_ in ps args, process environments or installer output"
}

# ───────────────────────── main ─────────────────────────
docker info >/dev/null 2>&1 || { echo "docker is not available" >&2; exit 1; }
T0=$(date +%s)
if [ "$BUILD" = 1 ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then build_image; fi
[ "$BUILD" = 1 ] && build_blob
[ -f "$WORK/meta.env" ] || { echo "no build in $WORK (run with --build)" >&2; exit 2; }
# shellcheck disable=SC1091
. "$WORK/meta.env"
VD1="${V1}_${COMMIT}"; VD2="${V2}_${COMMIT}"
NODE_PIN="$PD/runtime/node-v${NODE_VERSION}-linux-${ARCH}/bin/node"
write_helpers
log "blob $WORK (commit $COMMIT, linux-$ARCH), logs $LOGS"

scenario1
if ! printf '%s' "$RESULTS" | grep -q '^FAIL scenario 1'; then
  scenario2
else
  RESULTS="${RESULTS}FAIL scenario 2: skipped, scenario 1 failed"$'\n'
fi
scenario3
scenario4
scenario5

echo
echo "==================== ntc-e2e-update: results ($(( $(date +%s) - T0 )) s) ===================="
printf '%s' "$RESULTS"
printf '%s' "$RESULTS" | grep -q '^FAIL' && exit 1
exit 0
