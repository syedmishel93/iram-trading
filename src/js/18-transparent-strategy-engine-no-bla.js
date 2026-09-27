function renderQuick(){updateAcct();try{if(window.Tick)Tick.emit(curPrice());}catch(e){}const q=document.getElementById('qInfo');if(!q)return;const px=curPrice();q.innerHTML=`${CURSYM.sym} @ <b style="color:var(--txt)">${fmt(px)}</b>${PAPER.locked?' <span style="color:var(--bear)">LOCKED</span>':''}`;const op=document.getElementById('qOpen');const u=unrealized();op.innerHTML=PAPER.pos.length?`${PAPER.pos.length} open · <span class="${u>=0?'up':'dn'}">${u>=0?'+':''}$${u.toFixed(2)}</span> · <span style="cursor:pointer;text-decoration:underline" id="qFlat">flat</span>`:'no open positions';const f=document.getElementById('qFlat');if(f)f.onclick=closeAll}

/* ---------- hedge desk (delta-neutral funding capture) ---------- */
let HEDGE='funding';
function renderHedge(){
  const g=id=>+document.getElementById(id).value;const cap=g('hCap'),fund=g('hFund')/100,basis=g('hBasis')/100,lev=g('hLev'),drift=g('hDrift');
  const asset=document.getElementById('hAsset').value;const notional=cap*lev;
  const box=(k,v,c)=>`<div class="stat"><div class="k">${k}</div><div class="v mono ${c||''}">${v}</div></div>`;
  const legs=(rows)=>`<table class="log"><thead><tr><th>Leg</th><th>Instrument</th><th>Direction</th><th>Notional</th><th>Delta / role</th></tr></thead><tbody>${rows}</tbody></table>`;
  const framework=(rows)=>`<table class="log"><thead><tr><th>Component</th><th>Operational rule</th><th>Management action</th></tr></thead><tbody>${rows.map(r=>`<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td style="color:var(--muted)">${r[2]}</td></tr>`).join('')}</tbody></table>`;
  const yEl=document.getElementById('hYield'),lEl=document.getElementById('hLegs'),rEl=document.getElementById('hRules'),dEl=document.getElementById('hDesc');
  const N=notional.toLocaleString();

  if(HEDGE==='funding'){
    dEl.innerHTML='<b style="color:var(--txt)">Delta-Neutral Funding Capture</b> — long spot + short perpetual, net delta zero. Harvest the funding longs pay shorts plus basis convergence, with no directional bet. At 1× the short can\'t be liquidated in a squeeze.';
    const dailyRate=fund*3,annualPct=dailyRate*365*100,dailyYield=notional*dailyRate,monthlyYield=dailyYield*30,basisYield=notional*basis;const netDelta=Math.random()*0.8-0.4,needsRebal=Math.abs(netDelta)>drift;
    yEl.innerHTML=[box('Daily funding','+$'+dailyYield.toFixed(2),'up'),box('Monthly (est.)','+$'+monthlyYield.toFixed(0),'up'),box('Annualised',annualPct.toFixed(1)+'%','up'),box('Basis convergence','+$'+basisYield.toFixed(0),'up')].join('');
    const proj=[cap];let e=cap;for(let i=0;i<90;i++){e*=1+dailyRate;proj.push(e)}lineChart('hCanvas',[{d:proj,c:var_bull(),w:2}]);
    lEl.innerHTML=legs(`<tr><td>Long</td><td class="mono">${asset} spot</td><td class="up">+1.0</td><td class="mono">$${N}</td><td class="mono up">+1.00</td></tr><tr><td>Short</td><td class="mono">${asset}-PERP</td><td class="dn">−1.0</td><td class="mono">$${N}</td><td class="mono dn">−1.00</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">delta 0.00</td><td>—</td><td class="mono">$0 dir.</td><td class="mono ${needsRebal?'dn':'up'}">${netDelta>=0?'+':''}${netDelta.toFixed(2)}% ${needsRebal?'!':'✓'}</td></tr>`)+`<div style="font-size:10.5px;color:var(--muted);margin-top:10px">Rebalance when drift &gt; ${drift}%. Current: ${Math.abs(netDelta).toFixed(2)}% ${needsRebal?'— <span style="color:var(--bear)">triggered</span>':'— within tolerance'}.</div>`;
    rEl.innerHTML=framework([['Asset',`Deep-liquidity ${asset}`,'Tight spreads keep the funding edge intact'],['Delta target','0.00 always',`Auto-rebalance beyond ${drift}%`],['Profit','Funding + basis',`~$${dailyYield.toFixed(2)}/day compounded`],['Risk',`${lev}× cross-margin`,lev<=1?'No squeeze liquidation':'! >1× adds liquidation risk'],['Exit','Funding turns negative','Capture basis, redeploy']]);
  }
  else if(HEDGE==='pairs'){
    dEl.innerHTML='<b style="color:var(--txt)">Pairs / Statistical Arbitrage</b> — long one asset, short a correlated one, beta-weighted to net-zero market exposure. You profit when the spread reverts to its mean, regardless of market direction.';
    const z=(Math.random()*4-2),corr=0.82+Math.random()*0.12,half=6+Math.random()*10,edge=Math.abs(z)*0.4;
    yEl.innerHTML=[box('Spread z-score',(z>=0?'+':'')+z.toFixed(2),Math.abs(z)>2?(z>0?'dn':'up'):''),box('Correlation',corr.toFixed(2),corr>0.8?'up':'dn'),box('Half-life',half.toFixed(0)+' bars'),box('Edge if reverts','~'+edge.toFixed(1)+'%','up')].join('');
    const path=[];let s=z;for(let i=0;i<80;i++){s+= -0.06*s+(Math.random()-0.5)*0.4;path.push(s)}lineChart('hCanvas',[{d:path,c:Math.abs(z)>2?var_bear():var_bull(),w:2},{d:path.map(()=>0),c:'#5A6472',w:1,dash:true}]);
    const dir=z>0?['Short','Long']:['Long','Short'];
    lEl.innerHTML=legs(`<tr><td>${dir[0]}</td><td class="mono">${asset}USD (rich leg)</td><td class="${dir[0]==='Long'?'up':'dn'}">${dir[0]}</td><td class="mono">$${(notional/2).toLocaleString()}</td><td class="mono">≈β-weighted</td></tr><tr><td>${dir[1]}</td><td class="mono">ETHUSD (cheap leg)</td><td class="${dir[1]==='Long'?'up':'dn'}">${dir[1]}</td><td class="mono">$${(notional/2).toLocaleString()}</td><td class="mono">hedge</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">market-neutral</td><td>—</td><td class="mono">~$0 dir.</td><td class="mono up">β≈0</td></tr>`);
    rEl.innerHTML=framework([['Pair selection','Cointegrated, corr &gt; 0.8','Re-test cointegration weekly; drop if it breaks'],['Entry','|z-score| &gt; 2','Fade the spread toward its mean'],['Exit','z-score → 0','Take profit on convergence'],['Stop','|z| &gt; 3.5 or corr breakdown','Structural break — cut, don\'t average down'],['Sizing','β-weighted legs','Keeps net market exposure ≈ 0']]);
  }
  else if(HEDGE==='carry'){
    dEl.innerHTML='<b style="color:var(--txt)">Cash-and-Carry Basis</b> — long spot + short a dated future. Lock in the basis (future premium) and collect it as the future converges to spot at expiry. Fully hedged on price.';
    const days=30,annual=basis/(days/365)*100,pnl=notional*basis,financing=notional*0.0002*days;
    yEl.innerHTML=[box('Basis premium',(basis*100).toFixed(2)+'%','up'),box('Days to expiry',days+'d'),box('Annualised carry',annual.toFixed(1)+'%','up'),box('Locked P&L','+$'+(pnl-financing).toFixed(0),'up')].join('');
    const decay=[];for(let i=0;i<=days;i++)decay.push(basis*100*(1-i/days));lineChart('hCanvas',[{d:decay,c:var_bull(),w:2},{d:decay.map(()=>0),c:'#5A6472',w:1,dash:true}]);
    lEl.innerHTML=legs(`<tr><td>Long</td><td class="mono">${asset} spot</td><td class="up">+1.0</td><td class="mono">$${N}</td><td class="mono up">+1.00</td></tr><tr><td>Short</td><td class="mono">${asset} future (dated)</td><td class="dn">−1.0</td><td class="mono">$${N}</td><td class="mono dn">−1.00</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">basis locked</td><td>—</td><td class="mono">$0 dir.</td><td class="mono up">converges to 0</td></tr>`);
    rEl.innerHTML=framework([['Entry','Positive basis vs financing','Only when annualised carry &gt; funding cost'],['Hold','To expiry','Basis mechanically → 0 at settlement'],['Financing','Track borrow/margin cost','Net carry = basis − financing'],['Risk','Delivery / margin calls','Keep margin buffer; roll before expiry'],['Exit','At/near expiry or early convergence','Unwind both legs, redeploy']]);
  }
  else if(HEDGE==='collar'){
    dEl.innerHTML='<b style="color:var(--txt)">Protective Collar</b> — hold spot, buy a put (downside floor), sell a call (upside cap) to finance it. Caps both loss and gain: a cheap, defined-risk hedge for a position you want to keep.';
    const floorPct=8,capPct=10,putCost=notional*0.02,callCredit=notional*0.018,net=putCost-callCredit;
    yEl.innerHTML=[box('Max loss','−'+floorPct+'%','dn'),box('Max gain','+'+capPct+'%','up'),box('Net premium',(net>=0?'−$':'+$')+Math.abs(net).toFixed(0),net<=0?'up':'dn'),box('Protected range','±'+floorPct+'/'+capPct+'%')].join('');
    // payoff diagram
    const cv=document.getElementById('hCanvas');const r=cv.parentElement.getBoundingClientRect();const H=120,dpr=devicePixelRatio||1;cv.width=r.width*dpr;cv.height=H*dpr;const gx=cv.getContext('2d');gx.setTransform(dpr,0,0,dpr,0,0);const W=r.width;gx.clearRect(0,0,W,H);const xs=[];for(let i=0;i<=100;i++){const mv=(i/100*30-15);const pl=Math.max(-floorPct,Math.min(capPct,mv));xs.push(pl)}const lo=-floorPct-3,hi=capPct+3;const yy=v=>H-8-((v-lo)/(hi-lo))*(H-16);gx.strokeStyle='rgba(212,218,227,.3)';gx.setLineDash([3,3]);gx.beginPath();gx.moveTo(0,yy(0));gx.lineTo(W,yy(0));gx.stroke();gx.setLineDash([]);gx.strokeStyle=var_bull();gx.lineWidth=2;gx.beginPath();xs.forEach((v,i)=>{const x=i/100*W;i?gx.lineTo(x,yy(v)):gx.moveTo(x,yy(v))});gx.stroke();
    lEl.innerHTML=legs(`<tr><td>Core</td><td class="mono">${asset} spot</td><td class="up">+1.0</td><td class="mono">$${N}</td><td class="mono up">holding</td></tr><tr><td>Floor</td><td class="mono">Long put −${floorPct}%</td><td class="up">protective</td><td class="mono">$${putCost.toFixed(0)}</td><td class="mono">caps loss</td></tr><tr><td>Finance</td><td class="mono">Short call +${capPct}%</td><td class="dn">covered</td><td class="mono">+$${callCredit.toFixed(0)}</td><td class="mono">caps gain</td></tr>`);
    rEl.innerHTML=framework([['Strikes',`Put −${floorPct}%, call +${capPct}%`,'Widen for more upside, tighten for cheaper hedge'],['Cost','Call credit offsets put','Aim for near-zero-cost collar'],['Best use','Protect a holding through an event','Earnings, unlock, macro risk'],['Assignment','Called away at cap','Accept the capped gain or roll the call'],['Exit','After the risk window','Remove options, keep or trim spot']]);
  }
  else if(HEDGE==='beta'){
    dEl.innerHTML='<b style="color:var(--txt)">Beta Hedge</b> — keep your long book, short an index future sized by the book\'s beta. Neutralises broad-market moves so only your stock-selection (alpha) remains.';
    const beta=1.15,shortNotional=notional*beta,residual=notional*0.15;
    yEl.innerHTML=[box('Portfolio β',beta.toFixed(2)),box('Hedge ratio',(beta*100).toFixed(0)+'%'),box('Index to short','$'+shortNotional.toLocaleString(),'dn'),box('Alpha exposure','$'+residual.toLocaleString(),'up')].join('');
    const uh=[cap];let a=cap,b=cap;const uhd=[cap],hd=[cap];for(let i=0;i<60;i++){const mk=(Math.random()-0.48)*0.02;const al=(Math.random()-0.45)*0.004;a*=1+mk*beta+al;b*=1+al;uhd.push(a);hd.push(b)}lineChart('hCanvas',[{d:uhd,c:'#5A6472',w:1.3,dash:true},{d:hd,c:var_bull(),w:2}]);
    lEl.innerHTML=legs(`<tr><td>Long</td><td class="mono">Your book</td><td class="up">+1.0</td><td class="mono">$${N}</td><td class="mono up">β ${beta.toFixed(2)}</td></tr><tr><td>Short</td><td class="mono">Index future</td><td class="dn">−β</td><td class="mono">$${shortNotional.toLocaleString()}</td><td class="mono dn">−${beta.toFixed(2)}</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">alpha-only</td><td>—</td><td class="mono">market β≈0</td><td class="mono up">keeps alpha</td></tr>`)+`<div style="font-size:10.5px;color:var(--muted);margin-top:10px">Dashed = unhedged book (rides the market); solid = beta-hedged (isolates selection skill).</div>`;
    rEl.innerHTML=framework([['Beta estimate','Regress book vs index','Recompute as holdings change'],['Hedge size','β × book notional','Short that much index'],['Rebalance','On β drift or new positions','Keep market exposure ≈ 0'],['Cost','Futures roll + financing','Small vs the risk removed'],['Goal','Isolate alpha','Profit even in a flat/down market if you pick well']]);
  }
  else if(HEDGE==='grid'){
    dEl.innerHTML='<b style="color:var(--txt)">Grid Neutral</b> — place staggered buy and sell orders across a range. Each oscillation books small profits. Market-neutral in a sideways regime; needs range, not trend.';
    const levels=10,spacing=1.2,rangePct=levels*spacing,perFill=notional/levels*spacing/100;
    yEl.innerHTML=[box('Grid levels',String(levels)),box('Spacing',spacing.toFixed(1)+'%'),box('Range covered','±'+(rangePct/2).toFixed(0)+'%'),box('Profit / fill','~$'+perFill.toFixed(1),'up')].join('');
    const osc=[];for(let i=0;i<80;i++)osc.push(Math.sin(i/6)*rangePct/2);lineChart('hCanvas',[{d:osc,c:var_bull(),w:2},{d:osc.map(()=>0),c:'#5A6472',w:1,dash:true}]);
    lEl.innerHTML=legs(`<tr><td>Below</td><td class="mono">${levels/2} buy limits</td><td class="up">accumulate</td><td class="mono">$${(notional/2).toLocaleString()}</td><td class="mono up">bid grid</td></tr><tr><td>Above</td><td class="mono">${levels/2} sell limits</td><td class="dn">distribute</td><td class="mono">$${(notional/2).toLocaleString()}</td><td class="mono dn">ask grid</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">range-bound</td><td>—</td><td class="mono">mean-reverting</td><td class="mono">✓ if ranging</td></tr>`);
    rEl.innerHTML=framework([['Regime check','Low ADX / ranging',`Use the Regime Classifier — grids die in trends`],['Grid setup',`${levels} levels, ${spacing}% apart`,'Tighter = more fills, more fees'],['Profit','Each round-trip fill','Buy low rung, sell next rung up'],['Risk','Trend breakout of range','Set outer stops; disable if ADX rises'],['Rebalance','Recentre on range shift','Cancel & re-lay the grid']]);
  }
  else if(HEDGE==='calendar'){
    dEl.innerHTML='<b style="color:var(--txt)">Calendar Spread</b> \u2014 sell a near-term option and buy a longer-dated one at the same strike. The front leg decays faster than the back leg, so you harvest the theta differential. Structural model with illustrative extrinsic values \u2014 wire a live options chain for exact greeks.';
    const frontExt=notional*0.020, backExt=notional*0.032, netDebit=backExt-frontExt;
    const thetaFront=frontExt/30, thetaBack=backExt/60, netTheta=thetaFront-thetaBack;
    yEl.innerHTML=[box('Net debit','$'+netDebit.toFixed(0)),box('Front \u03b8/day','+$'+thetaFront.toFixed(1),'up'),box('Back \u03b8/day','-$'+thetaBack.toFixed(1),'dn'),box('Net \u03b8/day','+$'+netTheta.toFixed(1),netTheta>0?'up':'dn')].join('');
    const decay=[];for(let i=0;i<60;i++){decay.push(frontExt*Math.max(0,1-i/30)-backExt*Math.max(0,1-i/60)+netDebit)}lineChart('hCanvas',[{d:decay,c:var_bull(),w:2},{d:decay.map(()=>netDebit),c:'#5A6472',w:1,dash:true}]);
    lEl.innerHTML=legs(`<tr><td>Short</td><td class="mono">${asset} near-term call</td><td class="dn">-1 (sell)</td><td class="mono">$${frontExt.toFixed(0)} ext.</td><td class="mono dn">fast \u03b8</td></tr><tr><td>Long</td><td class="mono">${asset} back-month call</td><td class="up">+1 (buy)</td><td class="mono">$${backExt.toFixed(0)} ext.</td><td class="mono up">slow \u03b8</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">same strike</td><td>\u2248 delta-neutral</td><td class="mono">$${netDebit.toFixed(0)} debit</td><td class="mono up">long \u03b8 spread</td></tr>`);
    rEl.innerHTML=framework([['Strike','At-the-money',`Max value when price sits at strike near front expiry`],['Front expiry','\u224830 days','Sells the fastest-decaying leg'],['Back expiry','\u224860 days','Retains extrinsic after front expires'],['Profit','Theta differential','Front decays ~2\u00d7 faster than back'],['Risk','Large directional move','Both legs move together \u2014 loss is capped near the net debit'],['Exit','Roll or close at front expiry','Book the decay, re-establish if thesis holds']]);
  }
  else if(HEDGE==='covered'){
    dEl.innerHTML='<b style="color:var(--txt)">Covered Call</b> \u2014 hold the asset and sell a call against it. You collect the premium as income and cushion small drawdowns; in exchange your upside is capped at the strike. Income structure, not a directional bet. Illustrative premium \u2014 wire a live chain for exact numbers.';
    const spot=cap, prem=cap*0.03, strikeUp=0.05, maxProfit=cap*strikeUp+prem, be=spot-prem, annual=(prem/cap)*12*100;
    yEl.innerHTML=[box('Premium','+$'+prem.toFixed(0),'up'),box('Max profit','+$'+maxProfit.toFixed(0),'up'),box('Breakeven','$'+be.toFixed(0)),box('Annualised (rolled)',annual.toFixed(0)+'%','up')].join('');
    const payoff=[];for(let i=0;i<80;i++){const mv=(i-40)/40*0.12;const spotPL=cap*mv;const capped=Math.min(spotPL,cap*strikeUp);payoff.push(capped+prem)}lineChart('hCanvas',[{d:payoff,c:var_bull(),w:2},{d:payoff.map(()=>0),c:'#5A6472',w:1,dash:true}]);
    lEl.innerHTML=legs(`<tr><td>Long</td><td class="mono">${asset} spot</td><td class="up">+1.0</td><td class="mono">$${cap.toLocaleString()}</td><td class="mono up">owns upside</td></tr><tr><td>Short</td><td class="mono">${asset} call +5%</td><td class="dn">-\u0394</td><td class="mono">$${prem.toFixed(0)} prem.</td><td class="mono dn">caps upside</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">income</td><td>+ premium</td><td class="mono">cushion $${prem.toFixed(0)}</td><td class="mono up">yield + partial hedge</td></tr>`);
    rEl.innerHTML=framework([['Underlying','Asset you already hold','Only write calls on inventory you own'],['Strike','\u2248+5% OTM',`Higher strike = more upside kept, less premium`],['Premium','\u22483% of spot','Your income and downside cushion'],['Capped at','Strike + premium',`Upside surrendered above $${(spot*(1+strikeUp)).toFixed(0)}`],['Best regime','Flat to mildly up','Premium decays in your favour'],['Risk','Sharp drop','Premium only cushions \u2014 it is not a full hedge']]);
  }
  else if(HEDGE==='voltarget'){
    dEl.innerHTML='<b style="color:var(--txt)">Vol-Target Overlay</b> \u2014 not a position but a sizing rule: scale exposure inversely to realised volatility so risk stays constant. When vol doubles, you halve size. Keeps portfolio risk stable across calm and stormy regimes.';
    const tgtVol=15, _c=DATA.map(x=>x.c), _n=_c.length-1, _atrA=IND.atr(DATA), _av=(_atrA&&_atrA[_n])||_c[_n]*0.01, realVol=Math.max(4,(_av/(_c[_n]||1))*Math.sqrt(252)*100), scale=Math.min(2,tgtVol/realVol), exposure=notional*scale;
    yEl.innerHTML=[box('Target vol',tgtVol+'%'),box('Realised vol',realVol.toFixed(0)+'%',realVol>tgtVol?'dn':'up'),box('Scale factor',scale.toFixed(2)+'\u00d7',scale>=1?'up':'dn'),box('Sized exposure','$'+exposure.toFixed(0))].join('');
    const ex=[];for(let i=0;i<80;i++){const v=tgtVol*(1+0.6*Math.sin(i/9));ex.push(Math.min(2,tgtVol/v))}lineChart('hCanvas',[{d:ex,c:var_bull(),w:2},{d:ex.map(()=>1),c:'#5A6472',w:1,dash:true}]);
    lEl.innerHTML=legs(`<tr><td>Base</td><td class="mono">${asset} position</td><td class="up">+1.0</td><td class="mono">$${notional.toFixed(0)}</td><td class="mono">raw exposure</td></tr><tr><td>Overlay</td><td class="mono">vol scalar</td><td class="mono">\u00d7${scale.toFixed(2)}</td><td class="mono">$${exposure.toFixed(0)}</td><td class="mono ${scale>=1?'up':'dn'}">risk-normalised</td></tr><tr style="border-top:2px solid var(--edge2)"><td><b>Net</b></td><td class="mono">constant risk</td><td>${tgtVol}% target</td><td class="mono">dynamic</td><td class="mono up">stable vol</td></tr>`);
    rEl.innerHTML=framework([['Target','15% annualised vol','The risk budget you want to hold constant'],['Measure','Realised vol (ATR\u00d7\u221a252)','Rolling estimate from recent bars'],['Rule','size = target / realised','Cap the scalar (e.g. \u22642\u00d7) to avoid over-leverage'],['Effect','Down-size in storms','Automatically de-risks when vol spikes'],['Rebalance','Daily or on vol shift','Re-measure and re-scale'],['Risk','Vol \u2260 drawdown','Low vol can still gap \u2014 keep hard stops']]);
  }
}

/* ---------- live data (best-effort in-browser; crypto via public API) ---------- */
function binanceSym(sym){const sp=SPECS[sym];if(!sp)return null;if(sp.cls==='crypto'){const base=sym.replace(/USD$/,'');if(base==='POL')return 'POLUSDT';return base+'USDT'}if(sp.cls==='cryptofut'){return sym.replace(/PERP$/,'')+'USDT'}return null}
function isFut(sym){return !!(SPECS[sym]&&SPECS[sym].cls==='cryptofut')}
function tfInterval(tf){return {'1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','1d':'1d','1w':'1w','1M':'1M'}[tf]||'1h'}
const BAR_CACHE={};   /* sym|tf -> bars, for instant timeframe/symbol switching */
async function fetchKlines(sym,interval='1h',limit=1000){
  const bs=binanceSym(sym);if(!bs)throw new Error('no crypto mapping');
  const base=isFut(sym)?'https://fapi.binance.com/fapi/v1/klines':((document.getElementById('dsRest')&&document.getElementById('dsRest').value)||'https://data-api.binance.vision/api/v3/klines');
  const ctrl=new AbortController();const to=setTimeout(()=>ctrl.abort(),6000);
  const res=await fetch(`${base}?symbol=${bs}&interval=${interval}&limit=${limit}`,{signal:ctrl.signal});clearTimeout(to);
  if(!res.ok)throw new Error('HTTP '+res.status);
  const j=await res.json();if(!Array.isArray(j))throw new Error('bad response');
  return j.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}));
}

/* =====================================================================
   TRANSPARENT STRATEGY ENGINE — no black box
   Each strategy is a declarative spec (entry/exit/stop/tp conditions).
   The engine evaluates those exact rules bar-by-bar on real data and
   records every trade with the reason it entered and how it exited.
   Uploaded strategies use the identical format and run through the same
   engine, so nothing is hidden.
   ===================================================================== */
function indicatorsFor(d){
  const c=d.map(x=>x.c),o=d.map(x=>x.o),h=d.map(x=>x.h),l=d.map(x=>x.l);
  const macd=IND.macd(c),bb=IND.boll(c),st=IND.supertrend(d),sto=IND.stoch(d);
  let cum=0,cv=0;const vwap=d.map(x=>{const tp=(x.h+x.l+x.c)/3;cum+=tp*x.v;cv+=x.v;return cv?cum/cv:x.c});
  const div=new Array(d.length).fill(0);detectDivergence(d).forEach(dv=>{const b=dv.pts[1].i;if(b<div.length)div[b]=dv.dir==='bull'?1:-1});
  return {close:c,open:o,high:h,low:l,ema9:IND.ema(c,9),ema20:IND.ema(c,20),ema21:IND.ema(c,21),ema50:IND.ema(c,50),ema200:IND.ema(c,200),rsi:IND.rsi(c),atr:IND.atr(d),macd:macd.m,macds:macd.sig,macdh:macd.hist,stochk:sto.K,stochd:sto.D,cci:IND.cci(d),willr:IND.willr(d),bbu:bb.up,bbl:bb.lo,bbm:bb.mid,stdir:st.dir,vwap,roc:IND.roc(c,12),adx:IND.adx(d),mfi:IND.mfi(d),flux:IND.flux(d),div};
}
