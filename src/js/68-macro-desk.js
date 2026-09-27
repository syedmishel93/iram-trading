/* =====================================================================
   v39.3 — MACRO DESK. The fundamental layer, as ONE card in the READ station.

   THE SHAPE: a driver matrix per asset class. Each row = one driver:
   value · direction arrow · weight · SOURCE-TIER BADGE. The weighted sum is
   printed with its arithmetic visible. Glass-box, like everything else here.

   THE TIERS (every row wears one — data honesty is not a footnote):
     LIVE    streaming/hourly from a keyless API
     DAILY   free API, daily cadence
     WEEKLY  official release cadence (CFTC COT)
     SCRAPE  fragile page-shape dependency (Farside ETF, FF calendar) —
             expected to break occasionally; when it does, the row goes '—'
     MODEL   derived, not observed (hash ribbon, correlation) — the derivation
             is stated in the row's tooltip
     KEY     needs FRED_API_KEY on the service (free); blank until set

   THE CONTRACT: a driver without data renders '—' (NOT MEASURABLE), never an
   interpolation. The MACRO BIAS line is INFO-ONLY — it is never merged into
   the price-signal verdict silently; it says so on its face. Nothing here
   predicts a price.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var SNAP = null, SERIES = {}, CAL = [], ERRS = {};

  function base() {
    try { return (typeof svcBase === 'function' && svcBase()) || 'http://127.0.0.1:8788'; }
    catch (_) { return 'http://127.0.0.1:8788'; }
  }
  function j(url) {
    return fetch(url, { signal: AbortSignal.timeout(4000) }).then(function (r) { return r.json(); });
  }

  /* ---------- data ---------- */
  function pull() {
    j(base() + '/svc/data/snapshot').then(function (rows) {
      var m = {};
      (rows || []).forEach(function (r) { m[r.source + '.' + r.k] = r; });
      SNAP = m;
      /* v39.5 X2 — tolerant parse: rows written before the double-encode fix
         still exist in his SQLite (parse once -> a STRING); parse again. Rows
         written after parse once -> array. Anything else -> honest []. */
      try {
        var raw = JSON.parse((m['calendar.high_usd'] || {}).v || '[]');
        if (typeof raw === 'string') raw = JSON.parse(raw);
        CAL = Array.isArray(raw) ? raw : [];
      } catch (_) { CAL = []; }
      try { window._macroCal = CAL; } catch (_) {}   /* A3: the Brain news gate reads this */
      render(); calChip();
    }).catch(function () { /* service down -> card shows its honest empty state */ });
    /* v39.7 W3: a dash that explains itself -- last error per collector. */
    j(base() + '/svc/data/errors').then(function (e) { ERRS = e || {}; render(); }).catch(function () {});
    /* history for the derived rows */
    ['coinmetrics|btc_mvrv', 'btcchain|hashrate_ghs', 'fred|m2'].forEach(function (sk) {
      var p = sk.split('|');
      j(base() + '/svc/data/series?source=' + p[0] + '&k=' + p[1] + '&n=500')
        .then(function (r) { SERIES[sk] = r || []; render(); }).catch(function () {});
    });
  }

  function num(k) { var r = SNAP && SNAP[k]; if (!r) return null; var v = parseFloat(r.v); return isFinite(v) ? v : null; }
  function age(k) { var r = SNAP && SNAP[k]; return r ? (Date.now() / 1000 - r.t) : null; }

  function zScore(series) {
    var v = series.map(function (r) { return parseFloat(r.v); }).filter(isFinite);
    if (v.length < 30) return null;                       /* honest: no z from thin history */
    var mu = v.reduce(function (a, b) { return a + b; }, 0) / v.length;
    var sd = Math.sqrt(v.reduce(function (a, b) { return a + (b - mu) * (b - mu); }, 0) / v.length) || 1;
    return (v[v.length - 1] - mu) / sd;
  }
  function trendPct(series, backN) {
    var v = series.map(function (r) { return parseFloat(r.v); }).filter(isFinite);
    if (v.length < backN + 1) return null;
    var a = v[v.length - 1 - backN], b = v[v.length - 1];
    return a ? (b / a - 1) * 100 : null;
  }

  /* rolling correlation from bars already loaded this session — honest: it only
     exists once you have opened both symbols. No hidden fetching. */
  function corrWith(symA, symB, n) {
    try {
      function closes(sym) {
        for (var k in BAR_CACHE) if (k.indexOf(sym + '|') === 0 && BAR_CACHE[k].length > n + 2)
          return BAR_CACHE[k].slice(-(n + 1)).map(function (c) { return c.c; });
        return null;
      }
      var A = closes(symA), B = closes(symB);
      if (!A || !B) return null;
      function rets(x) { var o = []; for (var i = 1; i < x.length; i++) o.push(x[i] / x[i - 1] - 1); return o; }
      var a = rets(A), b = rets(B), m = Math.min(a.length, b.length);
      a = a.slice(-m); b = b.slice(-m);
      var ma = a.reduce(function (p, q) { return p + q; }, 0) / m, mb = b.reduce(function (p, q) { return p + q; }, 0) / m;
      var cov = 0, va = 0, vb = 0;
      for (var i2 = 0; i2 < m; i2++) { var da = a[i2] - ma, db = b[i2] - mb; cov += da * db; va += da * da; vb += db * db; }
      var d = Math.sqrt(va * vb);
      return d ? cov / d : null;
    } catch (_) { return null; }
  }

  /* v39.7 W1: this card read window._dxy -- a global NOTHING ever set. Read real
     DXY where it lives: BAR_CACHE (proxy leg or the computed FX basket). */
  function dxyRead() {
    try {
      for (var k in BAR_CACHE) {
        if (k.indexOf('DXY|') === 0 && BAR_CACHE[k].length > 2) {
          var b = BAR_CACHE[k], a = b[b.length - 2].c, v = b[b.length - 1].c;
          var src = (window._imxSrc && window._imxSrc.DXY && window._imxSrc.DXY !== 'synthetic') ? window._imxSrc.DXY : 'computed FX basket';
          return { v: v, dir: v > a ? 1 : v < a ? -1 : 0, src: src };
        }
      }
    } catch (_) {}
    return null;
  }
  /* v39.7 W2: store rows are HOURLY; trendPct(s,30)=30 HOURS labeled "/30d".
     Daily resample + real-day windows; short history says how many days remain. */
  function daily(series) {
    var by = {};
    (series || []).forEach(function (r) { var v = parseFloat(r.v); if (isFinite(v)) by[Math.floor(r.t / 86400)] = v; });
    return Object.keys(by).sort(function (a, b) { return a - b; }).map(function (d) { return by[d]; });
  }
  function trendDays(series, days) {
    var d = daily(series);
    if (d.length < days + 1) return { need: days + 1 - d.length };
    var a = d[d.length - 1 - days], b = d[d.length - 1];
    return { pct: a ? (b / a - 1) * 100 : null };
  }

  function halving() {
    /* pure arithmetic: last halving 2024-04-20, cycle ~ 4y of blocks */
    var days = Math.floor((Date.now() - Date.parse('2024-04-20')) / 86400000);
    return { day: days, of: 1460 };
  }

  /* ---------- the rows ---------- */
  function R(name, val, dir, weight, tier, tip, err) {
    return { name: name, val: val, dir: dir, w: weight, tier: tier, tip: tip || '', err: err || null };
  }
  var A = '\u25b2', V = '\u25bc', DASH = '\u2014';

  function btcRows() {
    var rows = [];
    var m2t = trendDays(SERIES['fred|m2'] || [], 90);
    rows.push(R('Global M2 tide', m2t.pct != null ? m2t.pct.toFixed(2) + '% /90d' : (num('fred.m2') != null && m2t.need ? 'needs ' + m2t.need + ' more days' : null),
      m2t.pct != null ? (m2t.pct > 0 ? 1 : -1) : 0, 0.15, num('fred.m2') == null ? 'KEY' : 'DAILY',
      'US M2 (FRED M2SL) 90-day change. Liquidity expansion is BTC\u2019s tide. Global proxies not yet wired \u2014 US leg only, labeled as such.'));
    var ry = num('fred.real10y');
    rows.push(R('Real 10Y yield', ry == null ? null : ry.toFixed(2) + '%',
      ry == null ? 0 : (ry < 1 ? 1 : -1), 0.12, ry == null ? 'KEY' : 'DAILY',
      'FRED DFII10. Rising real yields = opportunity-cost headwind for non-yielding assets.'));
    var _dx = dxyRead();
    rows.push(R('DXY', _dx ? _dx.v.toFixed(1) : null, _dx ? -_dx.dir : 0, 0.12, 'LIVE',
      _dx ? ('From ' + _dx.src + '. Inverse driver: dollar up = BTC headwind (arrow shows the BTC read).')
          : 'Needs DXY bars: proxy leg or computed FX basket \u2014 both build after a few minutes online.'));
    var etf = num('farside.btc_etf_flow_musd');
    rows.push(R('Spot ETF net flow', etf == null ? null : (etf >= 0 ? '+' : '') + etf.toFixed(0) + 'M',
      etf == null ? 0 : (etf > 0 ? 1 : -1), 0.14, 'SCRAPE',
      'Farside daily total, $M. SCRAPE tier: breaks when the page shape changes \u2014 blank means the scrape failed, not zero flow.', 'data_etfflow'));
    var st = num('llama.stablecoin_usd');
    rows.push(R('Stablecoin float', st == null ? null : (st / 1e9).toFixed(0) + 'B',
      0, 0.08, 'LIVE', 'DeFiLlama total circulating. Sidelined purchasing power; direction needs history to score, so it carries level only for now.'));
    var f = num('binance_funding.BTCUSDT');
    rows.push(R('Funding rate', f == null ? null : (f * 100).toFixed(3) + '%',
      f == null ? 0 : (f > 0.0005 ? -1 : f < 0 ? 1 : 0), 0.08, 'LIVE',
      'Binance perp. Hot positive funding = crowded longs = cascade fuel (contrarian).'));
    var mv = SERIES['coinmetrics|btc_mvrv'] || [];
    var mvz = zScore(mv), mvNow = num('coinmetrics.btc_mvrv');
    rows.push(R('MVRV z (accum.)', mvNow == null ? null : mvNow.toFixed(2) + (mvz != null ? ' \u00b7 z ' + mvz.toFixed(1) : ' \u00b7 z needs history'),
      mvz == null ? 0 : (mvz > 2 ? -1 : mvz < -0.5 ? 1 : 0), 0.10, 'DAILY',
      'CoinMetrics market/realized cap. The z-score is computed from THIS terminal\u2019s accumulated history and is honest about being young.', 'data_mvrv'));
    var hrT = trendDays(SERIES['btcchain|hashrate_ghs'] || [], 30);
    rows.push(R('Hash ribbon', hrT.pct != null ? (hrT.pct >= 0 ? '+' : '') + hrT.pct.toFixed(1) + '%/30d' : (num('btcchain.hashrate_ghs') != null && hrT.need ? 'needs ' + hrT.need + ' more days' : null),
      hrT.pct != null ? (hrT.pct < -8 ? -1 : hrT.pct > 0 ? 1 : 0) : 0, 0.06, 'MODEL',
      'Hashrate 30-day trend from accumulated observations. Sharp decline \u2248 miner capitulation. No $ cost floor is printed \u2014 that would be a guess wearing a suit.'));
    var h = halving();
    rows.push(R('Halving cycle', 'day ' + h.day + '/' + h.of, 0, 0.05, 'MODEL',
      'Arithmetic since 2024-04-20. A seasonal prior, not a signal.'));
    var cr = corrWith('BTCUSD', 'NAS100', 30);
    rows.push(R('BTC\u2194NDX corr', cr == null ? null : cr.toFixed(2),
      0, 0.05, 'MODEL', cr == null
        ? 'Needs NAS100 bars loaded this session (open it once) \u2014 no hidden fetching.'
        : '30-bar return correlation from session bars. A sign flip = regime break.'));
    var fg = num('feargreed.index');
    rows.push(R('Fear & Greed', fg == null ? null : fg.toFixed(0),
      fg == null ? 0 : (fg > 80 ? -1 : fg < 20 ? 1 : 0), 0.05, 'LIVE', 'alternative.me. Contrarian at the extremes.'));
    return rows;
  }

  function goldRows() {
    var rows = [];
    var ry = num('fred.real10y');
    rows.push(R('Real 10Y yield', ry == null ? null : ry.toFixed(2) + '%',
      ry == null ? 0 : (ry < 1 ? 1 : -1), 0.25, ry == null ? 'KEY' : 'DAILY',
      'THE core driver: gold pays nothing, so real yield is its opportunity cost. FRED DFII10.'));
    var be = num('fred.breakeven10y');
    rows.push(R('10Y breakeven', be == null ? null : be.toFixed(2) + '%',
      be == null ? 0 : (be > 2.4 ? 1 : 0), 0.10, be == null ? 'KEY' : 'DAILY',
      'FRED T10YIE \u2014 the inflation-expectation half of real yields; moving alone it is the early signal.'));
    var _dx2 = dxyRead();
    rows.push(R('DXY', _dx2 ? _dx2.v.toFixed(1) : null, _dx2 ? -_dx2.dir : 0, 0.15, 'LIVE',
      _dx2 ? ('From ' + _dx2.src + '. Denominator effect: weaker dollar lifts the $ gold price.')
           : 'Needs DXY bars (proxy or computed basket) \u2014 builds after a few minutes online.'));
    var cot = num('cftc.gold_mm_net');
    rows.push(R('COT MM net', cot == null ? null : (cot / 1000).toFixed(0) + 'k',
      cot == null ? 0 : (cot > 180000 ? -1 : cot < 40000 ? 1 : 0), 0.12, 'WEEKLY',
      'CFTC managed-money net longs (contracts). Extremes are contrarian; official weekly release.'));
    var debt = num('fred.fed_debt');
    rows.push(R('US federal debt', debt == null ? null : (debt / 1e6).toFixed(1) + 'T',
      0, 0.08, debt == null ? 'KEY' : 'DAILY',
      'FRED GFDEBTN \u2014 the sovereign-debt-premium proxy leg. Level only; a trend score needs accumulated history.'));
    /* gold/silver ratio from session bars — honest availability */
    var gs = (function () {
      try {
        function last(sym) { for (var k in BAR_CACHE) if (k.indexOf(sym + '|') === 0 && BAR_CACHE[k].length) return BAR_CACHE[k][BAR_CACHE[k].length - 1].c; return null; }
        var g = last('XAUUSD'), s2 = last('XAGUSD'); return (g && s2) ? g / s2 : null;
      } catch (_) { return null; }
    })();
    rows.push(R('Gold/Silver ratio', gs == null ? null : gs.toFixed(0),
      0, 0.08, 'MODEL', gs == null
        ? 'Needs XAUUSD + XAGUSD bars this session (open both once).'
        : 'From session bars. >90 historically = fear-heavy regime; <70 = reflation.'));
    rows.push(R('CB buying / physical', null, 0, 0.12, 'QTR',
      'World Gold Council quarterly \u2014 no free live feed exists. HONEST BLANK: shown so you remember the leg exists, never faked.'));
    var cr = corrWith('XAUUSD', 'US10Y', 30);
    rows.push(R('Gold\u2194yield corr', cr == null ? null : cr.toFixed(2), 0, 0.10, 'MODEL',
      cr == null ? 'Needs US10Y bars loaded this session.' : '30-bar correlation; the usual sign is negative \u2014 a flip is a regime tell.'));
    return rows;
  }

  /* ---------- render ---------- */
  var TIER_TIP = {
    LIVE: 'keyless API, streaming/hourly', DAILY: 'free API, daily cadence',
    WEEKLY: 'official weekly release', QTR: 'quarterly official data \u2014 no live feed',
    SCRAPE: 'fragile page scrape \u2014 blank means the scrape broke, not zero',
    MODEL: 'derived, not observed \u2014 derivation in this tooltip', KEY: 'set FRED_API_KEY on the service (free) to light this up'
  };

  function render() {
    if (document.hidden) return;   /* v39.4 perf */
    var side = $('side'); if (!side) return;
    var card = $('macroCard');
    if (!card) {
      var hero = side.querySelector('.card'); if (!hero) return;
      card = document.createElement('div');
      card.className = 'card'; card.id = 'macroCard';
      card.innerHTML = '<h3>Macro drivers <span class="tag" title="The fundamental layer: macro, structure, supply and sentiment drivers per asset class. Every row wears its data-source tier; a blank means NOT MEASURABLE, never zero.">FUNDAMENTAL</span></h3><div id="macroBody"></div>';
      hero.parentElement.insertBefore(card, hero.nextSibling);
    }
    var body = $('macroBody'); if (!body) return;
    var cls = (typeof CURSYM !== 'undefined' && CURSYM && CURSYM.cls) || 'crypto';
    var rows = (cls === 'metal') ? goldRows() : btcRows();
    if (!SNAP) {
      body.innerHTML = '<div style="font-size:11px;color:var(--muted2)">Macro feeds arrive via mishel_service.py (port 8788). Start it \u2014 honest empty until then.</div>';
      return;
    }
    /* v39.6 Z8: KEY badges are actionable — one delegated handler, capture-proof */
    if (!body.dataset.keyWired) { body.dataset.keyWired = '1';
      body.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('.mk-tier.t-key');
        if (!t) return;
        try { toast('Set FRED_API_KEY on the service (free key at fred.stlouisfed.org), restart mishel_service.py \u2014 lights up M2, real 10Y, breakevens and debt.', 'var(--accent,#5B8DEF)'); }
        catch (_) { alert('Set FRED_API_KEY (free at fred.stlouisfed.org) and restart mishel_service.py.'); }
      });
    }
    var score = 0, wsum = 0, dirLegs = 0, liveLegs = 0;
    var html = rows.map(function (r) {
      var has = r.val != null;
      if (has && r.dir !== 0) { score += r.dir * r.w; dirLegs++; }
      if (has) { wsum += r.w; liveLegs++; }
      var arrow = !has ? '' : r.dir > 0 ? '<span class="mk-u">' + A + '</span>' : r.dir < 0 ? '<span class="mk-d">' + V + '</span>' : '<span class="mk-n">\u00b7</span>';
      var why = (!has && r.err && ERRS[r.err]) ? (' | WHY BLANK: ' + String(ERRS[r.err]).slice(0, 110)) : '';
      return '<div class="mk-row" title="' + ((r.tip || '') + why).replace(/"/g, '&quot;') + ' [' + r.tier + ': ' + TIER_TIP[r.tier] + '] weight ' + r.w + '">'
        + '<span class="mk-name">' + r.name + '</span>'
        + '<span class="mk-val">' + (has ? r.val : DASH) + '</span>'
        + arrow
        + '<span class="mk-tier t-' + r.tier.toLowerCase() + '">' + r.tier + '</span></div>';
    }).join('');
    var bias = wsum > 0.2 ? (score / wsum) : null;
    html += '<div class="mk-bias" title="Weighted sum of the arrows above, weights visible per row. INFO-ONLY: this line is never merged into the price-signal verdict \u2014 it is context, not a trigger.">'
      + 'MACRO BIAS <b class="' + (bias == null ? '' : bias > 0.15 ? 'mk-u' : bias < -0.15 ? 'mk-d' : 'mk-n') + '">'
      + (bias == null ? DASH + ' (insufficient legs)' : (bias >= 0 ? '+' : '') + bias.toFixed(2)) + '</b>'
      + ' <span style="color:var(--muted2);font-size:9px">' + dirLegs + '/' + liveLegs + ' legs directional \u00b7 info-only \u00b7 never auto-merged</span></div>';
    /* next red event, if the calendar leg is alive */
    if (CAL.length) {
      var nxt = CAL.map(function (e) { return { t: Date.parse(e.t), n: e.n }; })
        .filter(function (e) { return isFinite(e.t) && e.t > Date.now(); })
        .sort(function (a, b) { return a.t - b.t; })[0];
      if (nxt) {
        var mins = Math.round((nxt.t - Date.now()) / 60000);
        html += '<div class="mk-cal' + (mins < 60 ? ' hot' : '') + '" title="High-impact USD release (ForexFactory mirror, SCRAPE tier). Half the drivers above move on these \u2014 entering minutes before one is a coin-flip wearing your stop.">'
          + '\u26a1 ' + nxt.n + ' in ' + (mins >= 60 ? Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm' : mins + 'm') + '</div>';
      }
    }
    body.innerHTML = html;
  }

  /* status-bar countdown chip (lands in the slot, like every injected chip) */
  function calChip() {
    var slot = $('stSlot'); if (!slot || !CAL.length) return;
    var nxt = CAL.map(function (e) { return { t: Date.parse(e.t), n: e.n }; })
      .filter(function (e) { return isFinite(e.t) && e.t > Date.now(); })
      .sort(function (a, b) { return a.t - b.t; })[0];
    var el = $('stCal');
    if (!nxt) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.className = 's'; el.id = 'stCal'; slot.appendChild(el); }
    var mins = Math.round((nxt.t - Date.now()) / 60000);
    el.textContent = nxt.n.split(' ').slice(0, 2).join(' ') + ' ' + (mins >= 60 ? Math.floor(mins / 60) + 'h' : mins + 'm');
    el.title = 'Next high-impact USD release: ' + nxt.n;
    el.style.color = mins < 60 ? 'var(--warn)' : '';
  }

  function boot() {
    /* v39.6: the card must exist (honest empty state) even when the service is
       down or slow — previously render() only ran inside the fetch .then, so a
       dead service meant NO card at all, indistinguishable from a bug. */
    try { render(); } catch (_) {}
    pull();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  setInterval(pull, 300000);          /* 5 min — the server collects hourly; polling faster would fake freshness */
  setInterval(calChip, 60000);
  window.macroDesk = { render: render, pull: pull };
})();
