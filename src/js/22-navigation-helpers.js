(function(){var ck=document.getElementById('tabCmdK');if(ck)ck.onclick=function(){try{document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}));var cp=document.getElementById('cmdk')||document.getElementById('palette');if(cp)cp.style.display='flex';}catch(e){}};})();
document.querySelectorAll('.nav').forEach(n=>n.onclick=()=>{
  document.querySelectorAll('.nav').forEach(x=>x.classList.remove('on'));n.classList.add('on');
  const v=n.dataset.view;document.querySelectorAll('.view').forEach(x=>x.classList.remove('on'));
  multiStopAll();
  document.getElementById('v-'+v).classList.add('on');
  try{syncTabBar(v)}catch(e){}
  document.getElementById('side').style.display=(v==='chart')?'flex':'none';
  document.getElementById('main').style.gridColumn=(v==='chart')?'':'';
  if(v==='backtest'&&!window._ranBt){window._ranBt=1;runBacktest()}
  if(v==='intel'){renderIntel();try{if(window.renderSigLedger)renderSigLedger()}catch(e){}}
  if(v==='heatmap')renderHeatmap();
  if(v==='multi')renderMulti();
  if(v==='ai')renderAiChat();
  if(v==='watchlist')renderWatchlist();
  if(v==='news')renderNews();
  if(v==='screener'){if(typeof MODE!=='undefined'&&MODE==='online'){screenLive()}else{fillScreener();try{document.getElementById('scanInfo').textContent='Synthetic preview (offline).'}catch(e){}}try{if(window.ensureCoinScan)ensureCoinScan()}catch(e){}}
  if(v==='alerts')renderAlerts();
  if(v==='mtf'){renderMTFDash();try{renderMTFAuto()}catch(e){}}
  if(v==='news')try{renderNews();renderUpcoming()}catch(e){}
  if(v==='insights')try{renderInsights()}catch(e){}
  if(v==='orderflow'){renderOrderFlow();try{if(window.startDepthLadder)startDepthLadder()}catch(e){}}
  if(v==='risk')renderRisk();
  if(v==='calc')calcCompute();
  if(v==='sessions')renderSessions();
  if(v==='paper')renderPaper();
  if(v==='hedge')renderHedge();
  if(v==='chart')setTimeout(draw,20);
});

/* ========================= navigation helpers ========================= */
function goView(v){const n=document.querySelector('.nav[data-view="'+v+'"]');if(n)n.click()}

/* ================= v14.3 MEME RADAR — real DexScreener discovery + transparent rug-pull risk =================
   Honesty: this is a RISK SCREEN and a data view, never a price prediction. It shows actually-trending DEX
   tokens with a rug-risk score computed from real on-chain fields (+ optional GoPlus security). No token is
   ever fabricated; if a feed doesn't respond, the panel says so and shows nothing. Extreme-risk asset class. */
let MEME_CHAIN='all';
const GP_CHAIN={ethereum:'1',bsc:'56',base:'8453',polygon:'137',arbitrum:'42161',avalanche:'43114',optimism:'10',blast:'81457',linea:'59144',scroll:'534352',zksync:'324',fantom:'250',cronos:'25'};
function _memeEsc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function fmtUsd(n){if(n==null||!isFinite(n))return '\u2014';const a=Math.abs(n);if(a>=1e9)return '$'+(n/1e9).toFixed(1)+'B';if(a>=1e6)return '$'+(n/1e6).toFixed(1)+'M';if(a>=1e3)return '$'+(n/1e3).toFixed(1)+'k';return '$'+n.toFixed(0)}
function fmtAge(h){if(h==null)return '\u2014';if(h<24)return h.toFixed(0)+'h';const d=h/24;return d<30?d.toFixed(0)+'d':(d/30).toFixed(0)+'mo'}

/* momentum: DESCRIPTIVE recent-activity score 0-100 (turnover + positive move + buy pressure + depth). NOT a forecast. */
function memeMomentum(p){
  const liq=+p.liq||0, vol=+p.vol24||0, chg=+p.chg24||0, buys=+p.buys||0, sells=+p.sells||0;
  const churn=liq>0?Math.min(3,vol/liq):0;
  const churnS=churn/3*35;
  const chgS=Math.max(0,Math.min(30,(chg/50)*30));
  const flow=(buys+sells)>0?buys/(buys+sells):0.5;
  const flowS=Math.max(0,Math.min(20,(flow-0.5)/0.5*20));
  const liqS=Math.min(15,Math.log10(Math.max(1,liq))/6*15);
  return Math.round(Math.max(0,Math.min(100,churnS+chgS+flowS+liqS)));
}
/* rug risk: DANGER score 0-100 (higher = worse). DexScreener fields always; GoPlus security merged when available. */
function memeRug(p,sec){
  let r=0;const notes=[];
  const liq=+p.liq||0, fdv=+p.fdv||0, vol=+p.vol24||0, ageH=p.ageH!=null?+p.ageH:999;
  if(liq<5000){r+=25;notes.push('very low liquidity (<$5k)')}
  else if(liq<25000){r+=12;notes.push('thin liquidity (<$25k)')}
  if(fdv>0&&liq>0){const flt=liq/fdv;if(flt<0.02){r+=15;notes.push('liquidity a tiny fraction of FDV')}else if(flt<0.05){r+=8;notes.push('low liquidity vs FDV')}}
  if(ageH<6){r+=15;notes.push('extremely new (<6h)')}else if(ageH<24){r+=8;notes.push('very new (<24h)')}
  if(liq>0&&vol/liq>10){r+=12;notes.push('churning >10\u00d7 liquidity in 24h')}
  if(!p.hasSocials){r+=6;notes.push('no listed socials/website')}
  if(sec){
    if(sec.honeypot){r+=45;notes.push('flagged HONEYPOT \u2014 sells may be blocked')}
    const bt=+sec.buyTax||0,st=+sec.sellTax||0;
    if(st>30||bt>30){r+=25;notes.push('extreme tax >30%')}else if(st>10||bt>10){r+=12;notes.push('high tax >10%')}
    if(sec.lpLocked!=null&&sec.lpLocked<50){r+=15;notes.push('LP not majority-locked ('+sec.lpLocked.toFixed(0)+'%)')}
    if(sec.top10!=null&&sec.top10>50){r+=15;notes.push('top-10 holders own >50%')}
    if(sec.mintable){r+=12;notes.push('supply is mintable')}
    if(sec.openSource===false){r+=8;notes.push('contract not verified')}
    if(sec.canTakeBackOwnership||sec.hiddenOwner){r+=10;notes.push('owner can reclaim control')}
  }
  if(sec&&sec.honeypot)r=Math.max(r,90); // a honeypot = cannot sell = guaranteed loss; always EXTREME
  return {score:Math.max(0,Math.min(100,Math.round(r))),notes,hasSec:!!sec};
}
function rugBand(s){return s>=75?['EXTREME','memehi']:s>=50?['High','memehi']:s>=25?['Elevated','mememid']:['Lower','memelo']}

function normalizePair(p){
  if(!p||!p.baseToken)return null;
  const created=p.pairCreatedAt||0;const ageH=created?(Date.now()-created)/3.6e6:null;
  const info=p.info||{};
  const socials=!!((info.socials&&info.socials.length)||(info.websites&&info.websites.length));
  return {addr:(p.baseToken.address||''),sym:p.baseToken.symbol||'?',name:p.baseToken.name||'',chain:p.chainId||'',
    liq:(p.liquidity&&p.liquidity.usd)||0,vol24:(p.volume&&p.volume.h24)||0,chg24:(p.priceChange&&p.priceChange.h24)||0,
    buys:(p.txns&&p.txns.h24&&p.txns.h24.buys)||0,sells:(p.txns&&p.txns.h24&&p.txns.h24.sells)||0,
    fdv:p.fdv||0,ageH,hasSocials:socials,url:p.url||'',priceUsd:+p.priceUsd||0,sec:null};
}

function memeMsg(html,tone){const b=document.getElementById('memeInfo');if(b)b.innerHTML='<span style="color:var(--'+(tone||'muted')+')">'+html+'</span>'}

async function scanMeme(){
  const body=document.getElementById('memeBody');if(!body)return;
  memeMsg('scanning DexScreener\u2026');body.innerHTML='<tr><td colspan="9" style="padding:14px;color:var(--muted)">Fetching trending DEX tokens\u2026</td></tr>';
  try{
    const boostR=await fetch('https://api.dexscreener.com/token-boosts/latest/v1',{signal:AbortSignal.timeout(10000)});
    if(!boostR.ok)throw new Error('DexScreener boosts HTTP '+boostR.status);
    let boosts=await boostR.json();if(!Array.isArray(boosts))boosts=[];
    try{const profR=await fetch('https://api.dexscreener.com/token-profiles/latest/v1',{signal:AbortSignal.timeout(10000)});
      if(profR.ok){const profs=await profR.json();if(Array.isArray(profs))boosts=boosts.concat(profs)}}catch(e){}
    if(MEME_CHAIN!=='all')boosts=boosts.filter(b=>b.chainId===MEME_CHAIN);
    const _seen={};boosts=boosts.filter(b=>{const k=(b.chainId||'')+':'+(b.tokenAddress||'').toLowerCase();if(!b.tokenAddress||_seen[k])return false;_seen[k]=1;return true});
    boosts=boosts.slice(0,60);
    if(!boosts.length){memeMsg('No trending tokens returned for this chain right now. Try All chains, or scan again shortly.','gold');body.innerHTML='<tr><td colspan="9" style="padding:14px;color:var(--muted)">Nothing to show \u2014 no fabricated tokens.</td></tr>';return}
    const byChain={};boosts.forEach(b=>{if(b.tokenAddress&&b.chainId){(byChain[b.chainId]=byChain[b.chainId]||[]).push(b.tokenAddress)}});
    let pairs=[];
    for(const ch in byChain){
      const addrs=byChain[ch].slice(0,30).join(',');
      try{const pr=await fetch('https://api.dexscreener.com/latest/dex/tokens/'+addrs,{signal:AbortSignal.timeout(10000)});
        if(pr.ok){const pj=await pr.json();if(pj&&Array.isArray(pj.pairs))pairs=pairs.concat(pj.pairs)}}catch(e){}
    }
    if(!pairs.length)throw new Error('no pair data returned');
    const best={};pairs.forEach(p=>{const k=(p.baseToken&&p.baseToken.address)||p.pairAddress;const L=(p.liquidity&&p.liquidity.usd)||0;if(!best[k]||L>((best[k].liquidity&&best[k].liquidity.usd)||0))best[k]=p});
    const minLiq=+((document.getElementById('memeMinLiq')||{}).value)||0;
    let rows=Object.values(best).map(normalizePair).filter(r=>r&&r.liq>=minLiq);
    rows.forEach(r=>{r._rug=memeRug(r);r._mom=memeMomentum(r)});
    rows.sort((a,b)=>a._rug.score-b._rug.score||b._mom-a._mom);
    if(!rows.length){memeMsg('All results were below your min-liquidity filter.','gold');body.innerHTML='<tr><td colspan="9" style="padding:14px;color:var(--muted)">Nothing above the liquidity floor.</td></tr>';return}
    window._memeRows=rows;renderMemeRows(rows);
    memeMsg('\u2713 '+rows.length+' trending tokens (boosts + profiles feeds merged) \u00b7 sorted safest-first \u00b7 real DexScreener data \u00b7 rug-risk is a screen, not a guarantee','bull');
  }catch(e){
    const msg=(e&&e.message)||String(e);
    memeMsg('\u2717 Couldn\'t reach DexScreener ('+_memeEsc(msg)+'). No connection or rate-limited \u2014 nothing is shown rather than faking it. Retry shortly.','bear');
    body.innerHTML='<tr><td colspan="9" style="padding:14px;color:var(--muted)">No live data \u2014 no synthetic tokens shown.</td></tr>';
  }
}

/* v16.2 MEME PRO — pure helpers (unit-tested) */
