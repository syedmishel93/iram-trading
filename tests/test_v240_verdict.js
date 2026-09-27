// v24.0 VERDICT ENGINE — pure decision logic, SHIPPED source
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
global.localStorage=global.localStorage||{_d:{},getItem(k){return this._d[k]||null},setItem(k,v){this._d[k]=v}};
global.STORE={set:(k,v)=>{localStorage.setItem(k,v);return v},get:k=>localStorage.getItem(k),durable:()=>true,flushNow(){},hydrate(){}};  /* v35.0: STORE is a browser global now (durable keys mirror to SQLite) */
eval(grab('shortAddrSafe')+'\n'+grab('walletIntel')+'\n'+grab('tokenVerdict')+'\n'+grab('walletCopyability')+'\n'+grab('feedRead'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// tokenVerdict — AVOID (thin + rug)
let v=tokenVerdict({liq:5000,vol24:50000,chg24:200,buys:400,sells:230,ageDays:0.5,rug:'Elevated 40'});
ok(v.stance==='AVOID','thin liquidity + elevated rug \u2192 AVOID');
ok(v.flags.some(f=>f.includes('thin')),'F5: names the liquidity red flag');
ok(v.confidence,'F4: confidence label present');
// WATCH (smart money + buy pressure + healthy liq)
v=tokenVerdict({liq:80000,vol24:120000,chg24:30,buys:900,sells:300,ageDays:5,rug:'Lower 0',smartCount:3,smartTier:'S/A'});
ok(v.stance==='WATCH','healthy liq + 3 smart wallets + buy pressure \u2192 WATCH');
ok(v.pros.some(p=>p.includes('smart wallets')),'credits smart-money presence');
ok(v.conviction>=60,'WATCH conviction \u226560 ('+v.conviction+')');
// RESEARCH (mixed)
v=tokenVerdict({liq:40000,vol24:30000,chg24:-5,buys:500,sells:480,ageDays:10,rug:'Lower 0'});
ok(v.stance==='RESEARCH','balanced/mixed signals \u2192 RESEARCH');
// regime tightens
let vNormal=tokenVerdict({liq:25000,vol24:20000,buys:300,sells:250,ageDays:3,rug:'Lower 0',smartCount:1});
let vRiskoff=tokenVerdict({liq:25000,vol24:20000,buys:300,sells:250,ageDays:3,rug:'Lower 0',smartCount:1},{momentum:'RISK-OFF'});
ok(vRiskoff.conviction<=vNormal.conviction,'F7: risk-off regime lowers conviction');

// walletCopyability
let cp=walletCopyability({addr:'a',cats:{early:3,whale:1},tokens:[{t:'1'},{t:'2'},{t:'3'},{t:'4'}],flags:[],last:Date.now()},
  {role:'SNIPER',consistency:{score:80},style:{style:'ACCUMULATOR'}},{roundtrips:3,now:Date.now()});
ok(cp.stance==='COPYABLE','S/A tier + consistent + round-trips \u2192 COPYABLE');
ok(cp.pros.length>=2,'lists the copyability evidence');
cp=walletCopyability({addr:'r',cats:{risky:2},tokens:[{t:'1'}],flags:['x'],last:Date.now()},{role:'RUGGER / INSIDER'},{now:Date.now()});
ok(cp.stance==='AVOID'&&cp.cons.length,'risk wallet \u2192 AVOID with reason');
cp=walletCopyability({addr:'u',cats:{whale:1},tokens:[{t:'1'}],flags:[],last:Date.now()},{role:'WHALE'},{now:Date.now()});
ok(['WATCH','UNPROVEN'].includes(cp.stance),'thin single-token wallet \u2192 WATCH/UNPROVEN, not COPYABLE');

// feedRead
let fr=feedRead({dir:'BUY',amt:1000000,sym:'PEPE'},{cats:{whale:1}},{role:'WHALE',style:{style:'ACCUMULATOR'}});
ok(fr.tier==='WHALE'&&fr.dir==='BUY'&&fr.note==='adding','feed interpreted: tier + direction + adding/reducing');
fr=feedRead({dir:'BUY',usd:50000,sym:'X'},{},{style:{style:'BOT'}});
ok(fr.ctxAmt.includes('$50,000')&&fr.note==='mechanical','F6: $ context + BOT flagged as mechanical');

// shipped
ok(src.includes('function buildOpportunities('),'buildOpportunities shipped');
console.log('\nv24.0 VERDICT TESTS: '+P+' passed, '+F+' failed');

// --- opportunities + F2 watchlist-state + reorg (appended) ---
(function(){
const src2=require('fs').readFileSync(__dirname+'/../index.html','utf8');
function g(name){const i=src2.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src2.length;j++){const c=src2[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src2.slice(i,j)}
global.localStorage={_d:{},getItem(k){return this._d[k]||null},setItem(k,v){this._d[k]=v}};
eval(g('shortAddrSafe')+g('walletIntel')+g('tokenVerdict')+g('earlyEntryRadar')+g('tokenSmartMoney')+g('buildOpportunities')+g('pinState')+g('pinSave')+g('pinAdd')+g('pinDiff'));
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};
const now=Date.now();
// opportunities: convergence surfaces
const db={'0xa':{addr:'0xa',cats:{early:3,whale:1},tokens:[{t:'0xtok',chain:'ethereum'},{t:'0xt2'},{t:'0xt3'},{t:'0xt4'}],flags:[],last:now},
  '0xb':{addr:'0xb',cats:{early:3,whale:1},tokens:[{t:'0xtok',chain:'ethereum'},{t:'0xt5'},{t:'0xt6'},{t:'0xt7'}],flags:[],last:now}};
const opps=buildOpportunities(db,[],{now});
ok(opps.length>=1&&opps[0].kind==='convergence'&&opps[0].conviction>0,'opportunities: convergence surfaces with conviction + action');
ok(opps[0].action==='scout'&&opps[0].actionData.addr,'each opportunity has a next-step action');
// F2 pin state
pinAdd('coin','0xTOK',{stance:'RESEARCH',smartCount:1});
let d=pinDiff('coin','0xTOK',{stance:'WATCH',smartCount:3});
ok(d&&d.changes.length===2&&d.changes.some(c=>c.includes('stance')),'F2: pinDiff detects stance + smart-count change since pin');
ok(pinDiff('coin','0xNOPE',{})===null,'F2: unpinned item \u2192 null');
d=pinDiff('coin','0xTOK',{stance:'RESEARCH',smartCount:1});
ok(d.changes.length===0,'F2: no change \u2192 empty diff (no false alarms)');
// reorg shipped
ok(src2.includes("['SMART MONEY',['smart','intel']]")&&src2.includes("['DISCOVER',['insights','screener','onchain','heatmap','news']]"),'left bar reorganized: SMART MONEY + DISCOVER groups');
ok(src2.indexOf("['SMART MONEY'")<src2.indexOf("['DISCOVER'"),'SMART MONEY ordered before DISCOVER');
ok(src2.includes('id="smOpps"')&&src2.includes('Opportunities Now'),'Opportunities Desk panel shipped');
ok(src2.includes('<th>Verdict</th>'),'A1: meme radar gains a Verdict column');
ok(src2.includes('feedRead(e,rc,null)'),'A3: live feed interprets each transfer');
console.log('\nv24.0 DESK/REORG TESTS: '+p+' passed, '+f+' failed');
process.exit((f)?1:0);
})();
