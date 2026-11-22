// Линк билдинг: търсене на сайтове за партньорство (SerpApi), контакти и проверка на получените линкове.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as cheerio from 'cheerio';
import { getSettings, serpPage, realLink } from './ranks.js';
import { fetchFollow, normalize } from './crawler.js';

let DATA_DIR = 'data';
export const setDataDir = (d) => { DATA_DIR = d; };
const FILE = () => path.join(DATA_DIR, 'outreach.json');
export async function listCampaigns() { try { return JSON.parse(await readFile(FILE(), 'utf8')); } catch { return []; } }
async function save(c) { await mkdir(DATA_DIR, { recursive: true }); await writeFile(FILE(), JSON.stringify(c, null, 2), 'utf8'); }

// Шаблони за търсене. {kw} се заменя с ключовата дума.
export const FOOTPRINTS = [
  { id: 'guest_bg', label: 'Гост статии (БГ)', q: '"{kw}" ("гост статия" OR "пишете за нас" OR "станете автор" OR "публикувайте статия")' },
  { id: 'guest_en', label: 'Гост статии (EN)', q: '"{kw}" ("write for us" OR "guest post" OR "contribute")' },
  { id: 'resources', label: 'Страници с полезни връзки', q: '"{kw}" (intitle:"полезни връзки" OR intitle:"полезни линкове" OR intitle:ресурси OR intitle:resources)' },
  { id: 'blogs', label: 'Блогове по темата', q: '"{kw}" блог' },
  { id: 'directories', label: 'Каталози и указатели', q: '"{kw}" (каталог OR указател OR "добави сайт" OR "добавете фирма")' },
  { id: 'forums', label: 'Форуми', q: '"{kw}" (форум OR inurl:forum OR inurl:topic)' },
  { id: 'reviews', label: 'Ревюта и сравнения', q: '"{kw}" (ревю OR сравнение OR "топ 10" OR класация)' },
];

// Големи платформи, от които не се взимат линкове чрез контакт
const SKIP = /(^|\.)(google\.[a-z.]+|youtube\.com|facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|pinterest\.[a-z.]+|tiktok\.com|reddit\.com|wikipedia\.org|amazon\.[a-z.]+|ebay\.[a-z.]+|olx\.bg|apple\.com|microsoft\.com|github\.com|gitlab\.com|stackoverflow\.com|stackexchange\.com|quora\.com)$/i;
const host = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const bare = (d) => (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');

export const STATUSES = ['new', 'good', 'contacted', 'replied', 'won', 'rejected'];

export async function upsertCampaign(input) {
  const all = await listCampaigns();
  const clean = {
    name: (input.name || '').trim() || bare(input.domain),
    domain: bare(input.domain),
    keywords: [...new Set((input.keywords || []).map((k) => k.trim()).filter(Boolean))].slice(0, 50),
    footprints: (input.footprints || []).filter((f) => FOOTPRINTS.some((x) => x.id === f)),
    gl: input.gl || 'bg', hl: input.hl || 'bg',
  };
  if (!clean.domain) throw new Error('Въведи своя домейн');
  if (!clean.keywords.length) throw new Error('Въведи поне една тема');
  if (!clean.footprints.length) throw new Error('Избери поне един вид сайтове');
  const ex = input.id && all.find((c) => c.id === input.id);
  if (ex) Object.assign(ex, clean);
  else all.push({ id: randomUUID(), createdAt: new Date().toISOString(), prospects: [], searched: [], ...clean });
  await save(all);
  return ex || all.at(-1);
}
export async function deleteCampaign(id) { await save((await listCampaigns()).filter((c) => c.id !== id)); }

export async function updateProspect(cid, pid, patch) {
  const all = await listCampaigns();
  const p = all.find((c) => c.id === cid)?.prospects.find((x) => x.id === pid);
  if (!p) throw new Error('Няма такъв сайт');
  for (const k of ['status', 'notes', 'contact', 'linkUrl']) if (typeof patch[k] === 'string') p[k] = patch[k].slice(0, 4000);
  if (patch.status && !STATUSES.includes(patch.status)) throw new Error('Невалиден статус');
  p.updatedAt = new Date().toISOString();
  await save(all);
  return p;
}
export async function deleteProspect(cid, pid) {
  const all = await listCampaigns();
  const c = all.find((x) => x.id === cid);
  const p = c?.prospects.find((x) => x.id === pid);
  if (p) {
    c.prospects = c.prospects.filter((x) => x.id !== pid);
    c.ignored = [...new Set([...(c.ignored || []), p.host])]; // да не се появява пак при следващо търсене
  }
  await save(all);
}

// Само комбинации, които още не са търсени, за да не се харчат заявки два пъти.
export function pendingQueries(c) {
  const out = [];
  for (const kw of c.keywords) for (const f of c.footprints) {
    const key = `${f}|${kw}`;
    if (!(c.searched || []).includes(key)) out.push({ key, kw, f, q: FOOTPRINTS.find((x) => x.id === f).q.replaceAll('{kw}', kw) });
  }
  return out;
}

export async function runSearch(cid, onProgress = () => {}, signal) {
  const { serpapiKey } = await getSettings();
  if (!serpapiKey) throw new Error('Първо въведи SerpApi ключ в Настройки');
  const c0 = (await listCampaigns()).find((c) => c.id === cid);
  if (!c0) throw new Error('Няма такава кампания');
  const todo = pendingQueries(c0);
  const found = []; const done = [];
  let i = 0;
  for (const t of todo) {
    if (signal?.aborted) break;
    onProgress({ phase: 'Търся сайтове', done: i, queued: todo.length, current: t.q });
    try {
      const results = await serpPage(serpapiKey, t.q, { gl: c0.gl, hl: c0.hl, device: 'desktop' }, 0);
      for (const r of results) found.push({ url: realLink(r), title: r.title, snippet: r.snippet, kw: t.kw, f: t.f });
      done.push(t.key);
    } catch (e) {
      if (/api key|run out|account/i.test(e.message)) throw e;
    }
    i++;
  }
  // сливаме с текущото състояние (може да е редактирано междувременно)
  const all = await listCampaigns();
  const c = all.find((x) => x.id === cid);
  if (!c) return { added: 0 };
  c.searched = [...new Set([...(c.searched || []), ...done])];
  const byHost = new Map(c.prospects.map((p) => [p.host, p]));
  const ignored = new Set(c.ignored || []);
  let added = 0;
  for (const r of found) {
    const hst = host(r.url);
    if (!hst || SKIP.test(hst) || hst === c.domain || hst.endsWith('.' + c.domain) || ignored.has(hst)) continue;
    let p = byHost.get(hst);
    if (!p) {
      p = { id: randomUUID(), host: hst, url: r.url, title: r.title, snippet: r.snippet, found: [], status: 'new', notes: '', contact: '', linkUrl: '', createdAt: new Date().toISOString() };
      c.prospects.push(p); byHost.set(hst, p); added++;
    }
    const tag = `${FOOTPRINTS.find((x) => x.id === r.f).label}: ${r.kw}`;
    if (!p.found.includes(tag)) p.found.push(tag);
  }
  await save(all);
  return { added, searches: done.length };
}

// ---------- контакти (без SerpApi) ----------
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const BAD_EMAIL = /\.(png|jpe?g|gif|webp|svg)$|@(sentry|example|domain|email)\.|wixpress|u003e/i;
async function getHtml(url) {
  const r = await fetchFollow(url, { timeout: 12000 });
  if (r.res.status !== 200 || !(r.res.headers.get('content-type') || '').includes('html')) { try { await r.res.body?.cancel(); } catch {} return null; }
  return { html: await r.res.text(), url: r.finalUrl };
}
function extract(html, base) {
  const $ = cheerio.load(html);
  const emails = new Set();
  $('a[href^="mailto:"]').each((_, e) => { const m = ($(e).attr('href') || '').slice(7).split('?')[0].trim(); if (m) emails.add(decodeURIComponent(m).toLowerCase()); });
  for (const m of $('body').text().match(EMAIL) || []) emails.add(m.toLowerCase());
  const pages = new Set();
  $('a[href]').each((_, e) => {
    const t = ($(e).text() + ' ' + $(e).attr('href')).toLowerCase();
    if (/контакт|contact|за нас|about|реклама|advertis|сътрудничество|пишете/.test(t)) { const n = normalize($(e).attr('href'), base); if (n && host(n) === host(base)) pages.add(n); }
  });
  return { emails: [...emails].filter((e) => !BAD_EMAIL.test(e)), pages: [...pages] };
}
export async function findContacts(cid, pid) {
  const all = await listCampaigns();
  const p = all.find((c) => c.id === cid)?.prospects.find((x) => x.id === pid);
  if (!p) throw new Error('Няма такъв сайт');
  const emails = new Set(); const pages = new Set();
  try {
    const home = await getHtml(`https://${p.host}/`);
    if (home) {
      const e = extract(home.html, home.url); e.emails.forEach((x) => emails.add(x)); e.pages.forEach((x) => pages.add(x));
      for (const pg of [...pages].slice(0, 3)) {
        try { const sub = await getHtml(pg); if (sub) extract(sub.html, sub.url).emails.forEach((x) => emails.add(x)); } catch {}
      }
    }
  } catch {}
  p.emails = [...emails].slice(0, 10);
  p.contactPages = [...pages].slice(0, 5);
  p.contactChecked = new Date().toISOString();
  if (!p.contact && p.emails.length) p.contact = p.emails[0];
  await save(all);
  return p;
}

// ---------- проверка на получен линк (без SerpApi) ----------
export async function verifyLink(cid, pid) {
  const all = await listCampaigns();
  const c = all.find((x) => x.id === cid);
  const p = c?.prospects.find((x) => x.id === pid);
  if (!p) throw new Error('Няма такъв сайт');
  if (!p.linkUrl) throw new Error('Въведи адреса на страницата, където е линкът');
  let result;
  try {
    const page = await getHtml(p.linkUrl);
    if (!page) result = { ok: false, text: 'Страницата не се отваря или не е HTML' };
    else {
      const $ = cheerio.load(page.html);
      const links = $('a[href]').map((_, e) => ({ href: normalize($(e).attr('href'), page.url), rel: ($(e).attr('rel') || '').toLowerCase(), text: $(e).text().replace(/\s+/g, ' ').trim() })).get()
        .filter((l) => l.href && (host(l.href) === c.domain || host(l.href)?.endsWith('.' + c.domain)));
      const robots = ($('meta[name="robots" i]').attr('content') || '').toLowerCase();
      if (!links.length) result = { ok: false, text: `Няма линк към ${c.domain} на тази страница` };
      else {
        const follow = links.find((l) => !/nofollow|sponsored|ugc/.test(l.rel));
        const l = follow || links[0];
        result = { ok: true, follow: !!follow && !/nofollow/.test(robots), href: l.href, anchor: l.text, rel: l.rel,
          text: `Линкът е намерен → ${l.href}${l.text ? ` (текст: „${l.text.slice(0, 60)}“)` : ''}. ${follow && !/nofollow/.test(robots) ? 'Предава сила (dofollow).' : 'Маркиран е като nofollow/sponsored, тоест предава малко сила.'}${/noindex/.test(robots) ? ' Внимание: страницата е скрита от Google (noindex).' : ''}` };
      }
    }
  } catch (e) { result = { ok: false, text: 'Грешка: ' + (e.cause?.code || e.message) }; }
  p.verify = { ...result, at: new Date().toISOString() };
  await save(all);
  return p;
}
