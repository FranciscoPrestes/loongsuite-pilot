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

Fila: o grupo `ntc-release` tem profundidade 1. Com uma execucao rodando e uma pendente, uma terceira
**substitui a pendente** (que e cancelada). Se um disparo sumiu, rode de novo.

### Pre-requisito: branch padrao

`workflow_dispatch` so funciona quando o arquivo do workflow existe no branch **padrao** do repositorio. Antes
da primeira execucao, ajuste o branch padrao do fork para `NTConsult-main` (GitHub > Settings > Branches). O
primeiro dry run, ja a partir do branch padrao, usa `source_ref=NTConsult-main`.

### Checklist de ambientes (configuracao do GitHub, feita pelo Francisco)

- [ ] Ambientes `ntc-canary` e `ntc-stable` restritos ao branch de deploy `NTConsult-main` (Settings > Environments > Deployment branches).
- [ ] `ntc-stable` com revisor obrigatorio (o Francisco).
- [ ] Cada ambiente com a sua credencial federada no Terraform (tarefa 13).

### Disparar uma release (canary)

`ntc-release.yml` com `source_ref` (padrao `NTConsult-main`), `rollout` (padrao `10`) e `dry_run` (padrao `true`).
A versao sai de `tools/ntc-release/cli.mjs next-version` a partir das tags `ntc-v*` e **tem de ser estritamente
maior que o stable e o canary publicados** (o `prepare` recusa, ate no dry run). O fluxo e:
`prepare` -> `test` -> `package` -> `node-modules` (5 plataformas) -> `assemble` -> `publish`.

- Com `dry_run=true` (padrao) o fluxo termina no `assemble`: nada e publicado, e o artefato `blob-stage`
  mostra exatamente o que subiria. Antes do blob existir, a leitura do `latest.json` atual e tolerante a falha.
- O `test` exclui dois testes PowerShell do upstream que ja estao vermelhos no `NTConsult-main`
  (`installer-multimodal-config.test.mjs` e `dashboard-lifecycle.test.mjs`) via `vitest.ntc-release.config.ts`; o resto roda.
- `dry_run=false` **so depois do OK do Francisco e com o blob existindo**. O job `publish` roda no ambiente
  `ntc-canary` e faz, nesta ordem: confere que o ETag do `latest.json` nao mudou; envia `releases/<v>/` e
  `deps/node-modules/<v>/` (retomavel na mesma execucao: um blob que ja existe so e aceito se o conteudo for identico, senao
  falha); espelha `deps/node/22.22.2/` so se ausente; envia `install.sh`/`install.ps1` da raiz **so se nao
  existirem** (primeira release; depois disso quem move esses arquivos e a promocao); confere o ETag de novo;
  grava `latest.json` com `If-Match`, `manifest/stable.txt` e `manifest/canary.txt`; confere que os `.txt`
  concordam com o `latest.json` (`check-channels.mjs`); e por ultimo cria a tag `ntc-v<versao>`.
- **Retomar uma publicacao interrompida:** use "Re-run failed jobs" na **mesma execucao** (ela reaproveita o
  artefato `blob-stage`, entao os bytes sao os mesmos e o envio retoma: blobs ja enviados e identicos sao
  pulados). Um **novo disparo nao retoma**: o `deploy/package-opensource.sh` grava `build_time` no pacote, entao
  os bytes saem diferentes e o envio imutavel recusa a mesma versao. Para refazer com um disparo novo, limpe antes
  os blobs da versao que nunca ficou valida com a ferramenta manual (nenhum workflow a usa):
  `bash tools/ntc-release/purge-unreleased.sh <versao>` (lista) e `... <versao> --yes` (apaga). Ela se recusa a
  agir se o `latest.json` referencia a versao (stable ou canary) ou se a tag `ntc-v<versao>` existe no origin.
  Requer `az login`, `NTC_STORAGE_ACCOUNT` e `AZURE_SUBSCRIPTION_ID`.
- Se o `If-Match` falhar (ou o ETag mudou entre o `assemble` e o `publish`), `latest.json` e os `.txt` **nao**
  foram alterados. "Re-run failed jobs" nao ajuda (o ETag guardado ficou velho): rode `purge-unreleased.sh
  <versao> --yes` e dispare uma execucao nova.
- Se a falha acontecer **depois** do `latest.json` (um `.txt` nao subiu, a checagem de canais reprovou, ou a tag
  nao subiu), o manifest ja aponta para a versao e uma nova execucao seria recusada (a versao nao e maior que o
  canary). O job tenta sozinho reparar os `.txt` a partir do `latest.json`; na mao:
  `node tools/ntc-release/check-channels.mjs --blob <url> --repair out` e
  `NTC_TXT_ONLY=1 bash tools/ntc-release/publish-manifest.sh out`. Depois crie a tag na mao, com o comando que o
  log imprime: `git tag ntc-v<versao> <sha> && git push origin ntc-v<versao>`. Como a tag e o ultimo passo, uma
  tag existente sempre significa release completa.

### Promover para stable

`ntc-promote.yml` com `version` (ex.: `1.2.0-ntc.1`, tem de ser o canary atual). O job `verify` baixa
`releases/<v>/` do blob, sem credencial, e confere o sha256 de todos os arquivos listados no `SHA256SUMS`, inclusive `thin/install.sh` e `thin/install.ps1`. O job `promote` roda no
ambiente `ntc-stable` (revisor obrigatorio): atualiza os aliases no servidor (`installer.sh`, `installer.ps1`,
`install.sh`, `install.ps1` na raiz, e `releases/latest/loongsuite-pilot.{tar.gz,zip}`; os `install.*` vem de
`releases/<v>/thin/`), espera cada copia terminar e so entao grava `latest.json` (`If-Match`), `stable.txt` e
remove `canary.txt`, e confere a consistencia dos canais.

### Rollback

O atualizador **nunca faz downgrade** (achado A3), entao nao ha "voltar" para uma versao antiga publicada.
Rollback = **republicar um commit bom**: dispare `ntc-release.yml` com `source_ref` apontando para o commit (ou
tag) bom. Ele sai com um numero de versao novo e maior (`-ntc.N+1`), entra como canary e depois se promove.
Isso so funciona enquanto o `version` do `package.json` desse commit for **maior ou igual** ao publicado. Se o
upstream subiu a versao base depois (por exemplo 1.2.0 para 1.3.0), o commit antigo geraria `1.2.0-ntc.N`, que o
`prepare` recusa; nesse caso faca um commit de reversao **na base atual** e publique-o, para sair um `-ntc.N`
maior na base corrente. Para um canary ruim, basta nao promove-lo e publicar a correcao por cima.

### O que e mutavel

Tudo em `releases/<v>/` e `deps/` e imutavel (publicado com `--overwrite false`). So mudam: `manifest/latest.json`,
`manifest/stable.txt`, `manifest/canary.txt` (a cada release e promocao), e, so na promocao, `install.sh`,
`install.ps1`, `installer.sh`, `installer.ps1` e `releases/latest/*` (aliases, `no-cache`).
