function sigScan(d,strat){ /* pure: historical signals with entry/stop/T1/T2 + resolution. Glass box. */
  if(!d||d.length<80)return [];
  const c=d.map(x=>x.c);
  const e20=IND.ema(c,20),e50=IND.ema(c,50),e200=IND.ema(c,200),rsi=IND.rsi(c),st=IND.supertrend(d),atr=IND.atr(d);
  const macd=IND.macd(c);
  const sw=swings(d,3);const lastSwing=(i,lo2)=>{const arr=lo2?sw.lo:sw.hi;let v=null;for(let k=0;k<arr.length;k++){if(arr[k]<i)v=arr[k];else break}return v};
  /* extra series for the expanded set (all pure, computed once) */
  let cumPV=0,cumV=0;const vwap=d.map(b=>{const tp=(b.h+b.l+b.c)/3;cumPV+=tp*(b.v||1);cumV+=(b.v||1);return cumPV/cumV});
  const mean20=[],sd20=[];{let q=[];for(let i=0;i<c.length;i++){q.push(c[i]);if(q.length>20)q.shift();
    const m=q.reduce((a,b)=>a+b,0)/q.length;mean20.push(m);sd20.push(Math.sqrt(q.reduce((a,b)=>a+(b-m)*(b-m),0)/q.length)||1e-9)}}
  const dayOf=t=>Math.floor(t/86400000);
  const dayRange={};d.forEach((b,i)=>{const k=dayOf(b.t);(dayRange[k]=dayRange[k]||{hi:-1e18,lo:1e18,n:0,firstHi:-1e18,firstLo:1e18});
    const r=dayRange[k];r.n++;if(r.n<=6){r.firstHi=Math.max(r.firstHi,b.h);r.firstLo=Math.min(r.firstLo,b.l)}r.hi=Math.max(r.hi,b.h);r.lo=Math.min(r.lo,b.l)});
  const idxInDay=[];{const cnt={};d.forEach(b=>{const k=dayOf(b.t);cnt[k]=(cnt[k]||0)+1;idxInDay.push(cnt[k]-1)})}
  const dc20hi=[],dc20lo=[];for(let i=0;i<d.length;i++){let hh=-1e18,ll=1e18;for(let k=Math.max(0,i-20);k<i;k++){hh=Math.max(hh,d[k].h);ll=Math.min(ll,d[k].l)}dc20hi.push(hh);dc20lo.push(ll)}
  /* atr percentile for quality */
  const atrSorted=atr.slice(30).filter(isFinite).sort((a,b)=>a-b);
  const atrPct=i=>{if(!atrSorted.length)return 50;let lo2=0,hi2=atrSorted.length;const v=atr[i];while(lo2<hi2){const m=(lo2+hi2)>>1;atrSorted[m]<v?lo2=m+1:hi2=m}return lo2/atrSorted.length*100};
  const sigs=[];
  const compo=i=>((e20[i]>e50[i])?1:-1)+((rsi[i]||50)>50?1:-1)+((macd.hist[i]||0)>=0?1:-1);
  const quality=(i,dir)=>{ /* glass-box 0-100: trend align 40 + momentum side 30 + vol sweet-spot 30 */
    let q=0;const trendUp=e50[i]>e200[i];
    if((dir===1&&trendUp)||(dir===-1&&!trendUp))q+=40;
    const r=(rsi[i]||50);q+=Math.max(0,Math.min(30,dir===1?(r-50)*1.2:(50-r)*1.2));
    const ap=atrPct(i);if(ap>=20&&ap<=80)q+=30;else if(ap>10&&ap<90)q+=15;
    return Math.round(q)};
    /* v34 AC1/AC2 + strategy substrate: all pure, once per scan */
  const adxA=IND.adx(d);
  const atrPctl=atr.map((a2,i2)=>{let lo3=Math.max(0,i2-200),n3=0,q3=0;for(let k3=lo3;k3<=i2;k3++){n3++;if(atr[k3]<=a2)q3++}return n3?q3/n3*100:50});
  const volAvg20=[];{let q4=[];for(let i4=0;i4<d.length;i4++){q4.push(d[i4].v||0);if(q4.length>20)q4.shift();volAvg20.push(q4.reduce((a,b)=>a+b,0)/q4.length)}}
  const bbW=c.map((v,i4)=>sd20[i4]*4/(mean20[i4]||1));
  const bbWPctl=bbW.map((w,i4)=>{let lo4=Math.max(0,i4-120),n4=0,q5=0;for(let k4=lo4;k4<=i4;k4++){n4++;if(bbW[k4]<=w)q5++}return n4?q5/n4*100:50});
  let cum2=0;const cvdP=d.map(b=>{cum2+=(b.c>=b.o?1:-1)*(b.v||0);return cum2});
  /* multi-touch levels + equal pools (0.15 ATR tolerance) */
  const touchesOf=(i4,lo5)=>{const arr=lo5?sw.lo:sw.hi;const a5=atr[i4]||1;let latest=null;
    for(let k4=arr.length-1;k4>=0;k4--){if(arr[k4]<i4){latest=arr[k4];break}}
    if(latest==null)return {idx:null,t:0,eq:false};
    const pv=lo5?d[latest].l:d[latest].h;let t2=0,eq2=0;
    arr.forEach(ix=>{if(ix>=i4)return;const v2=lo5?d[ix].l:d[ix].h;if(Math.abs(v2-pv)<=0.15*a5){t2++;if(ix!==latest)eq2++}});
    return {idx:latest,p:pv,t:t2,eq:eq2>=1};};
  /* prior-12h extreme for session grabs */
  const prevExt=i4=>{const t0=d[i4].t-12*3600000;let hi5=-1e18,lo5=1e18;for(let k4=i4-1;k4>=0&&d[k4].t>=t0;k4--){hi5=Math.max(hi5,d[k4].h);lo5=Math.min(lo5,d[k4].l)}return {hi:hi5,lo:lo5}};
  /* HTF trend from cached 4h bars (honest: null when not loaded) */
  let htf=null;try{const k5=Object.keys(BAR_CACHE||{}).find(k6=>k6.startsWith(((CURSYM&&CURSYM.sym)||'')+'|4h'));
    if(k5&&BAR_CACHE[k5].length>60){const hc=BAR_CACHE[k5].map(b=>b.c);const he20=IND.ema(hc,20),he50=IND.ema(hc,50);
      htf={bars:BAR_CACHE[k5],e20:he20,dir:he20[he20.length-1]>he50[he50.length-1]?1:-1};}}catch(e){}
  const CTX={d,c,e20,e50,e200,rsi,st,atr,macd,vwap,mean20,sd20,dc20hi,dc20lo,dayOf,dayRange,idxInDay,lastSwing,
    adxA,atrPctl,volAvg20,bbWPctl,cvdP,touchesOf,prevExt,htf,others:null};
  /* S21 ensemble substrate: all other strategies' fired directions by bar */
  if(strat==='ensemble'){const map={};Object.keys(window.SIG_STRATS).forEach(k6=>{if(k6==='ensemble')return;
    try{sigScan(d,k6).forEach(sg=>{for(let o5=-2;o5<=2;o5++){const key=(sg.i+o5)+'_'+sg.dir;map[key]=(map[key]||0)+(o5===0?1:1)}})}catch(e){}});
    CTX.others=map;}
  const habitat=(window.SIG_STRATS[strat]||{}).habitat||'any';
  for(let i=60;i<d.length-1;i++){
    let dir=0;
    /* AC1: in-habitat only (trend needs ADX\u226522, range needs ADX<22); 'any' passes */
    if(habitat==='trend'&&(adxA[i]||20)<22)continue;
    if(habitat==='range'&&(adxA[i]||20)>=22)continue;
    const det=window.SIG_DETECT[strat];
    if(det){try{dir=det(CTX,i)||0}catch(e){dir=0}}
    if(!dir)continue;
    if(sigs.length&&i-sigs[sigs.length-1].i<5)continue;   /* debounce */
    const a=atr[i]||c[i]*0.005;const entry=c[i];
    const swI=lastSwing(i,dir===1);
    /* AC2: stop width adapts to the volatility state \u2014 compressed 0.9\u00d7, normal 1.2\u00d7, expanded 1.5\u00d7 ATR floor */
    const pad=atrPctl[i]<30?0.9:atrPctl[i]>70?1.5:1.2;
    let stop=dir===1?Math.min(swI!=null?d[swI].l:entry-pad*a,entry-pad*a)-0.15*a
                    :Math.max(swI!=null?d[swI].h:entry+pad*a,entry+pad*a)+0.15*a;
    const R=Math.abs(entry-stop);if(R<=0||!isFinite(R))continue;
    const t1=dir===1?entry+R:entry-R,t2=dir===1?entry+2*R:entry-2*R;
    /* resolve forward: stop vs t1 (first touch wins; conservative: same-bar both => stop) */
    let res='open',rEnd=null;
    const TMAX=40; /* AC3: time barrier \u2014 stale signals expire as scratch (\u00b10R), L\u00f3pez de Prado triple-barrier */
    for(let k=i+1;k<d.length;k++){
      if(k-i>TMAX){res='time';rEnd=k;break}
      const hitS=dir===1?d[k].l<=stop:d[k].h>=stop;
      const hit1=dir===1?d[k].h>=t1:d[k].l<=t1;
      const hit2=dir===1?d[k].h>=t2:d[k].l<=t2;
      if(hitS){res='stop';rEnd=k;break}
      if(hit2){res='t2';rEnd=k;break}
      if(hit1&&res==='open'){res='t1' /* keep scanning for t2/stop after 1R? conservative: bank T1 */;rEnd=k;break}
    }
    const _hr=new Date(d[i].t).getUTCHours();const sess=(_hr>=12&&_hr<21)?((_hr>=12&&_hr<16)?'LDN+NY':'NY'):(_hr>=7&&_hr<12)?'LDN':'ASIA';
    /* AC6: cost realism \u2014 spread estimate in R, subtracted from every outcome */
    /* v38.0 AC6-REAL: the cost of a trade is not a constant.
       For 37 versions every instrument was costed at a flat 2bps and commission and
       swap were ignored entirely. Gold's spread at rollover is nothing like EURUSD's
       at midday, and a swap-negative pair held over Wednesday pays triple. A backtest
       costed with a guess is a backtest of a market that does not exist.
       Order of truth: broker spec > live broker tick > live book > LABELLED assumption. */
    const _held=(rEnd!=null&&rEnd>i)?(rEnd-i):0;              /* bars in the trade -> swap nights */
    const cst=(window.costModel?window.costModel(entry,R,_held):null);
    const costR=cst?cst.costR:Math.min(0.15,(entry*0.0002)/R);
    sigs.push({i,dir,entry,stop,t1,t2,res,rEnd,r:R,q:quality(i,dir),sess,costR});
  }
  return sigs;}
function sigStats(sigs){ /* pure honesty · v34: net of costs, Wilson CI, time-barrier scratches */
  const done=(sigs||[]).filter(s=>s.res!=='open');
  if(!done.length)return {n:(sigs||[]).length,resolved:0,winPct:null,avgR:null,pf:null,ciLo:null,ciHi:null,netAvgR:null,scratches:0};
  const scored=done.filter(s=>s.res!=='time');const scratches=done.length-scored.length;
  if(!scored.length)return {n:sigs.length,resolved:done.length,winPct:null,avgR:null,pf:null,ciLo:null,ciHi:null,netAvgR:null,scratches};
  const outR=s=>(s.res==='t2'?2:s.res==='t1'?1:-1);
  const wins=scored.filter(s=>outR(s)>0);
  const gross=wins.reduce((a,s)=>a+outR(s),0);
  const loss=scored.length-wins.length;
  const avgR=scored.reduce((a,s)=>a+outR(s),0)/scored.length;
  const netAvgR=scored.reduce((a,s)=>a+outR(s)-(s.costR||0),0)/scored.length;
  const nn=scored.length,ph=wins.length/nn,z=1.96,den=1+z*z/nn;
  const ctr=(ph+z*z/(2*nn))/den,hw=z*Math.sqrt(ph*(1-ph)/nn+z*z/(4*nn*nn))/den;
  return {n:sigs.length,resolved:done.length,winPct:ph,avgR,netAvgR,pf:loss?+(gross/loss).toFixed(2):(gross?Infinity:null),ciLo:Math.max(0,ctr-hw),ciHi:Math.min(1,ctr+hw),scratches};}
function sigFilterQ(sigs,minQ){return (sigs||[]).filter(s=>(s.q==null)||s.q>=minQ);} /* smart filter: quality gate */
function sigSessStats(sigs){ /* C1: measured record per session */
  const by={};(sigs||[]).forEach(s=>{(by[s.sess||'?']=by[s.sess||'?']||[]).push(s)});
  const out={};Object.keys(by).forEach(k=>out[k]=sigStats(by[k]));return out;}
function sigStack(d,mainSigs,mainStrat){ /* C2: mark signals where >=2 OTHER strategies agree (same dir, within 3 bars) */
  const others={};Object.keys(window.SIG_STRATS).forEach(k=>{if(k===mainStrat)return;try{others[k]=sigScan(d,k)}catch(e){}});
  (mainSigs||[]).forEach(s=>{let n=0;Object.keys(others).forEach(k=>{if(others[k].some(o=>o.dir===s.dir&&Math.abs(o.i-s.i)<=3))n++});s.stack=n;});
  return mainSigs;}
function sigStackStats(sigs){ /* stacked (>=2 agree) vs solo, measured separately */
  const st=(sigs||[]).filter(s=>(s.stack||0)>=2),so=(sigs||[]).filter(s=>(s.stack||0)<2);
  return {stacked:sigStats(st),solo:sigStats(so),nStacked:st.length};}
