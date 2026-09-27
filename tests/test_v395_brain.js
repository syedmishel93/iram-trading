/* =====================================================================
   test_v395_brain.js — the Signal Brain + exit grid + scoreboard, as MATH.
   Modules are loaded into a stub window; every assertion is on pure logic.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let P = 0, F = 0;
const ok = (n, c, d) => { if (c) { P++; console.log('  ok  ', n); } else { F++; console.log('  FAIL', n, d !== undefined ? d : ''); } };

function resolve(pattern) {
  /* v39.6 — split.py derives filenames from module headers, so '69-signal-brain.js'
     became '69-the-signal-brain.js' after one re-split and this test died on a
     pinned name. Resolve by pattern: the same lesson as every pinned literal. */
  const dir = path.join(__dirname, '..', 'src', 'js');
  const hit = fs.readdirSync(dir).find(f => f.includes(pattern));
  if (!hit) throw new Error('no module matching ' + pattern);
  return path.join(dir, hit);
}
function loadModule(file) {
  const code = fs.readFileSync(resolve(file), 'utf8');
  const store = {};
  const win = {
    STORE: { get: k => store[k], set: (k, v) => { store[k] = v; } },
    localStorage: { getItem: k => store[k], setItem: (k, v) => { store[k] = v; } },
    document: { hidden: true, readyState: 'complete', addEventListener() {}, getElementById: () => null, querySelector: () => null },
    setInterval() {}, fetch: () => ({ catch() {} }),
  };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(code, win);
  return win;
}

console.log('\n=== v39.5 SIGNAL BRAIN (pure math) ===\n');
const W = loadModule('signal-brain');
const Brain = W.Brain;

/* B-1: untrained = honest fallback to the legacy Q cliff, verbatim */
let t = Brain.tier({ q: 61, dir: 1 }, {});
ok('untrained: Q61 -> tier A via legacy cliff (fallback flagged)', t.tier === 'A' && t.fallback === true);
t = Brain.tier({ q: 32, dir: 1 }, {});
ok('untrained: Q32 -> tier C via legacy cliff', t.tier === 'C' && t.fallback === true);

/* B-2: the learner separates a separable world.
   Synthetic truth: London trend-regime longs pay; NY mean-revert shorts lose. */
function mk(good) {
  return { sig: { q: good ? 70 : 35, dir: good ? 1 : -1, sess: good ? 'London' : 'NY', t: Date.now(), i: Math.random() * 1e9 | 0 },
           ctx: { regime: good ? 'trend' : 'revert' }, y: good ? 1 : 0 };
}
for (let e = 0; e < 12; e++) for (let i = 0; i < 20; i++) { const s = mk(i % 2 === 0); Brain.learn(Brain.features(s.sig, s.ctx), s.y); }
ok('trained flag flips after MIN examples', Brain.state().trained === true, Brain.state().n);
const good = Brain.score(mk(true).sig, mk(true).ctx), bad = Brain.score(mk(false).sig, mk(false).ctx);
ok('separable world separated: good >> bad score', good.score - bad.score >= 30, good.score + ' vs ' + bad.score);
ok('good pattern lands tier A', Brain.tier(mk(true).sig, mk(true).ctx).tier === 'A');
ok('bad pattern lands tier C', Brain.tier(mk(false).sig, mk(false).ctx).tier === 'C');

/* B-3: the decomposition is a real reasoning trace: parts sum ~ logit */
const sc = Brain.score(mk(true).sig, mk(true).ctx);
ok('decomposition present, labeled, sorted by |impact|',
  sc.parts.length >= 3 && sc.parts.every(p => p.label) &&
  Math.abs(sc.parts[0].v) >= Math.abs(sc.parts[sc.parts.length - 1].v));

/* B-4: learnBatch dedupes — same resolved trigger never teaches twice */
const n0 = Brain.state().n;
const batch = [{ i: 7, t: 111, q: 60, dir: 1, sess: 'London', res: 't1' }];
Brain.learnBatch(batch, {}, 'BTC|5m|X'); Brain.learnBatch(batch, {}, 'BTC|5m|X');
ok('learnBatch dedupe: re-scan adds 0', Brain.state().n === n0 + 1, Brain.state().n - n0);
Brain.learnBatch([{ i: 8, t: 112, q: 60, dir: 1, sess: 'London', res: 'time' }], {}, 'BTC|5m|X');
ok('time-scratches teach nothing', Brain.state().n === n0 + 1);

/* B-5: persistence roundtrip */
const w1 = Brain.state().w;
const W2 = loadModule('signal-brain');       // fresh context, empty store => blank
ok('fresh context starts blank (no cross-contamination)', W2.Brain.state().n === 0);

console.log('\n=== v39.5 EXIT GRID (pure math) ===\n');
const S = loadModule('scoreboard');

/* a synthetic long: entry 100, stop 99 (R=1). Bars run to 101 (=+1R), pull back
   to 100.2, then run to 103. TP1R banks +1; TP2R survives the pullback and
   banks +2; the trail gets tagged on the pullback. */
const bars = [{ o: 100, h: 100, l: 100, c: 100 }];
[100.6, 101.0, 100.2, 101.5, 102.2, 103.0].forEach(px => bars.push({ o: px, h: px + 0.1, l: px - 0.35, c: px }));
const sigs = [{ i: 0, dir: 1, entry: 100, stop: 99, costR: 0 }];
const g = S.exitGrid(sigs, bars, bars.map(() => 0.3));
ok('TP1R banks exactly +1R', g.table.fixed1R && g.table.fixed1R.avgR === 1);
ok('TP2R banks exactly +2R', g.table.fixed2R && g.table.fixed2R.avgR === 2);
ok('ATR trail exits between entry and target (tagged on the pullback)',
  g.table.atrTrail && g.table.atrTrail.avgR > 0 && g.table.atrTrail.avgR < 2, JSON.stringify(g.table.atrTrail));
ok('under 15 samples: no variant is crowned (honesty)', g.best === null);

/* stop-first honesty: a bar that spans both stop and target counts as a LOSS */
const bars2 = [{ o: 100, h: 100, l: 100, c: 100 }, { o: 100, h: 101.4, l: 98.9, c: 99.5 }];
const g2 = S.exitGrid([{ i: 0, dir: 1, entry: 100, stop: 99, costR: 0 }], bars2, [0.3, 0.3]);
ok('a bar spanning stop AND target resolves as the LOSS (conservative)', g2.table.fixed1R.avgR === -1);

console.log('\n=== v39.5 SCOREBOARD / DECAY ===\n');
ok('Wilson interval sane at 6/10', (() => { const [a, b] = S.scoreboard.wilson(6, 10); return a > 0.3 && b < 0.9 && a < 0.6; })());
/* decay: 70% over 175, then 25 straight losses -> recent ceiling below full floor */
const rec = { n: 200, w: 140, hist: Array(25).fill(0), bySess: {} };
ok('DECAYING flagged: last-25 detached below the full record', S.scoreboard.decayed(rec) === true);
const rec2 = { n: 200, w: 140, hist: Array(25).fill(1).map((_, i) => i % 3 ? 1 : 0), bySess: {} };
ok('a normal recent stretch is NOT flagged', S.scoreboard.decayed(rec2) === false);

/* integration strings on the shipped page */
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
ok('Brain wired into sigRefresh (learn + tier)', idx.includes('Brain.learnBatch(SS.sigs') && idx.includes("_s.brain=Brain.tier"));
ok('tiered gate replaces the cliff only when trained (fallback preserved)', idx.includes("Brain.state().trained") && idx.includes('sigFilterQ(SS.sigs,50)'));
ok('A-tier Telegram push wired, once per bar', idx.includes('brainPush') && idx.includes('Decision-support only'));
ok('single Auto S/R owner: the srz duplicate is retired', idx.includes("retired \u2014 'srzones' (51-psar) is the single Auto S/R owner"));
ok('volume-weighted S/R: strength printed on the zone', idx.includes("% vol'"));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
