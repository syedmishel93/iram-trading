// v15.1 — SHIPPED-source tests: AVWAP sigma-bands, axis heat buckets, template store logic.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){let m=html.match(new RegExp('\\nfunction '+name+'\\('));if(!m)throw new Error('missing '+name);
  let i=m.index+1,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}return html.slice(i,k+1)}
const store={};const localStorage={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
const STORE={set:(k,v)=>{localStorage.setItem(k,v);return v},get:k=>localStorage.getItem(k),durable:()=>true,flushNow(){},hydrate(){}};  /* v35.0: STORE is a browser global now (durable keys mirror to SQLite) */
const src=['avwapBandsFrom','axisHeatBuckets','_tplStore','saveDrawTemplate','listDrawTemplates','applyDrawTemplate','deleteDrawTemplate'].map(grab).join('\n');
const F={localStorage};new Function('localStorage','STORE',src+'\nreturn {avwapBandsFrom,axisHeatBuckets,saveDrawTemplate,listDrawTemplates,applyDrawTemplate,deleteDrawTemplate};')(localStorage,STORE);
const R=new Function('localStorage','STORE',src+'\nreturn {avwapBandsFrom,axisHeatBuckets,saveDrawTemplate,listDrawTemplates,applyDrawTemplate,deleteDrawTemplate};')(localStorage,STORE);
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};
const near=(a,b,t=1e-9)=>Math.abs(a-b)<=t;

// AVWAP bands: constant price + constant vol -> mean=price, sigma=0, bands collapse
{const d=[];for(let i=0;i<50;i++)d.push({h:100,l:100,c:100,v:10});
 const B=R.avwapBandsFrom(0,d);
 ok(near(B.v[49],100),'flat series: AVWAP=price');
 ok(near(B.u1[49],100)&&near(B.l2[49],100),'flat series: bands collapse to mean');}
// known two-value case: prices 90 and 110, equal vol -> mean=100, var=100, sd=10
{const d=[{h:90,l:90,c:90,v:5},{h:110,l:110,c:110,v:5}];
 const B=R.avwapBandsFrom(0,d);
 ok(near(B.v[1],100),'two-point mean=100');
 ok(near(B.u1[1],110)&&near(B.l1[1],90),'\u00b11\u03c3 = 90/110');
 ok(near(B.u2[1],120)&&near(B.l2[1],80),'\u00b12\u03c3 = 80/120');}
// vol-weighting: heavy vol on 110 pulls mean up
{const d=[{h:90,l:90,c:90,v:1},{h:110,l:110,c:110,v:9}];
 const B=R.avwapBandsFrom(0,d);ok(near(B.v[1],108),'vol-weighted mean = 108');}
// anchor respected: values before anchor are null
{const d=[];for(let i=0;i<10;i++)d.push({h:1+i,l:1+i,c:1+i,v:1});
 const B=R.avwapBandsFrom(5,d);ok(B.v[4]==null&&B.v[5]!=null,'null before anchor');}

// axis heat: single candle spanning full range fills all buckets evenly -> all 1 after normalize
{const bk=R.axisHeatBuckets([{h:110,l:100,v:60}],100,110,6);
 ok(bk.length===6&&bk.every(v=>near(v,1)),'full-span candle -> uniform heat=1');}
// heat concentrates where candles overlap
{const d=[{h:102,l:100,v:10},{h:102,l:100,v:10},{h:110,l:108,v:10}];
 const bk=R.axisHeatBuckets(d,100,110,10);
 const lowSum=bk.slice(0,2).reduce((a,b)=>a+b,0),highSum=bk.slice(8,10).reduce((a,b)=>a+b,0);
 ok(lowSum>highSum,'double-traded zone hotter ('+lowSum.toFixed(2)+'>'+highSum.toFixed(2)+')');}
// degenerate range: safe zeros
ok(R.axisHeatBuckets([{h:5,l:4,v:1}],10,10,8).every(v=>v===0),'degenerate lo==hi -> zeros, no crash');

// templates: save -> list -> apply (deep copy) -> delete
{ok(R.saveDrawTemplate('setupA',[{type:'hline',price:1.1},{type:'trend',a:{bar:1,price:1},b:{bar:9,price:2}}]),'save ok');
 const ls=R.listDrawTemplates();ok(ls.length===1&&ls[0].name==='setupA'&&ls[0].n===2,'list shows saved (n=2)');
 const items=R.applyDrawTemplate('setupA');ok(items.length===2,'apply returns items');
 items[0].price=999;const again=R.applyDrawTemplate('setupA');ok(again[0].price===1.1,'apply is a deep copy (no mutation leak)');
 ok(R.applyDrawTemplate('nope')===null,'missing template -> null');
 ok(R.deleteDrawTemplate('setupA')&&R.listDrawTemplates().length===0,'delete works');
 ok(!R.saveDrawTemplate('',[]),'empty name refused');}

console.log(`\nv15.1 CHARTING TESTS: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
