function ribbonSegs(hist){ /* [{t,regime}] -> merged segments [{regime,from,to,n}] */
  const out=[];(hist||[]).forEach(h=>{if(!h||h.regime==null)return;
    const last=out[out.length-1];
    if(last&&last.regime===h.regime){last.to=h.t;last.n++}
    else out.push({regime:h.regime,from:h.t,to:h.t,n:1})});
  return out}
/* v15.3 renders — corr/lead-lag, meta-label gate, regime ribbon + feature store */
function gatherWatchBars(n){ /* per-WATCH-symbol closes: seeded synthetic offline (labeled), same series the watchlist shows */
  n=n||220;const out={};WATCH.slice(0,10).forEach(s=>{try{out[s]=genData(n,SPECS[s].px,(s.charCodeAt(0)+s.length)*13).map(c=>c.c)}catch(e){}});return out}
function renderCorrMatrix(){
  const host=document.getElementById('corrOut');if(!host)return;
  const bars=gatherWatchBars(220);const syms=Object.keys(bars);
  if(syms.length<3){host.innerHTML='<span style="color:var(--muted)">Need \u22653 watchlist symbols.</span>';return}
  const rets={};syms.forEach(s=>{const c=bars[s];const r=[];for(let i=1;i<c.length;i++)r.push(Math.log(c[i]/c[i-1]));rets[s]=r});
  let cells='<tr><th></th>'+syms.map(s=>'<th style="font-size:9px">'+s.replace('USD','')+'</th>').join('')+'</tr>';
  syms.forEach(a=>{cells+='<tr><th style="font-size:9px;text-align:right">'+a.replace('USD','')+'</th>'+syms.map(b=>{
    if(a===b)return '<td style="text-align:center;color:var(--muted2)">\u2014</td>';
    const c=pearson(rets[a],rets[b]);const col=c>0?'rgba(45,190,142,'+(Math.abs(c)*0.55).toFixed(2)+')':'rgba(240,97,109,'+(Math.abs(c)*0.55).toFixed(2)+')';
    return '<td class="mono" style="text-align:center;background:'+col+'">'+c.toFixed(2)+'</td>'}).join('')+'</tr>'});
  /* lead-lag: strongest |corr| pairs with their best lag */
  const pairs=[];for(let i=0;i<syms.length;i++)for(let j=i+1;j<syms.length;j++){const ll=leadLagBest(rets[syms[i]],rets[syms[j]],8);pairs.push({a:syms[i],b:syms[j],lag:ll.lag,corr:ll.corr})}
  pairs.sort((x,y)=>Math.abs(y.corr)-Math.abs(x.corr));
  const lead=pairs.slice(0,6).map(p=>{const who=p.lag>0?p.a+' leads '+p.b+' by '+p.lag:p.lag<0?p.b+' leads '+p.a+' by '+(-p.lag):'coincident';
    return '<div style="font-size:11px;padding:2px 0"><span class="mono '+(p.corr>0?'up':'dn')+'">'+p.corr.toFixed(2)+'</span> \u00b7 '+p.a.replace('USD','')+'\u2194'+p.b.replace('USD','')+' \u2014 '+who+' bar(s)'}).join('</div>')+'</div>';
  host.innerHTML='<table class="log" style="font-family:var(--mono);font-size:10px">'+cells+'</table>'
    +'<div style="font-size:10px;color:var(--muted2);letter-spacing:.06em;text-transform:uppercase;margin:10px 0 4px">Strongest lead-lag relationships (\u00b18 bars scanned)</div>'+lead
    +'<div style="font-size:10px;color:var(--muted2);margin-top:8px">Computed on the same series the watchlist shows \u2014 <b>seeded synthetic while offline</b>; connect the proxy and use the Screener for live reads. A lead of k bars means the leader\u2019s move tends to show up in the other k bars later on THIS sample \u2014 correlation, not causation.</div>';
}
function renderMetaGate(){
  const host=document.getElementById('metaOut');if(!host)return;
  const T=(window._trades||[]).filter(t=>isFinite(t.R)&&t.entryI!=null);
  if(T.length<30){host.innerHTML='<span style="color:var(--muted)">Run a backtest first (Strategy Tester) \u2014 the gate needs \u226530 real trades; there are '+T.length+' from the last run. Nothing is synthesised.</span>';return}
  let arr;try{arr=indicatorsFor(DATA)}catch(e){host.innerHTML='<span style="color:var(--gold)">Indicator context unavailable.</span>';return}
  const feats=T.map(t=>{const i=Math.min(DATA.length-1,t.entryI);
    return [t.side||0,(arr.adx[i]||0),(arr.rsi[i]||50)-50,(arr.atr[i]||0)/(DATA[i].c||1)*100,new Date(DATA[i].t).getUTCHours()/23]});
  const res=metaLabelGate(feats,T.map(t=>t.R),0.7);
  if(!res.ok){host.innerHTML='<span style="color:var(--muted)">'+_memeEsc(res.reason)+'.</span>';return}
  const pc=v=>v==null?'\u2014':(v*100).toFixed(0)+'%';const fR=v=>v==null?'\u2014':((v>=0?'+':'')+v.toFixed(2)+'R');
  host.innerHTML='<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;font-size:11px">'
    +'<div class="stat"><div class="k">OOS trades (all)</div><div class="v">'+res.all.n+' \u00b7 '+pc(res.all.wr)+' \u00b7 '+fR(res.all.avgR)+'</div></div>'
    +'<div class="stat"><div class="k">Gate kept</div><div class="v">'+res.kept.n+' \u00b7 '+pc(res.kept.wr)+' \u00b7 '+fR(res.kept.avgR)+'</div></div>'
    +'<div class="stat"><div class="k">Gate skipped</div><div class="v">'+res.skipped.n+' \u00b7 '+pc(res.skipped.wr)+' \u00b7 '+fR(res.skipped.avgR)+'</div></div>'
    +'<div class="stat"><div class="k">Avg-R uplift (kept vs all)</div><div class="v '+(res.uplift>0?'up':res.uplift<0?'dn':'')+'">'+fR(res.uplift)+'</div></div></div>'
    +'<div style="margin-top:8px;font-size:11px;color:var(--txt)">'+_memeEsc(res.verdict)+'</div>'
    +'<div style="font-size:10px;color:var(--muted2);margin-top:6px">Logistic gate on [side, ADX, RSI, ATR%, hour] \u2014 trained on the first '+res.nTrain+' trades, judged only on the last '+res.nTest+' (chronological, no leakage). If it says no uplift, believe it.</div>';
}
async function renderSvcPanels(){
  const rb=document.getElementById('ribbonOut'),fsb=document.getElementById('fstoreOut');
  const base='http://127.0.0.1:8788';
  if(rb){try{const closes=(typeof DATA!=='undefined'&&DATA.length)?DATA.slice(-300).map(c=>c.c):[];if(closes.length<50)throw new Error('need \u226550 bars loaded');const r=await fetch(base+'/svc/ml/regime',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({closes:closes}),signal:AbortSignal.timeout(6000)});const j=await r.json();
    let hist=(j&&(j.history||j.regimes))||[];if(!hist.length&&j&&Array.isArray(j.labels))hist=j.labels.map((rg,i)=>({t:i,regime:rg}));const segs=ribbonSegs(hist);
    if(!segs.length)throw new Error('no regime history yet');
    rb.innerHTML='<div style="display:flex;height:16px;border-radius:4px;overflow:hidden;border:1px solid var(--edge)">'+segs.map(s=>'<div title="'+_memeEsc(String(s.regime))+' \u00d7'+s.n+'" style="flex:'+s.n+';background:'+(/high|risk.?off|bear/i.test(String(s.regime))?'rgba(240,97,109,.6)':/low|risk.?on|bull/i.test(String(s.regime))?'rgba(45,190,142,.55)':'rgba(138,148,166,.4)')+'"></div>').join('')+'</div><div style="font-size:10px;color:var(--muted2);margin-top:5px">'+segs.length+' regime segment(s) from the service GMM \u2014 newest right.</div>';
  }catch(e){rb.innerHTML='<span style="color:var(--muted)">Service regime feed offline ('+_memeEsc((e&&e.message)||e)+') \u2014 start mishel_service.py (port 8788). Nothing simulated.</span>'}}
  if(fsb){try{const r=await fetch(base+'/svc/data/snapshot',{signal:AbortSignal.timeout(3000)});const j=await r.json();
    const rows=Object.entries(j&&(j.features||j.data||{})).slice(0,14);
    if(!rows.length)throw new Error('snapshot empty');
    fsb.innerHTML='<table class="log" style="font-size:11px"><tbody>'+rows.map(([k,v])=>'<tr><td style="color:var(--muted)">'+_memeEsc(k)+'</td><td class="mono">'+_memeEsc(typeof v==='object'?JSON.stringify(v).slice(0,60):String(v))+'</td></tr>').join('')+'</tbody></table><div style="font-size:10px;color:var(--muted2);margin-top:5px">Live feature-store snapshot from the background service.</div>';
  }catch(e){fsb.innerHTML='<span style="color:var(--muted)">Feature store offline ('+_memeEsc((e&&e.message)||e)+') \u2014 start mishel_service.py. Nothing simulated.</span>'}}
}
/* ================= v15.2 ON-CHAIN PACK — whale numbers · rugpuller/deployer tracker · token dossier · wallet flow ================= */
/* -- pure logic (unit-tested) -- */
function whaleStats(rows,holderCount){ /* rows: [{addr,pct,isContract,locked}] pct in % */
  rows=rows||[];const whales=rows.filter(h=>h.pct>=1&&!h.isContract&&!h.locked);
  const top10=rows.slice(0,10).reduce((a,x)=>a+x.pct,0);
  const top1=rows.length?rows[0].pct:0;
  const contractPct=rows.filter(h=>h.isContract).reduce((a,x)=>a+x.pct,0);
  let risk='LOW';if(top1>=20||top10>=60)risk='EXTREME';else if(top1>=10||top10>=45)risk='HIGH';else if(top10>=30)risk='ELEVATED';
  return{whaleCount:whales.length,whalePct:+whales.reduce((a,x)=>a+x.pct,0).toFixed(2),top1:+top1.toFixed(2),top10:+top10.toFixed(2),contractPct:+contractPct.toFixed(2),holderCount:holderCount||rows.length,risk:risk};
}
function walletFlow(transfers){ /* transfers: [{tok,dir,amt}] -> per-token net + verdict so you can see what a whale is really doing */
  const by={};(transfers||[]).forEach(t=>{if(!t||!t.tok||!isFinite(+t.amt))return;const k=t.tok;by[k]=by[k]||{tok:k,inn:0,out:0,n:0};if(t.dir==='in')by[k].inn+=+t.amt;else if(t.dir==='out')by[k].out+=+t.amt;by[k].n++});
  const rows=Object.values(by).map(r=>{const net=r.inn-r.out;const tot=r.inn+r.out;
    const verdict=tot<=0?'—':net>tot*0.15?'ACCUMULATING':net<-tot*0.15?'DISTRIBUTING':'CHURNING';
    return{tok:r.tok,inn:r.inn,out:r.out,net:net,n:r.n,verdict:verdict}});
  rows.sort((a,b)=>Math.abs(b.net)-Math.abs(a.net));return rows;
}
/* -- rugpuller / deployer reputation registry (protective screening: YOU mark rugs, it remembers the deployer) -- */
function loadRuggers(){try{return JSON.parse(localStorage.getItem('mishel_ruggers')||'[]')}catch(e){return[]}}
function saveRuggers(a){try{STORE.set('mishel_ruggers',JSON.stringify((a||[]).slice(0,400)))}catch(e){}}
function markRugger(deployer,chain,tokenAddr,note){
  deployer=(deployer||'').toLowerCase().trim();if(!deployer||deployer.length<8)return null;
  const L=loadRuggers();let e=L.find(x=>x.addr===deployer);
  if(!e){e={addr:deployer,chains:[],tokens:[],notes:[],added:Date.now()};L.push(e)}
  if(chain&&e.chains.indexOf(chain)<0)e.chains.push(chain);
  const ta=(tokenAddr||'').toLowerCase();if(ta&&e.tokens.indexOf(ta)<0)e.tokens.push(ta);
  if(note)e.notes.push(String(note).slice(0,80));
  saveRuggers(L);return e;
}
function flagRugger(deployer,owner){ /* returns match record if deployer OR owner is a known rugger */
  const L=loadRuggers();const d=(deployer||'').toLowerCase(),o=(owner||'').toLowerCase();
  return L.find(x=>x.addr&&(x.addr===d||x.addr===o))||null;
}
function unmarkRugger(addr){const L=loadRuggers();const i=L.findIndex(x=>x.addr===(addr||'').toLowerCase());if(i<0)return false;L.splice(i,1);saveRuggers(L);return true}
/* -- cross-source token dossier: DexScreener pair + GoPlus security + holder stats -> one honest verdict -- */
function dossierVerdict(dx,sec,ws){
  const flags=[],good=[];
  if(sec){if(sec.honeypot)flags.push('HONEYPOT \u2014 you may not be able to sell');
    if(sec.sellTax>=15)flags.push('sell tax '+sec.sellTax.toFixed(0)+'%');else if(sec.sellTax>=8)flags.push('elevated sell tax '+sec.sellTax.toFixed(0)+'%');
    if(sec.buyTax>=15)flags.push('buy tax '+sec.buyTax.toFixed(0)+'%');
    if(sec.mintable)flags.push('mintable \u2014 supply can be inflated');
    if(sec.openSource===false)flags.push('closed-source contract');
    if(sec.lpLocked!=null){if(sec.lpLocked<20)flags.push('LP only '+sec.lpLocked.toFixed(0)+'% locked');else if(sec.lpLocked>=80)good.push('LP '+sec.lpLocked.toFixed(0)+'% locked')}}
  if(ws){if(ws.risk==='EXTREME')flags.push('extreme holder concentration (top-10 '+ws.top10+'%)');
    else if(ws.risk==='HIGH')flags.push('high holder concentration (top-10 '+ws.top10+'%)');
    else if(ws.risk==='LOW')good.push('healthy holder spread (top-10 '+ws.top10+'%)');
    if(ws.whaleCount>0)good.push(ws.whaleCount+' whale wallet'+(ws.whaleCount>1?'s':'')+' \u22651% ('+ws.whalePct+'% combined)')}
  if(dx){if(dx.liq!=null&&dx.liq<10000)flags.push('thin liquidity '+(typeof fmtUsd==='function'?fmtUsd(dx.liq):('$'+dx.liq)));
    else if(dx.liq!=null&&dx.liq>=100000)good.push('deep liquidity');
    if(dx.ageH!=null&&dx.ageH<24)flags.push('under 24h old \u2014 most new tokens fail')}
  if(typeof dossierVerdict._rugger==='object'&&dossierVerdict._rugger)flags.unshift('\u26a0 DEPLOYER PREVIOUSLY RUGGED '+((dossierVerdict._rugger.tokens||[]).length||'?')+' token(s) you marked');
  let grade,cls;const hard=flags.some(f=>/HONEYPOT|DEPLOYER PREVIOUSLY/.test(f));
  if(hard||flags.length>=4){grade='AVOID';cls='bear'}
  else if(flags.length>=2){grade='HIGH RISK';cls='gold'}
  else if(flags.length===1){grade='CAUTION';cls='gold'}
  else{grade='NO RED FLAGS FOUND';cls='bull'}
  return{grade:grade,cls:cls,flags:flags,good:good};
}
/* v15.2 dossier + rugger UI (async fetches; every failure is an honest empty state) */
function renderRuggerList(){
  const box=document.getElementById('ruggerList');if(!box)return;const L=loadRuggers();
  if(!L.length){box.innerHTML='<span style="color:var(--muted2);font-size:10.5px">No flagged deployers yet. Mark a token as a rug in the Whale/Holder scan, or paste a deployer above.</span>';return}
  box.innerHTML=L.map(r=>'<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--edge2)"><span class="mono" style="font-size:10.5px">'+_memeEsc(shortAddr(r.addr))+'</span><span style="color:var(--muted2);font-size:10px">'+(r.chains||[]).join(', ')+' \u00b7 '+(r.tokens||[]).length+' rug(s) marked</span><button class="tbtn rugdel" data-a="'+_memeEsc(r.addr)+'" style="padding:1px 7px;font-size:10px;margin-left:auto">\u2715</button></div>').join('')
    +'<div style="font-size:9.5px;color:var(--muted2);margin-top:6px">'+L.length+' flagged \u00b7 stored in your browser (mishel_ruggers) \u00b7 included in Config Export.</div>';
  box.querySelectorAll('.rugdel').forEach(b=>b.onclick=()=>{unmarkRugger(b.dataset.a);renderRuggerList()});
}
async function buildDossier(addrArg,chainArg,outArg){
  const addr=(typeof addrArg==='string'&&addrArg)?addrArg.trim():(((document.getElementById('dossierAddr')||{}).value||'').trim());
  let chain=(typeof chainArg==='string'&&chainArg)?chainArg:(((document.getElementById('dossierChain')||{}).value)||'');
  /* auto-detect: 0x + 40 hex = EVM; base58 without 0x = Solana. Fixes empty-select + pasted pump.fun addrs. */
  if(!chain){chain=/^0x[0-9a-fA-F]{40}$/.test(addr)?'ethereum':(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)?'solana':'ethereum');
    const csel=document.getElementById('dossierChain');if(csel){try{csel.value=chain}catch(e){}}}
  const out=(outArg&&outArg.nodeType===1)?outArg:document.getElementById('dossierOut');if(!out)return;
  if(!addr){out.innerHTML='<span style="color:var(--gold)">Paste a token contract address first.</span>';return}
  out.innerHTML='Fetching DexScreener + GoPlus\u2026';
  let dx=null,dxErr=null,sec=null,secErr=null,ws=null,creator='',owner='';
  const _isEVM=!!GP_CHAIN[chain];
  if(!_isEVM){secErr='GoPlus security is EVM-only \u2014 no honeypot/tax/LP check available for '+chain+' (Solana). DexScreener price/liquidity below is still real.';}
  try{const r=await fetch('https://api.dexscreener.com/latest/dex/tokens/'+addr,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();const ps=(j&&j.pairs)||[];
    if(ps.length){let best=ps[0];ps.forEach(p=>{if(((p.liquidity&&p.liquidity.usd)||0)>((best.liquidity&&best.liquidity.usd)||0))best=p});
      const np=normalizePair(best);if(np)dx=np;}
    if(!dx)dxErr='no pairs found';}catch(e){dxErr=(e&&e.message)||String(e)}
  if(_isEVM)try{const cid=GP_CHAIN[chain];
    const r=await fetch('https://api.gopluslabs.io/api/v1/token_security/'+cid+'?contract_addresses='+addr,{signal:AbortSignal.timeout(10000)});
    if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();const key=addr.toLowerCase();const d=j&&j.result&&(j.result[key]||j.result[addr]);
    if(!d)throw new Error('no security data');
    const info=parseHolders(d);ws=whaleStats(info.rows,info.holderCount);
    creator=(d.creator_address||'').toLowerCase();owner=(d.owner_address||'').toLowerCase();
    sec={honeypot:info.honeypot,buyTax:info.buyTax,sellTax:info.sellTax,lpLocked:info.lpLocked,mintable:d.is_mintable=='1',openSource:d.is_open_source=='1'};
  }catch(e){secErr=(e&&e.message)||String(e)}
  const rg=flagRugger(creator,owner);dossierVerdict._rugger=rg;
  const v=dossierVerdict(dx,sec,ws);dossierVerdict._rugger=null;
  /* v20 D7: whale-flow vs price divergence — top-10 concentration delta since your last dossier vs 24h price */
  let dvg=null;try{if(ws&&dx){const prev=holderSnap('doss:'+chain+':'+addr.toLowerCase(),ws.top10);
    const dTop=holderDelta(prev,ws.top10);const chg=(dx.priceChange&&+dx.priceChange.h24!=null)?+dx.priceChange.h24:(dx.chg24!=null?+dx.chg24:null);
    dvg=divergenceRead(dTop,chg);}}catch(e){}
  if(dvg){try{out._dvgNote='<div style="background:var(--gold-dim,rgba(232,163,61,.1));border:1px solid rgba(232,163,61,.4);border-radius:8px;padding:7px 10px;font-size:11px;color:var(--gold);margin:8px 0"><b>\u26a1 '+dvg.kind+'</b> \u2014 '+_memeEsc(dvg.txt)+'</div>'}catch(e){}}else{try{out._dvgNote=''}catch(e){}}
  const row=(k,val)=>'<tr><td style="width:130px;color:var(--muted)">'+k+'</td><td>'+val+'</td></tr>';
  out.innerHTML='<div style="margin-bottom:8px"><span class="pill '+(v.cls==='bull'?'memelo':v.cls==='gold'?'mememid':'memehi')+'" style="font-size:12px">'+v.grade+'</span>'
  try{if(out._dvgNote)out.insertAdjacentHTML('afterbegin',out._dvgNote)}catch(e){}
    +(rg?' <span style="color:var(--bear);font-weight:700;font-size:11px">\u26a0 deployer is in your rugger registry</span>':'')+'</div>'
    +'<table class="log" style="font-family:var(--ui)"><tbody>'
    +row('DexScreener',dx?(_memeEsc(dx.sym||'?')+' \u00b7 liq '+fmtUsd(dx.liq)+' \u00b7 24h vol '+fmtUsd(dx.vol24)+' \u00b7 age '+fmtAge(dx.ageH)+(dx.url?' \u00b7 <a href="'+_memeEsc(dx.url)+'" target="_blank" rel="noopener">chart\u2197</a>':'')):'<span style="color:var(--gold)">unavailable ('+_memeEsc(dxErr||'')+') \u2014 not filled in</span>')
    +row('GoPlus security',sec?((sec.honeypot?'<b style="color:var(--bear)">HONEYPOT</b> \u00b7 ':'')+'tax '+sec.buyTax.toFixed(0)+'/'+sec.sellTax.toFixed(0)+'% \u00b7 '+(sec.lpLocked!=null?('LP '+sec.lpLocked.toFixed(0)+'% locked'):'LP lock unknown')+' \u00b7 '+(sec.mintable?'mintable':'not mintable')+' \u00b7 '+(sec.openSource?'open-source':'closed-source')):'<span style="color:var(--gold)">unavailable ('+_memeEsc(secErr||'')+') \u2014 not filled in</span>')
    +row('Whale numbers',ws?(ws.whaleCount+' whales \u22651% holding '+ws.whalePct+'% \u00b7 top-1 '+ws.top1+'% \u00b7 top-10 '+ws.top10+'% \u00b7 '+ws.holderCount+' holders \u00b7 risk '+ws.risk):'\u2014')
    +row('Deployer',creator?('<span class="mono">'+_memeEsc(shortAddr(creator))+'</span>'+(rg?' <b style="color:var(--bear)">KNOWN RUGGER ('+(rg.tokens||[]).length+' marked)</b>':' \u2014 not in your registry')):'\u2014')
    +'</tbody></table>'
    +(v.flags.length?'<div style="margin-top:8px">'+v.flags.map(f=>'<div style="color:var(--bear);font-size:11px;padding:1px 0">\u2717 '+_memeEsc(f)+'</div>').join('')+'</div>':'')
    +(v.good.length?'<div style="margin-top:4px">'+v.good.map(f=>'<div style="color:var(--bull);font-size:11px;padding:1px 0">\u2713 '+_memeEsc(f)+'</div>').join('')+'</div>':'')
    +'<div style="font-size:10px;color:var(--muted2);margin-top:8px">Verdict is a deterministic merge of the sources above \u2014 a screen, not advice. "No red flags found" \u2260 safe: most new tokens still fail. You decide and execute.</div>';
}
