/* ================= v21.0 SMART MONEY ENGINE — pure ML (unit-tested) ================= */
function walletIntel(rec,ctx){ /* P1+P12: composite 0-100 intelligence score with confidence, tiered, glass box */
  ctx=ctx||{};const now=ctx.now||Date.now();const parts=[];let sc=0;
  const early=(rec.cats&&rec.cats.early)||0,whale=(rec.cats&&rec.cats.whale)||0,maker=(rec.cats&&rec.cats.maker)||0,risky=(rec.cats&&rec.cats.risky)||0;
  const tok=(rec.tokens||[]).length;
  const eComp=Math.min(42,early*14);if(eComp){sc+=eComp;parts.push('early-accumulator \u00d7'+early+' (+'+eComp.toFixed(0)+')')}
  const wComp=Math.min(20,whale*7);if(wComp){sc+=wComp;parts.push('whale \u00d7'+whale+' (+'+wComp.toFixed(0)+')')}
  const mComp=Math.min(12,maker*5);if(mComp){sc+=mComp;parts.push('churner \u00d7'+maker+' (+'+mComp.toFixed(0)+')')}
  const xComp=tok>1?Math.min(20,(tok-1)*7):0;if(xComp){sc+=xComp;parts.push(tok+' distinct tokens (+'+xComp.toFixed(0)+')')}
  const co=(ctx.coHoldCount||0);const cComp=Math.min(14,co*7);if(cComp){sc+=cComp;parts.push('in '+co+' co-holding cluster(s) (+'+cComp.toFixed(0)+')')}
  if(risky){sc-=Math.min(60,risky*25);parts.push('risk-classified \u00d7'+risky+' (\u2212'+Math.min(60,risky*25)+')')}
  if(rec.flags&&rec.flags.length){sc-=Math.min(25,rec.flags.length*10);parts.push(rec.flags.length+' manipulation flag(s) (\u2212'+Math.min(25,rec.flags.length*10)+')')}
  if(rec.fresh){sc-=8;parts.push('fresh wallet (\u22128 caution)')}
  const ageD=(now-(rec.last||now))/86400000;const decay=Math.pow(0.5,ageD/14);
  if(ageD>1){parts.push(ageD.toFixed(0)+'d inactive (\u00d7'+decay.toFixed(2)+')')}
  /* P12 confidence: more independent tokens = more trustworthy signal */
  const conf=Math.min(1,tok/4);const confPct=Math.round(conf*100);
  let score=Math.max(0,Math.min(100,Math.round(sc*decay*(0.72+0.28*conf))));
  if(risky||(rec.flags&&rec.flags.length))score=Math.max(0,Math.min(score,25));
  const tier=risky?'D':(score>=75?'S':score>=60?'A':score>=40?'B':score>=20?'C':'D');
  return {score,tier,conf:confPct,parts,risky:risky>0};}
function clusterDetect(db){ /* P6: group wallets by shared manipulation-partner (circular) into entities */
  const adj={};Object.values(db||{}).forEach(r=>{(r.flags||[]).forEach(f=>{const m=/circular \u2194 ([0-9a-zA-Z]+)/.exec(f);
    if(m){const other=m[1].toLowerCase().replace(/\u2026.*/,'');(adj[r.addr]=adj[r.addr]||new Set()).add(other);(adj[other]=adj[other]||new Set()).add(r.addr)}})});
  const seen={},clusters=[];Object.keys(adj).forEach(a=>{if(seen[a])return;const stack=[a],grp=[];
    while(stack.length){const x=stack.pop();if(seen[x])continue;seen[x]=1;grp.push(x);(adj[x]||new Set()).forEach(y=>{if(!seen[y])stack.push(y)})}
    if(grp.length>=2)clusters.push({wallets:grp,n:grp.length})});
  return clusters.sort((a,b)=>b.n-a.n).slice(0,8);}
/* ================= v23.0 WALLET DNA ENGINE — pure ML behavioral fingerprint (unit-tested) ================= */
function _hoursBetween(a,b){return Math.abs(a-b)/3600000}
function dnaHoldTime(events){ /* A1: median hold time from matched buy→sell pairs per token */
  const byTok={};(events||[]).forEach(e=>{const t=(e.token||e.sym||'').toLowerCase();if(!t)return;(byTok[t]=byTok[t]||[]).push(e)});
  const holds=[];Object.values(byTok).forEach(evs=>{evs.sort((a,b)=>a.t-b.t);let openT=null;
    evs.forEach(e=>{const buy=(e.dir==='in'||e.direction==='BUY');if(buy&&openT==null)openT=e.t;
      else if(!buy&&openT!=null){holds.push(_hoursBetween(e.t,openT));openT=null}})});
  if(!holds.length)return null;holds.sort((a,b)=>a-b);const med=holds[holds.length>>1];
  return {medianHours:+med.toFixed(1),n:holds.length,band:med<1?'scalper (<1h)':med<24?'intraday':med<24*7?'swing':'position (>1w)'};}
function dnaStyle(events,now){ /* A2: style classifier from timing + direction patterns */
  now=now||Date.now();const evs=(events||[]).slice().sort((a,b)=>a.t-b.t);
  if(evs.length<3)return {style:'UNKNOWN',why:'too few transfers to classify ('+evs.length+')',conf:0};
  let buys=0,sells=0;evs.forEach(e=>{(e.dir==='in'||e.direction==='BUY')?buys++:sells++});
  const gaps=[];for(let i=1;i<evs.length;i++)gaps.push(evs[i].t-evs[i-1].t);
  const mean=gaps.reduce((a,b)=>a+b,0)/gaps.length;const varc=gaps.reduce((a,b)=>a+(b-mean)*(b-mean),0)/gaps.length;
  const cv=mean>0?Math.sqrt(varc)/mean:99;                       // low CV = mechanical = bot
  const ht=dnaHoldTime(evs);
  const buyPct=buys/(buys+sells);
  if(cv<0.35&&evs.length>=6)return {style:'BOT',why:'near-uniform transfer intervals (CV '+cv.toFixed(2)+') — mechanical timing',conf:Math.min(95,60+evs.length*2)};
  if(ht&&ht.medianHours<1)return {style:'SNIPER',why:'median hold '+ht.medianHours+'h — flips fast, hunts launches',conf:70};
  if(buyPct>=0.75)return {style:'ACCUMULATOR',why:Math.round(buyPct*100)+'% of actions are buys — building positions',conf:70};
  if(buyPct<=0.25)return {style:'DUMPER',why:Math.round((1-buyPct)*100)+'% of actions are sells — distributing',conf:70};
  if(ht&&ht.medianHours>=24*3)return {style:'SWING HOLDER',why:'median hold '+(ht.medianHours/24).toFixed(1)+'d — patient positions',conf:65};
  if(ht&&ht.medianHours<24)return {style:'SCALPER',why:'median hold '+ht.medianHours+'h — quick in/out',conf:60};
  return {style:'MIXED',why:'no dominant pattern',conf:40};}
function dnaConsistency(events){ /* A3: does the wallet repeat a pattern? entropy of hold-time bands */
  const ht=[];const byTok={};(events||[]).forEach(e=>{const t=(e.token||e.sym||'').toLowerCase();if(t)(byTok[t]=byTok[t]||[]).push(e)});
  Object.values(byTok).forEach(evs=>{evs.sort((a,b)=>a.t-b.t);let o=null;evs.forEach(e=>{const buy=(e.dir==='in'||e.direction==='BUY');
    if(buy&&o==null)o=e.t;else if(!buy&&o!=null){ht.push(_hoursBetween(e.t,o));o=null}})});
  if(ht.length<3)return {score:null,txt:'not enough round-trips to judge consistency'};
  const band=h=>h<1?0:h<24?1:h<168?2:3;const cnt=[0,0,0,0];ht.forEach(h=>cnt[band(h)]++);
  const tot=ht.length;let H=0;cnt.forEach(c=>{if(c){const pi=c/tot;H-=pi*Math.log2(pi)}});
  const maxH=2;const score=Math.round((1-H/maxH)*100);
  return {score,txt:score>=70?'highly consistent — repeats a pattern (copyable)':score>=40?'moderately consistent':'erratic — hard to copy',n:ht.length};}
function dnaAffinity(holdings,rec){ /* A4: what token-type the wallet gravitates to */
  const tags={meme:0,defi:0,stable:0,other:0};const MEME=/pepe|doge|shib|wif|bonk|floki|meme|inu|cat|elon|trump|pump/i;
  const DEFI=/uni|aave|comp|sushi|curve|link|crv|ldo|gmx|dydx|snx/i;const STABLE=/usdc|usdt|dai|frax|busd/i;
  (holdings||[]).forEach(h=>{const s=(h.sym||'')+' '+(h.name||'');if(STABLE.test(s))tags.stable++;else if(MEME.test(s))tags.meme++;else if(DEFI.test(s))tags.defi++;else tags.other++});
  const tot=Object.values(tags).reduce((a,b)=>a+b,0);if(!tot)return null;
  const top=Object.entries(tags).sort((a,b)=>b[1]-a[1])[0];
  return {profile:top[0],pct:Math.round(top[1]/tot*100),breakdown:tags};}
function dnaTiming(events){ /* A6: which UTC hours the wallet is active */
  const hrs=new Array(24).fill(0);(events||[]).forEach(e=>{const d=new Date(e.t);if(!isNaN(d))hrs[d.getUTCHours()]++});
  const tot=hrs.reduce((a,b)=>a+b,0);if(!tot)return null;
  const peak=hrs.indexOf(Math.max(...hrs));
  const sess=peak>=0&&peak<8?'Asia':peak<13?'London':peak<21?'New York':'Asia';
  return {peakHourUTC:peak,session:sess,hist:hrs,n:tot};}
function dnaRisk(rec){ /* A5: how much exposure to flagged/risky classifications */
  const risky=(rec&&rec.cats&&rec.cats.risky)||0;const flags=(rec&&rec.flags||[]).length;
  const score=Math.min(100,risky*30+flags*20);
  return {score,band:score>=60?'RECKLESS':score>=30?'ELEVATED':'DISCIPLINED',risky,flags};}
function walletDNA(ctx){ /* A1 master: assemble the full fingerprint */
  ctx=ctx||{};const ev=ctx.events||[],hold=ctx.holdings||[],rec=ctx.rec||{};
  const style=dnaStyle(ev,ctx.now),hold_t=dnaHoldTime(ev),cons=dnaConsistency(ev),aff=dnaAffinity(hold,rec),tim=dnaTiming(ev),risk=dnaRisk(rec);
  /* precise role label */
  let role='WALLET',roleWhy='';
  const whale=(rec.cats&&rec.cats.whale)||0,maker=(rec.cats&&rec.cats.maker)||0,early=(rec.cats&&rec.cats.early)||0;
  if(risk.band==='RECKLESS'||(rec.cats&&rec.cats.risky)){role='RUGGER / INSIDER';roleWhy='risk-flagged — avoid copying'}
  else if(style.style==='BOT'){role='BOT / MM';roleWhy=style.why}
  else if(maker>=1&&Math.abs((hold_t&&hold_t.n)||0)){role='MARKET MAKER';roleWhy='two-way liquidity provision'}
  else if(ctx.roundtrips>=2){role='WINNER (proxy)';roleWhy=ctx.roundtrips+' completed round-trips — activity/skill proxy, not verified profit'}
  else if(early>=1||style.style==='SNIPER'){role='SNIPER / EARLY';roleWhy='enters early on launches'}
  else if(whale>=1){role='WHALE';roleWhy='large holder'}
  else if(style.style==='ACCUMULATOR'){role='ACCUMULATOR';roleWhy=style.why}
  else if(style.style==='DUMPER'){role='DUMPER';roleWhy=style.why}
  return {role,roleWhy,style,holdTime:hold_t,consistency:cons,affinity:aff,timing:tim,risk};}
function profitProxy(events){ /* P7: on-chain round-trips — bought then later sold SAME token. Honest proxy, not PnL. */
  const byTok={};(events||[]).forEach(e=>{const t=(e.token||'').toLowerCase();if(!t)return;(byTok[t]=byTok[t]||[]).push(e)});
  let roundtrips=0,tokens=0;const detail=[];
  Object.entries(byTok).forEach(([t,evs])=>{evs.sort((a,b)=>a.t-b.t);let bought=false,rt=0;
    evs.forEach(e=>{if(e.direction==='BUY')bought=true;else if(e.direction==='SELL'&&bought){rt++;bought=false}});
    if(rt>0){roundtrips+=rt;tokens++;detail.push({token:t,sym:evs[0].sym||'?',rt})}});
  return {roundtrips,tokens,detail:detail.sort((a,b)=>b.rt-a.rt).slice(0,6)};}
function walletNick(addr){try{const m=JSON.parse(localStorage.getItem('mishel_wnick')||'{}');return m[(addr||'').toLowerCase()]||null}catch(e){return null}}
function setWalletNick(addr,nick,note){try{const m=JSON.parse(localStorage.getItem('mishel_wnick')||'{}');const a=(addr||'').toLowerCase();
  if(nick||note)m[a]={nick:nick||((m[a]||{}).nick||''),note:note!=null?note:((m[a]||{}).note||'')};else delete m[a];
  STORE.set('mishel_wnick',JSON.stringify(m));return true}catch(e){return false}}
function tokenSmartMoney(db,tokenAddr){ /* P5: which DB wallets touch a given token, ranked */
  const t=(tokenAddr||'').toLowerCase();if(!t)return[];
  return Object.values(db||{}).filter(r=>(r.tokens||[]).some(x=>x.t===t))
    .map(r=>({addr:r.addr,intel:walletIntel(r,{}),cats:r.cats})).sort((a,b)=>b.intel.score-a.intel.score).slice(0,20);}
function wdbExportCSV(db){ /* P8 */
  const rows=[['wallet','tier','score','confidence','tokens','cats','flags','nickname']];
  Object.values(db||{}).forEach(r=>{const iv=walletIntel(r,{});rows.push([r.addr,iv.tier,iv.score,iv.conf,(r.tokens||[]).length,
    Object.entries(r.cats||{}).map(([k,v])=>k+':'+v).join('|'),(r.flags||[]).length,(walletNick(r.addr)||{}).nick||'']);});
  return rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');}
function wdbImportCSV(text){ /* P8: seed DB from address list or CSV first column */
  let db=wdbLoad(),added=0;(text||'').split(/[\r\n]+/).forEach(line=>{const a=(line.split(',')[0]||'').replace(/"/g,'').trim();
    if(/^0x[0-9a-fA-F]{40}$/.test(a)||/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)){const al=a.toLowerCase();
      if(!db[al]){db[al]={addr:al,chains:[/^0x/.test(a)?'ethereum':'solana'],cats:{},tokens:[],flags:[],first:Date.now(),last:Date.now(),imported:true};added++}}});
  wdbSave(db);return added;}
/* ================= v24.0 VERDICT ENGINE — pure decision logic (unit-tested) ================= */
