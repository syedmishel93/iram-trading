let _speaking=false;
function speakLast(){try{
  const last=[...AI_LOG].reverse().find(m=>m.role==='ai');if(!last){toast('Nothing to read yet');return}
  if(!('speechSynthesis' in window)){toast('Speech not supported in this browser',var_bear());return}
  if(_speaking){speechSynthesis.cancel();_speaking=false;const b=document.getElementById('aiSpeak');if(b)b.classList.remove('gold');return}
  const plain=last.text.replace(/\*\*|__|_/g,'').replace(/[▲▼·✓✗▲▼⌫·]/g,'').replace(/\n+/g,'. ');
  const u=new SpeechSynthesisUtterance(plain.slice(0,1400));u.rate=1.04;u.pitch=1;
  u.onend=()=>{_speaking=false;const b=document.getElementById('aiSpeak');if(b)b.classList.remove('gold')};
  _speaking=true;const b=document.getElementById('aiSpeak');if(b)b.classList.add('gold');speechSynthesis.cancel();speechSynthesis.speak(u);
}catch(e){toast('Voice error: '+e.message,var_bear())}}
function startMic(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){toast('Voice input needs Chrome/Edge (Web Speech API)',var_bear());return}
  try{const rec=new SR();rec.lang='en-US';rec.interimResults=false;rec.maxAlternatives=1;
    const mb=document.getElementById('aiMic');if(mb)mb.classList.add('gold');
    rec.onresult=e=>{const q=e.results[0][0].transcript;const inp=document.getElementById('aiInput');if(inp)inp.value=q;askAnalyst(q);};
    rec.onerror=e=>toast('Mic: '+e.error,var_bear());
    rec.onend=()=>{if(mb)mb.classList.remove('gold')};
    rec.start();toast('Listening… speak now');
  }catch(e){toast('Mic error: '+e.message,var_bear())}
}
{const b=document.getElementById('aiSpeak');if(b)b.onclick=speakLast}
{const b=document.getElementById('aiClear');if(b)b.onclick=()=>{AI_LOG=[];AI_MSGS=[];renderAiChat();toast('Conversation cleared')}}
{const b=document.getElementById('aiMic');if(b)b.onclick=startMic}
{const b=document.getElementById('dsExtTest');if(b)b.onclick=async()=>{const r=document.getElementById('dsExtResult');const url=((document.getElementById('dsNewsUrl')||{}).value||(document.getElementById('dsCalUrl')||{}).value||(document.getElementById('dsFlowUrl')||{}).value||'').trim();if(!url){r.textContent='Paste a URL in one of the fields first.';return}if(!proxyBase()){r.innerHTML='<span style="color:var(--gold)">Set the proxy URL in ② and run the server — the proxy fetches these to avoid CORS.</span>';return}r.textContent='fetching…';try{const res=await fetch(proxyBase()+'/fetch?url='+encodeURIComponent(url));const txt=await res.text();r.innerHTML=`<span style="color:${res.ok?'var(--bull)':'var(--bear)'}">${res.ok?'✓':'✗'} ${res.status} — ${txt.length} bytes.</span> <span class="mono" style="color:var(--muted2)">${txt.slice(0,140).replace(/</g,'&lt;')}…</span>`}catch(e){r.innerHTML='<span style="color:var(--bear)">✗ '+e.message+' (is the proxy running?)</span>'}}}
function renderAnalytics(){
  const el=document.getElementById('mmAnalytics');if(!el||!DATA.length)return;
  const n=DATA.length-1,c=DATA.map(x=>x.c),price=c[n];
  const rsi=IND._rsi[n]||50,adx=(IND.adx(DATA)[n]||20),atr=(IND.atr(DATA)[n]||0);
  const e50=IND._e50[n],e200=IND._e200[n],trend=e50>e200?'Up':'Down';
  const vwap=IND._vwap?IND._vwap.vw[n]:null,L=IND._levels||{};
  let reg={regime:'—'};try{reg=classifyRegime(DATA)}catch(e){}
  const con=IND._consensus||consensusSignal(DATA);
  const col=con.score>8?'var(--bull)':con.score<-8?'var(--bear)':'var(--muted)';
  const bar=v=>{const pct=Math.max(0,Math.min(100,(v+1)/2*100));const cc=v>0.05?'var(--bull)':v<-0.05?'var(--bear)':'var(--muted)';return `<div style="height:5px;background:var(--edge);border-radius:3px;overflow:hidden;margin-top:2px"><div style="height:100%;width:${pct}%;background:${cc}"></div></div>`};
  const ck=(()=>{try{return tradeChecklist(analystContext())}catch(e){return {passed:0,total:5}}})();
  const row=(k,v,cc)=>`<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--edge)"><span style="color:var(--muted)">${k}</span><span class="mono ${cc||''}">${v}</span></div>`;
  el.innerHTML=`
    <div style="text-align:center;padding:6px 0 10px;border-bottom:1px solid var(--edge);margin-bottom:8px">
      <div style="font-size:26px;font-weight:800;color:${col};line-height:1">${con.score>=0?'+':''}${con.score}</div>
      <div style="font-size:13px;font-weight:700;color:${col}">${con.label}</div>
      <div style="font-size:10px;color:var(--muted2);margin-top:2px">${con.confidence}% agreement · ${con.votes.length} indicators · ${con.bull}▲ ${con.bear}▼</div>
      ${CON_HIST.pts.length>2?(()=>{const pts=CON_HIST.pts.slice(-60);const w=170,h=22;const path=pts.map((p,i)=>`${i?'L':'M'}${(i/(pts.length-1)*w).toFixed(1)},${(h/2-(p.s/100)*(h/2-1)).toFixed(1)}`).join('');return `<svg width="${w}" height="${h}" style="margin-top:6px;opacity:.9"><line x1="0" y1="${h/2}" x2="${w}" y2="${h/2}" stroke="var(--edge)" stroke-dasharray="2,3"/><path d="${path}" fill="none" stroke="${col}" stroke-width="1.5"/></svg><div style="font-size:9px;color:var(--muted2)">consensus momentum (last ${pts.length} bars)</div>`})():''}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 12px;margin-bottom:10px;font-size:10px;color:var(--muted2)">
      <div>TREND ${bar(con.byCat.trend)}</div><div>MOMENTUM ${bar(con.byCat.momentum)}</div>
      <div>VOLATILITY ${bar(con.byCat.volatility)}</div><div>VOLUME ${bar(con.byCat.volume)}</div>
    </div>
    <div style="font-size:11px;padding:6px 8px;border-radius:7px;background:var(--panel2);margin-bottom:10px;border:1px solid var(--edge)">
      <span style="color:var(--muted)">Objectivity checklist</span> <span class="mono" style="color:${ck.passed>=4?'var(--bull)':ck.passed>=3?'var(--gold)':'var(--bear)'};font-weight:700;float:right">${ck.passed}/${ck.total} ✓</span>
    </div>
    ${row('Trend (50/200)',trend,trend==='Up'?'up':'dn')}
    ${row('Trend strength',adx.toFixed(0)+' ADX'+(adx>25?' · strong':adx>20?' · building':' · weak'),adx>25?'up':'')}
    ${row('Volatility',(atr/price*100).toFixed(2)+'% ATR')}
    ${row('Regime',reg.regime)}
    ${row('RSI(14)',rsi.toFixed(0),rsi>70?'dn':rsi<30?'up':'')}
    ${vwap!=null?row('vs VWAP',((price-vwap)/vwap*100>=0?'+':'')+((price-vwap)/vwap*100).toFixed(2)+'%',price>=vwap?'up':'dn'):''}
    ${L.pdh?row('vs PDH',((price-L.pdh)/L.pdh*100).toFixed(2)+'%',price>=L.pdh?'up':'dn'):''}
    ${L.pdl?row('vs PDL',((price-L.pdl)/L.pdl*100).toFixed(2)+'%',price>=L.pdl?'up':'dn'):''}`;
}

/* ---------- live strategy signal (glass-box: evaluates the selected strategy on the latest bar) ---------- */
function liveSignal(){
  if(!document.getElementById('v-chart').classList.contains('on'))return null;
  const sel=document.getElementById('stratSel');const name=sel&&sel.value;
  if(!name||!DATA||DATA.length<210)return null;
  let spec;try{spec=specFor(name,CURSTYLE)}catch(e){return null}
  let arr;try{arr=indicatorsFor(DATA)}catch(e){return null}
  const i=DATA.length-1;
  if(_group(spec.long,arr,i))return{side:'BUY',reason:ruleText(spec.long),name};
  if(spec.short&&_group(spec.short,arr,i))return{side:'SELL',reason:ruleText(spec.short),name};
  return{side:'FLAT',reason:'No entry trigger on the current bar',name};
}
function renderStratSignal(){
  const el=document.getElementById('stratSignal');if(!el)return;
  const s=liveSignal();
  if(!s){el.innerHTML='<span style="color:var(--muted)">Pick a strategy in the Strategy Tester to see its live buy/sell signal here.</span>';return}
  const col=s.side==='BUY'?'var(--bull)':s.side==='SELL'?'var(--bear)':'var(--muted2)';
  const arrow=s.side==='BUY'?'▲':s.side==='SELL'?'▼':'■';
  el.innerHTML=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="font-weight:800;font-size:15px;color:${col}">${arrow} ${s.side}</span><span class="mono" style="font-size:11px;color:var(--muted);margin-left:auto">${s.name}</span></div><div style="font-size:11px;color:var(--muted);line-height:1.5">${s.side==='FLAT'?s.reason:'Trigger — '+s.reason}</div><div style="font-size:10px;color:var(--muted2);margin-top:5px">@ ${fmt(curPrice())} · evaluated against the strategy's own rules on the latest bar</div>`;
}

/* ---------- confluence UI ---------- */
function renderConfluence(rep){
  const cls=rep.label.includes('Buy')?'up':rep.label.includes('Sell')?'dn':'';
  document.getElementById('vLabel').innerHTML=`<span class="${cls}">${rep.label}</span>`;
  document.getElementById('vScore').textContent=`${rep.score>=0?'+':''}${rep.score.toFixed(2)}`;
  document.getElementById('needle').style.left=`${(rep.score+1)/2*100}%`;
  document.getElementById('confSummary').innerHTML=summarize(rep);
  document.getElementById('agreeLine').innerHTML=`<span class="a">▲ ${rep.agree.length} agree</span><span class="c">▼ ${rep.conflict.length} conflict</span><span style="color:var(--muted)">agreement ${(rep.conf*100).toFixed(0)}%</span>`;
  const _AM={'RSI(14)':'RSI','MACD hist':'MACD','EMA 50/200':'EMA 50/200','Price vs EMA200':'Price vs EMA200','Supertrend':'Supertrend','Kinetic Flux':'Kinetic Flux','Bollinger %B':'Bollinger'};
  const rows=[...rep.S].sort((a,b)=>Math.abs(b._c)-Math.abs(a._c)).map(s=>{
    const k=s.dv>0?'b':s.dv<0?'s':'n';const dl=s.dirLabel.replace('_',' ');
    const _ac=(IND._acc&&_AM[s.source]&&IND._acc[_AM[s.source]]!=null)?IND._acc[_AM[s.source]]:null;
    const _acch=_ac!=null?`<span class="acc-chip ${_ac>=0.55?'g':_ac<0.45?'r':''}" title="Measured directional hit-rate of this signal on this symbol & timeframe (last ~260 bars)">${(_ac*100).toFixed(0)}%</span>`:'';
    return `<div class="row ${k}"><div class="bar"></div><div><div class="src">${s.source} <span class="cat">${s.category}</span>${_acch}</div><div class="rsn">${s.reason}</div></div><div class="vote">${s._c>=0?'+':''}${s._c.toFixed(2)}<small>${dl}</small></div></div>`}).join('');
  document.getElementById('confRows').innerHTML=rows;
  const full=document.getElementById('confRowsFull');if(full)full.innerHTML=rows;
  const big=document.getElementById('confBig');
  if(big)big.innerHTML=`<div class="verdict"><span class="big ${cls}">${rep.label}</span><span class="score mono">score ${rep.score.toFixed(2)} · agreement ${(rep.conf*100).toFixed(0)}%</span></div><div class="meter"><div class="needle" style="left:${(rep.score+1)/2*100}%"></div></div><div class="meter-scale"><span>Strong Sell</span><span>Neutral</span><span>Strong Buy</span></div><div class="conf-line">${summarize(rep)}</div>`;
  renderWeights();
}
function summarize(rep){const side=rep.score>0?'bullish':rep.score<0?'bearish':'balanced';const top=[...rep.S].sort((a,b)=>Math.abs(b._c)-Math.abs(a._c)).slice(0,3).map(s=>s.source).join(', ');let cf='';if(rep.conflict.length){const c=rep.conflict.sort((a,b)=>Math.abs(b._c)-Math.abs(a._c))[0];cf=` Main counter-argument — <b>${c.source}</b>: ${c.reason}`;}return `Reads <b>${rep.label}</b> (${side}). Chief drivers: <b>${top}</b>.${cf}`}
function renderWeights(){const box=document.getElementById('weights');if(!box)return;box.innerHTML=Object.keys(CATW).map(k=>`<div class="wt"><label>${k}</label><input type="range" min="0" max="2" step="0.1" value="${CATW[k]}" data-cat="${k}"><span class="v">${CATW[k].toFixed(1)}</span></div>`).join('');box.querySelectorAll('input').forEach(inp=>inp.oninput=e=>{CATW[e.target.dataset.cat]=+e.target.value;e.target.nextElementSibling.textContent=(+e.target.value).toFixed(1);const b=buildSignals(DATA);renderConfluence(confluence(b.S))})}

function mtfMatrix(){
  const tfs=['15m','1H','4H','1D'];const cols=[];
  tfs.forEach((t,i)=>{const seed=1000+i*7;const dd=genData(300,DATA[DATA.length-1].c,seed);const b=buildSignals(dd);const r=confluence(b.S);cols.push({tf:t,con:r})});
  const cats=[['trend','Trend'],['momentum','Momentum'],['smc','Smart Money'],['oscillator','Oscillators'],['volume','Volume'],['volatility','Volatility'],['divergence','Divergence'],['flux','Flux']]
    .filter(c=>cols.some(x=>x.con.byCat[c[0]]!=null));
  const agree=(()=>{const sg=cols.map(c=>Math.sign(c.con.score)).filter(v=>v!==0);if(!sg.length)return 0;const pos=sg.filter(v=>v>0).length;return Math.round(Math.max(pos,sg.length-pos)/cols.length*100)})();
  return {cols,cats,agree};
}
function mtfCell(v){if(v==null)return '<td class="mx n">·</td>';const cls=v>0?'u':v<0?'d':'n';const ch=v>0?'▲':v<0?'▼':'—';return `<td class="mx ${cls}">${ch}</td>`}
function mtfTableHTML(m,compact){
  const head='<tr><th></th>'+m.cols.map(c=>`<th>${c.tf}</th>`).join('')+'</tr>';
  const verdict='<tr class="vr"><th>Verdict</th>'+m.cols.map(c=>{const cls=c.con.score>0.15?'u':c.con.score<-0.15?'d':'n';return `<td class="mx ${cls}">${compact?(c.con.label.replace('Strong ','S.')):c.con.label}</td>`}).join('')+'</tr>';
  const rows=m.cats.map(cat=>'<tr><th>'+cat[1]+'</th>'+m.cols.map(c=>mtfCell(c.con.byCat[cat[0]])).join('')+'</tr>').join('');
  return `<table class="mtfgrid${compact?' sm':''}">${head}${rows}${verdict}</table>
  <div class="mtf-agree">Cross-timeframe alignment <b class="${m.agree>=75?'u':m.agree>=50?'n':'d'}">${m.agree}%</b>${m.agree>=75?' — timeframes agree; signal is high-conviction.':m.agree>=50?' — partial agreement; size accordingly.':' — timeframes conflict; the primary read is low-conviction here.'}</div>`;
}
