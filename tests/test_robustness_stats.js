// v14.2 — known-answer + invariant tests for the SHIPPED backtest statistics.
// Functions are extracted verbatim from index.html (see /tmp build step) — this file
// re-extracts them at runtime so the test always matches shipped code.
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

function grab(name){
  let m = html.match(new RegExp('\\nfunction '+name.replace(/[$]/g,'\\$')+'\\('));
  if(m){ let i=m.index+1, j=html.indexOf('{',i), d=0, k=j;
    for(;k<html.length;k++){ if(html[k]==='{')d++; else if(html[k]==='}'){d--; if(d===0)break;} }
    return html.slice(i,k+1);
  }
  m = html.match(new RegExp('\\nconst '+name+'='));
  if(m){ let i=m.index+1, k=html.indexOf('\n',i); return html.slice(i,k); }
  throw new Error('not found: '+name);
}
const src = ['_mean','_std','_skew','_kurt','normCdf','sharpeR','psr0','mulberry32'].map(grab).join('\n');
const F = {};
new Function(src + '\nObject.assign(this,{_mean,_std,_skew,_kurt,normCdf,sharpeR,psr0,mulberry32});').call(F);
const {_mean,_std,_skew,_kurt,normCdf,sharpeR,psr0,mulberry32} = F;

let pass=0, fail=0;
const ok=(c,m)=>{ if(c) pass++; else { fail++; console.log('  FAIL:',m); } };
const near=(a,b,t=1e-3)=>Math.abs(a-b)<=t;

// ---- normCdf known values ----
ok(near(normCdf(0),0.5,1e-9), 'normCdf(0)=0.5');
ok(near(normCdf(1.959964),0.975,2e-3), 'normCdf(1.96)=0.975');
ok(near(normCdf(-1.959964),0.025,2e-3), 'normCdf(-1.96)=0.025');
ok(near(normCdf(2.326348),0.99,2e-3), 'normCdf(2.33)=0.99');
ok(normCdf(-3)<normCdf(0) && normCdf(0)<normCdf(3), 'normCdf monotone');
ok(near(normCdf(5),1,1e-3) && near(normCdf(-5),0,1e-3), 'normCdf tails');

// ---- mean/std sanity ----
ok(_mean([1,2,3,4,5])===3, 'mean([1..5])=3');
ok(near(_std([2,4,4,4,5,5,7,9]),2.0,1e-9), 'population std known = 2');  // classic textbook example

// ---- sharpeR ----
ok(sharpeR([1,1,1,1])===0, 'zero-variance Sharpe = 0 (safe)');
ok(sharpeR([2,-1,1,-0.5,1.5])>0, 'positive-mean Sharpe > 0');
ok(sharpeR([-2,1,-1,0.5,-1.5])<0, 'negative-mean Sharpe < 0');
{ // Sharpe = mean/std exactly
  const R=[0.5,-0.2,0.3,-0.1,0.4,-0.15,0.25];
  ok(near(sharpeR(R), _mean(R)/_std(R), 1e-12), 'Sharpe == mean/std');
}

// ---- psr0: matches the closed form for a given series ----
{
  const R=[0.6,-0.3,0.4,-0.2,0.5,-0.25,0.35,-0.15,0.45,-0.1];
  const sr=sharpeR(R), n=R.length, g3=_skew(R), g4=_kurt(R);
  const denom=Math.sqrt(Math.max(1e-9,1-g3*sr+((g4-1)/4)*sr*sr));
  const expect=normCdf(sr*Math.sqrt(n-1)/denom);
  ok(near(psr0(R),expect,1e-9), 'PSR matches Bailey/LdP closed form');
  ok(psr0(R)>=0 && psr0(R)<=1, 'PSR bounded [0,1]');
}
ok(!isFinite(psr0([1,2,3])) || Number.isNaN(psr0([1,2,3])), 'PSR refuses n<4 (NaN)');

// ---- monotonicity: stronger edge -> higher PSR ----
{
  const weak=psr0([0.2,-0.1,0.15,-0.05,0.1,-0.08,0.12,-0.03,0.09,-0.04]);
  const strong=psr0([1.2,1.0,0.9,1.1,0.8,1.3,0.95,1.05,1.15,0.85]);
  ok(strong>weak, 'PSR: stronger edge > weaker edge ('+strong.toFixed(3)+' > '+weak.toFixed(3)+')');
  const losing=psr0([-0.5,0.2,-0.4,0.1,-0.6,0.15,-0.3,0.05,-0.45,0.08]);
  ok(losing<0.5, 'PSR < 50% for a losing series ('+losing.toFixed(3)+')');
  ok(strong>0.9, 'PSR high for a strong consistent series ('+strong.toFixed(3)+')');
}

// ---- Monte-Carlo bootstrap invariants (mirrors shipped renderRobustness core) ----
{
  const Rs=[]; let rr=mulberry32(42);
  for(let i=0;i<80;i++) Rs.push((rr()-0.42)*2);   // slight positive-skewed edge
  const N=Rs.length, P=600, risk=0.01, ruinDD=0.5;
  let rng=mulberry32(99);
  const finals=[]; let ruined=0; const stepMid=[];
  for(let p=0;p<P;p++){ let e=1,peak=1,ruin=false;
    for(let k=0;k<N;k++){ const r=Rs[(rng()*N)|0]; e*=1+risk*r; if(e<1e-6)e=1e-6; if(e>peak)peak=e; if((peak-e)/peak>=ruinDD)ruin=true; }
    finals.push(e); if(ruin)ruined++; }
  const pProfit=finals.filter(v=>v>1).length/P;
  const ror=ruined/P;
  const s=finals.slice().sort((a,b)=>a-b);
  const q=(p)=>s[Math.min(s.length-1,Math.max(0,Math.round(p*(s.length-1))))];
  ok(pProfit>=0 && pProfit<=1, 'P(profit) in [0,1]');
  ok(ror>=0 && ror<=1, 'risk-of-ruin in [0,1]');
  ok(q(0.05)<=q(0.5) && q(0.5)<=q(0.95), 'percentile band ordered p5<=p50<=p95');
  ok(finals.every(v=>v>0), 'all bootstrap equities positive');
  // determinism: same seed -> same result
  let rng2=mulberry32(99); const f2=[];
  for(let p=0;p<P;p++){ let e=1; for(let k=0;k<N;k++){ const r=Rs[(rng2()*N)|0]; e*=1+risk*r; if(e<1e-6)e=1e-6; } f2.push(e); }
  ok(f2.every((v,i)=>near(v,finals[i],1e-9)), 'bootstrap deterministic for a fixed seed');
}

console.log(`\nv14.2 ROBUSTNESS/STATS TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
