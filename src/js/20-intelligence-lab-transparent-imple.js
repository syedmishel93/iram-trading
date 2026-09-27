const AI_PROMPT=`You are a trading-strategy generator for the "Mishel Intelligence Trading" terminal. Output ONLY a Python file that defines a dict named STRATEGY, nothing else.

Schema:
- "name": string, "style": one of scalp|intraday|swing|mm|custom
- "long" / "short": list of conditions; each condition is [indicator, operator, value]; all conditions AND together
- "exitLong" / "exitShort": same format (optional; stop/target always apply)
- "stop": {"type":"atr","mult":N} or {"type":"pct","value":N}
- "tp": {"type":"rr","value":N} or {"type":"pct","value":N} (optional)
Operators: ">", "<", "crossabove", "crossbelow"
Indicators available: close open high low ema9 ema20 ema21 ema50 ema200 rsi macd macds macdh stochk stochd cci willr adx roc mfi flux vwap bbu bbl bbm stdir atr div
("flux" = a momentum×volume oscillator around 0; "div" = +1 bullish / -1 bearish RSI divergence; "stdir" = supertrend direction +1/-1)

Now write a STRATEGY for: <describe your idea here — e.g. "a trend-following breakout for swing trading gold">`;
function parsePyStrategy(text){let t=text.replace(/#[^\n]*/g,'');const m=t.match(/STRATEGY\s*=\s*\{/);if(!m)throw new Error('No "STRATEGY = { ... }" dict found in the file');let i=t.indexOf('{',m.index),depth=0,end=-1;for(let j=i;j<t.length;j++){if(t[j]==='{')depth++;else if(t[j]==='}'){depth--;if(depth===0){end=j;break}}}if(end<0)throw new Error('Unbalanced braces in STRATEGY');let body=t.slice(i,end+1);body=body.replace(/'/g,'"').replace(/\bTrue\b/g,'true').replace(/\bFalse\b/g,'false').replace(/\bNone\b/g,'null').replace(/,(\s*[}\]])/g,'$1');return JSON.parse(body);}
const STRAT_GUIDE=`<b style="color:var(--txt)">How a strategy works.</b> The engine walks the data bar by bar. When every <b class="up">long</b> condition is true it opens a long; it closes on any <b>exitLong</b> condition, the stop, or the target. Same for shorts.<br><br>
<b style="color:var(--txt)">A condition</b> is three parts: <span class="mono">[indicator, operator, value]</span>. Example: <span class="mono">["rsi","crossabove","30"]</span> = "RSI crosses above 30". The value can be a number or another indicator (e.g. <span class="mono">["close",">","ema200"]</span>). All conditions in a list must be true together (AND).<br><br>
<b style="color:var(--txt)">Operators:</b> <span class="mono">&gt; &nbsp; &lt; &nbsp; crossabove &nbsp; crossbelow</span><br>
<b style="color:var(--txt)">Indicators:</b> <span class="mono">close open high low · ema9/20/21/50/200 · rsi macd macds macdh · stochk stochd · cci willr · adx roc mfi · flux (momentum×volume) · vwap · bbu bbl bbm (Bollinger) · stdir (supertrend ±1) · div (divergence ±1) · atr</span><br>
<b style="color:var(--txt)">Stop:</b> <span class="mono">{"type":"atr","mult":2}</span> or <span class="mono">{"type":"pct","value":1.5}</span>. <b style="color:var(--txt)">Target:</b> <span class="mono">{"type":"rr","value":2}</span> (2× the risk) or <span class="mono">{"type":"pct","value":3}</span>.<br><br>
<b style="color:var(--gold)">Fastest path:</b> click "Copy AI prompt", paste it into any chatbot, describe your idea, and upload the file it gives you. Or download an example and edit it. Or just build one visually in the tester's "Tweak" panel and hit "Save as my strategy".`;
function validateSpec(o){if(!o||typeof o!=='object')throw new Error('not an object');if(!Array.isArray(o.long)&&!Array.isArray(o.short))throw new Error('needs a "long" or "short" rule array');if(!o.stop)o.stop={type:'pct',value:1.5};if(!o.name)o.name='Uploaded strategy';return o}
function addUserStrat(spec){validateSpec(spec);const style=['scalp','intraday','swing','mm','custom'].includes(spec.style)?spec.style:'custom';USER_STRATS[spec.name]={spec,style,tf:spec.timeframe||'any',hold:spec.hold||'per rules'};if(style==='custom'&&!STRATS.custom.find(x=>x[0]===spec.name))STRATS.custom.push([spec.name,spec.timeframe||'any',spec.hold||'per rules']);renderUserStrats();}
function renderUserStrats(){const box=document.getElementById('userStratList');if(!box)return;const keys=Object.keys(USER_STRATS);box.innerHTML=keys.length?`<table class="log"><thead><tr><th>Name</th><th>Style</th><th>Rules</th><th></th></tr></thead><tbody>${keys.map(k=>{const u=USER_STRATS[k];return `<tr><td><b>${k}</b></td><td>${u.style}</td><td class="mono" style="font-size:10px;color:var(--muted)">${(u.spec.long||[]).length} long · ${(u.spec.short||[]).length} short</td><td><button class="tbtn" data-rms="${k}" style="padding:2px 8px">remove</button></td></tr>`}).join('')}</tbody></table>`:'<div style="color:var(--muted);font-size:12px">No uploaded strategies yet. Upload a JSON rules file — it appears in the tester automatically.</div>';box.querySelectorAll('[data-rms]').forEach(b=>b.onclick=()=>{const k=b.dataset.rms;const st=USER_STRATS[k].style;delete USER_STRATS[k];STRATS.custom=STRATS.custom.filter(x=>x[0]!==k);renderUserStrats();if(CURSTYLE===st)populateStrats(st)})}

/* ---------- forex / stocks live data (Twelve Data — works in-browser with a free key) ---------- */
let API_KEY='',FX_PROVIDER='twelvedata';
let PROXY_URL='',PROXY_PROVIDER='yfinance';   /* forex/stocks proxy upstream */
let CRYPTO_PROVIDER='binance',CRYPTO_UPSTREAM='yfinance';   /* crypto: binance(direct) | proxy */
let ALERTS=[],_alertSeq=1,_alertPollT=null;    /* rule-based alert engine */
function tdSym(sym){const m={EURUSD:'EUR/USD',GBPUSD:'GBP/USD',USDJPY:'USD/JPY',AUDUSD:'AUD/USD',USDCHF:'USD/CHF',USDCAD:'USD/CAD',NZDUSD:'NZD/USD',EURJPY:'EUR/JPY',GBPJPY:'GBP/JPY',EURGBP:'EUR/GBP',AUDJPY:'AUD/JPY',EURAUD:'EUR/AUD',XAUUSD:'XAU/USD',XAGUSD:'XAG/USD',BTCUSD:'BTC/USD',ETHUSD:'ETH/USD'};return m[sym]||sym}
function tdInterval(tf){return {'1m':'1min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','4h':'4h','1d':'1day','1w':'1week','1M':'1month'}[tf]||'1h'}
async function fetchForex(sym,tf){
  if(!API_KEY)throw new Error('no API key set');
  const url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSym(sym))}&interval=${tdInterval(tf)}&outputsize=360&apikey=${API_KEY}`;
  const ctrl=new AbortController();const to=setTimeout(()=>ctrl.abort(),8000);
  const res=await fetch(url,{signal:ctrl.signal});clearTimeout(to);const j=await res.json();
  if(j.status==='error')throw new Error(j.message||'provider error');
  if(!j.values)throw new Error('no data');
  return j.values.map(v=>({t:Date.parse(v.datetime),o:+v.open,h:+v.high,l:+v.low,c:+v.close,v:+(v.volume||0)})).reverse();
}
/* real-time quote (Twelve Data /price) — REAL last price, never fabricated */
async function fetchForexQuote(sym){
  if(!API_KEY)throw new Error('no API key set');
  const url=`https://api.twelvedata.com/price?symbol=${encodeURIComponent(tdSym(sym))}&apikey=${API_KEY}`;
  const ctrl=new AbortController();const to=setTimeout(()=>ctrl.abort(),8000);
  let res;try{res=await fetch(url,{signal:ctrl.signal})}finally{clearTimeout(to)}
  const j=await res.json();
  if(j&&(j.status==='error'||j.code))throw new Error(j.message||('provider error '+(j.code||'')));
  const p=+((j&&j.price));if(!Number.isFinite(p))throw new Error('no price');
  return p;
}

/* ---------- local data proxy (ddt_data_server.py) — unlocks yfinance / Polygon / Alpaca / Alpha Vantage ---------- */
function proxyBase(){return (PROXY_URL||'').replace(/\/+$/,'')}
async function fetchProxy(sym,tf,limit=360,provider){
  const base=proxyBase();if(!base)throw new Error('no proxy URL set');
  const prov=provider||PROXY_PROVIDER;
  const key=API_KEY?`&key=${encodeURIComponent(API_KEY)}`:'';
  const url=`${base}/ohlc?provider=${prov}&symbol=${encodeURIComponent(sym)}&interval=${tf}&limit=${limit}${key}`;
  const ctrl=new AbortController();const to=setTimeout(()=>ctrl.abort(),12000);
  let res,j;
  try{res=await fetch(url,{signal:ctrl.signal})}finally{clearTimeout(to)}
  j=await res.json();
  if(j.error)throw new Error(j.error);
  if(!j.bars||!j.bars.length)throw new Error('no data');
  return j.bars.map(b=>({t:+b.t,o:+b.o,h:+b.h,l:+b.l,c:+b.c,v:+(b.v||0)}));
}
async function proxyQuote(sym,provider){
  const base=proxyBase();if(!base)throw new Error('no proxy URL set');
  const prov=provider||PROXY_PROVIDER;
  const key=API_KEY?`&key=${encodeURIComponent(API_KEY)}`:'';
  const r=await fetch(`${base}/quote?provider=${prov}&symbol=${encodeURIComponent(sym)}${key}`);
  const j=await r.json();if(j.error)throw new Error(j.error);return +j.price;
}

/* =====================================================================
   INTELLIGENCE LAB — transparent implementations
   ===================================================================== */
function _hist(id,values,color,zeroCenter){const c=document.getElementById(id);if(!c)return;const r=c.parentElement.getBoundingClientRect();const H=parseInt(c.style.height)||140,dpr=devicePixelRatio||1;c.width=r.width*dpr;c.height=H*dpr;const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=r.width;g.clearRect(0,0,W,H);if(!values.length)return;const lo=Math.min(...values),hi=Math.max(...values),bins=28,bk=new Array(bins).fill(0);values.forEach(v=>{let bi=Math.floor((v-lo)/((hi-lo)||1)*bins);bi=Math.max(0,Math.min(bins-1,bi));bk[bi]++});const mx=Math.max(...bk);for(let b=0;b<bins;b++){const bw=W/bins,bh=bk[b]/mx*(H-22);const cx=lo+(b+0.5)/bins*(hi-lo);const col=zeroCenter?(cx>=0?'rgba(45,190,142,.6)':'rgba(240,97,109,.6)'):color;g.fillStyle=col;g.fillRect(b*bw+1,H-14-bh,bw-2,bh)}g.fillStyle='#566072';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText(lo.toFixed(1),2,H-2);g.textAlign='right';g.fillText(hi.toFixed(1),W-2,H-2)}

/* 4 · MC Dropout — uncertainty of the current confluence read */
function mcDropout(signals,M=400,drop=0.3){const scores=[];for(let m=0;m<M;m++){let raw=0,maxp=0;signals.forEach(s=>{if(Math.random()<drop)return;raw+=s.dv*s.strength*s.weight;maxp+=2*s.weight});scores.push(maxp?Math.max(-1,Math.min(1,raw/maxp)):0)}return scores}
function renderDropout(){const S=buildSignals(DATA).S;const sc=mcDropout(S);const mean=_mean(sc),sd=_std(sc),lo=_pct(sc,0.05),hi=_pct(sc,0.95);const robust=sd<0.12?['Robust','up']:sd<0.22?['Moderate','']:['Fragile','dn'];const box=(k,v,c)=>`<div class="stat"><div class="k">${k}</div><div class="v mono ${c||''}">${v}</div></div>`;
  document.getElementById('dropStats').innerHTML=[box('Mean bias',(mean>=0?'+':'')+mean.toFixed(2),mean>=0?'up':'dn'),box('Uncertainty (σ)','±'+sd.toFixed(2),robust[1]),box('90% band',`${lo.toFixed(2)} … ${hi.toFixed(2)}`),box('Read stability',robust[0],robust[1])].join('');
  _hist('dropCanvas',sc,'rgba(76,130,251,.6)',true);}

/* 3 · MCMC adaptive position sizing (Metropolis–Hastings over win-rate) */
function mcmcWinRate(wins,losses,iters=6000){let p=0.5;const lp=x=>(x<=0||x>=1)?-Infinity:wins*Math.log(x)+losses*Math.log(1-x);let cur=lp(p);const s=[];for(let i=0;i<iters;i++){const prop=p+(Math.random()-0.5)*0.12;const l=lp(prop);if(Math.log(Math.random())<l-cur){p=prop;cur=l}s.push(p)}return s.slice(1000)}
function kelly(p,b){return b>0?(p*b-(1-p))/b:0}
function runMCMC(){const trades=(window._trades&&window._trades.length>=5)?window._trades:runStrategy(specFor(document.getElementById('stratSel').value||'EMA 50/200 Cross',CURSTYLE),DATA);
  const wins=trades.filter(t=>t.R>0),losses=trades.filter(t=>t.R<=0);const W=wins.length,L=losses.length;
  if(W+L<3){document.getElementById('mcmcStats').innerHTML='<div class="stat"><div class="k">Need trades</div><div class="v" style="font-size:12px">run a backtest first</div></div>';return}
  const avgW=wins.length?_mean(wins.map(t=>t.R)):1,avgL=losses.length?Math.abs(_mean(losses.map(t=>t.R))):1;const b=avgW/(avgL||1);
  const samples=mcmcWinRate(W,L);const pMean=_mean(samples),pLo=_pct(samples,0.25);
  const fPoint=Math.max(0,kelly(pMean,b)),fCons=Math.max(0,kelly(pLo,b));const rec=Math.min(0.05,fCons*0.5);
  const box=(k,v,c)=>`<div class="stat"><div class="k">${k}</div><div class="v mono ${c||''}">${v}</div></div>`;
  document.getElementById('mcmcStats').innerHTML=[box('Win-rate (post.)',(pMean*100).toFixed(0)+'%',pMean>0.5?'up':''),box('25th pctile',(pLo*100).toFixed(0)+'%'),box('Payoff b',b.toFixed(2),b>1?'up':''),box('Suggested risk',(rec*100).toFixed(2)+'%','up')].join('');
  _hist('mcmcCanvas',samples.map(x=>x*100),'rgba(232,163,61,.6)',false);
  document.getElementById('mcmcStats').insertAdjacentHTML('afterend','');
}

/* 2 · Generative market simulator (regime-switching, vol-clustering, fat tails) */
function genSynth(n,start,volD,seed){const r=mulberry32(seed);const out=[];let px=start,vol=start*volD,drift=0,tleft=0;let t=Date.now()-n*3600e3;for(let i=0;i<n;i++){if(tleft<=0){const reg=(r()*3|0)-1;drift=reg*start*volD*0.15*(0.5+r());tleft=25+(r()*55|0);vol=start*volD*(0.6+r()*1.2)}tleft--;const o=px;const jump=r()<0.03?(r()-0.5)*vol*6:0;const shock=(r()-0.5)*vol*2+drift+jump;const c=Math.max(start*0.3,o+shock);const hi=Math.max(o,c)+r()*vol*0.9,lo=Math.min(o,c)-r()*vol*0.9;out.push({t:t+i*3600e3,o,h:hi,l:lo,c,v:(0.6+r()*1.4)*1e5});px=c}return out}
function runGen(){const c=DATA.map(x=>x.c);const rets=[];for(let i=1;i<c.length;i++)rets.push((c[i]-c[i-1])/c[i-1]);const volD=_std(rets)||0.01;const spec=specFor(document.getElementById('stratSel').value||'EMA 50/200 Cross',CURSTYLE);
  const N=200,outcomes=[],curves=[];for(let p=0;p<N;p++){const path=genSynth(260,CURSYM.px||1000,volD,p*31+7);const tr=runStrategy(spec,path);let eq=1;const curve=[1];tr.forEach(t=>{eq*=1+0.01*t.R;curve.push(eq)});outcomes.push((eq-1)*100);if(p<45)curves.push(curve)}
  outcomes.sort((a,b)=>a-b);const med=outcomes[N/2|0],p5=outcomes[N*0.05|0],p95=outcomes[N*0.95|0],pw=outcomes.filter(v=>v>0).length/N*100;
  const box=(k,v,c)=>`<div class="stat"><div class="k">${k}</div><div class="v mono ${c||''}">${v}</div></div>`;
  document.getElementById('genStats').innerHTML=[box('Median',(med>=0?'+':'')+med.toFixed(1)+'%',med>=0?'up':'dn'),box('5th pctile',p5.toFixed(1)+'%',p5>=0?'up':'dn'),box('95th pctile','+'+p95.toFixed(1)+'%','up'),box('Prob. profit',pw.toFixed(0)+'%',pw>50?'up':'dn')].join('');
  // fan of equity curves
  const cv2=document.getElementById('genCanvas');const r=cv2.parentElement.getBoundingClientRect();const H=150,dpr=devicePixelRatio||1;cv2.width=r.width*dpr;cv2.height=H*dpr;const g=cv2.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=r.width;g.clearRect(0,0,W,H);let lo=1e9,hi=-1e9;curves.forEach(cu=>cu.forEach(v=>{lo=Math.min(lo,v);hi=Math.max(hi,v)}));const y=v=>H-8-((v-lo)/((hi-lo)||1))*(H-16);g.lineWidth=1;curves.forEach(cu=>{g.strokeStyle=cu[cu.length-1]>=1?'rgba(45,190,142,.22)':'rgba(240,97,109,.22)';g.beginPath();cu.forEach((v,i)=>{const x=i/(cu.length-1||1)*W;i?g.lineTo(x,y(v)):g.moveTo(x,y(v))});g.stroke()});g.strokeStyle='rgba(212,218,227,.4)';g.setLineDash([4,3]);g.beginPath();g.moveTo(0,y(1));g.lineTo(W,y(1));g.stroke();g.setLineDash([]);}

/* 1 · MCTS alpha generator */
const MCTS_TREND=[{l:'no trend filter',c:null},{l:'EMA50 > EMA200',c:['ema50','>','ema200']},{l:'EMA50 < EMA200',c:['ema50','<','ema200']},{l:'ADX > 20',c:['adx','>','20']},{l:'Kinetic Flux > 0',c:['flux','>','0']},{l:'Close > VWAP',c:['close','>','vwap']}];
const MCTS_TRIG=[{l:'RSI crosses above 30',c:['rsi','crossabove','30']},{l:'MACD crosses above signal',c:['macd','crossabove','macds']},{l:'Close crosses above EMA20',c:['close','crossabove','ema20']},{l:'Stoch %K crosses above %D',c:['stochk','crossabove','stochd']},{l:'Flux crosses above 0',c:['flux','crossabove','0']},{l:'Close crosses below Boll lower',c:['close','crossbelow','bbl']},{l:'CCI crosses above -100',c:['cci','crossabove','-100']}];
const MCTS_EXIT=[{l:'RSI>65 · ATR×2 · 2R',exitLong:[['rsi','>','65']],stop:{type:'atr',mult:2},tp:{type:'rr',value:2}},{l:'Close<EMA20 · ATR×2 · 3R',exitLong:[['close','<','ema20']],stop:{type:'atr',mult:2},tp:{type:'rr',value:3}},{l:'To Boll mid · 1.5% · 2R',exitLong:[['close','>','bbm']],stop:{type:'pct',value:1.5},tp:{type:'rr',value:2}},{l:'Flux<0 · ATR×3 · 2.5R',exitLong:[['flux','<','0']],stop:{type:'atr',mult:3},tp:{type:'rr',value:2.5}}];
const MCTS_DEPTHS=[MCTS_TREND,MCTS_TRIG,MCTS_EXIT];
function mctsSpec(path){const t=MCTS_TREND[path[0]].c,trg=MCTS_TRIG[path[1]].c,e=MCTS_EXIT[path[2]];const long=[];if(t)long.push(t);long.push(trg);return {name:'MCTS α',long,exitLong:e.exitLong,stop:e.stop,tp:e.tp,note:`Discovered by MCTS: ${MCTS_TREND[path[0]].l} + ${MCTS_TRIG[path[1]].l}, exit ${MCTS_EXIT[path[2]].l}.`}}
function mctsReward(spec){const tr=runStrategy(spec,DATA);if(tr.length<3)return 0.12;let eq=1;tr.forEach(t=>eq*=1+0.01*t.R);const ret=(eq-1)*100;return 1/(1+Math.exp(-ret/12))}
function runMCTS(){const iters=150;const root={a:null,depth:0,visits:0,value:0,children:[],untried:[...MCTS_DEPTHS[0].keys()],parent:null};const all=[];
  for(let it=0;it<iters;it++){let node=root;const path=[];
    while(node.untried.length===0&&node.children.length){let bi=0,best=-1e9;node.children.forEach((ch,i)=>{const u=ch.value/ch.visits+1.4*Math.sqrt(Math.log(node.visits+1)/ch.visits);if(u>best){best=u;bi=i}});node=node.children[bi];path.push(node.a)}
    if(node.untried.length&&node.depth<MCTS_DEPTHS.length){const a=node.untried.splice((Math.random()*node.untried.length)|0,1)[0];const nd=node.depth+1;const child={a,depth:nd,visits:0,value:0,children:[],untried:nd<MCTS_DEPTHS.length?[...MCTS_DEPTHS[nd].keys()]:[],parent:node};node.children.push(child);node=child;path.push(a)}
    const full=[...path];while(full.length<3)full.push((Math.random()*MCTS_DEPTHS[full.length].length)|0);
    const spec=mctsSpec(full);const rew=mctsReward(spec);all.push({full,rew,spec});
    let nn=node;while(nn){nn.visits++;nn.value+=rew;nn=nn.parent}}
  all.sort((a,b)=>b.rew-a.rew);const seen=new Set(),top=[];for(const rr of all){const k=rr.full.join(',');if(!seen.has(k)){seen.add(k);top.push(rr);if(top.length>=5)break}}
  document.getElementById('mctsInfo').innerHTML=`${iters} simulations · ${seen.size} unique setups explored · best score ${(top[0].rew).toFixed(3)}`;
  document.getElementById('mctsOut').innerHTML=`<table class="log"><thead><tr><th>Rank</th><th>Discovered strategy (rules)</th><th>Net return*</th><th></th></tr></thead><tbody>${top.map((r,i)=>{let eq=1;const tr=runStrategy(r.spec,DATA);tr.forEach(t=>eq*=1+0.01*t.R);const ret=(eq-1)*100;return `<tr><td>${i+1}</td><td style="font-size:11px">${ruleText(r.spec.long)} <span style="color:var(--muted2)">→ exit</span> ${ruleText(r.spec.exitLong)}</td><td class="mono ${ret>=0?'up':'dn'}">${ret>=0?'+':''}${ret.toFixed(1)}%</td><td><button class="tbtn" data-mcts="${r.full.join(',')}" style="padding:2px 8px">save</button></td></tr>`}).join('')}</tbody></table><div style="font-size:10px;color:var(--muted);margin-top:8px">*net return of that rule set on the currently loaded data (long-only search). Save one to the ★ Custom list and refine it in the editor. Real build searches long+short and across timeframes.</div>`;
  document.querySelectorAll('[data-mcts]').forEach(b=>b.onclick=()=>{const path=b.dataset.mcts.split(',').map(Number);const spec=mctsSpec(path);spec.name='MCTS α '+Date.now().toString().slice(-4);spec.style='custom';addUserStrat(spec);toast('★ Saved '+spec.name,var_bull())});}
