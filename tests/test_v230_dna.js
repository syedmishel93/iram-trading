// v23.0 WALLET DNA ENGINE — pure ML, SHIPPED source
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(['_hoursBetween','dnaHoldTime','dnaStyle','dnaConsistency','dnaAffinity','dnaTiming','dnaRisk','walletDNA'].map(grab).join('\n'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};
const H=3600000,now=Date.now();
const ev=(dir,token,tHoursAgo)=>({direction:dir,token,t:now-tHoursAgo*H});

// hold time
let hts=dnaHoldTime([ev('BUY','A',10),ev('SELL','A',9.6),ev('BUY','B',5),ev('SELL','B',4.7)]);
ok(hts&&hts.n===2&&hts.medianHours<1&&hts.band.includes('scalper'),'hold time: two <1h round-trips \u2192 scalper band');
ok(dnaHoldTime([ev('BUY','A',1)])===null,'open position only \u2192 null hold time');

// style: BOT (uniform intervals)
const botEv=[];for(let i=0;i<8;i++)botEv.push(ev(i%2?'SELL':'BUY','T'+i,100-i*10));
let st=dnaStyle(botEv,now);
ok(st.style==='BOT'&&st.why.includes('CV'),'uniform intervals \u2192 BOT');
// SNIPER (fast flips)
st=dnaStyle([ev('BUY','A',10),ev('SELL','A',9.8),ev('BUY','B',5),ev('SELL','B',4.9),ev('BUY','C',2),ev('SELL','C',1.9)],now);
ok(st.style==='SNIPER','sub-1h median holds \u2192 SNIPER');
// ACCUMULATOR
st=dnaStyle([ev('BUY','A',10),ev('BUY','B',8),ev('BUY','C',6),ev('SELL','D',2)],now);
ok(st.style==='ACCUMULATOR','75%+ buys \u2192 ACCUMULATOR');
// DUMPER
st=dnaStyle([ev('SELL','A',10),ev('SELL','B',8),ev('SELL','C',6),ev('BUY','D',2)],now);
ok(st.style==='DUMPER','75%+ sells \u2192 DUMPER');
ok(dnaStyle([ev('BUY','A',1)],now).style==='UNKNOWN','<3 transfers \u2192 UNKNOWN (honest)');

// consistency: repeated same-band = high
const consist=[];for(let i=0;i<5;i++){consist.push(ev('BUY','T'+i,100-i*10));consist.push(ev('SELL','T'+i,99.5-i*10))}
let cs=dnaConsistency(consist);
ok(cs.score>=70,'all round-trips same hold-band \u2192 high consistency ('+cs.score+')');
const erratic=[ev('BUY','A',100),ev('SELL','A',99.5),ev('BUY','B',50),ev('SELL','B',20),ev('BUY','C',10),ev('SELL','C',0.5)];
ok(dnaConsistency(erratic).score<dnaConsistency(consist).score,'mixed hold-bands \u2192 lower consistency');

// affinity
let af=dnaAffinity([{sym:'PEPE'},{sym:'WIF'},{sym:'BONK'},{sym:'USDC'}]);
ok(af.profile==='meme'&&af.pct===75,'3 memes + 1 stable \u2192 meme profile 75%');
ok(dnaAffinity([])===null,'no holdings \u2192 null affinity');

// timing
let tm=dnaTiming([{t:Date.UTC(2026,0,1,14)},{t:Date.UTC(2026,0,2,15)},{t:Date.UTC(2026,0,3,14)}]);
ok(tm&&tm.peakHourUTC===14&&tm.session==='New York','peak 14:00 UTC \u2192 New York session');

// risk
ok(dnaRisk({cats:{risky:2},flags:['x']}).band==='RECKLESS','risky+flags \u2192 RECKLESS');
ok(dnaRisk({cats:{}}).band==='DISCIPLINED','clean wallet \u2192 DISCIPLINED');

// role assembly
let d=walletDNA({events:consist,holdings:[{sym:'PEPE'}],rec:{cats:{early:2}},roundtrips:0,now});
ok(d.role&&d.roleWhy&&d.style&&d.consistency&&d.affinity&&d.timing&&d.risk,'walletDNA assembles all 6 DNA facets + role');
d=walletDNA({events:consist,rec:{cats:{risky:1}},now});
ok(d.role==='RUGGER / INSIDER','risk wallet \u2192 RUGGER/INSIDER role (avoid copying)');
d=walletDNA({events:consist,rec:{cats:{whale:1}},roundtrips:3,now});
ok(d.role==='WINNER (proxy)'&&d.roleWhy.includes('not verified profit'),'round-trips \u2192 WINNER proxy, honesty in the reason');

// shipped
ok(src.includes('function walletDNA('),'walletDNA shipped');
console.log('\nv23.0 DNA TESTS: '+P+' passed, '+F+' failed');global.__dnaFail=F;

// --- power features (D2/D3/D4) appended ---
(function(){
const src2=require('fs').readFileSync(__dirname+'/../index.html','utf8');
function grab2(name){const i=src2.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src2.length;j++){const c=src2[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src2.slice(i,j)}
global.localStorage=global.localStorage||{_d:{},getItem(k){return this._d[k]||null},setItem(k,v){this._d[k]=v}};
eval(grab2('walletIntel')+'\n'+grab2('smartMomentum')+'\n'+grab2('earlyEntryRadar')+'\n'+grab2('walletCompare'));
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};
const now=Date.now();
const db={
  '0xa':{addr:'0xa',cats:{early:3,whale:1},tokens:[{t:'0xtok',chain:'ethereum'},{t:'0xt2'},{t:'0xt3'},{t:'0xt4'}],flags:[],last:now},
  '0xb':{addr:'0xb',cats:{early:3,whale:1},tokens:[{t:'0xtok',chain:'ethereum'},{t:'0xt5'},{t:'0xt6'},{t:'0xt7'}],flags:[],last:now},
  '0xc':{addr:'0xc',cats:{risky:2},tokens:[{t:'0xtok'}],flags:['circular \u2194 0xd'],last:now}};
const m=smartMomentum(db,now);
ok(['RISK-ON','NEUTRAL','RISK-OFF'].includes(m.band)&&m.n===2,'D3 momentum: risk wallet excluded, band computed');
const er=earlyEntryRadar(db,now);
ok(er.length===1&&er[0].wallets.length===2&&er[0].token==='0xtok','D4 early radar: token with 2 top-tier wallets surfaced (risk wallet excluded)');
const cmp=walletCompare(db,'0xa','0xb');
ok(cmp&&cmp.a.intel&&cmp.b.intel&&cmp.a.tokens===4,'D2 compare: two wallets side by side with intel');
ok(walletCompare(db,'0xa','0xNOPE')===null,'compare with unknown wallet \u2192 null');
// shipped panels + telegram
ok(src2.includes('id="smMomentum"')&&src2.includes('id="smEarly"'),'momentum + early-radar panels shipped');
ok(src2.includes('DNA sent to Telegram')&&src2.includes('dna:dnaSnap'),'track = subscribe: DNA snapshot sent on tracking');
ok(src2.includes('\\u{1F9EC}')&&src2.includes('Median hold')&&src2.includes('Risk DNA'),'DNA dashboard rendered in wallet dossier');
console.log('\nv23.0 POWER TESTS: '+p+' passed, '+f+' failed');
if(f)process.exit(1);
})();
