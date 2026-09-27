function renderLaunchRows(rows){
  const body=document.getElementById('launchBody');if(!body)return;
  body.innerHTML=rows.map((r,i)=>{const [al,ac]=launchBand(r.ageH);const [rl,rc]=rugBand(r._rug.score);const chg=+r.chg24||0;
    const bl=buyLinks(r.chain,r.addr)[0];
    return `<tr title="${_memeEsc(r._rug.notes.join(' \u00b7 ')||'DexScreener metrics only')}"><td><b>${_memeEsc(r.sym)}</b> <span style="color:var(--muted2);font-size:10px">${_memeEsc((r.name||'').slice(0,14))}</span><div style="margin-top:2px"><span class="mono" style="font-size:9px;color:var(--muted2)">${_memeEsc(shortAddr(r.addr))}</span> <button class="tbtn lcopy" data-a="${_memeEsc(r.addr)}" title="copy full contract address" style="padding:0 5px;font-size:9px">\u29c9</button></div></td><td style="font-size:10px;color:var(--muted)">${_memeEsc(r.chain)}</td><td><span class="pill ${ac}">${al}</span></td><td class="mono">${fmtUsd(r.liq)}</td><td class="mono">${fmtUsd(r.vol24)}</td><td class="mono ${chg>=0?'up':'dn'}">${chg>=0?'+':''}${chg.toFixed(0)}%</td><td><span class="pill ${rc}">${rl} ${r._rug.score}</span></td><td style="white-space:nowrap">${r.url?`<a href="${_memeEsc(r.url)}" target="_blank" rel="noopener" style="font-size:10px">chart\u2197</a>`:'\u2014'} ${bl?`<a href="${bl.url}" target="_blank" rel="noopener" style="font-size:10px">${bl.name}\u2197</a>`:''} <button class="tbtn ldoss" data-i="${i}" title="run the full safety dossier on this token" style="padding:1px 6px;font-size:9px">\ud83d\udd0e</button></td></tr>`;
  }).join('');
  body.querySelectorAll('.lcopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1100)}catch(e){prompt('Copy contract address:',b.dataset.a)}});
  body.querySelectorAll('.ldoss').forEach(b=>b.onclick=()=>{const r=(window._launchRows||[])[+b.dataset.i];if(!r)return;
    const ai=document.getElementById('dossierAddr'),ci=document.getElementById('dossierChain');
    if(ai)ai.value=r.addr;if(ci){try{ci.value=r.chain}catch(e){}}
    try{buildDossier()}catch(e){}
    const out=document.getElementById('dossierOut');if(out)out.scrollIntoView({behavior:'smooth',block:'center'});});
}

/* ---------- Whale / Holder Tracker ---------- */
/* ================= v15.4 AI DESK + INFRA PACK — confluence narration · morning brief · MTF vision · Kraken/Coinbase failover ================= */
/* -- pure logic (unit-tested) -- */
function narrateConfluence(con,ck){ /* deterministic ordered narration of the read — no LLM, no invented claims */
  const L=[];if(!con)return['No consensus available \u2014 load data first.'];
  const dir=con.score>8?'bullish':con.score<-8?'bearish':'neutral';
  L.push('1. Consensus is '+con.label+' at '+(con.score>=0?'+':'')+con.score+'/100 with '+con.confidence+'% of '+((con.votes||[]).length)+' indicators agreeing \u2014 the read is '+dir+'.');
  if(con.byCat){const c=con.byCat;const lead=Object.entries({trend:c.trend,momentum:c.momentum,volume:c.volume}).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1]))[0];
    L.push('2. The strongest category is '+lead[0]+' ('+(lead[1]>=0?'+':'')+lead[1]+'); '+(Math.sign(c.trend)===Math.sign(c.momentum)&&c.trend!==0?'trend and momentum agree \u2014 cleaner signal.':'trend and momentum disagree \u2014 expect chop.'));}
  if(ck&&ck.items){L.push('3. Objectivity gates: '+ck.passed+'/'+ck.total+' pass.');
    ck.items.filter(i=>!i.pass).slice(0,3).forEach((i,k)=>L.push('   \u2717 failing: '+i.txt));}
  L.push((ck&&ck.passed>=4)?'4. Verdict: conditions are disciplined \u2014 if you take it, size to plan and place the stop first.':
    (ck&&ck.passed<=2)?'4. Verdict: this would be an emotional entry \u2014 the honest move is to stand aside.':
    '4. Verdict: mixed \u2014 only proceed if the failing gates are acceptable in your written plan.');
  return L;
}
function buildMorningBrief(ctx){ /* ctx: {sym,tf,price,con,regime,session,levels:{above,below},journal} — deterministic text */
  ctx=ctx||{};const f=[];const c=ctx.con||{};
  f.push('\u2600\ufe0e MORNING BRIEF \u2014 '+(ctx.sym||'?')+' \u00b7 '+(ctx.tf||'?')+' \u00b7 '+new Date().toISOString().slice(0,10));
  if(ctx.price!=null)f.push('Price '+ctx.price+' \u00b7 regime '+(ctx.regime||'?')+' \u00b7 session '+(ctx.session||'?'));
  if(c.label)f.push('Consensus: '+c.label+' ('+(c.score>=0?'+':'')+(c.score||0)+', '+(c.confidence||0)+'% agree)');
  if(ctx.levels){const up=(ctx.levels.above||[]).slice(0,2).map(l=>l.name+' '+l.p).join(' / ');const dn=(ctx.levels.below||[]).slice(0,2).map(l=>l.name+' '+l.p).join(' / ');
    if(up)f.push('Overhead: '+up);if(dn)f.push('Support: '+dn);}
  if(ctx.journal&&ctx.journal.trades>0)f.push('Your edge: '+ctx.journal.trades+' trades \u00b7 '+(ctx.journal.win_rate_pct||0)+'% wins \u00b7 expectancy $'+(ctx.journal.expectancy_per_trade!=null?(+ctx.journal.expectancy_per_trade).toFixed(2):'?'));
  f.push('\u2014 deterministic brief from live terminal state \u00b7 not advice \u00b7 you execute at your broker');
  return f.join('\n');
}
/* -- renders / actions -- */
function renderNarration(){
  const box=document.getElementById('narrOut');if(!box)return;
  try{const x=analystContext();const lines=narrateConfluence(x.con,tradeChecklist(x));
    box.innerHTML=lines.map(l=>'<div style="font-size:11.5px;padding:2px 0;color:'+(/\u2717/.test(l)?'var(--bear)':/Verdict/.test(l)?'var(--txt)':'var(--muted)')+'">'+_memeEsc(l)+'</div>').join('')
    +'<div style="font-size:10px;color:var(--muted2);margin-top:6px">Deterministic narration of the live consensus \u2014 same numbers, spoken in order. No LLM.</div>';
  }catch(e){box.innerHTML='<span style="color:var(--muted)">Load a chart first.</span>'}
}
async function showMorningBrief(sendTg){
  const box=document.getElementById('briefOut');if(!box)return;
  let txt;try{const x=analystContext();const lad=levelLadder(x);const j=aiToolRun('get_journal_stats',{});
    const h=new Date().getUTCHours();const sess=h<8?'Asia':h<13?'London':h<17?'London/NY overlap':h<22?'New York':'after-hours';
    txt=buildMorningBrief({sym:x.name,tf:x.tf,price:(+x.price).toFixed(x.dec),con:x.con,regime:(x.reg&&x.reg.regime)||'?',session:sess,
      levels:{above:(lad.above||[]).slice(0,2).map(l=>({name:l.name,p:(+l.p).toFixed(x.dec)})),below:(lad.below||[]).slice(0,2).map(l=>({name:l.name,p:(+l.p).toFixed(x.dec)}))},journal:j});
  }catch(e){box.innerHTML='<span style="color:var(--gold)">Could not assemble brief: '+_memeEsc((e&&e.message)||e)+'</span>';return}
  box.innerHTML='<pre style="white-space:pre-wrap;font-family:var(--mono);font-size:11px;background:var(--panel);border:1px solid var(--edge);border-radius:8px;padding:10px">'+_memeEsc(txt)+'</pre>';
  if(sendTg){try{const r=await fetch('http://127.0.0.1:8788/svc/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:txt}),signal:AbortSignal.timeout(4000)});
    const j=await r.json();toast(j.ok?'\u2713 Brief sent to Telegram via service':'Service replied but not ok','#2DBE8E');}
    catch(e){toast('Service offline \u2014 start mishel_service.py to send briefs to Telegram','#E8A33D')}}
}
async function mtfVisionRead(){
  const box=document.getElementById('mtfVisionOut');if(!box)return;
  const base=(typeof proxyBase==='function')?proxyBase():null;
  if(!base){box.innerHTML='<span style="color:var(--gold)">Needs the data proxy running with ANTHROPIC_API_KEY set server-side (Settings \u2192 Data sources). No key here = no fabricated \u201cvision read\u201d.</span>';return}
  box.innerHTML='Capturing chart + assembling multi-timeframe table\u2026';
  try{
    const cv=document.getElementById('chart')||document.querySelector('canvas');
    const img=cv?cv.toDataURL('image/png').split(',')[1]:null;
    const tfs=['1H','4H','1D'];const rows=tfs.map((t,i)=>{const dd=genData(300,CURSYM.px,1000+i*7);const cc=consensusSignal(dd);return t+': '+cc.label+' ('+(cc.score>=0?'+':'')+cc.score+')'});
    const q='You are a trading desk analyst. Here is the current chart image and the multi-timeframe consensus table:\n'+rows.join('\n')+'\nGive a short honest multi-timeframe read. If timeframes conflict, say so plainly. Do not invent levels not visible.';
    const out=await proxyAI(q,{image:img,mtf:rows});
    box.innerHTML='<div style="font-size:11.5px;line-height:1.55">'+aiMd(String(out||'').slice(0,4000))+'</div><div style="font-size:10px;color:var(--muted2);margin-top:6px">LLM read via your proxy \u00b7 offline MTF rows are synthetic-seeded until live data is connected \u2014 labeled honestly.</div>';
  }catch(e){box.innerHTML='<span style="color:var(--gold)">Vision read failed: '+_memeEsc((e&&e.message)||e)+' \u2014 nothing invented in its place.</span>'}
}
/* ================= v15.3 ANALYTICS PACK — correlation & lead-lag · meta-labeling gate · regime ribbon + feature store ================= */
/* -- pure logic (unit-tested) -- */
function pearson(a,b){const n=Math.min(a.length,b.length);if(n<3)return 0;let ma=0,mb=0;for(let i=0;i<n;i++){ma+=a[i];mb+=b[i]}ma/=n;mb/=n;
  let nu=0,da=0,db=0;for(let i=0;i<n;i++){nu+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)*(a[i]-ma);db+=(b[i]-mb)*(b[i]-mb)}
  return nu/Math.sqrt((da*db)||1e-12)}
function leadLagBest(a,b,maxLag){ /* returns {lag,corr}: lag>0 means A LEADS B by `lag` bars (a shifted forward matches b) */
  maxLag=maxLag||10;let best={lag:0,corr:pearson(a,b)};
  for(let L=1;L<=maxLag;L++){
    const cAB=pearson(a.slice(0,a.length-L),b.slice(L));      /* a leads b */
    const cBA=pearson(b.slice(0,b.length-L),a.slice(L));      /* b leads a */
    if(Math.abs(cAB)>Math.abs(best.corr))best={lag:L,corr:cAB};
    if(Math.abs(cBA)>Math.abs(best.corr))best={lag:-L,corr:cBA};}
  return best}
/* -- meta-labeling: a secondary logistic model decides WHICH primary signals to take (Lopez de Prado ch.3 idea, honest small version) -- */
function _sigm(z){return 1/(1+Math.exp(-Math.max(-30,Math.min(30,z))))}
function metaLabelFit(X,y,iters,lr){ /* X rows of features (with bias handled here), y 0/1 */
  iters=iters||400;lr=lr||0.1;if(!X.length||X.length!==y.length)return null;
  const d=X[0].length;let w=new Array(d+1).fill(0);
  for(let it=0;it<iters;it++){const g=new Array(d+1).fill(0);
    for(let i=0;i<X.length;i++){let z=w[0];for(let j=0;j<d;j++)z+=w[j+1]*X[i][j];const p=_sigm(z),e=p-y[i];
      g[0]+=e;for(let j=0;j<d;j++)g[j+1]+=e*X[i][j];}
    for(let j=0;j<=d;j++)w[j]-=lr*g[j]/X.length;}
  return {w:w,predict:function(x){let z=w[0];for(let j=0;j<x.length;j++)z+=w[j+1]*x[j];return _sigm(z)}}}
function _zNorm(X){ /* column z-score using TRAIN stats only; returns {Z, apply} */
  const d=X[0].length,mu=new Array(d).fill(0),sd=new Array(d).fill(0);
  X.forEach(r=>r.forEach((v,j)=>mu[j]+=v));mu.forEach((v,j)=>mu[j]=v/X.length);
  X.forEach(r=>r.forEach((v,j)=>sd[j]+=(v-mu[j])*(v-mu[j])));sd.forEach((v,j)=>sd[j]=Math.sqrt(v/X.length)||1);
  const ap=r=>r.map((v,j)=>(v-mu[j])/sd[j]);
  return {Z:X.map(ap),apply:ap}}
function metaLabelGate(feats,outcomes,split){ /* feats[i]=[...], outcomes[i]=R; chronological split; returns honest OOS report */
  const n=feats.length;if(n<30)return {ok:false,reason:'need \u226530 trades ('+n+' here) \u2014 a gate fitted on fewer would be noise'};
  split=split||0.7;const cut=Math.floor(n*split);
  const trX=feats.slice(0,cut),trY=outcomes.slice(0,cut).map(R=>R>0?1:0);
  const teX=feats.slice(cut),teR=outcomes.slice(cut);
  if(teX.length<8)return {ok:false,reason:'only '+teX.length+' out-of-sample trades \u2014 not enough to judge the gate'};
  const nz=_zNorm(trX);const model=metaLabelFit(nz.Z,trY);if(!model)return {ok:false,reason:'fit failed'};
  const pTe=teX.map(r=>model.predict(nz.apply(r)));
  const keep=[],skip=[];pTe.forEach((p,i)=>{(p>0.5?keep:skip).push(teR[i])});
  const stats=a=>{if(!a.length)return {n:0,wr:null,avgR:null,sumR:0};const w=a.filter(v=>v>0).length;
    return {n:a.length,wr:w/a.length,avgR:a.reduce((x,y)=>x+y,0)/a.length,sumR:a.reduce((x,y)=>x+y,0)}};
  const all=stats(teR),kept=stats(keep),skipped=stats(skip);
  const uplift=(kept.n&&all.avgR!=null&&kept.avgR!=null)?kept.avgR-all.avgR:null;
  return {ok:true,nTrain:cut,nTest:teR.length,all:all,kept:kept,skipped:skipped,uplift:uplift,
    verdict:kept.n===0?'Gate rejected every OOS trade \u2014 unusable as-is':
      (uplift!=null&&uplift>0.05&&kept.n>=5)?'Gate improved avg R out-of-sample \u2014 promising, forward-test it':
      (uplift!=null&&uplift<-0.05)?'Gate made things WORSE out-of-sample \u2014 the features carry no reliable filter signal here':
      'No meaningful OOS uplift \u2014 honest result: these features don\u2019t separate winners from losers on this data'};}
