function walletCompare(db,a,b){ /* D2: side-by-side */
  const ra=db[(a||'').toLowerCase()],rb=db[(b||'').toLowerCase()];if(!ra||!rb)return null;
  const now=Date.now();return {a:{addr:a,intel:walletIntel(ra,{now}),cats:ra.cats,tokens:(ra.tokens||[]).length},
    b:{addr:b,intel:walletIntel(rb,{now}),cats:rb.cats,tokens:(rb.tokens||[]).length}};}
/* ===== v28.0 D4: next-best-action (rule-based, glass box) ===== */
function nbaCompute(db,ctx){ctx=ctx||{};const rows=Object.values(db||{});const acts=[];
  const copyable=ctx.copyableCount||0,sa=ctx.saCount||0;
  let realConv=[];try{const rings={};(clusterDetect(db)||[]).forEach(c=>c.wallets.forEach(a=>rings[a.toLowerCase()]=1));
    realConv=(coHolding(db)||[]).filter(c=>c.wallets.filter(a=>rings[(a||'').toLowerCase()]).length<c.wallets.length/2)}catch(e){}
  let ringsN=0;try{ringsN=(clusterDetect(db)||[]).length}catch(e){}
  if(realConv.length)acts.push({p:1,txt:realConv.length+' token(s) show REAL convergence \u2014 independent smart wallets agree',act:'scout the top one',fn:'conv',data:realConv[0]});
  if(rows.length&&!sa&&!copyable)acts.push({p:2,txt:rows.length+' wallets but 0 earn S/A \u2014 your Solana single-token whales can\u2019t show cross-token skill',act:'\u26a1 run the EVM harvest',fn:'evm'});
  if(ringsN)acts.push({p:3,txt:ringsN+' sybil ring(s) detected \u2014 fake-crowd operators in your data',act:'review patterns panel',fn:'noop'});
  if(!rows.length)acts.push({p:0,txt:'Empty wallet database',act:'Mass Harvest after scanning a radar',fn:'evm'});
  acts.sort((a,b)=>a.p-b.p);return acts.slice(0,3);}
/* ===== E1: Action Queue ===== */
function aqLoad(){try{return JSON.parse(localStorage.getItem('mishel_actionq')||'[]')}catch(e){return[]}}
function aqSave(q){try{STORE.set('mishel_actionq',JSON.stringify(q.slice(0,30)))}catch(e){}}
function aqPush(kind,id,txt,data){const q=aqLoad();const k=kind+':'+id;if(q.some(x=>x.k===k))return false;
  q.unshift({k,kind,id,txt,data,t:Date.now()});aqSave(q);return true;}
/* ===== E3: daily diff ===== */
function dailyDiff(db,ctx){try{
  const snap={n:Object.keys(db||{}).length,sa:ctx.saCount||0,copy:ctx.copyableCount||0,t:Date.now()};
  const prev=JSON.parse(localStorage.getItem('mishel_lastvisit')||'null');
  localStorage.setItem('mishel_lastvisit',JSON.stringify(snap));
  if(!prev||Date.now()-prev.t<3600000)return null;
  const d=[];if(snap.n!==prev.n)d.push((snap.n>prev.n?'+':'')+(snap.n-prev.n)+' wallets');
  if(snap.sa!==prev.sa)d.push('S/A '+prev.sa+'\u2192'+snap.sa);
  if(snap.copy!==prev.copy)d.push('copyable '+prev.copy+'\u2192'+snap.copy);
  return d.length?{since:prev.t,changes:d}:null;}catch(e){return null}}
/* ===== E2: research pack \u2014 one consolidated decision view ===== */
/* ===== v33 M13: QUICK FUNDAMENTAL ANALYSIS \u2014 glass-box, per component, honest N/A ===== */
function qfaScore(d){ /* d: {mc,fdv,vol24,liq,ageDays,rugFlags,holdersTop10,holderCount,smartCount,buys,sells} */
  const C=[];const add=(name,pts,max,why)=>C.push({name,pts:Math.max(0,Math.min(max,Math.round(pts))),max,why});
  /* valuation 25 */
  if(d.mc&&d.fdv){const dil=d.fdv/d.mc;add('dilution',dil<1.2?15:dil<2?10:dil<4?5:0,15,'FDV '+dil.toFixed(1)+'\u00d7 MC'+(dil>=2?' \u2014 heavy unlock overhang':''));}
  else add('dilution',7,15,'MC/FDV unavailable \u2014 neutral');
  if(d.mc&&d.vol24!=null){const vm=d.vol24/d.mc;add('real usage',vm>0.15?10:vm>0.03?6:vm>0.005?3:0,10,'vol/MC '+(vm*100).toFixed(1)+'%'+(vm<=0.005?' \u2014 ghost town':''));}
  else add('real usage',4,10,'volume unavailable');
  /* liquidity 20 */
  if(d.liq!=null&&d.mc){const lm=d.liq/d.mc;add('depth',lm>0.08?12:lm>0.02?8:lm>0.005?4:0,12,'liq '+(lm*100).toFixed(1)+'% of MC');}
  else add('depth',5,12,'liquidity unavailable');
  add('exit feasibility',d.liq==null?3:d.liq>2e5?8:d.liq>3e4?5:1,8,d.liq==null?'unknown':('~$10k order '+(d.liq>2e5?'clean':d.liq>3e4?'noticeable slippage':'moves the pool')));
  /* holders 25 */
  if(d.holdersTop10!=null)add('concentration',d.holdersTop10<25?15:d.holdersTop10<45?9:d.holdersTop10<70?4:0,15,'top-10 hold '+d.holdersTop10.toFixed(0)+'%');
  else add('concentration',6,15,'holder split unavailable');
  add('holder base',d.holderCount==null?4:d.holderCount>5000?10:d.holderCount>500?6:2,10,d.holderCount==null?'unknown':d.holderCount.toLocaleString()+' holders');
  /* contract 20 */
  const rf=(d.rugFlags||[]).length;add('contract safety',rf===0?14:rf===1?7:0,14,rf?rf+' risk flag(s): '+(d.rugFlags||[]).slice(0,2).join(', '):'no flags from the security screen');
  add('maturity',d.ageDays==null?3:d.ageDays>180?6:d.ageDays>30?4:1,6,d.ageDays==null?'age unknown':Math.round(d.ageDays)+' days old');
  /* flow & smart context 10 */
  if(d.buys!=null&&d.sells!=null){const r2=d.sells?d.buys/d.sells:2;add('flow balance',r2>1.1?5:r2>0.8?3:1,5,'buys/sells '+r2.toFixed(2));}else add('flow balance',2,5,'flow unavailable');
  add('smart presence',(d.smartCount||0)>=3?5:(d.smartCount||0)>=1?3:0,5,(d.smartCount||0)+' of your tracked wallets in it');
  const total=C.reduce((a,b)=>a+b.pts,0),max=C.reduce((a,b)=>a+b.max,0);
  const score=Math.round(total/max*100);
  const dil=(d.mc&&d.fdv)?d.fdv/d.mc:null;
  const verdict=score>=70?'SOUND':dil!=null&&dil>=3?'DILUTED':(d.rugFlags||[]).length>=2||((d.holdersTop10||0)>70)?'FRAGILE':score<40?'HOLLOW':'MIXED';
  const threat=C.slice().sort((a,b)=>(a.pts/a.max)-(b.pts/b.max))[0];
  return {score,verdict,components:C,threat:threat?threat.name+': '+threat.why:null};}
/* ===== M5: entity labels \u2014 typed chips wherever an address appears ===== */
function labelChip(addr){try{const n=walletNick(addr)||{};if(!n.nick&&!n.type)return null;
  const COLS={whale:'#4C82FB',fund:'#2DBE8E',deployer:'#F0616D',mm:'#E8A33D',exchange:'#9B8CFF'};
  const c2=COLS[(n.type||'').toLowerCase()]||'var(--muted)';
  return '<span class="pill sem" style="border-color:'+c2+';color:'+c2+';font-size:8.5px;padding:0 6px" title="your label ('+(n.type||'untyped')+')">'+_memeEsc((n.type||'').toUpperCase()+(n.type&&n.nick?' \u00b7 ':'')+(n.nick||''))+'</span>'}catch(e){return null}}
window.qfaScore=qfaScore;window.labelChip=labelChip;
async function researchPack(addr,chain){
  let m=document.getElementById('packModal');
  if(!m){m=document.createElement('div');m.id='packModal';
    m.style.cssText='position:fixed;inset:0;z-index:720;background:rgba(4,6,10,.6);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;backdrop-filter:blur(3px)';
    m.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;max-width:640px;width:100%;max-height:82vh;overflow:auto;padding:16px 18px" id="packBody"></div>';
    m.onclick=e=>{if(e.target===m)m.style.display='none'};document.body.appendChild(m);}
  m.style.display='flex';const b=document.getElementById('packBody');
  b.innerHTML='<div style="font-size:12px;color:var(--muted2)">\u{1F4E6} building research pack for <span class="mono">'+_memeEsc(shortAddr(addr))+'</span> ('+_memeEsc(chain)+')\u2026 real fetches, honest waits.</div>';
  let sd=null;try{sd=await fetchScoutData(addr,chain)}catch(e){}
  const db=wdbLoad();let smw=[];try{smw=tokenSmartMoney(db,addr)}catch(e){}
  let v={stance:'RESEARCH',col:'var(--gold)',conviction:50,confidence:'thin',pros:[],flags:['no market data fetched']};
  try{if(sd&&sd.market)v=tokenVerdict({liq:sd.market.liq,vol24:sd.market.vol24,chg24:sd.market.chg24,buys:sd.market.buys,sells:sd.market.sells,ageDays:sd.market.ageDays,rug:sd.rugLabel,smartCount:smw.length})}catch(e){}
  const row=(k,val)=>'<div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px dashed color-mix(in srgb,var(--edge) 40%,transparent);font-size:11px"><span style="color:var(--muted2)">'+k+'</span><span class="mono" style="color:var(--txt);text-align:right">'+val+'</span></div>';
  b.innerHTML='<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><span style="font-size:15px;font-weight:800">\u{1F4E6} Research Pack</span><span class="mono" style="font-size:11px;color:var(--muted2)">'+_memeEsc(shortAddr(addr))+' \u00b7 '+_memeEsc(chain)+'</span><button class="tbtn" style="margin-left:auto" onclick="document.getElementById(\'packModal\').style.display=\'none\'">\u2715</button></div>'
    +'<div style="border:1.5px solid '+v.col+';border-radius:11px;padding:10px 13px;margin-bottom:10px"><div style="font-size:17px;font-weight:800;color:'+v.col+'">'+v.stance+' <span style="font-size:11px;color:var(--muted2);font-weight:600">conviction '+v.conviction+' \u00b7 '+v.confidence+' data</span></div>'
    +'<div style="font-size:10.5px;color:var(--muted);margin-top:4px">'+(v.pros||[]).map(x=>'\u2713 '+_memeEsc(x)).join('<br>')+((v.flags||[]).length?'<br>'+(v.flags||[]).map(x=>'\u26a0 '+_memeEsc(x)).join('<br>'):'')+'</div></div>'
    +(function(){try{ /* M13: QFA hero */
      var mk=(sd&&sd.market)||{};var q=qfaScore({mc:+mk.mc||null,fdv:+mk.fdv||null,vol24:+mk.vol24||null,liq:+mk.liq||null,ageDays:mk.ageDays,rugFlags:(sd&&sd.rugFlags)||((sd&&sd.rugLabel&&/risk|honeypot|danger/i.test(sd.rugLabel))?[sd.rugLabel]:[]),holdersTop10:sd&&sd.top10Pct,holderCount:sd&&sd.holderCount,smartCount:smw.length,buys:mk.buys,sells:mk.sells});
      var vc={SOUND:'var(--fav)',MIXED:'var(--neut)',DILUTED:'var(--unfav)',FRAGILE:'var(--bear)',HOLLOW:'var(--bear)'}[q.verdict];
      return '<div style="border:1px solid '+vc+';border-radius:11px;padding:10px 13px;margin-bottom:10px"><div style="display:flex;align-items:baseline;gap:10px"><span style="font-size:11px;color:var(--muted2);font-weight:700">\u26a1 FUNDAMENTALS</span><b style="font-size:20px;color:'+vc+'">'+q.verdict+'</b><span class="mono" style="font-size:12px;color:var(--muted)">'+q.score+'/100</span></div>'
        +'<div style="font-size:9.5px;color:var(--muted);margin-top:5px;line-height:1.7">'+q.components.map(function(c3){return '<span style="white-space:nowrap;margin-right:10px">'+c3.name+' <b>'+c3.pts+'/'+c3.max+'</b></span>'}).join('')+'</div>'
        +(q.threat?'<div style="font-size:9.5px;color:var(--unfav);margin-top:4px">\u26a0 biggest threat \u2014 '+_memeEsc(q.threat)+'</div>':'')
        +'<div style="font-size:8.5px;color:var(--muted2);margin-top:4px">every component + weight shown \u00b7 structural soundness, never a buy signal</div></div>';
    }catch(e){return ''}})()
    +(sd&&sd.market?row('liquidity','$'+(+sd.market.liq||0).toLocaleString())+row('24h volume','$'+(+sd.market.vol24||0).toLocaleString())+row('buys / sells',(sd.market.buys||0)+' / '+(sd.market.sells||0))+row('rug screen',_memeEsc(sd.rugLabel||'\u2014')):'<div style="font-size:10.5px;color:var(--muted2)">market data unavailable for this token \u2014 honest blank</div>')
    +row('smart wallets in it',smw.length?smw.length+' ('+smw.slice(0,3).map(w=>shortAddr(w.addr||w)).join(', ')+')':'0')
    +'<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">'
    +'<button class="tbtn pkscout" data-a="'+_memeEsc(addr)+'" data-c="'+_memeEsc(chain)+'">\u{1F3AF} full scout</button>'
    +'<button class="tbtn pkpin" data-a="'+_memeEsc(addr)+'">\u2605 pin + watch verdict</button>'
    +'<button class="tbtn pktrade" title="E4: to the chart \u2014 on-chain tokens aren\u2019t chartable pairs; this jumps to the chart for your own read">\u{1F4C8} to chart</button></div>'
    +'<div style="font-size:9px;color:var(--muted2);margin-top:10px">decision support with visible evidence \u2014 never a buy signal \u00b7 you decide \u00b7 nothing executes</div>';
  b.querySelectorAll('.pkscout').forEach(x=>x.onclick=()=>{const inp=document.getElementById('scAddr');if(inp)inp.value=x.dataset.a;const cs=document.getElementById('scChain');if(cs)try{cs.value=x.dataset.c}catch(e){}m.style.display='none';try{goView('onchain')}catch(e){}});
  b.querySelectorAll('.pkpin').forEach(x=>x.onclick=()=>{try{pinAdd('coin',x.dataset.a,{stance:v.stance,smartCount:smw.length});toast('\u2605 pinned \u2014 changes surface in the watch table & daily diff','var(--gold)')}catch(e){}});
  b.querySelectorAll('.pktrade').forEach(x=>x.onclick=()=>{m.style.display='none';try{goView('chart')}catch(e){}toast('on-chain token \u2014 not a chartable pair; chart is for your market read','var(--muted)')});
}
window.researchPack=researchPack;
function renderTierControls(filt,sortBy){ /* R5 filter + D3 sort */
  const fb=(v,l)=>'<button class="tbtn smtf" data-f="'+v+'" style="padding:2px 9px;font-size:10px'+(filt===v?';background:var(--accent,#5B8DEF);color:#fff':'')+'">'+l+'</button>';
  const sb=(v,l)=>'<button class="tbtn smsort" data-s="'+v+'" style="padding:2px 9px;font-size:10px'+(sortBy===v?';background:var(--accent,#5B8DEF);color:#fff':'')+'">'+l+'</button>';
  return '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:8px"><span style="font-size:9px;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em">show</span>'+fb('all','all')+fb('sa','S/A only')+fb('copy','copyable')+'<span style="width:1px;height:16px;background:var(--edge)"></span><span style="font-size:9px;color:var(--muted2);text-transform:uppercase;letter-spacing:.08em">sort</span>'+sb('score','tier')+sb('tokens','tokens')+sb('recency','recent')+'</div>';}
function renderThinHint(rows){ /* R4: honest guidance when the DB is thin/low-tier */
  const el=document.getElementById('smRank');if(!el)return;
  const solanaOnly=rows.length&&rows.every(x=>(x.r.chains||[]).every(c=>c==='solana'));
  const allSingle=rows.length&&rows.every(x=>(x.r.tokens||[]).length<=1);
  let tip='';
  if(allSingle||solanaOnly){tip='<div style="background:var(--gold-dim,rgba(232,163,61,.1));border:1px solid rgba(232,163,61,.35);border-radius:9px;padding:10px 12px;margin-top:10px;font-size:11px;line-height:1.6;color:var(--gold)"><b>Why your wallets score low:</b> they\'re '+(solanaOnly?'all Solana ':'')+'single-token '+(allSingle?'holders':'wallets')+' \u2014 the engine can\'t see cross-token skill or completed round-trips, so it honestly rates them C/D. <b>To surface copyable S/A wallets:</b> scan the Launch/Meme radars for <b>EVM tokens</b> (Base \u00b7 Arbitrum \u00b7 Ethereum) and Mass Harvest \u2014 there the wallet history, round-trips and cross-token behaviour are visible, which is what earns a high tier. This isn\'t a display bug; it\'s the honesty contract not inventing tiers the data can\'t support.</div>';}
  el.insertAdjacentHTML('beforeend',tip);}
function renderSmartDesk(){
  const db=wdbLoad();const rank=document.getElementById('smRank');if(!rank)return;
  const now=Date.now();let followed={};try{(loadWallets()||[]).forEach(w=>followed[(w.addr||'').toLowerCase()]=1)}catch(e){}
  const coMap={};try{coHolding(db).forEach(c=>c.wallets.forEach(a=>coMap[a]=(coMap[a]||0)+1))}catch(e){}
  /* R1: walletIntel gives tier + score + conf (fixes the undefined bug); attach DNA role + copyability (R3/D1) */
  let rows=Object.values(db).map(r=>{const s=walletIntel(r,{now,coHoldCount:coMap[r.addr]||0});
    let dna=null,copy=null;try{dna=walletDNA({events:[],holdings:[],rec:r,roundtrips:0,now});copy=walletCopyability(r,dna,{now,roundtrips:0})}catch(e){}
    return {r,s,dna,copy}});
  /* R5 tier filter */
  const filt=(window._smTierFilter||'all');
  const smartAll=rows.filter(x=>!x.s.risky&&x.s.score>0);
  window._smCounts={sa:smartAll.filter(x=>x.s.tier==='S'||x.s.tier==='A').length,copyable:smartAll.filter(x=>x.copy&&x.copy.stance==='COPYABLE').length};
  /* E1 producer: first-seen S/A wallets land in the queue */
  try{smartAll.forEach(x=>{if(x.s.tier==='S'||x.s.tier==='A')aqPush('sa',x.r.addr,'New '+x.s.tier+'-tier wallet '+shortAddr(x.r.addr)+' \u2014 review copyability',{addr:x.r.addr,chain:(x.r.chains||[])[0]||'ethereum'})})}catch(e){}
  let smart=smartAll;
  if(filt==='sa')smart=smartAll.filter(x=>x.s.tier==='S'||x.s.tier==='A');
  else if(filt==='copy')smart=smartAll.filter(x=>x.copy&&x.copy.stance==='COPYABLE');
  /* D3 sort */
  const sortBy=(window._smSort||'score');
  smart=smart.slice().sort((a,b)=>{if(sortBy==='tokens')return (b.r.tokens||[]).length-(a.r.tokens||[]).length;
    if(sortBy==='recency')return (b.r.last||0)-(a.r.last||0);return b.s.score-a.s.score}).slice(0,40);
  const risky=rows.filter(x=>x.s.risky).sort((a,b)=>((b.r.cats.risky||0)-(a.r.cats.risky||0))).slice(0,10);
  const _wireCtl=()=>{rank.querySelectorAll('.smtf').forEach(b=>b.onclick=()=>{window._smTierFilter=b.dataset.f;renderSmartDesk()});rank.querySelectorAll('.smsort').forEach(b=>b.onclick=()=>{window._smSort=b.dataset.s;renderSmartDesk()});};
  if(!smartAll.length&&!risky.length){rank.innerHTML=renderTierControls(filt,sortBy)+'<div style="font-size:11.5px;color:var(--muted2);line-height:1.6">Empty database \u2014 run the Wallet Scout on any token, or Mass Harvest after scanning the radars.</div>';_wireCtl();renderThinHint(rows);return}
  if(!smart.length){rank.innerHTML=renderTierControls(filt,sortBy)+'<div style="font-size:11.5px;color:var(--muted2);line-height:1.6">No wallets earn <b>'+(filt==='sa'?'S/A tier':'COPYABLE')+'</b> yet \u2014 honest, not a bug: your current wallets don\u2019t have the cross-token history that earns it. <button class="tbtn smtf" data-f="all" style="padding:2px 9px;font-size:10px">\u2190 show all</button> or use \u26a1 Get copyable wallets (EVM) above.</div>';_wireCtl();renderThinHint(rows);return}
  const row=(x,dn)=>{const r=x.r;const cats=Object.entries(r.cats||{}).map(([c,n])=>'<span class="pill'+(c==='risky'?' bear':'')+'" style="font-size:9px">'+c+(n>1?' \u00d7'+n:'')+'</span>').join(' ');
    const ex=explorerUrl(r.chains[0]||'ethereum',r.addr);
    const tierCol={S:'#3FB981',A:'#6fd08c',B:'var(--gold)',C:'var(--muted)',D:'var(--bear)'}[x.s.tier]||'var(--muted)';
    const flagPill=(r.flags&&r.flags.length)?' <span class="pill bear" style="font-size:8.5px" title="'+_memeEsc(r.flags.join(' \u00b7 '))+'">\u{1F3AD} pattern</span>':'';
    return '<tr>'
      +'<td style="padding:9px 8px"><div style="display:flex;align-items:center;gap:7px">'
        +'<span class="pill" style="font-weight:700;color:'+tierCol+';border-color:'+tierCol+';font-size:10px;min-width:34px;text-align:center" title="'+_memeEsc(x.s.parts.join(' \u00b7 '))+'">'+x.s.tier+' '+x.s.score+'</span>'
        +'<div style="line-height:1.3"><div class="mono" style="font-size:11.5px;color:'+(dn?'var(--bear)':'var(--txt)')+'">'+_memeEsc(shortAddr(r.addr))+(walletNick(r.addr)?' <b style="color:var(--gold)">'+_memeEsc(walletNick(r.addr).nick||'')+'</b>':'')+(followed[r.addr]?' <span class="up" style="font-size:9px">\u2605 tracked</span>':'')+'</div>'
        +(x.copy?'<span class="pill" style="font-size:8.5px;font-weight:700;color:'+(x.copy.stance==='COPYABLE'?'var(--bull)':x.copy.stance==='AVOID'?'var(--bear)':'var(--gold)')+';margin-left:2px" title="'+_memeEsc((x.copy.pros||[]).concat(x.copy.cons||[]).join(' \u00b7 '))+'">'+x.copy.stance+'</span>':'')
        +'</div>'
        +'<div style="font-size:9px;color:var(--muted2);margin-top:1px">'+(x.dna&&x.dna.role?'<b style="color:var(--muted)">'+_memeEsc(x.dna.role)+'</b> \u00b7 ':'')+cats+flagPill+' \u00b7 '+(r.tokens||[]).length+' token'+((r.tokens||[]).length===1?'':'s')+' \u00b7 '+x.s.conf+'% conf</div></div></div></td>'
      +'<td style="white-space:nowrap;text-align:left;padding:9px 8px;width:300px">'
        +'<button class="tbtn smcopy" data-a="'+_memeEsc(r.addr)+'" style="padding:2px 7px;font-size:10px" title="copy address">\u29c9</button> '
        +'<button class="tbtn smdoss" data-a="'+_memeEsc(r.addr)+'" data-c="'+(r.chains[0]||'ethereum')+'" style="padding:2px 9px;font-size:10px" title="full DNA dashboard: holdings + buys/sells">\u{1F4B0} dashboard</button> '
        +(dn?'<button class="tbtn smflag" data-a="'+_memeEsc(r.addr)+'" data-c="'+(r.chains[0]||'ethereum')+'" style="padding:2px 8px;font-size:10px">\u{1F6A9} flag</button>':'<button class="tbtn smfollow" data-a="'+_memeEsc(r.addr)+'" data-c="'+(r.chains[0]||'ethereum')+'" style="padding:2px 8px;font-size:10px" title="track = auto Telegram signals">\u2605 track</button>')+' '
        +'<button class="tbtn smnick" data-a="'+_memeEsc(r.addr)+'" style="padding:2px 6px;font-size:10px" title="nickname + note">\u270e</button>'
        +(ex?' <a href="'+ex+'" target="_blank" rel="noopener" style="font-size:11px" title="explorer">\u2197</a>':'')+'</td></tr>'};
  rank.innerHTML=renderTierControls(filt,sortBy)+'<table class="log smrank-tbl" style="border-collapse:collapse;width:100%;table-layout:fixed"><thead><tr><th style="padding:6px 8px;text-align:left">wallet \u00b7 tier \u00b7 copyability \u00b7 evidence</th><th style="text-align:left;padding:6px 8px;width:300px">actions</th></tr></thead><tbody>'
    +smart.map(x=>row(x,false)).join('')
    +(risky.length?('<tr><td colspan="2" style="padding:12px 8px 6px;color:var(--bear);font-size:10.5px;font-weight:700;border-top:1px solid var(--bear)">\u26a0 RISK WALLETS \u2014 excluded from smart rank</td></tr>'+risky.map(x=>row(x,true)).join('')):'')
    +'</tbody></table><div style="font-size:10px;color:var(--muted2);margin-top:6px">'+Object.keys(db).length+' wallets in your database \u00b7 behavioral evidence from public data \u00b7 hover a score for its full breakdown \u00b7 never an endorsement</div>';
  const co=document.getElementById('smCoHold');
  if(co){const cl=coHolding(db);
    let ringSet={};try{(clusterDetect(db)||[]).forEach(cl2=>cl2.wallets.forEach(a=>ringSet[a.toLowerCase()]=1))}catch(e){}
    co.innerHTML=cl.length?cl.map((c,ci)=>{
      const ringed=c.wallets.filter(a=>ringSet[(a||'').toLowerCase()]).length;
      const real=ringed<c.wallets.length/2;
      const verdict=real
        ?'<span class="pill" style="color:var(--bull);border-color:var(--bull);font-size:9px;font-weight:700">\u2713 REAL convergence</span> <span style="font-size:9.5px;color:var(--muted2)">'+(c.wallets.length-ringed)+' independent wallets hold this \u2014 worth a look, not a buy signal</span>'
        :'<span class="pill bear" style="font-size:9px;font-weight:700">\u26a0 LIKELY FAKE</span> <span style="font-size:9.5px;color:var(--muted2)">'+ringed+'/'+c.wallets.length+' wallets sit in a sybil ring \u2014 likely one operator faking a crowd; ignore</span>';
      return '<div style="border:1px solid '+(real?'var(--edge)':'color-mix(in srgb,var(--bear) 40%,var(--edge))')+';border-radius:8px;padding:7px 9px;margin-top:5px;font-size:10.5px">'
        +'<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><span class="mono" style="color:var(--txt)">'+_memeEsc(shortAddr(c.token))+'</span> <button class="tbtn cocopy" data-a="'+_memeEsc(c.token)+'" style="padding:0 5px;font-size:9px">\u29c9</button><span style="color:var(--muted2)">('+_memeEsc(c.chain||'?')+')</span> \u2014 <b class="up">'+c.wallets.length+' wallets</b>'
        +(real?' <button class="tbtn coscout" data-a="'+_memeEsc(c.token)+'" data-c="'+_memeEsc(c.chain||'ethereum')+'" style="padding:1px 8px;font-size:9.5px">scout \u25b7</button> <button class="tbtn copack" data-a="'+_memeEsc(c.token)+'" data-c="'+_memeEsc(c.chain||'ethereum')+'" style="padding:1px 8px;font-size:9.5px" title="E2: dossier + verdict + holders + rug in one consolidated view">\u{1F4E6} pack</button>':'')
        +'</div><div style="margin-top:4px">'+verdict+'</div>'
        +'<details style="margin-top:3px"><summary style="cursor:pointer;font-size:9px;color:var(--muted2)">wallets ('+c.wallets.length+')</summary><div style="margin-top:3px;display:flex;gap:4px;flex-wrap:wrap">'
        +c.wallets.map(a=>'<span class="codash" data-a="'+_memeEsc(a)+'" data-c="'+_memeEsc(c.chain||'ethereum')+'" style="cursor:pointer;font-size:9.5px;color:'+(ringSet[a.toLowerCase()]?'var(--bear)':'var(--accent,#5B8DEF)')+';text-decoration:underline" title="'+(ringSet[a.toLowerCase()]?'in a sybil ring':'open dashboard')+'">'+(labelChip(a)||'')+_memeEsc(shortAddr(a))+'</span>').join(' ')
        +'</div></details></div>';}).join('')
      +'<div class="ck-note" style="margin-top:6px">SO WHAT: REAL convergence = independent smart wallets agreeing \u2192 scout it. LIKELY FAKE = one operator\u2019s ring \u2192 ignore. <i>convergence = several wallets buying the same token; sybil ring = wallets that transfer among themselves.</i></div>'
      :'<span style="font-size:11px;color:var(--muted2)">Needs \u22652 wallets sharing a token.</span>';
    co.querySelectorAll('.cocopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1100)}catch(e){prompt('Copy:',b.dataset.a)}});
    co.querySelectorAll('.codash').forEach(el=>el.onclick=()=>{try{smWalletDossier(el.dataset.a,el.dataset.c)}catch(e){}});
    co.querySelectorAll('.coscout').forEach(b=>b.onclick=()=>{const inp=document.getElementById('scAddr');if(inp)inp.value=b.dataset.a;const cs=document.getElementById('scChain');if(cs)try{cs.value=b.dataset.c}catch(e){}try{goView('onchain')}catch(e){}toast('\u2192 loaded in scout','var(--accent)')});
    co.querySelectorAll('.copack').forEach(b=>b.onclick=()=>{try{researchPack(b.dataset.a,b.dataset.c)}catch(e){}});
  }
  const mp=document.getElementById('smManip');
  if(mp){const withFlags=Object.values(db).filter(r=>r.flags&&r.flags.length);
    const MEAN={'flip-flop':'bot-like churn \u2014 not human conviction; don\u2019t copy','circular':'transfers in a ring \u2014 wash/sybil behaviour; treat holdings as fake'};
    mp.innerHTML=withFlags.length?
      '<div style="font-size:10px;color:var(--bear);font-weight:700;margin-top:2px">'+withFlags.length+' wallets show wash-like patterns \u2014 all excluded from the smart rank automatically.</div>'
      +withFlags.slice(0,8).map(r=>{const key=/circular/.test((r.flags||[]).join(' '))?'circular':'flip-flop';
        return '<div style="border:1px solid var(--edge);border-radius:8px;padding:6px 9px;margin-top:5px;font-size:10px"><div style="display:flex;gap:6px;align-items:center"><span class="mono" style="color:var(--bear)">'+_memeEsc(shortAddr(r.addr))+'</span><span style="color:var(--muted2)">'+_memeEsc((r.flags||[])[0]||'')+'</span><button class="tbtn mpflag" data-a="'+_memeEsc(r.addr)+'" data-c="'+_memeEsc((r.chains||[])[0]||'ethereum')+'" style="margin-left:auto;padding:1px 7px;font-size:9px">\u{1F6A9} flag deployer-list</button></div><div style="font-size:9px;color:var(--muted2);margin-top:2px">= '+MEAN[key]+'</div></div>'}).join('')
      +'<div class="ck-note" style="margin-top:6px">SO WHAT: these are named patterns in sampled transfers \u2014 evidence shown, never an accusation. They already can\u2019t pollute your ranking; flag ones you want remembered as deployers.</div>'
      :'<span style="font-size:11px;color:var(--muted2)">No wash-like patterns in the sampled data yet.</span>';
    mp.querySelectorAll('.mpflag').forEach(b=>b.onclick=()=>{try{markRugger(b.dataset.a,b.dataset.c,'','pattern-flagged from Smart Money');toast('\u{1F6A9} remembered in the rugpuller registry','var(--bear)')}catch(e){}});
  }
  rank.querySelectorAll('.smcopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1100)}catch(e){prompt('Copy:',b.dataset.a)}});
  rank.querySelectorAll('.smfollow').forEach(b=>b.onclick=()=>{const a=b.dataset.a,ch=b.dataset.c;
    const inp=document.getElementById('ocWalletAddr');if(inp)inp.value=a;
    try{const ws=loadWallets();if(!ws.some(w=>(w.addr||'').toLowerCase()===a.toLowerCase())){ws.push({addr:a,chain:ch,label:'smart desk'});saveWallets(ws);renderWalletList()}}catch(e){}
    try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
      var rc=(wdbLoad()||{})[a.toLowerCase()]||{};var dnaSnap=null;
      try{var dd=walletDNA({events:[],holdings:[],rec:rc,roundtrips:0,now:Date.now()});dnaSnap={nick:(walletNick(a)||{}).nick||'',role:dd.role,style:dd.style.style,risk:dd.risk.band}}catch(e){}
      fetch(sb+'/svc/onchain/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:a,chain:ch,min_usd:10000,dna:dnaSnap}),signal:AbortSignal.timeout(3000)})
        .then(r=>toast(r.ok?'\u2605 Tracking \u2014 DNA sent to Telegram; you\'ll now get its buys, sells, flips & rug-moves automatically':'\u2605 Tracking locally \u2014 service refused','var(--gold)'))
        .catch(()=>toast('\u2605 Tracking locally \u2014 start mishel_service for auto Telegram decisions','var(--gold)'));}catch(e){}
    renderSmartDesk();});
  rank.querySelectorAll('.smflag').forEach(b=>b.onclick=()=>{try{markRugger(b.dataset.a,b.dataset.c,'','flagged from Smart Money Desk');toast('\u{1F6A9} flagged','#F0616D');renderRuggerList()}catch(e){}});
  rank.querySelectorAll('.smdoss').forEach(b=>b.onclick=()=>smWalletDossier(b.dataset.a,b.dataset.c));
  rank.querySelectorAll('.smtf').forEach(b=>b.onclick=()=>{window._smTierFilter=b.dataset.f;renderSmartDesk()});
  rank.querySelectorAll('.smsort').forEach(b=>b.onclick=()=>{window._smSort=b.dataset.s;renderSmartDesk()});
  rank.querySelectorAll('.smnick').forEach(b=>b.onclick=()=>{const cur=walletNick(b.dataset.a)||{};
    const nk=prompt('Nickname for '+shortAddr(b.dataset.a)+':',cur.nick||'');if(nk===null)return;
    const ty=prompt('Type (whale / fund / deployer / mm / exchange \u2014 optional):',cur.type||'');
    const nt=prompt('Private note (optional):',cur.note||'');setWalletNick(b.dataset.a,nk,nt||'');
    try{const m5=JSON.parse(localStorage.getItem('mishel_wnick')||'{}');const k5=b.dataset.a.toLowerCase();if(m5[k5]){m5[k5].type=(ty||'').trim();STORE.set('mishel_wnick',JSON.stringify(m5))}}catch(e){}
    renderSmartDesk();});
  try{renderClusters(db);renderLeaderboard();renderMomentum(db);renderEarlyRadar(db);renderOpportunities(db);renderNBA(db);renderQueue();renderDiff(db);renderWatch(db);}catch(e){}}
