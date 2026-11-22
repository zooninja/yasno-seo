// Превръща събраните данни в списък от проблеми с обяснение и съвет.
// severity: 'error' (грешка), 'warning' (предупреждение), 'notice' (съвет)

const statusText = (s, err) => (err ? `Грешка: ${err}` : s === 0 ? 'Няма отговор' : `Код ${s}`);
const isBroken = (s) => s === 0 || s === 404 || s === 410 || s >= 500;
const fromText = (arr) => (arr?.length ? `Линк от: ${arr.slice(0, 3).join(', ')}${arr.length > 3 ? ` и още ${arr.length - 3}` : ''}` : '');

export function analyze(data) {
  const { site, pages, externals, images, blockedByRobots } = data;
  const html = pages.filter((p) => p.isHtml && p.status === 200 && !p.chain.length);
  const indexable = html.filter((p) => !p.noindex && (!p.canonical || p.canonical === p.url));
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const issues = [];
  const add = (code, severity, title, why, fix, items) => {
    if (items.length) issues.push({ code, severity, title, why, fix, count: items.length, items });
  };

  // ---------- ГРЕШКИ ----------
  add('broken_internal', 'error', 'Счупени вътрешни страници',
    'Посетителите и Google попадат на страница, която не съществува или не работи. Това губи посетители и хаби обхождането.',
    'Поправи или премахни линковете към тези адреси. Ако страницата е преместена, направи пренасочване 301 към новия адрес.',
    pages.filter((p) => isBroken(p.status) || p.error).map((p) => ({ url: p.url, detail: `${statusText(p.status, p.error)}. ${fromText(p.linkedFrom)}` })));

  add('broken_external', 'error', 'Счупени външни линкове',
    'Линкове към други сайтове, които вече не работят. Влошават доверието и опита на посетителя.',
    'Смени линка с работещ адрес или го премахни.',
    Object.entries(externals).filter(([, r]) => r.status !== undefined && isBroken(r.status))
      .map(([u, r]) => ({ url: u, detail: `${statusText(r.status, r.error)}. ${fromText(r.from)}` })));

  add('broken_images', 'error', 'Счупени изображения',
    'Картинки, които не се зареждат. Страницата изглежда счупена.',
    'Качи отново картинката или поправи адреса ѝ.',
    Object.entries(images).filter(([, r]) => r.status !== undefined && isBroken(r.status))
      .map(([u, r]) => ({ url: u, detail: `${statusText(r.status, r.error)}. ${fromText(r.from)}` })));

  add('missing_title', 'error', 'Страници без заглавие (title)',
    'Заглавието е текстът, който Google показва като линк в резултатите. Без него Google си измисля заглавие.',
    'Добави уникален <title> с 30–60 знака, който описва страницата.',
    html.filter((p) => !p.title).map((p) => ({ url: p.url, detail: 'Няма title' })));

  if (site.startUrl.startsWith('http:')) {
    add('no_https', 'error', 'Сайтът не използва HTTPS',
      'Браузърите показват „Не е защитено“, а Google предпочита сигурните сайтове.',
      'Инсталирай SSL сертификат (често безплатно от хостинга) и пренасочи всички http адреси към https.',
      [{ url: site.startUrl, detail: 'Адресът започва с http://' }]);
  }

  // ---------- ПРЕДУПРЕЖДЕНИЯ ----------
  const dup = (key) => {
    const m = new Map();
    for (const p of indexable) { const v = p[key]; if (v) { if (!m.has(v)) m.set(v, []); m.get(v).push(p.url); } }
    return [...m.entries()].filter(([, u]) => u.length > 1);
  };
  add('duplicate_title', 'warning', 'Еднакви заглавия на различни страници',
    'Google не разбира коя страница да покаже и те се конкурират помежду си.',
    'Направи заглавието на всяка страница уникално.',
    dup('title').flatMap(([t, urls]) => urls.map((u) => ({ url: u, detail: `„${t}“ се повтаря на ${urls.length} страници` }))));

  add('missing_desc', 'warning', 'Страници без мета описание',
    'Описанието е текстът под линка в Google. Без него Google взима случаен откъс и по-малко хора кликват.',
    'Добави <meta name="description"> с 70–160 знака, което кани към кликване.',
    indexable.filter((p) => !p.metaDesc).map((p) => ({ url: p.url, detail: 'Няма описание' })));

  add('duplicate_desc', 'warning', 'Еднакви мета описания',
    'Еднаквите описания не помагат на хората да изберат правилната страница.',
    'Напиши отделно описание за всяка страница.',
    dup('metaDesc').flatMap(([t, urls]) => urls.map((u) => ({ url: u, detail: `Повтаря се на ${urls.length} страници: „${t.slice(0, 80)}…“` }))));

  add('title_long', 'warning', 'Твърде дълги заглавия',
    'Google съкращава заглавия над около 60 знака и края не се вижда.',
    'Съкрати до 60 знака и сложи важното в началото.',
    html.filter((p) => p.title && p.title.length > 60).map((p) => ({ url: p.url, detail: `${p.title.length} знака: „${p.title}“` })));

  add('missing_h1', 'warning', 'Страници без главно заглавие (H1)',
    'H1 казва на хората и на Google за какво е страницата.',
    'Добави един видим заглавен ред <h1> в началото на съдържанието.',
    html.filter((p) => !p.h1?.length).map((p) => ({ url: p.url, detail: 'Няма H1' })));

  add('redirect_chain', 'warning', 'Вериги от пренасочвания',
    'Няколко пренасочвания едно след друго забавят зареждането и губят част от силата на линковете.',
    'Насочи първия адрес директно към крайния.',
    pages.filter((p) => p.chain.length > 1).map((p) => ({ url: p.url, detail: `${p.chain.length} пренасочвания → ${p.finalUrl}` })));

  const linksToRedirect = pages.filter((p) => p.chain.length && p.inlinks > 0);
  add('links_to_redirect', 'warning', 'Вътрешни линкове към пренасочени адреси',
    'Твоите собствени линкове минават през пренасочване. Това е излишно забавяне.',
    'Смени линковете да сочат директно към крайния адрес.',
    linksToRedirect.map((p) => ({ url: p.url, detail: `Пренасочва към ${p.finalUrl}. ${fromText(p.linkedFrom)}` })));

  add('img_no_alt', 'warning', 'Изображения без alt текст',
    'Alt текстът описва картинката за незрящи хора и за Google Картинки.',
    'Добави кратко описание alt="..." на всяка смислена картинка. За чисто декоративни сложи alt="".',
    html.filter((p) => p.imagesNoAlt?.length).map((p) => ({ url: p.url, detail: `${p.imagesNoAlt.length} от ${p.imagesTotal} картинки нямат alt` })));

  add('slow', 'warning', 'Бавни страници',
    'Сървърът отговаря бавно (над 1,5 секунди). Хората си тръгват, а Google го отчита.',
    'Включи кеширане, провери хостинга и тежките добавки (плъгини).',
    html.filter((p) => p.ms > 1500).sort((a, b) => b.ms - a.ms).map((p) => ({ url: p.url, detail: `${(p.ms / 1000).toFixed(1)} сек.` })));

  add('heavy_images', 'warning', 'Тежки изображения (над 300 KB)',
    'Големите картинки забавят зареждането, особено на телефон.',
    'Намали размера и ги запиши като WebP или AVIF.',
    Object.entries(images).filter(([, r]) => r.size > 300 * 1024).sort((a, b) => b[1].size - a[1].size)
      .map(([u, r]) => ({ url: u, detail: `${Math.round(r.size / 1024)} KB. ${fromText(r.from)}` })));

  add('mixed_content', 'warning', 'Несигурно съдържание на защитени страници',
    'HTTPS страница зарежда файлове през http://. Браузърът може да ги блокира.',
    'Смени адресите на тези файлове с https://.',
    html.filter((p) => p.insecure?.length).map((p) => ({ url: p.url, detail: `${p.insecure.length} файла: ${p.insecure.slice(0, 2).join(', ')}` })));

  add('no_viewport', 'warning', 'Няма настройка за мобилни (viewport)',
    'Без нея страницата се показва смалена на телефон.',
    'Добави <meta name="viewport" content="width=device-width, initial-scale=1">.',
    html.filter((p) => !p.viewport).map((p) => ({ url: p.url, detail: 'Няма viewport' })));

  const smBad = site.sitemapUrls.map((u) => byUrl.get(u)).filter((p) => p && (p.status !== 200 || p.chain.length || p.noindex));
  add('sitemap_bad', 'warning', 'Sitemap съдържа неподходящи адреси',
    'Картата на сайта трябва да съдържа само работещи страници, които искаш в Google.',
    'Премахни от sitemap счупените, пренасочените и noindex страниците.',
    smBad.map((p) => ({ url: p.url, detail: p.noindex ? 'Има noindex' : p.chain.length ? `Пренасочва към ${p.finalUrl}` : statusText(p.status, p.error) })));

  if (!site.sitemapFound) {
    add('no_sitemap', 'warning', 'Няма карта на сайта (sitemap.xml)',
      'Картата помага на Google да намери всички страници.',
      'Създай sitemap.xml (повечето CMS го правят с добавка), посочи го в robots.txt и в Search Console.',
      [{ url: site.origin + '/sitemap.xml', detail: 'Не е намерена' }]);
  }

  // ---------- СЪВЕТИ ----------
  add('unverified_external', 'notice', 'Външни линкове, които не можаха да се проверят',
    'Сайтът не отговори навреме или отказва автоматични проверки. Вероятно работят, но не е сигурно.',
    'Отвори няколко от тях ръчно в браузъра.',
    Object.entries(externals).filter(([, r]) => r.status === -1 || r.status === 401 || r.status === 403 || r.status === 429)
      .map(([u, r]) => ({ url: u, detail: `${r.status === -1 ? r.error : 'Код ' + r.status + ' (отказан достъп за роботи)'}. ${fromText(r.from)}` })));

  add('title_short', 'notice', 'Много кратки заглавия',
    'Под 30 знака заглавието често не казва достатъчно.',
    'Допълни с ключова дума и полза за читателя.',
    html.filter((p) => p.title && p.title.length < 30).map((p) => ({ url: p.url, detail: `${p.title.length} знака: „${p.title}“` })));

  add('desc_length', 'notice', 'Мета описания с неподходяща дължина',
    'Под 70 знака не се използва мястото, над 160 Google съкращава.',
    'Целта е 70–160 знака.',
    indexable.filter((p) => p.metaDesc && (p.metaDesc.length < 70 || p.metaDesc.length > 160))
      .map((p) => ({ url: p.url, detail: `${p.metaDesc.length} знака` })));

  add('multi_h1', 'notice', 'Повече от едно H1',
    'Не е грешка, но едно главно заглавие е по-ясно.',
    'Остави едно H1, другите направи H2.',
    html.filter((p) => p.h1?.length > 1).map((p) => ({ url: p.url, detail: `${p.h1.length} H1: ${p.h1.slice(0, 3).map((h) => `„${h.slice(0, 40)}“`).join(', ')}` })));

  add('thin', 'notice', 'Малко текст на страницата',
    'Под 200 думи често е трудно да се отговори пълно на въпроса на търсещия.',
    'Добави полезно съдържание или обедини сходни страници.',
    indexable.filter((p) => p.wordCount < 200).map((p) => ({ url: p.url, detail: `${p.wordCount} думи` })));

  add('noindex', 'notice', 'Страници, скрити от Google (noindex)',
    'Тези страници няма да се появят в Google. Провери дали е нарочно.',
    'Ако трябва да се показват, премахни noindex.',
    html.filter((p) => p.noindex).map((p) => ({ url: p.url, detail: `robots: ${[p.robotsMeta, p.xRobots].filter(Boolean).join(' / ')}` })));

  add('canonical_other', 'notice', 'Canonical сочи към друг адрес',
    'Страницата казва на Google „истинската версия е другаде“. Само тя ще се показва.',
    'Провери дали посоченият адрес е правилният.',
    html.filter((p) => p.canonical && p.canonical !== p.url).map((p) => {
      const t = byUrl.get(p.canonical);
      return { url: p.url, detail: `→ ${p.canonical}${t && t.status !== 200 ? ` (той връща ${statusText(t.status, t.error)})` : ''}` };
    }));

  add('no_lang', 'notice', 'Не е посочен езикът на страницата',
    'Атрибутът lang помага на четците за екран и на Google.',
    'Добави <html lang="bg"> (или съответния език).',
    html.filter((p) => !p.lang).map((p) => ({ url: p.url, detail: 'Няма lang' })));

  add('deep', 'notice', 'Дълбоко скрити страници',
    'Нужни са повече от 3 клика от началната страница, за да се стигне до тях.',
    'Добави линкове от менюто, категориите или свързани статии.',
    html.filter((p) => p.depth > 3).map((p) => ({ url: p.url, detail: `${p.depth} клика` })));

  add('orphan', 'notice', 'Страници без вътрешни линкове към тях',
    'Намерени са само в sitemap. Без линкове Google ги смята за маловажни.',
    'Добави линкове към тях от подходящи страници.',
    html.filter((p) => p.inSitemap && p.inlinks === 0 && p.url !== site.startUrl).map((p) => ({ url: p.url, detail: 'Само в sitemap' })));

  add('not_in_sitemap', 'notice', 'Страници, които липсват в sitemap',
    'Работещи страници за Google, но не са в картата на сайта.',
    'Добави ги в sitemap.xml.',
    site.sitemapFound ? indexable.filter((p) => !p.inSitemap).map((p) => ({ url: p.url, detail: 'Не е в sitemap' })) : []);

  add('temp_redirect', 'notice', 'Временни пренасочвания (302/307)',
    'Временното пренасочване казва на Google да пази стария адрес.',
    'Ако преместването е завинаги, смени го на 301.',
    pages.filter((p) => p.chain.some((c) => c.status === 302 || c.status === 307)).map((p) => ({ url: p.url, detail: `→ ${p.finalUrl}` })));

  add('blocked_robots', 'notice', 'Адреси, блокирани в robots.txt',
    'Тези адреси не са обходени, защото robots.txt ги забранява. Провери дали е нарочно.',
    'Ако трябва да са в Google, махни забраната от robots.txt.',
    blockedByRobots.map((u) => ({ url: u, detail: 'Забранен в robots.txt' })));

  if (site.robots && !site.robots.found) {
    add('no_robots', 'notice', 'Няма файл robots.txt',
      'Не е задължителен, но е мястото, където се посочва sitemap.',
      'Създай robots.txt с ред „Sitemap: https://твоя-сайт/sitemap.xml“.',
      [{ url: site.origin + '/robots.txt', detail: statusText(site.robots.status ?? 0, site.robots.error) }]);
  }

  // ---------- обобщение ----------
  const order = { error: 0, warning: 1, notice: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  const errorUrls = new Set(issues.filter((i) => i.severity === 'error').flatMap((i) => i.items.map((x) => x.url)));
  const health = html.length ? Math.round((html.filter((p) => !errorUrls.has(p.url)).length / html.length) * 100) : 0;
  return {
    summary: {
      health,
      pagesCrawled: pages.length,
      htmlPages: html.length,
      indexable: indexable.length,
      errors: issues.filter((i) => i.severity === 'error').reduce((s, i) => s + i.count, 0),
      warnings: issues.filter((i) => i.severity === 'warning').reduce((s, i) => s + i.count, 0),
      notices: issues.filter((i) => i.severity === 'notice').reduce((s, i) => s + i.count, 0),
      externalsChecked: Object.keys(externals).length, externalsTotal: data.externalsTotal,
      imagesChecked: Object.keys(images).length, imagesTotal: data.imagesTotal,
      avgMs: html.length ? Math.round(html.reduce((s, p) => s + (p.ms || 0), 0) / html.length) : null,
    },
    issues,
  };
}
