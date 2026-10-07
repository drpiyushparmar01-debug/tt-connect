// Simulates a trading day against the alert engine with a fake Telegram, using the collector test's data.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
process.env.ALGOLENS_DATA = path.join(here, '.testdata');
const DATA = process.env.ALGOLENS_DATA;
const { enrich, history, updateState } = await import('../enrich.js');
const { withDefaults, runAlerts, pnlMessage } = await import('../alerts.js');

const live = JSON.parse(await fs.readFile(path.join(DATA, 'live.json'), 'utf8'));
// make one strategy MCX so the evening session has something to report
live.items[2].ex = 'MCX';
const sent = [];
const fakeFetch = async (url, opts) => { const b = JSON.parse(opts.body); sent.push({ url, chat: b.chat_id, text: b.text }); return new Response(JSON.stringify({ ok: true })); };
const settings = withDefaults({
  telegram: { token: '123456789:' + 'x'.repeat(35), botName: 'mybot' },
  channels: [
    { id: 'a', type: 'telegram', name: 'Private', chatId: '111', preset: 'all', scope: 'all' },
    { id: 'b', type: 'telegram', name: 'Errors desk', chatId: '222', preset: 'errors', scope: 'all' },
    { id: 'c', type: 'telegram', name: 'Creator', chatId: '333', preset: 'pnl', scope: [live.items[3].id] },
  ],
  perStrategy: { [live.items[1].id]: { pnl: false } },
  alerts: { intervalMin: 30, dayHL: true },
});
await fs.rm(path.join(DATA, 'state.json'), { force: true }); await fs.rm(path.join(DATA, 'alert-state.json'), { force: true });
await fs.rm(path.join(DATA, 'intraday'), { recursive: true, force: true }); await fs.rm(path.join(DATA, 'alert-history.json'), { force: true });

const ist = (hhmm) => new Date(`2026-10-01T${hhmm}:00+05:30`); // a Thursday
const hist = await history(DATA);
async function tick(hhmm, mutate) {
  if (mutate) mutate(live.items);
  const state = JSON.parse(await fs.readFile(path.join(DATA, 'state.json'), 'utf8').catch(() => '{}'));
  const en = enrich(live.items, hist, state, settings, ist(hhmm));
  const { events, day } = await updateState(DATA, en, ist(hhmm));
  const before = sent.length;
  await runAlerts(DATA, settings, en, events, day, ist(hhmm), fakeFetch);
  return sent.slice(before);
}

let out = await tick('09:00'); // before market: no digest
assert.equal(out.length, 0);
const st0 = JSON.parse(await fs.readFile(path.join(DATA, 'state.json'), 'utf8'));
assert.ok(Object.keys(st0.overnight).length > 0, 'positions held before 09:15 mark strategies positional');
out = await tick('09:15');
assert.deepEqual(out.map((m) => m.chat).sort(), ['111', '333'], 'digest goes to the all and pnl channels, not the errors desk');
const creator = out.find((m) => m.chat === '333').text;
assert.ok(creator.includes(live.items[3].template_name || live.items[3].name), 'creator channel only sees its scoped strategy');
assert.ok(!out.find((m) => m.chat === '111').text.includes(`<b>${live.items[1].name}</b>`), 'strategy with P&L alerts off is left out');
out = await tick('09:30'); assert.equal(out.length, 0, '30-minute interval respected');
out = await tick('09:45', (it) => { it[0].all_pnl += 5000; }); assert.equal(out.length, 2);
assert.ok(out[0].text.includes('High'), 'day high/low shown');
// an execution error goes to the all and errors channels immediately
out = await tick('10:00', (it) => { it[4].status = 'Error-Execution'; });
const errs = out.filter((m) => m.text.includes('Execution error'));
assert.deepEqual(errs.map((m) => m.chat).sort(), ['111', '222']);
// a strategy disappears from the account
const gone = live.items.pop();
out = await tick('10:15'); assert.ok(out.some((m) => m.text.includes('Strategy removed') && m.text.includes(gone.name)));
// end of day after 15:40, once
out = await tick('15:45'); assert.ok(out.some((m) => m.text.includes('End of day')));
out = await tick('16:00'); assert.ok(!out.some((m) => m.text.includes('End of day')), 'end of day sent once');
// MCX evening: only MCX strategies
out = await tick('16:15'); const mcx = out.find((m) => m.text.includes('MCX P&L update'));
assert.ok(mcx); assert.equal((mcx.text.match(/🔹/g) || []).length, 1);
out = await tick('23:45'); assert.ok(out.some((m) => m.text.includes('MCX end of day')));

// formats
const sleek = pnlMessage(live.items.slice(0, 3), withDefaults({ alerts: { format: 'sleek', header: 'MyAlgo' } }), { now: ist('11:00') }).join('\n\n');
assert.ok(sleek.startsWith('📊 <b>MyAlgo')); assert.ok(!sleek.includes('├'));
const oneX = pnlMessage([{ ...live.items[0], today: 2000, allTime: 0, allTimePct: 0, mult: 2, cap: 100000, style: 'Intraday', name: 'X' }], withDefaults({ alerts: { oneX: true } }), { now: ist('11:00') }).join('\n');
assert.ok(oneX.includes('+₹1,000'), '1x P&L divides by the multiplier');
const hist2 = JSON.parse(await fs.readFile(path.join(DATA, 'alert-history.json'), 'utf8'));
assert.ok(hist2.length >= 10 && hist2.every((h) => h.ok));
console.log(`alert tests passed (${sent.length} messages simulated)`);
console.log('\n--- sample detailed message ---\n' + sent.find((m) => m.chat === '111' && m.text.includes('P&L update')).text.split('\n\n').slice(0, 3).join('\n\n'));
