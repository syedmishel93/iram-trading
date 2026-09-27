// v15.2 — SHIPPED-source tests: whale numbers, wallet flow, rugger registry, dossier verdict.
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){let m=html.match(new RegExp('\\nfunction '+name+'\\('));if(!m)throw new Error('missing '+name);
  let i=m.index+1,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}return html.slice(i,k+1)}
const store={};const localStorage={getItem:k=>store[k]||null,setItem:(k,v)=>{store[k]=String(v)}};
const STORE={set:(k,v)=>{localStorage.setItem(k,v);return v},get:k=>localStorage.getItem(k),durable:()=>true,flushNow(){},hydrate(){}};  /* v35.0: STORE is a browser global now (durable keys mirror to SQLite) */
const src=['whaleStats','walletFlow','loadRuggers','saveRuggers','markRugger','flagRugger','unmarkRugger','dossierVerdict'].map(grab).join('\n');
const R=new Function('localStorage','STORE',src+'\nreturn {whaleStats,walletFlow,markRugger,flagRugger,unmarkRugger,loadRuggers,dossierVerdict};')(localStorage,STORE);
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};

// whaleStats known answers
{const rows=[{addr:'a',pct:15,isContract:false,locked:false},{addr:'b',pct:5,isContract:false,locked:false},
  {addr:'c',pct:4,isContract:true,locked:false},{addr:'d',pct:0.5,isContract:false,locked:false},{addr:'e',pct:2,isContract:false,locked:true}];
 const w=R.whaleStats(rows,1000);
 ok(w.whaleCount===2,'whales = 2 (contracts+locked excluded), got '+w.whaleCount);
 ok(w.whalePct===20,'whales hold 20%');
 ok(w.top1===15&&w.top10===26.5,'top1=15, top10=26.5');
 ok(w.contractPct===4,'contract share 4%');
 ok(w.risk==='HIGH','top1 15% -> HIGH risk, got '+w.risk);
 ok(w.holderCount===1000,'holder count passthrough');}
{ok(R.whaleStats([{addr:'x',pct:25,isContract:false,locked:false}]).risk==='EXTREME','top1 25% -> EXTREME');
 ok(R.whaleStats([{addr:'x',pct:2,isContract:false,locked:false}]).risk==='LOW','spread -> LOW');
 ok(R.whaleStats([]).whaleCount===0,'empty rows safe');}

// walletFlow verdicts
{const fl=R.walletFlow([{tok:'PEPE',dir:'in',amt:100},{tok:'PEPE',dir:'out',amt:10},
  {tok:'WIF',dir:'out',amt:80},{tok:'WIF',dir:'in',amt:5},
  {tok:'ARB',dir:'in',amt:50},{tok:'ARB',dir:'out',amt:50}]);
 const g=t=>fl.find(x=>x.tok===t);
 ok(g('PEPE').verdict==='ACCUMULATING','PEPE accumulating');
 ok(g('WIF').verdict==='DISTRIBUTING','WIF distributing');
 ok(g('ARB').verdict==='CHURNING','ARB churning (net~0)');
 ok(fl[0].tok==='PEPE'||fl[0].tok==='WIF','sorted by |net|');
 ok(R.walletFlow([]).length===0,'empty transfers safe');
 ok(R.walletFlow([{tok:'X',dir:'in',amt:'nan'}]).length===0,'non-finite amounts dropped');}

// rugger registry lifecycle
{const e=R.markRugger('0xDEPLOYER1','base','0xTOKA','note');
 ok(e&&e.addr==='0xdeployer1','marked lowercased');
 R.markRugger('0xDEPLOYER1','ethereum','0xTOKB');
 const L=R.loadRuggers();ok(L.length===1&&L[0].tokens.length===2&&L[0].chains.length===2,'dedup merges chains+tokens');
 ok(R.flagRugger('0xdeployer1','')!==null,'flag by creator');
 ok(R.flagRugger('','0xDEPLOYER1')!==null,'flag by owner (case-insens)');
 ok(R.flagRugger('0xclean','0xclean2')===null,'clean deployer not flagged');
 ok(R.markRugger('short')===null,'too-short address refused');
 ok(R.unmarkRugger('0xdeployer1')&&R.loadRuggers().length===0,'unmark removes');}

// dossier verdict grading
{const v=R.dossierVerdict({liq:200000,ageH:400},{honeypot:false,buyTax:1,sellTax:1,lpLocked:95,mintable:false,openSource:true},{risk:'LOW',top10:18,whaleCount:3,whalePct:9});
 ok(v.grade==='NO RED FLAGS FOUND'&&v.cls==='bull','clean token -> no red flags');
 ok(v.good.length>=2,'good list populated');}
{const v=R.dossierVerdict({liq:5000,ageH:3},{honeypot:true,buyTax:0,sellTax:0,lpLocked:null,mintable:true,openSource:false},{risk:'EXTREME',top10:80,whaleCount:1,whalePct:40});
 ok(v.grade==='AVOID','honeypot -> AVOID (hard flag)');
 ok(v.flags.some(f=>/HONEYPOT/.test(f)),'honeypot named');}
{R.dossierVerdict._rugger={tokens:['a','b']};
 const v=R.dossierVerdict(null,null,null);R.dossierVerdict._rugger=null;
 ok(v.grade==='AVOID'&&v.flags.some(f=>/DEPLOYER PREVIOUSLY RUGGED/.test(f)),'known rugger -> AVOID even with no other data');}
{const v=R.dossierVerdict({liq:15000,ageH:10},{honeypot:false,buyTax:2,sellTax:9,lpLocked:50,mintable:false,openSource:true},{risk:'ELEVATED',top10:35,whaleCount:2,whalePct:6});
 ok(v.grade==='HIGH RISK'||v.grade==='CAUTION','moderate flags -> caution band, got '+v.grade);}

console.log(`\nv15.2 ON-CHAIN TESTS: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
