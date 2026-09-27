function renderIntel(){renderDropout();renderRegime();renderModel();renderEnsemble();document.getElementById('mctsOut').innerHTML='<div style="color:var(--muted);font-size:12px">Click "Search for alpha" to run the tree search.</div>';document.getElementById('genStats').innerHTML='';document.getElementById('mcmcStats').innerHTML='';}

/* Market heatmap */
function renderHeatmap(){const groups={};
  Object.entries(SPECS).forEach(([k,s])=>{if(!(s.px>0))return;const dd=genData(300,s.px,(k.charCodeAt(0)+k.length)*13+3);const rep=confluence(buildSignals(dd).S);(groups[s.cls]||(groups[s.cls]=[])).push({k,name:s.name,score:rep.score,label:rep.label})});
  let html='';const order=[['crypto','Crypto'],['cryptofut','Crypto Futures'],['forex','Forex'],['metal','Metals'],['index','Indices'],['stock','Stocks'],['manual','Custom']];
  order.forEach(([cls,title])=>{const arr=groups[cls];if(!arr||!arr.length)return;arr.sort((a,b)=>b.score-a.score);html+=`<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin:16px 0 8px">${title}</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px">`+arr.map(a=>{const cc=a.score>0.05?'up':a.score<-0.05?'dn':'';return `<div class="heat-tile" data-sym="${a.k}" data-cls="${cls}" style="background:${heat(a.score)};border:1px solid var(--edge);border-radius:10px;padding:12px;cursor:pointer;transition:.12s"><div style="font-family:var(--disp);font-weight:600;font-size:13px">${a.name}</div><div class="mono" style="font-size:9.5px;color:var(--muted)">${a.k}</div><div class="${cc}" style="font-family:var(--disp);font-weight:600;font-size:11px;margin-top:7px">${a.label} <span class="mono">${a.score>=0?'+':''}${a.score.toFixed(2)}</span></div></div>`}).join('')+'</div>'});
  document.getElementById('heatGrid').innerHTML=html;
  document.querySelectorAll('.heat-tile').forEach(t=>t.onclick=()=>renderHeatDetail(t.dataset.sym));
}
function heatSentiment(score){const pct=Math.round((score+1)/2*100);const lab=score>0.35?'Strongly Bullish':score>0.1?'Bullish':score<-0.35?'Strongly Bearish':score<-0.1?'Bearish':'Neutral';return{pct,lab}}
function renderHeatDetail(sym){
  const s=SPECS[sym];const el=document.getElementById('heatDetail');if(!s||!el)return;
  const d=genData(300,s.px,(sym.charCodeAt(0)+sym.length)*13+3);
  const c=d.map(x=>x.c),n=d.length-1;
  const rep=confluence(buildSignals(d).S);
  const rsi=IND.rsi(c)[n]||50,atr=IND.atr(d)[n]||0,price=c[n];
  const ci=n-24>0?n-24:0,chg=(c[n]-c[ci])/c[ci]*100;
  const hi=Math.max(...c.slice(-96)),lo=Math.min(...c.slice(-96));
  const reg=classifyRegime(d),sent=heatSentiment(rep.score);
  const stat=(k,v,cc)=>`<div class="stat"><div class="k">${k}</div><div class="v mono ${cc||''}">${v}</div></div>`;
  el.innerHTML=`<div class="panelbox"><div style="display:flex;align-items:center;gap:12px;margin-bottom:12px"><div><div style="font-family:var(--disp);font-weight:700;font-size:18px">${s.name}</div><div class="mono" style="color:var(--muted);font-size:11px">${sym} · ${s.cls}</div></div><button class="run" id="heatOpen" style="margin-left:auto">Open in chart ▷</button></div>
    <div class="grid2" style="align-items:start">
      <div class="panelbox"><h4>Key stats</h4><div class="stat-grid">${[stat('Price',fmt(price)),stat('Change (24 bars)',(chg>=0?'+':'')+chg.toFixed(2)+'%',chg>=0?'up':'dn'),stat('High',fmt(hi)),stat('Low',fmt(lo)),stat('ATR %',(atr/price*100).toFixed(2)+'%'),stat('RSI(14)',rsi.toFixed(0),rsi>70?'dn':rsi<30?'up':'')].join('')}</div></div>
      <div class="panelbox"><h4>Technical sentiment <span class="tag">FROM INDICATORS</span></h4><div style="display:flex;align-items:center;gap:10px;margin:6px 0"><span style="font-family:var(--disp);font-weight:700;font-size:16px;color:${rep.score>=0.1?'var(--bull)':rep.score<=-0.1?'var(--bear)':'var(--muted)'}">${sent.lab}</span><span class="mono" style="margin-left:auto;color:var(--muted)">${sent.pct}/100</span></div><div class="meter" style="margin:4px 0"><div class="needle" style="left:${sent.pct}%"></div></div><div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:8px">${reg.regime} — ${reg.advice}</div><div style="font-size:10px;color:var(--muted2);margin-top:8px">Derived from price action &amp; the glass-box confluence — not social/news sentiment.</div></div>
    </div>
    <div class="grid2" style="align-items:start;margin-top:14px">
      <div class="panelbox"><h4>Key facts</h4><div style="font-size:12px;line-height:1.9;color:var(--muted)"><div>Asset class · <b style="color:var(--txt)">${s.cls}</b></div><div>Pip / tick · <b style="color:var(--txt)">${s.pip}</b></div><div>Contract · <b style="color:var(--txt)">${s.contract||'—'}</b></div><div>Confluence bias · <b class="${rep.label.includes('Buy')?'up':rep.label.includes('Sell')?'dn':''}">${rep.label} (${rep.score>=0?'+':''}${rep.score.toFixed(2)})</b></div></div></div>
      <div class="panelbox"><h4>News · Whale tracker <span class="tag">LIVE FEED</span></h4><div style="font-size:11.5px;color:var(--muted);line-height:1.7">Headlines and large-wallet (“whale”) flow need a live data feed — a news API and an on-chain source like Whale Alert. Those aren't bundled (no fake data here). Add a key in the backend and these can be surfaced through the proxy. For crypto, on-chain whale flow plus funding/open-interest are the highest-signal additions.</div></div>
    </div></div>`;
  const ob=document.getElementById('heatOpen');if(ob)ob.onclick=()=>{document.getElementById('assetCls').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.cls===s.cls));populateSymbols(s.cls);document.getElementById('symSel').value=sym;loadSymbol();const cn=document.querySelector('.nav[data-view="chart"]');if(cn)cn.click()};
  if(el.scrollIntoView)el.scrollIntoView({behavior:'smooth',block:'nearest'});
}

/* =====================================================================
   Deep-learning model inference (runs your uploaded network in-browser),
   regime classifier, ensemble meta-model, and workspace persistence.
   ===================================================================== */
let MODEL=null;
const MODEL_FEATURES=['(rsi-50)/50','tanh(macdHist/atr)','trend(±1)','tanh((close-ema200)/atr/5)','tanh(flux/5)','(stochK-50)/50','tanh(cci/200)','(adx-25)/25','tanh(roc/10)','bollPos*2-1','tanh(vol/vsma-1)','(willr+50)/50'];
function featVec(d){const n=d.length-1;const c=d.map(x=>x.c);const ema50=IND.ema(c,50),ema200=IND.ema(c,200),rsi=IND.rsi(c),atrA=IND.atr(d),macd=IND.macd(c),fluxA=IND.flux(d),sto=IND.stoch(d),cciA=IND.cci(d),adxA=IND.adx(d),rocA=IND.roc(c,12),bb=IND.boll(c),wr=IND.willr(d),vs=IND.sma(d.map(x=>x.v),20);const atr=atrA[n]||c[n]*0.01;const T=Math.tanh,cl=x=>Math.max(-1,Math.min(1,x));const bbpos=((c[n]-bb.lo[n])/((bb.up[n]-bb.lo[n])||1)-0.5)*2;
  return [(rsi[n]-50)/50,T((macd.hist[n]||0)/atr),ema50[n]>ema200[n]?1:-1,T((c[n]-ema200[n])/atr/5),T((fluxA[n]||0)/5),((sto.K[n]||50)-50)/50,T((cciA[n]||0)/200),cl(((adxA[n]||20)-25)/25),T((rocA[n]||0)/10),cl(bbpos),T(d[n].v/((vs[n]||d[n].v))-1),((wr[n]||-50)+50)/50];}
function actF(x,a){return a==='relu'?Math.max(0,x):a==='tanh'?Math.tanh(x):a==='sigmoid'?1/(1+Math.exp(-x)):x}
function mlpForward(vec,model){let a=vec;for(const L of model.layers){const out=[];for(let i=0;i<L.W.length;i++){let s=L.b?L.b[i]:0;for(let j=0;j<L.W[i].length;j++)s+=L.W[i][j]*a[j];out.push(actF(s,L.act||'linear'))}a=out}return a[0]}
function modelBias(d){if(!MODEL||MODEL.type!=='mlp')return null;const v=featVec(d);if(v.length!==MODEL.layers[0].W[0].length)return null;const o=mlpForward(v,MODEL);return Math.max(-1,Math.min(1,o))}
const EXAMPLE_MODEL={type:'mlp',name:'Momentum+Trend (example)',note:'Interpretable single-layer example. Replace W with your trained weights. Input = the 12 canonical features, output tanh in [-1,1].',features:MODEL_FEATURES,layers:[{W:[[0.4,0.6,0.9,0.5,0.7,0.3,0.4,0.3,0.4,-0.3,0.2,0.3]],b:[0],act:'tanh'}]};

function classifyRegime(d){const n=d.length-1;const c=d.map(x=>x.c);const adx=IND.adx(d)[n]||20;const ema50=IND.ema(c,50),ema200=IND.ema(c,200);const atrA=IND.atr(d);const atrPct=(atrA[n]||c[n]*0.01)/c[n]*100;const hist=atrA.slice(-100).filter(v=>v!=null).map(v=>v/c[n]*100);const volRank=hist.length?hist.filter(v=>v<atrPct).length/hist.length:0.5;const trendUp=ema50[n]>ema200[n];let regime,advice,style;
  if(adx>25){regime=trendUp?'Trending up':'Trending down';advice='Trend-following favoured — breakouts and pullback entries. Fading is risky here.';style='swing / intraday trend'}
  else if(volRank>0.8){regime='High-volatility expansion';advice='Widen stops, cut size. Momentum & breakout plays; avoid tight mean-reversion.';style='breakout'}
  else{regime='Ranging / low ADX';advice='Mean-reversion favoured — fade extremes at Bollinger/VWAP. Breakouts unreliable.';style='scalp / mean-reversion'}
  return {regime,advice,style,adx,atrPct,volRank,trendUp};}
function renderRegime(){const r=classifyRegime(DATA);const col=r.regime.includes('up')?'var(--bull)':r.regime.includes('down')?'var(--bear)':r.regime.includes('volatil')?'var(--gold)':'var(--blue)';
  document.getElementById('regimeOut').innerHTML=`<div class="verdict" style="margin:2px 0 8px"><span class="big" style="color:${col};font-size:19px">${r.regime}</span></div>
    <div style="display:flex;gap:16px;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:10px"><span>ADX <b style="color:var(--txt)">${r.adx.toFixed(0)}</b></span><span>Vol rank <b style="color:var(--txt)">${(r.volRank*100).toFixed(0)}%</b></span><span>Trend <b class="${r.trendUp?'up':'dn'}">${r.trendUp?'up':'down'}</b></span></div>
    <div style="background:var(--panel2);border:1px solid var(--edge);border-radius:8px;padding:10px;font-size:12px;line-height:1.5"><b style="color:var(--txt)">Play it as:</b> ${r.advice}<br><span style="color:var(--muted);font-size:11px">Best-fit style: ${r.style}</span></div>`;}
function renderModel(){const box=document.getElementById('modelOut');if(!MODEL){box.innerHTML='<div style="color:var(--muted);font-size:12px">No model loaded. Go to <b style="color:var(--txt)">Settings → Model manager</b> to upload your trained network (or grab the example).</div>';return}
  if(MODEL.type==='weights'){box.innerHTML=`<div style="font-size:12px">Loaded a <b>weights</b> model: it re-tunes the confluence category emphasis. Active in every read.</div>`;return}
  const o=modelBias(DATA);const cls=o>0?'up':'dn';
  box.innerHTML=`<div class="mono" style="font-size:11px;color:var(--muted);margin-bottom:8px">${MODEL.name||'MLP'} · ${MODEL.layers.length} layer(s) · in-browser inference</div><div class="verdict" style="margin:2px 0 8px"><span class="big ${cls}" style="font-size:22px">${o>=0?'+':''}${o.toFixed(2)}</span><span class="score mono">${o>0.15?'bullish':o<-0.15?'bearish':'neutral'} forecast</span></div><div class="meter"><div class="needle" style="left:${(o+1)/2*100}%"></div></div><div class="meter-scale"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div><div style="font-size:10.5px;color:var(--muted);margin-top:8px">Feeds the confluence as a weighted "Learned model" signal.</div>`;}
function renderEnsemble(){const S=buildSignals(DATA).S;const rep=confluence(S);const drop=mcDropout(S);const certainty=Math.max(0,1-Math.min(1,_std(drop)/0.3));const reg=classifyRegime(DATA);const mo=modelBias(DATA);
  const comps=[{n:'Confluence bias',s:rep.score,w:1.4},{n:'Regime bias',s:reg.trendUp?0.4:-0.4,w:0.7}];
  if(mo!=null)comps.push({n:'Learned model',s:mo,w:1.3});
  const wsum=comps.reduce((a,c)=>a+c.w,0);const meta=comps.reduce((a,c)=>a+c.s*c.w,0)/wsum;const metaAdj=meta*(0.5+0.5*certainty);
  const label=metaAdj>=0.35?'Strong Buy':metaAdj>=0.12?'Buy':metaAdj>-0.12?'Neutral':metaAdj>-0.35?'Sell':'Strong Sell';const cls=label.includes('Buy')?'up':label.includes('Sell')?'dn':'';
  document.getElementById('ensembleOut').innerHTML=`<div class="grid2" style="align-items:center"><div><div class="verdict"><span class="big ${cls}" style="font-size:24px">${label}</span><span class="score mono">meta ${metaAdj.toFixed(2)} · certainty ${(certainty*100).toFixed(0)}%</span></div><div class="meter"><div class="needle" style="left:${(metaAdj+1)/2*100}%"></div></div><div class="meter-scale"><span>Strong Sell</span><span>Neutral</span><span>Strong Buy</span></div></div>
    <table class="log"><thead><tr><th>Component</th><th>Score</th><th>Weight</th></tr></thead><tbody>${comps.map(c=>`<tr><td>${c.n}</td><td class="mono ${c.s>=0?'up':'dn'}">${c.s>=0?'+':''}${c.s.toFixed(2)}</td><td class="mono" style="color:var(--muted)">${c.w.toFixed(1)}×</td></tr>`).join('')}<tr style="border-top:2px solid var(--edge2)"><td><b>Certainty scaler</b></td><td class="mono">×${(0.5+0.5*certainty).toFixed(2)}</td><td class="mono" style="color:var(--muted)">MC-Dropout</td></tr></tbody></table></div>
    <div style="font-size:10.5px;color:var(--muted);margin-top:8px">Meta-score is the weighted mean of the components, then scaled by how certain the signals are (low uncertainty → full conviction). Load a model in Settings to add its voice.</div>`;}

/* workspace export / import */
function exportWorkspace(){const ws={version:1,custom:Object.fromEntries(Object.entries(USER_STRATS).map(([k,v])=>[k,v.spec])),weights:CATW,guardrail:{maxDayLoss:PAPER.maxDayLoss},model:MODEL,fxProvider:FX_PROVIDER,proxy:{url:PROXY_URL,provider:PROXY_PROVIDER},alerts:ALERTS.map(a=>({sym:a.sym,tf:a.tf,field:a.field,op:a.op,value:a.value,repeat:a.repeat,armed:a.armed}))};const blob=new Blob([JSON.stringify(ws,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mishel_workspace.json';a.click();document.getElementById('wsInfo').innerHTML='<span style="color:var(--bull)">✓ Exported — reload this file any time to restore your setup.</span>';}
function importWorkspace(text){try{const ws=JSON.parse(text);let n=0;if(ws.custom)Object.values(ws.custom).forEach(spec=>{addUserStrat(spec);n++});if(ws.weights)Object.assign(CATW,ws.weights);if(ws.guardrail&&ws.guardrail.maxDayLoss)PAPER.maxDayLoss=ws.guardrail.maxDayLoss;if(ws.model){MODEL=ws.model;renderModelInfo()}if(ws.proxy){PROXY_URL=ws.proxy.url||'';PROXY_PROVIDER=ws.proxy.provider||'yfinance';const pu=document.getElementById('dsProxyUrl');if(pu)pu.value=PROXY_URL;const pp=document.getElementById('dsProxyProv');if(pp)pp.value=PROXY_PROVIDER}if(Array.isArray(ws.alerts)){ALERTS=ws.alerts.map(a=>({...a,id:_alertSeq++,fires:0,_was:false,_prev:null,created:Date.now()}));renderAlerts()}document.getElementById('wsInfo').innerHTML=`<span style="color:var(--bull)">✓ Restored — ${n} strategies, weights, guardrails${ws.model?', model':''}${ws.alerts&&ws.alerts.length?', '+ws.alerts.length+' alerts':''}.</span>`;toast('Workspace restored',var_bull());recompute()}catch(e){document.getElementById('wsInfo').innerHTML=`<span style="color:var(--bear)">✗ ${e.message}</span>`}}
function renderModelInfo(){const box=document.getElementById('modelInfo');if(!box)return;if(!MODEL){box.innerHTML='<div style="color:var(--muted);font-size:12px">No model loaded — the terminal uses its transparent signals only.</div>';return}const params=MODEL.type==='mlp'?MODEL.layers.reduce((a,L)=>a+L.W.length*L.W[0].length+(L.b?L.b.length:0),0):Object.keys(MODEL.category||MODEL.weights||{}).length;box.innerHTML=`<div style="background:var(--gold-dim);border:1px solid rgba(232,163,61,.3);border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center"><div><b style="color:var(--txt)">${MODEL.name||MODEL.type}</b> <span class="mono" style="font-size:10px;color:var(--muted)">· ${MODEL.type} · ${params} params · running in-browser</span></div><button class="tbtn" id="modelRemove" style="padding:3px 9px">remove</button></div>`;document.getElementById('modelRemove').onclick=()=>{MODEL=null;renderModelInfo();recompute()};}

/* =====================================================================
   Wiring
   ===================================================================== */
let CURSYM={cls:'forex'};
function loadSymbol(){
  const sym=document.getElementById('symSel').value;const sp=SPECS[sym];if(!sp)return;
  stopLive();memLog('symbol',sym);
  const csv=(PREFER_CSV&&CSV_STORE[sym])?CSV_STORE[sym]:null;
  const _ck=sym+'|'+TF;
  DATA=csv?csv.slice(-1000):((MODE==='online'&&BAR_CACHE[_ck]&&BAR_CACHE[_ck].length>10)?BAR_CACHE[_ck].slice():genData(600,sp.px,(sym.charCodeAt(0)+sym.length)*13+(TF.length*7)));
  const px=DATA[DATA.length-1].c;
  CURSYM={sym,name:sp.name,cls:sp.cls,px,kind:sp.cls,spec:sp,csv:!!csv};
  if(typeof syncSymBtn==='function')syncSymBtn();
  document.getElementById('symKind').textContent=sp.cls+(csv?' · CSV':'');
  const last=DATA[DATA.length-1].c,prev=DATA[DATA.length-2].c,chg=(last-prev)/prev*100;
  document.getElementById('lastPx').textContent=fmt(last);
  const ce=document.getElementById('chg');ce.textContent=`${chg>=0?'+':''}${chg.toFixed(2)}%`;ce.className=`chg mono ${chg>=0?'up':'dn'}`;
  document.getElementById('lastPx').className=`px mono ${chg>=0?'up':'dn'}`;
  document.getElementById('cEntry').value=fmt(last);
  document.getElementById('cStop').value=fmt(last*0.982);
  VIEW.off=0;recompute();try{updateHead(last)}catch(e){}
  if(MODE==='online'){const dot=document.getElementById('feedDot'),txt=document.getElementById('feedTxt');goOnline(dot,txt)}
}

// nav
/* ===== v25.0 TOP TAB BAR wiring ===== */
window.VIEW_LABELS={chart:'Chart & Analysis',multi:'Multi-Chart',mtf:'Multi-Timeframe',confluence:'Confluence (XAI)',ai:'AI Analyst',orderflow:'Order Flow',heatmap:'Market Heatmap',screener:'Screener',smart:'Smart Money',onchain:'On-Chain Desk',watchlist:'Watchlist',sessions:'Trading Sessions',news:'News & Calendar',backtest:'Strategy Tester',intel:'Intelligence Lab',paper:'Demo Trading',calc:'Trade Calculator',hedge:'Hedge Desk',risk:'Portfolio Risk',alerts:'Alerts & Webhooks',settings:'Data & Settings'};
function tabViewToTab(v){const t=document.querySelector('.tab[data-views~="'+v+'"]')||[...document.querySelectorAll('.tab[data-views]')].find(t=>(t.dataset.views||'').split(',').includes(v));return t;}
function showSubtabs(tabBtn,activeView){
  const st=document.getElementById('subtabs');if(!st)return;
  const views=(tabBtn.dataset.views||'').split(',').filter(Boolean);
  if(views.length<=1){st.classList.remove('show');st.innerHTML='';return;}
  st.innerHTML=views.map(v=>'<button class="subtab'+(v===activeView?' on':'')+'" data-view="'+v+'">'+(window.VIEW_LABELS[v]||v)+'</button>').join('');
  st.classList.add('show');
  st.querySelectorAll('.subtab').forEach(b=>b.onclick=()=>goView(b.dataset.view));
}
function syncTabBar(activeView){
  const tab=tabViewToTab(activeView);
  document.querySelectorAll('.tab[data-views]').forEach(t=>t.classList.remove('on'));
  if(tab){tab.classList.add('on');showSubtabs(tab,activeView);}
}
document.querySelectorAll('.tab[data-views]').forEach(t=>t.onclick=()=>{
  const views=(t.dataset.views||'').split(',').filter(Boolean);
  const cur=document.querySelector('.view.on');const curV=cur?cur.id.replace('v-',''):'';
  /* if this tab's group already active, keep view; else go to its first view */
  if(views.includes(curV)){syncTabBar(curV);}else{goView(views[0]);}
});
