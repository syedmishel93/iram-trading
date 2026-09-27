function deskAnalyst(q){
  const x=analystContext(),f=v=>v==null?'—':(+v).toFixed(x.dec),ql=(q||'').toLowerCase();
  const S=analystFactors(x),lad=levelLadder(x),con=x.con;
  const prob=Math.max(5,Math.min(95,Math.round(50+con.score*0.35)));
  const dirWord=con.score>8?'bullish':con.score<-8?'bearish':'balanced / neutral';
  const consensusLine=()=>`**Consensus: ${con.label}** — score ${con.score>=0?'+':''}${con.score}/100 with **${con.confidence}% agreement** across ${con.votes.length} indicators${con.tuned?', **weights tuned to this market history**':''}. Objective lean ≈ **${prob}%** ${dirWord} (from indicator agreement, not opinion). ${x.name} · ${x.tf} @ ${f(x.price)}, ${x.reg.regime.toLowerCase()} regime · ${x.live?'**live data**':'synthetic data (connect a source for live)'}.`;
  const catLine=()=>`By category — trend ${con.byCat.trend>0?'▲':con.byCat.trend<0?'▼':'·'} ${con.byCat.trend}, momentum ${con.byCat.momentum>0?'▲':con.byCat.momentum<0?'▼':'·'} ${con.byCat.momentum}, volatility ${con.byCat.volatility}, volume ${con.byCat.volume>0?'▲':con.byCat.volume<0?'▼':'·'} ${con.byCat.volume} (−1 bearish … +1 bullish).`;
  const scorecard=()=>{const accMap=x.acc||{};const alias={'Trend (50/200 EMA)':'EMA 50/200','Price vs EMA200':'Price vs EMA200','MACD':'MACD','RSI':'RSI','Money flow (MFI)':'MFI','Order-flow (Flux)':'Kinetic Flux'};return 'Factor scorecard (weight · measured hit-rate here):\n'+S.F.filter(fx=>fx.w>0).map(fx=>{const an=alias[fx.name];const hr=an&&accMap[an]!=null?` · hit ${(accMap[an]*100).toFixed(0)}%`:'';return `• ${fx.dir>0?'▲':fx.dir<0?'▼':'·'} **${fx.name}** (w ${fx.w}${hr}) — ${fx.note}`}).join('\n')};
  const checklistBlock=()=>{const ck=tradeChecklist(x);return `**Objectivity checklist (${ck.passed}/${ck.total}):**\n`+ck.items.map(i=>`${i.pass?'✓':'✗'} ${i.txt}`).join('\n')+`\n\n${ck.passed>=4?'Most objective gates pass — a plan here is disciplined, not emotional.':ck.passed>=3?'Mixed — proceed only if the failing gates are acceptable to your plan.':'! Several gates fail — this would likely be an emotional/biased entry. Consider standing aside.'}`;};
  const ladder=()=>{const up=lad.above.slice(0,4).map(l=>`${l.name} ${f(l.p)} (+${((l.p-x.price)/x.price*100).toFixed(2)}%)`).join(' · ')||'clear overhead';const dn=lad.below.slice(0,4).map(l=>`${l.name} ${f(l.p)} (${((l.p-x.price)/x.price*100).toFixed(2)}%)`).join(' · ')||'clear below';return `**Resistance above:** ${up}\n**Support below:** ${dn}`;};
  const risk=()=>{const stop=x.atr*1.5,tgt=con.score>=0?lad.above[0]:lad.below[0],rr=tgt?Math.abs(tgt.p-x.price)/stop:null;return `Risk: an ATR-based stop is ≈ ${f(stop)} away (${(stop/x.price*100).toFixed(2)}%). ${tgt?`Nearest target ${tgt.name} ${f(tgt.p)} ≈ **${rr?rr.toFixed(1):'?'}R**.`:''} In a ${x.reg.regime.toLowerCase()} regime, ${x.reg.advice||'size to your plan and respect the level'}.`;};
  const scenarios=()=>{const r=lad.above[0],s=lad.below[0];return `**Scenarios** — bullish: a ${x.tf} close above ${r?f(r.p)+' ('+r.name+')':'nearby resistance'} opens continuation. Bearish: losing ${s?f(s.p)+' ('+s.name+')':'nearby support'} hands control down.${x.vwap!=null?` VWAP ${f(x.vwap)} is the pivot.`:''}`;};
  // ---- account / journal / backtest awareness ----
  if(/position|exposure|my risk|how much.*risk|open trade|my trade|account|margin|equity|my balance/.test(ql)){
    const a=aiToolRun('get_account_risk',{});
    if(!a.open_positions||!a.open_positions.length)return `Demo account: balance $${a.balance}, equity $${a.equity}, margin level ${a.margin_level_pct}% at 1:${a.leverage}. **No open positions** — nothing at risk right now.`;
    const tot=a.open_positions.reduce((s,p)=>s+(p.risk_to_stop_usd||0),0);
    const lines=a.open_positions.map(p=>`• ${p.side} ${p.symbol} ${p.qty} @ ${f(p.entry)} (stop ${f(p.stop)}) — P&L ${p.unrealized>=0?'+$':'-$'}${Math.abs(p.unrealized).toFixed(0)}, risk $${p.risk_to_stop_usd.toFixed(0)}`).join('\n');
    return `**Account risk** — equity $${a.equity}, free margin $${a.free_margin}, margin level ${a.margin_level_pct}%.\n${lines}\n**Total risk to stops: $${tot.toFixed(0)}** (${(tot/a.equity*100).toFixed(1)}% of equity).${tot/a.equity>0.06?' ! Above a typical 6% portfolio-heat guardrail — consider trimming.':' Within a sensible heat budget.'}`;
  }
  if(/journal|expectanc|win rate|my edge|my performance|my stats|how am i doing/.test(ql)){
    const j=aiToolRun('get_journal_stats',{});
    if(j.trades===0)return 'No closed demo trades yet — take some and I can measure your expectancy, win rate, and payoff.';
    return `**Your edge (${j.trades} trades)** — expectancy ${j.expectancy_per_trade>=0?'+$':'-$'}${Math.abs(j.expectancy_per_trade).toFixed(2)}/trade, win rate ${j.win_rate_pct}%, profit factor ${j.profit_factor??'—'}, avg win $${j.avg_win} vs avg loss $${j.avg_loss}. ${j.expectancy_per_trade>0?'Positive expectancy — it compounds if you size consistently.':'Negative expectancy — the average trade loses; fix setup selection or R:R before scaling.'}`;
  }
  if(/backtest|strategy result|does.*strategy work|test the strategy|run.*backtest/.test(ql)){
    const b=aiToolRun('run_backtest',{});if(b.error)return b.error;const s=b.stats||{};
    return `**${b.strategy}** — net ${s['Net return']||'—'}, win rate ${s['Win rate']||'—'}, PF ${s['Profit factor']||'—'}, max DD ${s['Max drawdown']||'—'}, in-sample R ${s['In-sample R']||'—'} vs out-of-sample R ${s['Out-of-sample R']||'—'}. If OOS is much weaker than in-sample, treat the edge as overfit.`;
  }
  // ---- market analysis intents ----
  if(/why|explain|reason|driver|because/.test(ql)){const b=S.bull.slice(0,3).map(d=>d.name).join(', ')||'none',be=S.bear.slice(0,3).map(d=>d.name).join(', ')||'none';return `${consensusLine()}\n\n${catLine()}\n\nPulling **for**: ${b}.\nPulling **against**: ${be}.\n\n${scorecard()}`;}
  if(/portfolio risk|var\b|cvar|value at risk|correlat|crowd|book risk/.test(ql)){const r=portfolioRisk();if(!r)return 'No open positions — portfolio VaR needs a book. Open demo trades and ask again.';const cw=r.crowding_warnings.length?'\n! **Crowding:** '+r.crowding_warnings.join('; ')+' — these move together; you hold effectively one larger bet.':'';return `**Portfolio risk (${r.positions} positions, equity $${r.equity})**\n• 1-day VaR(95%): **-$${r.var95_usd}** (${r.var95_pct_of_equity}% of equity) · CVaR: -$${r.cvar95_usd}\n• Gross $${r.gross} · Net ${r.net>=0?'+$'+r.net:'-$'+Math.abs(r.net)}\n• Portfolio heat (risk-to-stops): **$${r.portfolio_heat_usd}** (${r.portfolio_heat_pct}%${r.portfolio_heat_pct>6?' — above a 6% guardrail, consider trimming':' — within budget'})${cw}\n\n_${r.data_note}._`;}
  if(/quantum|anneal|optimi[sz]e weights|tune the (weights|consensus)/.test(ql)){const q=annealCategoryWeights(DATA);if(!q)return 'Need 160+ bars to run the annealing optimizer — load more history.';return `**Quantum-inspired annealing** (honest: simulated annealing, a classical heuristic inspired by quantum annealing — not quantum hardware):\n\nOptimized category weights for ${x.name} · ${x.tf} over ${q.samples} samples:\n• Trend **${q.weights.trend}** · Momentum **${q.weights.momentum}** · Volatility **${q.weights.volatility}** · Volume **${q.weights.volume}**\n\nDirectional hit-rate: **${q.hit_rate}%** vs ${q.baseline}% with equal weights${q.hit_rate>q.baseline?' — the annealer found a better mix for this market':' — equal weights are already near-optimal here'}.\n\n_Optimized in-sample; treat as a lens on which category matters most here, not a guarantee._`;}
  if(/accura|reliab|which indicator|best indicator|hit rate|track record|tuned/.test(ql)){if(!x.acc)return 'Not enough history yet to measure per-indicator accuracy (needs 120+ bars). Load more data and ask again.';const rows=Object.entries(x.acc).filter(([,v])=>v!=null).sort((a,b)=>b[1]-a[1]);const best=rows.slice(0,4).map(([k,v])=>`▲ **${k}** ${(v*100).toFixed(0)}%`).join('\n');const worst=rows.slice(-3).map(([k,v])=>`▼ **${k}** ${(v*100).toFixed(0)}%`).join('\n');return `**Per-indicator hit rate on ${x.name} · ${x.tf}** (how often each vote predicted the next 5 bars, last ~250 bars${x.live?', live data':''}):\n\nMost reliable here:\n${best}\n\nLeast reliable here:\n${worst}\n\nThe consensus weights each indicator by these measured hit rates — it trusts what has actually worked on this market, not textbook assumptions. ~50% = coin-flip; treat anything below that as noise.`;}
  if(/checklist|should i (take|enter)|is this a good|discipline|objectiv|am i chasing|bias/.test(ql))return `${consensusLine()}\n\n${checklistBlock()}\n\n${risk()}`;
  if(/target|where.*go|how high|how low|take profit|tp\b/.test(ql)){const dir=con.score>=0?lad.above:lad.below;const t=dir.slice(0,3).map(l=>`${l.name} ${f(l.p)} (${((l.p-x.price)/x.price*100).toFixed(2)}%)`).join(' → ')||'no clear level in range';return `Projected ${con.score>=0?'upside':'downside'} targets: ${t}.\n\n${ladder()}`;}
  if(/level|support|resist|vwap|fib|pdh|pdl|range|pivot/.test(ql))return ladder()+'\n\n'+scenarios();
  if(/risk|stop|size|volatil|atr|lose|r:r|reward/.test(ql))return risk()+'\n\n'+checklistBlock();
  if(/setup|trade|entry|play|idea|plan/.test(ql)){const dir=con.score>8?'Longs favoured':con.score<-8?'Shorts favoured':'No directional edge yet — wait for the consensus to resolve';return `${consensusLine()}\n\n${dir}. Entry idea: ${con.score>=0?'buy pullbacks toward VWAP/EMA support and let a '+x.tf+' close reclaim':'sell rallies into VWAP/EMA resistance and let a '+x.tf+' close reject'}.\n\n${checklistBlock()}\n\n${risk()}`;}
  if(/consensus|indicators|combined|overall|verdict|score/.test(ql))return `${consensusLine()}\n\n${catLine()}\n\n${scorecard()}`;
  if(/momentum|rsi|macd|overbought|oversold|money flow|mfi/.test(ql)){const n=DATA.length-1,macd=IND._macd,mfi=(IND._mfi&&IND._mfi[n])||50,sr=IND.stochRSI(DATA.map(z=>z.c))[n];return `Momentum: RSI ${x.rsi.toFixed(0)} (${x.rsi>70?'overbought':x.rsi<30?'oversold':'neutral'}), StochRSI ${sr!=null?sr.toFixed(0):'—'}, MFI ${mfi.toFixed(0)}, MACD ${macd&&macd.hist[n]>=0?'positive':'negative'}, ADX ${x.adx.toFixed(0)}. Momentum category net: ${con.byCat.momentum} (−1…+1). ${x.rsi>70||x.rsi<30?'Stretched — watch for mean-reversion or divergence.':'Room to run with the trend.'}`;}
  if(/timeframe|higher tf|mtf|alignment|bigger picture|multi.?time/.test(ql)){const tfs=['15m','1H','4H','1D'],rows=tfs.map((t,i)=>{const dd=genData(300,x.price,1000+i*7),cc=consensusSignal(dd);return {t,label:cc.label,score:cc.score}}),agree=rows.filter(r=>r.score>8).length,dis=rows.filter(r=>r.score<-8).length;return `**Multi-timeframe consensus** — ${rows.map(r=>r.t+': '+r.label).join(' · ')}. ${agree>=3?'Timeframes align bullish — higher conviction for longs.':dis>=3?'Timeframes align bearish — higher conviction for shorts.':'Mixed — lower conviction; trade the level, not the direction.'} _(Higher-TF data is illustrative offline; live when connected.)_`;}
  if(/session|london|new york|asia|time of day|when to trade/.test(ql)){const h=new Date().getUTCHours(),sess=h<8?'Asian':h<13?'London':h<17?'London/NY overlap (peak liquidity)':h<22?'New York':'after-hours (thin)';return `Current session (UTC ${h}:00): **${sess}**. ${/overlap/.test(sess)?'The London/NY overlap usually brings the most volume and cleanest moves.':'Asia often sets the session range; London/NY tends to break it.'} ${x.L.ldnH?`London H ${f(x.L.ldnH)} / L ${f(x.L.ldnL)}.`:''}`;}
  if(/^(hi|hello|hey|help|what can you|who are you)/.test(ql))return `I'm your desk analyst for **${x.name} · ${x.tf}**. I run a ${con.votes.length}-indicator **consensus** with a confidence score and an objectivity checklist. Ask for the **consensus/verdict**, **why**, a **checklist** ("should I take this?"), **key levels**, **targets**, **risk/stop**, a **setup**, **multi-timeframe**, the **session**, your **positions**, **journal edge**, or to **run the backtest**.`;
  // default: full objective read
  return [consensusLine(),catLine(),scorecard(),checklistBlock(),ladder(),scenarios(),risk(),'_Objective, outlier-filtered read combining '+con.votes.length+' indicators — deterministic, not financial advice._'].join('\n\n');
}
let AI_LOG=[];
function aiMd(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/_(.+?)_/g,'<i style="color:var(--muted2)">$1</i>').replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>')}
function renderAiChat(){const el=document.getElementById('aiChat');if(!el)return;if(!AI_LOG.length){el.innerHTML='<div style="color:var(--muted);padding:8px">Ask a question or tap a chip below — I read the live analysis for <b>'+CURSYM.name+' · '+TF+'</b>.</div>';return}el.innerHTML=AI_LOG.map(m=>m.role==='user'?`<div style="text-align:right;margin:8px 0"><span style="display:inline-block;background:var(--gold-dim);color:var(--txt);padding:7px 11px;border-radius:10px;max-width:80%">${m.text.replace(/</g,'&lt;')}</span></div>`:`<div style="margin:8px 0"><span style="display:inline-block;background:var(--panel2);border:1px solid var(--edge);padding:9px 12px;border-radius:10px;max-width:88%">${aiMd(m.text)}</span></div>`).join('');el.scrollTop=el.scrollHeight}
async function proxyAI(question,context){const base=proxyBase();if(!base)throw new Error('no proxy URL set');const r=await fetch(base+'/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question,context})});const j=await r.json();if(j.error)throw new Error(j.error);return j.text}

/* ========== Agentic AI Desk Analyst: the LLM calls the terminal's REAL functions (tool use) ========== */
let AI_MSGS=[];   /* running conversation for the agent */
const AI_TOOLS=[
  {name:'get_analysis',description:'Current glass-box analysis of the loaded instrument: confluence bias & score, 50/200 trend, regime, RSI, ADX, ATR%, detected chart patterns.',input_schema:{type:'object',properties:{}}},
  {name:'get_levels',description:'Key price levels for the loaded instrument: VWAP, prior-day high/low, nearest Fibonacci, and predictive range bounds.',input_schema:{type:'object',properties:{}}},
  {name:'get_account_risk',description:'Demo account risk snapshot: balance, equity, used/free margin, margin level %, leverage, and every open position with entry, stop, current price, unrealized P&L and $ risk-to-stop.',input_schema:{type:'object',properties:{}}},
  {name:'get_journal_stats',description:'Closed-trade journal edge metrics: number of trades, win rate, expectancy per trade, profit factor, average win/loss.',input_schema:{type:'object',properties:{}}},
  {name:'run_backtest',description:'Run the currently selected strategy over the loaded data and return net return, win rate, profit factor, max drawdown, expectancy, and in/out-of-sample R. Optionally set round-trip cost in basis points.',input_schema:{type:'object',properties:{cost_bps:{type:'number'}}}},
  {name:'position_size',description:'Compute a risk-based position size from the demo balance. Returns dollars risked, units, and USD notional.',input_schema:{type:'object',properties:{risk_pct:{type:'number'},entry:{type:'number'},stop:{type:'number'}},required:['risk_pct','entry','stop']}},
  {name:'get_session_memory',description:'What the user has done this session: recently viewed symbols, trades taken (open/close with P&L), and notable events (fired alerts). Use it for continuity across the conversation.',input_schema:{type:'object',properties:{}}},
  {name:'get_portfolio_risk',description:'Portfolio-level risk over the ACTUAL open demo positions: 1-day 95% VaR and CVaR in USD and % of equity, gross/net exposure, portfolio heat (total risk-to-stops), pairwise correlations, and crowding warnings for correlated same-direction positions.',input_schema:{type:'object',properties:{}}}
];
function aiToolRun(name,input){try{input=input||{};
  if(name==='get_analysis'){const x=analystContext();const topAcc=x.acc?Object.entries(x.acc).filter(([,v])=>v!=null).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>({indicator:k,hit_rate_pct:+(v*100).toFixed(0)})):null;return {symbol:x.sym,timeframe:x.tf,price:x.price,live_data:x.live,consensus:{label:x.con.label,score:x.con.score,confidence_pct:x.con.confidence,indicators:x.con.votes.length,tuned_to_history:x.con.tuned,by_category:x.con.byCat},most_reliable_indicators_here:topAcc,confluence:x.rep.label,trend:x.trend,regime:x.reg.regime,rsi:+x.rsi.toFixed(0),adx:+x.adx.toFixed(0),atr_pct:+(x.atr/x.price*100).toFixed(2),patterns:x.pats}}
  if(name==='get_levels'){const x=analystContext();const near=x.fib?x.fib.levels.reduce((a,b)=>Math.abs(b.price-x.price)<Math.abs(a.price-x.price)?b:a):null;return {vwap:x.vwap,pdh:x.L.pdh,pdl:x.L.pdl,nearest_fib:near?{pct:+(near.r*100).toFixed(1),price:near.price}:null,predictive_range:x.pr?{low:x.pr.l1[x.pr.l1.length-1],high:x.pr.u1[x.pr.u1.length-1]}:null}}
  if(name==='get_account_risk'){const px=curPrice();return {balance:+PAPER.bal.toFixed(2),equity:+(PAPER.bal+unrealized()).toFixed(2),used_margin:+usedMargin().toFixed(2),free_margin:+freeMargin().toFixed(2),margin_level_pct:+marginLevel().toFixed(0),leverage:PAPER.leverage,open_positions:PAPER.pos.map(p=>({symbol:p.sym,side:p.side>0?'long':'short',qty:p.qty,entry:p.entry,stop:p.sl,current:px,unrealized:+((px-p.entry)*p.side*p.qty).toFixed(2),risk_to_stop_usd:+(Math.abs(p.entry-(p.sl||p.entry))*p.qty).toFixed(2)}))}}
  if(name==='get_journal_stats'){const h=PAPER.hist;if(!h.length)return {trades:0,note:'no closed trades yet'};const w=h.filter(t=>t.pl>0),l=h.filter(t=>t.pl<=0),gp=w.reduce((a,t)=>a+t.pl,0),gl=-l.reduce((a,t)=>a+t.pl,0);return {trades:h.length,win_rate_pct:+(w.length/h.length*100).toFixed(0),expectancy_per_trade:+((gp-gl)/h.length).toFixed(2),profit_factor:gl>0?+(gp/gl).toFixed(2):null,avg_win:+(w.length?gp/w.length:0).toFixed(2),avg_loss:+(l.length?gl/l.length:0).toFixed(2)}}
  if(name==='run_backtest'){const sel=document.getElementById('stratSel');if(!sel||!sel.value)return {error:'no strategy selected in the Strategy Tester'};if(input.cost_bps!=null){const bc=document.getElementById('btCost');if(bc)bc.value=input.cost_bps}runBacktest();const stats={};document.querySelectorAll('#btStats .stat').forEach(s=>{const k=s.querySelector('.k'),v=s.querySelector('.v');if(k&&v)stats[k.textContent]=v.textContent});return {strategy:sel.value,stats}}
  if(name==='position_size'){const per=Math.abs(input.entry-input.stop),dollars=PAPER.bal*(+input.risk_pct)/100,units=per>0?dollars/per:0;return {risk_usd:+dollars.toFixed(2),units:+units.toFixed(4),notional_usd:+(units*input.entry).toFixed(2)}}
  if(name==='get_session_memory'){const m=SESSION_MEM;return {session_minutes:Math.round((Date.now()-m.started)/60000),recent_symbols:m.symbols.slice(-8),trades:m.trades.slice(-10),recent_events:m.events.slice(-8).map(e=>e.txt),current:{symbol:CURSYM.sym,timeframe:TF}}}
  if(name==='get_portfolio_risk'){const r=portfolioRisk();return r||{positions:0,note:'no open positions — nothing at risk'}}
  }catch(e){return {error:String(e&&e.message||e)}}
  return {error:'unknown tool '+name};
}
async function proxyAgent(system,messages,tools){const base=proxyBase();if(!base)throw new Error('no proxy URL set');const r=await fetch(base+'/ai',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({system,messages,tools})});const j=await r.json();if(j.error)throw new Error(j.error);return j}
async function runAgent(question,onStep,extraContent){
  const system="You are a professional trading-desk and risk analyst for the Mishel Intelligence Trading terminal. Ground EVERY quantitative claim in the tools — call them to read the terminal's real current numbers, never invent values. Use get_session_memory for continuity. When the user asks about a trade or risk, check get_account_risk and get_analysis. Be concise and specific, cover bias/levels/risk when relevant, and never give financial advice or promise outcomes — describe scenarios and let the user decide.";
  let messages=[...AI_MSGS,{role:'user',content:extraContent?[...extraContent,{type:'text',text:question}]:question}];
  for(let step=0;step<6;step++){
    const res=await proxyAgent(system,messages,AI_TOOLS);
    messages.push({role:'assistant',content:res.content});
    if(res.stop_reason==='tool_use'){
      const results=[];
      for(const b of res.content){if(b.type==='tool_use'){if(onStep)onStep('· running '+b.name+'…');const out=aiToolRun(b.name,b.input);results.push({type:'tool_result',tool_use_id:b.id,content:JSON.stringify(out)})}}
      messages.push({role:'user',content:results});continue;
    }
    const txt=(res.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    AI_MSGS=messages;if(AI_MSGS.length>24)AI_MSGS=AI_MSGS.slice(-24);
    return txt||'(no answer)';
  }
  return "Reached the reasoning-step limit before finishing.";
}
async function askAnalyst(q){
  q=(q||'').trim();if(!q)return;AI_LOG.push({role:'user',text:q});renderAiChat();
  const useLLM=document.getElementById('aiUseLLM')&&document.getElementById('aiUseLLM').checked,st=document.getElementById('aiStatus');
  if(useLLM&&proxyBase()){
    if(st)st.textContent='thinking (agent)…';AI_LOG.push({role:'ai',text:'…'});renderAiChat();
    try{const txt=await runAgent(q,s=>{if(st)st.textContent=s});AI_LOG[AI_LOG.length-1]={role:'ai',text:txt};if(st)st.textContent='answered via LLM agent (proxy)'}
    catch(e){AI_LOG[AI_LOG.length-1]={role:'ai',text:deskAnalyst(q)+'\n\n_(LLM unavailable: '+e.message+' — used the built-in analyst.)_'};if(st)st.textContent='built-in (LLM error)'}
  } else {AI_LOG.push({role:'ai',text:deskAnalyst(q)});if(st)st.textContent=useLLM?'set a proxy URL in Settings to use the LLM — used built-in':'built-in analyst'}
  renderAiChat();
}
{const s=document.getElementById('aiSend');if(s)s.onclick=()=>{const inp=document.getElementById('aiInput');askAnalyst(inp.value);inp.value=''}}
{const inp=document.getElementById('aiInput');if(inp)inp.addEventListener('keydown',e=>{if(e.key==='Enter'){askAnalyst(inp.value);inp.value=''}})}
document.querySelectorAll('.aiq').forEach(b=>b.onclick=()=>askAnalyst(b.dataset.q));
function chartImageB64(){try{return document.getElementById('chart').toDataURL('image/png').split(',')[1]}catch(e){return null}}
async function askAnalystImage(){
  const useLLM=document.getElementById('aiUseLLM')&&document.getElementById('aiUseLLM').checked;
  if(!(useLLM&&proxyBase())){AI_LOG.push({role:'user',text:' [chart image]'});AI_LOG.push({role:'ai',text:'Chart-image analysis needs the LLM: enable **Use LLM via proxy** and set a proxy URL, so the vision model can read the rendered chart. Offline, just ask in words — I read the underlying data directly.'});renderAiChat();return}
  const img=chartImageB64();if(!img){AI_LOG.push({role:'ai',text:'Could not capture the chart image (open the Chart view first).'});renderAiChat();return}
  const q='Analyze this chart image: trend/structure, key levels, notable patterns, and what to watch next.';
  AI_LOG.push({role:'user',text:' '+q});AI_LOG.push({role:'ai',text:'…'});renderAiChat();
  const st=document.getElementById('aiStatus');if(st)st.textContent='vision analysis…';
  try{const txt=await runAgent(q,s=>{if(st)st.textContent=s},[{type:'image',source:{type:'base64',media_type:'image/png',data:img}}]);AI_LOG[AI_LOG.length-1]={role:'ai',text:txt};if(st)st.textContent='answered via vision LLM'}
  catch(e){AI_LOG[AI_LOG.length-1]={role:'ai',text:'Vision error: '+e.message};if(st)st.textContent='vision error'}
  renderAiChat();
}
{const b=document.getElementById('aiImg');if(b)b.onclick=askAnalystImage}
/* ---------- voice: listen (TTS) and talk (speech-to-text) ---------- */

/* ================= v39.18 LIVE DECISION (calls the standalone Python engine) ================= */
async function decideNow(outId){
  var out=document.getElementById(typeof outId==='string'?outId:'decideOut'); if(!out) return;
  out.innerHTML='<span style="color:var(--muted2)">reading live state\u2026</span>';
  try{
    var x=analystContext();
    var mtf=[]; try{ var m=mtfMatrix(),W={'15m':0.7,'1H':1,'4H':1.4,'1D':1.8}; m.cols.forEach(function(c){ mtf.push({tf:c.tf,score:c.con.score,weight:W[c.tf]||1}); }); }catch(e){}
    var news=null; try{ var nx=(window._macroCal||[]).map(function(e){return Date.parse(e.t)}).filter(function(t){return isFinite(t)&&t>Date.now()}).sort(function(a,b){return a-b})[0]; if(nx)news=Math.round((nx-Date.now())/60000); }catch(e){}
    var of=window._ofRead||null;
    var acct={heat:(window._gov&&window._gov.heat)||0,open_risk:(window._gov&&window._gov.openRisk)||0,locked:(typeof PAPER!=='undefined'&&PAPER.locked)||false};
    var L=x.L||{}, levels={support:(L.pdl||L.ldnL||L.support||null),resistance:(L.pdh||L.ldnH||L.resistance||null)};
    var state={price:x.price,adx:x.adx,regime:(x.reg&&x.reg.regime)||'',
      confluence:{score:x.con.score,agree_pct:x.con.confidence},
      mtf:mtf, orderflow: of?{imbalance:of.imbalance,taker_buy:of.taker_buy}:null,
      news_min:news, levels:levels, account:acct};
    var base=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    var r=await fetch(base+'/svc/analyst',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state),signal:AbortSignal.timeout(5000)});
    var d=await r.json();
    if(!d.ok){ out.innerHTML='<span style="color:var(--bear)">engine error: '+(d.err||'unknown')+'</span>'; return; }
    renderDecision(out,d);
  }catch(e){
    out.innerHTML='<div style="color:var(--muted)">The decision engine runs on the local service (<b>mishel_service.py</b> on :8788). Start it and tap Analyze again \u2014 this read is computed in Python and grounded in your live numbers, never invented.</div>';
  }
}
function renderDecision(out,d){
  var dcls=d.direction>0?'up':d.direction<0?'dn':'';
  var gates=(d.gates||[]).map(function(g){return '<div style="display:flex;gap:8px;font-size:11px;margin:1px 0"><span style="color:'+(g.pass?'var(--bull)':'var(--bear)')+'">'+(g.pass?'\u2713':'\u2717')+'</span><span>'+g.name+' \u2014 <span style="color:var(--muted)">'+g.detail+'</span></span></div>';}).join('');
  var reasons=(d.reasons||[]).map(function(r){return '<li>'+r.driver+(r.points!=null?' <span style="color:var(--muted2)">('+(r.points>=0?'+':'')+r.points+' pts \u00b7 w'+r.weight+')</span>':'')+'</li>';}).join('');
  var inval=(d.invalidation||[]).map(function(i){return '<li>'+i+'</li>';}).join('');
  out.innerHTML=
    '<div style="display:flex;align-items:baseline;gap:12px;margin-bottom:8px"><div class="'+dcls+'" style="font-size:22px;font-weight:700">'+d.bias+'</div><div style="color:var(--muted);font-size:11px">conviction <b>'+d.conviction+'%</b> \u00b7 score '+(d.score>=0?'+':'')+d.score+' \u00b7 gates '+d.gates_passed+'/'+d.gates_total+'</div></div>'
    +'<div style="font-size:12px;margin-bottom:10px">'+d.posture+'</div>'
    +'<div style="margin-bottom:8px">'+gates+'</div>'
    +'<div style="font-size:10px;color:var(--muted2);letter-spacing:.06em;margin:8px 0 2px">WHY</div><ul style="margin:0 0 8px;padding-left:18px;font-size:11px">'+reasons+'</ul>'
    +'<div style="font-size:10px;color:var(--muted2);letter-spacing:.06em;margin:6px 0 2px">WHAT WOULD FLIP IT</div><ul style="margin:0 0 8px;padding-left:18px;font-size:11px">'+inval+'</ul>'
    +'<div style="font-size:9px;color:var(--muted2)">'+(d.note||'')+'</div>';
}
document.addEventListener('DOMContentLoaded',function(){ var b=document.getElementById('decideBtn'); if(b)b.onclick=decideNow; });
/* auto-refresh while the AI view is open (throttled) */
setInterval(function(){ try{ var v=document.getElementById('v-ai'); if(v&&v.classList.contains('on')&&document.getElementById('decideOut')&&!document.hidden) decideNow(); }catch(e){} }, 8000);
