#!/usr/bin/env bash
#
# schedule-sync.sh
# ---------------------------------------------------------------------------
# Runs tools/sync-upstream.sh on a schedule (macOS launchd LaunchAgent).
# The job stops on anything that needs a human (conflict, failed gate) and the
# reason is in the log; the sync history itself lives in git.
#
#   tools/schedule-sync.sh install     # weekly, Monday 09:00 by default
#   tools/schedule-sync.sh status      # job state and the last log lines
#   tools/schedule-sync.sh run-now     # start the job once, right now
#   tools/schedule-sync.sh uninstall
#
# Settings (environment, read at install time):
#   SYNC_WEEKDAY (0-6, Sunday=0; default 1)   SYNC_HOUR (default 9)   SYNC_MINUTE (default 0)
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
WEEKDAY="${SYNC_WEEKDAY:-1}"
HOUR="${SYNC_HOUR:-9}"
MINUTE="${SYNC_MINUTE:-0}"
JOB_ARGS="${SYNC_JOB_ARGS:-}"
DOMAIN="gui/$(id -u)"

die() { printf '[schedule] ERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '[schedule] %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || die "launchd is macOS only. See the cron example in this file's header."
[ -f "$ROOT/tools/sync-upstream.sh" ] || die "tools/sync-upstream.sh not found in $ROOT"

case "$WEEKDAY" in [0-6]) ;; *) die "SYNC_WEEKDAY must be 0-6" ;; esac
case "$HOUR" in ''|*[!0-9]*) die "SYNC_HOUR must be a number" ;; esac
case "$MINUTE" in ''|*[!0-9]*) die "SYNC_MINUTE must be a number" ;; esac

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
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>$WEEKDAY</integer>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
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
    info "installed $LABEL: weekday=$WEEKDAY at $(printf '%02d:%02d' "$HOUR" "$MINUTE"), repo=$ROOT"
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
      info "schedule: weekday=$WEEKDAY at $(printf '%02d:%02d' "$HOUR" "$MINUTE") (as installed)"
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
