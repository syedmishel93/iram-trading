// v28.0 — SIG engine known-answer tests (shipped source)
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// minimal IND for the engine
global.window={SIG_STRATS:{emaPull:{},stFlip:{},smcChoch:{},momFlip:{}}};
global.CURSYM={sym:'TEST'};global.BAR_CACHE={};   // v34: sigScan reads these for HTF context
global.IND={
  ema(c,n){const k=2/(n+1);const o=[];let e=c[0];c.forEach((v,i)=>{e=i?v*k+e*(1-k):v;o.push(e)});return o},
  rsi(c,n=14){const o=[];let g=0,l=0;for(let i=1;i<c.length;i++){const d=c[i]-c[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n;o[i]=l?100-100/(1+g/l):100}o[0]=50;return o},
  atr(d,n=14){const o=[];let a=0;for(let i=0;i<d.length;i++){const tr=i?Math.max(d[i].h-d[i].l,Math.abs(d[i].h-d[i-1].c),Math.abs(d[i].l-d[i-1].c)):d[i].h-d[i].l;a=i?(a*(n-1)+tr)/n:tr;o.push(a)}return o},
  macd(c){const e12=this.ema(c,12),e26=this.ema(c,26);const m=c.map((_,i)=>e12[i]-e26[i]);const sig=this.ema(m,9);return{m,sig,hist:m.map((v,i)=>v-sig[i])}},
  adx(d,n=14){const o=[];for(let i=0;i<d.length;i++)o.push(25);return o},   // v34 stub: neutral ADX (habitat gates stay open for 'any', trend gate at 22<25 passes)
  supertrend(d,p=10,mult=3){const atr=this.atr(d,p);const dir=[],up=[],dn=[];let dr=1;for(let i=0;i<d.length;i++){const mid=(d[i].h+d[i].l)/2;const u=mid+mult*atr[i],l=mid-mult*atr[i];up.push(u);dn.push(l);if(i){if(d[i].c>up[i-1])dr=1;else if(d[i].c<dn[i-1])dr=-1}dir.push(dr)}return{dir,up,dn}}
};
eval(grab('swings'));
{const rS=src.indexOf('window.SIG_DETECT={'),rE=src.indexOf('function sigScan(d,strat){');eval(src.slice(rS,rE));}   // registry (v29.0)
eval(grab('sigScan'));eval(grab('sigStats'));eval(grab('sigStyleForTF'));eval(grab('sigBest'));

// synthetic: choppy range, violent crash, then strong stair-step uptrend
const d=[];let px=100;
for(let i=0;i<90;i++){px=100+Math.sin(i/5)*2;d.push({t:i*3600000,o:px,h:px+1.2,l:px-1.2,c:px+Math.sin(i/3)*0.8,v:100})}
for(let i=0;i<15;i++){px*=0.985;d.push({t:(90+i)*3600000,o:px*1.002,h:px*1.003,l:px*0.985,c:px*0.99,v:300})}
for(let i=0;i<180;i++){px*=1.006;d.push({t:(105+i)*3600000,o:px*0.998,h:px*1.008,l:px*0.994,c:px,v:150})}

const stf=sigScan(d,'momFlip').concat(sigScan(d,'smcChoch'));
ok(stf.length>=2,'momFlip+smcChoch: signals fire on crash/reversal ('+stf.length+')');
ok(stf.every(s=>s.dir===1?(s.stop<s.entry&&s.t1>s.entry&&s.t2>s.t1):(s.stop>s.entry&&s.t1<s.entry&&s.t2<s.t1)),'geometry: stop/T1/T2 on correct sides for every signal');
ok(stf.every(s=>Math.abs(Math.abs(s.t1-s.entry)-s.r)<1e-9&&Math.abs(Math.abs(s.t2-s.entry)-2*s.r)<1e-9),'T1=1R, T2=2R exactly (glass-box math)');
const up=stf.filter(s=>s.dir===1&&s.i>=105);
ok(up.some(s=>s.res==='t1'||s.res==='t2'),'long signal in the uptrend resolves to target');
const st=sigStats(stf);
ok(st.resolved>0&&st.winPct!=null&&isFinite(st.avgR),'stats: measured winPct + avgR from resolved signals');
ok(sigStats([]).winPct===null,'stats: no signals \u2192 null (honest, not fake 0%)');
// all four strategies run without throwing
['emaPull','stFlip','smcChoch','momFlip'].forEach(k=>{let okk=true;try{sigScan(d,k)}catch(e){okk=false}ok(okk,'strategy runs clean: '+k)});
// debounce
const mf=sigScan(d,'momFlip');ok(mf.every((s,ix)=>ix===0||s.i-mf[ix-1].i>=5),'debounce: signals \u22655 bars apart');
// sigBest picks something on rich data or returns null honestly
const b=sigBest(d);ok(b===null||(b._sel&&b._sel.resolved>=6&&b.oos===true),'sigBest: selects in-sample (\u22656) and reports OOS (v29 contract)');
console.log('\nv28.0 SIG TESTS: '+P+' passed, '+F+' failed');if(F)process.exit(1);

// ===== v28.0 UI surface: SIG rendering + decision layer D1-D6 + E-features =====
(function(){
const src2=require('fs').readFileSync(__dirname+'/../index.html','utf8');
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};

// SIG2-5 surface
ok(src2.includes('id="sigSel"')&&src2.includes('best measured'),'SIG4: strategy picker in toolbar w/ auto best-measured');
ok(src2.includes("'\\u25b2 L'")&&src2.includes('roundRect'),'SIG2: flag-pill markers at signal bars (v30 style)');
ok(src2.includes('createLinearGradient(xi,0,xe,0)')&&src2.includes('o.y(sg.entry)'),'SIG2: outcome ribbons entry\u2192resolution (v30 style)');
ok(src2.includes("ln(yS,'rgba(240,97,109,.9)','stop')")&&src2.includes("'T1'")&&src2.includes("'T2'"),'SIG2: live setup lines (entry/stop/T1/T2) on chart');
ok(src2.includes('measured on THIS data, not a promise'),'SIG3: honesty legend with measured record');
ok(src2.includes('record building \\u2014 not enough resolved signals'),'SIG3: honest when record is thin');
ok(src2.includes('plan card synced \\u00b7 you decide'),'SIG5: live signal toast \u2014 decision support, no auto-exec');
ok(!/autoExec|autoTrade\(|executeOrder\(/.test(src2),'SIG6: no auto-execution anywhere');

// D1/D2
ok(src2.includes('REAL convergence')&&src2.includes('LIKELY FAKE')&&src2.includes('sybil ring'),'D1: convergence verdicts w/ sybil cross-check');
ok(src2.includes('<details')&&src2.includes("summary style=\"cursor:pointer"),'D6: address walls collapsed behind expanders');
ok(src2.includes('bot-like churn')&&src2.includes('excluded from the smart rank automatically'),'D2: pattern meanings + auto-exclusion summary');
ok((src2.match(/SO WHAT/g)||[]).length>=2,'D3: SO-WHAT strips on data panels');
ok(src2.includes('convergence = several wallets buying the same token'),'D5: inline micro-explanations');

// D4 NBA
ok(src2.includes('function nbaCompute')&&src2.includes('What should I do now?'),'D4: next-best-action box');
ok(src2.includes('run the EVM harvest')&&src2.includes('REAL convergence \\u2014 independent smart wallets agree'),'D4: rules name concrete next steps');

// E1/E2/E3
ok(src2.includes('function aqPush')&&src2.includes('Action Queue'),'E1: action queue inbox');
ok(src2.includes('function researchPack')&&src2.includes('Research Pack'),'E2: consolidated research pack modal');
ok(src2.includes('never a buy signal \\u00b7 you decide \\u00b7 nothing executes'),'E2: honesty footer in pack');
ok(src2.includes('function dailyDiff')&&src2.includes('Since your last visit'),'E3: daily what-changed diff');

// E4/E5/E9/E10/E6/E8
ok(src2.includes('pktrade')&&src2.includes('pkpin'),'E4/E5: to-chart + pin-and-watch from the pack');
ok(src2.includes('function renderWatch')&&src2.includes('VERDICT TRACKER'),'E9: watch table w/ \u0394 since pinned');
ok(src2.includes('Narrative tag')&&src2.includes('narrative mix:'),'E10: narrative tags + rotation mix');
ok(src2.includes('function walletVisitDiff')&&src2.includes('since your last look'),'E6: wallet follow-diff in dossier');
ok(src2.includes('your note:'),'E8: wallet note shown in dossier');
ok(parseFloat((src2.match(/APP_VER='([\d.]+)'/)||[])[1])>=28.0,'version 28.0+');
console.log('v28.0 SURFACE TESTS: '+p+' passed, '+f+' failed');if(f)process.exit(1);
})();

// ===== v28.1: 12 styled strategies + quality gate + TF-fit auto =====
(function(){
const src3=require('fs').readFileSync(__dirname+'/../index.html','utf8');
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};
function g3(name){const i=src3.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src3.length;j++){const c=src3[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src3.slice(i,j)}
// SIG_STRATS: 12 strategies across 3 styles
const mS=src3.indexOf('window.SIG_STRATS={'),mE=src3.indexOf('};',mS);
const blk=src3.slice(mS,mE);
const strats=(blk.match(/(\w+):\{style:'(scalp|day|swing)'/g)||[]);
ok(strats.length>=12,'12+ strategies defined ('+strats.length+')');
['scalp','day','swing'].forEach(st=>ok((blk.match(new RegExp("style:'"+st+"'","g"))||[]).length>=3,'\u2265 3 strategies for style: '+st));
// v39.0 — pinned the emoji in the optgroup labels (⚡ Scalping / ☀ Day trade / 🌙 Swing).
// All 61 pictographs were purged from the chrome. The GROUPING is what this test is
// about, and the grouping is intact.
ok(/optgroup label="\s*Scalping/.test(src3)&&/optgroup label="\s*Day trade/.test(src3)&&/optgroup label="\s*Swing/.test(src3),'picker grouped by trading style');

// engine stubs to actually run all 12
global.window={SIG_STRATS:{}};eval(src3.slice(mS,mE+2).replace('window.SIG_STRATS=','window.SIG_STRATS='));
global.IND=Object.assign(global.IND||{},{
  boll(c,pp=20){const up=[],lo=[],mid=[];for(let i=0;i<c.length;i++){if(i<pp-1){up.push(null);lo.push(null);mid.push(null);continue}let s=0;for(let j=i-pp+1;j<=i;j++)s+=c[j];const m=s/pp;let v=0;for(let j=i-pp+1;j<=i;j++)v+=(c[j]-m)**2;const sd=Math.sqrt(v/pp);mid.push(m);up.push(m+2*sd);lo.push(m-2*sd)}return{up,lo,mid}},
  adx(d){return d.map(()=>25)},
  donchian(d,pp=20){const up=new Array(d.length).fill(null),lo=new Array(d.length).fill(null);for(let i=pp-1;i<d.length;i++){let h=-1e18,l=1e18;for(let j=i-pp+1;j<=i;j++){h=Math.max(h,d[j].h);l=Math.min(l,d[j].l)}up[i]=h;lo[i]=l}return{up,lo}},
  vwapBands(d){const vw=[],u1=[],l1=[];let pv=0,vv=0;for(let i=0;i<d.length;i++){const tp=(d[i].h+d[i].l+d[i].c)/3,v0=d[i].v||1;pv+=tp*v0;vv+=v0;const w=pv/vv;vw.push(w);u1.push(w*1.004);l1.push(w*0.996)}return{vw,u1,l1,u2:u1,l2:l1}}});
const rS=src3.indexOf('window.SIG_DETECT={'),rE=src3.indexOf('function sigScan(d,strat){');
eval(src3.slice(rS,rE));   // the strategy registry (v29.0 #6)
eval(g3('sigScan'));eval(g3('sigStats'));eval(g3('sigFilterQ'));eval(g3('sigStyleForTF'));eval(g3('sigBest'));
const d=[];let px=100;
for(let i=0;i<90;i++){px=100+Math.sin(i/5)*2;d.push({t:i*3600000,o:px,h:px+1.2,l:px-1.2,c:px+Math.sin(i/3)*0.8,v:100})}
for(let i=0;i<15;i++){px*=0.985;d.push({t:(90+i)*3600000,o:px*1.002,h:px*1.003,l:px*0.985,c:px*0.99,v:300})}
for(let i=0;i<180;i++){px*=1.006;d.push({t:(105+i)*3600000,o:px*0.998,h:px*1.008,l:px*0.994,c:px,v:150})}
Object.keys(window.SIG_STRATS).forEach(k=>{let okk=true,n=0;try{n=sigScan(d,k).length}catch(e){okk=false}
  ok(okk,'runs clean: '+k+' ('+window.SIG_STRATS[k].style+', '+n+' signals)')});
// quality: every signal carries q 0-100; gate is monotonic
const all2=sigScan(d,'momFlip');
ok(all2.every(s=>s.q==null||(s.q>=0&&s.q<=100)),'quality score 0-100 attached to signals');
ok(sigFilterQ(all2,50).length<=all2.length,'Q\u226550 gate never adds signals (monotonic filter)');
// TF fit
ok(sigStyleForTF('5m')==='scalp'&&sigStyleForTF('1h')==='day'&&sigStyleForTF('4h')==='swing','TF\u2192style mapping (5m scalp, 1h day, 4h swing)');
// stats gained PF
ok(g3('sigStats').includes('pf'),'stats include profit factor');
ok(parseFloat((src3.match(/APP_VER='([\d.]+)'/)||[])[1])>=28.1,'version 28.1+');
console.log('v28.1 STYLE/QUALITY TESTS: '+p+' passed, '+f+' failed');if(f)process.exit(1);
})();
