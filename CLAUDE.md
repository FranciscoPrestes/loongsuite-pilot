See [AGENTS.md](./AGENTS.md) for project architecture, module docs, and development guidelines.

## Fork NTConsult: lembrete de sincronizacao

Este clone e o fork NTConsult do repositorio original. No inicio de cada sessao rode `bash tools/sync-reminder.sh` (o hook `SessionStart` de `.claude/settings.json` ja faz isso). Se ele imprimir algo, avise o usuario ANTES de qualquer outra coisa: a sincronizacao com o original esta atrasada ou a ultima tentativa falhou (por exemplo, conflito). Ofereca rodar `bash tools/sync-upstream.sh --dry-run` e depois sem `--dry-run`. Nunca sincronize sem o consentimento do usuario. Detalhes em [FORK.md](./FORK.md).

## Comunicação com o Francisco (executivo técnico)

- Respostas curtas e expositivas. Resultado e impacto primeiro. Sem narrar arquivo, módulo ou linha alterada; detalhe técnico só se ele perguntar.
- Relato final: feito / em andamento / deu certo / deu errado (e por quê) / decisões pendentes.
- Decisões em aberto: perguntar uma a uma (AskUserQuestion), nunca várias de uma vez. Explicar cada opção em palavras ("opção 5 = fazer tal coisa"), nunca só o rótulo, e dizer por que a decisão é necessária.
- Postura de dev sênior: filtrar o essencial, não despejar diffs, logs ou jargão.
