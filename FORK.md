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

## Cuidado ao rodar a suite de testes

Alguns testes de deploy do upstream (`tests/unit/deployment/inject-command.test.ts` e vizinhos) gravam no
`~/.claude/settings.json` real (variavel `env.LOONGSUITE_PILOT_DATA_DIR` apontando para uma pasta temporaria e
hooks do Pilot removidos ou trocados). Isso **quebra a coleta da propria maquina** ate alguem consertar.
Ha um PR aberto no original para isolar isso (alibaba/loongsuite-pilot#456). Ate ele entrar, rode a suite
sempre com um HOME descartavel:

```bash
env -u LOONGSUITE_PILOT_DATA_DIR HOME="$(mktemp -d)" ./node_modules/.bin/vitest run
```

O `tools/sync-upstream.sh` ja faz isso no seu gate de verificacao.

## Testes dos scripts

`bash tools/tests/sync-tools-test.sh` simula upstream, fork e clone em pasta temporaria (50 checagens).

## Release e rollback

Dois workflows manuais (`workflow_dispatch`), ambos com `concurrency: ntc-release` (um por vez) e login na Azure
por OIDC (sem chave de storage). Variaveis do repositorio (nao segredos): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
`AZURE_SUBSCRIPTION_ID`, `NTC_BLOB_BASE_URL`, `NTC_STORAGE_ACCOUNT`.

### Disparar uma release (canary)

`ntc-release.yml` com `source_ref` (padrao `NTConsult-main`), `rollout` (padrao `10`) e `dry_run` (padrao `true`).
A versao sai de `tools/ntc-release/cli.mjs next-version` a partir das tags `ntc-v*`. O fluxo e:
`prepare` -> `test` -> `package` -> `node-modules` (5 plataformas) -> `assemble` -> `publish`.

- Com `dry_run=true` (padrao) o fluxo termina no `assemble`: nada e publicado, e o artefato `blob-stage`
  mostra exatamente o que subiria. Antes do blob existir, a leitura do `latest.json` atual e tolerante a falha.
- `dry_run=false` **so depois do OK do Francisco e com o blob existindo**. O job `publish` roda no ambiente
  `ntc-canary`, falha se qualquer caminho imutavel ja existir (`releases/<v>/`, `deps/node-modules/<v>/`),
  espelha `deps/node/22.22.2/` so se ausente, grava `latest.json` com `If-Match`, depois `manifest/stable.txt` e
  `manifest/canary.txt`, e por ultimo cria a tag `ntc-v<versao>`. Se o `If-Match` falhar, nada mais foi
  gravado: rode de novo. Se uma publicacao parar no meio, os blobs de `releases/<v>/` ja enviados bloqueiam a
  repeticao; limpe-os (com OK) antes de rodar outra vez.

### Promover para stable

`ntc-promote.yml` com `version` (ex.: `1.2.0-ntc.1`, tem de ser o canary atual). O job `verify` baixa
`releases/<v>/` do blob, sem credencial, e confere o sha256 de todos os arquivos. O job `promote` roda no
ambiente `ntc-stable` (revisor obrigatorio): atualiza os aliases no servidor (`installer.sh`, `installer.ps1`
e `releases/latest/loongsuite-pilot.{tar.gz,zip}`), espera cada copia terminar e so entao grava `latest.json`
(`If-Match`), `stable.txt` e remove `canary.txt`.

### Rollback

O atualizador **nunca faz downgrade** (achado A3), entao nao ha "voltar" para uma versao antiga publicada.
Rollback = **republicar um commit bom**: dispare `ntc-release.yml` com `source_ref` apontando para o commit (ou
tag) bom. Ele sai com um numero de versao novo e maior (`-ntc.N+1`), entra como canary e depois se promove.
Para um canary ruim, basta nao promove-lo e publicar a correcao por cima.

### O que e mutavel

Tudo em `releases/<v>/` e `deps/` e imutavel (publicado com `--overwrite false`). So mudam: `latest.json`,
`manifest/stable.txt`, `manifest/canary.txt`, `install.sh`, `install.ps1` (raiz, `no-cache`) e os aliases
(`installer.sh`, `installer.ps1`, `releases/latest/*`).
