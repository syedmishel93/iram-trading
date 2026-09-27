document.getElementById('replayBtn').onclick=replay;
// strategy style
document.getElementById('btStyle').querySelectorAll('button').forEach(b=>b.onclick=()=>{document.getElementById('btStyle').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');populateStrats(b.dataset.style);runBacktest()});
// offline / online mode
let MODE='offline',liveTimer=null;
function setMode(m){MODE=m;['modeToggle','modeToggle2'].forEach(id=>{const el=document.getElementById(id);if(el)el.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.mode===m))});const dot=document.getElementById('feedDot'),txt=document.getElementById('feedTxt');
  if(m==='online'){dot.classList.remove('off');goOnline(dot,txt)}
  else{dot.classList.add('off');txt.textContent=CURSYM.csv?('CSV · '+CURSYM.sym):'Local — synthetic';stopLive()}}
async function goOnline(dot,txt){
  const ckey=CURSYM.sym+'|'+TF;
  const seed=(bars,label,after)=>{DATA=bars;BAR_CACHE[ckey]=DATA;CURSYM.px=DATA[DATA.length-1].c;VIEW.off=0;recompute();txt.textContent=label;if(after)after();};
  if(BAR_CACHE[ckey]&&BAR_CACHE[ckey].length>10){DATA=BAR_CACHE[ckey].slice();CURSYM.px=DATA[DATA.length-1].c;VIEW.off=0;recompute();txt.textContent='cached — refreshing…'}  // instant paint, then refresh below
  if(CURSYM.cls==='crypto'||CURSYM.cls==='cryptofut'){
    if(CRYPTO_PROVIDER==='proxy'&&proxyBase()){
      txt.textContent=`connecting (crypto proxy · ${CRYPTO_UPSTREAM})…`;
      try{const bars=await fetchProxy(CURSYM.sym,tfInterval(TF),1000,CRYPTO_UPSTREAM);if(bars.length>10){seed(bars,`${CRYPTO_UPSTREAM} (proxy) — live`,()=>startLiveProxy(CRYPTO_UPSTREAM));return}}catch(e){txt.textContent='crypto proxy: '+e.message+' — simulated';startLive();return}
    }
    if(binanceSym(CURSYM.sym)){
      txt.textContent='connecting…';
      try{const bars=await fetchKlines(CURSYM.sym,tfInterval(TF));if(bars.length>10){seed(bars,'Binance — live',startLiveWS);return}}catch(e){}
      txt.textContent='Binance blocked — set crypto provider to Local proxy in Settings';startLive();return;
    }
    txt.textContent='no crypto mapping — simulated';startLive();return;
  }
  if(FX_PROVIDER==='proxy'&&proxyBase()){
    txt.textContent=`connecting (proxy · ${PROXY_PROVIDER})…`;
    try{const bars=await fetchProxy(CURSYM.sym,tfInterval(TF),1000,PROXY_PROVIDER);if(bars.length>10){seed(bars,`${PROXY_PROVIDER} (proxy) — live`,()=>startLiveProxy(PROXY_PROVIDER));return}}catch(e){txt.textContent='proxy: '+e.message+' — simulated';startLive();return}
  }
  if(API_KEY){
    txt.textContent='connecting ('+FX_PROVIDER+')…';
    try{const bars=await fetchForex(CURSYM.sym,TF);if(bars.length>10){seed(bars,FX_PROVIDER+' — live (WS)',startLiveForexWS);return}}catch(e){txt.textContent=FX_PROVIDER+' error: '+e.message+' — no live ticks (add credits or retry)';stopLive();return}
  }
  txt.textContent='no live vendor — add a Twelve Data key or proxy in Settings (Online shows REAL data only)';stopLive();
}
function updateHead(px){const prev=DATA[DATA.length-2].c,chg=(px-prev)/prev*100;const lp=document.getElementById('lastPx');lp.textContent=fmt(px);lp.className=`px mono ${chg>=0?'up':'dn'}`;const ce=document.getElementById('chg');ce.textContent=`${chg>=0?'+':''}${chg.toFixed(2)}%`;ce.className=`chg mono ${chg>=0?'up':'dn'}`;try{const n=document.getElementById('ihName');if(n)n.textContent=CURSYM.name||CURSYM.sym;const ip=document.getElementById('ihPx');if(ip){const ft=fmt(px),di=ft.lastIndexOf('.');
      ip.innerHTML=di>0?ft.slice(0,di)+'<span class="dec">'+ft.slice(di)+'</span>':ft;ip.style.color=chg>=0?'var(--bull)':'var(--bear)';
      const pv=+(ip.dataset.pv||0);if(pv&&px!==pv){ip.classList.remove('tick-up','tick-dn');void ip.offsetWidth;ip.classList.add(px>pv?'tick-up':'tick-dn')}ip.dataset.pv=px;}const ic=document.getElementById('ihChg');if(ic){ic.textContent=(chg>=0?'+':'')+chg.toFixed(2)+'% ('+TF+')';ic.style.color=chg>=0?'var(--bull)':'var(--bear)';ic.style.borderColor=chg>=0?'var(--bull)':'var(--bear)'}const con=IND._consensus;const cc=document.getElementById('ihCon');if(cc&&con){cc.textContent=con.label+' '+(con.score>=0?'+':'')+con.score;const col=con.score>8?'var(--bull)':con.score<-8?'var(--bear)':'var(--muted)';cc.style.color=col;cc.style.borderColor=col}const atr=IND.atr(DATA)[DATA.length-1];const iv=document.getElementById('ihVol');if(iv&&atr)iv.textContent='ATR '+(atr/px*100).toFixed(2)+'%'}catch(e){}}
function startLive(){stopLive();window._realFeed=false;liveTimer=setInterval(()=>{if(!DATA.length)return;const c=DATA[DATA.length-1];const vol=(c.h-c.l)||c.c*0.001;const nc=Math.max(c.c*0.5,c.c+(Math.random()-0.5)*vol*0.5);c.c=nc;c.h=Math.max(c.h,nc);c.l=Math.min(c.l,nc);updateHead(nc);markTo();renderQuick();evalAlerts();if(document.getElementById('v-chart').classList.contains('on'))draw()},REFRESH_MS)}
function startLiveReal(){stopLive();liveTimer=setInterval(async()=>{try{const bs=binanceSym(CURSYM.sym);const kb=(document.getElementById('dsRest')&&document.getElementById('dsRest').value)||'https://data-api.binance.vision/api/v3/klines';const tu=kb.replace(/\/klines.*$/,'/ticker/price');const r=await fetch(`${tu}?symbol=${bs}`);const j=await r.json();const nc=+j.price;if(!Number.isFinite(nc))return;const c=DATA[DATA.length-1];c.c=nc;c.h=Math.max(c.h,nc);c.l=Math.min(c.l,nc);CURSYM.px=nc;
    /* v37.1 HOTFIX — THE INVARIANT: every path that writes CURSYM.px MUST stamp the
       freshness contract. This one never did, so Fresh.state() saw no _realFeed and
       returned 'offline' on a perfectly live Binance feed — which, per the v35 gate,
       silently killed the Decision Bar AND the MT5 ticket for all of crypto. A contract
       that only some feeds honour is not a contract. */
    window._lastTick=Date.now();window._realFeed=true;window._feedBroker=false;
    window._feedSrc=window._feedSrc||'Binance';window._feedDelay=false;
    updateHead(nc);markTo();renderQuick();evalAlerts();if(document.getElementById('v-chart').classList.contains('on'))draw()}catch(e){}},Math.max(1500,REFRESH_MS))}
/* measured bar spacing: median dt of the last 60 bars — the data's ACTUAL granularity,
   which can differ from the UI TF when a provider falls back to coarser bars */
function barSpacingMs(){try{if(!DATA||DATA.length<8)return tfSeconds(TF)*1000;
  const ds=[];for(let i=Math.max(1,DATA.length-60);i<DATA.length;i++)ds.push(DATA[i].t-DATA[i-1].t);
  ds.sort((a,b)=>a-b);return ds[ds.length>>1]||tfSeconds(TF)*1000;}catch(e){return tfSeconds(TF)*1000}}
/* authoritative history heal: the provider's bars REPLACE the overlapping local tail.
   Sorted + monotonic by construction; also purges any locally fabricated phantom bars. */
function mergeBars(fresh){try{if(!fresh||!fresh.length)return;
  fresh=fresh.slice().sort((a,b)=>a.t-b.t);
  if(!DATA.length){DATA=fresh.slice(-2000);}
  else{const f0=fresh[0].t;
    DATA=DATA.filter(b=>b.t<f0).concat(fresh);
    if(DATA.length>2000)DATA=DATA.slice(-2000);}
  VIEW.off=0;BAR_CACHE[CURSYM.sym+'|'+TF]=DATA;
}catch(e){}}
function startLiveProxy(provider){stopLive();window._pxSyncAt=0;   /* heal immediately on first tick */
  liveTimer=setInterval(async()=>{try{
    const prov=provider||PROXY_PROVIDER;
    /* BAR-AUTHORITATIVE FEED: new candles come only from the provider (heal every 60s).
       A delayed feed must never have bars fabricated from wall-clock arithmetic —
       that is what painted phantom v:0 bars into the chart. */
    if(Date.now()-window._pxSyncAt>60000){window._pxSyncAt=Date.now();
      try{const fb=await fetchProxy(CURSYM.sym,tfInterval(TF),60,prov);if(fb&&fb.length>2){mergeBars(fb);recompute()}}catch(e){}}
    const nc=await proxyQuote(CURSYM.sym,prov);
    if(!Number.isFinite(nc))return;
    const c=DATA[DATA.length-1];const now=Date.now();const barMs=tfSeconds(TF)*1000;
    /* nudge the forming bar only while it is plausibly still forming (delay-tolerant window);
       an older last bar means we are between provider updates — wait for the heal, never invent */
    const gateMs=Math.max(barMs,typeof barSpacingMs==='function'?barSpacingMs():barMs);
    if(c&&(now-c.t)<3*gateMs){c.c=nc;c.h=Math.max(c.h,nc);c.l=Math.min(c.l,nc);}
    CURSYM.px=nc;window._lastTick=Date.now();window._realFeed=true;
    /* v36.0: MT5 is not "another provider". It is the venue. Mark it as such. */
    window._feedBroker=(prov==='mt5');
    window._feedSrc=window._feedBroker?'MT5 \u00b7 your broker':(prov+' (proxy)');
    window._feedDelay=(prov==='yfinance');
    /* F3: the REAL spread you are paying, straight from the terminal. This replaces the
       hard-coded 0.0002 guess that every signal's costR has been using for 34 versions —
       and gold's spread at rollover is nothing like EURUSD's at midday. */
    if(window._feedBroker && Date.now()-(window._mt5SpreadAt||0)>15000){
      window._mt5SpreadAt=Date.now();
      fetch(proxyBase()+'/mt5/tick?symbol='+encodeURIComponent(CURSYM.sym))
        .then(function(r){return r.json()})
        .then(function(t){ if(t && t.bid && t.ask){
          window._oflow=window._oflow||{};
          window._oflow.sym=(CURSYM.sym||'').replace(/USD$/,'USDT').toLowerCase();
          window._oflow.spread={bid:t.bid,ask:t.ask};
          window._brokerSpread={sym:CURSYM.sym,bid:t.bid,ask:t.ask,
                                spread:t.spread,pips:t.spread/(t.digits>=4?0.0001:0.01),t:Date.now()};
        }}).catch(function(){});
    }
    updateHead(nc);markTo();recompute();renderQuick();evalAlerts();
    if(document.getElementById('v-chart').classList.contains('on'))draw()
  }catch(e){}},Math.max(3000,REFRESH_MS))}
/* real-time forex/metals ticker — polls Twelve Data quotes. Online mode shows REAL data only:
   on any error the chart is left frozen for the stale watchdog; ticks are never synthesised.
   Poll floor 8s respects Twelve Data free tier (~8 req/min). */
function startLiveForex(){stopLive();
  const iv=Math.max(8000,REFRESH_MS);
  liveTimer=setInterval(async()=>{
    try{
      if(Date.now()-(window._fxSyncAt||0)>600000){window._fxSyncAt=Date.now();  /* heal history: 1 TD credit / 10 min */
        try{const fb=await fetchForex(CURSYM.sym,TF);if(fb&&fb.length>2){mergeBars(fb.slice(-30));recompute()}}catch(e){}}
      const nc=await fetchForexQuote(CURSYM.sym);
      if(!Number.isFinite(nc))return;                          // bad payload -> do not fabricate
      let c=DATA[DATA.length-1];const now=Date.now();const barMs=tfSeconds(TF)*1000;
      if(c&&(now-c.t)>=barMs){                                  // TF period elapsed -> roll a new REAL candle
        const nb={t:c.t+barMs,o:c.c,h:nc,l:nc,c:nc,v:0};
        DATA.push(nb);if(DATA.length>2000)DATA.shift();VIEW.off=0;c=nb;
      }else{c.c=nc;c.h=Math.max(c.h,nc);c.l=Math.min(c.l,nc);}  // update the forming candle
      CURSYM.px=nc;window._lastTick=now;window._realFeed=true;window._feedSrc='Twelve Data';window._feedDelay=false;
      updateHead(nc);markTo();recompute();renderQuick();evalAlerts();
      if(document.getElementById('v-chart').classList.contains('on'))draw();
    }catch(e){/* leave chart frozen; stale watchdog flags it. Never synthesise a tick in Online mode. */}
  },iv);
}
/* v39.19: real-time metals/forex via the Twelve Data WEBSOCKET — sub-second streaming
   instead of 8s REST polls, so XAU/EUR tick smoothly like BTC. History still heals from
   the REST series every 10 min (1 credit). Falls back to the REST poller if the socket
   can't open, and never fabricates a tick. */
function startLiveForexWS(){
  stopLive();
  if(!API_KEY){ startLiveForex(); return; }
  var sym0=CURSYM.sym, tsym=(typeof tdSym==='function'?tdSym(sym0):sym0), fellBack=false, opened=false;
  var ws; try{ ws=new WebSocket('wss://ws.twelvedata.com/v1/quotes/price?apikey='+encodeURIComponent(API_KEY)); }
  catch(e){ startLiveForex(); return; }
  window._fxws=ws;
  var fb=setTimeout(function(){ if(!opened&&!fellBack){ fellBack=true; try{ws.onclose=null;ws.close()}catch(e){} startLiveForex(); } }, 6000);
  ws.onopen=function(){ opened=true; clearTimeout(fb);
    try{ ws.send(JSON.stringify({action:'subscribe',params:{symbols:tsym}})); }catch(e){}
    window._fxHealTimer=setInterval(async function(){ try{ if(CURSYM.sym!==sym0)return; var b=await fetchForex(sym0,TF); if(b&&b.length>2){mergeBars(b.slice(-30));recompute()} }catch(e){} }, 600000);
  };
  ws.onmessage=function(ev){ try{ var m=JSON.parse(ev.data);
    if(!m||m.event!=='price'||m.price==null||CURSYM.sym!==sym0) return;
    var nc=+m.price; if(!Number.isFinite(nc)) return;                      // bad payload -> never fabricate
    var c=DATA[DATA.length-1], now=Date.now(), barMs=tfSeconds(TF)*1000;
    if(c&&(now-c.t)>=barMs){ var nb={t:c.t+barMs,o:c.c,h:nc,l:nc,c:nc,v:0}; DATA.push(nb); if(DATA.length>2000)DATA.shift(); VIEW.off=0; c=nb; }
    else if(c){ c.c=nc; c.h=Math.max(c.h,nc); c.l=Math.min(c.l,nc); }
    CURSYM.px=nc; window._lastTick=now; window._realFeed=true; window._feedSrc='Twelve Data \u00b7 WS'; window._feedDelay=false; window._feedBroker=false;
    updateHead(nc); markTo(); recompute(); renderQuick(); evalAlerts();
    if(document.getElementById('v-chart').classList.contains('on'))draw();
  }catch(e){} };
  ws.onerror=function(){ try{ws.close()}catch(e){} };
  ws.onclose=function(){ clearTimeout(fb); if(window._fxHealTimer){clearInterval(window._fxHealTimer);window._fxHealTimer=null;}
    if(!fellBack&&typeof MODE!=='undefined'&&MODE==='online'&&CURSYM.sym===sym0){ setTimeout(function(){ if(MODE==='online'&&CURSYM.sym===sym0&&(!window._fxws||window._fxws.readyState>1)) startLiveForex(); }, 3000); } };
}
