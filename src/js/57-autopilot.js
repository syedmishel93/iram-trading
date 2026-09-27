/* ================= v10.0 AUTOPILOT (demo account, fully autonomous) ================= */
(function(){try{
  var q=document.getElementById('qOpen');if(!q||!q.parentElement)return;
  var b=document.createElement('button');b.className='tbtn';b.id='apBtn';b.textContent='AUTOPILOT: OFF (demo)';
  b.title='Fully autonomous demo trading: consensus+confidence gate, Kelly-vol sizing, ATR brackets, kill-switch enforced. Demo account only, by design.';
  q.parentElement.appendChild(b);
  window.AUTOPILOT=false;window.AUTLOG=[];
  b.onclick=function(){window.AUTOPILOT=!window.AUTOPILOT;
    b.classList.toggle('on',window.AUTOPILOT);
    b.textContent='AUTOPILOT: '+(window.AUTOPILOT?'ON (demo)':'OFF (demo)');
    toast(window.AUTOPILOT?'Autopilot engaged: statistical edges only, zero hands. Demo account.':'Autopilot off','var(--gold)');};
  function killSwitch(){try{
    var rec=JSON.parse(localStorage.getItem('mishel_day0')||'null');if(!rec)return false;
    var eq=PAPER.bal+(typeof unrealized==='function'?unrealized():0);
    var maxDL=+((document.getElementById('setMaxDL')||{}).value)||3;
    if(rec.eq&&eq<rec.eq*(1-maxDL/100)){
      if(PAPER.pos.length){PAPER.pos.slice().forEach(function(p){try{paperClose(p.id,'kill-switch')}catch(e){}});
        toast('KILL-SWITCH: all positions flattened, autopilot disengaged','var(--bear)');try{if(window.sendTG)sendTG('\ud83d\uded1 KILL-SWITCH \u2014 daily loss limit hit: all demo positions flattened, autopilot disengaged')}catch(e){}}
      window.AUTOPILOT=false;b.classList.remove('on');b.textContent='AUTOPILOT: OFF (kill-switch)';
      return true;}
    return false;}catch(e){return false}}
  setInterval(function(){try{
    if(killSwitch())return;
    if(!window.AUTOPILOT)return;
    var t0=performance.now();
    var con=IND._consensus||consensusSignal(DATA);
    if(!Number.isFinite(con.score)||!Number.isFinite(con.confidence))return;if(window._imx&&window._imx.anomaly&&window._imx.anomaly.flag){AUTLOG.push({t:Date.now(),skip:'stood down: structural anomaly flagged'});if(AUTLOG.length>200)AUTLOG.shift();return}if(Math.abs(con.score)<25||con.confidence<55){AUTLOG.push({t:Date.now(),skip:'edge too weak: score '+con.score+' / conf '+con.confidence+'%'});if(AUTLOG.length>200)AUTLOG.shift();return}
    if(PAPER.pos.some(function(p){return p.sym===CURSYM.sym}))return;
    /* robustness quick check */
    var rep2=null;try{rep2=confluence(buildSignals(DATA).S)}catch(e){return}
    var scores=[];for(var k=0;k<30;k++){var sub=rep2.S.filter(function(){return Math.random()>0.3});if(sub.length>3)scores.push(confluence(sub).score)}
    scores.sort(function(a,c){return a-c});var spread=(scores[Math.floor(scores.length*0.9)]-scores[Math.floor(scores.length*0.1)])/2;
    if(spread>0.18){AUTLOG.push({t:Date.now(),skip:'fragile read: dropout spread '+spread.toFixed(2)});if(AUTLOG.length>200)AUTLOG.shift();return} /* fragile read: stand down */
    var side=con.score>0?1:-1;var px=curPrice();var atr=IND.atr(DATA).slice(-1)[0]||px*0.008;
    var sl=px-side*2*atr,tp=px+side*3*atr;
    /* Kelly-vol sizing from journal edge, quarter-Kelly, vol-scaled */
    var risk=0.75;try{var h=PAPER.hist;if(h.length>=8){var w=h.filter(function(t){return t.pl>0}),l=h.filter(function(t){return t.pl<=0});
      if(w.length&&l.length){var p2=w.length/h.length,aw=w.reduce(function(a,t){return a+t.pl},0)/w.length,al=Math.abs(l.reduce(function(a,t){return a+t.pl},0)/l.length)||1;
        var f=Math.max(0,(p2*(aw/al)-(1-p2))/(aw/al));risk=Math.max(0.25,Math.min(2,f*25));}}}catch(e){}
    var tgtVol=0.008;risk=risk*Math.max(0.4,Math.min(1.6,tgtVol/((atr/px)||tgtVol)));
    try{document.getElementById('pSL').value=fmt(sl).replace(/,/g,'');document.getElementById('pTP').value=fmt(tp).replace(/,/g,'');
      document.getElementById('pRisk').value=risk.toFixed(2);document.getElementById('pQty').value='';}catch(e){}
    var before=PAPER.pos.length;
    try{paperOpen(side)}catch(e){return}
    var ms=Math.round(performance.now()-t0);
    if(PAPER.pos.length>before){try{PAPER.pos[PAPER.pos.length-1]._auto=true}catch(e){}
      AUTLOG.push({t:Date.now(),sym:CURSYM.sym,side:side,score:con.score,conf:con.confidence,risk:+risk.toFixed(2),ms:ms});
      try{ALERT_LOG.unshift({t:Date.now(),sym:CURSYM.sym,desc:'AUTOPILOT '+(side>0?'LONG':'SHORT')+' \u00b7 score '+con.score+' \u00b7 '+con.confidence+'% \u00b7 risk '+risk.toFixed(2)+'% \u00b7 decided in '+ms+'ms',val:''});if(window.updateBell)updateBell()}catch(e){}
      try{if(window.sendTG)sendTG('\ud83e\udd16 AUTOPILOT (demo) '+(side>0?'LONG ':'SHORT ')+CURSYM.sym+' @ '+fmt(px)+' \u00b7 score '+con.score+' \u00b7 conf '+con.confidence+'% \u00b7 risk '+risk.toFixed(2)+'% \u2014 demo account, informational')}catch(e){}
    }
  }catch(e){}},30000);
}catch(e){}})();

/* ================= v10.0 chart: linear regression channel ================= */
(function(){try{
  var _d7=draw;draw=function(){_d7();try{
    if(!RENDER||!ON.has('lrc'))return;var g=cv.getContext('2d');
    var st2=RENDER.start,cw2=RENDER.cw,ph2=RENDER.priceH,W2=RENDER.W,pr2=RENDER.padR;
    var end2=Math.min(DATA.length,st2+Math.ceil((W2-pr2)/cw2)+1);var n=end2-st2;if(n<10)return;
    var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;
    var Y=function(p){return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*ph2};
    var sx=0,sy=0,sxy=0,sxx=0;for(var i=0;i<n;i++){var c=DATA[st2+i].c;sx+=i;sy+=c;sxy+=i*c;sxx+=i*i}
    var slope=(n*sxy-sx*sy)/((n*sxx-sx*sx)||1e-9),icpt=(sy-slope*sx)/n;
    var sd=0;for(var j=0;j<n;j++){var e2=DATA[st2+j].c-(icpt+slope*j);sd+=e2*e2}sd=Math.sqrt(sd/n);
    [[0,'rgba(76,130,251,.9)',1.6],[1,'rgba(76,130,251,.45)',1],[-1,'rgba(76,130,251,.45)',1],[2,'rgba(76,130,251,.25)',1],[-2,'rgba(76,130,251,.25)',1]].forEach(function(L2){
      g.strokeStyle=L2[1];g.lineWidth=L2[2];g.beginPath();
      g.moveTo(cw2/2,Y(icpt+L2[0]*sd));g.lineTo((n-1)*cw2+cw2/2,Y(icpt+slope*(n-1)+L2[0]*sd));g.stroke();});
    g.lineWidth=1;g.fillStyle='rgba(76,130,251,.9)';g.font='8.5px JetBrains Mono';g.textAlign='left';
    g.fillText('LRC '+(slope>=0?'+':'')+((slope*n)/DATA[end2-1].c*100).toFixed(1)+'% / window',4,Y(icpt+slope*(n-1))-6);
  }catch(e){}};
  var body=document.getElementById('indPanelBody');
  if(body){var host=body.querySelector('.tcat');
    var ch=document.createElement('div');ch.className='chip';ch.dataset.ind='lrc';ch.style.cssText='--k:#4C82FB';ch.innerHTML='<span class="sw"></span>Regression Channel';
    if(host)host.appendChild(ch);
    ch.onclick=function(e){e.stopPropagation();if(ON.has('lrc'))ON.delete('lrc');else ON.add('lrc');ch.classList.toggle('on',ON.has('lrc'));
      var ic=document.getElementById('indCount');if(ic)ic.textContent='('+ON.size+' on)';try{draw()}catch(_){}};}
}catch(e){}})();


/* ================= v11.0 DATA TRUTH ================= */
(function(){try{
  var wrap=cv.parentElement;var w=document.createElement('div');w.id='liveWarn';w.textContent='';wrap.appendChild(w);
  setInterval(function(){try{
    var online=(typeof MODE!=='undefined'&&MODE==='online');
    var isCrypto=CURSYM&&(CURSYM.cls==='crypto'||CURSYM.cls==='cryptofut');
    var live=online&&(isCrypto||window._realFeed)&&window._lastTick&&(Date.now()-window._lastTick<90000);
    var sf=document.getElementById('stFeed');
    if(sf)sf.textContent=live?((window._feedSrc||'Binance')+(isCrypto?' WS':'')+' \u00b7 REAL'+(window._feedDelay?' \u00b7 delayed':'')):(online?(isCrypto?'ONLINE \u00b7 feed stale/unavailable':'ONLINE \u00b7 no live vendor for this class'):'synthetic \u00b7 offline');
    if(sf)sf.style.color=live?'var(--bull)':(online?'var(--bear)':'');
    /* hard truth banner: Online but chart is NOT live */
    if(online&&!live){w.style.display='block';w.textContent=isCrypto?'\u26a0 LIVE MODE: this chart is NOT receiving real ticks (feed stale or failed). Retry, switch source, or go Offline.':'\u26a0 LIVE MODE: '+CURSYM.name+' has no browser-direct live vendor \u2014 data shown is NOT real. Use the proxy (Settings) or trade crypto symbols live.'}
    else w.style.display='none';
    /* footer static text -> truth */
    var tail=document.querySelector('.status .s[style*="margin-left"]');
    if(tail)tail.textContent='Mishel Intelligence Trading \u00b7 '+(live?'REAL DATA ('+(window._feedSrc||'Binance')+(window._feedDelay?' \u00b7 delayed':'')+')':'synthetic/offline data')+' \u00b7 not financial advice';
  }catch(e){}},4000);
}catch(e){}})();

/* ================= v11.0 BYBIT FAILOVER (public v5 REST) ================= */
(function(){try{
  if(typeof fetchKlines!=='function')return;
  window._feedSrc='Binance';
  var TFB={'1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','1h':'60','2h':'120','4h':'240','6h':'360','12h':'720','1d':'D','1w':'W'};
  async function bybit(sym,interval,n){
    var bs=(sym||'').replace('USD','USDT').replace('PERP','USDT');
    var iv=TFB[interval]||TFB[(TF||'1h')]||'60';
    var r=await fetch('https://api.bybit.com/v5/market/kline?category=spot&symbol='+bs+'&interval='+iv+'&limit='+Math.min(1000,n||300));
    var j=await r.json();if(!j.result||!j.result.list)throw new Error('bybit empty');
    return j.result.list.map(function(k){return {t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}}).reverse();}
  var _fk=fetchKlines;fetchKlines=async function(sym,interval,n){
    if(window.FORCE_SRC&&window.FORCE_SRC!=='binance'&&window._PROV&&window._PROV[window.FORCE_SRC]){
      var fb=await window._PROV[window.FORCE_SRC](sym,interval,n);
      window._feedSrc={bybit:'Bybit',kraken:'Kraken',coinbase:'Coinbase',okx:'OKX',kucoin:'KuCoin',gate:'Gate.io'}[window.FORCE_SRC]+' (forced)';return fb}
    if(window.FORCE_BYBIT){var bb=await bybit(sym,interval,n);window._feedSrc='Bybit';return bb}
    try{var out=await _fk(sym,interval,n);
      if(out&&out.length>10){window._feedSrc='Binance';return out}
      throw new Error('thin');}
    catch(e){
      try{var b=await bybit(sym,interval,n);window._feedSrc='Bybit (failover)';
        try{toast('Binance feed failed \u2014 switched to Bybit','var(--gold)')}catch(_){}
        return b;}
      catch(e2){
        try{var kk=await _kraken(sym,interval,n);window._feedSrc='Kraken (failover)';
          try{toast('Binance+Bybit failed \u2014 switched to Kraken','var(--gold)')}catch(_){}
          return kk;}
        catch(e3){
          try{var cb=await _coinbase(sym,interval,n);window._feedSrc='Coinbase (failover)';
            try{toast('Switched to Coinbase','var(--gold)')}catch(_){}
            return cb;}
          catch(e4){
            try{var ox=await _okx(sym,interval,n);window._feedSrc='OKX (failover)';
              try{toast('Switched to OKX','var(--gold)')}catch(_){}
              return ox;}
            catch(e5){
              try{var ku=await _kucoin(sym,interval,n);window._feedSrc='KuCoin (failover)';
                try{toast('Switched to KuCoin','var(--gold)')}catch(_){}
                return ku;}
              catch(e6){var gt=await _gateio(sym,interval,n);window._feedSrc='Gate.io (failover)';
                try{toast('Switched to Gate.io \u2014 last free fallback','var(--gold)')}catch(_){}
                return gt;}}}}}}};
  /* v15.4: two more free public providers in the failover chain */
  var TFK={'1m':1,'3m':1,'5m':5,'15m':15,'30m':30,'1h':60,'2h':60,'4h':240,'6h':240,'12h':720,'1d':1440,'1w':10080};
  async function _kraken(sym,interval,n){
    var ks=(sym||'').replace('BTC','XBT').replace('USD','USD');
    var iv=TFK[interval]||60;
    var r=await fetch('https://api.kraken.com/0/public/OHLC?pair='+ks+'&interval='+iv);
    var j=await r.json();if(j.error&&j.error.length)throw new Error('kraken: '+j.error[0]);
    var key=Object.keys(j.result||{}).filter(function(k){return k!=='last'})[0];
    if(!key)throw new Error('kraken empty');
    var rows=j.result[key].map(function(k){return {t:+k[0]*1000,o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[6]}});
    return rows.slice(-Math.min(rows.length,n||300));}
  var TFC={'1m':60,'5m':300,'15m':900,'1h':3600,'6h':21600,'1d':86400};
  async function _coinbase(sym,interval,n){
    var cs=(sym||'').replace('USD','-USD');
    var gran=TFC[interval]||3600;
    var r=await fetch('https://api.exchange.coinbase.com/products/'+cs+'/candles?granularity='+gran);
    var j=await r.json();if(!Array.isArray(j)||!j.length)throw new Error('coinbase empty');
    return j.map(function(k){return {t:+k[0]*1000,o:+k[3],h:+k[2],l:+k[1],c:+k[4],v:+k[5]}}).reverse().slice(-Math.min(j.length,n||300));}
  /* v16.1: three more free public providers — pure mappers are unit-tested */
  function _okxArgs(sym,interval){var m={'1m':'1m','3m':'3m','5m':'5m','15m':'15m','30m':'30m','1h':'1H','2h':'2H','4h':'4H','6h':'6H','12h':'12H','1d':'1D','1w':'1W'};
    return {instId:(sym||'').replace('USD','-USDT'),bar:m[interval]||'1H'}}
  function _okxRows(j,n){if(!j||!Array.isArray(j.data)||!j.data.length)throw new Error('okx empty');
    return j.data.map(function(k){return {t:+k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}}).reverse().slice(-Math.min(j.data.length,n||300))}
  async function _okx(sym,interval,n){var a=_okxArgs(sym,interval);
    var r=await fetch('https://www.okx.com/api/v5/market/candles?instId='+a.instId+'&bar='+a.bar+'&limit='+Math.min(300,n||300));
    return _okxRows(await r.json(),n)}
  function _kucoinArgs(sym,interval){var m={'1m':'1min','3m':'3min','5m':'5min','15m':'15min','30m':'30min','1h':'1hour','2h':'2hour','4h':'4hour','6h':'6hour','12h':'12hour','1d':'1day','1w':'1week'};
    return {symbol:(sym||'').replace('USD','-USDT'),type:m[interval]||'1hour'}}
  function _kucoinRows(j,n){if(!j||!Array.isArray(j.data)||!j.data.length)throw new Error('kucoin empty');
    return j.data.map(function(k){return {t:+k[0]*1000,o:+k[1],h:+k[3],l:+k[4],c:+k[2],v:+k[5]}}).reverse().slice(-Math.min(j.data.length,n||300))}
  async function _kucoin(sym,interval,n){var a=_kucoinArgs(sym,interval);
    var r=await fetch('https://api.kucoin.com/api/v1/market/candles?type='+a.type+'&symbol='+a.symbol);
    return _kucoinRows(await r.json(),n)}
  function _gateArgs(sym,interval){var ok={'1m':1,'5m':1,'15m':1,'30m':1,'1h':1,'4h':1,'1d':1,'1w':1};
    return {pair:(sym||'').replace('USD','_USDT'),interval:ok[interval]?interval:'1h'}}
  function _gateRows(j,n){if(!Array.isArray(j)||!j.length)throw new Error('gate empty');
    return j.map(function(k){return {t:+k[0]*1000,o:+k[5],h:+k[3],l:+k[4],c:+k[2],v:+k[6]}}).slice(-Math.min(j.length,n||300))}
  async function _gateio(sym,interval,n){var a=_gateArgs(sym,interval);
    var r=await fetch('https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair='+a.pair+'&interval='+a.interval+'&limit='+Math.min(500,n||300));
    return _gateRows(await r.json(),n)}
  window._PROV={bybit:function(s,i,n){return bybit(s,i,n)},kraken:_kraken,coinbase:_coinbase,okx:_okx,kucoin:_kucoin,gate:_gateio};
}catch(e){}})();

