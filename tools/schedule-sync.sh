#!/usr/bin/env bash
#
# schedule-sync.sh
# ---------------------------------------------------------------------------
# Runs tools/sync-upstream.sh on a schedule (macOS launchd LaunchAgent).
# This only keeps the CODE of the fork current with the original repository. It has
# nothing to do with telemetry collection, which runs continuously in the Pilot daemon.
# A run with nothing new upstream only does a fetch, so a short interval is cheap.
# The job stops on anything that needs a human (conflict, failed gate) and the
# reason is in the log; the sync history itself lives in git.
#
#   tools/schedule-sync.sh install     # every 4 hours by default
#   tools/schedule-sync.sh status      # job state and the last log lines
#   tools/schedule-sync.sh run-now     # start the job once, right now
#   tools/schedule-sync.sh uninstall
#
# Settings (environment, read at install time):
#   SYNC_INTERVAL_HOURS (default 4; the job also fires after the Mac wakes from sleep)
#   SYNC_LOG_FILE (default ~/Library/Logs/loongsuite-pilot-sync.log)
#   SYNC_LAUNCHD_LABEL (default com.NTConsult.loongsuite-pilot-sync)
#   SYNC_JOB_ARGS (extra options passed to sync-upstream.sh, for example
#                  "--update-pr-branches")
#
# On Linux use cron instead, for example:
#   0 9 * * 1  cd /path/to/loongsuite-pilot && bash tools/sync-upstream.sh >> ~/loongsuite-pilot-sync.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

LABEL="${SYNC_LAUNCHD_LABEL:-com.NTConsult.loongsuite-pilot-sync}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="${SYNC_LOG_FILE:-$HOME/Library/Logs/loongsuite-pilot-sync.log}"
INTERVAL_HOURS="${SYNC_INTERVAL_HOURS:-4}"
JOB_ARGS="${SYNC_JOB_ARGS:-}"
DOMAIN="gui/$(id -u)"

die() { printf '[schedule] ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[schedule] %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || die "launchd is macOS only. See the cron example in this file's header."
[ -f "$ROOT/tools/sync-upstream.sh" ] || die "tools/sync-upstream.sh not found in $ROOT"

case "$INTERVAL_HOURS" in ''|*[!0-9]*|0) die "SYNC_INTERVAL_HOURS must be a positive whole number" ;; esac
INTERVAL_SECONDS=$((INTERVAL_HOURS * 3600))

write_plist() {
  mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
  local args_xml=""
  local arg
  for arg in $JOB_ARGS; do args_xml="$args_xml    <string>$arg</string>
"; done
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/tools/sync-upstream.sh</string>
$args_xml  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key>
  <integer>$INTERVAL_SECONDS</integer>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null || die "generated plist is invalid: $PLIST"
}

is_loaded() { launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; }

case "${1:-}" in
  install)
    write_plist
    is_loaded && launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    info "installed $LABEL: every ${INTERVAL_HOURS}h, repo=$ROOT"
    info "log: $LOG"
    ;;
  uninstall)
    is_loaded && launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    info "removed $LABEL"
    ;;
  run-now)
    is_loaded || die "not installed; run: tools/schedule-sync.sh install"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    info "started; follow the result with: tools/schedule-sync.sh status"
    ;;
  status)
    if is_loaded; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*(state|runs|last exit code|program) " || true
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s*run interval" || true
    else
      info "not installed"
    fi
    if [ -f "$LOG" ]; then
      info "last log lines ($LOG):"
      tail -8 "$LOG" | sed 's/^/    /'
    fi
    ;;
  *)
    sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
