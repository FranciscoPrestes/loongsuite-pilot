# Regras de trabalho dos agentes (fork NTConsult)

Vale para qualquer agente (Claude Code, Codex, Copilot, outros) que mexa neste repositório.
`AGENTS.md` é o guia do projeto original (sincronizado com ele); este arquivo é só do fork e
nunca conflita com o original. Em caso de conflito entre os dois, vale este.

## 1. Uma worktree por tarefa (obrigatório)

Vários agentes trabalham ao mesmo tempo neste repositório. Dois agentes na mesma pasta e na mesma
branch já fizeram commit na branch errada e levaram trabalho alheio para uma release.

- **Nunca trabalhe no clone principal.** Ele fica na `NTConsult-main`, limpo, só para leitura.
  Não faça commit nele e não deixe uma branch de trabalho em checkout nele.
- **Toda tarefa começa numa worktree nova**, fora do repositório (`../<repo>-wt/<branch>`):

  ```bash
  bash tools/agent-worktree.sh start feat/minha-tarefa    # imprime o caminho; entre nele
  ```
- Trabalhe, teste e commite **só dentro dela**. Cada agente, a sua. Nunca mexa na worktree de outro.
- **Ao terminar, mescle e apague tudo** (worktree, branch local e branch remota):

  ```bash
  bash tools/agent-worktree.sh finish feat/minha-tarefa
  ```

  O script exige árvore limpa, faz rebase sobre `origin/NTConsult-main`, envia para a
  `NTConsult-main` e remove a worktree e as branches. Se o rebase tiver conflito, ele para e
  mantém a worktree para você resolver. Não deixe worktree nem branch para trás.
- Worktree nova não tem `node_modules`: ligue com `ln -s <clone-principal>/node_modules node_modules`
  ou rode `npm ci`.
- `bash tools/agent-worktree.sh list` mostra quem está trabalhando onde.
- Mudança que exige revisão antes de entrar: abra PR da branch em vez de rodar `finish`, e só
  apague a worktree depois do merge.

## 2. Antes de qualquer ação com efeito fora da sua máquina

Push, PR, comentário no repositório original, release, promoção. Peça autorização se o usuário
ainda não deu para aquele passo. Autorização para um passo não vale para o próximo.

- **Antes de release ou push na `NTConsult-main`**, rode `git log origin/NTConsult-main..HEAD`
  e confira que todos os commits são seus. Commit de outro agente só entra com o OK do usuário.
- **Sincronizar com o repositório original** só com consentimento
  (`tools/sync-upstream.sh --dry-run` primeiro). Detalhes em `FORK.md`.
- **Contribuição ao original** (PR, comentário em issue) só quando o usuário mandar.

## 3. Release

Detalhes em `FORK.md` ("Release e rollback"). Resumo:

1. Rode `ntc-release.yml` com `dry_run=true` e confira que passa.
2. Rode com `dry_run=false` (sai como canário, 10%).
3. `ntc-promote.yml` só com OK explícito do usuário, de preferência depois de alguns dias de canário.

Se o CI reprovar, corrija a causa. Não pule testes nem force.

## 4. Código e testes

- **Teste primeiro** (vermelho, depois verde). Cobertura mínima de 80% no que você escrever.
- **Testes com HOME descartável**: `HOME=$(mktemp -d) npx vitest run ...`. A suíte escreve em `~/.claude` e em outras pastas do agente.
- Saída do vitest aparece truncada pelo RTK: use `--reporter=json --outputFile=<arquivo>` e leia o arquivo.
- Arquivos pequenos (200–400 linhas, máximo 800), sem mutação de objetos, erros tratados em toda borda.
- Commits no formato `tipo: descrição` (feat, fix, refactor, docs, test, chore, perf, ci), em português
  ou inglês, e com a linha `Co-Authored-By` do agente.
- **Nada de segredo no repositório**: chaves, tokens, `.env`. Segredos ficam no Key Vault.
- Grafia: **NTConsult**, sempre junto, com NT e C maiúsculos.
- **Texto de interface em inglês** (app Mac, painel Tauri, dashboard). Nada em chinês nem português na UI.

## 5. Pegadinhas conhecidas

- **Binário do app Mac** (`app/macos-status-bar/bin/`) é versionado mas está no `.gitignore`: depois de
  mudar `Sources/`, rode `node scripts/build-status-bar-app.mjs` e `git add -f` o binário.
- **Ícone na barra de menu do Mac** pode sumir: com notch e barra cheia o macOS esconde ícones sem
  avisar. Por isso o painel novo (`app/tray`) abre também por atalho (Cmd/Ctrl+Alt+Shift+T).
- **Interface gráfica**: não envie cliques nem teclas à tela do usuário sem avisar antes.
- **Testes que falham só localmente** (`config-loader`, `inject-command`, perfil de PII, qoder cold start):
  o CI é o árbitro. Confirme no CI antes de tratar como defeito seu.
- **`opencode`**: o plugin do Pilot fica registrado como diretório (`plugins/opencode`), formato exigido
  pelo OpenCode 2.x. Prompts do usuário chegam pelo hook `session.prompt`.

## 6. Como falar com o Francisco

Respostas curtas, resultado e impacto primeiro, sem narrar arquivo nem linha alterada. Relato final:
feito / em andamento / deu certo / deu errado (e por quê) / decisões pendentes. Decisões em aberto
uma a uma, explicando cada opção em palavras. Detalhes em `CLAUDE.md`.
