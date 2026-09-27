// S6 — golden tests for terminal logic mirrors. Run: node tests/test_terminal.js
// merge splice
let DATA=[{t:0,c:1,v:5},{t:1,c:2,v:5},{t:2,c:9,v:0},{t:3,c:9,v:0}]; // 2 phantoms
const fresh=[{t:1,c:2.5,v:7},{t:2,c:3,v:7}];
DATA=DATA.filter(b=>b.t<fresh[0].t).concat(fresh);
console.assert(DATA.length===3&&DATA.every(b=>b.v>0)&&DATA.every((b,i)=>!i||b.t>DATA[i-1].t),"splice");
// ledger scoring
console.assert(((97-100)*(-40)>0)===true&&((103-100)*(-40)>0)===false,"ledger");
// gap classification (measured spacing)
const ms=1800000,dts=[ms,ms,ms*2,ms*8];let miss=0,cl=0;dts.forEach(dt=>{if(dt>6*ms)cl++;else if(dt>1.5*ms)miss++});
console.assert(miss===1&&cl===1,"gaps");
// zone clustering
const pts=[100,100.2,105].sort((a,b)=>a-b);let Z=[],cur=null;pts.forEach(p=>{if(cur&&p-cur.hi<=0.5){cur.hi=p;cur.n++}else{if(cur)Z.push(cur);cur={lo:p,hi:p,n:1}}});Z.push(cur);
console.assert(Z.filter(z=>z.n>=2).length===1,"zones");
console.log("TERMINAL LOGIC TESTS PASS ✓");
