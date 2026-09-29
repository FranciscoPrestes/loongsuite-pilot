# Fork NTConsult do loongsuite-pilot

Este repositorio e o fork NTConsult de `alibaba/loongsuite-pilot`. Ele tem o nosso codigo
(por exemplo o coletor do GitHub Copilot) e precisa receber, de tempos em tempos, as
novidades do repositorio original. **A sincronizacao nao e automatica**: um conflito
passaria despercebido. Em vez disso, um lembrete aparece quando voce abre o Claude Code
(ou outro assistente) neste projeto.

## Branches

| Branch | Papel | Regra |
|---|---|---|
| `main` | Espelho do original (`upstream/main`) | Nunca commitar nele |
| `NTConsult-main` | Nossa versao: `main` + nossas mudancas | Recebe `git merge main` |
| `feat/*` | Branches com PR aberto no original | So mexer para acompanhar o PR |

Remotos: `origin` = fork (`FranciscoPrestes/loongsuite-pilot`), `upstream` = original.

## Lembrete

`bash tools/sync-reminder.sh` nao imprime nada quando esta tudo em dia. Ele fala em dois casos:

1. a ultima sincronizacao bem-sucedida tem mais de `SYNC_REMIND_DAYS` dias (padrao 1) ou nunca aconteceu;
2. a **ultima tentativa falhou** (por exemplo, conflito). Esse aviso se repete em toda sessao ate uma
   sincronizacao dar certo.

Quem dispara:
- **Claude Code**: hook `SessionStart` em `.claude/settings.json`.
- **Outros assistentes** (Codex, Copilot etc.): instrucao no `AGENTS.md` e em `.github/copilot-instructions.md`.

O estado fica na configuracao local do clone (`git config --local --get-regexp '^ntconsult\.'`).
O historico das sincronizacoes fica no proprio git: `git log --first-parent NTConsult-main`.

## Sincronizar

```bash
bash tools/sync-upstream.sh --dry-run   # mostra o que mudaria, nao altera nada
bash tools/sync-upstream.sh             # espelha main, mescla no NTConsult-main, testa e publica
```

O script trabalha num worktree temporario (nao mexe no seu diretorio de trabalho), roda
typecheck e os testes do Copilot antes de publicar, e **para sem enviar nada** se houver conflito,
`main` divergido ou teste falhando. Opcoes: `--update-pr-branches` (rebaseia e reenvia branches de PR
com `--force-with-lease`) e `--no-verify`.

### Se der conflito

O script lista os arquivos em conflito e nada foi enviado. Resolva na mao:

```bash
git switch NTConsult-main
git merge main            # resolva os arquivos, git add, git commit
bash tools/sync-upstream.sh   # roda de novo; sucesso limpa o aviso de falha
```

## Testes dos scripts

`bash tools/tests/sync-tools-test.sh` simula upstream, fork e clone em pasta temporaria (50 checagens).
