// Runs the collector against a stand-in for Tradetron built from the real response shapes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.env.SYNC_DELAY_MS = '0';
process.env.ALGOLENS_DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '.testdata');
const { sync, liveSync, historySync, parseStats } = await import('../collector.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.ALGOLENS_DATA;
const meta = JSON.parse(await fs.readFile(path.join(here, 'fixtures', 'meta.json'), 'utf8'));
const equity = JSON.parse(await fs.readFile(path.join(here, 'fixtures', 'equity.json'), 'utf8'));

// three made-up "own" deployments, reusing history shapes from real ones
const own = [
  { id: 30553146, name: 'part 1', creator: 'Edgocity', status: 'Live-Entered', type: 'LIVE AUTO', ex: 'NFO', on: '2025-06-02', broker: 'Bigul (Symphony)', cap: 1800000, ctr: 49, all_pnl: 96067, src: 23095425 },
  { id: 30553246, name: 'part 2', creator: 'Edgocity', status: 'Live-Entered', type: 'LIVE AUTO', ex: 'BFO', on: '2025-07-31', broker: 'Bigul (Symphony)', cap: 1800000, ctr: 47, all_pnl: 81200, src: 24212075 },
  { id: 30999999, name: 'Brand new deployment', creator: 'Me', status: 'Active', type: 'LIVE AUTO', ex: 'MCX', on: '2026-10-01', broker: 'Zerodha', cap: 300000, ctr: 1, all_pnl: 0, src: null },
];
const pos = (sid, n) => JSON.stringify(Array.from({ length: n }, (_, k) => ({ id: sid * 10 + k, strategy_id: sid, instrument: `OPTIDX_NIFTY_06OCT2026_${k % 2 ? 'CE' : 'PE'}_${22500 + k * 100}`, underlying: 'NIFTY 50', exchange: 'NFO', quantity: k === n - 1 ? 0 : (k % 2 ? -65 : 65), price: 40 + k, ltp: 42 + k, pnl: (k % 2 ? -1 : 1) * 130 * (k + 1), exp: 0, entry_value: 0, run_counter: 0, option_type: k % 2 ? 'CE' : 'PE' })));
const row = (m, source) => ({ id: m.id, template_id: m.tid || 1, template_name: m.name, creator_name: m.creator, status: m.status, deployment_type: m.type, exchange: m.ex, deployed_on: m.on, broker_name: m.broker, capital: m.cap, run_counter: m.ctr, all_pnl: m.all_pnl, share_kind: source === 'shared' ? m.kind : null, source, is_shared: source === 'shared', pnl: (m.id % 7 - 3) * 1500.5, last_pnl: 2400, exposure: -30000, position_count: 4, open_position_count: 3, run_counters: [{ run_counter: m.ctr, pnl: -1200 }, { run_counter: m.ctr - 1, pnl: 2400 }], positions: pos(m.id, 4), currency_code: 'INR' });
const scopes = { deployed: own.map((m) => row(m, 'own')), shared: meta.map((m) => row(m, 'shared')) };
const series = (id) => { const o = own.find((m) => m.id === +id); return o ? (o.src ? equity[o.src] : null) : equity[id]; };
const statsHtml = (id) => {
  const s = series(id);
  return `<html><body><p><strong>Share Code:</strong> <code>e310c7e1-502f-46d8-8b77-38f66cde9cb1</code></p><p>Subscribers: 96</p>
<script type="application/json" id="tt-stats-data">${JSON.stringify({ equity: (s || []).map(([date, v]) => ({ date, eq_curve: v, ret_per: 0, uw_curve: 0 })), months: [], addStats: [] })}</script></body></html>`;
};
let calls = [];
function fakeTradetron({ expired = false } = {}) {
  return async (url, opts) => {
    calls.push(url);
    assert.ok(opts.headers.Cookie, 'cookie header sent');
    if (expired) return new Response('', { status: 302, headers: { Location: '/login' } });
    const u = new URL(url);
    if (u.pathname === '/api/deployments') {
      const all = scopes[u.searchParams.get('scope')], page = +u.searchParams.get('page'), per = 5;
      return new Response(JSON.stringify({ success: true, data: all.slice((page - 1) * per, page * per), paginate: { current_page: page, last_page: Math.ceil(all.length / per), total: all.length } }));
    }
    if (u.pathname === '/api/p/stats') return new Response(statsHtml(u.searchParams.get('tid')));
    return new Response('nope', { status: 404 });
  };
}
const quiet = { log: () => {} };

// 1. full sync: own + shared, paginated
await fs.rm(DATA, { recursive: true, force: true });
const s1 = await sync({ cookie: 'session=abc', fetchImpl: fakeTradetron(), ...quiet });
assert.equal(s1.ok, true);
const live = JSON.parse(await fs.readFile(path.join(DATA, 'live.json'), 'utf8'));
assert.equal(live.items.length, 15);
assert.equal(live.items.filter((d) => d.source === 'own').length, 3);
assert.equal(live.items[0].positions.length, 4);
assert.deepEqual(Object.keys(live.items[0].positions[0]), ['i', 'u', 'x', 'q', 'avg', 'ltp', 'pnl', 't']);
const idx = JSON.parse(await fs.readFile(path.join(DATA, 'index.json'), 'utf8'));
assert.equal(idx.length, 14, 'brand-new deployment has no history yet');
const st = JSON.parse(await fs.readFile(path.join(DATA, 'sync-status.json'), 'utf8'));
assert.equal(st.history.failed[0].id, 30999999);
const ms = JSON.parse(await fs.readFile(path.join(DATA, 'strategies', '5212119.json'), 'utf8'));
assert.equal(ms.equity.at(-1)[1], 2194348);

// 2. live refresh only touches the two lists (4 requests here because of pagination at 5 per page)
calls = [];
const l = await liveSync({ cookie: 'session=abc', fetchImpl: fakeTradetron(), ...quiet });
assert.equal(l.status.ok, true);
assert.ok(calls.every((c) => c.includes('/api/deployments')), 'live refresh never fetches statistics pages');

// 3. history for one new id only, keeping the rest
calls = [];
await historySync({ cookie: 'session=abc', fetchImpl: fakeTradetron(), items: l.items, onlyIds: [5212119], ...quiet });
assert.equal(calls.length, 1);
assert.equal(JSON.parse(await fs.readFile(path.join(DATA, 'index.json'), 'utf8')).length, 14);

// 4. expired session: reported, old data kept
const s2 = await liveSync({ cookie: 'old', fetchImpl: fakeTradetron({ expired: true }), ...quiet });
assert.equal(s2.status.authExpired, true);
assert.equal(JSON.parse(await fs.readFile(path.join(DATA, 'live.json'), 'utf8')).items.length, 15);

assert.equal(parseStats('<html>no data</html>'), null);
// leave a healthy demo state behind
await sync({ cookie: 'session=abc', fetchImpl: fakeTradetron(), ...quiet });
console.log('collector tests passed');
