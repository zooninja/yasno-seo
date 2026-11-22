// Позиции в Google чрез SerpApi. Ключът се пази само локално в data/settings.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { keywordPositions } from './gsc.js';

let DATA_DIR = 'data';
export const setDataDir = (d) => { DATA_DIR = d; };
const file = (n) => path.join(DATA_DIR, n);

async function readJson(name, fallback) {
  try { return JSON.parse(await readFile(file(name), 'utf8')); } catch { return fallback; }
}
async function writeJson(name, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file(name), JSON.stringify(value, null, 2), 'utf8');
}

export const getSettings = () => readJson('settings.json', {});
export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await writeJson('settings.json', s);
  return s;
}

export const listProjects = () => readJson('rank-projects.json', []);
const saveProjects = (p) => writeJson('rank-projects.json', p);

const bare = (d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
const hostMatches = (link, domain) => {
  try { const h = new URL(link).hostname.toLowerCase().replace(/^www\./, ''); return h === domain || h.endsWith('.' + domain); }
  catch { return false; }
};

// Google понякога дава пренасочващ адрес (google.bg/goto?...). Тогава истинският
// домейн е само в displayed_link, например „https://www.instagram.com › ...“.
export function realLink(r) {
  try {
    if (!/(^|\.)google\.[a-z.]+$/i.test(new URL(r.link).hostname)) return r.link;
  } catch {}
  const shown = (r.displayed_link || '').split(' › ')[0].trim();
  if (!shown) return r.link;
  try { return new URL(/^https?:\/\//.test(shown) ? shown : 'https://' + shown).origin + '/'; } catch { return r.link; }
}

const GOOGLE_DOMAIN = { bg: 'google.bg', us: 'google.com', uk: 'google.co.uk', de: 'google.de', gr: 'google.gr', ro: 'google.ro', fr: 'google.fr', es: 'google.es', it: 'google.it', tr: 'google.com.tr' };

export async function upsertProject(input) {
  const projects = await listProjects();
  const clean = {
    name: (input.name || input.domain || '').trim(),
    domain: bare(input.domain || ''),
    competitors: (input.competitors || []).map(bare).filter(Boolean).slice(0, 5),
    keywords: [...new Set((input.keywords || []).map((k) => k.trim()).filter(Boolean))].slice(0, 500),
    gl: input.gl || 'bg', hl: input.hl || 'bg',
    location: (input.location || '').trim(),
    device: ['mobile', 'all'].includes(input.device) ? input.device : 'desktop',
    depth: [10, 20, 30, 50, 100].includes(Number(input.depth)) ? Number(input.depth) : 30,
    source: input.source === 'gsc' ? 'gsc' : 'serpapi',
    schedule: ['off', 'daily', 'weekly', 'monthly'].includes(input.schedule) ? input.schedule : 'off',
  };
  if (clean.source === 'serpapi' && clean.schedule === 'daily') clean.schedule = 'weekly'; // ежедневно с SerpApi изчерпва плана
  if (clean.source === 'serpapi' && clean.gl === 'all') clean.gl = 'us'; // SerpApi изисква конкретна държава
  if (clean.source === 'serpapi' && clean.device === 'all') clean.device = 'desktop';
  if (!clean.domain) throw new Error('Въведи домейн');
  if (!clean.keywords.length) throw new Error('Въведи поне една ключова дума');
  const existing = input.id && projects.find((p) => p.id === input.id);
  if (existing) Object.assign(existing, clean);
  else projects.push({ id: randomUUID(), history: [], createdAt: new Date().toISOString(), ...clean });
  await saveProjects(projects);
  return existing || projects.at(-1);
}

export async function deleteProject(id) {
  await saveProjects((await listProjects()).filter((p) => p.id !== id));
}

export async function accountInfo(key) {
  const res = await fetch('https://serpapi.com/account.json?api_key=' + encodeURIComponent(key));
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return { searchesLeft: j.total_searches_left ?? j.plan_searches_left, plan: j.plan_name, perMonth: j.searches_per_month, thisMonth: j.this_month_usage };
}

export async function serpPage(key, q, p, start) {
  const params = new URLSearchParams({
    engine: 'google', q, api_key: key, gl: p.gl, hl: p.hl,
    google_domain: GOOGLE_DOMAIN[p.gl] || 'google.com', device: p.device, start: String(start), num: '10',
  });
  if (p.location) params.set('location', p.location);
  const res = await fetch('https://serpapi.com/search.json?' + params);
  const j = await res.json();
  if (j.error) {
    if (/hasn't returned any results/i.test(j.error)) return [];
    throw new Error(j.error);
  }
  return j.organic_results || [];
}

async function checkKeyword(key, q, p) {
  const out = { position: null, url: null, title: null, competitors: {}, top: [], searches: 0 };
  const want = new Set(p.competitors);
  let pos = 0;
  for (let start = 0; start < p.depth; start += 10) {
    const results = await serpPage(key, q, p, start);
    out.searches++;
    for (const raw of results) {
      const r = { ...raw, link: realLink(raw) };
      pos++;
      if (out.top.length < 10) out.top.push({ position: pos, title: r.title, link: r.link });
      if (out.position == null && hostMatches(r.link, p.domain)) { out.position = pos; out.url = r.link; out.title = r.title; }
      for (const c of want) if (!out.competitors[c] && hostMatches(r.link, c)) out.competitors[c] = { position: pos, url: r.link };
    }
    if (results.length < 5) break; // няма следваща страница
    const allFound = out.position != null && [...want].every((c) => out.competitors[c]);
    if (allFound) break;
  }
  return out;
}

// Най-много заявки, които една проверка може да изхарчи
export const maxCost = (p) => (p.source === 'gsc' ? 0 : p.keywords.length * Math.ceil(p.depth / 10));

export async function runCheck(id, onProgress = () => {}, signal) {
  const projects = await listProjects();
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error('Няма такъв проект');
  const results = {};
  let searches = 0, i = 0;
  if (p.source === 'gsc') {
    onProgress({ phase: 'Взимам позициите от Search Console', done: 0, queued: 1 });
    const r = await keywordPositions(p.domain, p.keywords, { gl: p.gl, device: p.device, days: 7 });
    Object.assign(results, r.results); i = p.keywords.length;
  }
  const { serpapiKey } = await getSettings();
  if (p.source !== 'gsc' && !serpapiKey) throw new Error('Първо въведи SerpApi ключ в Настройки');
  for (const kw of p.source === 'gsc' ? [] : p.keywords) {
    if (signal?.aborted) break;
    onProgress({ phase: 'Проверявам позициите', done: i, queued: p.keywords.length, current: kw });
    try { const r = await checkKeyword(serpapiKey, kw, p); searches += r.searches; results[kw] = r; }
    catch (e) { results[kw] = { error: e.message }; if (/api key|run out|account/i.test(e.message)) break; }
    i++;
  }
  // прочитаме наново, в случай че проектът е редактиран междувременно
  const fresh = await listProjects();
  const target = fresh.find((x) => x.id === id);
  if (target) {
    target.history.push({ at: new Date().toISOString(), searches, source: p.source || 'serpapi', results });
    target.history = target.history.slice(-60);
    await saveProjects(fresh);
  }
  onProgress({ phase: 'Готово', done: i, queued: p.keywords.length });
  return { searches, results };
}
