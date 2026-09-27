function addAlert(){
  const sym=document.getElementById('alSym').value,tf=document.getElementById('alTf').value,field=document.getElementById('alField').value,op=document.getElementById('alOp').value,value=document.getElementById('alVal').value.trim(),repeat=document.getElementById('alRepeat').checked;
  const isEvent=AL_EVENTS.includes(field);
  if(!isEvent&&(value===''||!Number.isFinite(+value))){document.getElementById('alHint').innerHTML='<span style="color:var(--bear)">Enter a numeric value.</span>';return}
  ALERTS.unshift({id:_alertSeq++,sym,tf,field,op,value:isEvent?'':+value,repeat,armed:true,fires:0,_was:false,_prev:null,created:Date.now()});
  document.getElementById('alHint').innerHTML='<span style="color:var(--bull)">✓ Armed.</span>';
  renderAlerts();toast('Alert armed: '+sym,var_bull());
}
function toggleAlert(id){const a=ALERTS.find(x=>x.id===id);if(a){a.armed=!a.armed;if(a.armed){a._was=false;a._prev=null}renderAlerts()}}
function delAlert(id){ALERTS=ALERTS.filter(x=>x.id!==id);renderAlerts()}
function fillAlertSyms(){const s=document.getElementById('alSym');if(!s)return;const cur=s.value||CURSYM.sym;s.innerHTML=Object.keys(SPECS).map(k=>`<option ${k===cur?'selected':''}>${k}</option>`).join('')}
function renderAlerts(){
  fillAlertSyms();
  const el=document.getElementById('alCount');if(el)el.textContent=ALERTS.length?`(${ALERTS.filter(a=>a.armed).length} live / ${ALERTS.length} total)`:'';
  const body=ALERTS.length?ALERTS.map(a=>{
    const st=a.armed?'<span class="pill win">armed</span>':'<span class="pill loss">paused</span>';
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--edge)"><div style="flex:1;min-width:0"><div style="font-size:12px"><b>${a.sym}</b> <span style="color:var(--muted)">${alertText(a)}</span></div><div style="font-size:10px;color:var(--muted2)">${a.repeat?'repeats':'once'}${a.fires?' · fired '+a.fires+'×':''}${a.sym!==CURSYM.sym&&a.field!=='price'?' · needs its symbol loaded':''}</div></div>${st}<button class="tbtn" style="padding:3px 8px;font-size:11px" onclick="toggleAlert(${a.id})">${a.armed?'pause':'arm'}</button><button class="tbtn" style="padding:3px 8px;font-size:11px" onclick="delAlert(${a.id})">✕</button></div>`}).join(''):'<div style="color:var(--muted);font-size:12px">No alerts yet. Build one on the left.</div>';
  const ae=document.getElementById('alArmed');if(ae)ae.innerHTML=body;
  const lg=document.getElementById('alLog');if(lg)lg.innerHTML=ALERT_LOG.length?`<table class="log"><thead><tr><th>Time</th><th>Symbol</th><th>Condition</th></tr></thead><tbody>${ALERT_LOG.map(l=>`<tr><td class="mono" style="color:var(--muted)">${new Date(l.t).toLocaleTimeString()}</td><td><b>${l.sym}</b></td><td>${l.desc}${l.val}</td></tr>`).join('')}</tbody></table>`:'<div style="color:var(--muted);font-size:12px">Nothing yet. Armed alerts that fire will appear here.</div>';
}
/* wire the alerts UI (elements exist — script runs after the body) */
{const b=document.getElementById('alAdd');if(b)b.onclick=addAlert;}
{const b=document.getElementById('alNotify');if(b)b.onclick=()=>{const h=document.getElementById('alHint');if(!window.Notification){h.textContent='This browser has no notifications.';return}Notification.requestPermission().then(p=>{h.innerHTML=p==='granted'?'<span style="color:var(--bull)">✓ Notifications on.</span>':'<span style="color:var(--gold)">Notifications '+p+'.</span>'})};}
{const f=document.getElementById('alField');if(f)f.onchange=e=>{const ev=AL_EVENTS.includes(e.target.value);document.getElementById('alOp').disabled=ev;const v=document.getElementById('alVal');v.disabled=ev;v.placeholder=ev?'(not needed)':'e.g. 70000 or 30'}}
setInterval(pollForeignAlerts,15000);
{const ss=document.getElementById('stratSel');if(ss)ss.addEventListener('change',()=>{try{CURSTYLE=styleOf(ss.value);const bt=document.getElementById('btStyle');if(bt)bt.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.style===CURSTYLE));stratHint()}catch(e){}renderStratSignal();});}

/* ===================== MULTI-CHART — independent live mini-charts ===================== */
let MULTI=[],MULTI_LAYOUT=4;
const MULTI_DEFAULTS=[['BTCUSD','1h'],['ETHUSD','1h'],['SOLUSD','1h'],['EURUSD','1h'],['XAUUSD','1h'],['GBPUSD','1h']];
const _miniReq={};
function requestMiniDraw(p){if(_miniReq[p.id])return;_miniReq[p.id]=true;requestAnimationFrame(()=>{_miniReq[p.id]=false;if(document.getElementById('v-multi').classList.contains('on'))miniDraw(p)})}
function multiStopAll(){MULTI.forEach(p=>{if(p.ws){try{p.ws.onclose=null;p.ws.close()}catch(e){}p.ws=null}})}
function miniWS(p){
  const bs=binanceSym(p.sym);if(!bs||typeof WebSocket==='undefined')return;
  const wsb=isFut(p.sym)?'wss://fstream.binance.com/ws':wsBase();let ws;try{ws=new WebSocket(`${wsb}/${bs.toLowerCase()}@kline_${tfInterval(p.tf)}`)}catch(e){return}
  p.ws=ws;
  ws.onmessage=ev=>{try{const m=JSON.parse(ev.data);if(!m.k)return;const k=m.k;const bar={t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v};if(![bar.o,bar.h,bar.l,bar.c].every(Number.isFinite))return;const last=p.data[p.data.length-1];if(last&&last.t===bar.t){last.o=bar.o;last.h=bar.h;last.l=bar.l;last.c=bar.c;last.v=bar.v}else if(!last||bar.t>last.t){p.data.push(bar);if(p.data.length>400)p.data.shift()}else return;if(document.getElementById('v-multi').classList.contains('on'))requestMiniDraw(p)}catch(e){}};
  ws.onclose=()=>{if(p.ws===ws)p.ws=null};
}
async function loadMini(p){
  if(p.ws){try{p.ws.onclose=null;p.ws.close()}catch(e){}p.ws=null}
  const sp=SPECS[p.sym];
  p.data=genData(200,sp?sp.px:1000,(p.sym.charCodeAt(0)+p.tf.length)*11+3);
  miniDraw(p);                                                        // instant paint — never blank
  if(sp&&(sp.cls==='crypto'||sp.cls==='cryptofut')&&binanceSym(p.sym)){
    try{const bars=await fetchKlines(p.sym,tfInterval(p.tf),200);if(bars&&bars.length>20){p.data=bars;miniDraw(p)}}catch(e){}
    miniWS(p);
  }
}
function miniDraw(p){
  const cv=document.getElementById(p.id+'-cv');if(!cv||!p.data.length)return;
  const r=cv.getBoundingClientRect();
  if(r.width<20){requestAnimationFrame(()=>miniDraw(p));return}                 // canvas not laid out yet — retry next frame
  const dpr=devicePixelRatio||1,H=parseInt(cv.style.height)||210,padR=54;
  cv.width=r.width*dpr;cv.height=H*dpr;const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=r.width;
  g.clearRect(0,0,W,H);
  const nbars=H>360?130:H>250?110:90;const vis=p.data.slice(-nbars);let lo=Infinity,hi=-Infinity;vis.forEach(c=>{lo=Math.min(lo,c.l);hi=Math.max(hi,c.h)});const pad=(hi-lo)*0.08||1;lo-=pad;hi+=pad;
  const volH=Math.min(42,H*0.15),priceH2=H-volH;
  const cw=(W-padR)/vis.length,x=i=>i*cw+cw/2,y=v=>(1-(v-lo)/((hi-lo)||1))*(priceH2-14)+4;
  const c=p.data.map(z=>z.c),e20=IND.ema(c,20),e50=IND.ema(c,50),off=p.data.length-vis.length;
  const line=(arr,col)=>{g.strokeStyle=col;g.lineWidth=1;g.beginPath();let m=false;for(let i=0;i<vis.length;i++){const v=arr[off+i];if(v==null){m=false;continue}const px=x(i),py=y(v);if(!m){g.moveTo(px,py);m=true}else g.lineTo(px,py)}g.stroke()};
  line(e20,'#4C82FB');line(e50,'#E8A33D');
  vis.forEach((c,i)=>{const up=c.c>=c.o,col=up?var_bull():var_bear();g.strokeStyle=col;g.fillStyle=col;const cx=x(i);g.beginPath();g.moveTo(cx,y(c.h));g.lineTo(cx,y(c.l));g.stroke();const bt=y(Math.max(c.o,c.c)),bb=y(Math.min(c.o,c.c));g.fillRect(cx-cw*0.34,bt,cw*0.68,Math.max(1,bb-bt))});
  {const vmax=Math.max(...vis.map(c=>c.v||0))||1;vis.forEach((c,i)=>{const vh=(c.v||0)/vmax*(volH-4);g.fillStyle=c.c>=c.o?'rgba(45,190,142,.32)':'rgba(240,97,109,.32)';g.fillRect(x(i)-cw*0.35,H-vh,cw*0.7,vh)})}
  g.fillStyle='#566072';g.font='9px JetBrains Mono';g.textAlign='left';g.textBaseline='middle';for(let gg=0;gg<=3;gg++){const pr=lo+(hi-lo)*gg/3;g.fillText(fmt(pr),W-padR+4,y(pr))}
  const lc=p.data[p.data.length-1],yy=y(lc.c);if(yy>=0&&yy<=H){const col=lc.c>=lc.o?var_bull():var_bear();g.strokeStyle=col;g.setLineDash([2,3]);g.beginPath();g.moveTo(0,yy);g.lineTo(W-padR,yy);g.stroke();g.setLineDash([]);g.fillStyle=col;g.fillRect(W-padR,yy-7,padR,14);g.fillStyle='#0B0E14';g.fillText(fmt(lc.c),W-padR+4,yy)}
  if(p.hover){const hx=p.hover.x,hy=p.hover.y;let bi=Math.round(hx/cw-0.5);bi=Math.max(0,Math.min(vis.length-1,bi));const bar=vis[bi],cx=x(bi);
    g.strokeStyle='rgba(212,218,227,.4)';g.setLineDash([3,3]);g.beginPath();g.moveTo(cx,0);g.lineTo(cx,priceH2);g.moveTo(0,hy);g.lineTo(W-padR,hy);g.stroke();g.setLineDash([]);
    const prAtY=lo+(hi-lo)*(1-(hy-4)/((priceH2-14)||1));if(hy>=0&&hy<=priceH2){g.fillStyle='#2E3846';g.fillRect(W-padR,hy-7,padR,14);g.fillStyle='#D4DAE3';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText(fmt(prAtY),W-padR+4,hy)}
    const dec=bar.c<10?4:bar.c<1000?2:0,ch=((bar.c-bar.o)/bar.o*100);
    g.font='9px JetBrains Mono';const txt=`O ${bar.o.toFixed(dec)} H ${bar.h.toFixed(dec)} L ${bar.l.toFixed(dec)} C ${bar.c.toFixed(dec)} ${ch>=0?'+':''}${ch.toFixed(2)}%`;const tw=g.measureText(txt).width;
    g.fillStyle='rgba(10,13,19,.9)';g.fillRect(4,4,tw+12,16);g.fillStyle=bar.c>=bar.o?var_bull():var_bear();g.textAlign='left';g.fillText(txt,10,15)}
  let rep={label:'—'};try{rep=confluence(buildSignals(p.data).S)}catch(e){}
  const hd=document.getElementById(p.id+'-head');if(hd){const cls=rep.label.includes('Buy')?'var(--bull)':rep.label.includes('Sell')?'var(--bear)':'var(--muted)';const cc=p.data.map(z=>z.c),nn=cc.length-1,ci=nn-24>0?nn-24:0,chg=(cc[nn]-cc[ci])/cc[ci]*100,rsiv=(IND.rsi(cc)[nn]||50);hd.innerHTML=`<span class="mono" style="color:var(--txt)">${fmt(lc.c)}</span> <span class="mono" style="color:${chg>=0?'var(--bull)':'var(--bear)'}">${chg>=0?'+':''}${chg.toFixed(2)}%</span> · <span class="mono" style="color:var(--muted)">RSI ${rsiv.toFixed(0)}</span> · <span style="color:${cls};font-weight:700">${rep.label}</span>`}
}
function renderMulti(){
  const grid=document.getElementById('multiGrid');if(!grid)return;
  multiStopAll();
  const n=MULTI_LAYOUT;grid.style.gridTemplateColumns=n===1?'1fr':n>=6?'1fr 1fr 1fr':'1fr 1fr';
  for(let k=MULTI.length;k<n;k++){const [s,tf]=MULTI_DEFAULTS[k%4];MULTI.push({sym:s,tf,data:[],ws:null,id:'mc'+k})}
  const panels=MULTI.slice(0,n);
  const cvH=n===1?470:n===2?350:n>=6?205:280;
  grid.innerHTML=panels.map((p,i)=>`<div class="panelbox" style="padding:8px"><div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><select data-mi="${i}" class="mc-sym" style="background:var(--panel);border:1px solid var(--edge);border-radius:6px;padding:3px 6px;color:var(--txt);font-family:var(--mono);font-size:11px"></select><select data-mi="${i}" class="mc-tf" style="background:var(--panel);border:1px solid var(--edge);border-radius:6px;padding:3px 6px;color:var(--txt);font-family:var(--mono);font-size:11px">${['1m','5m','15m','1h','4h','1d'].map(t=>`<option ${t===p.tf?'selected':''}>${t}</option>`).join('')}</select><span class="mc-head" id="${p.id}-head" style="font-size:11px;margin-left:auto"></span><button class="tbtn" data-open="${i}" style="padding:2px 8px;font-size:12px" title="Open in main chart">⤢</button></div><canvas id="${p.id}-cv" style="width:100%;height:${cvH}px;display:block"></canvas></div>`).join('');
  panels.forEach((p,i)=>{
    const sy=grid.querySelector(`.mc-sym[data-mi="${i}"]`);sy.innerHTML=Object.keys(SPECS).map(k=>`<option ${k===p.sym?'selected':''}>${k}</option>`).join('');
    sy.onchange=e=>{p.sym=e.target.value;loadMini(p)};
    grid.querySelector(`.mc-tf[data-mi="${i}"]`).onchange=e=>{p.tf=e.target.value;loadMini(p)};
    grid.querySelector(`button[data-open="${i}"]`).onclick=()=>{const cls=SPECS[p.sym].cls;document.getElementById('assetCls').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.cls===cls));populateSymbols(cls);document.getElementById('symSel').value=p.sym;TF=p.tf;document.getElementById('tfBar').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.tf===p.tf));loadSymbol();const cn=document.querySelector('.nav[data-view="chart"]');if(cn)cn.click()};
    {const cvEl=document.getElementById(p.id+'-cv');if(cvEl){cvEl.onmousemove=ev=>{const rc=cvEl.getBoundingClientRect();p.hover={x:ev.clientX-rc.left,y:ev.clientY-rc.top};requestMiniDraw(p)};cvEl.onmouseleave=()=>{p.hover=null;requestMiniDraw(p)}}}
    loadMini(p);
  });
}
{const ml=document.getElementById('multiLayout');if(ml)ml.querySelectorAll('button').forEach(b=>b.onclick=()=>{ml.querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');MULTI_LAYOUT=+b.dataset.lay;renderMulti()});}

/* =====================================================================
   Institutional-tier modules (transparent, retail-scale)
   · Multi-timeframe alignment  · Order flow / microstructure (Citadel-style)
   · Portfolio risk command (Aladdin-style)  · Strategy robustness
   Computed on synthetic data here; the Python build wires real feeds
   (ccxt L2 order book for crypto, yfinance for the rest).
   ===================================================================== */
const _mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const _std=a=>{const m=_mean(a);return Math.sqrt(_mean(a.map(v=>(v-m)**2)))};
const _pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.max(0,Math.min(s.length-1,Math.floor(p*s.length)))]};
function heat(v){ // v in [-1,1] -> red..grey..green cell background
  if(v>=0)return `rgba(45,190,142,${0.10+0.5*Math.min(1,v)})`;
  return `rgba(240,97,109,${0.10+0.5*Math.min(1,-v)})`;
}

/* ---------- Multi-timeframe alignment ---------- */
const TF_ALL=['5m','15m','1H','4H','1D','1W'];
const TF_W={'5m':0.5,'15m':0.7,'1H':1.0,'4H':1.4,'1D':1.8,'1W':2.2};
function renderMTFDash(){
  const base=CURSYM.px||DATA[DATA.length-1].c;
  let net=0,wsum=0;
  const cells=TF_ALL.map((tf,i)=>{
    const dd=genData(320,base,(CURSYM.sym.charCodeAt(0)||66)*17+i*101+5);
    const rep=confluence(buildSignals(dd).S);
    const c=dd.map(x=>x.c),n=c.length-1;
    const rsi=IND.rsi(c).slice(-1)[0]||50;
    const e50=IND.ema(c,50),e200=IND.ema(c,200);
    const trend=e50[n]>e200[n]?'Up':'Down';
    net+=rep.score*TF_W[tf];wsum+=TF_W[tf];
    return {tf,rep,rsi,trend};
  });
  const biasScore=net/wsum;
  const sign=Math.sign(biasScore);
  const agree=cells.filter(c=>Math.sign(c.rep.score)===sign&&sign!==0).length;
  const alignPct=agree/TF_ALL.length*100;
  const label=biasScore>=0.45?'Strong Buy':biasScore>=0.15?'Buy':biasScore>-0.15?'Neutral':biasScore>-0.45?'Sell':'Strong Sell';
  const cls=label.includes('Buy')?'up':label.includes('Sell')?'dn':'';
  const conviction=alignPct>=83?'High conviction — timeframes aligned':alignPct>=50?'Moderate — some disagreement':'Low — timeframes in conflict, stand aside';
  let html=`<div class="grid2" style="margin-bottom:16px">
    <div class="panelbox"><h4>Higher-TF-weighted bias</h4>
      <div class="verdict"><span class="big ${cls}">${label}</span><span class="score mono">weighted ${biasScore.toFixed(2)}</span></div>
      <div class="meter"><div class="needle" style="left:${(biasScore+1)/2*100}%"></div></div>
      <div class="meter-scale"><span>Strong Sell</span><span>Neutral</span><span>Strong Buy</span></div>
      <div class="conf-line" style="margin-top:12px"><b>${agree}/${TF_ALL.length}</b> timeframes agree · alignment <b>${alignPct.toFixed(0)}%</b>. ${conviction}.</div>
    </div>
    <div class="panelbox"><h4>Per-timeframe read</h4>
      <table class="log"><thead><tr><th>TF</th><th>Trend</th><th>Confluence</th><th>Score</th><th>RSI</th><th>Weight</th></tr></thead><tbody>`;
  cells.forEach(c=>{const cc=c.rep.label.includes('Buy')?'up':c.rep.label.includes('Sell')?'dn':'';
    html+=`<tr><td><b>${c.tf}</b></td><td class="${c.trend==='Up'?'up':'dn'}">${c.trend}</td><td class="${cc}">${c.rep.label}</td><td class="mono ${cc}">${c.rep.score>=0?'+':''}${c.rep.score.toFixed(2)}</td><td class="mono">${c.rsi.toFixed(0)}</td><td class="mono" style="color:var(--muted)">${TF_W[c.tf].toFixed(1)}×</td></tr>`});
  html+=`</tbody></table></div></div>
    <div class="panelbox"><h4>Alignment grid</h4>
      <div style="display:grid;grid-template-columns:repeat(${TF_ALL.length},1fr);gap:8px">`;
  cells.forEach(c=>{const cc=c.rep.label.includes('Buy')?'up':c.rep.label.includes('Sell')?'dn':'';
    html+=`<div style="background:${heat(c.rep.score)};border:1px solid var(--edge);border-radius:10px;padding:14px 8px;text-align:center">
      <div class="mono" style="font-size:12px;color:var(--muted);margin-bottom:6px">${c.tf}</div>
      <div class="${cc}" style="font-family:var(--disp);font-weight:600;font-size:13px">${c.rep.label}</div>
      <div class="mono" style="font-size:10px;color:var(--muted);margin-top:4px">${c.rep.score>=0?'+':''}${c.rep.score.toFixed(2)}</div></div>`});
  html+=`</div></div>`;
  document.getElementById('mtfBias').innerHTML=html;
}

/* ---------- Order flow & microstructure ---------- */

/* v39.17: keep the MTF bias panel current while you're looking at it (nav only drew
   it once before). Throttled + visibility-gated so the heavier 6-TF recompute never
   runs when the tab is hidden. The auto-fib table already updates on the draw loop. */
setInterval(function(){ try{ var v=document.getElementById('v-mtf'); if(v&&v.classList.contains('on')&&typeof renderMTFDash==='function') renderMTFDash(); }catch(e){} }, 5000);
