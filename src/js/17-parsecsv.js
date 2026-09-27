const CSV_STORE={};let PREFER_CSV=true,REFRESH_MS=2000;
function parseCSV(text){
  const lines=text.trim().split(/\r?\n/).filter(l=>l.trim());if(!lines.length)return[];
  const delim=lines[0].includes('\t')?'\t':(lines[0].includes(';')?';':',');
  const first=lines[0].toLowerCase();const hasHeader=/date|time|open|high|low|close/.test(first);
  let start=0,cols={t:0,o:1,h:2,l:3,c:4,v:5};
  if(!hasHeader){const f0=lines[0].split(delim);const dateLike=Number.isFinite(Date.parse(f0[0]))&&!Number.isFinite(+f0[0]);cols=dateLike?{t:0,o:1,h:2,l:3,c:4,v:5}:{t:-1,o:0,h:1,l:2,c:3,v:4}}
  if(hasHeader){start=1;const hs=lines[0].split(delim).map(h=>h.trim().toLowerCase().replace(/["']/g,''));
    const find=(...names)=>{for(const n of names){const i=hs.findIndex(h=>h===n);if(i>=0)return i}for(const n of names){const i=hs.findIndex(h=>h.includes(n));if(i>=0)return i}return -1};
    cols={t:find('date','time','timestamp'),o:find('open'),h:find('high'),l:find('low'),c:find('close','price','last'),v:find('volume','vol')};}
  const bars=[];
  for(let i=start;i<lines.length;i++){const p=lines[i].split(delim);const o=+p[cols.o],h=+p[cols.h],l=+p[cols.l],c=+p[cols.c];if(![o,h,l,c].every(Number.isFinite))continue;let t=cols.t>=0?Date.parse(p[cols.t]):NaN;if(!Number.isFinite(t))t=Date.now()-(lines.length-i)*3600e3;bars.push({t,o,h,l,c,v:cols.v>=0?(+p[cols.v]||0):0})}
  bars.sort((a,b)=>a.t-b.t);return bars;
}
function renderCsvList(){
  const box=document.getElementById('csvList');const keys=Object.keys(CSV_STORE);
  if(!keys.length){box.innerHTML='<div style="color:var(--muted);font-size:12px">No CSV files loaded yet. Pick a symbol above and choose a file — try one exported from TradingView or your broker.</div>';return}
  box.innerHTML='<table class="log"><thead><tr><th>Symbol</th><th>Bars</th><th>Date range</th><th></th></tr></thead><tbody>'+keys.map(k=>{const b=CSV_STORE[k];const a=new Date(b[0].t).toLocaleDateString(),z=new Date(b[b.length-1].t).toLocaleDateString();return `<tr><td><b>${k}</b> <span class="pill win">loaded</span></td><td class="mono">${b.length}</td><td class="mono" style="color:var(--muted)">${a} → ${z}</td><td><button class="tbtn" data-rm="${k}" style="padding:3px 9px">remove</button></td></tr>`}).join('')+'</tbody></table>';
  box.querySelectorAll('[data-rm]').forEach(btn=>btn.onclick=()=>{const k=btn.dataset.rm;delete CSV_STORE[k];renderCsvList();if(CURSYM.sym===k)loadSymbol()});
}
function wireSettings(){
  const csvSym=document.getElementById('csvSym');
  Object.entries(SPECS).forEach(([k,s])=>{const o=document.createElement('option');o.value=k;o.textContent=`${s.name} (${k})`;csvSym.appendChild(o)});
  document.getElementById('csvFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const sym=csvSym.value;const rd=new FileReader();rd.onload=()=>{try{const bars=parseCSV(rd.result);if(bars.length<5){alert('Could not read enough rows. The file needs open/high/low/close columns.');return}CSV_STORE[sym]=bars;renderCsvList();if(CURSYM.sym===sym)loadSymbol()}catch(err){alert('Parse error: '+err.message)}};rd.readAsText(f);e.target.value=''});
  document.getElementById('setPreferCsv').addEventListener('change',e=>{PREFER_CSV=e.target.value==='1';loadSymbol()});
  document.getElementById('setRefresh').addEventListener('input',e=>{REFRESH_MS=Math.max(300,(+e.target.value||2)*1000);if(MODE==='online')startLive()});
  // API key + provider
  document.getElementById('dsKey').addEventListener('input',e=>{API_KEY=e.target.value.trim()});
  document.getElementById('dsFxProv').addEventListener('change',e=>{FX_PROVIDER=e.target.value});
  {const pu=document.getElementById('dsProxyUrl');if(pu)pu.addEventListener('input',e=>{PROXY_URL=e.target.value.trim()});}
  {const pp=document.getElementById('dsProxyProv');if(pp)pp.addEventListener('change',e=>{PROXY_PROVIDER=e.target.value});}
  {const cp=document.getElementById('dsCryptoProv');if(cp)cp.addEventListener('change',e=>{CRYPTO_PROVIDER=e.target.value});}
  {const cu=document.getElementById('dsCryptoUp');if(cu)cu.addEventListener('change',e=>{CRYPTO_UPSTREAM=e.target.value});}
  // strategy upload
  document.getElementById('stratFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{try{const spec=/\.py$/i.test(f.name)?parsePyStrategy(rd.result):JSON.parse(rd.result);addUserStrat(spec);toast('★ Strategy added: '+spec.name,var_bull());const b=document.getElementById('btStyle');if(b){b.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.style==='custom'))}populateStrats('custom');document.getElementById('stratSel').value=spec.name;stratHint()}catch(err){alert('Could not read strategy: '+err.message)}};rd.readAsText(f);e.target.value=''});
  const dl=(txt,name,mime)=>{const bl=new Blob([txt],{type:mime});const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download=name;a.click()};
  document.getElementById('stratPyExample').onclick=()=>dl(PY_EXAMPLE,'ddt_strategy_example.py','text/plain');
  document.getElementById('stratGuideBtn').onclick=()=>{const g=document.getElementById('stratGuide');if(g.style.display==='none'){g.innerHTML=STRAT_GUIDE;g.style.display='block'}else g.style.display='none'};
  document.getElementById('stratPrompt').onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(AI_PROMPT).then(()=>toast('AI prompt copied — paste it into any chatbot',var_bull()),()=>{});};
  document.getElementById('stratExample').onclick=()=>{const blob=new Blob([JSON.stringify(EXAMPLE_SPEC,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ddt_strategy_example.json';a.click()};
  // deep-learning model manager
  document.getElementById('modelFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>{try{const m=JSON.parse(rd.result);if(m.type==='mlp'){if(!m.layers||!m.layers[0]||!m.layers[0].W)throw new Error('mlp needs layers[].W');}else if(m.type==='weights'){Object.assign(CATW,m.category||m.weights||{})}else throw new Error('type must be "mlp" or "weights"');MODEL=m;renderModelInfo();toast('✓ Model loaded — now in the confluence',var_bull());recompute()}catch(err){alert('Invalid model: '+err.message)}};rd.readAsText(f);e.target.value=''});
  document.getElementById('modelExample').onclick=()=>{const blob=new Blob([JSON.stringify(EXAMPLE_MODEL,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ddt_model_example.json';a.click()};
  renderModelInfo();
  // workspace
  document.getElementById('wsExport').onclick=exportWorkspace;
  document.getElementById('wsFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();rd.onload=()=>importWorkspace(rd.result);rd.readAsText(f);e.target.value=''});
  // risk defaults
  document.getElementById('setMaxDL').addEventListener('input',e=>{PAPER.maxDayLoss=+e.target.value||3});
  document.getElementById('setDefRisk').addEventListener('input',e=>{const v=+e.target.value||1;const pr=document.getElementById('pRisk');if(pr)pr.value=v;const cr=document.getElementById('cRisk');if(cr){cr.value=v;sizer()}});
  renderCsvList();renderUserStrats();
}

/* ---------- tiny toast ---------- */
let _toastT=null;
function toast(msg,col){let el=document.getElementById('_toast');if(!el){el=document.createElement('div');el.id='_toast';el.style.cssText='position:fixed;bottom:44px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--edge2);color:var(--txt);padding:9px 16px;border-radius:9px;font-size:12px;z-index:80;box-shadow:0 6px 24px rgba(0,0,0,.35)';document.body.appendChild(el)}el.textContent=msg;el.style.borderColor=col||'var(--edge2)';el.style.opacity='1';clearTimeout(_toastT);_toastT=setTimeout(()=>el.style.opacity='0',2200)}

/* ---------- paper trading account ---------- */
const PAPER={bal:10000,start:10000,pos:[],hist:[],dayRealized:0,lossStreak:0,locked:false,seq:1,maxDayLoss:3,leverage:100,guard:(function(){try{return localStorage.getItem('mishel_guard')==='1'}catch(e){return false}})()};
function curPrice(){return DATA.length?DATA[DATA.length-1].c:(CURSYM.px||0)}
function liqPrice(entry,side,lev,mmr=0.005){return side>0?entry*(1-1/lev+mmr):entry*(1+1/lev-mmr)}
{/* v39.1 F2: was pLev - COLLIDED with the paper-desk select. getElementById bound the first (paper) element, so THIS settings control was dead and its liqHint never painted. */const lv=document.getElementById('pLevQ');if(lv)lv.onchange=()=>{PAPER.leverage=+lv.value||100;var _p=document.getElementById('pLev');if(_p)_p.value=lv.value;const h=document.getElementById('liqHint');if(h&&isFut(CURSYM.sym)){const px=curPrice();h.textContent='~liq long '+fmt(liqPrice(px,1,PAPER.leverage))+' / short '+fmt(liqPrice(px,-1,PAPER.leverage))}else if(h)h.textContent='';toast('Demo leverage 1:'+PAPER.leverage)}}
function paperOpen(side){
  if(PAPER.locked){toast('LOCKED Trading locked by daily guardrail',var_bear());return}
  const px=curPrice(),sym=CURSYM.sym;let qty=+document.getElementById('pQty').value||0;
  const sl=+document.getElementById('pSL').value||0,tp=+document.getElementById('pTP').value||0,riskPct=+document.getElementById('pRisk').value||0;
  if(sl>0&&riskPct>0){const per=Math.abs(px-sl);if(per>0)qty=(PAPER.bal*riskPct/100)/per}
  if(qty<=0)qty=1;
  PAPER.pos.push({id:PAPER.seq++,sym,side,qty,entry:px,sl:sl||null,tp:tp||null,opened:Date.now()});memLog('trade',{action:'open',sym,side:side>0?'long':'short',entry:px});
  toast(`${side>0?'▲ Bought':'▼ Sold'} ${qty.toFixed(qty<10?3:1)} ${sym} @ ${fmt(px)}`,side>0?var_bull():var_bear());
  renderPaper();renderQuick();
}
function paperClose(id,reason='manual'){
  const i=PAPER.pos.findIndex(p=>p.id===id);if(i<0)return;const p=PAPER.pos[i],px=curPrice();
  const pl=(px-p.entry)*p.side*p.qty;PAPER.bal+=pl;PAPER.dayRealized+=pl;
  PAPER.lossStreak=pl>=0?0:PAPER.lossStreak+1;
  PAPER.hist.unshift({...p,exit:px,pl,reason,closed:Date.now(),win:pl>=0});memLog('trade',{action:'close',sym:p.sym,pl:+pl.toFixed(2),reason});
  PAPER.pos.splice(i,1);checkGuard();renderPaper();renderQuick();
}
function closeAll(){[...PAPER.pos].forEach(p=>paperClose(p.id,'flat'))}
function markTo(){const px=curPrice();[...PAPER.pos].forEach(p=>{if(p.sl&&((p.side>0&&px<=p.sl)||(p.side<0&&px>=p.sl)))paperClose(p.id,'SL');else if(p.tp&&((p.side>0&&px>=p.tp)||(p.side<0&&px<=p.tp)))paperClose(p.id,'TP')})}
function unrealized(){const px=curPrice();return PAPER.pos.reduce((s,p)=>s+(px-p.entry)*p.side*p.qty,0)}
function usedMargin(){return PAPER.pos.reduce((s,p)=>s+(p.qty*p.entry)/(PAPER.leverage||1),0)}
function freeMargin(){return (PAPER.bal+unrealized())-usedMargin()}
function marginLevel(){const m=usedMargin();return m>0?(PAPER.bal+unrealized())/m*100:0}
function updateAcct(){const b=document.getElementById('acctBal'),e=document.getElementById('acctEq');if(b)b.textContent='$'+PAPER.bal.toFixed(0);if(e){const eq=PAPER.bal+unrealized();e.textContent='$'+eq.toFixed(0);e.className='mono '+(eq>=PAPER.start?'up':'dn')}}
function renderJournalStats(){
  const el=document.getElementById('journalStats');if(!el)return;
  const h=PAPER.hist;
  if(!h.length){el.innerHTML='<div style="color:var(--muted);font-size:12px">Close some demo trades — expectancy, payoff, win rate, and average R appear here so you can see whether you actually have an edge.</div>';return}
  const n=h.length,wins=h.filter(t=>t.pl>0),losses=h.filter(t=>t.pl<=0);
  const gp=wins.reduce((a,t)=>a+t.pl,0),gl=-losses.reduce((a,t)=>a+t.pl,0);
  const wr=wins.length/n*100,expc=(gp-gl)/n,avgW=wins.length?gp/wins.length:0,avgL=losses.length?gl/losses.length:0;
  const pf=gl>0?gp/gl:(gp>0?Infinity:0),payoff=avgL>0?avgW/avgL:0;
  const rOf=t=>{const risk=Math.abs(t.entry-(t.sl!=null?t.sl:t.entry))*(t.qty||1);return risk>0?t.pl/risk:null};
  const Rs=h.map(rOf).filter(v=>v!=null),avgR=Rs.length?Rs.reduce((a,b)=>a+b,0)/Rs.length:null;
  const stat=(k,v,cc)=>`<div class="stat"><div class="k">${k}</div><div class="v ${cc||''}">${v}</div></div>`;
  const bySide=s=>{const g=h.filter(t=>t.side===s);if(!g.length)return '—';const w=g.filter(t=>t.pl>0).length,avg=g.reduce((a,t)=>a+t.pl,0)/g.length;return `${(w/g.length*100).toFixed(0)}% · ${avg>=0?'+':'-'}$${Math.abs(avg).toFixed(0)}/t`};
  const syms={};h.forEach(t=>{syms[t.sym]=(syms[t.sym]||0)+t.pl});
  const symRows=Object.entries(syms).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([s,pl])=>`<div style="display:flex;justify-content:space-between;padding:2px 0"><span>${s}</span><span class="mono ${pl>=0?'up':'dn'}">${pl>=0?'+':'-'}$${Math.abs(pl).toFixed(0)}</span></div>`).join('');
  el.innerHTML=`<div class="stat-grid" style="margin-bottom:10px">${[
    stat('Expectancy',(expc>=0?'+$':'-$')+Math.abs(expc).toFixed(2)+'/t',expc>=0?'up':'dn'),
    stat('Win rate',wr.toFixed(0)+'%',wr>=50?'up':''),
    stat('Profit factor',isFinite(pf)?pf.toFixed(2):'∞',pf>=1?'up':'dn'),
    stat('Payoff (W/L)',payoff.toFixed(2),payoff>=1?'up':''),
    stat('Avg win','$'+avgW.toFixed(0),'up'),stat('Avg loss','-$'+avgL.toFixed(0),'dn'),
    stat('Avg R',avgR!=null?(avgR>=0?'+':'')+avgR.toFixed(2)+'R':'—',avgR>=0?'up':'dn'),
    stat('Trades',String(n),null)
  ].join('')}</div>
  <div class="grid2" style="gap:10px">
    <div><div style="font-size:10px;color:var(--muted2);margin-bottom:3px">BY SIDE</div><div style="font-size:11px"><div style="display:flex;justify-content:space-between;padding:2px 0"><span class="up">Long</span><span class="mono">${bySide(1)}</span></div><div style="display:flex;justify-content:space-between;padding:2px 0"><span class="dn">Short</span><span class="mono">${bySide(-1)}</span></div></div></div>
    <div><div style="font-size:10px;color:var(--muted2);margin-bottom:3px">P/L BY SYMBOL</div><div style="font-size:11px">${symRows||'—'}</div></div>
  </div>
  <div style="font-size:10px;color:var(--muted2);margin-top:8px">Expectancy = average $ per trade — the number that compounds. Positive expectancy over enough trades is a real edge; a high win rate with a payoff below 1 often isn't.</div>`;
}
function checkGuard(){if(!PAPER.guard)return;const dayPct=PAPER.dayRealized/PAPER.start*100;if(dayPct<=-PAPER.maxDayLoss||PAPER.lossStreak>=3){if(!PAPER.locked){PAPER.locked=true;toast('LOCKED Daily guardrail hit — trading locked',var_bear())}}}
function renderPaper(){
  const eq=PAPER.bal+unrealized();const dayPct=PAPER.dayRealized/PAPER.start*100;
  const wins=PAPER.hist.filter(h=>h.win).length,wr=PAPER.hist.length?wins/PAPER.hist.length*100:0;
  const box=(k,v,c)=>`<div class="stat"><div class="k">${k}</div><div class="v mono ${c||''}">${v}</div></div>`;
  const ps=document.getElementById('paperStats');if(ps)ps.innerHTML=[
    box('Balance','$'+PAPER.bal.toFixed(2)),box('Equity','$'+eq.toFixed(2),eq>=PAPER.start?'up':'dn'),
    box('Margin','$'+usedMargin().toFixed(2)),box('Free margin','$'+freeMargin().toFixed(2),freeMargin()>=0?'up':'dn'),
    box('Margin level',marginLevel()?marginLevel().toFixed(0)+'%':'—',(marginLevel()===0||marginLevel()>=200)?'up':marginLevel()<100?'dn':''),
    box('Open P/L',(unrealized()>=0?'+$':'-$')+Math.abs(unrealized()).toFixed(2),unrealized()>=0?'up':'dn'),
    box('Leverage','1:'+PAPER.leverage),box('Day P/L',(dayPct>=0?'+':'')+dayPct.toFixed(2)+'%',dayPct>=0?'up':'dn'),
    box('Win rate',wr.toFixed(0)+'%',wr>=50?'up':'')
  ].join('');
  updateAcct();
  document.getElementById('ticketSym').innerHTML=`<b style="color:var(--txt)">${CURSYM.sym}</b> @ <span class="${''}">${fmt(curPrice())}</span>`;
  const px=curPrice();
  const op=document.getElementById('openPos');
  if(op)op.innerHTML=PAPER.pos.length?`<table class="log"><thead><tr><th>#</th><th>Sym</th><th>Side</th><th>Qty</th><th>Entry</th><th>Now</th><th>P/L</th><th></th></tr></thead><tbody>${PAPER.pos.map(p=>{const pl=(px-p.entry)*p.side*p.qty;return `<tr><td>${p.id}</td><td>${p.sym}</td><td class="${p.side>0?'up':'dn'}">${p.side>0?'Long':'Short'}</td><td class="mono">${p.qty.toFixed(p.qty<10?3:1)}</td><td class="mono">${fmt(p.entry)}</td><td class="mono">${fmt(px)}</td><td class="mono ${pl>=0?'up':'dn'}">${pl>=0?'+':''}$${pl.toFixed(2)}</td><td><button class="tbtn" data-close="${p.id}" style="padding:2px 8px">close</button></td></tr>`}).join('')}</tbody></table>`:'<div style="color:var(--muted);font-size:12px">No open positions. Use the ticket to buy or sell.</div>';
  if(op)op.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>paperClose(+b.dataset.close));
  const jn=document.getElementById('journal');
  renderJournalStats();
  if(jn)jn.innerHTML=PAPER.hist.length?`<table class="log"><thead><tr><th>Sym</th><th>Side</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Exit by</th></tr></thead><tbody>${PAPER.hist.slice(0,20).map(h=>`<tr><td>${h.sym}</td><td class="${h.side>0?'up':'dn'}">${h.side>0?'L':'S'}</td><td class="mono">${fmt(h.entry)}</td><td class="mono">${fmt(h.exit)}</td><td class="mono ${h.pl>=0?'up':'dn'}">${h.pl>=0?'+':''}$${h.pl.toFixed(2)}</td><td><span class="pill ${h.win?'win':'loss'}">${h.reason}</span></td></tr>`).join('')}</tbody></table>`:'<div style="color:var(--muted);font-size:12px">Closed trades will appear here as your journal.</div>';
  const gb=document.getElementById('guardBox');
  if(gb){const tgl=`<button class="tbtn" id="gToggle" style="padding:3px 9px">${PAPER.guard?'Disable':'Enable'} guardrail</button>`;
    gb.innerHTML=(PAPER.guard&&PAPER.locked)?`<div style="background:var(--bear-dim);border:1px solid var(--bear);border-radius:8px;padding:9px;font-size:11px;color:var(--bear)">LOCKED Locked — hit ${PAPER.maxDayLoss}% daily loss or 3 losses in a row. <button class="tbtn" id="gReset" style="margin-top:6px;padding:3px 9px">Reset day</button> ${tgl}</div>`
    :PAPER.guard?`<div style="font-size:10.5px;color:var(--muted)">Guardrail armed: locks at −${PAPER.maxDayLoss}% day loss or 3 straight losses. ${tgl}</div>`
    :`<div style="font-size:10.5px;color:var(--muted)">Guardrail <b style="color:var(--txt)">off</b> — demo trades are never blocked by a daily loss cap. ${tgl}</div>`;
    const gr=document.getElementById('gReset');if(gr)gr.onclick=()=>{PAPER.locked=false;PAPER.dayRealized=0;PAPER.lossStreak=0;renderPaper()};
    const gt=document.getElementById('gToggle');if(gt)gt.onclick=()=>{PAPER.guard=!PAPER.guard;try{STORE.set('mishel_guard',PAPER.guard?'1':'0')}catch(e){}if(!PAPER.guard)PAPER.locked=false;toast('Daily guardrail '+(PAPER.guard?'enabled':'disabled'),PAPER.guard?var_bull():var_bear());renderPaper()};
  }
}

/* v39.24: persist the API key so it auto-loads every session (Save / Remove). */
(function(){ var K='mishel_apikey';
  function stat(m){var s=document.getElementById('dsKeyStat');if(s)s.textContent=m;}
  document.addEventListener('DOMContentLoaded',function(){ try{
    var saved=null;try{saved=localStorage.getItem(K)}catch(e){}
    if(saved){ API_KEY=saved; var i=document.getElementById('dsKey'); if(i)i.value=saved; stat('\u2713 key loaded from this browser — Online metals/forex will use it'); }
    var sv=document.getElementById('dsKeySave');
    if(sv)sv.onclick=function(){ var v=((document.getElementById('dsKey')||{}).value||'').trim(); if(!v){stat('paste a key first');return;} API_KEY=v; try{localStorage.setItem(K,v)}catch(e){} stat('\u2713 saved \u2014 auto-loads every session'); if(typeof toast==='function')toast('API key saved',(typeof var_bull==='function'?var_bull():'var(--bull)')); if(typeof MODE!=='undefined'&&MODE==='online'&&typeof setMode==='function')try{setMode('online')}catch(e){} };
    var cl=document.getElementById('dsKeyClear');
    if(cl)cl.onclick=function(){ API_KEY=''; var i=document.getElementById('dsKey'); if(i)i.value=''; try{localStorage.removeItem(K)}catch(e){} stat('key removed'); if(typeof toast==='function')toast('API key removed'); };
  }catch(e){} });
})();
