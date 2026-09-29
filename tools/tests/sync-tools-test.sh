#!/usr/bin/env bash
#
# Simulation tests for tools/sync-upstream.sh and tools/sync-reminder.sh.
# Builds throwaway upstream/fork/clone repositories in a temp dir; touches nothing else.
#
#   bash tools/tests/sync-tools-test.sh
set -uo pipefail

TOOLS="$(cd "$(dirname "$0")/.." && pwd)"
SYNC="$TOOLS/sync-upstream.sh"
REMIND="$TOOLS/sync-reminder.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export SYNC_VERIFY_CMD=true SYNC_PR_BRANCHES=feat/pr
unset SYNC_REMIND_DAYS

G() { git -c init.defaultBranch=main "$@"; }
pass=0; fail=0
ok() { if [ "$1" = "0" ]; then pass=$((pass+1)); echo "  ok   - $2"; else fail=$((fail+1)); echo "  FAIL - $2"; fi; }
extra_worktrees() { [ -z "$(G worktree list | sed -n '2p')" ]; }
cfg() { G config --local --get "ntconsult.$1" 2>/dev/null || true; }

setup() {
  T="$(mktemp -d)"; cd "$T"
  G init -q --bare upstream.git; G clone -q upstream.git upw 2>/dev/null
  ( cd upw && echo a > a.txt && echo shared > shared.txt && G add . && G commit -qm base && G push -q origin main )
  G clone -q --bare upstream.git origin.git; G clone -q origin.git local 2>/dev/null; cd local
  G remote add upstream ../upstream.git; G fetch -q upstream
  G switch -q -c NTConsult-main main; echo ours > ours.txt; G add ours.txt; G commit -qm "our feature"
  G switch -q -c feat/pr main; echo pr > pr.txt; G add pr.txt; G commit -qm "pr work"
  G switch -q NTConsult-main; G merge -q feat/pr -m "merge pr" 2>/dev/null
  G push -q origin main NTConsult-main feat/pr 2>/dev/null
}
advance() { ( cd "$T/upw" && echo "$1" >> "$2" && G add . && G commit -qm "$3" && G push -q origin main ); }

echo "1. nothing new"; setup
out=$("$SYNC" 2>&1); ok $? "exits 0"; echo "$out" | grep -q "already matches"; ok $? "reports up to date"

echo "2. upstream advances: dry-run, then real"; setup
advance x a.txt "upstream change"; before=$(G rev-parse main)
"$SYNC" --dry-run >/dev/null 2>&1; ok $? "dry-run exits 0"
[ "$(G rev-parse main)" = "$before" ]; ok $? "dry-run did not move main"
[ -z "$(cfg lastSyncStatus)" ]; ok $? "dry-run records no status"
"$SYNC" >/dev/null 2>&1; ok $? "real run exits 0"
[ "$(G rev-parse main)" = "$(G rev-parse upstream/main)" ]; ok $? "main mirrors upstream"
[ "$(G rev-parse origin/main)" = "$(G rev-parse upstream/main)" ]; ok $? "origin/main pushed"
G merge-base --is-ancestor main NTConsult-main; ok $? "NTConsult-main contains main"
[ "$(G rev-parse origin/NTConsult-main)" = "$(G rev-parse NTConsult-main)" ]; ok $? "NTConsult-main pushed"
G show NTConsult-main:ours.txt >/dev/null 2>&1; ok $? "our change kept"
extra_worktrees; ok $? "temporary worktrees cleaned"
[ "$(cfg lastSyncStatus)" = "ok" ] && [ -n "$(cfg lastSyncEpoch)" ] && [ -n "$(cfg lastSyncAt)" ]; ok $? "success recorded (status, epoch, ISO time)"

echo "3. PR branch behind"; setup
advance x a.txt "upstream change"
out=$("$SYNC" 2>&1); echo "$out" | grep -q "feat/pr is 1 commit(s) behind"; ok $? "reports PR branch behind"
old=$(G rev-parse feat/pr); "$SYNC" >/dev/null 2>&1
[ "$(G rev-parse feat/pr)" = "$old" ]; ok $? "PR branch untouched without the flag"
"$SYNC" --update-pr-branches >/dev/null 2>&1; ok $? "update-pr-branches exits 0"
G merge-base --is-ancestor main feat/pr; ok $? "PR branch rebased onto main"
[ "$(G rev-parse origin/feat/pr)" = "$(G rev-parse feat/pr)" ]; ok $? "PR branch force-pushed"

echo "4. checked-out NTConsult-main with local edits"; setup
echo dirty > dirty.txt; echo more >> a.txt
advance y shared.txt "upstream change elsewhere"
"$SYNC" >/dev/null 2>&1; ok $? "run succeeds with a dirty tree"
[ -f dirty.txt ] && grep -q more a.txt; ok $? "local edits preserved"
[ "$(G rev-parse HEAD)" = "$(G rev-parse origin/NTConsult-main)" ]; ok $? "checked-out branch fast-forwarded"

echo "5. conflict stops safely and is remembered"; setup
echo mine >> shared.txt; G add shared.txt; G commit -qm "our edit"; G push -q origin NTConsult-main
advance theirs shared.txt "upstream edit of the same file"; ours_before=$(G rev-parse NTConsult-main)
out=$("$SYNC" 2>&1); rc=$?
[ "$rc" -ne 0 ]; ok $? "exits non-zero"
echo "$out" | grep -q "conflict: shared.txt"; ok $? "names the conflicting file"
[ "$(G rev-parse NTConsult-main)" = "$ours_before" ]; ok $? "NTConsult-main untouched"
extra_worktrees; ok $? "worktree cleaned after the conflict"
[ "$(cfg lastSyncStatus)" = "failed" ]; ok $? "failure recorded"
cfg lastSyncMessage | grep -q "conflicts"; ok $? "failure reason recorded"
[ -z "$(cfg lastSyncEpoch)" ]; ok $? "no successful-sync time recorded for a failed run"
echo "   reminder after the conflict:"
out=$("$REMIND" 2>&1); echo "$out" | grep -q "FALHOU"; ok $? "reminder shouts about the failed attempt"
echo "$out" | grep -q "conflicts"; ok $? "reminder shows the reason"

echo "6. diverged main is refused"; setup
G switch -q main; echo bad > bad.txt; G add bad.txt; G commit -qm "commit on the mirror"; G switch -q NTConsult-main
out=$("$SYNC" 2>&1); rc=$?
[ "$rc" -ne 0 ]; ok $? "refuses when main has local commits"
echo "$out" | grep -q "must stay a mirror"; ok $? "explains why"
[ "$(cfg lastSyncStatus)" = "failed" ]; ok $? "failure recorded"

echo "7. failed verification blocks the push"; setup
advance z a.txt "upstream change"; ours_before=$(G rev-parse NTConsult-main)
out=$(SYNC_VERIFY_CMD=false "$SYNC" 2>&1); rc=$?
[ "$rc" -ne 0 ]; ok $? "exits non-zero"
echo "$out" | grep -q "verification failed"; ok $? "says verification failed"
[ "$(G rev-parse origin/NTConsult-main)" = "$ours_before" ]; ok $? "NTConsult-main not pushed"
extra_worktrees; ok $? "worktree cleaned"
[ "$(cfg lastSyncStatus)" = "failed" ]; ok $? "failure recorded"

echo "8. failure is cleared by a later success"; setup
echo mine >> shared.txt; G add shared.txt; G commit -qm "our edit"
advance theirs shared.txt "upstream edit"
"$SYNC" >/dev/null 2>&1; [ "$(cfg lastSyncStatus)" = "failed" ]; ok $? "first run fails on conflict"
G merge -q main -m "resolved by hand" >/dev/null 2>&1 || { printf 'resolved\n' > shared.txt; G add shared.txt; G commit -qm "resolve" >/dev/null 2>&1; }
"$SYNC" >/dev/null 2>&1; [ "$(cfg lastSyncStatus)" = "ok" ]; ok $? "next run succeeds and records ok"
[ -z "$("$REMIND" 2>&1)" ]; ok $? "reminder is silent again"

echo "9. reminder behaviour"; setup
out=$("$REMIND" 2>&1); echo "$out" | grep -q "nunca registrada"; ok $? "never synced: reminds"
advance q a.txt "upstream change"
out=$("$REMIND" 2>&1); echo "$out" | grep -q "1 commit(s) novo(s)"; ok $? "stale: says how far behind the original is"
"$SYNC" >/dev/null 2>&1
[ -z "$("$REMIND" 2>&1)" ]; ok $? "just synced: silent"
G config --local ntconsult.lastSyncEpoch "$(( $(date +%s) - 3*86400 ))"
out=$("$REMIND" 2>&1); echo "$out" | grep -q "3 dia(s)"; ok $? "3 days old: reminds with the age"
[ -z "$(SYNC_REMIND_DAYS=7 "$REMIND" 2>&1)" ]; ok $? "SYNC_REMIND_DAYS raises the threshold"
out=$("$REMIND" 2>&1); echo "$out" | grep -q "Assistente: avise"; ok $? "asks the assistant to tell the user"
G config --local ntconsult.lastSyncEpoch "not-a-number"
"$REMIND" >/dev/null 2>&1; ok $? "corrupt state does not crash"
( cd "$(mktemp -d)" && [ -z "$("$REMIND" 2>&1)" ] ); ok $? "outside a git repo: silent"
[ "$(G rev-parse main)" = "$(G rev-parse upstream/main)" ]; ok $? "reminder changed no branch"

echo "RESULT pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
