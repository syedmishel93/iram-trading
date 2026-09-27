// v14.7 — known-answer + invariant tests for the SHIPPED overfitting-audit statistics.
// Extracts cscvPBO / deflatedSharpe / expectedMaxSR / normInv / _combos and the stats primitives
// verbatim from index.html so the test always matches shipped code.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){
  let m=html.match(new RegExp('\\nfunction '+name.replace(/[$]/g,'\\$')+'\\('));
  if(m){let i=m.index+1,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}return html.slice(i,k+1)}
  m=html.match(new RegExp('\\nconst '+name+'='));
  if(m){let i=m.index+1,k=html.indexOf('\n',i);return html.slice(i,k)}
  throw new Error('not found: '+name);
}
const names=['_mean','_std','_skew','_kurt','normCdf','sharpeR','_combos','normInv','cscvPBO','expectedMaxSR','deflatedSharpe'];
const src=names.map(grab).join('\n');
const F={};new Function(src+'\nObject.assign(this,{'+names.join(',')+'});').call(F);
const {_combos,normInv,cscvPBO,expectedMaxSR,deflatedSharpe,sharpeR,normCdf}=F;

let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};
const near=(a,b,t=1e-6)=>Math.abs(a-b)<=t;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}

// combos
ok(_combos(4,2).length===6,'C(4,2)=6');
ok(_combos(6,3).length===20,'C(6,3)=20');
ok(_combos(4,2).every(c=>c.length===2&&c[0]<c[1]),'combos sorted pairs');

// normInv
ok(near(normCdf(normInv(0.975)),0.975,2e-3),'normInv/normCdf roundtrip .975');
ok(near(normInv(0.5),0,1e-6),'normInv(0.5)=0');
ok(normInv(0.9)>0 && normInv(0.1)<0,'normInv sign');

// CSCV validity + bounds
{
  let r=mulberry32(7);const T=240,base=[];for(let i=0;i<T;i++)base.push(r()-0.5);
  const res=cscvPBO([base.slice(),base.slice(),base.slice(),base.slice()],10);
  ok(res.ok,'cscv runs');
  ok(res.pbo>=0&&res.pbo<=1,'PBO in [0,1] ('+res.pbo.toFixed(3)+')');
  ok(res.splits===_combos(10,5).length,'splits==C(10,5)='+res.splits);
}
// dominant real edge → low PBO
{
  const T=320,noise=k=>{const a=[],rr=mulberry32(k);for(let i=0;i<T;i++)a.push((rr()-0.5)*2);return a};
  const good=noise(1).map(v=>v+0.6);
  const res=cscvPBO([good,noise(2),noise(3),noise(4),noise(5),noise(6)],12);
  ok(res.pbo<0.4,'dominant real edge → low PBO ('+res.pbo.toFixed(3)+')');
}
// too few configs / short series → honest failure
ok(!cscvPBO([[1,2,3]],10).ok,'refuses <2 configs');
ok(!cscvPBO([[1,2],[3,4]],10).ok,'refuses T<S');

// Deflated Sharpe: more trials deflates
{
  let r=mulberry32(3);const best=[];for(let i=0;i<120;i++)best.push((r()-0.35)*2);
  const few=[0.1,0.15,0.12,0.2,0.08],many=[];for(let i=0;i<200;i++)many.push((mulberry32(500+i)()-0.5)*0.6);
  const dFew=deflatedSharpe(best,few,best.length),dMany=deflatedSharpe(best,many,best.length);
  ok(dFew.ok&&dMany.ok,'DSR computes');
  ok(dMany.sr0>=dFew.sr0,'more trials → SR0 bar not lower');
  ok(dMany.dsr<=dFew.dsr+1e-9,'more trials deflates DSR ('+dMany.dsr.toFixed(3)+' <= '+dFew.dsr.toFixed(3)+')');
  ok(dFew.dsr>=0&&dFew.dsr<=1,'DSR in [0,1]');
}
// losing series → DSR<0.5
{
  let r=mulberry32(9);const bad=[];for(let i=0;i<120;i++)bad.push((r()-0.62)*2);
  const trials=[];for(let i=0;i<30;i++)trials.push(mulberry32(i)()-0.5);
  ok(deflatedSharpe(bad,trials,bad.length).dsr<0.5,'losing series → DSR<0.5');
}
ok(!deflatedSharpe([1,2,3],[0.1,0.2],3).ok,'DSR refuses n<4');

console.log(`\nv14.7 OVERFITTING-AUDIT TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
