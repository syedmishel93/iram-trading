/* =====================================================================
   v39.5 — SCOREBOARD (B1) + EXIT GRID (B4) + DECAY WATCH (B6)

   B1 THE SCOREBOARD: you cannot fix "signals are inaccurate" without knowing
   WHICH strategy is inaccurate WHERE. Every resolved trigger the signal
   engine scans is folded into a per-strategy record split by session, with
   a recent-vs-all comparison. Data source: the same sigScan resolutions the
   Brain learns from — no second bookkeeping, no invented numbers.

   B6 DECAY: a strategy whose last-25 record detaches from its full record
   (Wilson intervals no longer overlapping) is flagged DECAYING right on the
   board. You stop trading last year's edge because the board says so.

   B4 EXIT GRID: entries get the attention, exits move the expectancy. For
   the CURRENT strategy's triggers on the LOADED bars, outcomes are re-walked
   under five exit policies — same entries, same costs — and the measured
   winner is printed. Walk-forward honest: each variant only reads bars after
   its own entry.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- B1: the record store ---------------- */
  var KEY = 'board.v1';
  function load() {
    try { return JSON.parse(((window.STORE && STORE.get) ? STORE.get(KEY) : localStorage.getItem(KEY)) || '{}'); }
    catch (_) { return {}; }
  }
  function save(b) {
    try { var j = JSON.stringify(b); if (window.STORE && STORE.set) STORE.set(KEY, j); else localStorage.setItem(KEY, j); } catch (_) {}
  }

  function fold(strat, sym, sigs) {
    if (!strat || !sigs || !sigs.length) return;
    var b = load(); var seen = b._seen = b._seen || {};
    var rec = b[strat] = b[strat] || { n: 0, w: 0, hist: [], bySess: {} };
    var added = 0;
    sigs.forEach(function (s) {
      if (!s || s.res === 'open' || s.res === 'time') return;
      var k = sym + '|' + strat + '|' + (s.i != null ? s.i : s.t);
      if (seen[k]) return; seen[k] = 1;
      var win = (s.res === 't1' || s.res === 't2') ? 1 : 0;
      rec.n++; rec.w += win;
      rec.hist.push(win); if (rec.hist.length > 200) rec.hist.shift();
      var ss = s.sess || '?'; var e = rec.bySess[ss] = rec.bySess[ss] || { n: 0, w: 0 };
      e.n++; e.w += win; added++;
    });
    /* bound the dedupe map */
    var ks = Object.keys(seen); if (ks.length > 6000) ks.slice(0, 2000).forEach(function (k) { delete seen[k]; });
    if (added) save(b);
  }

  function wilson(w, n) {
    if (!n) return [0, 1];
    var p = w / n, z = 1.96, d = 1 + z * z / n;
    var c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  function decayed(rec) {
    /* B6: last-25 vs full — non-overlapping Wilson intervals = detached */
    if (rec.n < 50 || rec.hist.length < 25) return false;
    var tail = rec.hist.slice(-25), tw = tail.reduce(function (a, b) { return a + b; }, 0);
    var A = wilson(rec.w, rec.n), B = wilson(tw, 25);
    return B[1] < A[0];             /* recent ceiling below full floor = decaying */
  }

  /* ---------------- B4: the exit grid (pure, testable) ---------------- */
  /* variants: same entry+initial stop; outcomes net of costR.
     fixed1R  : take profit at 1R
     fixed2R  : take profit at 2R (stop untouched)
     be1R     : stop -> breakeven after +1R touch, target 2R
     atrTrail : trail stop 1.5*ATR behind best price
     time20   : flat after 20 bars at market                              */
  function exitGrid(sigs, bars, atrArr) {
    var out = { fixed1R: [], fixed2R: [], be1R: [], atrTrail: [], time20: [] };
    (sigs || []).forEach(function (s) {
      if (s.i == null || s.entry == null || s.stop == null) return;
      var R = Math.abs(s.entry - s.stop); if (!(R > 0)) return;
      var dir = s.dir === 1 ? 1 : -1, cost = s.costR || 0;
      var stopBE = s.stop, trail = s.stop, best = s.entry, hit1 = false;
      var res = { fixed1R: null, fixed2R: null, be1R: null, atrTrail: null, time20: null };
      for (var i = s.i + 1; i < bars.length; i++) {
        var c = bars[i], k = i - s.i;
        var hi = dir === 1 ? c.h : (2 * s.entry - c.l), lo = dir === 1 ? c.l : (2 * s.entry - c.h);
        var up = (hi - s.entry) / R, dn = (s.entry - lo) / R;   /* excursion in R, direction-normalized */
        /* stop-first inside a bar: the conservative (honest) assumption */
        if (res.fixed1R == null) { if (dn >= 1) res.fixed1R = -1; else if (up >= 1) res.fixed1R = 1; }
        if (res.fixed2R == null) { if (dn >= 1) res.fixed2R = -1; else if (up >= 2) res.fixed2R = 2; }
        if (res.be1R == null) {
          if (!hit1 && dn >= 1) res.be1R = -1;
          else { if (up >= 1) hit1 = true; if (hit1 && dn >= 0) res.be1R = up >= 2 ? 2 : (dn >= 0 && lo <= s.entry + 1e-12 ? 0 : null); if (res.be1R == null && up >= 2) res.be1R = 2; }
        }
        if (res.atrTrail == null) {
          var a = (atrArr && atrArr[i]) || R;
          if (dir === 1) { best = Math.max(best, c.h); trail = Math.max(trail, best - 1.5 * a); if (c.l <= trail) res.atrTrail = (trail - s.entry) / R; }
          else { best = Math.min(best, c.l); trail = Math.min(trail, best + 1.5 * a); if (c.h >= trail) res.atrTrail = (s.entry - trail) / R; }
        }
        if (res.time20 == null) { if (dn >= 1) res.time20 = -1; else if (k >= 20) res.time20 = dir === 1 ? (c.c - s.entry) / R : (s.entry - c.c) / R; }
        if (res.fixed1R != null && res.fixed2R != null && res.be1R != null && res.atrTrail != null && res.time20 != null) break;
      }
      Object.keys(out).forEach(function (v) { if (res[v] != null) out[v].push(res[v] - cost); });
    });
    var table = {};
    Object.keys(out).forEach(function (v) {
      var a = out[v]; if (!a.length) { table[v] = null; return; }
      var avg = a.reduce(function (x, y) { return x + y; }, 0) / a.length;
      table[v] = { n: a.length, avgR: +avg.toFixed(3), winPct: +(a.filter(function (r) { return r > 0; }).length / a.length).toFixed(3) };
    });
    var best2 = Object.keys(table).filter(function (v) { return table[v] && table[v].n >= 15; })
      .sort(function (x, y) { return table[y].avgR - table[x].avgR; })[0] || null;
    return { table: table, best: best2 };
  }
  window.exitGrid = exitGrid;

  /* ---------------- the card ---------------- */
  var NAMES = { fixed1R: 'TP 1R', fixed2R: 'TP 2R', be1R: 'BE after 1R', atrTrail: 'ATR trail 1.5x', time20: 'time stop 20' };

  function render() {
    if (document.hidden) return;
    var side = $('side'); if (!side) return;
    var SS = window._sigState || {};
    /* fold the latest scan into the board (dedup inside) */
    try { if (SS.resolvedStrat && SS.sigs) fold(SS.resolvedStrat, (window.CURSYM || {}).sym || '?', SS.sigs); } catch (_) {}

    var card = $('boardCard');
    if (!card) {
      var anchor = $('stratSignal'); if (!anchor) return;
      card = document.createElement('div'); card.className = 'card'; card.id = 'boardCard';
      card.innerHTML = '<h3>Strategy scoreboard <span class="tag" title="Every resolved trigger the engine scans, folded into a per-strategy record split by session. RECENT vs ALL: when the last-25 Wilson interval detaches below the full record, the strategy is flagged DECAYING — stop trading last year\u2019s edge. Same data the Brain learns from; nothing separate, nothing invented.">MEASURED</span></h3>'
        + '<div id="boardBody" style="font-size:11px"></div>'
        + '<button class="tbtn" id="exitGridBtn" style="margin-top:8px;font-size:11px" title="Re-walk the current strategy\u2019s triggers under five exit policies — same entries, same costs — and print the measured winner. Exits move expectancy more than entry tweaks.">Run exit grid \u25b7</button>'
        + '<div id="exitGridOut" style="font-size:11px;margin-top:6px"></div>';
      anchor.parentElement.parentElement.insertBefore(card, anchor.parentElement.nextSibling);
      $('exitGridBtn').onclick = function () {
        var o = $('exitGridOut');
        try {
          var SS2 = window._sigState || {};
          if (!SS2.sigs || !SS2.sigs.length || typeof DATA === 'undefined') { o.textContent = 'No scanned triggers on this chart yet \u2014 arm a strategy first.'; return; }
          var atr = []; try { atr = IND.atr(DATA); } catch (_) {}
          var g = exitGrid(SS2.sigs, DATA, atr);
          var rows = Object.keys(g.table).map(function (v) {
            var t = g.table[v];
            if (!t) return '<tr><td>' + NAMES[v] + '</td><td colspan=3 style="color:var(--muted2)">\u2014</td></tr>';
            return '<tr' + (v === g.best ? ' style="color:var(--bull);font-weight:600"' : '') + '><td>' + NAMES[v] + '</td><td>' + (t.avgR >= 0 ? '+' : '') + t.avgR.toFixed(2) + 'R</td><td>' + Math.round(t.winPct * 100) + '%</td><td>' + t.n + '</td></tr>';
          }).join('');
          o.innerHTML = '<table style="width:100%;font-family:var(--mono);font-size:10px;border-collapse:collapse"><tr style="color:var(--muted2)"><td>exit</td><td>avgR</td><td>win</td><td>n</td></tr>' + rows + '</table>'
            + (g.best ? '<div style="margin-top:4px;color:var(--muted)">measured best on THIS data: <b style="color:var(--bull)">' + NAMES[g.best] + '</b> \u2014 same entries, exits did that.</div>'
                      : '<div style="margin-top:4px;color:var(--muted2)">under 15 resolved per variant \u2014 not enough evidence to crown one.</div>');
        } catch (e) { o.textContent = 'exit grid error: ' + (e && e.message); }
      };
    }
    var body = $('boardBody'); if (!body) return;
    var b = load(); var strats = Object.keys(b).filter(function (k) { return k !== '_seen' && b[k].n >= 5; })
      .sort(function (x, y) { return b[y].n - b[x].n; }).slice(0, 8);
    if (!strats.length) { body.innerHTML = '<span style="color:var(--muted2)">Record builds as scanned triggers resolve \u2014 arm a strategy and let it run.</span>'; return; }
    /* v39.7 A4 -- MORNING READ: one composed paragraph, every clause traceable
       to a number already on screen. Template over data. NOT an LLM, NOT a
       prediction -- a briefing. */
    var read = '';
    try {
      var bs2 = window.Brain && Brain.state();
      var mb = document.querySelector('#macroBody .mk-bias');
      var macroTxt = mb ? mb.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) : null;
      var cal = (window._macroCal || []).map(function (e) { return { t: Date.parse(e.t), n: e.n }; })
        .filter(function (e) { return isFinite(e.t) && e.t > Date.now(); }).sort(function (a, b) { return a.t - b.t; })[0];
      var dk = strats.filter(function (k) { return decayed(b[k]); });
      var bits = [];
      if (macroTxt) bits.push(macroTxt.indexOf('+0.00') >= 0 ? 'macro neutral' : macroTxt);
      if (bs2) bits.push(bs2.trained ? 'Brain live (' + bs2.n + ' examples)' : 'Brain training ' + bs2.n + '/' + bs2.min);
      if (dk.length) bits.push(dk.join(', ') + ' DECAYING \u2014 stand down on ' + (dk.length > 1 ? 'these' : 'it'));
      if (cal) { var mins = Math.round((cal.t - Date.now()) / 60000);
        bits.push(cal.n + ' in ' + (mins >= 60 ? Math.floor(mins / 60) + 'h' + (mins % 60) + 'm' : mins + 'm') + (mins <= 45 ? ' \u2014 no fresh risk into it' : '')); }
      if (bits.length) read = '<div style="padding:4px 6px;margin-bottom:6px;border-left:2px solid var(--accent,#5B8DEF);color:var(--muted);font-size:10.5px" title="Composed from the numbers on this screen (macro bias, Brain state, decay flags, calendar) \u2014 a briefing, never a prediction.">' + bits.join(' \u00b7 ') + '</div>';
    } catch (_) {}
    var brainLine = read;
    try { var bs = window.Brain && Brain.state(); if (bs) brainLine = '<div style="color:var(--muted2);margin-bottom:4px">Brain: ' + (bs.trained ? 'trained on ' + bs.n + ' resolved triggers \u00b7 tiers LIVE' : bs.n + '/' + bs.min + ' examples \u2014 tiers on legacy Q-gate until trained') + '</div>'; } catch (_) {}
    body.innerHTML = brainLine + strats.map(function (k) {
      var r = b[k], ci = wilson(r.w, r.n), dk = decayed(r);
      var sess = Object.keys(r.bySess).map(function (s2) { var e = r.bySess[s2]; return s2 + ' ' + Math.round(100 * e.w / e.n) + '%(' + e.n + ')'; }).join(' \u00b7 ');
      return '<div style="padding:3px 0;border-bottom:1px solid var(--edge)" title="' + sess + '">'
        + '<b>' + k + '</b>' + (dk ? ' <span style="color:var(--bear);font-weight:700" title="last-25 Wilson interval sits entirely below the full record \u2014 live behavior has detached from the backtest. The Brain sees the same data and down-weights it.">DECAYING</span>' : '')
        + ' <span class="mono">' + Math.round(100 * r.w / r.n) + '% of ' + r.n + '</span>'
        + ' <span style="color:var(--muted2)">CI ' + Math.round(ci[0] * 100) + '\u2013' + Math.round(ci[1] * 100) + '%</span></div>';
    }).join('');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else render();
  setInterval(render, 15000);
  window.scoreboard = { fold: fold, decayed: decayed, wilson: wilson, render: render };
})();
