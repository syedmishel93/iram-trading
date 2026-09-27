/* ================= v11.0 EXTRA TIMEFRAMES ================= */
(function(){try{
  var menu=document.getElementById('tfMenu');if(!menu)return;
  ['3m','2h','6h','12h'].forEach(function(tf){
    var b=document.createElement('button');b.className='tfm-item';b.textContent=tf.toUpperCase();b.dataset.tf=tf;
    b.onclick=function(){try{TF=tf;var c=document.getElementById('tfMoreCur');if(c)c.textContent=tf.toUpperCase();
      document.querySelectorAll('#tfBar button').forEach(function(x){x.classList.remove('on')});
      menu.style.display='none';loadSymbolName(CURSYM.sym);}catch(e){}};
    menu.appendChild(b);});
}catch(e){}})();

/* ================= v11.0 REAL US10Y / DXY + computed-DXY fallback ================= */
(function(){try{
  window._imxSrc={BTCUSD:'synthetic',XAUUSD:'synthetic',US10Y:'synthetic',DXY:'synthetic',ETHUSD:'synthetic'};
  async function pull(){try{
    if(typeof MODE==='undefined'||MODE!=='online')return;
    var lg=function(sym){for(var k in BAR_CACHE){if(k.indexOf(sym+'|')===0&&BAR_CACHE[k].length>80)return true}return false};
    /* crypto legs — browser-direct Binance/Bybit, keyless, REAL */
    try{if(!lg('BTCUSD')){var b1=await fetchKlines('BTCUSD','1h',200);if(b1&&b1.length>40)BAR_CACHE['BTCUSD|1h']=b1}if(lg('BTCUSD'))window._imxSrc.BTCUSD=(window._feedSrc||'Binance')}catch(e){}
    try{if(!lg('ETHUSD')){var e1=await fetchKlines('ETHUSD','1h',200);if(e1&&e1.length>40)BAR_CACHE['ETHUSD|1h']=e1}if(lg('ETHUSD'))window._imxSrc.ETHUSD=(window._feedSrc||'Binance')}catch(e){}
    /* XAU — Twelve Data browser-direct when a key is set (10-min throttle, free-tier safe) */
    try{if(typeof API_KEY!=='undefined'&&API_KEY&&!lg('XAUUSD')&&Date.now()-(window._xauAt||0)>600000){window._xauAt=Date.now();var x1=await fetchForex('XAUUSD','1h');if(x1&&x1.length>40)BAR_CACHE['XAUUSD|1h']=x1}if(lg('XAUUSD'))window._imxSrc.XAUUSD='Twelve Data'}catch(e){}
    if(typeof proxyBase!=='function'||!proxyBase())return;
    try{var t=await fetchProxy('^TNX','1h',200);if(t&&t.length>40){BAR_CACHE['US10Y|1h']=t;window._imxSrc.US10Y='yfinance \u00b7 proxy'}}catch(e){}
    try{var d=await fetchProxy('DX-Y.NYB','1h',200);if(d&&d.length>40){BAR_CACHE['DXY|1h']=d;window._imxSrc.DXY='yfinance \u00b7 proxy'}}catch(e){}
  }catch(e){}}
  /* computed DXY from its real FX basket (renormalized w/o SEK) */
  function computedDXY(){try{
    function ser(sym){for(var k in BAR_CACHE){if(k.indexOf(sym+'|')===0&&BAR_CACHE[k].length>80)return BAR_CACHE[k]}return null}
    var E=ser('EURUSD'),J=ser('USDJPY'),G=ser('GBPUSD'),C=ser('USDCAD'),F=ser('USDCHF');
    if(!(E&&J&&G&&C&&F))return false;
    var n=Math.min(E.length,J.length,G.length,C.length,F.length,200);
    var out=[];var W={e:-0.601,j:0.142,g:-0.124,c:0.095,f:0.038}; /* renormalized */
    for(var i=0;i<n;i++){var idx=function(a){return a[a.length-n+i]};
      var v=50.14348112*Math.pow(idx(E).c,W.e)*Math.pow(idx(J).c,W.j)*Math.pow(idx(G).c,W.g)*Math.pow(idx(C).c,W.c)*Math.pow(idx(F).c,W.f);
      out.push({t:idx(E).t,o:v,h:v,l:v,c:v,v:1});}
    BAR_CACHE['DXY|1h']=out;window._imxSrc.DXY='computed from FX basket';return true;}catch(e){return false}}
  setInterval(function(){pull();if(window._imxSrc.DXY==='synthetic')computedDXY();
    try{var b=document.getElementById('imxBody');if(b&&!document.getElementById('imxSrc')){var d2=document.createElement('div');d2.id='imxSrc';b.appendChild(d2)}
      var el=document.getElementById('imxSrc');if(el){var sm2=window._imxSrc||{};var onl2=(typeof MODE!=='undefined'&&MODE==='online');el.textContent=onl2?('sources \u2014 BTC: '+(sm2.BTCUSD||'?')+' \u00b7 XAU: '+(sm2.XAUUSD||'?')+' \u00b7 10Y: '+(sm2.US10Y||'?')+' \u00b7 DXY: '+(sm2.DXY||'?')+' \u00b7 ETH(SMT): '+(sm2.ETHUSD||'?')):'sources \u2014 offline: all legs synthetic (illustrative only)';}}catch(e){}
  },60000);setTimeout(pull,4000);
}catch(e){}})();

/* ================= v11.0 STRUCTURAL CHART PARSER (ML reads the chart) ================= */
(function(){try{
  if(typeof buildSignals!=='function')return;
  window.STRUCT=null;
  var _bs=buildSignals;buildSignals=function(d){
    var out=_bs(d);
    try{
      var sw=swings(d,3);var H=sw.hi.slice(-3),L=sw.lo.slice(-3);
      if(H.length>=2&&L.length>=2){
        var hh=d[H[H.length-1]].h>d[H[H.length-2]].h,hl=d[L[L.length-1]].l>d[L[L.length-2]].l;
        var lh=!hh,ll=!hl;
        var phase=hh&&hl?'uptrend structure (HH+HL)':lh&&ll?'downtrend structure (LH+LL)':'transition / range structure';
        var dv=hh&&hl?1:lh&&ll?-1:0;
        /* impulse vs correction: distance of price from last swing extreme in ATR */
        var atr=IND.atr(d).slice(-1)[0]||d[d.length-1].c*0.008;
        var px=d[d.length-1].c;var lastHi=d[H[H.length-1]].h,lastLo=d[L[L.length-1]].l;
        var pos=(px-lastLo)/((lastHi-lastLo)||1);
        var ctx2=pos>0.75?'pressing the highs':pos<0.25?'testing the lows':'mid-structure';
        /* level confluence density near price */
        var lv=detectSR(d);var near=lv.filter(function(l2){return Math.abs(l2.p-px)<atr*1.2}).length;
        window.STRUCT={phase:phase,pos:+pos.toFixed(2),ctx:ctx2,levelsNear:near};
        var strength=Math.min(1,0.4+near*0.15);
        if(dv!==0)out.S.push({source:'Structure parser',category:'smc',dv:dv,strength:strength,
          reason:phase+' \u2014 '+ctx2+(near?' into '+near+' clustered level'+(near>1?'s':''):''),weight:1.1,value:pos,
          dirLabel:dv>0?'BULL':'BEAR'});
      }
    }catch(e){}
    return out;};
}catch(e){}})();

/* ================= v11.0 MACRO-CONDITIONED READ + NaN firewall ================= */
(function(){try{
  if(typeof consensusSignal!=='function')return;
  var _cs=consensusSignal;consensusSignal=function(d,acc){
    var r=_cs(d,acc);
    try{
      if(!Number.isFinite(r.score))r.score=0;if(!Number.isFinite(r.confidence))r.confidence=0;
      var m=window._imx;
      if(m&&typeof CURSYM!=='undefined'&&(CURSYM.cls==='crypto'||CURSYM.cls==='cryptofut')&&d===DATA){
        var dxyZ=(m.spreads&&m.spreads[0])?m.spreads[0].z:0; /* BTC vs DXY spread z */
        if(Number.isFinite(dxyZ)&&Math.abs(dxyZ)>2&&Math.sign(dxyZ)!==Math.sign(r.score)&&r.score!==0){
          r.score=Math.round(r.score*0.75);r.macroNote='macro headwind: BTC-DXY spread '+dxyZ.toFixed(1)+'z against this read (score dampened 25%)';}
        if(m.regime&&m.regime.pHighVol>0.7)r.macroNote=(r.macroNote?r.macroNote+' \u00b7 ':'')+'high-vol regime (p='+m.regime.pHighVol+')';
      }
    }catch(e){}
    return r;};
  /* surface the macro note + structure in the XAI extras */
  setInterval(function(){try{
    var box=document.getElementById('xaiExtras');if(!box)return;
    var con=IND._consensus;var extra='';
    if(con&&con.macroNote)extra+='<div class="xh">Macro conditioning</div>'+con.macroNote;
    if(window.STRUCT)extra+='<div class="xh">Structure read</div>'+window.STRUCT.phase+' \u00b7 '+window.STRUCT.ctx+' \u00b7 range position '+(window.STRUCT.pos*100).toFixed(0)+'%';
    var old=box.querySelector('#xaiMacro');if(old)old.remove();
    if(extra){var d2=document.createElement('div');d2.id='xaiMacro';d2.innerHTML=extra;box.appendChild(d2)}
  }catch(e){}},8000);
}catch(e){}})();

/* ================= v11.0 NEWS & CALENDAR QUICK-LINKS ================= */
(function(){try{
  var icons=document.querySelector('.topgrp-icons');if(!icons)return;
  var b=document.createElement('button');b.className='tbtn iconbtn';b.title='News & calendar quick-links';
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>';
  icons.insertBefore(b,icons.firstChild);
  var p=document.createElement('div');p.id='newsPanel';document.body.appendChild(p);
  var LINKS=[['Calendars',[['ForexFactory calendar','https://www.forexfactory.com/calendar'],['Investing.com econ calendar','https://www.investing.com/economic-calendar/'],['CoinMarketCal (crypto events)','https://coinmarketcal.com/'],['Fed meeting calendar','https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm']]],
    ['Live intel',[['CoinGlass liquidations','https://www.coinglass.com/LiquidationData'],['Binance announcements','https://www.binance.com/en/support/announcement'],['TradingEconomics US10Y','https://tradingeconomics.com/united-states/government-bond-yield'],['DXY \u00b7 MarketWatch','https://www.marketwatch.com/investing/index/dxy']]]];
  function render(){var my=[];try{my=JSON.parse(localStorage.getItem('mishel_links')||'[]')}catch(e){}
    p.innerHTML=LINKS.map(function(g){return '<div class="np-h">'+g[0]+'</div>'+g[1].map(function(L){return '<a class="np-a" href="'+L[1]+'" target="_blank" rel="noopener">'+L[0]+'<small>'+L[1].replace('https://','').split('/')[0]+'</small></a>'}).join('')}).join('')
      +'<div class="np-h">Your links</div>'+my.map(function(L,i){return '<a class="np-a" href="'+L[1]+'" target="_blank" rel="noopener">'+L[0]+'<small>'+L[1].replace('https://','').split('/')[0]+'</small></a>'}).join('')
      +'<a class="np-a" id="npAdd" style="color:var(--gold)">+ Add your own link\u2026</a>';
    var add=p.querySelector('#npAdd');if(add)add.onclick=function(){var u=prompt('Link URL (https://\u2026):');if(!u)return;var n=prompt('Name:',u.replace('https://','').split('/')[0]);if(!n)return;
      my.push([n,u]);try{localStorage.setItem('mishel_links',JSON.stringify(my))}catch(e){}render();};}
  b.onclick=function(e){e.stopPropagation();if(p.style.display==='block'){p.style.display='none';return}
    render();var r=b.getBoundingClientRect();p.style.top=(r.bottom+8)+'px';p.style.left=Math.max(8,r.right-290)+'px';p.style.display='block';};
  document.addEventListener('click',function(e){if(p.style.display==='block'&&!(e.target.closest&&(e.target.closest('#newsPanel')||e.target===b)))p.style.display='none';});
}catch(e){}})();

