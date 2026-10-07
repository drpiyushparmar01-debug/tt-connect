// AlgoLens alerts: scheduled P&L digests, end-of-day summaries and error alerts, sent to Telegram and Discord.
import fs from 'node:fs/promises';
import path from 'node:path';
import { istParts, toMin, isMcx, dayHighLow } from './enrich.js';

export const DEFAULT_SETTINGS = {
  hidden: [], names: {}, styleOverride: {}, perStrategy: {},
  liveIntervalMin: 15,
  alerts: {
    enabled: true, intervalMin: 30, mcx: true, header: '', oneX: false, dayHL: false,
    format: 'detailed', sort: 'pnl', useAlias: true, footer: [], eod: true, eodTime: '15:40', mcxEodTime: '23:40', errors: true,
  },
  telegram: { token: '', botName: '' },
  channels: [], // { id, type: 'telegram'|'discord', name, chatId, webhook, preset: 'all'|'errors'|'pnl', scope: 'all'|[ids], enabled }
};
export function withDefaults(s = {}) {
  return { ...DEFAULT_SETTINGS, ...s, alerts: { ...DEFAULT_SETTINGS.alerts, ...(s.alerts || {}) }, telegram: { ...DEFAULT_SETTINGS.telegram, ...(s.telegram || {}) }, channels: s.channels || [] };
}

const readJson = async (f, fb) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return fb; } };
async function writeJson(file, obj) { const tmp = file + '.tmp'; await fs.writeFile(tmp, JSON.stringify(obj)); await fs.rename(tmp, file); }
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const money = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + '₹' + Math.abs(Math.round(v)).toLocaleString('en-IN');
const moneyC = (v) => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 1e7 ? `${s}₹${(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `${s}₹${(a / 1e5).toFixed(2)} L` : `${s}₹${Math.round(a).toLocaleString('en-IN')}`; };
const pct = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%';
const dot = (v) => v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪';
const hm = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };

// ---------- message builders (also used by the preview on the Alerts page) ----------
export function pnlMessage(items, settings, { title = 'P&L update', day = null, now = new Date(), eod = false } = {}) {
  const a = settings.alerts, p = istParts(now);
  const scale = (d, v) => a.oneX ? v / (d.mult || 1) : v;
  const capOf = (d) => a.oneX ? d.cap / (d.mult || 1) : d.cap;
  let rows = items.map((d) => ({ d, v: scale(d, d.today), pc: d.today / d.cap * 100, all: scale(d, d.allTime) }));
  if (a.sort === 'pnl') rows.sort((x, y) => y.v - x.v); else if (a.sort === 'name') rows.sort((x, y) => x.d.name.localeCompare(y.d.name));
  const nm = (d) => esc(a.useAlias ? d.name : (d.tdName || d.name));
  const net = rows.reduce((s, r) => s + r.v, 0), cap = items.reduce((s, d) => s + capOf(d), 0);
  const head = `${eod ? '📘' : '📊'} <b>${esc(a.header || 'AlgoLens')} · ${title}</b>\n<i>${new Date(p.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} · ${hm(p.hhmm)}${a.oneX ? ' · 1x P&L' : ''}</i>`;
  const blocks = rows.map(({ d, v, pc, all }) => {
    if (a.format === 'sleek') return `${dot(v)} ${nm(d)}: <b>${money(v)}</b> (${pct(pc)})`;
    const lines = [`🔹 <b>${nm(d)}</b>${d.mult > 1 ? ` · ${d.mult}x` : ''}`, `├ ${d.style} · ${esc(d.status)}`];
    if (a.dayHL && day) {
      const { hi, lo } = dayHighLow(day, d.id);
      if (hi && lo) lines.push(`├ High ${money(scale(d, hi.v))} at ${hm(hi.t)} · Low ${money(scale(d, lo.v))} at ${hm(lo.t)}`);
    }
    if (eod) lines.push(`├ All-time: ${money(all)} (${pct(d.allTimePct)})`);
    lines.push(`└ ${dot(v)} Day: <b>${money(v)}</b> (${pct(pc)})`);
    return lines.join('\n');
  });
  let tail = `⚡ <b>Net total: ${money(net)}</b> (${pct(cap ? net / cap * 100 : 0)} of ${moneyC(cap)}) · ${items.length} strateg${items.length === 1 ? 'y' : 'ies'}`;
  if (a.dayHL && day && !a.oneX) { const { hi, lo } = dayHighLow(day); if (hi && lo) tail += `\nDay high ${money(hi.v)} at ${hm(hi.t)} · low ${money(lo.v)} at ${hm(lo.t)}`; }
  const foot = (a.footer || []).filter((l) => l.label && /^https?:\/\//.test(l.url)).map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(' · ');
  const body = a.format === 'sleek' ? [blocks.join('\n')] : blocks;
  return [head, ...body, tail + (foot ? '\n\n' + foot : '')];
}

export function eventMessage(e, settings) {
  const n = esc(e.name);
  if (e.kind === 'error') return `🚨 <b>Execution error</b>\n${n} moved from ${esc(e.prev)} to <b>${esc(e.status)}</b>.\nOpen it in Tradetron to fix: https://tradetron.tech/deployed/view/${e.id}`;
  if (e.kind === 'recovered') return `✅ <b>Recovered</b>\n${n} is now ${esc(e.status)}.`;
  if (e.kind === 'removed') return `⚠️ <b>Strategy removed</b>\n${n} (SID ${e.id}) is no longer in your Tradetron account.`;
  if (e.kind === 'session') return `🔑 <b>Tradetron session expired</b>\nAlgoLens can't read your account until you paste a fresh session on the Settings page.`;
  return esc(JSON.stringify(e));
}

// Join message blocks into chunks under Telegram's 4,096-character limit
function chunk(blocks, max = 3900) {
  const out = []; let cur = '';
  for (const b of blocks) { if (cur && (cur + '\n\n' + b).length > max) { out.push(cur); cur = b; } else cur = cur ? cur + '\n\n' + b : b; }
  if (cur) out.push(cur);
  return out;
}

// ---------- delivery ----------
export async function sendTo(channel, text, settings, fetchImpl = fetch) {
  if (channel.type === 'discord') {
    const content = text.replace(/<a href="([^"]+)">([^<]+)<\/a>/g, '[$2]($1)').replace(/<\/?b>/g, '**').replace(/<\/?i>/g, '_').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const part of chunk(content.split('\n\n'), 1900)) {
      const r = await fetchImpl(channel.webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: part }) });
      if (!r.ok) throw new Error(`Discord answered ${r.status}`);
    }
    return;
  }
  if (!settings.telegram.token) throw new Error('No Telegram bot token saved.');
  for (const part of chunk(text.split('\n\n'))) {
    const r = await fetchImpl(`https://api.telegram.org/bot${settings.telegram.token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: channel.chatId, text: part, parse_mode: 'HTML', disable_web_page_preview: true }) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(j.description || `Telegram answered ${r.status}`);
  }
}

const wants = (ch, kind) => ch.enabled !== false && (ch.preset === 'all' || (ch.preset === 'errors' && kind === 'error') || (ch.preset === 'pnl' && (kind === 'pnl' || kind === 'eod')));
const inScope = (ch, id) => ch.scope === 'all' || !Array.isArray(ch.scope) || ch.scope.includes(id);

async function logHistory(DATA, entry) {
  const file = path.join(DATA, 'alert-history.json');
  const h = await readJson(file, []);
  h.unshift(entry);
  await writeJson(file, h.slice(0, 300));
}

// kind: 'pnl' | 'eod' | 'error'. build(channel) returns the text for that channel (or null to skip it).
export async function dispatch(DATA, settings, kind, build, fetchImpl = fetch) {
  const results = [];
  for (const ch of settings.channels) {
    if (!wants(ch, kind)) continue;
    const text = build(ch);
    if (!text) continue;
    try { await sendTo(ch, text, settings, fetchImpl); results.push({ ch: ch.name, ok: true }); }
    catch (e) { results.push({ ch: ch.name, ok: false, error: e.message }); }
    await logHistory(DATA, { at: new Date().toISOString(), kind, channel: ch.name, ok: results.at(-1).ok, error: results.at(-1).error || null, text });
  }
  return results;
}

// ---------- scheduling: called after every live refresh ----------
export async function runAlerts(DATA, settings, enriched, events, day, now = new Date(), fetchImpl = fetch) {
  const a = settings.alerts;
  const file = path.join(DATA, 'alert-state.json');
  const st = await readJson(file, { lastPnl: null, eod: null, mcxEod: null });
  const p = istParts(now), weekday = p.day >= 1 && p.day <= 5;
  const sent = [];
  if (!settings.channels.length) return sent;

  // 1. error / removed / recovered events, right away
  if (a.errors !== false) {
    const evs = events.filter((e) => e.kind === 'removed' || settings.perStrategy?.[e.id]?.error !== false);
    if (evs.length) sent.push(...await dispatch(DATA, settings, 'error', (ch) => { const mine = evs.filter((e) => inScope(ch, e.id)); return mine.length ? mine.map((e) => eventMessage(e, settings)).join('\n\n') : null; }, fetchImpl));
  }
  if (!a.enabled || !weekday) { await writeJson(file, st); return sent; }

  const pnlItems = enriched.filter((d) => settings.perStrategy?.[d.id]?.pnl !== false && !settings.hidden?.includes(d.id));
  const pick = (ch, list) => list.filter((d) => inScope(ch, d.id));
  const nse = p.min >= toMin('09:15') && p.min <= toMin('15:30');
  const mcxEve = a.mcx && p.min > toMin('15:30') && p.min <= toMin('23:30');

  // 2. periodic P&L digest during market hours
  const due = !st.lastPnl || st.lastPnl.date !== p.date || p.min - st.lastPnl.min >= a.intervalMin - 1;
  if ((nse || mcxEve) && due) {
    const list = nse ? pnlItems : pnlItems.filter(isMcx);
    if (list.length) {
      sent.push(...await dispatch(DATA, settings, 'pnl', (ch) => { const l = pick(ch, list); return l.length ? pnlMessage(l, settings, { day, now, title: nse ? 'P&L update' : 'MCX P&L update' }).join('\n\n') : null; }, fetchImpl));
      st.lastPnl = { date: p.date, min: p.min };
    }
  }
  // 3. end-of-day summaries
  if (a.eod && p.min >= toMin(a.eodTime) && st.eod !== p.date) {
    st.eod = p.date;
    sent.push(...await dispatch(DATA, settings, 'eod', (ch) => { const l = pick(ch, pnlItems); return l.length ? pnlMessage(l, settings, { day, now, eod: true, title: 'End of day' }).join('\n\n') : null; }, fetchImpl));
  }
  if (a.eod && a.mcx && p.min >= toMin(a.mcxEodTime) && st.mcxEod !== p.date) {
    st.mcxEod = p.date;
    const mcx = pnlItems.filter(isMcx);
    if (mcx.length) sent.push(...await dispatch(DATA, settings, 'eod', (ch) => { const l = pick(ch, mcx); return l.length ? pnlMessage(l, settings, { day, now, eod: true, title: 'MCX end of day' }).join('\n\n') : null; }, fetchImpl));
  }
  await writeJson(file, st);
  return sent;
}

// ---------- Telegram helpers for the Settings page ----------
export async function telegramInfo(token, fetchImpl = fetch) {
  const me = await (await fetchImpl(`https://api.telegram.org/bot${token}/getMe`)).json();
  if (!me.ok) throw new Error(me.description || 'Telegram did not accept that bot token.');
  const up = await (await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?limit=100&allowed_updates=${encodeURIComponent('["message","channel_post","my_chat_member"]')}`)).json();
  const chats = new Map();
  for (const u of up.result || []) {
    const c = (u.message || u.channel_post || u.my_chat_member || {}).chat;
    if (c) chats.set(c.id, { id: String(c.id), type: c.type, title: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id) });
  }
  return { bot: me.result.username, chats: [...chats.values()] };
}
