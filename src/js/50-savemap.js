(function(){try{
  var bell=document.getElementById('bellBtn');if(!bell||document.getElementById('gearBtn'))return;
  var g=document.createElement('button');g.className='tbtn iconbtn';g.id='gearBtn';g.title='Settings';
  g.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z"/></svg>';
  g.onclick=function(){try{goView('settings')}catch(e){}};
  bell.parentElement.insertBefore(g,bell);
}catch(e){}})();


/* ---- v7.3a: objectivity-checklist gate on demo orders ---- */
(function(){try{
  if(typeof paperOpen!=='function')return;
  var _po=paperOpen;
  paperOpen=function(side){
    try{
      var con=(typeof consensusSignal==='function')?consensusSignal(DATA):confluence(buildSignals(DATA).S);var ck=tradeChecklist({con:con,tf:TF});
      var against=(side>0&&con.score<-0.15)||(side<0&&con.score>0.15);
      var weak=ck.passed<=Math.ceil(ck.total/2);
      if((weak||against)&&(!window._gateAt||Date.now()-window._gateAt>6000)){
        window._gateAt=Date.now();
        var why=[];if(weak)why.push('checklist '+ck.passed+'/'+ck.total);if(against)why.push('order fights the '+con.label+' read');
        toast('\u26d4 Discipline gate: '+why.join(' \u00b7 ')+' \u2014 click again within 6s to override','var(--bear)');
        try{ALERT_LOG.unshift({t:Date.now(),sym:CURSYM.sym,desc:'order blocked by gate ('+why.join(', ')+')',val:''});if(window.updateBell)updateBell()}catch(e){}
        return;
      }
      if(window._gateAt){try{memLog('event','gate overridden: '+CURSYM.sym)}catch(e){}}
      window._gateAt=0;
    }catch(e){}
    return _po(side);
  };
}catch(e){}})();

/* ---- v7.3b: per-symbol drawing persistence (always on, lightweight) ---- */
(function(){try{
  window.DRAWMAP={};
  try{var raw=localStorage.getItem('mishel_drawmap');if(raw)DRAWMAP=JSON.parse(raw)||{}}catch(e){}
  function saveMap(){try{if(CURSYM&&CURSYM.sym)DRAWMAP[CURSYM.sym]=DRAWINGS.slice(0,150);STORE.set('mishel_drawmap',JSON.stringify(DRAWMAP))}catch(e){}}
  if(typeof loadSymbol==='function'){
    var _ls=loadSymbol;
    loadSymbol=function(){
      var prev=(typeof CURSYM!=='undefined'&&CURSYM)?CURSYM.sym:null;
      try{if(prev)DRAWMAP[prev]=DRAWINGS.slice(0,150)}catch(e){}
      _ls();
      try{var cur=CURSYM.sym;if(DRAWMAP[cur])DRAWINGS=DRAWMAP[cur].slice();else if(prev&&prev!==cur)DRAWINGS=[];draw()}catch(e){}
      try{if(window.renderMTFSide)renderMTFSide()}catch(e){}
      try{if(window.renderIndActive)renderIndActive()}catch(e){}
    };
  }
  setInterval(saveMap,6000);
  window.addEventListener('beforeunload',saveMap);
  try{if(typeof CURSYM!=='undefined'&&CURSYM&&DRAWMAP[CURSYM.sym]&&!DRAWINGS.length){DRAWINGS=DRAWMAP[CURSYM.sym].slice();draw()}}catch(e){}
  try{if(window.renderMTFSide)setTimeout(renderMTFSide,800)}catch(e){}
}catch(e){}})();

/* ---- v7.3c: drawing-break alerts (trendline / ray / hline crosses fire the bell) ---- */
(function(){try{
  function levelOf(d,i){
    if(d.type==='hline')return d.price;
    if((d.type==='trend'||d.type==='ray')&&d.a&&d.b){const den=(d.b.bar-d.a.bar)||1;const t=(i-d.a.bar)/den;
      if(d.type==='trend'&&(t<0||t>1.6))return null;
      return d.a.price+(d.b.price-d.a.price)*t;}
    return null;
  }
  window.checkDrawAlerts=function(){
    try{
      if(!DRAWINGS.length||DATA.length<2)return;
      const i=DATA.length-1,c=DATA[i].c,p=DATA[i-1].c;
      DRAWINGS.forEach(function(d){
        const lv=levelOf(d,i);if(lv==null||!isFinite(lv))return;
        const now=c>=lv?1:-1,was=d._aw==null?(p>=lv?1:-1):d._aw;
        if(now!==was){
          const dir=now>0?'\u25b2 broke above':'\u25bc broke below';
          const nm=d.type==='hline'?'H-line':d.type==='ray'?'Ray':'Trendline';
          try{ALERT_LOG.unshift({t:Date.now(),sym:CURSYM.sym,desc:nm+' '+dir+' ',val:fmt(lv)});if(ALERT_LOG.length>60)ALERT_LOG.pop();if(window.updateBell)updateBell()}catch(e){}
          try{toast(nm+' '+dir+' '+fmt(lv),now>0?'var(--bull)':'var(--bear)')}catch(e){}
        }
        d._aw=now;
      });
    }catch(e){}
  };
  if(typeof evalAlerts==='function'){var _ev=evalAlerts;evalAlerts=function(){_ev();window.checkDrawAlerts()};}
  else setInterval(window.checkDrawAlerts,5000);
}catch(e){}})();

/* ---- v7.3d: interactive status bar ---- */
(function(){try{
  var f=document.getElementById('stFeed');if(f){f.style.cursor='pointer';f.title='Open data-source settings';f.onclick=function(){try{goView('settings')}catch(e){}};}
  var r=document.getElementById('stRegime');if(r){r.style.cursor='help';r.title='Regime detection: ADX + EMA slope classify the tape as Trending / Mean-reverting / Choppy. Strategies and the confluence weights adapt to it.';}
  var a=document.getElementById('stAtr');if(a){a.style.cursor='help';a.title='Average True Range of the loaded series \u2014 the volatility unit used for stops and position sizing.';}
}catch(e){}})();


/* ---- v7.4a: card folding fixed for ALL cards, present and future (delegated) ---- */
(function(){try{
  /* strip the old per-card listeners (they double-fired with any new handler) */
  document.querySelectorAll('.side .card h3').forEach(function(h){var c=h.cloneNode(true);h.parentNode.replaceChild(c,h);});
  var saved={};try{saved=JSON.parse(localStorage.getItem('mishel_cards2')||'{}')}catch(e){}
  function keyOf(card){var h=card.querySelector('h3');return (card.id||(h?h.textContent.trim().slice(0,24):'card'))}
  document.addEventListener('click',function(e){
    var h=e.target.closest('.side .card>h3');if(!h)return;
    if(e.target.closest('.tag')||e.target.closest('.tag2'))return; /* badges keep their tooltips clickable */
    var card=h.parentElement;card.classList.toggle('folded');
    saved[keyOf(card)]=card.classList.contains('folded')?1:0;
    try{localStorage.setItem('mishel_cards2',JSON.stringify(saved))}catch(e2){}
  });
  function applySaved(){document.querySelectorAll('.side .card').forEach(function(card){if(saved[keyOf(card)])card.classList.add('folded')})}
  applySaved();setTimeout(applySaved,1200);
  var sideEl=document.getElementById('side');if(sideEl)sideEl.scrollTop=0;
}catch(e){}})();

/* ---- v7.4b: XAI extras in the Confluence card — counterfactual + robustness ---- */
(function(){try{
  if(typeof renderConfluence!=='function')return;
  window.renderXaiExtras=function(rep){
    var host=document.getElementById('agreeLine');if(!host)return;
    var box=document.getElementById('xaiExtras');
    if(!box){box=document.createElement('div');box.id='xaiExtras';host.parentElement.appendChild(box);}
    /* counterfactual: what would flip the read */
    var sign=rep.score>0?1:rep.score<0?-1:0;var cf='';
    if(sign!==0){
      var opp=[...rep.S].filter(function(x){return Math.sign(x.dv)===-sign}).sort(function(a,b){return Math.abs(b._c)-Math.abs(a._c)}).slice(0,2);
      if(opp.length){cf=opp.map(function(x){
        if(x.source==='RSI(14)'&&x.value!=null)return 'RSI '+(sign>0?'holding above 55':'dropping below 45')+' (now '+x.value.toFixed(0)+')';
        if(x.source==='Price vs EMA200')return 'a close '+(sign>0?'above':'below')+' the 200 EMA';
        if(x.source==='MACD hist')return 'MACD histogram flipping '+(sign>0?'positive':'negative');
        return x.source+' flipping '+(sign>0?'bullish':'bearish');
      }).join(' \u00b7 ');}
    }
    /* robustness: MC signal-dropout — recompute score 60x dropping ~30% of signals */
    var scores=[];try{for(var k2=0;k2<60;k2++){var sub=rep.S.filter(function(){return Math.random()>0.3});if(sub.length>3){var r2=confluence(sub);scores.push(r2.score)}}}catch(e){}
    var rob='';
    if(scores.length>10&&Number.isFinite(rep.score)){scores.sort(function(a,b){return a-b});var lo2=scores[Math.floor(scores.length*0.1)],hi2=scores[Math.floor(scores.length*0.9)];var spread=(hi2-lo2)/2;if(!Number.isFinite(spread))spread=0;
      var robust=spread<0.14;
      rob='<div class="xh">Robustness (signal-dropout)</div>score '+rep.score.toFixed(2)+' \u00b1 '+spread.toFixed(2)+' \u2014 <b class="'+(robust?'rb':'rf')+'">'+(robust?'ROBUST':'FRAGILE')+'</b>'+(robust?' \u00b7 the read barely moves when signals are removed.':' \u00b7 the read depends heavily on a few signals \u2014 treat with caution.');}
    else if(!Number.isFinite(rep.score)){rob='<div class="xh">Robustness (signal-dropout)</div><span style="color:var(--muted2)">not enough clean signal data on this feed to test robustness \u2014 honest blank, not a fake number.</span>';}
    box.innerHTML=(cf?'<div class="xh">What would flip this</div>'+cf:'')+rob;
  };
  var _rc=renderConfluence;renderConfluence=function(rep){_rc(rep);try{renderXaiExtras(rep)}catch(e){}};
}catch(e){}})();

/* ---- v7.4c: new indicators — Ichimoku · Keltner · Donchian · PSAR · Pivots · ZigZag · S/R Zones ---- */
