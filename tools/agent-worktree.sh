#!/usr/bin/env bash
#
# One git worktree per task, so several agents can work in the same repo without
# touching each other's files or branches. Rules: AGENTS.ntc.md.
#
#   bash tools/agent-worktree.sh start <branch>    create worktree + branch from origin/<base>
#   bash tools/agent-worktree.sh finish <branch>   rebase, push to <base>, delete worktree and branch
#   bash tools/agent-worktree.sh list              show worktrees
#
# Env: AGENT_BASE_BRANCH (default NTConsult-main), AGENT_WT_ROOT (default ../<repo>-wt).
set -euo pipefail

BASE="${AGENT_BASE_BRANCH:-NTConsult-main}"
COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN_REPO="$(cd "$COMMON/.." && pwd)"
ROOT="${AGENT_WT_ROOT:-$(dirname "$MAIN_REPO")/$(basename "$MAIN_REPO")-wt}"

die() { echo "agent-worktree: $*" >&2; exit 1; }
slug() { printf '%s' "$1" | tr '/' '-'; }
# Path of the worktree that has <branch> checked out (works for hand-made worktrees too).
worktree_of() {
  git -C "$MAIN_REPO" worktree list --porcelain | awk -v ref="refs/heads/$1" '
    /^worktree / { path = substr($0, 10) }
    $0 == "branch " ref { print path; exit }'
}
need_branch() { [ -n "${1:-}" ] || die "usage: $0 $2 <branch>"; }

cmd_start() {
  local branch="${1:-}"; need_branch "$branch" start
  local dir="$ROOT/$(slug "$branch")"
  git -C "$MAIN_REPO" show-ref --verify --quiet "refs/heads/$branch" && die "branch '$branch' already exists"
  [ -e "$dir" ] && die "$dir already exists"
  git -C "$MAIN_REPO" fetch -q origin
  mkdir -p "$ROOT"
  git -C "$MAIN_REPO" worktree add -q "$dir" -b "$branch" "origin/$BASE"
  echo "$dir"
}

cmd_finish() {
  local branch="${1:-}"; need_branch "$branch" finish
  local dir; dir="$(worktree_of "$branch")"
  [ -n "$dir" ] && [ -d "$dir" ] || die "no worktree has branch '$branch' checked out"
  [ "$dir" != "$MAIN_REPO" ] || die "'$branch' is checked out in the main clone, not in a worktree"
  [ -z "$(git -C "$dir" status --porcelain)" ] || die "uncommitted files in $dir; commit or discard them first"

  git -C "$dir" fetch -q origin
  if ! git -C "$dir" rebase -q "origin/$BASE"; then
    git -C "$dir" rebase --abort || true
    die "rebase onto origin/$BASE conflicts; worktree kept at $dir, resolve it by hand"
  fi
  git -C "$dir" push -q origin "HEAD:$BASE" || die "push to $BASE refused (someone pushed first?); run finish again"

  git -C "$MAIN_REPO" worktree remove --force "$dir"
  git -C "$MAIN_REPO" branch -D -q "$branch"
  git -C "$MAIN_REPO" push -q origin --delete "$branch" 2>/dev/null || true

  # Keep the local base branch current unless some worktree has it checked out.
  if ! git -C "$MAIN_REPO" worktree list --porcelain | grep -qx "branch refs/heads/$BASE"; then
    git -C "$MAIN_REPO" fetch -q origin
    git -C "$MAIN_REPO" branch -f "$BASE" "origin/$BASE"
  fi
  echo "landed '$branch' on $BASE; worktree and branch removed"
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  finish) shift; cmd_finish "$@" ;;
  list) git -C "$MAIN_REPO" worktree list ;;
  *) die "usage: $0 start|finish <branch> | list" ;;
esac
