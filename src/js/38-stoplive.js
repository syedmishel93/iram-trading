function stopLive(){window._realFeed=false;if(liveTimer){clearInterval(liveTimer);liveTimer=null}if(window._fxHealTimer){clearInterval(window._fxHealTimer);window._fxHealTimer=null}if(window._fxws){try{window._fxws.onclose=null;window._fxws.close()}catch(e){}window._fxws=null}stopWS()}

/* ---------- smooth redraw (throttle to one frame) ---------- */
let _drawReq=false;
function requestDraw(){if(_drawReq)return;_drawReq=true;requestAnimationFrame(()=>{_drawReq=false;if(document.getElementById('v-chart').classList.contains('on'))draw()})}

/* ---------- visible bar count (zoom) ---------- */
function setBars(n){VIEW.count=Math.max(20,Math.min(DATA.length||600,Math.round(n)));const bc=document.getElementById('barsCount');if(bc)bc.textContent=VIEW.count;draw()}

/* ---------- Binance live WebSocket (real-time kline stream — like TradingView) ---------- */
let liveWS=null,_wsReconnect=0,_lastRecalc=0;
function stopWS(){if(liveWS){try{liveWS.onclose=null;liveWS.onmessage=null;liveWS.close()}catch(e){}liveWS=null}}
function wsBase(){const f=document.getElementById('dsWs');const v=f&&f.value&&f.value.trim();return v||'wss://stream.binance.com:9443/ws'}
function applyKline(k){
  const bar={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v};
  if(![bar.o,bar.h,bar.l,bar.c].every(Number.isFinite))return;
  const last=DATA[DATA.length-1];
  let appended=false;
  if(last&&last.t===bar.t){last.o=bar.o;last.h=bar.h;last.l=bar.l;last.c=bar.c;last.v=bar.v}      // update forming candle (authoritative)
  else if(!last||bar.t>last.t){DATA.push(bar);if(DATA.length>2000)DATA.shift();VIEW.off=0;appended=true}  // candle rolled over → new bar
  else return;
  CURSYM.px=bar.c;
  /* v37.1 HOTFIX — same invariant. The websocket is the FASTEST feed in the whole
     terminal and it was the one Fresh could not see. It is a real, live, exchange
     feed: that is exactly what 'LIVE' is supposed to mean. */
  window._lastTick=Date.now();window._realFeed=true;window._feedBroker=false;
  window._feedDelay=false;
  updateHead(bar.c);markTo();renderQuick();
  const now=Date.now();
  if(appended||k.x||now-_lastRecalc>4000){_lastRecalc=now;recompute();evalAlerts()}                  // full refresh on new bar / close / every 4s (keeps indicators in sync)
  else requestDraw();                                                                                 // light redraw while the candle forms
}
function startLiveWS(){
  stopLive();
  const bs=binanceSym(CURSYM.sym);
  if(!bs||typeof WebSocket==='undefined'){startLiveReal();return}
  const url=`${wsBase()}/${bs.toLowerCase()}@kline_${tfInterval(TF)}`;
  let ws;try{ws=new WebSocket(url)}catch(e){startLiveReal();return}
  liveWS=ws;let opened=false;const txt=document.getElementById('feedTxt');
  ws.onopen=()=>{opened=true;_wsReconnect=0;if(txt)txt.textContent='Binance — live (ws)'};
  ws.onmessage=ev=>{try{const m=JSON.parse(ev.data);if(m.k)applyKline(m.k)}catch(e){}};
  ws.onerror=()=>{};
  ws.onclose=()=>{liveWS=null;if(MODE!=='online')return;
    if(!opened){if(txt)txt.textContent='Binance ws blocked — polling';startLiveReal();return}
    if(_wsReconnect<3){_wsReconnect++;setTimeout(()=>{if(MODE==='online')startLiveWS()},1500)}else startLiveReal()};
}
document.querySelectorAll('#modeToggle button, #modeToggle2 button').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
// paper trading
document.getElementById('btnBuy').onclick=()=>paperOpen(1);
document.getElementById('btnSell').onclick=()=>paperOpen(-1);
{const l=document.getElementById('pLev');if(l)l.onchange=e=>{PAPER.leverage=+e.target.value||100;var _q=document.getElementById('pLevQ');if(_q)_q.value=e.target.value;renderPaper()}}
{const a=document.getElementById('pApplyAcct');if(a)a.onclick=()=>{const d=+document.getElementById('pDeposit').value||10000;PAPER.bal=PAPER.start=d;PAPER.pos=[];PAPER.hist=[];PAPER.dayRealized=0;PAPER.lossStreak=0;PAPER.locked=false;PAPER.leverage=+document.getElementById('pLev').value||100;renderPaper();renderQuick();toast('Demo account reset — $'+d.toFixed(0)+' @ 1:'+PAPER.leverage,var_bull())}}
document.getElementById('btnFlat').onclick=closeAll;
document.getElementById('qBuy').onclick=()=>paperOpen(1);
document.getElementById('qSell').onclick=()=>paperOpen(-1);
// hedge inputs
['hCap','hFund','hBasis','hLev','hDrift'].forEach(id=>document.getElementById(id).addEventListener('input',renderHedge));
document.getElementById('hAsset').addEventListener('change',renderHedge);
document.getElementById('hStrat').querySelectorAll('button').forEach(b=>b.onclick=()=>{HEDGE=b.dataset.h;document.getElementById('hStrat').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));renderHedge()});
// intelligence lab
document.getElementById('mctsRun').onclick=()=>{document.getElementById('mctsInfo').textContent='searching…';setTimeout(runMCTS,30)};
document.getElementById('genRun').onclick=()=>{document.getElementById('genStats').innerHTML='<div class="stat"><div class="k">Simulating…</div><div class="v"></div></div>';setTimeout(runGen,30)};
document.getElementById('mcmcRun').onclick=runMCMC;
// data source test
{const _dt=document.getElementById('dsTest');if(_dt)_dt.onclick=async()=>{const r=document.getElementById('dsResult');r.textContent='testing…';const cls=CURSYM.cls;try{
  if(cls==='crypto'){
    if(CRYPTO_PROVIDER==='proxy'){if(!proxyBase()){r.innerHTML='<span style="color:var(--gold)">Set the proxy URL (② section) and run the server first.</span>';return}const b=await fetchProxy(CURSYM.sym,'1h',20,CRYPTO_UPSTREAM);r.innerHTML=`<span style="color:var(--bull)">✓ Crypto proxy (${CRYPTO_UPSTREAM}) — ${b.length} bars for ${CURSYM.sym}, last ${b[b.length-1].c}.</span>`;return}
    const b=await fetchKlines(CURSYM.sym,'1h',10);r.innerHTML=`<span style="color:var(--bull)">✓ Binance live — ${b.length} bars, ${CURSYM.sym} ${b[b.length-1].c}.</span>`;return;
  }
  if(FX_PROVIDER==='proxy'){if(!proxyBase()){r.innerHTML='<span style="color:var(--gold)">Set the proxy URL (② section) and run the server first.</span>';return}const b=await fetchProxy(CURSYM.sym,'1h',20,PROXY_PROVIDER);r.innerHTML=`<span style="color:var(--bull)">✓ Proxy (${PROXY_PROVIDER}) — ${b.length} bars for ${CURSYM.sym}, last ${b[b.length-1].c}.</span>`;return}
  if(!API_KEY){r.innerHTML='<span style="color:var(--gold)">Paste a Twelve Data / Alpha Vantage key (② section), or switch the provider to Local proxy.</span>';return}
  const b=await fetchForex(CURSYM.sym,'1h');r.innerHTML=`<span style="color:var(--bull)">✓ ${FX_PROVIDER} live — ${b.length} bars for ${CURSYM.sym}.</span>`;
}catch(e){r.innerHTML=`<span style="color:var(--bear)">✗ ${e.message}. Check the key/symbol, or use the local proxy for guaranteed feeds.</span>`}};}
{const b=document.getElementById('dsTestCrypto');if(b)b.onclick=async()=>{const r=document.getElementById('dsResCrypto');r.textContent='testing…';const sym=(CURSYM.cls==='crypto')?CURSYM.sym:'BTCUSD';try{
  if(CRYPTO_PROVIDER==='proxy'){if(!proxyBase()){r.innerHTML='<span style="color:var(--gold)">Set the proxy URL in ② and run the server.</span>';return}const bars=await fetchProxy(sym,'1h',20,CRYPTO_UPSTREAM);r.innerHTML=`<span style="color:var(--bull)">✓ Crypto proxy (${CRYPTO_UPSTREAM}) — ${bars.length} bars, ${sym} ${bars[bars.length-1].c}.</span>`;}
  else{const bars=await fetchKlines(sym,'1h',10);r.innerHTML=`<span style="color:var(--bull)">✓ Binance live — ${bars.length} bars, ${sym} ${bars[bars.length-1].c}.</span>`;}
}catch(e){r.innerHTML=`<span style="color:var(--bear)">✗ ${e.message}</span>`}};}
{const b=document.getElementById('dsTestForex');if(b)b.onclick=async()=>{const r=document.getElementById('dsResForex');r.textContent='testing…';const sym=(CURSYM.cls!=='crypto')?CURSYM.sym:'EURUSD';try{
  if(FX_PROVIDER==='proxy'){if(!proxyBase()){r.innerHTML='<span style="color:var(--gold)">Set the proxy URL and run the server.</span>';return}const bars=await fetchProxy(sym,'1h',20,PROXY_PROVIDER);r.innerHTML=`<span style="color:var(--bull)">✓ Proxy (${PROXY_PROVIDER}) — ${bars.length} bars, ${sym} ${bars[bars.length-1].c}.</span>`;}
  else{if(!API_KEY){r.innerHTML='<span style="color:var(--gold)">Paste a key, or set provider to Local proxy.</span>';return}const bars=await fetchForex(sym,'1h');r.innerHTML=`<span style="color:var(--bull)">✓ ${FX_PROVIDER} live — ${bars.length} bars, ${sym}.</span>`;}
}catch(e){const msg=(e&&e.message)||String(e);const proxyish=/failed to fetch|networkerror|load failed|cors|refused|econn|typeerror|fetch/i.test(msg);if(FX_PROVIDER==='proxy'&&proxyish){r.innerHTML='<span style="color:var(--bear)">✗ Local proxy not reachable at '+(proxyBase()||'http://127.0.0.1:8787')+'</span>'+'<div style="font-size:11px;color:var(--muted);margin-top:5px;line-height:1.55">The proxy server isn\'t running (or the URL is wrong). Two fixes:<br>• Start it — run <code>server/ddt_data_server.py</code> (or your <code>start_mishel</code> launcher) — then retry.<br>• No proxy? Switch <b>Provider</b> above to <b>Twelve Data</b> (free key, works right in the browser — no proxy) and paste a read-only market-data key.</div>';}else if(FX_PROVIDER!='proxy'&&proxyish){r.innerHTML='<span style="color:var(--bear)">✗ Couldn\'t reach the data provider</span><div style="font-size:11px;color:var(--muted);margin-top:5px;line-height:1.55">Check the key is a valid read-only market-data key and that the symbol is supported by this provider, then retry.</div>';}else{r.innerHTML='<span style="color:var(--bear)">✗ '+msg+'</span>';}}};}

// chart interaction (pan + drawing)
let drag=null;
/* ---- inertial panning + eased zoom (buttery, TradingView-class feel) ---- */
let _inertiaRAF=null;
function startInertia(vPxMs){ // px/ms at release
  cancelAnimationFrame(_inertiaRAF);
  let v=vPxMs*16;             // px/frame
  let last=performance.now(),acc=0;
  const step=now=>{const dt=Math.min(40,now-last);last=now;v*=Math.pow(0.94,dt/16);           // friction
    const cw=cv._w/VIEW.count;acc+=v*(dt/16)/cw;
    const whole=acc>0?Math.floor(acc):Math.ceil(acc);
    if(whole){acc-=whole;const max=Math.max(0,DATA.length-VIEW.count);const next=Math.max(0,Math.min(max,VIEW.off+whole));if(next===VIEW.off){v=0}else{VIEW.off=next;requestDraw()}}
    if(Math.abs(v)>0.25)_inertiaRAF=requestAnimationFrame(step)};
  if(Math.abs(v)>0.6)_inertiaRAF=requestAnimationFrame(step);
}
let _zoomRAF=null;
function animBars(target){ // eased zoom to a bar count
  target=Math.max(20,Math.min(DATA.length||600,Math.round(target)));
  cancelAnimationFrame(_zoomRAF);
  const from=VIEW.count,t0=performance.now(),dur=160;
  const ease=t=>1-Math.pow(1-t,3);
  const step=now=>{const t=Math.min(1,(now-t0)/dur);VIEW.count=Math.round(from+(target-from)*ease(t));VIEW.off=Math.max(0,Math.min(Math.max(0,DATA.length-VIEW.count),VIEW.off));requestDraw();if(t<1)_zoomRAF=requestAnimationFrame(step)};
  _zoomRAF=requestAnimationFrame(step);
}
function evtXY(e){const r=cv.getBoundingClientRect();let x=e.clientX-r.left,y=e.clientY-r.top;
  /* B2: magnet — snap y to the nearest O/H/L/C of the bar under the cursor while drawing */
  try{if(window.MAGNET&&TOOL!=='cursor'&&window._chartMap){const m=window._chartMap;
    const bi=Math.max(0,Math.min(m.end-m.start-1,Math.floor(x/m.cw)))+m.start;const b=DATA[bi];
    if(b&&y<m.priceH){const cand=[b.o,b.h,b.l,b.c];let best=null,bd=12;
      cand.forEach(pv=>{const py=(1-((m.lg?Math.log(pv):pv)-m.la)/m.ls)*m.priceH;const d2=Math.abs(py-y);if(d2<bd){bd=d2;best=py}});
      if(best!=null)y=best;}}}catch(e2){}
  return {x,y}}
function setTool(t){TOOL=t;const db=document.getElementById('drawbar');if(db)db.querySelectorAll('button[data-tool]').forEach(b=>b.classList.toggle('on',b.dataset.tool===t));cv.style.cursor=t==='cursor'?'default':'crosshair'}
cv.addEventListener('mousedown',e=>{const {x,y}=evtXY(e);if(!RENDER)return;
  {const ph=paneHitAt(x,y);if(ph){closePane(ph.key);return}}
  if(TOOL==='cursor'){const hit=hitDrawing(x,y);if(hit>=0){SELDRAW=hit;draw();return}const wasSel=SELDRAW;SELDRAW=-1;cancelAnimationFrame(_inertiaRAF);drag={x:e.clientX,off:VIEW.off,v:0,lx:null,lt:0};if(wasSel>=0)draw();return}
  const bar=barAt(x),price=priceAt(y);
  if(TOOL==='hline'){snapDrawings();DRAWINGS.push({type:'hline',price});setTool('cursor');draw();return}
  if(TOOL==='vline'){snapDrawings();DRAWINGS.push({type:'vline',bar});setTool('cursor');draw();return}
  if(TOOL==='avwap'){snapDrawings();DRAWINGS.push({type:'avwap',bar:Math.round(bar)});setTool('cursor');draw();return}
  if(TOOL==='text'){const t=prompt('Text label:');if(t){snapDrawings();DRAWINGS.push({type:'text',bar,price,text:t})}setTool('cursor');draw();return}
  drawStart={bar,price};drawPreview={type:TOOL,a:drawStart,b:{bar,price}};if(TOOL==='brush')drawPreview.points=[{bar,price}];});
cv.addEventListener('mousemove',e=>{const {x,y}=evtXY(e);MOUSE={x,y};
  if(drag){const now=performance.now();const dx=e.clientX-drag.x;const cw=cv._w/VIEW.count;const newOff=Math.max(0,Math.min(DATA.length-VIEW.count,drag.off+Math.round(dx/cw)));if(drag.lx!=null&&now>drag.lt){drag.v=0.75*(drag.v||0)+0.25*((e.clientX-drag.lx)/(now-drag.lt))}drag.lx=e.clientX;drag.lt=now;VIEW.off=newOff;requestDraw();return}
  if(drawStart&&RENDER){const bar=barAt(x),price=priceAt(y);if(TOOL==='brush')drawPreview.points.push({bar,price});else drawPreview.b={bar,price};requestDraw();return}
  if(TOOL==='cursor'&&RENDER)cv.style.cursor=paneHitAt(x,y)?'pointer':(hitDrawing(x,y)>=0?'pointer':'default');
  if(window.paintOverlay){try{paintOverlay()}catch(e){requestDraw()}}else{requestDraw()}});
cv.addEventListener('mouseup',()=>{if(drag&&drag.v)startInertia(drag.v);drag=null;if(drawStart&&drawPreview){const p=drawPreview;let keep=true;if(['trend','ray','rect','fib','measure','arrow','long','short'].includes(p.type)&&Math.abs(p.a.bar-p.b.bar)<0.4&&Math.abs(p.a.price-p.b.price)<(RENDER?(RENDER.hi-RENDER.lo)*0.002:1e-6))keep=false;if(p.type==='brush'&&(!p.points||p.points.length<2))keep=false;if(keep){snapDrawings();DRAWINGS.push(p)}drawStart=null;drawPreview=null;if(TOOL!=='brush')setTool('cursor');draw()}});
cv.addEventListener('mouseleave',()=>{MOUSE=null;const ro=document.getElementById('readout');if(ro)ro.innerHTML='';if(!drawStart)draw()});
cv.addEventListener('dblclick',e=>{e.preventDefault();VIEW.off=0;animBars(120)});
