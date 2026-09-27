/* =====================================================================
   Chart engine (canvas): candles · volume · overlays · SMC · crosshair
   ===================================================================== */
const cv=document.getElementById('chart'),ctx=cv.getContext('2d');
let DATA=[],VIEW={count:120,off:0},CUR=null,MOUSE=null,TF='1h';
const ON=new Set(['ema20','ema50','ema200','sr']);   /* v39.25: clean startup — EMAs + S/R only; SMC overlays (fvg/ob/liq/bos/patterns) toggle on when wanted */
const PANES=new Set();   /* active indicator sub-panels below price: rsi, macd */
const APP_VER='39.11';document.title='iram Intelligence · v'+APP_VER;
const SESSION_MEM={symbols:[],trades:[],events:[],started:Date.now()};
let CHART_TYPE='candles';   /* candles | heikin | bars | line | area */
let VOL_ON=true;            /* volume sub-panel (collapsible) */
const PANE_HITS=[];         /* on-canvas × close regions for panes, refreshed each draw */
const CON_HIST={key:'',pts:[]};  /* consensus score history for the momentum strip */
function paneHitAt(x,y){return PANE_HITS.find(r=>x>=r.x&&x<=r.x+r.w&&y>=r.y&&y<=r.y+r.h)}
function closePane(key){if(key==='vol'){VOL_ON=false}else PANES.delete(key);const b=document.querySelector('#paneCtl button[data-pane="'+key+'"]');if(b)b.classList.remove('on');draw()}
function heikinAshi(arr){const out=[];let po,pc;for(let i=0;i<arr.length;i++){const c=arr[i],hc=(c.o+c.h+c.l+c.c)/4,ho=i===0?(c.o+c.c)/2:(po+pc)/2;out.push({o:ho,h:Math.max(c.h,ho,hc),l:Math.min(c.l,ho,hc),c:hc,v:c.v,t:c.t});po=ho;pc=hc}return out}
const LAYOUTS={
  scalp:{tf:'5m',on:['ema20','ema50','vwap'],panes:['rsi'],type:'candles'},
  swing:{tf:'1d',on:['ema50','ema200','pdhl','sr'],panes:[],type:'candles'},
  clean:{on:[],panes:[],type:'line'},
  full:{on:['ema20','ema50','ema200','vwap','autotl','autofib','vp'],panes:['rsi','macd'],type:'candles'}
};
function applyLayout(name){const L=LAYOUTS[name];if(!L)return;ON.clear();L.on.forEach(o=>ON.add(o));PANES.clear();L.panes.forEach(p=>PANES.add(p));if(L.type)CHART_TYPE=L.type;
  document.querySelectorAll('.chip[data-ind]').forEach(c=>c.classList.toggle('on',ON.has(c.dataset.ind)));
  document.querySelectorAll('#paneCtl button').forEach(b=>b.classList.toggle('on',PANES.has(b.dataset.pane)));
  const ct=document.getElementById('chartType');if(ct)ct.value=CHART_TYPE;
  const ic=document.getElementById('indCount');if(ic)ic.textContent='('+ON.size+' on)';
  if(L.tf){const tb=document.querySelector('#tfBar button[data-tf="'+L.tf+'"]');if(tb){tb.click();return}}
  recompute();draw();toast('Layout: '+name,var_bull());}
function memLog(kind,data){const m=SESSION_MEM;if(kind==='symbol'){if(m.symbols[m.symbols.length-1]!==data){m.symbols.push(data);if(m.symbols.length>30)m.symbols.shift()}}else if(kind==='trade'){m.trades.push({...data,t:Date.now()});if(m.trades.length>60)m.trades.shift()}else if(kind==='event'){m.events.push({txt:String(data),t:Date.now()});if(m.events.length>40)m.events.shift()}}

function fit(){const r=cv.parentElement.getBoundingClientRect();const dpr=devicePixelRatio||1;cv.width=r.width*dpr;cv.height=r.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);cv._w=r.width;cv._h=r.height}

let _drawSched=false;
function draw(){ /* F1: rAF-batched — many callers per tick, one real paint per frame */
  if(_drawSched)return;_drawSched=true;
  requestAnimationFrame(()=>{_drawSched=false;try{_drawNow()}catch(e){console.error('draw',e);
    try{if(!window._lastDrawErr||Date.now()-window._lastDrawErr>5000){window._lastDrawErr=Date.now();
      (window._errlog=window._errlog||[]).push({t:Date.now(),kind:'draw',msg:String(e&&e.message||e).slice(0,200),src:'draw-loop'});
      if(window._errlog.length>50)window._errlog.shift();}}catch(e2){}}});}
function _drawNow(){
  if(!DATA.length)return; fit();
  const W=cv._w,H=cv._h,padR=64,padB=26;
  const _panes=[...PANES];const _PH=_panes.length?Math.max(44,Math.min(150,window.PANE_H||86,(H-padB)*0.22)):0;const _panesH=_panes.length*_PH;const _avail=(H-padB)-_panesH;
  const priceH=!VOL_ON?_avail-4:(_panes.length?_avail*Math.min(.92,Math.max(.5,window.PANE_RATIO||0.84)):(H-padB)*Math.min(.92,Math.max(.5,window.PANE_RATIO||0.82))),volY=priceH+8,volH=VOL_ON?(_avail-priceH-14):0;
  ctx.clearRect(0,0,W,H);
  if(window.GLR&&typeof GLR.begin==='function')GLR.begin(cv);   /* v32.1 F1: never throw when the GL module half-initialized */
  const _lt=document.documentElement.getAttribute('data-theme')==='light';const GRIDC=_lt?'rgba(20,30,50,.08)':'rgba(35,43,56,.32)';const AXT=_lt?'#5C6676':'#566072';
  try{if(window.WATERMARK!==false&&CURSYM){ctx.save();ctx.globalAlpha=_lt?0.04:0.032;ctx.fillStyle=_lt?'#1B2430':'#8593A8';ctx.font='700 30px Inter,system-ui';ctx.textAlign='left';ctx.textBaseline='alphabetic';ctx.fillText((CURSYM.name||CURSYM.sym)+' \u00b7 '+TF.toUpperCase(),10,(H-padB)-10);ctx.restore()}}catch(e){}
  const start=Math.max(0,DATA.length-VIEW.count-VIEW.off);
  const end=Math.min(DATA.length,start+VIEW.count);
  const vis=DATA.slice(start,end);
  let lo=Infinity,hi=-Infinity,vmax=0;
  vis.forEach(c=>{lo=Math.min(lo,c.l);hi=Math.max(hi,c.h);vmax=Math.max(vmax,c.v)});
  const pad=(hi-lo)*(window.YPAD||0.08);lo-=pad;hi+=pad;
  const cw=(W-padR)/vis.length;
  const x=i=>i*cw+cw/2;
  const _lg=window.SCALE_MODE==='log'&&lo>0;const _la=_lg?Math.log(lo):lo,_lb=_lg?Math.log(hi):hi,_ls=(_lb-_la)||1e-9;
  const y=p=>(1-((_lg?Math.log(p>0?p:1e-9):p)-_la)/_ls)*priceH;
  window._chartMap={start,end,cw,W,H,padR,priceH,lo,hi,lg:_lg,la:_la,ls:_ls};   /* v29: axis math for overlays */
  try{if(window._drawPre)window._drawPre({g:ctx,vis,start,end,x,y,cw,W,H,padR,priceH,lo,hi})}catch(e){}   /* v26.2 hook: session shading */
  const yv=v=>volY+volH-(v/vmax)*volH;

  // grid + price axis
  ctx.font='10px JetBrains Mono';ctx.textBaseline='middle';
  {const _rawStep=(hi-lo)/5,_mag=Math.pow(10,Math.floor(Math.log10(_rawStep||1e-9)));const _r=_rawStep/_mag;const _step=(_r>=5?10:_r>=2?5:_r>=1?2:1)*_mag;let _p=Math.ceil(lo/_step)*_step;ctx.lineWidth=1;for(;_p<=hi;_p+=_step){const yy=Math.round(y(_p))+0.5;if(yy<0||yy>priceH)continue;ctx.strokeStyle=GRIDC;ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.fillStyle=AXT;ctx.textAlign='left';ctx.fillText(fmt(_p),W-padR+6,yy)}}

  const idx=arr=>arr.slice(start,end);
  // ---- SMC boxes first (behind candles) ----
  if(ON.has('fvg'))IND._fvg.forEach(f=>{if(f.i<start||f.i>=end)return;const gy1=y(f.top),gy2=y(f.bot);ctx.fillStyle=f.type==='bull'?'rgba(76,130,251,.13)':'rgba(240,97,109,.11)';ctx.fillRect(x(f.i-start),Math.min(gy1,gy2),(end-f.i)*cw,Math.abs(gy2-gy1));ctx.strokeStyle=f.type==='bull'?'rgba(76,130,251,.4)':'rgba(240,97,109,.4)';ctx.setLineDash([3,3]);ctx.strokeRect(x(f.i-start),Math.min(gy1,gy2),(end-f.i)*cw,Math.abs(gy2-gy1));ctx.setLineDash([])});
  if(ON.has('ob'))IND._ob.forEach(o=>{if(o.i<start||o.i>=end)return;const gy1=y(o.top),gy2=y(o.bot);ctx.fillStyle=o.type==='bull'?'rgba(232,163,61,.14)':'rgba(155,140,255,.13)';ctx.fillRect(x(o.i-start),Math.min(gy1,gy2),(end-o.i)*cw,Math.abs(gy2-gy1))});

  // ---- S/R + liquidity lines ----
  if(ON.has('sr'))IND._sr.forEach(l=>{const yy=y(l.p);if(yy<0||yy>priceH)return;ctx.strokeStyle='rgba(122,132,148,.5)';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#7A8494';ctx.textAlign='left';ctx.fillText(l.n+'× '+fmt(l.p),4,yy-7)});
  if(ON.has('liq')){const recent=vis.slice(-40);const eqh=Math.max(...recent.map(c=>c.h)),eql=Math.min(...recent.map(c=>c.l));[[eqh,'buy-side',var_bear()],[eql,'sell-side',var_bull()]].forEach(([p,lab,col])=>{const yy=y(p);ctx.strokeStyle=col;ctx.globalAlpha=.55;ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.globalAlpha=1;ctx.fillStyle=col;ctx.textAlign='right';ctx.fillText(lab+' liq',W-padR-4,yy-7)})}

  // ---- key levels: PDH/PDL, PD close, PWH/PWL, session H/L, day open ----
  const L=IND._levels||{};
  const tagLeft=(price,label,col,dash=[5,4])=>{if(price==null)return;const yy=y(price);if(yy<8||yy>priceH-2)return;ctx.strokeStyle=col;ctx.globalAlpha=.6;ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;ctx.font='9px JetBrains Mono';const txt=label+' '+fmt(price);const tw=ctx.measureText(txt).width;ctx.fillStyle=col;ctx.fillRect(0,yy-7,tw+8,13);ctx.fillStyle='#0B0E14';ctx.textAlign='left';ctx.fillText(txt,4,yy)};
  if(ON.has('pdhl')){tagLeft(L.pdh,'PDH',var_bear());tagLeft(L.pdl,'PDL',var_bull())}
  if(ON.has('pdc'))tagLeft(L.pdc,'PDC','#7A8494',[2,3]);
  if(ON.has('pwhl')){tagLeft(L.pwh,'PWH','#9B8CFF');tagLeft(L.pwl,'PWL','#9B8CFF')}
  if(ON.has('sesshl')){tagLeft(L.asiaH,'ASIA H','#4C82FB',[2,3]);tagLeft(L.asiaL,'ASIA L','#4C82FB',[2,3]);tagLeft(L.ldnH,'LDN H','#E8A33D',[2,3]);tagLeft(L.ldnL,'LDN L','#E8A33D',[2,3])}
  if(ON.has('dopen'))tagLeft(L.dopen,'D.OPEN','#E8A33D',[6,3]);

  // ---- overlays ----
  const line=(arr,col,wdt=1.4)=>{ctx.strokeStyle=col;ctx.lineWidth=wdt;ctx.beginPath();let m=false;idx(arr).forEach((v,i)=>{if(v==null){m=false;return}const px=x(i),py=y(v);if(!m){ctx.moveTo(px,py);m=true}else ctx.lineTo(px,py)});ctx.stroke();ctx.lineWidth=1};
  if(ON.has('ema20'))line(IND._e20,'#4C82FB');
  if(ON.has('ema50'))line(IND._e50,'#E8A33D');
  if(ON.has('ema200'))line(IND._e200,'#9B8CFF',1.8);
  if(ON.has('boll')){line(IND._bb.up,'rgba(90,100,114,.7)');line(IND._bb.lo,'rgba(90,100,114,.7)');line(IND._bb.mid,'rgba(90,100,114,.4)')}
  if(ON.has('vwap')&&IND._vwap){line(IND._vwap.vw,'#4C82FB',1.7);line(IND._vwap.u1,'rgba(76,130,251,.5)');line(IND._vwap.l1,'rgba(76,130,251,.5)');line(IND._vwap.u2,'rgba(76,130,251,.28)');line(IND._vwap.l2,'rgba(76,130,251,.28)');const vn=IND._vwap.vw[end-1];if(vn!=null){ctx.fillStyle='#4C82FB';ctx.font='9px JetBrains Mono';ctx.textAlign='left';ctx.fillText('VWAP '+fmt(vn),4,y(vn)-4)}}
  if(ON.has('autotl')&&IND._atl)IND._atl.forEach(L=>{const col=L.kind==='res'?'rgba(240,97,109,.85)':'rgba(45,190,142,.85)';const slope=(L.b.p-L.a.p)/((L.b.i-L.a.i)||1);const ex=end-1,ep=L.a.p+slope*(ex-L.a.i);ctx.strokeStyle=col;ctx.lineWidth=1.6;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(x(Math.max(0,L.a.i-start)),y(L.a.i>=start?L.a.p:L.a.p+slope*(start-L.a.i)));ctx.lineTo(x(ex-start),y(ep));ctx.stroke();ctx.fillStyle=col;ctx.font='9px Inter';ctx.textAlign='right';ctx.fillText(L.kind==='res'?'resistance':'support',x(ex-start)-2,y(ep)-4)});
  if(ON.has('autofib')&&IND._afib){const f=IND._afib,x0=Math.max(0,Math.min(f.hi.i,f.lo.i)-start);f.levels.forEach(lv=>{const yy=y(lv.price);if(yy<0||yy>priceH)return;ctx.strokeStyle=lv.r===0||lv.r===1?'rgba(232,163,61,.6)':'rgba(232,163,61,.32)';ctx.setLineDash(lv.r===0||lv.r===1?[]:[3,3]);ctx.beginPath();ctx.moveTo(x0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(232,163,61,.95)';ctx.font='9px JetBrains Mono';ctx.textAlign='left';ctx.fillText((lv.r*100).toFixed(1)+'%',x0+3,yy-2)})}
  if(ON.has('raindrop')){const vmax2=Math.max(...vis.map(c=>c.v||0))||1;vis.forEach((c,i)=>{const tp=(c.h+c.l+c.c)/3,rad=2.5+Math.sqrt((c.v||0)/vmax2)*Math.min(cw*0.7,15);ctx.fillStyle=c.c>=c.o?'rgba(45,190,142,.26)':'rgba(240,97,109,.26)';ctx.beginPath();ctx.arc(x(i),y(tp),rad,0,7);ctx.fill();ctx.strokeStyle=c.c>=c.o?'rgba(45,190,142,.75)':'rgba(240,97,109,.75)';ctx.lineWidth=1;ctx.stroke()})}
  if(ON.has('nw')&&IND._nw){line(IND._nw.up,'rgba(155,140,255,.55)');line(IND._nw.mid,'#9B8CFF',1.7);line(IND._nw.lo,'rgba(155,140,255,.55)')}
  if(ON.has('predr')&&IND._pr){line(IND._pr.u2,'rgba(240,97,109,.32)');line(IND._pr.u1,'rgba(240,97,109,.55)');line(IND._pr.mid,'#E8A33D',1.7);line(IND._pr.l1,'rgba(45,190,142,.55)');line(IND._pr.l2,'rgba(45,190,142,.32)');const m=IND._pr.mid[end-1];if(m!=null){ctx.fillStyle='#E8A33D';ctx.font='9px JetBrains Mono';ctx.textAlign='left';ctx.fillText('PR '+fmt(m),4,y(m)-4)}}
  if(ON.has('divscan')&&IND._divscan)IND._divscan.forEach(dv=>{const a=dv.pts[0],b=dv.pts[1];if(b.i<start||b.i>=end)return;const col=dv.dir==='bull'?var_bull():var_bear();ctx.strokeStyle=col;ctx.lineWidth=1;ctx.setLineDash([2,2]);if(a.i>=start){ctx.beginPath();ctx.moveTo(x(a.i-start),y(a.p));ctx.lineTo(x(b.i-start),y(b.p));ctx.stroke()}ctx.setLineDash([]);ctx.fillStyle=col;ctx.font='8px Inter';ctx.textAlign='center';ctx.fillText((dv.dir==='bull'?'▲ ':'▼ ')+dv.osc,x(b.i-start),y(b.p)+(dv.dir==='bull'?13:-7))})
  if(ON.has('super')){ctx.lineWidth=1.8;let m=false;ctx.beginPath();idx(IND._st.st).forEach((v,i)=>{const gi=i+start;if(v==null){m=false;return}const col=IND._st.dir[gi]===1?var_bull():var_bear();ctx.strokeStyle=col;const px=x(i),py=y(v);if(!m){ctx.beginPath();ctx.moveTo(px,py);m=true}else{ctx.lineTo(px,py);ctx.stroke();ctx.beginPath();ctx.moveTo(px,py)}});ctx.lineWidth=1}

  // ---- volume ----
  if(VOL_ON){const _vn=vis.length;vis.forEach((c,i)=>{const _fade=0.35+0.65*(i/_vn);ctx.fillStyle=c.c>=c.o?('rgba(45,190,142,'+(0.46*_fade).toFixed(2)+')'):('rgba(240,97,109,'+(0.62*_fade).toFixed(2)+')');const h=(c.v/vmax)*volH;ctx.fillRect(x(i)-cw*0.4,volY+volH-h,cw*0.8,h)});
  ctx.strokeStyle='rgba(35,43,56,.6)';ctx.beginPath();ctx.moveTo(0,volY);ctx.lineTo(W-padR,volY);ctx.stroke();}

  /* ---- feed-integrity overlays: session closures vs missing bars + bad prints ----
     closures (>6xTF) are the market being closed (normal); missing bars (1.5-6xTF) are feed defects.
     No per-gap text (labels smeared into a band on gappy intraday data); one summary line instead. */
  try{const _tfms=barSpacingMs();const _reqms=tfSeconds(TF)*1000;ctx.save();
    if(_tfms>_reqms*1.4){ctx.fillStyle='rgba(232,163,61,.6)';ctx.font='8.5px JetBrains Mono';ctx.textAlign='left';
      ctx.fillText('feed granularity \u2248'+Math.round(_tfms/60000)+'m (requested '+TF+') \u2014 provider fallback',6,12);}
    let _closures=0,_missing=0;const _cx=[];
    for(let _gi=1;_gi<vis.length;_gi++){const _dt=vis[_gi].t-vis[_gi-1].t;
      if(_dt>6*_tfms){_closures++;if(_cx.length<60)_cx.push(x(_gi)-cw/2)}
      else if(_dt>1.5*_tfms)_missing++;}
    if(_cx.length&&_closures<=60){ctx.strokeStyle='rgba(232,163,61,.16)';ctx.setLineDash([2,6]);
      _cx.forEach(_gx=>{ctx.beginPath();ctx.moveTo(_gx,0);ctx.lineTo(_gx,priceH);ctx.stroke()});ctx.setLineDash([]);}
    if(_closures||_missing){ctx.fillStyle='rgba(232,163,61,.55)';ctx.font='8.5px JetBrains Mono';ctx.textAlign='left';
      ctx.fillText((_closures?_closures+' session break'+(_closures>1?'s':''):'')+(_closures&&_missing?' \u00b7 ':'')+(_missing?_missing+' missing bar'+(_missing>1?'s':''):''),6,priceH-5);}
    const _rngs=vis.map(c=>c.h-c.l).filter(v=>v>0).sort((a,b)=>a-b);const _med=_rngs[_rngs.length>>1]||0;
    if(_med>0){ctx.fillStyle='rgba(240,97,109,.85)';ctx.font='9px JetBrains Mono';ctx.textAlign='center';
      vis.forEach((c,i)=>{if((c.h-c.l)>6*_med)ctx.fillText('\u26a0',x(i),Math.max(9,y(c.h)-6))});}
    ctx.restore();}catch(e){}
  // ---- candles ----
  if(CHART_TYPE==='line'||CHART_TYPE==='area'){const accent=getComputedStyle(document.documentElement).getPropertyValue('--blue').trim()||'#4C82FB';ctx.strokeStyle=accent;ctx.lineWidth=1.8;ctx.beginPath();vis.forEach((c,i)=>{const px=x(i),py=y(c.c);i?ctx.lineTo(px,py):ctx.moveTo(px,py)});ctx.stroke();if(CHART_TYPE==='area'){ctx.lineTo(x(vis.length-1),priceH);ctx.lineTo(x(0),priceH);ctx.closePath();const g2=ctx.createLinearGradient(0,0,0,priceH);g2.addColorStop(0,'rgba(76,130,251,.26)');g2.addColorStop(1,'rgba(76,130,251,0)');ctx.fillStyle=g2;ctx.fill()}ctx.lineWidth=1}
  else{let candles=vis;if(CHART_TYPE==='heikin')candles=heikinAshi(DATA).slice(start,end);
    if(window.GLR&&GLR.on&&GLR.ok&&CHART_TYPE!=='bars'){GLR.candles(candles,x,y,cw,cv)}
    else{const hollow=window.CANDLE_HOLLOW===true;const wickW=Math.max(1,Math.min(1.6,cw*0.09));
      candles.forEach((c,i)=>{const up2=c.c>=c.o;const col=up2?var_bull():var_bear();ctx.strokeStyle=col;ctx.fillStyle=col;const cx=x(i);
      ctx.lineWidth=wickW;ctx.beginPath();ctx.moveTo(cx,y(c.h));ctx.lineTo(cx,y(c.l));ctx.stroke();ctx.lineWidth=1;
      if(CHART_TYPE==='bars'){ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(cx-cw*0.34,y(c.o));ctx.lineTo(cx,y(c.o));ctx.moveTo(cx,y(c.c));ctx.lineTo(cx+cw*0.34,y(c.c));ctx.stroke();ctx.lineWidth=1}
      else{const bt=y(Math.max(c.o,c.c)),bb2=y(Math.min(c.o,c.c)),bw=cw*0.68,bh=Math.max(1,bb2-bt);
        if(hollow&&up2){ctx.strokeRect(cx-bw/2+0.5,bt+0.5,bw-1,Math.max(1,bh-1))}
        else{ctx.fillRect(cx-bw/2,bt,bw,bh);if(cw>4){ctx.globalAlpha=0.35;ctx.strokeRect(cx-bw/2+0.5,bt+0.5,bw-1,Math.max(1,bh-1));ctx.globalAlpha=1}}}});}
      /* A3: pulsing live dot at last close */
      try{if(!window._pulseT0)window._pulseT0=Date.now();const lc=vis[vis.length-1];const ph=(Date.now()-window._pulseT0)%1600/1600;
        const pr2=2.2+Math.sin(ph*Math.PI*2)*1.1;ctx.save();ctx.globalAlpha=.85;ctx.fillStyle=lc.c>=lc.o?var_bull():var_bear();
        ctx.beginPath();ctx.arc(x(vis.length-1),y(lc.c),pr2,0,7);ctx.fill();ctx.restore();}catch(e){}
  }

  // ---- BOS/CHoCH labels ----
  if(ON.has('bos'))IND._bos.forEach(b=>{if(b.i<start||b.i>=end)return;const yy=y(b.price);ctx.fillStyle=b.dir==='up'?var_bull():var_bear();ctx.font='9px JetBrains Mono';ctx.textAlign='center';ctx.fillText(b.type,x(b.i-start),yy+(b.dir==='up'?-4:12))});

  // ---- premium / discount zones ----
  if(ON.has('pd')){const eq=(hi+lo)/2;ctx.fillStyle='rgba(240,97,109,.05)';ctx.fillRect(0,0,W-padR,y(eq));ctx.fillStyle='rgba(45,190,142,.05)';ctx.fillRect(0,y(eq),W-padR,priceH-y(eq));ctx.strokeStyle='rgba(155,140,255,.5)';ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(0,y(eq));ctx.lineTo(W-padR,y(eq));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(240,97,109,.6)';ctx.textAlign='left';ctx.font='9px JetBrains Mono';ctx.fillText('PREMIUM',4,14);ctx.fillStyle='rgba(45,190,142,.6)';ctx.fillText('DISCOUNT',4,priceH-6);ctx.fillStyle='#9B8CFF';ctx.fillText('equilibrium '+fmt(eq),4,y(eq)-4)}

  // ---- swing HH/HL/LH/LL labels ----
  if(ON.has('swings')&&IND._sw){ctx.font='8px JetBrains Mono';let ph=null,pl=null;IND._sw.hi.forEach(i=>{if(i<start||i>=end)return;const lab=ph==null?'H':DATA[i].h>ph?'HH':'LH';ph=DATA[i].h;ctx.fillStyle=lab==='HH'?var_bull():var_bear();ctx.textAlign='center';ctx.fillText(lab,x(i-start),y(DATA[i].h)-6)});IND._sw.lo.forEach(i=>{if(i<start||i>=end)return;const lab=pl==null?'L':DATA[i].l<pl?'LL':'HL';pl=DATA[i].l;ctx.fillStyle=lab==='HL'?var_bull():var_bear();ctx.textAlign='center';ctx.fillText(lab,x(i-start),y(DATA[i].l)+12)})}

  // ---- session shading (by candle UTC hour) ----
  if(ON.has('sessions'))vis.forEach((c,i)=>{const h=new Date(c.t).getUTCHours();const asia=h>=0&&h<9,ldn=h>=8&&h<17,ny=h>=13&&h<22;if(asia||ldn||ny){ctx.fillStyle=(ldn&&ny)?'rgba(45,190,142,.07)':ny?'rgba(45,190,142,.045)':ldn?'rgba(232,163,61,.05)':'rgba(120,132,148,.05)';ctx.fillRect(x(i)-cw/2,0,cw,priceH)}});

  // ---- auto chart patterns ----
  if(ON.has('patterns')&&IND._patterns)IND._patterns.forEach(p=>{const col=p.dir==='bull'?var_bull():p.dir==='bear'?var_bear():'#E8A33D';ctx.strokeStyle=col;ctx.lineWidth=1.5;
    if(p.pts&&p.pts.length){ctx.beginPath();let started=false;p.pts.forEach(pt=>{if(pt.i<start||pt.i>=end)return;const px2=x(pt.i-start),py2=y(pt.p);if(!started){ctx.moveTo(px2,py2);started=true}else ctx.lineTo(px2,py2)});ctx.stroke();p.pts.forEach(pt=>{if(pt.i<start||pt.i>=end)return;ctx.fillStyle=col;ctx.beginPath();ctx.arc(x(pt.i-start),y(pt.p),3,0,7);ctx.fill()})}
    if(p.lines)p.lines.forEach(L=>{const dxx=(L.b.i-L.a.i)||1,slope=(L.b.p-L.a.p)/dxx;const ex=end-1,ep=L.a.p+slope*(ex-L.a.i);ctx.strokeStyle=col;ctx.setLineDash([]);ctx.beginPath();ctx.moveTo(x(L.a.i-start),y(L.a.p));ctx.lineTo(x(ex-start),y(ep));ctx.stroke()});
    const lp=p.lp||(p.pts&&p.pts.find(pt=>pt.i>=start&&pt.i<end));
    if(lp&&lp.i>=start&&lp.i<end){ctx.fillStyle=col;ctx.font='bold 10px Inter';ctx.textAlign='center';ctx.fillText(p.type,x(lp.i-start),y(lp.p)-16)}
    if(p.neck!=null){ctx.strokeStyle='rgba(232,163,61,.5)';ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(0,y(p.neck));ctx.lineTo(W-padR,y(p.neck));ctx.stroke();ctx.setLineDash([])}
    ctx.lineWidth=1});

  // ---- divergence connectors ----
  if(ON.has('div')&&IND._div)IND._div.forEach(dv=>{const a=dv.pts[0],b=dv.pts[1];if(a.i<start||b.i>=end)return;const col=dv.dir==='bull'?var_bull():var_bear();ctx.strokeStyle=col;ctx.lineWidth=1.5;ctx.setLineDash(dv.hidden?[4,3]:[]);ctx.beginPath();ctx.moveTo(x(a.i-start),y(a.p));ctx.lineTo(x(b.i-start),y(b.p));ctx.stroke();ctx.setLineDash([]);ctx.lineWidth=1;ctx.fillStyle=col;ctx.font='bold 9px Inter';ctx.textAlign='center';ctx.fillText(dv.type,x(b.i-start),dv.dir==='bull'?y(b.p)+13:y(b.p)-8)});

  // ---- inducement (IDM) markers ----
  if(ON.has('idm')&&IND._idm)IND._idm.forEach(m=>{if(m.i<start||m.i>=end)return;const col=m.dir==='bull'?var_bull():var_bear();const yy=y(m.p);ctx.strokeStyle=col;ctx.globalAlpha=.7;ctx.setLineDash([2,2]);ctx.beginPath();ctx.moveTo(x(m.i-start)-cw,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;ctx.fillStyle=col;ctx.font='bold 8px JetBrains Mono';ctx.textAlign='left';ctx.fillText('IDM',x(m.i-start)-cw+2,m.dir==='bull'?yy+11:yy-4)});

  // ---- volume profile (right edge) ----
  if(ON.has('axheat')){try{const hb=axisHeatBuckets(vis,lo,hi,60);const stripW=7,x0=W-padR+1;for(let b=0;b<hb.length;b++){const y1=(1-(b+1)/hb.length)*priceH,hgt=priceH/hb.length;g.fillStyle='rgba(232,163,61,'+(0.04+hb[b]*0.5).toFixed(3)+')';g.fillRect(x0,y1,stripW,hgt+0.5);}}catch(e){}}
  if(ON.has('news')){try{
    var _src=[].concat((window._macroCal||[]).map(function(e){return {t:Date.parse(e.t),impact:e.impact||'high',title:e.n}}))
                .concat((window._newsItems||[]));
    const marks=newsMarkerIdx(_src,vis).sort(function(a,b){return b.n-a.n}).slice(0,10);   /* cap: never wall up */
    window._newsHot=[];
    marks.forEach(mk=>{const xx=x(mk.i);var col=mk.hi?'rgba(240,97,109,.95)':'rgba(201,166,255,.92)';
      ctx.strokeStyle=mk.hi?'rgba(240,97,109,.38)':'rgba(201,166,255,.38)';ctx.setLineDash([2,4]);ctx.beginPath();ctx.moveTo(xx,14);ctx.lineTo(xx,priceH);ctx.stroke();ctx.setLineDash([]);
      ctx.fillStyle=col;ctx.beginPath();ctx.moveTo(xx,4);ctx.lineTo(xx+5,9);ctx.lineTo(xx,14);ctx.lineTo(xx-5,9);ctx.closePath();ctx.fill();
      if(mk.n>1){ctx.fillStyle=col;ctx.font='8px JetBrains Mono';ctx.textAlign='center';ctx.fillText(String(mk.n),xx,24)}
      window._newsHot.push({x:xx,y:9,items:mk.items||[],hi:mk.hi});});
    if(marks.length){ctx.font='8px JetBrains Mono';ctx.textAlign='left';ctx.fillStyle='rgba(240,97,109,.9)';ctx.fillText('\u25c6 high-impact',8,priceH-6);ctx.fillStyle='rgba(201,166,255,.85)';ctx.fillText('\u25c6 news',92,priceH-6);ctx.fillStyle='rgba(150,160,175,.65)';ctx.fillText('hover for details \u00b7 click \u2192 News feed',150,priceH-6);}
    if(!marks.length&&!(window._macroCal&&window._macroCal.length)&&(!window._newsItems||!window._newsItems.length)){ctx.fillStyle='rgba(201,166,255,.55)';ctx.font='9px JetBrains Mono';ctx.textAlign='left';ctx.fillText('calendar markers: load a timed calendar in Discover \u2192 News & Calendar, then toggle Cal on',8,14)}
  }catch(e){window._newsHot=[]}}
  if(ON.has('vp')||ON.has('mp')){const bins=44,volB=new Array(bins).fill(0),tpoB=new Array(bins).fill(0);const binOf=p=>Math.min(bins-1,Math.max(0,Math.floor((p-lo)/((hi-lo)||1)*bins)));vis.forEach(c=>{volB[binOf(c.c)]+=(c.v||1);const a=binOf(c.l),b=binOf(c.h);for(let k=a;k<=b;k++)tpoB[k]++});const useTPO=ON.has('mp')&&!ON.has('vp');const buck=useTPO?tpoB:volB;const mx=Math.max(...buck)||1;let poc=0,pv=-1;buck.forEach((v,i)=>{if(v>pv){pv=v;poc=i}});const total=buck.reduce((a,b)=>a+b,0)||1;let lo_i=poc,hi_i=poc,acc=buck[poc];while(acc<total*0.7&&(lo_i>0||hi_i<bins-1)){const dn=lo_i>0?buck[lo_i-1]:-1,up=hi_i<bins-1?buck[hi_i+1]:-1;if(up>=dn){hi_i++;acc+=buck[hi_i]}else{lo_i--;acc+=buck[lo_i]}}const yb=i=>(1-i/bins)*priceH,pAt=i=>lo+(i+0.5)/bins*(hi-lo);for(let b=0;b<bins;b++){const yy=yb(b),ww=(buck[b]/mx)*92,inVA=b>=lo_i&&b<=hi_i;ctx.fillStyle=b===poc?'rgba(232,163,61,.55)':inVA?'rgba(76,130,251,.22)':'rgba(120,132,148,.14)';ctx.fillRect(W-padR-ww,yy-priceH/bins,ww,priceH/bins-1)}const lvl2=(i,col,lab)=>{const yy=yb(i);ctx.strokeStyle=col;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=col;ctx.font='9px JetBrains Mono';ctx.textAlign='left';ctx.fillText(lab+' '+fmt(pAt(i)),4,yy-2)};lvl2(poc,'rgba(232,163,61,.95)',useTPO?'POC(t)':'POC');lvl2(hi_i,'rgba(76,130,251,.8)','VAH');lvl2(lo_i,'rgba(76,130,251,.8)','VAL')}

  // ---- current price line (live) ----
  {const lc=DATA[DATA.length-1];if(lc){/* v39.6 Z3: the tag reserves its lane; overlapping flags slide instead of stacking */const yy=(window._flagLane?window._flagLane(y(lc.c)-8,16)+8:y(lc.c));window._liveTagY=yy;if(yy>=0&&yy<=priceH){const col=lc.c>=lc.o?var_bull():var_bear();ctx.strokeStyle=col;ctx.globalAlpha=.85;ctx.setLineDash([2,3]);ctx.beginPath();ctx.moveTo(0,yy);ctx.lineTo(W-padR,yy);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;ctx.fillStyle=col;ctx.fillRect(W-padR,yy-8,padR,16);ctx.fillStyle='#0B0E14';ctx.font='10px JetBrains Mono';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(fmt(lc.c),W-padR+5,yy)}}}

  // ---- indicator sub-panels (RSI / MACD) ----
  PANE_HITS.length=0;
  const paneClose=(top,key)=>{const bs=10,bx0=W-padR-20,by0=top+3;ctx.fillStyle='rgba(120,132,148,.18)';ctx.beginPath();ctx.arc(bx0+bs/2,by0+bs/2,bs/2+2.5,0,7);ctx.fill();ctx.strokeStyle=AXT;ctx.lineWidth=1.1;ctx.beginPath();ctx.moveTo(bx0+2,by0+2);ctx.lineTo(bx0+bs-2,by0+bs-2);ctx.moveTo(bx0+bs-2,by0+2);ctx.lineTo(bx0+2,by0+bs-2);ctx.stroke();ctx.lineWidth=1;PANE_HITS.push({key,x:bx0-4,y:by0-4,w:bs+9,h:bs+9})};
  if(VOL_ON&&volH>4){ctx.fillStyle=AXT;ctx.font='9px JetBrains Mono';ctx.textAlign='left';ctx.fillText('VOL',10,volY+11);paneClose(volY+2,'vol')}
  _panes.forEach((pane,k)=>{
    const top=_avail+k*_PH+4,ph=_PH-8;
    paneClose(top+2,pane);
    ctx.strokeStyle=GRIDC;ctx.beginPath();ctx.moveTo(0,_avail+k*_PH);ctx.lineTo(W-padR,_avail+k*_PH);ctx.stroke();
    ctx.textAlign='left';
    if(pane==='cvd'){ /* M8: proxy CVD (candle-direction volume) + live-session real CVD */
      let cum=0;const cvdArr=[];for(let ci=0;ci<DATA.length;ci++){const b2=DATA[ci];cum+=(b2.c>=b2.o?1:-1)*(b2.v||0);cvdArr.push(cum)}
      const seg=cvdArr.slice(start,end);let mn2=Math.min(...seg),mx2=Math.max(...seg);if(mn2===mx2){mn2-=1;mx2+=1}
      const py2=v=>top+(1-(v-mn2)/(mx2-mn2))*ph;
      ctx.strokeStyle=seg[seg.length-1]>=seg[0]?var_bull():var_bear();ctx.lineWidth=1.3;ctx.beginPath();
      seg.forEach((v,i2)=>{i2?ctx.lineTo(x(i2),py2(v)):ctx.moveTo(x(i2),py2(v))});ctx.stroke();ctx.lineWidth=1;
      /* divergence flag: price higher-high while CVD lower-high over the last 30 visible bars */
      try{const n3=seg.length;if(n3>30){const pSeg=vis.map(b3=>b3.c);
        const pHi=Math.max(...pSeg.slice(-15)),pHiPrev=Math.max(...pSeg.slice(-30,-15));
        const cHi=Math.max(...seg.slice(-15)),cHiPrev=Math.max(...seg.slice(-30,-15));
        if(pHi>pHiPrev&&cHi<cHiPrev){ctx.fillStyle='rgba(240,97,109,.85)';ctx.font='8.5px JetBrains Mono';ctx.textAlign='right';ctx.fillText('\u26a0 bearish divergence \u2014 price HH, CVD LH',W-padR-6,top+10)}
        else if(pHi<pHiPrev&&cHi>cHiPrev){ctx.fillStyle='rgba(45,190,142,.85)';ctx.font='8.5px JetBrains Mono';ctx.textAlign='right';ctx.fillText('bullish divergence \u2014 price LH, CVD HH',W-padR-6,top+10)}}}catch(e){}
      ctx.fillStyle='rgba(140,150,165,.6)';ctx.font='8px JetBrains Mono';ctx.textAlign='left';
      const live=(window._oflow&&window._oflow.cvd&&window._oflow.cvd.length>3);
      ctx.fillText('CVD \u00b7 proxy (candle-direction \u00d7 volume)'+(live?' \u00b7 live session: '+((window._oflow.cvd[window._oflow.cvd.length-1].v-window._oflow.cvd[0].v)>=0?'+$':'\u2212$')+Math.abs((window._oflow.cvd[window._oflow.cvd.length-1].v-window._oflow.cvd[0].v)/1000).toFixed(0)+'k real aggressor':' \u00b7 real aggressor CVD needs Online'),6,top+10);
    }
    if(pane==='rsi'){
      const rsi=IND._rsi,py=v=>top+(1-v/100)*ph;
      ctx.strokeStyle='rgba(120,132,148,.28)';ctx.setLineDash([2,3]);[30,50,70].forEach(lv=>{ctx.beginPath();ctx.moveTo(0,py(lv));ctx.lineTo(W-padR,py(lv));ctx.stroke()});ctx.setLineDash([]);
      ctx.strokeStyle='#9B8CFF';ctx.lineWidth=1.4;ctx.beginPath();let m=false;for(let i=start;i<end;i++){const v=rsi[i];if(v==null){m=false;continue}const xx=x(i-start),yy=py(v);m?ctx.lineTo(xx,yy):(ctx.moveTo(xx,yy),m=true)}ctx.stroke();ctx.lineWidth=1;
      ctx.fillStyle=AXT;ctx.font='9px JetBrains Mono';ctx.fillText('RSI '+((rsi[end-1]||50).toFixed(0)),4,top+9);ctx.fillText('70',W-padR+4,py(70));ctx.fillText('30',W-padR+4,py(30));
    } else if(pane==='macd'){
      const md=IND._macd;let mx=1e-9;for(let i=start;i<end;i++){mx=Math.max(mx,Math.abs(md.m[i]||0),Math.abs(md.sig[i]||0),Math.abs(md.hist[i]||0))}
      const py=v=>top+ph/2-(v/mx)*(ph/2-3);
      ctx.strokeStyle='rgba(120,132,148,.28)';ctx.beginPath();ctx.moveTo(0,py(0));ctx.lineTo(W-padR,py(0));ctx.stroke();
      for(let i=start;i<end;i++){const hh=md.hist[i]||0;ctx.fillStyle=hh>=0?'rgba(45,190,142,.55)':'rgba(240,97,109,.55)';const xx=x(i-start),y0=py(0),y1=py(hh);ctx.fillRect(xx-cw*0.3,Math.min(y0,y1),Math.max(1,cw*0.6),Math.abs(y1-y0)||1)}
      const lp=(arr,col)=>{ctx.strokeStyle=col;ctx.lineWidth=1.2;ctx.beginPath();let m=false;for(let i=start;i<end;i++){const v=arr[i];if(v==null){m=false;continue}const xx=x(i-start),yy=py(v);m?ctx.lineTo(xx,yy):(ctx.moveTo(xx,yy),m=true)}ctx.stroke();ctx.lineWidth=1};
      lp(md.m,'#4C82FB');lp(md.sig,'#E8A33D');
      ctx.fillStyle=AXT;ctx.font='9px JetBrains Mono';ctx.fillText('MACD',4,top+9);
    } else if(pane==='mfi'){
      const mfi=IND._mfi||IND.mfi(DATA),py=v=>top+(1-v/100)*ph;
      ctx.strokeStyle='rgba(120,132,148,.28)';ctx.setLineDash([2,3]);[20,50,80].forEach(lv=>{ctx.beginPath();ctx.moveTo(0,py(lv));ctx.lineTo(W-padR,py(lv));ctx.stroke()});ctx.setLineDash([]);
      ctx.strokeStyle='#4C82FB';ctx.lineWidth=1.4;ctx.beginPath();let m=false;for(let i=start;i<end;i++){const v=mfi[i];if(v==null){m=false;continue}const xx=x(i-start),yy=py(v);m?ctx.lineTo(xx,yy):(ctx.moveTo(xx,yy),m=true)}ctx.stroke();ctx.lineWidth=1;
      ctx.fillStyle=AXT;ctx.font='9px JetBrains Mono';ctx.fillText('MFI '+((mfi[end-1]||50).toFixed(0)),4,top+9);
    }
  });

  /* v39.1 D1: right-edge flag LANES. The screenshot showed the RSI pane label,
     the FLUX flag and the last-price flag stacked on the same pixels. Every
     axis flag now reserves its rect; an overlapping newcomer slides down to
     the next free slot. Painters opt in via window._flagLane(y,h) -> y'. */
  window._flagLanes=[];
  window._flagLane=function(fy,fh){
    fh=fh||14; var lanes=window._flagLanes,y2=fy,moved=true,guard=0;
    while(moved&&guard++<12){moved=false;
      for(var i=0;i<lanes.length;i++){var L=lanes[i];
        if(y2<L.y+L.h&&y2+fh>L.y){y2=L.y+L.h+2;moved=true}}}
    lanes.push({y:y2,h:fh});return y2;
  };

  // ---- store render mapping + render user drawings ----
  RENDER={start,cw,lo,hi,priceH,W,padR};
  drawDrawings(ctx);

  // ---- crosshair ----
  /* v39.6 Z5: an entire if(false&&...) corpse (crosshair + axis-time pill + updateReadout) deleted -- 4 lines that could never execute. My v39.1 'D2 fix' was applied INSIDE this corpse and therefore fixed nothing: the pills on screen come from the M1 overlay (46-wave-1) and the session painter, not from here. */
  try{if(window._drawPost)window._drawPost({g:ctx,vis,start,end,x,y,cw,W,H,padR,priceH,lo,hi})}catch(e){}   /* v26.2 hook: compare + SM markers */
  drawLegend();
}

/* ================= v39.29 CALENDAR MARKERS — toggle · hover shows the event · click opens it ================= */
document.addEventListener('DOMContentLoaded',function(){ setTimeout(function(){ try{
  var chart=document.getElementById('chart'); if(!chart)return;
  var tip=document.createElement('div'); tip.id='newsTip';
  tip.style.cssText='position:fixed;z-index:99999;display:none;max-width:290px;background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--txt);box-shadow:0 8px 30px rgba(0,0,0,.55);pointer-events:none;line-height:1.45';
  document.body.appendChild(tip);
  var calBtn=document.getElementById('calBtn'), calVal=document.getElementById('calVal');
  function setCal(on){ if(on)ON.add('news');else ON.delete('news'); if(calVal)calVal.textContent=on?'on':'off'; if(calBtn)calBtn.classList.toggle('on',on); try{localStorage.setItem('iram_cal_on',on?'1':'0')}catch(e){} try{draw()}catch(e){} }
  var saved=null;try{saved=localStorage.getItem('iram_cal_on')}catch(e){} setCal(saved==='1');
  if(calBtn)calBtn.onclick=function(){ setCal(!ON.has('news')); };
  function near(e){ var r=chart.getBoundingClientRect(), mx=e.clientX-r.left, my=e.clientY-r.top, hots=window._newsHot||[]; for(var i=0;i<hots.length;i++){ if(Math.abs(hots[i].x-mx)<9&&my<34)return hots[i]; } return null; }
  chart.addEventListener('mousemove',function(e){ var h=near(e);
    if(h&&h.items&&h.items.length){ tip.innerHTML=h.items.map(function(it){ var d=new Date(it.t), tm=isFinite(d)?d.toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):''; var hi=/high/i.test(it.impact||'');
        return '<div style="margin:2px 0">'+(hi?'<span style="color:var(--bear)">\u25c6</span> ':'<span style="color:var(--violet,#B794F6)">\u25c6</span> ')+'<b>'+it.title+'</b>'+(tm?'<br><span style="color:var(--muted2)">'+tm+(it.impact?' \u00b7 '+it.impact:'')+'</span>':'')+'</div>'; }).join('');
      tip.style.display='block'; tip.style.left=Math.min(e.clientX+12,innerWidth-300)+'px'; tip.style.top=(e.clientY+14)+'px'; }
    else tip.style.display='none'; });
  chart.addEventListener('mouseleave',function(){ tip.style.display='none'; });
  chart.addEventListener('click',function(e){ if(near(e)){ try{ var b=document.querySelector('[data-view="news"]'); if(b)b.click(); }catch(_){} } });
}catch(e){} },2500); });
