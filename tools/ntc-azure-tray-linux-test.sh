#!/usr/bin/env bash
# NT TES collector + tray panel on a DISPOSABLE Ubuntu VM in Azure (no public IP, no inbound rule).
# Installs from the real blob (thin install.sh, as an ordinary user), then checks:
#   1. headless session: the collector must NOT download or start the tray
#   2. the tray binary on a stock server: lists missing shared libraries (informational)
#   3. with a virtual display + the runtime libraries: the collector installs the tray under
#      ~/.loongsuite-pilot/tray/<v>/ and starts it, a second launch shows the panel (single instance)
# Everything is deleted at the end (also on failure).
#
# Usage: NTC_BLOB_BASE_URL=https://<account>.blob.core.windows.net/pilot [NTC_CHANNEL=canary|stable] bash tools/ntc-azure-tray-linux-test.sh
# Needs: az login, subscription "Projeto Beat" (override with AZURE_SUBSCRIPTION).
# The test key is synthetic (ntcp_ + 33 chars): never a credential.
set -euo pipefail

: "${NTC_BLOB_BASE_URL:?}"
SUB="${AZURE_SUBSCRIPTION:-Projeto Beat}"
LOC="${AZURE_LOCATION:-eastus2}"
SIZE="${VM_SIZE:-Standard_D2s_v3}"
CHANNEL="${NTC_CHANNEL:-canary}"
RG="${NTC_LIN_RG:-rg-ntc-tray-lin-$RANDOM}"
VM="ntclin"
TEST_KEY="ntcp_LINSMOKE$(printf 'A%.0s' $(seq 1 25))"
PASS=0; FAIL=0; CREATED=0
W="$(mktemp -d)"

cleanup() {
  local rc=$?
  rm -rf "$W"
  [ "$CREATED" = 1 ] || exit "$rc"
  if [ "${NTC_LIN_KEEP:-}" = 1 ]; then echo "KEPT $RG: az group delete -n $RG --subscription '$SUB' --yes"; exit "$rc"; fi
  echo "==> deleting $RG"
  az group delete -n "$RG" --subscription "$SUB" --yes >/dev/null 2>&1 || true
  [ "$(az group exists -n "$RG" --subscription "$SUB")" = "false" ] && echo "group $RG gone" || echo "ERROR: $RG still exists, delete it by hand"
  exit "$rc"
}
trap cleanup EXIT

ok() { PASS=$((PASS+1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
info() { echo "INFO  $1"; }

# run a bash script file as root on the VM; prints its stdout/stderr
vm() {
  az vm run-command invoke -g "$RG" -n "$VM" --subscription "$SUB" --command-id RunShellScript --scripts "@$1" \
    --query 'value[0].message' -o tsv 2>&1
}
# value of a "key=value" line in vm output
val() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | tail -1; }

[ "$(az group exists -n "$RG" --subscription "$SUB")" = "false" ] || { echo "refusing: $RG already exists" >&2; exit 2; }
echo "==> creating $RG ($SIZE, $LOC, channel=$CHANNEL)"
az group create -n "$RG" -l "$LOC" --subscription "$SUB" \
  --tags purpose=ntc-linux-tray-smoke owner=francisco.prestes expires="$(date -u -v+1d +%F 2>/dev/null || date -u -d '+1 day' +%F)" -o none
CREATED=1
az vm create -g "$RG" -n "$VM" --subscription "$SUB" --image Canonical:ubuntu-24_04-lts:server:latest --size "$SIZE" \
  --admin-username ntcadmin --authentication-type password --admin-password "Aa1-$(openssl rand -hex 12)" \
  --public-ip-address "" --nsg-rule NONE --tags purpose=ntc-linux-tray-smoke -o none

echo "==> user + install from the blob (ordinary user, $CHANNEL channel)"
cat > "$W/install.sh" <<EOF
set -u
id ntcuser >/dev/null 2>&1 || useradd -m -s /bin/bash ntcuser
apt-get update -qq >/dev/null 2>&1; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
su - ntcuser -c "export NTC_PILOT_CHAVE='$TEST_KEY' NTC_PILOT_EMAIL='lin@ntconsult.com.br' NTC_PILOT_BLOB_URL='$NTC_BLOB_BASE_URL' NTC_PILOT_CHANNEL='$CHANNEL'; curl -fsSL '$NTC_BLOB_BASE_URL/install.sh' | bash" > /tmp/install.log 2>&1
echo "install_exit=\$?"
tail -8 /tmp/install.log | sed "s/$TEST_KEY/<chave>/g"
EOF
OUT="$(vm "$W/install.sh")"; echo "$OUT" | tail -12 | cut -c1-180
case "$(val "$OUT" install_exit)" in 0) ok "thin installer finished (exit 0)";; *) bad "thin installer failed"; exit 1;; esac

echo "==> 1. headless session: no tray expected"
cat > "$W/headless.sh" <<'EOF'
H=/home/ntcuser/.loongsuite-pilot
sleep 45
echo "collector_running=$(pgrep -u ntcuser -f collector-daemon | head -1 | wc -l)"
echo "version_file=$(cat $H/current 2>/dev/null)"
echo "autoupdate_manifest=$(grep -o '"manifestUrl"[^,]*' $H/config.json | head -1)"
echo "tray_dir=$([ -d $H/tray ] && ls $H/tray | tr '\n' ' ' || echo none)"
echo "display=${DISPLAY:-unset}"
EOF
OUT="$(vm "$W/headless.sh")"; echo "$OUT" | tail -8 | cut -c1-160
[ "$(val "$OUT" collector_running)" = 1 ] && ok "collector is running" || bad "collector not running"
[ "$(val "$OUT" tray_dir)" = none ] && ok "headless: tray not installed (guard works)" || bad "headless: tray was installed: $(val "$OUT" tray_dir)"

echo "==> 2. the tray binary on a stock server (informational)"
cat > "$W/ldd.sh" <<EOF
MAN=\$(curl -fsS '$NTC_BLOB_BASE_URL/manifest/latest.json')
V=\$(printf '%s' "\$MAN" | python3 -c 'import sys,json;m=json.load(sys.stdin);print((m.get("canary") or m)["version"] if "$CHANNEL"=="canary" else m["version"])')
echo "release=\$V"
mkdir -p /tmp/trayprobe && cd /tmp/trayprobe
curl -fsS -o t.tgz "$NTC_BLOB_BASE_URL/deps/tray/\$V/tray-linux-x64.tar.gz" && tar -xzf t.tgz && echo "downloaded=1" || echo "downloaded=0"
echo "missing_libs_stock=\$(ldd ./ntc-tes-tray 2>/dev/null | grep 'not found' | awk '{print \$1}' | tr '\n' ' ')"
EOF
OUT="$(vm "$W/ldd.sh")"; echo "$OUT" | tail -4 | cut -c1-200
[ "$(val "$OUT" downloaded)" = 1 ] && ok "tray archive downloads from the blob" || bad "tray archive missing in the blob"
info "libraries missing on a stock Ubuntu server: $(val "$OUT" missing_libs_stock)"

echo "==> 3. virtual display + runtime libraries: the collector must install and start the tray"
cat > "$W/display.sh" <<'EOF'
export DEBIAN_FRONTEND=noninteractive
apt-get install -y -qq xvfb x11-utils dbus-x11 libwebkit2gtk-4.1-0 libayatana-appindicator3-1 >/dev/null 2>&1
echo "libs_after=$(ldd /tmp/trayprobe/ntc-tes-tray 2>/dev/null | grep -c 'not found')"
UIDN=$(id -u ntcuser); RT=/run/user/$UIDN
SU() { sudo -u ntcuser env XDG_RUNTIME_DIR=$RT DBUS_SESSION_BUS_ADDRESS=unix:path=$RT/bus "$@"; }
(Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &) ; sleep 3
H=/home/ntcuser/.loongsuite-pilot
# the collector runs as a systemd user service (as on a desktop): give the user manager a display, then restart it
SU systemctl --user set-environment DISPLAY=:99 NTC_TES_SHOW=1
UNIT=$(SU systemctl --user list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -i loongsuite | grep -v updater | head -1)
echo "unit=$UNIT"
SU systemctl --user restart $UNIT
for i in $(seq 1 40); do
  [ -x "$(ls $H/tray/*/ntc-tes-tray 2>/dev/null | head -1)" ] && break; sleep 5
done
sleep 10
echo "tray_installed=$(ls $H/tray 2>/dev/null | grep -v '^tray\.' | tr '\n' ' ')"
echo "tray_pid_file=$(cat $H/tray/tray.pid 2>/dev/null)"
echo "tray_running=$(pgrep -u ntcuser -x ntc-tes-tray | wc -l)"
echo "tray_exe_mode=$(stat -c %a $(ls $H/tray/*/ntc-tes-tray 2>/dev/null | head -1) 2>/dev/null)"
echo "window=$(DISPLAY=:99 xwininfo -root -tree 2>/dev/null | grep -i 'NT TES' | head -1 | sed 's/^ *//' | cut -c1-110)"
echo "--- collector log (tray lines)"; SU journalctl --user -u $UNIT --no-pager 2>/dev/null | grep -i tray | tail -4 | cut -c1-220
EOF
OUT="$(vm "$W/display.sh")"; echo "$OUT" | tail -12 | cut -c1-200
[ "$(val "$OUT" libs_after)" = 0 ] && ok "runtime libraries satisfied" || bad "still missing libraries after apt"
[ -n "$(val "$OUT" tray_installed)" ] && ok "collector installed the tray: $(val "$OUT" tray_installed)" || bad "tray not installed by the collector"
[ "$(val "$OUT" tray_running)" -ge 1 ] 2>/dev/null && ok "tray process is running" || bad "tray process not running"
[ "$(val "$OUT" tray_exe_mode)" = 755 ] && ok "tray executable has mode 755" || bad "unexpected mode: $(val "$OUT" tray_exe_mode)"
printf '%s' "$(val "$OUT" window)" | grep -qi "NT TES" && ok "panel window exists on the display" || bad "no NT TES window found"

echo "==> 4. a second launch must reuse the running tray (single instance)"
cat > "$W/single.sh" <<'EOF'
H=/home/ntcuser/.loongsuite-pilot
EXE=$(ls $H/tray/*/ntc-tes-tray | head -1)
before=$(pgrep -u ntcuser -x ntc-tes-tray | wc -l)
UIDN=$(id -u ntcuser); RT=/run/user/$UIDN
sudo -u ntcuser env DISPLAY=:99 XDG_RUNTIME_DIR=$RT DBUS_SESSION_BUS_ADDRESS=unix:path=$RT/bus sh -c "$EXE >/tmp/second.log 2>&1 &"; sleep 5
echo "before=$before after=$(pgrep -u ntcuser -x ntc-tes-tray | wc -l)"
EOF
OUT="$(vm "$W/single.sh")"; line="$(echo "$OUT" | grep '^before=' | tail -1)"; echo "$line"
[ "$line" = "before=1 after=1" ] && ok "single instance: still one tray process" || bad "single instance check: $line"

echo; echo "RESULT pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
