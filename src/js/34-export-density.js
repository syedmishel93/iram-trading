function exportConfig(){try{const cfg=collectConfig(localStorage);const blob=new Blob([JSON.stringify(cfg,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='mishel-config-'+new Date().toISOString().slice(0,10)+'.json';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},100);if(typeof toast==='function')toast('Config exported ('+Object.keys(cfg.keys).length+' settings)',var_bull())}catch(e){if(typeof toast==='function')toast('Export failed: '+e.message,var_bear())}}
function importConfig(file){if(!file)return;const r=new FileReader();r.onload=()=>{try{const cfg=JSON.parse(r.result);const n=applyConfig(cfg,localStorage);if(typeof toast==='function')toast('Imported '+n+' settings \u2014 reloading\u2026',var_bull());setTimeout(()=>location.reload(),700)}catch(e){if(typeof toast==='function')toast('Import failed: not a valid config file',var_bear())}};r.readAsText(file)}

/* -- F4: signal attribution ("why") -- */
function renderAttribution(){const box=document.getElementById('confAttrib');if(!box)return;let con;try{con=(typeof IND!=='undefined'&&IND._consensus)?IND._consensus:consensusSignal(DATA)}catch(e){return}const rows=attributeConsensus(con);if(!rows.length){box.innerHTML='';return}const max=Math.max(1,...rows.map(r=>Math.abs(r.contribution)));const bars=rows.filter(r=>r.contribution!==0).slice(0,8).map(r=>{const pos=r.contribution>0;const w=Math.abs(r.contribution)/max*100;return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:11px"><span style="width:82px;color:var(--muted);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_memeEsc(r.name)}</span><div style="flex:1;display:flex;justify-content:center"><div style="width:50%;display:flex;justify-content:flex-end">${pos?'':`<div style="height:11px;width:${w}%;background:var(--bear);border-radius:2px 0 0 2px"></div>`}</div><div style="width:50%">${pos?`<div style="height:11px;width:${w}%;background:var(--bull);border-radius:0 2px 2px 0"></div>`:''}</div></div><span class="mono ${pos?'up':'dn'}" style="width:44px">${pos?'+':''}${r.contribution}</span></div>`}).join('');const neutral=rows.filter(r=>r.contribution===0).map(r=>_memeEsc(r.name));box.innerHTML=`<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--edge2)"><div style="font-size:11px;font-weight:600;color:var(--txt);margin-bottom:6px">Why this score \u2014 each module's share</div>${bars}${neutral.length?`<div style="font-size:10px;color:var(--muted2);margin-top:6px">Neutral (no vote): ${neutral.join(', ')}</div>`:''}<div style="font-size:10px;color:var(--muted2);margin-top:6px">Green pulls the score up, red pulls it down; bar length = share of the weighted sum. Contributions add up to the consensus score.</div></div>`}

/* -- F7: backtest explainer -- */
function renderBtExplain(stats){const box=document.getElementById('btExplain');if(!box)return;if(!stats||!stats.trades){box.innerHTML='';return}const ex=explainBacktest(stats);const li=(arr,cls,icon)=>arr.map(x=>`<div style="font-size:11px;color:var(--${cls==='up'?'bull':cls==='dn'?'bear':'muted'});padding:2px 0;line-height:1.45">${icon} ${_memeEsc(x)}</div>`).join('');box.innerHTML=`<div class="panelbox" style="margin-top:16px"><h4>Plain-language read</h4><div style="margin:8px 0"><span class="pill ${ex.verdict[1]==='up'?'memelo':ex.verdict[1]==='dn'?'memehi':'mememid'}" style="font-size:12px">${_memeEsc(ex.verdict[0])}</span></div>${ex.strong.length?li(ex.strong,'up','\u2713'):''}${ex.weak.length?li(ex.weak,'dn','\u2717'):''}${ex.notes.length?li(ex.notes,'','\u2139'):''}<div style="font-size:10px;color:var(--muted2);margin-top:8px">Deterministic read of the real backtest numbers \u2014 no LLM, no invented claims. A backtest is a hypothesis, not a promise; forward-test before sizing up.</div></div>`}

/* -- F3: wallet watchlist + holder-change snapshot -- */
function loadWallets(){try{return JSON.parse(localStorage.getItem('mishel_wallets')||'[]')}catch(e){return []}}
function saveWallets(a){try{localStorage.setItem('mishel_wallets',JSON.stringify(a||[]))}catch(e){}}
function renderWalletList(){const box=document.getElementById('ocWalletList');if(!box)return;const ws=loadWallets();if(!ws.length){box.innerHTML='<span style="font-size:10px;color:var(--muted2)">No saved wallets yet \u2014 track one, then \u2605 Save it here.</span>';return}box.innerHTML=ws.map((w,i)=>`<span class="pill mememid" style="cursor:pointer;margin:2px 4px 2px 0;display:inline-flex;align-items:center;gap:5px"><span class="oc-wl" data-i="${i}">${_memeEsc(w.label||shortAddr(w.addr))} \u00b7 ${_memeEsc(w.chain)}</span><span class="oc-wlx" data-i="${i}" style="cursor:pointer;opacity:.6">\u2715</span></span>`).join('');box.querySelectorAll('.oc-wl').forEach(el=>el.onclick=()=>{const w=loadWallets()[+el.dataset.i];if(!w)return;const inp=document.getElementById('ocWalletAddr');inp.value=w.addr;const sel=document.getElementById('ocWalletChain');if(sel){sel.value=w.chain;OC_WALLET_CHAIN=w.chain}scanWallet()});box.querySelectorAll('.oc-wlx').forEach(el=>el.onclick=()=>{const ws=loadWallets();ws.splice(+el.dataset.i,1);saveWallets(ws);renderWalletList()})}
function saveCurrentWallet(){const addr=((document.getElementById('ocWalletAddr')||{}).value||'').trim();if(!addr){if(typeof toast==='function')toast('Enter a wallet address first',var_bear());return}const ws=loadWallets();if(ws.some(w=>w.addr.toLowerCase()===addr.toLowerCase()&&w.chain===OC_WALLET_CHAIN)){if(typeof toast==='function')toast('Already saved',var_bear());return}ws.unshift({addr,chain:OC_WALLET_CHAIN,label:shortAddr(addr)});saveWallets(ws.slice(0,20));renderWalletList();if(typeof toast==='function')toast('Wallet saved to watchlist',var_bull())}
function holderSnap(key,cur){try{const m=JSON.parse(localStorage.getItem('mishel_holdersnap')||'{}');const prev=m[key]!=null?m[key]:null;m[key]=cur;localStorage.setItem('mishel_holdersnap',JSON.stringify(m));return prev}catch(e){return null}}

function initExtras(){
  const w=(id,fn,ev)=>{const el=document.getElementById(id);if(el&&!el._xw){el._xw=1;el[ev||'onclick']=fn}};
  w('cfgExport',exportConfig);
  w('cfgImport',()=>{const f=document.getElementById('cfgFile');if(f)f.click()});
  const f=document.getElementById('cfgFile');if(f&&!f._xw){f._xw=1;f.onchange=e=>{importConfig(e.target.files&&e.target.files[0])}}
  w('walletSave',saveCurrentWallet);
  try{renderWalletList()}catch(e){}
}
function loadSymbolName(sym){const sp=SPECS[sym];if(!sp)return;document.getElementById('assetCls').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.cls===sp.cls));populateSymbols(sp.cls);document.getElementById('symSel').value=sym;loadSymbol();goView('chart')}
function setTFName(tf){const b=document.querySelector('#tfBar button[data-tf="'+tf+'"]');if(b)b.click()}
function toggleIndId(id){const c=document.querySelector('.chip[data-ind="'+id+'"]');if(c)c.click()}

/* ========================= export + density ========================= */
function exportPNG(){try{const a=document.createElement('a');a.download=(CURSYM.sym||'chart')+'_'+TF+'.png';a.href=document.getElementById('chart').toDataURL('image/png');a.click();toast('Chart PNG exported',var_bull())}catch(e){toast('Export failed',var_bear())}}
function exportCSV(){const rows=[['time','open','high','low','close','volume'],...DATA.map(d=>[new Date(d.t).toISOString(),d.o,d.h,d.l,d.c,d.v])];const csv=rows.map(r=>r.join(',')).join('\n');const a=document.createElement('a');a.download=(CURSYM.sym||'data')+'_'+TF+'.csv';a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.click();toast('CSV exported',var_bull())}
let _density=0;function cycleDensity(){_density=(_density+1)%3;const r=document.documentElement;r.style.fontSize=['','15px','13px'][_density];toast('Density: '+['default','comfortable','compact'][_density])}

/* ========================= alerts inbox (bell + badge) ========================= */
let _alertsSeen=0;
function updateBell(){const b=document.getElementById('bellBadge');if(!b)return;const unseen=Math.max(0,ALERT_LOG.length-_alertsSeen);if(unseen>0){b.style.display='block';b.textContent=unseen>9?'9+':unseen}else b.style.display='none'}
{const bell=document.getElementById('bellBtn');if(bell)bell.onclick=()=>{_alertsSeen=ALERT_LOG.length;updateBell();goView('alerts')}}

/* ========================= command palette ========================= */
let CMD_ACTIVE=0,CMD_LIST=[];
function buildCommands(){
  const cmds=[];
  document.querySelectorAll('.nav').forEach(n=>{const v=n.dataset.view,lbl=(n.querySelector('.lbl')||{}).textContent||v;cmds.push({label:lbl,hint:'View',run:()=>goView(v)})});
  /* v32 D3: tracked wallets, workspaces, quick actions & settings jumps */
  try{(loadWallets()||[]).slice(0,20).forEach(w=>cmds.push({label:'\u{1F40B} '+(w.label||'')+' '+shortAddr(w.addr),hint:'Wallet',run:()=>smWalletDossier(w.addr,w.chain||'ethereum')}))}catch(e){}
  ;['Scalping','Research','Review'].forEach(ws=>cmds.push({label:'\u{1F5C2} Workspace: '+ws,hint:'Workspace',run:()=>window.applyWorkspace&&window.applyWorkspace(ws.toLowerCase())}));
  cmds.push({label:'\u{1F514} Signal alert on this chart',hint:'Action',run:()=>{const b=document.getElementById('sigBellBtn');if(b)b.click()}});
  cmds.push({label:'\u{1F4D3} Open decision journal',hint:'Action',run:()=>{const b=document.getElementById('jrnBtn');if(b)b.click()}});
  cmds.push({label:'\u2696 Execution reconciliation (MT5) \u2014 planned vs actual',hint:'Action',run:()=>window.reconPanel&&window.reconPanel()});
  cmds.push({label:'\ud83d\udee1 Risk Governor \u2014 daily loss, open risk, currency concentration',hint:'Action',run:()=>window.govPanel&&window.govPanel()});
  cmds.push({label:'\u2600 Pre-market ritual \u2014 five checks before London',hint:'Action',run:()=>window.preMarket&&window.preMarket()});
  cmds.push({label:'\u25a4 Toggle volume profile',hint:'Action',run:()=>{const b=document.getElementById('vpvrBtn');if(b)b.click()}});
  cmds.push({label:'\u{1F9F2} Toggle magnet snap',hint:'Action',run:()=>{const b=document.getElementById('magnetBtn');if(b)b.click()}});
  cmds.push({label:'\u2699 Data & Settings',hint:'Settings',run:()=>goView('settings')});
  cmds.push({label:'? Keyboard shortcuts',hint:'Help',run:()=>window.showKeys&&window.showKeys()});
  Object.keys(SPECS).forEach(s=>cmds.push({label:s+' · '+SPECS[s].name,hint:'Symbol',run:()=>loadSymbolName(s)}));
  document.querySelectorAll('#tfBar button').forEach(b=>cmds.push({label:'Timeframe '+b.dataset.tf,hint:'Timeframe',run:()=>setTFName(b.dataset.tf)}));
  document.querySelectorAll('.chip[data-ind]').forEach(c=>cmds.push({label:'Toggle '+c.textContent.trim(),hint:'Indicator',run:()=>toggleIndId(c.dataset.ind)}));
  document.querySelectorAll('#drawbar button[data-tool]').forEach(b=>cmds.push({label:'Tool: '+(b.title||b.dataset.tool),hint:'Draw',run:()=>{if(typeof setTool==='function')setTool(b.dataset.tool)}}));
  ['candles','heikin','bars','line','area'].forEach(t=>cmds.push({label:'Chart type: '+t,hint:'Chart',run:()=>{CHART_TYPE=t;const ct=document.getElementById('chartType');if(ct)ct.value=t;draw()}}));
  ['scalp','swing','clean','full'].forEach(t=>cmds.push({label:'Layout: '+t,hint:'Layout',run:()=>applyLayout(t)}));
  ['institutional','midnight','binance','tradingview','trendspider','frost','light'].forEach(t=>cmds.push({label:'Theme: '+t.charAt(0).toUpperCase()+t.slice(1),hint:'Theme',run:()=>applyTheme(t)}));
  cmds.push({label:'Show onboarding tour',hint:'Help',run:startTour},{label:'Keyboard shortcuts (?)',hint:'Help',run:showHelp},{label:'Run self-test diagnostics',hint:'Action',run:()=>{goView('settings');setTimeout(renderSelfTest,150)}});
  cmds.push({label:'Export chart as PNG',hint:'Action',run:exportPNG},{label:'Export data as CSV',hint:'Action',run:exportCSV},{label:'Cycle density (compact/comfortable)',hint:'Action',run:cycleDensity},{label:'Toggle theme (light/dark)',hint:'Action',run:()=>document.getElementById('themeBtn').click()},{label:'Toggle fullscreen',hint:'Action',run:()=>document.getElementById('fsBtn').click()},{label:'New synthetic data',hint:'Action',run:()=>{const b=document.getElementById('newBtn');if(b)b.click()}});
  cmds.push({label:'Candle skin (vivid \u21c4 muted frost)',hint:'Appearance',run:()=>setCandleSkin(CANDLE_SKIN==='muted'?'vivid':'muted')},{label:'Aurora intensity (cycle)',hint:'Appearance',run:()=>{if(window.cycleAurora)window.cycleAurora()}});
  cmds.push({label:'Toggle GPU renderer (WebGL)',hint:'Action',run:()=>{if(window.GLR)GLR.set(!GLR.on)}},{label:'Toggle Glass interface',hint:'Action',run:()=>{const on=!document.body.classList.contains('glass');document.body.classList.toggle('glass',on);try{localStorage.setItem('mishel_glass',on?'1':'0')}catch(e){}const s=document.getElementById('setGlass');if(s)s.value=on?'1':'0'}});
  cmds.push({label:'Send analysis snapshot to Telegram',hint:'Action',run:()=>{if(window.tgSnapshot)tgSnapshot()}});
  return cmds;
}
function cmdParse(q){ /* v33 M3: Bloomberg-style command syntax */
  const out=[];if(!q)return out;
  let m=q.match(/^([a-z]{2,10})\s+(1m|5m|15m|1h|4h|1d)$/i);
  if(m){const sym=m[1].toUpperCase(),tf2=m[2].toLowerCase();
    const full=Object.keys(SPECS).find(k2=>k2===sym||k2===sym+'USD'||k2.startsWith(sym));
    if(full)out.push({label:'\u{1F4C8} '+full+' \u00b7 '+tf2.toUpperCase(),hint:'Command',run:()=>{loadSymbolName(full);setTimeout(()=>{const b=[...document.querySelectorAll('#tfBar button')].find(x2=>x2.textContent.trim().toLowerCase()===tf2);if(b)b.click()},400)}});}
  m=q.match(/^qfa\s+(.+)$/i);
  if(m)out.push({label:'\u26a1 QFA \u2192 '+m[1],hint:'Command',run:()=>researchPack(m[1].trim(),'ethereum')});
  m=q.match(/^w:(.+)$/i);
  if(m){const needle=m[1].toLowerCase();try{(loadWallets()||[]).forEach(w=>{const n=(walletNick(w.addr)||{}).nick||'';
    if(n.toLowerCase().includes(needle)||w.addr.toLowerCase().includes(needle))out.push({label:'\u{1F40B} '+(n||shortAddr(w.addr)),hint:'Command',run:()=>smWalletDossier(w.addr,w.chain||'ethereum')})})}catch(e){}}
  if(q==='j')out.push({label:'\u{1F4D3} Journal',hint:'Command',run:()=>{const b=document.getElementById('jrnBtn');if(b)b.click()}});
  if(q==='lab')out.push({label:'Strategy lab',hint:'Command',run:()=>window.openLab()});
  return out;}
function renderCmd(filter){const list=document.getElementById('cmdkList');const q=(filter||'').toLowerCase().trim();const src=cmdParse(q).concat(buildCommands());CMD_LIST=q?src.filter(c=>c.label.toLowerCase().includes(q)||c.hint.toLowerCase().includes(q)).slice(0,40):src.filter(c=>c.hint==='View').concat(src.filter(c=>c.hint==='Action')).slice(0,30);if(CMD_ACTIVE>=CMD_LIST.length)CMD_ACTIVE=0;list.innerHTML=CMD_LIST.map((c,i)=>`<div class="cmdk-row" data-i="${i}" style="display:flex;justify-content:space-between;align-items:center;padding:9px 16px;cursor:pointer;background:${i===CMD_ACTIVE?'var(--panel2)':'transparent'};border-left:2px solid ${i===CMD_ACTIVE?'var(--gold)':'transparent'}"><span>${c.label.replace(/</g,'&lt;')}</span><span style="font-size:10px;color:var(--muted2);text-transform:uppercase">${c.hint}</span></div>`).join('')||'<div style="padding:16px;color:var(--muted)">No matches</div>';list.querySelectorAll('.cmdk-row').forEach(r=>{r.onmousedown=(e)=>{e.preventDefault();const c=CMD_LIST[+r.dataset.i];closeCmd();if(c)setTimeout(()=>c.run(),0)};r.onmouseenter=()=>{CMD_ACTIVE=+r.dataset.i;list.querySelectorAll('.cmdk-row').forEach(x=>{const on=+x.dataset.i===CMD_ACTIVE;x.style.background=on?'var(--panel2)':'transparent';x.style.borderLeft='2px solid '+(on?'var(--gold)':'transparent')})}})}
function openCmd(){const m=document.getElementById('cmdk');if(!m)return;m.style.display='block';const inp=document.getElementById('cmdkInput');inp.value='';CMD_ACTIVE=0;renderCmd('');inp.focus()}
function closeCmd(){const m=document.getElementById('cmdk');if(m)m.style.display='none'}
{const inp=document.getElementById('cmdkInput');if(inp){inp.addEventListener('input',()=>{CMD_ACTIVE=0;renderCmd(inp.value)});inp.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();CMD_ACTIVE=Math.min(CMD_LIST.length-1,CMD_ACTIVE+1);renderCmd(inp.value)}else if(e.key==='ArrowUp'){e.preventDefault();CMD_ACTIVE=Math.max(0,CMD_ACTIVE-1);renderCmd(inp.value)}else if(e.key==='Enter'){const c=CMD_LIST[CMD_ACTIVE];closeCmd();if(c)c.run()}else if(e.key==='Escape')closeCmd()})}}
{const b=document.getElementById('cmdkBtn');if(b)b.onclick=openCmd;const m=document.getElementById('cmdk');if(m)m.addEventListener('click',e=>{if(e.target===m)closeCmd()})}

/* ========================= global keyboard shortcuts ========================= */
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&(e.key==='k'||e.key==='K')){e.preventDefault();openCmd();return}
  const ae=document.activeElement;if(ae&&/input|textarea|select/i.test(ae.tagName))return;
  if(!document.getElementById('v-chart').classList.contains('on'))return;
  const tfs=[...document.querySelectorAll('#tfBar button')];
  if(/^[1-9]$/.test(e.key)){const i=+e.key-1;if(tfs[i]){tfs[i].click()}return}
  if(e.key==='\\'){const d=document.getElementById('drawToggle');if(d)d.click();return}
  if(e.key==='r'||e.key==='R'){const b=document.querySelector('#paneCtl button[data-pane="rsi"]');if(b)b.click();return}
  if(e.key==='m'||e.key==='M'){const b=document.querySelector('#paneCtl button[data-pane="macd"]');if(b)b.click();return}
  if(e.key==='i'||e.key==='I'){const b=document.getElementById('indToggle');if(b)b.click();return}
  if((e.ctrlKey||e.metaKey)&&(e.key==='z'||e.key==='Z')){e.preventDefault();e.shiftKey?redoDraw():undoDraw();return}
  if((e.ctrlKey||e.metaKey)&&(e.key==='y'||e.key==='Y')){e.preventDefault();redoDraw();return}
});
{const b=document.getElementById('densBtn');if(b)b.onclick=cycleDensity}
/* ---------- top-bar decluttering: overflow ⋯ menu (moves secondary controls; listeners persist) ---------- */
(function(){try{
  const mb=document.getElementById('moreBtn'),mp=document.getElementById('morePanel');if(!mb||!mp)return;
  const themeRow=document.getElementById('moreTheme'),row2=document.getElementById('moreRow2');
  const ts=document.getElementById('themeSel');if(ts&&themeRow)themeRow.appendChild(ts);
  ['themeBtn','densBtn','fsBtn'].forEach(id=>{const el=document.getElementById(id);if(el&&row2)row2.appendChild(el)});
  mb.onclick=e=>{e.stopPropagation();const r=mb.getBoundingClientRect();mp.style.left=Math.min(r.left,innerWidth-250)+'px';mp.style.top=(r.bottom+6)+'px';mp.style.display=mp.style.display==='block'?'none':'block'};
  document.addEventListener('click',e=>{if(mp.style.display==='block'&&!e.target.closest('#morePanel')&&e.target.id!=='moreBtn')mp.style.display='none'});
  mp.querySelectorAll('.more-item').forEach(it=>it.onclick=()=>{mp.style.display='none';const a=it.dataset.act;if(a==='exportPng')exportPNG();else if(a==='exportCsv')exportCSV();else if(a==='tour')startTour();else if(a==='help')showHelp();else if(a==='selftest'){goView('settings');setTimeout(renderSelfTest,150)}});
}catch(e){}})();
/* ---------- side panel: slide-over on tablets/phones instead of disappearing ---------- */
(function(){try{
  const side=document.getElementById('side');if(!side)return;
  const tg=document.createElement('button');tg.id='sideToggle';tg.title='Analysis panel';tg.textContent='◧';document.body.appendChild(tg);
  tg.onclick=()=>{side.classList.toggle('show')};
  document.addEventListener('click',e=>{if(innerWidth<=1024&&side.classList.contains('show')&&!e.target.closest('#side')&&e.target.id!=='sideToggle')side.classList.remove('show')});
}catch(e){}})();
