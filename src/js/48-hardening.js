/* ================= v26.1 HARDENING (client side) ================= */
(function(){
  /* H1: attach the service token (if the user set one) to every service call */
  var _f=window.fetch;
  window.fetch=function(url,opt){
    try{var u=(typeof url==='string')?url:(url&&url.url)||'';
      if(u.indexOf('/svc/')>=0){var tok=localStorage.getItem('mishel_svc_token');
        if(tok){opt=opt||{};opt.headers=Object.assign({},opt.headers||{},{'X-Mishel-Token':tok});}}}catch(e){}
    return _f.call(this,url,opt)};
  /* H2: loop-staleness banner — polls /svc/health; if any background loop hasn't ticked in >10min, show red */
  function chk(){try{var sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    fetch(sb+'/svc/health',{signal:AbortSignal.timeout(2500)}).then(function(r){return r.json()}).then(function(j){
      var b=document.getElementById('loopStaleBanner');
      if(j&&j.stale_loops&&j.stale_loops.length){
        if(!b){b=document.createElement('div');b.id='loopStaleBanner';
          b.style.cssText='position:fixed;bottom:38px;left:50%;transform:translateX(-50%);z-index:500;background:color-mix(in srgb,var(--bear) 18%,var(--panel));border:1px solid var(--bear);color:var(--bear);font:600 11px/1.4 var(--mono);padding:7px 14px;border-radius:9px;box-shadow:0 8px 24px -10px rgba(0,0,0,.6)';
          document.body.appendChild(b);}
        /* v39.2: loops now tick every 20s even while sleeping (sleep_ticking), so this banner
           no longer false-alarms on hourly loops - if it shows, a thread is GENUINELY hung.
           Print how stale, so a 12-min blip and a 3-hour corpse read differently. */
        b.textContent='\u26a0 service loop STUCK: '+j.stale_loops.map(function(k){var m=j.loops&&j.loops[k]?Math.round(j.loops[k].stale_s/60):'?';return k+' ('+m+'m)'}).join(', ')+' \u2014 restart mishel_service.py; its work has NOT been happening';
        b.style.display='block';
      }else if(b)b.style.display='none';
    }).catch(function(){})}catch(e){}}
  setTimeout(chk,4000);setInterval(chk,60000);
})();

/* ================= v31.0 E1/E2: ORDER FLOW + OI (Binance free, browser-direct) ================= */
(function(){
  window._oflow={spread:null,cvd:[],tape:[],oi:null,oiPrev:null,ls:null,sym:null};
  var ws1=null,ws2=null;
  function base(){try{var b=(CURSYM.sym||'').replace(/USD$/,'USDT');return /USDT$/.test(b)?b.toLowerCase():null}catch(e){return null}}
  function isCrypto(){try{return /BTC|ETH|SOL|BNB|XRP|DOGE|ADA/.test(CURSYM.sym)&&typeof MODE!=='undefined'&&MODE==='online'}catch(e){return false}}
  function stop(){try{if(ws1)ws1.close();if(ws2)ws2.close()}catch(e){}ws1=ws2=null;}
  function start(){stop();var b=base();if(!b||!isCrypto())return;var O=window._oflow;O.sym=b;O.cvd=[];O.tape=[];
    try{ws1=new WebSocket('wss://stream.binance.com:9443/ws/'+b+'@bookTicker');
      ws1.onmessage=function(m){try{var j=JSON.parse(m.data);O.spread={bid:+j.b,ask:+j.a,t:Date.now()}}catch(e){}};}catch(e){}
    try{ws2=new WebSocket('wss://stream.binance.com:9443/ws/'+b+'@aggTrade');
      var cum=O.cvd.length?O.cvd[O.cvd.length-1].v:0;
      ws2.onmessage=function(m){try{var j=JSON.parse(m.data);var q=+j.q*(+j.p);cum+=j.m?-q:q; /* m=true buyer is maker => sell aggressor */
        O.tape.unshift({p:+j.p,q:q,sell:!!j.m,t:+j.T});if(O.tape.length>24)O.tape.pop();
        var now=Date.now();var lastPt=O.cvd[O.cvd.length-1];
        if(!lastPt||now-lastPt.t>5000){O.cvd.push({t:now,v:cum});if(O.cvd.length>120)O.cvd.shift()}else lastPt.v=cum;}catch(e){}};}catch(e){}
  }
  function pollOI(){var b=base();if(!b||!isCrypto())return;var B=b.toUpperCase();
    fetch('https://fapi.binance.com/fapi/v1/openInterest?symbol='+B,{signal:AbortSignal.timeout(4000)}).then(function(r){return r.json()}).then(function(j){
      var O=window._oflow;O.oiPrev=O.oi;O.oi={v:+j.openInterest,t:Date.now()}}).catch(function(){});
    fetch('https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol='+B+'&period=1h&limit=1',{signal:AbortSignal.timeout(4000)}).then(function(r){return r.json()}).then(function(j){
      if(j&&j[0])window._oflow.ls=+j[0].longShortRatio}).catch(function(){});}
  var lastSym2=null;
  setInterval(function(){try{if(CURSYM&&CURSYM.sym!==lastSym2){lastSym2=CURSYM.sym;start();pollOI()}}catch(e){}},3000);
  setInterval(pollOI,90000);
})();

/* ================= v26.0 COCKPIT — right-side decision cards S1-S14 ================= */
(function(){
  var ORDER_KEY='mishel_cockpit',W_KEY='mishel_sidew';
  function st(){try{return JSON.parse(localStorage.getItem(ORDER_KEY)||'{}')}catch(e){return{}}}
  function stSave(o){try{localStorage.setItem(ORDER_KEY,JSON.stringify(o))}catch(e){}}
  function fmtN(v,dec){return v==null||!isFinite(v)?'\u2014':(+v).toFixed(dec!=null?dec:( +v<10?4:+v<1000?2:0))}
  function row(k,v,col){return '<div class="ck-row"><span class="k">'+k+'</span><span class="v"'+(col?' style="color:'+col+'"':'')+'>'+v+'</span></div>'}
  function card(id,title,body,note,chips){return '<div class="ck" id="ck-'+id+'" draggable="true" data-ck="'+id+'"><div class="ck-h">'+title+'<span class="ck-car">\u25bc</span></div><div class="ck-b">'+body+(note?'<div class="ck-note">'+note+'</div>':'')+(chips?'<div style="display:flex;gap:5px;margin-top:7px;flex-wrap:wrap">'+chips.map(function(c5){return '<button class="tbtn ckchip" data-act="'+c5[1]+'" style="padding:1px 9px;font-size:9px">'+c5[0]+'</button>'}).join('')+'</div>':'')+'</div></div>'}

  window._confHist=window._confHist||[];

  function planCalc(x){ /* S1: structured starting point, glass-box */
    var price=x.price,atr=x.atr||price*0.005,dir=x.rep.score>=0?'LONG':'SHORT';
    var sw=IND._sw||{hi:[],lo:[]},d=DATA;
    var lastLo=sw.lo.length?d[sw.lo[sw.lo.length-1]].l:price-1.2*atr;
    var lastHi=sw.hi.length?d[sw.hi[sw.hi.length-1]].h:price+1.2*atr;
    var stop=dir==='LONG'?Math.min(lastLo,price-1.2*atr)-0.15*atr:Math.max(lastHi,price+1.2*atr)+0.15*atr;
    var R=Math.abs(price-stop);var t1=dir==='LONG'?price+R:price-R;var t2=dir==='LONG'?price+2*R:price-2*R;
    return {dir:dir,entryLo:price-0.25*atr,entryHi:price+0.25*atr,stop:stop,r:R,t1:t1,t2:t2,swing:dir==='LONG'?lastLo:lastHi,atr:atr};}

  function build(){
    var side=document.getElementById('side');if(!side)return;
    if(!document.getElementById('v-chart')||!document.getElementById('v-chart').classList.contains('on'))return;
    if(typeof DATA==='undefined'||!DATA||DATA.length<30)return;
    var x;try{x=analystContext()}catch(e){return}
    var dec=x.dec,price=x.price,atr=x.atr||0;
    var S=st(),closed=S.closed||{};
    var cards={};

    /* S1 Trade Plan */
    var pl=planCalc(x);
    cards.plan=card('plan','\ud83d\udccb Trade Plan <span class="tag" title="Auto-computed structured starting point: direction from confluence sign, entry zone = price \u00b10.25 ATR, stop beyond the last swing (\u22651.2 ATR), targets at 1R/2R. Inputs shown \u2014 glass box. NOT advice.">'+pl.dir+'</span>',
      row('entry zone',fmtN(pl.entryLo,dec)+' \u2013 '+fmtN(pl.entryHi,dec))
      +row('stop',fmtN(pl.stop,dec),'var(--bear)')
      +row('target 1 (1R)',fmtN(pl.t1,dec),'var(--bull)')
      +row('target 2 (2R)',fmtN(pl.t2,dec),'var(--bull)')
      +row('risk (R)',fmtN(pl.r,dec)+' \u00b7 '+(pl.r/price*100).toFixed(2)+'%')
      +row('breakeven win-rate @1:2','33.4% needed'+((window._sigState||{}).stats&&window._sigState.stats.winPct!=null?' \u00b7 measured '+(window._sigState.stats.winPct*100).toFixed(0)+'%':''))
      +row('R:R at T2','1 : 2')
      +(window._liveSig&&window._liveSig.sym===x.sym?'<div style="margin-top:6px"><button class="tbtn" id="ckTook" style="padding:2px 10px;font-size:10px" title="C7: log this live signal to your decision journal \u2014 resolved later with the same stop-first honesty as the engine record.">\u{1F4D3} I took this</button></div>':''),
      'logic: dir='+pl.dir.toLowerCase()+' (confluence '+x.rep.score.toFixed(2)+') \u00b7 stop beyond swing '+fmtN(pl.swing,dec)+' + 0.15 ATR \u00b7 ATR '+fmtN(pl.atr,dec)+' \u00b7 structured starting point, not advice',[['\u{1F4CB} MT5 ticket','ticket'],['\u{1F4D3} journal','journal']]);

    /* S2 Sizer */
    var acct=+(localStorage.getItem('mishel_ck_acct')||10000),risk=+(localStorage.getItem('mishel_ck_risk')||1);
    var riskAmt=acct*risk/100,units=pl.r>0?riskAmt/pl.r:0;
    cards.sizer=card('sizer','\u2696\ufe0f Position Size <span class="tag" title="account \u00d7 risk% \u00f7 stop distance. Uses the Trade Plan stop live.">LIVE</span>',
      '<div style="display:flex;gap:6px;margin-bottom:6px"><input id="ckAcct" class="mono" value="'+acct+'" style="width:50%;background:var(--panel2);border:1px solid var(--edge);border-radius:6px;padding:3px 6px;color:var(--txt);font-size:10.5px" title="account $"><input id="ckRisk" class="mono" value="'+risk+'" style="width:26%;background:var(--panel2);border:1px solid var(--edge);border-radius:6px;padding:3px 6px;color:var(--txt);font-size:10.5px" title="risk %"><span style="font-size:9px;color:var(--muted2);align-self:center">$/%</span></div>'
      +row('risk amount','$'+riskAmt.toFixed(2))
      +row('size @ plan stop','<b class="ck-big">'+ (units>=1000?units.toFixed(0):units.toFixed(units<1?4:2)) +'</b> units')
      +row('notional','$'+(units*price).toFixed(0)),
      'stop distance from Trade Plan ('+fmtN(pl.r,dec)+'). Edit account/risk% \u2014 persisted.');

    /* S3 Key Levels */
    var L=x.L||{};var lv=[];
    ['pdh','pdl','pdc','pwh','pwl'].forEach(function(k){if(L[k]!=null)lv.push([k.toUpperCase(),L[k]])});
    if(x.vwap!=null)lv.push(['VWAP',x.vwap]);
    try{var fv=(IND._fvg||[]).slice(-6).map(function(f){return['FVG '+f.type,(f.top+f.bot)/2]});lv=lv.concat(fv.slice(-2))}catch(e){}
    try{var ob=(IND._ob||[]).slice(-2).map(function(o){return['OB '+(o.type||''),(o.top+o.bot)/2]});lv=lv.concat(ob)}catch(e){}
    lv=lv.filter(function(a){return isFinite(a[1])}).map(function(a){return{n:a[0],p:a[1],d:(a[1]-price)/price*100,da:atr?(a[1]-price)/atr:0}});
    lv.sort(function(a,b){return Math.abs(a.d)-Math.abs(b.d)});
    cards.levels=card('levels','\ud83d\udccd Key Levels <span class="tag" title="PDH/PDL/PWH/PWL + VWAP + nearest FVG/OB, each with live distance in % and ATRs. Sorted nearest-first.">'+lv.length+'</span>',
      lv.slice(0,8).map(function(l){return row(l.n,fmtN(l.p,dec)+' <span style="color:'+(l.d>=0?'var(--bull)':'var(--bear)')+'">'+(l.d>=0?'+':'')+l.d.toFixed(2)+'%</span> \u00b7 '+Math.abs(l.da).toFixed(1)+'\u00d7ATR')}).join('')||'<span class="ck-note">levels build as daily/weekly history accumulates</span>','',lv.length?[['\u{1F514} alert @ '+lv[0].n,'alertlvl']]:null);

    /* S4 Vol & Regime */
    var rets=[];for(var i=Math.max(1,DATA.length-500);i<DATA.length;i++){rets.push(Math.abs(DATA[i].c/DATA[i-1].c-1))}
    var cur20=0;for(var j=Math.max(1,DATA.length-20);j<DATA.length;j++)cur20+=Math.abs(DATA[j].c/DATA[j-1].c-1);cur20/=Math.min(20,DATA.length-1);
    var below=rets.filter(function(r){return r<=cur20}).length;var volPct=rets.length?Math.round(below/rets.length*100):50;
    var trending=/trend/i.test(x.reg.regime||'');
    cards.vol=card('vol','\ud83c\udf21\ufe0f Volatility & Regime <span class="tag">'+(x.reg.regime||'\u2014')+'</span>',
      row('ATR',fmtN(atr,dec)+' ('+(atr/price*100).toFixed(2)+'%)'+judge('atrPct',atr/price*100))
      +row('realized vol percentile',volPct+'th'+judge('volPctile',volPct),volPct>75?'var(--bear)':volPct<25?'var(--muted)':'var(--txt)')
      +row('ADX',x.adx.toFixed(0))
      +row('stop-width implication',trending?'\u2265 1.2\u00d7ATR (trend runs)':'\u2248 0.8\u20131.0\u00d7ATR (range)'),
      x.reg.advice||'');

    /* S5 Session clock */
    var now=new Date(),h=now.getUTCHours()+now.getUTCMinutes()/60;
    var sess=[['Asia',23,8],['London',7,16],['New York',12,21]];
    var live=sess.filter(function(sx){var a=sx[1],b=sx[2];return a<b?(h>=a&&h<b):(h>=a||h<b)}).map(function(sx){return sx[0]});
    var nexts=[];sess.forEach(function(sx){[sx[1],sx[2]].forEach(function(bd,ix){var dh=(bd-h+24)%24;if(dh>0.001)nexts.push({n:sx[0]+(ix?' close':' open'),m:Math.round(dh*60)})})});
    nexts.sort(function(a,b){return a.m-b.m});
    var hrV=new Array(24).fill(0),hrN=new Array(24).fill(0);
    for(var k2=1;k2<DATA.length;k2++){var hh=new Date(DATA[k2].t).getUTCHours();hrV[hh]+=Math.abs(DATA[k2].c/DATA[k2-1].c-1);hrN[hh]++}
    var curH=now.getUTCHours(),curHV=hrN[curH]?hrV[curH]/hrN[curH]:0,avgHV=0,cnt=0;for(var k3=0;k3<24;k3++){if(hrN[k3]){avgHV+=hrV[k3]/hrN[k3];cnt++}}avgHV=cnt?avgHV/cnt:1;
    cards.session=card('session','\ud83d\udd52 Session Clock <span class="tag">'+(live.join(' + ')||'off-hours')+'</span>',
      row('live now',live.join(' + ')||'between sessions')
      +(nexts[0]?row('next: '+nexts[0].n,Math.floor(nexts[0].m/60)+'h '+('0'+nexts[0].m%60).slice(-2)+'m'):'')
      +(nexts[1]?row('then: '+nexts[1].n,Math.floor(nexts[1].m/60)+'h '+('0'+nexts[1].m%60).slice(-2)+'m'):'')
      +row('this hour\u2019s typical vol',avgHV?((curHV/avgHV*100).toFixed(0)+'% of avg hour'):'\u2014'),
      'hour-of-day volatility measured from your loaded history (UTC).');

    /* S6 Cross-market */
    var xm=document.getElementById('ihXm');var xmT=xm?xm.textContent:'',xmTip=xm?(xm.title||''):'';
    cards.xmkt=card('xmkt','\ud83c\udf10 Cross-Market <span class="tag">DRIVERS</span>',
      row('read',(xmT||'\u2014').replace(/^X-MKT\s*/,''))
      +'<div class="ck-note" style="margin-top:4px">'+ (xmTip?xmTip.slice(0,220):'') +'</div>',
      (typeof MODE!=='undefined'&&MODE==='online')?'live cross-market module feeding gate 6 of the checklist':'offline \u2014 detail resumes when online');

    /* S7 News countdown */
    var ni=(window._newsItems||[]).filter(function(e){return e&&e.t&&e.t>Date.now()}).sort(function(a,b){return a.t-b.t}).slice(0,3);
    cards.news=card('news','\ud83d\udcf0 Next Events <span class="tag">'+ni.length+'</span>',
      ni.length?ni.map(function(e){var m=Math.max(0,Math.round((e.t-Date.now())/60000));return row((e.title||e.event||'event').slice(0,34),Math.floor(m/60)+'h'+('0'+m%60).slice(-2)+'m')}).join(''):'<span class="ck-note">no upcoming items \u2014 load a feed in News & Calendar (honest empty, never fake)</span>','');

    /* S8 Funding (crypto) */
    var isCrypto=/BTC|ETH|SOL|USD$|USDT/.test(x.sym)&&!/EUR|GBP|JPY|XAU/.test(x.sym);
    if(isCrypto){var fr=window._fundRate;
      var OF=window._oflow||{};var oiD=(OF.oi&&OF.oiPrev)?(OF.oi.v-OF.oiPrev.v)/OF.oiPrev.v*100:null;
      var pxUp=DATA.length>2?DATA[DATA.length-1].c>DATA[DATA.length-3].c:null;
      var divg=(oiD!=null&&pxUp!=null)?((pxUp&&oiD<-0.5)?'\u26a0 price up + OI down \u2014 short-covering rally, weak hands':(!pxUp&&oiD>0.5)?'\u26a0 price down + OI up \u2014 new shorts pressing':null):null;
      cards.funding=card('funding','\ud83d\udcb8 Funding & Positioning <span class="tag" title="E2: funding + open interest + global long/short accounts from Binance futures free endpoints. Divergence flags when price and OI disagree.">PERPS</span>',
        row('funding (8h)',(fr!=null?fr.toFixed(4)+'%'+judge('funding',fr):'\u2014 (needs online)'),fr>0?'var(--bull)':fr<0?'var(--bear)':null)
        +row('open interest',OF.oi?OF.oi.v.toLocaleString(undefined,{maximumFractionDigits:0})+(oiD!=null?' ('+(oiD>=0?'+':'')+oiD.toFixed(1)+'%)':''):'\u2014')
        +row('long/short accts',OF.ls!=null?OF.ls.toFixed(2)+(OF.ls>1.4?' \u00b7 retail long-heavy':OF.ls<0.7?' \u00b7 retail short-heavy':''):'\u2014')
        +row('read',fr==null?'\u2014':fr>0.01?'longs pay \u2014 crowded long':fr<-0.01?'shorts pay \u2014 crowded short':'balanced'),
        divg||'OI + L/S from Binance futures \u00b7 honest \u2014 blank until fetched');}

    /* E1: Order Flow (live microstructure, honest offline) */
    (function(){var O=window._oflow||{};var isCr=/BTC|ETH|SOL|BNB|XRP|DOGE|ADA/.test(x.sym);
      if(!isCr)return;
      var sp=O.spread,cvd=O.cvd||[];
      var cvdD=cvd.length>5?cvd[cvd.length-1].v-cvd[0].v:null;
      var spark2='';if(cvd.length>3){var W3=250,H3=26;var mn3=Infinity,mx3=-Infinity;cvd.forEach(function(pt){mn3=Math.min(mn3,pt.v);mx3=Math.max(mx3,pt.v)});var sp3=(mx3-mn3)||1;
        spark2='<svg width="100%" viewBox="0 0 '+W3+' '+H3+'" preserveAspectRatio="none" style="display:block;margin:3px 0"><polyline points="'+cvd.map(function(pt,i3){return (i3/(cvd.length-1)*W3).toFixed(1)+','+((1-(pt.v-mn3)/sp3)*H3).toFixed(1)}).join(' ')+'" fill="none" stroke="'+(cvdD>=0?'var(--bull)':'var(--bear)')+'" stroke-width="1.4"/></svg>';}
      var tape=(O.tape||[]).slice(0,5).map(function(t2){return '<span style="color:'+(t2.sell?'var(--bear)':'var(--bull)')+'">'+(t2.sell?'\u25bc':'\u25b2')+'$'+(t2.q>=1000?(t2.q/1000).toFixed(0)+'k':t2.q.toFixed(0))+'</span>'}).join(' ');
      cards.oflow=card('oflow','\u{1F30A} Order Flow <span class="tag" title="E1: live microstructure browser-direct from the Binance WebSocket \u2014 bid/ask spread, aggressor tape, and CVD (cumulative volume delta: buy-aggressor $ minus sell-aggressor $). Session-local, honest.">LIVE</span>',
        row('spread',sp?fmt(sp.bid)+' / '+fmt(sp.ask)+' ('+(((sp.ask-sp.bid)/sp.ask)*10000).toFixed(1)+' bps)':'\u2014 connecting\u2026')
        +row('CVD (session)',cvdD!=null?((cvdD>=0?'+$':'\u2212$')+Math.abs(cvdD/1000).toFixed(0)+'k '+(cvdD>=0?'buyers pressing':'sellers pressing')):'\u2014 building')
        +spark2
        +(tape?'<div style="font-size:9px;margin-top:2px">'+tape+'</div>':''),
        (typeof MODE!=='undefined'&&MODE==='online')?'aggressor-side $ from aggTrade \u00b7 resets each session \u00b7 evidence, not prediction':'needs Online mode \u2014 honest empty');})();
    /* E4: correlation matrix across loaded symbols */
    (function(){try{var keys=Object.keys(BAR_CACHE||{}).filter(function(k){return k.split('|')[1]===TF&&BAR_CACHE[k].length>40});
      if(keys.length<2)return;keys=keys.slice(0,4);
      var rets={};keys.forEach(function(k){var b=BAR_CACHE[k].slice(-40);var rr=[];for(var i2=1;i2<b.length;i2++)rr.push(b[i2].c/b[i2-1].c-1);rets[k]=rr});
      function corr(a,b){var n2=Math.min(a.length,b.length);if(n2<10)return null;var ma=0,mb=0;for(var i2=0;i2<n2;i2++){ma+=a[i2];mb+=b[i2]}ma/=n2;mb/=n2;
        var num=0,da=0,db2=0;for(var j2=0;j2<n2;j2++){num+=(a[j2]-ma)*(b[j2]-mb);da+=(a[j2]-ma)*(a[j2]-ma);db2+=(b[j2]-mb)*(b[j2]-mb)}
        var den=Math.sqrt(da*db2);return den?num/den:null}
      var hi2=null,body2='';
      for(var i4=0;i4<keys.length;i4++)for(var j4=i4+1;j4<keys.length;j4++){var c4=corr(rets[keys[i4]],rets[keys[j4]]);if(c4==null)continue;
        if(hi2==null||Math.abs(c4)>Math.abs(hi2.c))hi2={a:keys[i4].split('|')[0],b:keys[j4].split('|')[0],c:c4};
        body2+=row(keys[i4].split('|')[0]+' \u00d7 '+keys[j4].split('|')[0],(c4>=0?'+':'')+c4.toFixed(2),Math.abs(c4)>0.8?'var(--bear)':null);}
      if(!body2)return;
      cards.corr=card('corr','\u{1F517} Correlation <span class="tag" title="E4: rolling 40-bar return correlation across the symbols you loaded this session. |r|>0.8 in red \u2014 those positions are one trade wearing two hats.">40-BAR</span>',
        body2,(hi2&&Math.abs(hi2.c)>0.8)?('\u26a0 '+hi2.a+' & '+hi2.b+' move together (r='+hi2.c.toFixed(2)+') \u2014 sizing both = doubling one bet'):'diversification looks real at this window');}catch(e){}})();
    /* SUP2: crowding meter \u2014 how retail is this trade */
    (function(){try{var OF2=window._oflow||{};var parts2=[];var score2=0;
      if(window._fundRate!=null){window._fundHist=window._fundHist||[];var FH=window._fundHist;
        if(!FH.length||FH[FH.length-1].v!==window._fundRate)FH.push({t:Date.now(),v:window._fundRate});if(FH.length>500)FH.shift();
        var pc=FH.filter(function(f2){return Math.abs(f2.v)<=Math.abs(window._fundRate)}).length/FH.length*100;
        var fp=Math.abs(window._fundRate)>0.02?30:Math.abs(window._fundRate)>0.01?18:5;parts2.push(['funding '+window._fundRate.toFixed(3)+'% ('+pc.toFixed(0)+'th pctl of session)',fp]);score2+=fp;}
      if(OF2.ls!=null){var lp=OF2.ls>1.4||OF2.ls<0.7?30:OF2.ls>1.2||OF2.ls<0.85?15:5;parts2.push(['L/S accounts '+OF2.ls.toFixed(2),lp]);score2+=lp;}
      var stp2=Math.pow(10,Math.floor(Math.log10(price))-1);var dR=Math.abs(price/stp2-Math.round(price/stp2));
      var rp=dR<0.05?20:dR<0.15?10:3;parts2.push(['round-number proximity',rp]);score2+=rp;
      if(!parts2.length)return;
      var col2=score2>=55?'var(--unfav)':score2>=30?'var(--neut)':'var(--fav)';
      cards.crowd=card('crowd','\u{1F465} Crowding <span class="tag" title="SUP2: how crowded/retail this trade is \u2014 funding vs its own session history + long/short accounts + round-number magnetism. High crowding = the fuel MMs hunt. Feeds the Decision Bar.">METER</span>',
        row('crowding','<b style="color:'+col2+'">'+score2+'</b>/80'+(score2>=55?' \u00b7 crowded \u2014 sweep fuel':score2<30?' \u00b7 clean':''))
        +parts2.map(function(p3){return row(p3[0],p3[1]+' pts')}).join(''),
        'components shown \u00b7 crowding is context, not a signal \u00b7 AR1 funding-fade lives here as a gate (honest: no funding history exists to back-measure it as a strategy)');
      window._crowdScore=score2;}catch(e){}})();
    /* S9 Smart-money mini */
    var ws=[];try{ws=loadWallets()||[]}catch(e){}
    var ev=(window._lastFeedEvents||[]);var day=Date.now()-86400000;var b24=0,s24=0;ev.forEach(function(e){if(e.t>day){if(e.dir==='BUY')b24++;else s24++}});
    var lastE=ev[0];
    cards.smart=card('smart','\ud83d\udc0b Smart Money <span class="tag">'+ws.length+' tracked</span>',
      row('tracked wallets',ws.length)
      +row('moves 24h',b24+' buys \u00b7 '+s24+' sells',b24>s24?'var(--bull)':s24>b24?'var(--bear)':null)
      +(lastE?row('latest',lastE.dir+' '+(lastE.sym||'')+' \u00b7 '+(lastE.t?Math.round((Date.now()-lastE.t)/60000)+'m ago':'')):'')
      +'<div style="margin-top:6px"><button class="tbtn" onclick="goView(\'smart\')" style="padding:2px 9px;font-size:10px">open desk \u25b7</button></div>',
      ev.length?'from the service event store':'feed empty \u2014 track wallets + run mishel_service for live moves');

    /* S10 Signal accuracy */
    var accB='';try{var acc=IND._acc;if(acc){var rowsA=[];Object.keys(acc).forEach(function(k4){var a=acc[k4];var hr=(a&&typeof a==='object')?(a.acc!=null?a.acc:a.hit):(typeof a==='number'?a:null);var nn=(a&&a.n)||null;if(hr!=null&&isFinite(hr))rowsA.push({k:k4,hr:hr,n:nn})});
      /* v38.0 — n AND A CONFIDENCE INTERVAL, OR IT IS NOT A MEASUREMENT.
         This panel used to print "Bollinger 59%, Supertrend 51%, CMF 50%, Aroon 49%"
         with no sample size and no interval, sorted best-first. Sorting a noisy
         statistic descending and showing the top of it IS selection bias, rendered.
         With n=40, a 59% hit-rate has a 95% interval of roughly 43-73%: it does not
         exclude a coin. Saying "59%" without saying that is not a small omission,
         it is the whole thing. Now: every row carries n and its Wilson interval,
         and anything whose interval straddles 50% is greyed and labelled a coin flip. */
      rowsA.forEach(function(r2){
        if(r2.n && typeof wilson==='function'){
          var w=wilson(Math.round(r2.hr*r2.n), r2.n);
          r2.lo=w.lo; r2.hi=w.hi; r2.sig=(w.lo>0.5||w.hi<0.5);
        } else { r2.sig=false; }
      });
      rowsA.sort(function(a,b){ return (b.sig?1:0)-(a.sig?1:0) || b.hr-a.hr });
      accB=rowsA.slice(0,6).map(function(r2){
        var pct=(r2.hr*100).toFixed(0)+'%';
        if(!r2.n) return row(r2.k, pct+' <span style="color:var(--bear)">\u00b7 n unknown</span>', 'var(--muted2)');
        var ci=' <span style="color:var(--muted2);font-size:9.5px">n='+r2.n
              +' \u00b7 95% '+(r2.lo*100).toFixed(0)+'\u2013'+(r2.hi*100).toFixed(0)+'%</span>';
        if(!r2.sig) return row(r2.k, pct+ci+' <span style="color:var(--muted2)">coin flip</span>', 'var(--muted2)');
        return row(r2.k, pct+ci, r2.hr>=0.5?'var(--bull)':'var(--bear)');
      }).join('');
      if(rowsA.length && !rowsA.some(function(r2){return r2.sig}))
        accB+='<div class="ck-note" style="color:var(--gold)">Not one indicator here beats a coin '
             +'at 95% confidence on this sample. That is the honest read \u2014 not a reason to pick the '
             +'biggest number.</div>';
    }}catch(e){}
    cards.acc=card('acc','\ud83c\udfaf Signal Accuracy <span class="tag" title="Measured directional hit-rate of each signal on THIS symbol & timeframe (last ~260 bars) \u2014 which signals actually work here.">MEASURED</span>',
      accB||'<span class="ck-note">accuracy replay runs after the chart paints \u2014 appears within seconds on \u2265120 bars</span>','');

    /* S11 Confluence sparkline */
    var H=window._confHist;var lastH=H[H.length-1];
    if(!lastH||Date.now()-lastH.t>20000||Math.abs(lastH.s-x.rep.score)>0.001){H.push({t:Date.now(),s:x.rep.score});if(H.length>120)H.shift()}
    var spark='';if(H.length>2){var W2=250,H2=34;var pts=H.map(function(pt,i2){return (i2/(H.length-1)*W2).toFixed(1)+','+((1-(pt.s+1)/2)*H2).toFixed(1)}).join(' ');
      spark='<svg width="100%" viewBox="0 0 '+W2+' '+H2+'" preserveAspectRatio="none" style="display:block;margin:4px 0"><line x1="0" y1="'+(H2/2)+'" x2="'+W2+'" y2="'+(H2/2)+'" stroke="var(--edge)" stroke-dasharray="3,3"/><polyline points="'+pts+'" fill="none" stroke="'+(x.rep.score>=0?'var(--bull)':'var(--bear)')+'" stroke-width="1.6"/></svg>';}
    var slope=H.length>6?(H[H.length-1].s-H[H.length-6].s):0;
    cards.spark=card('spark','\ud83d\udcc8 Confluence Momentum <span class="tag">'+(slope>0.05?'BUILDING \u2191':slope<-0.05?'FADING \u2193':'STABLE')+'</span>',
      spark+row('now',x.rep.label+' '+x.rep.score.toFixed(2))+row('\u0394 last 5 reads',(slope>=0?'+':'')+slope.toFixed(2)),
      'history accumulates while the chart is open (session-local, honest).');

    /* S12 Model verdict */
    var up=0,nn2=0;for(var k5=Math.max(1,DATA.length-100);k5<DATA.length;k5++){nn2++;if(DATA[k5].c>DATA[k5-1].c)up++}
    var ph=nn2?up/nn2:0.5;var z=1.96;var den=1+z*z/nn2;var ctr=(ph+z*z/(2*nn2))/den;var hw=z*Math.sqrt(ph*(1-ph)/nn2+z*z/(4*nn2*nn2))/den;
    cards.model=card('model','\ud83e\udde0 Model Verdict <span class="tag" title="GMM/heuristic regime + the honest base rate: share of up-bars in the last 100 with a Wilson 95% interval. No overclaiming \u2014 this is context, not prediction.">HONEST</span>',
      row('regime',x.reg.regime||'\u2014')
      +row('up-bar base rate (100)',(ph*100).toFixed(0)+'%')
      +row('95% interval',((ctr-hw)*100).toFixed(0)+'\u2013'+((ctr+hw)*100).toFixed(0)+'%')
      +row('consensus',(x.con&&x.con.label)||'\u2014'),
      x.reg.advice||'base rate is context, not a prediction.');

    /* assemble with S13 order + S14 width bar */
    /* v33 R1: three decision-first sections */
    /* v39.9 T8: the SNIPER card + Broker ticket now own the plan and the sizing
   (one plan engine, shown once). The cockpit keeps CONTEXT + EVIDENCE as the
   audit/WHY layer. plan/sizer are dropped from it so the same numbers never
   render twice. */
var SECMAP={decide:[],context:['levels','vol','session','funding','xmkt','corr','news'],evidence:['acc','spark','oflow','smart','model']};
    var SECMETA={decide:{t:'\u26a1 DECIDE',tip:'the trade itself \u2014 now shown in the SNIPER card at the top'},context:{t:'\u{1F9ED} CONTEXT',tip:'the terrain \u2014 levels, regime, session, positioning'},evidence:{t:'\u{1F52C} EVIDENCE',tip:'why the verdict reads this way \u2014 measured, glass-box'}};
    function secDigest(sec){try{
      if(sec==='decide'){var pl2=cards.plan?pl.dir+' \u00b7 1:2 @ '+fmtN(pl.stop,dec):'';return pl2}
      if(sec==='context')return (x.reg.regime||'')+' \u00b7 ATR '+(atr/price*100).toFixed(2)+'%'+(window._fundRate!=null?' \u00b7 fund '+window._fundRate.toFixed(3)+'%':'');
      if(sec==='evidence'){var st3=(window._sigState||{}).stats;return st3&&st3.winPct!=null?('sig '+(st3.winPct*100).toFixed(0)+'% \u00b7 '+st3.resolved+' res'):(x.rep.label||'')}
    }catch(e){}return ''}
    var order=S.order&&S.order.length?S.order:['plan','sizer','oflow','levels','vol','session','smart','spark','acc','model','corr','crowd','xmkt','news','funding'];
    Object.keys(cards).forEach(function(id){if(order.indexOf(id)<0)order.push(id)});
    var host=document.getElementById('cockpit');
    if(!host){host=document.createElement('div');host.id='cockpit';side.appendChild(host);}
    var wNow=+(localStorage.getItem(W_KEY)||344);
    var cmpOn=document.body.classList.contains('compact');
    var bar='<div class="ck-bar">COCKPIT \u00b7 width '+[300,344,420].map(function(w){return '<button class="ckw'+(w===wNow?' on':'')+'" data-w="'+w+'">'+(w===300?'narrow':w===344?'normal':'wide')+'</button>'}).join(' ')+' \u00b7 <button id="ckCompact" class="'+(cmpOn?'on':'')+'" title="V9: compact density everywhere \u2014 tighter paddings, slimmer bars. Persisted.">compact</button><span style="margin-left:auto" title="drag cards to reorder \u00b7 click a header to collapse \u00b7 saved">drag \u00b7 collapse \u00b7 saved</span></div>';
    var closedSec={};try{closedSec=JSON.parse(localStorage.getItem('mishel_cksec')||'{}')}catch(e){}
    var secHtml=['decide','context','evidence'].map(function(sec){
      var body=order.filter(function(id){return SECMAP[sec].indexOf(id)>=0}).map(function(id){return cards[id]||''}).join('');
      if(!body)return '';
      return '<div class="cksec'+(closedSec[sec]?' closed':'')+'" data-sec="'+sec+'"><div class="cksec-h" title="'+SECMETA[sec].tip+'">'+SECMETA[sec].t+'<span class="dig">'+secDigest(sec)+'</span><span class="car">\u25bc</span></div><div class="cksec-b">'+body+'</div></div>'}).join('');
    /* v39.10 Z2: plan + sizer are owned by the SNIPER card and the ORDER TICKET
   now. They were still being BUILT here and fell through to 'loose', rendering
   a duplicate Trade Plan at the bottom of the cockpit. Drop them before the
   loose-render so the same numbers never appear twice. */
delete cards.plan; delete cards.sizer;
var loose=order.filter(function(id){return cards[id]&&SECMAP.decide.indexOf(id)<0&&SECMAP.context.indexOf(id)<0&&SECMAP.evidence.indexOf(id)<0}).map(function(id){return cards[id]}).join('');
    host.innerHTML=bar+secHtml+loose;
    host.querySelectorAll('.cksec-h').forEach(function(h2){h2.onclick=function(){var sc=h2.parentElement;sc.classList.toggle('closed');var cs2={};try{cs2=JSON.parse(localStorage.getItem('mishel_cksec')||'{}')}catch(e){}cs2[sc.dataset.sec]=sc.classList.contains('closed');try{localStorage.setItem('mishel_cksec',JSON.stringify(cs2))}catch(e){}}});
    Object.keys(closed).forEach(function(id){var el=document.getElementById('ck-'+id);if(el&&closed[id])el.classList.add('closed')});
    /* wiring */
    host.querySelectorAll('.ck-h').forEach(function(hh){hh.onclick=function(){var c=hh.parentElement;c.classList.toggle('closed');var S2=st();S2.closed=S2.closed||{};S2.closed[c.dataset.ck]=c.classList.contains('closed');stSave(S2)}});
    host.querySelectorAll('.ckw').forEach(function(b){b.onclick=function(){var w=+b.dataset.w;localStorage.setItem(W_KEY,w);document.documentElement.style.setProperty('--side-w',w+'px');build()}});
    var cb2=document.getElementById('ckCompact');if(cb2)cb2.onclick=function(){var on=!document.body.classList.contains('compact');document.body.classList.toggle('compact',on);localStorage.setItem('mishel_compact',on?'1':'0');try{draw()}catch(e){}build()};
    var a1=document.getElementById('ckAcct'),r1=document.getElementById('ckRisk');
    host.querySelectorAll('.ckchip').forEach(function(cb3){cb3.onclick=function(){var act=cb3.dataset.act;
      if(act==='journal'){var jb2=document.getElementById('jrnBtn');if(jb2)jb2.click()}
      else if(act==='alertlvl'){try{var L3=x.L||{};var lvl=L3.pdh!=null?L3.pdh:price;var op2=lvl>=price?'>=':'<=';ALERTS.push({sym:x.sym,op:op2,px:lvl,note:'level alert (M4)',fired:null});if(typeof saveAlerts==='function')saveAlerts();toast('\u{1F514} alert '+x.sym+' '+op2+' '+fmtN(lvl,dec),'var(--gold)')}catch(e){}}
      else if(act==='ticket'){ /* M11: copy-ready MT5 order ticket */
        /* v35.0 THE GATE: an order ticket is the one artefact that turns a number
           into money. It never gets built from a price we cannot vouch for. */
        if(window.Fresh && Fresh.blocks()){
          try{ toast('\u26d4 Ticket refused \u2014 '+Fresh.why(),'var(--bear)') }catch(_){}
          return;
        }
        /* v37.0 THE SECOND GATE: nor from a book that is already over its limits.
           This does not stop him trading. It stops US making it convenient. */
        var sym5=x.sym.replace('BTC','BTCUSD').replace(/^EUR$/,'EURUSD');
        if(!/USD/.test(sym5))sym5=x.sym+'USD';
        var acct5=+(localStorage.getItem('mishel_ck_acct')||10000),risk5=+(localStorage.getItem('mishel_ck_risk')||1);
        window.govCheck({symbol:sym5,side:(pl.dir||'').toLowerCase().indexOf('long')>=0?'long':'short',
                         risk_R:1.0,risk_pct:risk5}).then(function(gv){
          if(!gv.ok){
            var why=(gv.verdict.reasons||[]).filter(function(r){return r.level==='block'})
                      .map(function(r){return r.msg}).join('\n\n');
            try{ toast('\u26d4 Ticket refused by the Risk Governor','var(--bear)') }catch(_){}
            alert('\u26d4 RISK GOVERNOR \u2014 TICKET REFUSED\n\n'+why
              +'\n\nNothing is stopping you placing this by hand in MT5. This terminal just '
              +'will not hand you the ticket.\n\nOpen \ud83d\udee1 Risk Governor to see the whole book, '
              +'or change the limits if you no longer believe them.');
            return;
          }
          if(gv.verdict && gv.verdict.verdict==='warn'){
            try{ toast('\u26a0 '+(gv.verdict.reasons[0]||{}).msg,'var(--gold)') }catch(_){}
          }
          buildTicket5(x,pl,dec,sym5,acct5,risk5);
        });
        return;
      }
    }});
    var tk=document.getElementById('ckTook');
    if(tk)tk.onclick=function(){try{var L2=window._liveSig;if(!L2)return;jrnAdd(L2);window._liveSig=null;toast('\u{1F4D3} logged \u2014 outcome resolves honestly in the Journal (\u{1F4D3} toolbar button)','var(--gold)');build()}catch(e){}};
    if(a1)a1.onchange=function(){STORE.set('mishel_ck_acct',a1.value);build()};
    if(r1)r1.onchange=function(){STORE.set('mishel_ck_risk',r1.value);build()};
    var dragging=null;
    host.querySelectorAll('.ck').forEach(function(c){
      c.addEventListener('dragstart',function(){dragging=c;c.classList.add('drag')});
      c.addEventListener('dragend',function(){c.classList.remove('drag');dragging=null;
        var S3=st();S3.order=[].map.call(host.querySelectorAll('.ck'),function(e2){return e2.dataset.ck});stSave(S3)});
      c.addEventListener('dragover',function(e3){e3.preventDefault();if(!dragging||dragging===c)return;
        var r3=c.getBoundingClientRect();(e3.clientY<r3.top+r3.height/2)?host.insertBefore(dragging,c):host.insertBefore(dragging,c.nextSibling)});
    });
  }
  try{var w0=+(localStorage.getItem(W_KEY)||0);if(w0)document.documentElement.style.setProperty('--side-w',w0+'px')}catch(e){}
  window.renderCockpit=build;
  setTimeout(build,1800);setInterval(function(){try{build()}catch(e){}},7000);
})();

