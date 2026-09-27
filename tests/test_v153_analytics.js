// v15.3 — SHIPPED-source tests: pearson/lead-lag (known shift), meta-labeling (planted signal + honesty), ribbon segs.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){let m=html.match(new RegExp('\\nfunction '+name+'\\('));if(!m)throw new Error('missing '+name);
  let i=m.index+1,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}return html.slice(i,k+1)}
const src=['pearson','leadLagBest','_sigm','metaLabelFit','_zNorm','metaLabelGate','ribbonSegs'].map(grab).join('\n');
const R=new Function(src+'\nreturn {pearson,leadLagBest,metaLabelFit,metaLabelGate,ribbonSegs};')();
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};
const near=(a,b,t=1e-6)=>Math.abs(a-b)<=t;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

// pearson known values
ok(near(R.pearson([1,2,3,4],[2,4,6,8]),1),'perfect positive corr = 1');
ok(near(R.pearson([1,2,3,4],[8,6,4,2]),-1),'perfect negative corr = -1');
ok(Math.abs(R.pearson([1,2,3,4,5,6,7,8],[5,1,4,2,5,1,4,2]))<0.6,'weak relation stays small');

// lead-lag KNOWN ANSWER: b is a delayed copy of a by 3 bars -> a leads b by 3
{const rr=mulberry32(5);const a=[];for(let i=0;i<200;i++)a.push(rr()-0.5);
 const b=new Array(3).fill(0).concat(a.slice(0,197));
 const ll=R.leadLagBest(a,b,8);
 ok(ll.lag===3,'detects a leads b by 3 (got '+ll.lag+')');
 ok(ll.corr>0.95,'lagged corr ~1 (got '+ll.corr.toFixed(2)+')');
 const ll2=R.leadLagBest(b,a,8);
 ok(ll2.lag===-3,'symmetric: b arg first -> lag=-3 (got '+ll2.lag+')');}

// meta-labeling: PLANTED signal — feature[0] perfectly predicts outcome -> gate uplift OOS
{const feats=[],outs=[];const rr=mulberry32(9);
 for(let i=0;i<120;i++){const good=rr()>0.5?1:0;feats.push([good,rr()*40,(rr()-0.5)*30,rr(),rr()]);outs.push(good?0.8+rr()*0.4:-(0.8+rr()*0.4));}
 const g=R.metaLabelGate(feats,outs,0.7);
 ok(g.ok,'gate runs on 120 trades');
 ok(g.kept.wr>0.9,'planted: kept win-rate >90% ('+(g.kept.wr*100).toFixed(0)+'%)');
 ok(g.uplift>0.3,'planted: strong positive OOS uplift ('+g.uplift.toFixed(2)+'R)');
 ok(/improved/i.test(g.verdict),'verdict acknowledges uplift');}
// meta-labeling HONESTY: random features -> no fake edge claimed
{const feats=[],outs=[];const rr=mulberry32(21);
 for(let i=0;i<120;i++){feats.push([rr(),rr(),rr(),rr(),rr()]);outs.push(rr()>0.5?1:-1);}
 const g=R.metaLabelGate(feats,outs,0.7);
 ok(g.ok,'random gate runs');
 ok(!(g.uplift>0.3&&/improved/i.test(g.verdict))||Math.abs(g.uplift)<0.5,'no large fabricated uplift on noise');}
// refusals
ok(!R.metaLabelGate([[1,2]],[1],0.7).ok,'refuses <30 trades');
{const feats=[],outs=[];for(let i=0;i<32;i++){feats.push([i%2,0,0,0,0]);outs.push(i%2?1:-1)}
 const g=R.metaLabelGate(feats,outs,0.9); /* 90% split -> ~3 OOS */
 ok(!g.ok&&/out-of-sample/.test(g.reason),'refuses tiny OOS slice');}

// ribbonSegs merge
{const segs=R.ribbonSegs([{t:1,regime:'LO'},{t:2,regime:'LO'},{t:3,regime:'HI'},{t:4,regime:'HI'},{t:5,regime:'HI'},{t:6,regime:'LO'}]);
 ok(segs.length===3,'3 merged segments');
 ok(segs[0].n===2&&segs[1].n===3&&segs[2].n===1,'segment counts 2/3/1');
 ok(segs[1].from===3&&segs[1].to===5,'segment span correct');
 ok(R.ribbonSegs([]).length===0&&R.ribbonSegs(null).length===0,'empty/null safe');}

console.log(`\nv15.3 ANALYTICS TESTS: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
