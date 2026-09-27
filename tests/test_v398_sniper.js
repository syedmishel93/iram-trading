/* =====================================================================
   test_v398_sniper.js — the Sniper decision surface.

   Asserts the STATE MACHINE and the HARD GATE (the user's explicit choice:
   any red checklist item => STAND DOWN, plan greyed). The verdict logic is
   what protects against operational error, so it is tested as pure logic
   against a stubbed window, plus contract checks on the shipped page.
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

/* build a stub world where DATA/analystContext/IND exist, then load the module
   and drive checklist() + planFrom() directly */
function loadSniper(world) {
  const code = fs.readFileSync(resolve('sniper'), 'utf8');
  const bars = []; for (let i = 0; i < 60; i++) bars.push({ o: 100, h: 101, l: 99, c: 100 + Math.sin(i / 5), t: 1e12 + i * 3e5, v: 10 });
  const win = Object.assign({
    document: { hidden: true, readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    setInterval() {}, setTimeout() {},
    DATA: bars, IND: { _sw: { hi: [55], lo: [50] }, atr: () => bars.map(() => 0.5), _rsi: [], adx: () => bars.map(() => 20) },
    CURSYM: { sym: 'BTCUSD', cls: 'crypto' },
    analystContext: () => ({ price: 100, atr: 0.5, rep: { score: 1, label: 'Long' }, reg: { regime: 'Ranging / low ADX' } }),
    localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
    STORE: null,
  }, world || {});
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  return win;
}

console.log('\n=== v39.8 SNIPER STATE MACHINE ===\n');
const W = loadSniper();
const S = W.sniper;

const x = W.analystContext();
const pl = S.planFrom(x);
ok('planFrom: LONG plan has stop below entry, targets above', pl.dir === 'LONG' && pl.stop < pl.entryLo && pl.t1 > pl.price && pl.t2 > pl.t1);
ok('planFrom: 2R target is twice the 1R distance',
  Math.abs((pl.t2 - pl.price) - 2 * (pl.t1 - pl.price)) < 1e-9);

/* checklist: clean world => all green */
W.window._oflow = { spread: { ask: 100.02, bid: 100.00 } };   // $0.02 on 100 = fine for crypto
W.window._macroCal = [];                                       // no event
W.window._sigState = { resolvedStrat: 'VWAP Bounce Scalp' };   // revert strat...
let chk = S.checklist(x, pl);
const byLabel = l => chk.find(c => c.label.indexOf(l) === 0 || c.label.indexOf(l) >= 0);
/* revert strat in a Ranging regime => regime MATCHES (green) */
ok('checklist: mean-revert strat in Ranging regime = regime check GREEN', byLabel('regime').ok === true);
ok('checklist: no event => news check GREEN', byLabel('news').ok === true);
ok('checklist: tight spread => spread GREEN', byLabel('spread').ok === true);

/* the HARD GATE: a red news item must exist within 30m */
W.window._macroCal = [{ t: new Date(Date.now() + 12 * 60000).toISOString(), n: 'CPI' }];
chk = S.checklist(x, pl);
ok('checklist: event in 12m => news check RED (the hard-block trigger)', byLabel('news').ok === false);

/* regime conflict: a TREND strategy in a Ranging regime must go red */
W.window._sigState = { resolvedStrat: 'Stop-Run Reclaim' };    // trend-nature strat
chk = S.checklist(x, pl);
ok('checklist: trend strat in Ranging regime = regime check RED', byLabel('regime').ok === false);

console.log('\n=== v39.8 SHIPPED CONTRACT ===\n');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('Sniper card ships and mounts first in #side', idx.includes("id = 'sniperCard'") && idx.includes('side.insertBefore(card, side.firstChild)'));
ok('four verdict states exist', idx.includes("'TRADE'") && idx.includes("'STAND DOWN'") && idx.includes("'CONFLICT'") && idx.includes("'ARM'"));
ok('HARD BLOCK: any red checklist item => STAND DOWN (user choice)',
  idx.includes('live && redItems.length') && idx.includes("state = 'STAND DOWN'"));
ok('plan is greyed unless state is TRADE', idx.includes("planLive = (state === 'TRADE')") && idx.includes("planStyle = planLive ? '' : 'opacity:.5'"));
ok('risk is TYPED per session — no hidden default', idx.includes('type session risk') && idx.includes('sniper.risk.session'));
ok('TRUST line always shows the record (no oracle)', idx.includes('TRUST:') && idx.includes('A verdict without its receipts is an oracle'));
ok('CONFLICT names the split (not hidden)', idx.includes('strategy \u2019 + pl.dir'.replace('\u2019','') ) || idx.includes("'strategy ' + pl.dir + ' vs macro '"));
ok('the honest footer disclaims certainty', idx.includes('not that the trade will win'));
ok('no auto-execution promised', idx.includes('No auto-execution'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
