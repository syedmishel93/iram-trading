function indicatorAccuracy(d,hz=5){
  const n=d.length;if(n<120)return null;
  const c=d.map(x=>x.c);
  const e50=IND.ema(c,50),e200=IND.ema(c,200),st=IND.supertrend(d),ar=IND.aroon(d),vt=IND.vortex(d);
  const rsi=IND.rsi(c),mac=IND.macd(c).hist,cci=IND.cci(d),tsi=IND.tsi(c),ult=IND.ult(d),ao=IND.ao(d),roc=IND.roc(c);
  const mfi=IND.mfi(d),cmf=IND.cmf(d),obv=IND.obv(d),flux=IND.flux(d),bb=IND.boll(c),don=IND.donchian(d);
  const V={
    'EMA 50/200':i=>e50[i]>e200[i]?1:-1,
    'Price vs EMA200':i=>c[i]>e200[i]?1:-1,
    'Supertrend':i=>st.dir&&st.dir[i]>0?1:-1,
    'Aroon':i=>ar.up[i]!=null?(ar.up[i]>ar.dn[i]?1:-1):0,
    'Vortex':i=>vt.vp[i]!=null?(vt.vp[i]>vt.vm[i]?1:-1):0,
    'RSI':i=>rsi[i]==null?0:rsi[i]>55?1:rsi[i]<45?-1:0,
    'MACD':i=>mac[i]==null?0:mac[i]>0?1:-1,
    'CCI':i=>cci[i]==null?0:cci[i]>100?1:cci[i]<-100?-1:0,
    'TSI':i=>tsi[i]==null?0:tsi[i]>0?1:-1,
    'Ultimate':i=>ult[i]==null?0:ult[i]>50?1:-1,
    'Awesome':i=>ao[i]==null?0:ao[i]>0?1:-1,
    'ROC':i=>roc[i]==null?0:roc[i]>0?1:-1,
    'Bollinger':i=>bb.up[i]==null?0:c[i]>bb.up[i]?-1:c[i]<bb.lo[i]?1:0,
    'Donchian':i=>don.up[i]==null?0:c[i]>=don.up[i]?1:c[i]<=don.lo[i]?-1:0,
    'MFI':i=>mfi[i]==null?0:mfi[i]>55?1:mfi[i]<45?-1:0,
    'CMF':i=>cmf[i]==null?0:cmf[i]>0.05?1:cmf[i]<-0.05?-1:0,
    'OBV slope':i=>i>5?(obv[i]>obv[i-5]?1:-1):0,
    'Kinetic Flux':i=>flux[i]==null?0:flux[i]>0?1:-1
  };
  const start=Math.max(60,n-260),acc={};
  for(const name in V){let w=0,t=0;for(let i=start;i<n-hz;i++){const v=V[name](i);if(!v)continue;t++;if(Math.sign(c[i+hz]-c[i])===Math.sign(v))w++}acc[name]=t>=20?w/t:null}
  return acc;
}
/* ================= quantum-inspired annealing (simulated annealing — honest: a classical
   heuristic inspired by quantum annealing, NOT quantum hardware) =================
   Optimizes the consensus category weights (trend/momentum/volatility/volume) to maximize
   historical directional hit-rate on this instrument. */
function annealCategoryWeights(d,iters=350){
  if(d.length<160)return null;
  const n=d.length,c=d.map(x=>x.c),hz=5;
  const e50=IND.ema(c,50),e200=IND.ema(c,200),mac=IND.macd(c).hist,bb=IND.boll(c),mfi=IND.mfi(d);
  const cat=i=>({trend:e50[i]>e200[i]?1:-1,momentum:mac[i]==null?0:(mac[i]>0?1:-1),volatility:bb.up[i]==null?0:(c[i]>bb.up[i]?-1:c[i]<bb.lo[i]?1:0),volume:mfi[i]==null?0:(mfi[i]>55?1:mfi[i]<45?-1:0)});
  const start=Math.max(60,n-240),samples=[];for(let i=start;i<n-hz;i++)samples.push({v:cat(i),dir:Math.sign(c[i+hz]-c[i])});
  const score=w=>{let hit=0,t=0;samples.forEach(s=>{const sig=Math.sign(w.trend*s.v.trend+w.momentum*s.v.momentum+w.volatility*s.v.volatility+w.volume*s.v.volume);if(!sig||!s.dir)return;t++;if(sig===s.dir)hit++});return t?hit/t:0};
  let cur={trend:1,momentum:1,volatility:1,volume:1},curS=score(cur),best={...cur},bestS=curS;
  const keys=['trend','momentum','volatility','volume'];const r=mulberry32(1234+n);
  for(let k=0;k<iters;k++){const T=1-k/iters;const cand={...cur};const key=keys[(r()*4)|0];cand[key]=Math.max(0.1,Math.min(2.5,cand[key]+(r()-0.5)*0.6*(0.3+T)));const s=score(cand);if(s>curS||r()<Math.exp((s-curS)/(0.02*T+1e-4))){cur=cand;curS=s}if(curS>bestS){best={...cur};bestS=curS}}
  const base=score({trend:1,momentum:1,volatility:1,volume:1});
  return {weights:Object.fromEntries(keys.map(k=>[k,+best[k].toFixed(2)])),hit_rate:+(bestS*100).toFixed(1),baseline:+(base*100).toFixed(1),samples:samples.length};
}
/* ================= multi-indicator consensus (combines the pack into one accuracy-weighted, outlier-filtered signal) ================= */
function consensusSignal(d,acc){
  if(d.length<60)return {score:0,confidence:0,label:'Neutral',bull:0,bear:0,votes:[],byCat:{trend:0,momentum:0,volatility:0,volume:0},adx:0,tuned:false};
  if(acc===undefined)acc=(typeof DATA!=='undefined'&&d===DATA&&IND._acc)?IND._acc:null;
  const n=d.length-1,c=d.map(x=>x.c),votes=[],V=(name,cat,vote)=>votes.push({name,cat,vote});
  const e50=IND.ema(c,50),e200=IND.ema(c,200),st=IND.supertrend(d),ar=IND.aroon(d),vt=IND.vortex(d),adx=IND.adx(d)[n]||18;
  V('EMA 50/200','trend',e50[n]>e200[n]?1:-1);V('Price vs EMA200','trend',c[n]>e200[n]?1:-1);
  V('Supertrend','trend',st.dir&&st.dir[n]>0?1:-1);V('Aroon','trend',ar.up[n]>ar.dn[n]?1:-1);V('Vortex','trend',vt.vp[n]>vt.vm[n]?1:-1);
  const rsi=IND.rsi(c)[n],mh=IND.macd(c).hist[n],cci=IND.cci(d)[n],tsi=IND.tsi(c)[n],ult=IND.ult(d)[n],ao=IND.ao(d)[n],roc=IND.roc(c)[n];
  V('RSI','momentum',rsi>55?1:rsi<45?-1:0);V('MACD','momentum',mh>0?1:-1);V('CCI','momentum',cci>100?1:cci<-100?-1:cci>0?0.5:-0.5);
  V('TSI','momentum',tsi>0?1:-1);V('Ultimate','momentum',ult>50?1:-1);V('Awesome','momentum',ao>0?1:-1);V('ROC','momentum',roc>0?1:-1);
  const bb=IND.boll(c),z=IND.zscore(c)[n],don=IND.donchian(d);
  V('Bollinger','volatility',c[n]>bb.up[n]?-1:c[n]<bb.lo[n]?1:0);V('Z-score','volatility',z>2?-1:z<-2?1:0);V('Donchian','trend',c[n]>=don.up[n]?1:c[n]<=don.lo[n]?-1:0);
  const mfi=IND.mfi(d)[n],cmf=IND.cmf(d)[n],obv=IND.obv(d),flux=IND.flux(d)[n];
  V('MFI','volume',mfi>55?1:mfi<45?-1:0);V('CMF','volume',cmf>0.05?1:cmf<-0.05?-1:0);V('OBV slope','volume',obv[n]>obv[n-5]?1:-1);V('Kinetic Flux','volume',flux>0?1:-1);
  const gate=adx>20?1:0.6;let sum=0,wsum=0;const dirs=[];
  const accMul=name=>{if(!acc||acc[name]==null)return 1;return Math.max(0.4,Math.min(1.6,acc[name]*2))};   // 50% hit-rate → ×1, 30% → ×0.6, 75% → ×1.5
  votes.forEach(v=>{const base=(v.cat==='trend'?1.2*gate:v.cat==='momentum'?1:v.cat==='volume'?0.9:0.8);const w=base*accMul(v.name);v.acc=acc&&acc[v.name]!=null?+(acc[v.name]*100).toFixed(0):null;v.w=+w.toFixed(2);sum+=v.vote*w;wsum+=w;if(v.vote!==0)dirs.push(Math.sign(v.vote))});
  const score=Math.max(-100,Math.min(100,sum/(wsum||1)*100));
  const bull=dirs.filter(x=>x>0).length,bear=dirs.filter(x=>x<0).length,tot=bull+bear||1;
  const confidence=Math.round(Math.abs(bull-bear)/tot*100);
  const label=score>25?'Strong Buy':score>8?'Buy':score<-25?'Strong Sell':score<-8?'Sell':'Neutral';
  const byCat=cat=>{const cv=votes.filter(v=>v.cat===cat);return +(cv.reduce((a,v)=>a+v.vote,0)/(cv.length||1)).toFixed(2)};
  return {score:+score.toFixed(0),confidence,label,bull,bear,votes,byCat:{trend:byCat('trend'),momentum:byCat('momentum'),volatility:byCat('volatility'),volume:byCat('volume')},adx:+adx.toFixed(0),tuned:!!acc};
}

/* ---------- auto chart-pattern detection (heuristic, glass-box) ---------- */
function detectPatterns(d){
  const sw=swings(d,3);const H=sw.hi.slice(-6),L=sw.lo.slice(-6);const out=[];const near=(a,b,t)=>Math.abs(a-b)/((a+b)/2)<t;
  // Double top / bottom
  if(H.length>=2){const a=H[H.length-2],b=H[H.length-1];const between=L.filter(i=>i>a&&i<b);if(between.length&&near(d[a].h,d[b].h,0.012)&&(Math.min(d[a].h,d[b].h)-d[between[0]].l)/d[a].h>0.012){out.push({type:'Double Top',dir:'bear',conf:0.7,pts:[{i:a,p:d[a].h},{i:b,p:d[b].h}],neck:d[between[0]].l})}}
  if(L.length>=2){const a=L[L.length-2],b=L[L.length-1];const between=H.filter(i=>i>a&&i<b);if(between.length&&near(d[a].l,d[b].l,0.012)&&(d[between[0]].h-Math.max(d[a].l,d[b].l))/d[a].l>0.012){out.push({type:'Double Bottom',dir:'bull',conf:0.7,pts:[{i:a,p:d[a].l},{i:b,p:d[b].l}],neck:d[between[0]].h})}}
  // Head & shoulders (bear) / inverse (bull)
  if(H.length>=3){const [l,h,r]=[H[H.length-3],H[H.length-2],H[H.length-1]];if(d[h].h>d[l].h*1.012&&d[h].h>d[r].h*1.012&&near(d[l].h,d[r].h,0.02)){out.push({type:'Head & Shoulders',dir:'bear',conf:0.6,pts:[{i:l,p:d[l].h},{i:h,p:d[h].h},{i:r,p:d[r].h}]})}}
  if(L.length>=3){const [l,h,r]=[L[L.length-3],L[L.length-2],L[L.length-1]];if(d[h].l<d[l].l*0.988&&d[h].l<d[r].l*0.988&&near(d[l].l,d[r].l,0.02)){out.push({type:'Inverse H&S',dir:'bull',conf:0.6,pts:[{i:l,p:d[l].l},{i:h,p:d[h].l},{i:r,p:d[r].l}]})}}
  // Trendline structures: triangles, wedges, channels, rectangle (each carries two trendlines for rendering)
  if(H.length>=2&&L.length>=2){
    const h0=H[H.length-2],h1=H[H.length-1],l0=L[L.length-2],l1=L[L.length-1];
    const hs=(d[h1].h-d[h0].h)/((h1-h0)||1),ls=(d[l1].l-d[l0].l)/((l1-l0)||1);
    const lines=[{a:{i:h0,p:d[h0].h},b:{i:h1,p:d[h1].h}},{a:{i:l0,p:d[l0].l},b:{i:l1,p:d[l1].l}}];
    const lp={i:h1,p:d[h1].h};
    const flatH=Math.abs(hs)<d[h1].h*8e-5,flatL=Math.abs(ls)<d[l1].l*8e-5;
    const parallel=Math.abs(hs-ls)<(Math.abs(hs)+Math.abs(ls))/2*0.35;
    let pat=null;
    if(hs<0&&ls>0)pat=['Symmetrical Triangle','neutral',0.5];
    else if(flatH&&ls>0)pat=['Ascending Triangle','bull',0.55];
    else if(hs<0&&flatL)pat=['Descending Triangle','bear',0.55];
    else if(hs>0&&ls>0&&ls>hs*1.25&&!parallel)pat=['Rising Wedge','bear',0.55];
    else if(hs<0&&ls<0&&hs<ls*1.25&&!parallel)pat=['Falling Wedge','bull',0.55];
    else if(hs>0&&ls>0&&parallel)pat=['Ascending Channel','bull',0.5];
    else if(hs<0&&ls<0&&parallel)pat=['Descending Channel','bear',0.5];
    else if(flatH&&flatL)pat=['Rectangle (range)','neutral',0.45];
    if(pat)out.push({type:pat[0],dir:pat[1],conf:pat[2],pts:[],lines,lp});
  }
  return out.slice(-3);
}

/* ---------- full trade calculator (TradingPro formulas) ---------- */
function calcCompute(){
  const g=id=>+document.getElementById(id).value;const sym=document.getElementById('kSym').value;
  const sp=sym==='CUSTOM'?{name:'Custom',cls:'manual',pip:g('kMpip')||0.0001,contract:g('kMcontract')||1,dpp:g('kMdpp')||1,px:g('kEntry')||0}:(SPECS[sym]||SPECS.EURUSD);
  const bal=g('kBal'),eq=g('kEq'),lev=g('kLev'),riskPct=g('kRisk');
  const dir=document.getElementById('kDir').value;const entry=g('kEntry'),sl=g('kSL'),tp=g('kTP'),lot=g('kLot');
  const spread=g('kSpread'),comm=g('kComm'),swap=g('kSwap'),nights=g('kNights'),slip=g('kSlip');
  const slPips=Math.abs(entry-sl)/sp.pip, tpPips=Math.abs(tp-entry)/sp.pip;
  const rr=slPips?tpPips/slPips:0;const perPip=sp.dpp*lot;
  const riskAmt=bal*riskPct/100;const recLot=slPips?riskAmt/(slPips*sp.dpp):0;
  const grossP=lot*tpPips*sp.dpp, grossL=lot*slPips*sp.dpp;
  const margin=entry*lot*sp.contract/lev;const freeM=eq-margin;const mLevel=margin?eq/margin*100:0;
  const canOpen=margin<=eq;
  const slDist=Math.abs(entry-sl);const s=dir==='Buy'?1:-1;
  const tp1=entry+s*slDist, tp2=entry+s*rr*slDist, tp3=entry+s*3*slDist;
  // costs
  const spreadCost=spread*perPip, commCost=comm*lot*2, swapCost=swap*nights, slipCost=slip*perPip;
  const totalCost=spreadCost+commCost+swapCost+slipCost;
  const netP=grossP-totalCost, netL=grossL+totalCost;
  const netRR=netL?Math.abs(netP)/Math.abs(netL):0;const beoPips=perPip?totalCost/perPip:0;const cutPct=grossP?totalCost/grossP*100:0;
  const rrQ=rr>=2?['GOOD','up']:rr>=1?['FAIR','']:['POOR','dn'];
  const lotChk=lot<=recLot*1.05?['WITHIN limit','up']:['OVER limit — reduce lots','dn'];
  const mChk=mLevel>=200?['SAFE (>200%)','up']:mLevel>=100?['TIGHT','']:['DANGER (<100%)','dn'];
  const box=(k,v,c='')=>`<div class="stat"><div class="k">${k}</div><div class="v ${c} mono">${v}</div></div>`;
  const money=n=>(n<0?'-$':'$')+Math.abs(n).toLocaleString(undefined,{maximumFractionDigits:2});
  document.getElementById('kSpecs').innerHTML=`contract <b style="color:var(--txt)">${sp.contract.toLocaleString()}</b> · pip <b style="color:var(--txt)">${sp.pip}</b> · $/pip per lot <b style="color:var(--txt)">${sp.dpp}</b>`;
  document.getElementById('calcOut').innerHTML=`
    <div class="stat-grid" style="grid-template-columns:repeat(4,1fr)">
      ${box('SL distance',slPips.toFixed(1)+' pips')}${box('TP distance',tpPips.toFixed(1)+' pips')}${box('Risk : Reward',rr.toFixed(2),rr>=2?'up':rr>=1?'':'dn')}${box('Risk amount',money(riskAmt))}
      ${box('Recommended lot',recLot.toFixed(3),'up')}${box('Your lot',lot.toFixed(2),lot<=recLot*1.05?'up':'dn')}${box('Gross profit @TP',money(grossP),'up')}${box('Gross loss @SL',money(-grossL),'dn')}
    </div>
    <div class="grid2">
      <div class="panelbox"><h4>Margin</h4><table class="log"><tbody>
        <tr><td>Margin required</td><td class="mono" style="text-align:right">${money(margin)}</td></tr>
        <tr><td>Free margin after</td><td class="mono" style="text-align:right">${money(freeM)}</td></tr>
        <tr><td>Margin level</td><td class="mono ${mChk[1]}" style="text-align:right">${mLevel.toFixed(0)}%</td></tr>
        <tr><td>Can open trade?</td><td class="mono ${canOpen?'up':'dn'}" style="text-align:right">${canOpen?'YES':'NO — insufficient'}</td></tr>
      </tbody></table></div>
      <div class="panelbox"><h4>Take-profit ladder</h4><table class="log"><tbody>
        <tr><td>TP1 · 1:1 (quick)</td><td class="mono" style="text-align:right">${tp1.toFixed(sp.pip<0.01?4:2)}</td></tr>
        <tr><td>TP2 · ${rr.toFixed(1)}:1 (target)</td><td class="mono up" style="text-align:right">${tp2.toFixed(sp.pip<0.01?4:2)}</td></tr>
        <tr><td>TP3 · 3:1 (stretch)</td><td class="mono" style="text-align:right">${tp3.toFixed(sp.pip<0.01?4:2)}</td></tr>
      </tbody></table></div>
    </div>
    <div class="panelbox" style="margin-top:16px"><h4>Net P/L after broker costs</h4>
      <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:0">
        ${box('Total cost',money(totalCost),'dn')}${box('Net profit @TP',money(netP),netP>0?'up':'dn')}${box('Net loss @SL',money(-netL),'dn')}${box('Effective net R:R',netRR.toFixed(2),netRR>=2?'up':netRR>=1?'':'dn')}
        ${box('Break-even',beoPips.toFixed(1)+' pips')}${box('Broker cut',cutPct.toFixed(1)+'% of TP',cutPct<20?'':'dn')}${box('Spread+slip',money(spreadCost+slipCost),'dn')}${box('Commission',money(commCost),'dn')}
      </div>
    </div>
    <div class="panelbox" style="margin-top:16px"><h4>Verdict</h4>
      <div style="display:flex;gap:24px;flex-wrap:wrap;font-size:13px">
        <div>R:R quality <b class="${rrQ[1]}">${rrQ[0]}</b></div>
        <div>Lot size <b class="${lotChk[1]}">${lotChk[0]}</b></div>
        <div>Margin <b class="${mChk[1]}">${mChk[0]}</b></div>
      </div></div>`;
}
