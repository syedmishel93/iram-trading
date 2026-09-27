function renderWatch(db){const el=document.getElementById('smWatch');if(!el)return;
  const P=pinState();const keys=Object.keys(P);
  if(!keys.length){el.innerHTML='<span style="font-size:11px;color:var(--muted2)">Pin a token from a research pack (\u2605) and it\u2019s tracked here.</span>';return}
  el.innerHTML='<table class="log" style="width:100%"><thead><tr><th>item</th><th>pinned stance</th><th>tag</th><th>\u0394 since pinned</th><th></th></tr></thead><tbody>'
    +keys.slice(0,12).map(k=>{const x=P[k];const smNow=(function(){try{return tokenSmartMoney(db,x.id).length}catch(e){return null}})();
      const d=pinDiff(x.kind,x.id,{stance:(x.snap||{}).stance,smartCount:smNow!=null?smNow:(x.snap||{}).smartCount});
      return '<tr><td class="mono" style="font-size:10px">'+_memeEsc(shortAddrSafe(x.id))+'</td>'
        +'<td><span class="pill" style="font-size:9px">'+_memeEsc((x.snap||{}).stance||'\u2014')+'</span> <span style="font-size:8.5px;color:var(--muted2)">'+(d?d.sincePinned:'')+'</span></td>'
        +'<td><span class="wtag" data-k="'+_memeEsc(k)+'" style="cursor:pointer;font-size:9px;color:var(--gold)">'+_memeEsc(x.tag||'+ tag')+'</span></td>'
        +'<td style="font-size:9.5px;color:var(--muted2)">'+(d&&d.changes.length?d.changes.join(' \u00b7 '):'no change')+'</td>'
        +'<td style="text-align:right"><button class="tbtn wpack" data-a="'+_memeEsc(x.id)+'" style="padding:1px 7px;font-size:9px" title="re-check with a fresh research pack">\u{1F4E6}</button> <button class="tbtn wunpin" data-k="'+_memeEsc(k)+'" style="padding:1px 6px;font-size:9px;color:var(--muted)">\u2715</button></td></tr>'}).join('')
    +'</tbody></table>'
    +(function(){const tags={};keys.forEach(k=>{const t=P[k].tag;if(t)tags[t]=(tags[t]||0)+1});const te=Object.entries(tags);
      return te.length?'<div class="ck-note" style="margin-top:5px">narrative mix: '+te.map(t=>t[0]+' \u00d7'+t[1]).join(' \u00b7 ')+'</div>':''})();
  el.querySelectorAll('.wtag').forEach(b=>b.onclick=()=>{const P2=pinState();const t=prompt('Narrative tag (AI / meme / DeFi / L2 \u2026):',(P2[b.dataset.k]||{}).tag||'');if(t===null)return;P2[b.dataset.k].tag=t.trim();pinSave(P2);renderWatch(wdbLoad())});
  el.querySelectorAll('.wpack').forEach(b=>b.onclick=()=>{const P2=pinState();const it=Object.values(P2).find(x=>x.id===b.dataset.a.toLowerCase())||{};researchPack(b.dataset.a,it.chain||'ethereum')});
  el.querySelectorAll('.wunpin').forEach(b=>b.onclick=()=>{const P2=pinState();delete P2[b.dataset.k];pinSave(P2);renderWatch(wdbLoad())});}
function renderNBA(db){const el=document.getElementById('smNBA');if(!el)return;
  const acts=nbaCompute(db,window._smCounts||{});
  if(!acts.length){el.innerHTML='<span style="font-size:11px;color:var(--muted2)">Desk is in good shape \u2014 scan a radar or open the Opportunities below.</span>';return}
  el.innerHTML=acts.map((a,i)=>'<div style="display:flex;gap:10px;align-items:center;padding:6px 0'+(i?';border-top:1px dashed color-mix(in srgb,var(--edge) 40%,transparent)':'')+'"><span style="font-size:14px">'+(i===0?'\u{1F449}':'\u00b7')+'</span><div style="flex:1;font-size:11px;color:var(--txt)">'+a.txt+'</div><button class="tbtn nbact" data-fn="'+a.fn+'" data-i="'+i+'" style="white-space:nowrap;padding:2px 10px;font-size:10px">'+a.act+'</button></div>').join('');
  el.querySelectorAll('.nbact').forEach(b=>b.onclick=()=>{const a=acts[+b.dataset.i];
    if(a.fn==='evm'){const g=document.getElementById('smGetCopyable');if(g)g.click();}
    else if(a.fn==='conv'&&a.data){const inp=document.getElementById('scAddr');if(inp)inp.value=a.data.token;const cs=document.getElementById('scChain');if(cs)try{cs.value=a.data.chain||'ethereum'}catch(e){}try{goView('onchain')}catch(e){}}
    else toast('see the Manipulation Patterns panel below','var(--muted)');});
  /* E1 producer: REAL convergences */
  try{const rings={};(clusterDetect(db)||[]).forEach(c=>c.wallets.forEach(w=>rings[w.toLowerCase()]=1));
    (coHolding(db)||[]).forEach(c=>{if(c.wallets.filter(w=>rings[(w||'').toLowerCase()]).length<c.wallets.length/2)
      aqPush('conv',c.token,'REAL convergence: '+c.wallets.length+' independent wallets in '+shortAddr(c.token),{addr:c.token,chain:c.chain||'ethereum'})})}catch(e){}}
function renderQueue(){const el=document.getElementById('smQueue');if(!el)return;const q=aqLoad();
  if(!q.length){el.innerHTML='<span style="font-size:11px;color:var(--muted2)">Nothing to review \u2014 items land here as your data finds them.</span>';return}
  el.innerHTML=q.slice(0,8).map((x,i)=>'<div style="display:flex;gap:8px;align-items:center;padding:5px 0'+(i?';border-top:1px dashed color-mix(in srgb,var(--edge) 35%,transparent)':'')+'"><span class="pill sem" style="color:'+(x.kind==='conv'?'var(--fav);border-color:var(--fav)':'var(--gold);border-color:var(--gold)')+';font-size:7.5px;padding:0 5px">'+(x.kind==='conv'?'CONVERGENCE':(x.kind||'').toUpperCase())+'</span><span style="font-size:11px;flex:1;color:var(--txt)">'+_memeEsc(x.txt)+'</span><span style="font-size:8.5px;color:var(--muted2)">'+Math.round((Date.now()-x.t)/3600000)+'h</span><button class="tbtn aqgo" data-i="'+i+'" style="padding:1px 8px;font-size:9.5px">'+(x.kind==='conv'?'\u{1F4E6} pack':'open \u25b7')+'</button><button class="tbtn aqx" data-i="'+i+'" style="padding:1px 6px;font-size:9.5px;color:var(--muted)">\u2715</button></div>').join('');
  el.querySelectorAll('.aqgo').forEach(b=>b.onclick=()=>{const x=aqLoad()[+b.dataset.i];if(!x)return;
    if(x.kind==='conv'){researchPack(x.data.addr,x.data.chain)}else if(x.kind==='sa'){smWalletDossier(x.data.addr,x.data.chain)}});
  el.querySelectorAll('.aqx').forEach(b=>b.onclick=()=>{const q2=aqLoad();q2.splice(+b.dataset.i,1);aqSave(q2);renderQueue()});}
function renderDiff(db){const el=document.getElementById('smDiff');if(!el)return;
  const d=dailyDiff(db,window._smCounts||{});
  if(!d){el.style.display='none';return}
  el.style.display='block';
  el.innerHTML='<div style="background:color-mix(in srgb,var(--accent,#5B8DEF) 7%,transparent);border:1px solid var(--accent,#5B8DEF);border-radius:9px;padding:8px 12px;font-size:11px"><b>Since your last visit ('+Math.round((Date.now()-d.since)/3600000)+'h ago):</b> '+d.changes.join(' \u00b7 ')+'</div>';}
function renderOpportunities(db){ /* B1/B2 */
  const el=document.getElementById('smOpps');if(!el)return;
  let mom=null;try{mom=smartMomentum(db).band}catch(e){}
  const tokens=[].concat(window._memeRows||[],window._launchRows||[]).map(r=>({addr:r.addr,sym:r.sym,chain:r.chain,liq:r.liq,vol24:r.vol,chg24:r.chg,buys:r.buys,sells:r.sells,ageDays:r.ageDays,rug:r.rug,
    smartCount:(function(){try{return tokenSmartMoney(db,r.addr).length}catch(e){return 0}})()}));
  let opps=[];try{opps=buildOpportunities(db,tokens,{now:Date.now(),momentum:mom})}catch(e){}
  if(!opps.length){el.innerHTML='<span style="font-size:11px;color:var(--muted2)">No high-conviction signals right now — harvest more wallets or scan the radars. Honest empty beats a fake tip.</span>';return}
  el.innerHTML=opps.map(o=>{const icon=o.kind==='convergence'?'◆':'○';const col=o.conviction>=75?'var(--bull)':o.conviction>=60?'var(--gold)':'var(--muted)';
    return '<div style="display:flex;align-items:center;gap:11px;border:1px solid var(--edge);border-radius:9px;padding:9px 11px;margin-top:7px">'
      +'<div style="font-size:18px">'+icon+'</div>'
      +'<div style="flex:1"><div style="font-size:12px;font-weight:600;color:var(--txt)">'+_memeEsc(o.why)+'</div>'
      +'<div style="font-size:9.5px;color:var(--muted2);margin-top:2px">'+(o.kind==='convergence'?'smart-money convergence':'healthy coin — '+(o.stance||'WATCH'))+' · '+_memeEsc(shortAddrSafe(o.token))+(o.chain?' ('+_memeEsc(o.chain)+')':'')+'</div></div>'
      +'<div style="text-align:center;min-width:52px"><div style="font-size:16px;font-weight:700;color:'+col+'">'+o.conviction+'</div><div style="font-size:8px;color:var(--muted2);text-transform:uppercase;letter-spacing:.06em">conviction</div></div>'
      +'<button class="tbtn oppAct" data-act="'+o.action+'" data-a="'+_memeEsc((o.actionData&&o.actionData.addr)||'')+'" data-c="'+_memeEsc((o.actionData&&o.actionData.chain)||'ethereum')+'" style="white-space:nowrap">'+(o.action==='scout'?'scout ▷':'dossier ▷')+'</button></div>';}).join('')
    +'<div style="font-size:9.5px;color:var(--muted2);margin-top:8px">ranked by conviction · decision support, not a buy signal · every pick shows its evidence '+(mom?'· regime: '+mom:'')+'</div>';
  el.querySelectorAll('.oppAct').forEach(b=>b.onclick=()=>{const a=b.dataset.a,c=b.dataset.c;
    if(!a){toast('no address for this signal','var(--muted)');return}
    if(b.dataset.act==='scout'){const inp=document.getElementById('scAddr');if(inp)inp.value=a;const cs=document.getElementById('scChain');if(cs)try{cs.value=c}catch(e){}try{goView('onchain')}catch(e){}toast('→ token loaded in scout','var(--accent)')}
    else{smWalletDossier(a,c)}});}
function renderMomentum(db){ /* D3 */
  const el=document.getElementById('smMomentum');if(!el)return;const m=smartMomentum(db);
  const col=m.band==='RISK-ON'?'var(--bull)':m.band==='RISK-OFF'?'var(--bear)':'var(--gold)';
  el.innerHTML=m.n?('<div style="display:flex;align-items:center;gap:12px"><div style="font-size:22px;font-weight:700;color:'+col+'">'+m.band+'</div><div style="flex:1"><div style="height:8px;background:var(--panel2);border-radius:4px;overflow:hidden"><div style="height:100%;width:'+m.score+'%;background:'+col+'"></div></div><div style="font-size:10px;color:var(--muted2);margin-top:4px">'+m.score+'/100 from '+m.n+' non-risk wallets \u00b7 '+m.recent+' active this week</div></div></div><div style="font-size:9.5px;color:var(--muted2);margin-top:6px">aggregate posture of your smart-money DB \u2014 a sentiment proxy, not a price prediction</div>'):'<span style="font-size:11px;color:var(--muted2)">Harvest wallets to compute group posture.</span>';}
function renderEarlyRadar(db){ /* D4 */
  const el=document.getElementById('smEarly');if(!el)return;const r=earlyEntryRadar(db);
  el.innerHTML=r.length?r.map(x=>'<div style="border:1px solid var(--bull);border-radius:8px;padding:6px 9px;margin-top:5px;font-size:10.5px"><b class="up">\u2605 '+x.wallets.length+' top-tier wallets</b> in <span class="mono">'+_memeEsc(shortAddr(x.token))+'</span> <span style="color:var(--muted2)">('+_memeEsc(x.chain||'?')+')</span><div style="font-size:9.5px;color:var(--muted2);margin-top:2px">tiers: '+x.tiers.join(', ')+' \u2014 strongest copy signal when they cluster</div></div>').join(''):'<span style="font-size:11px;color:var(--muted2)">No token yet has \u22652 S/A wallets \u2014 harvest more to surface convergence.</span>';}
function pushDbWallets(smart){
  try{const top=smart.filter(x=>x.s.tier==='S'||x.s.tier==='A').slice(0,40)
    .map(x=>({wallet:x.r.addr,chain:x.r.chains[0]||'ethereum',tier:x.s.tier,score:x.s.score,nick:(walletNick(x.r.addr)||{}).nick||'',alert:1}));
  if(!top.length)return;const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
  fetch(sb+'/svc/onchain/dbwallets',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallets:top}),signal:AbortSignal.timeout(2500)}).catch(()=>{});}catch(e){}}
function renderClusters(db){
  const el=document.getElementById('smCluster');if(!el)return;const cl=clusterDetect(db);
  el.innerHTML=cl.length?cl.map(c=>'<div style="border:1px solid var(--bear);border-radius:8px;padding:6px 9px;margin-top:5px;font-size:10.5px"><b class="dn">Sybil cluster \u00d7'+c.n+'</b> \u2014 '+c.wallets.slice(0,5).map(a=>_memeEsc(shortAddr(a))).join(' \u2194 ')+'<div style="font-size:9.5px;color:var(--muted2);margin-top:2px">wallets in a circular ring \u2014 likely one operator faking diversification</div></div>').join(''):'<span style="font-size:11px;color:var(--muted2)">No Sybil rings detected in sampled transfers.</span>';}
async function renderLeaderboard(){
  const el=document.getElementById('smLeader');if(!el)return;el.dataset.sowhat='1';
  let rows=[];try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    const r=await fetch(sb+'/svc/onchain/leaderboard',{signal:AbortSignal.timeout(2500)});if(r.ok)rows=await r.json();}catch(e){}
  if(!rows.length){el.innerHTML='<span style="font-size:11px;color:var(--muted2)">Round-trip leaderboard builds from the service event store as your followed wallets trade \u2014 start mishel_service and follow wallets. Counts on-chain buy\u2192sell round-trips, not realized PnL.</span>';return}
  el.innerHTML='<table class="log"><thead><tr><th>wallet</th><th>round-trips</th><th>tokens</th></tr></thead><tbody>'+rows.map(w=>'<tr><td class="mono" style="font-size:10.5px">'+_memeEsc(shortAddr(w.wallet))+(walletNick(w.wallet)?' <b style="color:var(--gold);font-size:10px">'+_memeEsc(walletNick(w.wallet).nick)+'</b>':'')+'</td><td class="mono up">'+w.roundtrips+'</td><td class="mono">'+w.tokens+'</td></tr>').join('')+'</tbody></table><div style="font-size:9.5px;color:var(--muted2);margin-top:5px">on-chain buy\u2192sell round-trips \u00b7 completed cycles only \u00b7 proxy for activity, NOT verified profit</div>';}
function renderTokenSM(){
  const el=document.getElementById('smTokOut');if(!el)return;const t=((document.getElementById('smTokAddr')||{}).value||'').trim();
  if(!t){el.innerHTML='<span style="font-size:11px;color:var(--muted2)">Paste a token contract to see which of your DB wallets are in it.</span>';return}
  const list=tokenSmartMoney(wdbLoad(),t);
  el.innerHTML=list.length?('<table class="log"><thead><tr><th>wallet</th><th>tier</th><th>evidence</th></tr></thead><tbody>'+list.map(w=>'<tr><td class="mono" style="font-size:10.5px">'+_memeEsc(shortAddr(w.addr))+(walletNick(w.addr)?' <b style="color:var(--gold);font-size:10px">'+_memeEsc(walletNick(w.addr).nick)+'</b>':'')+'</td><td><span class="pill" style="font-weight:700">'+w.intel.tier+' '+w.intel.score+'</span></td><td style="font-size:10px;color:var(--muted2)">'+Object.entries(w.cats||{}).map(([c,n])=>c+(n>1?'\u00d7'+n:'')).join(' \u00b7 ')+'</td></tr>').join('')+'</tbody></table>'):'<span style="font-size:11px;color:var(--muted2)">None of your DB wallets are recorded in that token yet \u2014 scout it or mass-harvest.</span>';}
function portfolioSummary(events){ /* pure: buy/sell balance + most-active token from recent transfers */
  const evs=Array.isArray(events)?events:[];if(!evs.length)return null;
  let buys=0,sells=0;const byTok={};
  evs.forEach(e=>{const d=(e.dir==='in'||e.direction==='BUY')?'buy':'sell';if(d==='buy')buys++;else sells++;
    const t=e.token||e.sym||'?';byTok[t]=(byTok[t]||0)+1;});
  const top=Object.entries(byTok).sort((a,b)=>b[1]-a[1])[0];
  const total=buys+sells;const buyPct=total?Math.round(buys/total*100):0;
  const bias=buyPct>=65?'net ACCUMULATING':buyPct<=35?'net DISTRIBUTING':'two-way / balanced';
  return {buys,sells,buyPct,bias,topToken:top?top[0]:'?',topCount:top?top[1]:0,total};}
function walletVisitDiff(addr,tokensNow){ /* E6: what changed since I last opened this wallet */
  try{const K='mishel_wsnap';const m=JSON.parse(localStorage.getItem(K)||'{}');const a=(addr||'').toLowerCase();
    const prev=m[a];m[a]={n:tokensNow,t:Date.now()};localStorage.setItem(K,JSON.stringify(m));
    if(!prev)return null;const d=tokensNow-prev.n;
    return {ago:Math.round((Date.now()-prev.t)/3600000),delta:d};}catch(e){return null}}
async function smWalletDossier(addr,chain){
  const box=document.getElementById('smDossier');if(!box)return;
  box.innerHTML='<div class="panelbox"><h4>\u{1F4C7} Wallet Dossier \u2014 <span class="mono" style="font-size:12px">'+_memeEsc(shortAddr(addr))+'</span></h4><div style="font-size:11px;color:var(--muted)">fetching holdings + activity (Blockscout '+_memeEsc(chain)+')\u2026</div></div>';
  box.scrollIntoView({behavior:'smooth',block:'center'});
  let holdings=[],events=[],fresh=null,errs=[];
  const base=BLOCKSCOUT[chain];
  if(chain==='solana'){
    /* free public Solana RPC — SPL token holdings; transfers need a paid indexer so shown honestly as N/A */
    try{const r=await fetch('https://api.mainnet-beta.solana.com',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getTokenAccountsByOwner',params:[addr,{programId:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'},{encoding:'jsonParsed'}]}),signal:AbortSignal.timeout(12000)});
      if(r.ok){const j=await r.json();const accs=(j&&j.result&&j.result.value)||[];
        let symMap={};try{if(!window._jupTokens){const jr=await fetch('https://tokens.jup.ag/tokens?tags=verified',{signal:AbortSignal.timeout(8000)});if(jr.ok){const arr=await jr.json();window._jupTokens={};(arr||[]).forEach(t=>{window._jupTokens[t.address]={sym:t.symbol,name:t.name}})}}symMap=window._jupTokens||{}}catch(e){}
        holdings=accs.map(a=>{const info=a.account&&a.account.data&&a.account.data.parsed&&a.account.data.parsed.info;const ta=info&&info.tokenAmount;const mint=(info&&info.mint)||'';const meta=symMap[mint];
          return {sym:meta?meta.sym:(mint.slice(0,4)+'\u2026'+mint.slice(-4)),name:meta?meta.name:mint,amt:ta?(+ta.uiAmount||0):0,mint:mint}}).filter(h=>h.amt>0).sort((a,b)=>b.amt-a.amt).slice(0,12);}
      else errs.push('Solana RPC HTTP '+r.status);}catch(e){errs.push('Solana holdings: '+e.message)}
    errs.push('Solana buy/sell history needs a paid indexer \u2014 shown as N/A rather than faked');
  }else if(base){
    try{const r=await fetch(base+'/api/v2/addresses/'+addr+'/token-balances',{signal:AbortSignal.timeout(10000)});
      if(r.ok){const j=await r.json();holdings=(Array.isArray(j)?j:[]).slice(0,12).map(x=>({sym:(x.token&&x.token.symbol)||'?',name:(x.token&&x.token.name)||'',amt:(+x.value||0)/Math.pow(10,+(x.token&&x.token.decimals)||18)}))}else errs.push('balances HTTP '+r.status)}catch(e){errs.push('balances: '+e.message)}
    try{const r=await fetch(base+'/api/v2/addresses/'+addr+'/counters',{signal:AbortSignal.timeout(8000)});
      if(r.ok){const j=await r.json();fresh=freshness(j&&j.transactions_count)}}catch(e){}
    try{const r=await fetch(base+'/api/v2/addresses/'+addr+'/token-transfers?type=ERC-20',{signal:AbortSignal.timeout(10000)});
      if(r.ok){const j=await r.json();events=((j&&j.items)||[]).slice(0,12).map(it=>normalizeTransfer(it,addr))}else errs.push('transfers HTTP '+r.status)}catch(e){errs.push('transfers: '+e.message)}
  }else{box.querySelector('div div').innerHTML='No free data source for '+_memeEsc(chain)+' wallets \u2014 honestly unavailable, nothing faked.';return}
  const db=wdbLoad();const rec=db[(addr||'').toLowerCase()];
  box.innerHTML='<div class="panelbox"><h4>\u{1F4C7} Wallet Dossier \u2014 <span class="mono" style="font-size:12px">'+_memeEsc(shortAddr(addr))+'</span> <button class="tbtn smcopy2" style="padding:0 6px;font-size:9px">\u29c9</button></h4>'
    +(fresh?'<div style="font-size:11px;color:var(--gold);margin:4px 0">\u26a0 '+_memeEsc(fresh.txt)+'</div>':'')
    +(rec&&rec.lastReason?'<div style="font-size:10.5px;color:var(--muted2);margin:4px 0">classification evidence: '+_memeEsc(rec.lastReason)+'</div>':'')
    +(function(){ /* v23 DNA DASHBOARD */
      try{var db2=wdbLoad();var rc=db2[(addr||'').toLowerCase()]||{};
      var rt=0;try{rt=profitProxy(events).roundtrips}catch(e){}
      var dna=walletDNA({events:events,holdings:holdings,rec:rc,roundtrips:rt,now:Date.now()});
      var chip=function(k,v,col){return '<div style="background:var(--panel2);border:1px solid var(--edge);border-radius:8px;padding:7px 10px;min-width:120px"><div style="font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted2)">'+k+'</div><div style="font-size:12px;font-weight:600;color:'+(col||'var(--txt)')+';margin-top:2px">'+v+'</div></div>'};
      var roleCol=/RUGGER|DUMPER/.test(dna.role)?'var(--bear)':/WINNER|WHALE|SNIPER|MARKET/.test(dna.role)?'var(--bull)':'var(--txt)';
      var h='<div style="background:linear-gradient(180deg,color-mix(in srgb,var(--accent,#5B8DEF) 8%,transparent),transparent);border:1px solid var(--edge);border-radius:10px;padding:11px;margin:8px 0">';
      try{const _lc=labelChip(addr);if(_lc)h+='<div style="margin-bottom:5px">'+_lc+'</div>';}catch(e){}
      try{const _nk=walletNick(addr)||{};if(_nk.note)h+='<div style="font-size:10px;color:var(--gold);margin-bottom:6px">\u270e your note: '+_memeEsc(_nk.note)+'</div>';
        const _vd=walletVisitDiff(addr,(holdings||[]).length);
        if(_vd)h+='<div style="font-size:10px;color:var(--muted2);margin-bottom:6px">since your last look ('+_vd.ago+'h ago): '+(_vd.delta===0?'same holdings count':(_vd.delta>0?'+':'')+_vd.delta+' holdings')+'</div>';}catch(e){}
      h+='<div style="display:flex;align-items:center;gap:9px;margin-bottom:8px"><span style="font-size:14px">\u{1F9EC}</span><b style="font-size:13px;color:'+roleCol+'">'+dna.role+'</b><span style="font-size:10.5px;color:var(--muted2)">'+_memeEsc(dna.roleWhy)+'</span></div>';
      h+='<div style="display:flex;gap:8px;flex-wrap:wrap">';
      h+=chip('Style',dna.style.style+' <span style="font-size:9px;color:var(--muted2)">'+dna.style.conf+'%</span>',/BOT|DUMPER/.test(dna.style.style)?'var(--bear)':'var(--txt)');
      if(dna.holdTime)h+=chip('Median hold',dna.holdTime.medianHours+'h \u00b7 '+dna.holdTime.band.split(' ')[0]);
      if(dna.consistency&&dna.consistency.score!=null)h+=chip('Consistency',dna.consistency.score+'/100',dna.consistency.score>=70?'var(--bull)':'var(--txt)');
      if(dna.affinity)h+=chip('Prefers',dna.affinity.profile+' '+dna.affinity.pct+'%');
      if(dna.timing)h+=chip('Active',dna.timing.session+' (~'+dna.timing.peakHourUTC+':00 UTC)');
      h+=chip('Risk DNA',dna.risk.band,dna.risk.band==='DISCIPLINED'?'var(--bull)':dna.risk.band==='RECKLESS'?'var(--bear)':'var(--gold)');
      if(rt)h+=chip('Round-trips',rt+' \u00b7 proxy','var(--bull)');
      h+='</div>';
      h+='<div style="font-size:9.5px;color:var(--muted2);margin-top:8px">'+_memeEsc(dna.style.why)+(dna.consistency&&dna.consistency.txt?' \u00b7 '+_memeEsc(dna.consistency.txt):'')+'</div></div>';
      return h;}catch(e){return ''}})()
    +(function(){var ps=portfolioSummary(events);if(!ps)return '';
      return '<div style="display:flex;gap:14px;flex-wrap:wrap;background:var(--panel2);border:1px solid var(--edge);border-radius:8px;padding:8px 11px;margin:8px 0;font-size:11px">'
        +'<span><b style="color:'+(ps.buyPct>=65?'var(--bull)':ps.buyPct<=35?'var(--bear)':'var(--txt)')+'">'+ps.bias+'</b></span>'
        +'<span style="color:var(--muted)">buys '+ps.buys+' / sells '+ps.sells+' ('+ps.buyPct+'% buy)</span>'
        +'<span style="color:var(--muted)">most active: <b style="color:var(--txt)">'+_memeEsc(String(ps.topToken).slice(0,10))+'</b> \u00d7'+ps.topCount+'</span>'
        +'<span style="font-size:9.5px;color:var(--muted2)">from last '+ps.total+' transfers</span></div>';})()
    +'<div class="grid2" style="margin-top:8px"><div><b style="font-size:11px;color:var(--muted)">HOLDING NOW ('+holdings.length+')</b>'
    +(holdings.length?'<table class="log" style="margin-top:4px"><tbody>'+holdings.map(h=>'<tr><td><b>'+_memeEsc(h.sym)+'</b> <span style="color:var(--muted2);font-size:9px">'+_memeEsc(h.name.slice(0,14))+'</span></td><td class="mono">'+h.amt.toLocaleString(undefined,{maximumFractionDigits:0})+'</td></tr>').join('')+'</tbody></table>':'<div style="font-size:10.5px;color:var(--muted2)">no ERC-20 balances returned</div>')
    +'</div><div><b style="font-size:11px;color:var(--muted)">RECENT BUYS / SELLS</b>'
    +(events.length?'<table class="log" style="margin-top:4px"><tbody>'+events.map(e=>'<tr><td class="mono" style="font-size:9px">'+_memeEsc(String(e.time).slice(5,16).replace('T',' '))+'</td><td class="'+(e.dir==='in'?'up':'dn')+'">'+(e.dir==='in'?'BUY/IN':'SELL/OUT')+'</td><td><b>'+_memeEsc(e.token)+'</b></td><td class="mono">'+(+e.amount).toLocaleString(undefined,{maximumFractionDigits:0})+'</td></tr>').join('')+'</tbody></table>':'<div style="font-size:10.5px;color:var(--muted2)">no recent ERC-20 transfers returned</div>')
    +'</div></div>'+(errs.length?'<div style="font-size:10px;color:var(--bear);margin-top:6px">partial: '+_memeEsc(errs.join(' \u00b7 '))+'</div>':'')
    +'<div style="font-size:10px;color:var(--muted2);margin-top:6px">real Blockscout data \u00b7 direction is relative to this wallet \u00b7 copy decisions are yours</div></div>';
  const cb=box.querySelector('.smcopy2');if(cb)cb.onclick=async()=>{try{await navigator.clipboard.writeText(addr);cb.textContent='\u2713'}catch(e){prompt('Copy:',addr)}};}
async function renderSmartFeed(){
  const box=document.getElementById('smFeed');const srcEl=document.getElementById('smFeedSrc');if(!box)return;
  let evts=[],src='';
  try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    const r=await fetch(sb+'/svc/onchain/events?limit=40',{signal:AbortSignal.timeout(2500)});
    if(r.ok){const j=await r.json();evts=(j||[]).map(e=>({t:e.t*1000,sym:e.sym,dir:e.direction,amt:e.amount,wallet:e.wallet}));window._lastFeedEvents=evts;src='service event store (also powers your Telegram signals)'}}catch(e){}
  if(!evts.length){let ws=[];try{ws=(loadWallets()||[]).slice(0,4)}catch(e){}
    if(!ws.length){box.innerHTML='<span style="font-size:11px;color:var(--muted2)">Follow wallets (\u2605) first \u2014 their buys/sells will stream here.</span>';if(srcEl)srcEl.textContent='';return}
    for(const w of ws){const base=BLOCKSCOUT[w.chain||'ethereum'];if(!base)continue;
      try{const r=await fetch(base+'/api/v2/addresses/'+w.addr+'/token-transfers?type=ERC-20',{signal:AbortSignal.timeout(8000)});
        if(r.ok){const j=await r.json();((j&&j.items)||[]).slice(0,8).forEach(it=>{const e=normalizeTransfer(it,w.addr);evts.push({t:Date.parse(e.time)||0,sym:e.token,dir:e.dir==='in'?'BUY':'SELL',amt:e.amount,wallet:w.addr})})}}catch(e){}}
    src='direct Blockscout (start mishel_service for the smart signal engine)';}
  evts.sort((a,b)=>b.t-a.t);evts=evts.slice(0,25);
  if(srcEl)srcEl.textContent=src?('source: '+src):'';
  setTimeout(function(){try{
    box.querySelectorAll('.feeddash').forEach(el=>el.onclick=()=>{try{var rc=(wdbLoad()||{})[el.dataset.a.toLowerCase()];smWalletDossier(el.dataset.a,(rc&&rc.chains&&rc.chains[0])||'ethereum')}catch(e){}});
    box.querySelectorAll('.feedcopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1000)}catch(e){prompt('Copy:',b.dataset.a)}});
  }catch(e){}},50);
  box.innerHTML=evts.length?('<table class="log"><tbody>'+evts.map(e=>{const ago=e.t?Math.max(0,Math.round((Date.now()-e.t)/60000)):null;
    return '<tr><td class="mono" style="font-size:9.5px"><span class="feeddash" data-a="'+_memeEsc(e.wallet)+'" style="cursor:pointer;color:var(--accent,#5B8DEF);text-decoration:underline" title="open wallet dashboard">'+_memeEsc(shortAddr(e.wallet))+'</span> <button class="tbtn feedcopy" data-a="'+_memeEsc(e.wallet)+'" style="padding:0 4px;font-size:8px">\u29c9</button></td><td class="'+(e.dir==='BUY'?'up':'dn')+'"><b>'+e.dir+'</b></td><td><b>'+_memeEsc(e.sym||'?')+'</b></td><td class="mono">'+(+e.amt||0).toLocaleString(undefined,{maximumFractionDigits:0})+'</td><td style="font-size:9px;color:var(--muted2)">'+(function(){try{var rc=(wdbLoad()||{})[(e.wallet||'').toLowerCase()]||{};var fr=feedRead(e,rc,null);return (rc.cats?Object.keys(rc.cats)[0]+' \u00b7 ':'')+fr.note}catch(x){return ''}})()+'</td><td class="mono" style="font-size:9px;color:var(--muted2)">'+(ago==null?'':ago+'m ago')+'</td></tr>'}).join('')+'</tbody></table>')
    :'<span style="font-size:11px;color:var(--muted2)">No transfers returned for your followed wallets right now \u2014 honest empty, retry shortly.</span>';}
async function testSources(){
  const out=document.getElementById('shOut');if(!out)return;
  const provs=[['Binance',async()=>{const r=await fetch('https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2',{signal:AbortSignal.timeout(6000)});const j=await r.json();if(!Array.isArray(j)||!j.length)throw new Error('empty');}]];
  const P=window._PROV||{};[['Bybit','bybit'],['Kraken','kraken'],['Coinbase','coinbase'],['OKX','okx'],['KuCoin','kucoin'],['Gate.io','gate']].forEach(([nm,k])=>{
    if(P[k])provs.push([nm,async()=>{const b=await P[k]('BTCUSD','1h',3);if(!b||!b.length)throw new Error('empty')}]);});
  out.innerHTML='<div style="font-size:11px;color:var(--muted)">testing '+provs.length+' providers\u2026</div>';
  const rows=[];
  for(const [nm,fn] of provs){const t0=performance.now();
    try{await fn();rows.push({nm,ok:true,ms:Math.round(performance.now()-t0)})}
    catch(e){rows.push({nm,ok:false,err:(e&&e.message)||String(e)})}
    out.innerHTML='<table class="log"><thead><tr><th>provider</th><th>status</th><th>detail</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+r.nm+'</td><td class="'+(r.ok?'up':'dn')+'">'+(r.ok?'\u2713 OK':'\u2717 FAIL')+'</td><td class="mono" style="font-size:10px">'+(r.ok?(r.ms+' ms'):String(r.err).slice(0,60).replace(/</g,'&lt;'))+'</td></tr>').join('')+'</tbody></table>'
      +(rows.length===provs.length?'<div style="font-size:10px;color:var(--muted2);margin-top:6px">'+rows.filter(r=>r.ok).length+'/'+provs.length+' reachable from this browser \u00b7 the chart failover uses them in this order \u00b7 a FAIL here usually means CORS/network on your side, not the exchange being down</div>':'');
  }
}
async function scoutRun(){
  const out=document.getElementById('scOut');if(!out)return;
  const addr=((document.getElementById('scAddr')||{}).value||'').trim();
  const chain=((document.getElementById('scChain')||{}).value)||'ethereum';
  if(!addr){out.innerHTML='<span style="font-size:11px;color:var(--gold)">Paste a token contract address first.</span>';return}
  out.innerHTML='<span style="font-size:11px;color:var(--muted)">scouting\u2026 holders (GoPlus)'+(BLOCKSCOUT[chain]?' + transfers (Blockscout)':'')+'\u2026</span>';
  let holders=[],creator='',owner='',transfers=[],notes=[];
  try{const cid=GP_CHAIN[chain];if(!cid)throw new Error('chain not covered by GoPlus');
    const r=await fetch('https://api.gopluslabs.io/api/v1/token_security/'+cid+'?contract_addresses='+addr,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('GoPlus HTTP '+r.status);
    const j=await r.json();const d=j&&j.result&&(j.result[addr.toLowerCase()]||j.result[addr]);
    if(!d)throw new Error('GoPlus returned no data for this token');
    creator=d.creator_address||'';owner=d.owner_address||'';
    holders=(Array.isArray(d.holders)?d.holders:[]).map(h=>({addr:h.address||'',pct:(+h.percent||0)*100,isContract:h.is_contract==1,locked:h.is_locked==1,tag:h.tag||''}));
  }catch(e){out.innerHTML='<span style="font-size:11px;color:var(--bear)">\u2717 holder source failed: '+_memeEsc(e.message)+' \u2014 nothing scored on missing data.</span>';return}
  if(BLOCKSCOUT[chain]){try{const tr=await fetch(BLOCKSCOUT[chain]+'/api/v2/tokens/'+addr+'/transfers',{signal:AbortSignal.timeout(10000)});
      if(tr.ok){const tj=await tr.json();const items=(tj&&tj.items)||[];
        transfers=items.map(it=>({from:(it.from&&it.from.hash)||'',to:(it.to&&it.to.hash)||'',time:it.timestamp||''}));
        transfers.reverse();/* oldest first for early detection */}
      else notes.push('transfers: Blockscout HTTP '+tr.status+' \u2014 maker/early categories skipped');
    }catch(e){notes.push('transfers unavailable ('+e.message+') \u2014 maker/early categories skipped')}}
  else notes.push('no free Blockscout on '+chain+' \u2014 holder-based categories only');
  let ruggers={};try{(loadRuggers()||[]).forEach(r=>{ruggers[(r.addr||'').toLowerCase()]=true})}catch(e){}
  const res=scoutWallets({holders,transfers,creator,owner,ruggers});
  try{wdbHarvest(res,chain,addr,manipFlags(transfers));if(document.getElementById('v-smart'))renderSmartDesk()}catch(e){}
  const cat=(title,arr,cls)=>{if(!arr.length)return '<div style="margin-top:10px"><b style="font-size:11px;color:var(--muted)">'+title+'</b><div style="font-size:10px;color:var(--muted2)">none found in the sampled data \u2014 honest empty, nothing invented</div></div>';
    return '<div style="margin-top:10px"><b style="font-size:11px;color:var(--txt)">'+title+'</b>'+arr.map(w=>{const ex=explorerUrl(chain,w.addr);
      return '<div style="border:1px solid var(--edge);border-radius:8px;padding:7px 9px;margin-top:5px"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="mono" style="font-size:10.5px;color:'+(cls==='dn'?'var(--bear)':'var(--txt)')+'">'+_memeEsc(shortAddr(w.addr))+'</span><button class="tbtn sccopy" data-a="'+_memeEsc(w.addr)+'" style="padding:0 6px;font-size:9px">\u29c9</button>'+(cls!=='dn'?'<button class="tbtn scfollow" data-a="'+_memeEsc(w.addr)+'" style="padding:1px 7px;font-size:9.5px">\u2605 follow</button>':'<button class="tbtn scflag" data-a="'+_memeEsc(w.addr)+'" style="padding:1px 7px;font-size:9.5px">\u{1F6A9} flag</button>')+(ex?'<a href="'+ex+'" target="_blank" rel="noopener" style="font-size:10px">view\u2197</a>':'')+'</div><div style="font-size:10px;color:var(--muted2);margin-top:3px">'+w.reasons.map(_memeEsc).join(' \u00b7 ')+'</div></div>'}).join('')+'</div>'};
  out.innerHTML=cat('\u{1F40B} Whales (\u22651% holders)',res.whales,'')+cat('\u2696 Two-way churners (market-maker-like)',res.makers,'')+cat('\u23f1 Early accumulators (still holding)',res.early,'')+cat('\u26a0 Risk wallets',res.risky,'dn')
    +'<div style="font-size:10px;color:var(--muted2);margin-top:10px">Sampled: '+res.sampled.holders+' holders \u00b7 '+res.sampled.transfers+' transfers'+(notes.length?' \u00b7 '+_memeEsc(notes.join(' \u00b7 ')):'')+' \u00b7 pattern screens from public data \u2014 not proof of skill, not an endorsement, never a buy signal.</div>';
  out.querySelectorAll('.sccopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1100)}catch(e){prompt('Copy wallet address:',b.dataset.a)}});
  out.querySelectorAll('.scfollow').forEach(b=>b.onclick=()=>{const a=b.dataset.a;
    const inp=document.getElementById('ocWalletAddr');if(inp)inp.value=a;
    const sel=document.getElementById('ocWalletChain');if(sel){try{sel.value=chain;OC_WALLET_CHAIN=chain}catch(e){}}
    try{scanWallet()}catch(e){}
    try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
      fetch(sb+'/svc/onchain/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:a,chain,min_usd:10000}),signal:AbortSignal.timeout(3000)})
        .then(r=>toast(r.ok?'\u2605 Followed \u2014 tracker loaded + server alerts armed':'\u2605 Loaded in tracker','var(--gold)'))
        .catch(()=>toast('\u2605 Loaded in Wallet Tracker \u2014 start mishel_service for Telegram alerts','var(--gold)'));}catch(e){}
    try{renderWhaleBoard()}catch(e){}});
  out.querySelectorAll('.scflag').forEach(b=>b.onclick=()=>{try{markRugger(b.dataset.a,chain,addr,'flagged from Wallet Scout');toast('\u{1F6A9} flagged in your Rugpuller Registry','#F0616D');renderRuggerList()}catch(e){}});
}
async function renderWhaleBoard(){
  const box=document.getElementById('wbList');if(!box)return;
  let rows=[];try{(loadWallets()||[]).forEach(w=>rows.push({addr:w.addr,chain:w.chain||'ethereum',label:w.label||'',src:'saved'}))}catch(e){}
  try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
    const r=await fetch(sb+'/svc/onchain/watch',{signal:AbortSignal.timeout(2500)});
    if(r.ok){const j=await r.json();const arr=(j&&(j.watches||j.items||j.data))||[];
      arr.forEach(w=>{const a=(w.wallet||w.addr||'');if(a)rows.push({addr:a,chain:w.chain||'ethereum',label:'server alert \u2265$'+((+w.min_usd||0)/1000)+'k',src:'service'})});}
  }catch(e){}
  const seen={};rows=rows.filter(w=>{const k=(w.addr||'').toLowerCase();if(!k||seen[k])return false;seen[k]=1;return true});
  if(!rows.length){box.innerHTML='<span style="font-size:10px;color:var(--muted2)">No followed wallets yet \u2014 \u2605 Save one in the Wallet Tracker or \u2605 follow a whale from any holder scan.'+(navigator.onLine?'':' (service offline)')+'</span>';return}
  box.innerHTML='<table class="log"><thead><tr><th>wallet</th><th>chain</th><th>note</th><th></th></tr></thead><tbody>'+rows.map((w,i)=>{
    const ex=explorerUrl(w.chain,w.addr);
    return '<tr><td class="mono" style="font-size:10.5px">'+_memeEsc(shortAddr(w.addr))+' <button class="tbtn wbcopy" data-a="'+_memeEsc(w.addr)+'" style="padding:0 5px;font-size:9px" title="copy full address">\u29c9</button></td><td style="font-size:10px;color:var(--muted)">'+_memeEsc(w.chain)+'</td><td style="font-size:10px;color:var(--muted2)">'+_memeEsc(w.label||w.src)+'</td><td style="white-space:nowrap"><button class="tbtn wbscan" data-i="'+i+'" style="padding:2px 8px;font-size:9.5px">verdict \u25b7</button> '+(ex?'<a href="'+ex+'" target="_blank" rel="noopener" style="font-size:10px">view\u2197</a> ':'')+'<button class="tbtn wbremove" data-a="'+_memeEsc(w.addr)+'" data-c="'+_memeEsc(w.chain||'ethereum')+'" style="padding:2px 8px;font-size:9.5px;color:var(--bear)" title="stop tracking / remove from board">\u2715 remove</button></td></tr>'}).join('')+'</tbody></table>';
  window._wbRows=rows;
  box.querySelectorAll('.wbcopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1100)}catch(e){prompt('Copy wallet address:',b.dataset.a)}});
  box.querySelectorAll('.wbscan').forEach(b=>b.onclick=()=>{const w=(window._wbRows||[])[+b.dataset.i];if(!w)return;
    const inp=document.getElementById('ocWalletAddr');if(inp)inp.value=w.addr;
    const sel=document.getElementById('ocWalletChain');if(sel){try{sel.value=w.chain;OC_WALLET_CHAIN=w.chain}catch(e){}}
    try{scanWallet()}catch(e){}
    const wb=document.getElementById('walletBody');if(wb)wb.scrollIntoView({behavior:'smooth',block:'center'});});
  box.querySelectorAll('.wbremove').forEach(b=>b.onclick=()=>{const a=b.dataset.a,ch=b.dataset.c;
    try{const ws=loadWallets().filter(w=>(w.addr||'').toLowerCase()!==a.toLowerCase());saveWallets(ws);if(typeof renderWalletList==='function')renderWalletList();}catch(e){}
    try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
      fetch(sb+'/svc/onchain/unwatch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:a}),signal:AbortSignal.timeout(2500)}).catch(()=>{});}catch(e){}
    toast('\u2715 Removed from board \u2014 tracking stopped','var(--muted)');renderWhaleBoard();});
}
