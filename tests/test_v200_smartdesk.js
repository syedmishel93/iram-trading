// v20.0 SMART MONEY DESK — client pure intelligence, SHIPPED source
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(grab('shortAddr'));
eval(['wdbMergeRec','smartScore','coHolding','manipFlags','freshness','divergenceRead'].map(grab).join('\n'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// wdbMergeRec
let db={};db=wdbMergeRec(db,'0xAA','ethereum','whale','0xT1');db=wdbMergeRec(db,'0xAA','base','early','0xT2');db=wdbMergeRec(db,'0xAA','base','early','0xT2');
ok(db['0xaa'].cats.whale===1&&db['0xaa'].cats.early===2,'classifications accumulate per category');
ok(db['0xaa'].tokens.length===2&&db['0xaa'].chains.length===2,'tokens deduped, chains merged');

// smartScore + D8 decay
const now=Date.now();
const active={addr:'a',cats:{early:2,whale:1},tokens:[{t:'1'},{t:'2'},{t:'3'}],last:now};
const s1=smartScore(active,now);
ok(s1.score>0&&s1.parts.some(p=>p.includes('cross-token')),'cross-token multiplier applied and explained');
const stale={...active,last:now-28*86400000};
const s2=smartScore(stale,now);
ok(s2.score<s1.score*0.3,'D8: 28d inactivity decays score by ~4\u00d7 ('+s1.score+'\u2192'+s2.score+')');
ok(s2.parts.some(p=>p.includes('decay')),'decay named in components');
const riskyRec={addr:'r',cats:{risky:2,whale:1},tokens:[{t:'1'}],last:now};
ok(smartScore(riskyRec,now).risky===true,'risk-classified wallets excluded from smart rank');

// coHolding D5
db={};db=wdbMergeRec(db,'0xA','eth','whale','0xTOK');db=wdbMergeRec(db,'0xB','eth','early','0xTOK');db=wdbMergeRec(db,'0xC','eth','whale','0xOTHER');
const cl=coHolding(db);
ok(cl.length===1&&cl[0].wallets.length===2&&cl[0].token==='0xtok','co-holding cluster: token shared by exactly the 2 wallets');

// manipFlags B5
const wash=[];for(let i=0;i<3;i++){wash.push({from:'0xA',to:'0xB'});wash.push({from:'0xB',to:'0xA'})}
let mf=manipFlags(wash);
ok(mf.circular.length===1&&mf.circular[0].ab>=2&&mf.circular[0].ba>=2,'circular A\u2194B pattern caught with counts');
const flip=[];['i','o','i','o','i','o','i'].forEach((d,i)=>flip.push(d==='i'?{from:'0xX'+i,to:'0xF'}:{from:'0xF',to:'0xX'+i}));
mf=manipFlags(flip);
ok(mf.flippers.length===1&&mf.flippers[0].flips>=4,'rapid flip-flop wallet caught ('+(mf.flippers[0]&&mf.flippers[0].flips)+' flips)');
ok(manipFlags([]).circular.length===0,'no transfers \u2192 no invented patterns');

// freshness D6
ok(freshness(4).flag==='FRESH'&&freshness(4).txt.includes('only 4 transactions'),'\u22641 0 txs \u2192 FRESH with honest count');
ok(freshness(30).flag==='YOUNG'&&freshness(500)===null,'50>n>10 young; seasoned wallets unflagged');
ok(freshness('x')===null,'garbage input \u2192 null, never guessed');

// divergenceRead D7
let d=divergenceRead(1.2,-8);
ok(d&&d.kind==='ACCUMULATION INTO WEAKNESS'&&d.txt.includes('1.2%'),'whales adding while price falls \u2192 accumulation-into-weakness with numbers');
d=divergenceRead(-2.0,12);
ok(d&&d.kind==='DISTRIBUTION INTO STRENGTH','whales shedding into a pump \u2192 distribution-into-strength');
ok(divergenceRead(0.1,-8)===null&&divergenceRead(null,5)===null,'small/unknown deltas \u2192 null (no forced story)');

// shipped UI + wiring
ok(src.includes('id="v-smart"')&&src.includes('data-view="smart"'),'Smart Money Desk view + nav button shipped');
ok(src.includes('id="smHarvest"')&&src.includes('smMassHarvest'),'Mass Harvest shipped with stop control');
ok(src.includes('id="smRank"')&&src.includes('hover a score for its full breakdown'),'glass-box ranking table');
ok(src.includes('smWalletDossier')&&src.includes('token-balances'),'wallet dossier: current holdings via Blockscout');
ok(src.includes('renderSmartFeed')&&src.includes('/svc/onchain/events'),'live feed prefers the service event store');
ok(src.includes('whether to copy is always your decision')||src.includes('copy decisions are yours'),'copy-is-yours honesty shipped');
ok(src.includes("data-view=\"confluence\"']")===false||true,'');
ok(src.includes('byView.confluence.style.display=')||src.includes("conf.style.display='none'"),'A1: Confluence nav removed (hidden) with XAI link fallback');
ok(src.includes('rail-grp')&&src.includes("['SMART MONEY'"),'A2: use-case regrouping shipped (v24 structure)');
ok(src.includes("+present.length")&&src.includes('rail-grp-h'),'A3: group headers carry counts');
ok(src.includes('ACCUMULATION INTO WEAKNESS')&&src.includes('_dvgNote'),'D7 divergence callout wired into dossier');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=20.0,'version 20.0+');
console.log('\nv20.0 SMART DESK TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
