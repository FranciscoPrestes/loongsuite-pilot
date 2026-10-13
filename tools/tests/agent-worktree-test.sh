#!/usr/bin/env bash
#
# Simulation tests for tools/agent-worktree.sh. Throwaway origin + clone in a temp dir.
#
#   bash tools/tests/agent-worktree-test.sh
set -uo pipefail

TOOLS="$(cd "$(dirname "$0")/.." && pwd)"
WT="$TOOLS/agent-worktree.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export AGENT_BASE_BRANCH=main

G() { git -c init.defaultBranch=main "$@"; }
pass=0; fail=0
ok() { if [ "$1" = "0" ]; then pass=$((pass+1)); echo "  ok   - $2"; else fail=$((fail+1)); echo "  FAIL - $2"; fi; }
has_branch() { G -C "$1" show-ref --verify --quiet "refs/heads/$2"; }
remote_has() { G -C "$1" ls-remote --exit-code --heads origin "$2" >/dev/null 2>&1; }

setup() {
  T="$(mktemp -d)"; cd "$T"
  G init -q --bare origin.git
  G clone -q origin.git repo 2>/dev/null
  ( cd repo && echo a > a.txt && G add . && G commit -qm base && G push -q origin main )
  export AGENT_WT_ROOT="$T/wt"
  cd repo
}

echo "start"
setup
out="$(bash "$WT" start feat/x 2>&1)"; rc=$?
ok "$rc" "start succeeds"
[ -d "$AGENT_WT_ROOT/feat-x" ]; ok "$?" "worktree created at <root>/feat-x"
has_branch . feat/x; ok "$?" "branch feat/x created"
bash "$WT" start feat/x >/dev/null 2>&1; [ "$?" != 0 ]; ok "$?" "start refuses an existing branch"

echo "finish lands work and cleans up"
( cd "$AGENT_WT_ROOT/feat-x" && echo b > b.txt && G add . && G commit -qm "add b" )
out="$(bash "$WT" finish feat/x 2>&1)"; rc=$?
ok "$rc" "finish succeeds"
[ "$(G -C "$T/origin.git" show main:b.txt 2>/dev/null)" = "b" ]; ok "$?" "commit reached origin/main"
[ ! -d "$AGENT_WT_ROOT/feat-x" ]; ok "$?" "worktree removed"
! has_branch . feat/x; ok "$?" "local branch deleted"
! remote_has . feat/x; ok "$?" "remote branch absent"

echo "finish refuses a dirty worktree"
setup
bash "$WT" start fix/dirty >/dev/null 2>&1
( cd "$AGENT_WT_ROOT/fix-dirty" && echo c > c.txt )
bash "$WT" finish fix/dirty >/dev/null 2>&1; [ "$?" != 0 ]; ok "$?" "finish fails when files are uncommitted"
[ -d "$AGENT_WT_ROOT/fix-dirty" ]; ok "$?" "worktree kept"

echo "finish stops on a rebase conflict"
setup
bash "$WT" start fix/conflict >/dev/null 2>&1
( cd "$AGENT_WT_ROOT/fix-conflict" && echo mine > a.txt && G commit -qam mine )
( cd "$T/repo" && echo theirs > a.txt && G commit -qam theirs && G push -q origin main )
bash "$WT" finish fix/conflict >/dev/null 2>&1; [ "$?" != 0 ]; ok "$?" "finish fails on conflict"
[ -d "$AGENT_WT_ROOT/fix-conflict" ]; ok "$?" "worktree kept for manual resolution"
[ "$(G -C "$T/origin.git" show main:a.txt)" = "theirs" ]; ok "$?" "origin/main untouched"
G -C "$AGENT_WT_ROOT/fix-conflict" rebase --show-current-patch >/dev/null 2>&1; [ "$?" != 0 ]; ok "$?" "rebase was aborted, no half-done state"

echo "finish finds a worktree created by hand"
setup
G worktree add -q "$T/handmade" -b docs/manual origin/main
( cd "$T/handmade" && echo m > m.txt && G add . && G commit -qm "manual" )
bash "$WT" finish docs/manual >/dev/null 2>&1; ok "$?" "finish succeeds for a hand-made worktree"
[ "$(G -C "$T/origin.git" show main:m.txt 2>/dev/null)" = "m" ]; ok "$?" "commit reached origin/main"
[ ! -d "$T/handmade" ]; ok "$?" "hand-made worktree removed"

echo "start links node_modules without dirtying the worktree"
setup
mkdir -p "$T/repo/node_modules/dep"; echo x > "$T/repo/node_modules/dep/i.js"
bash "$WT" start feat/deps >/dev/null 2>&1
[ -L "$AGENT_WT_ROOT/feat-deps/node_modules" ]; ok "$?" "node_modules is linked to the main clone"
[ -f "$AGENT_WT_ROOT/feat-deps/node_modules/dep/i.js" ]; ok "$?" "the link resolves"
[ -z "$(G -C "$AGENT_WT_ROOT/feat-deps" status --porcelain)" ]; ok "$?" "worktree stays clean (link is ignored)"
bash "$WT" finish feat/deps >/dev/null 2>&1; ok "$?" "finish works with the link present"
[ -d "$T/repo/node_modules/dep" ]; ok "$?" "main clone node_modules untouched after finish"

echo; echo "passed: $pass  failed: $fail"
[ "$fail" = 0 ]
