/* =====================================================================
   test_v391_dom.js — THE TEST v39.0 WAS MISSING.

   v39.0 shipped with 1,377 green assertions and a visibly broken status bar.
   Every one of those assertions checked SOURCE STRINGS; not one rendered the
   DOM. This test loads the SHIPPED index.html in jsdom — scripts OFF, so it
   asserts the static contract every injector depends on — and checks the
   things a screenshot checks:

     1. no duplicate ids anywhere in the document (this alone would have
        caught #stClock, dead since v35, and #pLev)
     2. the status bar's landing-zone contract: the anchor selector that six
        modules use to insertBefore() actually matches something
     3. child order: system truth first, risk hero last
     4. exactly ONE element in the bar owns margin-left:auto
     5. the top bar carries no duplicate of DAY/OPEN (they live in the status
        bar alone)
   ===================================================================== */
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('  SKIP jsdom not installed — run `npm i jsdom` to enable the DOM audit (it caught 5 real bugs; do not leave it off)');
  process.exit(0);
}

const FILE = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};

console.log('\n=== v39.1 DOM CONTRACT (jsdom, scripts off) ===\n');

const dom = new JSDOM(html, { runScripts: undefined });   // static DOM only
const doc = dom.window.document;

/* ---- 1. duplicate ids ---------------------------------------------------- */
const seen = new Map();
doc.querySelectorAll('[id]').forEach(el => {
  const id = el.id;
  seen.set(id, (seen.get(id) || 0) + 1);
});
const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => k + ' x' + n);
ok('no duplicate ids in the document (would have caught #stClock, dead since v35)',
  dups.length === 0, 'duplicated: ' + dups.join(', '));

/* ---- 2. the injection anchor exists -------------------------------------- */
/* Six modules do: st.querySelector('.s[style*="margin-left"]') and insertBefore
   into it. v39.0 deleted the node that matched; insertBefore(el,null) became a
   silent appendChild and the bar scrambled. */
const status = doc.querySelector('.status');
ok('.status exists', !!status);
const anchor = status && status.querySelector('.s[style*="margin-left"]');
ok('the legacy injection anchor  .s[style*="margin-left"]  matches an element (#stSlot)',
  !!anchor && anchor.id === 'stSlot',
  anchor ? 'matched ' + (anchor.id || anchor.className) : 'NO MATCH — six insertBefore() calls will silently appendChild');

/* ---- 3. child order: truth first, hero last ------------------------------ */
if (status) {
  const kids = [...status.children];
  ok('first status child is the SYSTEM TRUTH cluster (#stSys)',
    kids[0] && kids[0].id === 'stSys', 'first is ' + (kids[0] && (kids[0].id || kids[0].className)));
  const hero = status.querySelector('.st-grp.push');
  ok('the risk hero (.st-grp.push) is a direct child', !!hero);
  // CSS `order` puts it last visually even if DOM shifts; assert the CSS contract exists.
  ok('CSS pins the hero to order:3 (immune to blind appendChild by future modules)',
    /\.status\s*>\s*\.st-grp\.push\{\s*order:3/.test(html.replace(/\s+/g, ' ')) ||
    html.includes('.status > .st-grp.push{ order:3; }'));
}

/* ---- 4. exactly one margin-left:auto in the bar --------------------------- */
if (status) {
  const autos = [...status.querySelectorAll('[style*="margin-left"]')]
    .filter(el => /margin-left\s*:\s*auto/.test(el.getAttribute('style') || ''));
  ok('exactly ONE element in the status bar owns margin-left:auto',
    autos.length === 1, autos.length + ' found: ' + autos.map(e => e.id || e.className).join(', '));
}

/* ---- 5. DAY/OPEN live in one place --------------------------------------- */
const top = doc.querySelector('.top');
ok('the top bar does NOT duplicate DAY/OPEN (status bar is the risk surface)',
  top && !top.querySelector('#topDayR') && !top.querySelector('#topOpenR'));
ok('the status bar DOES carry stOpenR / stDayR / stCapBar',
  status && !!status.querySelector('#stOpenR') && !!status.querySelector('#stDayR') && !!status.querySelector('#stCapBar'));
ok('the top account chip carries SPREAD (the entry-cost number belongs beside the price)',
  top && !!top.querySelector('#topSpread'));

/* ---- 6. the confluence disclosure ----------------------------------------- */
const det = doc.querySelector('#confDetails');
ok('confluence narrative sits inside a <details> (verdict stays above the fold)',
  !!det && !!det.querySelector('#confSummary') && !!det.querySelector('#agreeLine'));
ok('the disclosure ships CLOSED', det && !det.hasAttribute('open'));

/* ---- 7. the instrument header no longer triples the price ----------------- */
['ihName', 'ihPx', 'ihChg'].forEach(id => {
  const el = doc.getElementById(id);
  ok('#' + id + ' exists (its four writers still land) but is retired from display',
    !!el && el.classList.contains('ih-dead'));
});

/* ---- 8. every id a v39 writer targets exists ------------------------------ */
['stSlot', 'stSys', 'stMode', 'stOpenR', 'stDayR', 'stCapBar', 'topSpread', 'topAcctTag',
  'stFreshWrap', 'stClockWrap', 'stSyncWrap', 'stCostWrap', 'stGovWrap']
  .forEach(id => ok('#' + id + ' present', !!doc.getElementById(id)));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
