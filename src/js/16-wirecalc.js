function wireCalc(){['kBal','kEq','kLev','kRisk','kEntry','kSL','kTP','kLot','kSpread','kComm','kSwap','kNights','kSlip','kMpip','kMcontract','kMdpp'].forEach(id=>{const el=document.getElementById(id);if(el)el.addEventListener('input',calcCompute)});
  document.getElementById('kDir').addEventListener('change',calcCompute);
  // manual current price → seed a sensible entry/SL/TP the user can then fine-tune
  const seedFromPrice=()=>{const p=+document.getElementById('kPrice').value;if(!p)return;const v=document.getElementById('kSym').value;const pip=v==='CUSTOM'?(+document.getElementById('kMpip').value||0.0001):(SPECS[v]?.pip||0.0001);const s=document.getElementById('kDir').value==='Buy'?1:-1;const dec=pip<0.01?4:2;document.getElementById('kEntry').value=p;document.getElementById('kSL').value=+(p*(1-s*0.01)).toFixed(dec);document.getElementById('kTP').value=+(p*(1+s*0.02)).toFixed(dec);calcCompute()};
  document.getElementById('kPrice').addEventListener('input',seedFromPrice);
  document.getElementById('kSym').addEventListener('change',()=>{const v=document.getElementById('kSym').value;document.getElementById('kManual').style.display=(v==='CUSTOM')?'block':'none';const sp=SPECS[v];if(sp){document.getElementById('kPrice').value=sp.px;seedFromPrice()}else{document.getElementById('kPrice').value='';calcCompute()}});}

/* ---------- trading sessions model ---------- */
const SESSIONS=[
  {name:'Sydney',s:22,e:7,col:'#9B8CFF'},
  {name:'Tokyo',s:0,e:9,col:'#4C82FB'},
  {name:'London',s:8,e:17,col:'#E8A33D'},
  {name:'New York',s:13,e:22,col:'#2DBE8E'},
];
const inSession=(h,s)=>s.s<s.e?(h>=s.s&&h<s.e):(h>=s.s||h<s.e);
function utcActivity(h){ // canonical typical volatility by UTC hour (0..1)
  const peaks=[[8,0.85],[9,0.8],[13,1.0],[14,0.98],[15,0.9],[16,0.7],[0,0.55],[1,0.5],[3,0.45],[20,0.4]];
  let v=0.15;peaks.forEach(([ph,pv])=>{v=Math.max(v,pv*Math.exp(-((h-ph)**2)/6))});return Math.min(1,v);
}
function renderSessions(){
  const now=new Date();const utcH=now.getUTCHours();const offMin=-now.getTimezoneOffset();const offH=offMin/60;
  const openNow=SESSIONS.filter(s=>inSession(utcH,s));
  const overlap=inSession(utcH,SESSIONS[2])&&inSession(utcH,SESSIONS[3]);
  const localStr=now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  document.getElementById('sessLive').innerHTML=`<div class="grid2">
    <div class="panelbox"><h4>Right now</h4>
      <div class="verdict"><span class="big" style="color:${overlap?'var(--bull)':'var(--gold)'}">${openNow.length?openNow.map(s=>s.name).join(' + '):'Markets quiet'}</span></div>
      <div class="conf-line">${localStr} local · ${String(utcH).padStart(2,'0')}:00 UTC · your offset UTC${offH>=0?'+':''}${offH}. ${overlap?'<b style="color:var(--bull)">London–New York overlap — the highest-volatility window of the day.</b>':openNow.length?'Active session; expect normal participation.':'Between sessions — thin liquidity, wider spreads, choppy moves.'}</div>
    </div>
    <div class="panelbox"><h4>Best windows to trade</h4><div style="font-size:12px;color:var(--muted);line-height:1.8">
      ▸ <b style="color:var(--gold)">London open</b> — first big volatility burst of the day<br>
      ▸ <b style="color:var(--bull)">London–NY overlap</b> — deepest liquidity, cleanest trends<br>
      ▸ <b style="color:var(--blue)">Tokyo</b> — best for JPY &amp; AUD pairs, quieter ranges<br>
      ▸ Avoid the post-NY / pre-Tokyo lull unless scalping tight ranges</div></div>
  </div>`;
  // heatmap weekday x local hour
  const days=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];const dayMul=[1,1,1,1,0.95,0.35,0.3];
  let hm='<div style="overflow-x:auto"><table class="log" style="border-collapse:separate;border-spacing:2px"><thead><tr><th></th>';
  for(let lh=0;lh<24;lh++)hm+=`<th style="text-align:center;padding:2px;font-size:8.5px">${String(lh).padStart(2,'0')}</th>`;
  hm+='</tr></thead><tbody>';
  days.forEach((dn,di)=>{hm+=`<tr><td style="font-weight:600">${dn}</td>`;for(let lh=0;lh<24;lh++){const uh=((lh-offH)%24+24)%24;const a=utcActivity(uh)*dayMul[di];hm+=`<td title="${dn} ${lh}:00 · activity ${(a*100).toFixed(0)}%" style="width:20px;height:18px;padding:0;border-radius:3px;background:${heat(a)}"></td>`}hm+='</tr>'});
  hm+='</tbody></table></div><div style="font-size:10.5px;color:var(--muted);margin-top:10px">Greener = the market typically moves more. Rows are weekdays; columns are your local hour. Weekends thin out (crypto trades 24/7, FX/stocks closed).</div>';
  document.getElementById('sessHeat').innerHTML=hm;
  // session table
  const toLocal=h=>String(((h+offH)%24+24)%24).padStart(2,'0')+':00';
  document.getElementById('sessTable').innerHTML=`<table class="log"><thead><tr><th>Session</th><th>UTC window</th><th>Your local</th><th>Status</th><th>Character</th></tr></thead><tbody>${SESSIONS.map(s=>{const open=inSession(utcH,s);return `<tr><td><span style="color:${s.col}">●</span> <b>${s.name}</b></td><td class="mono">${String(s.s).padStart(2,'0')}:00–${String(s.e).padStart(2,'0')}:00</td><td class="mono">${toLocal(s.s)}–${toLocal(s.e)}</td><td>${open?'<span class="pill win">open</span>':'<span class="pill loss">closed</span>'}</td><td style="color:var(--muted)">${s.name==='London'?'High volatility, trend origination':s.name==='New York'?'High volatility, news-driven':s.name==='Tokyo'?'Moderate, ranges, JPY focus':'Low, thin liquidity'}</td></tr>`}).join('')}</tbody></table>`;
}

/* ---------- previous day/week & session key levels ---------- */
function keyLevels(d){
  const dayKey=t=>{const x=new Date(t);return x.getUTCFullYear()+'-'+(x.getUTCMonth()+1)+'-'+x.getUTCDate()};
  const weekKey=t=>{const x=new Date(t);const on=new Date(Date.UTC(x.getUTCFullYear(),0,1));return x.getUTCFullYear()+'w'+Math.ceil(((x-on)/86400000+1)/7)};
  const days={},dorder=[],weeks={},worder=[];
  d.forEach((c,i)=>{const dk=dayKey(c.t);if(!days[dk]){days[dk]=[];dorder.push(dk)}days[dk].push(i);const wk=weekKey(c.t);if(!weeks[wk]){weeks[wk]=[];worder.push(wk)}weeks[wk].push(i)});
  const hiOf=ix=>Math.max(...ix.map(i=>d[i].h)),loOf=ix=>Math.min(...ix.map(i=>d[i].l));
  const cur=days[dorder[dorder.length-1]]||[],prev=days[dorder[dorder.length-2]]||[];
  const prevW=weeks[worder[worder.length-2]]||[];const L={};
  if(prev.length){L.pdh=hiOf(prev);L.pdl=loOf(prev);L.pdc=d[prev[prev.length-1]].c}
  if(cur.length){L.cdh=hiOf(cur);L.cdl=loOf(cur);L.dopen=d[cur[0]].o}
  if(prevW.length){L.pwh=hiOf(prevW);L.pwl=loOf(prevW)}
  const sess=(ix,a,b)=>ix.filter(i=>{const h=new Date(d[i].t).getUTCHours();return b>a?(h>=a&&h<b):(h>=a||h<b)});
  const scope=cur.length>3?cur:prev;const asia=sess(scope,0,9),ldn=sess(scope,8,17);
  if(asia.length){L.asiaH=hiOf(asia);L.asiaL=loOf(asia)}
  if(ldn.length){L.ldnH=hiOf(ldn);L.ldnL=loOf(ldn)}
  return L;
}

/* ---------- strategies grouped by trading style (strategies/ registry) ---------- */
const STRATS={
  scalp:[
    ['VWAP Bounce Scalp','M1–M5','seconds–minutes'],
    ['EMA 9/21 Scalp','M1','1–10 min'],
    ['Stochastic Fast Scalp','M1–M3','minutes'],
    ['Order-Block M1 Scalp','M1','minutes'],
    ['London-Open Scalp','M5','first 30 min'],
    ['Bollinger Fade Scalp','M3','minutes'],
    ['Kinetic Flux Scalp','M1–M5','minutes'],
    ['Williams %R Reversal Scalp','M1–M5','minutes'],
    ['ROC Impulse Scalp','M1–M3','minutes'],
  ],
  intraday:[
    ['Opening-Range Breakout','M15','close by EOD'],
    ['VWAP Trend Intraday','M15–H1','hours'],
    ['London Session Breakout','M15','hours'],
    ['PDH/PDL Liquidity Sweep','M15–H1','hours'],
    ['MACD Intraday Momentum','H1','hours'],
    ['FVG Retest Intraday','M15','hours'],
    ['RSI Divergence Reversal','M15–H1','hours'],
    ['Kinetic Flux Momentum','M15','hours'],
    ['ADX Trend-Strength Intraday','H1','hours'],
    ['MFI Money-Flow Intraday','M15–H1','hours'],
  ],
  swing:[
    ['EMA 50/200 Swing','H4–D1','days–weeks'],
    ['Supertrend Swing','H4','days'],
    ['Weekly S/R Swing','D1','days–weeks'],
    ['Double Bottom/Top Swing','H4–D1','days'],
    ['Higher-TF FVG Swing','H4','days'],
    ['Dual-Momentum Rotation','D1','weeks'],
    ['MACD Divergence Swing','H4–D1','days'],
    ['Triple-EMA Ribbon Swing','H4–D1','days–weeks'],
  ],
  mm:[
    ['Avellaneda–Stoikov Market Making','tick–M1','seconds (inventory-aware quoting)'],
    ['Order-Flow Imbalance','tick–M1','seconds'],
    ['Grid Mean-Reversion','M1–M5','minutes'],
    ['Stat-Arb Pairs (cointegration)','M5–H1','hours'],
    ['Basis / Cash-and-Carry','H1–D1','days (funding capture)'],
    ['Gamma Scalping (delta-neutral)','M1','intraday'],
    ['VWAP / TWAP Execution','any','execution algo'],
    ['Liquidity-Provision (rebate)','tick','seconds'],
  ],
  custom:[],
};
let CURSTYLE='scalp';
function styleOf(name){for(const st in STRATS){if((STRATS[st]||[]).some(x=>x[0]===name))return st}const u=USER_STRATS[name];return u?u.style:(CURSTYLE||'scalp')}
function buildStratOptions(){const sel=document.getElementById('stratSel');if(!sel)return;const keep=sel.value;sel.innerHTML='';const groups=[['scalp',' Scalping'],['intraday',' Intraday'],['swing',' Swing'],['mm',' Market Maker'],['custom','★ Custom']];groups.forEach(([style,label])=>{const list=[...(STRATS[style]||[])];Object.values(USER_STRATS).filter(u=>u.style===style).forEach(u=>{if(!list.find(x=>x[0]===u.spec.name))list.push([u.spec.name,u.tf,u.hold])});if(!list.length)return;const og=document.createElement('optgroup');og.label=label;list.forEach(([n])=>{const o=document.createElement('option');o.value=n;o.textContent=n+(USER_STRATS[n]?' ★':'');og.appendChild(o)});sel.appendChild(og)});if(keep){const o=[...sel.options].find(x=>x.value===keep);if(o)sel.value=keep}}
function populateStrats(style){CURSTYLE=style;buildStratOptions();const sel=document.getElementById('stratSel');if(sel){const first=(STRATS[style]||[])[0];const uFirst=Object.values(USER_STRATS).find(u=>u.style===style);const pick=first?first[0]:(uFirst?uFirst.spec.name:'');if(pick)sel.value=pick}const bt=document.getElementById('btStyle');if(bt)bt.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x.dataset.style===style));stratHint();}
function stratHint(){const name=document.getElementById('stratSel').value;let tf='any',hold='per rules';const u=USER_STRATS[name];if(u){tf=u.tf;hold=u.hold}else{const row=(STRATS[CURSTYLE]||[]).find(x=>x[0]===name);if(row){tf=row[1];hold=row[2]}}const mm=CURSTYLE==='mm'?' <span style="color:var(--gold)">— note: true market making needs low-latency infra &amp; exchange rebates retail can\'t access; these model the logic at retail cadence.</span>':'';const folder=u?'strategies/custom/ (yours)':`strategies/${CURSTYLE}/`;document.getElementById('stratHint').innerHTML=`Built for <b style="color:var(--txt)">${tf}</b> · typical hold <b style="color:var(--txt)">${hold}</b> · style: ${CURSTYLE}. Module: <code style="color:var(--gold)">${folder}</code>.${mm}`}

/* ---------- CSV data manager — parses your files in-browser, no upload ---------- */
