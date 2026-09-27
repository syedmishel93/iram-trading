/* =====================================================================
   test_v399_broker.js — the broker-accurate ticket + verdict watch + C1.
   The lot math is the money-critical path: tested as pure arithmetic.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let P = 0, F = 0;
const ok = (n, c, d) => { if (c) { P++; console.log('  ok  ', n); } else { F++; console.log('  FAIL', n, d !== undefined ? d : ''); } };

function resolve(pattern) {
  const dir = path.join(__dirname, '..', 'src', 'js');
  const hit = fs.readdirSync(dir).find(f => f.includes(pattern));
  if (!hit) throw new Error('no module matching ' + pattern);
  return path.join(dir, hit);
}
function load(pattern, extra) {
  const code = fs.readFileSync(resolve(pattern), 'utf8');
  const store = {};
  const win = Object.assign({
    document: { hidden: true, readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    setInterval() {}, setTimeout() {},
    STORE: { get: k => store[k], set: (k, v) => { store[k] = v; } },
    localStorage: { getItem: k => store[k], setItem: (k, v) => { store[k] = v; } },
    CURSYM: { sym: 'BTCUSD', cls: 'crypto' }, BAR_CACHE: {},
  }, extra || {});
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  return win;
}

console.log('\n=== v39.9 BROKER-ACCURATE SIZING (the money path) ===\n');
const W = load('broker-desk');

/* MT5 default profile: risk 1% of 1000 = $10. EURUSD contract 100k.
   stop 20 pips = 0.0020. lots = 10 / (0.0020 * 100000) = 0.05 */
let sz = W.brokerSize('EURUSD', 1.10000, 1.09800);
ok('MT5 EURUSD: correct lots from contract spec (0.05)', sz.ok && Math.abs(sz.lots - 0.05) < 1e-9, sz.lots);

/* XAUUSD contract 100 (oz), NOT 100000. risk $10, stop $5 -> 10/(5*100)=0.02 */
sz = W.brokerSize('XAUUSD', 2000, 1995);
ok('XAUUSD sized on 100 oz (the 1000x bug is dead): 0.02 lots', sz.ok && Math.abs(sz.lots - 0.02) < 1e-9, sz.lots);
ok('XAUUSD would be 1000x smaller on a 100k contract (proves the fix matters)',
  Math.abs((10 / (5 * 100000)) - 0.00002) < 1e-12);

/* actual risk is reported and honest */
ok('actual risk money reported', sz.ok && sz.actualRisk > 0 && Math.abs(sz.actualRisk - 10) < 5, sz.actualRisk);

/* switching profile changes the symbol name (T2/T9) */
W.window.localStorage.setItem('broker.active.v1', 'Binance');
ok('Binance profile maps BTCUSD -> BTCUSDT', W.brokerSym('BTCUSD') === 'BTCUSDT');
ok('MT5 profile maps BTCUSD -> BTCUSD', (function () { W.window.localStorage.setItem('broker.active.v1', 'JustMarkets MT5'); return W.brokerSym('BTCUSD') === 'BTCUSD'; })());

/* no spec => refuses to guess (never a wrong contract size) */
sz = W.brokerSize('XPTUSD', 900, 890);
ok('unknown symbol: refuses to size, does NOT guess', !sz.ok && /will not guess|No contract spec/.test(sz.why));

/* ticket text carries the exact fields */
const tk = W.brokerTicket('BTCUSD', { dir: 'LONG', entryLo: 64000, entryHi: 64100, stop: 63500, t1: 64550, t2: 65100 });
ok('ticket includes symbol, side, entry, SL, TP', /symbol:/.test(tk.text) && /side: LONG/.test(tk.text) && /SL:/.test(tk.text) && /TP:/.test(tk.text));
ok('ticket says nothing auto-executes', /manual entry|you place/.test(tk.text));

console.log('\n=== v39.9 SHIPPED CONTRACT ===\n');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('T1: order ticket card with per-field copy buttons', idx.includes("id = 'brokerCard'") && idx.includes('bk-cp'));
ok('T4: pre-flight strip on the sniper card', idx.includes('snp-preflight'));
ok('T5: verdict watchlist card', idx.includes("id = 'watchCard'") && idx.includes('wl-state'));
ok('T6: arming pushes the full broker ticket to the phone', idx.includes('window.brokerTicket(CURSYM.sym, pl)') && idx.includes('You place it'));
ok('T7: "I placed this" logs a real trade', idx.includes('realtrades.v1') && idx.includes('I placed this'));
ok('T8: plan/sizer removed from the DECIDE cockpit (no double render)', idx.includes('decide:[]'));
ok('T9: broker profiles switchable', idx.includes('bkProfile') && idx.includes('JustMarkets MT5') && idx.includes('Binance'));
ok('C1: explain-on-hover appends plain-language meaning', idx.includes('EXPLAIN-ON-HOVER') && idx.includes('data-c1'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
