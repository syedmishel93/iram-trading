// v15.0 — known-answer + invariant tests for the SHIPPED seasonality edge finder.
// Extracts wilson / sessionBucket / seasonalityStats verbatim from index.html.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){
  let m=html.match(new RegExp('\\nfunction '+name+'\\('));
  if(m){let i=m.index+1,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}return html.slice(i,k+1)}
  m=html.match(new RegExp('\\nconst '+name+'='));
  if(m){let i=m.index+1,k=html.indexOf('\n',i);return html.slice(i,k)}
  throw new Error('not found: '+name);
}
const names=['wilson','sessionBucket','SESSION_ORDER','seasonalityStats'];
const src=names.map(grab).join('\n');
const F={};new Function(src+'\nObject.assign(this,{'+names.join(',')+'});').call(F);
const {wilson,sessionBucket,seasonalityStats}=F;

let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};
const near=(a,b,t=1e-4)=>Math.abs(a-b)<=t;

// wilson
ok(wilson(0,10).lo===0,'wilson 0/10 lo=0');
ok(near(wilson(5,10).p,0.5),'wilson 5/10 p=.5');
ok((wilson(50,100).hi-wilson(50,100).lo)<(wilson(2,4).hi-wilson(2,4).lo),'more n → tighter CI');
ok(wilson(8,8).hi===1,'wilson 8/8 hi=1');
ok(wilson(0,0).lo===0&&wilson(0,0).hi===1,'wilson n=0 safe');

// session buckets full clock
const map={0:'Asia',7:'Asia',8:'London',12:'London',13:'London/NY overlap',16:'London/NY overlap',17:'New York',21:'New York',22:'After-hours',23:'After-hours'};
ok(Object.keys(map).every(h=>sessionBucket(+h)===map[h]),'all session boundaries correct');

// seasonalityStats end-to-end
{
  const base=Date.UTC(2025,0,1,0,0,0);const d=[];for(let i=0;i<48;i++)d.push({t:base+i*3600e3,c:100});
  const trades=[{R:1.2,entryI:2},{R:0.8,entryI:3},{R:1.5,entryI:4},{R:-1,entryI:18},{R:-1,entryI:19}];
  const s=seasonalityStats(trades,d,2);
  ok(s.total===5,'5 trades mapped');
  const asia=s.bySession.find(x=>x.key==='Asia'),ny=s.bySession.find(x=>x.key==='New York');
  ok(asia.n===3&&asia.wins===3,'Asia 3/3');
  ok(ny.n===2&&ny.wins===0,'NY 0/2');
  ok(near(asia.meanR,(1.2+0.8+1.5)/3),'Asia mean R');
  ok(near(asia.sumR,3.5),'Asia sum R');
  ok(asia.enough&&ny.enough,'meet minN=2');
  ok(s.byHour.find(x=>+x.key===2).n===1,'hour 02 = 1 trade');
  ok(s.bySession.map(x=>x.key).join(',').indexOf('Asia')<s.bySession.map(x=>x.key).join(',').indexOf('New York'),'session order Asia before NY');
}
// insufficient sample flag
{
  const base=Date.UTC(2025,0,1,0,0,0);const d=[];for(let i=0;i<24;i++)d.push({t:base+i*3600e3,c:1});
  const s=seasonalityStats([{R:1,entryI:2},{R:-1,entryI:3}],d,5);
  ok(s.bySession.every(x=>!x.enough),'thin buckets flagged not-enough');
}
// bad/missing candle safety
ok(seasonalityStats([{R:1,entryI:999}],[{t:Date.UTC(2025,0,1),c:1}],5).total===0,'out-of-range entryI dropped, no crash');

console.log(`\nv15.0 SEASONALITY TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
