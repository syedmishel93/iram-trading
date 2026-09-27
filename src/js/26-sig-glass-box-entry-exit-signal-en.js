function tokenVerdict(t,ctx){ /* A1/C1/F4/F5: coin-trade decision from real fields. t: {liq,vol24,chg24,buys,sells,ageDays,rug,smartCount,smartTier} */
  ctx=ctx||{};const flags=[],pros=[];let risk=0,edge=0;
  const liq=+t.liq||0,vol=+t.vol24||0,buys=+t.buys||0,sells=+t.sells||0,age=+t.ageDays;
  const bsr=sells>0?buys/sells:(buys>0?9:1);
  /* red flags (F5: why-not transparency) */
  if(liq<10000){risk+=3;flags.push('liquidity $'+(liq/1000).toFixed(1)+'k — thin, hard to exit')}
  else if(liq<30000){risk+=1;flags.push('modest liquidity $'+(liq/1000).toFixed(0)+'k')}
  if(t.rug&&/high|elevated/i.test(t.rug)){risk+=2;flags.push('rug screen: '+t.rug)}
  if(vol>0&&liq>0&&vol/liq>25){risk+=1;flags.push('vol '+(vol/liq).toFixed(0)+'× liquidity — churny/volatile')}
  if(age!=null&&age<1){risk+=1;flags.push('under 1 day old — unproven')}
  /* edge signals */
  if(bsr>=2){edge+=2;pros.push('buys '+bsr.toFixed(1)+'× sells — net buy pressure')}
  else if(bsr>=1.3){edge+=1;pros.push('buys > sells ('+bsr.toFixed(1)+'×)')}
  if((+t.chg24||0)>0&&vol>liq){edge+=1;pros.push('rising with real volume')}
  if(t.smartCount>=2){edge+=3;pros.push(t.smartCount+' smart wallets'+(t.smartTier?' ('+t.smartTier+')':'')+' in it')}
  else if(t.smartCount===1){edge+=1;pros.push('1 smart wallet in it')}
  /* F7 regime: risk-off tightens */
  const regime=ctx.momentum;if(regime==='RISK-OFF')risk+=1;
  /* conviction + stance */
  const conv=Math.max(0,Math.min(100,Math.round(50+edge*11-risk*13)));
  let stance,col;
  if(risk>=4||(risk>=3&&edge<2)){stance='AVOID';col='var(--bear)'}
  else if(edge>=3&&risk<=2){stance='WATCH';col='var(--bull)'}
  else{stance='RESEARCH';col='var(--gold)'}
  /* F4 confidence from data sufficiency */
  const dataPts=(liq>0?1:0)+(vol>0?1:0)+(buys+sells>0?1:0)+(t.smartCount!=null?1:0)+(age!=null?1:0);
  const conf=dataPts>=4?'solid':dataPts>=2?'moderate':'thin';
  const line=(stance==='AVOID'?flags[0]:pros[0])||'insufficient signal';
  return {stance,col,conviction:conv,confidence:conf,line,pros,flags,bsr:+bsr.toFixed(2)};}
function walletCopyability(rec,dna,ctx){ /* A2/C2: which-wallet-do-I-copy stance */
  ctx=ctx||{};const iv=(typeof walletIntel==='function')?walletIntel(rec,ctx):{score:0,tier:'D',conf:0,risky:false};
  const pros=[],cons=[];let stance,col;
  if(iv.risky||(dna&&/RUGGER|DUMPER/.test(dna.role))){stance='AVOID';col='var(--bear)';cons.push('risk-flagged — do not copy')}
  else{
    if(iv.tier==='S'||iv.tier==='A')pros.push(iv.tier+'-tier intelligence ('+iv.score+')');
    if(dna&&dna.consistency&&dna.consistency.score>=70)pros.push('consistent pattern ('+dna.consistency.score+'/100)');
    if(ctx.roundtrips>=2)pros.push(ctx.roundtrips+' completed round-trips (proxy)');
    if(dna&&dna.style&&/ACCUMULATOR|SWING|SNIPER/.test(dna.style.style))pros.push(dna.style.style.toLowerCase()+' style');
    if((iv.conf||0)<50)cons.push('low confidence — few independent tokens');
    if(pros.length>=2&&(iv.tier==='S'||iv.tier==='A')){stance='COPYABLE';col='var(--bull)'}
    else if(iv.tier==='B'||pros.length>=1){stance='WATCH';col='var(--gold)'}
    else{stance='UNPROVEN';col='var(--muted)'}
  }
  const conv=Math.max(0,Math.min(100,Math.round((iv.score||0)*0.7+(dna&&dna.consistency&&dna.consistency.score||0)*0.3-(iv.risky?60:0))));
  return {stance,col,conviction:conv,pros,cons,tier:iv.tier,confidence:(iv.conf>=75?'solid':iv.conf>=40?'moderate':'thin')};}
/* ================= v28.0 SIG — glass-box entry/exit signal engine (SIG1) ================= */
window.SIG_STRATS_V34=1;window.SIG_STRATS={
  /* SCALP (1m-15m) */
  vwapBounce:{style:'scalp',habitat:'range',name:'VWAP Bounce',desc:'price stretches \u22650.6 ATR from cumulative VWAP then closes back toward it \u2014 mean-reversion to fair value'},
  rsiExtreme:{style:'scalp',habitat:'range',name:'RSI Extreme Snap',desc:'RSI <25 (or >75) then hooks back through 30/70 \u2014 exhaustion snapback'},
  bbSnap:{style:'scalp',habitat:'range',name:'Bollinger Snapback',desc:'close outside the 20,2 band then back inside \u2014 fade the overshoot'},
  /* DAY (15m-1h) */
  emaPull:{style:'day',habitat:'trend',name:'EMA Pullback',desc:'trend up (EMA50>EMA200) + close reclaims EMA20 after RSI reset <45; mirrored for shorts'},
  momFlip:{style:'day',habitat:'any',name:'Momentum Composite',desc:'EMA20/50 alignment + RSI side + MACD histogram \u2014 enter when the composite flips'},
  orb:{style:'day',habitat:'any',name:'Opening Range Break',desc:'first 6 bars of the UTC day define the range; trade the first close beyond it'},
  pdBreak:{style:'day',habitat:'trend',name:'Prev-Day Break',desc:'close crosses yesterday\u2019s high (long) or low (short) \u2014 classic day-trade level break'},
  /* SWING (4h-1d) */
  stFlip:{style:'swing',habitat:'trend',name:'Supertrend Flip',desc:'enter when Supertrend flips direction; ride the new side'},
  smcChoch:{style:'swing',habitat:'any',name:'SMC CHoCH',desc:'change-of-character swing break \u2192 enter on the break bar in the new direction'},
  donchian:{style:'swing',habitat:'trend',name:'Donchian 20 Break',desc:'close beyond the 20-bar high/low \u2014 the classic breakout-follow system'},
  goldenX:{style:'swing',habitat:'trend',name:'EMA 50/200 Cross',desc:'golden / death cross of EMA50 through EMA200'},
  macdZero:{style:'swing',habitat:'trend',name:'MACD Zero Cross',desc:'MACD line crosses zero in the direction of the EMA200 slope'},
  liqSweep:{name:'Liquidity Sweep',style:'scalp',habitat:'any',desc:'wick through a prior swing low that closes back above it \u2014 the stop-hunt reversal (mirrored for highs)'},
  cvdDiv:{name:'CVD Divergence Snap',style:'scalp',habitat:'range',desc:'price HH while candle-direction CVD makes an LH at a range edge \u2014 effort without result'},
  failedBreak:{name:'Failed Breakout Trap',style:'swing',habitat:'any',desc:'Donchian break that closes back inside within 2 bars \u2014 trap the trapped'},
  compBreak:{name:'Compression Break',style:'swing',habitat:'any',desc:'BB-width <15th percentile for 10+ bars, then a volume-confirmed break'},
  htfPull:{name:'HTF Confluence Pullback',style:'swing',habitat:'trend',desc:'4H trend + pullback into the 4H EMA20 zone + reclaim (needs 4h bars cached \u2014 honest empty otherwise)'},
  ensemble:{name:'Ensemble Vote',style:'day',habitat:'any',desc:'fires only when \u22653 other strategies agree in direction within \u00b12 bars \u2014 the \u25c9 stack as a first-class strategy'},
  stopRun:{name:'Stop-Run Reclaim',style:'day',habitat:'any',desc:'MM: a MULTI-TOUCH level (2+ touches = maximal resting stops) swept on elevated volume, then reclaimed within 2 bars'},
  eqRaid:{name:'Equal-Highs Raid',style:'day',habitat:'any',desc:'MM: engineered liquidity \u2014 equal highs/lows (\u22640.15 ATR apart) raided and rejected'},
  sessionGrab:{name:'Session Liquidity Grab',style:'day',habitat:'any',desc:'MM: the Judas swing \u2014 NY open takes the prior 12h extreme then reverses back inside (intraday TFs)'},
  fvgFill:{name:'Imbalance Fill',style:'day',habitat:'trend',desc:'MM: return to an unfilled fair-value gap with DECLINING opposing volume \u2192 continuation at the fill'},
  absorption:{name:'Absorption Break',style:'scalp',habitat:'any',desc:'MM/Wyckoff: huge volume + tiny range = someone absorbing; enter the break of the absorption bar'},
  lateBreak:{name:'Late-Breakout Fade',style:'swing',habitat:'range',desc:'anti-retail: 3rd+ test breaks a level on LOWER volume than prior tests \u2014 exhausted chase, fade it'},
  vwapShadow:{name:'VWAP Execution Shadow',style:'day',habitat:'trend',desc:'algo-aligned: entries only within 0.5\u03c3 of VWAP in trend direction \u2014 trade where the big tickets fill'},
  ignition:{name:'Momentum Ignition',style:'scalp',habitat:'any',desc:'algo signature: 3 expanding-volume bars from a quiet base \u2014 join early, never chase past 1.5 ATR'}};
window.SIG_STYLE_TF={scalp:['1m','5m','15m'],day:['15m','30m','1h'],swing:['4h','1d','1w']};
function sigStyleForTF(tf){if(['1m','5m'].includes(tf))return 'scalp';if(['15m','30m','1h'].includes(tf))return 'day';return 'swing'}
/* ===== v29.0 #6 STRATEGY REGISTRY — each strategy is a self-contained detect(ctx,i) => dir. Add #13 by pushing here; sigScan needs no edits. ===== */
window.SIG_DETECT={
  vwapBounce:function(x,i){var st=Math.abs(x.c[i-1]-x.vwap[i-1]);
    if(st<0.6*(x.atr[i]||1e-9))return 0;
    if(x.c[i-1]<x.vwap[i-1]&&x.c[i]>x.c[i-1])return 1;
    if(x.c[i-1]>x.vwap[i-1]&&x.c[i]<x.c[i-1])return -1;return 0},
  rsiExtreme:function(x,i){var r=x.rsi;if((r[i-1]||50)<25&&(r[i]||50)>=30)return 1;if((r[i-1]||50)>75&&(r[i]||50)<=70)return -1;return 0},
  bbSnap:function(x,i){var up1=x.mean20[i-1]+2*x.sd20[i-1],lo1=x.mean20[i-1]-2*x.sd20[i-1];
    var up0=x.mean20[i]+2*x.sd20[i],lo0=x.mean20[i]-2*x.sd20[i];
    if(x.c[i-1]<lo1&&x.c[i]>lo0)return 1;if(x.c[i-1]>up1&&x.c[i]<up0)return -1;return 0},
  emaPull:function(x,i){var c=x.c;if(x.e50[i]>x.e200[i]&&c[i]>x.e20[i]&&c[i-1]<=x.e20[i-1]&&(x.rsi[i-1]||50)<45)return 1;
    if(x.e50[i]<x.e200[i]&&c[i]<x.e20[i]&&c[i-1]>=x.e20[i-1]&&(x.rsi[i-1]||50)>55)return -1;return 0},
  momFlip:function(x,i){var f=function(k){return ((x.e20[k]>x.e50[k])?1:-1)+(((x.rsi[k]||50)>50)?1:-1)+(((x.macd.hist[k]||0)>=0)?1:-1)};
    var s0=f(i),s1=f(i-1);if(s0>=2&&s1<2)return 1;if(s0<=-2&&s1>-2)return -1;return 0},
  orb:function(x,i){var k=x.dayOf(x.d[i].t),r=x.dayRange[k];if(!r||x.idxInDay[i]<6)return 0;
    if(x.c[i]>r.firstHi&&x.c[i-1]<=r.firstHi)return 1;if(x.c[i]<r.firstLo&&x.c[i-1]>=r.firstLo)return -1;return 0},
  pdBreak:function(x,i){var pk=x.dayOf(x.d[i].t)-1,pr=x.dayRange[pk];if(!pr||pr.hi===-1e18)return 0;
    if(x.c[i]>pr.hi&&x.c[i-1]<=pr.hi)return 1;if(x.c[i]<pr.lo&&x.c[i-1]>=pr.lo)return -1;return 0},
  stFlip:function(x,i){if(x.st.dir[i]===1&&x.st.dir[i-1]===-1)return 1;if(x.st.dir[i]===-1&&x.st.dir[i-1]===1)return -1;return 0},
  smcChoch:function(x,i){var d=x.d,c=x.c;var ls=x.lastSwing(i,false),ll=x.lastSwing(i,true);
    if(ll!=null&&c[i]<d[ll].l&&c[i-1]>=d[ll].l)return -1;if(ls!=null&&c[i]>d[ls].h&&c[i-1]<=d[ls].h)return 1;return 0},
  donchian:function(x,i){if(x.dc20hi[i]===-1e18)return 0;
    if(x.c[i]>x.dc20hi[i]&&x.c[i-1]<=x.dc20hi[i-1])return 1;if(x.c[i]<x.dc20lo[i]&&x.c[i-1]>=x.dc20lo[i-1])return -1;return 0},
  goldenX:function(x,i){if(x.e50[i]>x.e200[i]&&x.e50[i-1]<=x.e200[i-1])return 1;if(x.e50[i]<x.e200[i]&&x.e50[i-1]>=x.e200[i-1])return -1;return 0},
  macdZero:function(x,i){var m=x.macd.m;if((m[i]||0)>0&&(m[i-1]||0)<=0)return 1;if((m[i]||0)<0&&(m[i-1]||0)>=0)return -1;return 0},
  liqSweep:(C,i)=>{const lo=C.touchesOf(i,true),hi=C.touchesOf(i,false);
    if(lo.idx!=null&&C.d[i].l<lo.p&&C.c[i]>lo.p&&C.c[i-1]>=C.d[i-1].l&&C.d[i-1].l>=lo.p)return 1;
    if(lo.idx!=null&&C.d[i-1].l<lo.p&&C.c[i]>lo.p&&C.c[i-1]<=lo.p)return 1;
    if(hi.idx!=null&&((C.d[i].h>hi.p&&C.c[i]<hi.p)||(C.d[i-1].h>hi.p&&C.c[i-1]<=hi.p&&C.c[i]<hi.p)))return -1;return 0},
  cvdDiv:(C,i)=>{if(i<32)return 0;const ph=Math.max(...C.c.slice(i-11,i+1)),php=Math.max(...C.c.slice(i-27,i-11));
    const ch=Math.max(...C.cvdP.slice(i-11,i+1)),chp=Math.max(...C.cvdP.slice(i-27,i-11));
    const pl=Math.min(...C.c.slice(i-11,i+1)),plp=Math.min(...C.c.slice(i-27,i-11));
    const cl=Math.min(...C.cvdP.slice(i-11,i+1)),clp=Math.min(...C.cvdP.slice(i-27,i-11));
    const nearHi=C.c[i]>C.dc20hi[i-1]*0.995,nearLo=C.c[i]<C.dc20lo[i-1]*1.005;
    if(ph>php&&ch<chp&&nearHi&&C.c[i]<C.c[i-1])return -1;
    if(pl<plp&&cl>clp&&nearLo&&C.c[i]>C.c[i-1])return 1;return 0},
  failedBreak:(C,i)=>{if(i<24)return 0;
    if(C.c[i-2]>C.dc20hi[i-3]&&C.c[i]<C.dc20hi[i-3])return -1;
    if(C.c[i-2]<C.dc20lo[i-3]&&C.c[i]>C.dc20lo[i-3])return 1;return 0},
  compBreak:(C,i)=>{if(i<15)return 0;let comp=true;for(let k=i-10;k<i;k++)if(C.bbWPctl[k]>=15){comp=false;break}
    if(!comp||(C.d[i].v||0)<1.5*(C.volAvg20[i]||1))return 0;
    if(C.c[i]>C.mean20[i]+2*C.sd20[i])return 1;if(C.c[i]<C.mean20[i]-2*C.sd20[i])return -1;return 0},
  htfPull:(C,i)=>{if(!C.htf)return 0;const hE=C.htf.e20[C.htf.e20.length-1],a=C.atr[i]||1;
    if(C.htf.dir===1&&Math.abs(C.d[i].l-hE)<=0.5*a&&C.c[i]>C.c[i-1]&&C.c[i]>C.d[i].o)return 1;
    if(C.htf.dir===-1&&Math.abs(C.d[i].h-hE)<=0.5*a&&C.c[i]<C.c[i-1]&&C.c[i]<C.d[i].o)return -1;return 0},
  ensemble:(C,i)=>{if(!C.others)return 0;const up=C.others[i+'_1']||0,dn=C.others[i+'_-1']||0;
    if(up>=3&&up>dn)return 1;if(dn>=3&&dn>up)return -1;return 0},
  stopRun:(C,i)=>{const lo=C.touchesOf(i,true),hi=C.touchesOf(i,false);const v=C.d[i].v||0,va=C.volAvg20[i]||1;
    if(lo.idx!=null&&lo.t>=2&&C.d[i-1].l<lo.p&&(C.d[i-1].v||0)>1.2*va&&C.c[i]>lo.p)return 1;
    if(hi.idx!=null&&hi.t>=2&&C.d[i-1].h>hi.p&&(C.d[i-1].v||0)>1.2*va&&C.c[i]<hi.p)return -1;return 0},
  eqRaid:(C,i)=>{const lo=C.touchesOf(i,true),hi=C.touchesOf(i,false);
    if(hi.idx!=null&&hi.eq&&C.d[i].h>hi.p&&C.c[i]<hi.p)return -1;
    if(lo.idx!=null&&lo.eq&&C.d[i].l<lo.p&&C.c[i]>lo.p)return 1;return 0},
  sessionGrab:(C,i)=>{const hr=new Date(C.d[i].t).getUTCHours();if(hr<12||hr>=14)return 0;
    const ex=C.prevExt(i);if(!isFinite(ex.hi))return 0;
    if(C.d[i].h>ex.hi&&C.c[i]<ex.hi)return -1;if(C.d[i].l<ex.lo&&C.c[i]>ex.lo)return 1;return 0},
  fvgFill:(C,i)=>{try{const fv=(IND._fvg||[]).filter(f=>!f.filled&&f.i<i-2).slice(-3);
    const declining=(C.d[i].v||0)<(C.d[i-1].v||0)&&(C.d[i-1].v||0)<(C.d[i-2].v||0);
    if(!declining)return 0;
    for(const f of fv){const mid=(f.top+f.bot)/2;
      if(f.type==='bull'&&C.d[i].l<=f.top&&C.d[i].l>=f.bot&&C.c[i]>mid)return 1;
      if(f.type==='bear'&&C.d[i].h>=f.bot&&C.d[i].h<=f.top&&C.c[i]<mid)return -1;}}catch(e){}return 0},
  absorption:(C,i)=>{if(i<21)return 0;const pb=C.d[i-1];const a=C.atr[i-1]||1;
    if((pb.v||0)>2*(C.volAvg20[i-1]||1)&&(pb.h-pb.l)<0.5*a){
      if(C.c[i]>pb.h)return 1;if(C.c[i]<pb.l)return -1;}return 0},
  lateBreak:(C,i)=>{const hi=C.touchesOf(i,false),lo=C.touchesOf(i,true);const v=C.d[i].v||0;
    if(hi.idx!=null&&hi.t>=3&&C.c[i]>hi.p){const tv=(C.d[hi.idx].v||1);if(v<0.8*tv)return -1}
    if(lo.idx!=null&&lo.t>=3&&C.c[i]<lo.p){const tv=(C.d[lo.idx].v||1);if(v<0.8*tv)return 1}return 0},
  vwapShadow:(C,i)=>{const near=Math.abs(C.c[i]-C.vwap[i])<=0.5*(C.sd20[i]||1);if(!near)return 0;
    if(C.e50[i]>C.e200[i]&&C.c[i]>C.vwap[i]&&C.c[i-1]<=C.vwap[i-1])return 1;
    if(C.e50[i]<C.e200[i]&&C.c[i]<C.vwap[i]&&C.c[i-1]>=C.vwap[i-1])return -1;return 0},
  ignition:(C,i)=>{if(i<15)return 0;
    const up=C.c[i]>C.d[i].o&&C.c[i-1]>C.d[i-1].o&&C.c[i-2]>C.d[i-2].o;
    const dn=C.c[i]<C.d[i].o&&C.c[i-1]<C.d[i-1].o&&C.c[i-2]<C.d[i-2].o;
    const expV=(C.d[i].v||0)>(C.d[i-1].v||0)&&(C.d[i-1].v||0)>(C.d[i-2].v||0);
    if(!expV||(!up&&!dn))return 0;
    let baseHi=-1e18,baseLo=1e18;for(let k=i-13;k<i-3;k++){baseHi=Math.max(baseHi,C.d[k].h);baseLo=Math.min(baseLo,C.d[k].l)}
    const a=C.atr[i]||1;if((baseHi-baseLo)>1.6*a)return 0;
    const mid=(baseHi+baseLo)/2;if(Math.abs(C.c[i]-mid)>1.5*a)return 0;
    return up?1:-1}};
