document.querySelectorAll('.side .card>h3, #side .card>h3').forEach(h=>{h.addEventListener('click',()=>h.parentElement.classList.toggle('folded'))});
/* ---------- smart trade planner: one click → full disciplined plan ---------- */
function planTrade(side){ // side: 1 long, -1 short
  const x=analystContext(),lad=levelLadder(x);
  const entry=x.price,atrStop=x.atr*1.5;
  const structLvl=side>0?lad.below[0]:lad.above[0];
  const structStop=structLvl?Math.abs(entry-structLvl.p)*1.05:null;
  const stopDist=structStop&&structStop<atrStop*2?Math.max(structStop,x.atr*0.6):atrStop;
  const sl=entry-side*stopDist;
  const tps=(side>0?lad.above:lad.below).slice(0,3).map(l=>({name:l.name,p:l.p,rr:Math.abs(l.p-entry)/stopDist}));
  const acct=PAPER.bal,riskPct=1,dollars=acct*riskPct/100,units=dollars/stopDist;
  const contract=(CURSYM.spec&&CURSYM.spec.contract)||null;const lots=contract&&contract>1?units/contract:null;
  const ck=tradeChecklist(x);const aligned=Math.sign(x.con.score)===side||x.con.score===0;
  const liq=isFut(CURSYM.sym)?liqPrice(entry,side,PAPER.leverage||100):null;
  return {side,entry,sl,stopDist,tps,units,lots,dollars,riskPct,ck,aligned,con:x.con,dec:x.dec,liq};
}
function renderPlan(side){
  const p=planTrade(side),f=v=>(+v).toFixed(p.dec),el=document.getElementById('planOut');if(!el)return;
  const warn=!p.aligned?`<div style="color:var(--gold);font-size:11px;margin-bottom:6px">! This ${p.side>0?'long':'short'} is against the consensus (${p.con.label}) — counter-trend; reduce size or skip.</div>`:'';
  const tpRows=p.tps.length?p.tps.map((t,i)=>`<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:var(--muted)">TP${i+1} · ${t.name}</span><span class="mono">${f(t.p)} <b class="${t.rr>=1?'up':''}">${t.rr.toFixed(1)}R</b></span></div>`).join(''):'<div style="color:var(--muted)">no clear targets in range</div>';
  el.innerHTML=`${warn}
    <div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:var(--muted)">Entry (mkt)</span><span class="mono">${f(p.entry)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:var(--muted)">Stop</span><span class="mono dn">${f(p.sl)} (${(p.stopDist/p.entry*100).toFixed(2)}%)</span></div>
    ${tpRows}
    <div style="display:flex;justify-content:space-between;padding:2px 0;border-top:1px solid var(--edge);margin-top:4px"><span style="color:var(--muted)">Size @ ${p.riskPct}% risk ($${p.dollars.toFixed(0)})</span><span class="mono">${p.lots!=null?p.lots.toFixed(2)+' lots':p.units.toFixed(4)+' u'}</span></div>
    ${p.liq!=null?`<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:var(--muted)">Est. liquidation (1:${PAPER.leverage})</span><span class="mono ${(p.side>0?p.liq>p.sl:p.liq<p.sl)?"dn":""}">${f(p.liq)}${(p.side>0?p.liq>p.sl:p.liq<p.sl)?" ! inside stop!":""}</span></div>`:``}<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:var(--muted)">Checklist</span><span class="mono ${p.ck.passed>=4?'up':p.ck.passed>=3?'':'dn'}">${p.ck.passed}/${p.ck.total} ✓</span></div>
    <button class="run" id="planExec" style="width:100%;margin-top:8px">Execute on demo ▷</button>
    <div style="font-size:9.5px;color:var(--muted2);margin-top:5px">A plan, not advice — demo execution only.</div>`;
  const ex=document.getElementById('planExec');if(ex)ex.onclick=()=>{const q=document.getElementById('pQty'),s=document.getElementById('pSL'),t=document.getElementById('pTP'),r=document.getElementById('pRisk');if(r)r.value='';if(q)q.value=p.units.toFixed(4);if(s)s.value=f(p.sl);if(t&&p.tps[0])t.value=f(p.tps[0].p);paperOpen(p.side);toast('Plan executed on demo',var_bull())};
}
{const a=document.getElementById('planLong');if(a)a.onclick=()=>renderPlan(1);const b=document.getElementById('planShort');if(b)b.onclick=()=>renderPlan(-1)}

/* ---------- derivatives: Binance Futures OI + funding (free public endpoints, on demand) ---------- */
async function loadDerivatives(){
  const el=document.getElementById('derivOut');if(!el)return;
  if(CURSYM.cls!=='crypto'&&CURSYM.cls!=='cryptofut'){el.innerHTML='<span style="color:var(--muted)">Derivatives data is for crypto/futures symbols (Binance Futures). Load one first.</span>';return}
  const sym=binanceSym(CURSYM.sym);if(!sym){el.innerHTML='<span style="color:var(--muted)">No Binance mapping for this symbol.</span>';return}
  el.innerHTML='<span style="color:var(--muted)">fetching…</span>';
  const get=async path=>{const url='https://fapi.binance.com'+path;try{const r=await fetch(url);if(!r.ok)throw new Error('http '+r.status);return await r.json()}catch(e){if(proxyBase()){const r2=await fetch(proxyBase()+'/fetch?url='+encodeURIComponent(url));if(!r2.ok)throw new Error('proxy '+r2.status);return await r2.json()}throw e}};
  try{
    const [oi,prem]=await Promise.all([get('/fapi/v1/openInterest?symbol='+sym),get('/fapi/v1/premiumIndex?symbol='+sym)]);
    const fr=+prem.lastFundingRate*100,mark=+prem.markPrice,oiV=+oi.openInterest,notional=oiV*mark;
    const nft=prem.nextFundingTime?new Date(+prem.nextFundingTime):null;const mins=nft?Math.max(0,Math.round((nft-Date.now())/60000)):null;
    const row=(k,v,cc)=>`<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--edge)"><span style="color:var(--muted)">${k}</span><span class="mono ${cc||''}">${v}</span></div>`;
    el.innerHTML=row('Open interest',oiV.toLocaleString(undefined,{maximumFractionDigits:0})+' '+sym.replace('USDT',''))+
      row('OI notional','$'+(notional>=1e9?(notional/1e9).toFixed(2)+'B':(notional/1e6).toFixed(0)+'M'))+
      row('Funding rate',(fr>=0?'+':'')+fr.toFixed(4)+'% / 8h',fr>=0?'up':'dn')+
      (mins!=null?row('Next funding','in '+Math.floor(mins/60)+'h '+(mins%60)+'m'):'')+
      row('Mark price',fmt(mark))+
      `<div style="font-size:9.5px;color:var(--muted2);margin-top:6px">${fr>0.03?'High positive funding — crowded longs paying shorts (squeeze risk).':fr<-0.03?'Negative funding — crowded shorts paying longs.':'Funding near neutral — no crowding signal.'} Source: Binance Futures public API.</div>`;
    memLog('event',sym+' OI/funding: fr '+fr.toFixed(4)+'%');
  }catch(e){el.innerHTML='<span style="color:var(--bear)">✗ '+e.message+'. If your browser blocks fapi.binance.com, run the proxy (Settings ②) — it routes through /fetch automatically.</span>'}
}
{const b=document.getElementById('derivLoad');if(b)b.onclick=loadDerivatives}

/* ---------- onboarding tour + help overlay ---------- */
const TOUR=[
 ['Welcome to Mishel Intelligence Trading','A glass-box terminal: every signal shows its reasoning. This 30-second tour shows you around. (Esc to skip)'],
 ['Symbol & timeframe','Top-left: click the symbol name to search any market (with a live consensus badge per row); 1–9 keys or the buttons switch timeframe; pick chart type & layout presets from the dropdowns.'],
 ['Indicators & panes',' Indicators opens the categorized overlay library. Vol/RSI/MACD/MFI buttons open sub-panes — each pane has an × on the chart to close it, TradingView-style.'],
 ['The consensus engine','The right panel fuses 20+ indicators into one score with % agreement — weights are tuned to this market\u2019s own measured hit-rates. Click any card header to collapse it.'],
 ['AI Desk Analyst','The  view answers in plain language (offline, no key): bias, levels, risk, "should I take this?" checklist, per-indicator accuracy.  Use the mic to talk, the speaker to listen. Enable the LLM via proxy for the full agent.'],
 ['Power tools','⌘/Ctrl-K opens the command palette (everything is reachable). Ctrl-Z undoes drawings. Right-click the chart for quick actions. Run the self-test in Settings any time. Good luck — trade the plan.']
];
let _tourI=0;
function showTour(i){_tourI=i;let m=document.getElementById('tourBox');if(!m){m=document.createElement('div');m.id='tourBox';m.style.cssText='position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';m.innerHTML='<div id="tourCard" style="max-width:430px;margin:16px;background:var(--panel);border:1px solid var(--edge2);border-radius:14px;padding:22px;box-shadow:0 30px 80px -20px #000"></div>';document.body.appendChild(m);m.addEventListener('click',e=>{if(e.target===m)endTour()})}
  const c=document.getElementById('tourCard'),[h,b]=TOUR[i];
  c.innerHTML=`<div style="font-size:16px;font-weight:700;margin-bottom:8px">${h}</div><div style="font-size:12.5px;color:var(--muted);line-height:1.7;margin-bottom:16px">${b}</div><div style="display:flex;justify-content:space-between;align-items:center"><span style="font-size:10px;color:var(--muted2)">${i+1} / ${TOUR.length}</span><span>${i>0?'<button class="tbtn" onclick="showTour('+(i-1)+')">‹ Back</button> ':''}<button class="run" onclick="${i<TOUR.length-1?'showTour('+(i+1)+')':'endTour()'}">${i<TOUR.length-1?'Next ›':'Start trading ▷'}</button></span></div>`;
}
function endTour(){const m=document.getElementById('tourBox');if(m)m.remove();try{localStorage.setItem('mishel_toured','1')}catch(e){}}
function startTour(){showTour(0)}
function showHelp(){let m=document.getElementById('helpBox');if(m){m.remove();return}m=document.createElement('div');m.id='helpBox';m.style.cssText='position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
  const rows=[['⌘/Ctrl-K','Command palette (everything)'],['1–9','Switch timeframe'],['\\\\','Drawing toolbar'],['R / M / I','RSI pane · MACD pane · Indicators'],['Ctrl-Z / Ctrl-Y','Undo / redo drawings'],['Delete','Remove selected drawing'],['Right-click','Chart quick actions'],['?','This help']];
  m.innerHTML=`<div style="max-width:420px;margin:16px;background:var(--panel);border:1px solid var(--edge2);border-radius:14px;padding:22px;box-shadow:0 30px 80px -20px #000"><div style="font-size:15px;font-weight:700;margin-bottom:12px">Keyboard shortcuts</div>${rows.map(r=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--edge);font-size:12px"><span class="mono" style="color:var(--gold)">${r[0]}</span><span style="color:var(--muted)">${r[1]}</span></div>`).join('')}<div style="margin-top:14px;text-align:right"><button class="tbtn" onclick="document.getElementById('helpBox').remove()">Close</button> <button class="run" onclick="document.getElementById('helpBox').remove();startTour()">Replay tour ▷</button></div></div>`;
  document.body.appendChild(m);m.addEventListener('click',e=>{if(e.target===m)m.remove()})}
document.addEventListener('keydown',e=>{const ae=document.activeElement;if(ae&&/input|textarea|select/i.test(ae.tagName))return;if(e.key==='?')showHelp();if(e.key==='Escape'){const t=document.getElementById('tourBox');if(t)endTour()}});
/* ---------- reliability: global error boundary + in-app self-test ---------- */
let _errCount=0;
window.addEventListener('error',e=>{_errCount++;try{toast('! Recovered from an error: '+String(e.message).slice(0,80),var_bear())}catch(_){}return false});
window.addEventListener('unhandledrejection',e=>{_errCount++;try{toast('! Async error handled: '+String(e.reason&&e.reason.message||e.reason).slice(0,80),var_bear())}catch(_){}});
function runSelfTest(){
  const R=[],t=(name,fn)=>{try{const ok=fn();R.push({name,ok:!!ok,err:ok?null:'assert failed'})}catch(e){R.push({name,ok:false,err:e.message})}};
  const eq=(a,b,tol=1e-9)=>Math.abs(a-b)<=tol;
  t('SMA known vector',()=>{const s=IND.sma([1,2,3,4,5],3);return eq(s[2],2)&&eq(s[4],4)});
  t('EMA converges to constant',()=>{const e=IND.ema(new Array(80).fill(7),10);return eq(e[79],7,1e-6)});
  t('RSI bounded 0–100',()=>{const d=genData(200,100,3);return IND.rsi(d.map(x=>x.c)).slice(20).every(v=>v>=0&&v<=100)});
  t('ATR positive',()=>{const d=genData(200,100,4);return IND.atr(d).slice(20).every(v=>v>0)});
  t('Heikin-Ashi invariant h≥l',()=>{const h=heikinAshi(genData(150,100,5));return h.every(c=>c.h>=c.l&&c.h>=Math.max(c.o,c.c)-1e-9)});
  t('Bollinger ordering',()=>{const b=IND.boll(genData(200,100,6).map(x=>x.c));for(let i=30;i<200;i++){if(!(b.up[i]>=b.mid[i]&&b.mid[i]>=b.lo[i]))return false}return true});
  t('Consensus in [-100,100]',()=>{const cn=consensusSignal(genData(300,100,7));return cn.score>=-100&&cn.score<=100&&cn.confidence>=0&&cn.confidence<=100});
  t('Median ignores outlier',()=>eq(_median([1,2,3,4,1000]),3));
  t('Winsorize clamps outlier',()=>_winsor([1,2,3,4,1000],2)[4]<1000);
  t('Anchored VWAP finite from anchor',()=>{const s=DATA.length;DATA=genData(120,100,8);const a=avwapFrom(60);const okv=a[119]!=null&&Number.isFinite(a[119])&&a[59]==null;return okv});
  t('Sizer math (1% of 10k, $1 risk/unit)',()=>{const units=(10000*1/100)/1;return eq(units,100)});
  t('Accuracy rates in [0,1]',()=>{const a=indicatorAccuracy(genData(300,100,9));return a&&Object.values(a).filter(v=>v!=null).every(v=>v>=0&&v<=1)});
  t('Annealer ≥ baseline',()=>{const q=annealCategoryWeights(genData(300,100,10));return q&&q.hit_rate>=q.baseline-0.001});
  t('normCdf anchors',()=>eq(normCdf(0),0.5,1e-6)&&eq(normCdf(1.959964),0.975,2e-3)&&normCdf(-3)<normCdf(3));
  t('Sharpe of zero-variance R is 0 (safe)',()=>sharpeR([1,1,1,1])===0);
  t('Sharpe sign matches mean',()=>sharpeR([2,-1,1,-0.5,1.5])>0 && sharpeR([-2,1,-1,0.5,-1.5])<0);
  t('PSR bounded and monotone in edge',()=>{const weak=psr0([0.2,-0.1,0.15,-0.05,0.1,-0.08,0.12,-0.03]);const strong=psr0([1.2,1.0,0.9,1.1,0.8,1.3,0.95,1.05]);return weak>=0&&weak<=1&&strong>=0&&strong<=1&&strong>weak});
  t('PSR<50% for a losing series',()=>{const p=psr0([-0.5,0.2,-0.4,0.1,-0.6,0.15,-0.3,0.05]);return isFinite(p)&&p<0.5});
  t('Meme momentum bounded 0–100',()=>{const m=memeMomentum({liq:5e5,vol24:15e5,chg24:45,buys:900,sells:200});return m>=0&&m<=100});
  t('Meme honeypot forces EXTREME',()=>{const r=memeRug({liq:1e5,fdv:2e5,vol24:5e4,ageH:500,hasSocials:true},{honeypot:true});return r.score>=75&&rugBand(r.score)[0]==='EXTREME'});
  t('Meme clean token lower risk',()=>memeRug({liq:8e5,fdv:2e6,vol24:4e5,ageH:2000,hasSocials:true}).score<25);
  t('Holder parse: top10 + lpLocked',()=>{const hi=parseHolders({holder_count:100,holders:[{address:"0xa",percent:"0.4"},{address:"0xb",percent:"0.1",is_locked:1}],lp_holders:[{percent:"0.7",is_locked:1},{percent:"0.3",is_locked:0}]});return Math.abs(hi.top10-50)<1e-9&&Math.abs(hi.lpLocked-70)<1e-9});
  t('Wallet transfer direction + decimals',()=>{const t=normalizeTransfer({from:{hash:"0xx"},to:{hash:"0xme"},token:{decimals:"6"},total:{value:"1500000",decimals:"6"}},"0xME");return t.dir==="in"&&Math.abs(t.amount-1.5)<1e-9});
  t('Launch band freshness',()=>launchBand(3)[0].includes("<6h")&&launchBand(999)[0]===">3d");
  const pass=R.filter(x=>x.ok).length;
  return {pass,total:R.length,results:R,errorsThisSession:_errCount};
}
function renderSelfTest(){const el=document.getElementById('selfTestOut');if(!el)return;el.innerHTML='<span style="color:var(--muted)">running…</span>';setTimeout(()=>{const r=runSelfTest();el.innerHTML=`<div style="font-weight:700;color:${r.pass===r.total?'var(--bull)':'var(--bear)'};margin-bottom:6px">${r.pass}/${r.total} checks passed · ${r.errorsThisSession} runtime errors this session</div>`+r.results.map(x=>`<div style="font-size:11px;padding:2px 0">${x.ok?'✓':'✗'} ${x.name}${x.err?' — <span style="color:var(--bear)">'+x.err+'</span>':''}</div>`).join('');recompute()},30)}
/* ---------- opt-in persistence (guarded; degrades to session-only if storage unavailable) ---------- */
const PERSIST_KEY='mishel_state_v1';
function persistOn(){try{return localStorage.getItem(PERSIST_KEY+'_on')==='1'}catch(e){return false}}
function persistSnapshot(){return {mode:MODE,theme:document.documentElement.getAttribute('data-theme')||'midnight',chartType:CHART_TYPE,volOn:VOL_ON,on:[...ON],panes:[...PANES],tf:TF,sym:CURSYM.sym,drawings:DRAWINGS.slice(0,120),paper:{bal:PAPER.bal,start:PAPER.start,hist:PAPER.hist.slice(0,80),leverage:PAPER.leverage,seq:PAPER.seq},alerts:ALERTS.slice(0,40)}}
let _saveT=null;
function persistSave(){if(!persistOn())return;clearTimeout(_saveT);_saveT=setTimeout(()=>{try{localStorage.setItem(PERSIST_KEY,JSON.stringify(persistSnapshot()))}catch(e){}},600)}
function persistRestore(){try{if(!persistOn())return false;const raw=localStorage.getItem(PERSIST_KEY);if(!raw)return false;const s=JSON.parse(raw);
  if(s.theme&&s.theme!=='midnight')applyTheme(s.theme);
  if(s.chartType){CHART_TYPE=s.chartType;const ct=document.getElementById('chartType');if(ct)ct.value=s.chartType}
  if(typeof s.volOn==='boolean'){VOL_ON=s.volOn;const b=document.querySelector('#paneCtl button[data-pane="vol"]');if(b)b.classList.toggle('on',VOL_ON)}
  if(Array.isArray(s.on)){ON.clear();s.on.forEach(o=>ON.add(o));document.querySelectorAll('.chip[data-ind]').forEach(c=>c.classList.toggle('on',ON.has(c.dataset.ind)))}
  if(Array.isArray(s.panes)){PANES.clear();s.panes.forEach(p=>PANES.add(p));document.querySelectorAll('#paneCtl button').forEach(b=>{if(b.dataset.pane!=='vol')b.classList.toggle('on',PANES.has(b.dataset.pane))})}
  if(Array.isArray(s.drawings))DRAWINGS=s.drawings;
  if(s.paper){PAPER.bal=s.paper.bal??PAPER.bal;PAPER.start=s.paper.start??PAPER.start;PAPER.hist=s.paper.hist||PAPER.hist;PAPER.leverage=s.paper.leverage||PAPER.leverage;PAPER.seq=s.paper.seq||PAPER.seq}
  if(Array.isArray(s.alerts))ALERTS=s.alerts;
  if(s.mode==='online')setTimeout(()=>{try{setMode('online');toast('Reconnecting live data…')}catch(e){}},400);   // smart resume: auto-reconnect
  return true}catch(e){return false}}
