var _mtfLast=0;
function renderMTF(){
  /* v39.18 perf: this recomputes 8x genData (4 TFs x two tables). It used to run on
     EVERY draw-loop tick even when the MTF view and side card were hidden. Gate it to
     when something that shows it is visible, and throttle to 2s (higher-TF synthetic
     data barely moves tick-to-tick). Cuts idle CPU sharply on a fast tape. */
  try{
    var mtfV=document.getElementById('v-mtf'), chartV=document.getElementById('v-chart');
    var vis=(mtfV&&mtfV.classList.contains('on'))||(chartV&&chartV.classList.contains('on'));
    if(!vis||document.hidden)return;
    var now=Date.now(); if(now-_mtfLast<2000)return; _mtfLast=now;
  }catch(e){}
  const box=document.getElementById('mtf');if(!box)return;try{const m=mtfMatrix();box.innerHTML=mtfTableHTML(m,false)}catch(e){box.innerHTML='<div style="color:var(--muted)">MTF matrix unavailable.</div>'}renderMTFAuto()}
window.renderMTFSide=function(){try{
  let card=document.getElementById('mtfSideCard');
  if(!card){const conf=document.querySelector('.side .card');if(!conf)return;
    card=document.createElement('div');card.className='card';card.id='mtfSideCard';
    card.innerHTML='<h3>MTF confluence <span class="tag" title="The same glass-box signals recomputed on 15m/1H/4H/1D. Agreement across timeframes = conviction.">GRID</span></h3><div id="mtfSideBody"></div>';
    conf.parentElement.insertBefore(card,conf.nextSibling);}
  const m=mtfMatrix();document.getElementById('mtfSideBody').innerHTML=mtfTableHTML(m,true);
}catch(e){}};
function renderMTFAuto(){
  const el=document.getElementById('mtfAuto');if(!el)return;
  const tfs=['15m','1H','4H','1D'],price=DATA[DATA.length-1].c;
  const proj=(tl,n)=>tl?tl.b.p+(tl.b.p-tl.a.p)/((tl.b.i-tl.a.i)||1)*(n-1-tl.b.i):null;
  const rows=tfs.map((t,i)=>{
    const dd=genData(320,price,1000+i*7);const rep=confluence(buildSignals(dd).S);
    const f=autoFib(dd),tl=autoTrendlines(dd),lp=dd[dd.length-1].c;
    let nf=null,nd=1e9;f&&f.levels.forEach(l=>{const d2=Math.abs(l.price-lp);if(d2<nd){nd=d2;nf=l}});
    const resP=proj(tl.find(x=>x.kind==='res'),dd.length),supP=proj(tl.find(x=>x.kind==='sup'),dd.length);
    const cls=rep.label.includes('Buy')?'up':rep.label.includes('Sell')?'dn':'';
    return `<tr><td><b>${t}</b></td><td class="${cls}">${rep.label}</td><td class="mono">${nf?(nf.r*100).toFixed(1)+'%':'—'}</td><td class="mono dn">${resP?fmt(resP):'—'}</td><td class="mono up">${supP?fmt(supP):'—'}</td></tr>`;
  }).join('');
  el.innerHTML=`<div class="panelbox" style="margin-bottom:14px"><h4>Auto-analysis across timeframes <span class="tag">AUTO TL + FIB</span></h4><table class="log"><thead><tr><th>TF</th><th>Bias</th><th>Nearest Fib</th><th>Resistance</th><th>Support</th></tr></thead><tbody>${rows}</tbody></table><div style="font-size:10px;color:var(--muted2);margin-top:6px">Auto-trendlines and Fibonacci computed independently on each timeframe — alignment across TFs raises conviction. (Higher-TF data is illustrative offline; live when a data source is connected.)</div></div>`;
}

function renderStatus(){document.getElementById('stBars').textContent=DATA.length;const c=DATA.map(x=>x.c);const e50=IND._e50,e200=IND._e200,n=c.length-1;const trend=e50[n]>e200[n];const rsi=IND._rsi[n]||50;const regime=Math.abs(rsi-50)>18||Math.abs(e50[n]-e200[n])/c[n]>0.01?'Trending':'Mean-reverting';document.getElementById('stRegime').innerHTML=`<span style="color:${regime==='Trending'?'var(--gold)':'var(--blue)'}">${regime}</span>`;const atr=IND.atr(DATA);document.getElementById('stAtr').textContent=fmt(atr[n]||0);document.getElementById('stFeed').textContent=CURSYM.kind==='crypto'?'ccxt · Binance':'yfinance';}

/* ---------- position sizer (real) ---------- */
function sizer(){const acct=+document.getElementById('cAcct').value||0;const risk=+document.getElementById('cRisk').value||0;const entry=+document.getElementById('cEntry').value||0;const stop=+document.getElementById('cStop').value||0;const per=Math.abs(entry-stop);const dollars=acct*risk/100;const units=per>0?dollars/per:0;const notional=units*entry;const contract=(CURSYM&&CURSYM.spec&&CURSYM.spec.contract)||null;let sizeTxt='—';if(units>0){if(contract&&contract>1){const lots=units/contract;sizeTxt=lots.toLocaleString(undefined,{maximumFractionDigits:lots<1?3:2})+' lots  ($'+notional.toLocaleString(undefined,{maximumFractionDigits:0})+')'}else{sizeTxt=units.toLocaleString(undefined,{maximumFractionDigits:units<10?4:2})+' units  ($'+notional.toLocaleString(undefined,{maximumFractionDigits:0})+')'}}document.getElementById('cSize').textContent=sizeTxt;document.getElementById('cSub').textContent=`Risking $${dollars.toFixed(0)} · ${per>0?(per/entry*100).toFixed(2):0}% stop · notional $${notional.toLocaleString(undefined,{maximumFractionDigits:0})}${contract&&contract>1?' · 1 lot = '+contract.toLocaleString()+' units':''}`}
['cAcct','cRisk','cEntry','cStop'].forEach(id=>document.getElementById(id).addEventListener('input',sizer));

/* =====================================================================
   Backtest + Monte Carlo demo views (computed on synthetic trade stream)
   ===================================================================== */
/* v16.4 RRG — pure math (unit-tested) */
function rrgQuadrant(rs,mom){return rs>=100?(mom>=100?'LEADING':'WEAKENING'):(mom>=100?'IMPROVING':'LAGGING')}
function rrgCalc(seriesMap,benchKey,win,momWin){
  win=win||20;momWin=momWin||5;const bench=seriesMap[benchKey];
  if(!bench||bench.length<win+momWin+2)return[];
  const out=[];
  Object.keys(seriesMap).forEach(sym=>{if(sym===benchKey)return;const px=seriesMap[sym];
    if(!px||px.length<win+momWin+2)return;
    const L=Math.min(px.length,bench.length);const a=px.slice(-L),b=bench.slice(-L);
    const ratio=a.map((v,i)=>b[i]>0?v/b[i]:null).filter(v=>v!=null);
    if(ratio.length<win+momWin+2)return;
    const rsSeries=[];
    for(let i=win;i<ratio.length;i++){let m=0;for(let k=i-win;k<i;k++)m+=ratio[k];m/=win;
      rsSeries.push(m>0?100*ratio[i]/m:100);}
    if(rsSeries.length<momWin+1)return;
    const tail=[];const T=rsSeries.length;
    for(let k=Math.max(momWin,T-5);k<T;k++){const rs=rsSeries[k];const prev=rsSeries[k-momWin];
      const mom=prev>0?100*rs/prev:100;tail.push({rs:+rs.toFixed(2),mom:+mom.toFixed(2)});}
    const cur=tail[tail.length-1];
    out.push({sym,rs:cur.rs,mom:cur.mom,quad:rrgQuadrant(cur.rs,cur.mom),tail});});
  return out.sort((x,y)=>y.rs-x.rs);}
function renderRRG(){
  const out=document.getElementById('rrgOut');if(!out)return;
  const map={};let benchSrc='';
  try{Object.keys(BAR_CACHE||{}).forEach(k=>{if(!/\|1h$/.test(k))return;const bars=BAR_CACHE[k];
    if(Array.isArray(bars)&&bars.length>=40)map[k.split('|')[0]]=bars.map(c=>c.c);});
    if(typeof DATA!=='undefined'&&DATA.length>=40&&typeof CURSYM!=='undefined'&&CURSYM.sym&&!map[CURSYM.sym]&&window._realFeed)map[CURSYM.sym]=DATA.map(c=>c.c);
  }catch(e){}
  const syms=Object.keys(map);
  const bench=map.BTCUSD?'BTCUSD':syms[0];
  if(syms.length<3){out.innerHTML='<div style="font-size:11px;color:var(--muted)">Need real cached bars for \u22653 symbols (have '+syms.length+'). Go Online and open a few symbols \u2014 each one caches its 1h bars \u2014 then refresh. Nothing synthetic is plotted here.</div>';return}
  const pts=rrgCalc(map,bench,20,5);
  if(!pts.length){out.innerHTML='<div style="font-size:11px;color:var(--muted)">Cached series too short for a '+(20+5)+'-bar rotation window.</div>';return}
  const S=340,C=S/2;const span=Math.max(4,...pts.map(p=>Math.max(Math.abs(p.rs-100),Math.abs(p.mom-100))))*1.25;
  const X=v=>C+(v-100)/span*(C-24),Y=v=>C-(v-100)/span*(C-24);
  const QCOL={LEADING:'#2DBE8E',WEAKENING:'#E8A33D',LAGGING:'#F0616D',IMPROVING:'#4C82FB'};
  let svg='<svg viewBox="0 0 '+S+' '+S+'" style="width:100%;max-width:430px;display:block">';
  svg+='<rect x="'+C+'" y="0" width="'+C+'" height="'+C+'" fill="rgba(45,190,142,.05)"/><rect x="'+C+'" y="'+C+'" width="'+C+'" height="'+C+'" fill="rgba(232,163,61,.05)"/><rect x="0" y="'+C+'" width="'+C+'" height="'+C+'" fill="rgba(240,97,109,.05)"/><rect x="0" y="0" width="'+C+'" height="'+C+'" fill="rgba(76,130,251,.05)"/>';
  svg+='<line x1="'+C+'" y1="0" x2="'+C+'" y2="'+S+'" stroke="rgba(120,132,148,.35)"/><line x1="0" y1="'+C+'" x2="'+S+'" y2="'+C+'" stroke="rgba(120,132,148,.35)"/>';
  svg+='<text x="'+(S-6)+'" y="12" text-anchor="end" font-size="9" fill="#2DBE8E">LEADING</text><text x="'+(S-6)+'" y="'+(S-6)+'" text-anchor="end" font-size="9" fill="#E8A33D">WEAKENING</text><text x="6" y="'+(S-6)+'" font-size="9" fill="#F0616D">LAGGING</text><text x="6" y="12" font-size="9" fill="#4C82FB">IMPROVING</text>';
  pts.forEach(p=>{const col=QCOL[p.quad];
    if(p.tail.length>1){svg+='<polyline fill="none" stroke="'+col+'" stroke-opacity=".45" stroke-width="1.2" points="'+p.tail.map(t=>X(t.rs).toFixed(1)+','+Y(t.mom).toFixed(1)).join(' ')+'"/>'}
    svg+='<circle cx="'+X(p.rs).toFixed(1)+'" cy="'+Y(p.mom).toFixed(1)+'" r="4" fill="'+col+'"/>';
    svg+='<text x="'+(X(p.rs)+6).toFixed(1)+'" y="'+(Y(p.mom)+3).toFixed(1)+'" font-size="9.5" fill="var(--txt)" font-family="JetBrains Mono">'+p.sym.replace('USD','')+'</text>';});
  svg+='</svg>';
  const rows=pts.map(p=>'<tr><td><b>'+p.sym+'</b></td><td class="mono">'+p.rs.toFixed(1)+'</td><td class="mono">'+p.mom.toFixed(1)+'</td><td><span class="pill" style="color:'+QCOL[p.quad]+'">'+p.quad+'</span></td></tr>').join('');
  out.innerHTML='<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start">'+svg+'<table class="log" style="min-width:230px"><thead><tr><th>sym</th><th>RS</th><th>Mom</th><th>quadrant</th></tr></thead><tbody>'+rows+'</tbody></table></div><div style="font-size:10px;color:var(--muted2);margin-top:6px">Benchmark: <b>'+bench+'</b> \u00b7 window 20 bars \u00b7 momentum lookback 5 \u00b7 '+pts.length+' symbols from real cached 1h bars \u00b7 tails = last 5 readings</div>';}
/* v16.3 TV2 — Pine v5 exporter. Pure: spec in, script out. Unsupported Mishel-custom vars are named, never silently translated. */
const PINE_MAP={close:'close',open:'open',high:'high',low:'low',
  ema9:'ta.ema(close,9)',ema20:'ta.ema(close,20)',ema21:'ta.ema(close,21)',ema50:'ta.ema(close,50)',ema200:'ta.ema(close,200)',
  rsi:'ta.rsi(close,14)',atr:'ta.atr(14)',vwap:'ta.vwap',roc:'ta.roc(close,12)',mfi:'ta.mfi(hlc3,14)',cci:'ta.cci(hlc3,20)',willr:'ta.wpr(14)',
  macd:'_macdL',macds:'_macdS',macdh:'_macdH',stochk:'_stK',stochd:'_stD',bbu:'_bbU',bbl:'_bbL',bbm:'_bbM',adx:'_adx',stdir:'_stDir'};
const PINE_DECL={_macd:'[_macdL,_macdS,_macdH] = ta.macd(close,12,26,9)',_st:'_stK = ta.stoch(close,high,low,14)\n_stD = ta.sma(_stK,3)',
  _bb:'[_bbM,_bbU,_bbL] = ta.bb(close,20,2)',_adx:'[_diP,_diM,_adx] = ta.dmi(14,14)',
  _stdir:'[_stLine,_stDirRaw] = ta.supertrend(3,10)\n_stDir = _stDirRaw < 0 ? 1 : -1  // Pine: dir<0 = uptrend; mapped to Mishel convention (1 = up) — verify on your chart'};
function pineTerm(v,unsupported){if(typeof v==='number'||(typeof v==='string'&&v!==''&&isFinite(+v)))return String(v);
  if(PINE_MAP[v])return PINE_MAP[v];unsupported.push(v);return null}
function pineCond(group,unsupported){if(!Array.isArray(group)||!group.length)return null;
  const parts=group.map(([L,op,R])=>{const a=pineTerm(L,unsupported),b=pineTerm(R,unsupported);if(a==null||b==null)return null;
    if(op==='crossabove')return 'ta.crossover('+a+', '+b+')';if(op==='crossbelow')return 'ta.crossunder('+a+', '+b+')';
    return '('+a+' '+op+' '+b+')';}).filter(Boolean);
  return parts.length?parts.join(' and '):null}
function pineExport(spec,name){
  const unsupported=[];const used=new Set();
  const scan=g=>{(g||[]).forEach(([L,,R])=>{[L,R].forEach(v=>{if(PINE_MAP[v]&&PINE_MAP[v][0]==='_')used.add(v)})})};
  [spec.long,spec.short,spec.exitLong,spec.exitShort].forEach(scan);
  const decls=[];if([...used].some(v=>v.indexOf('macd')===0))decls.push(PINE_DECL._macd);
  if([...used].some(v=>v.indexOf('stoch')===0))decls.push(PINE_DECL._st);
  if([...used].some(v=>v.indexOf('bb')===0))decls.push(PINE_DECL._bb);
  if(used.has('adx'))decls.push(PINE_DECL._adx);if(used.has('stdir'))decls.push(PINE_DECL._stdir);
  const longC=pineCond(spec.long,unsupported),shortC=spec.short?pineCond(spec.short,unsupported):null;
  const exL=pineCond(spec.exitLong,unsupported),exS=spec.short?pineCond(spec.exitShort,unsupported):null;
  const st=spec.stop||{type:'pct',value:1.5},tp=spec.tp||null;
  const stopL=st.type==='atr'?('strategy.position_avg_price - ta.atr(14)*'+(st.mult||2)):('strategy.position_avg_price*(1-'+((st.value||1.5)/100)+')');
  const stopS=st.type==='atr'?('strategy.position_avg_price + ta.atr(14)*'+(st.mult||2)):('strategy.position_avg_price*(1+'+((st.value||1.5)/100)+')');
  const tpL=tp?(tp.type==='rr'?('strategy.position_avg_price + (strategy.position_avg_price - ('+stopL+'))*'+(tp.value||2)):('strategy.position_avg_price*(1+'+((tp.value||2)/100)+')')):null;
  const tpS=tp?(tp.type==='rr'?('strategy.position_avg_price - (('+stopS+') - strategy.position_avg_price)*'+(tp.value||2)):('strategy.position_avg_price*(1-'+((tp.value||2)/100)+')')):null;
  const U=[...new Set(unsupported)];
  const lines=['//@version=5',
    'strategy("'+String(name||spec.name||'Mishel strategy').replace(/"/g,"'")+' — exported from Mishel Intelligence Trading", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=5, commission_type=strategy.commission.percent, commission_value=0.05)',
    '// EXPORT NOTES: Mishel freezes the stop at entry; Pine recomputes strategy.position_avg_price-based exits each bar — expect small divergences.',
    U.length?('// UNSUPPORTED Mishel-custom indicators, rules containing them were DROPPED (not approximated): '+U.join(', ')):'// all rule variables translated 1:1',''];
  decls.forEach(d=>lines.push(d));if(decls.length)lines.push('');
  lines.push('longCond = '+(longC||'false  // long rules untranslatable — see UNSUPPORTED note'));
  if(shortC!==null||spec.short)lines.push('shortCond = '+(shortC||'false  // short rules untranslatable'));
  lines.push('','if longCond and strategy.position_size == 0','    strategy.entry("L", strategy.long)');
  if(spec.short)lines.push('if shortCond and strategy.position_size == 0','    strategy.entry("S", strategy.short)');
  lines.push('','if strategy.position_size > 0','    strategy.exit("XL","L", stop='+stopL+(tpL?(', limit='+tpL):'')+')');
  if(exL)lines.push('    if '+exL,'        strategy.close("L", comment="exit rule")');
  if(spec.short){lines.push('if strategy.position_size < 0','    strategy.exit("XS","S", stop='+stopS+(tpS?(', limit='+tpS):'')+')');
    if(exS)lines.push('    if '+exS,'        strategy.close("S", comment="exit rule")');}
  return {code:lines.join('\n'),unsupported:U,complete:U.length===0};}
