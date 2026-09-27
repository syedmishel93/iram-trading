/* =====================================================================
   v39.5 — THE SIGNAL BRAIN (glass-box meta-labeling)

   THE COMPLAINT IT ANSWERS: "very few signals and mostly not accurate."
   Few + inaccurate means the survivors of the gates aren't earning their
   survival, and the gates themselves are cliffs (Q>=50 for every regime,
   every session, every symbol).

   WHAT THIS IS: an online logistic regression, trained by SGD on this
   terminal's OWN resolved triggers (sigScan already labels every historical
   trigger t1/t2/stop/time — a ready-made training set, walk-forward by
   construction because resolution needs future bars that scoring never
   sees). Every live trigger gets a 0-100 score that DECOMPOSES on screen:
   "regime +14 · session +8 · Q +11 · spread -6 ..." — a reasoning trace,
   never an oracle.

   WHAT IT IS NOT: it does not predict price, it does not execute, and it
   cannot claim more than the data supports — under MIN_TRAIN resolved
   examples it says UNTRAINED and the tier system falls back to the old
   Q-gate untouched.

   TIERS (the "more signals, honestly" fix): instead of hiding everything
   under one cliff, triggers are graded A / B / C and each grade WEARS its
   own measured record. You see more; nothing is oversold.
   ===================================================================== */
(function () {
  'use strict';

  /* ---------- feature extraction (every feature is printable) ---------- */
  /* v39.7: four strategy hash-buckets (A2 -- the Brain learns WHICH strategies
     work where, without unbounded one-hots), a red-news proximity gate (A3),
     and the isolation-forest anomaly score (A5). Old persisted weight sets
     simply lack the new keys and read 0 -- forward-compatible by construction. */
  var FEATS = [
    'bias', 'q', 'regTrend', 'regRevert', 'sessAsia', 'sessLdn', 'sessNy',
    'dirLong', 'atrPos', 'mtf', 'crowd', 'fund', 'macro', 'dna', 'hourSin', 'hourCos',
    'strat0', 'strat1', 'strat2', 'strat3', 'news', 'anom'
  ];
  var LABELS = {
    bias: 'baseline', q: 'quality Q', regTrend: 'trending regime', regRevert: 'mean-rev regime',
    sessAsia: 'Asia session', sessLdn: 'London session', sessNy: 'NY session',
    dirLong: 'long side', atrPos: 'ATR percentile', mtf: 'MTF alignment', crowd: 'crowding',
    fund: 'funding pctl', macro: 'macro bias', dna: 'candle DNA', hourSin: 'time-of-day', hourCos: 'time-of-day\u00b7',
    strat0: 'strategy id', strat1: 'strategy id\u00b7', strat2: 'strategy id\u00b7\u00b7', strat3: 'strategy id\u00b7\u00b7\u00b7',
    news: 'red news <30m', anom: 'anomaly score'
  };

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function features(sig, ctx) {
    ctx = ctx || {};
    var h = new Date(sig.t || Date.now()).getUTCHours() + 2;
    var f = {
      bias: 1,
      q: sig.q != null ? clamp((sig.q - 50) / 50, -1, 1) : 0,
      regTrend: ctx.regime === 'trend' ? 1 : 0,
      regRevert: ctx.regime === 'revert' ? 1 : 0,
      sessAsia: sig.sess === 'Asia' ? 1 : 0,
      sessLdn: sig.sess === 'London' ? 1 : 0,
      sessNy: sig.sess === 'NY' ? 1 : 0,
      dirLong: sig.dir === 1 ? 1 : -1,
      atrPos: ctx.atrPctl != null ? clamp(ctx.atrPctl * 2 - 1, -1, 1) : 0,
      mtf: ctx.mtfAlign != null ? clamp(ctx.mtfAlign * 2 - 1, -1, 1) : 0,
      crowd: ctx.crowd != null ? clamp(1 - ctx.crowd / 40, -1, 1) : 0,
      fund: ctx.fundPctl != null ? clamp(1 - 4 * Math.abs(ctx.fundPctl - 0.5), -1, 1) : 0,
      macro: ctx.macro != null ? clamp(ctx.macro * (sig.dir === 1 ? 1 : -1), -1, 1) : 0,
      dna: ctx.dna != null ? clamp((ctx.dna - 0.5) * 2, -1, 1) : 0,
      hourSin: Math.sin(2 * Math.PI * h / 24),
      hourCos: Math.cos(2 * Math.PI * h / 24),
      strat0: 0, strat1: 0, strat2: 0, strat3: 0, news: 0, anom: 0
    };
    /* A2: strategy identity as 4 hash-bucket flags */
    if (ctx.strat) {
      var hsh = 0, st = String(ctx.strat);
      for (var ci = 0; ci < st.length; ci++) hsh = ((hsh << 5) - hsh + st.charCodeAt(ci)) | 0;
      f['strat' + (Math.abs(hsh) % 4)] = 1;
    }
    /* A3: minutes to the next high-impact USD release (macro desk publishes it) */
    if (ctx.newsMin != null && ctx.newsMin >= 0 && ctx.newsMin <= 30) f.news = -1;
    /* A5: isolation-forest weirdness (0..1); above 0.55 counts against */
    if (ctx.anom != null) f.anom = clamp(0.55 - ctx.anom, -1, 1) < 0 ? clamp((0.55 - ctx.anom) * 3, -1, 0) : 0;
    return f;
  }

  /* ---------- the model: logistic, SGD, L2 — all inspectable ---------- */
  var LR = 0.05, L2 = 0.001, MIN_TRAIN = 60;

  function blank() { var w = {}; FEATS.forEach(function (k) { w[k] = 0; }); return { w: w, n: 0 }; }

  function load() {
    try {
      var raw = (window.STORE && STORE.get) ? STORE.get('brain.v1') : localStorage.getItem('brain.v1');
      if (raw) { var m = JSON.parse(raw); if (m && m.w) return m; }
    } catch (_) {}
    return blank();
  }
  function save(m) {
    try {
      var j = JSON.stringify(m);
      if (window.STORE && STORE.set) STORE.set('brain.v1', j); else localStorage.setItem('brain.v1', j);
    } catch (_) {}
  }

  var M = load();

  function logit(f) {
    var z = 0; FEATS.forEach(function (k) { z += (M.w[k] || 0) * (f[k] || 0); });
    return z;
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

  function learn(f, y) {                    /* y in {0,1}: did the trigger pay */
    var p = sigmoid(logit(f)), g = p - y;
    FEATS.forEach(function (k) {
      M.w[k] = (M.w[k] || 0) - LR * (g * (f[k] || 0) + L2 * (M.w[k] || 0));
    });
    M.n++;
  }

  /* dedupe: a resolved trigger is learned ONCE, keyed by tag|index|barTime */
  var SEENK = 'brain.seen.v1';
  function seenSet() {
    try { return new Set(JSON.parse(((window.STORE && STORE.get) ? STORE.get(SEENK) : localStorage.getItem(SEENK)) || '[]')); }
    catch (_) { return new Set(); }
  }
  function saveSeen(s) {
    try {
      var arr = Array.from(s); if (arr.length > 4000) arr = arr.slice(-3000);
      var j = JSON.stringify(arr);
      if (window.STORE && STORE.set) STORE.set(SEENK, j); else localStorage.setItem(SEENK, j);
    } catch (_) {}
  }

  function learnBatch(sigs, ctx, tag) {
    var seen = seenSet(), added = 0;
    (sigs || []).forEach(function (s) {
      if (!s || s.res === 'open' || s.res === 'time') return;   /* scratches teach nothing */
      var key = (tag || '') + '|' + (s.i != null ? s.i : '') + '|' + (s.t || '');
      if (seen.has(key)) return;
      seen.add(key);
      learn(features(s, ctx), (s.res === 't1' || s.res === 't2') ? 1 : 0);
      added++;
    });
    if (added) { save(M); saveSeen(seen); }
    return added;
  }

  /* ---------- scoring + the printable decomposition ---------- */
  function score(sig, ctx) {
    var f = features(sig, ctx);
    var parts = FEATS.map(function (k) {
      return { k: k, label: LABELS[k], v: +((M.w[k] || 0) * (f[k] || 0)).toFixed(3) };
    }).filter(function (p) { return Math.abs(p.v) > 0.005 && p.k !== 'bias'; })
      .sort(function (a, b) { return Math.abs(b.v) - Math.abs(a.v); });
    return { score: Math.round(sigmoid(logit(f)) * 100), parts: parts.slice(0, 6), trained: M.n >= MIN_TRAIN, n: M.n };
  }

  /* tiers: A/B/C. UNTRAINED = honest fallback to the legacy Q>=50 cliff. */
  function tier(sig, ctx) {
    if (M.n < MIN_TRAIN) {
      return { tier: (sig.q == null || sig.q >= 50) ? 'A' : 'C', score: null, parts: [], fallback: true, n: M.n, min: MIN_TRAIN };
    }
    var r = score(sig, ctx);
    r.tier = r.score >= 62 ? 'A' : r.score >= 45 ? 'B' : 'C';
    r.fallback = false;
    return r;
  }

  window.Brain = {
    features: features, learn: learn, learnBatch: learnBatch,
    score: score, tier: tier,
    state: function () { return { n: M.n, trained: M.n >= MIN_TRAIN, min: MIN_TRAIN, w: JSON.parse(JSON.stringify(M.w)) }; },
    reset: function () { M = blank(); save(M); saveSeen(new Set()); },
    _sigmoid: sigmoid, _FEATS: FEATS
  };

  /* ---------- live context assembly: existing globals only; a missing input
     is simply a zero feature — nothing is invented ---------- */
  window.brainCtx = function () {
    var ctx = {};
    try { var r = (window._regime || '').toLowerCase(); ctx.regime = /trend/.test(r) ? 'trend' : /rever|range|chop/.test(r) ? 'revert' : null; } catch (_) {}
    try { if (window._mtfAlign != null) ctx.mtfAlign = +window._mtfAlign; } catch (_) {}
    try { if (window._crowdScore != null) ctx.crowd = +window._crowdScore; } catch (_) {}
    try {
      var mb = document.querySelector('#macroBody .mk-bias b');
      if (mb && /[-+]?\d/.test(mb.textContent)) ctx.macro = parseFloat(mb.textContent);
    } catch (_) {}
    /* v39.7 A1: the Candle-DNA card publishes its stat (n>=15 only) */
    try { if (window._dnaStat && window._dnaStat.p != null) ctx.dna = window._dnaStat.p; } catch (_) {}
    /* A3: minutes to the next red USD event, from the macro desk's calendar */
    try {
      var nx = (window._macroCal || []).map(function (e) { return Date.parse(e.t); })
        .filter(function (t) { return isFinite(t) && t > Date.now(); }).sort(function (a, b) { return a - b; })[0];
      if (nx) ctx.newsMin = Math.round((nx - Date.now()) / 60000);
    } catch (_) {}
    /* A5: intermarket anomaly score (isolation forest, computed since v7) */
    try { if (window._imx && window._imx.anomaly && window._imx.anomaly.iforest != null) ctx.anom = +window._imx.anomaly.iforest; } catch (_) {}
    return ctx;
  };

  /* ---------- Telegram push: A-tier only, once per bar, service optional --- */
  var lastPush = '';
  window.brainPush = function (sig, r, sym, tf, strat) {
    try {
      if (!r || r.tier !== 'A' || r.fallback) return;
      var key = sym + '|' + tf + '|' + (sig.i != null ? sig.i : sig.t);
      if (key === lastPush) return; lastPush = key;
      var base = (typeof svcBase === 'function' && svcBase()) || 'http://127.0.0.1:8788';
      var why = r.parts.slice(0, 3).map(function (p) { return p.label + (p.v > 0 ? ' +' : ' ') + Math.round(p.v * 100); }).join(' \u00b7 ');
      fetch(base + '/svc/notify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'A-TIER ' + (sig.dir === 1 ? 'LONG' : 'SHORT') + ' ' + sym + ' ' + tf + ' \u00b7 ' + strat + '\nBrain ' + r.score + '/100 (' + why + ')\nDecision-support only \u2014 not advice, not an order.' })
      }).catch(function () {});
    } catch (_) {}
  };
})();
