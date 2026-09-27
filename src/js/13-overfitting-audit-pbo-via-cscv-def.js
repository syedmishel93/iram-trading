/* ================= v14.7 OVERFITTING AUDIT — PBO via CSCV + Deflated Sharpe (Bailey/Lopez de Prado) ================= */
/* -- pure logic (unit-tested against the shipped copy) -- */
function _combos(n,k){const res=[],idx=[];(function rec(s,d){if(d===k){res.push(idx.slice());return}for(let i=s;i<n;i++){idx.push(i);rec(i+1,d+1);idx.pop()}})(0,0);return res}
function normInv(p){ /* Acklam inverse-normal — expected-max-Sharpe under the null needs it */
  if(p<=0)return -Infinity;if(p>=1)return Infinity;
  const a=[-3.969683028665376e+01,2.209460984245205e+02,-2.759285104469687e+02,1.383577518672690e+02,-3.066479806614716e+01,2.506628277459239e+00];
  const b=[-5.447609879822406e+01,1.615858368580409e+02,-1.556989798598866e+02,6.680131188771972e+01,-1.328068155288572e+01];
  const c=[-7.784894002430293e-03,-3.223964580411365e-01,-2.400758277161838e+00,-2.549732539343734e+00,4.374664141464968e+00,2.938163982698783e+00];
  const d=[7.784695709041462e-03,3.224671290700398e-01,2.445134137142996e+00,3.754408661907416e+00];
  const pl=0.02425,ph=1-pl;let q,r;
  if(p<pl){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)}
  if(p<=ph){q=p-0.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)}
  q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
function cscvPBO(M,S){ /* M: N configs x T time-aligned per-bar returns. Combinatorially-symmetric CV → P(backtest overfit). */
  S=S||10;if(S%2)S++;const N=M.length;if(N<2)return{ok:false,reason:'need \u22652 configs that traded'};
  const T=M[0].length;if(T<S)return{ok:false,reason:'need \u2265'+S+' bars'};
  const bsz=Math.floor(T/S),bounds=[];for(let s=0;s<S;s++)bounds.push([s*bsz,s===S-1?T:(s+1)*bsz]);
  const blockRet=[];for(let c=0;c<N;c++)blockRet.push(bounds.map(([x,y])=>M[c].slice(x,y)));
  const half=S/2,blockIdx=[];for(let i=0;i<S;i++)blockIdx.push(i);
  const trainSets=_combos(S,half),lambdas=[];
  trainSets.forEach(trainPos=>{
    const train=trainPos,inTest={};train.forEach(b=>inTest[b]=1);const test=blockIdx.filter(b=>!inTest[b]);
    const isSR=[],osSR=[];
    for(let c=0;c<N;c++){let inR=[],outR=[];train.forEach(b=>{inR=inR.concat(blockRet[c][b])});test.forEach(b=>{outR=outR.concat(blockRet[c][b])});isSR.push(sharpeR(inR));osSR.push(sharpeR(outR))}
    let nStar=0;for(let c=1;c<N;c++)if(isSR[c]>isSR[nStar])nStar=c;
    let below=0;for(let c=0;c<N;c++)if(osSR[c]<osSR[nStar])below++;
    let rank=(below+0.5)/N;rank=Math.min(1-1e-6,Math.max(1e-6,rank));
    lambdas.push(Math.log(rank/(1-rank)));
  });
  const pbo=lambdas.filter(l=>l<=0).length/lambdas.length;
  return{ok:true,pbo:pbo,lambdas:lambdas,splits:lambdas.length,nConfig:N,blocks:S};
}
function expectedMaxSR(trialSRs){ /* E[max Sharpe] under the null of no skill (Lopez de Prado) */
  const N=trialSRs.length;if(N<2)return 0;const v=_std(trialSRs);const g=0.5772156649015329;
  const z1=normInv(1-1/N),z2=normInv(1-1/(N*Math.E));return v*((1-g)*z1+g*z2);
}
function deflatedSharpe(bestRs,trialSRs,T){ /* DSR: deflate best Sharpe for #trials, trial dispersion, skew & kurtosis */
  const n=T||bestRs.length;if(n<4)return{ok:false,reason:'n<4'};
  const sr=sharpeR(bestRs),sr0=expectedMaxSR(trialSRs),g3=_skew(bestRs),g4=_kurt(bestRs);
  const denom=Math.sqrt(Math.max(1e-9,1-g3*sr+((g4-1)/4)*sr*sr));
  return{ok:true,dsr:normCdf(((sr-sr0)*Math.sqrt(n-1))/denom),sr:sr,sr0:sr0,trials:trialSRs.length};
}
/* -- honest real config sweep: vary the stop-multiple x target-R grid; each cell is a genuine runStrategy pass -- */
function sweepStrategyConfigs(baseSpec,d,costBps){
  costBps=costBps||0;const stopIsAtr=!baseSpec.stop||baseSpec.stop.type==='atr';
  const stopGrid=stopIsAtr?[1,1.5,2,2.5,3]:[0.8,1.2,1.6,2,2.6];
  const tpGrid=[1,1.5,2,2.5,3];const configs=[];const T=d.length;
  stopGrid.forEach(sv=>tpGrid.forEach(tv=>{
    const spec2=Object.assign({},baseSpec);
    spec2.stop=stopIsAtr?{type:'atr',mult:sv}:{type:'pct',value:sv};
    spec2.tp={type:'rr',value:tv};
    let raw;try{raw=runStrategy(spec2,d)}catch(e){raw=[]}
    const perBar=new Float64Array(T);const Rlist=[];
    raw.forEach(t=>{const risk=Math.abs(t.entry-t.stop)||t.entry*0.01;const costR=(costBps/10000)*t.entry/risk;const netR=t.R-costR;
      const bi=Math.min(T-1,Math.max(0,t.exitI!=null?t.exitI:(t.entryI||0)));perBar[bi]+=netR;Rlist.push(netR)});
    configs.push({label:(stopIsAtr?('SL '+sv+'x'):('SL '+sv+'%'))+' / TP '+tv+'R',stop:sv,tp:tv,ntr:Rlist.length,sharpe:sharpeR(Rlist),sumR:Rlist.reduce((a,b)=>a+b,0),perBar:perBar,Rlist:Rlist});
  }));
  return configs;
}
function renderOverfitAudit(baseSpec,d,meta){
  meta=meta||{};const host=document.getElementById('pboOut');if(!host)return;
  const MINTR=8;let configs=[];try{configs=sweepStrategyConfigs(baseSpec,d,meta.costBps||0)}catch(e){configs=[]}
  const qual=configs.filter(c=>c.ntr>=MINTR);
  if(qual.length<2){
    host.innerHTML='<div style="font-size:11.5px;color:var(--muted);line-height:1.6">The overfitting audit sweeps a real stop \u00d7 target grid ('+configs.length+' configs) through the same engine, but only <b>'+qual.length+'</b> produced \u2265'+MINTR+' trades on this data \u2014 too few to cross-validate honestly. Load a longer history or loosen the rules, then re-run. <i>No PBO is shown rather than a misleading one.</i></div>';
    return;
  }
  const M=qual.map(c=>Array.prototype.slice.call(c.perBar));
  const S=d.length>=1600?12:10;
  const cv=cscvPBO(M,S);
  const trialSRs=qual.map(c=>c.sharpe);
  let best=qual[0];qual.forEach(c=>{if(c.sharpe>best.sharpe)best=c});
  const ds=deflatedSharpe(best.Rlist,trialSRs,best.Rlist.length);
  const pboPct=cv.ok?(cv.pbo*100):null;const dsrPct=ds.ok?(ds.dsr*100):null;
  const pboColor=pboPct==null?'':(pboPct<=20?'up':pboPct<=50?'':'dn');
  const dsrColor=dsrPct==null?'':(dsrPct>=90?'up':dsrPct>=50?'':'dn');
  const verdict=(()=>{if(pboPct==null)return '';
    if(pboPct>50)return {t:'Likely overfit',c:'var(--bear)',m:'The in-sample \u201cbest\u201d config lands in the bottom half out-of-sample more often than not. Treat any single tuned result here with heavy suspicion.'};
    if(pboPct>20)return {t:'Fragile edge',c:'var(--gold)',m:'Some out-of-sample decay. The edge is real-ish but sensitive to the stop/target choice \u2014 don\u2019t over-tune.'};
    return {t:'Holds up out-of-sample',c:'var(--bull)',m:'The best in-sample config stays near the top out-of-sample across most splits. The edge is not merely fitted to these bars.'};})();
  host.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;font-size:11px">'
    +'<div class="stat"><div class="k">PBO (P backtest overfit)</div><div class="v '+pboColor+'">'+(pboPct!=null?pboPct.toFixed(0)+'%':'\u2014')+'</div></div>'
    +'<div class="stat"><div class="k">Deflated Sharpe (P true SR&gt;E[max])</div><div class="v '+dsrColor+'">'+(dsrPct!=null?dsrPct.toFixed(0)+'%':'\u2014')+'</div></div>'
    +'<div class="stat"><div class="k">Best-config Sharpe</div><div class="v '+(ds.ok&&ds.sr>0?'up':'dn')+'">'+(ds.ok?ds.sr.toFixed(2):'\u2014')+'</div></div>'
    +'<div class="stat"><div class="k">Expected max under null (SR\u2080)</div><div class="v">'+(ds.ok?ds.sr0.toFixed(2):'\u2014')+'</div></div>'
    +'<div class="stat"><div class="k">Configs tested / traded</div><div class="v">'+configs.length+' / '+qual.length+'</div></div>'
    +'<div class="stat"><div class="k">CSCV splits</div><div class="v">'+(cv.ok?cv.splits+' \u00d7 '+cv.blocks+' blocks':'\u2014')+'</div></div>'
    +'</div>'
    +(verdict?'<div style="margin-top:10px;padding:9px 12px;border:1px solid '+verdict.c+';border-radius:8px;background:rgba(255,255,255,.02)"><b style="color:'+verdict.c+'">'+verdict.t+'</b> <span style="color:var(--muted2);font-size:11px">\u2014 '+verdict.m+'</span></div>':'')
    +'<div style="margin-top:10px"><div style="font-size:10px;color:var(--muted);margin-bottom:4px">Logit distribution of out-of-sample rank across all CSCV splits (mass left of 0 = overfit).</div><canvas id="pboHist" style="height:120px"></canvas></div>'
    +'<div style="font-size:10px;color:var(--muted2);margin-top:8px">Best-Sharpe config on full sample: <b>'+best.label+'</b> ('+best.ntr+' trades). '
    +'Deflated Sharpe deflates it for '+qual.length+' trials, their dispersion, and this series\u2019 skew/kurtosis. '
    +'CSCV picks the in-sample winner on each split and checks where it ranks out-of-sample \u2014 real cross-validation on your bars, not a promise. You execute at your broker.</div>';
  /* logit histogram */
  if(cv.ok){const c=document.getElementById('pboHist');if(c){const dpr=devicePixelRatio||1,box=c.parentElement.getBoundingClientRect(),H=120;c.width=box.width*dpr;c.height=H*dpr;const g=c.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const W=box.width;g.clearRect(0,0,W,H);
    const L=cv.lambdas,lo=Math.min.apply(null,L),hi=Math.max.apply(null,L),span=(hi-lo)||1,bins=24,bk=new Array(bins).fill(0);
    L.forEach(v=>{bk[Math.min(bins-1,Math.max(0,Math.floor((v-lo)/span*bins)))]++});const mx=Math.max.apply(null,bk)||1;
    const x0=(0-lo)/span*W;
    bk.forEach((v,i)=>{const bw=W/bins,bh=v/mx*(H-22),xx=i*bw,mid=lo+(i+0.5)/bins*span;g.fillStyle=mid<=0?'rgba(240,97,109,.55)':'rgba(45,190,142,.5)';g.fillRect(xx+1,H-14-bh,bw-2,bh)});
    if(x0>=0&&x0<=W){g.strokeStyle='rgba(212,218,227,.5)';g.setLineDash([3,3]);g.beginPath();g.moveTo(x0,2);g.lineTo(x0,H-14);g.stroke();g.setLineDash([]);g.fillStyle='#8A94A6';g.font='9px JetBrains Mono';g.textAlign='center';g.fillText('\u03bb=0',x0,H-3)}
    g.fillStyle='#566072';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText('overfit \u2190',4,12);g.textAlign='right';g.fillText('\u2192 robust',W-4,12);
  }}
}

/* ================= v15.0 SEASONALITY / TIME-OF-DAY EDGE FINDER — hit-rate & expectancy by session/hour (real trades only) ================= */
function wilson(k,n,z){z=z||1.96;if(n<=0)return{p:0,lo:0,hi:1};const p=k/n,z2=z*z,denom=1+z2/n,centre=p+z2/(2*n),half=z*Math.sqrt((p*(1-p)+z2/(4*n))/n);return{p:p,lo:Math.max(0,(centre-half)/denom),hi:Math.min(1,(centre+half)/denom)}}
function sessionBucket(h){if(h<8)return 'Asia';if(h<13)return 'London';if(h<17)return 'London/NY overlap';if(h<22)return 'New York';return 'After-hours'}
const SESSION_ORDER=['Asia','London','London/NY overlap','New York','After-hours'];
function seasonalityStats(trades,d,minN){minN=minN||5;
  const rows=(trades||[]).map(t=>{const c=d[t.entryI];if(!c||!isFinite(t.R))return null;const h=new Date(c.t).getUTCHours();return{R:t.R,h:h,sess:sessionBucket(h)}}).filter(Boolean);
  function agg(key){const g={};rows.forEach(r=>{const kk=r[key];(g[kk]=g[kk]||[]).push(r.R)});
    return Object.keys(g).map(kk=>{const Rs=g[kk],n=Rs.length,wins=Rs.filter(v=>v>0).length,mean=Rs.reduce((a,b)=>a+b,0)/n,w=wilson(wins,n);
      return{key:kk,n:n,wins:wins,winRate:wins/n,meanR:mean,sumR:Rs.reduce((a,b)=>a+b,0),lo:w.lo,hi:w.hi,enough:n>=minN}})}
  const bySession=agg('sess').sort((a,b)=>SESSION_ORDER.indexOf(a.key)-SESSION_ORDER.indexOf(b.key));
  const byHour=agg('h').sort((a,b)=>(+a.key)-(+b.key));
  return{total:rows.length,minN:minN,bySession:bySession,byHour:byHour}}
function renderSeasonality(trades,d){
  const host=document.getElementById('seasOut');if(!host)return;
  const Rs=(trades||[]).filter(t=>isFinite(t.R));
  if(Rs.length<12){host.innerHTML='<div style="font-size:11.5px;color:var(--muted);line-height:1.6">The edge finder splits your <b>real</b> trades by session and hour, but there are only <b>'+Rs.length+'</b> here \u2014 need \u226512 before a time-of-day pattern means anything (a few trades per bucket would just be noise dressed up as an edge). Run a longer history or a looser rule. <i>Nothing is synthesised to fill the grid.</i></div>';return}
  const st=seasonalityStats(Rs,d,5);
  const fmtR=v=>(v>=0?'+':'')+v.toFixed(2);
  const barCI=(row)=>{const w=100,lo=row.lo*w,hi=row.hi*w,p=row.winRate*w;
    return '<div style="position:relative;height:8px;background:var(--panel);border-radius:4px;overflow:hidden"><div style="position:absolute;left:'+lo.toFixed(1)+'%;width:'+Math.max(1,(hi-lo)).toFixed(1)+'%;top:0;bottom:0;background:rgba(76,130,251,.25)"></div><div style="position:absolute;left:calc('+p.toFixed(1)+'% - 1px);width:2px;top:-1px;bottom:-1px;background:'+(row.meanR>0?'var(--bull)':'var(--bear)')+'"></div><div style="position:absolute;left:calc(50% - 1px);width:1px;top:0;bottom:0;background:rgba(212,218,227,.3)"></div></div>'};
  const rowHtml=(r,label)=>{const dim=r.enough?'':'opacity:.5';const tag=r.enough?'':' <span style="color:var(--gold);font-size:9px">n&lt;'+st.minN+'</span>';
    return '<tr style="'+dim+'"><td style="white-space:nowrap"><b>'+label+'</b>'+tag+'</td><td class="mono">'+r.n+'</td><td class="mono '+(r.winRate>=0.5?'up':'dn')+'">'+(r.winRate*100).toFixed(0)+'%</td><td style="min-width:120px">'+barCI(r)+'</td><td class="mono '+(r.meanR>0?'up':'dn')+'">'+fmtR(r.meanR)+'R</td><td class="mono '+(r.sumR>0?'up':'dn')+'">'+fmtR(r.sumR)+'R</td></tr>'};
  const enough=st.bySession.filter(s=>s.enough);
  let bestS=null,worstS=null;enough.forEach(s=>{if(!bestS||s.meanR>bestS.meanR)bestS=s;if(!worstS||s.meanR<worstS.meanR)worstS=s});
  const head='<tr><th>Bucket</th><th>Trades</th><th>Win%</th><th style="min-width:120px">Win-rate 95% CI</th><th>Avg R</th><th>Total R</th></tr>';
  const sessTable='<table class="log" style="font-family:var(--ui);width:100%"><thead>'+head+'</thead><tbody>'+st.bySession.map(s=>rowHtml(s,s.key)).join('')+'</tbody></table>';
  const hoursShown=st.byHour.filter(h=>h.n>0);
  const hourTable='<table class="log" style="font-family:var(--ui);width:100%"><thead>'+head.replace('Bucket','Hour (UTC)')+'</thead><tbody>'+hoursShown.map(h=>rowHtml(h,String(h.key).padStart(2,'0')+':00')).join('')+'</tbody></table>';
  const verdict=(bestS&&worstS&&bestS.key!==worstS.key&&(bestS.meanR-worstS.meanR)>0.15)
    ? '<div style="margin-top:10px;padding:9px 12px;border:1px solid var(--bull);border-radius:8px;background:rgba(255,255,255,.02);font-size:11px"><b style="color:var(--bull)">'+bestS.key+'</b> is your strongest window here ('+fmtR(bestS.meanR)+'R avg over '+bestS.n+' trades) and <b style="color:var(--bear)">'+worstS.key+'</b> the weakest ('+fmtR(worstS.meanR)+'R). The CI bars show whether that gap is signal or small-sample noise \u2014 overlapping bars mean don\u2019t trust it yet.</div>'
    : '<div style="margin-top:10px;font-size:11px;color:var(--muted)">No session stands out beyond noise yet \u2014 win-rate CIs overlap. That\u2019s an honest \u201cno time-of-day edge here,\u201d not a failure.</div>';
  host.innerHTML='<div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.55">Every closed backtest trade is bucketed by the UTC hour it was <b>entered</b> (from the real candle timestamp). The blue band is the 95% Wilson interval on win-rate; the vertical tick is the point estimate; the faint centre line is 50%. Buckets under '+st.minN+' trades are dimmed \u2014 shown for honesty, not to be trusted.</div>'
    +'<div style="font-size:10px;color:var(--muted2);letter-spacing:.08em;text-transform:uppercase;margin:4px 0 6px">By session</div>'+sessTable
    +verdict
    +'<div style="font-size:10px;color:var(--muted2);letter-spacing:.08em;text-transform:uppercase;margin:14px 0 6px">By hour (UTC)</div>'+hourTable
    +'<div style="font-size:10px;color:var(--muted2);margin-top:8px">'+st.total+' trades placed into buckets \u00b7 win-rate CIs are Wilson-score (correct for small n) \u00b7 sessions use the London/NY clock. A bucket looking good on 4 trades is luck; wait for the CI to tighten. You execute at your broker.</div>';
}

