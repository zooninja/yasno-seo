// Бърз преглед на една страница от резултатите в Google: какво има на нея,
// за да се сравни с твоята. Отваря само публични http(s) адреси.
import * as cheerio from 'cheerio';
import { fetchFollow } from './crawler.js';

const MAX_HTML = 3 * 1024 * 1024;
const TTL = 6 * 60 * 60 * 1000; // пазим прегледа 6 часа, за да не товарим чуждите сайтове
const cache = new Map();

// Не отваряме адреси от локалната мрежа: прегледът е само за публични сайтове.
function isPublic(u) {
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return false;
  return true;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[-_/.,:;!?()"'„“«»]+/g, ' ').replace(/\s+/g, ' ').trim();

// Колко от думите на заявката се срещат в текста (0..1)
function coverage(text, kw) {
  const words = norm(kw).split(' ').filter((w) => w.length > 1);
  if (!words.length) return 0;
  const t = ' ' + norm(text) + ' ';
  return words.filter((w) => t.includes(w)).length / words.length;
}
function countPhrase(text, kw) {
  const k = norm(kw); if (!k) return 0;
  const t = norm(text); let n = 0, i = 0;
  while ((i = t.indexOf(k, i)) !== -1) { n++; i += k.length; }
  return n;
}

function schemaInfo($) {
  const types = new Set();
  let published = null, modified = null, rating = null;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(walk);
    const t = o['@type'];
    if (t) [].concat(t).forEach((x) => types.add(String(x)));
    published ||= o.datePublished || null;
    modified ||= o.dateModified || null;
    if (!rating && o.aggregateRating) rating = { value: o.aggregateRating.ratingValue, count: o.aggregateRating.reviewCount || o.aggregateRating.ratingCount };
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  $('script[type="application/ld+json" i]').each((_, e) => { try { walk(JSON.parse($(e).contents().text())); } catch {} });
  $('[itemtype]').each((_, e) => { const t = ($(e).attr('itemtype') || '').split('/').pop(); if (t) types.add(t); });
  published ||= $('meta[property="article:published_time"]').attr('content') || null;
  modified ||= $('meta[property="article:modified_time"]').attr('content') || $('meta[property="og:updated_time"]').attr('content') || null;
  return { types: [...types].slice(0, 12), published, modified, rating };
}

export async function peek(rawUrl, keyword = '') {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Грешен адрес'); }
  if (!/^https?:$/.test(u.protocol) || !isPublic(u)) throw new Error('Адресът не е публичен сайт');
  const key = u.href + '\n' + keyword;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;

  const { res, ms, finalUrl } = await fetchFollow(u.href, { timeout: 15000 });
  if (!isPublic(new URL(finalUrl))) throw new Error('Адресът пренасочва към локална мрежа');
  const type = res.headers.get('content-type') || '';
  if (!res.ok) { try { await res.body?.cancel(); } catch {} throw new Error(`Сайтът отговори с код ${res.status}` + (res.status === 403 || res.status === 503 ? ' (вероятно спира роботи)' : '')); }
  if (!/html/i.test(type)) { try { await res.body?.cancel(); } catch {} throw new Error('Не е HTML страница (' + (type.split(';')[0] || 'непознат вид') + ')'); }
  const buf = Buffer.from(await res.arrayBuffer());
  const html = buf.subarray(0, MAX_HTML).toString('utf8');

  const $ = cheerio.load(html);
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const title = clean($('head title').first().text() || $('title').first().text()) || null;
  const metaDesc = clean($('meta[name="description" i]').attr('content')) || null;
  const h1 = $('h1').map((_, e) => clean($(e).text())).get().filter(Boolean).slice(0, 5);
  const h2 = $('h2').map((_, e) => clean($(e).text())).get().filter(Boolean);
  const h3Count = $('h3').length;
  const schema = schemaInfo($);
  const host = new URL(finalUrl).hostname;
  let internal = 0, external = 0;
  $('a[href]').each((_, e) => {
    try { const l = new URL($(e).attr('href'), finalUrl); if (!/^https?:$/.test(l.protocol)) return; l.hostname === host ? internal++ : external++; } catch {}
  });
  const images = $('img').length;
  const videos = $('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length;
  const lists = $('main ul, main ol, article ul, article ol').length || $('ul, ol').length;
  const tables = $('table').length;
  const faq = schema.types.includes('FAQPage') || $('details, [itemtype*="FAQPage"]').length > 0;
  $('script, style, noscript, template, svg').remove();
  // основният текст: <main>/<article>, ако ги има, иначе цялото тяло
  const mainText = clean($('main').text() || $('article').text() || $('body').text());
  const words = mainText ? mainText.split(' ').filter((w) => /\p{L}/u.test(w)).length : 0;

  const data = {
    url: rawUrl, finalUrl, ms, title, metaDesc, h1, h2: h2.slice(0, 15), h2Count: h2.length, h3Count, words,
    lang: $('html').attr('lang') || null,
    canonical: $('link[rel="canonical" i]').attr('href') || null,
    noindex: /noindex/i.test($('meta[name="robots" i]').attr('content') || ''),
    schema, internal, external, images, videos, lists, tables, faq,
    kw: keyword ? {
      title: coverage(title, keyword), h1: coverage(h1.join(' '), keyword), desc: coverage(metaDesc, keyword),
      url: coverage(decodeURIComponent(new URL(finalUrl).pathname), keyword), h2: h2.filter((x) => coverage(x, keyword) >= 0.5).length,
      exact: countPhrase(mainText, keyword),
    } : null,
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}
