
/* ── v39.12 · TICK BUS ───────────────────────────────────────────────────
   Before this, every decision card polled on its own timer (Sniper 4s,
   ticket 5s, watch 6s, ticker 15s), disconnected from the websocket — so the
   ARM level, pip distances and spread lagged the tape by up to 6s. The bus
   lets the FASTEST feed (renderQuick, called by every feed incl. the ws kline
   in applyKline) drive read-only cards directly. rAF-batched — one repaint per
   frame no matter how many ticks land — and subscribers self-skip when the
   price is unchanged. The old intervals stay as the heartbeat for quiet/offline
   periods and for tab-wake catch-up; this is the live path. Defined above the
   Clock banner so the ops-test's marker-based IIFE grab still lands on Clock. */
(function(){
  var subs=[], sched=false, last=null;
  function flush(){ sched=false; var px=last; for(var i=0;i<subs.length;i++){ try{ subs[i](px); }catch(e){} } }
  window.Tick={
    emit:function(px){ if(px!=null&&isFinite(px)) last=px;
      if(sched) return; sched=true;
      if(typeof requestAnimationFrame==='function' && !(typeof document!=='undefined'&&document.hidden)) requestAnimationFrame(flush);
      else setTimeout(flush,16);
    },
    on:function(fn){ if(typeof fn==='function'&&subs.indexOf(fn)<0) subs.push(fn);
      return function(){ var i=subs.indexOf(fn); if(i>=0) subs.splice(i,1); }; },
    subs:subs
  };
  window.onTick=window.Tick.on;          /* subscribe: window.onTick(fn) -> returns an unsubscribe */
  /* content-hash guard (S9): skip fn when the signature is unchanged since last paint under key */
  var _sig={};
  window.renderIfChanged=function(key,sig,fn){ if(_sig[key]===sig) return false; _sig[key]=sig; try{ fn&&fn(); }catch(e){} return true; };
})();
/* =====================================================================
   v35.0 OPERATIONAL SPINE — CLOCK + FRESHNESS CONTRACT
   ---------------------------------------------------------------------
   Problem this solves (see HANDOVER "operational fragility"):
     · 57 independent setIntervals: no registry, no error isolation — one
       throwing timer used to die silently and take its whole job with it.
     · Background tabs: Chrome throttles timers to >=60s when the tab is not
       focused. The UI kept rendering the last value and still said LIVE.
       You are always in MT5, so the terminal is ALWAYS a background tab.
       That is not "fragility" — that is a WRONG NUMBER at the moment of
       decision. We cannot defeat the browser's throttling; we CAN refuse to
       lie about it.
   The contract:
     1. Clock owns every recurring job (setInterval is wrapped — zero call-site
        edits, all 57 enrol automatically). One place to see them all.
     2. Each job is try-guarded: one job dies, the other 56 keep running, and
        the failure is recorded, not swallowed.
     3. On tab wake (visibilitychange -> visible) every due job runs IMMEDIATELY
        — catch-up, instead of stale-then-eventually.
     4. Fresh: every decision surface asks "how old is this number?" and BLOCKS
        when the answer is bad. Honest empty > confident stale.
   ===================================================================== */
(function(){
  var _natSet = window.setInterval.bind(window);
  var _natClr = window.clearInterval.bind(window);
  var BASE = 900000;                    /* Clock ids live above this; native ids stay below */

  var Clock = {
    jobs: {}, seq: 0, driver: null, lastWake: 0, wokeAfter: 0,
    add: function(name, ms, fn, opt){
      opt = opt || {};
      var id = BASE + (++this.seq);
      this.jobs[id] = { id:id, name:name||('job#'+this.seq), ms:Math.max(1,ms|0), fn:fn,
                        render:!!opt.render, last:Date.now(), runs:0, errs:0, lastErr:null, lastRun:null };
      return id;
    },
    clear: function(id){ if(this.jobs[id]){ delete this.jobs[id]; return true } return false },
    /* render:true jobs are pure paint — skipped while hidden, caught up on wake.
       Everything else keeps running (subject to the browser's own throttling,
       which we do not pretend to control). */
    tick: function(){
      var now = Date.now(), vis = (document.visibilityState !== 'hidden');
      for (var k in this.jobs){
        var j = this.jobs[k];
        if (now - j.last < j.ms) continue;
        if (j.render && !vis) { j.last = now; continue; }   /* skip paint, don't pile up */
        j.last = now; j.runs++; j.lastRun = now;
        try { j.fn() }
        catch(e){ j.errs++; j.lastErr = (e && e.message) || String(e);
                  try{ if(window.logErr) window.logErr('clock:'+j.name, e) }catch(_){ } }
      }
    },
    /* wake: every job becomes due at once, so the screen is never a minute behind */
    wake: function(){
      var gap = this.lastWake ? Date.now()-this.lastWake : 0;
      this.wokeAfter = gap;
      for (var k in this.jobs) this.jobs[k].last = 0;
      this.tick();
      this.lastWake = Date.now();
    },
    /* the operational X-ray: name / interval / runs / errors / last run */
    report: function(){
      var out = [], now = Date.now();
      for (var k in this.jobs){ var j = this.jobs[k];
        out.push({ name:j.name, ms:j.ms, runs:j.runs, errs:j.errs,
                   ageS: j.lastRun ? Math.round((now-j.lastRun)/1000) : null,
                   lastErr:j.lastErr, render:j.render }) }
      return out.sort(function(a,b){ return b.errs-a.errs || a.ms-b.ms });
    },
    health: function(){ var r=this.report(); return { jobs:r.length,
      failing:r.filter(function(j){return j.errs>0}).length,
      errs:r.reduce(function(a,j){return a+j.errs},0) } }
  };

  /* --- the single driver. 250ms granularity: sub-second jobs still feel instant --- */
  Clock.driver = _natSet(function(){ Clock.tick() }, 250);

  /* --- govern setInterval: all 57 existing call sites enrol with zero edits --- */
  window.setInterval = function(fn, ms){
    if (typeof fn !== 'function') return _natSet.apply(null, arguments);   /* string-eval form: not ours */
    var nm = 'anon@' + (ms|0) + 'ms';
    /* v39.5 X4 — the old fallback grabbed the FIRST call-site inside the body,
       which is how the X-ray filled with jobs named "M", "toLowerCase" and
       "Date": stack-trace garbage wearing a name tag. Preference order now:
       fn.name (covers named functions AND const foo = () => ...), then the
       function keyword. If neither, an honest anon beats a wrong name. */
    try {
      if (fn.name && fn.name !== 'anonymous') nm = fn.name + '@' + (ms|0) + 'ms';
      else { var m = String(fn).slice(0,90).match(/function\s+([A-Za-z0-9_$]+)/);
             if (m) nm = m[1] + '@' + (ms|0) + 'ms'; }
    } catch(_){}
    return Clock.add(nm, ms, fn);
  };
  window.clearInterval = function(id){ if (!Clock.clear(id)) _natClr(id) };

  /* --- tab wake: catch up immediately, and say so if the gap was long --- */
  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible'){
      Clock.wake();
      try{ if (Clock.wokeAfter > 120000 && window.toast)
             toast('Tab was backgrounded ' + Math.round(Clock.wokeAfter/60000) + 'm — jobs caught up, checking data freshness', 'var(--gold)') }catch(_){}
    } else { Clock.lastWake = Date.now(); }
  });
  window.addEventListener('focus', function(){ Clock.wake() });
  window.Clock = Clock;

  /* =====================================================================
     FRESHNESS CONTRACT — one place that answers "may I act on this number?"
     Two separate clocks, never conflated:
       tickAge  = how long since the feed last moved   (is it ALIVE?)
       vendorLag = the vendor's own delay, e.g. yfinance ~15m (is it CURRENT?)
     A yfinance feed can be perfectly ALIVE and still 15 minutes behind your
     broker. Both facts get told; neither is hidden behind the word "LIVE".
     ===================================================================== */
  var VENDOR_LAG_MS = 15*60*1000;   /* yfinance proxy — labelled, never silently absorbed */
  window.Fresh = {
    online: function(){ try{ return (typeof MODE!=='undefined' && MODE==='online') }catch(_){ return false } },
    tickAge: function(){ return window._lastTick ? Date.now()-window._lastTick : null },
    vendorLag: function(){ return window._feedDelay ? VENDOR_LAG_MS : 0 },
    /* the honest total: how old is the price actually on screen */
    dataAge: function(){ var a=this.tickAge(); return a==null ? null : a + this.vendorLag() },
    thresh: function(){ return window._feedDelay ? {live:120000, lag:600000}   /* polled proxy */
                                                 : {live:20000,  lag:90000} }, /* websocket   */
    /* live | lagging | stale | offline  — 'offline' means synthetic/no real feed */
    state: function(){
      if (!this.online() || !window._realFeed) return 'offline';
      var a = this.tickAge(); if (a == null) return 'stale';
      var t = this.thresh();
      return a <= t.live ? 'live' : a <= t.lag ? 'lagging' : 'stale';
    },
    /* THE GATE. Anything that tells you to act must call this first. */
    ok:     function(){ var s=this.state(); return s==='live' || s==='lagging' },
    blocks: function(){ return !this.ok() },
    why: function(){
      var s = this.state();
      if (s === 'offline') return 'OFFLINE / synthetic data — nothing here is a real price. Switch to Online.';
      if (s === 'stale')   { var a=this.tickAge();
        return 'FEED STALE — last tick ' + (a==null?'never':Math.round(a/1000)+'s ago') + '. Not a tradeable number.' }
      if (s === 'lagging') return 'feed lagging — verify at your broker before acting';
      if (window._feedBroker)
        return 'REAL \u00b7 BROKER — these are YOUR broker\'s bars and YOUR spread. '
             + 'Every level, ATR and stop below is computed on the series you are actually filled on.';
      return window._feedDelay
        ? 'REAL \u00b7 delayed \u2014 vendor is ~15m behind. Levels are indicative; your broker is the truth.'
        : 'live \u2014 exchange feed. For FX/metals, connect MT5: a vendor series is not the market you trade.';
    },
    label: function(){
      var s=this.state(), a=this.tickAge();
      if (s==='offline') return 'OFFLINE';
      if (s==='stale')   return 'STALE ' + (a==null?'\u2014':Math.round(a/1000)+'s');
      if (s==='lagging') return 'LAG ' + Math.round(a/1000) + 's';
      /* v36.0: there are three classes of truth, and only one of them is YOUR price.
         BROKER  — the venue you are actually filled at. Nothing outranks it.
         LIVE    — a real exchange feed (crypto): the venue, for crypto.
         delayed — a vendor's idea of the price. Useful. Not tradeable. */
      if (window._feedBroker) return 'REAL \u00b7 BROKER';
      return window._feedDelay ? 'REAL \u00b7 delayed' : 'LIVE';
    },
    /* v36.0: is the series on screen the series you get filled on? */
    broker: function(){ return !!window._feedBroker },
    color: function(){ var s=this.state();
      if (s==='live' && window._feedBroker) return 'var(--fav,#6fd08c)';
      return s==='live' ? 'var(--up,#6fd08c)' : s==='lagging' ? 'var(--gold)' : 'var(--bear)' }
  };
})();

