/* v39.18 — MTF-switch bug fix, order-flow live read, decision engine UI, news wiring, perf gate. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };

console.log('\n=== v39.18 FEATURES ===\n');

// MTF bug: two separate containers, each renderer targets its own
ok('MTF: split into #mtfBias + #mtfAuto (no more shared #mtfDash battleground)',
   idx.includes('id="mtfBias"') && idx.includes('id="mtfAuto"'));
ok('MTF: bias renderer -> #mtfBias, auto-fib renderer -> #mtfAuto',
   idx.includes("getElementById('mtfBias')") && idx.includes("getElementById('mtfAuto')"));
ok('MTF: nav renders both so the page no longer flips',
   /if\(v==='mtf'\)\{renderMTFDash\(\);try\{renderMTFAuto/.test(idx));

// perf gate on renderMTF (was 8x genData every tick, even hidden)
ok('PERF: renderMTF gated to visible + throttled (2s)',
   idx.includes('_mtfLast') && idx.includes('now-_mtfLast<2000'));

// order-flow live read
ok('OF: live read panel present (#l2Read + renderRead)',
   idx.includes('id="l2Read"') && idx.includes('function renderRead'));
ok('OF: book pressure + short-term lean + taker flow',
   idx.includes('book pressure') && idx.includes('short-term lean') && idx.includes('taker flow'));
ok('OF: CVD + absorption added', idx.includes('CVD') && idx.includes('absorption'));
ok('OF: exposes window._ofRead for the decision engine', idx.includes('window._ofRead'));
ok('OF: honest — labeled pressure, not a prediction', idx.includes('NOT a price prediction'));

// decision engine UI (calls the Python engine)
ok('DEC: Live Decision panel (#decideOut + decideNow)',
   idx.includes('id="decideOut"') && idx.includes('function decideNow') || idx.includes('async function decideNow'));
ok('DEC: posts live state to the Python engine /svc/analyst', idx.includes('/svc/analyst'));
ok('DEC: renders bias/conviction/gates/why/invalidation', idx.includes('function renderDecision') && idx.includes('WHAT WOULD FLIP IT'));

// news wiring — feeds the whole app, auto-loads
ok('NEWS: parsed calendar feeds window._macroCal; headlines feed window._newsFeed',
   idx.includes('window._macroCal=items') && idx.includes('window._newsFeed=items'));
ok('NEWS: auto-loads configured sources (autoNews on boot + timer)',
   idx.includes('function autoNews') && idx.includes('autoNews()'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
