#!/usr/bin/env node
/* =====================================================================
   v35.0 — SIGNAL WORKER (Node sidecar for mishel_service.py)
   ---------------------------------------------------------------------
   WHY THIS EXISTS
   The 26 strategies live in index.html as JavaScript. Server-side alerting
   needs to run them with the browser CLOSED. There were two options:

     (a) re-implement the 26 strategies in Python  -> TWO sources of truth.
         The day they disagree you do not know which one is lying, and you
         will find out on a live trade. REJECTED.
     (b) run the SHIPPED JavaScript in Node.       -> ONE source of truth.

   This is (b). It extracts the exact shipped text of IND / swings /
   SIG_META / SIG_DETECT / sigScan / sigStats / quality straight out of
   index.html — the same brace-matching extraction the test suite has used
   for 34 versions (tests/_*_src.js) — and evaluates it. Nothing is copied,
   so nothing can drift. If a strategy changes in index.html, this worker
   changes with it on the next tick.

   PROTOCOL
     stdin : {"bars":[{t,o,h,l,c,v}...], "strategies":["emaPull",...],
              "tf":"1h", "qGate":50}
     stdout: {"ok":true, "fired":[{strategy,name,dir,entry,stop,t1,t2,q,
              barT,record:{...}}], "meta":{...}}
   A signal is "fired" only if it sits on the LAST CLOSED bar. History is
   used to compute the measured record, never to raise a stale alert.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = path.join(__dirname, '..', 'index.html');

/* ---- extraction (identical technique to tests/test_v340_alpha.js) ---- */
function braceSlice(src, i) {
  let d = 0, j = i, started = false;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    if (c === '}') { d--; if (started && d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('shipped function missing from index.html: ' + name);
  return braceSlice(src, i);
}
function grabAssign(src, prefix) {
  const i = src.indexOf(prefix);
  if (i < 0) throw new Error('shipped assignment missing from index.html: ' + prefix);
  return braceSlice(src, i);
}

function buildSandbox() {
  const src = fs.readFileSync(HTML, 'utf8');
  const sandbox = {
    window: {}, console, Math, Date, JSON, Number, String, Array, Object, isFinite, isNaN,
    CURSYM: { sym: '', spec: null }, TF: '1h', BAR_CACHE: {}, MODE: 'online'
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  /* IND is declared as a literal, then EXTENDED by 23 top-level one-liners
     (IND.adx=..., IND.flux=..., ...). The test suite stubs adx; the server must
     not — it runs the real one. Pull every extension verbatim. */
  const indExt = src.split('\n')
    .filter(l => /^IND\.\w+\s*=\s*function/.test(l))
    .join('\n');
  if (!/IND\.adx\s*=/.test(indExt)) throw new Error('IND.adx extension not found in index.html');

  const parts = [
    grabAssign(src, 'const IND = {'),                 // the real indicator library — not a stub
    indExt,                                           // + the 23 shipped extensions
    grabFn(src, 'swings'),
    grabAssign(src, 'window.SIG_STRATS={') ,
    grabAssign(src, 'window.SIG_STYLE_TF={'),
    grabFn(src, 'sigStyleForTF'),
    grabAssign(src, 'window.SIG_DETECT={'),
    grabFn(src, 'sigScan'),
    grabFn(src, 'sigStats')
  ];
  // _mean/_std are global const arrows in index.html — some strategies use them.
  const meanI = src.indexOf('const _mean=');
  if (meanI >= 0) parts.unshift(src.slice(meanI, src.indexOf('\n', src.indexOf('const _std=')) + 1));

  vm.runInContext(parts.join(';\n') + ';\n', sandbox, { filename: 'shipped-from-index.html' });
  return sandbox;
}

function main(input) {
  const box = buildSandbox();
  const bars = input.bars || [];
  const tf = input.tf || '1h';
  const qGate = input.qGate == null ? 0 : +input.qGate;
  const strats = (input.strategies && input.strategies.length)
    ? input.strategies
    : Object.keys(box.window.SIG_DETECT);

  box.TF = tf;
  box.CURSYM = { sym: input.sym || '', spec: null };

  if (bars.length < 80) {
    return { ok: false, err: 'need >=80 bars to evaluate honestly, got ' + bars.length, fired: [] };
  }

  /* ---------------------------------------------------------------------
     WHICH BAR COUNTS AS "NOW"?
     The SHIPPED sigScan detect loop is  for(let i=60; i < d.length-1; i++)
     — it deliberately never scans the FINAL element of the array. So a live
     alert on the newest closed bar is only reachable if that bar is not last.

     The caller therefore passes:  [...closed bars, the still-forming bar]
     and lastClosedIdx = closed.length - 1.

     The forming bar is REAL (partial) data used for exactly two things:
       1. a positional tail, so sigScan's loop can reach the last closed bar;
       2. invalidation — if price has ALREADY run the stop intrabar, we do not
          alert. Better a missed alert than an alert into a dead setup.
     Its OHLC never generates a signal of its own (i = last is excluded).
     If lastClosedIdx is absent we default to bars.length-2: the newest bar
     sigScan is capable of seeing. We never invent a bar to reach further.
     --------------------------------------------------------------------- */
  const lastIdx = (input.lastClosedIdx != null) ? (input.lastClosedIdx | 0) : (bars.length - 2);
  if (lastIdx < 60 || lastIdx > bars.length - 1) {
    return { ok: false, err: 'lastClosedIdx out of range', fired: [] };
  }
  const fired = [];
  const meta = {};
  const skipped = [];

  for (const s of strats) {
    if (!box.window.SIG_DETECT[s]) { meta[s] = 'unknown strategy'; continue; }
    let sigs;
    try { sigs = box.sigScan(bars, s); }
    catch (e) { meta[s] = 'scan error: ' + e.message; continue; }
    const stats = box.sigStats(sigs);
    meta[s] = { n: sigs.length, resolved: stats.resolved, winPct: stats.winPct,
                netAvgR: stats.netAvgR, ciLo: stats.ciLo, ciHi: stats.ciHi };

    for (const sg of sigs) {
      if (sg.i !== lastIdx) continue;                 // only the newest closed bar
      if ((sg.q || 0) < qGate) continue;
      if (sg.res === 'stop') {                        // already invalidated intrabar
        skipped.push({ strategy: s, why: 'stop already run intrabar — not alerted' });
        continue;
      }
      fired.push({
        strategy: s,
        name: (box.window.SIG_STRATS[s] || {}).name || s,
        dir: sg.dir > 0 ? 'LONG' : 'SHORT',
        entry: sg.entry, stop: sg.stop, t1: sg.t1, t2: sg.t2,
        q: sg.q, sess: sg.sess, barT: bars[lastIdx].t,
        record: { resolved: stats.resolved, winPct: stats.winPct,
                  netAvgR: stats.netAvgR, ciLo: stats.ciLo, ciHi: stats.ciHi }
      });
    }
  }
  return { ok: true, fired, meta, skipped, lastBarT: bars[lastIdx].t, bars: bars.length,
           strategies: strats.length };
}

/* ---- stdin/stdout ---- */
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => buf += d);
process.stdin.on('end', () => {
  let out;
  try { out = main(JSON.parse(buf || '{}')); }
  catch (e) { out = { ok: false, err: e.message, fired: [] }; }
  process.stdout.write(JSON.stringify(out));
});
/* self-test: `node sig_worker.js --selftest` proves the shipped source loads */
if (process.argv.includes('--selftest')) {
  try {
    const box = buildSandbox();
    const n = Object.keys(box.window.SIG_DETECT).length;
    process.stdout.write(JSON.stringify({ ok: true, strategies: n,
      names: Object.keys(box.window.SIG_DETECT) }));
  } catch (e) { process.stdout.write(JSON.stringify({ ok: false, err: e.message })); }
  process.exit(0);
}
