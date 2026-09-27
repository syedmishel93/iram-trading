let _cbull=null,_cbear=null;
/* v14.1 C2 — muted candle skin: mutes the canvas up/down colours toward a cool slate,
   independent of theme, without touching the CSS/UI palette. Covers 2D and GPU paths. */
let CANDLE_SKIN='vivid';
const CANDLE_GREY=[126,138,158],CANDLE_MUTE_T=0.34;
function _hex2rgb(x){x=(x||'').trim();let m=x.match(/^#([0-9a-f]{3})$/i);if(m)return[parseInt(m[1][0]+m[1][0],16),parseInt(m[1][1]+m[1][1],16),parseInt(m[1][2]+m[1][2],16)];m=x.match(/^#([0-9a-f]{6})/i);if(m)return[parseInt(m[1].slice(0,2),16),parseInt(m[1].slice(2,4),16),parseInt(m[1].slice(4,6),16)];m=x.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);if(m)return[+m[1],+m[2],+m[3]];return null}
function _muteRGB(rgb){return[Math.round(rgb[0]+(CANDLE_GREY[0]-rgb[0])*CANDLE_MUTE_T),Math.round(rgb[1]+(CANDLE_GREY[1]-rgb[1])*CANDLE_MUTE_T),Math.round(rgb[2]+(CANDLE_GREY[2]-rgb[2])*CANDLE_MUTE_T)]}
function _candleTint(base){if(CANDLE_SKIN!=='muted')return base;const rgb=_hex2rgb(base);if(!rgb)return base;const m=_muteRGB(rgb);return 'rgb('+m[0]+','+m[1]+','+m[2]+')'}
function setCandleSkin(v){CANDLE_SKIN=(v==='muted')?'muted':'vivid';_cbull=_cbear=null;try{localStorage.setItem('mishel_candle',CANDLE_SKIN)}catch(e){}const s=document.getElementById('setCandle');if(s)s.value=CANDLE_SKIN;try{if(document.getElementById('v-chart').classList.contains('on'))draw();if(document.getElementById('v-multi').classList.contains('on'))renderMulti()}catch(e){}}
function var_bull(){if(_cbull===null)_cbull=_candleTint(getComputedStyle(document.documentElement).getPropertyValue('--bull').trim());return _cbull}
function var_bear(){if(_cbear===null)_cbear=_candleTint(getComputedStyle(document.documentElement).getPropertyValue('--bear').trim());return _cbear}
IND.vwapBands=function(d){const vw=[],u1=[],l1=[],u2=[],l2=[];let cumPV=0,cumV=0,cumPV2=0;for(let i=0;i<d.length;i++){const tp=(d[i].h+d[i].l+d[i].c)/3,v=(d[i].v||1);cumPV+=tp*v;cumV+=v;cumPV2+=tp*tp*v;const vwap=cumPV/cumV;const varr=Math.max(0,cumPV2/cumV-vwap*vwap),sd=Math.sqrt(varr);vw.push(vwap);u1.push(vwap+sd);l1.push(vwap-sd);u2.push(vwap+2*sd);l2.push(vwap-2*sd)}return{vw,u1,l1,u2,l2}};
/* ---------- automatic trendline detection (fits the best-respected support & resistance lines) ---------- */
function autoTrendlines(d){
  if(d.length<40)return [];
  const N=d.length,look=Math.min(N,160),minI=N-look,sw=swings(d,3);
  const pick=(idxs,kind)=>{
    const P=idxs.filter(i=>i>=minI);if(P.length<2)return null;let best=null;
    for(let a=0;a<P.length-1;a++)for(let b=a+1;b<P.length;b++){
      const ia=P[a],ib=P[b];if(ib-ia<8)continue;
      const pa=kind==='res'?d[ia].h:d[ia].l,pb=kind==='res'?d[ib].h:d[ib].l;
      const slope=(pb-pa)/(ib-ia);let viol=0,touch=0;
      for(let k=ia;k<=N-1;k++){const lp=pa+slope*(k-ia);
        if(kind==='res'){if(d[k].h>lp*1.0012)viol++;else if(d[k].h>lp*0.999)touch++}
        else{if(d[k].l<lp*0.9988)viol++;else if(d[k].l<lp*1.001)touch++}}
      const score=(ib-ia)+touch*3-viol*5;
      if(!best||score>best.score)best={a:{i:ia,p:pa},b:{i:ib,p:pb},kind,score,touch,viol};
    }
    return best&&best.viol<=Math.max(3,look*0.05)?best:best;
  };
  return [pick(sw.hi,'res'),pick(sw.lo,'sup')].filter(Boolean);
}
/* ---------- automatic Fibonacci (anchors to the most significant recent swing) ---------- */
function autoFib(d){
  if(d.length<30)return null;
  const look=Math.min(d.length,120),s=d.length-look;let hi=-Infinity,lo=Infinity,hiI=s,loI=s;
  for(let i=s;i<d.length;i++){if(d[i].h>hi){hi=d[i].h;hiI=i}if(d[i].l<lo){lo=d[i].l;loI=i}}
  const up=loI<hiI,rng=hi-lo||1;const R=[0,0.236,0.382,0.5,0.618,0.786,1];
  return {hi:{i:hiI,p:hi},lo:{i:loI,p:lo},up,levels:R.map(r=>({r,price:up?hi-rng*r:lo+rng*r}))};
}
/* ---------- LuxAlgo-style premium overlays ---------- */
/* Nadaraya-Watson envelope: Gaussian-kernel regression of price + mean-abs-error bands (repaints near the right edge, like the original). */
IND.nadaraya=function(c,h=8,mult=3){const n=c.length,mid=new Array(n),win=Math.ceil(h*3);for(let i=0;i<n;i++){let num=0,den=0;const a=Math.max(0,i-win),b=Math.min(n-1,i+win);for(let j=a;j<=b;j++){const w=Math.exp(-((i-j)*(i-j))/(2*h*h));num+=w*c[j];den+=w}mid[i]=num/den}let mae=0;for(let i=0;i<n;i++)mae+=Math.abs(c[i]-mid[i]);mae=(mae/n)*mult;return {mid,up:mid.map(v=>v+mae),lo:mid.map(v=>v-mae)}};
/* Predictive Ranges: ATR-stepped adaptive mean with ±1/±2 range bounds. */
IND.predRanges=function(d,mult=6){const atrA=IND.atr(d),n=d.length,mid=new Array(n),u1=new Array(n),l1=new Array(n),u2=new Array(n),l2=new Array(n);let avg=d[0].c,held=d[0].c*0.01;for(let i=0;i<n;i++){const a=(atrA[i]||held);held=a;const v=a*mult;if(v>0){if(d[i].c-avg>v)avg+=v*Math.floor((d[i].c-avg)/v);else if(avg-d[i].c>v)avg-=v*Math.floor((avg-d[i].c)/v)}mid[i]=avg;u1[i]=avg+v;l1[i]=avg-v;u2[i]=avg+2*v;l2[i]=avg-2*v}return {mid,u1,l1,u2,l2}};
/* Divergence auto-scanner across RSI / MACD / MFI over recent swings. */
function divScanAll(d){if(d.length<40)return [];const c=d.map(x=>x.c),sw=swings(d,3),out=[];const oscs={RSI:IND.rsi(c),MACD:IND.macd(c).hist,MFI:IND.mfi(d)};for(const name in oscs){const o=oscs[name];const H=sw.hi.slice(-5),L=sw.lo.slice(-5);for(let k=1;k<H.length;k++){const a=H[k-1],b=H[k];if(o[a]==null||o[b]==null)continue;if(d[b].h>d[a].h&&o[b]<o[a])out.push({osc:name,dir:'bear',type:name+' bearish',pts:[{i:a,p:d[a].h},{i:b,p:d[b].h}]})}for(let k=1;k<L.length;k++){const a=L[k-1],b=L[k];if(o[a]==null||o[b]==null)continue;if(d[b].l<d[a].l&&o[b]>o[a])out.push({osc:name,dir:'bull',type:name+' bullish',pts:[{i:a,p:d[a].l},{i:b,p:d[b].l}]})}}return out.slice(-8)}
/* Anchored VWAP from a given absolute bar index. */
function avwapFrom(anchor){const n=DATA.length,out=new Array(n).fill(null);let cpv=0,cv=0;for(let i=Math.max(0,Math.round(anchor));i<n;i++){const tp=(DATA[i].h+DATA[i].l+DATA[i].c)/3,v=DATA[i].v||1;cpv+=tp*v;cv+=v;out[i]=cpv/cv}return out}
function fmt(p){return p>=1000?p.toLocaleString('en-US',{maximumFractionDigits:1}):p>=1?p.toFixed(2):p.toFixed(4)}

/* ================= v15.1 CHARTING PACK — AVWAP sigma-bands · axis heat · drawing templates ================= */
/* -- pure logic (unit-tested) -- */
function avwapBandsFrom(anchor,d){ /* vol-weighted mean + vol-weighted sigma from anchor: real math, no smoothing tricks */
  d=d||DATA;const n=d.length,v0=new Array(n).fill(null),u1=new Array(n).fill(null),l1=new Array(n).fill(null),u2=new Array(n).fill(null),l2=new Array(n).fill(null);
  let cv=0,cpv=0,cpv2=0;
  for(let i=Math.max(0,Math.round(anchor));i<n;i++){const tp=(d[i].h+d[i].l+d[i].c)/3,vv=d[i].v||1;cv+=vv;cpv+=tp*vv;cpv2+=tp*tp*vv;
    const m=cpv/cv,varr=Math.max(0,cpv2/cv-m*m),sd=Math.sqrt(varr);
    v0[i]=m;u1[i]=m+sd;l1[i]=m-sd;u2[i]=m+2*sd;l2[i]=m-2*sd;}
  return{v:v0,u1:u1,l1:l1,u2:u2,l2:l2};
}
function newsMarkerIdx(items,vis){ /* map timestamped news items onto visible bars — items without a parseable time are never plotted */
  if(!Array.isArray(items)||!items.length||!Array.isArray(vis)||vis.length<2)return[];
  const sp=(vis[vis.length-1].t-vis[0].t)/Math.max(1,vis.length-1);if(!(sp>0))return[];
  const lo=vis[0].t,hi=vis[vis.length-1].t+sp;const byBar={};
  items.forEach(it=>{if(!it||!Number.isFinite(it.t))return;if(it.t<lo||it.t>=hi)return;
    let i=Math.floor((it.t-lo)/sp);if(i<0)i=0;if(i>vis.length-1)i=vis.length-1;
    const imp=String(it.impact||'');const hiImp=/high/i.test(imp);
    if(!byBar[i])byBar[i]={i,n:0,hi:false,items:[]};byBar[i].n++;byBar[i].hi=byBar[i].hi||hiImp;
    if(byBar[i].items.length<6)byBar[i].items.push({title:(it.title||it.n||it.event||'event'),impact:imp,t:it.t});});
  return Object.values(byBar);}
function axisHeatBuckets(d,lo,hi,bins){ /* volume-at-price buckets over the visible range -> normalized 0..1 heat */
  bins=bins||60;
  var _sig=(d?d.length:0)+'|'+lo.toFixed(4)+'|'+hi.toFixed(4)+'|'+bins;   /* v39.26: cache between frames — recompute only when the view actually changes */
  var _c=axisHeatBuckets._c; if(_c&&_c.sig===_sig&&_c.val)return _c.val;
  const bk=new Array(bins).fill(0);if(!(hi>lo)||!d||!d.length){axisHeatBuckets._c={sig:_sig,val:bk};return bk;}
  d.forEach(c=>{const span=Math.max(1e-12,c.h-c.l);const b0=Math.max(0,Math.min(bins-1,Math.floor((c.l-lo)/(hi-lo)*bins))),b1=Math.max(0,Math.min(bins-1,Math.floor((c.h-lo)/(hi-lo)*bins)));
    const per=(c.v||1)/((b1-b0+1)||1);for(let b=b0;b<=b1;b++)bk[b]+=per;});
  const mx=Math.max.apply(null,bk)||1;var _nb=bk.map(v=>v/mx);axisHeatBuckets._c={sig:_sig,val:_nb};return _nb;
}
/* -- drawing templates: named sets, per-symbol-agnostic (bars/prices are absolute; honest note shown on apply) -- */
function _tplStore(){try{return JSON.parse(localStorage.getItem('mishel_drawtpl')||'{}')||{}}catch(e){return{}}}
function saveDrawTemplate(name,drawings){if(!name)return false;const s=_tplStore();s[name]={saved:Date.now(),items:(drawings||[]).slice(0,150)};try{STORE.set('mishel_drawtpl',JSON.stringify(s))}catch(e){return false}return true}
function listDrawTemplates(){const s=_tplStore();return Object.keys(s).sort().map(k=>({name:k,n:(s[k].items||[]).length,saved:s[k].saved}))}
function applyDrawTemplate(name){const s=_tplStore();const t=s[name];if(!t)return null;return JSON.parse(JSON.stringify(t.items||[]))}
function deleteDrawTemplate(name){const s=_tplStore();if(!(name in s))return false;delete s[name];try{STORE.set('mishel_drawtpl',JSON.stringify(s))}catch(e){}return true}
function tplUI(){
  const names=listDrawTemplates();
  const pick=prompt('Drawing templates\n\nType a NEW name to save the current '+DRAWINGS.length+' drawing(s) as a template,\nor type an existing name to APPLY it'+(names.length?('\n\nSaved: '+names.map(t=>t.name+' ('+t.n+')').join(' \u00b7 ')):'\n\n(none saved yet)')+'\n\nPrefix with - to delete (e.g. -old):','');
  if(pick==null||!pick.trim())return;const nm=pick.trim();
  if(nm[0]==='-'){const del=nm.slice(1).trim();if(deleteDrawTemplate(del))toast('\u2715 Template deleted: '+del,'#8A94A6');else toast('No template named '+del,'#E8A33D');return}
  const exists=names.some(t=>t.name===nm);
  if(exists){const items=applyDrawTemplate(nm);if(items){snapDrawings();DRAWINGS=DRAWINGS.concat(items);draw();toast('\u2713 Applied template '+nm+' ('+items.length+') \u2014 note: bar positions are absolute, so on a different history length lines may sit off-screen','#2DBE8E')}}
  else{if(saveDrawTemplate(nm,DRAWINGS))toast('\u2605 Saved template '+nm+' ('+DRAWINGS.length+')','#2DBE8E');else toast('Could not save (storage full?)','#F0616D')}
}

/* ---------- manual drawing tools (TradingView-style) ---------- */
let RENDER=null,DRAWINGS=[],TOOL='cursor',drawStart=null,drawPreview=null;
function bx(bar){return (bar-RENDER.start)*RENDER.cw+RENDER.cw/2}
function byP(price){return (1-(price-RENDER.lo)/((RENDER.hi-RENDER.lo)||1))*RENDER.priceH}
function barAt(sx){return RENDER.start+(sx-RENDER.cw/2)/RENDER.cw}
function priceAt(sy){if(window.SCALE_MODE==='log'&&RENDER.lo>0){const a=Math.log(RENDER.lo),b=Math.log(RENDER.hi);return Math.exp(a+(1-sy/RENDER.priceH)*(b-a))}return RENDER.lo+(1-sy/RENDER.priceH)*(RENDER.hi-RENDER.lo)}
let SELDRAW=-1;
let DRAW_UNDO=[],DRAW_REDO=[];
function snapDrawings(){DRAW_UNDO.push(JSON.stringify(DRAWINGS));if(DRAW_UNDO.length>60)DRAW_UNDO.shift();DRAW_REDO=[]}
function undoDraw(){if(!DRAW_UNDO.length)return;DRAW_REDO.push(JSON.stringify(DRAWINGS));DRAWINGS=JSON.parse(DRAW_UNDO.pop());SELDRAW=-1;draw()}
function redoDraw(){if(!DRAW_REDO.length)return;DRAW_UNDO.push(JSON.stringify(DRAWINGS));DRAWINGS=JSON.parse(DRAW_REDO.pop());SELDRAW=-1;draw()}
function _distSeg(px,py,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,L=dx*dx+dy*dy;if(L===0)return Math.hypot(px-x1,py-y1);let t=((px-x1)*dx+(py-y1)*dy)/L;t=Math.max(0,Math.min(1,t));return Math.hypot(px-(x1+t*dx),py-(y1+t*dy))}
function drawingDist(d,px,py){if(!RENDER)return 1e9;const {W,padR}=RENDER;
  if(d.type==='hline')return Math.abs(py-byP(d.price));
  if(d.type==='vline')return Math.abs(px-bx(d.bar));
  if(d.type==='avwap')return Math.abs(px-bx(d.bar));
  if(d.type==='text')return Math.hypot(px-bx(d.bar),py-byP(d.price));
  if(d.type==='brush'&&d.points&&d.points.length)return Math.min(...d.points.map(p=>Math.hypot(px-bx(p.bar),py-byP(p.price))));
  if(d.a&&d.b){const x1=bx(d.a.bar),y1=byP(d.a.price),x2=bx(d.b.bar),y2=byP(d.b.price);
    if(['rect','fib','long','short'].includes(d.type)){const L=Math.min(x1,x2),R=Math.max(x1,x2),T=Math.min(y1,y2),B=Math.max(y1,y2);return Math.min(_distSeg(px,py,L,T,R,T),_distSeg(px,py,L,B,R,B),_distSeg(px,py,L,T,L,B),_distSeg(px,py,R,T,R,B))}
    return _distSeg(px,py,x1,y1,x2,y2);}
  return 1e9;}
function hitDrawing(px,py){let best=-1,bd=9;for(let i=DRAWINGS.length-1;i>=0;i--){const dd=drawingDist(DRAWINGS[i],px,py);if(dd<bd){bd=dd;best=i}}return best}
function highlightSelected(g){if(SELDRAW<0||SELDRAW>=DRAWINGS.length||!RENDER)return;const d=DRAWINGS[SELDRAW];g.save();g.strokeStyle='#E8A33D';g.fillStyle='#E8A33D';g.lineWidth=2;g.setLineDash([]);
  const handle=(bar,price)=>{const X=bx(bar),Y=byP(price);g.fillStyle='#E8A33D';g.fillRect(X-3.5,Y-3.5,7,7);g.strokeStyle='#0B0E14';g.lineWidth=1;g.strokeRect(X-3.5,Y-3.5,7,7)};
  if(d.type==='hline'){const yy=byP(d.price);g.strokeStyle='rgba(232,163,61,.95)';g.beginPath();g.moveTo(0,yy);g.lineTo(RENDER.W-RENDER.padR,yy);g.stroke()}
  else if(d.type==='vline'){const xx=bx(d.bar);g.strokeStyle='rgba(232,163,61,.95)';g.beginPath();g.moveTo(xx,0);g.lineTo(xx,RENDER.priceH);g.stroke()}
  else{if(d.a)handle(d.a.bar,d.a.price);if(d.b)handle(d.b.bar,d.b.price);if(d.bar!=null&&d.price!=null)handle(d.bar,d.price)}
  const ax=d.a?bx(d.a.bar):d.bar!=null?bx(d.bar):20,ay=d.a?byP(d.a.price):d.price!=null?byP(d.price):(d.type==='hline'?byP(d.price):14);
  g.fillStyle='rgba(232,163,61,.95)';g.font='9px Inter';g.textAlign='left';g.fillText('⌫ Del',ax+6,ay-8);
  g.restore()}
