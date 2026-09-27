function persistToggle(onoff){try{localStorage.setItem(PERSIST_KEY+'_on',onoff?'1':'0');if(onoff){persistSave();toast('Setup will be remembered in this browser',var_bull())}else{localStorage.removeItem(PERSIST_KEY);toast('Saved setup cleared — session-only mode')}}catch(e){toast('Storage unavailable in this browser',var_bear())}}
['click','change','keyup'].forEach(ev=>document.addEventListener(ev,()=>persistSave(),{passive:true}));
/* ---------- splash boot sequence ---------- */
(function(){const sp=document.getElementById('splash');if(!sp)return;const bar=document.getElementById('splashBar'),msg=document.getElementById('splashMsg');const steps=[[22,'loading engine…'],[52,'computing indicators…'],[78,'tuning consensus to history…'],[100,'ready']];let i=0;const tick=()=>{if(i<steps.length){if(bar)bar.style.width=steps[i][0]+'%';if(msg)msg.textContent=steps[i][1];i++;setTimeout(tick,i===steps.length?260:210)}else{sp.style.opacity='0';setTimeout(()=>{sp.style.display='none'},520)}};setTimeout(tick,60)})();
/* ---------- searchable symbol dropdown (consensus badge per row) ---------- */
let SYMF='all';
function fillSymDropCls(){const el=document.getElementById('symDropCls');if(!el)return;const cats=[['all','All'],['forex','FX'],['crypto','Crypto'],['cryptofut','Futures'],['metal','Metals'],['index','Indices'],['stock','Stocks']];el.innerHTML=cats.map(([v,l])=>`<button class="tbtn symf ${SYMF===v?'gold':''}" data-f="${v}" style="height:24px;padding:0 9px;font-size:10.5px">${l}</button>`).join('');el.querySelectorAll('.symf').forEach(b=>b.onclick=e=>{e.stopPropagation();SYMF=b.dataset.f;fillSymDropCls();renderSymList(document.getElementById('symSearch').value)})}
function renderSymList(filter){const list=document.getElementById('symList');if(!list)return;const q=(filter||'').toLowerCase().trim();const syms=Object.keys(SPECS).filter(s=>(SYMF==='all'||SPECS[s].cls===SYMF)&&(!q||s.toLowerCase().includes(q)||SPECS[s].name.toLowerCase().includes(q))).slice(0,60);list.innerHTML=syms.map(s=>{const dd=genData(160,SPECS[s].px,(s.charCodeAt(0)+s.length)*13);const con=consensusSignal(dd);const col=con.score>8?'var(--bull)':con.score<-8?'var(--bear)':'var(--muted)';const rk=(window.assetRisk?assetRisk(s):{label:'',cls:''});const rp=rk.label?` <span class="pill ${rk.cls}">${rk.label}</span>`:'';const ic=(window.assetIcon?assetIcon(s,16):'');return `<div class="sym-row" data-s="${s}" style="display:flex;justify-content:space-between;align-items:center;padding:9px 14px;cursor:pointer;gap:8px"><span style="display:flex;align-items:center;gap:7px;min-width:0">${ic}<b>${s}</b> <span style="color:var(--muted2);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${SPECS[s].name}</span>${rp}</span><span style="font-size:10px;font-weight:700;color:${col};white-space:nowrap">${con.label} ${con.score>=0?'+':''}${con.score}</span></div>`}).join('')||'<div style="padding:14px;color:var(--muted)">No matches</div>';list.querySelectorAll('.sym-row').forEach(r=>{r.onmouseenter=()=>r.style.background='var(--panel2)';r.onmouseleave=()=>r.style.background='';r.onclick=()=>{loadSymbolName(r.dataset.s);document.getElementById('symDrop').style.display='none'}})}
{const b=document.getElementById('symBtn');if(false)b.onclick=(ev)=>{if(ev&&ev.stopPropagation)ev.stopPropagation();const d=document.getElementById('symDrop');if(d.parentElement!==document.body)document.body.appendChild(d);const r=b.getBoundingClientRect();d.style.left=Math.min(r.left,innerWidth-312)+'px';d.style.top=(r.bottom+6)+'px';d.style.display='block';const si=document.getElementById('symSearch');si.value='';fillSymDropCls();renderSymList('');si.focus()};const si=document.getElementById('symSearch');if(si)si.addEventListener('input',()=>renderSymList(si.value))}
document.addEventListener('click',e=>{const d=document.getElementById('symDrop');if(d&&d.style.display==='block'&&e.target.closest&&!e.target.closest('#symDrop')&&e.target.id!=='symBtn')d.style.display='none'});
function syncSymBtn(){const b=document.getElementById('symBtn');if(b&&CURSYM)b.innerHTML=(window.assetIcon?assetIcon(CURSYM.sym,15):'')+' '+(CURSYM.name||CURSYM.sym)+' ▾'}
/* ---------- right-click context menu on the chart ---------- */
let _ctx={bar:0,price:0};
{const cvEl=document.getElementById('chart');if(cvEl)cvEl.addEventListener('contextmenu',e=>{e.preventDefault();const rect=cvEl.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;if(!RENDER)return;_ctx={bar:barAt(x),price:priceAt(y)};const m=document.getElementById('ctxMenu');if(!m)return;m.style.display='block';m.style.left=Math.min(e.clientX,window.innerWidth-200)+'px';m.style.top=Math.min(e.clientY,window.innerHeight-230)+'px';const pe=document.getElementById('ctxPrice');if(pe)pe.textContent=fmt(_ctx.price)})}
document.addEventListener('click',e=>{const m=document.getElementById('ctxMenu');if(m&&e.target.closest&&!e.target.closest('#ctxMenu'))m.style.display='none'});
document.querySelectorAll('.ctx-item').forEach(it=>it.onclick=()=>{const a=it.dataset.act,m=document.getElementById('ctxMenu');if(m)m.style.display='none';
  if(a==='hline'){snapDrawings();DRAWINGS.push({type:'hline',price:_ctx.price});draw()}
  else if(a==='vline'){snapDrawings();DRAWINGS.push({type:'vline',bar:_ctx.bar});draw()}
  else if(a==='avwap'){snapDrawings();DRAWINGS.push({type:'avwap',bar:Math.round(_ctx.bar)});draw()}
  else if(a==='trend'){const db=document.getElementById('drawbar');if(db&&!db.classList.contains('open')){const dt=document.getElementById('drawToggle');if(dt)dt.click()}if(typeof setTool==='function')setTool('trend')}
  else if(a==='clear'){snapDrawings();DRAWINGS=[];SELDRAW=-1;draw()}
  else if(a==='autofibhere'){try{var f=autoFib(DATA);if(f){snapDrawings();DRAWINGS.push({type:'fib',a:{bar:f.up?f.lo.i:f.hi.i,price:f.up?f.lo.p:f.hi.p},b:{bar:f.up?f.hi.i:f.lo.i,price:f.up?f.hi.p:f.lo.p}});draw();toast('Fib placed on the dominant swing','var(--gold)')}}catch(e){}}
  else if(a==='smarttl'){try{const sw2=swings(DATA,3);const all=[...sw2.hi.map(i=>({i,p:DATA[i].h,k:'res'})),...sw2.lo.map(i=>({i,p:DATA[i].l,k:'sup'}))];let p1=null,bd=1e9;all.forEach(pt=>{const d2=Math.abs(pt.i-_ctx.bar);if(d2<bd){bd=d2;p1=pt}});if(p1){const same=all.filter(pt=>pt.k===p1.k&&pt.i<p1.i-6);let best=null,bs=-1e9;same.forEach(pt=>{const slope=(p1.p-pt.p)/((p1.i-pt.i)||1);let touch=0,viol=0;for(let k2=pt.i;k2<DATA.length;k2++){const lp=pt.p+slope*(k2-pt.i);const px2=p1.k==='res'?DATA[k2].h:DATA[k2].l;if(p1.k==='res'?px2>lp*1.0012:px2<lp*0.9988)viol++;else if(Math.abs(px2-lp)/lp<0.001)touch++}const sc2=touch*3-viol*4+(p1.i-pt.i)*0.1;if(sc2>bs){bs=sc2;best=pt}});if(best){snapDrawings();DRAWINGS.push({type:'trend',a:{bar:best.i,price:best.p},b:{bar:p1.i,price:p1.p}});draw();toast(' Smart trendline: '+(p1.k==='res'?'resistance':'support'),'var(--gold)')}else toast('No second pivot found for a clean line','var(--muted)')}}catch(e){}}
  else if(a==='alerthere'){try{const p=+_ctx.price;const dirUp=p>DATA[DATA.length-1].c;ALERTS.unshift({id:_alertSeq++,sym:CURSYM.sym,tf:'',field:'price',op:dirUp?'cross_up':'cross_dn',value:p,repeat:false,armed:true,fires:0,_was:false,_prev:null,created:Date.now()});if(typeof renderAlerts==='function')try{renderAlerts()}catch(_){}toast('Alert set @ '+fmt(p),'var(--gold)')}catch(e){}}
  else if(a==='copyprice'){try{const t=fmt(_ctx.price);(navigator.clipboard&&navigator.clipboard.writeText)?navigator.clipboard.writeText(t):0;toast('Copied '+t,'var(--bull)')}catch(e){}}
  else if(a==='resetview'){try{VIEW.off=0;VIEW.count=120;window.YPAD=0.08;draw();toast('View reset','var(--bull)')}catch(e){}}
  else if(a==='chsym'){try{if(window.openSymModal)openSymModal();else if(window.openSymbolPicker)openSymbolPicker()}catch(e){}}
});

/* ========================= watchlist ========================= */
const WATCH=['BTCUSD','ETHUSD','SOLUSD','XRPUSD','EURUSD','GBPUSD','USDJPY','XAUUSD','SPX500','NAS100'].filter(s=>SPECS[s]);
function renderWatchlist(){
  const grid=document.getElementById('watchGrid');if(!grid)return;
  grid.innerHTML=WATCH.map((s,i)=>`<div class="panelbox wl-card" data-sym="${s}" style="padding:9px 10px;cursor:pointer;position:relative"><span class="wl-x" data-x="${s}" title="Remove" style="position:absolute;top:6px;right:8px;color:var(--muted2);font-size:12px;cursor:pointer;padding:2px 5px">✕</span><div style="display:flex;justify-content:space-between;align-items:center;padding-right:16px"><span style="display:flex;align-items:center;gap:6px">${window.assetIcon?assetIcon(s,15):''}<b>${s}</b>${(function(){var rk=window.assetRisk?assetRisk(s):{label:'',cls:''};return rk.label?` <span class="pill ${rk.cls}">${rk.label}</span>`:'';})()}</span><span id="wl-badge-${i}" style="font-size:10px;font-weight:700"></span></div><div style="font-size:10px;color:var(--muted2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px">${SPECS[s].name}</div><canvas id="wl-cv-${i}" style="width:100%;height:52px;display:block;margin-top:6px"></canvas><div id="wl-meta-${i}" style="font-size:10px;color:var(--muted2);margin-top:4px"></div></div>`).join('');
  WATCH.forEach((s,i)=>{
    const dd=genData(220,SPECS[s].px,(s.charCodeAt(0)+s.length)*13);const con=consensusSignal(dd);
    const badge=document.getElementById('wl-badge-'+i);const col=con.score>8?'var(--bull)':con.score<-8?'var(--bear)':'var(--muted)';
    if(badge){badge.textContent=con.label+' '+(con.score>=0?'+':'')+con.score;badge.style.color=col}
    const meta=document.getElementById('wl-meta-'+i);if(meta)meta.textContent=`${con.confidence}% agree · ${dd[dd.length-1].c.toFixed(SPECS[s].px<10?4:2)}`;
    const cv=document.getElementById('wl-cv-'+i);if(cv){const r=cv.getBoundingClientRect(),dpr=devicePixelRatio||1,H=52,W=r.width;cv.width=W*dpr;cv.height=H*dpr;const g=cv.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);const vis=dd.slice(-80),cs=vis.map(x=>x.c),lo=Math.min(...cs),hi=Math.max(...cs),y=v=>H-4-((v-lo)/((hi-lo)||1))*(H-8);g.strokeStyle=col;g.lineWidth=1.4;g.beginPath();cs.forEach((v,k)=>{const x=k/(cs.length-1)*W;k?g.lineTo(x,y(v)):g.moveTo(x,y(v))});g.stroke()}
  });
  grid.querySelectorAll('.wl-card').forEach(c=>c.onclick=()=>loadSymbolName(c.dataset.sym));
  grid.querySelectorAll('.wl-x').forEach(xb=>xb.onclick=e=>{e.stopPropagation();wlRemove(xb.dataset.x)});
  fillWlAdd();
}
/* ---------- watchlist editing ---------- */
function fillWlAdd(){const s=document.getElementById('wlAdd');if(!s)return;s.innerHTML='<option value="">+ Add symbol…</option>'+Object.keys(SPECS).filter(x=>!WATCH.includes(x)).map(x=>`<option value="${x}">${x}</option>`).join('')}
{const s=document.getElementById('wlAdd');if(s)s.onchange=()=>{if(s.value&&!WATCH.includes(s.value)){WATCH.push(s.value);renderWatchlist();fillWlAdd();toast(s.value+' added to watchlist',var_bull())}}}
function wlRemove(sym){const i=WATCH.indexOf(sym);if(i>=0){WATCH.splice(i,1);renderWatchlist();fillWlAdd()}}

/* ---------- setup scanner: scan the watchlist for YOUR conditions ---------- */
function scanBars(sym){for(const k in BAR_CACHE){if(k.startsWith(sym+'|')&&BAR_CACHE[k].length>120)return BAR_CACHE[k]}return genData(260,(SPECS[sym]||{px:100}).px,(sym.charCodeAt(0)+sym.length)*13)}
function runScan(){
  const out=document.getElementById('scanOut');if(!out)return;
  const minS=Math.abs(+document.getElementById('scanMin').value||25);
  const wantVwap=document.getElementById('scanVwap').checked,wantDiv=document.getElementById('scanDiv').checked;
  out.innerHTML='<span style="color:var(--muted);font-size:12px">scanning '+WATCH.length+' symbols…</span>';
  setTimeout(()=>{
    const rows=[];
    WATCH.forEach(sym=>{try{
      const d=scanBars(sym),n=d.length-1,con=consensusSignal(d);
      if(Math.abs(con.score)<minS)return;
      const vw=IND.vwapBands(d).vw[n],vdist=vw?Math.abs(d[n].c-vw)/vw*100:99;
      if(wantVwap&&vdist>=0.5)return;
      const divs=divScanAll(d),hasDiv=['rsi','macd','mfi'].some(k=>divs[k]&&divs[k].length&&n-divs[k][divs[k].length-1].i2<12);
      if(wantDiv&&!hasDiv)return;
      rows.push({sym,con,vdist:+vdist.toFixed(2),hasDiv,live:!!Object.keys(BAR_CACHE).find(k=>k.startsWith(sym+'|'))});
    }catch(e){}});
    rows.sort((a,b)=>Math.abs(b.con.score)-Math.abs(a.con.score));
    out.innerHTML=rows.length?`<table class="log"><thead><tr><th>Symbol</th><th>Consensus</th><th>Agree</th><th>vs VWAP</th><th>Diverg.</th><th>Data</th></tr></thead><tbody>${rows.map(r=>`<tr class="scan-row" data-s="${r.sym}" style="cursor:pointer"><td><b>${r.sym}</b></td><td style="color:${r.con.score>0?'var(--bull)':'var(--bear)'}">${r.con.label} ${r.con.score>=0?'+':''}${r.con.score}</td><td class="mono">${r.con.confidence}%</td><td class="mono">${r.vdist}%</td><td>${r.hasDiv?'✓':'—'}</td><td style="color:var(--muted2);font-size:10px">${r.live?'live':'synthetic'}</td></tr>`).join('')}</tbody></table><div style="font-size:10px;color:var(--muted2);margin-top:5px">Click a row to load it. Ranked by |consensus|. Offline symbols use illustrative synthetic data — connect a source for real scans.</div>`
      :'<div style="color:var(--muted);font-size:12px;padding:8px;border:1px dashed var(--edge);border-radius:8px">No setups match — loosen the score threshold or the filters.</div>';
    out.querySelectorAll('.scan-row').forEach(tr=>tr.onclick=()=>loadSymbolName(tr.dataset.s));
  },30);
}
{const b=document.getElementById('scanBtn');if(b)b.onclick=runScan}

/* ========================= news & economic calendar ========================= */
var DEFAULT_NEWS_RSS='https://www.coindesk.com/arc/outboundfeeds/rss/';
function rssToItems(txt){
  try{ if(!/<(item|entry)[ >]/i.test(txt))return null;
    var items=[], re=/<(item|entry)\b[\s\S]*?<\/\1>/gi, m;
    while((m=re.exec(txt))&&items.length<40){ var b=m[0];
      var t=(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'';
      var link=(b.match(/<link[^>]*href="([^"]+)"/i)||[])[1]||(b.match(/<link[^>]*>([\s\S]*?)<\/link>/i)||[])[1]||'';
      var date=(b.match(/<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/\1>/i)||[])[2]||'';
      t=t.replace(/<!\[CDATA\[|\]\]>/g,'').replace(/<[^>]+>/g,'').trim();
      if(t)items.push({t:Date.parse(date)||null,impact:null,title:t,meta:(date||'').trim(),url:(link||'').trim()}); }
    return items.length?items:null;
  }catch(e){return null}
}
function newsParse(kind,txt){
  let j;try{j=JSON.parse(txt)}catch(e){return rssToItems(txt)}
  const items=[];
  const arr=Array.isArray(j)?j:(j.results||j.data||j.articles||j.feed||[]);
  if(!Array.isArray(arr))return null;
  arr.slice(0,40).forEach(o=>{
    const _tm=Date.parse(o.published_at||o.datetime||o.date||o.time||'');
    if(kind==='calendar'){items.push({t:Number.isFinite(_tm)?_tm:null,impact:o.impact||null,title:o.event||o.title||o.name||'(event)',meta:[o.country,o.date||o.time,o.impact&&('impact: '+o.impact),o.actual!=null&&('actual '+o.actual),o.forecast!=null&&('forecast '+o.forecast)].filter(Boolean).join(' · '),url:null});}
    else{items.push({t:Number.isFinite(_tm)?_tm:null,impact:null,title:o.title||o.headline||o.name||'(headline)',meta:[o.source&&(o.source.title||o.source),o.published_at||o.datetime||o.date,(o.currencies||[]).map&&(o.currencies||[]).map(c=>c.code).join(',')].filter(Boolean).join(' · '),url:o.url||o.link||(o.source&&o.source.url)});}
  });
  return items;
}
async function renderNews(){
  const list=document.getElementById('newsList');if(!list)return;
  const kind=document.getElementById('newsKind').value;
  let url=(document.getElementById('newsUrl').value||'').trim()||((kind==='calendar'?(document.getElementById('dsCalUrl')||{}).value:(document.getElementById('dsNewsUrl')||{}).value)||'').trim();
  if(!url&&kind!=='calendar')url=DEFAULT_NEWS_RSS;   /* headlines populate with zero setup via keyless RSS through the proxy */
  if(!url){list.innerHTML='<div style="color:var(--muted);font-size:12px;padding:8px">No source set. Paste an endpoint above or in Settings → ③ External data. Free sources are listed below.</div>';return}
  if(!proxyBase()){list.innerHTML='<div style="color:var(--gold);font-size:12px;padding:8px">Run the local proxy and set its URL in Settings → ② so the browser can fetch this without CORS.</div>';return}
  list.innerHTML='<div style="color:var(--muted);padding:8px">fetching…</div>';
  try{const res=await fetch(proxyBase()+'/fetch?url='+encodeURIComponent(url));const txt=await res.text();const items=newsParse(kind,txt);
    if(!items||!items.length){list.innerHTML='<div style="font-size:11px;color:var(--muted)">Fetched '+txt.length+' bytes but couldn\'t auto-parse this shape. Raw preview:</div><pre style="font-size:10px;color:var(--muted2);white-space:pre-wrap;max-height:300px;overflow:auto">'+txt.slice(0,1200).replace(/</g,'&lt;')+'</pre>';return}
    window._newsItems=items;try{if(typeof ON!=='undefined'&&ON.has('news')&&typeof draw==='function')draw()}catch(e){}
    try{ if(kind==='calendar'){ window._macroCal=items.filter(function(i){return i.t}).map(function(i){return {t:new Date(i.t).toISOString(),n:i.title,impact:i.impact}}); } else { window._newsFeed=items.filter(function(i){return i.title}).map(function(i){return {title:i.title}}); } }catch(e){}
    list.innerHTML=items.map(it=>`<div class="panelbox" style="padding:10px"><div style="font-size:13px;font-weight:600;color:var(--txt)">${(it.url?`<a href="${it.url}" target="_blank" rel="noopener" style="color:var(--txt);text-decoration:none">${it.title.replace(/</g,'&lt;')}</a>`:it.title.replace(/</g,'&lt;'))}</div>${it.meta?`<div style="font-size:10px;color:var(--muted2);margin-top:3px">${it.meta.replace(/</g,'&lt;')}</div>`:''}</div>`).join('');
  }catch(e){list.innerHTML='<div style="color:var(--bear);font-size:12px;padding:8px">✗ '+e.message+' (is the proxy running?)</div>'}
}
{const b=document.getElementById('newsLoad');if(b)b.onclick=renderNews}
async function autoNews(){
  if(!proxyBase())return;
  var calU=((document.getElementById('dsCalUrl')||{}).value||'').trim(), newsU=((document.getElementById('dsNewsUrl')||{}).value||'').trim();
  async function pull(kind,url){ if(!url)return; try{ var res=await fetch(proxyBase()+'/fetch?url='+encodeURIComponent(url),{signal:AbortSignal.timeout(6000)}); var txt=await res.text(); var items=newsParse(kind,txt); if(!items||!items.length)return;
    if(kind==='calendar')window._macroCal=items.filter(function(i){return i.t}).map(function(i){return {t:new Date(i.t).toISOString(),n:i.title,impact:i.impact}});
    else window._newsFeed=items.filter(function(i){return i.title}).map(function(i){return {title:i.title}}); }catch(e){} }
  await pull('calendar',calU); await pull('news',newsU||DEFAULT_NEWS_RSS);
}
window.autoNews=autoNews;
setTimeout(function(){try{autoNews()}catch(e){}},3000);
setInterval(function(){try{autoNews()}catch(e){}},300000);
// hide side panel when not on chart by adjusting grid
const appEl=document.querySelector('.app');
window.SIDE_W=344;window.SIDE_COLLAPSED=false;
window.syncAppGrid=function(){/* v39.3 V3: this used to write an inline grid-template-columns - still computing a 216/74px column for the RAIL THAT DIED IN v25 - and it LOST to the v39 !important shell rule, so the hide/show chevron changed a style that could no longer take effect. One CSS variable now carries the live width; the single authoritative rule obeys it. */try{appEl.style.gridTemplateColumns='';appEl.style.gridTemplateRows='';}catch(e){}var chartOn=document.getElementById('v-chart').classList.contains('on');var w=chartOn?(window.SIDE_COLLAPSED?0:(window.SIDE_W||320)):0;document.documentElement.style.setProperty('--side-w-live',w+'px');if(window.layoutSide)window.layoutSide();};
new MutationObserver(window.syncAppGrid).observe(document.getElementById('v-chart'),{attributes:true});syncAppGrid();

// indicator chips
document.getElementById('toolbar').querySelectorAll('.chip').forEach(ch=>ch.onclick=()=>{const k=ch.dataset.ind;ch.classList.toggle('on');if(ON.has(k))ON.delete(k);else ON.add(k);draw()});
// timeframe
document.getElementById('tfBar').querySelectorAll('button').forEach(b=>b.onclick=()=>{document.getElementById('tfBar').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');TF=b.dataset.tf;if(window.syncTfLabel)syncTfLabel();loadSymbol()});
// asset-class toggle
document.getElementById('assetCls').querySelectorAll('button').forEach(b=>b.onclick=()=>{document.getElementById('assetCls').querySelectorAll('button').forEach(x=>x.classList.remove('on'));b.classList.add('on');populateSymbols(b.dataset.cls);loadSymbol()});
// buttons
document.getElementById('symSel').onchange=loadSymbol;
document.getElementById('newBtn').onclick=()=>{DATA=genData(600,DATA[DATA.length-1].c,(Math.random()*1e6)|0);recompute()};
document.getElementById('stratSel').onchange=()=>{stratHint();runBacktest()};
document.getElementById('runBt').onclick=runBacktest;
{const bc=document.getElementById('btCost');if(bc)bc.addEventListener('change',()=>{if(document.getElementById('stratSel').value)runBacktest()})}

/* ================= v39.21 TRENDING INSIGHTS (Arkham-style, from the terminal's own live reads) ================= */
function _insCard(ins){
  var pills=(ins.tags||[]).map(function(t){return '<span class="pill '+(t.cls||'')+'">'+t.label+'</span>';}).join(' ');
  return '<div class="panelbox" style="padding:12px;'+(ins.sym?'cursor:pointer':'')+'"'+(ins.sym?' data-ins-sym="'+ins.sym+'"':'')+'>'
    +'<div style="display:flex;gap:5px;margin-bottom:8px;flex-wrap:wrap">'+pills+'</div>'
    +'<div style="font-size:13px;font-weight:600;color:var(--txt);line-height:1.4">'+ins.headline+'</div>'
    +(ins.meta?'<div style="font-size:10px;color:var(--muted2);margin-top:6px">'+ins.meta+'</div>':'')+'</div>';
}
function buildInsights(){
  var out=[], sym=(window.CURSYM&&CURSYM.sym)||'';
  var x=null; try{x=analystContext()}catch(e){}
  if(x&&x.con){ var sc=x.con.score, dir=sc>8?'Bullish':sc<-8?'Bearish':'Neutral', cls=sc>8?'bull':sc<-8?'bear':'';
    out.push({tags:[{label:dir,cls:cls},{label:'Confluence',cls:'info'}], sym:sym,
      headline:(window.assetIcon?assetIcon(sym,15)+' ':'')+sym+' consensus '+x.con.label+' '+(sc>=0?'+':'')+sc+' \u00b7 '+x.con.confidence+'% agree',
      meta:'this-timeframe glass-box read \u00b7 '+((x.reg&&x.reg.regime)||'')}); }
  var of=window._ofRead; if(of){ var lean=of.lean||'', l=/UP/.test(lean)?'Bullish':/DOWN/.test(lean)?'Bearish':'', lc=l==='Bullish'?'bull':l==='Bearish'?'bear':'';
    out.push({tags:[{label:'Order Flow',cls:'info'}].concat(l?[{label:l,cls:lc}]:[]).concat(of.absorption?[{label:'Absorption',cls:'whale'}]:[]),
      headline:'Book '+(of.imbalance!=null?Math.round(of.imbalance*100)+'% bid-heavy':'balanced')+(of.taker_buy!=null?' \u00b7 '+Math.round(of.taker_buy*100)+'% takers buying':''),
      meta:(of.absorption?of.absorption+' \u00b7 ':'')+'CVD '+(of.cvd!=null?(of.cvd>=0?'+':'')+of.cvd.toFixed(1):'\u2014')}); }
  try{ var nx=(window._macroCal||[]).map(function(e){return {t:Date.parse(e.t),n:e.n}}).filter(function(e){return isFinite(e.t)&&e.t>Date.now()}).sort(function(a,b){return a.t-b.t})[0];
    if(nx){ var m=Math.round((nx.t-Date.now())/60000); out.push({tags:[{label:'Important',cls:'warn'},{label:'Calendar',cls:''}], headline:'\u26a1 '+nx.n+' in '+(m>=60?Math.floor(m/60)+'h'+(m%60)+'m':m+'m'), meta:'high-impact event window'}); } }catch(e){}
  var fr=window._fundRate; if(fr!=null&&Math.abs(fr)>0.03) out.push({tags:[{label:fr>0?'Crowded Longs':'Crowded Shorts',cls:fr>0?'bear':'bull'},{label:'Funding',cls:'pump'}], headline:'Funding '+fr.toFixed(3)+'% \u2014 '+(fr>0?'longs paying, squeeze risk':'shorts paying, squeeze risk'), meta:'perp funding'});
  if(window._imx&&window._imx.anomaly&&window._imx.anomaly.flag) out.push({tags:[{label:'Anomaly',cls:'bear'}], headline:'Unusual market conditions \u2014 historical patterns may not hold', meta:'structural anomaly detector'});
  if(window._imx&&window._imx.regime&&window._imx.regime.state) out.push({tags:[{label:'Regime',cls:'info'}], headline:'Market regime: '+window._imx.regime.state, meta:'cross-market volatility read'});
  if(window._fng!=null){ var fg=window._fng, fl=fg<25?'Extreme Fear':fg<45?'Fear':fg<55?'Neutral':fg<75?'Greed':'Extreme Greed'; out.push({tags:[{label:fl,cls:fg<45?'bull':fg>55?'bear':''}], headline:'Fear & Greed '+Math.round(fg)+' \u00b7 '+fl, meta:'contrarian sentiment gauge'}); }
  try{ var mm=mtfMatrix(); if(mm&&mm.agree!=null) out.push({tags:[{label:'Multi-TF',cls:'info'},{label:mm.agree>=66?'Aligned':'Split',cls:mm.agree>=66?'bull':'warn'}], headline:'Timeframes '+mm.agree+'% aligned', meta:'15m \u00b7 1H \u00b7 4H \u00b7 1D confluence'}); }catch(e){}
  return out;
}
function renderInsights(){
  var grid=document.getElementById('insightsGrid'); if(!grid)return;
  var ins=buildInsights();
  if(!ins.length){ grid.innerHTML='<div style="grid-column:1/-1;color:var(--muted);padding:14px;border:1px dashed var(--edge);border-radius:8px">No live insights yet \u2014 go Online and load a symbol; order-flow, funding and news populate as their feeds connect. Nothing is fabricated here.</div>'; return; }
  grid.innerHTML=ins.map(_insCard).join('');
  grid.querySelectorAll('[data-ins-sym]').forEach(function(c){ c.onclick=function(){ try{loadSymbolName(c.dataset.insSym)}catch(e){} }; });
  try{ if(Date.now()-(window._insDecAt||0)>20000){ window._insDecAt=Date.now(); if(typeof decideNow==='function')decideNow('insDecision'); } }catch(e){}
  var _db=document.getElementById('insDecideBtn'); if(_db&&!_db._wired){ _db._wired=1; _db.onclick=function(){ window._insDecAt=Date.now(); if(typeof decideNow==='function')decideNow('insDecision'); }; }
}
window.renderInsights=renderInsights;
setInterval(function(){ try{ var v=document.getElementById('v-insights'); if(v&&v.classList.contains('on')&&!document.hidden) renderInsights(); }catch(e){} }, 5000);


/* ================= v39.29 UPCOMING EVENTS STRIP — next high-impact events with live countdowns ================= */
function renderUpcoming(){
  var el=document.getElementById('upcomingEvents'); if(!el)return;
  var now=Date.now();
  var evs=(window._macroCal||[]).map(function(e){return {t:Date.parse(e.t),n:e.n,impact:e.impact};})
    .filter(function(e){return isFinite(e.t)&&e.t>now;}).sort(function(a,b){return a.t-b.t;}).slice(0,3);
  if(!evs.length){ el.innerHTML='<div style="font-size:11px;color:var(--muted2);padding:8px 0">No upcoming events — wire a calendar source below to see what\u2019s coming.</div>'; return; }
  el.innerHTML='<div style="font-size:10px;color:var(--muted2);letter-spacing:.06em;margin-bottom:6px">NEXT HIGH-IMPACT EVENTS</div>'
    +'<div style="display:flex;gap:10px;flex-wrap:wrap">'+evs.map(function(e){
      var m=Math.round((e.t-now)/60000), cd=m>=60?Math.floor(m/60)+'h '+(m%60)+'m':m+'m', hi=/high/i.test(e.impact||'');
      return '<div style="flex:1;min-width:190px;padding:9px 11px;border:1px solid '+(hi?'var(--bear)':'var(--edge)')+';border-radius:8px;background:color-mix(in srgb,var(--panel2) 50%,transparent)"><div style="font-size:12px;font-weight:600">'+(hi?'<span style="color:var(--bear)">\u25c6</span> ':'')+e.n+'</div><div style="font-size:11px;color:var(--accent);margin-top:3px">in '+cd+'</div></div>';
    }).join('')+'</div>';
}
window.renderUpcoming=renderUpcoming;
setInterval(function(){ try{ var v=document.getElementById('v-news'); if(v&&v.classList.contains('on')&&!document.hidden)renderUpcoming(); }catch(e){} },15000);
