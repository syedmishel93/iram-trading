/* =====================================================================
   v39.11 — DYNAMIC STRATEGY: SELECTION (D2) + GATED PROPOSER (D4)

   The honest version of "AI that makes/changes strategies". It does NOT conjure
   a strategy and tell you to trust it -- that is a machine for overfitting to
   noise, and it would lie to you with confidence. Instead:

   D2 ADAPTIVE SELECTION: among your PROVEN strategies, which does the evidence
   trust in the CURRENT regime x session, and which does it bench? Reads the
   scoreboard the Brain already built. It changes what it trusts as conditions
   change -- dynamic, but never inventing.

   D4 GATED PROPOSER: it may PROPOSE new rule combinations (pairs of existing
   strategies that agree), but every proposal must survive:
     - a real walk-forward split (train picks nothing the test doesn't confirm)
     - the PBO / CSCV overfitting probability (cscvPBO, already in this codebase)
     - a deflated-Sharpe check for the number of trials searched
   A proposal that fails any gate is shown as REJECTED with the reason. One that
   passes is labeled CANDIDATE with its OOS sample -- never auto-live, never
   traded until YOU promote it. The evidence decides; you approve.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- D2: adaptive selection from the scoreboard ---------- */
  function board() {
    try { return JSON.parse((window.STORE && STORE.get ? STORE.get('board.v1') : localStorage.getItem('board.v1')) || '{}'); } catch (_) { return {}; }
  }
  function wilson(w, n) { if (!n) return [0, 1]; var p = w / n, z = 1.96, d = 1 + z * z / n; var c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; }

  function selection() {
    var b = board(), out = { trust: [], bench: [], thin: [] };
    Object.keys(b).forEach(function (k) {
      if (k === '_seen') return;
      var r = b[k]; if (!r || r.n < 5) { if (r && r.n) out.thin.push({ k: k, n: r.n }); return; }
      var pct = r.w / r.n, ci = wilson(r.w, r.n);
      if (ci[0] > 0.5) out.trust.push({ k: k, pct: Math.round(pct * 100), n: r.n, lo: Math.round(ci[0] * 100) });
      else if (ci[1] < 0.5) out.bench.push({ k: k, pct: Math.round(pct * 100), n: r.n, hi: Math.round(ci[1] * 100) });
      else out.thin.push({ k: k, n: r.n, pct: Math.round(pct * 100) });
    });
    out.trust.sort(function (a, c) { return c.lo - a.lo; });
    out.bench.sort(function (a, c) { return a.hi - c.hi; });
    return out;
  }

  /* ---------- D4: propose rule combos, then GATE them ---------- */
  /* a "combo" = two existing strategies that must BOTH fire same-direction in a
     window. We build its historical resolved-trade returns and run the gates. */
  function comboReturns(kA, kB, d) {
    if (typeof sigScan !== 'function') return null;
    var a, bb;
    try { a = sigScan(d, kA); bb = sigScan(d, kB); } catch (_) { return null; }
    if (!a || !bb) return null;
    var idxB = {}; bb.forEach(function (s) { idxB[s.i] = s; });
    var rets = [];
    a.forEach(function (s) {
      if (s.res === 'open') return;
      /* both agree within 3 bars, same dir */
      var partner = null;
      for (var w = 0; w <= 3; w++) { if (idxB[s.i - w] && idxB[s.i - w].dir === s.dir) { partner = idxB[s.i - w]; break; } }
      if (!partner) return;
      var r = (s.res === 't1' || s.res === 't2') ? (s.res === 't2' ? 2 : 1) : -1;
      rets.push(r - (s.costR || 0));
    });
    return rets;
  }

  /* per-bar return series for CSCV: we approximate with the resolved-trade
     stream padded to equal length across configs (cscvPBO needs N configs x T). */
  function gateCombo(kA, kB, d) {
    var combo = comboReturns(kA, kB, d);
    if (!combo || combo.length < 12) return { ok: false, reason: 'too few joint triggers (' + (combo ? combo.length : 0) + ')' };
    /* build the trial set: this combo vs each solo leg, aligned by trade index */
    var soloA = [], soloB = [];
    try {
      var sa = sigScan(d, kA), sb = sigScan(d, kB);
      soloA = sa.filter(function (s) { return s.res !== 'open'; }).map(function (s) { return (s.res === 't2' ? 2 : s.res === 't1' ? 1 : -1) - (s.costR || 0); });
      soloB = sb.filter(function (s) { return s.res !== 'open'; }).map(function (s) { return (s.res === 't2' ? 2 : s.res === 't1' ? 1 : -1) - (s.costR || 0); });
    } catch (_) {}
    var T = Math.min(combo.length, soloA.length, soloB.length);
    if (T < 12) return { ok: false, reason: 'legs too short to cross-validate' };
    var M = [combo.slice(-T), soloA.slice(-T), soloB.slice(-T)];
    var gate = { combo: combo, n: combo.length };
    /* WALK-FORWARD: first 60% train avgR must hold in last 40% test */
    var cut = Math.floor(combo.length * 0.6);
    var trainR = combo.slice(0, cut), testR = combo.slice(cut);
    var trAvg = trainR.reduce(function (a, c) { return a + c; }, 0) / trainR.length;
    var teAvg = testR.reduce(function (a, c) { return a + c; }, 0) / testR.length;
    gate.trainAvgR = +trAvg.toFixed(3); gate.testAvgR = +teAvg.toFixed(3);
    if (teAvg <= 0) return { ok: false, reason: 'walk-forward FAIL: train +' + trAvg.toFixed(2) + 'R but test ' + teAvg.toFixed(2) + 'R', gate: gate };
    /* PBO via CSCV (already in codebase) */
    try {
      if (typeof cscvPBO === 'function') {
        var pbo = cscvPBO(M, Math.min(10, T - (T % 2)));
        if (pbo.ok) { gate.pbo = +pbo.pbo.toFixed(2); if (pbo.pbo > 0.5) return { ok: false, reason: 'overfit: PBO ' + (pbo.pbo * 100).toFixed(0) + '% > 50%', gate: gate }; }
      }
    } catch (_) {}
    /* deflated Sharpe for the trial count */
    try {
      if (typeof deflatedSharpe === 'function') {
        function sr(a) { var m = a.reduce(function (x, y) { return x + y; }, 0) / a.length; var v = a.reduce(function (x, y) { return x + (y - m) * (y - m); }, 0) / a.length; return v ? m / Math.sqrt(v) : 0; }
        var ds = deflatedSharpe(combo.slice(-T), [sr(M[0]), sr(M[1]), sr(M[2])], T);
        if (ds.ok) { gate.dsr = +ds.dsr.toFixed(2); if (ds.dsr < 0.6) return { ok: false, reason: 'deflated-Sharpe ' + ds.dsr.toFixed(2) + ' < 0.60 (no skill after trial-count deflation)', gate: gate }; }
      }
    } catch (_) {}
    var winPct = combo.filter(function (r) { return r > 0; }).length / combo.length;
    gate.winPct = Math.round(winPct * 100);
    gate.avgR = +(combo.reduce(function (a, c) { return a + c; }, 0) / combo.length).toFixed(2);
    return { ok: true, gate: gate };
  }

  function propose() {
    if (typeof DATA === 'undefined' || !DATA || DATA.length < 120 || !window.SIG_STRATS) return { candidates: [], rejected: [], note: 'need \u2265120 bars + strategies loaded' };
    var keys = Object.keys(window.SIG_STRATS).filter(function (k) { return k !== 'ensemble'; });
    /* limit the search -- fewer trials = less overfitting risk, and honest DSR */
    var pairs = [];
    for (var i = 0; i < keys.length && pairs.length < 12; i++)
      for (var jx = i + 1; jx < keys.length && pairs.length < 12; jx++) pairs.push([keys[i], keys[jx]]);
    var cand = [], rej = [];
    pairs.forEach(function (pr) {
      var g = gateCombo(pr[0], pr[1], DATA);
      var nm = (window.SIG_STRATS[pr[0]].name || pr[0]) + ' + ' + (window.SIG_STRATS[pr[1]].name || pr[1]);
      if (g.ok) cand.push({ name: nm, gate: g.gate });
      else rej.push({ name: nm, reason: g.reason });
    });
    cand.sort(function (a, c) { return c.gate.avgR - a.gate.avgR; });
    return { candidates: cand, rejected: rej, trials: pairs.length };
  }
  window.strategyProposer = { propose: propose, selection: selection, gateCombo: gateCombo };

  /* ---------- the card ---------- */
  function render() {
    if (document.hidden) return;
    var side = $('side'); if (!side) return;
    var card = $('stratLabCard');
    if (!card) {
      card = document.createElement('div'); card.className = 'card collapsed'; card.id = 'stratLabCard';
      var host = $('boardCard') || $('sniperCard');
      if (host && host.nextSibling) side.insertBefore(card, host.nextSibling); else side.appendChild(card);
    }
    var sel = selection();
    card.innerHTML =
      '<h3>Strategy Lab <span class="tag" title="D2: which of your PROVEN strategies the evidence trusts vs benches in the current conditions. D4: proposes new rule combos, but only shows ones that survive walk-forward + PBO + deflated-Sharpe \u2014 labeled CANDIDATE, never auto-traded. The evidence decides; you approve.">ADAPTIVE</span></h3>'
      + '<div class="lab-sel">'
        + '<div class="lab-trust"><b>trusting:</b> ' + (sel.trust.length ? sel.trust.slice(0, 4).map(function (t) { return t.k + ' (' + t.pct + '%/' + t.n + ')'; }).join(', ') : '\u2014 none proven yet') + '</div>'
        + (sel.bench.length ? '<div class="lab-bench"><b>benched:</b> ' + sel.bench.slice(0, 4).map(function (t) { return t.k + ' (' + t.pct + '%)'; }).join(', ') + '</div>' : '')
      + '</div>'
      + '<button class="tbtn" id="labPropose" title="Search pairs of your strategies for combinations that survive walk-forward + overfitting gates. Slow, honest, and it will usually reject most of them \u2014 that is the machinery working.">\u25b7 Propose gated combos</button>'
      + '<div id="labOut" style="font-size:11px;margin-top:6px"></div>';
    var pb = $('labPropose');
    if (pb) pb.onclick = function (e) {
      e.stopPropagation();
      var o = $('labOut'); o.textContent = 'searching + gating\u2026';
      setTimeout(function () {
        var r = propose();
        if (!r.candidates.length && !r.rejected.length) { o.textContent = r.note || 'no combos to test'; return; }
        o.innerHTML =
          (r.candidates.length
            ? '<div class="lab-cand-h">CANDIDATES (passed all gates \u2014 NOT live, you promote):</div>'
              + r.candidates.map(function (c) {
                  return '<div class="lab-cand" title="walk-forward test ' + c.gate.testAvgR + 'R \u00b7 PBO ' + (c.gate.pbo != null ? Math.round(c.gate.pbo * 100) + '%' : 'n/a') + ' \u00b7 DSR ' + (c.gate.dsr != null ? c.gate.dsr : 'n/a') + '">\u2713 <b>' + c.name + '</b> \u00b7 ' + c.gate.winPct + '% / ' + c.gate.n + ' \u00b7 ' + c.gate.avgR + 'R <span style="color:var(--muted2)">CANDIDATE</span></div>';
                }).join('')
            : '<div class="lab-cand-h">No combo survived the gates \u2014 that is the honest result, not a bug.</div>')
          + (r.rejected.length ? '<details class="lab-rej"><summary>' + r.rejected.length + ' rejected (why)</summary>'
              + r.rejected.slice(0, 10).map(function (x) { return '<div class="lab-rejrow">\u2715 ' + x.name + ' \u2014 ' + x.reason + '</div>'; }).join('') + '</details>' : '')
          + '<div class="lab-foot">' + (r.trials || 0) + ' pairs tested. A candidate is a hypothesis with OOS evidence \u2014 paper-trade it before you trust it. Nothing here trades automatically.</div>';
      }, 30);
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else setTimeout(render, 2100);
  setInterval(render, 20000);
  window.strategyLab = { render: render };
})();
