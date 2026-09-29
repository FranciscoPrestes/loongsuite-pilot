See [AGENTS.md](./AGENTS.md) for project architecture, module docs, and development guidelines.

## Fork NTConsult: lembrete de sincronizacao

Este clone e o fork NTConsult do repositorio original. No inicio de cada sessao rode `bash tools/sync-reminder.sh` (o hook `SessionStart` de `.claude/settings.json` ja faz isso). Se ele imprimir algo, avise o usuario ANTES de qualquer outra coisa: a sincronizacao com o original esta atrasada ou a ultima tentativa falhou (por exemplo, conflito). Ofereca rodar `bash tools/sync-upstream.sh --dry-run` e depois sem `--dry-run`. Nunca sincronize sem o consentimento do usuario. Detalhes em [FORK.md](./FORK.md).
