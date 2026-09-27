// v16.4 RRG + RAIL UX — tests against SHIPPED code
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(grab('rrgQuadrant')+'\n'+grab('rrgCalc'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

ok(rrgQuadrant(105,103)==='LEADING','RS\u2191 Mom\u2191 \u2192 LEADING');
ok(rrgQuadrant(105,97)==='WEAKENING','RS\u2191 Mom\u2193 \u2192 WEAKENING');
ok(rrgQuadrant(95,97)==='LAGGING','RS\u2193 Mom\u2193 \u2192 LAGGING');
ok(rrgQuadrant(95,103)==='IMPROVING','RS\u2193 Mom\u2191 \u2192 IMPROVING');

// known-answer: bench flat; ACCELERATING outperformer; ACCELERATING underperformer
// (constant-rate exponentials sit exactly on the mom=100 boundary — a correct RRG property — so use acceleration)
const N=80;const flat=Array.from({length:N},()=>100);
const acc=(g0,dg)=>{let px=100;const a=[];for(let i=0;i<N;i++){a.push(px);px*=(1+g0+dg*i)}return a};
const upper=acc(0.001,0.0002);    // relative gain speeding up
const downer=acc(-0.001,-0.0002); // relative loss speeding up
let pts=rrgCalc({BENCH:flat,UP:upper,DOWN:downer},'BENCH',20,5);
const up=pts.find(p=>p.sym==='UP'),dn=pts.find(p=>p.sym==='DOWN');
ok(pts.length===2,'bench excluded from its own plot');
ok(up.rs>100&&up.mom>100&&up.quad==='LEADING','accelerating outperformer \u2192 LEADING (rs='+up.rs+', mom='+up.mom+')');
ok(dn.rs<100&&dn.mom<100&&dn.quad==='LAGGING','accelerating underperformer \u2192 LAGGING (rs='+dn.rs+', mom='+dn.mom+')');
ok(up.tail.length>=2&&up.tail.length<=5,'tail carries \u22645 readings for the trail');

// mild turnaround: long decline, small uptick at the end -> still below trailing avg (rs<100) but momentum up -> IMPROVING
const turn=[];{let px=100;for(let i=0;i<N;i++){turn.push(px);px*=(i<70?0.995:1.001)}}
pts=rrgCalc({BENCH:flat,TURN:turn},'BENCH',20,5);
ok(pts[0].rs<100&&pts[0].mom>100&&pts[0].quad==='IMPROVING','mild turnaround \u2192 IMPROVING ('+pts[0].rs+'/'+pts[0].mom+')');

// honesty: short series refused
ok(rrgCalc({BENCH:flat.slice(0,10),X:upper.slice(0,10)},'BENCH').length===0,'short series \u2192 empty, never padded');
ok(rrgCalc({BENCH:flat,X:upper.slice(0,15)},'BENCH').length===0,'short member skipped');
ok(rrgCalc({},'BENCH').length===0,'no data \u2192 empty');

// shipped UI
ok(src.includes('id="rrgOut"')&&src.includes('id="rrgRun"'),'RRG panel + refresh shipped in heatmap view');
ok(src.includes('Nothing synthetic is plotted here'),'honest empty state shipped');
ok(src.includes('id="railSearch"')&&src.includes('mishel_railgrp'),'rail search + collapsible group persistence shipped');
ok(src.includes('.rail-grp.collapsed .nav{display:none}'),'collapse CSS shipped');
console.log('\nv16.4 RRG+RAIL TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
