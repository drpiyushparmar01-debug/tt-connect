// Turns raw live data into what the pages and alerts need: today's P&L, multiplier, intraday/positional,
// drawdown now vs max, intraday snapshots and day high/low, and events (errors, removed strategies).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// ---------- India time helpers ----------
export const IST_MS = 5.5 * 3600e3;
export const istParts = (d = new Date()) => { const t = new Date(d.getTime() + IST_MS); return { date: t.toISOString().slice(0, 10), min: t.getUTCHours() * 60 + t.getUTCMinutes(), day: t.getUTCDay(), hhmm: t.toISOString().slice(11, 16) }; };
export const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + (m || 0); };
export const isMcx = (d) => /MCX/i.test(d.ex || '');

// ---------- analytics engine (shared with the browser) ----------
let A = null;
export async function engine() {
  if (A) return A;
  const src = await fs.readFile(path.join(ROOT, 'web', 'analytics.js'), 'utf8');
  const mod = { exports: {} };
  new Function('module', 'window', 'globalThis', src)(mod, undefined, {});
  return (A = mod.exports);
}

const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
async function writeJson(file, obj) { const tmp = file + '.tmp'; await fs.writeFile(tmp, JSON.stringify(obj)); await fs.rename(tmp, file); }

// ---------- history cache (reloaded when a history sync rewrites the files) ----------
let hist = { stamp: null, byId: new Map() };
export async function history(DATA) {
  const st = await readJson(path.join(DATA, 'sync-status.json'), {});
  const stamp = st.history?.finishedAt || 'none';
  if (stamp === hist.stamp) return hist.byId;
  const eng = await engine();
  const index = await readJson(path.join(DATA, 'index.json'), []);
  const byId = new Map();
  for (const m of index) {
    const f = await readJson(path.join(DATA, 'strategies', `${m.id}.json`), null);
    if (!f || !f.equity?.length) continue;
    const r = eng.analyze(f.equity, m.cap);
    byId.set(m.id, { equity: f.equity, shareCode: f.shareCode, days: f.equity.length, maxDDPct: r.maxDDPct, avgMonthlyRoiPct: r.avgMonthlyRoiPct, peak: Math.max(0, ...f.equity.map((e) => e[1])) });
  }
  hist = { stamp, byId };
  return byId;
}

// ---------- enrichment ----------
export function classify(d, h, state, overrides) {
  if (overrides?.[d.id]) return overrides[d.id];
  if (state.overnight?.[d.id]) return 'Positional';
  if (h && h.days >= 10 && d.ctr / h.days < 0.6) return 'Positional'; // fewer than ~1 counter per trading day
  return 'Intraday';
}

export function enrich(items, histById, state, settings, now = new Date()) {
  const today = istParts(now).date;
  return items.map((d) => {
    const h = histById.get(d.id);
    // Today's P&L, the way Tradetron shows it: intraday strategies start a new counter each day, so the
    // current counter's P&L is today's. Positional counters span days, so use now − previous close.
    const style = classify(d, h, state, settings.styleOverride);
    let prevClose = null;
    if (h) for (let i = h.equity.length - 1; i >= 0; i--) if (h.equity[i][0] < today) { prevClose = h.equity[i][1]; break; }
    const todayPnl = style === 'Intraday' || prevClose == null ? d.pnl : d.all_pnl - prevClose;
    const peak = Math.max(h?.peak ?? 0, d.all_pnl);
    const ddNowPct = (peak - d.all_pnl) / (d.cap + peak) * 100;
    const ddMaxPct = Math.max(h?.maxDDPct ?? 0, ddNowPct);
    const mult = d.mult || 1;
    return {
      ...d,
      name: settings.names?.[d.id] || d.name, tdName: d.name,
      today: Math.round(todayPnl), todayPct: todayPnl / d.cap * 100,
      allTime: d.all_pnl, allTimePct: d.all_pnl / d.cap * 100,
      mult, style,
      ddNowPct, ddMaxPct, shareCode: h?.shareCode || null,
      sinceDays: Math.max(0, Math.round((Date.parse(today) - Date.parse(d.on)) / 864e5)),
      avgMonthlyRoiPct: h?.avgMonthlyRoiPct ?? null,
      alerts: { error: settings.perStrategy?.[d.id]?.error !== false, pnl: settings.perStrategy?.[d.id]?.pnl !== false },
    };
  });
}

// ---------- state: overnight flags, status changes, removed strategies, intraday snapshots ----------
export async function updateState(DATA, enriched, now = new Date()) {
  const file = path.join(DATA, 'state.json');
  const state = await readJson(file, { overnight: {}, lastStatus: {}, known: {}, removed: {} });
  const { date, min } = istParts(now);
  const events = [];
  const seen = new Set();
  for (const d of enriched) {
    seen.add(d.id);
    // Holding positions before the 09:15 open means the strategy carries overnight
    if (min < toMin('09:15') && d.open > 0) state.overnight[d.id] = 'Positional';
    const prev = state.lastStatus[d.id];
    if (prev && prev !== d.status && /error|block/i.test(d.status)) events.push({ kind: 'error', id: d.id, name: d.name, status: d.status, prev });
    if (prev && /error|block/i.test(prev) && !/error|block/i.test(d.status)) events.push({ kind: 'recovered', id: d.id, name: d.name, status: d.status, prev });
    state.lastStatus[d.id] = d.status;
    state.known[d.id] = { name: d.name, ex: d.ex, cap: d.cap, source: d.source };
    delete state.removed[d.id];
  }
  for (const [id, k] of Object.entries(state.known)) {
    if (!seen.has(+id) && !state.removed[id]) { state.removed[id] = { ...k, at: now.toISOString() }; events.push({ kind: 'removed', id: +id, name: k.name }); }
  }
  await writeJson(file, state);

  // append an intraday snapshot (today's P&L per strategy and in total)
  await fs.mkdir(path.join(DATA, 'intraday'), { recursive: true });
  const ifile = path.join(DATA, 'intraday', `${date}.json`);
  const day = await readJson(ifile, { date, snaps: [] });
  const byId = Object.fromEntries(enriched.map((d) => [d.id, d.today]));
  day.snaps.push({ t: istParts(now).hhmm, total: enriched.reduce((a, d) => a + d.today, 0), byId });
  await writeJson(ifile, day);
  return { state, events, day };
}

export async function readIntraday(DATA, date = istParts().date) {
  return readJson(path.join(DATA, 'intraday', `${date}.json`), { date, snaps: [] });
}

// day high / low for one strategy (or the total when id is null) from today's snapshots
export function dayHighLow(day, id = null) {
  let hi = null, lo = null;
  for (const s of day.snaps || []) {
    const v = id == null ? s.total : s.byId?.[id];
    if (v == null) continue;
    if (!hi || v > hi.v) hi = { v, t: s.t };
    if (!lo || v < lo.v) lo = { v, t: s.t };
  }
  return { hi, lo };
}
