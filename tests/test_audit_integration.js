// v15.0 — INTEGRATION smoke test: extracts the REAL compute subgraph (indicators + strategy engine +
// v14.7/v15.0 blocks) from the shipped index.html and runs the whole pipeline on genuine genData candles.
// Proves the wiring works end-to-end, not just the isolated math.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(sig){let m=html.match(sig);if(!m)throw new Error('not found: '+sig);
  let i=m.index,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}
  let end=k+1;if(html.slice(end,end+1)===';')end++;return html.slice(i,end)}
function grabArrow(name){const m=html.match(new RegExp('\\nconst '+name+'='));const i=m.index+1,k=html.indexOf('\n',i);return html.slice(i,k)}
function grabLine(prefix){const i=html.indexOf('\n'+prefix)+1,k=html.indexOf('\n',i);return html.slice(i,k)} // single-line IND.x=... statements
const stats=['_skew','_kurt','normCdf','sharpeR'].map(n=>grab(new RegExp('\\nfunction '+n+'\\('))).join('\n')+'\n'+grabArrow('_mean')+'\n'+grabArrow('_std');
const pieces=[
  grab(/\nfunction mulberry32\(/),grab(/\nfunction genData\(/),grab(/\nconst IND ?=/),
  grabLine('IND.stoch=function'),grabLine('IND.willr=function'),grabLine('IND.cci=function'),
  grabLine('IND.roc=function'),grabLine('IND.mfi=function'),grabLine('IND.adx=function'),grabLine('IND.flux=function'),
  grab(/\nfunction swings\(/),grab(/\nfunction detectDivergence\(/),grab(/\nfunction indicatorsFor\(/),
  grab(/\nfunction _val\(/),grab(/\nfunction _triplet\(/),grab(/\nfunction _group\(/),
  grab(/\nfunction _stopPx\(/),grab(/\nfunction _tpPx\(/),grab(/\nfunction runStrategy\(/),
  grab(/\nconst VNAME ?=/),grabArrow('nv'),grab(/\nconst OPN ?=/),grab(/\nfunction ruleText\(/),
  stats,grab(/\nfunction _combos\(/),grab(/\nfunction normInv\(/),grab(/\nfunction cscvPBO\(/),
  grab(/\nfunction expectedMaxSR\(/),grab(/\nfunction deflatedSharpe\(/),grab(/\nfunction sweepStrategyConfigs\(/),
  grab(/\nfunction wilson\(/),grab(/\nfunction sessionBucket\(/),grabArrow('SESSION_ORDER'),grab(/\nfunction seasonalityStats\(/),
];
const ex=['genData','runStrategy','sweepStrategyConfigs','cscvPBO','deflatedSharpe','seasonalityStats'];
const F={};new Function(pieces.join('\n')+'\nObject.assign(this,{'+ex.join(',')+'});').call(F);
const {genData,runStrategy,sweepStrategyConfigs,cscvPBO,deflatedSharpe,seasonalityStats}=F;

let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};
const d=genData(2000,68000,42);
ok(d.length===2000&&isFinite(d[0].t),'genData real OHLC+time');
const spec={name:'ema50/200',long:[['ema50','>','ema200'],['close','crossabove','ema50']],short:[['ema50','<','ema200'],['close','crossbelow','ema50']],exitLong:[['close','<','ema50']],exitShort:[['close','>','ema50']],stop:{type:'atr',mult:2},tp:{type:'rr',value:2}};
const base=runStrategy(spec,d);
ok(base.length>0&&base.every(t=>isFinite(t.R)&&t.entryI!=null&&t.exitI!=null),'runStrategy → trades w/ R,entryI,exitI ('+base.length+')');
const configs=sweepStrategyConfigs(spec,d,2);
ok(configs.length===25,'sweep = 25 configs');
ok(configs.every(c=>c.perBar.length===d.length),'perBar time-aligned to bars');
const qual=configs.filter(c=>c.ntr>=8);ok(qual.length>=2,qual.length+' configs ≥8 trades');
const cv=cscvPBO(qual.map(c=>Array.prototype.slice.call(c.perBar)),10);
ok(cv.ok&&cv.pbo>=0&&cv.pbo<=1&&cv.splits===252,'CSCV on real sweep → PBO '+(cv.pbo*100).toFixed(0)+'% over 252 splits');
let best=qual[0];qual.forEach(c=>{if(c.sharpe>best.sharpe)best=c});
const ds=deflatedSharpe(best.Rlist,qual.map(c=>c.sharpe),best.Rlist.length);
ok(ds.ok&&ds.dsr>=0&&ds.dsr<=1,'DSR on real best config → '+(ds.dsr*100).toFixed(0)+'%');
const seas=seasonalityStats(base.map(t=>({R:t.R,entryI:t.entryI})),d,5);
ok(seas.total===base.length,'seasonality bucketed all '+base.length+' trades');
ok(seas.bySession.every(s=>s.n>0&&s.lo<=s.hi)&&seas.byHour.every(h=>h.winRate>=0&&h.winRate<=1),'valid Wilson CIs + bounded win-rates');
console.log(`\nv15.0 AUDIT INTEGRATION (real pipeline): ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
