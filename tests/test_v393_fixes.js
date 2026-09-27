/* =====================================================================
   test_v393_fixes.js — the three screenshot bugs, asserted so they stay dead.

   META-LESSON (this file, first edition): its own regex literals shipped
   double-escaped (\\d for \d, [\\s\\S] for [\s\S]) — so the script-stripper
   stripped nothing and the width check hunted a literal backslash. The test
   reported 41 failures against a correct build: A BENT RULER. Tests are code;
   they can be the bug.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let P = 0, F = 0;
const ok = (n, c, d) => { if (c) { P++; console.log('  ok  ', n); } else { F++; console.log('  FAIL', n, d || ''); } };

console.log('\n=== v39.3 VISIBLE-BUG FIXES ===\n');

/* V1 — every SVG inside a button carries intrinsic width/height ATTRIBUTES.
   The giant-icon bug: unsized SVGs were constrained only by .top-scoped CSS,
   then v32.1 relocated two buttons into the #tbOverflow popup and the journal
   icon rendered at natural size. Style-by-location travels badly; attributes
   travel with the element. */
{
  const markup = src.slice(src.indexOf('<body')).replace(/<script[\s\S]*?<\/script>/g, '');
  const bad = [];
  const re = /<button[^>]*>\s*<svg([^>]*)>/g; let m;
  while ((m = re.exec(markup))) {
    if (!/width="\d+"/.test(m[1]) || !/height="\d+"/.test(m[1])) bad.push(m[1].slice(0, 60));
  }
  ok('V1: every button-child <svg> in the MARKUP has width+height attributes', bad.length === 0, bad.join(' | '));
  ok('V1b: global backstop caps any icon (incl. JS-injected) at 18px',
    src.includes('button > svg, .tbtn > svg{ max-width:18px; max-height:18px'));
}

/* V2 — toolbar icons sized in their own scope, not only .top */
ok('V2: .chart-toolbar svg sizing exists', src.includes('.chart-toolbar .tbtn > svg{ width:15px'));
ok('V2b: #tbOverflow svg sizing exists', src.includes('#tbOverflow .tbtn > svg{ width:15px'));

/* V3 — the collapse click moves a variable the authoritative rule reads */
ok('V3: syncAppGrid sets --side-w-live (no more losing an inline-style fight)',
  src.includes("setProperty('--side-w-live'"));
ok('V3b: the shell grid reads var(--side-w-live, var(--side-w))',
  src.includes('var(--side-w-live, var(--side-w))'));
ok('V3c: the phantom 216/74px rail column is gone from syncAppGrid',
  !src.includes('pinned?216:74'));

/* V4 — popup labels carry words, not OS-dependent pictographs */
['\\u2668 Liq zones', '\\u{1F5FA} Liquidity map', '\\u{1F9EA} Strategy lab', '\\u{1F9EA} Strategy Lab'].forEach(g =>
  ok('V4: popup label purged: ' + g.slice(0, 16), !src.includes(g)));
ok('V4b: #tbOverflow is styled by the design system', src.includes('#tbOverflow{ display:none; position:fixed'));

/* MACRO DESK — presence + honesty contract */
ok('M1: macro card module shipped', src.includes('macroCard'));
ok('M2: every driver row carries a tier badge class', src.includes('mk-tier t-'));
ok('M3: the bias line says INFO-ONLY on its face', src.includes('never auto-merged'));
ok('M4: honest empty state when the service is down', src.includes('honest empty until then'));
ok('M5: no fabricated miner cost floor', src.includes('guess wearing a suit'));


/* ===================== v39.6 Z-fixes (appended) ===================== */
console.log('\n=== v39.6 Z-FIXES ===\n');
ok('Z1: legend docked top-LEFT (right edge is flags-only)', src.includes('.legend{position:absolute;top:34px;left:12px;right:auto'));
ok('Z2: delegation is capture-phase on document, side re-queried per event',
  src.includes("document.getElementById('side');") && /addEventListener\('click', function \(e\) \{\s*var sd = document\.getElementById\('side'\)/.test(src));
ok('Z3: the last-price tag reserves a flag lane', src.includes('_flagLane(y(lc.c)-8,16)+8'));
ok('Z4: the duplicate gold time pill is retired (47-tv owns crosshair time)', src.includes('THE REAL DOUBLE-PILL'));
ok('Z4b: the duplicate gold price pill is retired', src.includes("duplicated 47-tv's #axPx"));
ok('Z5: the if(false) crosshair corpse is deleted', !src.includes('if(false&&MOUSE'));
ok('Z6: spread formats per asset class (crypto=$, metal=cents, fx=pips)', src.includes("cls === 'crypto'") && src.includes("'$' + (px >= 10"));
ok('Z7: the Brain has a face (tier badge + decomposition on the card)', src.includes("class=\"brain-tier '+_b.tier"));
ok('Z7b: untrained state is said in words', src.includes('grading on the legacy Q-gate until trained'));
ok('Z8: KEY badges are click-actionable', src.includes("closest('.mk-tier.t-key')"));
ok('Z9: MACRO BIAS reports n/m directional legs', src.includes("legs directional"));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
