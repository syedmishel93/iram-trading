/* =====================================================================
   Symbol universe (specs from TradingPro workbook + extended),
   full trade calculator, leading oscillators, chart-pattern detection,
   and trading-session model.
   ===================================================================== */
const SPECS={
  // forex — contract 100000; JPY pairs pip 0.01
  EURUSD:{name:'EUR/USD',cls:'forex',pip:0.0001,contract:100000,dpp:10,px:1.0842},
  GBPUSD:{name:'GBP/USD',cls:'forex',pip:0.0001,contract:100000,dpp:10,px:1.2710},
  USDJPY:{name:'USD/JPY',cls:'forex',pip:0.01,contract:100000,dpp:9.09,px:156.30},
  AUDUSD:{name:'AUD/USD',cls:'forex',pip:0.0001,contract:100000,dpp:10,px:0.6640},
  USDCHF:{name:'USD/CHF',cls:'forex',pip:0.0001,contract:100000,dpp:10,px:0.8880},
  USDCAD:{name:'USD/CAD',cls:'forex',pip:0.0001,contract:100000,dpp:10,px:1.3720},
  NZDUSD:{name:'NZD/USD',cls:'forex',pip:0.0001,contract:100000,dpp:10,px:0.6080},
  EURJPY:{name:'EUR/JPY',cls:'forex',pip:0.01,contract:100000,dpp:9.09,px:169.5},
  GBPJPY:{name:'GBP/JPY',cls:'forex',pip:0.01,contract:100000,dpp:9.09,px:198.6},
  EURGBP:{name:'EUR/GBP',cls:'forex',pip:0.0001,contract:100000,dpp:12.7,px:0.8530},
  AUDJPY:{name:'AUD/JPY',cls:'forex',pip:0.01,contract:100000,dpp:9.09,px:103.8},
  EURAUD:{name:'EUR/AUD',cls:'forex',pip:0.0001,contract:100000,dpp:6.6,px:1.633},
  // crypto
  BTCUSD:{name:'BTC/USD',cls:'crypto',pip:1,contract:1,dpp:1,px:68420},
  ETHUSD:{name:'ETH/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:3456},
  SOLUSD:{name:'SOL/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:172},
  XRPUSD:{name:'XRP/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.612},
  BNBUSD:{name:'BNB/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:604},
  DOGEUSD:{name:'DOGE/USD',cls:'crypto',pip:0.00001,contract:1,dpp:1,px:0.148},
  ADAUSD:{name:'ADA/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.442},
  AVAXUSD:{name:'AVAX/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:31.2},
  DOTUSD:{name:'DOT/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:5.85},
  LINKUSD:{name:'LINK/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:16.4},
  POLUSD:{name:'POL (MATIC)/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.38},
  LTCUSD:{name:'LTC/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:92.5},
  TRXUSD:{name:'TRX/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.24},
  SHIBUSD:{name:'SHIB/USD',cls:'crypto',pip:1e-8,contract:1,dpp:1,px:0.0000175},
  UNIUSD:{name:'UNI/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:9.6},
  ATOMUSD:{name:'ATOM/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:5.1},
  NEARUSD:{name:'NEAR/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:3.4},
  APTUSD:{name:'APT/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:6.8},
  ARBUSD:{name:'ARB/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.52},
  OPUSD:{name:'OP/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:1.05},
  PEPEUSD:{name:'PEPE/USD',cls:'crypto',pip:1e-9,contract:1,dpp:1,px:0.0000095},
  SUIUSD:{name:'SUI/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:2.35},
  TONUSD:{name:'TON/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:3.9},
  ICPUSD:{name:'ICP/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:6.2},
  FILUSD:{name:'FIL/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:3.15},
  INJUSD:{name:'INJ/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:12.8},
  WIFUSD:{name:'WIF/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.62},
  BONKUSD:{name:'BONK/USD',cls:'crypto',pip:1e-8,contract:1,dpp:1,px:0.0000118},
  FLOKIUSD:{name:'FLOKI/USD',cls:'crypto',pip:1e-7,contract:1,dpp:1,px:0.000052},
  SHIBUSD:{name:'SHIB/USD',cls:'crypto',pip:1e-8,contract:1,dpp:1,px:0.0000121},
  SEIUSD:{name:'SEI/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.171},
  TIAUSD:{name:'TIA/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:1.42},
  JUPUSD:{name:'JUP/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.36},
  RENDERUSD:{name:'RENDER/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:2.85},
  FETUSD:{name:'FET/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.55},
  ONDOUSD:{name:'ONDO/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.71},
  ENAUSD:{name:'ENA/USD',cls:'crypto',pip:0.0001,contract:1,dpp:1,px:0.26},
  PENGUUSD:{name:'PENGU/USD',cls:'crypto',pip:1e-6,contract:1,dpp:1,px:0.0148},
  HYPEUSD:{name:'HYPE/USD',cls:'crypto',pip:0.001,contract:1,dpp:1,px:38.5},
  TAOUSD:{name:'TAO/USD',cls:'crypto',pip:0.01,contract:1,dpp:1,px:335},
  BTCPERP:{name:'BTC-PERP',cls:'cryptofut',pip:0.1,contract:1,dpp:1,px:68450,maxLev:125},
  ETHPERP:{name:'ETH-PERP',cls:'cryptofut',pip:0.01,contract:1,dpp:1,px:3520,maxLev:100},
  SOLPERP:{name:'SOL-PERP',cls:'cryptofut',pip:0.001,contract:1,dpp:1,px:172,maxLev:75},
  XRPPERP:{name:'XRP-PERP',cls:'cryptofut',pip:0.0001,contract:1,dpp:1,px:0.63,maxLev:75},
  BNBPERP:{name:'BNB-PERP',cls:'cryptofut',pip:0.01,contract:1,dpp:1,px:596,maxLev:75},
  DOGEPERP:{name:'DOGE-PERP',cls:'cryptofut',pip:0.00001,contract:1,dpp:1,px:0.128,maxLev:75},
  AVAXPERP:{name:'AVAX-PERP',cls:'cryptofut',pip:0.001,contract:1,dpp:1,px:31.2,maxLev:50},
  LINKPERP:{name:'LINK-PERP',cls:'cryptofut',pip:0.001,contract:1,dpp:1,px:16.4,maxLev:50},
  PEPEPERP:{name:'PEPE-PERP',cls:'cryptofut',pip:1e-9,contract:1,dpp:1,px:0.0000095,maxLev:25},
  SUIPERP:{name:'SUI-PERP',cls:'cryptofut',pip:0.0001,contract:1,dpp:1,px:2.35,maxLev:50},
  // metals
  XAUUSD:{name:'Gold',cls:'metal',pip:0.01,contract:100,dpp:1,px:2352},
  XAGUSD:{name:'Silver',cls:'metal',pip:0.001,contract:5000,dpp:5,px:30.4},
  // indices
  NAS100:{name:'Nasdaq 100',cls:'index',pip:0.01,contract:1,dpp:1,px:20180},
  US30:{name:'Dow 30',cls:'index',pip:1,contract:1,dpp:1,px:42150},
  SPX500:{name:'S&P 500',cls:'index',pip:0.1,contract:1,dpp:1,px:5810},
  GER40:{name:'DAX 40',cls:'index',pip:0.1,contract:1,dpp:1,px:18520},
  UK100:{name:'FTSE 100',cls:'index',pip:0.5,contract:1,dpp:1,px:8210},
  // stocks
  AAPL:{name:'Apple',cls:'stock',pip:0.01,contract:1,dpp:1,px:229.3},
  NVDA:{name:'Nvidia',cls:'stock',pip:0.01,contract:1,dpp:1,px:126.4},
  TSLA:{name:'Tesla',cls:'stock',pip:0.01,contract:1,dpp:1,px:250.2},
  MSFT:{name:'Microsoft',cls:'stock',pip:0.01,contract:1,dpp:1,px:449.5},
};
/* ── v39.12 · ONE spec-driven unit resolver ─────────────────────────────
   The v39.11 sniper bug: a $64,706 crypto stop distance rendered as
   "15,741 pips" because the card's unit logic fell to an FX fallback
   (px>50?0.01:0.0001) whenever CURSYM.cls momentarily read 'forex'. This
   recovers class + pip from the SYMBOL SPEC — CURSYM.spec, else
   SPECS[CURSYM.sym], else SPECS[#symSel] — so units follow the instrument,
   not a volatile global. Guard of last resort: an asset priced >1000 is
   never a 0.01-pip forex pair. Glass-box: no guessing where a spec exists. */
function symSpecNow(){
  try{
    var c=(typeof CURSYM!=='undefined'&&CURSYM)||{};
    if(c.spec&&c.spec.cls)return c.spec;
    var sym=c.sym;
    if(!sym||!SPECS[sym]){var el=document.getElementById('symSel');if(el&&SPECS[el.value])sym=el.value;}
    if(sym&&SPECS[sym])return SPECS[sym];
  }catch(_){}
  return null;
}
window.symUnit=function(px){
  var sp=symSpecNow();
  var cls=sp?sp.cls:null;
  var price=(px!=null&&isFinite(px))?px:(sp?sp.px:null);
  var pip=(sp&&isFinite(sp.pip))?sp.pip:null;
  if(pip==null){ pip=(price!=null&&price>1000)?1:(price!=null&&price>50)?0.01:0.0001; }
  var ptsLike=(cls==='crypto'||cls==='metal'||cls==='stock');
  /* an asset priced >1000 called 'forex' (or unknown) is impossible → points */
  if(!ptsLike&&price!=null&&price>1000){cls='pts';pip=1;ptsLike=true;}
  var pxDec = cls==='crypto' ? (price>=1000?1:(price>=1?2:5))
            : cls==='metal'  ? 2
            : cls==='stock'  ? 2
            : cls==='pts'    ? 1
            : 5;   /* forex */
  function distFmt(d){
    d=Math.abs(+d||0);
    if(cls==='metal') return d.toFixed(1)+' pts';
    if(ptsLike)       return '$'+d.toFixed(d>=100?0:1);
    return (d/pip).toFixed(1)+' pips';
  }
  return { cls:cls, pip:pip, pxDec:pxDec, px:price, ptsLike:ptsLike, distFmt:distFmt,
           fmtPx:function(v){return (v==null||!isFinite(v))?'\u2014':(+v).toFixed(pxDec);} };
};
function populateSymbols(cls){
  const sel=document.getElementById('symSel');sel.innerHTML='';
  Object.entries(SPECS).filter(([k,s])=>s.cls===cls).forEach(([k,s])=>{const o=document.createElement('option');o.value=k;o.textContent=s.name;sel.appendChild(o)});
  const kSym=document.getElementById('kSym');
  if(kSym&&!kSym._filled){Object.entries(SPECS).forEach(([k,s])=>{const o=document.createElement('option');o.value=k;o.textContent=`${s.name} (${k})`;kSym.appendChild(o)});const cu=document.createElement('option');cu.value='CUSTOM';cu.textContent='── Custom (manual, offline) ──';kSym.appendChild(cu);kSym._filled=1}
}

/* ---------- leading oscillators (added to IND) ---------- */
IND.stoch=function(d,k=14,dsm=3){const K=[];for(let i=0;i<d.length;i++){if(i<k-1){K.push(null);continue}let hh=-1e18,ll=1e18;for(let j=i-k+1;j<=i;j++){hh=Math.max(hh,d[j].h);ll=Math.min(ll,d[j].l)}K.push((d[i].c-ll)/((hh-ll)||1)*100)}const D=IND.sma(K.map(v=>v==null?0:v),dsm);return{K,D}};
IND.willr=function(d,p=14){const r=[];for(let i=0;i<d.length;i++){if(i<p-1){r.push(null);continue}let hh=-1e18,ll=1e18;for(let j=i-p+1;j<=i;j++){hh=Math.max(hh,d[j].h);ll=Math.min(ll,d[j].l)}r.push((hh-d[i].c)/((hh-ll)||1)*-100)}return r};
IND.cci=function(d,p=20){const tp=d.map(c=>(c.h+c.l+c.c)/3);const sma=IND.sma(tp,p);const r=[];for(let i=0;i<d.length;i++){if(i<p-1){r.push(null);continue}let md=0;for(let j=i-p+1;j<=i;j++)md+=Math.abs(tp[j]-sma[i]);md/=p;r.push((tp[i]-sma[i])/(0.015*(md||1e-9)))}return r};
IND.ao=function(d){const med=d.map(c=>(c.h+c.l)/2);const f=IND.sma(med,5),s=IND.sma(med,34);return med.map((_,i)=>(f[i]!=null&&s[i]!=null)?f[i]-s[i]:null)};
IND.roc=function(a,p=12){return a.map((v,i)=>i<p?null:(v-a[i-p])/(a[i-p]||1e-9)*100)};
IND.mfi=function(d,p=14){const tp=d.map(c=>(c.h+c.l+c.c)/3);const out=new Array(d.length).fill(null);for(let i=p;i<d.length;i++){let pos=0,neg=0;for(let j=i-p+1;j<=i;j++){const mf=tp[j]*d[j].v;if(tp[j]>tp[j-1])pos+=mf;else if(tp[j]<tp[j-1])neg+=mf}out[i]=100-100/(1+pos/(neg||1e-9))}return out};
IND.adx=function(d,p=14){const tr=[],pDM=[],mDM=[];for(let i=0;i<d.length;i++){if(i===0){tr.push(0);pDM.push(0);mDM.push(0);continue}const up=d[i].h-d[i-1].h,dn=d[i-1].l-d[i].l;pDM.push(up>dn&&up>0?up:0);mDM.push(dn>up&&dn>0?dn:0);tr.push(Math.max(d[i].h-d[i].l,Math.abs(d[i].h-d[i-1].c),Math.abs(d[i].l-d[i-1].c)))}const sm=arr=>{const o=new Array(arr.length).fill(null);let s=0;for(let i=1;i<=p&&i<arr.length;i++)s+=arr[i];o[p]=s;for(let i=p+1;i<arr.length;i++){s=s-s/p+arr[i];o[i]=s}return o};const str=sm(tr),sp=sm(pDM),smi=sm(mDM);const dx=new Array(d.length).fill(null);for(let i=0;i<d.length;i++){if(str[i]==null||str[i]===0)continue;const pdi=100*sp[i]/str[i],mdi=100*smi[i]/str[i];dx[i]=100*Math.abs(pdi-mdi)/((pdi+mdi)||1)}const adx=new Array(d.length).fill(null);let cnt=0,sum=0;for(let i=0;i<d.length;i++){if(dx[i]==null)continue;cnt++;sum+=dx[i];if(cnt===p)adx[i]=sum/p;else if(cnt>p&&adx[i-1]!=null)adx[i]=(adx[i-1]*(p-1)+dx[i])/p}return adx};
// Kinetic Flux — transparent hybrid momentum × volume-flow oscillator (open interpretation of the concept)
IND.flux=function(d,p=9){const c=d.map(x=>x.c);const atr=IND.atr(d,14);const vsma=IND.sma(d.map(x=>x.v),20);const raw=d.map((x,i)=>{if(i<1||atr[i]==null||!vsma[i])return 0;const vel=(c[i]-c[i-1])/(atr[i]||1e-9);const part=x.v/(vsma[i]||1);return vel*part});return IND.ema(raw,p).map(v=>v*20)};
/* ================= robust statistics (outlier filtering) ================= */
function _median(a){const b=a.filter(v=>v!=null&&isFinite(v)).sort((x,y)=>x-y);if(!b.length)return 0;const m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2}
function _mad(a){const m=_median(a);return _median(a.filter(v=>v!=null&&isFinite(v)).map(v=>Math.abs(v-m)))*1.4826}
function _winsor(a,k=3){const m=_median(a),s=_mad(a)||1e-9;return a.map(v=>v==null?null:Math.max(m-k*s,Math.min(m+k*s,v)))}
/* ================= extended indicator pack ================= */
IND.stochRSI=function(c,p=14){const r=IND.rsi(c,p),out=new Array(c.length).fill(null);for(let i=2*p;i<c.length;i++){let hi=-1e18,lo=1e18;for(let j=i-p+1;j<=i;j++){if(r[j]==null)continue;hi=Math.max(hi,r[j]);lo=Math.min(lo,r[j])}out[i]=(r[i]-lo)/((hi-lo)||1)*100}return out};
IND.obv=function(d){const o=new Array(d.length).fill(0);for(let i=1;i<d.length;i++)o[i]=o[i-1]+(d[i].c>d[i-1].c?d[i].v:d[i].c<d[i-1].c?-d[i].v:0);return o};
IND.cmf=function(d,p=20){const mfv=d.map(c=>{const r=(c.h-c.l)||1e-9;return ((c.c-c.l)-(c.h-c.c))/r*(c.v||0)}),out=new Array(d.length).fill(null);for(let i=p-1;i<d.length;i++){let s=0,v=0;for(let j=i-p+1;j<=i;j++){s+=mfv[j];v+=d[j].v||0}out[i]=s/(v||1e-9)}return out};
IND.keltner=function(d,p=20,mult=2){const c=d.map(x=>x.c),mid=IND.ema(c,p),atr=IND.atr(d,p);return {mid,up:mid.map((v,i)=>v==null||atr[i]==null?null:v+mult*atr[i]),lo:mid.map((v,i)=>v==null||atr[i]==null?null:v-mult*atr[i])}};
IND.donchian=function(d,p=20){const up=new Array(d.length).fill(null),lo=new Array(d.length).fill(null),mid=new Array(d.length).fill(null);for(let i=p-1;i<d.length;i++){let h=-1e18,l=1e18;for(let j=i-p+1;j<=i;j++){h=Math.max(h,d[j].h);l=Math.min(l,d[j].l)}up[i]=h;lo[i]=l;mid[i]=(h+l)/2}return {up,lo,mid}};
IND.aroon=function(d,p=25){const up=new Array(d.length).fill(null),dn=new Array(d.length).fill(null);for(let i=p;i<d.length;i++){let hi=-1e18,lo=1e18,hI=i,lI=i;for(let j=i-p;j<=i;j++){if(d[j].h>=hi){hi=d[j].h;hI=j}if(d[j].l<=lo){lo=d[j].l;lI=j}}up[i]=100*(p-(i-hI))/p;dn[i]=100*(p-(i-lI))/p}return {up,dn}};
IND.vortex=function(d,p=14){const vp=new Array(d.length).fill(null),vm=new Array(d.length).fill(null);for(let i=p;i<d.length;i++){let sp=0,sm=0,tr=0;for(let j=i-p+1;j<=i;j++){sp+=Math.abs(d[j].h-d[j-1].l);sm+=Math.abs(d[j].l-d[j-1].h);tr+=Math.max(d[j].h-d[j].l,Math.abs(d[j].h-d[j-1].c),Math.abs(d[j].l-d[j-1].c))}vp[i]=sp/(tr||1e-9);vm[i]=sm/(tr||1e-9)}return {vp,vm}};
IND.chop=function(d,p=14){const a=IND.atr(d,1),out=new Array(d.length).fill(null);for(let i=p;i<d.length;i++){let s=0,hh=-1e18,ll=1e18;for(let j=i-p+1;j<=i;j++){s+=a[j]||0;hh=Math.max(hh,d[j].h);ll=Math.min(ll,d[j].l)}out[i]=100*Math.log10(s/((hh-ll)||1e-9))/Math.log10(p)}return out};
IND.tsi=function(c,r=25,s=13){const m=c.map((v,i)=>i?v-c[i-1]:0),e2=IND.ema(IND.ema(m,r),s),a2=IND.ema(IND.ema(m.map(Math.abs),r),s);return c.map((_,i)=>(e2[i]!=null&&a2[i])?100*e2[i]/(a2[i]||1e-9):null)};
IND.ult=function(d,s1=7,s2=14,s3=28){const bp=new Array(d.length).fill(0),tr=new Array(d.length).fill(0);for(let i=1;i<d.length;i++){const low=Math.min(d[i].l,d[i-1].c);bp[i]=d[i].c-low;tr[i]=Math.max(d[i].h,d[i-1].c)-low}const avg=(p,i)=>{let sb=0,st=0;for(let j=i-p+1;j<=i;j++){sb+=bp[j];st+=tr[j]}return sb/(st||1e-9)},out=new Array(d.length).fill(null);for(let i=s3;i<d.length;i++)out[i]=100*(4*avg(s1,i)+2*avg(s2,i)+avg(s3,i))/7;return out};
IND.hv=function(c,p=20){const r=c.map((v,i)=>i?Math.log(v/c[i-1]):0),out=new Array(c.length).fill(null);for(let i=p;i<c.length;i++){const s=r.slice(i-p+1,i+1),m=s.reduce((a,b)=>a+b,0)/p;out[i]=Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/p)*Math.sqrt(252)*100}return out};
IND.zscore=function(c,p=20){const out=new Array(c.length).fill(null);for(let i=p-1;i<c.length;i++){let m=0;for(let j=i-p+1;j<=i;j++)m+=c[j];m/=p;let v=0;for(let j=i-p+1;j<=i;j++)v+=(c[j]-m)**2;out[i]=(c[i]-m)/((Math.sqrt(v/p))||1e-9)}return out};
/* ================= per-indicator historical accuracy (data-driven weighting) =================
   Replays each indicator's vote across history and measures how often it predicted the
   direction of the next `hz` bars — on THIS instrument & timeframe. With live data
   (online mode) this tunes the consensus to the real market, not assumptions. */

/* ================= v39.19 ASSET ICONS + RISK FLAGS ================= */
/* Bundled, offline-first: a brand-coloured disc with the coin's glyph for known
   assets, a hash-coloured monogram for everything else. If the online "update"
   option is enabled and populated window._iconCDN / window._riskList, those win. */
window.ASSET_META = {
  BTCUSD:{g:'\u20bf',c:'#F7931A'}, ETHUSD:{g:'\u039e',c:'#627EEA'}, SOLUSD:{g:'SOL',c:'#14B98A'},
  XRPUSD:{g:'XRP',c:'#23A9E0'}, BNBUSD:{g:'BNB',c:'#E0A611'}, DOGEUSD:{g:'\u00d0',c:'#C2A633'},
  ADAUSD:{g:'ADA',c:'#2A6DDF'}, AVAXUSD:{g:'AVX',c:'#E84142'}, LINKUSD:{g:'LNK',c:'#2A5ADA'},
  LTCUSD:{g:'LTC',c:'#5A6572'}, MATICUSD:{g:'MTC',c:'#8247E5'}, DOTUSD:{g:'DOT',c:'#E6007A'},
  XAUUSD:{g:'Au',c:'#E8A33D'}, XAGUSD:{g:'Ag',c:'#9AA3B0'},
  EURUSD:{g:'\u20ac',c:'#5B8DEF'}, GBPUSD:{g:'\u00a3',c:'#5B8DEF'}, USDJPY:{g:'\u00a5',c:'#5B8DEF'},
  AUDUSD:{g:'A$',c:'#5B8DEF'}, USDCAD:{g:'C$',c:'#5B8DEF'}, USDCHF:{g:'Fr',c:'#5B8DEF'},
  MSFT:{g:'MS',c:'#5B8DEF'}
};
function _iconHue(s){ var h=0; s=String(s||'?'); for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0; return h%360; }
function _defaultLogo(sym){
  try{ if(window._assetLogosOn===false)return null; var sp=(typeof SPECS!=='undefined'&&SPECS[sym])||null; if(!sp)return null;
    if(sp.cls==='crypto'||sp.cls==='cryptofut'){ var base=String(sym).replace(/USDT?$/,'').replace(/PERP$/,'').toLowerCase(); if(base) return 'https://cdn.jsdelivr.net/gh/atomiclabs/cryptocurrency-icons@master/128/color/'+base+'.png'; }
  }catch(e){} return null;
}
window.assetIcon=function(sym, size){
  size=size||16;
  try{
    var m=(window.ASSET_META&&ASSET_META[sym])||null;
    var glyph=m?m.g:String(sym||'?').replace(/USDT?$/,'').replace(/PERP$/,'').slice(0,3);
    var color=m?m.c:('hsl('+_iconHue(sym)+',48%,46%)');
    var fs=glyph.length>2?7:(glyph.length>1?8.5:10);
    var url=(window._iconCDN&&window._iconCDN[sym])||_defaultLogo(sym);   /* real logo (override or default CDN) */
    var out='<span class="aicon mono" style="position:relative;width:'+size+'px;height:'+size+'px;background:'+color+';font-size:'+fs+'px" title="'+sym+'">'+glyph;
    if(url) out+='<img src="'+url+'" alt="" loading="lazy" decoding="async" style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover" onerror="this.style.display=\'none\'">';   /* real logo overlays the disc; on error the brand disc shows */
    return out+'</span>';
  }catch(e){ return ''; }
};
/* Risk read. LOW-LIQ is computed from real data (thin volume / wide spread).
   DELIST risk is only claimed when a real source says so (the online risk list) or
   a symbol that HAD data has seen volume collapse toward zero -- never guessed. */
window.assetRisk=function(sym){
  try{
    if(window._riskList && window._riskList[sym]){ var r=window._riskList[sym];
      var mp0={ok:'',lowliq:'LOW LIQ',delist:'DELIST RISK'}; return {level:r.level||'ok',label:mp0[r.level||'ok']||'',cls:(r.level==='delist'?'bear':r.level==='lowliq'?'warn':''),reasons:[r.reason||'flagged by risk source']}; }
    var sp=(typeof SPECS!=='undefined'&&SPECS[sym])||null;
    var bars=null;
    try{ if(window.CURSYM&&CURSYM.sym===sym&&typeof DATA!=='undefined'&&DATA.length) bars=DATA;
      else { var BC=(typeof BAR_CACHE!=='undefined')?BAR_CACHE:{}; for(var k in BC){ if(k.indexOf(sym+'|')===0){ bars=BC[k]; break; } } } }catch(e){}
    var level='ok', reasons=[];
    if(bars && bars.length>5){
      var recent=bars.slice(-20), sv=0, nz=0;
      recent.forEach(function(b){ if(b.v!=null){ sv+=b.v; if(b.v>0)nz++; } });
      var avgV=recent.length?sv/recent.length:0;
      if(nz>0 && avgV<=0){ level='delist'; reasons.push('volume collapsed to zero'); }
      else if(nz>0 && nz<recent.length*0.4){ level='lowliq'; reasons.push('sporadic volume'); }
    }
    try{ if(window.CURSYM&&CURSYM.sym===sym&&window._oflow&&window._oflow.spread){ var s=window._oflow.spread; var pct=(s.ask-s.bid)/(s.ask||1); if(pct>0.0012){ if(level==='ok')level='lowliq'; reasons.push('wide spread ('+(pct*100).toFixed(2)+'%)'); } } }catch(e){}
    var mp={ok:'',lowliq:'LOW LIQ',delist:'DELIST RISK'};
    return {level:level,label:mp[level],cls:(level==='delist'?'bear':level==='lowliq'?'warn':''),reasons:reasons};
  }catch(e){ return {level:'ok',label:'',cls:'',reasons:[]}; }
};
/* Update option: when enabled + a source URL is set, pull fresh icon logos and a
   coin risk/delisting list through the proxy. Offline default uses bundled data. */
window.updateAssetData=async function(){
  try{
    if(!window._assetUpdateOn) return;
    var base=(typeof proxyBase==='function'&&proxyBase())||''; if(!base) return;
    var iu=((document.getElementById('dsIconUrl')||{}).value||'').trim();
    var ru=((document.getElementById('dsRiskUrl')||{}).value||'').trim();
    if(iu){ try{ var ri=await fetch(base+'/fetch?url='+encodeURIComponent(iu),{signal:AbortSignal.timeout(6000)}); var ji=await ri.json(); if(ji&&typeof ji==='object') window._iconCDN=ji; }catch(e){} }
    if(ru){ try{ var rr=await fetch(base+'/fetch?url='+encodeURIComponent(ru),{signal:AbortSignal.timeout(6000)}); var jr=await rr.json(); if(jr&&typeof jr==='object') window._riskList=jr; }catch(e){} }
    if(typeof renderWatchlist==='function')try{renderWatchlist()}catch(e){}
  }catch(e){}
};
setInterval(function(){try{window.updateAssetData&&window.updateAssetData()}catch(e){}},600000);
document.addEventListener('DOMContentLoaded',function(){ try{
  var cb=document.getElementById('assetUpdateOn'); if(!cb)return;
  try{ cb.checked=localStorage.getItem('mishel_assetUpdate')==='1'; }catch(e){}
  window._assetUpdateOn=cb.checked;
  cb.addEventListener('change',function(){ window._assetUpdateOn=cb.checked; try{localStorage.setItem('mishel_assetUpdate',cb.checked?'1':'0')}catch(e){} if(cb.checked&&window.updateAssetData)window.updateAssetData(); });
  if(window._assetUpdateOn&&window.updateAssetData)window.updateAssetData();
}catch(e){} });
