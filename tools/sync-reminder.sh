#!/usr/bin/env bash
#
# sync-reminder.sh
# ---------------------------------------------------------------------------
# Prints a reminder when the NTConsult fork is due for a sync with the original
# repository, and stays silent otherwise. It never changes anything: the sync is
# always run by a person (or an assistant on their behalf) with
#   bash tools/sync-upstream.sh
#
# It speaks up in two cases:
#   1. the last sync is older than SYNC_REMIND_DAYS (default 1) or never happened;
#   2. the last attempt FAILED (for example a merge conflict). That case is shown
#      every time until a sync succeeds, so a failure cannot go unnoticed.
#
# The state is written by tools/sync-upstream.sh into this clone's git config
# (keys ntconsult.lastSync*), so it is local to the machine. The history of the
# syncs themselves is in git: `git log --first-parent NTConsult-main`.
#
# Wired in automatically for Claude Code through .claude/settings.json
# (SessionStart hook) and for other assistants through AGENTS.md.
#
#   bash tools/sync-reminder.sh              # quiet unless a sync is due
#   SYNC_REMIND_DAYS=3 bash tools/sync-reminder.sh
# ---------------------------------------------------------------------------
set -uo pipefail

DAYS="${SYNC_REMIND_DAYS:-1}"
UPSTREAM="${SYNC_UPSTREAM_REMOTE:-upstream}"
MIRROR="${SYNC_MIRROR_BRANCH:-main}"

case "$DAYS" in ''|*[!0-9]*) DAYS=1 ;; esac

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$ROOT" || exit 0
git remote get-url "$UPSTREAM" >/dev/null 2>&1 || exit 0

state() { git config --local --get "ntconsult.$1" 2>/dev/null || true; }
fmt_epoch() {
  date -r "$1" '+%Y-%m-%d %H:%M' 2>/dev/null || date -d "@$1" '+%Y-%m-%d %H:%M' 2>/dev/null || printf '%s' "$1"
}

NOW="$(date +%s)"
LAST_OK="$(state lastSyncEpoch)"
STATUS="$(state lastSyncStatus)"
MESSAGE="$(state lastSyncMessage)"
ATTEMPT="$(state lastSyncAttemptEpoch)"

case "$LAST_OK" in ''|*[!0-9]*) LAST_OK="" ;; esac
case "$ATTEMPT" in ''|*[!0-9]*) ATTEMPT="" ;; esac

FAILED=0
[ "$STATUS" = "failed" ] && FAILED=1

DUE=0
AGE_DAYS=0
if [ -z "$LAST_OK" ]; then
  DUE=1
else
  AGE_DAYS=$(( (NOW - LAST_OK) / 86400 ))
  [ $(( NOW - LAST_OK )) -ge $(( DAYS * 86400 )) ] && DUE=1
fi

[ "$FAILED" -eq 0 ] && [ "$DUE" -eq 0 ] && exit 0

# Only when a reminder is needed: a quick look at how far behind the original is.
BEHIND=""
if git fetch --quiet "$UPSTREAM" 2>/dev/null && git show-ref --verify --quiet "refs/heads/$MIRROR"; then
  BEHIND="$(git rev-list --count "$MIRROR..$UPSTREAM/$MIRROR" 2>/dev/null || true)"
fi

echo "================================================================"
echo "[NTConsult] LEMBRETE: sincronizar o fork com o repositorio original"
echo "================================================================"
if [ "$FAILED" -eq 1 ]; then
  when="?"; [ -n "$ATTEMPT" ] && when="$(fmt_epoch "$ATTEMPT")"
  echo "ATENCAO: a ultima tentativa de sincronizacao FALHOU ($when)."
  echo "Motivo: ${MESSAGE:-desconhecido}"
fi
if [ -z "$LAST_OK" ]; then
  echo "Ultima sincronizacao bem-sucedida: nunca registrada nesta maquina."
else
  echo "Ultima sincronizacao bem-sucedida: $(fmt_epoch "$LAST_OK") (ha ${AGE_DAYS} dia(s))."
fi
if [ -n "$BEHIND" ]; then
  if [ "$BEHIND" -gt 0 ]; then
    echo "O repositorio original tem ${BEHIND} commit(s) novo(s) que ainda nao estao no fork."
  else
    echo "O repositorio original nao tem commits novos desde a ultima sincronizacao."
  fi
fi
echo
echo "Para sincronizar (nada e enviado se houver conflito ou teste falhando):"
echo "  bash tools/sync-upstream.sh --dry-run    # ver o que mudaria"
echo "  bash tools/sync-upstream.sh              # sincronizar"
echo
echo "Assistente: avise o usuario sobre este lembrete antes de continuar e"
echo "ofereca rodar a sincronizacao. Nao rode sem o consentimento dele."
echo "================================================================"
exit 0
