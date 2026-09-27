/* =====================================================================
   test_v397_wiring.js — W-fixes + A-wiring, pure logic where possible.
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
function loadModule(pattern, extra) {
  const code = fs.readFileSync(resolve(pattern), 'utf8');
  const store = {};
  const win = Object.assign({
    STORE: { get: k => store[k], set: (k, v) => { store[k] = v; } },
    localStorage: { getItem: k => store[k], setItem: (k, v) => { store[k] = v; } },
    document: { hidden: true, readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    setInterval() {}, fetch: () => ({ then: () => ({ catch() {} }), catch() {} }),
  }, extra || {});
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  return win;
}

console.log('\n=== v39.7 BRAIN FEATURE WIRING ===\n');
const W = loadModule('signal-brain');
const Brain = W.Brain;

/* backward compatibility: old persisted weights lack the new keys — must not throw */
ok('new FEATS present (strat buckets, news, anom)',
  Brain._FEATS.includes('strat0') && Brain._FEATS.includes('news') && Brain._FEATS.includes('anom'));
const f1 = Brain.features({ q: 60, dir: 1, sess: 'London' }, { strat: 'VWAP Bounce Scalp' });
ok('A2: exactly one strategy bucket lights up', ['strat0','strat1','strat2','strat3'].filter(k => f1[k] === 1).length === 1);
const f1b = Brain.features({ q: 60, dir: 1 }, { strat: 'VWAP Bounce Scalp' });
ok('A2: same strategy -> same bucket (stable hash)',
  ['strat0','strat1','strat2','strat3'].find(k => f1[k] === 1) === ['strat0','strat1','strat2','strat3'].find(k => f1b[k] === 1));
ok('A3: red news inside 30m = -1 penalty feature', Brain.features({ dir: 1 }, { newsMin: 12 }).news === -1);
ok('A3: news at 90m = no penalty', Brain.features({ dir: 1 }, { newsMin: 90 }).news === 0);
ok('A5: calm market (iforest .3) = 0', Brain.features({ dir: 1 }, { anom: 0.3 }).anom === 0);
ok('A5: weird market (iforest .8) penalizes', Brain.features({ dir: 1 }, { anom: 0.8 }).anom < 0);
ok('A1: dna feature reads a published stat', Brain.features({ dir: 1 }, { dna: 0.61 }).dna > 0);
ok('scoring with old-style ctx (none of the new keys) does not throw',
  (() => { try { Brain.score({ q: 55, dir: 1 }, {}); return true; } catch (e) { return false; } })());

console.log('\n=== v39.7 W2 DAILY RESAMPLE (via shipped page source) ===\n');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('W2: trendDays over DAILY buckets shipped (no more 30-rows=30h labeled /30d)',
  idx.includes('function trendDays') && idx.includes('Math.floor(r.t / 86400)'));
ok('W2: short history prints its ETA, not a bare dash', idx.includes("'needs ' + m2t.need + ' more days'"));
ok('W1: DXY read from BAR_CACHE with source cited', idx.includes("k.indexOf('DXY|') === 0") && idx.includes('computed FX basket'));
ok('W1: no CODE reads window._dxy anymore (the comment documenting the bug may)',
  !idx.includes('window._dxy !=') && !idx.includes('window._dxy!=') && !idx.includes('window._dxyDir'));
ok('W3: blank rows carry WHY BLANK from collector errors', idx.includes('WHY BLANK'));
ok('W4: expand hook nudges the pipeline + honest empty message', idx.includes('fills from the chart pipeline'));
ok('A4: morning read composed from on-screen numbers', idx.includes('a briefing, never a prediction'));
ok('A6: Kelly-lite hint prints its arithmetic, info-only', idx.includes('quarter-Kelly') && idx.includes('INFO-ONLY'));
ok('A3: NEWS badge on the brain line', idx.includes('\\u26a1NEWS') || idx.includes('⚡NEWS'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
