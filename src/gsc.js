// Google Search Console: OAuth (за десктоп приложение, с PKCE), данни за търсенето и импорт на линкове.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';

let DATA_DIR = 'data';
export const setDataDir = (d) => { DATA_DIR = d; };
const P = (n) => path.join(DATA_DIR, n);
const readJson = async (n, f) => { try { return JSON.parse(await readFile(P(n), 'utf8')); } catch { return f; } };
const writeJson = async (n, v) => { await mkdir(DATA_DIR, { recursive: true }); await writeFile(P(n), JSON.stringify(v, null, 2), 'utf8'); };

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://www.googleapis.com/webmasters/v3';

async function client() {
  const j = await readJson('google-client.json', null);
  const c = j?.installed || j?.web;
  if (!c) throw new Error('Липсва файлът data/google-client.json (OAuth клиент от Google Cloud)');
  return c;
}

// ---------- OAuth ----------
const pending = new Map(); // state -> { verifier, redirect }
export async function authUrl(redirect) {
  const c = await client();
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(16).toString('hex');
  pending.set(state, { verifier, redirect, at: Date.now() });
  const q = new URLSearchParams({
    client_id: c.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

export async function handleCallback(params) {
  const st = pending.get(params.get('state'));
  if (!st) throw new Error('Връзката изтече. Опитай отново от Search Console → Свържи.');
  pending.delete(params.get('state'));
  if (params.get('error')) throw new Error('Google отказа достъп: ' + params.get('error'));
  const c = await client();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: params.get('code'), client_id: c.client_id, client_secret: c.client_secret, redirect_uri: st.redirect, grant_type: 'authorization_code', code_verifier: st.verifier }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error('Google: ' + (t.error_description || t.error));
  if (!t.refresh_token) throw new Error('Google не върна дълготраен достъп. Премахни достъпа на приложението от myaccount.google.com/permissions и опитай пак.');
  await writeJson('gsc-token.json', { refresh_token: t.refresh_token, access_token: t.access_token, expiry: Date.now() + (t.expires_in - 60) * 1000, connectedAt: new Date().toISOString() });
}

export async function status() {
  const hasClient = !!(await readJson('google-client.json', null));
  const tok = await readJson('gsc-token.json', null);
  return { hasClient, connected: !!tok?.refresh_token, connectedAt: tok?.connectedAt || null };
}
export async function disconnect() {
  const tok = await readJson('gsc-token.json', null);
  if (tok?.refresh_token) { try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(tok.refresh_token), { method: 'POST' }); } catch {} }
  await rm(P('gsc-token.json'), { force: true });
}

async function accessToken() {
  const tok = await readJson('gsc-token.json', null);
  if (!tok?.refresh_token) throw Object.assign(new Error('Не си свързан със Search Console'), { code: 'NOAUTH' });
  if (tok.access_token && tok.expiry > Date.now()) return tok.access_token;
  const c = await client();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: tok.refresh_token, client_id: c.client_id, client_secret: c.client_secret, grant_type: 'refresh_token' }),
  });
  const t = await res.json();
  if (!res.ok) {
    if (t.error === 'invalid_grant') { await rm(P('gsc-token.json'), { force: true }); throw Object.assign(new Error('Достъпът до Search Console е изтекъл. Свържи се отново.'), { code: 'NOAUTH' }); }
    throw new Error('Google: ' + (t.error_description || t.error));
  }
  await writeJson('gsc-token.json', { ...tok, access_token: t.access_token, expiry: Date.now() + (t.expires_in - 60) * 1000 });
  return t.access_token;
}

async function gapi(url, body) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: 'Bearer ' + (await accessToken()), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json();
  if (!res.ok) {
    const msg = j.error?.message || 'Грешка ' + res.status;
    if (/has not been used|is disabled/i.test(msg)) throw new Error('Search Console API не е включено в Google Cloud проекта.');
    throw new Error('Google: ' + msg);
  }
  return j;
}

export async function sites() {
  const j = await gapi(API + '/sites');
  return (j.siteEntry || []).filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .map((s) => ({ siteUrl: s.siteUrl, permission: s.permissionLevel }))
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

// ---------- данни за търсенето ----------
const day = (d) => d.toISOString().slice(0, 10);
function ranges(days) {
  // Данните на Google закъсняват ~2-3 дни
  const end = new Date(Date.now() - 3 * 864e5);
  const start = new Date(end - (days - 1) * 864e5);
  const pEnd = new Date(start - 864e5);
  const pStart = new Date(pEnd - (days - 1) * 864e5);
  return { cur: [day(start), day(end)], prev: [day(pStart), day(pEnd)] };
}
async function query(site, [startDate, endDate], dimensions, rowLimit = 5000) {
  const j = await gapi(`${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { startDate, endDate, dimensions, rowLimit, dataState: 'all' });
  return j.rows || [];
}
const totals = (rows) => {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0), impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const pos = impressions ? rows.reduce((s, r) => s + r.position * r.impressions, 0) / impressions : null;
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: pos };
};
function merge(cur, prev) {
  const pm = new Map(prev.map((r) => [r.keys[0], r]));
  return cur.map((r) => {
    const p = pm.get(r.keys[0]);
    return { key: r.keys[0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
      prevClicks: p?.clicks ?? 0, prevPosition: p?.position ?? null };
  });
}

export async function performance(site, days = 28) {
  const rg = ranges(days);
  const [dCur, dPrev, qCur, qPrev, pCur, pPrev] = await Promise.all([
    query(site, rg.cur, ['date']), query(site, rg.prev, ['date']),
    query(site, rg.cur, ['query']), query(site, rg.prev, ['query']),
    query(site, rg.cur, ['page']), query(site, rg.prev, ['page']),
  ]);
  const queries = merge(qCur, qPrev);
  // Възможности: близо до първа страница или нисък CTR на високи позиции
  const nearly = queries.filter((q) => q.position >= 8 && q.position <= 20 && q.impressions >= 5).sort((a, b) => b.impressions - a.impressions);
  const lowCtr = queries.filter((q) => q.position <= 5 && q.impressions >= 30 && q.ctr < (q.position <= 3 ? 0.05 : 0.02)).sort((a, b) => b.impressions - a.impressions);
  return {
    site, days, range: rg.cur, prevRange: rg.prev,
    total: totals(dCur), prevTotal: totals(dPrev),
    daily: dCur.map((r) => ({ date: r.keys[0], clicks: r.clicks, impressions: r.impressions })),
    queries, pages: merge(pCur, pPrev), nearly, lowCtr,
  };
}

// ---------- импорт на линкове (файл от Search Console → Връзки → Експортиране) ----------
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : (first.includes('\t') ? '\t' : ',');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}
const hostOf = (s) => { try { return new URL(s).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; } };
const looksDomain = (s) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.trim());

function extractLinks(files, siteHost) {
  const pages = new Map(); const domains = new Map();
  const addDomain = (d, n) => { d = d.toLowerCase().replace(/^www\./, ''); if (siteHost && (d === siteHost || d.endsWith('.' + siteHost))) return; const x = domains.get(d) || { host: d, links: 0, pages: [] }; x.links = Math.max(x.links, n || 0); domains.set(d, x); };
  for (const { name, text } of files) {
    const rows = parseCsv(text);
    if (rows.length < 2) continue;
    for (const r of rows.slice(1)) {
      const urlCell = r.find((c) => /^https?:\/\//i.test(c.trim()));
      if (urlCell) {
        const u = urlCell.trim(); const h = hostOf(u);
        if (!h || (siteHost && (h === siteHost || h.endsWith('.' + siteHost)))) continue; // вътрешни връзки
        const date = r.find((c) => /^\d{4}-\d{2}-\d{2}|^\d{1,2}[./]\d{1,2}[./]\d{2,4}$|^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(c.trim()));
        if (!pages.has(u)) pages.set(u, { url: u, host: h, lastCrawled: date?.trim() || null });
      } else if (looksDomain(r[0] || '')) {
        const n = Number(String(r[1] || '').replace(/[^\d]/g, '')) || 0;
        addDomain(r[0].trim(), n);
      }
    }
  }
  for (const p of pages.values()) { addDomain(p.host, 0); domains.get(p.host)?.pages.push({ url: p.url, lastCrawled: p.lastCrawled }); }
  for (const d of domains.values()) d.links = Math.max(d.links, d.pages.length);
  return { pages: pages.size, domains: [...domains.values()].sort((a, b) => b.links - a.links) };
}

export async function importLinks(site, buf, filename) {
  const files = [];
  const u8 = new Uint8Array(buf);
  if (u8[0] === 0x50 && u8[1] === 0x4b) { // ZIP
    const unz = unzipSync(u8);
    for (const [name, data] of Object.entries(unz)) if (/\.csv$/i.test(name)) files.push({ name, text: strFromU8(data) });
    if (!files.length) throw new Error('В архива няма CSV файлове');
  } else files.push({ name: filename || 'file.csv', text: new TextDecoder().decode(u8) });
  const siteHost = site.startsWith('sc-domain:') ? site.slice(10).toLowerCase() : hostOf(site);
  const parsed = extractLinks(files, siteHost);
  if (!parsed.domains.length) throw new Error('Не намерих връзки във файла. Експортирай от Search Console → Връзки → „Експортиране на външни връзки“ (Най-нови връзки или Още примерни връзки) като CSV.');

  const all = await readJson('gsc-links.json', {});
  const hist = all[site] || [];
  const prev = hist.at(-1);
  const prevHosts = new Set(prev?.domains.map((d) => d.host) || []);
  const curHosts = new Set(parsed.domains.map((d) => d.host));
  const snap = {
    id: randomUUID(), at: new Date().toISOString(), files: files.map((f) => f.name),
    pages: parsed.pages, domains: parsed.domains,
    newHosts: prev ? [...curHosts].filter((h) => !prevHosts.has(h)) : [],
    lostHosts: prev ? [...prevHosts].filter((h) => !curHosts.has(h)) : [],
  };
  all[site] = [...hist, snap].slice(-24);
  await writeJson('gsc-links.json', all);
  return snap;
}
export async function linkSnapshots(site) {
  const all = await readJson('gsc-links.json', {});
  return (all[site] || []).map(({ domains, ...rest }) => ({ ...rest, domainCount: domains.length }));
}
export async function latestLinks(site) {
  const all = await readJson('gsc-links.json', {});
  return all[site]?.at(-1) || null;
}

// ---------- позиции на ключови думи (безплатно, само за собствени сайтове) ----------
const COUNTRY3 = { bg: 'bgr', us: 'usa', uk: 'gbr', de: 'deu', gr: 'grc', ro: 'rou', tr: 'tur', fr: 'fra', es: 'esp', it: 'ita' };

export async function findProperty(domain) {
  const d = domain.toLowerCase().replace(/^www\./, '');
  const list = await sites();
  return list.find((s) => s.siteUrl === 'sc-domain:' + d)?.siteUrl
    || list.find((s) => { try { return new URL(s.siteUrl).hostname.replace(/^www\./, '') === d; } catch { return false; } })?.siteUrl
    || list.find((s) => s.siteUrl.startsWith('sc-domain:') && d.endsWith('.' + s.siteUrl.slice(10)))?.siteUrl
    || null;
}

async function positionsFor(site, keywords, { gl, device, days }) {
  const end = new Date(Date.now() - 3 * 864e5), start = new Date(end - (days - 1) * 864e5);
  const filters = [];
  if (COUNTRY3[gl]) filters.push({ dimension: 'country', operator: 'equals', expression: COUNTRY3[gl] });
  if (device === 'desktop' || device === 'mobile') filters.push({ dimension: 'device', operator: 'equals', expression: device === 'mobile' ? 'MOBILE' : 'DESKTOP' });
  const j = await gapi(`${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    startDate: day(start), endDate: day(end), dimensions: ['query', 'page'], rowLimit: 25000, dataState: 'all',
    ...(filters.length ? { dimensionFilterGroups: [{ filters }] } : {}),
  });
  // за всяка заявка: страницата с най-много импресии и общият сбор
  const best = new Map(); const sum = new Map();
  for (const r of j.rows || []) {
    const q = r.keys[0].toLowerCase().trim();
    const b = best.get(q); if (!b || r.impressions > b.impressions) best.set(q, r);
    const t = sum.get(q) || { clicks: 0, impressions: 0 }; t.clicks += r.clicks; t.impressions += r.impressions; sum.set(q, t);
  }
  const out = {};
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim(); const r = best.get(k);
    if (r) out[kw] = { position: Math.round(r.position * 10) / 10, url: r.keys[1], clicks: sum.get(k).clicks, impressions: sum.get(k).impressions, days };
  }
  return out;
}

/** Средна позиция за всяка дума по данни на Google: последните 7 дни, а ако няма данни, последните 28. */
export async function keywordPositions(domain, keywords, { gl, device } = {}) {
  const site = await findProperty(domain);
  if (!site) throw new Error(`${domain} не е в твоя Search Console. Избери SerpApi като източник за този проект.`);
  const [w7, w28] = await Promise.all([positionsFor(site, keywords, { gl, device, days: 7 }), positionsFor(site, keywords, { gl, device, days: 28 })]);
  const results = {};
  for (const kw of keywords) {
    const r = w7[kw] || w28[kw];
    results[kw] = r ? { ...r, source: 'gsc', competitors: {}, top: [] } : { position: null, url: null, clicks: 0, impressions: 0, source: 'gsc', competitors: {}, top: [] };
  }
  return { site, results };
}
