// Ясно SEO: локален сървър. Слуша само на 127.0.0.1 (не е достъпен от мрежата).
import http from 'node:http';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { crawl } from './src/crawler.js';
import { analyze } from './src/rules.js';
import * as ranks from './src/ranks.js';
import * as outreach from './src/outreach.js';
import * as gsc from './src/gsc.js';
import * as scheduler from './src/scheduler.js';
import { peek } from './src/peek.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const AUDITS = path.join(DATA, 'audits');
const PORT = Number(process.env.PORT) || 4321;
ranks.setDataDir(DATA);
outreach.setDataDir(DATA);
gsc.setDataDir(DATA);
// Входът в Google се връща на този адрес: той е записан в Google Cloud, затова не се сменя.
const REDIRECT = `http://localhost:${PORT}`;

// Име на приложението в адреса на браузъра. Браузърите сами насочват всеки *.localhost
// към този компютър (RFC 6761), така че не е нужен hosts файл или DNS сървър.
// YASNO_HOST=localhost изключва името; YASNO_WEB_PORT=0 изключва порт 80.
const APP_HOST = (process.env.YASNO_HOST || 'yasno.seo.localhost').toLowerCase();
const WEB_PORT = process.env.YASNO_WEB_PORT != null ? Number(process.env.YASNO_WEB_PORT) : 80;
let appUrl = `http://${APP_HOST}:${PORT}`; // става без порт, ако порт 80 е свободен
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HOST_RE = new RegExp(`^(localhost|127\\.0\\.0\\.1|${esc(APP_HOST)})(:\\d+)?$`, 'i');
const ORIGIN_RE = new RegExp(`^http://(localhost|127\\.0\\.0\\.1|${esc(APP_HOST)})(:\\d+)?$`, 'i');
const isPlainLocal = (host) => /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host || '');

async function rawBody(req, limit = 50 * 1024 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('Файлът е твърде голям'); chunks.push(c); }
  return Buffer.concat(chunks);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.woff2': 'font/woff2' };

// ---------- задачи с прогрес (SSE) ----------
const jobs = new Map();
function startJob(kind, work) {
  const job = { id: randomUUID(), kind, status: 'running', progress: {}, result: null, error: null, clients: new Set(), ctrl: new AbortController() };
  jobs.set(job.id, job);
  const send = (event, data) => { for (const c of job.clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  job.send = send;
  work(job, (p) => { job.progress = p; send('progress', p); })
    .then((r) => { job.result = r; job.status = job.ctrl.signal.aborted ? 'stopped' : 'done'; send('done', { status: job.status, ref: r?.ref }); })
    .catch((e) => { job.status = 'error'; job.error = e.message; send('failed', { error: e.message }); })
    .finally(() => { for (const c of job.clients) c.end(); job.clients.clear(); setTimeout(() => jobs.delete(job.id), 30 * 60 * 1000); });
  return job;
}

// ---------- одити ----------
async function readIndex() { try { return JSON.parse(await readFile(path.join(AUDITS, 'index.json'), 'utf8')); } catch { return []; } }
async function saveAudit(report) {
  await mkdir(AUDITS, { recursive: true });
  await writeFile(path.join(AUDITS, report.id + '.json'), JSON.stringify(report), 'utf8');
  const index = (await readIndex()).filter((a) => a.id !== report.id);
  index.unshift({ id: report.id, url: report.site.startUrl, at: report.site.finishedAt, summary: report.summary, stopped: report.site.stopped });
  await writeFile(path.join(AUDITS, 'index.json'), JSON.stringify(index.slice(0, 200)), 'utf8');
}
const validId = (id) => /^[0-9a-f-]{36}$/.test(id);
async function loadAudit(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(await readFile(path.join(AUDITS, id + '.json'), 'utf8')); } catch { return null; }
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const SEV = { error: 'Грешка', warning: 'Предупреждение', notice: 'Съвет' };

async function runAudit(start, limit, { respectRobots = true, progress = () => {}, signal } = {}) {
  const data = await crawl({ startUrl: start, maxPages: limit, respectRobots, onProgress: progress, signal });
  progress({ phase: 'Анализирам резултатите' });
  const report = { id: randomUUID(), settings: { maxPages: limit, respectRobots }, ...data, ...analyze(data) };
  await saveAudit(report);
  return report;
}

// ---------- помощни ----------
async function body(req) {
  let s = ''; for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('Твърде голяма заявка'); }
  return s ? JSON.parse(s) : {};
}
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

// ---------- маршрути ----------
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // без "api"
  const [a, b, c] = parts;
  const M = req.method;

  if (a === 'jobs' && b && c === 'events' && M === 'GET') {
    const job = jobs.get(b); if (!job) return json(res, 404, { error: 'Няма такава задача' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: progress\ndata: ${JSON.stringify(job.progress)}\n\n`);
    if (job.status !== 'running') {
      res.write(job.status === 'error' ? `event: failed\ndata: ${JSON.stringify({ error: job.error })}\n\n` : `event: done\ndata: ${JSON.stringify({ status: job.status, ref: job.result?.ref })}\n\n`);
      return res.end();
    }
    job.clients.add(res); req.on('close', () => job.clients.delete(res));
    return;
  }
  if (a === 'jobs' && b && c === 'stop' && M === 'POST') {
    jobs.get(b)?.ctrl.abort(); return json(res, 200, { ok: true });
  }

  // преглед на страница от резултатите в Google
  if (a === 'peek' && M === 'GET') {
    try { return json(res, 200, await peek(url.searchParams.get('url') || '', (url.searchParams.get('kw') || '').slice(0, 200))); }
    catch (e) { return json(res, 422, { error: e.name === 'AbortError' ? 'Сайтът не отговори навреме' : e.message }); }
  }

  // одит
  if (a === 'audits' && !b && M === 'GET') return json(res, 200, await readIndex());
  if (a === 'audits' && !b && M === 'POST') {
    const { url: start, maxPages = 200, respectRobots = true } = await body(req);
    if (!start) return json(res, 400, { error: 'Въведи адрес на сайт' });
    const limit = Math.min(Math.max(Number(maxPages) || 200, 1), 5000);
    const job = startJob('audit', async (job, progress) => ({ ref: (await runAudit(start, limit, { respectRobots, progress, signal: job.ctrl.signal })).id }));
    return json(res, 200, { jobId: job.id });
  }
  if (a === 'audits' && b && !c && M === 'GET') {
    const r = await loadAudit(b); return r ? json(res, 200, r) : json(res, 404, { error: 'Одитът не е намерен' });
  }
  if (a === 'audits' && b && !c && M === 'DELETE') {
    if (!validId(b)) return json(res, 400, { error: 'Грешен номер' });
    await rm(path.join(AUDITS, b + '.json'), { force: true });
    const index = (await readIndex()).filter((x) => x.id !== b);
    await writeFile(path.join(AUDITS, 'index.json'), JSON.stringify(index), 'utf8');
    return json(res, 200, { ok: true });
  }
  if (a === 'audits' && b && c === 'csv' && M === 'GET') {
    const r = await loadAudit(b); if (!r) return json(res, 404, { error: 'Одитът не е намерен' });
    const only = url.searchParams.get('issue');
    const rows = [['Вид', 'Проблем', 'Адрес', 'Подробности'].map(csvCell).join(';')];
    for (const i of r.issues) if (!only || i.code === only) for (const it of i.items) rows.push([SEV[i.severity], i.title, it.url, it.detail].map(csvCell).join(';'));
    const host = new URL(r.site.startUrl).hostname;
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="odit-${host}${only ? '-' + only : ''}.csv"` });
    return res.end('﻿' + rows.join('\r\n'));
  }

  // настройки
  if (a === 'settings' && M === 'GET') {
    const s = await ranks.getSettings();
    return json(res, 200, { hasSerpapiKey: !!s.serpapiKey, keyHint: s.serpapiKey ? '…' + s.serpapiKey.slice(-4) : null, ui: s.ui || {} });
  }
  if (a === 'settings' && M === 'POST') {
    const inb = await body(req); const patch = {};
    if (typeof inb.serpapiKey === 'string') patch.serpapiKey = inb.serpapiKey.trim();
    if (inb.ui && typeof inb.ui === 'object') patch.ui = inb.ui;
    await ranks.saveSettings(patch); return json(res, 200, { ok: true });
  }
  if (a === 'serpapi' && b === 'account' && M === 'GET') {
    const { serpapiKey } = await ranks.getSettings();
    if (!serpapiKey) return json(res, 400, { error: 'Няма въведен ключ' });
    try { return json(res, 200, await ranks.accountInfo(serpapiKey)); } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // позиции
  if (a === 'ranks' && !b && M === 'GET') return json(res, 200, await ranks.listProjects());
  if (a === 'ranks' && !b && M === 'POST') {
    try { return json(res, 200, await ranks.upsertProject(await body(req))); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (a === 'ranks' && b && !c && M === 'DELETE') { await ranks.deleteProject(b); return json(res, 200, { ok: true }); }
  if (a === 'ranks' && b && c === 'check' && M === 'POST') {
    const job = startJob('ranks', async (job, progress) => { await ranks.runCheck(b, progress, job.ctrl.signal); return { ref: b }; });
    return json(res, 200, { jobId: job.id });
  }

  // автоматични задачи
  if (a === 'schedule' && !b && M === 'GET') {
    const projects = await ranks.listProjects();
    const index = await readIndex();
    const sites = [...new Map(index.map((x) => [x.url, x])).keys()];
    return json(res, 200, {
      autostart: await scheduler.autostartEnabled(),
      ranks: projects.map((p) => ({ id: p.id, name: p.name, domain: p.domain, source: p.source || 'serpapi', schedule: p.schedule || 'off', maxCost: ranks.maxCost(p), keywords: p.keywords.length, lastRun: p.history.at(-1)?.at || null })),
      audits: await scheduler.auditSchedules(), auditSites: sites,
      events: await scheduler.events(),
    });
  }
  if (a === 'schedule' && b === 'audit' && M === 'POST') {
    const { url: u, every, maxPages } = await body(req);
    if (!u || !['off', 'weekly', 'monthly'].includes(every)) return json(res, 400, { error: 'Невалидни данни' });
    await scheduler.setAuditSchedule(u, every, Math.min(Number(maxPages) || 200, 5000)); return json(res, 200, { ok: true });
  }
  if (a === 'schedule' && b === 'rank' && c && M === 'POST') {
    const { schedule } = await body(req);
    const p = (await ranks.listProjects()).find((x) => x.id === c);
    if (!p) return json(res, 404, { error: 'Няма такъв проект' });
    try { await ranks.upsertProject({ ...p, schedule }); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (a === 'schedule' && b === 'autostart' && M === 'POST') {
    try { await scheduler.setAutostart(!!(await body(req)).enabled); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }

  // Search Console
  if (a === 'gsc') {
    try {
      const site = url.searchParams.get('site');
      if (b === 'status' && M === 'GET') return json(res, 200, await gsc.status());
      if (b === 'connect' && M === 'GET') return json(res, 200, { url: await gsc.authUrl(REDIRECT) });
      if (b === 'disconnect' && M === 'POST') { await gsc.disconnect(); return json(res, 200, { ok: true }); }
      if (b === 'sites' && M === 'GET') return json(res, 200, await gsc.sites());
      if (b === 'performance' && M === 'GET') return json(res, 200, await gsc.performance(site, Number(url.searchParams.get('days')) || 28));
      if (b === 'links' && !c && M === 'GET') return json(res, 200, { latest: await gsc.latestLinks(site), history: await gsc.linkSnapshots(site) });
      if (b === 'links' && c === 'import' && M === 'POST') return json(res, 200, await gsc.importLinks(site, await rawBody(req), url.searchParams.get('name')));
    } catch (e) { return json(res, e.code === 'NOAUTH' ? 401 : 400, { error: e.message, code: e.code }); }
  }

  // линк билдинг
  if (a === 'outreach' && b === 'footprints' && M === 'GET') return json(res, 200, outreach.FOOTPRINTS.map(({ id, label }) => ({ id, label })));
  if (a === 'outreach' && !b && M === 'GET') {
    const all = await outreach.listCampaigns();
    return json(res, 200, all.map((c) => ({ ...c, pending: outreach.pendingQueries(c).length })));
  }
  if (a === 'outreach' && !b && M === 'POST') {
    try { return json(res, 200, await outreach.upsertCampaign(await body(req))); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (a === 'outreach' && b && !c && M === 'DELETE') { await outreach.deleteCampaign(b); return json(res, 200, { ok: true }); }
  if (a === 'outreach' && b && c === 'search' && M === 'POST') {
    const job = startJob('outreach', async (job, progress) => { await outreach.runSearch(b, progress, job.ctrl.signal); return { ref: b }; });
    return json(res, 200, { jobId: job.id });
  }
  const d = parts[3], e = parts[4];
  if (a === 'outreach' && b && c === 'prospects' && d) {
    try {
      if (!e && M === 'POST') return json(res, 200, await outreach.updateProspect(b, d, await body(req)));
      if (!e && M === 'DELETE') { await outreach.deleteProspect(b, d); return json(res, 200, { ok: true }); }
      if (e === 'contacts' && M === 'POST') return json(res, 200, await outreach.findContacts(b, d));
      if (e === 'verify' && M === 'POST') return json(res, 200, await outreach.verifyLink(b, d));
    } catch (ex) { return json(res, 400, { error: ex.message }); }
  }
  if (a === 'outreach' && b && c === 'csv' && M === 'GET') {
    const camp = (await outreach.listCampaigns()).find((x) => x.id === b);
    if (!camp) return json(res, 404, { error: 'Няма такава кампания' });
    const ST = { new: 'Нов', good: 'Подходящ', contacted: 'Писано', replied: 'Отговорили', won: 'Получен линк', rejected: 'Отказ' };
    const rows = [['Сайт', 'Адрес', 'Заглавие', 'Статус', 'Контакт', 'Имейли', 'Страница с линк', 'Проверка', 'Бележки', 'Намерен чрез'].map(csvCell).join(';')];
    for (const p of camp.prospects) rows.push([p.host, p.url, p.title, ST[p.status], p.contact, (p.emails || []).join(', '), p.linkUrl, p.verify?.text, p.notes, p.found.join(' | ')].map(csvCell).join(';'));
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="link-building-${camp.domain}.csv"` });
    return res.end('﻿' + rows.join('\r\n'));
  }

  return json(res, 404, { error: 'Няма такъв адрес' });
}

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const full = path.normalize(path.join(PUB, p));
  if (!full.startsWith(PUB + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': full.endsWith('.woff2') ? 'max-age=31536000' : 'no-cache' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Не е намерено'); }
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // защита: приемаме само заявки към localhost и към името на приложението
  if (!HOST_RE.test(req.headers.host || '')) { res.writeHead(403); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.origin && !ORIGIN_RE.test(req.headers.origin)) { res.writeHead(403); return res.end(); }
      return await api(req, res, url);
    }
    const toApp = isPlainLocal(req.headers.host) && APP_HOST !== 'localhost';
    // връщане от входа в Google (той винаги се връща на localhost:4321)
    if (url.pathname === '/' && url.searchParams.get('state') && (url.searchParams.get('code') || url.searchParams.get('error'))) {
      const back = toApp ? appUrl + '/' : '/';
      try { await gsc.handleCallback(url.searchParams); res.writeHead(302, { location: back + '#gsc' }); return res.end(); }
      catch (e) { res.writeHead(302, { location: back + '#gsc/error/' + encodeURIComponent(e.message) }); return res.end(); }
    }
    // отворено като localhost: прехвърляме към адреса с името на приложението
    if (toApp && req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { location: appUrl + '/' + url.search, 'cache-control': 'no-store' }); return res.end();
    }
    return await serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
}
const server = http.createServer(handle);

// Втори вход на порт 80, за да е адресът без номер на порт: http://yasno.seo.localhost
function listenWeb() {
  if (!WEB_PORT || WEB_PORT === PORT || APP_HOST === 'localhost') return Promise.resolve(false);
  return new Promise((resolve) => {
    const web = http.createServer(handle);
    web.once('error', () => resolve(false)); // порт 80 е зает или забранен: оставаме с номер на порт
    web.listen(WEB_PORT, '127.0.0.1', () => resolve(true));
  });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`\n  Ясно SEO вече работи: http://localhost:${PORT}\n`); process.exit(3); }
  throw e;
});
server.listen(PORT, '127.0.0.1', async () => {
  if (await listenWeb()) appUrl = `http://${APP_HOST}` + (WEB_PORT === 80 ? '' : ':' + WEB_PORT);
  else if (APP_HOST === 'localhost') appUrl = `http://localhost:${PORT}`;
  console.log(`\n  [${new Date().toLocaleString('bg-BG')}] Ясно SEO работи:  ${appUrl}\n  (работи и на http://localhost:${PORT})\n  За спиране натисни Ctrl+C\n`);
  scheduler.start({ dataDir: DATA, root: ROOT, audit: (u, max) => runAudit(u, max) });
});
