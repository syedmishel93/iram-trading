function genData(n, start, seed){
  const r = mulberry32(seed);
  const out=[]; let px=start, vol=start*0.010, drift=0, regime=0, tleft=0;
  let t = Date.now()-n*3600e3;
  for(let i=0;i<n;i++){
    if(tleft<=0){ regime=(r()*3|0)-1; drift=regime*start*0.0005*(0.5+r()); tleft=25+ (r()*55|0); vol=start*(0.006+r()*0.010);}
    tleft--;
    const o=px;
    const shock=(r()-0.5)*vol*2 + drift + (start-o)*0.025;
    let c=Math.max(start*0.88, Math.min(start*1.12, o+shock));
    const hi=Math.max(o,c)+r()*vol*0.9;
    const lo=Math.min(o,c)-r()*vol*0.9;
    const v=(0.6+r()*1.4)*(1+Math.abs(shock)/vol)*1e5;
    out.push({t:t+i*3600e3,o,h:hi,l:lo,c,v});
    px=c;
  }
  return out;
}

/* ---------- indicators (real math) ---------- */
const IND = {
  ema(a,p){const k=2/(p+1);let e=a[0];return a.map((v,i)=>{e=i?v*k+e*(1-k):v;return e})},
  sma(a,p){return a.map((_,i)=>{if(i<p-1)return null;let s=0;for(let j=i-p+1;j<=i;j++)s+=a[j];return s/p})},
  rsi(a,p=14){const r=[];let g=0,l=0;for(let i=1;i<a.length;i++){const d=a[i]-a[i-1];if(i<=p){g+=Math.max(d,0);l+=Math.max(-d,0);r.push(null);if(i===p){g/=p;l/=p;r[0]=null;r.push(100-100/(1+g/(l||1e-9)))}}else{g=(g*(p-1)+Math.max(d,0))/p;l=(l*(p-1)+Math.max(-d,0))/p;r.push(100-100/(1+g/(l||1e-9)))}}r.unshift(null);return r.slice(0,a.length)},
  atr(d,p=14){const tr=d.map((c,i)=>i?Math.max(c.h-c.l,Math.abs(c.h-d[i-1].c),Math.abs(c.l-d[i-1].c)):c.h-c.l);let a=tr.slice(0,p).reduce((x,y)=>x+y,0)/p;const out=d.map((_,i)=>{if(i<p)return null;a=(a*(p-1)+tr[i])/p;return a});return out},
  macd(a){const f=IND.ema(a,12),s=IND.ema(a,26);const m=a.map((_,i)=>f[i]-s[i]);const sig=IND.ema(m,9);const hist=m.map((v,i)=>v-sig[i]);return{m,sig,hist}},
  boll(a,p=20,k=2){const mid=IND.sma(a,p);const up=[],lo=[];for(let i=0;i<a.length;i++){if(i<p-1){up.push(null);lo.push(null);continue}let s=0;for(let j=i-p+1;j<=i;j++)s+=(a[j]-mid[i])**2;const sd=Math.sqrt(s/p);up.push(mid[i]+k*sd);lo.push(mid[i]-k*sd)}return{mid,up,lo}},
  supertrend(d,p=10,m=3){const atr=IND.atr(d,p);const st=[],dir=[];let prevSt=0,prevFub=0,prevFlb=0;for(let i=0;i<d.length;i++){if(atr[i]==null){st.push(null);dir.push(1);prevSt=0;prevFub=0;prevFlb=0;continue}const hl2=(d[i].h+d[i].l)/2,bub=hl2+m*atr[i],blb=hl2-m*atr[i],pc=d[i-1]?d[i-1].c:d[i].c;const fub=(bub<prevFub||pc>prevFub||prevFub===0)?bub:prevFub;const flb=(blb>prevFlb||pc<prevFlb||prevFlb===0)?blb:prevFlb;let cur;if(prevSt===0)cur=flb;else if(prevSt===prevFub)cur=d[i].c<=fub?fub:flb;else cur=d[i].c>=flb?flb:fub;st.push(cur);dir.push(cur===flb?1:-1);prevSt=cur;prevFub=fub;prevFlb=flb}return{st,dir}}
};

/* ---------- swing points + SMC detection (deterministic) ---------- */
function swings(d,look=3){const hi=[],lo=[];for(let i=look;i<d.length-look;i++){let sh=true,sl=true;for(let j=1;j<=look;j++){if(d[i].h<=d[i-j].h||d[i].h<=d[i+j].h)sh=false;if(d[i].l>=d[i-j].l||d[i].l>=d[i+j].l)sl=false}if(sh)hi.push(i);if(sl)lo.push(i)}return{hi,lo}}

function detectFVG(d){const g=[];for(let i=2;i<d.length;i++){if(d[i].l>d[i-2].h){g.push({i,type:'bull',top:d[i].l,bot:d[i-2].h})}else if(d[i].h<d[i-2].l){g.push({i,type:'bear',top:d[i-2].l,bot:d[i].h})}}return g.slice(-10)}

function detectOB(d,sw){const obs=[];sw.lo.slice(-4).forEach(i=>{if(i>0&&d[i].c<d[i].o)obs.push({i,type:'bull',top:Math.max(d[i].o,d[i].c),bot:d[i].l})});sw.hi.slice(-4).forEach(i=>{if(i>0&&d[i].c>d[i].o)obs.push({i,type:'bear',top:d[i].h,bot:Math.min(d[i].o,d[i].c)})});return obs.slice(-5)}

function detectSR(d){const sw=swings(d,4);const levels=[...sw.hi,...sw.lo].map(i=>d[i].c);const clusters=[];levels.forEach(l=>{const c=clusters.find(c=>Math.abs(c.p-l)/l<0.006);if(c){c.p=(c.p*c.n+l)/(c.n+1);c.n++}else clusters.push({p:l,n:1})});return clusters.filter(c=>c.n>=2).sort((a,b)=>b.n-a.n).slice(0,5)}

function detectBOS(d,sw){const ev=[];const H=sw.hi,L=sw.lo;for(let k=1;k<H.length;k++){const a=H[k-1],b=H[k];if(d[b].h>d[a].h){for(let i=a;i<d.length;i++)if(d[i].c>d[a].h){ev.push({i,type:'BOS',dir:'up',price:d[a].h});break}}}for(let k=1;k<L.length;k++){const a=L[k-1],b=L[k];if(d[b].l<d[a].l){for(let i=a;i<d.length;i++)if(d[i].c<d[a].l){ev.push({i,type:'CHoCH',dir:'dn',price:d[a].l});break}}}return ev.slice(-6)}
/* divergence: compare price swings vs RSI at those swings (regular + hidden) */
function detectDivergence(d){const rsi=IND.rsi(d.map(x=>x.c));const sw=swings(d,3);const out=[];
  const H=sw.hi.slice(-5);for(let k=1;k<H.length;k++){const a=H[k-1],b=H[k];if(rsi[a]==null||rsi[b]==null)continue;
    if(d[b].h>d[a].h&&rsi[b]<rsi[a])out.push({type:'Bearish div',dir:'bear',hidden:false,pts:[{i:a,p:d[a].h},{i:b,p:d[b].h}]});
    else if(d[b].h<d[a].h&&rsi[b]>rsi[a])out.push({type:'Hidden bear div',dir:'bear',hidden:true,pts:[{i:a,p:d[a].h},{i:b,p:d[b].h}]});}
  const L=sw.lo.slice(-5);for(let k=1;k<L.length;k++){const a=L[k-1],b=L[k];if(rsi[a]==null||rsi[b]==null)continue;
    if(d[b].l<d[a].l&&rsi[b]>rsi[a])out.push({type:'Bullish div',dir:'bull',hidden:false,pts:[{i:a,p:d[a].l},{i:b,p:d[b].l}]});
    else if(d[b].l>d[a].l&&rsi[b]<rsi[a])out.push({type:'Hidden bull div',dir:'bull',hidden:true,pts:[{i:a,p:d[a].l},{i:b,p:d[b].l}]});}
  return out.slice(-4);}
/* inducement (SMC): a minor swing that traps liquidity before the real move (labelled IDM) */
function detectInducements(d,sw){const out=[];const L=sw.lo.slice(-6),H=sw.hi.slice(-6);
  for(let k=2;k<L.length;k++){const p2=L[k-2],p1=L[k-1],c=L[k];if(d[c].l>d[p1].l&&d[p2].l<d[p1].l)out.push({type:'IDM',dir:'bull',i:p1,p:d[p1].l})}
  for(let k=2;k<H.length;k++){const p2=H[k-2],p1=H[k-1],c=H[k];if(d[c].h<d[p1].h&&d[p2].h>d[p1].h)out.push({type:'IDM',dir:'bear',i:p1,p:d[p1].h})}
  return out.slice(-3);}

/* ---------- glass-box confluence (mirrors ddt/xai/confluence.py) ---------- */
const CATW = {trend:1,momentum:1,oscillator:1,volatility:1,smc:1,pattern:1,divergence:1,flux:1,model:1,volume:1};
function buildSignals(d){
  const c=d.map(x=>x.c);
  const e20=IND.ema(c,20),e50=IND.ema(c,50),e200=IND.ema(c,200);
  const rsi=IND.rsi(c);const macd=IND.macd(c);const bb=IND.boll(c);const st=IND.supertrend(d);
  const sw=swings(d);const fvg=detectFVG(d);const bos=detectBOS(d,sw);
  const n=c.length-1;const last=c[n];const S=[];
  const dir=v=>v>=2?'STRONG_BULL':v===1?'BULL':v===0?'NEUTRAL':v===-1?'BEAR':'STRONG_BEAR';
  const push=(source,category,dv,strength,reason,weight=1,value=null)=>S.push({source,category,dv,strength,reason,weight,value,dirLabel:dir(dv)});

  // trend
  push('Price vs EMA200','trend',last>e200[n]?1:-1,0.8,last>e200[n]?'Trading above the 200 EMA — primary trend is up.':'Below the 200 EMA — primary trend is down.',1.3,last);
  push('EMA 50/200','trend',e50[n]>e200[n]?1:-1,0.7,e50[n]>e200[n]?'Golden-cross alignment: fast EMA above slow.':'Death-cross alignment: fast EMA below slow.',1.1);
  push('Supertrend','trend',st.dir[n]===1?2:-2,0.75,st.dir[n]===1?'Supertrend flipped and holding long.':'Supertrend holding short.',1.0);
  // momentum
  const rv=rsi[n]||50;
  push('RSI(14)','momentum',rv>70?-1:rv<30?1:rv>55?1:rv<45?-1:0,Math.min(1,Math.abs(rv-50)/25),rv>70?'Overbought (>70) — momentum stretched, fade risk.':rv<30?'Oversold (<30) — snap-back risk to the upside.':rv>55?'Momentum leans bullish above 55.':rv<45?'Momentum leans bearish below 45.':'Momentum neutral around midline.',1.0,rv);
  push('MACD hist','momentum',macd.hist[n]>0?1:-1,Math.min(1,Math.abs(macd.hist[n])/(last*0.004)),macd.hist[n]>0?'MACD histogram positive — bullish momentum building.':'MACD histogram negative — bearish momentum.',0.9);
  // volatility / mean-reversion
  const pos=(last-bb.lo[n])/((bb.up[n]-bb.lo[n])||1);
  push('Bollinger %B','volatility',pos>0.95?-1:pos<0.05?1:0,Math.abs(pos-0.5)*2,pos>0.95?'Riding the upper band — mean-reversion pullback risk.':pos<0.05?'Pinned to the lower band — bounce risk.':'Mid-band: no volatility extreme.',0.8,pos);
  // smc
  const lastBos=bos[bos.length-1];
  if(lastBos)push('Market structure','smc',lastBos.dir==='up'?2:-2,0.8,lastBos.dir==='up'?'Recent break of structure to the upside (BOS).':'Recent change of character down (CHoCH).',1.2);
  const openBull=fvg.filter(f=>f.type==='bull'&&last>=f.bot&&last<=f.top)[0];
  const openBear=fvg.filter(f=>f.type==='bear'&&last>=f.bot&&last<=f.top)[0];
  if(openBull)push('Fair Value Gap','smc',1,0.7,'Price mitigating a bullish FVG — demand zone.',1.0);
  else if(openBear)push('Fair Value Gap','smc',-1,0.7,'Price inside a bearish FVG — supply zone.',1.0);
  // volume
  const vAvg=d.slice(-20).reduce((s,x)=>s+x.v,0)/20;
  push('Volume','volume',d[n].v>vAvg*1.4?(d[n].c>d[n].o?1:-1):0,Math.min(1,d[n].v/vAvg-1),d[n].v>vAvg*1.4?(d[n].c>d[n].o?'Above-average volume on an up bar — participation confirms.':'Heavy volume on a down bar — sellers active.'):'Volume unremarkable versus its 20-bar average.',0.7);
  // leading oscillators (measure momentum extremes — lead, but still whipsaw)
  const sto=IND.stoch(d),wr=IND.willr(d),cc=IND.cci(d);
  const K=sto.K[n]||50,Dv=sto.D[n]||50;
  push('Stochastic','oscillator',K>80?-1:K<20?1:(K>Dv?1:-1),Math.min(1,Math.abs(K-50)/40),K>80?'%K above 80 — overbought, reversal risk.':K<20?'%K below 20 — oversold, bounce risk.':(K>Dv?'%K crossed above %D — momentum turning up.':'%K below %D — momentum turning down.'),0.7,K);
  const w=wr[n]||-50;
  push('Williams %R','oscillator',w>-20?-1:w<-80?1:0,Math.min(1,Math.abs(w+50)/40),w>-20?'Above −20 — overbought.':w<-80?'Below −80 — oversold.':'Mid-range, no extreme.',0.6,w);
  const cciv=cc[n]||0;
  push('CCI(20)','oscillator',cciv>100?(cciv>200?-1:1):cciv<-100?(cciv<-200?1:-1):0,Math.min(1,Math.abs(cciv)/200),cciv>200?'CCI > 200 — stretched, fade risk.':cciv>100?'CCI > 100 — strong bullish momentum.':cciv<-200?'CCI < −200 — washed out, bounce risk.':cciv<-100?'CCI < −100 — strong bearish momentum.':'CCI neutral.',0.6,cciv);
  // chart pattern
  const pats=detectPatterns(d);const p=pats[pats.length-1];
  if(p&&p.dir!=='neutral')push('Chart pattern','pattern',p.dir==='bull'?2:-2,p.conf,`${p.type} detected — classically ${p.dir==='bull'?'bullish':'bearish'}.`,1.0);
  // divergence
  const divs=detectDivergence(d);const dv=divs[divs.length-1];
  if(dv)push('Divergence','divergence',dv.dir==='bull'?(dv.hidden?1:2):(dv.hidden?-1:-2),dv.hidden?0.6:0.8,`${dv.type} — ${dv.hidden?'trend-continuation':'possible reversal'} signal.`,1.1);
  // inducement (SMC liquidity)
  const idms=detectInducements(d,sw);const idm=idms[idms.length-1];
  if(idm)push('Inducement (IDM)','smc',idm.dir==='bull'?1:-1,0.5,`Minor liquidity pool tagged — smart money may sweep it before the ${idm.dir==='bull'?'up':'down'} move.`,0.8);
  // kinetic flux
  const fx=IND.flux(d);const fv=fx[n]||0;
  push('Kinetic Flux','flux',fv>0?(fv>3?2:1):(fv<-3?-2:-1),Math.min(1,Math.abs(fv)/5),fv>0?'Positive flux — price rising with volume behind it.':'Negative flux — momentum and volume leaning down.',0.9,fv);
  // learned deep-learning model (if uploaded)
  if(typeof MODEL!=='undefined'&&MODEL&&MODEL.type==='mlp'){const mo=modelBias(d);if(mo!=null){const dv=mo>0.5?2:mo>0.15?1:mo<-0.5?-2:mo<-0.15?-1:0;push('Learned model','model',dv,Math.min(1,Math.abs(mo)),`Trained network output ${mo.toFixed(2)} — ${mo>0?'bullish':'bearish'} forecast.`,1.3,mo)}}
  return {S,ind:{e20,e50,e200,rsi,macd,bb,st,sw,fvg,bos,sto,pats}};
}

const DVAL={STRONG_BULL:2,BULL:1,NEUTRAL:0,BEAR:-1,STRONG_BEAR:-2};
function confluence(S){
  /* v24.2: sanitize — any signal with a non-finite dv/strength/weight is neutralized so score is never NaN */
  S=(S||[]).map(s=>{const dv=Number.isFinite(+s.dv)?+s.dv:0;const strength=Number.isFinite(+s.strength)?+s.strength:0;
    const weight=Number.isFinite(+s.weight)?+s.weight:1;return Object.assign({},s,{dv,strength,weight})});
  let raw=0,maxp=0;const byCat={};
  S.forEach(s=>{const w=s.weight*(CATW[s.category]??1);let contrib=s.dv*s.strength*w;if(!Number.isFinite(contrib))contrib=0;s._c=contrib;s._w=w;raw+=contrib;maxp+=2*Math.abs(w);byCat[s.category]=(byCat[s.category]||0)+contrib});
  let score=raw/(maxp||1);if(!Number.isFinite(score))score=0;score=Math.max(-1,Math.min(1,score));
  const label=score>=0.45?'Strong Buy':score>=0.15?'Buy':score>-0.15?'Neutral':score>-0.45?'Sell':'Strong Sell';
  const sign=score>0?1:score<0?-1:0;
  const agree=S.filter(s=>Math.sign(s.dv)===sign&&sign!==0);
  const conflict=S.filter(s=>Math.sign(s.dv)===-sign&&sign!==0);
  const tot=S.reduce((a,s)=>a+Math.abs(s._c),0)||1;
  let conf=Math.abs(raw)/tot;if(!Number.isFinite(conf))conf=0;
  return {score,label,byCat,agree,conflict,conf,S};
}

