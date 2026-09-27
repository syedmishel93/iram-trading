document.addEventListener('keydown',e=>{const ae=document.activeElement;if(ae&&/input|textarea|select/i.test(ae.tagName))return;if(!document.getElementById('v-chart').classList.contains('on'))return;
  if(e.key==='ArrowLeft'){VIEW.off=Math.min(Math.max(0,DATA.length-VIEW.count),VIEW.off+Math.max(1,VIEW.count>>3));requestDraw()}
  else if(e.key==='ArrowRight'){VIEW.off=Math.max(0,VIEW.off-Math.max(1,VIEW.count>>3));requestDraw()}
  else if(e.key==='+'||e.key==='='){animBars(VIEW.count/1.2)}
  else if(e.key==='-'||e.key==='_'){animBars(VIEW.count*1.2)}});
try{new ResizeObserver(()=>{if(document.getElementById('v-chart').classList.contains('on'))requestDraw()}).observe(cv.parentElement||cv)}catch(e){}
cv.addEventListener('wheel',e=>{e.preventDefault();const {x}=evtXY(e);const W=cv._w-64;if(W<=0||!DATA.length)return;
  const oldCount=VIEW.count;const start=Math.max(0,DATA.length-oldCount-VIEW.off);
  const iCur=Math.max(0,Math.min(oldCount,x/(W/oldCount)));const globalBar=start+iCur;               // bar under the cursor
  const factor=e.deltaY>0?1.15:1/1.15;                                                              // smooth proportional step
  const newCount=Math.max(20,Math.min(DATA.length||600,Math.round(oldCount*factor)));
  const newStart=globalBar-(x/(W/newCount));                                                         // keep that bar under the cursor
  let newOff=Math.round(DATA.length-newCount-newStart);
  newOff=Math.max(0,Math.min(Math.max(0,DATA.length-newCount),newOff));
  VIEW.count=newCount;VIEW.off=newOff;const bc=document.getElementById('barsCount');if(bc)bc.textContent=VIEW.count;requestDraw();
},{passive:false});
addEventListener('mouseup',()=>{if(drag&&drag.v)startInertia(drag.v);drag=null});
addEventListener('resize',()=>draw());
// drawing toolbar
document.getElementById('drawbar').querySelectorAll('button[data-tool]').forEach(b=>b.onclick=()=>setTool(b.dataset.tool));
document.getElementById('drawUndo').onclick=undoDraw;
document.addEventListener('keydown',e=>{const ae=document.activeElement;if(ae&&/input|textarea|select/i.test(ae.tagName))return;if((e.key==='Delete'||e.key==='Backspace')&&SELDRAW>=0&&SELDRAW<DRAWINGS.length&&document.getElementById('v-chart').classList.contains('on')){e.preventDefault();snapDrawings();DRAWINGS.splice(SELDRAW,1);SELDRAW=-1;draw();toast('Drawing deleted',var_bull())}if(e.key==='Escape'&&SELDRAW>=0){SELDRAW=-1;draw()}});
{const dt=document.getElementById('drawToggle');if(dt)dt.onclick=()=>{const db=document.getElementById('drawbar');const open=db.classList.toggle('open');dt.classList.toggle('on',open);if(!open)setTool('cursor')}}
function applyTheme(name){const r=document.documentElement;if(name==='midnight')r.removeAttribute('data-theme');else r.setAttribute('data-theme',name);try{localStorage.setItem('mishel_theme',name)}catch(e){}_cbull=_cbear=null;const sel=document.getElementById('themeSel');if(sel)sel.value=name;const tb=document.getElementById('themeBtn');if(tb)tb.innerHTML=name==='light'?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>';if(document.getElementById('v-chart').classList.contains('on'))draw();if(document.getElementById('v-multi').classList.contains('on'))renderMulti();const w=document.getElementById('v-watchlist');if(w&&w.classList.contains('on'))renderWatchlist();if(typeof renderAnalytics==='function')try{renderAnalytics()}catch(e){}}
{const tb=document.getElementById('themeBtn');if(tb)tb.onclick=()=>applyTheme((document.documentElement.getAttribute('data-theme')==='light')?'midnight':'light')}
{const sel=document.getElementById('themeSel');if(sel)sel.onchange=()=>applyTheme(sel.value)}
{const ct=document.getElementById('chartType');if(ct)ct.onchange=()=>{CHART_TYPE=ct.value;draw()}}
{const ls=document.getElementById('layoutSel');if(ls){const rebuild=()=>{const custom=Object.keys(LAYOUTS).filter(k=>!['scalp','swing','clean','full'].includes(k));ls.innerHTML='<option value="">Layout…</option><option value="scalp"> Scalp</option><option value="swing"> Swing</option><option value="clean"> Clean</option><option value="full"> Full</option>'+custom.map(k=>`<option value="${k}">★ ${k}</option>`).join('')+'<option value="__save"> Save current as…</option>'};rebuild();
 ls.onchange=()=>{const v=ls.value;ls.value='';if(!v)return;if(v==='__save'){const name=prompt('Name this layout (current indicators, panes, chart type & timeframe):');if(!name)return;LAYOUTS[name.trim()]={tf:TF,on:[...ON],panes:[...PANES],type:CHART_TYPE};rebuild();try{if(persistOn())STORE.set('mishel_layouts',JSON.stringify(Object.fromEntries(Object.entries(LAYOUTS).filter(([k])=>!['scalp','swing','clean','full'].includes(k)))))}catch(e){}toast('Layout "'+name+'" saved',var_bull());return}applyLayout(v)};
 try{const saved=localStorage.getItem('mishel_layouts');if(saved){Object.assign(LAYOUTS,JSON.parse(saved));rebuild()}}catch(e){}}}
/* ---------- candle close countdown (on demand) ---------- */
let cdOn=false,cdTimer=null;
function tfSeconds(tf){return {'1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600,'4h':14400,'1d':86400,'1w':604800,'1M':2592000}[tf]||3600}
function updateCountdown(){const el=document.getElementById('cdVal');if(!el)return;if(!cdOn){el.textContent='off';return}if(!DATA.length){el.textContent='—';return}const dur=tfSeconds(TF)*1000;const close=DATA[DATA.length-1].t+dur;let left=Math.floor((close-Date.now())/1000);if(left<0)left=0;const h=Math.floor(left/3600),m=Math.floor(left%3600/60),s=left%60;el.textContent=(h>0?h+':'+String(m).padStart(2,'0'):m)+':'+String(s).padStart(2,'0')}
{const cb=document.getElementById('cdBtn');if(cb)cb.onclick=()=>{cdOn=!cdOn;cb.classList.toggle('gold',cdOn);if(cdOn){updateCountdown();if(!cdTimer)cdTimer=setInterval(updateCountdown,1000)}else{if(cdTimer){clearInterval(cdTimer);cdTimer=null}updateCountdown()}}}
{const _redraw=()=>setTimeout(()=>{if(document.getElementById('v-chart').classList.contains('on'))draw();if(document.getElementById('v-multi').classList.contains('on'))renderMulti()},70);
 const mt=document.getElementById('minTop');if(mt)mt.onclick=()=>{document.querySelector('.app').classList.add('topmin');_redraw()};
 const rt=document.getElementById('restoreTop');if(rt)rt.onclick=()=>{document.querySelector('.app').classList.remove('topmin');_redraw()};
 const fs=document.getElementById('fsBtn');if(fs)fs.onclick=()=>{const el=document.documentElement,fsEl=document.fullscreenElement||document.webkitFullscreenElement;try{if(!fsEl){(el.requestFullscreen||el.webkitRequestFullscreen).call(el)}else{(document.exitFullscreen||document.webkitExitFullscreen).call(document)}}catch(e){}_redraw()};
 document.addEventListener('fullscreenchange',_redraw);}
document.getElementById('drawClear').onclick=()=>{snapDrawings();DRAWINGS=[];SELDRAW=-1;draw()};
{const m=document.getElementById('barsMinus');if(m)m.onclick=()=>setBars(VIEW.count-20)}
{const p=document.getElementById('barsPlus');if(p)p.onclick=()=>setBars(VIEW.count+20)}
{const f=document.getElementById('barsFit');if(f)f.onclick=()=>{VIEW.off=0;setBars(120)}}
{const t=document.getElementById('indToggle'),tb=document.getElementById('toolbar');if(t&&tb){
  /* categorize the chips into labelled groups (nodes move, listeners persist) */
  try{
  const CATS=[['Trend',['ema20','ema50','ema200','super','boll','nw','predr']],['Levels',['sr','pdhl','pdc','pwhl','dopen','sesshl','vwap','autotl','autofib']],['Smart Money',['fvg','ob','liq','bos','idm','swings','pd']],['Signals',['patterns','div','divscan']],['Volume & Profile',['vp','mp','raindrop']],['Context',['sessions']]];
  const chips={};tb.querySelectorAll('.chip[data-ind]').forEach(c=>chips[c.dataset.ind]=c);
  const anchor=tb.querySelector('.tgroup:not(#indToggleGroup)');if(anchor)anchor.remove();
  const frag=document.createDocumentFragment();
  CATS.forEach(([name,ids])=>{const have=ids.filter(id=>chips[id]);if(!have.length)return;const g=document.createElement('div');g.className='tcat';const h=document.createElement('div');h.className='tcat-h';h.textContent=name;g.appendChild(h);have.forEach(id=>g.appendChild(chips[id]));frag.appendChild(g)});
  const leftovers=Object.keys(chips).filter(id=>!CATS.some(([,ids])=>ids.includes(id)));
  if(leftovers.length){const g=document.createElement('div');g.className='tcat';const h=document.createElement('div');h.className='tcat-h';h.textContent='Other';g.appendChild(h);leftovers.forEach(id=>g.appendChild(chips[id]));frag.appendChild(g)}
  tb.appendChild(frag);
  }catch(e){/* categorization is cosmetic — never block boot */}
  const upd=()=>{const c=document.getElementById('indCount');if(c)c.textContent='('+ON.size+' on)'};t.onclick=()=>{tb.classList.toggle('collapsed');const a=t.querySelector('.arw');if(a)a.textContent=tb.classList.contains('collapsed')?'▾':'▴';upd()};tb.classList.add('collapsed');upd();tb.addEventListener('click',e=>{if(e.target.closest&&e.target.closest('.chip'))setTimeout(upd,0)})}}
{const pc=document.getElementById('paneCtl');if(pc)pc.querySelectorAll('button').forEach(b=>b.onclick=()=>{const p=b.dataset.pane;if(p==='vol'){VOL_ON=!VOL_ON;b.classList.toggle('on',VOL_ON)}else{if(PANES.has(p))PANES.delete(p);else PANES.add(p);b.classList.toggle('on',PANES.has(p))}draw()})}

// bar replay
let replayTimer=null;
function replay(){if(replayTimer){clearInterval(replayTimer);replayTimer=null;document.getElementById('replayBtn').textContent='▷ Bar Replay';VIEW.off=0;draw();return}document.getElementById('replayBtn').textContent='⏸ Replaying…';VIEW.off=90;draw();replayTimer=setInterval(()=>{if(VIEW.off<=0){clearInterval(replayTimer);replayTimer=null;document.getElementById('replayBtn').textContent='▷ Bar Replay';return}VIEW.off-=1;draw()},280)}

// init
populateSymbols('forex');
populateStrats('scalp');
wireCalc();
wireSettings();
(function seedCalc(){const sp=SPECS[document.getElementById('kSym').value||'EURUSD'];document.getElementById('kPrice').value=sp.px;document.getElementById('kEntry').value=sp.px;document.getElementById('kSL').value=+(sp.px*0.99).toFixed(sp.pip<0.01?4:2);document.getElementById('kTP').value=+(sp.px*1.02).toFixed(sp.pip<0.01?4:2)})();
setMode('offline');
loadSymbol();
{const pc=document.getElementById('persistChk');if(pc){try{pc.checked=persistOn()}catch(e){}pc.onchange=()=>persistToggle(pc.checked)}
 const stb=document.getElementById('selfTestBtn');if(stb)stb.onclick=renderSelfTest;
 if(persistRestore()){recompute();toast('Setup restored',var_bull())}
 try{if(!localStorage.getItem('mishel_toured'))setTimeout(startTour,1600)}catch(e){}}
setTimeout(draw,60);

/* ---- v5.2: escape stacking traps + sidebar pin ---- */
(function(){try{
  ['morePanel','symDrop','ctxMenu','cmdk'].forEach(function(id){var el=document.getElementById(id);
    if(el&&el.parentElement!==document.body){document.body.appendChild(el)}});
  var app=document.querySelector('.app'),pin=document.getElementById('railPin');
  if(pin&&app){pin.addEventListener('click',function(){
    app.classList.toggle('rail-pinned');
    var on=app.classList.contains('rail-pinned');var l=pin.querySelector('.lbl');if(l)l.textContent=on?'Collapse sidebar':'Pin sidebar';if(window.syncAppGrid)syncAppGrid();try{localStorage.setItem('mishel_pin',on?'1':'0')}catch(e){}
    try{if(typeof draw==='function'&&document.getElementById('v-chart').classList.contains('on')){setTimeout(draw,230)}}catch(e){}
  });}
}catch(e){}})();


/* ---- v5.3: TradingView-style timeframe dropdown ---- */
(function(){try{
  var bar=document.getElementById('tfBar'),btn=document.getElementById('tfMoreBtn'),menu=document.getElementById('tfMenu');
  if(!bar||!btn||!menu)return;
  if(document.body&&menu.parentElement!==document.body)document.body.appendChild(menu);
  var groups=[['Minutes',['1m','5m','15m','30m']],['Hours',['1h','4h']],['Days',['1d','1w','1M']]];
  window.syncTfLabel=function(){var on=bar.querySelector('button.on');var cur=document.getElementById('tfMoreCur');if(!cur)return;var FAV=['1m','5m','15m','1h','4h','1d'];var tf=on?on.dataset.tf:null;cur.textContent=(tf&&FAV.indexOf(tf)<0)?on.textContent.trim():'+';};
  function build(){menu.innerHTML=groups.map(function(g){return '<div class="tfm-h">'+g[0]+'</div>'+g[1].map(function(tf){var rb=bar.querySelector('button[data-tf="'+tf+'"]');var on=rb&&rb.classList.contains('on');return '<button class="tfm-item'+(on?' on':'')+'" data-tf="'+tf+'">'+(rb?rb.textContent.trim():tf)+'</button>';}).join('');}).join('');
    menu.querySelectorAll('.tfm-item').forEach(function(it){it.onclick=function(e){e.stopPropagation();var rb=bar.querySelector('button[data-tf="'+it.dataset.tf+'"]');if(rb)rb.click();menu.style.display='none';};});}
  btn.onclick=function(e){e.stopPropagation();if(menu.style.display==='block'){menu.style.display='none';return;}build();var r=btn.getBoundingClientRect();menu.style.left=Math.min(r.left,innerWidth-170)+'px';menu.style.top=(r.bottom+6)+'px';menu.style.display='block';};
  document.addEventListener('click',function(e){if(menu.style.display==='block'&&!(e.target.closest&&(e.target.closest('#tfMenu')||e.target.closest('#tfMoreBtn'))))menu.style.display='none';});
  syncTfLabel();
}catch(e){}})();


/* ---- Phase 2: fold the indicator chips into a searchable popover ---- */
(function(){try{
  var t=document.getElementById('indToggle'),tb=document.getElementById('toolbar');
  if(!t||!tb)return;
  var panel=document.createElement('div');panel.id='indPanel';
  panel.innerHTML='<div class="indp-head"><input id="indSearch" placeholder="Search indicators\u2026" autocomplete="off" spellcheck="false"></div><div id="indPanelBody"><div id="indPanelEmpty">No indicators match.</div></div>';
  document.body.appendChild(panel);
  var body=document.getElementById('indPanelBody'),empty=document.getElementById('indPanelEmpty');
  /* move the already-categorized .tcat groups out of the toolbar into the panel */
  tb.querySelectorAll('.tcat').forEach(function(g){body.appendChild(g)});
  /* drop leftover section labels + un-collapse (chips no longer live in the strip) */
  tb.querySelectorAll('.tgroup:not(#indToggleGroup)').forEach(function(g){g.remove()});
  tb.classList.remove('collapsed');
  function upd(){var c=document.getElementById('indCount');if(c)c.textContent='('+ON.size+' on)';}
  function filter(q){q=(q||'').toLowerCase().trim();var shown=0;
    body.querySelectorAll('.tcat').forEach(function(g){var any=false;
      g.querySelectorAll('.chip').forEach(function(c){var ok=!q||c.textContent.toLowerCase().indexOf(q)>=0;c.style.display=ok?'':'none';if(ok){any=true;shown++;}});
      g.style.display=any?'':'none';});
    empty.style.display=shown?'none':'block';}
  function open(){var r=t.getBoundingClientRect();panel.style.left=Math.min(r.left,innerWidth-356)+'px';panel.style.top=(r.bottom+7)+'px';panel.style.display='flex';var si=document.getElementById('indSearch');si.value='';filter('');si.focus();var a=t.querySelector('.arw');if(a)a.textContent='\u25b4';}
  function close(){panel.style.display='none';var a=t.querySelector('.arw');if(a)a.textContent='\u25be';}
  t.onclick=function(e){e.stopPropagation();if(panel.style.display==='flex')close();else open();};
  document.getElementById('indSearch').addEventListener('input',function(e){filter(e.target.value);});
  document.getElementById('indSearch').addEventListener('keydown',function(e){if(e.key==='Escape')close();});
  panel.addEventListener('click',function(e){e.stopPropagation();if(e.target.closest&&e.target.closest('.chip'))setTimeout(upd,0);});
  document.addEventListener('click',function(e){if(panel.style.display==='flex'&&!(e.target.closest&&(e.target.closest('#indPanel')||e.target.closest('#indToggle'))))close();});
  upd();
}catch(e){}})();


/* ---- v5.8: top-bar reorganization (defensive; never blocks boot) ---- */
