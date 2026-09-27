function renderOrderFlow(){
  const mid=CURSYM.px||DATA[DATA.length-1].c;const tick=mid*0.0004;const levels=16;
  const bids=[],asks=[];let bcum=0,acum=0;const r=mulberry32((CURSYM.sym.charCodeAt(0)||66)*31+7);
  for(let i=0;i<levels;i++){
    let bsz=(r()*0.7+0.3)*(1-i/levels*0.55), asz=(r()*0.7+0.3)*(1-i/levels*0.55);
    if(r()<0.16)bsz*=2.8; if(r()<0.16)asz*=2.8; // liquidity clusters
    bcum+=bsz;acum+=asz;
    bids.push({p:mid-(i+1)*tick,sz:bsz});asks.push({p:mid+(i+1)*tick,sz:asz});
  }
  const mx=Math.max(...bids.map(b=>b.sz),...asks.map(a=>a.sz));
  const imb=(bcum-acum)/(bcum+acum);
  // ladder
  let lad='<div style="font-family:var(--mono);font-size:11px">';
  asks.slice().reverse().forEach(a=>{lad+=`<div style="display:flex;align-items:center;gap:6px;height:19px"><span style="width:64px;text-align:right;color:var(--bear)">${fmt(a.p)}</span><div style="flex:1;display:flex;justify-content:flex-start"><div style="height:13px;width:${a.sz/mx*100}%;background:var(--bear-dim);border-left:2px solid var(--bear)"></div></div><span style="width:38px;color:var(--muted)">${a.sz.toFixed(1)}</span></div>`});
  lad+=`<div style="display:flex;align-items:center;gap:6px;height:26px;margin:3px 0;border-top:1px solid var(--edge2);border-bottom:1px solid var(--edge2)"><span style="width:64px;text-align:right;color:var(--gold);font-weight:600">${fmt(mid)}</span><span style="flex:1;color:var(--muted);font-size:10px">— mid / spread ${(tick).toFixed(mid<10?4:1)} —</span><span style="width:38px"></span></div>`;
  bids.forEach(b=>{lad+=`<div style="display:flex;align-items:center;gap:6px;height:19px"><span style="width:64px;text-align:right;color:var(--bull)">${fmt(b.p)}</span><div style="flex:1;display:flex;justify-content:flex-start"><div style="height:13px;width:${b.sz/mx*100}%;background:var(--bull-dim);border-left:2px solid var(--bull)"></div></div><span style="width:38px;color:var(--muted)">${b.sz.toFixed(1)}</span></div>`});
  lad+='</div>';
  document.getElementById('obLadder').innerHTML=lad;
  // imbalance gauge
  const iCls=imb>0?'up':'dn';
  document.getElementById('imbBox').innerHTML=`<div class="verdict" style="margin:4px 0 8px"><span class="big ${iCls}">${imb>0?'Bid heavy':'Ask heavy'}</span><span class="score mono">${(imb*100).toFixed(1)}%</span></div><div class="meter" style="background:linear-gradient(90deg,var(--bear),#3a3f4a 50%,var(--bull))"><div class="needle" style="left:${(imb+1)/2*100}%"></div></div><div class="meter-scale"><span>Sell pressure</span><span>Balanced</span><span>Buy pressure</span></div><div class="conf-line" style="margin-top:10px">Resting bid liquidity ${bcum.toFixed(1)} vs ask ${acum.toFixed(1)}. ${Math.abs(imb)>0.2?'Skew is significant — book leans '+(imb>0?'to buyers.':'to sellers.'):'Book is roughly balanced.'}</div>`;
  // CVD
  let run=0;const cvd=DATA.map(c=>{run+=(c.c>=c.o?1:-1)*c.v;return run});
  lineChart('cvdCanvas',[{d:cvd,c:cvd[cvd.length-1]>=0?var_bull():var_bear(),w:2}]);
  document.getElementById('cvdNote').innerHTML=`Net delta over window: <b style="color:var(--txt)">${cvd[cvd.length-1]>=0?'+':''}${(cvd[cvd.length-1]/1e6).toFixed(1)}M</b>. ${cvd[cvd.length-1]>=cvd[cvd.length-20]?'Rising — buyers absorbing.':'Falling — sellers in control.'}`;
  // anomalies
  const atr=IND.atr(DATA);const avgV=_mean(DATA.slice(-40).map(c=>c.v));const flags=[];
  DATA.slice(-50).forEach((c,k)=>{const i=DATA.length-50+k;const rng=c.h-c.l;
    if(c.v>avgV*2.2)flags.push({t:c.t,type:'Volume spike',mag:(c.v/avgV).toFixed(1)+'× avg',dir:c.c>=c.o});
    else if(atr[i]&&rng>atr[i]*2.2)flags.push({t:c.t,type:'Volatility burst',mag:(rng/atr[i]).toFixed(1)+'× ATR',dir:c.c>=c.o});});
  const last=flags.slice(-8).reverse();
  document.getElementById('anomBox').innerHTML=last.length?`<table class="log"><thead><tr><th>When</th><th>Type</th><th>Magnitude</th><th>Bar</th></tr></thead><tbody>${last.map(f=>`<tr><td>${new Date(f.t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td><td>${f.type}</td><td class="mono">${f.mag}</td><td class="${f.dir?'up':'dn'}">${f.dir?'up':'down'}</td></tr>`).join('')}</tbody></table>`:'<div style="color:var(--muted);font-size:12px">No unusual volume or volatility in the recent window.</div>';
}

/* ---------- Portfolio risk command (Aladdin-style, transparent) ---------- */
const BOOK=[
  {sym:'BTC/USDT',cls:'Crypto',side:1,notional:24000},
  {sym:'ETH/USDT',cls:'Crypto',side:1,notional:12000},
  {sym:'AAPL',cls:'Equity',side:1,notional:18000},
  {sym:'NVDA',cls:'Equity',side:1,notional:15000},
  {sym:'EUR/USD',cls:'FX',side:-1,notional:20000},
  {sym:'ES 1!',cls:'Index',side:1,notional:29000},
];
/* ---------- portfolio risk over the REAL demo positions (falls back to cached/synthetic returns per symbol) ---------- */
function portfolioRisk(){
  if(!PAPER.pos.length)return null;
  const eq=PAPER.bal+unrealized();
  const legs=PAPER.pos.map(p=>({sym:p.sym,side:p.side,notional:p.qty*p.entry,riskToStop:Math.abs(p.entry-(p.sl!=null?p.sl:p.entry))*p.qty}));
  const gross=legs.reduce((s,l)=>s+Math.abs(l.notional),0)||1;
  const net=legs.reduce((s,l)=>s+l.side*l.notional,0);
  const N=200;
  const retsOf=sym=>{let bars=null;for(const k in BAR_CACHE){if(k.startsWith(sym+'|')&&BAR_CACHE[k].length>N){bars=BAR_CACHE[k];break}}if(!bars)bars=genData(N+1,(SPECS[sym]||{px:100}).px,sym.charCodeAt(0)*13+7);const c=bars.slice(-(N+1)).map(x=>x.c),rr=[];for(let i=1;i<c.length;i++)rr.push((c[i]-c[i-1])/c[i-1]);return rr};
  const rets=legs.map(l=>retsOf(l.sym));const T=Math.min(...rets.map(r=>r.length));
  const w=legs.map(l=>l.side*l.notional/gross);
  const port=[];for(let t=0;t<T;t++){let s=0;for(let i=0;i<legs.length;i++)s+=w[i]*rets[i][rets[i].length-T+t];port.push(s)}
  const srt=[...port].sort((a,b)=>a-b),q=srt[Math.floor(0.05*srt.length)]||0;
  const varUsd=-q*gross,tail=port.filter(v=>v<=q),cvarUsd=tail.length?-(tail.reduce((a,b)=>a+b,0)/tail.length)*gross:varUsd;
  const heat=legs.reduce((s,l)=>s+l.riskToStop,0);
  const pairs=[];for(let i=0;i<legs.length;i++)for(let j=i+1;j<legs.length;j++){const a=rets[i].slice(-T),b=rets[j].slice(-T);const ma=a.reduce((x,y)=>x+y,0)/T,mb=b.reduce((x,y)=>x+y,0)/T;let nu=0,da=0,db=0;for(let k=0;k<T;k++){nu+=(a[k]-ma)*(b[k]-mb);da+=(a[k]-ma)**2;db+=(b[k]-mb)**2}const r=nu/Math.sqrt(da*db||1e-12);pairs.push({a:legs[i].sym,b:legs[j].sym,corr:+r.toFixed(2),same_direction:legs[i].side===legs[j].side})}
  const crowded=pairs.filter(p=>p.corr>0.6&&p.same_direction);
  return {equity:+eq.toFixed(2),positions:legs.length,gross:+gross.toFixed(0),net:+net.toFixed(0),var95_usd:+varUsd.toFixed(0),cvar95_usd:+cvarUsd.toFixed(0),var95_pct_of_equity:+(varUsd/eq*100).toFixed(2),portfolio_heat_usd:+heat.toFixed(0),portfolio_heat_pct:+(heat/eq*100).toFixed(2),correlated_pairs:pairs,crowding_warnings:crowded.map(p=>p.a+'↔'+p.b+' corr '+p.corr),data_note:'returns from cached live bars where available, seeded synthetic otherwise'};
}
function renderRisk(){
  const gross=BOOK.reduce((s,p)=>s+Math.abs(p.notional),0);
  const net=BOOK.reduce((s,p)=>s+p.side*p.notional,0);
  // synth correlated-ish daily returns per asset
  const N=250;const rets=BOOK.map((p,i)=>{const dd=genData(N+1,100,(p.sym.charCodeAt(0))*13+i*29);const c=dd.map(x=>x.c);const rr=[];for(let k=1;k<c.length;k++)rr.push((c[k]-c[k-1])/c[k-1]);return rr;});
  const w=BOOK.map(p=>p.side*p.notional/gross);
  const port=[];for(let t=0;t<N;t++){let s=0;for(let i=0;i<BOOK.length;i++)s+=w[i]*rets[i][t];port.push(s);}
  const vol=_std(port);const dayVaR=-_pct(port,0.05)*gross;const tail=port.filter(v=>v<=_pct(port,0.05));const cvar=-_mean(tail)*gross;
  const hhi=w.reduce((s,x)=>s+x*x,0);const largest=Math.max(...BOOK.map(p=>Math.abs(p.notional)))/gross*100;
  // correlation matrix
  const corr=(a,b)=>{const ma=_mean(a),mb=_mean(b);let n=0,da=0,db=0;for(let i=0;i<a.length;i++){n+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2}return n/Math.sqrt(da*db||1)};
  // risk contribution: w_i * cov(r_i, port)/var(port)
  const varp=vol*vol||1e-9;const rc=BOOK.map((p,i)=>{const cov=corr(rets[i],port)*_std(rets[i])*vol;return w[i]*cov/varp});
  const rcSum=rc.reduce((s,x)=>s+Math.abs(x),0)||1;
  const stats=[
    ['Gross exposure','$'+gross.toLocaleString(),null],
    ['Net exposure',(net>=0?'+$':'-$')+Math.abs(net).toLocaleString(),net>=0],
    ['1-day VaR (95%)','-$'+dayVaR.toFixed(0),false],
    ['CVaR / ES (95%)','-$'+cvar.toFixed(0),false],
    ['Daily volatility','$'+(vol*gross).toFixed(0),null],
    ['Concentration (HHI)',hhi.toFixed(2),hhi<0.3],
    ['Largest position',largest.toFixed(0)+'%',largest<40],
    ['Positions',BOOK.length.toString(),null],
  ];
  document.getElementById('riskStats').innerHTML=stats.map(([k,v,g])=>`<div class="stat"><div class="k">${k}</div><div class="v ${g===true?'up':g===false?'dn':''}">${v}</div></div>`).join('');
  // book table
  document.getElementById('bookTable').innerHTML=`<table class="log"><thead><tr><th>Symbol</th><th>Class</th><th>Side</th><th>Notional</th><th>Risk contrib.</th></tr></thead><tbody>${BOOK.map((p,i)=>{const rcp=Math.abs(rc[i])/rcSum*100;return `<tr><td><b>${p.sym}</b></td><td style="color:var(--muted)">${p.cls}</td><td class="${p.side>0?'up':'dn'}">${p.side>0?'Long':'Short'}</td><td class="mono">$${p.notional.toLocaleString()}</td><td><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:6px;background:var(--panel2);border-radius:4px;overflow:hidden"><div style="height:100%;width:${rcp}%;background:var(--gold)"></div></div><span class="mono" style="width:34px;text-align:right">${rcp.toFixed(0)}%</span></div></td></tr>`}).join('')}</tbody></table><div style="font-size:10.5px;color:var(--muted);margin-top:10px;line-height:1.5">Risk contribution = each position's marginal share of portfolio variance (weight × covariance with the book ÷ book variance). A position can be small in size yet large in risk if it's volatile or correlated.</div>`;
  // correlation heatmap
  let cm='<table class="log" style="text-align:center"><thead><tr><th></th>'+BOOK.map(p=>`<th style="text-align:center">${p.sym.split('/')[0].split(' ')[0]}</th>`).join('')+'</tr></thead><tbody>';
  BOOK.forEach((p,i)=>{cm+=`<tr><td style="text-align:left"><b>${p.sym.split('/')[0].split(' ')[0]}</b></td>`+BOOK.map((q,j)=>{const c=i===j?1:corr(rets[i],rets[j]);return `<td class="mono" style="background:${heat(c)};color:var(--txt)">${c.toFixed(2)}</td>`}).join('')+'</tr>'});
  cm+='</tbody></table><div style="font-size:10.5px;color:var(--muted);margin-top:10px">Green = move together, red = move opposite. High positive correlation across long positions means less diversification than the position count suggests.</div>';
  document.getElementById('corrBox').innerHTML=cm;
  // stress scenarios
  const SC=[
    ['Risk-off crash',{Crypto:-0.30,Equity:-0.12,Index:-0.10,FX:0.03}],
    ['Rates +100bps',{Crypto:-0.08,Equity:-0.05,Index:-0.04,FX:-0.01}],
    ['Crypto flush',{Crypto:-0.40,Equity:-0.03,Index:-0.02,FX:0.01}],
    ['Broad melt-up',{Crypto:0.25,Equity:0.08,Index:0.06,FX:-0.02}],
    ['USD spike',{Crypto:-0.10,Equity:-0.04,Index:-0.03,FX:-0.05}],
  ];
  document.getElementById('stressBox').innerHTML=`<table class="log"><thead><tr><th>Scenario</th><th>Modelled P/L</th><th>% of gross</th><th>Impact</th></tr></thead><tbody>${SC.map(([name,sh])=>{const pl=BOOK.reduce((s,p)=>s+p.side*p.notional*(sh[p.cls]||0),0);const pct=pl/gross*100;return `<tr><td>${name}</td><td class="mono ${pl>=0?'up':'dn'}">${pl>=0?'+$':'-$'}${Math.abs(pl).toFixed(0)}</td><td class="mono ${pl>=0?'up':'dn'}">${pct>=0?'+':''}${pct.toFixed(1)}%</td><td><div style="height:6px;background:var(--panel2);border-radius:4px;overflow:hidden"><div style="height:100%;width:${Math.min(100,Math.abs(pct)*3)}%;background:${pl>=0?'var(--bull)':'var(--bear)'}"></div></div></td></tr>`}).join('')}</tbody></table><div style="font-size:10.5px;color:var(--muted);margin-top:10px">Shocks are applied per asset class to current notionals — a first-order what-if, not a forecast. The real build lets you define custom scenarios and uses each position's beta.</div>`;
}

/* ---------- Strategy robustness (param sweep + walk-forward) ---------- */
/* ---------- Strategy robustness (v14.2: REAL Monte-Carlo resampling + REAL walk-forward) ----------
   No fabricated data: everything below is computed from the actual trade R-series produced by
   runStrategy on the loaded bars. Thin-data cases refuse honestly instead of synthesising. */
function _skew(a){const n=a.length;if(n<3)return 0;const m=_mean(a),sd=_std(a);if(sd===0)return 0;let s=0;for(let i=0;i<n;i++)s+=Math.pow((a[i]-m)/sd,3);return (n/((n-1)*(n-2)))*s}
function _kurt(a){const n=a.length;if(n<4)return 3;const m=_mean(a),sd=_std(a);if(sd===0)return 3;let s=0;for(let i=0;i<n;i++)s+=Math.pow((a[i]-m)/sd,4);return s/n} /* raw kurtosis, normal=3 */
function normCdf(x){const t=1/(1+0.2316419*Math.abs(x));const d=0.3989422804014327*Math.exp(-x*x/2);let p=d*t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return x>=0?1-p:p}
function sharpeR(Rs){const sd=_std(Rs);return sd>0?_mean(Rs)/sd:0} /* per-trade Sharpe of R-multiples (dimensionless) */
function psr0(Rs){ /* Probabilistic Sharpe Ratio vs SR*=0 (Bailey & Lopez de Prado): P(true SR>0) */
  const n=Rs.length;if(n<4)return NaN;const sr=sharpeR(Rs);if(!isFinite(sr))return NaN;
  const g3=_skew(Rs),g4=_kurt(Rs);
  const denom=Math.sqrt(Math.max(1e-9,1-g3*sr+((g4-1)/4)*sr*sr));
  return normCdf(sr*Math.sqrt(n-1)/denom);
}
function renderRobustness(trades,eqCurve,meta){
  meta=meta||{};const H=200,dpr=devicePixelRatio||1;
  const rr=document.getElementById('robustRead');
  const Rs=(trades||[]).map(t=>t.R).filter(v=>isFinite(v));
  const c=document.getElementById('sweepCanvas');if(!c)return;
  const box=c.parentElement.getBoundingClientRect();c.width=box.width*dpr;c.height=H*dpr;
  const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=box.width;g.clearRect(0,0,W,H);
  g.font='9px JetBrains Mono';
  if(Rs.length<20){
    g.fillStyle='#7A8494';g.font='11px JetBrains Mono';g.textAlign='center';
    g.fillText(Rs.length?(Rs.length+' trades \u2014 need \u226520 to resample honestly'):'no trades on this data to resample',W/2,H/2);
    g.font='9px JetBrains Mono';g.fillStyle='#566072';g.fillText('(a distribution from <20 samples would mislead)',W/2,H/2+16);
    if(rr)rr.innerHTML='<span style="color:var(--muted)">Monte-Carlo robustness needs \u226520 real trades on this data. '+(Rs.length?('Only '+Rs.length+' here \u2014 try a longer history, another symbol, or a looser rule.'):'These rules produced no trades.')+'</span>';
  } else {
    const N=Rs.length,P=600,risk=0.01,ruinDD=0.5;
    let rng=mulberry32(((meta.seed||99)>>>0)||99);
    const step=[];for(let k=0;k<=N;k++)step.push(new Float64Array(P));
    const finals=new Float64Array(P);let ruined=0;
    for(let p=0;p<P;p++){let e=1,peak=1,ruin=false;step[0][p]=1;
      for(let k=0;k<N;k++){const r=Rs[(rng()*N)|0];e*=1+risk*r;if(e<1e-6)e=1e-6;step[k+1][p]=e;if(e>peak)peak=e;if((peak-e)/peak>=ruinDD)ruin=true;}
      finals[p]=e;if(ruin)ruined++;}
    const pctArr=(ta,q)=>{const s=Array.prototype.slice.call(ta).sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.max(0,Math.round(q*(s.length-1))))]};
    const p05=step.map(s=>pctArr(s,0.05)),p50=step.map(s=>pctArr(s,0.5)),p95=step.map(s=>pctArr(s,0.95));
    let lo=Infinity,hi=-Infinity;for(let k=0;k<=N;k++){lo=Math.min(lo,p05[k]);hi=Math.max(hi,p95[k])}
    if(!(hi>lo)){hi=lo+1}
    const xk=k=>k/N*W,yv=v=>H-12-((v-lo)/(hi-lo))*(H-24);
    /* 5-95% band */
    g.beginPath();g.moveTo(xk(0),yv(p95[0]));for(let k=1;k<=N;k++)g.lineTo(xk(k),yv(p95[k]));
    for(let k=N;k>=0;k--)g.lineTo(xk(k),yv(p05[k]));g.closePath();
    g.fillStyle='rgba(76,130,251,.14)';g.fill();
    /* median */
    g.strokeStyle='#4C82FB';g.lineWidth=1.6;g.beginPath();for(let k=0;k<=N;k++){const xx=xk(k),yy=yv(p50[k]);k?g.lineTo(xx,yy):g.moveTo(xx,yy)}g.stroke();g.lineWidth=1;
    /* breakeven line */
    if(1>=lo&&1<=hi){g.strokeStyle='rgba(212,218,227,.25)';g.setLineDash([3,3]);g.beginPath();g.moveTo(0,yv(1));g.lineTo(W,yv(1));g.stroke();g.setLineDash([])}
    g.fillStyle='#566072';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText('median',6,12);g.fillText('5\u201395% band',6,24);
    const pProfit=Array.prototype.filter.call(finals,v=>v>1).length/P;
    const ror=ruined/P;
    const medF=pctArr(finals,0.5),lo5=pctArr(finals,0.05),hi95=pctArr(finals,0.95);
    if(rr){const sh=sharpeR(Rs),ps=psr0(Rs);
      const pf2=(x)=>((x-1)*100).toFixed(0);
      rr.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;font-size:11px">'
        +'<div class="stat"><div class="k">P(profitable)</div><div class="v '+(pProfit>0.5?'up':'dn')+'">'+(pProfit*100).toFixed(0)+'%</div></div>'
        +'<div class="stat"><div class="k">Median outcome</div><div class="v '+(medF>1?'up':'dn')+'">'+(medF>=1?'+':'')+pf2(medF)+'%</div></div>'
        +'<div class="stat"><div class="k">5\u201395% band</div><div class="v">'+pf2(lo5)+'% \u2192 +'+pf2(hi95)+'%</div></div>'
        +'<div class="stat"><div class="k">Risk of ruin (\u226550% DD)</div><div class="v '+(ror<0.1?'up':'dn')+'">'+(ror*100).toFixed(0)+'%</div></div>'
        +'<div class="stat"><div class="k">Sharpe (per-trade R)</div><div class="v '+(sh>0?'up':'dn')+'">'+sh.toFixed(2)+'</div></div>'
        +'<div class="stat"><div class="k">PSR (P true SR&gt;0)</div><div class="v '+(ps>0.9?'up':(ps>0.5?'':'dn'))+'">'+(isFinite(ps)?(ps*100).toFixed(0)+'%':'\u2014')+'</div></div>'
        +'</div><div style="font-size:10px;color:var(--muted2);margin-top:6px">'+P+' resampled paths of '+N+' trades at 1% risk each \u00b7 real R-multiples, resampled with replacement \u00b7 PSR after skew/kurtosis. Distribution, not a promise \u2014 you execute at your broker.</div>';
    }
  }
  /* ---- REAL walk-forward on wfCanvas (actual trades split by entry index) ---- */
  const wf=document.getElementById('wfCanvas');if(!wf)return;
  const b2=wf.parentElement.getBoundingClientRect();wf.width=b2.width*dpr;wf.height=H*dpr;
  const g2=wf.getContext('2d');g2.setTransform(dpr,0,0,dpr,0,0);const W2=b2.width;g2.clearRect(0,0,W2,H);
  const srt=(trades||[]).slice().sort((a,b)=>(a.entryI||0)-(b.entryI||0));
  const splitI=meta.splitI!=null?meta.splitI:0;
  const isT=srt.filter(t=>(t.entryI||0)<splitI),osT=srt.filter(t=>(t.entryI||0)>=splitI);
  g2.font='9px JetBrains Mono';
  if(srt.length<6||osT.length<4){
    g2.fillStyle='#7A8494';g2.font='11px JetBrains Mono';g2.textAlign='center';
    g2.fillText('insufficient out-of-sample trades ('+osT.length+') for a walk-forward read',W2/2,H/2);
    g2.font='9px JetBrains Mono';g2.fillStyle='#566072';g2.fillText('need \u22654 trades after the 70% split \u2014 not synthesising',W2/2,H/2+16);
  } else {
    let e=10000;const inS=[e];isT.forEach(t=>{e*=1+0.01*t.R;inS.push(e)});
    const ouS=[e];osT.forEach(t=>{e*=1+0.01*t.R;ouS.push(e)});
    const allv=inS.concat(ouS);const lo=Math.min.apply(null,allv),hi=Math.max.apply(null,allv);
    const xn=inS.length+ouS.length-2||1;const yv=v=>H-12-((v-lo)/((hi-lo)||1))*(H-24);
    g2.strokeStyle='#5A6472';g2.lineWidth=1.6;g2.beginPath();inS.forEach((v,i)=>{const x=i/xn*W2;i?g2.lineTo(x,yv(v)):g2.moveTo(x,yv(v))});g2.stroke();
    const sp=inS.length-1;
    g2.strokeStyle='#E8A33D';g2.beginPath();g2.moveTo(sp/xn*W2,yv(inS[sp]));ouS.forEach((v,i)=>{const x=(sp+1+i-1)/xn*W2;if(i>0)g2.lineTo(x,yv(v))});g2.stroke();g2.lineWidth=1;
    g2.strokeStyle='rgba(212,218,227,.2)';g2.setLineDash([3,3]);g2.beginPath();g2.moveTo(sp/xn*W2,0);g2.lineTo(sp/xn*W2,H);g2.stroke();g2.setLineDash([]);
    const isR=(inS[inS.length-1]/10000-1)*100,osR=(ouS[ouS.length-1]/inS[inS.length-1]-1)*100;
    g2.fillStyle='#566072';g2.font='9px JetBrains Mono';g2.textAlign='left';g2.fillText('in-sample '+(isR>=0?'+':'')+isR.toFixed(1)+'% ('+isT.length+')',6,12);
    g2.fillStyle='#E8A33D';g2.textAlign='right';g2.fillText('out-of-sample '+(osR>=0?'+':'')+osR.toFixed(1)+'% ('+osT.length+')',W2-6,12);
  }
}

