import { RANGES, buildSnapshot, formatTokens, runtimeStatus } from './snapshot.mjs';

const REFRESH_MS = 30_000;
const $ = (id) => document.getElementById(id);
const tauri = window.__TAURI__;
let range = 'today';

async function readFile(name) {
  if (!tauri) return null;
  try {
    const raw = await tauri.core.invoke('read_pilot_file', { name });
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.warn(`read ${name} failed`, err);
    return null;
  }
}

function fillList(id, items, row) {
  const ul = $(id);
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No data';
    ul.append(li);
    return;
  }
  for (const item of items) {
    const [name, val] = row(item);
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = name;
    const v = document.createElement('span');
    v.className = 'val';
    v.textContent = val;
    li.append(n, v);
    ul.append(li);
  }
}

const pct = (share) => `${Math.round(share * 100)}%`;

function render(snap, runtime) {
  const status = runtimeStatus(runtime);
  $('dot').classList.toggle('on', status.active);
  $('version').textContent = status.version;
  $('updated').textContent = runtime?.updatedAt
    ? new Date(runtime.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  $('error').hidden = !snap.error;
  $('error').textContent = snap.error ?? '';
  $('total').textContent = formatTokens(snap.totalTokens);
  $('input').textContent = formatTokens(snap.inputTokens);
  $('output').textContent = formatTokens(snap.outputTokens);
  $('cache').textContent = formatTokens(snap.cacheReadTokens);
  $('sessions').textContent = snap.totalSessions;
  $('requests').textContent = snap.totalRequests;
  $('tools').textContent = snap.totalToolCalls;
  fillList('agents', snap.agents, (a) => [a.agentType, `${a.events} ev · ${formatTokens(a.tokens)}`]);
  fillList('providers', snap.providers, (p) => [p.provider, `${pct(p.share)} · ${formatTokens(p.tokens)}`]);
  fillList('models', snap.models, (m) => [m.model, `${pct(m.share)} · ${formatTokens(m.tokens)}`]);
  fillList('repos', snap.repos, (r) => [r.repo, `${r.sessions} sess · ${r.events} evt`]);
  const max = Math.max(1, ...snap.dailyTokens.map((d) => d.value));
  $('trend').replaceChildren(...snap.dailyTokens.map((d) => {
    const bar = document.createElement('i');
    bar.style.height = `${Math.max(3, (d.value / max) * 100)}%`;
    bar.title = `${d.day}: ${formatTokens(d.value)}`;
    return bar;
  }));
}

async function refresh() {
  const [summary, runtime] = await Promise.all([readFile('metrics'), readFile('runtime')]);
  render(buildSnapshot(summary, range), runtime);
}

for (const btn of document.querySelectorAll('#ranges button')) {
  btn.addEventListener('click', () => {
    if (!RANGES.includes(btn.dataset.range)) return;
    range = btn.dataset.range;
    for (const b of document.querySelectorAll('#ranges button')) b.classList.toggle('on', b === btn);
    refresh();
  });
}

refresh();
setInterval(refresh, REFRESH_MS);
tauri?.event?.listen('panel-shown', refresh);
