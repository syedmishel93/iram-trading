function buyLinks(chain,addr){
  if(!addr)return[];const a=encodeURIComponent(addr);const L=[];
  if(chain==='solana'){L.push({name:'Jupiter',url:'https://jup.ag/swap/SOL-'+a});L.push({name:'Raydium',url:'https://raydium.io/swap/?outputMint='+a});}
  else if(chain==='bsc'){L.push({name:'PancakeSwap',url:'https://pancakeswap.finance/swap?outputCurrency='+a});}
  else if(['ethereum','base','arbitrum','optimism','polygon'].indexOf(chain)>=0){L.push({name:'Uniswap',url:'https://app.uniswap.org/swap?outputCurrency='+a+'&chain='+chain});}
  return L;}
function oppScore(r){
  const notes=[];let sc=0;
  const mom=+r._mom||0;const m=Math.max(0,Math.min(30,mom*0.3));sc+=m;if(m>15)notes.push('strong momentum +'+Math.round(m));
  const vl=(+r.liq>0)?(+r.vol24/+r.liq):0;const v=Math.max(0,Math.min(25,vl*8));sc+=v;if(vl>1.5)notes.push('vol/liq '+vl.toFixed(1)+'\u00d7 (hot) +'+Math.round(v));else if(vl<0.2&&r.liq>0)notes.push('thin turnover');
  const bs=(+r.sells>0)?(+r.buys/+r.sells):(+r.buys>0?2:1);const b=Math.max(0,Math.min(20,(bs-1)*20));sc+=b;if(bs>1.3)notes.push('buy pressure '+bs.toFixed(2)+' +'+Math.round(b));
  const age=+r.ageH||0;let ag=0;if(age>=6&&age<=24*14)ag=15;else if(age<6)ag=4;else ag=8;sc+=ag;notes.push(age<6?'very new (unproven)':(age<=24*14?'age sweet spot +15':'mature'));
  const rug=(r._rug&&+r._rug.score)||50;const pen=Math.round(rug*0.4);sc-=pen;if(pen>15)notes.push('rug-risk penalty \u2212'+pen);
  sc=Math.max(0,Math.min(100,Math.round(sc+10)));
  return {score:sc,notes,verdict:sc>=65?'OPPORTUNITY':(sc>=45?'WATCH':'PASS')};}
function shortAddr(a){return a?(a.length>14?a.slice(0,8)+'\u2026'+a.slice(-6):a):'\u2014'}
function renderMemeRows(rows){
  const body=document.getElementById('memeBody');if(!body)return;
  body.innerHTML=rows.map((r,idx)=>{
    const [lbl,cls]=rugBand(r._rug.score);
    const chg=r.chg24;const chgc=chg>=0?'up':'dn';
    const sec=r.sec?'':`<button class="tbtn memesec" data-i="${idx}" style="padding:2px 7px;font-size:10px">\ud83d\udee1 check</button>`;
    const secTag=r.sec?`<span style="font-size:9px;color:var(--muted2)">\u2713 verified</span>`:'';
    let _vv;try{_vv=tokenVerdict({liq:r.liq,vol24:r.vol24,chg24:r.chg24,buys:r.buys,sells:r.sells,ageDays:(r.ageH||0)/24,rug:lbl,smartCount:(function(){try{return tokenSmartMoney(wdbLoad(),r.addr).length}catch(e){return 0}})()});}catch(e){_vv={stance:'RESEARCH',col:'var(--muted)',conviction:50,line:'',confidence:'thin'}}
    return `<tr title="${_memeEsc((_vv.line||'')+' \u00b7 '+(r._rug.notes.join(' \u00b7 ')||'DexScreener metrics only'))}">
      <td><span class="pill" style="font-weight:700;color:${_vv.col};border-color:${_vv.col}" title="${_memeEsc(_vv.line)} \u00b7 conviction ${_vv.conviction} \u00b7 ${_vv.confidence} data">${_vv.stance}</span><div style="font-size:8px;color:var(--muted2);margin-top:1px">${_vv.conviction} \u00b7 ${_vv.confidence}</div></td>
      <td><b>${_memeEsc(r.sym)}</b> <span style="color:var(--muted2);font-size:10px">${_memeEsc((r.name||'').slice(0,16))}</span><div style="margin-top:2px"><span class="mono" style="font-size:9px;color:var(--muted2)">${_memeEsc(shortAddr(r.addr))}</span> <button class="tbtn memecopy" data-a="${_memeEsc(r.addr)}" title="copy full contract address" style="padding:0 5px;font-size:9px">\u29c9</button></div></td>
      <td style="font-size:10px;color:var(--muted)">${_memeEsc(r.chain)}</td>
      <td class="mono">${fmtAge(r.ageH)}</td>
      <td class="mono">${fmtUsd(r.liq)}</td>
      <td class="mono">${fmtUsd(r.vol24)}</td>
      <td class="mono ${chgc}">${chg>=0?'+':''}${(+chg).toFixed(0)}%</td>
      <td class="mono" style="font-size:10px">${r.buys}/${r.sells}</td>
      <td><span class="pill ${cls}">${lbl} ${r._rug.score}</span> ${secTag}</td>
      <td><span class="mono">${r._mom}</span> ${sec} ${r.url?`<a href="${_memeEsc(r.url)}" target="_blank" rel="noopener" style="font-size:10px">chart\u2197</a>`:''} <button class="tbtn memex" data-i="${idx}" style="padding:2px 7px;font-size:10px" title="address \u00b7 buy links \u00b7 safety checklist">\u2295</button></td>
    </tr>
    <tr class="memexrow" id="memex-${idx}" style="display:none"><td colspan="10" style="background:var(--panel);border-radius:8px;padding:10px 12px">
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:11px">
        <span style="color:var(--muted)">Contract:</span><span class="mono" style="color:var(--txt)">${_memeEsc(shortAddr(r.addr))}</span>
        <button class="tbtn memecopy" data-a="${_memeEsc(r.addr)}" style="padding:2px 8px;font-size:10px">\u29c9 copy full address</button>
        <span style="color:var(--muted)">Opportunity:</span><span class="pill ${oppScore(r).score>=65?'bull':(oppScore(r).score>=45?'':'bear')}">${oppScore(r).verdict} ${oppScore(r).score}</span>
        <span style="font-size:10px;color:var(--muted2)">${_memeEsc(oppScore(r).notes.join(' \u00b7 '))}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:11px;align-items:center">
        <span style="color:var(--muted)">Buy at:</span>
        ${buyLinks(r.chain,r.addr).map(l=>`<a href="${l.url}" target="_blank" rel="noopener" class="tbtn" style="padding:3px 9px;font-size:10.5px;text-decoration:none">${l.name}\u2197</a>`).join('')||'<span style="color:var(--muted2)">no verified DEX link for this chain \u2014 use the DexScreener chart link</span>'}
        ${r.url?`<a href="${_memeEsc(r.url)}" target="_blank" rel="noopener" class="tbtn" style="padding:3px 9px;font-size:10.5px;text-decoration:none">DexScreener\u2197</a>`:''}
        <button class="tbtn memedoss" data-i="${idx}" style="padding:3px 9px;font-size:10.5px">\ud83d\udd0e full safety dossier</button>
      </div>
      <div id="memedoss-${idx}" style="margin-top:8px"></div>
      <div style="margin-top:8px;font-size:10px;color:var(--muted2);line-height:1.7">Before buying, always: \u2460 copy the contract and confirm it matches the project you researched (fake clones are common) \u00b7 \u2461 run the safety dossier (honeypot / taxes / LP lock / rugger-registry hit) \u00b7 \u2462 check whale concentration on the On-Chain Desk \u00b7 \u2463 size small \u2014 meme liquidity vanishes fast. This terminal never executes trades; you buy at your own wallet/venue.</div>
    </td></tr>`;
  }).join('');
  body.querySelectorAll('.memesec').forEach(b=>b.onclick=()=>memeSecurity(+b.dataset.i,b));
  body.querySelectorAll('.memex').forEach(b=>b.onclick=()=>{const tr=document.getElementById('memex-'+b.dataset.i);if(tr)tr.style.display=(tr.style.display==='none'?'':'none')});
  body.querySelectorAll('.memecopy').forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.a);b.textContent='\u2713 copied';setTimeout(()=>{b.textContent='\u29c9 copy full address'},1200)}catch(e){prompt('Copy the contract address:',b.dataset.a)}});
  body.querySelectorAll('.memedoss').forEach(b=>b.onclick=async()=>{const r=(window._memeRows||[])[+b.dataset.i];const out=document.getElementById('memedoss-'+b.dataset.i);if(!r||!out)return;
    if(typeof buildDossier!=='function'){out.innerHTML='<span style="color:var(--muted)">dossier module unavailable</span>';return}
    b.disabled=true;b.textContent='building\u2026';
    try{await buildDossier(r.addr,r.chain,out)}catch(e){out.innerHTML='<span style="color:var(--bear)">\u2717 '+e.message+'</span>'}
    b.disabled=false;b.textContent='\ud83d\udd0e full safety dossier';});
}

async function memeSecurity(idx,btn){
  const rows=window._memeRows||[];const r=rows[idx];if(!r)return;
  if(r.chain==='solana'){btn.textContent='EVM only';btn.disabled=true;return}
  const cid=GP_CHAIN[r.chain];if(!cid){btn.textContent='n/a';btn.disabled=true;return}
  btn.textContent='checking\u2026';btn.disabled=true;
  try{
    const rr=await fetch('https://api.gopluslabs.io/api/v1/token_security/'+cid+'?contract_addresses='+r.addr,{signal:AbortSignal.timeout(10000)});
    if(!rr.ok)throw new Error('HTTP '+rr.status);
    const j=await rr.json();const key=(r.addr||'').toLowerCase();
    const d=j&&j.result&&(j.result[key]||j.result[r.addr]);
    if(!d)throw new Error('no data');
    const lpLocked=Array.isArray(d.lp_holders)?d.lp_holders.reduce((a,x)=>a+((x.is_locked==1)?(+x.percent||0):0),0)*100:null;
    const top10=Array.isArray(d.holders)?d.holders.slice(0,10).reduce((a,x)=>a+(+x.percent||0),0)*100:null;
    const sec={honeypot:d.is_honeypot=='1'||d.cannot_sell_all=='1',buyTax:(+d.buy_tax||0)*100,sellTax:(+d.sell_tax||0)*100,
      lpLocked,top10,mintable:d.is_mintable=='1',openSource:d.is_open_source=='1',
      canTakeBackOwnership:d.can_take_back_ownership=='1',hiddenOwner:d.hidden_owner=='1'};
    r.sec=sec;r._rug=memeRug(r,sec);
    renderMemeRows(rows);
    memeMsg('\u2713 security merged for '+_memeEsc(r.sym)+' (GoPlus) \u2014 rug-risk updated','bull');
  }catch(e){btn.textContent='failed';setTimeout(()=>{btn.textContent='\ud83d\udee1 check';btn.disabled=false},1500)}
}

function initMemeRadar(){
  const sc=document.getElementById('memeScan');if(sc&&!sc._wired){sc._wired=1;sc.onclick=scanMeme}
  const chSel=document.getElementById('memeChain');if(chSel&&!chSel._wired){chSel._wired=1;chSel.onchange=()=>{MEME_CHAIN=chSel.value}}
}

/* ================= v14.4 ON-CHAIN DESK — New-Launch Radar + Whale/Holder Tracker + Wallet Tracker =================
   Honesty & boundaries: every row is real data from DexScreener / GoPlus / Blockscout. Nothing is fabricated;
   a dead feed shows an honest empty state. This desk does NOT buy anything and never touches your keys \u2014 it is
   early-detection + risk screening so YOU decide and execute yourself. New launches are overwhelmingly rugs. */
let OC_HOLDER_CHAIN='ethereum', OC_WALLET_CHAIN='ethereum', OC_LAUNCH_CHAIN='all';
const BLOCKSCOUT={ethereum:'https://eth.blockscout.com',base:'https://base.blockscout.com',optimism:'https://optimism.blockscout.com',gnosis:'https://gnosis.blockscout.com',polygon:'https://polygon.blockscout.com',arbitrum:'https://arbitrum.blockscout.com',zksync:'https://zksync.blockscout.com',scroll:'https://scroll.blockscout.com',linea:'https://explorer.linea.build'};
function ocSet(id,html,tone){const b=document.getElementById(id);if(b)b.innerHTML='<span style="color:var(--'+(tone||'muted')+')">'+html+'</span>'}
function shortAddr(a){a=String(a||'');return a.length>12?a.slice(0,6)+'\u2026'+a.slice(-4):a}
function launchBand(ageH){return ageH==null?['?','']:ageH<6?['\u26a1 <6h','memehi']:ageH<24?['<24h','mememid']:ageH<72?['<3d','memelo']:['>3d','']}

/* ---------- New-Launch Radar ---------- */
async function scanLaunches(){
  const body=document.getElementById('launchBody');if(!body)return;
  ocSet('launchInfo','scanning newest DexScreener listings\u2026');body.innerHTML='<tr><td colspan="8" style="padding:14px;color:var(--muted)">Fetching newest token profiles\u2026</td></tr>';
  try{
    const pr=await fetch('https://api.dexscreener.com/token-profiles/latest/v1',{signal:AbortSignal.timeout(10000)});
    if(!pr.ok)throw new Error('profiles HTTP '+pr.status);
    let profs=await pr.json();if(!Array.isArray(profs))profs=[];
    if(OC_LAUNCH_CHAIN!=='all')profs=profs.filter(p=>p.chainId===OC_LAUNCH_CHAIN);
    profs=profs.slice(0,30);
    if(!profs.length){ocSet('launchInfo','No fresh listings for this chain right now \u2014 try All, or rescan shortly.','gold');body.innerHTML='<tr><td colspan="8" style="padding:14px;color:var(--muted)">Nothing to show \u2014 no fabricated launches.</td></tr>';return}
    const byChain={};profs.forEach(p=>{if(p.tokenAddress&&p.chainId)(byChain[p.chainId]=byChain[p.chainId]||[]).push(p.tokenAddress)});
    let pairs=[];
    for(const ch in byChain){try{const r=await fetch('https://api.dexscreener.com/latest/dex/tokens/'+byChain[ch].slice(0,30).join(','),{signal:AbortSignal.timeout(10000)});if(r.ok){const j=await r.json();if(j&&Array.isArray(j.pairs))pairs=pairs.concat(j.pairs)}}catch(e){}}
    if(!pairs.length)throw new Error('no pair data');
    const best={};pairs.forEach(p=>{const k=(p.baseToken&&p.baseToken.address)||p.pairAddress;const L=(p.liquidity&&p.liquidity.usd)||0;if(!best[k]||L>((best[k].liquidity&&best[k].liquidity.usd)||0))best[k]=p});
    let rows=Object.values(best).map(normalizePair).filter(Boolean);
    rows.forEach(r=>{r._rug=memeRug(r);r._mom=memeMomentum(r)});
    rows.sort((a,b)=>(a.ageH==null?1e9:a.ageH)-(b.ageH==null?1e9:b.ageH));
    if(!rows.length){ocSet('launchInfo','No usable pairs returned.','gold');body.innerHTML='<tr><td colspan="8" style="padding:14px;color:var(--muted)">Nothing to show.</td></tr>';return}
    window._launchRows=rows;renderLaunchRows(rows);
    ocSet('launchInfo','\u2713 '+rows.length+' freshest listings \u00b7 newest first \u00b7 real DexScreener data \u00b7 most new tokens fail \u2014 this is a research/risk screen, not a buy signal','bull');
  }catch(e){ocSet('launchInfo','\u2717 Couldn\'t reach DexScreener ('+_memeEsc((e&&e.message)||e)+'). Nothing shown rather than faking it \u2014 retry shortly.','bear');body.innerHTML='<tr><td colspan="8" style="padding:14px;color:var(--muted)">No live data \u2014 no synthetic launches.</td></tr>'}
}
/* v18.5 SMART WALLET SCOUT — transparent heuristics on public on-chain data.
   HONESTY: these are pattern screens, not proof. "Early accumulator" is the closest honest proxy
   for "profitable trader" from free data — realized PnL per wallet cannot be verified without
   full trade-by-trade price history, so we never claim it. */
