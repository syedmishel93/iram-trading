(function(){try{
  window.SCALE_MODE=localStorage.getItem('mishel_scale')||'lin';
  var host=document.getElementById('paneCtl')||document.getElementById('toolbar');if(!host)return;
  var b=document.createElement('button');b.className='tbtn';b.id='scaleBtn';b.title='Toggle linear / logarithmic price scale';
  function lab(){b.textContent=window.SCALE_MODE==='log'?'LOG':'LIN';b.classList.toggle('on',window.SCALE_MODE==='log')}
  b.onclick=function(){window.SCALE_MODE=window.SCALE_MODE==='log'?'lin':'log';try{localStorage.setItem('mishel_scale',window.SCALE_MODE)}catch(e){}lab();try{draw()}catch(e){}};
  lab();host.appendChild(b);
}catch(e){}})();

/* ---- v6.0b: alerts inbox dropdown on the bell ---- */
(function(){try{
  var bell=document.getElementById('bellBtn');if(!bell)return;
  var box=document.createElement('div');box.id='alertInbox';
  box.innerHTML='<div class="ai-head"><span>Alerts</span><button class="tbtn" id="aiInboxClear">Clear</button></div><div id="alertInboxList"></div>';
  document.body.appendChild(box);
  var seen=0;
  window.updateBell=function(){try{var n=(typeof ALERT_LOG!=='undefined'?ALERT_LOG.length:0)-seen;var bd=document.getElementById('bellBadge');
    if(bd){bd.style.display=n>0?'block':'none';bd.textContent=n>9?'9+':String(Math.max(n,0));}}catch(e){}};
  function render(){var list=document.getElementById('alertInboxList');var L=(typeof ALERT_LOG!=='undefined')?ALERT_LOG:[];
    list.innerHTML=L.length?L.slice(0,40).map(function(a){var d=new Date(a.t);var ts=('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);
      return '<div class="ai-row"><span class="t">'+ts+'</span><span><b>'+a.sym+'</b> '+a.desc+(a.val||'')+'</span></div>';}).join('')
      :'<div class="ai-empty">No alerts fired yet.<br>Create alerts in the Alerts & Webhooks view.</div>';}
  bell.addEventListener('click',function(e){e.stopPropagation();
    if(box.style.display==='flex'){box.style.display='none';return;}
    render();var r=bell.getBoundingClientRect();box.style.left=Math.max(8,Math.min(r.right-330,innerWidth-338))+'px';box.style.top=(r.bottom+8)+'px';box.style.display='flex';
    seen=(typeof ALERT_LOG!=='undefined')?ALERT_LOG.length:0;window.updateBell();});
  box.addEventListener('click',function(e){e.stopPropagation();});
  var cl=box.querySelector('#aiInboxClear');if(cl)cl.onclick=function(){try{ALERT_LOG.length=0}catch(e){}seen=0;render();window.updateBell();};
  document.addEventListener('click',function(e){if(box.style.display==='flex'&&!(e.target.closest&&(e.target.closest('#alertInbox')||e.target.closest('#bellBtn'))))box.style.display='none';});
  window.updateBell();
}catch(e){}})();

/* ---- v6.0c: live-feed health watchdog (stale badge + auto-heal) ---- */
(function(){try{
  if(typeof applyKline==='function'){var _ak=applyKline;applyKline=function(k){window._lastTick=Date.now();return _ak(k)};}
  var lastHeal=0;
  setInterval(function(){try{
    if(typeof MODE==='undefined'||MODE!=='online')return;
    var dot=document.getElementById('feedDot');if(!dot)return;
    var stale=window._lastTick&&(Date.now()-window._lastTick>15000);
    dot.classList.toggle('stale',!!stale);
    dot.title=stale?'No live ticks for 15s+':'';
    if(stale&&Date.now()-window._lastTick>45000&&Date.now()-lastHeal>30000){lastHeal=Date.now();try{setMode('online')}catch(e){}}
  }catch(e){}},5000);
}catch(e){}})();


/* ================= v7.0a: BRAND-NEW SYMBOL PICKER =================
   Fresh component, own namespace, opened via a CAPTURE-phase listener
   so no legacy handler can race or cancel it. Renders instantly from
   SPECS (the old picker ran genData+consensus for 60 symbols per open). */
(function(){try{
  var ov=document.createElement('div');ov.id='mspOverlay';
  ov.innerHTML='<div id="mspBox"><input id="mspInput" placeholder="Search symbols\u2026  (BTC, EUR/USD, gold\u2026)" autocomplete="off" spellcheck="false"><div id="mspCls"></div><div id="mspList"></div><div id="mspFoot">\u2191\u2193 navigate \u00b7 \u21b5 open \u00b7 esc close</div></div>';
  document.body.appendChild(ov);
  var box=ov.querySelector('#mspBox'),inp=ov.querySelector('#mspInput'),clsBar=ov.querySelector('#mspCls'),list=ov.querySelector('#mspList');
  var FILT='all',ACT=0,ROWS=[];
  var CATS=[['all','All'],['forex','FX'],['crypto','Crypto'],['cryptofut','Futures'],['metal','Metals'],['index','Indices'],['stock','Stocks']];
  function clsChips(){clsBar.innerHTML=CATS.map(function(c){return '<button class="msp-cls'+(FILT===c[0]?' on':'')+'" data-f="'+c[0]+'">'+c[1]+'</button>'}).join('');
    clsBar.querySelectorAll('.msp-cls').forEach(function(b){b.onclick=function(e){e.stopPropagation();FILT=b.dataset.f;clsChips();render(inp.value)}})}
  function rows(q){q=(q||'').toLowerCase().trim();
    var keys=Object.keys(SPECS).filter(function(k){var sp=SPECS[k];
      return (FILT==='all'||sp.cls===FILT)&&(!q||k.toLowerCase().indexOf(q)>=0||(sp.name||'').toLowerCase().indexOf(q)>=0)});
    return keys.slice(0,80)}
  function fmtPx(v){return v>=1000?v.toLocaleString(undefined,{maximumFractionDigits:1}):v>=1?v.toFixed(v<10?4:2):v.toFixed(5)}
  function render(q){ROWS=rows(q);ACT=Math.min(ACT,Math.max(0,ROWS.length-1));
    var rec=(!q&&window.SESSION_MEM&&SESSION_MEM.symbols)?SESSION_MEM.symbols.slice(-4).reverse().filter(function(k){return SPECS[k]}):[];
    var html='';
    if(rec.length){html+='<div class="msp-h">Recent</div>'+rec.map(function(k){return row(k,-1)}).join('');}
    html+= (rec.length?'<div class="msp-h">Symbols</div>':'') + (ROWS.length?ROWS.map(function(k,i){return row(k,i)}).join(''):'<div class="msp-empty">No symbols match \u201c'+String(q||'').replace(/</g,'&lt;')+'\u201d</div>');
    list.innerHTML=html;
    list.querySelectorAll('.msp-row').forEach(function(r){
      r.onclick=function(e){e.stopPropagation();pick(r.dataset.s)};
      r.onmouseenter=function(){var i=+r.dataset.i;if(i>=0){ACT=i;mark()}};});
    mark()}
  function row(k,i){var sp=SPECS[k];return '<div class="msp-row'+(i===ACT?' act':'')+'" data-s="'+k+'" data-i="'+i+'"><span class="tk">'+k+'</span><span class="nm">'+(sp.name||'')+'</span><span class="px">'+fmtPx(sp.px)+'</span><span class="cl">'+sp.cls+'</span></div>'}
  function mark(){list.querySelectorAll('.msp-row').forEach(function(r){r.classList.toggle('act',+r.dataset.i===ACT)})}
  function pick(sym){closeMsp();try{loadSymbolName(sym)}catch(e){try{document.getElementById('symSel').value=sym;loadSymbol()}catch(_){}}}
  function openMsp(prefill){ov.style.display='block';FILT='all';ACT=0;clsChips();inp.value=prefill||'';render(inp.value);setTimeout(function(){inp.focus();try{inp.setSelectionRange(inp.value.length,inp.value.length)}catch(e){}},0)}
  window.openMsp=openMsp;
  function closeMsp(){ov.style.display='none'}
  window.openSymbolPicker=openMsp;
  inp.addEventListener('input',function(){ACT=0;render(inp.value)});
  inp.addEventListener('keydown',function(e){
    if(e.key==='ArrowDown'){e.preventDefault();ACT=Math.min(ACT+1,ROWS.length-1);mark();var a=list.querySelector('.msp-row.act');if(a)a.scrollIntoView({block:'nearest'})}
    else if(e.key==='ArrowUp'){e.preventDefault();ACT=Math.max(ACT-1,0);mark();var a2=list.querySelector('.msp-row.act');if(a2)a2.scrollIntoView({block:'nearest'})}
    else if(e.key==='Enter'){if(ROWS[ACT])pick(ROWS[ACT])}
    else if(e.key==='Escape')closeMsp()});
  ov.addEventListener('mousedown',function(e){if(e.target===ov)closeMsp()});
  /* CAPTURE-phase open: fires before every legacy handler, then stops them dead */
  document.addEventListener('click',function(e){
    var t=e.target&&e.target.closest&&e.target.closest('.sym-pill,#symBtn');
    if(!t)return;
    e.preventDefault();e.stopImmediatePropagation();
    var d=document.getElementById('symDrop');if(d)d.style.display='none';
    if(ov.style.display==='block')closeMsp();else openMsp();
  },true);
}catch(e){}})();

/* ================= v7.0b: OHLC info bar + bar-close countdown ================= */
(function(){try{
  if(typeof cv==='undefined'||!cv||!cv.parentElement)return;
  var bar=document.createElement('div');bar.id='ohlcBar';cv.parentElement.appendChild(bar);
  var TFMS={'1m':6e4,'5m':3e5,'15m':9e5,'30m':18e5,'1h':36e5,'4h':144e5,'1d':864e5,'1w':6048e5,'1M':26298e5};
  var hoverBar=null;
  function pct(c){var p=(c.c-c.o)/c.o*100;return (p>=0?'+':'')+p.toFixed(2)+'%'}
  function paint(){try{
    if(!DATA||!DATA.length){bar.style.display='none';return}
    var c=hoverBar||DATA[DATA.length-1];if(!c){bar.style.display='none';return}
    var up=c.c>=c.o,cls=up?'u':'d';
    var cd='';
    if(!hoverBar){var ms=TFMS[TF]||36e5;var last=DATA[DATA.length-1];var rem=Math.max(0,last.t+ms-Date.now());
      if(rem>0&&rem<ms*1.5){var s2=Math.floor(rem/1000),h=Math.floor(s2/3600),m=Math.floor(s2%3600/60),sec=s2%60;
        cd='<span class="k">CLOSE</span><span class="cd">'+(h?h+':':'')+('0'+m).slice(-2)+':'+('0'+sec).slice(-2)+'</span>'}}
    bar.style.display='flex';
    bar.innerHTML='<b>'+((CURSYM&&(CURSYM.name||CURSYM.sym))||'')+'</b>'
      +'<span><span class="k">O</span><span class="'+cls+'">'+fmt(c.o)+'</span></span>'
      +'<span><span class="k">H</span><span class="'+cls+'">'+fmt(c.h)+'</span></span>'
      +'<span><span class="k">L</span><span class="'+cls+'">'+fmt(c.l)+'</span></span>'
      +'<span><span class="k">C</span><span class="'+cls+'">'+fmt(c.c)+'</span></span>'
      +'<span class="'+cls+'">'+pct(c)+'</span>'
      +'<span><span class="k">VOL</span>'+((c.v||0)>=1e6?((c.v/1e6).toFixed(2)+'M'):((c.v||0)/1e3).toFixed(1)+'K')+'</span>'
      +cd;
  }catch(e){}}
  cv.addEventListener('mousemove',function(e){try{
    if(!window.RENDER||!DATA.length){return}
    var r=cv.getBoundingClientRect();var mx=e.clientX-r.left;
    if(mx>RENDER.W-RENDER.padR){hoverBar=null;paint();return}
    var i=RENDER.start+Math.floor(mx/RENDER.cw);
    hoverBar=(i>=0&&i<DATA.length)?DATA[i]:null;paint();
  }catch(e){}});
  cv.addEventListener('mouseleave',function(){hoverBar=null;paint()});
  setInterval(paint,1000);paint();
}catch(e){}})();

