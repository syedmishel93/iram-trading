function scoutWallets(inp){
  inp=inp||{};const holders=Array.isArray(inp.holders)?inp.holders:[];const trs=Array.isArray(inp.transfers)?inp.transfers:[];
  const ruggers=inp.ruggers||{};const creator=(inp.creator||'').toLowerCase(),owner=(inp.owner||'').toLowerCase();
  const isC=h=>!!h.isContract;
  const whales=holders.filter(h=>h.addr&&!isC(h)&&h.pct>=1).sort((a,b)=>b.pct-a.pct).slice(0,5)
    .map(h=>({addr:h.addr,score:+h.pct.toFixed(2),reasons:['holds '+h.pct.toFixed(2)+'% of supply'+(h.locked?' (locked)':'')]}));
  const flow={};trs.forEach(t=>{const f=(t.from||'').toLowerCase(),to=(t.to||'').toLowerCase();
    if(f){flow[f]=flow[f]||{i:0,o:0};flow[f].o++}if(to){flow[to]=flow[to]||{i:0,o:0};flow[to].i++}});
  const holderSet={};holders.forEach(h=>{if(h.addr)holderSet[h.addr.toLowerCase()]=h});
  const makers=Object.entries(flow).filter(([a,f])=>{if(!a||a===creator||a===owner)return false;
      const h=holderSet[a];if(h&&isC(h))return false;
      const r=f.o?f.i/f.o:99;return f.i>=3&&f.o>=3&&r>=0.5&&r<=2;})
    .map(([a,f])=>({addr:a,score:Math.min(f.i,f.o),reasons:[f.i+' in / '+f.o+' out in the sampled transfers \u2014 two-way flow (market-maker-like churn, or an active swing wallet)']}))
    .sort((a,b)=>b.score-a.score).slice(0,5);
  const earlyCut=Math.max(5,Math.floor(trs.length*0.2));const seen={};const early=[];
  trs.slice(0,earlyCut).forEach((t,i)=>{const to=(t.to||'').toLowerCase();
    if(!to||seen[to]||to===creator||to===owner)return;seen[to]=1;
    const h=holderSet[to];if(!h||isC(h))return;
    early.push({addr:to,score:+(h.pct||0).toFixed(2),reasons:['received in the first '+earlyCut+' recorded transfers (#'+(i+1)+') and STILL holds '+(h.pct||0).toFixed(2)+'% \u2014 early accumulator (honest proxy: realized profit cannot be verified from free data)']});});
  early.sort((a,b)=>b.score-a.score);
  const risky=[];const push=(addr,why)=>{if(!addr)return;const ex=risky.find(r=>r.addr===addr);if(ex){ex.reasons.push(why);ex.score++}else risky.push({addr,score:1,reasons:[why]})};
  if(creator)push(creator,'token deployer \u2014 controls launch mechanics');
  if(owner&&owner!==creator)push(owner,'contract owner \u2014 can hold privileged functions');
  Object.keys(ruggers).forEach(a=>{const al=a.toLowerCase();
    if(al===creator||al===owner||flow[al]||holderSet[al])push(al,'in YOUR rugpuller registry \u2014 flagged from a previous rug');});
  if(creator){let fromDep={};trs.forEach(t=>{if((t.from||'').toLowerCase()===creator){const to=(t.to||'').toLowerCase();if(to)fromDep[to]=(fromDep[to]||0)+1}});
    Object.entries(fromDep).forEach(([a,n])=>{const h=holderSet[a];if(h&&h.pct>=5)push(a,'received tokens directly from the deployer and holds '+h.pct.toFixed(1)+'% \u2014 insider-allocation pattern')});}
  return {whales,makers,early:early.slice(0,5),risky:risky.slice(0,5),
    sampled:{holders:holders.length,transfers:trs.length}};}
/* ================= v20.0 SMART MONEY DESK — wallet DB + pure intelligence (unit-tested) ================= */
function wdbLoad(){try{return JSON.parse(localStorage.getItem('mishel_walletdb')||'{}')}catch(e){return{}}}
function wdbSave(db){try{STORE.set('mishel_walletdb',JSON.stringify(db))}catch(e){}}
function wdbMergeRec(db,addr,chain,cat,token,extra){ /* pure: merge one classification into the DB object */
  const a=(addr||'').toLowerCase();if(!a)return db;
  const r=db[a]||{addr:a,chains:[],cats:{},tokens:[],flags:[],first:Date.now(),last:0};
  if(chain&&r.chains.indexOf(chain)<0)r.chains.push(chain);
  if(cat)r.cats[cat]=(r.cats[cat]||0)+1;
  if(token){const tl=(token||'').toLowerCase();if(!r.tokens.some(t=>t.t===tl))r.tokens.push({t:tl,chain:chain||'',cat:cat||''});}
  if(extra&&extra.flag&&r.flags.indexOf(extra.flag)<0)r.flags.push(extra.flag);
  if(extra&&extra.reason){r.lastReason=extra.reason}
  r.last=Date.now();db[a]=r;return db;}
function smartScore(rec,now){ /* pure: cross-token behavioral score, recency-decayed (D8), components listed */
  now=now||Date.now();const W={early:3,whale:2,maker:1.5};const parts=[];let base=0;
  Object.entries(rec.cats||{}).forEach(([c,n])=>{if(W[c]){base+=W[c]*n;parts.push(n+'\u00d7 '+c+' (+'+(W[c]*n).toFixed(1)+')')}});
  const tok=Math.max(1,(rec.tokens||[]).length);const mult=1+Math.log2(tok);
  if(tok>1)parts.push(tok+' distinct tokens (\u00d7'+mult.toFixed(2)+' cross-token)');
  const ageD=(now-(rec.last||now))/86400000;const decay=Math.pow(0.5,ageD/14);
  if(ageD>1)parts.push(ageD.toFixed(0)+'d inactive (\u00d7'+decay.toFixed(2)+' decay)');
  const risky=(rec.cats&&rec.cats.risky)||0;if(risky)parts.push('risk-classified '+risky+'\u00d7 \u2014 excluded from smart rank');
  return {score:+(base*mult*decay).toFixed(2),parts,risky:risky>0};}
function coHolding(db){ /* pure D5: tokens touched by >=2 DB wallets */
  const byTok={};Object.values(db||{}).forEach(r=>{(r.tokens||[]).forEach(t=>{(byTok[t.t]=byTok[t.t]||{token:t.t,chain:t.chain,wallets:[]}).wallets.push(r.addr)})});
  return Object.values(byTok).filter(x=>x.wallets.length>=2).sort((a,b)=>b.wallets.length-a.wallets.length).slice(0,10);}
function manipFlags(transfers){ /* pure B5: named wash-like patterns with evidence */
  const trs=Array.isArray(transfers)?transfers:[];const pair={},dirs={};
  trs.forEach(t=>{const f=(t.from||'').toLowerCase(),to=(t.to||'').toLowerCase();if(!f||!to)return;
    pair[f+'>'+to]=(pair[f+'>'+to]||0)+1;
    (dirs[f]=dirs[f]||[]).push('o');(dirs[to]=dirs[to]||[]).push('i');});
  const circular=[];Object.keys(pair).forEach(k=>{const [a,b]=k.split('>');
    if(a<b&&pair[a+'>'+b]>=2&&pair[b+'>'+a]>=2)circular.push({a,b,ab:pair[a+'>'+b],ba:pair[b+'>'+a]});});
  const flippers=[];Object.entries(dirs).forEach(([a,seq])=>{let flips=0;for(let i=1;i<seq.length;i++)if(seq[i]!==seq[i-1])flips++;
    if(seq.length>=6&&flips>=4)flippers.push({addr:a,flips,n:seq.length});});
  return {circular:circular.slice(0,5),flippers:flippers.sort((x,y)=>y.flips-x.flips).slice(0,5)};}
function freshness(txCount){ /* pure D6: low-history wallet flag from total tx count */
  const n=+txCount;if(!Number.isFinite(n)||n<0)return null;
  if(n<=10)return {flag:'FRESH',txt:'fresh wallet \u2014 only '+n+' transactions ever (classic insider/manipulation tell when it buys big)'};
  if(n<=50)return {flag:'YOUNG',txt:'young wallet \u2014 '+n+' transactions total'};
  return null;}
function divergenceRead(whaleDeltaPct,priceChgPct){ /* pure D7: whale flow vs price divergence */
  if(whaleDeltaPct==null||priceChgPct==null||!Number.isFinite(+whaleDeltaPct)||!Number.isFinite(+priceChgPct))return null;
  const w=+whaleDeltaPct,p=+priceChgPct;
  if(w>=0.5&&p<=-3)return {kind:'ACCUMULATION INTO WEAKNESS',txt:'top holders ADDED '+w.toFixed(1)+'% of supply while price fell '+p.toFixed(0)+'% \u2014 whales buying the dip (or trapping exit liquidity: verify LP + taxes)'};
  if(w<=-0.5&&p>=3)return {kind:'DISTRIBUTION INTO STRENGTH',txt:'top holders SHED '+Math.abs(w).toFixed(1)+'% of supply while price rose '+p.toFixed(0)+'% \u2014 whales selling into the pump'};
  return null;}
function wdbHarvest(res,chain,token,manip){ /* side-effect: classify scout results into the DB */
  try{let db=wdbLoad();
    (res.whales||[]).forEach(w=>db=wdbMergeRec(db,w.addr,chain,'whale',token,{reason:w.reasons[0]}));
    (res.makers||[]).forEach(w=>db=wdbMergeRec(db,w.addr,chain,'maker',token,{reason:w.reasons[0]}));
    (res.early||[]).forEach(w=>db=wdbMergeRec(db,w.addr,chain,'early',token,{reason:w.reasons[0]}));
    (res.risky||[]).forEach(w=>db=wdbMergeRec(db,w.addr,chain,'risky',token,{reason:w.reasons[0]}));
    if(manip){(manip.circular||[]).forEach(c=>{db=wdbMergeRec(db,c.a,chain,null,token,{flag:'circular \u2194 '+shortAddr(c.b)+' ('+c.ab+'/'+c.ba+')'});db=wdbMergeRec(db,c.b,chain,null,token,{flag:'circular \u2194 '+shortAddr(c.a)+' ('+c.ba+'/'+c.ab+')'})});
      (manip.flippers||[]).forEach(f=>db=wdbMergeRec(db,f.addr,chain,null,token,{flag:'rapid flip-flop: '+f.flips+' direction changes in '+f.n+' sampled transfers'}));}
    wdbSave(db);}catch(e){}}
function scoutChainOK(chain){return !!GP_CHAIN[chain]||chain==='solana'}
async function fetchScoutData(addr,chain){ /* shared fetch for scout + mass harvest — EVM (GoPlus) + Solana (GoPlus solana endpoint) */
  let holders=[],creator='',owner='',transfers=[];
  if(chain==='solana'){
    const r=await fetch('https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses='+addr,{signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw new Error('GoPlus Solana HTTP '+r.status);
    const j=await r.json();const d=j&&j.result&&(j.result[addr]||j.result[addr.toLowerCase()]);
    if(!d)throw new Error('no GoPlus Solana data');
    const hs=d.holders||(d.dev&&d.dev.holders)||[];
    holders=(Array.isArray(hs)?hs:[]).map(h=>({addr:h.account||h.address||'',pct:(+h.percent||0)*100,isContract:false,locked:(h.is_locked==1||h.tag==='locked'),tag:h.tag||''}));
    creator=((d.metadata&&d.metadata.update_authority)||(d.creators&&d.creators[0]&&d.creators[0].address)||'').toString();
    owner=((d.mint_authority&&d.mint_authority.authority)||'').toString();
    return {holders,transfers,creator,owner,chain};
  }
  const cid=GP_CHAIN[chain];if(!cid)throw new Error('chain not covered by GoPlus');
  const r=await fetch('https://api.gopluslabs.io/api/v1/token_security/'+cid+'?contract_addresses='+addr,{signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error('GoPlus HTTP '+r.status);
  const j=await r.json();const d=j&&j.result&&(j.result[addr.toLowerCase()]||j.result[addr]);
  if(!d)throw new Error('no GoPlus data');
  holders=(Array.isArray(d.holders)?d.holders:[]).map(h=>({addr:h.address||'',pct:(+h.percent||0)*100,isContract:h.is_contract==1,locked:h.is_locked==1,tag:h.tag||''}));
  if(BLOCKSCOUT[chain]){try{const tr=await fetch(BLOCKSCOUT[chain]+'/api/v2/tokens/'+addr+'/transfers',{signal:AbortSignal.timeout(10000)});
    if(tr.ok){const tj=await tr.json();transfers=((tj&&tj.items)||[]).map(it=>({from:(it.from&&it.from.hash)||'',to:(it.to&&it.to.hash)||'',time:it.timestamp||''}));transfers.reverse();}}catch(e){}}
  return {holders,transfers,creator:d.creator_address||'',owner:d.owner_address||''};}
window._smStop=false;
async function smMassHarvest(){
  const st=document.getElementById('smStat');const stop=document.getElementById('smHarvestStop');const go=document.getElementById('smHarvest');
  const rows=[].concat(window._launchRows||[],window._memeRows||[]);
  const uniq={};rows.forEach(r=>{if(r&&r.addr&&r.chain&&!uniq[r.chain+':'+r.addr])uniq[r.chain+':'+r.addr]=r});
  const all=Object.values(uniq);const list=all.filter(r=>scoutChainOK(r.chain)).slice(0,15);
  if(!list.length){st.textContent=all.length?('None of the '+all.length+' radar tokens are on a scannable chain (EVM or Solana) \u2014 robinhood/other CEX-listed rows can\'t be scouted on-chain.'):'Nothing to harvest \u2014 scan the New-Launch Radar and/or Meme Radar first, then come back.';return}
  const skipped=all.length-list.length;
  window._smStop=false;stop.style.display='';go.disabled=true;let done=0,found=0;
  for(const r of list){if(window._smStop)break;
    st.textContent='harvesting '+(done+1)+'/'+list.length+' \u2014 '+r.sym+' ('+r.chain+')\u2026';
    try{const data=await fetchScoutData(r.addr,r.chain);
      let ruggers={};try{(loadRuggers()||[]).forEach(x=>{ruggers[(x.addr||'').toLowerCase()]=true})}catch(e){}
      const res=scoutWallets({holders:data.holders,transfers:data.transfers,creator:data.creator,owner:data.owner,ruggers});
      wdbHarvest(res,r.chain,r.addr,manipFlags(data.transfers));
      found+=res.whales.length+res.makers.length+res.early.length+res.risky.length;
    }catch(e){}
    done++;renderSmartDesk();
    await new Promise(z=>setTimeout(z,1300));}
  st.textContent=(window._smStop?'stopped \u2014 ':'\u2713 done \u2014 ')+done+'/'+list.length+' scannable tokens scanned, '+found+' wallet classifications ('+Object.keys(wdbLoad()).length+' wallets in DB)'+(skipped?' \u00b7 '+skipped+' non-scannable rows skipped':'');
  stop.style.display='none';go.disabled=false;}
