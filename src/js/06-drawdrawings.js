function drawDrawings(g){if(!RENDER)return;const {W,padR,priceH}=RENDER;g.save();g.beginPath();g.rect(0,0,W-padR,priceH);g.clip();const all=drawPreview?[...DRAWINGS,drawPreview]:DRAWINGS;all.forEach(d=>renderOne(g,d));highlightSelected(g);g.restore()}
function renderOne(g,d){if(d&&d.hidden)return;const {W,padR}=RENDER;const C='#4C82FB';g.lineWidth=1.6;g.font='9px JetBrains Mono';g.textAlign='left';
  if(d.type==='trend'){g.strokeStyle=C;g.beginPath();g.moveTo(bx(d.a.bar),byP(d.a.price));g.lineTo(bx(d.b.bar),byP(d.b.price));g.stroke()}
  else if(d.type==='ray'){g.strokeStyle=C;const x1=bx(d.a.bar),y1=byP(d.a.price),x2=bx(d.b.bar),y2=byP(d.b.price);const dx=(x2-x1)||0.001,dy=y2-y1;g.beginPath();g.moveTo(x1,y1);if(dx>0){const t=(W-padR-x1)/dx;g.lineTo(W-padR,y1+dy*t)}else g.lineTo(x2,y2);g.stroke()}
  else if(d.type==='hline'){g.strokeStyle=C;const yy=byP(d.price);g.beginPath();g.moveTo(0,yy);g.lineTo(W-padR,yy);g.stroke();g.fillStyle=C;g.fillText(fmt(d.price),4,yy-4)}
  else if(d.type==='rect'){const x1=bx(d.a.bar),y1=byP(d.a.price),x2=bx(d.b.bar),y2=byP(d.b.price);g.fillStyle='rgba(76,130,251,.1)';g.fillRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1));g.strokeStyle=C;g.strokeRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1))}
  else if(d.type==='fib'){const pHi=Math.max(d.a.price,d.b.price),pLo=Math.min(d.a.price,d.b.price);const L=Math.min(bx(d.a.bar),bx(d.b.bar));const levels=[0,0.236,0.382,0.5,0.618,0.786,1],cols=['#F0616D','#E8A33D','#E8A33D','#7A8494','#2DBE8E','#2DBE8E','#4C82FB'];levels.forEach((lv,i)=>{const p=pHi-lv*(pHi-pLo),yy=byP(p);g.strokeStyle=cols[i];g.globalAlpha=.7;g.beginPath();g.moveTo(L,yy);g.lineTo(W-padR,yy);g.stroke();g.globalAlpha=1;g.fillStyle=cols[i];g.fillText(`${(lv*100).toFixed(1)}%  ${fmt(p)}`,L+3,yy-3)})}
  else if(d.type==='brush'){g.strokeStyle=C;g.beginPath();(d.points||[]).forEach((pt,i)=>{const px=bx(pt.bar),py=byP(pt.price);i?g.lineTo(px,py):g.moveTo(px,py)});g.stroke()}
  else if(d.type==='text'){g.fillStyle='#D4DAE3';g.font='12px Inter';g.fillText(d.text,bx(d.bar),byP(d.price))}
  else if(d.type==='measure'){const x1=bx(d.a.bar),y1=byP(d.a.price),x2=bx(d.b.bar),y2=byP(d.b.price);const up=d.b.price>=d.a.price,col=up?var_bull():var_bear();g.strokeStyle=col;g.setLineDash([4,3]);g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();g.setLineDash([]);const dp=d.b.price-d.a.price,pct=dp/(d.a.price||1)*100,bars=Math.round(d.b.bar-d.a.bar);const lbl=`${dp>=0?'+':''}${fmt(dp)} (${pct>=0?'+':''}${pct.toFixed(2)}%) · ${Math.abs(bars)} bars`;const tw=g.measureText(lbl).width;g.fillStyle=col;g.fillRect((x1+x2)/2-tw/2-4,(y1+y2)/2-9,tw+8,15);g.fillStyle='#0B0E14';g.fillText(lbl,(x1+x2)/2-tw/2,(y1+y2)/2+1.5)}
  else if(d.type==='vline'){const xx=bx(d.bar);g.strokeStyle=C;g.beginPath();g.moveTo(xx,0);g.lineTo(xx,RENDER.priceH);g.stroke()}
  else if(d.type==='avwap'){const arr=avwapFrom(d.bar);try{const B=avwapBandsFrom(d.bar);const seg=(hiA,loA,al)=>{g.beginPath();let mm=false;for(let i=Math.max(RENDER.start,Math.round(d.bar));i<DATA.length;i++){const v=hiA[i];if(v==null)continue;const X=bx(i),Y=byP(v);if(X<0){mm=false;continue}if(X>W-padR)break;if(!mm){g.moveTo(X,Y);mm=true}else g.lineTo(X,Y)}for(let i=DATA.length-1;i>=Math.max(RENDER.start,Math.round(d.bar));i--){const v=loA[i];if(v==null)continue;const X=bx(i),Y=byP(v);if(X<0)continue;if(X>W-padR)continue;g.lineTo(X,Y)}g.closePath();g.fillStyle='rgba(232,163,61,'+al+')';g.fill()};seg(B.u2,B.l2,0.05);seg(B.u1,B.l1,0.08);}catch(e){}g.strokeStyle='#E8A33D';g.lineWidth=1.7;g.setLineDash([]);g.beginPath();let m=false;for(let i=Math.max(RENDER.start,Math.round(d.bar));i<DATA.length;i++){const v=arr[i];if(v==null)continue;const X=bx(i),Y=byP(v);if(X<0){m=false;continue}if(X>W-padR)break;if(!m){g.moveTo(X,Y);m=true}else g.lineTo(X,Y)}g.stroke();const aX=bx(Math.round(d.bar));if(aX>=0&&aX<=W-padR){g.strokeStyle='rgba(232,163,61,.55)';g.setLineDash([2,3]);g.beginPath();g.moveTo(aX,0);g.lineTo(aX,RENDER.priceH);g.stroke();g.setLineDash([]);g.fillStyle='#E8A33D';g.font='9px Inter';g.textAlign='left';g.fillText('aVWAP',aX+3,12)}}
  else if(d.type==='arrow'){const x1=bx(d.a.bar),y1=byP(d.a.price),x2=bx(d.b.bar),y2=byP(d.b.price);g.strokeStyle=C;g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();const ang=Math.atan2(y2-y1,x2-x1),ah=9;g.beginPath();g.moveTo(x2,y2);g.lineTo(x2-ah*Math.cos(ang-0.42),y2-ah*Math.sin(ang-0.42));g.moveTo(x2,y2);g.lineTo(x2-ah*Math.cos(ang+0.42),y2-ah*Math.sin(ang+0.42));g.stroke()}
  else if(d.type==='long'||d.type==='short'){const isL=d.type==='long';const entry=d.a.price,target=d.b.price;const stop=entry-(target-entry);const xe=bx(d.a.bar),xb=bx(d.b.bar);const xL=Math.min(xe,xb),xW=Math.max(46,Math.abs(xb-xe));const yE=byP(entry),yT=byP(target),yS=byP(stop);g.fillStyle=isL?'rgba(45,190,142,.15)':'rgba(45,190,142,.15)';g.fillRect(xL,Math.min(yE,yT),xW,Math.abs(yT-yE));g.fillStyle='rgba(240,97,109,.15)';g.fillRect(xL,Math.min(yE,yS),xW,Math.abs(yS-yE));g.strokeStyle=var_bull();g.beginPath();g.moveTo(xL,yT);g.lineTo(xL+xW,yT);g.stroke();g.strokeStyle=var_bear();g.beginPath();g.moveTo(xL,yS);g.lineTo(xL+xW,yS);g.stroke();g.strokeStyle='#D4DAE3';g.setLineDash([4,3]);g.beginPath();g.moveTo(xL,yE);g.lineTo(xL+xW,yE);g.stroke();g.setLineDash([]);const rr=Math.abs(target-entry)/(Math.abs(entry-stop)||1);g.fillStyle=var_bull();g.font='9px JetBrains Mono';g.fillText('TP '+fmt(target),xL+xW+3,yT);g.fillStyle=var_bear();g.fillText('SL '+fmt(stop),xL+xW+3,yS);g.fillStyle='#D4DAE3';g.fillText((isL?'LONG':'SHORT')+'  '+rr.toFixed(1)+'R',xL+3,yE-4)}
  g.lineWidth=1;g.setLineDash([])}

function updateReadout(c){const chg=((c.c-c.o)/c.o*100);document.getElementById('readout').innerHTML=
  `<b>${new Date(c.t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</b><br>`+
  `O <b>${fmt(c.o)}</b>  H <b>${fmt(c.h)}</b>  L <b>${fmt(c.l)}</b>  C <b>${fmt(c.c)}</b>  `+
  `<span class="${chg>=0?'up':'dn'}">${chg>=0?'+':''}${chg.toFixed(2)}%</span>  <span style="color:var(--muted2)">Rng ${c.l?((c.h-c.l)/c.l*100).toFixed(2):'0.00'}%</span><br>Vol <b>${(c.v/1e3).toFixed(0)}K</b>`}

function drawLegend(){const n=DATA.length-1,parts=[];window._indParked=window._indParked||[];
  const lgRow=(key,col,label,val)=>`<span class="lg-row"><span style="color:${col}">${label} ${val}</span><span class="lgx" data-ind="${key}" title="remove from chart (re-add from the parked row or Indicators menu)">✕</span></span>`;
  if(ON.has('ema20'))parts.push(lgRow('ema20','#4C82FB','EMA20',fmt(IND._e20[n])));
  if(ON.has('ema50'))parts.push(lgRow('ema50','#E8A33D','EMA50',fmt(IND._e50[n])));
  if(ON.has('ema200'))parts.push(lgRow('ema200','#9B8CFF','EMA200',fmt(IND._e200[n])));
  {const rv=(IND._rsi&&Number.isFinite(+IND._rsi[n]))?+IND._rsi[n]:50;parts.push(`<span style="color:var(--muted)">RSI ${rv.toFixed(0)}</span>`);}
  if(IND._flux){const fv=Number.isFinite(+IND._flux[n])?+IND._flux[n]:0;parts.push(`<span style="color:${fv>=0?'var(--bull)':'var(--bear)'}">FLUX ${fv.toFixed(1)}</span>`);}
  window._indParked.forEach(k=>parts.push(`<span class="lg-row parked" data-readd="${k}" title="click to re-add">${k} ↺</span>`));
  const lg=document.getElementById('legend');lg.innerHTML=parts.join('');
  lg.querySelectorAll('.lgx').forEach(b=>b.onclick=e2=>{e2.stopPropagation();const k=b.dataset.ind;ON.delete(k);if(!window._indParked.includes(k))window._indParked.push(k);
    document.querySelectorAll('[data-ind="'+k+'"]').forEach(el=>{if(el.classList)el.classList.remove('on');if(el.checked!==undefined)el.checked=false});try{recompute();draw()}catch(e){}});
  lg.querySelectorAll('.lg-row.parked').forEach(b=>b.onclick=()=>{const k=b.dataset.readd;ON.add(k);window._indParked=window._indParked.filter(x=>x!==k);
    document.querySelectorAll('[data-ind="'+k+'"]').forEach(el=>{if(el.classList)el.classList.add('on');if(el.checked!==undefined)el.checked=true});try{recompute();draw()}catch(e){}});}

/* ---------- recompute everything for current DATA ---------- */
function recompute(){
  const c=DATA.map(x=>x.c);
  IND._e20=IND.ema(c,20);IND._e50=IND.ema(c,50);IND._e200=IND.ema(c,200);
  IND._rsi=IND.rsi(c);IND._bb=IND.boll(c);IND._st=IND.supertrend(DATA);IND._macd=IND.macd(c);IND._mfi=IND.mfi(DATA);
  const sw=swings(DATA);IND._sw=sw;IND._fvg=detectFVG(DATA);IND._ob=detectOB(DATA,sw);
  IND._sr=detectSR(DATA);IND._bos=detectBOS(DATA,sw);IND._patterns=detectPatterns(DATA);IND._levels=keyLevels(DATA);IND._div=detectDivergence(DATA);IND._idm=detectInducements(DATA,sw);IND._flux=IND.flux(DATA);IND._vwap=IND.vwapBands(DATA);IND._atl=autoTrendlines(DATA);IND._afib=autoFib(DATA);IND._nw=IND.nadaraya(c);IND._pr=IND.predRanges(DATA);IND._divscan=divScanAll(DATA);
  {const ak=CURSYM.sym+'|'+TF;if(!IND._accKey||IND._accKey!==ak||Math.abs(DATA.length-(IND._accLen||0))>=20){IND._accKey=ak;IND._accLen=DATA.length;const snap=DATA;const later=(window.requestIdleCallback||(fn=>setTimeout(fn,60)));later(()=>{if(DATA!==snap&&CURSYM.sym+'|'+TF!==ak)return;IND._acc=indicatorAccuracy(DATA);IND._consensus=consensusSignal(DATA,IND._acc);try{renderAnalytics()}catch(e){}})}}   // heavy 18-indicator replay runs AFTER paint (idle), never blocking the chart
  IND._consensus=consensusSignal(DATA,IND._acc);
  {const key=CURSYM.sym+'|'+TF;if(CON_HIST.key!==key){CON_HIST.key=key;CON_HIST.pts=[]}const pts=CON_HIST.pts;const last=pts[pts.length-1];if(!last||last.t!==DATA[DATA.length-1].t){pts.push({t:DATA[DATA.length-1].t,s:IND._consensus.score});if(pts.length>200)pts.shift()}else last.s=IND._consensus.score}
  const built=buildSignals(DATA);const rep=confluence(built.S);
  renderConfluence(rep);try{renderAttribution()}catch(e){}renderMTF();renderStatus();sizer();markTo();renderQuick();if(document.getElementById('v-paper').classList.contains('on'))renderPaper();
  draw();
  evalAlerts();
  renderStratSignal();
  renderAnalytics();
}

/* ---------- market analytics (desk-style read of the current instrument) ---------- */
/* ---------- AI Desk Analyst: reads the live glass-box analysis and answers in plain language ---------- */
window.judge=function(k,v){ /* I2: every number gets a meaning — glass-box thresholds */
  if(v==null||!isFinite(v))return '';
  const J={
    atrPct:v<0.15?'quiet \u2014 tighter stops work':v<0.6?'normal range':'hot \u2014 widen stops, halve size',
    funding:Math.abs(v)<0.01?'balanced':v>0?'longs pay \u2014 crowded long':'shorts pay \u2014 crowded short',
    volPctile:v>80?'expansion \u2014 breakout conditions':v<25?'compression \u2014 expect a move':'mid-cycle',
    adx:v>=25?'trending \u2014 momentum entries favored':v<18?'ranging \u2014 fade extremes':'transitional',
    corr:Math.abs(v)>0.8?'one trade wearing two hats':'diversified',
    spreadBps:v<2?'tight \u2014 cheap to trade':v<8?'normal':'wide \u2014 costly entries',
    lsRatio:v>1.4?'retail long-heavy \u2014 contrarian caution':v<0.7?'retail short-heavy':'balanced crowd'};
  return J[k]?' \u00b7 <span class="jdg">'+J[k]+'</span>':'';};
function analystContext(){
  const d=DATA,n=d.length-1,c=d.map(x=>x.c),price=c[n];
  let rep={label:'Neutral',score:0};try{rep=confluence(buildSignals(d).S)}catch(e){}
  const rsi=(IND._rsi&&IND._rsi[n])||50,adx=(IND.adx(d)[n]||20),atr=(IND.atr(d)[n]||0);
  const e50=(IND._e50&&IND._e50[n]),e200=(IND._e200&&IND._e200[n]),trend=e50>e200?'up':'down';
  const vwap=IND._vwap?IND._vwap.vw[n]:null,L=IND._levels||{},pr=IND._pr,fib=IND._afib;
  const pats=(IND._patterns||[]).map(p=>p.type);
  let reg={regime:'—',advice:''};try{reg=classifyRegime(d)}catch(e){}
  const con=IND._consensus||consensusSignal(d);
  return {price,rep,rsi,adx,atr,trend,e50,e200,vwap,L,pr,fib,pats,reg,con,acc:IND._acc||null,live:(typeof MODE!=='undefined'&&MODE==='online'),sym:CURSYM.sym,tf:TF,name:CURSYM.name,dec:price<10?4:price<1000?2:0};
}
function analystContextString(){const x=analystContext(),f=v=>v==null?'n/a':(+v).toFixed(x.dec);
  return `Instrument ${x.name} (${x.sym}) TF ${x.tf}\nPrice ${f(x.price)}\nConfluence ${x.rep.label} score ${x.rep.score.toFixed(2)}\nTrend 50/200 ${x.trend}\nRSI ${x.rsi.toFixed(0)} ADX ${x.adx.toFixed(0)} ATR% ${(x.atr/x.price*100).toFixed(2)}\nRegime ${x.reg.regime}\nVWAP ${f(x.vwap)}\nPDH ${f(x.L.pdh)} PDL ${f(x.L.pdl)}\nPredictiveRange ${x.pr?f(x.pr.l1[x.pr.l1.length-1])+'-'+f(x.pr.u1[x.pr.u1.length-1]):'n/a'}\nPatterns ${x.pats.join(', ')||'none'}`;}
function analystFactors(x){
  const n=DATA.length-1,e20=(IND._e20&&IND._e20[n]),e50=x.e50,e200=x.e200,price=x.price;
  const macd=IND._macd,mh=macd?macd.hist[n]:null,mhPrev=macd?macd.hist[n-1]:null;
  const mfi=(IND._mfi&&IND._mfi[n])||50,flux=(IND._flux&&IND._flux[n])||0,F=[];
  const add=(name,dir,w,note)=>F.push({name,dir,w,note});
  add('Trend (50/200 EMA)',e50>e200?1:-1,2,e50>e200?'50 above 200 — uptrend structure':'50 below 200 — downtrend structure');
  add('Price vs EMA200',price>e200?1:-1,1.5,price>e200?'price above the 200 EMA':'price below the 200 EMA');
  if(e20!=null)add('Short trend (20/50)',e20>e50?1:-1,1,e20>e50?'20 above 50 — near-term up':'20 below 50 — near-term down');
  if(x.adx>25)add('ADX confirms trend',e50>e200?1:-1,1.2,`strong ADX ${x.adx.toFixed(0)} backs the prevailing trend`);
  add('RSI',x.rsi>70?-0.6:x.rsi<30?1:x.rsi>55?0.6:x.rsi<45?-0.6:0,1,`RSI ${x.rsi.toFixed(0)} — ${x.rsi>70?'overbought (pullback risk)':x.rsi<30?'oversold (bounce setup)':x.rsi>55?'bullish momentum':x.rsi<45?'bearish momentum':'neutral'}`);
  if(mh!=null)add('MACD',mh>0?1:-1,1,`histogram ${mh>=0?'positive':'negative'}${mhPrev!=null?(Math.abs(mh)>Math.abs(mhPrev)?' & expanding':' & fading'):''}`);
  if(x.vwap!=null)add('VWAP position',price>=x.vwap?1:-1,1.5,`price ${price>=x.vwap?'above':'below'} VWAP`);
  add('Confluence engine',x.rep.score>0.05?1:x.rep.score<-0.05?-1:0,2,`${x.rep.label} (${x.rep.score>=0?'+':''}${x.rep.score.toFixed(2)})`);
  add('Money flow (MFI)',mfi>55?1:mfi<45?-1:0,1,`MFI ${mfi.toFixed(0)}`);
  add('Order-flow (Flux)',flux>0?1:flux<0?-1:0,1,`pressure ${flux>=0?'+':''}${flux.toFixed(1)}`);
  if(x.pats.length){const bull=x.pats.some(p=>/Bull|Ascending|Inverse|Falling Wedge|Double Bottom/.test(p)),bear=x.pats.some(p=>/Bear|Descending|Rising Wedge|Double Top|Head/.test(p));if(bull||bear)add('Chart pattern',bull&&!bear?1:bear&&!bull?-1:0,1.5,x.pats.join(', '))}
  try{const dv=IND._div;if(dv&&dv.length){const last=dv[dv.length-1],s=String(last.type||last.dir||'');if(/bull/i.test(s))add('Divergence',1,1.5,'bullish RSI divergence');else if(/bear/i.test(s))add('Divergence',-1,1.5,'bearish RSI divergence')}}catch(e){}
  const net=F.reduce((a,fx)=>a+fx.dir*fx.w,0),maxW=F.reduce((a,fx)=>a+fx.w,0)||1;
  return {F,net,norm:net/maxW,bull:F.filter(fx=>fx.dir>0),bear:F.filter(fx=>fx.dir<0)};
}
function levelLadder(x){
  const price=x.price,L=x.L,levels=[];const push=(name,p)=>{if(p!=null&&Number.isFinite(p))levels.push({name,p})};
  push('VWAP',x.vwap);push('PDH',L.pdh);push('PDL',L.pdl);push('PDC',L.pdc);push('PWH',L.pwh);push('PWL',L.pwl);push('Day open',L.dopen);push('Asia H',L.asiaH);push('Asia L',L.asiaL);push('London H',L.ldnH);push('London L',L.ldnL);
  if(x.pr){const i=x.pr.u1.length-1;push('PR upper',x.pr.u1[i]);push('PR lower',x.pr.l1[i])}
  if(x.fib)x.fib.levels.forEach(l=>{if(l.r>0&&l.r<1)push('Fib '+(l.r*100).toFixed(1)+'%',l.price)});
  try{(IND._atl||[]).forEach(t=>{const slope=(t.b.p-t.a.p)/((t.b.i-t.a.i)||1),proj=t.b.p+slope*(DATA.length-1-t.b.i);push(t.kind==='res'?'Trendline (R)':'Trendline (S)',proj)})}catch(e){}
  return {above:levels.filter(l=>l.p>price).sort((a,b)=>a.p-b.p),below:levels.filter(l=>l.p<=price).sort((a,b)=>b.p-a.p)};
}
function tradeChecklist(x){
  const n=DATA.length-1,c=DATA.map(z=>z.c),z=IND.zscore(c)[n]||0,hv=IND.hv(c),hvNow=hv[n],hvMed=_median(hv.slice(-60)),con=x.con,items=[],item=(pass,txt)=>items.push({pass,txt});
  item(Math.sign(con.byCat.trend)===Math.sign(con.score)&&con.score!==0,'Aligned with the dominant trend (not fighting it)');
  item(con.confidence>=50,`Indicators agree ≥50% (now ${con.confidence}%) — not a coin-flip`);
  item(Math.abs(z)<2.2,`Not over-extended (z-score ${z.toFixed(1)}σ) — not chasing`);
  item(!(hvNow&&hvMed&&hvNow>hvMed*1.8),'Volatility normal, not an outlier spike (filtered)');
  item(x.adx>18,`Trend has strength (ADX ${x.adx.toFixed(0)})`);
  /* v18.5: the cross-market ML is now part of the analysis itself, not a side read */
  {const m=window._imx;
   if(m&&m.anomaly)item(!m.anomaly.flag,m.anomaly.flag?('Cross-market STRESS: iForest '+m.anomaly.iforest+' + Mahalanobis '+m.anomaly.mahal+'\u03c3 flag a structural anomaly \u2014 correlations are breaking, stand aside'):'Cross-market structure normal (iForest + Mahalanobis agree: no anomaly)');
   else item(true,'Cross-market monitor warming up \u2014 no anomaly data yet (not blocking)');}
  return {items,passed:items.filter(i=>i.pass).length,total:items.length};
}
