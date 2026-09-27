/* v38.0 — FUNCTIONAL PROOF OF THE ★ GATE.
   Not "does the code contain the words" — does it actually REFUSE noise and actually
   PASS a real edge? Both halves matter: a gate that always says no is not a gate,
   it is a broken feature that happens to look principled. */
const fs = require('fs'), vm = require('vm'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let P = 0, F = 0;
const ok = (c, m) => { if (c) { P++; console.log('  ' + m + ' \u2713') } else { F++; console.log('  ' + m + ' \u2717 FAIL') } };

/* pull the SHIPPED overfitting machinery straight out of index.html — one source of truth */
const grabFn = (n) => {
  const i = src.indexOf('function ' + n + '('); if (i < 0) return '';
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1) }
  }
};
const grabConst = (n) => { const m = src.match(new RegExp('const ' + n + '=[^\n]*')); return m ? m[0] : '' };

let code = '';
const NEED = ['_mean', '_std', '_skew', '_kurt', 'normCdf', 'sharpeR',
              '_combos', 'normInv', 'cscvPBO', 'expectedMaxSR', 'deflatedSharpe'];
for (const n of NEED) {
  const f = grabFn(n) || grabConst(n);
  if (!f) { console.log('  SETUP \u2717 missing ' + n); process.exit(1) }
  code += f + '\n';
}
const box = { Math, console }; vm.createContext(box); vm.runInContext(code, box);
ok(true, 'S1: the PBO/DSR machinery loads out of the SHIPPED index.html (not a copy)');

/* a deterministic RNG so this test can never flake */
function mk(seed) { let r = seed; return () => { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff - 0.5 } }

/* ---------------------------------------------------------------------
   CASE 1 — 26 strategies of PURE NOISE.
   Best-of-26 will ALWAYS look like an edge. That is the entire problem.
   --------------------------------------------------------------------- */
console.log('\nCASE 1 \u2014 26 strategies of pure noise (the data-mining trap)');
const rnd = mk(7);
const NOISE = [];
for (let s = 0; s < 26; s++) { const r = []; for (let t = 0; t < 300; t++) r.push(rnd() * 2); NOISE.push(r) }

const pbo = box.cscvPBO(NOISE, 10);
const srs = NOISE.map(r => box.sharpeR(r));
const bi = srs.indexOf(Math.max(...srs));
const dsr = box.deflatedSharpe(NOISE[bi], srs, 300);

ok(srs[bi] > 0, 'N1: the best of 26 noise series has a POSITIVE Sharpe (' + srs[bi].toFixed(3) +
   ') \u2014 it looks like an edge, because a search through noise always finds one');
ok(dsr.sr0 > 0 && Math.abs(srs[bi] - dsr.sr0) < 0.05,
   'N2: E[max] under the null is ' + dsr.sr0.toFixed(3) + ' \u2014 luck ALONE across 26 tries produces almost ' +
   'exactly the "edge" we found. That gap is the whole lie.');
ok(pbo.ok && pbo.pbo > 0.5,
   'N3: PBO = ' + (pbo.pbo * 100).toFixed(0) + '% \u2014 more likely than not an artefact of the search');
ok(dsr.ok && dsr.dsr < 0.90,
   'N4: deflated Sharpe = ' + (dsr.dsr * 100).toFixed(0) + '% \u2014 not distinguishable from the best of 26 coin flips');
const gatedNoise = (pbo.ok && pbo.pbo > 0.5) || dsr.dsr < 0.90;
ok(gatedNoise, 'N5: THE GATE WITHHOLDS THE \u2605. This is the bug that has been shipping since v1.');

/* ---------------------------------------------------------------------
   CASE 2 — one strategy with a REAL, persistent edge among 25 noise ones.
   The gate must not simply refuse everything.
   --------------------------------------------------------------------- */
console.log('\nCASE 2 \u2014 a genuine edge hidden among 25 noise strategies (the control)');
const rnd2 = mk(11);
const MIX = [];
for (let s = 0; s < 25; s++) { const r = []; for (let t = 0; t < 300; t++) r.push(rnd2() * 2); MIX.push(r) }
const real = []; for (let t = 0; t < 300; t++) real.push(rnd2() * 2 + 0.55);   /* persistent positive drift */
MIX.push(real);

const srs2 = MIX.map(r => box.sharpeR(r));
const bi2 = srs2.indexOf(Math.max(...srs2));
const dsr2 = box.deflatedSharpe(MIX[bi2], srs2, 300);

ok(bi2 === MIX.length - 1, 'R1: best-by-Sharpe correctly identifies the genuine strategy');
ok(dsr2.ok && dsr2.dsr >= 0.90,
   'R2: deflated Sharpe = ' + (dsr2.dsr * 100).toFixed(0) + '% \u2014 a REAL edge survives deflation for 26 trials');
ok(srs2[bi2] > dsr2.sr0 * 2,
   'R3: its Sharpe (' + srs2[bi2].toFixed(3) + ') clears E[max] under the null (' + dsr2.sr0.toFixed(3) +
   ') by a wide margin \u2014 unlike the noise case, where they were almost identical');
ok(dsr2.dsr > dsr.dsr,
   'R4: THE GATE DISCRIMINATES \u2014 the real edge scores strictly higher than the noise winner. ' +
   'A gate that refuses everything is not a gate; it is a broken feature that looks principled.');

console.log('\nv38.0 PICKER GATE (functional): ' + P + ' passed, ' + F + ' failed');
process.exit(F ? 1 : 0);
