/* v39.12 — the three fixes from the screenshot report:
   A) ONE spec-driven unit resolver — a $64k crypto stop is "$157", never "15,741 pips"
   B) tick bus — read-only cards move with the tape, not a 4–6s clock
   C) docked live bar — full-width, always visible, in the tabbar row (not buried in #side)
   Runs against the SHIPPED index.html. No copies of the code under test. */
const fs = require('fs');
const vm = require('vm');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };

console.log('\n=== v39.12 A · SPEC-DRIVEN UNIT RESOLVER ===\n');

ok('A0: resolver shipped (window.symUnit + symSpecNow)',
   idx.includes('window.symUnit=function') && idx.includes('function symSpecNow('));

/* the exact bug class must be gone from the sniper: no pip guessed from price */
ok('A1: the v39.11 price-guess is gone (no "x.price > 50 ? .. / 0.01")',
   !/x\.price\s*>\s*50\s*\?\s*[^;]*\/\s*0\.0?1/.test(idx));

/* extract the two resolver functions from the shipped bundle and exercise them */
const a = idx.indexOf('function symSpecNow(');
const b = idx.indexOf('function populateSymbols(', a);
const resolverSrc = idx.slice(a, b);
function run(cursym, sel, px) {
  const SPECS = {
    BTCUSD: { name: 'BTC/USD', cls: 'crypto', pip: 1, contract: 1, px: 68420 },
    XAUUSD: { name: 'Gold', cls: 'metal', pip: 0.01, contract: 100, px: 2352 },
    EURUSD: { name: 'EUR/USD', cls: 'forex', pip: 0.0001, contract: 100000, px: 1.0842 },
    USDJPY: { name: 'USD/JPY', cls: 'forex', pip: 0.01, contract: 100000, px: 156.30 }
  };
  const sandbox = { SPECS, CURSYM: cursym, isFinite, window: {},
    document: { getElementById: (id) => id === 'symSel' ? { value: sel } : null } };
  vm.createContext(sandbox);
  vm.runInContext(resolverSrc, sandbox);
  return sandbox.window.symUnit(px);
}
/* the actual screenshot: BTC, class momentarily reads 'forex' */
const btcGuarded = run({ sym: 'BTCUSD', cls: 'forex' }, 'BTCUSD', 64706.6);
ok('A2: BTC (cls flipped to forex) resolves via SPEC -> crypto', btcGuarded.cls === 'crypto');
ok('A3: BTC $157-style distance, NOT pips ("$" and no "pips")',
   btcGuarded.distFmt(157.4).indexOf('$') === 0 && btcGuarded.distFmt(157.4).indexOf('pips') < 0);
ok('A4: BTC pip is 1 (from spec), price shown at 1dp', btcGuarded.pip === 1 && btcGuarded.pxDec === 1);

/* last-resort guard: a >1000 asset with NO recoverable spec is still never 0.01-pip forex */
const noSpec = run({ cls: 'forex', sym: null }, null, 64000);
ok('A5: >1000 unknown asset guarded to points, not forex pips',
   noSpec.ptsLike === true && noSpec.distFmt(157).indexOf('$') === 0);

/* other classes stay correct */
const eur = run({ sym: 'EURUSD', cls: 'forex' }, 'EURUSD', 1.0842);
ok('A6: EURUSD is real pips at 0.0001', eur.pip === 0.0001 && eur.distFmt(0.0025).indexOf('pips') > 0);
const gold = run({ sym: 'XAUUSD', cls: 'metal' }, 'XAUUSD', 2352);
ok('A7: gold is points at 2dp', gold.cls === 'metal' && gold.pxDec === 2 && gold.distFmt(1.5).indexOf('pts') > 0);
const jpy = run({ sym: 'USDJPY', cls: 'forex' }, 'USDJPY', 156.30);
ok('A8: USDJPY pip is 0.01 (from spec, not a price guess)', jpy.pip === 0.01);

console.log('\n=== v39.12 B · TICK BUS ===\n');

ok('B0: bus shipped (window.Tick + window.onTick)',
   idx.includes('window.Tick=') && idx.includes('window.onTick=window.Tick.on'));
ok('B1: rAF-batched dispatch (one repaint per frame)', idx.includes('requestAnimationFrame(flush)'));
ok('B2: every feed drives it — renderQuick emits the tick',
   /function renderQuick\(\)\{[^]*?Tick\.emit\(curPrice\(\)\)/.test(idx));
ok('B3: sniper + watchlist subscribe with a price-changed guard',
   (idx.match(/window\.onTick\(function \(px\)/g) || []).length >= 2);
ok('B4: bus defined ABOVE the ops-spine banner (marker-grab still lands on Clock)',
   idx.indexOf('window.Tick=') < idx.indexOf('v35.0 OPERATIONAL SPINE'));

console.log('\n=== v39.12 C · DOCKED LIVE BAR ===\n');

ok('C0: still the #newsTicker element (N1 anchor preserved)', idx.includes("bar.id = 'newsTicker'"));
ok('C1: docked into the tabbar row, not buried in #side',
   idx.includes("var host = $('tabbar')") && idx.includes('host.appendChild(bar)'));
ok('C2: fixed feed-dot + scrolling tape (full ticker)',
   idx.includes('class="lb-fixed"') && idx.includes('class="lb-tape"'));
ok('C3: full-width docked CSS (display:flex, width:100%) + kept tkscroll',
   /#newsTicker\{[^}]*display:flex[^}]*width:100%/.test(idx) && idx.includes('tkscroll'));
ok('C4: ws-health dot with amber/red staleness (S3)',
   idx.includes('lb-dot-amb') && idx.includes('lb-dot-red'));
ok('C5: honest empty states (no fabrication)',
   idx.includes('tape quiet') && idx.includes('warming up'));
ok('C6: prices via the resolver-aware dp (no forex-pip error on crypto chips)',
   idx.includes('function dpOf('));
ok('C7: current symbol priced from live DATA/curPrice, others scan sym|* (v39.13)',
   idx.includes('function curQuote(') && idx.includes('function otherQuote('));
ok('C8: session published globally so every surface reads it (fixes "sess —")',
   idx.includes('window._session=sess()') || idx.includes('window._session = sess()'));
ok('C9: tabbar grid row is auto so the docked bar has room (was fixed --tabs-h, clipped it)',
   /grid-template-rows:var\(--top-h\) auto 1fr var\(--status-h\) !important/.test(idx) &&
   !/grid-template-rows:var\(--top-h\) var\(--tabs-h\) 1fr/.test(idx));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
