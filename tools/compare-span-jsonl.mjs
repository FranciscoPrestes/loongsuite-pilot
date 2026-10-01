#!/usr/bin/env node
// Verificação 5 da fase 0 (fork NTConsult): confere se os textos que o JSONL de eventos tem
// (prompts, respostas, prompt de sistema) chegam inteiros aos spans do otlp-debug.
// Compara texto cru com texto cru: cada parte de texto do evento precisa aparecer inteira
// nos atributos gen_ai.* de um span da mesma sessão. Fontes conhecidas de falso FAIL: ver FALSOS_FALHAS.
import * as fs from 'node:fs';
import * as readline from 'node:readline';
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
      if (typeof x.content === 'string') { if (x.content.length > 0) out.push(x.content); }
      else Object.entries(x).forEach(([k, val]) => { if (k !== 'role' && k !== 'type') visitar(val); }); // role/type são rótulos, não conteúdo
    }
  };
  visitar(v);
  return out;
}

// Fontes conhecidas de falso FAIL (o conversor derruba ou move dados antes do span):
const FALSOS_FALHAS = [
  'campos de string da mensagem fora de role/parts (ex.: name, id) são descartados pelo conversor',
  'mensagens com `content` mas sem `parts` são descartadas pelo conversor (perda real: mantida como faltando)',
  'mensagens de sistema do Grok são movidas para gen_ai.system_instructions (o corpus por sessão as cobre)',
];

const MIN_TEXTO = 20; // abaixo disso, um casamento fora da própria sessão não prova nada
const NAO_COMPARADOS = ['gen_ai.tool.call.arguments', 'gen_ai.tool.call.result', 'gen_ai.tool.definitions', 'agent.content'];

function parseLinha(linha) {
  try { return JSON.parse(linha); } catch { return null; }
}

// Corpus de textos dos spans, por sessão (gen_ai.session.id). Spans sem sessão herdam a
// sessão de outro span do mesmo traceId; os que restam só entram no corpus global.
export function createComparer() {
  const global = new Set();
  const porSessao = new Map();
  const sessaoDoTrace = new Map();
  const pendentes = [];
  const invalidas = { eventos: 0, spans: 0 };
  const report = {
    entradas: 0, entradasCompletas: 0, saidas: 0, saidasCompletas: 0, sistema: 0, sistemaNoSpan: 0,
    inconclusivos: 0, semSessao: 0, linhasInvalidas: invalidas, naoComparados: NAO_COMPARADOS, faltando: [],
  };
  const conjunto = (sessao) => {
    if (!porSessao.has(sessao)) porSessao.set(sessao, new Set());
    return porSessao.get(sessao);
  };

  function addSpanLine(linha) {
    const s = parseLinha(linha);
    if (!s || typeof s !== 'object') { invalidas.spans += 1; return; }
    const attrs = s.attributes ?? {};
    const textosSpan = Object.entries(attrs)
      .filter(([k]) => k.startsWith('gen_ai.'))
      .flatMap(([, v]) => textos(v));
    textosSpan.forEach((t) => global.add(t));
    const sessao = attrs['gen_ai.session.id'];
    if (sessao) {
      textosSpan.forEach((t) => conjunto(sessao).add(t));
      if (s.traceId) sessaoDoTrace.set(s.traceId, sessao);
    } else if (s.traceId) {
      pendentes.push([s.traceId, textosSpan]);
    }
  }

  function resolverPendentes() {
    for (const [trace, ts] of pendentes.splice(0)) {
      const sessao = sessaoDoTrace.get(trace);
      if (sessao) ts.forEach((t) => conjunto(sessao).add(t));
    }
  }

  function addEventLine(linha) {
    resolverPendentes();
    const ev = parseLinha(linha);
    if (!ev || typeof ev !== 'object') { invalidas.eventos += 1; return; }
    if (ev['event.name'] === 'agent.input') return; // cópia de compatibilidade, fora do trace
    const sessao = ev['gen_ai.session.id'];
    const proprio = sessao ? (porSessao.get(sessao) ?? new Set()) : global;
    let contouSemSessao = false;
    for (const [campo, total, completos] of CAMPOS) {
      if (ev[campo] === undefined) continue;
      const partes = textos(ev[campo]);
      if (partes.length === 0) continue; // marcador estrutural sem conteúdo (ex.: delta [])
      report[total] += 1;
      if (!sessao && !contouSemSessao) { report.semSessao += 1; contouSemSessao = true; }
      let faltou = false;
      let fraco = false;
      for (const t of partes) {
        if (proprio.has(t) && (sessao || t.length >= MIN_TEXTO)) continue;
        if (global.has(t) && t.length < MIN_TEXTO) fraco = true;
        else if (!proprio.has(t)) faltou = true;
      }
      if (faltou) report.faltando.push({ eventId: ev['event.id'], campo });
      else if (fraco) report.inconclusivos += 1;
      else report[completos] += 1;
    }
  }

  return { addSpanLine, addEventLine, report: () => { resolverPendentes(); return report; } };
}

export function compareSpanJsonl({ jsonlLines, spanLines }) {
  const c = createComparer();
  spanLines.forEach(c.addSpanLine);
  jsonlLines.forEach(c.addEventLine);
  return c.report();
}

// files: { jsonl: { exists, lines }, spans: { exists, lines } }
// Motivo pelo qual a comparação não prova nada (null quando é conclusiva).
export function razaoInconclusivo(report, files) {
  if (!files.jsonl.exists || files.jsonl.lines === 0) return 'arquivo de eventos (logs/output) ausente ou vazio';
  if (!files.spans.exists || files.spans.lines === 0) return 'arquivo otlp-debug ausente ou vazio (só existe com otlpTrace.debug ligado)';
  if (report.entradas === 0 || report.saidas === 0) return 'nenhuma entrada ou nenhuma saída foi comparada';
  return null;
}

function razaoSemProva(report) {
  if (report.inconclusivos > 0) return `${report.inconclusivos} comparação(ões) inconclusiva(s): texto curto casou só fora da própria sessão`;
  if (report.entradasCompletas === 0 || report.saidasCompletas === 0) return 'nenhuma entrada ou nenhuma saída foi confirmada por inteiro';
  return null;
}

// 0 ok, 1 faltando, 3 inconclusivo (nada comparado, ou sem prova suficiente).
export function exitCodeFor(report, files) {
  if (razaoInconclusivo(report, files)) return 3;
  if (report.faltando.length > 0) return 1;
  return razaoSemProva(report) ? 3 : 0;
}

async function lerLinhas(p, onLinha) {
  if (!fs.existsSync(p)) return { exists: false, lines: 0 };
  let lines = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) { if (l) { lines += 1; onLinha(l); } }
  return { exists: true, lines };
}

function diaSeguinte(data) {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = Object.fromEntries(argv.reduce((acc, a, i, all) => {
    if (a.startsWith('--') && a !== '--include-next-day') acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []));
  if (!args.agent || !args.date) {
    console.error('uso: compare-span-jsonl.mjs --agent <tipo> --date AAAA-MM-DD [--data-dir DIR] [--service NOME] [--include-next-day]');
    process.exit(2);
  }
  const dataDir = args['data-dir'] ?? path.join(os.homedir(), '.loongsuite-pilot');
  const service = args.service ?? 'loongsuite-pilot';
  const jsonl = path.join(dataDir, 'logs', 'output', `${args.agent}-${args.date}.jsonl`);
  const debugPath = (dia) => path.join(dataDir, 'logs', 'otlp-debug', `${service}-${args.agent}-${dia}.jsonl`);
  const spanFiles = [debugPath(args.date)];
  if (argv.includes('--include-next-day')) spanFiles.push(debugPath(diaSeguinte(args.date)));

  const c = createComparer();
  const spans = { exists: false, lines: 0 };
  for (const f of spanFiles) {
    const r = await lerLinhas(f, c.addSpanLine);
    spans.exists = spans.exists || r.exists;
    spans.lines += r.lines;
  }
  const events = await lerLinhas(jsonl, c.addEventLine);
  const report = c.report();
  const files = { jsonl: events, spans };
  const code = exitCodeFor(report, files);
  console.log(JSON.stringify({
    jsonl, spans: spanFiles, arquivos: files, ...report, faltando: report.faltando.slice(0, 50),
    avisos: FALSOS_FALHAS,
    aviso: 'otlp-debug é datado pela hora do flush: turno que cruza a meia-noite pode aparecer como falso "faltando" (use --include-next-day).',
  }, null, 2));
  if (code === 3) {
    console.error(`INCONCLUSIVO: ${razaoInconclusivo(report, files) ?? razaoSemProva(report)}. Confira --agent/--date/--data-dir.`);
  }
  process.exit(code);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
