// Автоматични задачи: проверки на позициите и одити по график.
// Работи, докато приложението е пуснато; ако компютърът е бил изключен, наваксва при следващото пускане.
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import * as ranks from './ranks.js';

let DATA_DIR = 'data';
let ROOT = '.';
let runAudit = null;
let busy = false;
const DAYS = { daily: 1, weekly: 7, monthly: 30 };
const MORNING = 7;                 // не пускаме задачи преди 7 ч.
const SERP_RESERVE = 10;           // оставяме поне толкова заявки за ръчна работа
const retryAfter = new Map();      // id -> време, преди което не опитваме пак

const P = (n) => path.join(DATA_DIR, n);
const readJson = async (n, f) => { try { return JSON.parse(await readFile(P(n), 'utf8')); } catch { return f; } };
const writeJson = async (n, v) => { await mkdir(DATA_DIR, { recursive: true }); await writeFile(P(n), JSON.stringify(v, null, 2), 'utf8'); };

export async function log(ok, text) {
  const ev = await readJson('events.json', []);
  ev.unshift({ at: new Date().toISOString(), ok, text });
  await writeJson('events.json', ev.slice(0, 100));
}
export const events = () => readJson('events.json', []);

function due(last, every) {
  if (!DAYS[every]) return false;
  if (new Date().getHours() < MORNING) return false;
  if (!last) return true;
  return Date.now() - new Date(last).getTime() >= DAYS[every] * 864e5 - 3 * 3600e3; // 3 ч. толеранс, за да не „пълзи“ часът
}
const blocked = (id) => (retryAfter.get(id) || 0) > Date.now();
const block = (id, hours) => retryAfter.set(id, Date.now() + hours * 3600e3);

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // ---- позиции ----
    for (const p of await ranks.listProjects()) {
      if (!due(p.history.at(-1)?.at, p.schedule) || blocked(p.id)) continue;
      if (p.source !== 'gsc') {
        const cost = ranks.maxCost(p);
        const { serpapiKey } = await ranks.getSettings();
        let left;
        try { left = (await ranks.accountInfo(serpapiKey)).searchesLeft; }
        catch (e) { await log(false, `Позиции „${p.name}“: не мога да проверя SerpApi акаунта (${e.message}).`); block(p.id, 6); continue; }
        if (left - cost < SERP_RESERVE) {
          await log(false, `Позиции „${p.name}“: пропуснато. Проверката може да струва до ${cost} заявки, а в SerpApi остават ${left}. Ще опитам пак утре.`);
          block(p.id, 24); continue;
        }
      }
      try {
        const r = await ranks.runCheck(p.id);
        const found = Object.values(r.results).filter((x) => x.position).length;
        await log(true, `Позиции „${p.name}“: ${found} от ${p.keywords.length} думи са намерени${p.source === 'gsc' ? ' (Search Console, безплатно)' : `, изхарчени ${r.searches} заявки`}.`);
      } catch (e) { await log(false, `Позиции „${p.name}“: ${e.message}`); block(p.id, 6); }
    }
    // ---- одити ----
    const cfg = await readJson('schedule.json', { audits: [] });
    for (const a of cfg.audits) {
      if (!due(a.lastRun, a.every) || blocked(a.url)) continue;
      try {
        const rep = await runAudit(a.url, a.maxPages);
        a.lastRun = new Date().toISOString();
        await log(true, `Одит ${new URL(rep.site.startUrl).hostname}: здраве ${rep.summary.health}%, ${rep.summary.errors} грешки, ${rep.summary.warnings} предупреждения.`);
      } catch (e) { await log(false, `Одит ${a.url}: ${e.message}`); block(a.url, 6); }
      await writeJson('schedule.json', cfg);
    }
  } catch (e) {
    console.error('Грешка в планировчика:', e);
  } finally { busy = false; }
}

export function start({ dataDir, root, audit }) {
  DATA_DIR = dataDir; ROOT = root; runAudit = audit;
  setTimeout(tick, 60 * 1000);           // минута след пускане
  setInterval(tick, 10 * 60 * 1000);     // после на всеки 10 минути
}

// ---------- настройки на одитите ----------
export const auditSchedules = async () => (await readJson('schedule.json', { audits: [] })).audits;
export async function setAuditSchedule(url, every, maxPages = 200) {
  const cfg = await readJson('schedule.json', { audits: [] });
  const key = url.trim();
  const ex = cfg.audits.find((a) => a.url === key);
  if (every === 'off') cfg.audits = cfg.audits.filter((a) => a.url !== key);
  else if (ex) Object.assign(ex, { every, maxPages });
  else cfg.audits.push({ url: key, every, maxPages, lastRun: null });
  await writeJson('schedule.json', cfg);
}

// ---------- стартиране с Windows ----------
const startupFile = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'YasnoSEO.vbs');
export async function autostartEnabled() { try { await access(startupFile()); return true; } catch { return false; } }
export async function setAutostart(enabled) {
  if (process.platform !== 'win32') throw new Error('Работи само под Windows');
  if (!enabled) { await rm(startupFile(), { force: true }); return; }
  const q = (s) => s.replace(/"/g, '""');
  // Скрит прозорец; изходът отива в data\server.log
  const cmd = `cmd /c ""${process.execPath}" server.js >> data\\server.log 2>&1"`;
  const vbs = [
    "' Yasno SEO: starts the local app hidden at Windows sign-in.",
    "' Delete this file (or turn it off in the app settings) to stop.",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.CurrentDirectory = "${q(ROOT)}"`,
    `sh.Run "${q(cmd)}", 0, False`,
  ].join('\r\n') + '\r\n';
  if (/[^\x20-\x7e\r\n]/.test(vbs)) throw new Error('Пътят до приложението съдържа символи, които стартовият файл не поддържа');
  await writeFile(startupFile(), vbs, 'latin1');
}
export const runDueNow = tick; // за ръчно пускане и тестове
