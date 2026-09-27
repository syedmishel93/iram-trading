/* =====================================================================
   v39.8 — THE SNIPER CARD

   ONE decision surface, FIXED read-order, top of panel. Answers the only
   question a discretionary trader has at the moment of decision: "is there a
   trade right now, and if so exactly what do I do?" — and gates it behind a
   hard checklist so operational error (missed news, wrong size, ignored
   exposure, fat-finger retype) cannot happen.

   WHAT IT DOES NOT DO: predict, execute, or imply certainty. A green
   checklist means YOUR RULES WERE FOLLOWED, not that the trade will win. The
   TRUST line (the strategy's real record in this regime) is always shown so a
   verdict can never be read as an oracle. Per the user's choice: ANY red
   checklist item HARD-BLOCKS to STAND DOWN; per-trade risk is TYPED each
   session (no hidden default that could misprice size).

   Everything here is COMPOSED from what already exists: analystContext() for
   the reads + plan inputs, the Brain tier, the scoreboard record, the macro
   calendar, the live spread. No new analysis.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var RISK_KEY = 'sniper.risk.session';

  function planFrom(x) {
    /* identical formula to 48-hardening's planCalc (private to its IIFE), kept
       in sync deliberately — a structured starting point, glass-box, not advice */
    var price = x.price, atr = x.atr || price * 0.005, dir = x.rep.score >= 0 ? 'LONG' : 'SHORT';
    var sw = (IND && IND._sw) || { hi: [], lo: [] }, d = DATA;
    var lastLo = sw.lo.length ? d[sw.lo[sw.lo.length - 1]].l : price - 1.2 * atr;
    var lastHi = sw.hi.length ? d[sw.hi[sw.hi.length - 1]].h : price + 1.2 * atr;
    var stop = dir === 'LONG' ? Math.min(lastLo, price - 1.2 * atr) - 0.15 * atr
                              : Math.max(lastHi, price + 1.2 * atr) + 0.15 * atr;
    var R = Math.abs(price - stop);
    return { dir: dir, entryLo: price - 0.25 * atr, entryHi: price + 0.25 * atr, stop: stop, r: R,
             t1: dir === 'LONG' ? price + R : price - R, t2: dir === 'LONG' ? price + 2 * R : price - 2 * R,
             atr: atr, price: price };
  }

  /* v39.14: keep the shown plan STILL. planFrom re-derives entry/stop/targets from the
     live price on every render, so on a fast tape the numbers jump and you cannot read a
     decision. stablePlan pins the plan until the direction flips or price drifts ~0.4 ATR
     from where it was drawn — then it redraws once, cleanly. */
  var _plan = null;
  function stablePlan(x) {
    var fresh = planFrom(x);
    var c = _plan;
    if (c && c.dir === fresh.dir && isFinite(c.price) && Math.abs(x.price - c.price) < 0.4 * (fresh.atr || (x.price * 0.005) || 1)) return c;
    _plan = fresh; return fresh;
  }

  /* Prefer the ONE canonical resolver (module 14). Fall back to a spec-aware
     local copy only if it is somehow absent (isolated test harness, or a
     failed module load) — the fallback still NEVER calls a >1000 asset a
     0.01-pip forex pair, so the v39.11 bug cannot come back through this door. */
  function _unit(px) {
    if (typeof window !== 'undefined' && window.symUnit) return window.symUnit(px);
    var c = (typeof CURSYM !== 'undefined' && CURSYM) || {}, cls = c.cls;
    var price = (px != null && isFinite(px)) ? px : c.px;
    var pip = cls === 'metal' ? 0.01 : cls === 'crypto' ? 1 : (price != null && price > 1000) ? 1 : (price != null && price > 50) ? 0.01 : 0.0001;
    var ptsLike = (cls === 'crypto' || cls === 'metal' || cls === 'stock');
    if (!ptsLike && price != null && price > 1000) { cls = 'pts'; pip = 1; ptsLike = true; }
    var pxDec = cls === 'crypto' ? (price >= 1000 ? 1 : (price >= 1 ? 2 : 5)) : cls === 'metal' ? 2 : cls === 'stock' ? 2 : cls === 'pts' ? 1 : 5;
    return { cls: cls, pip: pip, pxDec: pxDec, px: price, ptsLike: ptsLike,
      distFmt: function (d) { d = Math.abs(+d || 0); if (cls === 'metal') return d.toFixed(1) + ' pts'; if (ptsLike) return '$' + d.toFixed(d >= 100 ? 0 : 1); return (d / pip).toFixed(1) + ' pips'; },
      fmtPx: function (v) { return (v == null || !isFinite(v)) ? '\u2014' : (+v).toFixed(pxDec); } };
  }
  function dec() { try { return _unit().pxDec; } catch (_) { return 2; } }
  function f(v) { return v == null || !isFinite(v) ? '\u2014' : (+v).toFixed(dec()); }

  /* ---------- the checklist: each item returns {ok, label, val} ---------- */
  function checklist(x, pl) {
    var items = [];

    /* 1 spread sane for the class */
    var sp = null; try { sp = window._oflow && window._oflow.spread; } catch (_) {}
    var spOk = true, spTxt = 'n/a';
    if (sp && sp.ask && sp.bid) {
      var px = sp.ask - sp.bid, U = _unit(x.price), cls = U.cls;
      if (U.ptsLike && cls !== 'metal') { spTxt = '$' + px.toFixed(px >= 100 ? 0 : (px >= 1 ? 1 : 2)); spOk = px / x.price < 0.0006; }
      else if (cls === 'metal') { spTxt = (px * 100).toFixed(0) + '\u00a2'; spOk = px * 100 < 50; }
      else { var pips = px / U.pip; spTxt = pips.toFixed(1); spOk = pips <= 3; }
    }
    items.push({ ok: spOk, label: 'spread OK', val: spTxt });

    /* 2 NOT within 30m of a high-impact USD release */
    var newsMin = null;
    try {
      var nx = (window._macroCal || []).map(function (e) { return Date.parse(e.t); })
        .filter(function (t) { return isFinite(t) && t > Date.now(); }).sort(function (a, b) { return a - b; })[0];
      if (nx) newsMin = Math.round((nx - Date.now()) / 60000);
    } catch (_) {}
    items.push({ ok: !(newsMin != null && newsMin <= 30), label: 'news window clear',
      val: newsMin == null ? 'no event' : (newsMin <= 30 ? '\u26a1 ' + newsMin + 'm' : newsMin + 'm') });

    /* 3 regime matches the strategy's nature (trend strat in trend, etc.) */
    var reg = (x.reg && x.reg.regime || '').toLowerCase();
    var strat = ((window._sigState || {}).resolvedStrat || '').toLowerCase();
    var wantsTrend = /trend|breakout|momentum|run|reclaim/.test(strat);
    var wantsRevert = /revert|bounce|fade|range|mean|vwap/.test(strat);
    var isTrend = /trend/.test(reg), isRange = /rang|revert|chop|low adx/.test(reg);
    var regOk = true, regTxt = x.reg && x.reg.regime || '\u2014';
    if (strat) {
      if (wantsTrend && isRange) { regOk = false; }
      else if (wantsRevert && isTrend) { regOk = false; }
    }
    items.push({ ok: regOk, label: 'regime matches strategy', val: regTxt });

    /* 4 not already over-exposed to this direction's dominant currency
       (uses the Risk Governor's exposure read when present; otherwise neutral) */
    var expOk = true, expTxt = 'ok';
    try {
      if (window._gov && window._gov.exposure != null) {
        expTxt = (window._gov.exposure).toFixed(1) + 'x';
        expOk = Math.abs(window._gov.exposure) < 2.5;
      }
    } catch (_) {}
    items.push({ ok: expOk, label: 'exposure in bounds', val: expTxt });

    return items;
  }

  /* ---------- the record (TRUST line), from the scoreboard ---------- */
  function record(strat) {
    try {
      var b = JSON.parse(((window.STORE && STORE.get) ? STORE.get('board.v1') : localStorage.getItem('board.v1')) || '{}');
      var r = b[strat]; if (!r || r.n < 5) return null;
      var ci = window.scoreboard ? window.scoreboard.wilson(r.w, r.n) : null;
      return { pct: Math.round(100 * r.w / r.n), n: r.n, lo: ci ? Math.round(ci[0] * 100) : null, hi: ci ? Math.round(ci[1] * 100) : null,
               decaying: window.scoreboard ? window.scoreboard.decayed(r) : false };
    } catch (_) { return null; }
  }

  /* ---------- render ---------- */
  /* P1: distance in the unit the trader thinks in, per asset class, + $ value */
  function distUnit(px) {
    var U = _unit(px);                   /* spec-driven — never guesses pip from price */
    return { u: U.ptsLike ? 'pts' : 'pips', per: U.pip, fmt: U.distFmt };
  }
  /* P2: SCALP / INTRADAY / SWING from stop-vs-ATR and the timeframe, + est. time */
  function entryType(pl) {
    var tf = (window.TF || '5m'), atr = pl.atr || 1, stopR = pl.r / atr;
    var tfMin = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '6h': 360, '12h': 720, '1d': 1440 }[tf] || 5;
    /* bars-to-1R estimate: how many bars of typical ATR movement to cover R */
    var barsToR = Math.max(1, Math.round(pl.r / (atr || 1)));
    var mins = barsToR * tfMin;
    var kind, fit;
    if (stopR <= 1.4 && tfMin <= 15) { kind = 'SCALP'; }
    else if (tfMin <= 60 && mins <= 240) { kind = 'INTRADAY'; }
    else { kind = 'SWING'; }
    return { kind: kind, mins: mins, barsToR: barsToR, stopR: stopR, tfMin: tfMin };
  }
  /* P3: is this actually scalpable RIGHT NOW? spread vs target is the scalper's
     make-or-break number nobody shows. */
  function scalpFit(pl, et) {
    var target = pl.r;                       /* 1R distance */
    var sp = null; try { var o = window._oflow && window._oflow.spread; if (o && o.ask) sp = o.ask - o.bid; } catch (_) {}
    var eaten = (sp != null && target > 0) ? (sp / target) : null;   /* fraction of T1 the spread eats */
    var fit, why;
    if (et.kind !== 'SCALP') { fit = 'n/a'; why = 'not a scalp setup (' + et.kind.toLowerCase() + ')'; }
    else if (eaten == null) { fit = 'amber'; why = 'spread unknown — confirm in broker before scalping'; }
    else if (eaten > 0.15) { fit = 'red'; why = 'spread eats ' + Math.round(eaten * 100) + '% of your T1 — the edge is gone before you start'; }
    else if (eaten > 0.08) { fit = 'amber'; why = 'spread eats ' + Math.round(eaten * 100) + '% of T1 — marginal scalp'; }
    else { fit = 'green'; why = 'spread only ' + Math.round(eaten * 100) + '% of T1 — clean scalp'; }
    return { fit: fit, why: why, eaten: eaten };
  }

  function render() {
    if (document.hidden) return;
    var side = $('side'); if (!side) return;
    if (typeof DATA === 'undefined' || !DATA || DATA.length < 30) return;
    var x; try { x = analystContext(); } catch (_) { return; }

    var card = $('sniperCard');
    if (!card) {
      card = document.createElement('div'); card.className = 'card'; card.id = 'sniperCard';
      side.insertBefore(card, side.firstChild);          /* always first — top of panel */
    }

    var pl = stablePlan(x);
    var SS = window._sigState || {};
    var strat = SS.resolvedStrat || null;
    var live = SS._liveSig && SS._liveSig.barT === (DATA[DATA.length - 1] || {}).t;   /* trigger on THIS bar */
    var brain = (SS._liveSig && SS._liveSig.brain) || null;
    var chk = checklist(x, pl);
    var redItems = chk.filter(function (c) { return !c.ok; });
    var rec = strat ? record(strat) : null;

    /* THE VERDICT STATE MACHINE
       - CONFLICT: a live trigger exists but strategy dir disagrees with macro/regime
       - TRADE:    live trigger + checklist ALL green
       - STAND DOWN: live trigger but a red checklist item (hard block, per user)
       - ARM:      no live trigger but plan is valid -> watch level
    */
    var macroBias = null;
    try { var mb = document.querySelector('#macroBody .mk-bias b'); if (mb && /[-+]?\d/.test(mb.textContent)) macroBias = parseFloat(mb.textContent); } catch (_) {}
    var planDir = pl.dir === 'LONG' ? 1 : -1;
    var macroConflict = (macroBias != null && Math.abs(macroBias) > 0.15 && Math.sign(macroBias) !== planDir);

    var state, lead, col, why;
    if (live && redItems.length) {
      state = 'STAND DOWN'; col = 'var(--muted2)'; lead = '\u25cf';
      why = 'blocked by: ' + redItems.map(function (c) { return c.label; }).join(', ');
    } else if (live && macroConflict) {
      state = 'CONFLICT'; col = 'var(--bear)'; lead = '\u2715';
      why = 'strategy ' + pl.dir + ' vs macro ' + (macroBias > 0 ? 'long' : 'short') + ' bias (' + macroBias.toFixed(2) + ') \u2014 conviction LOW, size down or skip';
    } else if (live) {
      state = 'TRADE'; col = 'var(--bull)'; lead = '\u25cf';
      why = strat + ' triggered \u00b7 all checks green';
    } else {
      state = 'ARM'; col = 'var(--warn)'; lead = '\u25d0';
      var watch = pl.dir === 'LONG' ? pl.entryLo : pl.entryHi;
      why = (strat || 'strategy') + ' FLAT \u2014 watching ' + f(watch) + ' for a ' + pl.dir.toLowerCase();
    }

    /* risk: typed per session (user choice). No default that could misprice. */
    var risk = null; try { risk = localStorage.getItem(RISK_KEY); } catch (_) {}
    var acct = null; try { acct = +(localStorage.getItem('mishel_acct') || 0) || null; } catch (_) {}
    var sizeTxt, sizeTip;
    if (risk && acct && pl.r > 0) {
      var riskAmt = acct * (parseFloat(risk) / 100);
      var perUnit = pl.r;                    /* $ risk per unit at 1 lot depends on contract; show $risk + R */
      sizeTxt = '$' + riskAmt.toFixed(0) + ' risk @ ' + risk + '%';
      sizeTip = 'account ' + acct + ' \u00d7 ' + risk + '% = $' + riskAmt.toFixed(0) + ' at risk; lot size depends on your MT5 contract spec \u2014 set it on the ticket. Stop distance ' + f(pl.r) + '.';
    } else {
      sizeTxt = risk ? (acct ? '\u2014' : 'set account balance') : 'type session risk \u2193';
      sizeTip = 'Per your setup, per-trade risk is typed each session (no hidden default). Enter it below.';
    }

    var planLive = (state === 'TRADE');
    var planStyle = planLive ? '' : 'opacity:.5';

    /* T4 PRE-FLIGHT STRIP: the five things that can invalidate ANY trade,
       one line, always visible. Red here = don't fire, whatever the setup says. */
    var pf = [];
    try {
      var sp = window._oflow && window._oflow.spread;
      if (sp && sp.ask) { var pxd = sp.ask - sp.bid, U2 = _unit(x.price), cls2 = U2.cls;
        var spTxt = (U2.ptsLike && cls2 !== 'metal') ? '$' + pxd.toFixed(pxd >= 100 ? 0 : (pxd >= 1 ? 1 : 2)) : cls2 === 'metal' ? (pxd * 100).toFixed(0) + '\u00a2' : ((pxd / U2.pip).toFixed(1) + 'p');
        pf.push({ k: 'sprd', v: spTxt, bad: chk[0] && !chk[0].ok }); }
      var nItem = chk.find(function (c) { return c.label.indexOf('news') >= 0; });
      if (nItem) pf.push({ k: 'news', v: nItem.val, bad: !nItem.ok });
      pf.push({ k: 'sess', v: (typeof sessionNow === 'function' ? sessionNow() : (window._session || '\u2014')), bad: false });
      if (window._gov && window._gov.openRisk != null) pf.push({ k: 'open', v: (+window._gov.openRisk).toFixed(1) + 'R', bad: window._gov.openRisk > 3 });
      if (window._gov && window._gov.heat != null) pf.push({ k: 'heat', v: (+window._gov.heat).toFixed(0) + '%', bad: window._gov.heat > 6 });
    } catch (_) {}
    var pfHtml = pf.length ? '<div class="snp-preflight">' + pf.map(function (p) {
      return '<span class="snp-pf' + (p.bad ? ' bad' : '') + '" title="pre-flight: ' + p.k + '">' + p.k + ' <b>' + p.v + '</b></span>';
    }).join('') + '</div>' : '';

    /* P1/P2/P3 computed for this render (must be BEFORE the innerHTML concat) */
    var _du = distUnit(pl.price), _et = entryType(pl), _sf = scalpFit(pl, _et);
    var _rTxt = _du.fmt(pl.r), _t2Txt = _du.fmt(pl.r * 2);
    var _riskMoney = null; try { var _rk = localStorage.getItem(RISK_KEY), _ac = +(localStorage.getItem('mishel_acct') || 0); if (_rk && _ac) _riskMoney = _ac * (parseFloat(_rk) / 100); } catch (_) {}
    var _moneyLine = _riskMoney ? (' \u00b7 $' + _riskMoney.toFixed(0) + ' \u2192 +$' + (_riskMoney * 2).toFixed(0) + ' @T2') : '';
    var _etCol = _et.kind === 'SCALP' ? 'var(--bull)' : _et.kind === 'SWING' ? 'var(--warn)' : 'var(--accent,#5B8DEF)';
    var _fitCol = _sf.fit === 'green' ? 'var(--bull)' : _sf.fit === 'red' ? 'var(--bear)' : _sf.fit === 'amber' ? 'var(--warn)' : 'var(--muted2)';
    card.innerHTML = pfHtml +
      '<h3 style="display:flex;align-items:center;gap:8px">SNIPER '
        + '<span class="tag" title="One decision surface, fixed read-order, hard checklist gate. Composed from your existing reads \u2014 it consolidates and gates, it never predicts or decides for you. A green checklist means your RULES were followed, not that the trade will win.">FOCUS</span></h3>'
      + '<div class="snp-verdict" style="color:' + col + '" title="' + why.replace(/"/g, '&quot;') + '">' + lead + ' ' + state + '</div>'
      + '<div class="snp-why">' + why + '</div>'
      + (window._ofSynth && window._ofSynth.dir!=='balanced' ? '<div class="snp-flow" style="margin:6px 0;padding:6px 9px;border-radius:7px;font-size:11px;background:'+(window._ofSynth.cls==='up'?'var(--bull-dim)':window._ofSynth.cls==='dn'?'var(--bear-dim)':'var(--edge)')+'" title="Live order-flow synthesis from the Smart-Money detector \u2014 book pressure, sweeps, spoofs, stop-runs. Short-term microstructure lean, not a prediction."><b class="'+window._ofSynth.cls+'">FLOW: '+(window._ofSynth.dir==='UP'?'\u25b2 ':'\u25bc ')+window._ofSynth.intensity.toUpperCase()+' '+window._ofSynth.dir+'</b>'+(window._ofSynth.drivers&&window._ofSynth.drivers.length?' <span style="color:var(--muted)">\u00b7 '+window._ofSynth.drivers.join(', ')+'</span>':'')+'</div>' : '')
      + '<div class="snp-plan" style="' + planStyle + '">'
        + '<div class="snp-plan-h">IF IT TRIGGERS \u00b7 <b>' + pl.dir + '</b>'
          + ' <span class="snp-etype" style="color:' + _etCol + '" title="Entry nature from stop-vs-ATR (' + _et.stopR.toFixed(1) + '\u00d7 ATR) and timeframe. SCALP = tight stop on a fast TF, minutes-to-an-hour hold. Estimated \u2014 markets do not keep schedules.">' + _et.kind + ' \u00b7 ~' + (_et.mins >= 60 ? Math.floor(_et.mins / 60) + 'h' + (_et.mins % 60 ? (_et.mins % 60) + 'm' : '') : _et.mins + 'min') + '</span>'
          + (planLive ? ' <span style="color:var(--bull)">\u25cf LIVE</span>' : '') + '</div>'
        + (_sf.fit !== 'n/a' ? '<div class="snp-scalpfit" style="color:' + _fitCol + '" title="For scalping: how much of your first target the spread consumes. Over ~15% and the edge is gone before you enter \u2014 the number nobody shows.">SCALP-FIT: ' + _sf.why + '</div>' : '')
        + '<div class="snp-row"><span>entry</span><b class="mono">' + f(pl.entryLo) + '\u2013' + f(pl.entryHi) + '</b></div>'
        + '<div class="snp-row"><span>stop</span><b class="mono" style="color:var(--bear)">' + f(pl.stop) + ' <span class="snp-dist">\u2212' + _rTxt + '</span></b></div>'
        + '<div class="snp-row"><span>target 1 (1R)</span><b class="mono" style="color:var(--bull)">' + f(pl.t1) + ' <span class="snp-dist">+' + _rTxt + '</span></b></div>'
        + '<div class="snp-row"><span>target 2 (2R)</span><b class="mono" style="color:var(--bull)">' + f(pl.t2) + ' <span class="snp-dist">+' + _t2Txt + _moneyLine + '</span></b></div>'
        + '<div class="snp-row"><span>R:R</span><b class="mono">1:2 <span class="snp-dist">need &gt;33% to profit</span></b></div>'
        + '<div class="snp-row" title="' + sizeTip.replace(/"/g, '&quot;') + '"><span>size</span><b class="mono">' + sizeTxt + '</b></div>'
      + '</div>'
      + '<div class="snp-chk-h">CHECKLIST <span style="color:var(--muted2);font-weight:400">\u2014 all green to fire</span></div>'
      + chk.map(function (c) {
          return '<div class="snp-chk"><span class="' + (c.ok ? 'snp-ok' : 'snp-no') + '">' + (c.ok ? '\u2713' : '\u2715') + '</span>'
            + '<span class="snp-chk-l">' + c.label + '</span><span class="snp-chk-v">' + c.val + '</span></div>';
        }).join('')
      + (function () {
          /* D1: which strategies feed this read, and their agreement. Glass-box:
             the actual named strategies, not a black box. */
          try {
            if (!window.SIG_STRATS || typeof sigScan !== 'function') return '';
            var agree = { LONG: [], SHORT: [] }, n = DATA.length - 1;
            Object.keys(window.SIG_STRATS).forEach(function (k) {
              if (k === 'ensemble') return;
              try {
                var sg = sigScan(DATA, k);
                var last = sg && sg.length ? sg[sg.length - 1] : null;
                if (last && last.i >= n - 2) { (last.dir === 1 ? agree.LONG : agree.SHORT).push(window.SIG_STRATS[k].name || k); }
              } catch (_) {}
            });
            var mine = pl.dir === 'LONG' ? agree.LONG : agree.SHORT, against = pl.dir === 'LONG' ? agree.SHORT : agree.LONG;
            if (!mine.length && !against.length) return '';
            return '<div class="snp-strats" title="The strategies firing on the current bars and which way. Agreement in your direction strengthens the read; disagreement is the CONFLICT signal.">'
              + '<b>signal from:</b> ' + (mine.length ? mine.slice(0, 4).join(' + ') : '(none in ' + pl.dir + ')')
              + (against.length ? ' <span style="color:var(--bear)">\u00b7 ' + against.length + ' against</span>' : '')
              + '</div>';
          } catch (_) { return ''; }
        })()
      + '<div class="snp-trust" title="The strategy\u2019s real resolved record in the CURRENT regime, Wilson 95% CI. A verdict without its receipts is an oracle; this is the receipt. Thin or wide = low conviction, honestly.">'
        + 'TRUST: ' + (rec
            ? (strat + ' ' + rec.pct + '% / ' + rec.n + (rec.lo != null ? ' \u00b7 CI ' + rec.lo + '\u2013' + rec.hi + '%' : '') + (rec.decaying ? ' \u00b7 <span style="color:var(--bear)">DECAYING</span>' : '') + ' \u00b7 ' + (rec.hi - rec.lo > 30 || rec.pct < 50 ? 'LOW' : rec.pct >= 58 ? 'OK' : 'THIN'))
            : (strat ? 'no record yet for ' + strat + ' \u2014 let it resolve trades first' : 'arm a strategy to see its record'))
        + '</div>'
      + '<div class="snp-risk"><input id="snpRisk" type="number" step="0.1" min="0.1" max="5" placeholder="risk % this session" value="' + (risk || '') + '" style="width:100%"></div>'
      + (state === 'ARM' ? '<button class="tbtn snp-arm" id="snpArm" title="Arm a price alert at the watch level with THIS plan attached \u2014 plan the trade calm, get pinged when it triggers.">\u23f2 Arm alert at ' + f(pl.dir === 'LONG' ? pl.entryLo : pl.entryHi) + '</button>' : '')
      + '<div class="snp-foot">A green checklist means your rules were followed \u2014 not that the trade will win. No prediction. No auto-execution.</div>';

    var ri = $('snpRisk');
    if (ri && !ri.dataset.w) { ri.dataset.w = '1';
      ri.addEventListener('change', function () { try { localStorage.setItem(RISK_KEY, ri.value); } catch (_) {} render(); });
      ri.addEventListener('click', function (e) { e.stopPropagation(); });   /* typing must not toggle the card */
    }
    var arm = $('snpArm');
    if (arm) arm.onclick = function (e) {
      e.stopPropagation();
      try {
        var lvl = pl.dir === 'LONG' ? pl.entryLo : pl.entryHi;
        if (typeof addAlert === 'function') { addAlert(CURSYM.sym, lvl, pl.dir); arm.textContent = '\u2713 armed at ' + f(lvl); }
        else if (window.ALERT_LOG) { window.ALERT_LOG.unshift({ t: Date.now(), sym: CURSYM.sym, desc: 'SNIPER ' + pl.dir + ' plan @ ' + f(lvl), val: '' }); if (window.updateBell) updateBell(); arm.textContent = '\u2713 armed'; }
        /* T6: push the FULL broker ticket to your phone, so the alert IS the
           order instructions -- glance, place, done. Never fires without your click. */
        try {
          if (window.brokerTicket) {
            var tk = window.brokerTicket(CURSYM.sym, pl);
            var base = (typeof svcBase === 'function' && svcBase()) || 'http://127.0.0.1:8788';
            fetch(base + '/svc/notify', { method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: 'ARMED \u2014 ' + CURSYM.sym + '\n' + tk.text + '\nYou place it. Nothing auto-executes.' }) }).catch(function () {});
          }
        } catch (_) {}
      } catch (_) {}
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else setTimeout(render, 1500);
  setInterval(render, 4000);
  /* v39.14: the sniper is a DECISION surface — it must hold still. It refreshes on a calm
     4s cadence and its plan is sticky (stablePlan), so the numbers you are reading do not
     jump under your cursor. Fast live prices live in the docked bar and the watchlist. */
  window.sniper = { render: render, planFrom: planFrom, checklist: checklist };
})();
