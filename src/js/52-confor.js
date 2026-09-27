(function(){try{
  var el=document.getElementById('ihPx');if(!el)return;var last=null;
  new MutationObserver(function(){var v=parseFloat((el.textContent||'').replace(/[^0-9.\-]/g,''));
    if(last!=null&&isFinite(v)&&v!==last){el.classList.remove('flash-u','flash-d');void el.offsetWidth;el.classList.add(v>last?'flash-u':'flash-d')}
    if(isFinite(v))last=v;}).observe(el,{childList:true,characterData:true,subtree:true});
}catch(e){}})();

/* ---- v7.5: next-session countdown + data-quality monitor ---- */
(function(){try{
  var st=document.querySelector('.status');if(!st)return;
  var tail=st.querySelector('.s[style*="margin-left"]');
  var e1=document.createElement('div');e1.className='s';e1.id='stNext';
  var e2=document.createElement('div');e2.className='s';e2.id='stQual';
  st.insertBefore(e1,tail);st.insertBefore(e2,tail);
  var OPENS=[['Sydney',22],['Tokyo',0],['London',8],['New York',13]];
  setInterval(function(){try{
    var now=new Date(),h=now.getUTCHours(),mm=now.getUTCMinutes();
    var best=null;OPENS.forEach(function(o){var dh=(o[1]-h-1+24)%24,dm=60-mm;var mins=dh*60+dm;if(mins<=0)mins+=1440;if(!best||mins<best.m)best={n:o[0],m:mins}});
    if(best)e1.innerHTML=best.n+' opens in <b>'+Math.floor(best.m/60)+'h '+('0'+best.m%60).slice(-2)+'m</b>';
    if(DATA&&DATA.length>30){var ms=(typeof barSpacingMs==='function'?barSpacingMs():36e5);
      var miss=0,closures=0,n=Math.min(200,DATA.length);
      for(var i=DATA.length-n+1;i<DATA.length;i++){var dt=DATA[i].t-DATA[i-1].t;
        if(dt>ms*6)closures++;else if(dt>ms*1.5)miss++}
      var q=Math.max(0,100-miss*2);
      e2.innerHTML='Integrity <b class="'+(q>=95?'ok':'bad')+'" title="'+miss+' missing bars \u00b7 '+closures+' session breaks (breaks are normal, not counted) \u00b7 last '+n+' bars">'+q+'%'+(closures?' \u00b7 '+closures+' brk':'')+'</b>';}
  }catch(e){}},5000);
}catch(e){}})();


/* ---- v7.6a: Setup Scout + cross-pair validation (side cards) ---- */
(function(){try{
  var PEERS={crypto:['BTCUSD','ETHUSD','SOLUSD'],cryptofut:['BTCUSD','ETHUSD','SOLUSD'],forex:['EURUSD','GBPUSD','USDCHF'],metal:['XAUUSD','XAGUSD'],index:['SPX500','NAS100','US30'],stock:['SPX500','NAS100']};
  function conFor(sym){try{var key=null;for(var k in BAR_CACHE){if(k.indexOf(sym+'|')===0&&BAR_CACHE[k].length>60){key=k;break}}
    var d=key?BAR_CACHE[key].slice(-300):genData(300,(SPECS[sym]||{px:100}).px,(sym.charCodeAt(0)+sym.length)*13+7);
    return consensusSignal(d);}catch(e){return null}}
  function mount(){
    var anchor=document.getElementById('mtfSideCard')||document.querySelector('.side .card');if(!anchor)return false;
    if(!document.getElementById('scoutCard')){
      var c=document.createElement('div');c.className='card';c.id='scoutCard';
      c.innerHTML='<h3>Setup Scout <span class="tag" title="Watchlist ranked by |consensus| \u00d7 confidence. Click a row to load it.">AI</span></h3><div id="xpairLine" style="margin-bottom:8px"></div><div id="scoutBody"><div style="color:var(--muted);font-size:11.5px">Scanning\u2026</div></div>';
      anchor.parentElement.insertBefore(c,anchor.nextSibling);}
    return true;}
  window.renderScout=function(){try{
    if(!mount())return;
    /* cross-pair validation of the CURRENT read */
    var xp=document.getElementById('xpairLine');
    var mycon=IND._consensus||consensusSignal(DATA);var mySign=Math.sign(mycon.score);
    var peers=(PEERS[CURSYM.cls]||[]).filter(function(p){return p!==CURSYM.sym}).slice(0,3);
    var agree=0,chips='';
    peers.forEach(function(p){var c2=conFor(p);if(!c2)return;var ok=mySign!==0&&Math.sign(c2.score)===mySign;if(ok)agree++;
      chips+='<span class="xp-chip '+(ok?'ok':'no')+'" title="'+p+' consensus: '+c2.label+'">'+p.replace('USD','')+' '+(c2.score>=0?'\u25b2':'\u25bc')+'</span>';});
    if(xp)xp.innerHTML=peers.length?('<span style="font-size:10px;color:var(--muted2);letter-spacing:.08em">CROSS-MARKET</span><br>'+chips+'<span style="font-size:11px;color:var(--muted)"> '+agree+'/'+peers.length+' peers confirm'+(mySign!==0&&agree===0?' \u2014 this read is isolated; caution.':'')+'</span>'):'';
    /* ranked setups */
    var rows=[];(typeof WATCH!=='undefined'?WATCH:[]).slice(0,10).forEach(function(sym){
      var c2=conFor(sym);if(!c2)return;var q=Math.abs(c2.score)*(c2.confidence||0)/100;
      rows.push({sym:sym,con:c2,q:q});});
    rows.sort(function(a,b){return b.q-a.q});
    var body=document.getElementById('scoutBody');
    body.innerHTML=rows.slice(0,4).map(function(r){var u=r.con.score>=0;
      return '<div class="sc-row" data-s="'+r.sym+'"><span class="sc-sym">'+r.sym+'</span><span class="sc-lab '+(u?'u':'d')+'">'+r.con.label+'</span><span class="sc-sc">'+(r.con.score>=0?'+':'')+r.con.score+' \u00b7 '+r.con.confidence+'%</span></div>';}).join('')||'<div style="color:var(--muted);font-size:11.5px">No standout setups right now.</div>';
    body.querySelectorAll('.sc-row').forEach(function(el){el.onclick=function(){try{loadSymbolName(el.dataset.s)}catch(e){}};});
  }catch(e){}};
  setTimeout(renderScout,1500);setInterval(renderScout,120000);
}catch(e){}})();

/* ---- v7.6b: tilt detector + mistake ledger + pre-trade MC + auto-plan ---- */
(function(){try{
  window.MISTAKES=[];window._tilt={lastLossAt:0,overrides:0,strikes:0};
  var banner=document.createElement('div');banner.id='tiltBanner';document.body.appendChild(banner);
  function showTilt(msg){banner.innerHTML='<b>\u26a0 Discipline check.</b> '+msg+' <span style="color:#f9b">Consider a 15-minute pause \u2014 the market will still be here.</span>';banner.style.display='block';clearTimeout(banner._t);banner._t=setTimeout(function(){banner.style.display='none'},18000);banner.onclick=function(){banner.style.display='none'};}
  function medianQty(){var q=PAPER.hist.slice(-6).map(function(t){return t.qty||0}).filter(Boolean).sort(function(a,b){return a-b});return q.length?q[q.length>>1]:0;}
  function preTradeMC(entry,sl,tp,side){try{
    if(!sl||!tp)return null;var atr=(IND.atr(DATA).slice(-1)[0])||entry*0.008;var vol=atr/Math.sqrt(1);
    var hitT=0,hitS=0;for(var p=0;p<600;p++){var px=entry;for(var st2=0;st2<400;st2++){px+=(Math.random()-0.5)*2*vol;
      if(side>0){if(px>=tp){hitT++;break}if(px<=sl){hitS++;break}}else{if(px<=tp){hitT++;break}if(px>=sl){hitS++;break}}}}
    var tot=hitT+hitS||1;var R=Math.abs(tp-entry)/Math.abs(entry-sl||1e-9);var ev=(hitT/tot)*R-(hitS/tot);
    return {pT:Math.round(hitT/tot*100),pS:Math.round(hitS/tot*100),R:R,ev:ev};}catch(e){return null}}
  if(typeof paperOpen==='function'){var _po2=paperOpen;paperOpen=function(side){
    var now=Date.now();
    /* tilt: fast re-entry after a loss / oversizing */
    try{var q=+document.getElementById('pQty').value||0,mq=medianQty();
      if(window._tilt.lastLossAt&&now-window._tilt.lastLossAt<120000){window._tilt.strikes++;showTilt('You are re-entering <b>'+Math.round((now-window._tilt.lastLossAt)/1000)+'s after a losing trade</b> \u2014 the classic revenge pattern.');}
      else if(mq&&q>mq*2.5){showTilt('Position size is <b>'+(q/mq).toFixed(1)+'\u00d7 your recent median</b> \u2014 size escalation often follows frustration.');}
    }catch(e){}
    var before=PAPER.pos.length;
    _po2(side);
    try{if(PAPER.pos.length>before){var p=PAPER.pos[PAPER.pos.length-1];
      var con=IND._consensus||consensusSignal(DATA);p._ctx={score:con.score,label:con.label,t:now,gateOv:!!window._gateAt===false&&false};
      if(window._lastGateOverride&&now-window._lastGateOverride<8000)p._ctx.override=true;
      /* pre-trade Monte Carlo + auto-plan drawing */
      if(p.sl&&p.tp){var mc=preTradeMC(p.entry,p.sl,p.tp,side);
        if(mc)toast('MC \u00d7600: TP '+mc.pT+'% \u00b7 SL '+mc.pS+'% \u00b7 '+mc.R.toFixed(1)+'R \u2192 EV '+(mc.ev>=0?'+':'')+mc.ev.toFixed(2)+'R',mc.ev>=0?'var(--bull)':'var(--bear)');
        try{snapDrawings();DRAWINGS.push({type:side>0?'long':'short',a:{bar:DATA.length-1,price:p.entry},b:{bar:DATA.length+10,price:p.tp}});draw()}catch(e){}}
    }}catch(e){}
  };}
  /* record overrides from the gate */
  (function(){var od=Object.getOwnPropertyDescriptor(window,'_gateAt');})();
  if(typeof paperClose==='function'){var _pc=paperClose;paperClose=function(id,why){
    var p=PAPER.pos.find(function(x){return x.id===id});var px=curPrice();
    _pc(id,why);
    try{if(!p)return;var pl=(px-p.entry)*p.side*p.qty;
      if(pl<0)window._tilt.lastLossAt=Date.now();
      var tags=[];
      if(p._ctx){if(p.side>0&&p._ctx.score<-10)tags.push('fought the read');if(p.side<0&&p._ctx.score>10)tags.push('fought the read');
        if(p._ctx.override)tags.push('gate overridden');}
      if(window._tilt.lastLossAt&&p.opened&&p.opened-0>0&&(p.opened-(window._tilt._prevLossAt||0))<120000)tags.push('revenge entry');
      window._tilt._prevLossAt=window._tilt.lastLossAt;
      if(tags.length){MISTAKES.push({t:Date.now(),sym:p.sym,pl:pl,tags:tags});if(MISTAKES.length>80)MISTAKES.shift();
        if(pl<0)toast('Logged: '+tags.join(', '),'var(--gold)');}
      renderMistakes();
    }catch(e){}
  };}
  window.renderMistakes=function(){try{
    var host=document.getElementById('journalStats');if(!host)return;
    var box=document.getElementById('mistakeBox');
    if(!box){box=document.createElement('div');box.id='mistakeBox';box.style.cssText='margin-top:10px;border-top:1px solid var(--edge);padding-top:8px;font-size:11.5px;color:var(--muted)';host.parentElement.appendChild(box);}
    if(!MISTAKES.length){box.innerHTML='<span style="font-size:10px;letter-spacing:.08em;color:var(--muted2)">MISTAKE LEDGER</span><br>No tagged mistakes yet \u2014 keep it that way.';return}
    var cnt={};MISTAKES.forEach(function(m){m.tags.forEach(function(t){cnt[t]=(cnt[t]||0)+1})});
    var top=Object.entries(cnt).sort(function(a,b){return b[1]-a[1]}).slice(0,3);
    var cost=MISTAKES.filter(function(m){return m.pl<0}).reduce(function(a,m){return a+m.pl},0);
    box.innerHTML='<span style="font-size:10px;letter-spacing:.08em;color:var(--muted2)">MISTAKE LEDGER ('+MISTAKES.length+')</span><br>'+top.map(function(t){return '<b style="color:var(--txt)">'+t[1]+'\u00d7</b> '+t[0]}).join(' \u00b7 ')+(cost<0?'<br>cost of tagged mistakes: <b style="color:var(--bear)">$'+Math.abs(cost).toFixed(0)+'</b>':'');
  }catch(e){}};
}catch(e){}})();

/* ---- v7.6c: Kelly-aware sizing hint ---- */
