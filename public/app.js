// Ясно SEO: интерфейс. Целият текст от чужди сайтове се вмъква като текст (не като HTML).

// ---------- помощни ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') throw new Error('no html');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const app = document.getElementById('app');
const live = document.getElementById('live');
const say = (t) => { live.textContent = t; };
const fmtDate = (s) => new Date(s).toLocaleString('bg-BG', { dateStyle: 'medium', timeStyle: 'short' });
const num = (n) => Number(n ?? 0).toLocaleString('bg-BG');
const SEV = { error: 'Грешка', warning: 'Предупреждение', notice: 'Съвет' };
const SEV_ICON = { error: '✖', warning: '⚠', notice: 'ℹ' };

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Грешка ' + res.status);
  return data;
}
function render(...nodes) { app.replaceChildren(...nodes); app.focus({ preventScroll: true }); window.scrollTo(0, 0); }
const errorBox = (msg) => h('div', { class: 'error-box', role: 'alert' }, msg);
const eyebrow = (t, boxed) => h('span', { class: 'eyebrow' + (boxed ? ' boxed' : '') }, t);
const healthTone = (x) => (x >= 80 ? '' : x >= 50 ? 'mid' : 'bad');
const ring = (pct, small) => h('div', { class: ['ring', healthTone(pct), small ? 'small' : ''].filter(Boolean).join(' '), style: `--p:${pct}`, role: 'img', 'aria-label': `Здраве ${pct}%` }, h('span', {}, pct + '%'));
const link = (url) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'url' }, url);

// ---------- размер на текста ----------
const FS_KEY = 'yasno-fs';
const setFs = (px) => { px = Math.min(32, Math.max(16, px)); document.documentElement.style.setProperty('--fs', px + 'px'); localStorage.setItem(FS_KEY, px); };
setFs(Number(localStorage.getItem(FS_KEY)) || 20);
document.getElementById('fs-up').onclick = () => setFs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) + 2);
document.getElementById('fs-down').onclick = () => setFs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs')) - 2);

// ---------- навигация ----------
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => (location.hash = b.dataset.view)));
const views = { audit: auditHome, ranks: ranksHome, gsc: gscView, links: gscView, outreach: outreachView, settings: settingsView };
// японски украси (само декор, скрити от екранните четци)
const KANJI = { audit: '監査', ranks: '順位', gsc: '検索', links: '検索', outreach: '連携', settings: '設定' };
let activeStream = null;
function route() {
  activeStream?.close(); activeStream = null;
  const [view = 'audit', ...rest] = location.hash.slice(1).split('/');
  document.querySelectorAll('nav button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'));
  document.body.dataset.view = view;
  document.getElementById('kanji').textContent = KANJI[view] || KANJI.audit;
  (views[view] || auditHome)(...rest);
}
window.addEventListener('hashchange', route);

// ---------- прогрес на задача ----------
function watchJob(jobId, { title, onDone }) {
  const phase = h('p', { class: 'big' }, 'Започвам…');
  const bar = h('div');
  const counts = h('p');
  const current = h('p', { class: 'muted url' });
  const stopBtn = h('button', { class: 'danger', onclick: async () => { stopBtn.disabled = true; stopBtn.textContent = 'Спирам…'; await api(`/jobs/${jobId}/stop`, { method: 'POST' }); } }, 'Спри');
  render(h('h1', {}, title), h('div', { class: 'card' }, phase, h('div', { class: 'progress-bar', role: 'presentation' }, bar), counts, current, h('div', { class: 'actions' }, stopBtn)));
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  activeStream = es;
  let lastSaid = '';
  es.addEventListener('progress', (e) => {
    const p = JSON.parse(e.data);
    if (p.phase) { phase.textContent = p.phase; if (p.phase !== lastSaid) { say(p.phase); lastSaid = p.phase; } }
    if (p.queued) { counts.textContent = `${num(p.done)} от ${num(p.queued)}`; bar.style.width = Math.min(100, (p.done / p.queued) * 100) + '%'; }
    current.textContent = p.current || '';
  });
  es.addEventListener('done', (e) => { es.close(); onDone(JSON.parse(e.data)); });
  es.addEventListener('failed', (e) => { es.close(); render(h('h1', {}, title), errorBox(JSON.parse(e.data).error), h('button', { onclick: () => history.back() }, '← Назад')); });
  es.onerror = () => {};
}

// =====================================================================
// ОДИТ НА САЙТ
// =====================================================================
async function auditHome(id, tab) {
  if (id) return auditReport(id, tab);
  const url = h('input', { type: 'text', id: 'a-url', placeholder: 'например: example.bg', required: true, autocomplete: 'url' });
  const max = h('select', { id: 'a-max' }, [50, 200, 500, 1000, 2000].map((n) => h('option', { value: n, selected: n === 200 }, `до ${num(n)} страници`)));
  const robots = h('input', { type: 'checkbox', id: 'a-robots', checked: true });
  const err = h('div');
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    try {
      const { jobId } = await api('/audits', { method: 'POST', body: { url: url.value.trim(), maxPages: Number(max.value), respectRobots: robots.checked } });
      watchJob(jobId, { title: 'Одит на ' + url.value.trim(), onDone: (d) => { location.hash = d.ref ? `audit/${d.ref}` : 'audit'; } });
    } catch (ex) { err.replaceChildren(errorBox(ex.message)); }
  } },
    h('label', { for: 'a-url' }, 'Адрес на сайта'), url,
    h('div', { class: 'row' },
      h('div', {}, h('label', { for: 'a-max' }, 'Колко страници най-много'), max),
      h('div', {}, h('label', { class: 'check', for: 'a-robots' }, robots, 'Спазвай забраните в robots.txt'))),
    err,
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Започни одита')));

  const list = h('div', {}, h('p', { class: 'muted' }, 'Зареждам…'));
  render(eyebrow('Техническо SEO', true), h('h1', {}, 'Одит на сайт'), h('p', { class: 'lead' }, 'Обхожда сайта като Google и показва какво да се оправи, подредено по важност.'), form, eyebrow('История'), h('h2', { style: 'margin-top:.2rem' }, 'Предишни одити'), list);
  url.focus();
  try {
    const audits = await api('/audits');
    list.replaceChildren(...(audits.length ? audits.map((a) => h('div', { class: 'card' },
      h('div', { class: 'issue-head' },
        ring(a.summary.health, true),
        h('h3', {}, new URL(a.url).hostname)),
      h('p', { class: 'muted' }, `${fmtDate(a.at)} · ${num(a.summary.htmlPages)} страници · ${num(a.summary.errors)} грешки · ${num(a.summary.warnings)} предупреждения${a.stopped ? ' · спрян преди края' : ''}`),
      h('div', { class: 'actions' },
        h('button', { onclick: () => (location.hash = 'audit/' + a.id) }, 'Отвори'),
        h('button', { class: 'danger', onclick: async () => { if (confirm('Да изтрия ли този одит?')) { await api('/audits/' + a.id, { method: 'DELETE' }); route(); } } }, 'Изтрий'))))
      : [h('p', { class: 'muted' }, 'Още няма одити.')]));
  } catch (ex) { list.replaceChildren(errorBox(ex.message)); }
}

async function auditReport(id, tab = 'issues') {
  render(h('p', {}, 'Зареждам отчета…'));
  let r;
  try { r = await api('/audits/' + id); } catch (ex) { return render(errorBox(ex.message)); }
  const s = r.summary;
  const host = new URL(r.site.startUrl).hostname;
  const tile = (n, lbl, tone) => h('div', { class: 'tile' + (tone ? ' t-' + tone : '') }, h('div', { class: 'num' }, n), h('div', { class: 'lbl' }, lbl));
  const tabs = h('div', { class: 'filters', role: 'group', 'aria-label': 'Изглед' },
    h('button', { 'aria-pressed': String(tab === 'issues'), onclick: () => (location.hash = `audit/${id}/issues`) }, 'Проблеми'),
    h('button', { 'aria-pressed': String(tab === 'pages'), onclick: () => (location.hash = `audit/${id}/pages`) }, 'Всички страници'));

  const notes = [];
  if (r.site.stopped) notes.push('Одитът е спрян преди края, затова резултатите са частични.');
  if (r.site.limitReached) notes.push(`Достигнат е лимитът от ${num(r.settings.maxPages)} страници, затова сайтът може да има още.`);
  if (s.externalsTotal > s.externalsChecked) notes.push(`Проверени са ${num(s.externalsChecked)} от ${num(s.externalsTotal)} външни линка.`);

  render(
    h('button', { onclick: () => (location.hash = 'audit') }, '← Всички одити'),
    h('div', {}, eyebrow('Отчет от одит', true)),
    h('h1', {}, host),
    h('p', { class: 'muted' }, fmtDate(r.site.finishedAt)),
    h('div', { class: 'tiles' },
      h('div', { class: 'tile health ' + healthTone(s.health) }, ring(s.health), h('div', {}, h('div', { class: 'num' }, s.health >= 80 ? 'Добро' : s.health >= 50 ? 'Средно' : 'Слабо'), h('div', { class: 'lbl' }, 'Здраве (страници без грешки)'))),
      tile(num(s.htmlPages), 'Страници'),
      tile(num(s.errors), '✖ Грешки', s.errors ? 'error' : 'muted'),
      tile(num(s.warnings), '⚠ Предупреждения', s.warnings ? 'warning' : 'muted'),
      tile(num(s.notices), 'ℹ Съвети', s.notices ? 'notice' : 'muted'),
      tile(s.avgMs != null ? (s.avgMs / 1000).toFixed(1) + ' с' : '–', 'Средно време за отговор')),
    notes.length ? h('div', { class: 'notice-box' }, notes.map((n) => h('p', {}, n))) : null,
    tabs,
    tab === 'pages' ? pagesList(r) : issuesList(r));
}

function issuesList(r) {
  const wrap = h('div');
  let filter = 'all';
  const counts = { all: r.issues.length };
  for (const i of r.issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
  const btns = ['all', 'error', 'warning', 'notice'].map((f) => h('button', { 'aria-pressed': String(f === filter), onclick: () => { filter = f; btns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === f))); draw(); }, 'data-f': f },
    `${f === 'all' ? 'Всички' : SEV_ICON[f] + ' ' + { error: 'Грешки', warning: 'Предупреждения', notice: 'Съвети' }[f]} (${counts[f] || 0})`));
  const list = h('div');
  const draw = () => {
    const shown = r.issues.filter((i) => filter === 'all' || i.severity === filter);
    list.replaceChildren(...(shown.length ? shown.map((i) => issueCard(r, i)) : [h('div', { class: 'card' }, h('p', {}, '✔ Няма проблеми от този вид.'))]));
  };
  draw();
  wrap.append(
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: `/api/audits/${r.id}/csv`, download: true }, 'Изтегли всичко като CSV (за Excel)')),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Покажи' }, btns),
    list);
  return wrap;
}

function issueCard(r, i) {
  const PAGE = 25;
  let shown = 0;
  const ul = h('ul', { class: 'items' });
  const more = h('button', { onclick: () => add() });
  const add = () => {
    for (const it of i.items.slice(shown, shown + PAGE)) ul.append(h('li', {}, link(it.url), it.detail ? h('span', { class: 'detail' }, it.detail) : null));
    shown = Math.min(i.items.length, shown + PAGE);
    more.textContent = `Покажи още (${num(i.items.length - shown)} остават)`;
    more.classList.toggle('hidden', shown >= i.items.length);
  };
  const det = h('details', { class: 'card ' + i.severity },
    h('summary', {}, h('div', { class: 'issue-head' },
      h('span', { class: 'sev ' + i.severity }, SEV_ICON[i.severity] + ' ' + SEV[i.severity]),
      h('h3', {}, i.title),
      h('span', { class: 'count', 'aria-label': `${i.count} броя` }, num(i.count)),
      h('span', { class: 'chev' }))),
    h('div', { class: 'explain' }, h('p', {}, h('b', {}, 'Защо е важно: '), i.why), h('p', {}, h('b', {}, 'Как да се оправи: '), i.fix)),
    ul, h('div', { class: 'actions' }, more, h('a', { class: 'btn', href: `/api/audits/${r.id}/csv?issue=${i.code}`, download: true }, 'CSV само за този проблем')));
  det.addEventListener('toggle', () => { if (det.open && !shown) add(); }, { once: false });
  return det;
}

function pagesList(r) {
  const PAGE = 30;
  const search = h('input', { type: 'search', id: 'p-search', placeholder: 'Търси по адрес или заглавие' });
  const only = h('select', { id: 'p-only' },
    h('option', { value: 'html' }, 'Само HTML страници'),
    h('option', { value: 'all' }, 'Всички адреси'),
    h('option', { value: 'bad' }, 'Само с код, различен от 200'));
  const list = h('div');
  const more = h('button');
  let items = [], shown = 0;
  const statusLabel = (p) => p.error ? h('span', { class: 'sev error' }, '✖ ' + p.error)
    : p.status === 200 && !p.chain.length ? h('span', { class: 'sev ok' }, '✔ 200')
    : p.chain.length ? h('span', { class: 'sev warning' }, `↪ ${p.chain[0].status}`)
    : h('span', { class: 'sev error' }, '✖ ' + p.status);
  const fact = (k, v) => [h('dt', {}, k), h('dd', {}, v ?? '–')];
  const card = (p) => h('details', { class: 'card' },
    h('summary', {}, h('div', { class: 'issue-head' }, statusLabel(p), h('h3', { class: 'url' }, p.url), h('span', { class: 'chev' })),
      p.title ? h('p', { class: 'muted' }, p.title) : null),
    h('dl', { class: 'facts' },
      fact('Адрес', link(p.url)),
      p.chain.length ? fact('Пренасочва към', link(p.finalUrl)) : null,
      fact('Време за отговор', p.ms != null ? (p.ms / 1000).toFixed(2) + ' сек.' : null),
      fact('Заглавие', p.title ? `${p.title} (${p.title.length} знака)` : null),
      fact('Мета описание', p.metaDesc ? `${p.metaDesc} (${p.metaDesc.length} знака)` : null),
      fact('H1', p.h1?.length ? p.h1.join(' | ') : null),
      fact('Думи', p.wordCount != null ? num(p.wordCount) : null),
      fact('Клика от началото', p.depth),
      fact('Вътрешни линкове към нея', num(p.inlinks)),
      fact('Canonical', p.canonical),
      fact('Видима за Google', p.isHtml ? (p.noindex ? 'Не (noindex)' : 'Да') : null),
      fact('В sitemap', p.inSitemap ? 'Да' : 'Не'),
      fact('Картинки без alt', p.imagesNoAlt ? `${p.imagesNoAlt.length} от ${p.imagesTotal}` : null),
      fact('Език', p.lang)));
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    items = r.pages.filter((p) => (only.value === 'all' || (only.value === 'html' ? p.isHtml : (p.status !== 200 || p.chain.length || p.error)))
      && (!q || p.url.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q)));
    shown = 0; list.replaceChildren(); addMore();
    say(`${items.length} страници`);
  };
  const addMore = () => {
    list.append(...items.slice(shown, shown + PAGE).map(card));
    shown = Math.min(items.length, shown + PAGE);
    more.textContent = `Покажи още (${num(items.length - shown)} остават)`;
    more.classList.toggle('hidden', shown >= items.length);
    if (!items.length) list.append(h('p', { class: 'muted' }, 'Нищо не е намерено.'));
  };
  more.onclick = addMore;
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(draw, 250); };
  only.onchange = draw;
  setTimeout(draw);
  return h('div', {}, h('div', { class: 'row' },
    h('div', {}, h('label', { for: 'p-search' }, 'Търсене'), search),
    h('div', {}, h('label', { for: 'p-only' }, 'Покажи'), only)), h('div', { style: 'margin-top:1rem' }, list), h('div', { class: 'actions' }, more));
}

// =====================================================================
// ПОЗИЦИИ В GOOGLE
// =====================================================================
const COUNTRIES = [['bg', 'България'], ['us', 'САЩ'], ['uk', 'Великобритания'], ['de', 'Германия'], ['gr', 'Гърция'], ['ro', 'Румъния'], ['tr', 'Турция'], ['fr', 'Франция'], ['es', 'Испания'], ['it', 'Италия']];
const LANGS = [['bg', 'български'], ['en', 'английски'], ['de', 'немски'], ['el', 'гръцки'], ['ro', 'румънски'], ['tr', 'турски'], ['fr', 'френски'], ['es', 'испански'], ['it', 'италиански']];

const SCHEDULES = [['off', 'Само ръчно'], ['daily', 'Всеки ден'], ['weekly', 'Всяка седмица'], ['monthly', 'Всеки месец']];
const SRC_LABEL = { gsc: 'Search Console (безплатно)', serpapi: 'SerpApi' };
const posFmt = (x) => (x == null ? '–' : Number(x).toLocaleString('bg-BG', { maximumFractionDigits: 1 }));

async function ranksHome(id, sub) {
  if (id === 'new') return rankForm();
  if (id && sub === 'edit') return rankForm(id);
  if (id) return rankProject(id);
  render(h('p', {}, 'Зареждам…'));
  const [settings, gscSt, projects] = await Promise.all([api('/settings'), api('/gsc/status'), api('/ranks')]);
  const head = [eyebrow('Класиране', true), h('h1', {}, 'Позиции в Google'),
    h('p', { class: 'lead' }, 'На кое място излиза сайтът ти в Google за дадени думи и как се променя с времето. За твоите сайтове данните идват безплатно от Search Console, а за конкуренти и точни позиции от SerpApi.')];
  if (!settings.hasSerpapiKey && !gscSt.connected) {
    return render(...head, h('div', { class: 'notice-box' }, h('p', {}, 'Свържи Search Console или въведи SerpApi ключ.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (location.hash = 'gsc') }, 'Свържи Search Console'), h('button', { onclick: () => (location.hash = 'settings') }, 'SerpApi ключ'))));
  }
  render(...head,
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (location.hash = 'ranks/new') }, '+ Нов проект')),
    eyebrow('Проекти'), h('h2', { style: 'margin-top:.2rem' }, 'Твоите проекти'),
    ...(projects.length ? projects.map((p) => {
      const last = p.history.at(-1);
      const found = last ? Object.values(last.results).filter((x) => x.position).length : 0;
      const sched = SCHEDULES.find((s) => s[0] === (p.schedule || 'off'))[1].toLowerCase();
      return h('div', { class: 'card' },
        h('div', { class: 'issue-head' }, h('h3', {}, p.name), h('span', { class: 'sev ' + ((p.source || 'serpapi') === 'gsc' ? 'ok' : 'notice') }, SRC_LABEL[p.source || 'serpapi'])),
        h('p', { class: 'muted' }, `${p.domain} · ${p.keywords.length} думи · ${sched} · ${last ? 'последна проверка ' + fmtDate(last.at) + ` · намерени: ${found}` : 'още не е проверяван'}`),
        h('div', { class: 'actions' }, h('button', { onclick: () => (location.hash = 'ranks/' + p.id) }, 'Отвори')));
    }) : [h('p', { class: 'muted' }, 'Още няма проекти.')]));
}

async function rankForm(id) {
  const [all, gscSt] = await Promise.all([api('/ranks'), api('/gsc/status')]);
  const p = id ? all.find((x) => x.id === id) : null;
  const f = (label, el, hint) => [h('label', { for: el.id }, label, hint ? h('span', { class: 'hint' }, hint) : null), el];
  const name = h('input', { type: 'text', id: 'r-name', value: p?.name || '', placeholder: 'например: Моят магазин' });
  const domain = h('input', { type: 'text', id: 'r-domain', value: p?.domain || '', placeholder: 'example.bg', required: true });
  const kws = h('textarea', { id: 'r-kws', placeholder: 'по една на ред' }, (p?.keywords || []).join('\n'));
  const comps = h('textarea', { id: 'r-comps', style: 'min-height:5rem', placeholder: 'konkurent.bg' }, (p?.competitors || []).join('\n'));
  const sel = (id, opts, val) => h('select', { id }, opts.map(([v, t]) => h('option', { value: v, selected: v === val }, t)));
  const defaultSrc = p?.source || (gscSt.connected ? 'gsc' : 'serpapi');
  const source = sel('r-src', [['gsc', 'Search Console: безплатно, само за твои сайтове'], ['serpapi', 'SerpApi: точна позиция, конкуренти, топ 10']], defaultSrc);
  const gl = sel('r-gl', [['all', 'Всички държави (само Search Console)'], ...COUNTRIES], p?.gl || 'bg');
  const hl = sel('r-hl', LANGS, p?.hl || 'bg');
  const device = sel('r-device', [['all', 'Всички устройства (само Search Console)'], ['desktop', 'Компютър'], ['mobile', 'Телефон']], p?.device || 'desktop');
  const depth = sel('r-depth', [10, 20, 30, 50, 100].map((n) => [String(n), `Първите ${n} резултата`]), String(p?.depth || 30));
  const schedule = sel('r-sched', SCHEDULES, p?.schedule || 'weekly');
  const location_ = h('input', { type: 'text', id: 'r-loc', value: p?.location || '', placeholder: 'например: Sofia,Sofia City Province,Bulgaria' });
  const serpOnly = h('div', {},
    f('Конкуренти (по желание, до 5)', comps, 'По един домейн на ред'),
    h('div', { class: 'row' }, h('div', {}, f('Език на Google', hl)), h('div', {}, f('Колко дълбоко да търси', depth))),
    f('Точен град (по желание)', location_, 'Във формата на SerpApi. Празно означава цялата държава.'));
  const cost = h('div', { class: 'notice-box' });
  const upd = () => {
    const gsc = source.value === 'gsc';
    serpOnly.classList.toggle('hidden', gsc);
    schedule.querySelector('option[value="daily"]').disabled = !gsc;
    if (!gsc && schedule.value === 'daily') schedule.value = 'weekly';
    gl.querySelector('option[value="all"]').disabled = !gsc; device.querySelector('option[value="all"]').disabled = !gsc;
    if (!gsc && gl.value === 'all') gl.value = 'us';
    if (!gsc && device.value === 'all') device.value = 'desktop';
    const n = kws.value.split('\n').filter((x) => x.trim()).length;
    const per = Math.ceil(Number(depth.value) / 10) * n;
    const runs = { off: 0, daily: 30, weekly: 4.3, monthly: 1 }[schedule.value];
    cost.replaceChildren(...(gsc
      ? [h('p', {}, '✔ Безплатно. Показва средната позиция за последните 7 дни по данни на Google. Ако за 7 дни няма данни, взима последните 28.'),
         h('p', { class: 'muted' }, 'Думи, по които сайтът не се е показвал, излизат като „няма импресии“. Конкуренти не може да се следят: за тях избери SerpApi.')]
      : [h('p', {}, `Една проверка струва между ${num(n)} и ${num(per)} заявки в SerpApi (спира рано, щом намери сайта${comps.value.trim() ? ' и конкурентите' : ''}).`),
         runs ? h('p', { class: per * runs > 200 ? 'down' : 'muted' }, `С този график: до ~${num(Math.round(per * runs))} заявки на месец. Безплатният план има 250.`) : null]));
  };
  source.onchange = upd; kws.oninput = upd; depth.onchange = upd; comps.oninput = upd; schedule.onchange = upd;
  const err = h('div');
  render(
    h('button', { onclick: () => history.back() }, '← Назад'),
    h('div', {}, eyebrow('Позиции', true)), h('h1', {}, p ? 'Промени проекта' : 'Нов проект'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      try {
        const saved = await api('/ranks', { method: 'POST', body: {
          id: p?.id, name: name.value, domain: domain.value, keywords: kws.value.split('\n'), competitors: comps.value.split('\n'),
          gl: gl.value, hl: hl.value, device: device.value, depth: Number(depth.value), location: location_.value,
          source: source.value, schedule: schedule.value } });
        location.hash = 'ranks/' + saved.id;
      } catch (ex) { err.replaceChildren(errorBox(ex.message)); }
    } },
      f('Име на проекта', name),
      f('Домейн', domain, 'Без http:// и без www'),
      f('Ключови думи', kws, 'По една на ред'),
      f('Откъде да взимам позициите', source, gscSt.connected ? null : 'Search Console не е свързан. Свържи го от раздела Search Console.'),
      h('div', { class: 'row' }, h('div', {}, f('Държава', gl)), h('div', {}, f('Устройство', device))),
      serpOnly,
      f('Автоматична проверка', schedule, 'Работи, докато приложението е пуснато. Ако компютърът е бил изключен, проверката се прави при следващото пускане.'),
      cost, err,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Запази'),
        p ? h('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm('Да изтрия ли проекта и историята му?')) { await api('/ranks/' + p.id, { method: 'DELETE' }); location.hash = 'ranks'; } } }, 'Изтрий проекта') : null)));
  upd();
  (p ? kws : domain).focus();
}

async function rankProject(id) {
  render(h('p', {}, 'Зареждам…'));
  const p = (await api('/ranks')).find((x) => x.id === id);
  if (!p) return render(errorBox('Проектът не е намерен'));
  const src = p.source || 'serpapi';
  const last = p.history.at(-1), prev = p.history.at(-2);
  let sort = 'pos';
  const list = h('div');
  const run = async () => {
    try {
      const { jobId } = await api(`/ranks/${id}/check`, { method: 'POST' });
      watchJob(jobId, { title: 'Проверка: ' + p.name, onDone: () => route() });
    } catch (ex) { list.prepend(errorBox(ex.message)); }
  };
  const change = (now, before) => {
    if (now == null && before == null) return null;
    if (before == null) return h('span', { class: 'up' }, '★ ново');
    if (now == null) return h('span', { class: 'down' }, `▼ изпадна (беше ${posFmt(before)})`);
    const d = Math.round((before - now) * 10) / 10;
    return d > 0 ? h('span', { class: 'up' }, `▲ ${posFmt(d)} нагоре`) : d < 0 ? h('span', { class: 'down' }, `▼ ${posFmt(-d)} надолу`) : h('span', { class: 'muted' }, '= без промяна');
  };
  const draw = () => {
    if (!last) return list.replaceChildren(h('p', { class: 'muted' }, 'Още няма проверка. Натисни „Провери сега“.'));
    const rows = p.keywords.map((k) => ({ k, r: last.results[k] || {}, before: prev?.results[k]?.position ?? null }));
    const val = (x) => x.r.position ?? 999;
    rows.sort(sort === 'pos' ? (a, b) => val(a) - val(b) : sort === 'abc' ? (a, b) => a.k.localeCompare(b.k, 'bg')
      : (a, b) => ((b.before ?? 999) - val(b)) - ((a.before ?? 999) - val(a)));
    list.replaceChildren(...rows.map(({ k, r, before }) => {
      const hist = p.history.slice(-6).map((hh) => posFmt(hh.results[k]?.position));
      const gscRes = r.source === 'gsc';
      return h('div', { class: 'card' }, h('div', { class: 'kw' },
        h('div', { class: 'pos' + (r.position ? (r.position <= 3 ? ' top3' : r.position <= 10 ? ' top10' : r.position <= 30 ? ' top30' : '') : '') }, r.error ? h('div', { class: 'n none down' }, 'Грешка')
          : r.position ? [h('div', { class: 'n' }, posFmt(r.position)), h('div', { class: 'muted' }, gscRes ? 'средно място' : 'място')]
          : h('div', { class: 'n none' }, gscRes ? 'Няма импресии' : `Няма в топ ${p.depth}`)),
        h('div', {},
          h('h3', {}, k),
          r.error ? h('p', { class: 'down' }, r.error) : null,
          h('p', {}, change(r.position ?? null, before), hist.length > 1 ? h('span', { class: 'muted' }, `  История: ${hist.join(' → ')}`) : null),
          gscRes && r.impressions ? h('p', { class: 'muted' }, `${num(r.clicks)} клика · ${num(r.impressions)} импресии за последните ${r.days || 7} дни${r.days === 28 ? ' (за 7 дни няма данни)' : ''}`) : null,
          r.url ? h('p', {}, link(r.url)) : null,
          !gscRes && p.competitors.length ? h('p', { class: 'muted' }, 'Конкуренти: ', p.competitors.map((c) => `${c} ${r.competitors?.[c] ? '№' + r.competitors[c].position : '–'}`).join(' · ')) : null,
          r.top?.length ? serpCompare(k, r, p) : null)));
    }));
  };
  const sortBtns = [['pos', 'По позиция'], ['change', 'По промяна'], ['abc', 'По азбучен ред']].map(([v, t]) => h('button', { 'aria-pressed': String(v === sort), 'data-s': v, onclick: () => { sort = v; sortBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === v))); draw(); } }, t));
  const found = last ? Object.values(last.results).filter((x) => x.position) : [];
  const top3 = found.filter((x) => x.position <= 3).length, top10 = found.filter((x) => x.position <= 10).length;
  const tile = (n, lbl) => h('div', { class: 'tile' }, h('div', { class: 'num' }, n), h('div', { class: 'lbl' }, lbl));
  const sched = SCHEDULES.find((s) => s[0] === (p.schedule || 'off'))[1].toLowerCase();
  render(
    h('button', { onclick: () => (location.hash = 'ranks') }, '← Всички проекти'),
    h('div', {}, eyebrow('Проект за позиции', true)),
    h('h1', {}, p.name),
    h('p', { class: 'muted' }, `${p.domain} · ${SRC_LABEL[src]} · ${p.gl === 'all' ? 'всички държави' : COUNTRIES.find((c) => c[0] === p.gl)?.[1] || p.gl} · ${p.device === 'mobile' ? 'телефон' : p.device === 'all' ? 'всички устройства' : 'компютър'} · автоматично: ${sched}`),
    last ? h('p', { class: 'muted' }, `Последна проверка ${fmtDate(last.at)}${last.source === 'gsc' ? ' (Search Console, безплатно)' : ` (${last.searches} заявки в SerpApi)`}`) : null,
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: run }, src === 'gsc' ? 'Провери сега (безплатно)' : 'Провери сега'), h('button', { onclick: () => (location.hash = `ranks/${id}/edit`) }, 'Думи, източник и график')),
    last ? h('div', { class: 'tiles' }, tile(num(p.keywords.length), 'Думи'), tile(num(top3), 'В топ 3'), tile(num(top10), 'В топ 10'), tile(num(found.length), src === 'gsc' ? 'С импресии' : `В топ ${p.depth}`)) : null,
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Подреди' }, sortBtns),
    list);
  draw();
}

// ---------- преглед на първите 10 в Google и сравнение с твоята страница ----------
const fmtDay = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toLocaleDateString('bg-BG', { year: 'numeric', month: 'short', day: 'numeric' }); };
const median = (xs) => { const a = xs.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const yes = (x) => x >= 0.99; // всички думи на заявката са там
const part = (x) => x >= 0.5 && x < 0.99; // поне половината думи

async function poolMap(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

function peekView(d) {
  const chip = (t, cls) => h('span', { class: 'chip' + (cls ? ' ' + cls : '') }, t);
  const kwChip = (x, label) => yes(x) ? chip('✔ ' + label, 'good') : part(x) ? chip('◐ частично ' + label, 'half') : chip('✖ ' + label, 'bad');
  const date = fmtDay(d.schema.modified) || fmtDay(d.schema.published);
  const h2 = d.h2.length ? h('details', { class: 'h2list' }, h('summary', {}, `Подзаглавия H2 (${num(d.h2Count)})`),
    h('ol', {}, d.h2.map((x) => h('li', {}, x))), d.h2Count > d.h2.length ? h('p', { class: 'muted' }, `…и още ${num(d.h2Count - d.h2.length)}`) : null) : null;
  return h('div', { class: 'peek-body' },
    h('dl', { class: 'facts' },
      h('dt', {}, 'Заглавие (title)'), h('dd', {}, d.title ? `${d.title} (${d.title.length} знака)` : h('span', { class: 'down' }, 'няма')),
      h('dt', {}, 'H1'), h('dd', {}, d.h1.length ? d.h1.join(' | ') : h('span', { class: 'down' }, 'няма')),
      h('dt', {}, 'Описание'), h('dd', {}, d.metaDesc ? `${d.metaDesc} (${d.metaDesc.length} знака)` : h('span', { class: 'muted' }, 'няма (Google си прави сам)'))),
    h2,
    h('div', { class: 'chips' },
      chip(`${num(d.words)} думи`),
      chip(`${num(d.h2Count)} H2 · ${num(d.h3Count)} H3`),
      d.schema.types.length ? chip('Schema: ' + d.schema.types.slice(0, 4).join(', ')) : chip('без структурирани данни', 'dim'),
      date ? chip((d.schema.modified ? 'Обновена ' : 'Публикувана ') + date) : null,
      d.schema.rating?.value ? chip(`★ ${d.schema.rating.value}${d.schema.rating.count ? ` (${num(d.schema.rating.count)})` : ''}`) : null,
      chip(`${num(d.images)} картинки`),
      d.videos ? chip(`${num(d.videos)} видео`) : null,
      d.tables ? chip(`${num(d.tables)} таблици`) : null,
      d.faq ? chip('ЧЗВ / въпроси') : null,
      chip(`${num(d.internal)} вътр. · ${num(d.external)} външни линка`),
      chip(`${(d.ms / 1000).toFixed(1)} с отговор`),
      d.noindex ? chip('noindex', 'bad') : null),
    d.kw ? h('div', { class: 'chips' },
      h('span', { class: 'muted chips-lbl' }, 'Ключовата дума:'),
      kwChip(d.kw.title, 'в заглавието'), kwChip(d.kw.h1, 'в H1'), kwChip(d.kw.url, 'в адреса'), kwChip(d.kw.desc, 'в описанието'),
      chip(`${num(d.kw.h2)} H2 с нея`), chip(`точната фраза ${num(d.kw.exact)} пъти`)) : null);
}

function compareBox(kw, mine, others, depth) {
  const box = h('div', { class: 'compare card' });
  const ok = others.filter((d) => d && !d.approx);
  const skipped = others.filter((d) => d?.approx).length;
  if (!ok.length) { if (skipped) box.append(h('h3', {}, 'Сравнение'), h('p', { class: 'muted' }, `Google не даде точните адреси на резултатите (${skipped}), а само домейните, затова няма с какво да се сравни. Пусни нова проверка: тя ще запише точните адреси.`)); return box; }
  const share = (f) => ok.filter(f).length;
  const typeCount = {};
  for (const d of ok) for (const t of new Set(d.schema.types)) typeCount[t] = (typeCount[t] || 0) + 1;
  const commonTypes = Object.entries(typeCount).filter(([, n]) => n >= Math.max(2, ok.length * 0.3)).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`);
  const mWords = median(ok.map((d) => d.words)), mH2 = median(ok.map((d) => d.h2Count)), mImg = median(ok.map((d) => d.images));
  const mark = (v) => (v ? '✔ да' : '✖ не');
  const mark3 = (x) => (yes(x) ? '✔ да' : part(x) ? '◐ частично' : '✖ не');
  const kwShare = (k) => { const full = share((d) => yes(d.kw[k])), half = share((d) => part(d.kw[k])); return `${full} от ${ok.length}` + (half ? ` (+${half} частично)` : ''); };
  const rows = [
    ['Думи в текста', mine ? num(mine.words) : '–', `~${num(mWords)} (медиана)`],
    ['Подзаглавия H2', mine ? num(mine.h2Count) : '–', `~${num(mH2)}`],
    ['Картинки', mine ? num(mine.images) : '–', `~${num(mImg)}`],
    ['Думата в заглавието', mine?.kw ? mark3(mine.kw.title) : '–', kwShare('title')],
    ['Думата в H1', mine?.kw ? mark3(mine.kw.h1) : '–', kwShare('h1')],
    ['Думата в адреса', mine?.kw ? mark3(mine.kw.url) : '–', kwShare('url')],
    ['Структурирани данни', mine ? (mine.schema.types.slice(0, 4).join(', ') || 'няма') : '–', commonTypes.join(', ') || 'рядко'],
    ['С ЧЗВ / въпроси', mine ? mark(mine.faq) : '–', `${share((d) => d.faq)} от ${ok.length}`],
  ];
  const tips = [];
  if (mine) {
    if (mWords && mine.words < mWords * 0.7) tips.push(`Текстът ти е по-кратък: ${num(mine.words)} срещу около ${num(mWords)} думи при първите 10. Добави раздели, които те покриват, а ти не.`);
    if (mine.kw && !yes(mine.kw.title) && share((d) => yes(d.kw.title)) >= ok.length * 0.6) tips.push('Повечето от първите 10 имат думата в заглавието (title), а ти нямаш.');
    if (mine.kw && !yes(mine.kw.h1) && share((d) => yes(d.kw.h1)) >= ok.length * 0.5) tips.push('Сложи думата и в H1: така правят повечето от първите 10.');
    if (mH2 && mine.h2Count < mH2 * 0.6) tips.push(`Имаш по-малко подзаглавия H2 (${num(mine.h2Count)} срещу ~${num(mH2)}). Виж подзаглавията им отдолу: това са темите, които Google очаква.`);
    const missing = Object.entries(typeCount).filter(([t, n]) => n >= ok.length * 0.4 && !mine.schema.types.includes(t)).map(([t]) => t);
    if (missing.length) tips.push(`Често срещани структурирани данни, които липсват при теб: ${missing.join(', ')}.`);
    if (share((d) => d.faq) >= ok.length * 0.4 && !mine.faq) tips.push('Много от първите 10 имат раздел с въпроси и отговори (ЧЗВ).');
    if (!tips.length) tips.push('По тези показатели страницата ти е наравно с първите 10. Разликата вероятно е в обратните линкове, авторитета на сайта или в това колко добре текстът отговаря на търсенето.');
  }
  box.append(...[
    h('h3', {}, mine ? 'Твоята страница срещу първите 10' : `Какво общо имат първите 10`),
    skipped ? h('p', { class: 'muted' }, `Сравнението е по ${ok.length} страници. ${skipped} резултата са пропуснати, защото Google даде само домейна им, а не точната страница.`) : null,
    !mine ? h('p', { class: 'muted' }, `Сайтът ти не е в първите ${depth} за „${kw}“. Въведи адреса на твоята страница по темата отгоре, за да ги сравниш.`) : null,
    h('div', { class: 'cmp-table', role: 'table', 'aria-label': 'Сравнение' },
      h('div', { class: 'cmp-row cmp-head', role: 'row' }, h('span', { role: 'columnheader' }, 'Показател'), h('span', { role: 'columnheader' }, 'Твоята'), h('span', { role: 'columnheader' }, 'Първите 10')),
      rows.map(([a, b, c]) => h('div', { class: 'cmp-row', role: 'row' }, h('span', { role: 'rowheader' }, a), h('span', { role: 'cell' }, b), h('span', { role: 'cell' }, c)))),
    tips.length ? h('div', { class: 'explain' }, h('p', {}, h('b', {}, 'Какво да подобриш:')), h('ul', {}, tips.map((t) => h('li', {}, t)))) : null].filter(Boolean));
  return box;
}

function serpCompare(kw, r, p) {
  const det = h('details', { class: 'serp' });
  const body = h('div');
  det.append(h('summary', { class: 'muted' }, h('span', { class: 'serp-sum' }, 'Първите 10 в Google: заглавия, H1 и сравнение')), body);
  let loaded = false;
  det.addEventListener('toggle', () => { if (det.open && !loaded) { loaded = true; build(); } });

  function build() {
    const results = new Array(r.top.length).fill(null);
    let mine = null;
    const cmpSlot = h('div');
    const redraw = () => cmpSlot.replaceChildren(compareBox(kw, mine, results, p.depth));
    const mineUrl = h('input', { type: 'url', id: 'mine-' + kw.replace(/\W+/g, '-'), placeholder: 'https://твоят-сайт.bg/страница', value: r.url || '' });
    const mineSlot = h('div');
    const loadMine = async () => {
      const u = mineUrl.value.trim(); if (!u) return;
      mineSlot.replaceChildren(h('p', { class: 'muted' }, 'Отварям твоята страница…'));
      try {
        mine = await api(`/peek?url=${encodeURIComponent(u)}&kw=${encodeURIComponent(kw)}`);
        mineSlot.replaceChildren(h('div', { class: 'serp-item mine' }, h('div', { class: 'serp-head' }, h('span', { class: 'serp-pos' }, r.position ? '№' + posFmt(r.position) : 'ТИ'), h('div', {}, h('b', {}, 'Твоята страница'), h('span', { class: 'detail' }, link(mine.finalUrl)))), peekView(mine)));
      } catch (ex) { mine = null; mineSlot.replaceChildren(errorBox(ex.message)); }
      redraw();
    };
    const list = h('ol', { class: 'serp-list' }, r.top.map((t, i) => {
      const slot = h('div', { class: 'peek-slot' }, h('p', { class: 'muted loading' }, 'Отварям страницата…'));
      const own = r.url && t.link === r.url;
      const approx = t.approx || (t.approx === undefined && /^https?:\/\/[^/]+\/$/.test(t.link));
      const item = h('li', { class: 'serp-item' + (own ? ' mine' : '') },
        h('div', { class: 'serp-head' },
          h('span', { class: 'serp-pos', 'aria-label': `Място ${t.position}` }, String(t.position)),
          h('div', {},
            h('h4', {}, t.title || t.link, own ? h('span', { class: 'sev ok' }, 'твоята') : null),
            h('span', { class: 'detail' }, link(t.link)),
            t.snippet ? h('p', { class: 'snippet' }, t.snippet) : null,
            approx ? h('p', { class: 'muted snippet' }, 'ℹ Google не даде точния адрес, а само домейна. Ако резултатът е вътрешна страница, прегледът тук е на началната страница на сайта.') : null)),
        slot);
      item._load = async () => {
        try { results[i] = { ...(await api(`/peek?url=${encodeURIComponent(t.link)}&kw=${encodeURIComponent(kw)}`)), approx }; slot.replaceChildren(peekView(results[i])); }
        catch (ex) { slot.replaceChildren(h('p', { class: 'muted' }, '✖ Не успях да отворя страницата: ' + ex.message)); }
        redraw();
      };
      return item;
    }));
    body.replaceChildren(
      h('form', { class: 'mine-form', onsubmit: (e) => { e.preventDefault(); loadMine(); } },
        h('label', { for: mineUrl.id }, 'Твоята страница за сравнение', h('span', { class: 'hint' }, r.url ? 'Това е страницата, с която се класираш. Може да я смениш.' : 'Сайтът ти не е в резултатите. Въведи страницата, която искаш да класираш за тази дума.')),
        h('div', { class: 'row' }, mineUrl, h('button', { type: 'submit' }, 'Сравни'))),
      mineSlot, cmpSlot, list);
    say('Зареждам първите 10 резултата');
    if (r.url) loadMine();
    poolMap([...list.children], 3, (li) => li._load()).then(() => say('Прегледът е готов'));
  }
  return det;
}

// =====================================================================
// SEARCH CONSOLE
// =====================================================================
const GSC_TABS = [['overview', 'Обзор'], ['queries', 'Заявки'], ['pages', 'Страници'], ['chances', 'Възможности'], ['backlinks', 'Обратни линкове']];
const pct = (x) => (x * 100).toLocaleString('bg-BG', { maximumFractionDigits: 1 }) + '%';
const pos1 = (x) => (x == null ? '–' : x.toLocaleString('bg-BG', { maximumFractionDigits: 1 }));
const siteLabel = (s) => s.startsWith('sc-domain:') ? s.slice(10) + ' (целия домейн)' : s;

async function gscView(tab = 'overview', extra) {
  const head = [eyebrow('Данни от Google', true), h('h1', {}, 'Search Console')];
  if (tab === 'error') {
    return render(...head, errorBox(decodeURIComponent(extra || 'Неуспешно свързване')), h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (location.hash = 'gsc') }, 'Опитай пак')));
  }
  render(...head, h('p', {}, 'Зареждам…'));
  const st = await api('/gsc/status');
  if (!st.hasClient) return render(...head, errorBox('Липсва файлът data/google-client.json с OAuth клиента от Google Cloud.'));
  if (!st.connected) {
    const btn = h('button', { class: 'primary', onclick: async () => { btn.disabled = true; const { url } = await api('/gsc/connect'); location.href = url; } }, 'Свържи с Google');
    return render(...head,
      h('p', { class: 'lead' }, 'Показва реалните кликове, импресии и позиции на твоите сайтове в Google, без да харчи SerpApi заявки.'),
      h('div', { class: 'card' },
        h('p', {}, 'Ще те прехвърля към Google, за да разрешиш само четене на данните от Search Console.'),
        h('p', { class: 'muted' }, 'Ако Google покаже „Google hasn’t verified this app“, натисни „Advanced“ → „Go to … (unsafe)“. Това е твоето собствено OAuth приложение от Google Cloud.'),
        h('div', { class: 'actions' }, btn)));
  }
  let sites;
  try { sites = await api('/gsc/sites'); }
  catch (ex) { return render(...head, errorBox(ex.message), h('div', { class: 'actions' }, h('button', { onclick: async () => { await api('/gsc/disconnect', { method: 'POST' }); route(); } }, 'Свържи отново'))); }
  if (!sites.length) return render(...head, h('div', { class: 'notice-box' }, h('p', {}, 'Профилът ти няма потвърдени сайтове в Search Console.')));
  let site = localStorage.getItem('yasno-gsc-site');
  if (!sites.some((s) => s.siteUrl === site)) site = sites[0].siteUrl;
  let days = Number(localStorage.getItem('yasno-gsc-days')) || 28;
  const siteSel = h('select', { id: 'g-site', onchange: () => { localStorage.setItem('yasno-gsc-site', siteSel.value); route(); } }, sites.map((s) => h('option', { value: s.siteUrl, selected: s.siteUrl === site }, siteLabel(s.siteUrl))));
  const daysSel = h('select', { id: 'g-days', onchange: () => { localStorage.setItem('yasno-gsc-days', daysSel.value); route(); } }, [[7, 'Последните 7 дни'], [28, 'Последните 28 дни'], [90, 'Последните 3 месеца']].map(([v, t]) => h('option', { value: v, selected: v === days }, t)));
  const tabs = h('div', { class: 'filters', role: 'group', 'aria-label': 'Раздел' }, GSC_TABS.map(([v, t]) => h('button', { 'aria-pressed': String(v === tab), onclick: () => (location.hash = 'gsc/' + v) }, t)));
  const body = h('div', {}, h('p', { class: 'muted' }, 'Зареждам данните от Google…'));
  render(...head,
    h('div', { class: 'row' }, h('div', {}, h('label', { for: 'g-site' }, 'Сайт'), siteSel), tab === 'backlinks' ? null : h('div', {}, h('label', { for: 'g-days' }, 'Период'), daysSel)),
    h('div', { style: 'margin-top:1rem' }, tabs), body,
    h('div', { class: 'actions', style: 'margin-top:3rem' }, h('button', { class: 'small', onclick: async () => { if (confirm('Да прекъсна ли връзката със Search Console?')) { await api('/gsc/disconnect', { method: 'POST' }); route(); } } }, 'Прекъсни връзката с Google')));
  if (tab === 'backlinks') return gscBacklinks(body, site);
  let d;
  try { d = await api(`/gsc/performance?site=${encodeURIComponent(site)}&days=${days}`); }
  catch (ex) { return body.replaceChildren(errorBox(ex.message)); }
  d.noPrev = !d.prevTotal.impressions;
  const period = h('p', { class: 'muted' }, `${d.range[0]} – ${d.range[1]}, ${d.noPrev ? 'без сравнение (няма данни за предишните ' + days + ' дни)' : `сравнено с ${d.prevRange[0]} – ${d.prevRange[1]}`}. Данните на Google закъсняват 2–3 дни.`);
  if (tab === 'overview') body.replaceChildren(period, gscOverview(d));
  else if (tab === 'queries') body.replaceChildren(period, gscList(d.queries, 'заявка', d.noPrev));
  else if (tab === 'pages') body.replaceChildren(period, gscList(d.pages, 'страница', d.noPrev));
  else body.replaceChildren(period, gscChances(d));
}

function delta(cur, prev, { lowerIsBetter = false, fmt = num } = {}) {
  if (prev == null || prev === 0 && cur === 0) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < 0.05) return h('span', { class: 'muted' }, '= без промяна');
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  return h('span', { class: good ? 'up' : 'down' }, `${diff > 0 ? '▲' : '▼'} ${fmt(Math.abs(diff))}`);
}

function gscOverview(d) {
  const t = d.total, p = d.noPrev ? {} : d.prevTotal;
  const tile = (n, lbl, ch) => h('div', { class: 'tile' }, h('div', { class: 'num' }, n), h('div', { class: 'lbl' }, lbl), ch ? h('div', { style: 'margin-top:.3rem' }, ch) : null);
  const best = [...d.daily].sort((a, b) => b.clicks - a.clicks)[0];
  const topQ = [...d.queries].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 5);
  const namedClicks = d.queries.reduce((s, q) => s + q.clicks, 0);
  return h('div', {},
    h('div', { class: 'tiles' },
      tile(num(t.clicks), 'Кликове', delta(t.clicks, p.clicks)),
      tile(num(t.impressions), 'Импресии', delta(t.impressions, p.impressions)),
      tile(pct(t.ctr), 'CTR (кликове / импресии)', d.noPrev ? null : delta(t.ctr * 100, p.ctr * 100, { fmt: (x) => x.toLocaleString('bg-BG', { maximumFractionDigits: 1 }) + ' п.п.' })),
      tile(pos1(t.position), 'Средна позиция', !d.noPrev && t.position && p.position ? delta(t.position, p.position, { lowerIsBetter: true, fmt: pos1 }) : null)),
    best ? h('p', {}, h('b', {}, 'Най-добър ден: '), `${best.date} с ${num(best.clicks)} клика.`) : null,
    h('p', {}, h('b', {}, 'Възможности: '), `${num(d.nearly.length)} заявки са почти на първа страница, ${num(d.lowCtr.length)} са високо, но с малко кликове. `, h('a', { href: '#gsc/chances' }, 'Виж ги →')),
    eyebrow('Топ 5'), h('h2', { style: 'margin-top:.2rem' }, 'Най-важни заявки'),
    h('p', { class: 'muted' }, `Подредени по кликове, после по импресии.${t.clicks > namedClicks ? ` Google скрива редките заявки за поверителност, затова ${num(t.clicks - namedClicks)} от ${num(t.clicks)} клика не са свързани с конкретна заявка.` : ''}`),
    gscItems(topQ, d.noPrev));
}

function gscItems(rows, noPrev) {
  return h('ul', { class: 'items card' }, rows.map((r) => h('li', {},
    /^https?:/.test(r.key) ? link(r.key) : h('b', {}, r.key),
    h('span', { class: 'detail' }, `${num(r.clicks)} клика · ${num(r.impressions)} импресии · CTR ${pct(r.ctr)} · позиция ${pos1(r.position)} `,
      noPrev ? null : r.prevPosition != null ? delta(r.position, r.prevPosition, { lowerIsBetter: true, fmt: pos1 }) : h('span', { class: 'up' }, '★ ново')))));
}

function gscList(all, kind, noPrev) {
  const PAGE = 30;
  const search = h('input', { type: 'search', id: 'g-q', placeholder: kind === 'заявка' ? 'Търси в заявките' : 'Търси в адресите' });
  const sort = h('select', { id: 'g-sort' }, [['clicks', 'Най-много кликове'], ['impressions', 'Най-много импресии'], ['position', 'Най-добра позиция'], ['up', 'Най-голямо покачване'], ['down', 'Най-голямо падане']].map(([v, t]) => h('option', { value: v }, t)));
  const list = h('div'); const more = h('button'); let items = [], shown = 0;
  const ch = (r) => (r.prevPosition == null ? 0 : r.prevPosition - r.position);
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    items = all.filter((r) => !q || r.key.toLowerCase().includes(q));
    const s = sort.value;
    items.sort(s === 'clicks' ? (a, b) => b.clicks - a.clicks || b.impressions - a.impressions : s === 'position' ? (a, b) => a.position - b.position : s === 'up' ? (a, b) => ch(b) - ch(a) : s === 'down' ? (a, b) => ch(a) - ch(b) : (a, b) => b[s] - a[s]);
    shown = 0; list.replaceChildren(); add(); say(`${items.length} резултата`);
  };
  const add = () => {
    list.append(gscItems(items.slice(shown, shown + PAGE), noPrev));
    shown = Math.min(items.length, shown + PAGE);
    more.textContent = `Покажи още (${num(items.length - shown)} остават)`;
    more.classList.toggle('hidden', shown >= items.length);
  };
  more.onclick = add;
  let t; search.oninput = () => { clearTimeout(t); t = setTimeout(draw, 250); };
  sort.onchange = draw; setTimeout(draw);
  return h('div', {},
    h('div', { class: 'row' }, h('div', {}, h('label', { for: 'g-q' }, 'Търсене'), search), h('div', {}, h('label', { for: 'g-sort' }, 'Подреди'), sort)),
    h('p', { class: 'muted', style: 'margin-top:1rem' }, `Общо ${num(all.length)}.`), list, h('div', { class: 'actions' }, more));
}

function gscChances(d) {
  return h('div', {},
    eyebrow('Почти там'), h('h2', { style: 'margin-top:.2rem' }, 'Заявки на 8–20 място'),
    h('div', { class: 'explain' }, h('p', {}, h('b', {}, 'Защо е важно: '), 'Хората рядко отиват на втора страница. Малко подобрение тук носи много кликове.'),
      h('p', {}, h('b', {}, 'Какво да направиш: '), 'Допълни страницата, която излиза за тази заявка, сложи думата в заглавието и H1, и добави вътрешни линкове към нея.')),
    d.nearly.length ? gscItems(d.nearly.slice(0, 50), d.noPrev) : h('p', { class: 'muted' }, 'Няма такива заявки за периода.'),
    eyebrow('Високо, но без кликове'), h('h2', { style: 'margin-top:.2rem' }, 'Нисък CTR на добри позиции'),
    h('div', { class: 'explain' }, h('p', {}, h('b', {}, 'Защо е важно: '), 'Сайтът е в топ 5, но хората не кликват. Заглавието или описанието в Google не привличат.'),
      h('p', {}, h('b', {}, 'Какво да направиш: '), 'Пренапиши title и meta description: конкретна полза, число, година, отговор на въпроса.')),
    d.lowCtr.length ? gscItems(d.lowCtr.slice(0, 50), d.noPrev) : h('p', { class: 'muted' }, 'Няма такива заявки за периода.'));
}

async function gscBacklinks(body, site) {
  const file = h('input', { type: 'file', id: 'g-file', accept: '.csv,.zip,text/csv,application/zip' });
  const msg = h('div', { role: 'status' });
  const importBtn = h('button', { class: 'primary', onclick: async () => {
    const f = file.files[0]; if (!f) return msg.replaceChildren(errorBox('Избери файл'));
    importBtn.disabled = true; importBtn.textContent = 'Чета файла…';
    try {
      const res = await fetch(`/api/gsc/links/import?site=${encodeURIComponent(site)}&name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await f.arrayBuffer() });
      const j = await res.json(); if (!res.ok) throw new Error(j.error);
      gscBacklinks(body, site);
    } catch (ex) { msg.replaceChildren(errorBox(ex.message)); importBtn.disabled = false; importBtn.textContent = 'Внеси'; }
  } }, 'Внеси');
  const howto = h('details', { class: 'card' }, h('summary', {}, h('div', { class: 'issue-head' }, h('h3', {}, 'Как да изтегля файла от Search Console?'), h('span', { class: 'chev' }))),
    h('ol', {},
      h('li', {}, 'Отвори ', h('a', { href: 'https://search.google.com/search-console/links', target: '_blank', rel: 'noopener noreferrer' }, 'Search Console → Връзки'), ' и избери същия сайт.'),
      h('li', {}, 'Горе вдясно натисни „Експортиране на външни връзки“.'),
      h('li', {}, 'Избери „Най-нови връзки“ (най-пълно) или „Още примерни връзки“.'),
      h('li', {}, 'Избери „Изтегляне на CSV“ и внеси получения файл (може и .zip) тук.')),
    h('p', { class: 'muted' }, 'Google не дава линковете през API, затова е нужна тази ръчна стъпка. Внасяй нов файл веднъж месечно, за да виждаш новите и изгубените линкове.'));
  const form = h('div', { class: 'card' }, h('label', { for: 'g-file', style: 'margin-top:0' }, 'Файл от Search Console (CSV или ZIP)'), file, msg, h('div', { class: 'actions' }, importBtn));
  body.replaceChildren(h('p', { class: 'muted' }, 'Зареждам…'));
  const { latest, history } = await api(`/gsc/links?site=${encodeURIComponent(site)}`);
  if (!latest) return body.replaceChildren(h('p', { class: 'lead' }, 'Още няма внесени линкове за този сайт.'), howto, form);
  let filter = 'all';
  const newSet = new Set(latest.newHosts);
  const list = h('div'); const more = h('button'); let items = [], shown = 0; const PAGE = 25;
  const draw = () => {
    items = filter === 'lost' ? latest.lostHosts.map((host) => ({ host, lost: true, pages: [], links: 0 }))
      : latest.domains.filter((d) => filter === 'all' || newSet.has(d.host));
    shown = 0; list.replaceChildren(); add();
  };
  const add = () => {
    list.append(...items.slice(shown, shown + PAGE).map((d) => h('details', { class: 'card' },
      h('summary', {}, h('div', { class: 'issue-head' },
        d.lost ? h('span', { class: 'sev error' }, '✖ Изгубен') : newSet.has(d.host) ? h('span', { class: 'sev ok' }, '★ Нов') : null,
        h('h3', {}, d.host), d.links ? h('span', { class: 'count' }, num(d.links)) : null, d.pages.length ? h('span', { class: 'chev' }) : null)),
      d.lost ? h('p', { class: 'muted' }, 'Беше в предишния файл, но го няма в последния. Провери дали линкът е премахнат.') : null,
      d.pages.length ? h('ul', { class: 'items' }, d.pages.slice(0, 100).map((p) => h('li', {}, link(p.url), p.lastCrawled ? h('span', { class: 'detail' }, 'Последно обходена: ' + p.lastCrawled) : null))) : null)));
    shown = Math.min(items.length, shown + PAGE);
    more.textContent = `Покажи още (${num(items.length - shown)} остават)`;
    more.classList.toggle('hidden', shown >= items.length);
    if (!items.length) list.append(h('p', { class: 'muted' }, 'Няма такива.'));
  };
  more.onclick = add;
  const counts = { all: latest.domains.length, new: latest.newHosts.length, lost: latest.lostHosts.length };
  const pills = [['all', 'Всички'], ['new', '★ Нови'], ['lost', '✖ Изгубени']].map(([v, t]) => h('button', { 'aria-pressed': String(v === filter), 'data-f': v, onclick: () => { filter = v; pills.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.f === v))); draw(); } }, `${t} (${counts[v]})`));
  const tile = (n, lbl) => h('div', { class: 'tile' }, h('div', { class: 'num' }, n), h('div', { class: 'lbl' }, lbl));
  body.replaceChildren(
    h('p', { class: 'muted' }, `Последен внос: ${fmtDate(latest.at)} (${latest.files.join(', ')})${history.length > 1 ? ` · сравнено с ${fmtDate(history.at(-2).at)}` : ''}`),
    h('div', { class: 'tiles' }, tile(num(latest.domains.length), 'Сайтове с линк към теб'), tile(num(latest.pages), 'Страници с линк'), tile(num(counts.new), 'Нови сайтове'), tile(num(counts.lost), 'Изгубени сайтове')),
    history.length < 2 ? h('p', { class: 'muted' }, 'Новите и изгубените се виждат след втория внос.') : null,
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Покажи' }, pills),
    list, h('div', { class: 'actions' }, more),
    eyebrow('Обнови'), h('h2', { style: 'margin-top:.2rem' }, 'Внеси по-нов файл'), howto, form);
  draw();
}

// =====================================================================
// ЛИНК БИЛДИНГ
// =====================================================================
const ST = { new: 'Нов', good: 'Подходящ', contacted: 'Писано', replied: 'Отговорили', won: 'Получен линк', rejected: 'Отказ' };
const ST_CLASS = { new: 'notice', good: 'ok', contacted: 'warning', replied: 'warning', won: 'ok', rejected: 'error' };
const ST_ICON = { new: '•', good: '✔', contacted: '✉', replied: '↩', won: '★', rejected: '✖' };

async function outreachView(id, sub) {
  if (id === 'new') return campaignForm();
  if (id && sub === 'edit') return campaignForm(id);
  if (id) return campaignView(id);
  render(h('p', {}, 'Зареждам…'));
  const [settings, camps] = await Promise.all([api('/settings'), api('/outreach')]);
  const head = [eyebrow('Линкове', true), h('h1', {}, 'Линк билдинг'),
    h('p', { class: 'lead' }, 'Намира сайтове по твоята тема, които може да ти дадат линк (гост статии, каталози, блогове), и води списък с кого си писал и какво е станало.')];
  if (!settings.hasSerpapiKey) return render(...head, h('div', { class: 'notice-box' }, h('p', {}, 'Първо въведи своя SerpApi ключ.'), h('button', { class: 'primary', onclick: () => (location.hash = 'settings') }, 'Към Настройки')));
  render(...head,
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => (location.hash = 'outreach/new') }, '+ Нова кампания')),
    eyebrow('Кампании'), h('h2', { style: 'margin-top:.2rem' }, 'Твоите кампании'),
    ...(camps.length ? camps.map((c) => {
      const won = c.prospects.filter((p) => p.status === 'won').length;
      return h('div', { class: 'card' },
        h('div', { class: 'issue-head' }, h('h3', {}, c.name), won ? h('span', { class: 'sev ok' }, `★ ${won} получени линка`) : null),
        h('p', { class: 'muted' }, `${c.domain} · ${num(c.prospects.length)} сайта · теми: ${c.keywords.join(', ')}`),
        h('div', { class: 'actions' }, h('button', { onclick: () => (location.hash = 'outreach/' + c.id) }, 'Отвори')));
    }) : [h('p', { class: 'muted' }, 'Още няма кампании.')]));
}

async function campaignForm(id) {
  const [camps, fps] = await Promise.all([api('/outreach'), api('/outreach/footprints')]);
  const c = id ? camps.find((x) => x.id === id) : null;
  const f = (label, el, hint) => [h('label', { for: el.id }, label, hint ? h('span', { class: 'hint' }, hint) : null), el];
  const name = h('input', { type: 'text', id: 'o-name', value: c?.name || '', placeholder: 'например: Линкове за блога' });
  const domain = h('input', { type: 'text', id: 'o-domain', value: c?.domain || '', placeholder: 'example.bg' });
  const kws = h('textarea', { id: 'o-kws', style: 'min-height:6rem', placeholder: 'по една на ред, например:\nlinux\ndevops' }, (c?.keywords || []).join('\n'));
  const chosen = new Set(c?.footprints || ['guest_bg', 'resources', 'blogs']);
  const boxes = fps.map((fp) => {
    const cb = h('input', { type: 'checkbox', id: 'fp-' + fp.id, checked: chosen.has(fp.id), onchange: () => { cb.checked ? chosen.add(fp.id) : chosen.delete(fp.id); upd(); } });
    return h('label', { class: 'check', for: 'fp-' + fp.id }, cb, fp.label);
  });
  const sel = (id, opts, val) => h('select', { id }, opts.map(([v, t]) => h('option', { value: v, selected: v === val }, t)));
  const gl = sel('o-gl', COUNTRIES, c?.gl || 'bg');
  const hl = sel('o-hl', LANGS, c?.hl || 'bg');
  const cost = h('p', { class: 'notice-box' });
  const upd = () => {
    const n = kws.value.split('\n').filter((x) => x.trim()).length * chosen.size;
    cost.textContent = `Пълното търсене струва до ${num(n)} заявки в SerpApi (по 1 за всяка тема × вид сайт). Вече търсените комбинации не се плащат повторно.`;
  };
  kws.oninput = upd; upd();
  const err = h('div');
  render(
    h('button', { onclick: () => history.back() }, '← Назад'),
    h('div', {}, eyebrow('Линк билдинг', true)), h('h1', {}, c ? 'Промени кампанията' : 'Нова кампания'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault(); err.replaceChildren();
      try {
        const saved = await api('/outreach', { method: 'POST', body: { id: c?.id, name: name.value, domain: domain.value, keywords: kws.value.split('\n'), footprints: [...chosen], gl: gl.value, hl: hl.value } });
        location.hash = 'outreach/' + saved.id;
      } catch (ex) { err.replaceChildren(errorBox(ex.message)); }
    } },
      f('Име на кампанията', name),
      f('Твоят сайт', domain, 'Той се изключва от резултатите и към него се проверяват получените линкове'),
      f('Теми', kws, 'По една на ред. Една или две думи, за които искаш да те свързват.'),
      h('fieldset', { style: 'border:0;padding:0;margin:1.1rem 0 0' }, h('legend', { style: 'font-weight:700;margin-bottom:.4rem' }, 'Какви сайтове да търся'), ...boxes),
      h('div', { class: 'row' }, h('div', {}, f('Държава', gl)), h('div', {}, f('Език', hl))),
      cost, err,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Запази'),
        c ? h('button', { type: 'button', class: 'danger', onclick: async () => { if (confirm('Да изтрия ли кампанията и всички сайтове в нея?')) { await api('/outreach/' + c.id, { method: 'DELETE' }); location.hash = 'outreach'; } } }, 'Изтрий кампанията') : null)));
  (c ? kws : domain).focus();
}

async function campaignView(id, keepFilter) {
  render(h('p', {}, 'Зареждам…'));
  const c = (await api('/outreach')).find((x) => x.id === id);
  if (!c) return render(errorBox('Кампанията не е намерена'));
  let filter = keepFilter || 'all';
  const counts = { all: c.prospects.length };
  for (const p of c.prospects) counts[p.status] = (counts[p.status] || 0) + 1;
  const list = h('div');
  const more = h('button');
  const PAGE = 20; let items = [], shown = 0;
  const search = async () => {
    try {
      const { jobId } = await api(`/outreach/${id}/search`, { method: 'POST' });
      watchJob(jobId, { title: 'Търсене: ' + c.name, onDone: () => route() });
    } catch (ex) { list.prepend(errorBox(ex.message)); }
  };
  const draw = () => {
    items = c.prospects.filter((p) => filter === 'all' || p.status === filter)
      .sort((a, b) => b.found.length - a.found.length);
    shown = 0; list.replaceChildren(); addMore();
  };
  const addMore = () => {
    list.append(...items.slice(shown, shown + PAGE).map((p) => prospectCard(c, p, () => campaignView(id, filter))));
    shown = Math.min(items.length, shown + PAGE);
    more.textContent = `Покажи още (${num(items.length - shown)} остават)`;
    more.classList.toggle('hidden', shown >= items.length);
    if (!items.length) list.append(h('p', { class: 'muted' }, c.prospects.length ? 'Няма сайтове с този статус.' : 'Още няма намерени сайтове. Натисни „Търси сайтове“.'));
  };
  more.onclick = addMore;
  const pills = ['all', ...Object.keys(ST)].map((s) => h('button', { 'aria-pressed': String(s === filter), 'data-s': s,
    onclick: () => { filter = s; pills.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.s === s))); draw(); } },
    `${s === 'all' ? 'Всички' : ST_ICON[s] + ' ' + ST[s]} (${counts[s] || 0})`));
  const tile = (n, lbl) => h('div', { class: 'tile' }, h('div', { class: 'num' }, n), h('div', { class: 'lbl' }, lbl));
  render(
    h('button', { onclick: () => (location.hash = 'outreach') }, '← Всички кампании'),
    h('div', {}, eyebrow('Кампания за линкове', true)), h('h1', {}, c.name),
    h('p', { class: 'muted' }, `${c.domain} · теми: ${c.keywords.join(', ')}`),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onclick: search, disabled: !c.pending }, c.pending ? `Търси сайтове (${c.pending} заявки)` : 'Всичко е потърсено'),
      h('button', { onclick: () => (location.hash = `outreach/${id}/edit`) }, 'Теми и настройки'),
      c.prospects.length ? h('a', { class: 'btn', href: `/api/outreach/${id}/csv`, download: true }, 'CSV за Excel') : null),
    !c.pending && c.prospects.length ? h('p', { class: 'muted' }, 'За още сайтове добави нови теми или видове сайтове в „Теми и настройки“.') : null,
    h('div', { class: 'tiles' }, tile(num(counts.all), 'Намерени сайтове'), tile(num(counts.good || 0), 'Подходящи'), tile(num((counts.contacted || 0) + (counts.replied || 0)), 'В процес'), tile(num(counts.won || 0), 'Получени линкове')),
    h('div', { class: 'filters', role: 'group', 'aria-label': 'Покажи по статус' }, pills),
    list, h('div', { class: 'actions' }, more));
  draw();
}

function prospectCard(c, p, refresh) {
  const base = `/outreach/${c.id}/prospects/${p.id}`;
  const msg = h('div', { role: 'status' });
  const status = h('select', { id: 'st-' + p.id, onchange: async () => { await api(base, { method: 'POST', body: { status: status.value } }); p.status = status.value; badge.className = 'sev ' + ST_CLASS[p.status]; badge.textContent = ST_ICON[p.status] + ' ' + ST[p.status]; say('Статусът е сменен'); } },
    Object.entries(ST).map(([v, t]) => h('option', { value: v, selected: v === p.status }, t)));
  const contact = h('input', { type: 'text', id: 'ct-' + p.id, value: p.contact || '', placeholder: 'имейл, форма или име' });
  const linkUrl = h('input', { type: 'text', id: 'lu-' + p.id, value: p.linkUrl || '', placeholder: 'https://… страницата, където е твоят линк' });
  const notes = h('textarea', { id: 'nt-' + p.id, style: 'min-height:5rem' }, p.notes || '');
  const badge = h('span', { class: 'sev ' + ST_CLASS[p.status] }, ST_ICON[p.status] + ' ' + ST[p.status]);
  const busy = async (btn, label, fn) => { const t = btn.textContent; btn.disabled = true; btn.textContent = label; try { await fn(); } catch (ex) { msg.replaceChildren(errorBox(ex.message)); } finally { btn.disabled = false; btn.textContent = t; } };
  const saveBtn = h('button', { class: 'primary', onclick: () => busy(saveBtn, 'Записвам…', async () => {
    await api(base, { method: 'POST', body: { contact: contact.value, notes: notes.value, linkUrl: linkUrl.value } });
    msg.replaceChildren(h('p', { class: 'up' }, '✔ Записано'));
  }) }, 'Запази');
  const contactsBtn = h('button', { onclick: () => busy(contactsBtn, 'Търся…', async () => {
    const r = await api(base + '/contacts', { method: 'POST' });
    Object.assign(p, r); if (!contact.value && r.contact) contact.value = r.contact; drawContacts();
  }) }, 'Намери контакти');
  const verifyBtn = h('button', { onclick: () => busy(verifyBtn, 'Проверявам…', async () => {
    await api(base, { method: 'POST', body: { linkUrl: linkUrl.value } });
    const r = await api(base + '/verify', { method: 'POST' }); p.verify = r.verify; drawVerify();
  }) }, 'Провери линка');
  const delBtn = h('button', { class: 'danger', onclick: async () => { if (confirm(`Да премахна ли ${p.host}? Няма да се появява при следващи търсения.`)) { await api(base, { method: 'DELETE' }); refresh(); } } }, 'Премахни');
  const contactsBox = h('div'); const verifyBox = h('div');
  const drawContacts = () => {
    if (!p.contactChecked) return;
    contactsBox.replaceChildren(h('div', { class: 'explain' },
      h('p', {}, h('b', {}, 'Имейли: '), p.emails?.length ? p.emails.join(', ') : 'не са открити'),
      p.contactPages?.length ? h('p', {}, h('b', {}, 'Страници за контакт: '), ...p.contactPages.flatMap((u, i) => [i ? ' · ' : '', link(u)])) : null));
  };
  const drawVerify = () => {
    if (!p.verify) return;
    verifyBox.replaceChildren(h('p', { class: p.verify.ok ? (p.verify.follow ? 'up' : '') : 'down' }, (p.verify.ok ? '✔ ' : '✖ ') + p.verify.text, h('span', { class: 'detail' }, 'Проверено: ' + fmtDate(p.verify.at))));
  };
  drawContacts(); drawVerify();
  return h('details', { class: 'card' },
    h('summary', {},
      h('div', { class: 'issue-head' }, badge, h('h3', {}, p.host), h('span', { class: 'chev' })),
      h('p', { style: 'margin:.4rem 0 0' }, p.title),
      h('p', { class: 'muted', style: 'margin:.2rem 0 0;font-size:.9rem' }, 'Намерен чрез: ' + p.found.join(' · '))),
    p.snippet ? h('p', { class: 'muted' }, p.snippet) : null,
    h('p', {}, link(p.url)),
    h('div', { class: 'row' }, h('div', {}, h('label', { for: status.id }, 'Статус'), status), h('div', {}, h('label', { for: contact.id }, 'Контакт'), contact)),
    contactsBox,
    h('label', { for: linkUrl.id }, 'Страница с твоя линк', h('span', { class: 'hint' }, 'Когато получиш линк, постави адреса тук и натисни „Провери линка“.')), linkUrl,
    verifyBox,
    h('label', { for: notes.id }, 'Бележки'), notes,
    msg,
    h('div', { class: 'actions' }, saveBtn, contactsBtn, verifyBtn, delBtn));
}

async function settingsView() {
  const s = await api('/settings');
  const key = h('input', { type: 'password', id: 's-key', autocomplete: 'off', placeholder: s.hasSerpapiKey ? `Записан ключ, завършващ на ${s.keyHint}` : 'Постави ключа тук' });
  const msg = h('div');
  const acc = h('div');
  const loadAcc = async () => {
    acc.replaceChildren(h('p', { class: 'muted' }, 'Проверявам акаунта…'));
    try {
      const a = await api('/serpapi/account');
      acc.replaceChildren(h('div', { class: 'tiles' },
        h('div', { class: 'tile' }, h('div', { class: 'num' }, num(a.searchesLeft)), h('div', { class: 'lbl' }, 'Оставащи заявки')),
        a.plan ? h('div', { class: 'tile' }, h('div', { class: 'num', style: 'font-size:1.3rem' }, a.plan), h('div', { class: 'lbl' }, 'План')) : null,
        a.thisMonth != null ? h('div', { class: 'tile' }, h('div', { class: 'num' }, num(a.thisMonth)), h('div', { class: 'lbl' }, 'Използвани този месец')) : null));
    } catch (ex) { acc.replaceChildren(errorBox(ex.message)); }
  };
  render(eyebrow('Конфигурация', true), h('h1', {}, 'Настройки'),
    h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      if (!key.value.trim()) return;
      await api('/settings', { method: 'POST', body: { serpapiKey: key.value } });
      key.value = ''; msg.replaceChildren(h('p', { class: 'up', role: 'status' }, '✔ Ключът е записан.'));
      loadAcc();
    } },
      h('label', { for: 's-key' }, 'SerpApi ключ', h('span', { class: 'hint' }, 'Намира се на serpapi.com → Dashboard → API Key. Пази се само на този компютър, във файла data/settings.json.')),
      key, msg,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Запази ключа'))),
    acc,
    eyebrow('Автоматизация'), h('h2', { id: 'auto', style: 'margin-top:.2rem' }, 'Автоматични задачи'),
    autoBox);
  if (s.hasSerpapiKey) loadAcc();
  loadAuto();
}

const autoBox = h('div');
async function loadAuto() {
  autoBox.replaceChildren(h('p', { class: 'muted' }, 'Зареждам…'));
  let d;
  try { d = await api('/schedule'); } catch (ex) { return autoBox.replaceChildren(errorBox(ex.message)); }
  const ok = (el, text) => { el.replaceChildren(h('span', { class: 'up' }, '✔ ' + text)); setTimeout(() => el.replaceChildren(), 2500); };

  // стартиране с Windows
  const autoMsg = h('span', { role: 'status' });
  const auto = h('input', { type: 'checkbox', id: 's-autostart', checked: d.autostart, onchange: async () => {
    try { await api('/schedule/autostart', { method: 'POST', body: { enabled: auto.checked } }); ok(autoMsg, auto.checked ? 'Ще тръгва при влизане в Windows' : 'Изключено'); }
    catch (ex) { auto.checked = !auto.checked; autoMsg.replaceChildren(errorBox(ex.message)); }
  } });
  const startCard = d.container
    ? h('div', { class: 'card' },
      h('h3', {}, 'Работи в Docker'),
      h('p', { class: 'muted' }, 'Приложението тръгва само заедно с Docker, затова автоматичните проверки работят, докато контейнерът е пуснат. Спира се с „docker compose stop“.'))
    : h('div', { class: 'card' },
      h('label', { class: 'check', for: 's-autostart', style: 'margin-top:0' }, auto, 'Пускай приложението скрито при влизане в Windows'),
      h('p', { class: 'muted' }, 'Нужно е, за да работят автоматичните проверки. Отваряш го както досега, с иконата, „Старт Ясно SEO.bat“ или на адрес yasno.seo.localhost.'),
      autoMsg);

  // позиции
  const rankRows = d.ranks.map((p) => {
    const m = h('span', { role: 'status' });
    const s = h('select', { id: 'sr-' + p.id, onchange: async () => { try { await api('/schedule/rank/' + p.id, { method: 'POST', body: { schedule: s.value } }); ok(m, 'Записано'); } catch (ex) { m.replaceChildren(errorBox(ex.message)); } } },
      SCHEDULES.map(([v, t]) => h('option', { value: v, selected: v === p.schedule, disabled: v === 'daily' && p.source !== 'gsc' }, t)));
    return h('li', {}, h('label', { for: s.id, style: 'margin:0 0 .3rem' }, p.name, h('span', { class: 'hint' }, `${p.domain} · ${p.keywords} думи · ${p.source === 'gsc' ? 'Search Console, безплатно' : `SerpApi, до ${p.maxCost} заявки на проверка`}${p.lastRun ? ' · последно ' + fmtDate(p.lastRun) : ''}`)), s, m);
  });

  // одити
  const sched = new Map(d.audits.map((a) => [a.url, a]));
  const urls = [...new Set([...d.audits.map((a) => a.url), ...d.auditSites])];
  const auditRows = urls.map((u, i) => {
    const m = h('span', { role: 'status' });
    const cur = sched.get(u);
    const s = h('select', { id: 'sa-' + i, onchange: async () => { await api('/schedule/audit', { method: 'POST', body: { url: u, every: s.value, maxPages: cur?.maxPages || 200 } }); ok(m, 'Записано'); } },
      [['off', 'Само ръчно'], ['weekly', 'Всяка седмица'], ['monthly', 'Всеки месец']].map(([v, t]) => h('option', { value: v, selected: v === (cur?.every || 'off') }, t)));
    return h('li', {}, h('label', { for: s.id, style: 'margin:0 0 .3rem' }, new URL(u).hostname, h('span', { class: 'hint' }, cur?.lastRun ? 'последно ' + fmtDate(cur.lastRun) : 'до 200 страници')), s, m);
  });

  autoBox.replaceChildren(
    startCard,
    h('div', { class: 'card' }, h('h3', {}, 'Позиции в Google'),
      rankRows.length ? h('ul', { class: 'items' }, rankRows) : h('p', { class: 'muted' }, 'Няма проекти за позиции.'),
      h('p', { class: 'muted' }, 'Проверките през SerpApi се пропускат автоматично, ако след тях ще останат по-малко от 10 заявки.')),
    h('div', { class: 'card' }, h('h3', {}, 'Одит на сайт'),
      auditRows.length ? h('ul', { class: 'items' }, auditRows) : h('p', { class: 'muted' }, 'Направи поне един одит, за да можеш да го повтаряш автоматично.')),
    h('div', { class: 'card' }, h('h3', {}, 'Последни събития'),
      d.events.length ? h('ul', { class: 'items' }, d.events.slice(0, 20).map((e) => h('li', {}, h('span', { class: e.ok ? 'up' : 'down' }, e.ok ? '✔ ' : '✖ '), e.text, h('span', { class: 'detail' }, fmtDate(e.at)))))
        : h('p', { class: 'muted' }, 'Още няма автоматични проверки. Първите тръгват до 10 минути след пускане, но не преди 7 сутринта.')));
}

route();
