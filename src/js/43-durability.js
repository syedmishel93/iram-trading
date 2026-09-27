/* ================= v29.0 DURABILITY: #3 auto-backup · #7 error telemetry · #8 schema versioning ================= */
(function(){
  /* #8: schema version stamp + central migrate stub */
  var SCHEMA=1;
  try{var cur=+(localStorage.getItem('mishel_schema')||0);
    if(cur===0){localStorage.setItem('mishel_schema',SCHEMA);}
    else if(cur<SCHEMA){ /* migrate(cur -> SCHEMA): add per-key upgrades here; never silently reinterpret old shapes */
      localStorage.setItem('mishel_schema',SCHEMA);}
  }catch(e){}
  /* #7: error telemetry ring buffer + status badge */
  window._errlog=window._errlog||[];
  function logErr(kind,msg,src){try{window._errlog.push({t:Date.now(),kind:kind,msg:String(msg).slice(0,300),src:String(src||'').slice(0,120)});
    if(window._errlog.length>50)window._errlog.shift();badge()}catch(e){}}
  window.addEventListener('error',function(e){var st2='';try{st2=(e.error&&e.error.stack||'').split('\n')[1]||''}catch(e2){}logErr('error',e.message+(st2?' | '+st2.trim().slice(0,80):''),(e.filename||'')+':'+(e.lineno||''))});
  window.addEventListener('unhandledrejection',function(e){logErr('promise',(e.reason&&e.reason.message)||e.reason||'rejected','')});
  function badge(){try{var st=document.querySelector('.status');if(!st)return;var b=document.getElementById('errBadge');
    if(!b){b=document.createElement('span');b.id='errBadge';b.style.cssText='cursor:pointer;color:var(--bear);font-weight:700;margin-left:8px';
      b.title='client errors this session \u2014 click for the list (v29 #7: failures must be loud, not silent)';
      b.onclick=function(){var L=window._errlog.slice(-12).map(function(x){return new Date(x.t).toISOString().slice(11,19)+' ['+x.kind+'] '+x.msg+(x.src?' @'+x.src:'')}).join('\n');
        alert('Client errors (last '+Math.min(12,window._errlog.length)+' of '+window._errlog.length+'):\n\n'+(L||'none'))};
      (document.getElementById('stSlot')||st).appendChild(b)/* v39.1: badges land in the slot, never loose in the bar */;}
    b.textContent='\u26a0 '+window._errlog.length;b.style.display=window._errlog.length?'':'none';}catch(e){}}
  /* #3: auto-backup of decision-critical localStorage to the service (every 4h + on leave) */
  function backupBlob(){var keys=['mishel_walletdb','mishel_pins','mishel_actionq','mishel_wnick','mishel_cockpit','mishel_wsnap'];
    var o={_v:SCHEMA,_t:Date.now()};keys.forEach(function(k){try{var v=localStorage.getItem(k);if(v!=null)o[k]=v}catch(e){}});return o;}
  function doBackup(sync){try{var sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    var body=JSON.stringify(backupBlob());
    if(sync&&navigator.sendBeacon){navigator.sendBeacon(sb+'/svc/backup',new Blob([body],{type:'application/json'}));return}
    fetch(sb+'/svc/backup',{method:'POST',headers:{'content-type':'application/json'},body:body,signal:AbortSignal.timeout(4000)})
      .then(function(r){if(r.ok)console.log('[mishel] state backed up to service')}).catch(function(){});}catch(e){}}
  setTimeout(doBackup,20000);setInterval(doBackup,4*3600*1000);
  window.addEventListener('beforeunload',function(){doBackup(true)});
  /* restore-on-empty: if the wallet DB is empty but the service holds a backup, offer it once */
  setTimeout(function(){try{
    var have=false;try{have=Object.keys(JSON.parse(localStorage.getItem('mishel_walletdb')||'{}')).length>0}catch(e){}
    if(have)return;
    var sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    fetch(sb+'/svc/backup',{signal:AbortSignal.timeout(3000)}).then(function(r){return r.json()}).then(function(j){
      if(!j||!j.backup||!j.backup.mishel_walletdb)return;
      var n=0;try{n=Object.keys(JSON.parse(j.backup.mishel_walletdb)).length}catch(e){}
      if(!n)return;
      if(confirm('Your local wallet DB is empty, but the service holds a backup with '+n+' wallets from '+new Date(j.backup._t||j.t*1000).toLocaleString()+'.\n\nRestore it?')){
        Object.keys(j.backup).forEach(function(k){if(k[0]!=='_')try{localStorage.setItem(k,j.backup[k])}catch(e){}});
        location.reload();}
    }).catch(function(){});}catch(e){}},6000);
})();

/* ================= v35.0 A3: freshness chip + jobs X-ray ================= */
(function(){
  function paintFresh(){ try{
    var el=document.getElementById('stFresh'); if(!el||!window.Fresh) return;
    el.textContent = Fresh.label();
    el.style.color = Fresh.color();
    var w=document.getElementById('stFreshWrap'); if(w) w.title = Fresh.why();
  }catch(e){} }

  function paintClock(){ try{
    var el=document.getElementById('stClock'); if(!el||!window.Clock) return;
    var h=Clock.health();
    el.textContent = h.jobs + (h.failing? ' \u00b7 '+h.failing+'\u26a0' : '');
    el.style.color = h.failing ? 'var(--bear)' : 'var(--muted)';
  }catch(e){} }

  window.clockXray=function(){ try{
    var r=Clock.report();
    var rows=r.map(function(j){
      return '<tr'+(j.errs?' style="color:var(--bear)"':'')+'><td class="mono">'+j.name+'</td><td class="mono">'+j.ms+'ms</td>'
        +'<td class="mono">'+j.runs+'</td><td class="mono">'+(j.errs||'')+'</td>'
        +'<td class="mono">'+(j.ageS==null?'\u2014':j.ageS+'s')+'</td>'
        +'<td style="font-size:10px;color:var(--muted)">'+(j.lastErr||'')+'</td></tr>' }).join('');
    var m=document.getElementById('clockModal');
    if(!m){ m=document.createElement('div'); m.id='clockModal';
      m.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
      m.onclick=function(e){ if(e.target===m) m.remove() };
      document.body.appendChild(m); }
    m.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge);border-radius:12px;padding:18px;max-width:760px;max-height:76vh;overflow:auto">'
      +'<h3 style="margin:0 0 4px">\u23f1 Clock \u2014 jobs X-ray</h3>'
      +'<p style="color:var(--muted);font-size:11px;margin:0 0 10px;line-height:1.6">Every recurring job on one scheduler. A job that throws is isolated and counted here \u2014 it can no longer die silently. '
      +'Browsers throttle background tabs to \u226560s; the Clock cannot defeat that, so on wake it runs every due job immediately and the freshness chip tells you the truth in the meantime.</p>'
      +'<table class="log" style="width:100%"><thead><tr><th>job</th><th>every</th><th>runs</th><th>errs</th><th>last run</th><th>last error</th></tr></thead><tbody>'+rows+'</tbody></table>'
      +'<p style="color:var(--muted2);font-size:10px;margin:10px 0 0">Last wake gap: '+(Clock.wokeAfter?Math.round(Clock.wokeAfter/1000)+'s':'\u2014')+'</p></div>';
  }catch(e){} };

  setTimeout(function(){
    try{ var w=document.getElementById('stClockWrap'); if(w){ w.style.cursor='pointer'; w.onclick=clockXray } }catch(e){}
    paintFresh(); paintClock();
  }, 1200);
  function paintSync(){ try{
    var el=document.getElementById('stSync'); if(!el||!window.SYNC) return;
    var s=SYNC.state, age=SYNC.last?Math.round((Date.now()-SYNC.last)/1000):null;
    el.textContent = s==='synced' ? (age!=null? age+'s' : 'ok')
                   : s==='unsynced' ? ('\u26a0 UNSYNCED'+(SYNC.pending?' ('+SYNC.pending+')':''))
                   : '\u2014';
    el.style.color = s==='synced' ? 'var(--muted)' : s==='unsynced' ? 'var(--bear)' : 'var(--muted2)';
    var w=document.getElementById('stSyncWrap');
    if(w) w.title = s==='unsynced'
      ? ('NOT SYNCED \u2014 '+(SYNC.err||'service unreachable')+'. Writes are queued and will retry; your journal is NOT yet safe on disk. Start the service.')
      : 'Durable state mirrored to SQLite (journal, armed strategies, drawings, wallet DB). Click to force a sync now.';
  }catch(e){} }
  setTimeout(function(){ try{ var w=document.getElementById('stSyncWrap');
    if(w){ w.style.cursor='pointer'; w.onclick=function(){ try{ STORE.flushNow(); toast('Sync forced','var(--gold)') }catch(e){} } } }catch(e){} },1300);

  /* these three are the only jobs allowed to be pure paint */
  Clock.add('paintFresh', 1000, paintFresh, {render:true});
  Clock.add('paintClock', 3000, paintClock, {render:true});
  Clock.add('paintSync', 2000, paintSync, {render:true});
})();

/* ==================================================================
   v36.0 — EXECUTION RECONCILIATION
   ------------------------------------------------------------------
   Until now "your edge" was measured on PAPER.hist — the DEMO account.
   The decision journal logged what the SYSTEM would have done. Nothing in
   this terminal knew what actually filled, at what price, with what
   slippage, what spread you paid, or whether you moved the stop.

   A discretionary trader's entire edge lives in that gap.

   This panel closes it. Drop in an MT5 history report (or run the bridge)
   and every trade is graded against the plan you actually wrote down.
   ================================================================== */
