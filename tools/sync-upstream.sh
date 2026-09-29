#!/usr/bin/env bash
#
# sync-upstream.sh
# ---------------------------------------------------------------------------
# Keeps the NTConsult fork current with the original alibaba/loongsuite-pilot.
# Safe to run on a schedule (for example weekly): it stops on anything it cannot
# do without a human and never rewrites a branch unless told to.
#
#   tools/sync-upstream.sh                       # mirror + merge into NTConsult-main
#   tools/sync-upstream.sh --dry-run             # report only, change nothing
#   tools/sync-upstream.sh --update-pr-branches  # also rebase and re-push PR branches
#   tools/sync-upstream.sh --no-verify           # skip the typecheck/test gate
#
# Branch roles:
#   main            mirror of upstream/main. Never commit here.
#   NTConsult-main  our version: main + our changes. Gets `git merge main`.
#   PR branches     branches with open pull requests upstream. Rebased only with
#                   --update-pr-branches, pushed with --force-with-lease.
#
# The work happens in a temporary worktree, so your working directory (even a
# dirty one) is not touched, except for a fast-forward when NTConsult-main is
# the branch you have checked out.
#
# History lives in git itself: `git log --first-parent NTConsult-main` shows
# every sync as a merge commit. Each real run (not --dry-run) also records its
# outcome, ok or failed with the reason, in this clone's git config
# (ntconsult.lastSync*). tools/sync-reminder.sh reads that to remind you when a
# sync is due and to keep flagging a failed one (for example a conflict) until a
# later run succeeds.
#
# Settings (environment): SYNC_UPSTREAM_REMOTE (upstream), SYNC_ORIGIN_REMOTE
# (origin), SYNC_MIRROR_BRANCH (main), SYNC_OURS_BRANCH (NTConsult-main),
# SYNC_PR_BRANCHES (space separated, default feat/copilot-collector),
# SYNC_VERIFY_CMD (default: typecheck + Copilot tests).
# ---------------------------------------------------------------------------
set -euo pipefail

UPSTREAM="${SYNC_UPSTREAM_REMOTE:-upstream}"
ORIGIN="${SYNC_ORIGIN_REMOTE:-origin}"
MIRROR="${SYNC_MIRROR_BRANCH:-main}"
OURS="${SYNC_OURS_BRANCH:-NTConsult-main}"
PR_BRANCHES="${SYNC_PR_BRANCHES:-feat/copilot-collector}"
# The tests run with a throwaway HOME: some upstream deployment tests write into the real
# ~/.claude/settings.json (and other agent homes), which breaks the machine's own collection.
VERIFY_CMD="${SYNC_VERIFY_CMD:-npm run typecheck && env -u LOONGSUITE_PILOT_DATA_DIR HOME=\"\$(mktemp -d)\" ./node_modules/.bin/vitest run tests/unit/inputs/copilot tests/unit/deployment tests/unit/hooks/copilot-hook-event-writer.test.ts}"

DRY_RUN=0
VERIFY=1
UPDATE_PR=0
WORKTREES=()
WT_DIR=
RECORD_ENABLED=0

info() { printf '[sync] %s\n' "$*"; }
warn() { printf '[sync] WARNING: %s\n' "$*" >&2; }
# Remembers the outcome of the last real run so tools/sync-reminder.sh can surface it.
record_status() {
  [ "$RECORD_ENABLED" -eq 1 ] || return 0
  local now
  now="$(date +%s)"
  git config --local ntconsult.lastSyncAttemptEpoch "$now"
  git config --local ntconsult.lastSyncStatus "$1"
  git config --local ntconsult.lastSyncMessage "$2"
  if [ "$1" = "ok" ]; then
    git config --local ntconsult.lastSyncEpoch "$now"
    git config --local ntconsult.lastSyncAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
}

die() { printf '[sync] ERROR: %s\n' "$*" >&2; record_status failed "$*"; exit 1; }

usage() { sed -n '3,24p' "$0" | sed 's/^# \{0,1\}//'; }

cleanup() {
  local wt
  for wt in ${WORKTREES[@]+"${WORKTREES[@]}"}; do
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
  done
  git worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-verify) VERIFY=0 ;;
    --update-pr-branches) UPDATE_PR=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
cd "$ROOT"
[ "$DRY_RUN" -eq 0 ] && RECORD_ENABLED=1

for remote in "$UPSTREAM" "$ORIGIN"; do
  git remote get-url "$remote" >/dev/null 2>&1 || die "remote '$remote' is not configured"
done
git show-ref --verify --quiet "refs/heads/$MIRROR" || die "local branch '$MIRROR' does not exist"
git show-ref --verify --quiet "refs/heads/$OURS" || die "local branch '$OURS' does not exist"

current_branch() { git symbolic-ref --quiet --short HEAD 2>/dev/null || true; }
behind_count() { git rev-list --count "$1..$2"; }

# Sets WT_DIR. Not called through $(...): the registration must survive for the cleanup trap.
new_worktree() {
  WT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sync-upstream.XXXXXX")"
  WORKTREES+=("$WT_DIR")
  git worktree add --detach "$WT_DIR" "$1" >/dev/null 2>&1 || die "could not create a worktree at $1"
}

# Runs the gate in a worktree. node_modules is shared unless the lockfile changed.
verify() {
  local wt="$1" base="$2"
  [ "$VERIFY" -eq 1 ] || { info "verification skipped (--no-verify)"; return 0; }
  if [ -f "$wt/package.json" ]; then
    if ! git diff --quiet "$base" HEAD -- package-lock.json 2>/dev/null || [ ! -d "$ROOT/node_modules" ]; then
      info "lockfile changed: running npm ci in the worktree"
      (cd "$wt" && npm ci --silent) || die "npm ci failed; nothing was pushed"
    else
      ln -s "$ROOT/node_modules" "$wt/node_modules"
    fi
  fi
  info "verifying: $VERIFY_CMD"
  (cd "$wt" && bash -c "$VERIFY_CMD") || die "verification failed; nothing was pushed (fix, then rerun)"
}

info "fetching $UPSTREAM and $ORIGIN"
git fetch --quiet "$UPSTREAM"
git fetch --quiet "$ORIGIN"

# ---- 1. mirror -------------------------------------------------------------
if [ "$(behind_count "$UPSTREAM/$MIRROR" "$MIRROR")" -ne 0 ]; then
  die "$MIRROR has commits that are not in $UPSTREAM/$MIRROR. Move them to a feature branch; $MIRROR must stay a mirror."
fi
MIRROR_NEW="$(behind_count "$MIRROR" "$UPSTREAM/$MIRROR")"
if [ "$MIRROR_NEW" -eq 0 ]; then
  info "$MIRROR already matches $UPSTREAM/$MIRROR"
else
  info "$UPSTREAM/$MIRROR is $MIRROR_NEW commit(s) ahead of $MIRROR"
  if [ "$DRY_RUN" -eq 0 ]; then
    if [ "$(current_branch)" = "$MIRROR" ]; then
      git merge --ff-only --quiet "$UPSTREAM/$MIRROR" || die "could not fast-forward $MIRROR in the working tree (stash your changes)"
    else
      git update-ref "refs/heads/$MIRROR" "$(git rev-parse "$UPSTREAM/$MIRROR")"
    fi
    info "$MIRROR fast-forwarded"
  fi
fi
if [ "$DRY_RUN" -eq 0 ] && [ "$(git rev-parse "$MIRROR")" != "$(git rev-parse "$ORIGIN/$MIRROR" 2>/dev/null || echo none)" ]; then
  git push --quiet "$ORIGIN" "$MIRROR"
  info "pushed $MIRROR to $ORIGIN"
fi

# ---- 2. NTConsult-main -----------------------------------------------------
TARGET="$MIRROR"
[ "$DRY_RUN" -eq 1 ] && TARGET="$UPSTREAM/$MIRROR"
if git merge-base --is-ancestor "$TARGET" "$OURS"; then
  info "$OURS already contains $TARGET"
else
  info "$OURS is missing $(behind_count "$OURS" "$TARGET") commit(s) from $TARGET"
  if [ "$DRY_RUN" -eq 0 ]; then
    new_worktree "$OURS"; WT="$WT_DIR"
    if ! (cd "$WT" && git merge --no-edit --quiet "$TARGET" >/dev/null 2>&1); then
      (cd "$WT" && git diff --name-only --diff-filter=U) | sed 's/^/[sync]   conflict: /' >&2
      die "merging $TARGET into $OURS conflicts. Resolve by hand: git switch $OURS && git merge $MIRROR"
    fi
    MERGED="$(cd "$WT" && git rev-parse HEAD)"
    verify "$WT" "$OURS"
    if [ "$(current_branch)" = "$OURS" ]; then
      git merge --ff-only --quiet "$MERGED" || die "could not fast-forward the checked-out $OURS (stash your changes and rerun)"
    else
      git update-ref "refs/heads/$OURS" "$MERGED"
    fi
    git push --quiet "$ORIGIN" "$OURS"
    info "$OURS updated and pushed"
  fi
fi

# ---- 3. PR branches --------------------------------------------------------
for branch in $PR_BRANCHES; do
  git show-ref --verify --quiet "refs/heads/$branch" || { info "PR branch $branch not found locally, skipping"; continue; }
  if git merge-base --is-ancestor "$branch" "$TARGET"; then
    info "$branch is already in $TARGET: its PR was merged, you can delete the branch"
  elif git merge-base --is-ancestor "$TARGET" "$branch"; then
    info "$branch is up to date with $TARGET"
  elif [ "$UPDATE_PR" -eq 0 ] || [ "$DRY_RUN" -eq 1 ]; then
    info "$branch is $(behind_count "$branch" "$TARGET") commit(s) behind $TARGET (use --update-pr-branches to rebase and re-push)"
  else
    LEASE="$(git rev-parse "$ORIGIN/$branch" 2>/dev/null || echo '')"
    new_worktree "$branch"; PRWT="$WT_DIR"
    if ! (cd "$PRWT" && git rebase --quiet "$TARGET" >/dev/null 2>&1); then
      (cd "$PRWT" && git rebase --abort >/dev/null 2>&1 || true)
      warn "$branch does not rebase cleanly onto $TARGET; left untouched. Rebase it by hand."
      continue
    fi
    REBASED="$(cd "$PRWT" && git rev-parse HEAD)"
    verify "$PRWT" "$branch"
    if [ "$(current_branch)" = "$branch" ]; then
      git reset --keep "$REBASED" || die "could not update the checked-out $branch (stash your changes)"
    else
      git update-ref "refs/heads/$branch" "$REBASED"
    fi
    git push --quiet --force-with-lease="$branch:$LEASE" "$ORIGIN" "$branch"
    info "$branch rebased onto $TARGET and pushed (--force-with-lease)"
  fi
done

record_status ok "synced"
info "done"
