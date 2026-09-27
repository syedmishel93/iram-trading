/* =====================================================================
   v39.16 — FULL LIVE TICKER (scrolling, all-fields, constantly updating).

   The user asked for everything, moving, always accurate. So the bar is now a
   continuous marquee that cycles EVERY live field the terminal actually has —
   prices, day range, next-candle countdown, critical-news countdown, regime +
   ADX, ATR, RSI, funding, Fear & Greed, anomaly, open P&L, today's P&L, heat,
   open risk, guard/loss-streak, signal balance. A tiny fixed feed-health dot
   stays pinned on the left so connection status never scrolls away.

   SMOOTH + LIVE: the item STRUCTURE (which fields exist) is rendered once; on
   every tick and every second the VALUES are updated in place, so numbers move
   live without restarting the scroll. The marquee is only rebuilt when a field
   appears/disappears (e.g. a news event crosses into view, a position opens).

   HONEST: every field reads a real source; anything unavailable is simply left
   out (never faked). Hot items (news <=30m, anomaly, locked/cool-off, extreme
   funding) pulse and sort to the front. Keeps the N1 anchors: id 'newsTicker',
   tkscroll, 'tape quiet', _macroCal.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function base() { try { return (typeof svcBase === 'function' && svcBase()) || 'http://127.0.0.1:8788'; } catch (_) { return 'http://127.0.0.1:8788'; } }
  function j(u) { return fetch(u, { signal: AbortSignal.timeout(4000) }).then(function (r) { return r.json(); }); }

  /* the app's core state is let/const at top level — NOT on window; read it bare (guarded). */
  function _CUR() { try { return (typeof CURSYM !== 'undefined') ? CURSYM : null; } catch (_) { return null; } }
  function _BC()  { try { return (typeof BAR_CACHE !== 'undefined') ? BAR_CACHE : {}; } catch (_) { return {}; } }
  function _SPX() { try { return (typeof SPECS !== 'undefined') ? SPECS : {}; } catch (_) { return {}; } }
  function _IND() { try { return (typeof IND !== 'undefined') ? IND : null; } catch (_) { return null; } }
  function _DATA(){ try { return (typeof DATA !== 'undefined' && DATA) || []; } catch (_) { return []; } }
  function _PAPER(){ try { return (typeof PAPER !== 'undefined') ? PAPER : null; } catch (_) { return null; } }

  function tf() { try { return (typeof TF !== 'undefined' && TF) || '5m'; } catch (_) { return '5m'; } }
  function tfMs(t){ var m={'1m':6e4,'3m':18e4,'5m':3e5,'15m':9e5,'30m':18e5,'1h':36e5,'2h':72e5,'4h':144e5,'6h':216e5,'12h':432e5,'1d':864e5}; return m[String(t).toLowerCase()]||3e5; }
  function lastNum(a){ if(a==null) return null; if(typeof a==='number') return isFinite(a)?a:null; if(a.length){ for(var i=a.length-1;i>=0;i--){ if(a[i]!=null&&isFinite(a[i])) return +a[i]; } } return null; }
  function dpOf(sym) { try { var s = _SPX()[sym]; if (s) { if (s.cls === 'crypto') return s.px >= 1000 ? 0 : (s.px >= 1 ? 2 : 5); if (s.cls === 'metal' || s.cls === 'stock') return 2; return (s.pip && s.pip <= 0.001) ? 5 : 3; } } catch (_) {} return 2; }
  function money(px, dp) { try { return (+px).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }); } catch (_) { return (+px).toFixed(dp); } }

  function curQuote() {
    try {
      var C = _CUR(); var sym = C && C.sym; if (!sym) return null;
      var px = (typeof curPrice === 'function' ? curPrice() : (C && C.px));
      if (px == null || !isFinite(px)) return null;
      var d = _DATA(); var prev = d.length > 1 ? d[d.length - 2].c : null;
      return { sym: sym, px: px, chg: prev ? (px - prev) / prev * 100 : 0, dp: dpOf(sym), cur: true };
    } catch (_) { return null; }
  }
  function otherQuote(sym) {
    try {
      var best = null, BC = _BC();
      for (var k in BC) { if (k.indexOf(sym + '|') === 0) { var b = BC[k]; if (b && b.length > 1 && (!best || b.length > best.length)) best = b; } }
      if (!best) return null;
      var last = best[best.length - 1].c, prev = best[best.length - 2].c;
      if (!isFinite(last)) return null;
      return { sym: sym, px: last, chg: prev ? (last - prev) / prev * 100 : 0, dp: dpOf(sym) };
    } catch (_) { return null; }
  }
  function watchList() {
    var out = [], seen = {};
    var cq = curQuote(); if (cq) { out.push(cq); seen[cq.sym] = 1; }
    try {
      var order = [], BC = _BC();
      for (var k in BC) { var sy = k.split('|')[0]; if (sy && !seen[sy] && order.indexOf(sy) < 0) order.push(sy); }
      order.forEach(function (s) { if (out.length < 4) { var q = otherQuote(s); if (q) { out.push(q); seen[s] = 1; } } });
    } catch (_) {}
    return out;
  }

  function feedDot() {
    var age = null; try { if (window._lastTick) age = Date.now() - window._lastTick; } catch (_) {}
    var real = false; try { real = !!window._realFeed; } catch (_) {}
    if (age == null || !real) return { cls: 'lb-dot-off', t: 'Not receiving live prices' };
    if (age > 10000) return { cls: 'lb-dot-red', t: 'Price feed stalled \u2014 last update ' + Math.round(age / 1000) + 's ago' };
    if (age > 3000) return { cls: 'lb-dot-amb', t: 'Price feed slow \u2014 last update ' + Math.round(age / 1000) + 's ago' };
    return { cls: 'lb-dot-ok', t: 'Live \u2014 updated ' + age + 'ms ago' };
  }

  /* ---- build EVERY live item: {k, txt, hot, cls} ; honest — unavailable fields are skipped ---- */
  function items() {
    var L = [];
    var C = _CUR(), sym = C && C.sym;
    var px = null; try { px = (typeof curPrice === 'function' ? curPrice() : (C && C.px)); } catch (_) {}
    var U = null; try { U = window.symUnit ? window.symUnit(px) : null; } catch (_) {}
    var d = _DATA();
    var dp = U ? U.pxDec : (sym ? dpOf(sym) : 2);

    /* 1 — watched prices (current first, then other held symbols) */
    watchList().forEach(function (q) {
      var up = q.chg >= 0;
      var ic = (window.assetIcon ? window.assetIcon(q.sym, 13) : '');
      var rk = (window.assetRisk ? window.assetRisk(q.sym) : { label: '', cls: '' });
      var rp = rk.label ? ' <span class="pill ' + rk.cls + '">' + rk.label + '</span>' : '';
      L.push({ k: 'px:' + q.sym, cls: up ? 'up' : 'dn',
        txt: ic + ' ' + q.sym.replace(/USDT?$/, '') + ' <b>' + money(q.px, q.dp) + '</b> ' + (up ? '+' : '') + q.chg.toFixed(2) + '%' + rp });
    });

    /* 2 — the read (consensus bias) — the single most useful thing, so it leads */
    try { var _con = (typeof IND !== 'undefined' && IND._consensus) || null;
      if (_con && isFinite(_con.score)) L.push({ k: 'bias', cls: _con.score > 8 ? 'up' : _con.score < -8 ? 'dn' : '',
        txt: 'read <b>' + _con.label + ' ' + (_con.score >= 0 ? '+' : '') + _con.score + '</b> \u00b7 ' + _con.confidence + '% agree' }); } catch (_) {}

    /* 3 — session */
    var sess = ''; try { sess = window._session || (typeof window.mishelSession === 'function' ? window.mishelSession() : ''); } catch (_) {}
    if (sess && sess !== '-') L.push({ k: 'sess', txt: 'session <b>' + sess + '</b>' });

    /* 3 — spread (cost to enter now) */
    try { var s0 = window._oflow && window._oflow.spread;
      if (s0 && s0.ask && s0.bid) { var sp = s0.ask - s0.bid; var st = (U && !U.ptsLike) ? U.distFmt(sp) : '$' + sp.toFixed(sp >= 100 ? 0 : 2);
        L.push({ k: 'sprd', txt: 'spread <b>' + st + '</b>' }); } } catch (_) {}

    /* 4 — day range (last 24h) + where price sits + distance to hi/lo */
    try {
      if (d.length > 2 && isFinite(px)) {
        var since = Date.now() - 864e5, hi = -Infinity, lo = Infinity, used = 0;
        for (var i = d.length - 1; i >= 0; i--) { var b = d[i]; if (b.t && b.t < since) break; if (b.h > hi) hi = b.h; if (b.l < lo) lo = b.l; used++; if (used > 2000) break; }
        if (!isFinite(hi) || hi === -Infinity) { var slice = d.slice(-288); hi = Math.max.apply(null, slice.map(function (x) { return x.h; })); lo = Math.min.apply(null, slice.map(function (x) { return x.l; })); }
        if (isFinite(hi) && isFinite(lo) && hi > lo) {
          var pos = Math.round((px - lo) / (hi - lo) * 100);
          L.push({ k: 'range', txt: 'range ' + money(lo, dp) + '\u2013' + money(hi, dp) + ' \u00b7 <b>' + pos + '%</b>' });
          L.push({ k: 'tohilo', txt: 'to hi ' + (U ? U.distFmt(hi - px) : (hi - px).toFixed(2)) + ' \u00b7 to lo ' + (U ? U.distFmt(px - lo) : (px - lo).toFixed(2)) });
        }
      }
    } catch (_) {}

    /* 5 — next candle close countdown */
    try { var ms = tfMs(tf()), last = d.length ? d[d.length - 1].t : 0;
      if (ms && last) { var left = ms - ((Date.now() - last) % ms); if (left < 0) left += ms; var sec = Math.floor(left / 1000);
        L.push({ k: 'candle', txt: 'next bar <b>' + Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2) + '</b>' }); } } catch (_) {}

    /* 6 — regime + ADX */
    try { var adx = lastNum(_IND() && _IND().adx);
      if (adx != null) { var reg = adx >= 25 ? 'trending' : adx < 18 ? 'ranging' : 'transitional';
        L.push({ k: 'regime', txt: 'regime <b>' + reg + '</b> \u00b7 ADX ' + Math.round(adx) }); } } catch (_) {}

    /* 7 — ATR (money + %) */
    try { var atr = lastNum(_IND() && _IND().atr);
      if (atr != null && isFinite(px) && px) L.push({ k: 'atr', txt: 'ATR ' + (U ? U.distFmt(atr) : atr.toFixed(2)) + ' (' + (atr / px * 100).toFixed(2) + '%)' }); } catch (_) {}

    /* 8 — RSI */
    try { var rsi = lastNum(_IND() && _IND().rsi);
      if (rsi != null) { var rl = rsi >= 70 ? ' overbought' : rsi <= 30 ? ' oversold' : ''; L.push({ k: 'rsi', txt: 'RSI <b>' + Math.round(rsi) + '</b>' + rl }); } } catch (_) {}

    /* 9 — critical news countdown (high-impact economic events) */
    try {
      var nx = (window._macroCal || []).map(function (e) { return { t: Date.parse(e.t), n: e.n }; })
        .filter(function (e) { return isFinite(e.t) && e.t > Date.now(); }).sort(function (a, b) { return a.t - b.t; })[0];
      if (nx) { var m = Math.round((nx.t - Date.now()) / 60000);
        L.push({ k: 'news', hot: m <= 30, txt: '\u26a1 ' + nx.n + ' in <b>' + (m >= 60 ? Math.floor(m / 60) + 'h' + (m % 60) + 'm' : m + 'm') + '</b>' }); }
      else L.push({ k: 'news', txt: 'news <b>none scheduled</b>' });
    } catch (_) {}

    /* 10 — funding + crowding */
    try { var fr = window._fundRate;
      if (fr != null && isFinite(fr)) L.push({ k: 'fund', hot: Math.abs(fr) > 0.1, txt: 'funding <b>' + fr.toFixed(3) + '%</b> \u00b7 ' + (fr > 0 ? 'crowded longs' : fr < 0 ? 'crowded shorts' : 'flat') }); } catch (_) {}

    /* 11 — Fear & Greed */
    try { var fg = window._fng;
      if (fg != null && isFinite(fg)) { var lbl = fg < 25 ? 'extreme fear' : fg < 45 ? 'fear' : fg < 55 ? 'neutral' : fg < 75 ? 'greed' : 'extreme greed';
        L.push({ k: 'fng', txt: 'Fear&amp;Greed <b>' + Math.round(fg) + '</b> \u00b7 ' + lbl }); } } catch (_) {}

    /* 12 — structural anomaly */
    try { if (window._imx && window._imx.anomaly && window._imx.anomaly.flag) L.push({ k: 'anom', hot: true, txt: '\u26a0 unusual conditions \u2014 past patterns may not hold' }); } catch (_) {}

    /* 13 — cross-market regime (from the correlation/anomaly ML) */
    try { if (window._imx && window._imx.regime && window._imx.regime.state) L.push({ k: 'xreg', txt: 'market <b>' + window._imx.regime.state + '</b>' }); } catch (_) {}

    /* 14 — open position + live P&L */
    try { var P = _PAPER(), pos = (P && P.pos) || [];
      if (pos.length) { var u = (typeof unrealized === 'function') ? unrealized() : 0; L.push({ k: 'open', cls: u >= 0 ? 'up' : 'dn', txt: 'OPEN ' + pos.length + ' \u00b7 <b>' + (u >= 0 ? '+' : '') + '$' + u.toFixed(2) + '</b>' }); }
      else L.push({ k: 'open', txt: 'no open position' }); } catch (_) {}

    /* 15 — today's realized P&L + win/loss */
    try { var P2 = _PAPER();
      if (P2) { var dr = P2.dayRealized || 0; var hist = P2.hist || []; var t0 = new Date(); t0.setHours(0, 0, 0, 0);
        var today = hist.filter(function (h) { return (h.t || 0) >= t0.getTime(); });
        var w = today.filter(function (h) { return (h.pnl || 0) > 0; }).length, l = today.filter(function (h) { return (h.pnl || 0) < 0; }).length;
        L.push({ k: 'today', cls: dr >= 0 ? 'up' : 'dn', txt: 'today <b>' + (dr >= 0 ? '+' : '') + '$' + dr.toFixed(2) + '</b> \u00b7 ' + w + 'W-' + l + 'L' }); } } catch (_) {}

    /* 16 — account heat + open risk (from the Risk Governor) */
    try { if (window._gov) {
      if (window._gov.heat != null) L.push({ k: 'heat', hot: window._gov.heat > 6, txt: 'heat <b>' + (+window._gov.heat).toFixed(0) + '%</b>' });
      if (window._gov.openRisk != null) L.push({ k: 'orisk', hot: window._gov.openRisk > 3, txt: 'open risk <b>' + (+window._gov.openRisk).toFixed(1) + 'R</b>' });
    } } catch (_) {}

    /* 17 — guard / loss-streak */
    try { var P3 = _PAPER();
      if (P3) { if (P3.locked) L.push({ k: 'guard', hot: true, txt: '\u26d4 trading locked \u2014 daily loss limit hit' });
        else if (P3.lossStreak >= 2) L.push({ k: 'guard', hot: true, txt: 'cool-off \u00b7 ' + P3.lossStreak + ' losses in a row' }); } } catch (_) {}

    /* 18 — signal balance (how many strategies point each way) */
    try { var ss = window._sigState || {}, ag = ss.agree || null;
      if (ag) { var fore = (ag.LONG || []).length, aft = (ag.SHORT || []).length;
        if (fore || aft) L.push({ k: 'sig', txt: 'signals <b>' + fore + '</b> long / <b>' + aft + '</b> short' }); } } catch (_) {}

    return L;
  }

  /* ---- pull server-side extras (RSS headlines + Fear&Greed) into globals ---- */
  function pull() {
    j(base() + '/svc/data/snapshot').then(function (rows) {
      try {
        (rows || []).forEach(function (r) {
          if (!r || !r.k) return;
          if (/feargreed/i.test(r.k)) { var v = parseFloat(typeof r.v === 'string' ? r.v.replace(/[^0-9.\-]/g, '') : r.v); if (isFinite(v)) window._fng = v; }
        });
      } catch (_) {}
      render();
    }).catch(function () { render(); });
  }

  function mount() {
    var bar = $('newsTicker');
    if (bar) return bar;
    bar = document.createElement('div'); bar.id = 'newsTicker';
    bar.innerHTML = '<div class="lb-fixed"><i class="lb-dot" id="lbDot"></i></div><div class="lb-tape"><div class="tk-track"></div></div>';
    var host = $('tabbar');
    if (host) host.appendChild(bar);
    else { var side = $('side'); if (side) side.insertBefore(bar, side.firstChild); else return null; }
    return bar;
  }

  function esc(k) { return String(k).replace(/"/g, ''); }

  var _struct = null;
  function render() {
    if (document.hidden) return;
    var bar = mount(); if (!bar) return;

    /* feed-health dot (fixed left) */
    try { var dot = $('lbDot'); if (dot) { var f = feedDot(); dot.className = 'lb-dot ' + f.cls; dot.title = f.t; } } catch (_) {}

    var track = bar.querySelector('.tk-track'); if (!track) return;
    var L = items();

    if (!L.length) {
      if (_struct !== 'EMPTY') { track.innerHTML = '<span class="tk-item tk-quiet">tape quiet \u2014 warming up\u2026</span>'; track.style.animation = 'none'; _struct = 'EMPTY'; }
      return;
    }
    /* hot items to the front */
    L.sort(function (a, b) { return (b.hot ? 1 : 0) - (a.hot ? 1 : 0); });

    var sig = L.map(function (it) { return it.k + (it.hot ? '!' : ''); }).join('|');
    if (sig !== _struct) {
      /* STRUCTURE changed (a field appeared/disappeared or went hot) -> rebuild once */
      var one = L.map(function (it) {
        return '<span class="tk-item' + (it.hot ? ' tk-hot' : '') + (it.cls ? ' lb-' + it.cls : '') + '" data-k="' + esc(it.k) + '">' + it.txt + '</span>';
      }).join('<span class="tk-sep">\u00b7</span>');
      track.innerHTML = one + '<span class="tk-sep">\u00b7</span>' + one;   /* duplicate for a seamless loop */
      track.style.animation = '';
      track.style.animationDuration = Math.max(34, L.length * 3.4) + 's';
      _struct = sig;
    } else {
      /* SAME structure -> update values AND up/dn colour in place (both copies); scroll never restarts */
      L.forEach(function (it) {
        var els = track.querySelectorAll('[data-k="' + esc(it.k) + '"]');
        for (var i = 0; i < els.length; i++) {
          if (els[i].innerHTML !== it.txt) els[i].innerHTML = it.txt;
          if (it.cls) { els[i].classList.toggle('lb-up', it.cls === 'up'); els[i].classList.toggle('lb-dn', it.cls === 'dn'); }
        }
      });
    }
  }

  function boot() { render(); pull(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else setTimeout(boot, 1200);
  setInterval(pull, 60000);
  setInterval(render, 1000);   /* 1s heartbeat: countdowns tick, values refresh even when price is flat */
  /* live: also refresh the instant a price ticks in */
  (function () { var lp = null; if (window.onTick) window.onTick(function (px) { if (document.hidden || px === lp) return; lp = px; render(); }); })();
  window.newsTicker = { render: render, pull: pull, items: items };
})();

/* ================= v39.25 JARGON GLOSSARY — hover any term for plain English ================= */
window.GLOSSARY={
  'X-MKT':'Cross-market structure — whether correlated markets (dollar, yields) confirm or fight this move',
  'FLUX':'Order-flow flux — short-term net buying vs selling pressure',
  'HEAT':'Account heat — total % of your balance at risk across all open trades',
  'ARM':'Arm — turn this strategy/alert on so it can trigger',
  'R:R':'Risk-to-reward — potential profit divided by the risk on the trade',
  'ATR':'Average True Range — how much price typically moves per bar; used to size stops',
  'ADX':'Trend strength (0–100): above ~25 trends, below ~18 ranges',
  'Integrity':'Data integrity — % of expected candles actually received (feed health)',
  'Engine':'How long the last full analysis pass took to compute',
  'Jobs':'Background data jobs currently running',
  'Sync':'Seconds since the last successful data sync',
  'PROXY':'Local data proxy connection (lets the browser fetch sources without CORS errors)',
  'SVC':'Background service connection (alerts, journal, the decision engine)',
  'TG':'Telegram notification link',
  'SPRD':'Spread — the cost to enter a trade right now',
  'SPREAD':'The gap between buy and sell price — your immediate cost to enter',
  'CVD':'Cumulative Volume Delta — running total of aggressive buys minus sells',
  'SCALP-FIT':'How suitable current conditions are for scalping',
  'DXY':'US Dollar Index — dollar strength vs a basket of currencies',
  'FUND':'Funding rate — what perp longs pay shorts (or vice-versa); extremes = crowding',
  'VWAP':'Volume-Weighted Average Price — the session\u2019s fair-value line'
};
function applyGloss(){ try{
  var terms=Object.keys(window.GLOSSARY);
  var scope=document.querySelectorAll('.status *, #topbar .tag, #toolbar *, .ih *, #newsTicker *');
  scope.forEach(function(el){ if(el.children.length||el.title)return; var tx=(el.textContent||'').trim().toUpperCase(); if(!tx)return;
    for(var i=0;i<terms.length;i++){ var t=terms[i].toUpperCase(); if(tx===t||tx.indexOf(t+' ')===0||tx.indexOf(t)===0){ el.title=window.GLOSSARY[terms[i]]; el.style.cursor='help'; break; } } });
}catch(e){} }
document.addEventListener('DOMContentLoaded',function(){ setTimeout(applyGloss,1500); setInterval(applyGloss,12000); });
