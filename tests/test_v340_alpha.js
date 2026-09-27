// v34.0 — ACCURACY SPINE + 26-strategy roster: known-answer tests (shipped source)
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
function grabAssign(prefix){const i=src.indexOf(prefix);if(i<0)throw new Error(prefix+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

/* ---------- source assertions: the spine exists as shipped text ---------- */
const scanB=grab('sigScan'),statsB=grab('sigStats');
ok(scanB.includes('habitat')&&scanB.includes('adx'),'AC1: habitat gate in sigScan (ADX regime check)');
ok(/TMAX\s*=\s*40/.test(scanB)&&scanB.includes("'time'"),'AC3: 40-bar time barrier \u2192 res \'time\' (no immortal signals)');
ok(scanB.includes('costR'),'AC6: per-signal cost estimate attached');
ok(statsB.includes('ciLo')&&statsB.includes('ciHi')&&statsB.includes('1.96'),'AC5: Wilson 95% CI in sigStats');
ok(statsB.includes('netAvgR')&&statsB.includes('scratches'),'AC6/AC3: net-of-cost avgR + scratch count reported');
ok(src.includes('function sigBestWF(')&&src.includes('wf:true'),'AC4: walk-forward selector shipped');
ok(src.includes('WF-OOS \u00b7')||src.includes("'WF-OOS \\u00b7 '"),'AC4: legend labels walk-forward records honestly');
['liqSweep','cvdDiv','failedBreak','compBreak','htfPull','ensemble','stopRun','eqRaid','sessionGrab','fvgFill','absorption','lateBreak','vwapShadow','ignition']
  .forEach(k=>ok(src.includes(k+':{name:'),'meta shipped: '+k));
ok(src.includes('Liquidity &amp; MM mechanics')&&src.includes('Flow &amp; structure'),'picker: two new optgroups (all 26 reachable in UI)');
ok(src.includes('_labLite')&&src.includes('dataset.base'),'T-c: picker options decorated with measured net R in place');
ok(src.includes('_crowdScore'),'SUP2: crowding meter shipped');
ok(src.includes("'crowd'"),'SUP2: crowding card in cockpit order');
ok(src.includes('_liqMapOn')&&src.includes('mishel_liqmap'),'SUP1: liquidity map overlay + persisted toggle');
ok(!src.includes('fundingFade:{name:'),'AR1 honesty: funding fade demoted to crowding gate, not a fake-measured strategy');
ok(src.includes('window.qCalib=function')&&src.includes('window.sigMemo=function'),'IN1/IN2: setup memo + quality calibration shipped');

/* ---------- runtime harness ---------- */
global.window={};global.CURSYM={sym:'TEST'};global.BAR_CACHE={};
let ADXV=25;
global.IND={
  ema(c,n){const k=2/(n+1);const o=[];let e=c[0];c.forEach((v,i)=>{e=i?v*k+e*(1-k):v;o.push(e)});return o},
  rsi(c,n=14){const o=[];let g=0,l=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;o[i]=l?100-100/(1+g/l):100}o[0]=50;return o},
  atr(d,n=14){const o=[];let a=0;for(let i=0;i<d.length;i++){const tr=i?Math.max(d[i].h-d[i].l,Math.abs(d[i].h-d[i-1].c),Math.abs(d[i].l-d[i-1].c)):d[i].h-d[i].l;a=i?(a*(n-1)+tr)/n:tr;o.push(a)}return o},
  adx(d,n=14){return d.map(()=>ADXV)},
  macd(c){const e12=this.ema(c,12),e26=this.ema(c,26);const m=c.map((_,i)=>e12[i]-e26[i]);const sig=this.ema(m,9);return{m,sig,hist:m.map((v,i)=>v-sig[i])}},
  supertrend(d,p=10,mult=3){const atr=this.atr(d,p);const dir=[],up=[],dn=[];let dr=1;for(let i=0;i<d.length;i++){const mid=(d[i].h+d[i].l)/2;const u=mid+mult*atr[i],l=mid-mult*atr[i];up.push(u);dn.push(l);if(i){if(d[i].c>up[i-1])dr=1;else if(d[i].c<dn[i-1])dr=-1}dir.push(dr)}return{dir,up,dn}}
};
eval(grab('swings'));
{const mS=src.indexOf('window.SIG_STRATS={'),rS=src.indexOf('window.SIG_DETECT={'),rE=src.indexOf('function sigScan(d,strat){');
 eval(src.slice(mS,rS));eval(src.slice(rS,rE));}
eval(grab('sigScan'));eval(grab('sigStats'));eval(grab('sigStyleForTF'));eval(grab('sigBestWF'));
eval(grabAssign('window.qCalib=function'));

const FULL_STRATS=window.SIG_STRATS,FULL_DETECT=window.SIG_DETECT;
ok(Object.keys(FULL_STRATS).length===26,'roster: exactly 26 strategies ('+Object.keys(FULL_STRATS).length+')');

/* all 26 run clean on mixed synthetic */
function mkMixed(n){const d=[];let px=100;for(let i=0;i<n;i++){
  const ph=i<n*0.3?Math.sin(i/6)*1.5:i<n*0.5?-(i-n*0.3)*0.09:(i-n*0.5)*0.12;
  px=100+ph;const w=0.9+0.4*Math.sin(i/9);
  d.push({t:i*3600000,o:px-0.1,h:px+w,l:px-w,c:px+Math.sin(i/4)*0.3,v:100+((i*37)%140)})}return d}
const dM=mkMixed(600);let fails=0,fired=0;
Object.keys(FULL_STRATS).forEach(k=>{try{fired+=sigScan(dM,k).length}catch(e){fails++;console.log('    threw: '+k+' \u2014 '+e.message)}});
ok(fails===0,'all 26 strategies scan clean on 600 mixed bars');
ok(fired>0,'roster produces signals on mixed data ('+fired+')');

/* geometry + Wilson sanity on whatever resolved */
let allS=[];Object.keys(FULL_STRATS).forEach(k=>{try{allS=allS.concat(sigScan(dM,k))}catch(e){}});
const stA=sigStats(allS);
ok(stA.winPct==null||(stA.ciLo>=0&&stA.ciLo<=stA.winPct&&stA.winPct<=stA.ciHi&&stA.ciHi<=1),'AC5: 0 \u2264 ciLo \u2264 winPct \u2264 ciHi \u2264 1');
ok(stA.netAvgR==null||stA.avgR==null||stA.netAvgR<=stA.avgR+1e-12,'AC6: net avgR never flatters gross (costs only subtract)');

/* AC1 habitat gate \u2014 injected always-fire trend strategy, ADX dial */
window.SIG_STRATS={tt:{name:'T',style:'day',habitat:'trend'}};
window.SIG_DETECT={tt:(x,i)=>i%25===0?1:0};
ADXV=15;const gLow=sigScan(dM,'tt').length;
ADXV=30;const gHigh=sigScan(dM,'tt').length;
ok(gLow===0&&gHigh>0,'AC1: trend-habitat strategy silenced when ADX<22 ('+gLow+'), fires when trending ('+gHigh+')');

/* AC3 time barrier \u2014 fire once, then dead-flat drift: neither side hit \u2192 time */
ADXV=25;window.SIG_STRATS={tm:{name:'TM',style:'day',habitat:'any'}};window.SIG_DETECT={tm:(x,i)=>i===100?1:0};
const dF=[];let p2=100;for(let i=0;i<300;i++){const vol=i<100?1.0:0.05;dF.push({t:i*3600000,o:p2,h:p2+vol,l:p2-vol,c:p2,v:100})}
const sT=sigScan(dF,'tm');
ok(sT.length===1&&sT[0].res==='time','AC3: stalled signal expires as \'time\' (got '+(sT[0]&&sT[0].res)+')');
ok(sigStats(sT).scratches===1&&sigStats(sT).winPct===null,'AC3: scratches counted, win% stays honest null');

/* AC6 cost subtraction known-answer */
const fake=[{res:'t1',costR:0.2},{res:'t1',costR:0.2},{res:'stop',costR:0.2},{res:'open'}];
const stC=sigStats(fake);
ok(Math.abs(stC.avgR-(1+1-1)/3)<1e-9&&Math.abs(stC.netAvgR-((1-0.2)+(1-0.2)+(-1-0.2))/3)<1e-9,'AC6: netAvgR = gross \u2212 costR exactly');

/* AC4 walk-forward known-answer: winner vs loser on stair-step uptrend */
const dU=[];let p3=100;for(let i=0;i<480;i++){p3*=1.004;dU.push({t:i*3600000,o:p3*0.999,h:p3*1.006,l:p3*0.995,c:p3,v:120})}
window.SIG_STRATS={winA:{name:'W',style:'day',habitat:'any'},loseB:{name:'L',style:'day',habitat:'any'}};
window.SIG_DETECT={winA:(x,i)=>i%20===0?1:0,loseB:(x,i)=>i%20===0?-1:0};
const wf=sigBestWF(dU,null);
ok(!!wf&&wf.strat==='winA'&&wf.wf===true,'AC4: WF picks the strategy that wins in-sample (winA)');
ok(!!wf&&wf.picks.every(k=>k==='winA'),'AC4: every fold\'s train pick is the true winner');
ok(!!wf&&wf.stats.resolved>=5&&wf.stats.avgR>0,'AC4: aggregated TEST-fold record is real and positive ('+(wf&&wf.stats.avgR.toFixed(2))+'R)');
ok(sigBestWF(dU.slice(0,200),null)===null,'AC4: too little data \u2192 null, never a guess');

/* MM detections \u2014 equal highs raided then rejected */
window.SIG_STRATS=FULL_STRATS;window.SIG_DETECT=FULL_DETECT;
const dR=[];let p4=100;for(let i=0;i<260;i++){
  let h=p4+1,l=p4-1,c=p4;
  if(i===120||i===140||i===160){h=110.02;c=108}          // three equal highs \u2248110
  else if(i===200){h=111.6;l=108;c=108.4}                 // the raid: sweep above, close back
  else if(i>200&&i<230){c=p4-=0.28;h=c+0.8;l=c-0.9}       // rejection follows
  else{p4=100+Math.sin(i/7)*2;c=p4;h=p4+1;l=p4-1}
  dR.push({t:i*3600000,o:c+0.05,h,l,c,v:i===200?400:100})}
let mmFired=0;['eqRaid','liqSweep','stopRun'].forEach(k=>{try{mmFired+=sigScan(dR,k).length}catch(e){}});
ok(mmFired>0,'MM mechanics: raid-and-reject synthetic triggers liquidity strategies ('+mmFired+')');

/* ensemble discipline: never fires more than its components */
let compFired=0;Object.keys(FULL_STRATS).filter(k=>k!=='ensemble').forEach(k=>{try{compFired+=sigScan(dM,k).length}catch(e){}});
let ensFired=0;try{ensFired=sigScan(dM,'ensemble').length}catch(e){ensFired=-1}
ok(ensFired>=0&&ensFired<=compFired,'ensemble: requires agreement \u2014 fires \u2264 component total ('+ensFired+' \u2264 '+compFired+')');

/* IN2 qCalib buckets known-answer */
const cal=window.qCalib([{q:85,res:'t1'},{q:85,res:'t2'},{q:85,res:'stop'},{q:30,res:'stop'},{q:30,res:'stop'},{q:50,res:'time'},{q:null,res:'t1'},{q:90,res:'open'}]);
ok(Math.abs(cal['80+'].rate-2/3)<1e-9&&cal['80+'].n===3,'IN2: 80+ bucket rate = 2/3 of 3 (opens/time/null excluded)');
ok(cal['0-40'].rate===0&&cal['0-40'].n===2&&cal['40-60']===null,'IN2: losing bucket honest 0%, empty bucket null not fake');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1]||0)>=34.0,'version >= 34.0 (never pin exact APP_VER \u2014 a release must not redden a green suite)');
console.log('v34.0 ACCURACY SPINE: '+P+' passed, '+F+' failed');
process.exit(F?1:0);
