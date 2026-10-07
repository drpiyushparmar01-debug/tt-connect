// AlgoLens server: website, settings/alerts API, live refresh + alerts, and the daily history sync.
// No third-party packages (Node 22+).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv, COOKIE_FILE, readCookie, DATA_DIR } from './env.js';
import { sync, liveSync, historySync } from './collector.js';
import { enrich, history, updateState, readIntraday, istParts, toMin } from './enrich.js';
import { withDefaults, runAlerts, dispatch, pnlMessage, eventMessage, sendTo, telegramInfo } from './alerts.js';

loadEnv();
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = DATA_DIR;
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SYNC_TIME = process.env.SYNC_TIME || '23:45'; // IST: daily full-history refresh
const LIVE_HOURS = process.env.LIVE_HOURS || '09:00-23:45'; // IST window for live refresh (NSE + MCX evening)
const LIVE_WEEKENDS = process.env.LIVE_WEEKENDS === 'yes';
const SETTINGS = path.join(DATA, 'settings.json');

const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
async function writeJson(file, obj) { await fs.mkdir(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; await fs.writeFile(tmp, JSON.stringify(obj, null, 1)); await fs.rename(tmp, file); }
const loadSettings = async () => withDefaults(await readJson(SETTINGS, {}));
const liveInterval = (s) => Math.max(5, Number(s.liveIntervalMin || process.env.LIVE_INTERVAL_MIN || 15));

// ---------- data the pages need ----------
async function liveView() {
  const [live, settings, state] = await Promise.all([readJson(path.join(DATA, 'live.json'), { fetchedAt: null, items: [] }), loadSettings(), readJson(path.join(DATA, 'state.json'), { removed: {} })]);
  const items = enrich(live.items || [], await history(DATA), state, settings).filter((d) => !settings.hidden.includes(d.id));
  const liveIds = new Set((live.items || []).map((d) => d.id));
  const removed = Object.entries(state.removed || {}).filter(([id]) => !liveIds.has(+id)).map(([id, r]) => ({ id: +id, ...r, name: settings.names[id] || r.name }));
  return { fetchedAt: live.fetchedAt, intervalMin: liveInterval(settings), items, removed };
}
function publicSettings(s) {
  return { ...s, telegram: { hasToken: !!s.telegram.token, botName: s.telegram.botName } };
}

let pageCache = null;
async function renderSite() {
  if (pageCache) return pageCache;
  const [tpl, engineSrc, index, status, settings, live, intraday] = await Promise.all([
    fs.readFile(path.join(ROOT, 'web', 'app.template.html'), 'utf8'),
    fs.readFile(path.join(ROOT, 'web', 'analytics.js'), 'utf8'),
    readJson(path.join(DATA, 'index.json'), []),
    readJson(path.join(DATA, 'sync-status.json'), {}),
    loadSettings(), liveView(), readIntraday(DATA),
  ]);
  const meta = [], eq = {};
  for (const m of index) {
    if (settings.hidden.includes(m.id)) continue;
    const f = await readJson(path.join(DATA, 'strategies', `${m.id}.json`), null);
    if (!f || !f.equity.length) continue;
    meta.push({ ...m, name: settings.names[m.id] || m.name, shareCode: f.shareCode });
    eq[m.id] = f.equity;
  }
  const synced = meta.length ? meta.map((m) => eq[m.id].at(-1)[0]).sort().at(-1) : '';
  const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c'); // safe inside <script>
  const cfg = { server: true, settings: publicSettings(settings), liveHours: LIVE_HOURS, syncTime: SYNC_TIME, cookieSaved: !!readCookie(), catalog: await catalog(index) };
  pageCache = tpl
    .replace('/*ENGINE*/', () => engineSrc)
    .replace('/*META*/', () => json(meta))
    .replace('/*EQ*/', () => json(eq))
    .replace('/*SYNCED*/', () => synced)
    .replace('/*LIVE*/', () => json(live))
    .replace('/*INTRADAY*/', () => json(intraday))
    .replace('/*CONFIG*/', () => json(cfg))
    .replace('/*SYNC*/', () => json(syncSummary(status)));
  return pageCache;
}
async function catalog(index) { // every strategy, including hidden and brand-new ones
  const live = await readJson(path.join(DATA, 'live.json'), { items: [] });
  const map = new Map(index.map((m) => [m.id, { id: m.id, name: m.name, creator: m.creator, source: m.source || 'shared', ex: m.ex }]));
  for (const d of live.items || []) map.set(d.id, { id: d.id, name: d.name, creator: d.creator, source: d.source, ex: d.ex });
  return [...map.values()];
}
const syncSummary = (st) => ({ ok: st.ok, authExpired: st.authExpired, error: st.ok ? null : st.error, finishedAt: st.finishedAt, failed: st.history?.failed || [], live: st.live?.finishedAt || null, history: st.history?.finishedAt || null, historyCount: st.history?.count || 0 });

// ---------- sync runners ----------
let running = null;
const exclusive = (fn) => { if (running) return running; running = fn().finally(() => { running = null; pageCache = null; }); return running; };
const runSync = () => exclusive(async () => {
  const s = await sync({ cookie: readCookie(), log: () => {} });
  const st = await readJson(path.join(DATA, 'sync-status.json'), {});
  await afterLive(st.live || s);
  return s;
});

async function afterLive(liveStatus) {
  const settings = await loadSettings();
  const alertState = path.join(DATA, 'alert-state.json');
  if (liveStatus && !liveStatus.ok) {
    // tell the user once that the Tradetron session expired
    const st = await readJson(alertState, {});
    if (liveStatus.authExpired && !st.sessionAlerted) {
      await dispatch(DATA, settings, 'error', () => eventMessage({ kind: 'session' }, settings));
      await writeJson(alertState, { ...st, sessionAlerted: true });
    }
    return;
  }
  const live = await readJson(path.join(DATA, 'live.json'), { items: [] });
  const state0 = await readJson(path.join(DATA, 'state.json'), {});
  const enriched = enrich(live.items, await history(DATA), state0, settings);
  const { events, day } = await updateState(DATA, enriched);
  const st = await readJson(alertState, {}); if (st.sessionAlerted) await writeJson(alertState, { ...st, sessionAlerted: false });
  await runAlerts(DATA, settings, enriched, events, day).catch((e) => console.error('Alerts failed:', e.message));
}

const runLive = () => exclusive(async () => {
  const { status, items } = await liveSync({ cookie: readCookie(), log: () => {} });
  if (status.ok) {
    // fetch history right away for strategies added since the last history sync
    const index = await readJson(path.join(DATA, 'index.json'), []);
    const known = new Set(index.map((m) => m.id));
    const hist = await readJson(path.join(DATA, 'sync-status.json'), {});
    const tried = new Set((hist.history?.failed || []).map((f) => f.id)); // brand-new deployments with no history yet: retried nightly
    const todo = items.filter((d) => !known.has(d.id) && !tried.has(d.id)).map((d) => d.id);
    if (todo.length) await historySync({ cookie: readCookie(), items, onlyIds: todo, log: () => {} });
  }
  await afterLive(status);
  return status;
});

function inLiveWindow(now = new Date()) {
  const p = istParts(now);
  if (!LIVE_WEEKENDS && (p.day === 0 || p.day === 6)) return false;
  const [a, b] = LIVE_HOURS.split('-').map(toMin);
  return p.min >= a && p.min <= b;
}
// Live refreshes run on the clock (e.g. :00 :15 :30 :45) so alerts and the intraday chart line up neatly
async function scheduleLive() {
  const mins = liveInterval(await loadSettings());
  const now = Date.now(), step = mins * 60e3;
  const next = Math.ceil((now + 1000) / step) * step;
  setTimeout(async () => { if (inLiveWindow()) await runLive().catch((e) => console.error(e)); scheduleLive(); }, next - now);
}
function scheduleNightly() {
  const [hh, mm] = SYNC_TIME.split(':').map(Number);
  const now = new Date(), ist = new Date(now.getTime() + 5.5 * 3600e3);
  const next = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hh, mm) - 5.5 * 3600e3);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(async () => { await runSync().catch((e) => console.error(e)); scheduleNightly(); }, next - now);
}

// ---------- access: changes are allowed from this computer, or with the admin password ----------
function canWrite(req) {
  const ip = req.socket.remoteAddress || '';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return true;
  if (!ADMIN_PASSWORD) return false;
  const b64 = (req.headers.authorization || '').split(' ')[1];
  const pass = b64 ? Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':') : '';
  const a = Buffer.from(pass), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 2e6) throw new Error('Too large'); } return s ? JSON.parse(s) : {}; }
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

// Only these settings can be changed from the page; values are checked before saving
function mergeSettings(cur, patch) {
  const out = structuredClone(cur);
  if (patch.names) for (const [k, v] of Object.entries(patch.names)) { const n = String(v || '').trim().slice(0, 60); if (n) out.names[k] = n; else delete out.names[k]; }
  if (patch.hidden) out.hidden = patch.hidden.map(Number).filter(Boolean);
  if (patch.styleOverride) for (const [k, v] of Object.entries(patch.styleOverride)) { if (v === 'Intraday' || v === 'Positional') out.styleOverride[k] = v; else delete out.styleOverride[k]; }
  if (patch.perStrategy) for (const [k, v] of Object.entries(patch.perStrategy)) out.perStrategy[k] = { ...(out.perStrategy[k] || {}), ...(typeof v.error === 'boolean' ? { error: v.error } : {}), ...(typeof v.pnl === 'boolean' ? { pnl: v.pnl } : {}) };
  if (patch.liveIntervalMin) out.liveIntervalMin = [5, 10, 15, 30].includes(+patch.liveIntervalMin) ? +patch.liveIntervalMin : 15;
  if (patch.alerts) {
    const a = patch.alerts, o = out.alerts;
    for (const k of ['enabled', 'mcx', 'oneX', 'dayHL', 'useAlias', 'eod', 'errors']) if (typeof a[k] === 'boolean') o[k] = a[k];
    if (a.intervalMin) o.intervalMin = Math.max(15, Math.round(+a.intervalMin / 15) * 15);
    if (a.format) o.format = a.format === 'sleek' ? 'sleek' : 'detailed';
    if (a.sort) o.sort = ['pnl', 'name', 'order'].includes(a.sort) ? a.sort : 'pnl';
    if (typeof a.header === 'string') o.header = a.header.trim().slice(0, 40);
    for (const k of ['eodTime', 'mcxEodTime']) if (/^\d{2}:\d{2}$/.test(a[k] || '')) o[k] = a[k];
    if (Array.isArray(a.footer)) o.footer = a.footer.slice(0, 3).map((l) => ({ label: String(l.label || '').slice(0, 30), url: String(l.url || '').slice(0, 300) })).filter((l) => l.label && /^https?:\/\//.test(l.url));
  }
  if (Array.isArray(patch.channels)) out.channels = patch.channels.slice(0, 10).map((c) => ({
    id: String(c.id || crypto.randomUUID()), type: c.type === 'discord' ? 'discord' : 'telegram', name: String(c.name || 'Channel').slice(0, 40),
    chatId: String(c.chatId || '').trim(), webhook: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(c.webhook || '') ? c.webhook : '',
    preset: ['all', 'errors', 'pnl'].includes(c.preset) ? c.preset : 'all', scope: Array.isArray(c.scope) ? c.scope.map(Number) : 'all', enabled: c.enabled !== false,
  }));
  return out;
}

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/' && req.method === 'GET') {
      const html = await renderSite();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + html + '</body></html>');
    }
    if (p === '/health') { res.writeHead(200); return res.end('ok'); }
    if (p === '/admin') { // remote access: sign in once, then use the Settings page
      if (!canWrite(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="AlgoLens"' }); return res.end(ADMIN_PASSWORD ? 'Sign in required' : 'Set ADMIN_PASSWORD in .env to allow changes from other devices.'); }
      res.writeHead(302, { Location: '/#settings' }); return res.end();
    }
    if (p === '/api/live' && req.method === 'GET') {
      const [live, intraday, st] = await Promise.all([liveView(), readIntraday(DATA), readJson(path.join(DATA, 'sync-status.json'), {})]);
      return send(res, 200, { live, intraday, sync: syncSummary(st) });
    }
    if (p === '/api/intraday' && req.method === 'GET') return send(res, 200, await readIntraday(DATA, url.searchParams.get('date') || undefined));
    if (p === '/api/alerts/history' && req.method === 'GET') return send(res, 200, await readJson(path.join(DATA, 'alert-history.json'), []));
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, publicSettings(await loadSettings()));

    if (p.startsWith('/api/') && req.method === 'POST') {
      if (!canWrite(req)) return send(res, 403, { error: 'Changes are only allowed from the computer running AlgoLens, or after signing in at /admin.' });
      const b = await body(req);
      const settings = await loadSettings();
      if (p === '/api/settings') {
        const next = mergeSettings(settings, b);
        await writeJson(SETTINGS, next); pageCache = null;
        return send(res, 200, publicSettings(next));
      }
      if (p === '/api/sync') { runSync(); return send(res, 202, { message: 'Sync started. This takes about a minute.' }); }
      if (p === '/api/refresh') { await runLive(); return send(res, 200, { message: 'Live data refreshed.' }); }
      if (p === '/api/session') {
        const c = String(b.cookie || '').replace(/^cookie:\s*/i, '').trim();
        if (c.length < 20) return send(res, 400, { error: 'That does not look like a Tradetron cookie. Copy the whole value.' });
        await fs.mkdir(DATA, { recursive: true }); await fs.writeFile(COOKIE_FILE, c, { mode: 0o600 });
        runSync(); return send(res, 200, { message: 'Session saved. A full sync has started.' });
      }
      if (p === '/api/telegram/token') {
        const token = String(b.token || '').trim();
        if (!/^\d+:[\w-]{30,}$/.test(token)) return send(res, 400, { error: 'That is not a bot token. It looks like 123456789:ABC… and comes from @BotFather.' });
        const info = await telegramInfo(token);
        const next = { ...settings, telegram: { token, botName: info.bot } };
        await writeJson(SETTINGS, next); pageCache = null;
        return send(res, 200, { botName: info.bot, chats: info.chats });
      }
      if (p === '/api/telegram/detect') {
        if (!settings.telegram.token) return send(res, 400, { error: 'Save your bot token first.' });
        return send(res, 200, await telegramInfo(settings.telegram.token));
      }
      if (p === '/api/alerts/preview') {
        const live = await liveView();
        const draft = { ...settings, alerts: { ...settings.alerts, ...(b.alerts || {}) } };
        const items = live.items.filter((d) => draft.perStrategy?.[d.id]?.pnl !== false).slice(0, b.limit || 4);
        return send(res, 200, { text: items.length ? pnlMessage(items, draft, { day: await readIntraday(DATA) }).join('\n\n') : 'No live data yet.' });
      }
      if (p === '/api/alerts/test') {
        const ch = settings.channels.find((c) => c.id === b.id);
        if (!ch) return send(res, 404, { error: 'Channel not found. Save it first.' });
        try { await sendTo(ch, `✅ <b>AlgoLens is connected</b>\nThis channel will receive: ${{ all: 'P&L updates, end-of-day summaries and error alerts', errors: 'error alerts only', pnl: 'P&L updates and end-of-day summaries' }[ch.preset]}.`, settings); return send(res, 200, { message: 'Test message sent.' }); }
        catch (e) { return send(res, 400, { error: e.message }); }
      }
      if (p === '/api/alerts/send-now') {
        const live = await liveView();
        const items = live.items.filter((d) => settings.perStrategy?.[d.id]?.pnl !== false);
        const day = await readIntraday(DATA);
        const r = await dispatch(DATA, settings, 'pnl', (ch) => { const l = items.filter((d) => ch.scope === 'all' || !Array.isArray(ch.scope) || ch.scope.includes(d.id)); return l.length ? pnlMessage(l, settings, { day }).join('\n\n') : null; });
        return send(res, 200, { results: r });
      }
      return send(res, 404, { error: 'Unknown action' });
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  } catch (e) {
    console.error(e); send(res, 500, { error: e.message || 'Something went wrong. Check the server window.' });
  }
});

server.listen(PORT, () => console.log(`AlgoLens running on http://localhost:${PORT}`));
scheduleNightly();
scheduleLive();
loadSettings().then((s) => console.log(`Live refresh every ${liveInterval(s)} min, ${LIVE_HOURS} IST${LIVE_WEEKENDS ? '' : ' on weekdays'}; history daily at ${SYNC_TIME} IST`));
// On start: refresh live data now; run the full history sync too if it hasn't run today
(async () => {
  if (!readCookie()) return console.log('No Tradetron session yet: open the Settings page and paste it.');
  const st = await readJson(path.join(DATA, 'sync-status.json'), {});
  const histDay = st.history?.finishedAt ? istParts(new Date(st.history.finishedAt)).date : '';
  if (histDay !== istParts().date || !st.history?.ok) await runSync(); else if (inLiveWindow()) await runLive();
})().catch((e) => console.error(e));
