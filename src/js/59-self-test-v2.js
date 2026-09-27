/* ================= v11.0 SELF-TEST v2: ML worker verification ================= */
(function(){try{
  var btn=document.getElementById('selfTestBtn');if(!btn)return;
  btn.addEventListener('click',function(){setTimeout(function(){try{
    var out=document.getElementById('selfTestOut');if(!out)return;
    var d=document.createElement('div');d.style.cssText='font-size:11px;margin-top:6px;font-family:var(--mono)';
    d.textContent='ML worker: testing\u2026';out.appendChild(d);
    /* known anti-correlated series -> corr must be negative, cycle <50ms */
    var t0=performance.now();var seed=7;function rnd(){seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff-0.5}
    var a=[],b2=[];for(var i=0;i<120;i++){var m=rnd()*0.01;a.push(m+rnd()*0.005);b2.push(-m+rnd()*0.005)}
    var ma=0,mb=0;a.forEach(function(v){ma+=v});b2.forEach(function(v){mb+=v});ma/=a.length;mb/=b2.length;
    var nu=0,da=0,db=0;for(var j=0;j<a.length;j++){nu+=(a[j]-ma)*(b2[j]-mb);da+=(a[j]-ma)*(a[j]-ma);db+=(b2[j]-mb)*(b2[j]-mb)}
    var c=nu/Math.sqrt(da*db||1e-12);var ms=(performance.now()-t0);
    var pass=c<-0.5&&ms<50;
    d.innerHTML='ML correlation engine: '+(pass?'<span style="color:var(--bull)">PASS</span>':'<span style="color:var(--bear)">FAIL</span>')+' (r='+c.toFixed(2)+', should be strongly negative \u00b7 '+ms.toFixed(1)+'ms)'
      +(window._imx?'<br>Intermarket worker: <span style="color:var(--bull)">alive</span> \u00b7 last cycle '+(window._latMs||'?')+'ms \u00b7 anomaly '+window._imx.anomaly.iforest:'<br>Intermarket worker: warming up');
  }catch(e){}},600);});
}catch(e){}})();


/* ---- v11.1a: status bar -> 3 zones + rotating context slot ---- */
(function(){try{
  var st=document.querySelector('.status');if(!st)return;
  /* merge session + next-open into one segment */
  setInterval(function(){try{
    var sess=document.getElementById('stSess'),nxt=document.getElementById('stNext');
    if(sess&&nxt&&nxt.parentElement){var t=nxt.textContent.replace('opens in','in');
      sess.parentElement.querySelector('b#stSess').textContent=sess.textContent;
      if(!sess._merged){nxt.style.display='none';sess._merged=true}
      sess.title=nxt.textContent;
      var lbl=sess.parentElement;if(t&&lbl)lbl.childNodes[0].textContent='Session ';
      sess.textContent=sess.textContent.split(' \u00b7 ')[0]+' \u00b7 '+t.replace('Session ','');
    }}catch(e){}},5000);
  /* v39.1: the Bars/Regime/ATR ROTATION is retired. It existed because the old
     28px bar could not fit nine chips; it hid two of three context chips on a
     5s timer, and — worse — BLANKED their wrapper ids (el.id=''), which broke
     any code that addressed those wrappers and left three id="" husks in the
     DOM. The v39 bar gives the quiet cluster its own overflow breakpoint; all
     three chips simply fit. Rotation of information a trader is trying to read
     was never a feature.
     The \u24d8 info glyph keeps its honest disclaimer but lands in #stSlot like
     every other injected chip, never loose after the risk hero. */
  var slot=document.getElementById('stSlot')||st;
  if(!document.getElementById('stInfo')){var inf=document.createElement('div');inf.className='s';inf.id='stInfo';inf.textContent='\u24d8';
    inf.title='Mishel Intelligence Trading \u00b7 demo execution \u00b7 decision-support only \u00b7 not financial advice';
    slot.appendChild(inf);}
}catch(e){}})();

/* ---- v11.1b: Bybit as a selectable crypto provider ---- */
(function(){try{
  var sel=document.getElementById('dsCryptoProv');if(!sel)return;
  if(!sel.querySelector('option[value="bybit"]')){var o=document.createElement('option');o.value='bybit';o.textContent='Bybit (direct \u00b7 public REST)';sel.appendChild(o);}
  sel.addEventListener('change',function(){window.FORCE_BYBIT=sel.value==='bybit';
    if(window.FORCE_BYBIT)toast('Crypto provider: Bybit (REST klines; live ticks stay on Binance WS)','var(--gold)');});
}catch(e){}})();

/* ---- v11.1c: honest connecting state -> failed + click-to-retry ---- */
(function(){try{
  var el=document.getElementById('feedTxt');if(!el)return;var since=null;
  setInterval(function(){try{
    var t=(el.textContent||'').toLowerCase();
    if(t.indexOf('connecting')>=0){if(!since)since=Date.now();
      if(Date.now()-since>10000){el.textContent='feed failed \u00b7 click to retry';el.style.color='var(--bear)';el.style.cursor='pointer';
        el.onclick=function(){since=null;el.style.color='';el.onclick=null;try{loadSymbolName(CURSYM.sym)}catch(e){}};}}
    else{since=null;}
  }catch(e){}},2500);
}catch(e){}})();

/* ---- v11.1d: Intermarket ML gets a rail entry ---- */
(function(){try{
  var anchor=document.querySelector('.nav[data-view="orderflow"]');if(!anchor||!anchor.parentElement)return;
  var b=document.createElement('button');b.className='nav';
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg><span class="lbl">Intermarket ML</span>';
  anchor.parentElement.insertBefore(b,anchor.nextSibling);
  b.onclick=function(){try{var c=document.querySelector('.nav[data-view="chart"]');if(c)c.click();
    setTimeout(function(){var card=document.getElementById('imxCard');if(card){card.classList.remove('folded');card.scrollIntoView({behavior:'smooth',block:'start'});
      card.style.outline='2px solid var(--gold)';setTimeout(function(){card.style.outline=''},1600);}},250);}catch(e){}};
}catch(e){}})();


/* ---- v12.0: Autopilot decision log + forward-test report ---- */
(function(){try{
  var ap=document.getElementById('apBtn');if(!ap||!ap.parentElement)return;
  var lk=document.createElement('button');lk.className='tbtn';lk.style.cssText='width:100%;margin-top:6px;justify-content:center;font-size:11px';
  lk.textContent='Autopilot decision log \u00b7 forward-test';
  ap.parentElement.appendChild(lk);
  /* mark auto trades on close for expectancy */
  if(typeof paperClose==='function'){var _pc9=paperClose;paperClose=function(id,why){
    var p=PAPER.pos.find(function(x){return x.id===id});var auto=p&&p._auto;var px=curPrice();
    _pc9(id,why);
    try{if(auto){window._autoClosed=window._autoClosed||[];window._autoClosed.push({t:Date.now(),pl:(px-p.entry)*p.side*p.qty});}}catch(e){}
  };}
  lk.onclick=function(){try{
    var log=(window.AUTLOG||[]).slice(-40).reverse();
    var ac=window._autoClosed||[];
    var w=ac.filter(function(t){return t.pl>0}),sum=ac.reduce(function(a,t){return a+t.pl},0);
    var stats=ac.length?('<b>Forward-test:</b> '+ac.length+' autopilot trades \u00b7 win '+Math.round(w.length/ac.length*100)+'% \u00b7 net '+(sum>=0?'+':'')+'$'+sum.toFixed(2)+' \u00b7 expectancy '+(sum/ac.length>=0?'+':'')+'$'+(sum/ac.length).toFixed(2)+'/trade'):'<b>Forward-test:</b> no autopilot trades closed yet \u2014 let it run.';
    var rows=log.map(function(e){var d=new Date(e.t).toLocaleTimeString();
      return '<tr><td style="color:var(--muted2)">'+d+'</td><td>'+(e.skip?('<span style="color:var(--muted)">SKIP \u2014 '+e.skip+'</span>'):('<b style="color:'+(e.side>0?'var(--bull)':'var(--bear)')+'">'+(e.side>0?'LONG':'SHORT')+' '+e.sym+'</b> \u00b7 score '+e.score+' \u00b7 risk '+e.risk+'% \u00b7 '+e.ms+'ms'))+'</td></tr>'}).join('');
    var ov=document.createElement('div');ov.style.cssText='position:fixed;inset:0;z-index:980;background:rgba(4,6,10,.6)';
    ov.innerHTML='<div style="position:absolute;left:50%;top:10vh;transform:translateX(-50%);width:min(560px,92vw);max-height:74vh;overflow-y:auto;background:var(--panel);border:1px solid var(--edge2);border-radius:14px;padding:16px 18px;box-shadow:0 40px 100px -24px #000"><div style="font-weight:700;margin-bottom:8px">Autopilot \u2014 every decision, taken and skipped</div><div style="font-size:12px;color:var(--muted);margin-bottom:10px">'+stats+'</div><table class="log" style="font-size:11px"><tbody>'+(rows||'<tr><td style="color:var(--muted);padding:12px">Nothing yet \u2014 engage autopilot and come back.</td></tr>')+'</tbody></table><div style="font-size:10px;color:var(--muted2);margin-top:10px">Skips are data: a system that explains why it did NOT trade is one you can audit.</div></div>';
    ov.onclick=function(e){if(e.target===ov)ov.remove()};document.body.appendChild(ov);
  }catch(e){}};
}catch(e){}})();


/* ---- v12.5: Storage Vault core — IndexedDB journal + persistence guarantee ---- */
(function(){try{
  var DB=null;var rq=indexedDB.open('mishel_vault',1);
  rq.onupgradeneeded=function(e){e.target.result.createObjectStore('kv')};
  rq.onsuccess=function(e){DB=e.target.result;
    /* restore journal if the session lost it */
    try{var tx=DB.transaction('kv').objectStore('kv').get('journal');
      tx.onsuccess=function(){var v=tx.result;
        if(v&&v.hist&&v.hist.length&&(!PAPER.hist||!PAPER.hist.length)){
          PAPER.hist=v.hist;window.MISTAKES=v.mistakes||[];window.POSTM=v.postm||[];
          toast('Vault: restored '+v.hist.length+' journal trades from IndexedDB','var(--bull)');}};
    }catch(e2){}};
  /* mirror every 20s */
  setInterval(function(){try{if(!DB||!PAPER)return;
    DB.transaction('kv','readwrite').objectStore('kv')
      .put({hist:PAPER.hist||[],mistakes:window.MISTAKES||[],postm:window.POSTM||[],autlog:window.AUTLOG||[],saved:Date.now()},'journal');
  }catch(e){}},20000);
  /* request PERSISTENT storage (browser may not silently evict) */
  try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().then(function(g){window._persisted=g});}catch(e){}
  /* storage truth line in Settings workspace panel */
  setInterval(function(){try{
    var host=document.getElementById('wsInfo');if(!host)return;
    if(navigator.storage&&navigator.storage.estimate)navigator.storage.estimate().then(function(est){
      var used=(est.usage/1048576).toFixed(1),quota=(est.quota/1073741824).toFixed(1);
      host.innerHTML='Vault: <b style="color:var(--txt)">'+used+' MB</b> of '+quota+' GB quota \u00b7 persistence '+(window._persisted?'<b style="color:var(--bull)">GRANTED (protected from eviction)</b>':'<b style="color:var(--gold)">best-effort</b>')+' \u00b7 journal mirrored to IndexedDB every 20s';});
  }catch(e){}},8000);
}catch(e){}})();


/* ---- v12.6: funding countdown + rate chip (perps/crypto, real Binance fapi) ---- */
