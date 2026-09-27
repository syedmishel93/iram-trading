/* =====================================================================
   test_v391_boot.js — THE LIVE-DOM AUDIT (jsdom, scripts ON).

   test_v391_dom.js asserts the STATIC page; this one BOOTS it. The
   difference caught, in one run: three id="" husks created by a chip
   rotator, a version tag injecting its own margin-left:auto (tearing the
   bar in half), and legacy badges appending loose after the risk hero.
   Source-string tests can never see any of that, because the DOM they
   would need to inspect does not exist until the injectors run.

   Network, canvas, storage and speech are stubbed: this asserts DOM
   surgery, not data. fetch() hangs forever on purpose — a boot test that
   needs the network is a flaky test.
   ===================================================================== */
const fs = require('fs');
const path = require('path');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) {
  console.log('  SKIP jsdom not installed — run `npm i jsdom` to enable the DOM audit (it caught 5 real bugs; do not leave it off)');
  process.exit(0);
}

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};

const dom = new JSDOM(html, {
  runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/',
  beforeParse(w) {
    w.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
    w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    w.indexedDB = { open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null }) };
    w.WebSocket = function () { this.close = () => {}; this.send = () => {}; };
    w.fetch = () => new Promise(() => {});
    w.requestAnimationFrame = () => 0;
    w.SpeechSynthesisUtterance = function () {};
    w.speechSynthesis = { speak() {}, cancel() {} };
  }
});

setTimeout(() => {
  console.log('\n=== v39.1 BOOT AUDIT (live DOM, injectors included) ===\n');
  const d = dom.window.document;

  /* 1. ids stay unique THROUGH boot — the static test cannot see injected ones */
  const seen = {};
  d.querySelectorAll('[id]').forEach(e => { if (e.id) seen[e.id] = (seen[e.id] || 0) + 1; });
  const dups = Object.entries(seen).filter(([, n]) => n > 1).map(([k, n]) => k + ' x' + n);
  ok('no duplicate ids after boot (caught aiClear x2 in the first run)', dups.length === 0, dups.join(', '));

  /* 2. no id="" husks — el.id='' leaves an attribute that still matches [id] */
  ok('no empty-string ids (the retired chip rotator left three)', d.querySelectorAll('[id=""]').length === 0);

  /* 3. the status bar contract survives the injectors */
  const st = d.querySelector('.status');
  ok('.status exists after boot', !!st);
  if (st) {
    const kids = [...st.children];
    ok('risk hero (.st-grp.push) is the LAST status child in the DOM',
      kids.length > 0 && kids[kids.length - 1].classList.contains('push'),
      'last is ' + (kids[kids.length - 1].id || kids[kids.length - 1].className));
    const autos = [...st.querySelectorAll('*')]
      .filter(e => /margin-left:\s*auto/.test(e.getAttribute('style') || ''));
    ok('exactly ONE runtime element owns margin-left:auto (#stSlot)',
      autos.length === 1 && autos[0].id === 'stSlot',
      autos.map(e => e.id || e.className).join(', '));
  }

  /* 4. the context chips are all VISIBLE — the 5s rotation is retired */
  const wraps = ['stBars', 'stRegime', 'stAtr']
    .map(id => d.getElementById(id)).filter(Boolean).map(e => e.parentElement);
  ok('Bars / Regime / ATR all visible (information does not rotate away mid-read)',
    wraps.length === 3 && wraps.every(w => w.style.display !== 'none'));

  /* 4b. v39.4 — THE DELEGATION CONTRACT. v39.1 attached listeners to every
     <h3>; renderers that rebuilt card innerHTML destroyed them, and the sticky
     hero intercepted clicks on headers scrolled beneath it. Both fixed with one
     delegated listener on #side. This assertion performs the killer scenario:
     rebuild a card's ENTIRE innerHTML, then click its header. */
  {
    const side = d.getElementById('side');
    const cards = [...side.children].filter(c => c.classList.contains('card'));
    const victim = cards.find(c => c.classList.contains('collapsed') && !c.classList.contains('hero'));
    if (victim) {
      victim.innerHTML = victim.innerHTML;                       // destroys per-node listeners
      const before = victim.classList.contains('collapsed');
      victim.querySelector('h3').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      ok('card headers expand AFTER an innerHTML rebuild (delegated, unkillable)',
        victim.classList.contains('collapsed') !== before);
    } else ok('a collapsed non-hero card exists to test', false);
    const hero = side.querySelector('.card.hero');
    ok('hero is first-in-flow (sticky removed — it intercepted clicks beneath it)',
      hero && cards[0] === hero);
  }

  /* 4c. v39.6 Z2 — THE EXACT REPORTED FAILURE, simulated by name. The user
     listed MTF / Position sizer / Quick trade / AI Vision / Desk Narrator as
     dead. Each is clicked THROUGH a wrapper that calls stopPropagation() in
     the bubble phase — the capture-phase document listener must not care. */
  {
    const side = d.getElementById('side');
    const names = ['MTF', 'Position sizer', 'Quick trade', 'AI Vision', 'Desk Narrator', 'Macro drivers'];
    const cards = [...side.querySelectorAll('.card')];
    names.forEach(nm => {
      const c = cards.find(x => { const h = x.querySelector('h3'); return h && h.textContent.includes(nm); });
      if (!c) { ok('Z2[' + nm + ']: card exists', false); return; }
      if (c.classList.contains('hero')) { ok('Z2[' + nm + ']: (hero, always open)', true); return; }
      c.addEventListener('click', e => e.stopPropagation());          // the killer, installed on purpose
      const h = c.querySelector('h3');
      const before = c.classList.contains('collapsed');
      h.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      ok('Z2[' + nm + ']: toggles THROUGH a stopPropagation wrapper',
        c.classList.contains('collapsed') !== before);
    });
  }

  /* 5. both clocks exist and are distinct */
  ok('#stClock (Jobs X-ray) and #stWall (wall clock) are separate elements',
    !!d.getElementById('stClock') && !!d.getElementById('stWall'));

  dom.window.close();
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}, 5600);
