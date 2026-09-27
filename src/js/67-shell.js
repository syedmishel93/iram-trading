setTimeout(function(){ if(window.costSync) costSync().then(function(){ renderCostChip() }) }, 3000);
setInterval(function(){ if(window.costSync) costSync().then(function(){ renderCostChip() }) }, 600000);
setInterval(function(){ if(window.renderWithheld) renderWithheld() }, 4000);
/* =====================================================================
   v39.0 — SHELL (the JS half)

   Three jobs, all of them "make the chrome tell the truth":

   1. TOP BAR    — the account chip showed Bal/Eq: two static demo numbers.
                   It now shows day P&L, open risk and the LIVE BROKER
                   SPREAD — the three numbers you cannot open a position
                   without. The spread has existed since v36 (it feeds every
                   strategy's costR) and was displayed nowhere.

   2. STATUS BAR — was nine identical 10px chips, so the freshness contract
                   and the Risk Governor (the only two things that can BLOCK
                   a trade) were the same size as ATR. Now three clusters,
                   weighted, with semantic state colour.

   3. SIDE PANEL — nine equal-weight cards in a 320px column is a 3,000px
                   scroll. The verdict is now a sticky hero; the rest
                   collapse and remember.

   HONESTY: every field reads an EXISTING source of truth (Fresh, window._gov,
   window._oflow). Nothing is computed here and nothing is invented. A value we
   cannot obtain prints an em-dash, which means NOT MEASURABLE — never zero.
   ===================================================================== */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function setR(el, v, lessIsBetter) {
    if (!el) return;
    el.classList.remove('pos', 'neg', 'na');
    if (v == null || !isFinite(v)) { el.textContent = '\u2014'; el.classList.add('na'); return; }
    el.textContent = (v >= 0 ? '+' : '') + v.toFixed(1) + 'R';
    el.classList.add((lessIsBetter ? v <= 0 : v >= 0) ? 'pos' : 'neg');
  }

  /* ---------- 1. fold the once-a-year controls into the ⋯ panel ---------- */
  /* Theme, density and fullscreen are set once and then never again. They held
     four permanent slots in the top bar. The NODES are MOVED, not cloned — every
     existing getElementById binding still lands on the same element. */
  function foldControls() {
    var row = $('moreShell'); if (!row) return;
    ['themeSel', 'densBtn', 'themeBtn', 'fsBtn'].forEach(function (id) {
      var el = $(id);
      if (el && el.parentNode !== row) row.appendChild(el);
    });
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;padding:4px 0 6px;align-items:center';
  }

  /* ---------- 2. status bar ---------- */
  function paintMode() {
    var el = $('stMode'); if (!el || !window.Fresh) return;
    var st; try { st = Fresh.state(); } catch (_) { return; }
    var cls = 'local', txt = 'LOCAL DATA';
    if (st === 'stale') { cls = 'stale'; txt = 'STALE'; }
    else if (st === 'offline') { cls = 'local'; txt = 'LOCAL DATA'; }
    else if (window._feedBroker) { cls = 'live'; txt = 'BROKER \u00b7 LIVE'; }
    else if (window._feedDelay) { cls = 'delayed'; txt = 'REAL \u00b7 DELAYED'; }
    else if (st === 'lagging') { cls = 'delayed'; txt = 'REAL \u00b7 LAGGING'; }
    else { cls = 'live'; txt = 'REAL \u00b7 LIVE'; }
    el.className = cls;
    el.textContent = txt;
    try { el.title = Fresh.why(); } catch (_) {}
  }

  function paintFresh() {
    var w = $('stFreshWrap'); if (!w || !window.Fresh) return;
    var st; try { st = Fresh.state(); } catch (_) { return; }
    w.classList.remove('ok', 'warn', 'bad');
    w.classList.add(st === 'live' ? 'ok' : st === 'lagging' ? 'warn' : 'bad');
  }

  function paintSpread() {
    var el = $('topSpread'); if (!el) return;
    var s = window._oflow && window._oflow.spread;
    el.classList.remove('pos', 'neg', 'na');
    if (!s || !(s.ask > s.bid)) {
      el.textContent = '\u2014'; el.classList.add('na');
      if (el.parentNode) el.parentNode.title =
        'Spread NOT MEASURABLE — this feed carries no bid/ask. Connect MT5 for your broker\u2019s own spread.';
      return;
    }
    var mid = (s.ask + s.bid) / 2, px = s.ask - s.bid;
    /* v39.6 Z6 — the old math was forex-shaped for everything; for BTC at 64k
       it printed nonsense-scaled "pips". Per class: crypto = $ absolute,
       metals = cents, FX = pips (JPY pairs on the 0.01 pip). */
    var cls = (window.CURSYM && CURSYM.cls) || 'fx';
    var pips, txt, wide;
    if (cls === 'crypto') { txt = '$' + (px >= 10 ? px.toFixed(0) : px.toFixed(2)); wide = px / mid > 0.0005; }
    else if (cls === 'metal') { pips = px * 100; txt = pips.toFixed(0) + '\u00a2'; wide = pips > 50; }
    else { pips = mid > 50 ? px / 0.01 : px / 0.0001; txt = pips.toFixed(1); wide = pips > 5; }
    el.textContent = txt;
    if (wide) el.classList.add('neg'); else el.classList.add('pos');
    if (el.parentNode) el.parentNode.title =
      'Live broker spread ' + px.toPrecision(3) + ' (\u2248' + pips.toFixed(1) + ' pips). '
      + 'This is the number every strategy\u2019s costR has been charged at since v36.';
  }

  /* The Risk Governor becomes the biggest thing on the bar, because it is the only
     thing that can stop you. It reads window._gov, which 45-risk-governor.js already
     polls — no second source of truth is created here. */
  function paintRisk() {
    var g = window._gov || {}, s = g.state || {}, cfg = g.cfg || {};
    var down = g.down || !g.verdict;
    var openR = down ? null : s.open_risk_R;
    var dayR = down ? null : s.realized_R_today;
    var cap = (cfg.max_daily_loss_R != null) ? Math.abs(cfg.max_daily_loss_R) : 2.0;

    setR($('stOpenR'), openR, true);      /* open risk: less is better */
    setR($('stDayR'), dayR, false);
    /* v39.1 A7: topOpenR/topDayR no longer exist — DAY/OPEN live in the status
       bar alone. setR() null-guards, but dead writes are dead code: removed. */

    var bar = $('stCapBar');
    if (bar) {
      var i = bar.firstElementChild;
      var used = (dayR != null && dayR < 0) ? Math.min(1, Math.abs(dayR) / cap) : 0;
      if (i) i.style.width = (used * 100).toFixed(0) + '%';
      bar.classList.remove('warn', 'bad');
      if (used >= 1) bar.classList.add('bad');
      else if (used >= 0.6) bar.classList.add('warn');
      bar.title = down
        ? 'Risk Governor unreachable — your daily loss is NOT being watched. Start mishel_service.py.'
        : 'Daily loss cap ' + cap.toFixed(1) + 'R \u00b7 ' + (used * 100).toFixed(0) + '% used';
    }

    var blocked = !down && g.verdict && g.verdict.verdict === 'block';
    var wrap = $('stGovWrap'), chip = $('acctChip');
    if (wrap) wrap.classList.toggle('blocked', !!blocked);
    if (chip) chip.classList.toggle('blocked', !!blocked);
  }

  function paintChip(id, classify) {
    var el = $(id); if (!el) return;
    el.classList.remove('ok', 'warn', 'bad');
    var c = classify((el.textContent || '').trim());
    if (c) el.classList.add(c);
  }

  function paintStatus() {
    if (document.hidden) return;   /* v39.4 perf: a hidden tab paints nothing */
    try { paintMode(); } catch (_) {}
    try { paintFresh(); } catch (_) {}
    try { paintSpread(); } catch (_) {}
    try { paintRisk(); } catch (_) {}
    /* Jobs / Sync: colour derived from the text the EXISTING writers already put there. */
    try {
      paintChip('stClockWrap', function (t) { return /err|fail|\u2717/i.test(t) ? 'bad' : /\u2014|\?/.test(t) ? '' : 'ok'; });
      paintChip('stSyncWrap', function (t) {
        if (/unsynced|queued|\d+\s*q/i.test(t)) return 'warn';
        return /\u2014|\?/.test(t) ? '' : 'ok';
      });
    } catch (_) {}
  }

  /* ---------- 3. side panel: one hero, the rest collapsible ---------- */
  var SKEY = 'v39.side.collapsed';

  function sideState() {
    try { return JSON.parse((window.STORE && STORE.get ? STORE.get(SKEY) : localStorage.getItem(SKEY)) || '{}'); }
    catch (_) { return {}; }
  }
  function saveSide(o) {
    try {
      var j = JSON.stringify(o);
      if (window.STORE && STORE.set) STORE.set(SKEY, j); else localStorage.setItem(SKEY, j);
    } catch (_) {}
  }

  function wireSide() {
    /* v39.4 — DELEGATION, not per-node listeners.
       v39.1 attached click/keydown to every <h3>; any renderer that rebuilt its
       card's innerHTML destroyed them silently, and the sticky hero intercepted
       clicks on headers scrolled beneath it — "cards not expanding" was BOTH of
       those at once. Now: ONE listener on #side that no innerHTML can kill, and
       the hero is simply first (sticky removed — a nicety that cost two bugs). */
    var side = $('side'); if (!side) return;
    var cards = [].slice.call(side.children).filter(function (c) { return c.classList.contains('card'); });
    if (!cards.length) return;
    var st = sideState();

    cards.forEach(function (c, idx) {
      var h = c.querySelector('h3'); if (!h) return;
      if (idx === 0) { c.classList.add('hero'); c.classList.remove('collapsed'); return; }
      if (c.dataset.v39) return;            /* state applied once per card; CLICKS are delegated below */
      c.dataset.v39 = '1';
      var key = (h.textContent || ('card' + idx)).trim().slice(0, 24);
      /* v39.8: the Sniper card carries these cards' conclusions, so they start
         collapsed (one click away for detail). Sniper itself is the hero. */
      /* v39.10: the decision surfaces are ALWAYS open (never a collapsed black
         void); the reference/duplicate cards start collapsed. */
      var PRIMARY = {'SNIPER':1,'Order ticket':1,'Watch':1,'Confluence':1};
      var REDUNDANT = {'Signal drivers':1,'Multi-timeframe':1,'Position sizer':1,'Trade planner':1,
                       'Derivatives':1,'Quick trade':1,'Market analytics':1,'Relative Rotation (RRG-style)':1,
                       'Strategy signal':1,'MTF confluence':1,'Setup Scout':1,'Candle DNA':1,'AI Vision Desk':1,
                       'Desk Narrator':1,'Strategy Lab':1,'Macro drivers':0,'Strategy scoreboard':0};
      /* PRIMARY always open; explicit REDUNDANT collapse; then a HARD RULE:
         only SNIPER, Order ticket, Watch, Confluence, Macro, Scoreboard stay
         open by default — everything else collapses, so the panel can never
         drift back to a 10-card wall. */
      var KEEP_OPEN = {'SNIPER':1,'Order ticket':1,'Watch':1,'Confluence':1,'Macro drivers':1,'Strategy scoreboard':1};
      var collapsed;
      if (PRIMARY[key]) collapsed = false;
      else if (key in st) collapsed = !!st[key];
      else collapsed = KEEP_OPEN[key] ? false : true;
      c.classList.toggle('collapsed', collapsed);
      h.setAttribute('role', 'button');
      h.setAttribute('tabindex', '0');
      h.setAttribute('aria-expanded', String(!collapsed));
    });

    if (side.dataset.v39Delegated) return;
    side.dataset.v39Delegated = '1';
    /* v39.5 X1 — CAPTURE phase on document, not bubble on #side. This codebase
       contains 20 stopPropagation() calls, several inside side-panel content;
       any one of them between a header and #side ate the click in bubble phase,
       which is why WHICH cards died looked arbitrary (it depended on what was
       rendered inside them). Capture runs top-down BEFORE any bubble handler
       can stop anything: categorically unkillable. */
    function toggleFrom(target) {
      var h = target.closest && target.closest('.side .card > h3, .side .card h3');
      if (!h) return false;
      if (target.closest('select,input,button,a')) return true;   /* header controls still work */
      var c = h.closest('.card');
      if (!c || c.classList.contains('hero')) return true;
      var now = c.classList.toggle('collapsed');
      h.setAttribute('aria-expanded', String(!now));
      /* v39.7 W4: an expanded card with an EMPTY body looks identical to a dead
         header. On expand, nudge the render pipeline so the static bodies
         (Signal drivers / Multi-timeframe / Position sizer) repopulate, and if
         the body is still empty 400ms later, say so IN the card instead of
         leaving a void. */
      if (!now) {
        try { if (typeof draw === 'function') draw(); } catch (_) {}
        setTimeout(function () {
          try {
            var kids = [].slice.call(c.children).filter(function (x) { return x.tagName !== 'H3'; });
            var hasContent = kids.some(function (x) { return (x.textContent || '').trim().length > 0 || x.querySelector('input,select,button,canvas,table'); });
            if (!hasContent && kids[0]) kids[0].innerHTML = '<span style="color:var(--muted2);font-size:11px">Nothing to show yet \u2014 this card fills from the chart pipeline (load a symbol / arm a strategy). If this persists with a live chart, it is a bug: screenshot it.</span>';
          } catch (_) {}
        }, 400);
      }
      var key = (h.textContent || '').trim().slice(0, 24);
      var o = sideState(); o[key] = now; saveSide(o);
      return true;
    }
    /* v39.6 Z2 — capture phase (document is the FIRST node in capture, so no
       stopPropagation anywhere in the page can run before this), and #side is
       RE-QUERIED per event: a closure over a node that later gets replaced is
       a silent way to die. */
    document.addEventListener('click', function (e) {
      var sd = document.getElementById('side');
      if (!sd || !sd.contains(e.target)) return;
      toggleFrom(e.target);
    }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var sd = document.getElementById('side');
      if (!sd || !sd.contains(e.target)) return;
      if (toggleFrom(e.target)) e.preventDefault();
    }, true);
  }

  function boot() {
    try { foldControls(); } catch (_) {}
    try { wireSide(); } catch (_) {}
    /* v39.10: cards inject over the first several seconds (macro 1.5s, DNA/
       narrator 4-4.5s, etc.). Re-run wireSide so late arrivals get their
       collapse default + delegation, then stop — no perpetual timer. */
    var _ws = 0, _wt = setInterval(function () { try { wireSide(); } catch (_) {} if (++_ws >= 6) clearInterval(_wt); }, 1200);
    paintStatus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  /* Plain setInterval, which the v35 Clock wraps: this job is therefore try-guarded,
     counted in the Jobs X-ray, and catches up on tab wake like every other job. No
     private timer, no second scheduler. */
  setInterval(paintStatus, 1000);
  setInterval(wireSide, 4000);     /* views re-render their cards; wire the new ones */

  window.v39 = { paintStatus: paintStatus, wireSide: wireSide };
})();
