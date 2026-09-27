/* =====================================================================
   v35.0 STAGE C — DURABLE STATE (SQLite is the source of truth)
   ---------------------------------------------------------------------
   Your decision journal, your armed strategies, your drawings, your wallet
   DB lived in ONE browser profile. A Chrome reset, a new laptop, a cleared
   cache, and years of measured record are gone. That is not a nice-to-have.

   The split is deliberate:
     DURABLE  (15 keys) -> mirrored to SQLite via /svc/kv. Survives everything.
     LOCAL    (~42 keys) -> theme, pane heights, glass, compact, rail width...
                            these SHOULD be per-device. Syncing them is a bug.

   Reads stay instant (localStorage is the cache). Writes go to both.
   Server down? We say UNSYNCED in the status bar. We never pretend.
   ===================================================================== */
(function(){
  var DURABLE = ["mishel_journal","mishel_sigalerts","mishel_sigmem","mishel_drawmap","mishel_drawtpl",
                 "mishel_annot","mishel_pins","mishel_actionq","mishel_layouts","mishel_guard",
                 "mishel_ck_acct","mishel_ck_risk","mishel_ruggers","mishel_walletdb","mishel_wnick"];
  var DSET = {}; DURABLE.forEach(function(k){ DSET[k]=1 });
  var REVK = 'mishel_kvrev';                 /* local view of server revisions */
  var queue = {}, timer = null;

  function svcBase(){ try{ return (window.SVC_URL || 'http://127.0.0.1:8788') }catch(_){ return 'http://127.0.0.1:8788' } }
  function svcHeaders(){ var h={'Content-Type':'application/json'};
    try{ var t=localStorage.getItem('mishel_svctoken'); if(t) h['Authorization']='Bearer '+t }catch(_){}
    return h }
  function revs(){ try{ return JSON.parse(localStorage.getItem(REVK)||'{}') }catch(_){ return {} } }
  function setRevs(r){ try{ localStorage.setItem(REVK, JSON.stringify(r)) }catch(_){} }

  window.SYNC = { state:'idle', last:0, err:null, pending:0 };

  function flush(){
    timer = null;
    var items = queue; queue = {};
    var n = Object.keys(items).length; if(!n) return;
    SYNC.pending = n;
    fetch(svcBase()+'/svc/kv', {method:'POST', headers:svcHeaders(), body:JSON.stringify({items:items})})
      .then(function(r){ return r.json() })
      .then(function(j){
        if(!j || !j.ok) throw new Error((j&&j.err)||'service refused');
        var r = revs(); for(var k in (j.revs||{})) r[k]=j.revs[k]; setRevs(r);
        SYNC.state='synced'; SYNC.last=Date.now(); SYNC.err=null; SYNC.pending=0;
      })
      .catch(function(e){
        /* honest failure: keep the writes queued, say UNSYNCED, never claim success */
        for(var k in items) queue[k]=items[k];
        SYNC.state='unsynced'; SYNC.err=(e&&e.message)||String(e); SYNC.pending=Object.keys(queue).length;
        if(!timer) timer=setTimeout(flush, 30000);          /* retry, backed off */
      });
  }

  window.STORE = {
    durable: function(k){ return !!DSET[k] },
    get: function(k){ try{ return localStorage.getItem(k) }catch(_){ return null } },   /* cache read: instant */
    set: function(k, v){
      try{ localStorage.setItem(k, v) }catch(_){}                                        /* cache write */
      if(DSET[k]){ queue[k]=v; SYNC.pending=Object.keys(queue).length;
                   if(!timer) timer=setTimeout(flush, 2000); }                           /* debounced mirror */
      return v;
    },
    flushNow: function(){ if(timer){ clearTimeout(timer); timer=null } flush() },
    /* boot: if the server is AHEAD of this browser, this browser is the stale one.
       Pull down. This is what makes a new laptop / wiped profile a non-event. */
    hydrate: function(){
      return fetch(svcBase()+'/svc/kv/manifest', {headers:svcHeaders()})
        .then(function(r){ return r.json() })
        .then(function(j){
          if(!j || !j.ok) throw new Error('no manifest');
          var local = revs(), want = [];
          for(var k in (j.manifest||{})){
            if(!DSET[k]) continue;
            var srev = j.manifest[k].rev|0, lrev = local[k]|0;
            var have = null; try{ have = localStorage.getItem(k) }catch(_){}
            if(srev > lrev || have == null) want.push(k);
          }
          if(!want.length){ SYNC.state='synced'; SYNC.last=Date.now(); return {pulled:0} }
          return Promise.all(want.map(function(k){
            return fetch(svcBase()+'/svc/kv/'+encodeURIComponent(k), {headers:svcHeaders()})
              .then(function(r){ return r.json() })
              .then(function(d){
                if(d && d.ok && d.v != null){
                  try{ localStorage.setItem(k, d.v) }catch(_){}
                  var r2=revs(); r2[k]=d.rev; setRevs(r2);
                  return k;
                } return null;
              }).catch(function(){ return null });
          })).then(function(got){
            got = got.filter(Boolean);
            SYNC.state='synced'; SYNC.last=Date.now();
            if(got.length){
              try{ toast('\u21bb Restored '+got.length+' item(s) from the service \u2014 this browser was behind','var(--gold)') }catch(_){}
            }
            return {pulled:got.length, keys:got};
          });
        })
        .catch(function(e){ SYNC.state='unsynced'; SYNC.err=(e&&e.message)||String(e); return {pulled:0} });
    }
  };

  /* flush on the way out — a closed tab must not lose the last journal entry */
  window.addEventListener('beforeunload', function(){
    try{ if(Object.keys(queue).length){
      var b=new Blob([JSON.stringify({items:queue})],{type:'application/json'});
      navigator.sendBeacon(svcBase()+'/svc/kv', b);
    } }catch(_){}
  });

  setTimeout(function(){ try{ STORE.hydrate() }catch(_){} }, 900);
})();

/* =====================================================================
   iram Intelligence — interactive prototype
   Mirrors the real modular Python architecture in miniature so the demo
   is genuinely computed, not faked: indicators, SMC detection, and the
   glass-box confluence engine all run real (simplified) logic.
   ===================================================================== */

/* ---------- seeded RNG (reproducible synthetic feed) ---------- */
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

/* ---------- synthetic OHLCV with regimes ---------- */
