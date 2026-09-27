/* =====================================================================
   v39.9 — BROKER DESK (T1 + T3 + T9): analysis -> the exact live order.

   THE JOB: you analyze here, then place the trade by hand in JustMarkets MT5
   or Binance on your phone/laptop. This module is the BRIDGE. It turns the
   plan into the literal numbers you will TYPE into your broker -- symbol as
   THEY name it, lots computed from THEIR contract spec and YOUR account, each
   field one-tap copyable. TradingView never closed this gap; this does.

   T9 BROKER PROFILES: JustMarkets(MT5) and Binance saved with account
   currency, balance, default risk%, symbol map, and contract specs. Switch
   profile -> the whole ticket recomputes for that broker.

   T3 CONTRACT SPECS: entered once from your broker's spec sheet, so lot math
   is correct for YOUR account. XAUUSD is 100 oz/lot, not 100k units -- the
   error that sizes gold 1000x wrong. Nothing here guesses a contract size.

   NOTHING AUTO-EXECUTES. This hands you numbers; you place the order. That is
   deliberate and safer -- the human stays in the execution loop.
   ===================================================================== */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PKEY = 'broker.profiles.v1', AKEY = 'broker.active.v1';

  /* seed profiles -- sensible defaults the user edits once. Specs are the
     COMMON retail values; the user confirms against their own spec sheet. */
  function seed() {
    return {
      'JustMarkets MT5': {
        kind: 'mt5', ccy: 'USD', balance: 1000, risk: 1.0,
        symMap: { BTCUSD: 'BTCUSD', XAUUSD: 'XAUUSD', EURUSD: 'EURUSD', GBPUSD: 'GBPUSD', USDJPY: 'USDJPY', ETHUSD: 'ETHUSD' },
        specs: {   /* contract_size = units per 1.00 lot */
          EURUSD: { contract: 100000, digits: 5, minLot: 0.01, lotStep: 0.01 },
          GBPUSD: { contract: 100000, digits: 5, minLot: 0.01, lotStep: 0.01 },
          USDJPY: { contract: 100000, digits: 3, minLot: 0.01, lotStep: 0.01 },
          XAUUSD: { contract: 100, digits: 2, minLot: 0.01, lotStep: 0.01 },     /* 100 oz — NOT 100k */
          BTCUSD: { contract: 1, digits: 2, minLot: 0.01, lotStep: 0.01 },
          ETHUSD: { contract: 1, digits: 2, minLot: 0.01, lotStep: 0.01 }
        }
      },
      'Binance': {
        kind: 'binance', ccy: 'USDT', balance: 1000, risk: 1.0,
        symMap: { BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT', XAUUSD: 'PAXGUSDT' },
        specs: {   /* spot: "contract" = 1 base unit; size is in base qty */
          BTCUSDT: { contract: 1, digits: 2, minLot: 0.00001, lotStep: 0.00001 },
          ETHUSDT: { contract: 1, digits: 2, minLot: 0.0001, lotStep: 0.0001 }
        }
      }
    };
  }

  function load() {
    try { var p = JSON.parse((window.STORE && STORE.get ? STORE.get(PKEY) : localStorage.getItem(PKEY)) || 'null'); if (p) return p; } catch (_) {}
    var s = seed(); save(s); return s;
  }
  function save(p) { try { var j = JSON.stringify(p); if (window.STORE && STORE.set) STORE.set(PKEY, j); else localStorage.setItem(PKEY, j); } catch (_) {} }
  function activeName() { try { return (window.STORE && STORE.get ? STORE.get(AKEY) : localStorage.getItem(AKEY)) || 'JustMarkets MT5'; } catch (_) { return 'JustMarkets MT5'; } }
  function setActive(n) { try { if (window.STORE && STORE.set) STORE.set(AKEY, n); else localStorage.setItem(AKEY, n); } catch (_) {} }

  function active() { var p = load(); return p[activeName()] || p[Object.keys(p)[0]]; }

  /* map a Mishel symbol (BTCUSD, XAUUSD) to the broker's exact name */
  function brokerSym(mishelSym, prof) {
    prof = prof || active();
    var base = (mishelSym || '').replace('/', '').toUpperCase();
    return (prof.symMap && prof.symMap[base]) || base;
  }

  /* T1+T3: the lot/qty math, correct for the active broker's contract spec.
     lots = riskMoney / (stopDistance * contract_size), rounded to lotStep,
     floored at minLot. Returns the numbers you TYPE, plus the arithmetic. */
  function sizeFor(mishelSym, entry, stop) {
    var prof = active();
    var bsym = brokerSym(mishelSym, prof);
    var spec = prof.specs && prof.specs[bsym];
    var stopDist = Math.abs(entry - stop);
    var riskMoney = prof.balance * (prof.risk / 100);
    if (!spec) return { ok: false, why: 'No contract spec for ' + bsym + ' in ' + activeName() + '. Add it below \u2014 the terminal will not guess a contract size (that is how gold gets sized 1000x wrong).', bsym: bsym, riskMoney: riskMoney };
    if (!(stopDist > 0)) return { ok: false, why: 'stop distance is zero', bsym: bsym, riskMoney: riskMoney };
    var raw = riskMoney / (stopDist * spec.contract);
    var stepped = Math.max(spec.minLot, Math.round(raw / spec.lotStep) * spec.lotStep);
    stepped = +stepped.toFixed(8);
    var actualRisk = stepped * stopDist * spec.contract;
    return {
      ok: true, bsym: bsym, lots: stepped, riskMoney: riskMoney, actualRisk: actualRisk,
      contract: spec.contract, ccy: prof.ccy, unit: prof.kind === 'binance' ? 'qty' : 'lots',
      notional: stepped * spec.contract * entry,
      math: 'risk $' + riskMoney.toFixed(2) + ' \u00f7 (stop ' + stopDist.toFixed(spec.digits) + ' \u00d7 contract ' + spec.contract + ') = ' + raw.toFixed(4) + ' \u2192 ' + stepped + ' ' + (prof.kind === 'binance' ? 'qty' : 'lots') + ' (risks $' + actualRisk.toFixed(2) + ')'
    };
  }
  window.brokerSize = sizeFor;
  window.brokerSym = brokerSym;
  window.activeBroker = active;

  /* build the exact ticket text (for copy + Telegram) */
  function ticketText(mishelSym, pl) {
    var prof = active();
    var entry = (pl.entryLo + pl.entryHi) / 2;
    var sz = sizeFor(mishelSym, entry, pl.stop);
    var d = (prof.specs[sz.bsym] || {}).digits || 2;
    var lines = [
      (prof.kind === 'binance' ? 'BINANCE' : 'MT5') + ' ORDER \u2014 ' + activeName() + ' (manual entry)',
      'symbol: ' + sz.bsym,
      'side: ' + pl.dir,
      'entry: ' + entry.toFixed(d) + '  (zone ' + pl.entryLo.toFixed(d) + '\u2013' + pl.entryHi.toFixed(d) + ')',
      'SL: ' + pl.stop.toFixed(d),
      'TP: ' + pl.t2.toFixed(d) + '  (T1 ' + pl.t1.toFixed(d) + ')',
      sz.ok ? (prof.kind === 'binance' ? 'qty' : 'volume') + ': ' + sz.lots + ' ' + sz.unit + '  (risks ' + sz.actualRisk.toFixed(2) + ' ' + sz.ccy + ')'
            : 'size: \u2014 NOT SIZED (' + sz.why + ')',
      '\u2014 analysis, not advice \u00b7 you place & own this order'
    ];
    return { text: lines.join('\n'), sz: sz, entry: entry, digits: d };
  }
  window.brokerTicket = ticketText;

  /* ---------- the ticket CARD (copy-ready fields) ---------- */
  function copyField(v, btn) {
    try {
      if (navigator.clipboard) navigator.clipboard.writeText(String(v));
      else { var t = document.createElement('textarea'); t.value = v; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
      if (btn) { var o = btn.textContent; btn.textContent = '\u2713'; setTimeout(function () { btn.textContent = o; }, 900); }
    } catch (_) {}
  }
  window._brokerCopy = copyField;

  function render() {
    if (document.hidden) return;
    var side = $('side'); if (!side) return;
    if (typeof window.TradePlanObj !== 'object' && !(window.sniper)) { /* need a plan source */ }
    var sym = (window.CURSYM || {}).sym || 'BTCUSD';
    var pl = null;
    try { pl = window.sniper && window.sniper.planFrom ? window.sniper.planFrom(analystContext()) : null; } catch (_) {}
    var card = $('brokerCard');
    if (!card) {
      card = document.createElement('div'); card.className = 'card'; card.id = 'brokerCard';
      /* mount right after the Sniper card -- decide, then place */
      var sn = $('sniperCard');
      if (sn && sn.nextSibling) side.insertBefore(card, sn.nextSibling); else side.appendChild(card);
    }
    var prof = active(), names = Object.keys(load());
    if (!pl) { card.innerHTML = '<h3>Order ticket <span class="tag">BROKER</span></h3><div style="font-size:11px;color:var(--muted2)">Load a symbol \u2014 the ticket builds from the Sniper plan.</div>'; return; }

    var tk = ticketText(sym, pl), sz = tk.sz, d = tk.digits;
    function fieldRow(label, val, copy) {
      return '<div class="bk-row"><span class="bk-l">' + label + '</span>'
        + '<b class="mono bk-v">' + val + '</b>'
        + (copy != null ? '<button class="bk-cp" data-cp="' + String(copy).replace(/"/g, '&quot;') + '" title="copy ' + label + '">\u29c9</button>' : '') + '</div>';
    }
    card.innerHTML =
      '<h3>Order ticket <span class="tag" title="The exact numbers you type into your broker. Symbol as THEY name it, lots from THEIR contract spec and YOUR account. Nothing auto-executes.">BROKER</span></h3>'
      + '<div class="bk-profwrap"><select id="bkProfile" class="bk-prof" title="Active broker profile. Switch \u2192 the ticket recomputes for that broker\u2019s symbol name and contract spec.">'
        + names.map(function (n) { return '<option' + (n === activeName() ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></div>'
      + fieldRow('symbol', sz.bsym, sz.bsym)
      + fieldRow('side', pl.dir, pl.dir)
      + fieldRow('entry', tk.entry.toFixed(d), tk.entry.toFixed(d))
      + fieldRow('SL', pl.stop.toFixed(d), pl.stop.toFixed(d))
      + fieldRow('TP', pl.t2.toFixed(d), pl.t2.toFixed(d))
      + (sz.ok
          ? fieldRow((prof.kind === 'binance' ? 'qty' : 'volume'), sz.lots + ' ' + sz.unit, sz.lots)
          : '<div class="bk-row"><span class="bk-l">' + (prof.kind === 'binance' ? 'qty' : 'volume') + '</span><b class="bk-v" style="color:var(--warn)">\u2014 not sized</b></div>')
      + (sz.ok ? '<div class="bk-math" title="the arithmetic, glass-box">' + sz.math + '</div>'
               : '<div class="bk-math" style="color:var(--warn)">' + sz.why + '</div>')
      + '<div class="bk-acct">acct ' + prof.balance.toLocaleString() + ' ' + prof.ccy + ' \u00b7 risk ' + prof.risk + '% \u00b7 <button class="bk-edit" id="bkEdit">edit profile</button></div>'
      + '<button class="tbtn bk-copy" id="bkCopyAll" title="copy the whole ticket for pasting into notes or your broker">\u29c9 copy full ticket</button>'
      + '<button class="tbtn bk-logged" id="bkLogged" title="T7: after you place this in ' + activeName() + ', tap to log it. It records the plan you actually took (symbol, side, entry, stop, size, strategy) into your journal and feeds the scoreboard + override ledger — so the system learns from your REAL trades, not hypotheticals.">\u2713 I placed this — log it</button>'
      + '<div class="bk-foot">Nothing auto-executes. These are the numbers you type into ' + activeName() + '.</div>'
      + '<div id="bkEditPanel" style="display:none"></div>';

    var selEl = $('bkProfile'); if (selEl) selEl.onchange = function () { setActive(selEl.value); render(); };
    card.querySelectorAll('.bk-cp').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); copyField(b.dataset.cp, b); }; });
    var ca = $('bkCopyAll'); if (ca) ca.onclick = function (e) { e.stopPropagation(); copyField(tk.text, ca); };
    var lg = $('bkLogged'); if (lg) lg.onclick = function (e) {
      e.stopPropagation();
      try {
        var rec = { t: Date.now(), broker: activeName(), sym: sz.bsym, mishelSym: sym, side: pl.dir,
          entry: tk.entry, stop: pl.stop, t1: pl.t1, t2: pl.t2, size: sz.ok ? sz.lots : null, unit: sz.unit,
          risk: sz.ok ? sz.actualRisk : null, strat: (window._sigState || {}).resolvedStrat || null,
          brainTier: (window._liveSig && window._liveSig.brain && window._liveSig.brain.tier) || null, res: 'open' };
        var K = 'realtrades.v1';
        var arr = []; try { arr = JSON.parse((window.STORE && STORE.get ? STORE.get(K) : localStorage.getItem(K)) || '[]'); } catch (_) {}
        arr.push(rec); if (arr.length > 500) arr = arr.slice(-400);
        var js = JSON.stringify(arr); if (window.STORE && STORE.set) STORE.set(K, js); else localStorage.setItem(K, js);
        window._realTrades = arr;
        /* also drop a line into the alert log so it is visible immediately */
        if (window.ALERT_LOG) { window.ALERT_LOG.unshift({ t: Date.now(), sym: sz.bsym, desc: 'LOGGED ' + pl.dir + ' @ ' + tk.entry.toFixed(d) + (sz.ok ? ' · ' + sz.lots + ' ' + sz.unit : ''), val: '' }); if (window.updateBell) updateBell(); }
        lg.textContent = '✓ logged — resolve it in the journal when closed';
        lg.disabled = true;
      } catch (_) {}
    };
    var ed = $('bkEdit'); if (ed) ed.onclick = function (e) { e.stopPropagation(); editPanel(); };
  }

  /* T9/T3: edit the active profile's balance, risk, and per-symbol spec */
  function editPanel() {
    var panel = $('bkEditPanel'); if (!panel) return;
    if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
    var prof = active(), bsym = brokerSym((window.CURSYM || {}).sym || 'BTCUSD', prof);
    var sp = (prof.specs && prof.specs[bsym]) || { contract: '', digits: 2, minLot: 0.01, lotStep: 0.01 };
    panel.style.display = 'block';
    panel.innerHTML =
      '<div class="bk-edit-h">' + activeName() + ' \u2014 edit</div>'
      + '<label class="bk-f">account balance <input id="bkBal" type="number" value="' + prof.balance + '"></label>'
      + '<label class="bk-f">default risk % <input id="bkRisk" type="number" step="0.1" value="' + prof.risk + '"></label>'
      + '<div class="bk-edit-h" style="margin-top:6px">contract spec for <b>' + bsym + '</b> <span title="From your broker\u2019s spec sheet. contract = units per 1.00 lot. XAUUSD = 100 (oz), FX = 100000, crypto CFD often 1. Wrong here = wrong size.">\u24d8</span></div>'
      + '<label class="bk-f">contract size <input id="bkContract" type="number" value="' + sp.contract + '"></label>'
      + '<label class="bk-f">digits <input id="bkDigits" type="number" value="' + sp.digits + '"></label>'
      + '<label class="bk-f">min lot <input id="bkMin" type="number" step="0.0001" value="' + sp.minLot + '"></label>'
      + '<label class="bk-f">lot step <input id="bkStep" type="number" step="0.0001" value="' + sp.lotStep + '"></label>'
      + '<button class="tbtn" id="bkSave">save</button>';
    panel.querySelectorAll('input').forEach(function (i) { i.onclick = function (e) { e.stopPropagation(); }; });
    $('bkSave').onclick = function (e) {
      e.stopPropagation();
      var p = load(), pr = p[activeName()];
      pr.balance = +$('bkBal').value || pr.balance;
      pr.risk = +$('bkRisk').value || pr.risk;
      pr.specs = pr.specs || {};
      pr.specs[bsym] = { contract: +$('bkContract').value || null, digits: +$('bkDigits').value || 2, minLot: +$('bkMin').value || 0.01, lotStep: +$('bkStep').value || 0.01 };
      save(p); render();
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render); else setTimeout(render, 1700);
  setInterval(render, 5000);
  window.brokerDesk = { render: render, active: active, sizeFor: sizeFor, ticketText: ticketText, brokerSym: brokerSym };
})();
