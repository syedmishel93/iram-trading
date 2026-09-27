/* ================= v13.9 N1: NUMERICAL FEATURE BUS + N2 client (pixel-free, server ML) ================= */
(function(){try{
  var SVC='http://127.0.0.1:8788';
  setInterval(function(){try{
    var c=document.getElementById('deskNarr');if(!c||document.getElementById('mlBtn'))return;
    var b=document.createElement('button');b.className='run';b.id='mlBtn';b.style.cssText='margin-top:6px;padding:5px 12px;font-size:10.5px';b.textContent='Walk-forward model check \u25b7';
    var o=document.createElement('div');o.id='mlOut';o.style.cssText='font-size:10.5px;color:var(--muted);margin-top:5px;line-height:1.5';
    c.appendChild(b);c.appendChild(o);
    b.onclick=async function(){try{o.textContent='training walk-forward (server)\u2026';
      var r=await fetch(SVC+'/svc/ml/predict',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({closes:DATA.map(function(x){return x.c}),highs:DATA.map(function(x){return x.h}),lows:DATA.map(function(x){return x.l}),vols:DATA.map(function(x){return x.v}),horizon:24})});
      var j=await r.json();
      if(!j.ok){o.textContent='model: '+(j.err||'unavailable')+' \u2014 start the background service (server/run_service.sh) with scikit-learn installed';return}
      var edge=Math.abs(j.p_up-0.5);
      o.innerHTML='P(up, 24 bars) = <b style="color:'+(j.p_up>0.5?'var(--bull)':'var(--bear)')+'">'+(j.p_up*100).toFixed(0)+'%</b> \u00b7 out-of-sample acc <b>'+(j.acc*100).toFixed(0)+'%</b> \u00b7 Brier '+j.brier.toFixed(3)+' \u00b7 n='+j.n
        +(edge<0.06||j.acc<0.53?' \u2014 <span style="color:var(--gold)">weak edge: treat as noise, not signal</span>':'')
        +' <span style="color:var(--muted2)">(numbers-in, numbers-out \u2014 no pixels; strict time splits, no leakage)</span>';
    }catch(e){o.textContent='service unreachable \u2014 run server/run_service.sh'}};
  }catch(e){}},4000);
}catch(e){}})();
/* ================= v14.0 L2 AUTO-DISCOVERY + L3 SYSTEM STATUS PILL ================= */
(function(){try{
  async function probe(u){try{var r=await fetch(u,{signal:AbortSignal.timeout(2500)});return r.ok}catch(e){return false}}
  var S={proxy:false,svc:false,tg:false,ml:false};
  async function check(){
    S.proxy=await probe('http://127.0.0.1:8787/health');
    try{var r=await fetch('http://127.0.0.1:8788/svc/health',{signal:AbortSignal.timeout(2500)});var j=await r.json();S.svc=!!j.ok;S.tg=!!j.telegram}catch(e){S.svc=false;S.tg=false}
    /* L2: auto-configure the proxy field once, when found and empty */
    if(S.proxy){try{var inp=document.getElementById('dsProxyUrl');
      if(inp&&!inp.value.trim()){inp.value='http://127.0.0.1:8787';
        inp.dispatchEvent(new Event('input',{bubbles:true}));inp.dispatchEvent(new Event('change',{bubbles:true}));
        try{toast('Proxy auto-discovered on :8787 \u2014 configured',var_bull())}catch(e){}}}catch(e){}}
    paint();}
  function dot(on){return '<i style="display:inline-block;width:7px;height:7px;border-radius:50%;margin:0 4px 0 7px;background:'+(on?'var(--bull)':'var(--bear)')+'"></i>'}
  function paint(){var p=document.getElementById('sysPill');
    if(!p){/* v39.1 E1: the system pill belongs with system truth - the status bar's left cluster - not squeezed against the viewport edge in the top bar. */var top=document.getElementById('stSys')||document.querySelector('.top');if(!top)return;
      p=document.createElement('div');p.id='sysPill';
      p.style.cssText='display:flex;align-items:center;font-size:9.5px;letter-spacing:.05em;color:var(--muted);border:1px solid var(--edge);border-radius:999px;padding:4px 10px 4px 4px;margin-left:8px;cursor:pointer;user-select:none';
      p.title='System status \u2014 click for details';top.appendChild(p);
      p.onclick=function(){try{toast(
        (S.proxy?'proxy \u2713':'proxy \u2717 \u2014 run start_mishel.bat / start_mishel.py')+' \u00b7 '+
        (S.svc?'service \u2713':'service \u2717 \u2014 run start_mishel.bat')+' \u00b7 '+
        (S.tg?'telegram \u2713':'telegram \u2717 \u2014 POST /svc/telegram or Settings'),
        S.proxy&&S.svc?var_bull():'var(--gold)')}catch(e){}};}
    p.innerHTML=dot(S.proxy)+'PROXY'+dot(S.svc)+'SVC'+dot(S.tg)+'TG';}
  setTimeout(check,2500);setInterval(check,20000);
}catch(e){}})();
/* =====================================================================
   v38.0 — (1) THE REAL COST MODEL   (2) THE ★ PICKER STOPS LYING
   =====================================================================

   TWO FABRICATIONS, BOTH LOAD-BEARING, BOTH REMOVED HERE.

   (1) COST. For 37 versions every instrument was costed at a flat 2bps,
       and commission and swap were ignored ENTIRELY. Gold's spread at
       rollover is nothing like EURUSD's at midday. A pair held over
       Wednesday pays TRIPLE swap. Every "net R", every OOS win-rate,
       every ★ pick was computed against a market that does not exist.
       mt5_specs now holds the broker's real numbers. Use them.

   (2) THE PICKER. sigBestWF scans 26 strategies, picks the best by avgR
       on each training fold, and reports the aggregated test outcome.
       That is walk-forward, which is good — but it is still BEST-OF-26,
       and nothing anywhere deflated the result for 26 trials. Search hard
       enough through noise and something always looks brilliant.
       The PBO (CSCV) and Deflated-Sharpe machinery has been sitting in
       this codebase since v13, wired only to a backtest panel nobody
       opens. Here it is wired to the thing that actually tells him what
       to trade — with the power to REFUSE.
   ===================================================================== */

/* ---------------------------------------------------------------------
   1. COST MODEL
   window.COSTSPEC[sym] is filled from the broker (mt5_specs) by costSync().
   Order of truth:  broker spec > live broker tick > live book > ASSUMPTION
   An assumption is allowed. An UNLABELLED assumption is not.
   --------------------------------------------------------------------- */
window.COSTSPEC = window.COSTSPEC || {};

window.costSync = function(){
  var base=(window.SVC_URL||'http://127.0.0.1:8788');
  return fetch(base+'/svc/costs').then(function(r){return r.json()})
    .then(function(j){
      if(j && j.ok && j.specs){
        window.COSTSPEC=j.specs;
        window._costAt=Date.now();
      }
      return j;
    }).catch(function(){ return null });
};

/* bars -> nights held, for swap. TF-aware: 40 bars on 1m is not a night. */
function _nights(barsHeld){
  try{
    var ms=(typeof tfSeconds==='function'?tfSeconds(TF):3600)*1000;
    return Math.max(0, Math.floor((barsHeld*ms)/86400000));
  }catch(e){ return 0 }
}

/* Returns {costR, parts, source} or null. Never throws into the scan loop. */
window.costModel = function(entry, R, barsHeld){
  try{
    if(!(R>0)) return null;
    var sym=((typeof CURSYM!=='undefined'&&CURSYM.sym)||'').toUpperCase();
    var sp=window.COSTSPEC[sym];
    var spreadPx=null, source=null, comm=0, swap=0;

    /* (a) the broker's live tick — the truest thing available */
    var bs=window._brokerSpread;
    if(bs && bs.sym===sym && (Date.now()-bs.t)<120000 && bs.spread>0){
      spreadPx=bs.spread; source='broker tick (live)';
    }
    /* (b) the broker's own spec */
    if(spreadPx==null && sp && sp.spread_points>0 && sp.point>0){
      spreadPx=sp.spread_points*sp.point; source='broker spec';
    }
    /* (c) a live L2 book (crypto) */
    if(spreadPx==null && window._oflow && window._oflow.spread
       && window._oflow.spread.ask>window._oflow.spread.bid){
      spreadPx=window._oflow.spread.ask-window._oflow.spread.bid; source='live book';
    }
    /* (d) an ASSUMPTION — permitted, but it says so, loudly and forever */
    if(spreadPx==null){ spreadPx=entry*0.0002; source='ASSUMED 2bps (no broker spec)'; }

    /* commission + swap: only the broker knows these, and only if we asked */
    if(sp){
      /* commission is charged per side; specs give it per lot, so express it in
         price terms via the contract size. If the broker reports none, it is zero
         because the cost is IN the spread — not because we could not be bothered. */
      if(sp.commission_per_lot && sp.contract_size)
        comm = (2*Math.abs(sp.commission_per_lot))/sp.contract_size;   /* both sides */
      var n=_nights(barsHeld||0);
      if(n>0 && sp.swap_long!=null && sp.contract_size){
        /* swap points are per lot per night; sign matters — a positive swap PAYS you */
        var perNight=(Math.abs(sp.swap_long)*(sp.point||1))/1;
        swap = (n*perNight)/1;
        if(sp.swap_long>0) swap = -swap;   /* a credit reduces cost */
      }
    }

    var totalPx = spreadPx + comm + Math.max(0, swap);
    var costR = totalPx / R;

    /* The old code capped cost at 0.15R. A cap is a lie with a ceiling: if a trade
       really does cost 0.4R, that trade is not worth taking and the system must be
       allowed to SAY so. No cap — but flag the absurd. */
    return {
      costR: costR,
      parts: {spreadPx: spreadPx, commissionPx: comm, swapPx: swap,
              nights: _nights(barsHeld||0)},
      source: source,
      assumed: source.indexOf('ASSUMED')===0,
      heavy: costR>0.25
    };
  }catch(e){ return null }
};

/* what the UI shows so he always knows what his numbers were costed with */
