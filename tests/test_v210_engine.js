// v21.0 SMART MONEY ENGINE — pure ML, SHIPPED source
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
// localStorage shim for nick fns
global.localStorage={_d:{},getItem(k){return this._d[k]||null},setItem(k,v){this._d[k]=v},removeItem(k){delete this._d[k]}};
global.STORE={set:(k,v)=>{localStorage.setItem(k,v);return v},get:k=>localStorage.getItem(k),durable:()=>true,flushNow(){},hydrate(){}};  /* v35.0: STORE is a browser global now (durable keys mirror to SQLite) */
function grabConst(name){const i=src.indexOf('function wdbLoad(');const j=src.indexOf('function wdbSave(');return src.slice(i,src.indexOf('}',j)+1)}
eval(grab('wdbLoad')+'\n'+grab('wdbSave'));
eval(['walletIntel','clusterDetect','profitProxy','tokenSmartMoney','wdbExportCSV','wdbImportCSV','walletNick','setWalletNick'].map(grab).join('\n'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};
const now=Date.now();

// P1 walletIntel — tiers + composite
const star={addr:'s',cats:{early:3,whale:1},tokens:[{t:'1'},{t:'2'},{t:'3'},{t:'4'}],flags:[],last:now};
let iv=walletIntel(star,{now,coHoldCount:1});
ok(iv.score>=75&&iv.tier==='S','multi-token early accumulator \u2192 S tier ('+iv.score+')');
ok(iv.conf===100,'4 distinct tokens \u2192 100% confidence');
ok(iv.parts.some(p=>p.includes('early-accumulator')),'components fully listed (glass box)');
const weak={addr:'w',cats:{whale:1},tokens:[{t:'1'}],flags:[],last:now};
ok(walletIntel(weak,{now}).tier!=='S'&&walletIntel(weak,{now}).conf<100,'single-token whale \u2192 lower tier + confidence (P12)');
const bad={addr:'b',cats:{early:2,risky:1},tokens:[{t:'1'}],flags:['circular \u2194 0xabc'],last:now};
iv=walletIntel(bad,{now});
ok(iv.score<=25&&iv.tier==='D','risky/flagged wallet capped at \u226425, D tier');
const stale={...star,last:now-30*86400000};
ok(walletIntel(stale,{now}).score<walletIntel(star,{now,coHoldCount:1}).score,'30d inactivity decays intel score (D8)');

// P6 cluster
const db={'0xa':{addr:'0xa',flags:['circular \u2194 0xb\u2026 (2/2)']},'0xb':{addr:'0xb',flags:['circular \u2194 0xa\u2026 (2/2)']},'0xc':{addr:'0xc',flags:[]}};
const cl=clusterDetect(db);
ok(cl.length===1&&cl[0].n===2&&cl[0].wallets.includes('0xa')&&cl[0].wallets.includes('0xb'),'circular pair grouped into one Sybil cluster');

// P7 profit proxy
const evs=[{token:'0xt',sym:'PEPE',direction:'BUY',t:1},{token:'0xt',sym:'PEPE',direction:'SELL',t:2},
  {token:'0xt',sym:'PEPE',direction:'BUY',t:3},{token:'0xt',sym:'PEPE',direction:'SELL',t:4},
  {token:'0xu',sym:'WIF',direction:'BUY',t:1}];
const pp=profitProxy(evs);
ok(pp.roundtrips===2&&pp.tokens===1,'2 buy\u2192sell round-trips on one token counted; open position not counted');
ok(profitProxy([]).roundtrips===0,'no events \u2192 0 (no fake PnL)');

// P5 token-centric
const db2={'0xw1':{addr:'0xw1',cats:{early:2},tokens:[{t:'0xtok'}],last:now},'0xw2':{addr:'0xw2',cats:{whale:1},tokens:[{t:'0xtok'}],last:now},'0xw3':{addr:'0xw3',cats:{early:1},tokens:[{t:'0xother'}],last:now}};
const tsm=tokenSmartMoney(db2,'0xTOK');
ok(tsm.length===2&&tsm[0].intel.score>=tsm[1].intel.score,'token view: only wallets in that token, ranked by intel');

// P8 CSV
const csv=wdbExportCSV(db2);
ok(csv.split('\n').length===4&&csv.includes('wallet')&&csv.includes('tier'),'CSV export: header + one row per wallet');
localStorage._d={};let ndb={};wdbSave(ndb);
const added=wdbImportCSV('0x1111111111111111111111111111111111111111\nFt6MwN1111111111111111111111111111111111111\ngarbage');
ok(added===2,'CSV import seeds 2 valid addresses (EVM + Solana), rejects garbage');

// D1 nicknames
setWalletNick('0xAA','Insider #1','watched since launch');
ok(walletNick('0xaa').nick==='Insider #1'&&walletNick('0xaa').note==='watched since launch','nickname + note persist');

// X1/X2 shipped
ok(src.includes("chain==='solana'")&&src.includes('/api/v1/solana/token_security'),'X1: Solana holder fetch via GoPlus solana endpoint');
ok(src.includes('function scoutChainOK')&&src.includes("chain==='solana'"),'X2: harvest accepts Solana');
ok(src.includes('non-scannable rows skipped'),'X2: honest skipped-count message');
console.log('\nv21.0 ENGINE TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
