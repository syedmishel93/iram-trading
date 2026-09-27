function runBacktest(override){
  const name=document.getElementById('stratSel').value;if(!name&&!override)return;
  const spec=override||specFor(name,CURSTYLE);renderRules(spec);
  if(!override)renderEditor(specFor(name,CURSTYLE));
  const raw=runStrategy(spec,DATA);
  const costBps=Math.max(0,+((document.getElementById('btCost')||{}).value)||0);            // round-trip cost (spread+commission+slippage) in basis points
  const splitI=Math.floor(DATA.length*0.7);                                                  // 70% in-sample / 30% out-of-sample
  let eq=10000;const eqCurve=[eq];
  const trades=raw.map((t,k)=>{const risk=Math.abs(t.entry-t.stop)||t.entry*0.01;const costR=(costBps/10000)*t.entry/risk;const netR=t.R-costR;const pl=eq*0.01*netR;eq+=pl;eqCurve.push(eq);return {...t,i:k+1,R:netR,grossR:t.R,pl}});
  const span=DATA.slice(205);const bh0=(span[0]&&span[0].c)||1;const bh=[10000];span.forEach(c=>bh.push(10000*(c.c/bh0)));
  const dec=CURSYM.px<10?4:CURSYM.px<1000?2:0;const N=trades.length;
  const setStats=arr=>document.getElementById('btStats').innerHTML=arr.map(([k,v,g])=>`<div class="stat"><div class="k">${k}</div><div class="v ${g===true?'up':g===false?'dn':''}">${v}</div></div>`).join('');
  if(N===0){
    setStats([['Net return','0%',null],['Win rate','—',null],['Profit factor','—',null],['Max drawdown','0%',null],['Trades','0',null],['Avg R','—',null],['Sharpe~','—',null],['Expectancy','—',null]]);
    document.getElementById('tradeLog').innerHTML='<tr><td colspan="6" style="color:var(--muted);padding:14px">These rules produced no trades on this data. That\'s an honest result — try another symbol, timeframe, or loosen the conditions. The rules above are exactly what ran.</td></tr>';
    lineChart('eqCanvas',[{d:eqCurve,c:'#5A6472',w:1.5},{d:bh,c:'#5A6472',w:1.2,dash:true}]);
    renderRobustness([],eqCurve,{seed:7,splitI,name});try{renderOverfitAudit(spec,DATA,{costBps});}catch(e){}try{renderSeasonality([],DATA);}catch(e){}return;
  }
  const wins=trades.filter(t=>t.R>0).length;const ret=(eq/10000-1)*100;
  let peak=-1e9,mdd=0;eqCurve.forEach(v=>{peak=Math.max(peak,v);mdd=Math.max(mdd,(peak-v)/peak*100)});
  const gains=trades.filter(t=>t.pl>0).reduce((a,t)=>a+t.pl,0),losses=-trades.filter(t=>t.pl<0).reduce((a,t)=>a+t.pl,0);
  const pf=gains/(losses||1);const avgR=trades.reduce((a,t)=>a+t.R,0)/N;const _Rnet=trades.map(t=>t.R);const _sh=sharpeR(_Rnet);const _psr=psr0(_Rnet);
  const osRet=trades.filter(t=>t.entryI>=splitI).reduce((a,t)=>a+t.R,0);
  const isRet=trades.filter(t=>t.entryI<splitI).reduce((a,t)=>a+t.R,0);
  setStats([['Net return',(ret>=0?'+':'')+ret.toFixed(1)+'%',ret>=0],['Win rate',(wins/N*100).toFixed(0)+'%',wins/N>0.5],['Profit factor',pf.toFixed(2),pf>1],['Max drawdown','-'+mdd.toFixed(1)+'%',false],['Trades',String(N),null],['Avg R (net)',avgR.toFixed(2),avgR>0],['Expectancy',(ret/N).toFixed(2)+'%',ret>0],['Sharpe (per-trade R)',isFinite(_sh)?_sh.toFixed(2):'\u2014',_sh>0],['PSR (P true SR>0)',isFinite(_psr)?(_psr*100).toFixed(0)+'%':'\u2014',_psr>0.9],['Round-trip cost',costBps+' bps',null],['In-sample R',(isRet>=0?'+':'')+isRet.toFixed(1),isRet>=0],['Out-of-sample R',(osRet>=0?'+':'')+osRet.toFixed(1),osRet>=0]]);
  document.getElementById('tradeLog').innerHTML=trades.slice(-16).reverse().map(t=>`<tr title="Entry: ${t.entryReason}"><td>${t.i}</td><td class="${t.side>0?'up':'dn'}">${t.side>0?'Long':'Short'}</td><td class="mono">${t.entry.toFixed(dec)}</td><td class="mono">${t.exit.toFixed(dec)}</td><td class="mono ${t.R>=0?'up':'dn'}">${t.R>=0?'+':''}${t.R.toFixed(2)}R</td><td><span class="pill ${t.R>=0?'win':'loss'}">${t.reason}</span></td></tr>`).join('');
  lineChart('eqCanvas',[{d:eqCurve,c:var_bull(),w:2},{d:bh,c:'#5A6472',w:1.2,dash:true}]);
  window._trades=trades;
  try{renderBtExplain({trades:N,pf:pf,sharpe:_sh,psr:_psr,mdd:mdd,oosR:osRet,isR:isRet});}catch(e){}
  renderRobustness(trades,eqCurve,{seed:(name.length*7+N)>>>0,splitI,name});
  try{renderOverfitAudit(spec,DATA,{costBps});}catch(e){}
  try{renderSeasonality(trades,DATA);}catch(e){}
}
function lineChart(id,series){const c=document.getElementById(id);const r=c.parentElement.getBoundingClientRect();const H=parseInt(c.style.height)||220;const dpr=devicePixelRatio||1;c.width=r.width*dpr;c.height=H*dpr;const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=r.width;g.clearRect(0,0,W,H);let lo=Infinity,hi=-Infinity;series.forEach(s=>s.d.forEach(v=>{lo=Math.min(lo,v);hi=Math.max(hi,v)}));const y=v=>H-10-((v-lo)/(hi-lo||1))*(H-20);series.forEach(s=>{g.strokeStyle=s.c;g.lineWidth=s.w;if(s.dash)g.setLineDash([4,4]);g.beginPath();s.d.forEach((v,i)=>{const x=i/(s.d.length-1)*W;i?g.lineTo(x,y(v)):g.moveTo(x,y(v))});g.stroke();g.setLineDash([])})}

function runMC(trades){
  const paths=2000,steps=trades.length;const finals=[],mdds=[];const pct=[[],[],[]];
  const rs=trades.map(t=>t.R);const all=[];
  for(let p=0;p<paths;p++){let eq=10000;const curve=[eq];let peak=eq,mdd=0;for(let s=0;s<steps;s++){const R=rs[(Math.random()*rs.length)|0];eq+=eq*0.01*R;peak=Math.max(peak,eq);mdd=Math.max(mdd,(peak-eq)/peak);curve.push(eq)}finals.push(eq);mdds.push(mdd*100);all.push(curve)}
  // percentile bands
  for(let s=0;s<=steps;s++){const col=all.map(c=>c[s]).sort((a,b)=>a-b);pct[0].push(col[Math.floor(paths*0.05)]);pct[1].push(col[Math.floor(paths*0.5)]);pct[2].push(col[Math.floor(paths*0.95)])}
  finals.sort((a,b)=>a-b);
  const ruin=finals.filter(v=>v<8000).length/paths*100;
  const med=(finals[paths/2|0]/10000-1)*100,p05=(finals[paths*0.05|0]/10000-1)*100,p95=(finals[paths*0.95|0]/10000-1)*100;
  const mddMed=mdds.sort((a,b)=>a-b)[paths/2|0],mdd95=mdds[paths*0.95|0];
  const mcStats=[['Median outcome',(med>=0?'+':'')+med.toFixed(0)+'%',med>=0],['5th pctile',(p05>=0?'+':'')+p05.toFixed(0)+'%',p05>=0],['95th pctile','+'+p95.toFixed(0)+'%',true],['Risk of ruin (-20%)',ruin.toFixed(1)+'%',ruin<10],['Median max DD','-'+mddMed.toFixed(0)+'%',false],['Worst-case DD','-'+mdd95.toFixed(0)+'%',false],['Prob. profit',(finals.filter(v=>v>10000).length/paths*100).toFixed(0)+'%',true],['Paths','2,000',null]];
  document.getElementById('mcStats').innerHTML=mcStats.map(([k,v,g])=>`<div class="stat"><div class="k">${k}</div><div class="v ${g===true?'up':g===false?'dn':''}">${v}</div></div>`).join('');
  lineChart('mcCanvas',[{d:pct[2],c:'rgba(45,190,142,.6)',w:1.4},{d:pct[1],c:var_bull(),w:2.2},{d:pct[0],c:'rgba(240,97,109,.7)',w:1.4}]);
  // hist
  const c=document.getElementById('mcHist');const r=c.parentElement.getBoundingClientRect();const dpr=devicePixelRatio||1;c.width=r.width*dpr;c.height=240*dpr;const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=r.width,H=240;g.clearRect(0,0,W,H);const bins=26,bmax=Math.max(...mdds),bk=new Array(bins).fill(0);mdds.forEach(v=>bk[Math.min(bins-1,Math.floor(v/bmax*bins))]++);const mx=Math.max(...bk);bk.forEach((v,i)=>{const bw=W/bins;const bh=v/mx*(H-24);g.fillStyle=i/bins<0.5?'rgba(45,190,142,.5)':'rgba(240,97,109,.55)';g.fillRect(i*bw+1,H-12-bh,bw-2,bh)});g.fillStyle='#566072';g.font='9px JetBrains Mono';g.fillText('0%',2,H-2);g.fillText('-'+bmax.toFixed(0)+'% max DD',W-90,H-2)}

/* ---------- screener demo ---------- */
function fillScreener(){const syms=['BTC/USDT','ETH/USDT','SOL/USDT','AAPL','NVDA','TSLA','EUR/USD','GBP/JPY','ES 1!','GC 1!'];document.getElementById('screenBody').innerHTML=syms.map((s,i)=>{const dd=genData(300,100+i*40,i*11+3);const rep=confluence(buildSignals(dd).S);const cls=rep.label.includes('Buy')?'up':rep.label.includes('Sell')?'dn':'';const rsi=(IND.rsi(dd.map(x=>x.c)).slice(-1)[0]||50).toFixed(0);const reg=Math.random()>0.5?'Trending':'Mean-rev';const sig=['Fresh bullish FVG','Liquidity sweep','BOS up','RSI oversold','Death cross','Order-block retest'][i%6];return `<tr><td><b>${s}</b></td><td>${['1H','4H','1D'][i%3]}</td><td class="${cls}">${rep.label}</td><td class="mono ${cls}">${rep.score>=0?'+':''}${rep.score.toFixed(2)}</td><td class="mono">${rsi}</td><td>${reg}</td><td style="color:var(--muted)">${sig}</td></tr>`}).sort(()=>0).join('')}

/* ---------- live screener via the data proxy ---------- */
const SCAN_LIST=['BTCUSD','ETHUSD','SOLUSD','EURUSD','GBPUSD','USDJPY','XAUUSD','AAPL','NVDA','TSLA'];
async function screenLive(){
  const info=document.getElementById('scanInfo'),body=document.getElementById('screenBody');
  if(!proxyBase()){info.innerHTML='<span style="color:var(--gold)">Set a proxy URL in Settings → Data sources first (run ddt_data_server.py).</span>';return}
  const tf=TF||'1h';body.innerHTML='';let done=0;
  for(const sym of SCAN_LIST){
    info.textContent=`scanning ${sym}… (${done}/${SCAN_LIST.length})`;
    try{
      const d=await fetchProxy(sym,tf,300);
      if(d.length<40)throw new Error('thin data');
      const rep=confluence(buildSignals(d).S);
      const rsi=(IND.rsi(d.map(x=>x.c)).slice(-1)[0]||50).toFixed(0);
      const adx=IND.adx(d).slice(-1)[0]||20,reg=adx>22?'Trending':'Mean-rev';
      const cls=rep.label.includes('Buy')?'up':rep.label.includes('Sell')?'dn':'';
      body.insertAdjacentHTML('beforeend',`<tr><td><b>${sym}</b></td><td>${tf}</td><td class="${cls}">${rep.label}</td><td class="mono ${cls}">${rep.score>=0?'+':''}${rep.score.toFixed(2)}</td><td class="mono">${rsi}</td><td>${reg}</td><td style="color:var(--muted)">real · ${PROXY_PROVIDER}</td></tr>`);
    }catch(e){
      body.insertAdjacentHTML('beforeend',`<tr><td><b>${sym}</b></td><td>${tf}</td><td style="color:var(--muted2)">—</td><td>—</td><td>—</td><td>—</td><td style="color:var(--bear)">${e.message}</td></tr>`);
    }
    done++;await new Promise(r=>setTimeout(r,900)); /* gentle on free-tier limits */
  }
  info.innerHTML=`<span style="color:var(--bull)">✓ Scanned ${SCAN_LIST.length} symbols via ${PROXY_PROVIDER}.</span>`;
}
{const b=document.getElementById('scanLive');if(b)b.onclick=screenLive;}
{const b=document.getElementById('scanDemo');if(b)b.onclick=()=>{fillScreener();document.getElementById('scanInfo').textContent='Synthetic preview.';};}
try{initMemeRadar()}catch(e){}
try{initOnChain()}catch(e){}
try{initExtras()}catch(e){}

/* ===================== ALERTS ENGINE — glass-box, edge-triggered ===================== */
const AL_FIELDS={price:'Price',rsi:'RSI(14)',ema20:'EMA(20)',ema50:'EMA(50)',ema200:'EMA(200)',macdh:'MACD hist',atr:'ATR(14)',adx:'ADX(14)',flux:'Flux',confluence:'Confluence',conf_buy:'Confluence flips to Buy',conf_sell:'Confluence flips to Sell',bos_up:'Break of structure up',bos_down:'Break of structure down'};
const AL_EVENTS=['conf_buy','conf_sell','bos_up','bos_down'];
const AL_OPS={cross_up:'crosses above',cross_dn:'crosses below','>':'is above','<':'is below'};
let ALERT_LOG=[],_actx=null;

function alertMetrics(d){
  if(!d||d.length<30)return null;
  const c=d.map(x=>x.c),n=d.length-1;
  const rsi=IND.rsi(c),e20=IND.ema(c,20),e50=IND.ema(c,50),e200=IND.ema(c,200),atr=IND.atr(d),macd=IND.macd(c),adx=IND.adx(d),flux=IND.flux(d);
  let rep={score:0,label:'Neutral'};try{rep=confluence(buildSignals(d).S)}catch(e){}
  let bosDir='';try{const b=detectBOS(d,swings(d));if(b&&b.length)bosDir=b[b.length-1].dir}catch(e){}
  const g=a=>(a&&a[n]!=null&&Number.isFinite(a[n]))?a[n]:null;
  return {price:c[n],rsi:g(rsi),ema20:g(e20),ema50:g(e50),ema200:g(e200),macdh:(macd.hist&&Number.isFinite(macd.hist[n]))?macd.hist[n]:null,atr:g(atr),adx:g(adx),flux:g(flux),confluence:rep.score,conf_buy:/Buy/.test(rep.label),conf_sell:/Sell/.test(rep.label),bos_up:bosDir==='up',bos_down:bosDir==='dn',label:rep.label};
}
function alBeep(){try{_actx=_actx||new(window.AudioContext||window.webkitAudioContext)();const o=_actx.createOscillator(),g=_actx.createGain();o.connect(g);g.connect(_actx.destination);o.frequency.value=880;g.gain.value=0.05;o.start();o.stop(_actx.currentTime+0.12)}catch(e){}}
function alertText(a){if(AL_EVENTS.includes(a.field))return AL_FIELDS[a.field]+' on '+a.tf;return `${AL_FIELDS[a.field]} ${AL_OPS[a.op]} ${a.value} on ${a.tf}`}
function fireAlert(a,val){
  const now=Date.now(),desc=alertText(a);
  const vtxt=(val===''||val==null)?'':` @ ${typeof val==='number'?fmt(val):val}`;
  a.fires=(a.fires||0)+1;a.lastFire=now;
  ALERT_LOG.unshift({t:now,sym:a.sym,desc,val:vtxt});memLog('event',a.sym+' '+desc+vtxt);if(ALERT_LOG.length>60)ALERT_LOG.pop();if(typeof updateBell==='function')updateBell();
  toast(` ${a.sym} — ${desc}${vtxt}`,var_bull());
  try{if(window.Notification&&Notification.permission==='granted')new Notification(`Mishel alert — ${a.sym}`,{body:desc+vtxt})}catch(e){}
  try{if(window.sendTG)sendTG('\ud83d\udd14 '+a.sym+' alert \u2014 '+desc+vtxt)}catch(e){}
  alBeep();
  if(!a.repeat)a.armed=false;
  if(document.getElementById('v-alerts').classList.contains('on'))renderAlerts();
}
function evalAlerts(){
  if(!ALERTS.length)return;
  let m=null;try{m=alertMetrics(DATA)}catch(e){}
  if(!m)return;
  ALERTS.forEach(a=>{
    if(!a.armed||a.sym!==CURSYM.sym||(a.tf&&a.tf!==TF))return;
    const isEvent=AL_EVENTS.includes(a.field);
    let met=false;
    if(isEvent){met=!!m[a.field]}
    else{const v=m[a.field],t=+a.value;
      if(v==null||!Number.isFinite(v)||!Number.isFinite(t)){a._prev=v;return}
      if(a.op==='>')met=v>t;else if(a.op==='<')met=v<t;
      else if(a.op==='cross_up')met=a._prev!=null&&a._prev<=t&&v>t;
      else if(a.op==='cross_dn')met=a._prev!=null&&a._prev>=t&&v<t;
      a._prev=v;
    }
    const rising=met&&!a._was;
    if(a.op&&a.op.startsWith('cross')&&!isEvent){if(met)fireAlert(a,m[a.field])}
    else if(rising)fireAlert(a,isEvent?'':m[a.field]);
    a._was=met;
  });
}
async function pollForeignAlerts(){
  if(!proxyBase())return;
  const jobs=ALERTS.filter(a=>a.armed&&a.sym!==CURSYM.sym&&a.field==='price');
  for(const a of jobs){
    try{const px=await proxyQuote(a.sym);if(!Number.isFinite(px)){continue}
      const t=+a.value;let met=false;
      if(a.op==='>')met=px>t;else if(a.op==='<')met=px<t;
      else if(a.op==='cross_up')met=a._prev!=null&&a._prev<=t&&px>t;
      else if(a.op==='cross_dn')met=a._prev!=null&&a._prev>=t&&px<t;
      const rising=met&&!a._was;
      if(a.op.startsWith('cross')){if(met)fireAlert(a,px)}else if(rising)fireAlert(a,px);
      a._was=met;a._prev=px;
    }catch(e){}
  }
}
