function sigMemSave(sym,tf,strat,oosStats){try{const m=JSON.parse(localStorage.getItem('mishel_sigmem')||'{}');
  m[sym+'|'+tf]={strat,avgR:oosStats&&oosStats.avgR,winPct:oosStats&&oosStats.winPct,t:Date.now()};
  STORE.set('mishel_sigmem',JSON.stringify(m))}catch(e){}}
function sigMemGet(sym,tf){try{return JSON.parse(localStorage.getItem('mishel_sigmem')||'{}')[sym+'|'+tf]||null}catch(e){return null}}
/* C7: decision journal — "I took this signal" */
function jrnLoad(){try{return JSON.parse(localStorage.getItem('mishel_journal')||'[]')}catch(e){return[]}}
function jrnSave(j){try{STORE.set('mishel_journal',JSON.stringify(j.slice(0,300)))}catch(e){}}
function jrnAdd(e){const j=jrnLoad();j.unshift(e);jrnSave(j);return j.length;}
function jrnResolve(entry,d){ /* resolve a journal entry against bar data: stop-first conservative, same as the engine */
  for(let k=0;k<d.length;k++){const b=d[k];if(b.t<=entry.barT)continue;
    const hitS=entry.dir===1?b.l<=entry.stop:b.h>=entry.stop;
    const hit2=entry.dir===1?b.h>=entry.t2:b.l<=entry.t2;
    const hit1=entry.dir===1?b.h>=entry.t1:b.l<=entry.t1;
    if(hitS)return 'stop';if(hit2)return 't2';if(hit1)return 't1';}
  return 'open';}
function sigOOSStats(d,strat){ /* #1: split 70/30 — stats reported ONLY on the last 30% the picker never saw */
  const sigs=sigScan(d,strat);const split=Math.floor(d.length*0.7);
  const ins=sigs.filter(s2=>s2.i<split),oos=sigs.filter(s2=>s2.i>=split);
  return {inStats:sigStats(ins),oosStats:sigStats(oos),split};}
function sigBestWF(d,tf){ /* AC4: rolling walk-forward \u2014 select on window n, test on n+1, aggregate TEST outcomes only */
  if(!d||d.length<240)return null;
  const style=tf?sigStyleForTF(tf):null;
  const keys=Object.keys(window.SIG_STRATS).filter(k=>k!=='ensemble');
  const pool=style?keys.filter(k=>window.SIG_STRATS[k].style===style).concat(keys):keys;
  const folds=4,fl=Math.floor(d.length/folds);
  const testSigs=[];const picks=[];
  for(let f2=1;f2<folds;f2++){
    const trainEnd=f2*fl;const train=d.slice(0,trainEnd);
    let best=null;
    for(const k of pool){try{const st2=sigStats(sigScan(train,k));
      if(st2.resolved>=5&&st2.avgR!=null&&(!best||st2.avgR>best.avgR))best={k,avgR:st2.avgR}}catch(e){}}
    if(!best)continue;picks.push(best.k);
    try{sigScan(d,best.k).forEach(sg=>{if(sg.i>=trainEnd&&sg.i<trainEnd+fl&&sg.res!=='open')testSigs.push(sg)})}catch(e){}}
  if(testSigs.length<5)return null;
  const st3=sigStats(testSigs);
  const last=picks[picks.length-1];
  return {strat:last,stats:st3,wf:true,picks,folds:folds-1};}
function sigBest(d,tf){ /* auto-pick with OOS honesty: SELECT on the first 70%, REPORT the record from the held-out 30% */
  const style=tf?sigStyleForTF(tf):null;
  const pick=keys=>{let best=null;keys.forEach(k=>{try{const o=sigOOSStats(d,k);
    if(o.inStats.resolved>=6&&(!best||o.inStats.avgR>best._sel.avgR))best={strat:k,stats:o.oosStats,_sel:o.inStats,oos:true}}catch(e){}});return best};
  const all=Object.keys(window.SIG_STRATS);
  if(style){const fit=all.filter(k=>window.SIG_STRATS[k].style===style);const b=pick(fit);if(b)return b;}
  return pick(all);}
/* ===== v33 M12: STRATEGY LAB \u2014 the whole roster measured on THIS data ===== */
window.openLab=function(){try{
  if(typeof DATA==='undefined'||DATA.length<80){toast('need \u226580 bars loaded','var(--muted)');return}
  var m=document.getElementById('labModal');
  if(!m){m=document.createElement('div');m.id='labModal';
    m.style.cssText='position:fixed;inset:0;z-index:720;background:rgba(4,6,10,.6);display:flex;align-items:flex-start;justify-content:center;padding:5vh 16px;backdrop-filter:blur(3px)';
    m.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;max-width:820px;width:100%;max-height:85vh;overflow:auto;padding:16px 18px" id="labBody"></div>';
    m.onclick=function(e){if(e.target===m)m.style.display='none'};document.body.appendChild(m);}
  m.style.display='flex';var b=document.getElementById('labBody');
  b.innerHTML='<div style="font-size:11px;color:var(--muted2)">measuring 12 strategies on '+CURSYM.sym+' '+TF+'\u2026</div>';
  setTimeout(function(){
    var rows=Object.keys(window.SIG_STRATS).map(function(k){/* v34: full roster */
      var meta=window.SIG_STRATS[k];var st2=null,oos=null,sess=null,eq=[];
      try{var sg=sigScan(DATA,k);st2=sigStats(sg);oos=sigOOSStats(DATA,k);
        var ss2=sigSessStats(sg);var bs=null;Object.keys(ss2).forEach(function(s3){if(ss2[s3].resolved>=4&&(!bs||ss2[s3].avgR>ss2[bs].avgR))bs=s3});sess=bs;
        var cum=0;sg.filter(function(x2){return x2.res!=='open'}).forEach(function(x2){cum+=x2.res==='t2'?2:x2.res==='t1'?1:-1;eq.push(cum)});
      }catch(e){}
      return {k:k,name:meta.name,style:meta.style,st:st2,oos:oos&&oos.oos,sess:sess,eq:eq};});
    rows.sort(function(a,c){return ((c.oos&&c.oos.avgR)||(c.st&&c.st.avgR)||-9)-((a.oos&&a.oos.avgR)||(a.st&&a.st.avgR)||-9)});
    var spark=function(eq){if(eq.length<3)return '';var W2=90,H2=20;var mn=Math.min.apply(null,eq.concat([0])),mx=Math.max.apply(null,eq.concat([0]));var sp=(mx-mn)||1;
      return '<svg width="'+W2+'" height="'+H2+'"><polyline points="'+eq.map(function(v,i2){return (i2/(eq.length-1)*W2).toFixed(1)+','+((1-(v-mn)/sp)*H2).toFixed(1)}).join(' ')+'" fill="none" stroke="'+(eq[eq.length-1]>=0?'var(--bull)':'var(--bear)')+'" stroke-width="1.2"/></svg>'};
    b.innerHTML='<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><b style="font-size:14px">Strategy Lab</b><span class="mono" style="font-size:10.5px;color:var(--muted2)">'+CURSYM.sym+' '+TF+' \u00b7 '+DATA.length+' bars \u00b7 sorted by OOS avgR</span><button class="tbtn" style="margin-left:auto" onclick="document.getElementById(\'labModal\').style.display=\'none\'">\u2715</button></div>'
      +'<table class="log" style="width:100%"><thead><tr><th>strategy</th><th>style</th><th>habitat</th><th>win% (CI)</th><th>netR</th><th>PF</th><th>res</th><th>OOS avgR</th><th>best sess</th><th>equity (R)</th><th></th></tr></thead><tbody>'
      +rows.map(function(r){var st2=r.st||{};var oo=r.oos;
        return '<tr><td style="font-size:10.5px">'+r.name+'</td><td><span class="pill" style="font-size:8.5px">'+r.style+'</span></td>'
        +'<td style="font-size:8.5px;color:var(--muted2)">'+((window.SIG_STRATS[r.k]||{}).habitat||'any')+'</td>'
        +'<td class="mono">'+(st2.winPct!=null?(st2.winPct*100).toFixed(0)+'%'+(st2.ciLo!=null?'<span style="color:var(--muted2);font-size:8px"> '+(st2.ciLo*100).toFixed(0)+'\u2013'+(st2.ciHi*100).toFixed(0)+'</span>':''):'\u2014')+'</td>'
        +'<td class="mono" style="color:'+(((st2.netAvgR!=null?st2.netAvgR:st2.avgR)||0)>=0?'var(--bull)':'var(--bear)')+'">'+(st2.netAvgR!=null?(st2.netAvgR>=0?'+':'')+st2.netAvgR.toFixed(2):st2.avgR!=null?(st2.avgR>=0?'+':'')+st2.avgR.toFixed(2):'\u2014')+'</td>'
        +'<td class="mono">'+(st2.pf!=null?(st2.pf===Infinity?'\u221e':st2.pf):'\u2014')+'</td><td class="mono">'+(st2.resolved||0)+'</td>'
        +'<td class="mono" style="color:'+((oo&&oo.avgR||0)>=0?'var(--bull)':'var(--bear)')+'">'+(oo&&oo.avgR!=null?(oo.avgR>=0?'+':'')+oo.avgR.toFixed(2):'\u2014')+'</td>'
        +'<td style="font-size:9px">'+(r.sess||'\u2014')+'</td><td>'+spark(r.eq)+'</td>'
        +'<td><button class="tbtn labuse" data-k="'+r.k+'" style="padding:1px 8px;font-size:9px">use \u25b7</button></td></tr>'}).join('')
      +'</tbody></table><div style="font-size:9px;color:var(--muted2);margin-top:8px">measured on THIS loaded history \u00b7 OOS = record on the last 30% only (selection-proof) \u00b7 not a promise</div>';
    b.querySelectorAll('.labuse').forEach(function(bt){bt.onclick=function(){var SS=window._sigState;SS.on=true;SS.strat=bt.dataset.k;SS.lastLiveI=null;window.sigRefresh();m.style.display='none';toast('SIG \u2192 '+window.SIG_STRATS[bt.dataset.k].name,'var(--accent,#5B8DEF)')}});
  },30);
}catch(e){}};
function pinState(){try{return JSON.parse(localStorage.getItem('mishel_pins')||'{}')}catch(e){return{}}}
function pinSave(o){try{STORE.set('mishel_pins',JSON.stringify(o))}catch(e){}}
function pinAdd(kind,id,snapshot){ /* F2: pin a coin/wallet with a state snapshot */
  const p=pinState();const k=kind+':'+(id||'').toLowerCase();p[k]={kind,id:(id||'').toLowerCase(),snap:snapshot||{},pinnedAt:Date.now()};pinSave(p);return true;}
function pinDiff(kind,id,now_snapshot){ /* F2: what changed since pinned? pure */
  const p=pinState();const k=kind+':'+(id||'').toLowerCase();const rec=p[k];if(!rec)return null;
  const was=rec.snap||{},is=now_snapshot||{};const changes=[];
  if(was.stance&&is.stance&&was.stance!==is.stance)changes.push('stance '+was.stance+' \u2192 '+is.stance);
  if(was.tier&&is.tier&&was.tier!==is.tier)changes.push('tier '+was.tier+' \u2192 '+is.tier);
  if(was.bias&&is.bias&&was.bias!==is.bias)changes.push('flow '+was.bias+' \u2192 '+is.bias);
  if(was.smartCount!=null&&is.smartCount!=null&&is.smartCount!==was.smartCount)changes.push('smart wallets '+was.smartCount+' \u2192 '+is.smartCount);
  return {changes,pinnedAt:rec.pinnedAt,sincePinned:Math.round((Date.now()-rec.pinnedAt)/86400000)+'d'};}
function buildOpportunities(db,tokens,ctx){ /* B1/B2: merge signals into a ranked shortlist */
  ctx=ctx||{};const now=ctx.now||Date.now();const out=[];
  try{(earlyEntryRadar(db,now)||[]).forEach(x=>out.push({kind:'convergence',token:x.token,chain:x.chain,
    conviction:Math.min(100,55+x.wallets.length*12),why:x.wallets.length+' S/A wallets hold '+shortAddrSafe(x.token),
    action:'scout',actionData:{addr:x.token,chain:x.chain}}))}catch(e){}
  (tokens||[]).forEach(t=>{try{const v=tokenVerdict(t,ctx);if(v.stance==='WATCH'&&v.conviction>=60)
    out.push({kind:'coin',token:t.addr||t.sym,chain:t.chain,conviction:v.conviction,why:v.line,
      action:'dossier',actionData:{addr:t.addr,chain:t.chain},stance:v.stance})}catch(e){}});
  return out.sort((a,b)=>b.conviction-a.conviction).slice(0,6);}
function shortAddrSafe(a){try{return shortAddr(a)}catch(e){return(a||'').slice(0,8)+'…'}}
function feedRead(e,rec,dna){ /* A3/F6: interpret a single feed transfer */
  const tier=(dna&&dna.role)||(rec&&rec.cats&&Object.keys(rec.cats)[0])||'unclassified';
  const dir=e.dir||e.direction;const unusual=(dna&&dna.style&&dna.style.style==='BOT')?'mechanical':'';
  const ctxAmt=e.usd?('$'+(+e.usd).toLocaleString()):(+e.amt||+e.amount||0).toLocaleString()+' '+(e.sym||'');
  return {tier,dir,ctxAmt,note:unusual|| (dir==='BUY'?'adding':'reducing')};}
function smartMomentum(db,now){ /* D3: are smart wallets as a group risk-on or risk-off? */
  now=now||Date.now();let acc=0,dist=0,n=0;
  Object.values(db||{}).forEach(r=>{const iv=walletIntel(r,{now});if(iv.risky||iv.score<20)return;n++;
    const e=(r.cats&&r.cats.early)||0,w=(r.cats&&r.cats.whale)||0;acc+=e*3+w;});
  /* lightweight proxy: more early+whale classifications recently = risk-on */
  const recent=Object.values(db||{}).filter(r=>(now-(r.last||0))<7*86400000).length;
  const score=n?Math.min(100,Math.round((acc/n)*12+recent*2)):0;
  return {score,n,band:score>=60?'RISK-ON':score>=35?'NEUTRAL':'RISK-OFF',recent};}
function earlyEntryRadar(db,now){ /* D4: tokens where >=2 high-tier wallets are recorded, freshest first */
  now=now||Date.now();const byTok={};
  Object.values(db||{}).forEach(r=>{const iv=walletIntel(r,{now});if(iv.tier!=='S'&&iv.tier!=='A')return;
    (r.tokens||[]).forEach(t=>{(byTok[t.t]=byTok[t.t]||{token:t.t,chain:t.chain,wallets:[],tiers:[]});byTok[t.t].wallets.push(r.addr);byTok[t.t].tiers.push(iv.tier)})});
  return Object.values(byTok).filter(x=>x.wallets.length>=2).sort((a,b)=>b.wallets.length-a.wallets.length).slice(0,8);}
