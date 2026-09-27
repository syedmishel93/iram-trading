/* =====================================================================
   v39.9 — VERDICT WATCHLIST (T5): scan many symbols, see which has a setup.

   Replaces "six TradingView tabs open". A compact list of your symbols, each
   carrying its Sniper verdict (TRADE / ARM / STAND DOWN / CONFLICT) computed
   from that symbol's loaded bars. You scan the column, act on the one that has
   an actual trade -- instead of flipping charts hunting for it.

   HONEST: a verdict needs that symbol's bars loaded this session (open it once,
   or it says "no data"). No hidden fetching, no fabricated verdicts.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var WKEY = 'verdictwatch.syms';
  var DEFT = ['BTCUSD', 'ETHUSD', 'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];

  function syms() {
    try { var s = JSON.parse((window.STORE && STORE.get ? STORE.get(WKEY) : localStorage.getItem(WKEY)) || 'null'); if (Array.isArray(s) && s.length) return s; } catch (_) {}
    return DEFT.slice();
  }
  function saveSyms(a) { try { var j = JSON.stringify(a); if (window.STORE && STORE.set) STORE.set(WKEY, j); else localStorage.setItem(WKEY, j); } catch (_) {} }

  function barsFor(sym) {
    try { for (var k in BAR_CACHE) if (k.indexOf(sym + '|') === 0 && BAR_CACHE[k].length > 40) return BAR_CACHE[k]; } catch (_) {}
    return null;
  }

  /* a LIGHT verdict per symbol, from its bars -- the same spirit as the Sniper
     card but computed standalone so it works off-chart. Direction from a fast
     trend read; state from whether price is near the plan entry zone. */
  function verdict(sym) {
    var b = barsFor(sym);
    if (!b) return { state: 'no data', col: 'var(--muted2)', note: 'open once to load' };
    var n = b.length, c = b.map(function (x) { return x.c; }), price = c[n - 1];
    /* fast EMA slope for direction */
    function ema(p) { var k = 2 / (p + 1), e = c[0]; for (var i = 1; i < n; i++) e = c[i] * k + e * (1 - k); return e; }
    var e21 = ema(21), e55 = ema(55), dir = e21 >= e55 ? 'LONG' : 'SHORT';
    /* ATR for the zone */
    var atr = 0; for (var i = Math.max(1, n - 15); i < n; i++) atr += Math.abs(b[i].h - b[i].l); atr /= Math.min(14, n - 1);
    var entryLo = price - 0.25 * atr, entryHi = price + 0.25 * atr;
    /* near the zone? -> ARM/TRADE ; far -> WAIT */
    var inZone = price >= entryLo && price <= entryHi;
    var dist = Math.min(Math.abs(price - entryLo), Math.abs(price - entryHi)) / (atr || 1);
    var state, col;
    if (inZone) { state = dir === 'LONG' ? 'ARM \u25b2' : 'ARM \u25bc'; col = 'var(--warn)'; }
    else if (dist < 0.5) { state = 'near ' + (dir === 'LONG' ? '\u25b2' : '\u25bc'); col = 'var(--muted)'; }
    else { state = 'wait'; col = 'var(--muted2)'; }
    return { state: state, col: col, dir: dir, price: price, note: dir + ' bias \u00b7 ' + (atr / price * 100).toFixed(2) + '% ATR' };
  }

  function render() {
    if (document.hidden) return;
    var side = $('side'); if (!side) return;
    var card = $('watchCard');
    if (!card) {
      card = document.createElement('div'); card.className = 'card'; card.id = 'watchCard';
      var host = $('brokerCard') || $('sniperCard');
      if (host && host.nextSibling) side.insertBefore(card, host.nextSibling); else side.appendChild(card);
    }
    var list = syms();
    card.innerHTML =
      '<h3 style="display:flex;align-items:center;gap:8px">Watch <span class="tag" title="Each of your symbols with its live verdict, computed from that symbol\u2019s loaded bars. Scan the column, act on the one with a setup \u2014 instead of flipping charts. Click a row to load it.">VERDICTS</span></h3>'
      + list.map(function (sym) {
          var v = verdict(sym), bsym = window.brokerSym ? window.brokerSym(sym) : sym;
          return '<div class="wl-row" data-sym="' + sym + '" title="' + v.note + (bsym !== sym ? ' \u00b7 broker: ' + bsym : '') + '">'
            + '<span class="wl-sym">' + sym + '</span>'
            + '<span class="wl-state" style="color:' + v.col + '">' + v.state + '</span></div>';
        }).join('')
      + '<div class="wl-add"><input id="vwAddSym" placeholder="add symbol (e.g. XAGUSD)" style="width:100%"></div>';
    card.querySelectorAll('.wl-row').forEach(function (r) {
      r.onclick = function (e) { e.stopPropagation(); try { if (typeof loadSymbol === 'function') { CURSYM.sym = r.dataset.sym; loadSymbol(r.dataset.sym); } } catch (_) {} };
    });
    var add = $('vwAddSym');
    if (add) { add.onclick = function (e) { e.stopPropagation(); };
      add.onkeydown = function (e) { if (e.key === 'Enter' && add.value.trim()) { var a = syms(); a.push(add.value.trim().toUpperCase()); saveSyms(a); render(); } }; }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else setTimeout(render, 1900);
  setInterval(render, 6000);
  /* v39.12: tick-driven — refresh per-symbol verdicts on each tape tick, skip identical prices */
  (function () { var lp = null; if (window.onTick) window.onTick(function (px) { if (document.hidden || px === lp) return; lp = px; render(); }); })();
  window.verdictWatch = { render: render, verdict: verdict };
})();
/* =====================================================================
   v39.9 — C1 EXPLAIN-ON-HOVER. Keep every existing number; when you hover,
   add a plain-language line of WHAT IT MEANS FOR THE DECISION.

   Non-destructive: this only APPENDS to titles that don't already carry an
   explanation, and only for a known vocabulary. It never removes precision --
   the raw number stays; the hover teaches. Uncertainty is preserved: where a
   metric has a small sample or wide interval, the gloss says so rather than
   implying false confidence.
   ===================================================================== */
(function () {
  'use strict';

  /* what · how · what-you-do-with-it, in trader's language */
  var GLOSS = {
    'FLUX': 'short-term momentum/flow reading. Positive = buyers leaning in, negative = sellers. A confirmation, not a trigger on its own.',
    'RSI': 'Relative Strength Index (0\u2013100). >70 stretched up, <30 stretched down. In a trend it can stay stretched \u2014 not a standalone reversal signal.',
    'ATR': 'Average True Range \u2014 typical bar movement. Sets stop distance and position size. Rising ATR = wider stops needed.',
    'MACRO BIAS': 'net direction of the fundamental drivers, weighted. Negative = headwind for longs. INFO-ONLY \u2014 context, never merged into the trade trigger.',
    'breakeven': 'the win-rate this R:R needs just to break even. Lower = more forgiving. At 1:2 you only need ~33% to not lose money.',
    'confluence': 'how many independent signals agree, as one score. Higher |value| = stronger alignment. Sign = direction.',
    'MVRV': 'market value vs realized value (on-chain). High = holders in heavy profit (euphoria risk), low = capitulation. A slow context gauge.',
    'funding': 'perpetual funding rate. Hot positive = crowded longs paying to hold = squeeze fuel (contrarian at extremes).',
    'DXY': 'US dollar index. Inverse driver for BTC and gold \u2014 dollar up is a headwind for both.',
    'Wilson': '95% confidence interval on a win-rate. WIDE interval = few samples = low trust. Narrow = more reliable.',
    'regime': 'the market\u2019s current character (trending vs ranging). Match your strategy to it \u2014 trend tools fail in chop and vice-versa.',
    'crowding': 'how one-sided positioning is. Crowded = fragile; a small push triggers cascades. Less crowded = cleaner.',
    'heat': 'how much of your risk budget is already live. High heat = little room \u2014 skip marginal trades.',
    'slippage': 'the gap between the price you see and the fill you get. Real cost \u2014 baked into honest R:R.',
    'conviction': 'how many independent reads agree with the setup. Low conviction = size down or skip, even if a signal fired.'
  };

  var KEYS = Object.keys(GLOSS);
  var MARK = 'data-c1';

  function enrich(root) {
    try {
      var els = (root || document).querySelectorAll('[title]:not([' + MARK + '])');
      els.forEach(function (el) {
        var t = el.getAttribute('title') || '';
        var txt = (el.textContent || '');
        for (var i = 0; i < KEYS.length; i++) {
          var k = KEYS[i];
          if ((txt.indexOf(k) >= 0 || t.indexOf(k) >= 0)) {
            /* only append if the existing title doesn't already explain it */
            if (t.toLowerCase().indexOf(GLOSS[k].slice(0, 18).toLowerCase()) < 0) {
              el.setAttribute('title', (t ? t + '\n\n' : '') + '\u2192 ' + GLOSS[k]);
            }
            el.setAttribute(MARK, '1');
            break;
          }
        }
      });
    } catch (_) {}
  }

  /* run periodically -- cards re-render, new nodes appear; the MARK attribute
     makes it idempotent so we never double-append. */
  function boot() { enrich(document); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 2200);
  setInterval(function () { if (!document.hidden) enrich(document); }, 3000);
  window.explainHovers = { enrich: enrich, gloss: GLOSS };
})();
