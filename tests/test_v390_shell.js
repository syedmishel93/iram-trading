/* =====================================================================
   test_v390_shell.js — THE LINT THAT STOPS THE STRATA GROWING BACK

   Thirty-eight builds deposited ten `.app` grids, twelve `.rail` rules and
   two contradictory `--status-h` values. Nobody added those on purpose; each
   one was a reasonable local fix. The only thing that stops the next twenty
   builds doing it again is a test that goes RED.

   This test asserts the SHIPPED index.html, not a copy of it.
   ===================================================================== */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(FILE, 'utf8');
const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));
const body = html.slice(html.indexOf('<body'));
const markup = body.replace(/<script[\s\S]*?<\/script>/g, '');   // markup only, no JS

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};

console.log('\n=== v39.0 SHELL / DESIGN SYSTEM ===\n');

/* ---- 1. the shell layer exists and is LAST (source order = authority) ---- */
ok('v39 shell layer present', css.includes('v39.0 — SHELL'));
ok('v39 shell layer is the last CSS in the file',
  css.lastIndexOf('v39.0 — SHELL') > css.lastIndexOf('INTERFACE REBUILD'),
  'a later stratum was appended after the shell layer — it now silently overrides it');

/* ---- 2. the tokens resolve to the v39 geometry (the LAST decl wins) ---- */
const lastVal = (name) => {
  const m = [...css.matchAll(new RegExp('--' + name + '\\s*:\\s*([^;}]+)', 'g'))];
  return m.length ? m[m.length - 1][1].trim() : null;
};
ok('--top-h    = 44px (was 56)', lastVal('top-h') === '44px', 'got ' + lastVal('top-h'));
ok('--tabs-h   = 30px (was 40)', lastVal('tabs-h') === '30px', 'got ' + lastVal('tabs-h'));
ok('--status-h = 34px (was 28 AND 24 — two decls, winner decided by source order)',
  lastVal('status-h') === '34px', 'got ' + lastVal('status-h'));
ok('--side-w   = 320px (was 344)', lastVal('side-w') === '320px', 'got ' + lastVal('side-w'));
ok('--ctl-h    = 28px (was 34)', lastVal('ctl-h') === '28px', 'got ' + lastVal('ctl-h'));

/* ---- 3. NO EMOJI IN THE CHROME ---- */
/* 61 distinct pictographs shipped in the tab bar, context menu, panel headers
   and theme picker. They cannot be recoloured by a theme and they rasterise
   differently on every OS. Geometric glyphs (▾ → ✕ ⌘ ●) are typography and stay. */
// The exclusions are deliberate, not laziness:
//   ★ U+2605 / ☆ U+2606  — monochrome text glyphs. They inherit currentColor, they
//                          rasterise identically on every OS, and every trading
//                          platform on earth uses ★ for "favourite". They carry
//                          information here (curated theme, saved strategy, follow).
//   ✓ U+2713 / ✕ U+2715 / ✗ U+2717 — pass/fail marks. Same argument.
// A colour emoji cannot be themed and renders differently on every machine. That —
// not "is it a symbol" — is the line this test is drawing.
const PICTO = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{2604}\u{2607}-\u{2712}\u{2714}\u{2716}\u{2718}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
const emoji = markup.match(PICTO) || [];
ok('zero emoji in the shell markup', emoji.length === 0,
  emoji.length + ' found: ' + [...new Set(emoji)].join(' '));

/* ---- 4. the honesty bug ---- */
/* "· synthetic data ·" was hardcoded into the status bar. From v36 — the moment
   MT5 became a provider — that string was FALSE on every real tick, and it
   contradicted the project's own honesty contract in the one place the user
   looks 500 times a day. It is now a tag derived from Fresh.state(). */
// v39.1 — scope narrowed: the BUG was the hardcoded CLAIM in the status-bar
// MARKUP, false whenever MT5 was live. The string legitimately survives in
// Fresh.why()'s offline warning (derived + true when shown) and in comments
// documenting the fix. Assert the bar, not the corpus.
{
  const statusHtml = (markup.match(/<div class="status"[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
  ok('the hardcoded "synthetic data" claim is gone from the status-bar markup',
    statusHtml.length > 0 && !statusHtml.includes('synthetic data'));
}
ok('#stMode tag exists and is derived, not asserted',
  markup.includes('id="stMode"') && html.includes('Fresh.state()'));

/* ---- 5. the status bar tells the truth, and all 16 legacy ids survive ---- */
const ids = ['srcPick', 'srcLive', 'stFeed', 'stBars', 'stRegime', 'stAtr', 'stCost', 'stCostWrap',
  'stGov', 'stGovWrap', 'stFresh', 'stFreshWrap', 'stClock', 'stClockWrap', 'stSync', 'stSyncWrap'];
const lost = ids.filter(i => !markup.includes('id="' + i + '"'));
ok('all 16 pre-v39 status ids preserved (existing writers still land)', lost.length === 0, 'lost: ' + lost);

// v39.1 A7: topDayR/topOpenR removed on purpose — DAY/OPEN live in the status
// bar alone (one home per number). The top chip carries SPREAD only.
const NEW = ['stMode', 'stOpenR', 'stDayR', 'stCapBar', 'topSpread', 'topAcctTag'];
const missing = NEW.filter(i => !markup.includes('id="' + i + '"'));
ok('new risk/spread fields present', missing.length === 0, 'missing: ' + missing);

ok('status bar has 3 weighted clusters, not 9 flat chips',
  (markup.match(/class="st-grp/g) || []).length >= 3);

/* ---- 6. the three offsets that were pinned to a 56px top bar ---- */
/* .side-resizer / .side-collapse / .side-reopen hardcoded top:56px / 63px / 76px.
   ANY change to --top-h silently broke all three, with no test to catch it. */
const shell = css.slice(css.lastIndexOf('v39.0 — SHELL'));
['side-resizer', 'side-collapse', 'side-reopen'].forEach(c => {
  ok(c + ' is re-based on var(--top-h)', new RegExp('\\.' + c + '\\{[^}]*var\\(--top-h\\)').test(shell.replace(/\s+/g, '')));
});

/* ---- 7. matte, not glass ---- */
ok('backdrop-filter neutralised on every shell surface',
  /backdrop-filter:\s*none\s*!important/.test(shell));
ok('the 9s infinite gold->blue top-bar sweep is off',
  /\.top::after\{\s*display:none\s*!important/.test(shell.replace(/\s+/g, ' ')));
ok('body aurora radials removed', /body\{[^}]*background:var\(--ink\)\s*!important/.test(shell.replace(/\s+/g, '')));

/* ---- 8. contrast ---- */
/* --muted2 was #566072 on --panel #141922 = 2.78:1. WCAG AA body text needs 4.5.
   It is the colour of every secondary label in the app. */
const lum = (h) => {
  const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255)
    .map(v => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const darkM2 = (shell.match(/html\[data-theme\]\{\s*--muted2:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
ok('--muted2 (dark) passes WCAG AA on --panel (was #566072 = 2.78:1)',
  darkM2 && ratio(darkM2, '#141922') >= 4.5,
  darkM2 + ' = ' + (darkM2 ? ratio(darkM2, '#141922').toFixed(2) : '?') + ':1');
const lightM2 = (shell.match(/html\[data-theme="frost"\]\{\s*--muted2:\s*(#[0-9A-Fa-f]{6})/) || [])[1];
ok('--muted2 (light themes) passes WCAG AA on a light panel',
  lightM2 && ratio(lightM2, '#F2F4F8') >= 4.5,
  lightM2 + ' = ' + (lightM2 ? ratio(lightM2, '#F2F4F8').toFixed(2) : '?') + ':1');

/* ---- 9. the dead rail stays dead and stays honest ---- */
/* #rail{display:none!important} since v25.0. Twelve CSS strata and 21 nav
   buttons render nothing. Left inert on purpose (the command palette and
   several JS paths still query .nav[data-view]); asserted so nobody "fixes"
   the rail CSS again believing it ships. */
ok('the left rail is still explicitly dead (documented, not accidental)',
  css.includes('#rail{display:none!important}'));

/* ---- 10. focus is visible ---- */
ok(':focus-visible ring defined (baseline was 2 aria attrs in 1,739 elements)',
  /:focus-visible\{[^}]*outline:/.test(shell.replace(/\s+/g, '')));

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
