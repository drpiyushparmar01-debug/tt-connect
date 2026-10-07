// AlgoLens collector — reads your Tradetron deployments (your own and the ones shared with you through
// share codes). Read-only: it never changes anything on Tradetron.
//
//   liveSync()     every 15 min: status, current P&L, booked P&L and open positions   (≈4 small requests)
//   historySync()  once a day:   each deployment's daily P&L history (Statistics page)  (1 request per strategy)
//
// Run by hand:  node collector.js          (full sync: live + history)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCookie, loadEnv, DATA_DIR } from './env.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = DATA_DIR;
const BASE = 'https://tradetron.tech';
const delayMs = () => Number(process.env.SYNC_DELAY_MS ?? 1500); // pause between requests, to be gentle with Tradetron
const SCOPES = { deployed: 'own', shared: 'shared' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class AuthError extends Error {}

function headers(cookie) {
  return {
    Cookie: cookie,
    Accept: 'application/json, text/html',
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'AlgoLens-collector/2.0 (personal, read-only)',
  };
}

async function get(url, cookie, fetchImpl) {
  const res = await fetchImpl(BASE + url, { headers: headers(cookie), redirect: 'manual' });
  // An expired session redirects to /login or answers 401/419
  if ([301, 302, 401, 403, 419].includes(res.status)) throw new AuthError(`Tradetron answered ${res.status} for ${url}; the saved session has probably expired.`);
  if (!res.ok) throw new Error(`Tradetron answered ${res.status} for ${url}`);
  return res.text();
}
async function getJson(url, cookie, fetchImpl) {
  const txt = await get(url, cookie, fetchImpl);
  try { return JSON.parse(txt); } catch { throw new AuthError('Expected data from Tradetron but got a web page; the saved session has probably expired.'); }
}

export async function listScope(scope, cookie, fetchImpl = fetch) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await getJson(`/api/deployments?scope=${scope}&include_error_execution=yes&page=${page}`, cookie, fetchImpl);
    if (!j.success) throw new Error('Tradetron did not return the deployments list.');
    all.push(...j.data);
    if (!j.paginate || page >= j.paginate.last_page) break;
    await sleep(delayMs());
  }
  return all.map((d) => ({ ...d, _source: SCOPES[scope] }));
}

export function parseStats(html) {
  const m = html.match(/<script[^>]*id="tt-stats-data"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  const s = JSON.parse(m[1]);
  const shareCode = (html.match(/Share Code:\s*<\/strong>\s*<code>([0-9a-f-]{20,})<\/code>/i) || [])[1] || null;
  const sub = (html.match(/Subscribers:\s*(\d+)/) || [])[1];
  return {
    equity: (s.equity || []).map((e) => [e.date, Math.round(e.eq_curve * 100) / 100]),
    months: (s.months || []).map((x) => ({ month: x.date.slice(0, 7), pnl: x.pnl_change, trades: x.trades })),
    ttStats: Object.fromEntries((s.addStats || []).map((a) => [a.label, a.value])),
    shareCode,
    subscribers: sub ? Number(sub) : null,
  };
}

const parseMaybe = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };

function metaOf(d) {
  return {
    id: d.id, name: d.template_name, tid: d.template_id, creator: d.creator_name, status: d.status,
    type: d.deployment_type, ex: d.exchange, on: d.deployed_on, broker: d.broker_name, cap: d.capital,
    ctr: d.run_counter, all_pnl: Math.round(d.all_pnl || 0), kind: d.share_kind, currency: d.currency_code,
    source: d._source, mult: d.minimum_multiple || 1,
  };
}

function liveOf(d) {
  const positions = (parseMaybe(d.positions) || []).map((p) => ({
    i: p.instrument, u: p.underlying, x: p.exchange, q: p.quantity, avg: p.price, ltp: p.ltp, pnl: p.pnl, t: p.option_type,
  }));
  return {
    ...metaOf(d),
    pnl: d.pnl || 0, lastPnl: d.last_pnl || 0, exposure: d.exposure || 0,
    open: d.open_position_count || 0, total: d.position_count || 0,
    counters: (parseMaybe(d.run_counters) || []).slice(0, 10).map((c) => [c.run_counter, c.pnl]),
    positions,
  };
}

async function writeJson(file, obj) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(obj));
  await fs.rename(tmp, file); // atomic replace, so the site never reads a half-written file
}
const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };

async function saveStatus(kind, status) {
  const file = path.join(DATA, 'sync-status.json');
  const all = await readJson(file, {});
  all[kind] = status;
  // the top-level fields describe the most recent run of either kind (used by the site's status badge)
  Object.assign(all, { ok: status.ok, error: status.error, authExpired: status.authExpired, finishedAt: status.finishedAt, failed: status.failed || all.failed || [] });
  await writeJson(file, all);
}

// ---------- every 15 minutes ----------
export async function liveSync({ cookie = readCookie(), fetchImpl = fetch, log = console.log } = {}) {
  await fs.mkdir(DATA, { recursive: true });
  const status = { startedAt: new Date().toISOString(), finishedAt: null, ok: false, count: 0, error: null };
  let items = [];
  try {
    if (!cookie) throw new AuthError('No Tradetron session saved yet. Paste it on the admin page.');
    const own = await listScope('deployed', cookie, fetchImpl);
    await sleep(delayMs());
    const shared = await listScope('shared', cookie, fetchImpl);
    items = [...own, ...shared].map(liveOf);
    await writeJson(path.join(DATA, 'live.json'), { fetchedAt: new Date().toISOString(), items });
    Object.assign(status, { ok: true, count: items.length });
    log(`Live: ${own.length} own + ${shared.length} shared deployments`);
  } catch (e) {
    status.error = e.message; status.authExpired = e instanceof AuthError;
    log('Live sync failed: ' + e.message);
  }
  status.finishedAt = new Date().toISOString();
  await saveStatus('live', status);
  if (!status.ok) await notify(status, log);
  return { status, items };
}

// ---------- once a day (and right away for newly added strategies) ----------
export async function historySync({ cookie = readCookie(), fetchImpl = fetch, log = console.log, items, onlyIds } = {}) {
  await fs.mkdir(path.join(DATA, 'strategies'), { recursive: true });
  const startedAt = new Date().toISOString();
  const status = { startedAt, finishedAt: null, ok: false, count: 0, failed: [], error: null };
  try {
    if (!cookie) throw new AuthError('No Tradetron session saved yet. Paste it on the admin page.');
    if (!items) {
      const own = await listScope('deployed', cookie, fetchImpl); await sleep(delayMs());
      const shared = await listScope('shared', cookie, fetchImpl);
      items = [...own, ...shared].map(liveOf);
    }
    const prev = await readJson(path.join(DATA, 'index.json'), []);
    const prevById = new Map(prev.map((m) => [m.id, m]));
    const index = [];
    for (const d of items) {
      const meta = Object.fromEntries(['id', 'name', 'tid', 'creator', 'status', 'type', 'ex', 'on', 'broker', 'cap', 'ctr', 'all_pnl', 'kind', 'currency', 'source', 'mult'].map((k) => [k, d[k]]));
      if (onlyIds && !onlyIds.includes(d.id)) { if (prevById.has(d.id)) index.push({ ...prevById.get(d.id), ...meta }); continue; }
      await sleep(delayMs());
      try {
        const stats = parseStats(await get(`/api/p/stats?tid=${d.id}&hide_meta=1`, cookie, fetchImpl));
        if (!stats || !stats.equity.length) { status.failed.push({ id: d.id, reason: 'no statistics yet (new deployment)' }); continue; }
        await writeJson(path.join(DATA, 'strategies', `${d.id}.json`), { meta, ...stats, syncedAt: startedAt });
        index.push({ ...meta, shareCode: stats.shareCode, subscribers: stats.subscribers, last: stats.equity.at(-1)[0] });
        log(`  ✓ ${meta.name} (${stats.equity.length} days)`);
      } catch (e) {
        if (e instanceof AuthError) throw e;
        status.failed.push({ id: d.id, reason: e.message });
        log(`  ✗ ${meta.name}: ${e.message}`);
      }
    }
    await writeJson(path.join(DATA, 'index.json'), index);
    Object.assign(status, { ok: true, count: index.length });
  } catch (e) {
    status.error = e.message; status.authExpired = e instanceof AuthError;
    log('History sync failed: ' + e.message);
  }
  status.finishedAt = new Date().toISOString();
  await saveStatus('history', status);
  if (!status.ok) await notify(status, log);
  return status;
}

// Full sync = live + history for everything (the admin page's "Sync now")
export async function sync(opts = {}) {
  const { status, items } = await liveSync(opts);
  if (!status.ok) return status;
  return historySync({ ...opts, items });
}

// Optional Telegram alert when a sync fails or the session expires
let lastAlert = '';
async function notify(status, log) {
  const { TELEGRAM_BOT_TOKEN: tok, TELEGRAM_CHAT_ID: chat } = process.env;
  if (!tok || !chat) return;
  const text = status.authExpired
    ? 'AlgoLens: the Tradetron session has expired. Paste a fresh cookie on the admin page to resume syncing.'
    : `AlgoLens sync failed: ${status.error}`;
  if (text === lastAlert) return; // don't repeat the same alert every 15 minutes
  lastAlert = text;
  try { await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }); }
  catch (e) { log('Telegram alert failed: ' + e.message); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadEnv();
  const s = await sync();
  process.exit(s.ok ? 0 : 1);
}
