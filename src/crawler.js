// Обхождане на сайт: събира данни за всяка вътрешна страница.
import * as cheerio from 'cheerio';

const UA = 'YasnoSEO-Auditor/0.1 (local site audit)';
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|7z|gz|mp3|mp4|webm|avi|mov|docx?|xlsx?|pptx?|css|js|woff2?|ttf|eot|xml|txt)$/i;
const MAX_HTML = 5 * 1024 * 1024;

export function normalize(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

const bareHost = (h) => h.replace(/^www\./i, '').toLowerCase();

async function request(url, { method = 'GET', timeout = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const start = performance.now();
  try {
    const res = await fetch(url, {
      method, redirect: 'manual', signal: ctrl.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
    });
    return { res, ms: Math.round(performance.now() - start) };
  } finally { clearTimeout(timer); }
}

// Следва пренасочванията ръчно, за да запише веригата.
export async function fetchFollow(url, opts = {}) {
  const chain = [];
  let cur = url;
  for (let i = 0; i < 10; i++) {
    const { res, ms } = await request(cur, opts);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      chain.push({ url: cur, status: res.status });
      try { await res.body?.cancel(); } catch {}
      cur = new URL(loc, cur).href;
      continue;
    }
    return { res, ms, finalUrl: cur, chain };
  }
  throw new Error('Повече от 10 пренасочвания');
}

// Някои сървъри бавят или отказват HEAD, затова при съмнение пробваме и с GET.
async function checkStatus(url) {
  const attempt = async (method, timeout) => {
    const r = await fetchFollow(url, { method, timeout });
    try { await r.res.body?.cancel(); } catch {}
    return { status: r.res.status, size: Number(r.res.headers.get('content-length')) || null, chain: r.chain };
  };
  let first;
  try {
    first = await attempt('HEAD', 8000);
    if (first.status < 400 || first.status === 404 || first.status === 410) return first;
  } catch {}
  try { return await attempt('GET', 15000); }
  catch (e) {
    if (first) return first;
    const code = e.cause?.code;
    // недостижим домейн = наистина счупен; изтекло време = не може да се провери
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'CERT_HAS_EXPIRED') return { status: 0, error: code === 'ENOTFOUND' ? 'Домейнът не съществува' : code };
    return { status: -1, error: 'Не отговаря навреме' };
  }
}

// ---------- robots.txt ----------
function parseRobots(text) {
  const groups = []; let cur = null; let lastWasAgent = false;
  const sitemaps = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').match(/^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2];
    if (key === 'sitemap') { sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
  }
  const group = groups.find((g) => g.agents.includes('*'));
  return { rules: group ? group.rules.filter((r) => r.path) : [], sitemaps };
}

function robotsAllows(rules, url) {
  const u = new URL(url); const p = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

// ---------- sitemap ----------
async function readSitemap(url, out, depth = 0) {
  if (depth > 2 || out.size >= 5000) return;
  try {
    const { res } = await fetchFollow(url);
    if (res.status !== 200) return;
    const xml = await res.text();
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*<\/loc>/gis)].map((m) => m[1].trim().replace(/&amp;/g, '&'));
    if (/<sitemapindex/i.test(xml)) {
      for (const l of locs.slice(0, 50)) await readSitemap(l, out, depth + 1);
    } else {
      for (const l of locs) { const n = normalize(l); if (n && out.size < 5000) out.add(n); }
    }
  } catch {}
}

// ---------- анализ на HTML ----------
function parsePage(html, url) {
  const $ = cheerio.load(html);
  const text = (s) => $(s).text().replace(/\s+/g, ' ').trim();
  const titles = $('head title, title').map((_, e) => $(e).text().replace(/\s+/g, ' ').trim()).get();
  const descs = $('meta[name="description" i]').map((_, e) => ($(e).attr('content') || '').trim()).get();
  const links = [];
  $('a[href]').each((_, e) => {
    const href = normalize($(e).attr('href'), url);
    if (href) links.push({ href, nofollow: /nofollow/i.test($(e).attr('rel') || ''), text: $(e).text().replace(/\s+/g, ' ').trim().slice(0, 80) });
  });
  const images = $('img').map((_, e) => ({
    src: normalize($(e).attr('src') || $(e).attr('data-src') || '', url),
    hasAlt: $(e).attr('alt') !== undefined,
  })).get().filter((i) => i.src);
  const insecure = url.startsWith('https:')
    ? $('img[src^="http:"], script[src^="http:"], link[rel="stylesheet"][href^="http:"], iframe[src^="http:"]').map((_, e) => $(e).attr('src') || $(e).attr('href')).get()
    : [];
  $('script, style, noscript, template').remove();
  const body = text('body');
  return {
    title: titles[0] ?? null, titleCount: titles.length,
    metaDesc: descs[0] ?? null, metaDescCount: descs.length,
    h1: $('h1').map((_, e) => $(e).text().replace(/\s+/g, ' ').trim()).get(),
    h2Count: $('h2').length,
    canonical: normalize($('link[rel="canonical" i]').attr('href') || '', url),
    robotsMeta: ($('meta[name="robots" i]').attr('content') || '').toLowerCase(),
    lang: $('html').attr('lang') || null,
    viewport: $('meta[name="viewport" i]').length > 0,
    wordCount: body ? body.split(' ').filter((w) => /\p{L}/u.test(w)).length : 0,
    links, images, insecure,
  };
}

async function pool(items, size, fn, shouldStop) {
  let i = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (i < items.length && !shouldStop()) await fn(items[i++]);
  }));
}

/**
 * @param {object} o  { startUrl, maxPages, respectRobots, onProgress, signal }
 */
export async function crawl({ startUrl, maxPages = 200, respectRobots = true, concurrency = 4, onProgress = () => {}, signal }) {
  const stopped = () => signal?.aborted;
  const start = normalize(startUrl.includes('://') ? startUrl : 'https://' + startUrl);
  if (!start) throw new Error('Невалиден адрес');
  const origin = new URL(start).origin;
  const host = bareHost(new URL(start).hostname);
  const isInternal = (u) => bareHost(new URL(u).hostname) === host;

  const site = { startUrl: start, origin, robots: null, sitemapUrls: [], sitemapFound: false, startedAt: new Date().toISOString() };

  // robots.txt
  let robotRules = [];
  onProgress({ phase: 'Чета robots.txt и sitemap', done: 0, queued: 0 });
  try {
    const { res } = await fetchFollow(origin + '/robots.txt');
    if (res.status === 200) {
      const parsed = parseRobots(await res.text());
      robotRules = parsed.rules; site.robots = { found: true, sitemaps: parsed.sitemaps, disallowCount: parsed.rules.filter((r) => !r.allow).length };
    } else { site.robots = { found: false, status: res.status }; try { await res.body?.cancel(); } catch {} }
  } catch (e) { site.robots = { found: false, error: e.message }; }

  // sitemap
  const sitemapSet = new Set();
  const smList = site.robots?.sitemaps?.length ? site.robots.sitemaps : [origin + '/sitemap.xml'];
  for (const s of smList.slice(0, 10)) await readSitemap(s, sitemapSet);
  site.sitemapFound = sitemapSet.size > 0;
  site.sitemapUrls = [...sitemapSet];

  const pages = new Map();      // url -> данни
  const linkedFrom = new Map(); // url -> Set(източници)
  const queue = [];
  const seen = new Set();
  const blocked = new Set();
  const enqueue = (url, depth, from) => {
    if (from) { if (!linkedFrom.has(url)) linkedFrom.set(url, new Set()); linkedFrom.get(url).add(from); }
    if (seen.has(url)) return;
    if (!isInternal(url)) return;
    if (respectRobots && !robotsAllows(robotRules, url)) { blocked.add(url); return; }
    if (seen.size >= maxPages) return;
    seen.add(url); queue.push({ url, depth });
  };
  enqueue(start, 0, null);
  for (const u of sitemapSet) if (isInternal(u)) enqueue(u, null, null);

  const externals = new Map(); // url -> Set(източници)
  const imageUrls = new Map();

  const visit = async ({ url, depth }) => {
    const page = { url, depth, status: 0, chain: [], ms: null, inSitemap: sitemapSet.has(url) };
    pages.set(url, page);
    try {
      const fileLike = FILE_EXT.test(new URL(url).pathname);
      const r = await fetchFollow(url, { method: fileLike ? 'HEAD' : 'GET' });
      page.status = r.res.status; page.chain = r.chain; page.ms = r.ms; page.finalUrl = r.finalUrl;
      page.contentType = (r.res.headers.get('content-type') || '').split(';')[0];
      page.xRobots = (r.res.headers.get('x-robots-tag') || '').toLowerCase();
      const isHtml = page.contentType.includes('html');
      page.isHtml = isHtml && !fileLike;
      // пренасочване към вътрешна страница: обхождаме целта
      if (r.chain.length && r.finalUrl !== url && isInternal(r.finalUrl)) enqueue(r.finalUrl, depth == null ? null : depth, url);
      if (!page.isHtml || r.res.status !== 200 || r.chain.length) { try { await r.res.body?.cancel(); } catch {} return; }
      const buf = await r.res.arrayBuffer();
      page.size = buf.byteLength;
      if (buf.byteLength > MAX_HTML) return;
      const data = parsePage(new TextDecoder().decode(buf), url);
      const { links, images, ...rest } = data;
      Object.assign(page, rest);
      page.noindex = /noindex/.test(page.robotsMeta + ' ' + page.xRobots);
      page.imagesTotal = images.length;
      page.imagesNoAlt = images.filter((i) => !i.hasAlt).map((i) => i.src);
      page.internalLinks = 0; page.externalLinks = 0;
      const nofollowPage = /nofollow/.test(page.robotsMeta);
      for (const l of links) {
        if (isInternal(l.href)) {
          page.internalLinks++;
          if (!nofollowPage) enqueue(l.href, depth == null ? null : depth + 1, url);
          else { if (!linkedFrom.has(l.href)) linkedFrom.set(l.href, new Set()); linkedFrom.get(l.href).add(url); }
        } else {
          page.externalLinks++;
          if (!externals.has(l.href)) externals.set(l.href, new Set());
          externals.get(l.href).add(url);
        }
      }
      for (const img of images) {
        if (!imageUrls.has(img.src)) imageUrls.set(img.src, new Set());
        imageUrls.get(img.src).add(url);
      }
    } catch (e) {
      page.error = e.name === 'AbortError' ? 'Изтече времето за отговор' : (e.cause?.code || e.message);
    }
    onProgress({ phase: 'Обхождам страниците', done: pages.size, queued: seen.size, current: url });
  };

  // опашката расте по време на работа, затова въртим докато има работа
  while (!stopped()) {
    const batch = queue.splice(0, queue.length);
    if (!batch.length) break;
    // по-плитките първо
    batch.sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99));
    await pool(batch, concurrency, visit, stopped);
  }

  // външни линкове и изображения
  const extList = [...externals.keys()].slice(0, 400);
  const extResults = {};
  let n = 0;
  await pool(extList, 6, async (u) => {
    extResults[u] = await checkStatus(u);
    onProgress({ phase: 'Проверявам външните линкове', done: ++n, queued: extList.length, current: u });
  }, stopped);

  const imgList = [...imageUrls.keys()].slice(0, 400);
  const imgResults = {};
  n = 0;
  await pool(imgList, 6, async (u) => {
    imgResults[u] = await checkStatus(u);
    onProgress({ phase: 'Проверявам изображенията', done: ++n, queued: imgList.length, current: u });
  }, stopped);

  // кой към коя страница сочи
  for (const p of pages.values()) {
    p.linkedFrom = [...(linkedFrom.get(p.url) || [])];
    p.inlinks = p.linkedFrom.length;
  }

  // попълваме дълбочината на страниците, открити само от sitemap
  site.finishedAt = new Date().toISOString();
  site.stopped = !!stopped();
  site.limitReached = seen.size >= maxPages;
  return {
    site,
    pages: [...pages.values()],
    blockedByRobots: [...blocked].slice(0, 2000),
    externals: Object.fromEntries(extList.map((u) => [u, { ...extResults[u], from: [...externals.get(u)] }])),
    externalsTotal: externals.size,
    images: Object.fromEntries(imgList.map((u) => [u, { ...imgResults[u], from: [...imageUrls.get(u)] }])),
    imagesTotal: imageUrls.size,
  };
}
