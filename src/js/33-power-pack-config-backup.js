function parseHolders(d){
  const hs=Array.isArray(d.holders)?d.holders:[];
  const rows=hs.map(x=>({addr:x.address||'',pct:(+x.percent||0)*100,tag:x.tag||'',isContract:x.is_contract==1,locked:x.is_locked==1})).sort((a,b)=>b.pct-a.pct);
  const top10=rows.slice(0,10).reduce((a,x)=>a+x.pct,0);
  const lpLocked=Array.isArray(d.lp_holders)?d.lp_holders.reduce((a,x)=>a+((x.is_locked==1)?(+x.percent||0):0),0)*100:null;
  return {rows,top10,lpLocked,holderCount:+d.holder_count||rows.length,
    honeypot:d.is_honeypot=='1'||d.cannot_sell_all=='1',buyTax:(+d.buy_tax||0)*100,sellTax:(+d.sell_tax||0)*100};
}
async function scanHolders(){
  const addr=((document.getElementById('ocHolderAddr')||{}).value||'').trim();
  const body=document.getElementById('holderBody');if(!body)return;
  if(!addr){ocSet('holderInfo','Paste a token contract address first.','gold');return}
  const cid=GP_CHAIN[OC_HOLDER_CHAIN];if(!cid){ocSet('holderInfo','That chain isn\'t covered by the keyless security feed.','gold');return}
  ocSet('holderInfo','fetching holders (GoPlus)\u2026');body.innerHTML='<tr><td colspan="4" style="padding:12px;color:var(--muted)">Loading\u2026</td></tr>';
  try{
    const r=await fetch('https://api.gopluslabs.io/api/v1/token_security/'+cid+'?contract_addresses='+addr,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();const key=addr.toLowerCase();const d=j&&j.result&&(j.result[key]||j.result[addr]);
    if(!d)throw new Error('no data for that address on this chain');
    const info=parseHolders(d);window._holderInfo=info;renderHolders(info);
    /* v15.2: whale numbers + deployer reputation */
    try{const _ws=whaleStats(info.rows,info.holderCount);window._whaleStats=_ws;
    const _creator=(d.creator_address||'').toLowerCase(),_owner=(d.owner_address||'').toLowerCase();
    const _rg=flagRugger(_creator,_owner);
    const wbox=document.getElementById('whaleStatsBox');
    if(wbox){wbox.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;font-size:11px;margin-top:8px">'
      +'<div class="stat"><div class="k">Whale wallets (\u22651%)</div><div class="v">'+_ws.whaleCount+'</div></div>'
      +'<div class="stat"><div class="k">Whales hold</div><div class="v">'+_ws.whalePct+'%</div></div>'
      +'<div class="stat"><div class="k">Top-1 holder</div><div class="v '+(_ws.top1>=10?'dn':'')+'">'+_ws.top1+'%</div></div>'
      +'<div class="stat"><div class="k">Top-10</div><div class="v '+(_ws.top10>=45?'dn':'up')+'">'+_ws.top10+'%</div></div>'
      +'<div class="stat"><div class="k">In contracts</div><div class="v">'+_ws.contractPct+'%</div></div>'
      +'<div class="stat"><div class="k">Concentration risk</div><div class="v '+(_ws.risk==='LOW'?'up':_ws.risk==='ELEVATED'?'':'dn')+'">'+_ws.risk+'</div></div></div>'
      +(_creator?('<div style="font-size:10.5px;color:var(--muted);margin-top:8px">Deployer: <span class="mono">'+_memeEsc(shortAddr(_creator))+'</span>'+(_owner&&_owner!==_creator?(' \u00b7 owner <span class="mono">'+_memeEsc(shortAddr(_owner))+'</span>'):'')
      +(_rg?' <span style="color:var(--bear);font-weight:700">\u26a0 KNOWN RUGGER \u2014 you marked '+(_rg.tokens||[]).length+' of their token(s)</span>':'')
      +' <button class="tbtn" id="markRugBtn" style="padding:2px 8px;font-size:10px;margin-left:6px">\ud83d\udea9 mark token as rug</button></div>'):'<div style="font-size:10px;color:var(--muted2);margin-top:8px">GoPlus returned no deployer address for this token.</div>');
      const mrb=document.getElementById('markRugBtn');if(mrb)mrb.onclick=()=>{const who=_creator||_owner;if(!who){toast('No deployer address to mark','#E8A33D');return}
        markRugger(who,OC_HOLDER_CHAIN,addr,'marked from holder scan');toast('\ud83d\udea9 Deployer remembered \u2014 future launches by this wallet get flagged','#F0616D');renderRuggerList();};
    }}catch(e){}const _hk=OC_HOLDER_CHAIN+':'+addr.toLowerCase();const _prev=holderSnap(_hk,info.top10);const _hd=holderDelta(_prev,info.top10);const _ds=_hd!=null?(' \u00b7 '+(_hd>=0?'+':'')+_hd+'% vs last check'):'';
    const flags=[info.honeypot?'\u26a0 HONEYPOT':'', (info.sellTax>10||info.buyTax>10)?('tax '+Math.max(info.buyTax,info.sellTax).toFixed(0)+'%'):'', info.lpLocked!=null?('LP '+info.lpLocked.toFixed(0)+'% locked'):''].filter(Boolean).join(' \u00b7 ');
    ocSet('holderInfo','\u2713 top-10 hold '+info.top10.toFixed(1)+'% \u00b7 '+info.holderCount+' holders'+_ds+(flags?' \u00b7 '+flags:''), info.top10>50||info.honeypot?'bear':'bull');
  }catch(e){ocSet('holderInfo','\u2717 '+_memeEsc((e&&e.message)||e)+' \u2014 nothing shown rather than faking it.','bear');body.innerHTML='<tr><td colspan="4" style="padding:12px;color:var(--muted)">No data.</td></tr>'}
}
function explorerUrl(chain,addr){ /* chain-correct block explorer — unknown chain returns null, never a wrong link */
  const M={ethereum:'https://etherscan.io',bsc:'https://bscscan.com',base:'https://basescan.org',arbitrum:'https://arbiscan.io',
    polygon:'https://polygonscan.com',optimism:'https://optimistic.etherscan.io',avalanche:'https://snowtrace.io',
    fantom:'https://ftmscan.com',cronos:'https://cronoscan.com',linea:'https://lineascan.build',scroll:'https://scrollscan.com',
    zksync:'https://explorer.zksync.io',blast:'https://blastscan.io',gnosis:'https://gnosisscan.io',solana:'https://solscan.io'};
  if(!addr||!M[chain])return null;return M[chain]+(chain==='solana'?'/account/':'/address/')+addr;}
function renderHolders(info){
  const body=document.getElementById('holderBody');if(!body)return;
  if(!info.rows.length){body.innerHTML='<tr><td colspan="4" style="padding:12px;color:var(--muted)">No holder list returned for this token.</td></tr>';return}
  const ch=(typeof OC_HOLDER_CHAIN!=='undefined')?OC_HOLDER_CHAIN:'ethereum';
  body.innerHTML=info.rows.slice(0,20).map((h,i)=>{const ex=explorerUrl(ch,h.addr);
    return `<tr><td class="mono">${i+1}</td><td class="mono" style="font-size:10.5px">${_memeEsc(shortAddr(h.addr))}${h.isContract?' <span style="color:var(--muted2);font-size:9px">contract</span>':''}${h.locked?' <span class="up" style="font-size:9px">locked</span>':''}${h.tag?' <span style="color:var(--muted2);font-size:9px">'+_memeEsc(h.tag)+'</span>':''}
      ${h.addr&&!h.isContract?`<button class="tbtn whcopy" data-a="${_memeEsc(h.addr)}" title="copy full wallet address" style="padding:1px 6px;font-size:9px">\u29c9</button><button class="tbtn whfollow" data-a="${_memeEsc(h.addr)}" title="follow this whale: loads it in the Wallet Tracker below (accumulation/distribution verdicts) and registers it for server Telegram alerts if the service is running" style="padding:1px 6px;font-size:9px">\u2605 follow</button>`:''}</td>
      <td class="mono ${h.pct>20?'dn':''}">${h.pct.toFixed(2)}%</td>
      <td>${ex?`<a href="${ex}" target="_blank" rel="noopener" style="font-size:10px">view\u2197</a>`:'<span style="font-size:9px;color:var(--muted2)">no explorer mapped</span>'}</td></tr>`}).join('');
  body.querySelectorAll('.whcopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713';setTimeout(()=>{b.textContent='\u29c9'},1100)}catch(e){prompt('Copy wallet address:',b.dataset.a)}});
  body.querySelectorAll('.whfollow').forEach(b=>b.onclick=()=>{const a=b.dataset.a;
    const inp=document.getElementById('ocWalletAddr');if(inp)inp.value=a;
    try{if(typeof scanWallet==='function')scanWallet()}catch(e){}
    try{const sb=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
      fetch(sb+'/svc/onchain/watch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:a,chain:ch,min_usd:10000}),signal:AbortSignal.timeout(3000)})
        .then(r=>{toast(r.ok?'\u2605 Whale followed \u2014 tracker loaded + server will Telegram transfers \u2265$10k':'\u2605 Loaded in tracker \u2014 service refused watch registration','var(--gold)')})
        .catch(()=>{toast('\u2605 Loaded in Wallet Tracker \u2014 start mishel_service for Telegram whale alerts','var(--gold)')});
    }catch(e){}});
}

/* ---------- Wallet Tracker ---------- */
function normalizeTransfer(it,wallet){
  const w=(wallet||'').toLowerCase();
  const from=((it.from&&it.from.hash)||it.from||'').toLowerCase(),to=((it.to&&it.to.hash)||it.to||'').toLowerCase();
  const dir=to===w?'in':from===w?'out':'\u2014';
  const tok=it.token||{};const dec=+((it.total&&it.total.decimals)!=null?it.total.decimals:tok.decimals)||18;
  const raw=(it.total&&it.total.value!=null)?it.total.value:(it.value!=null?it.value:0);
  const amt=(+raw||0)/Math.pow(10,dec);
  return {time:it.timestamp||it.block_timestamp||'',token:tok.symbol||'?',name:tok.name||'',dir,amount:amt,counterparty:dir==='in'?from:to,hash:(it.tx_hash||it.transaction_hash||'')};
}
async function scanWallet(){
  const addr=((document.getElementById('ocWalletAddr')||{}).value||'').trim();
  const body=document.getElementById('walletBody');if(!body)return;
  if(!addr){ocSet('walletInfo','Paste a wallet address first.','gold');return}
  const base=BLOCKSCOUT[OC_WALLET_CHAIN];if(!base){ocSet('walletInfo','That chain isn\'t covered by the keyless explorer.','gold');return}
  ocSet('walletInfo','fetching recent transfers (Blockscout)\u2026');body.innerHTML='<tr><td colspan="5" style="padding:12px;color:var(--muted)">Loading\u2026</td></tr>';
  try{
    const r=await fetch(base+'/api/v2/addresses/'+addr+'/token-transfers?type=ERC-20',{signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json();const items=(j&&Array.isArray(j.items))?j.items:[];
    if(!items.length){ocSet('walletInfo','No recent ERC-20 transfers for this address on '+OC_WALLET_CHAIN+'.','gold');body.innerHTML='<tr><td colspan="5" style="padding:12px;color:var(--muted)">No transfers found.</td></tr>';return}
    const rows=items.slice(0,25).map(it=>normalizeTransfer(it,addr));
    window._walletRows=rows;renderWallet(rows);
    try{const fl=walletFlow(rows.map(r=>({tok:r.sym||r.tok||r.token,dir:r.dir,amt:+r.amt||0})));const fb=document.getElementById('walletFlowBox');
    if(fb&&fl.length){fb.innerHTML='<div style="font-size:10px;color:var(--muted2);letter-spacing:.06em;text-transform:uppercase;margin:6px 0 4px">Net flow this window \u2014 what this wallet is actually doing</div>'+fl.slice(0,6).map(r=>'<span class="pill '+(r.verdict==='ACCUMULATING'?'memelo':r.verdict==='DISTRIBUTING'?'memehi':'mememid')+'" style="margin:2px 4px 2px 0;font-size:10px">'+_memeEsc(String(r.tok).slice(0,10))+' '+r.verdict+'</span>').join('')+'<div style="font-size:9.5px;color:var(--muted2);margin-top:4px">From the fetched transfers only \u2014 a window, not full history. Ideas to copy, not commands: you execute at your broker.</div>';}else if(fb)fb.innerHTML='';}catch(e){}
    ocSet('walletInfo','\u2713 '+rows.length+' recent transfers on '+OC_WALLET_CHAIN+' \u00b7 real Blockscout data','bull');
  }catch(e){ocSet('walletInfo','\u2717 '+_memeEsc((e&&e.message)||e)+' \u2014 explorer unreachable or address invalid. Nothing faked.','bear');body.innerHTML='<tr><td colspan="5" style="padding:12px;color:var(--muted)">No data.</td></tr>'}
}
function renderWallet(rows){
  const body=document.getElementById('walletBody');if(!body)return;
  body.innerHTML=rows.map(t=>{const when=t.time?String(t.time).replace('T',' ').slice(0,16):'\u2014';
    return `<tr><td style="font-size:10px;color:var(--muted)">${_memeEsc(when)}</td><td><b>${_memeEsc(t.token)}</b></td><td class="${t.dir==='in'?'up':t.dir==='out'?'dn':''}">${t.dir==='in'?'\u2193 in':t.dir==='out'?'\u2191 out':'\u2014'}</td><td class="mono">${t.amount>=1?t.amount.toLocaleString(undefined,{maximumFractionDigits:2}):t.amount.toPrecision(3)}</td><td class="mono" style="font-size:10px">${_memeEsc(shortAddr(t.counterparty))}</td></tr>`;
  }).join('');
}

function initOnChain(){
  const w=(id,fn,ev)=>{const el=document.getElementById(id);if(el&&!el._ocw){el._ocw=1;el[ev||'onclick']=fn}};
  w('launchScan',scanLaunches);w('holderScan',scanHolders);w('walletScan',scanWallet);
  const lc=document.getElementById('ocLaunchChain');if(lc&&!lc._ocw){lc._ocw=1;lc.onchange=()=>{OC_LAUNCH_CHAIN=lc.value}}
  const hc=document.getElementById('ocHolderChain');if(hc&&!hc._ocw){hc._ocw=1;hc.onchange=()=>{OC_HOLDER_CHAIN=hc.value}}
  const wc=document.getElementById('ocWalletChain');if(wc&&!wc._ocw){wc._ocw=1;wc.onchange=()=>{OC_WALLET_CHAIN=wc.value}}
}

/* ================= v14.6 POWER PACK — config backup · signal attribution · backtest explainer · wallet watchlist ================= */
/* -- pure logic (unit-tested) -- */
function collectConfig(store){const out={_meta:{app:'Mishel Intelligence Trading',ver:(typeof APP_VER!=='undefined'?APP_VER:''),exported:new Date().toISOString()},keys:{}};for(let i=0;i<store.length;i++){const k=store.key(i);if(k&&k.indexOf('mishel')===0)out.keys[k]=store.getItem(k)}return out}
function applyConfig(cfg,store){if(!cfg||!cfg.keys||typeof cfg.keys!=='object')return 0;let n=0;Object.keys(cfg.keys).forEach(k=>{if(k.indexOf('mishel')===0){store.setItem(k,cfg.keys[k]);n++}});return n}
function attributeConsensus(con){if(!con||!Array.isArray(con.votes)||!con.votes.length)return [];const V=con.votes.map(v=>({name:v.name,cat:v.cat,vote:+v.vote||0,w:+v.w||0}));const wsum=V.reduce((a,v)=>a+v.w,0)||1;const out=V.map(v=>({name:v.name,cat:v.cat,vote:v.vote,contribution:+(v.vote*v.w/wsum*100).toFixed(1)}));out.sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution));return out}
function explainBacktest(s){s=s||{};const strong=[],weak=[],notes=[];const num=v=>(v==null||!isFinite(v))?null:v;const tr=num(s.trades)||0,pf=num(s.pf),sh=num(s.sharpe),psr=num(s.psr),ror=num(s.ror),mdd=num(s.mdd),oos=num(s.oosR),is=num(s.isR);if(tr<20)notes.push('Only '+tr+' trades \u2014 too few to trust; treat as anecdotal until 30+.');if(pf!=null){if(pf>=1.5)strong.push('Profit factor '+pf.toFixed(2)+' \u2014 gross wins clearly exceed losses.');else if(pf<1)weak.push('Profit factor '+pf.toFixed(2)+' (<1) \u2014 loses money gross.')}if(sh!=null){if(sh>=1)strong.push('Per-trade Sharpe '+sh.toFixed(2)+' \u2014 smooth risk-adjusted returns.');else if(sh<0.3)weak.push('Low per-trade Sharpe ('+sh.toFixed(2)+') \u2014 noisy vs risk.')}if(psr!=null){if(psr>=0.9)strong.push('PSR '+(psr*100).toFixed(0)+'% \u2014 high confidence the edge is real, not luck.');else if(psr<0.6)weak.push('PSR only '+(psr*100).toFixed(0)+'% \u2014 could be selection luck.')}if(ror!=null){if(ror<=0.05)strong.push('Risk-of-ruin '+(ror*100).toFixed(0)+'% \u2014 survives resampling.');else if(ror>0.2)weak.push('Risk-of-ruin '+(ror*100).toFixed(0)+'% \u2014 a bad ordering could wipe you out.')}if(oos!=null&&is!=null){if(oos>0&&oos>=is*0.5)strong.push('Out-of-sample held up ('+oos.toFixed(1)+'R OOS vs '+is.toFixed(1)+'R IS).');else if(oos<=0)weak.push('Out-of-sample fell apart ('+oos.toFixed(1)+'R) \u2014 likely curve-fit.')}if(mdd!=null&&mdd>=40)weak.push('Deep max drawdown ('+mdd.toFixed(0)+'%) \u2014 hard to sit through.');let verdict;const sc=strong.length-weak.length;if(tr<20)verdict=['Insufficient evidence','muted'];else if(sc>=2&&pf!=null&&pf>=1.2)verdict=['Promising \u2014 forward-test before sizing up','up'];else if(sc<=-1||(pf!=null&&pf<1))verdict=['Weak \u2014 likely no real edge here','dn'];else verdict=['Mixed \u2014 needs more data or refinement',''];return {verdict,strong,weak,notes}}
function holderDelta(prev,cur){if(prev==null||cur==null||!isFinite(prev)||!isFinite(cur))return null;return +(cur-prev).toFixed(2)}

/* -- F8: config export / import -- */
