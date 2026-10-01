#!/usr/bin/env node
// Verificação 5 da fase 0 (fork NTConsult): confere se os textos que o JSONL de eventos tem
// (prompts, respostas, prompt de sistema) chegam inteiros aos spans do otlp-debug.
// Compara texto cru com texto cru: cada parte de texto do evento precisa aparecer inteira
// nos atributos gen_ai.* de algum span.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const CAMPOS = [
  ['gen_ai.input.messages', 'entradas', 'entradasCompletas'],
  // Os eventos reais (ex.: llm.request do claude-code) trazem o prompt aqui, não em gen_ai.input.messages.
  ['gen_ai.input.messages_delta', 'entradas', 'entradasCompletas'],
  ['gen_ai.output.messages', 'saidas', 'saidasCompletas'],
  ['gen_ai.system_instructions', 'sistema', 'sistemaNoSpan'],
];

function textos(valor) {
  let v = valor;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return [v]; } }
  const out = [];
  const visitar = (x) => {
    if (typeof x === 'string') { if (x.length > 0) out.push(x); return; }
    if (Array.isArray(x)) { x.forEach(visitar); return; }
    if (x && typeof x === 'object') {
      if (typeof x.content === 'string') out.push(x.content);
      else Object.values(x).forEach(visitar);
    }
  };
  visitar(v);
  return out;
}

export function compareSpanJsonl({ jsonlLines, spanLines }) {
  // Texto cru dos atributos gen_ai.* dos spans (o valor do atributo é, ele mesmo, JSON em string).
  const corpusSpans = spanLines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean)
    .flatMap((s) => Object.entries(s.attributes ?? {})
      .filter(([k]) => k.startsWith('gen_ai.'))
      .flatMap(([, v]) => textos(v)))
    .join('\u0000');
  const report = { entradas: 0, entradasCompletas: 0, saidas: 0, saidasCompletas: 0, sistema: 0, sistemaNoSpan: 0, faltando: [] };
  for (const linha of jsonlLines) {
    let ev;
    try { ev = JSON.parse(linha); } catch { continue; }
    if (ev['event.name'] === 'agent.input') continue; // cópia de compatibilidade, fora do trace
    for (const [campo, total, completos] of CAMPOS) {
      if (ev[campo] === undefined) continue;
      const partes = textos(ev[campo]);
      if (partes.length === 0) continue; // marcador estrutural sem conteúdo (ex.: delta [])
      report[total] += 1;
      const inteiro = partes.every((t) => corpusSpans.includes(t));
      if (inteiro) report[completos] += 1;
      else report.faltando.push({ eventId: ev['event.id'], campo });
    }
  }
  return report;
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []));
  if (!args.agent || !args.date) {
    console.error('uso: compare-span-jsonl.mjs --agent <tipo> --date AAAA-MM-DD [--data-dir DIR] [--service NOME]');
    process.exit(2);
  }
  const dataDir = args['data-dir'] ?? path.join(os.homedir(), '.loongsuite-pilot');
  const service = args.service ?? 'loongsuite-pilot';
  const ler = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
  const jsonl = path.join(dataDir, 'logs', 'output', `${args.agent}-${args.date}.jsonl`);
  const spans = path.join(dataDir, 'logs', 'otlp-debug', `${service}-${args.agent}-${args.date}.jsonl`);
  const report = compareSpanJsonl({ jsonlLines: ler(jsonl), spanLines: ler(spans) });
  console.log(JSON.stringify({ jsonl, spans, ...report, faltando: report.faltando.slice(0, 50) }, null, 2));
  process.exit(report.faltando.length === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
