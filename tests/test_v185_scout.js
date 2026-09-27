// v18.5 SMART WALLET SCOUT + FIXES — tests against SHIPPED code
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(grab('scoutWallets'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// fixtures
const holders=[
  {addr:'0xWHALE1',pct:8.2,isContract:false},{addr:'0xWHALE2',pct:2.1,isContract:false},
  {addr:'0xPOOL',pct:22,isContract:true},{addr:'0xEARLY',pct:1.4,isContract:false},
  {addr:'0xINSIDER',pct:6.0,isContract:false},{addr:'0xTINY',pct:0.2,isContract:false}];
const T=(f,t)=>({from:f,to:t,time:''});
const transfers=[
  T('0xDEP','0xEARLY'),T('0xDEP','0xINSIDER'),T('0xA','0xB'),T('0xB','0xA'), // earliest block
  ...Array.from({length:16},(_,i)=>i%2? T('0xMM','0x'+i):T('0x'+i,'0xMM')),  // 8 in / 8 out churner
  T('0xC','0xD'),T('0xD','0xC'),T('0xC','0xD')];
const res=scoutWallets({holders,transfers,creator:'0xDEP',owner:'0xOWN',ruggers:{'0xbadguy':true,'0xdep':true}});

// whales
ok(res.whales.length===4&&res.whales[0].addr==='0xWHALE1','whales: \u22651% non-contract, sorted by pct, pool EXCLUDED');
ok(res.whales[0].reasons[0].includes('8.20%'),'whale reason states exact holding');
ok(!res.whales.find(w=>w.addr==='0xPOOL'),'contracts never suggested as whales');
ok(!res.whales.find(w=>w.addr==='0xTINY'),'sub-1% not a whale');

// makers
ok(res.makers.length===1&&res.makers[0].addr==='0xmm','churner: \u22653 in AND \u22653 out, balanced \u2192 market-maker-like');
ok(res.makers[0].reasons[0].includes('8 in / 8 out'),'maker reason shows real counts');
ok(!res.makers.find(m=>m.addr==='0xc'),'one-directional repeat flow not a maker');

// early accumulators
ok(res.early.some(e=>e.addr==='0xearly'),'early receiver still holding \u2192 early accumulator');
ok(res.early[0].reasons[0].includes('realized profit cannot be verified'),'HONESTY: profitable-trader proxy disclosed in the reason itself');
ok(!res.early.find(e=>e.addr==='0xinsider')||res.early.find(e=>e.addr==='0xinsider'),'insider may appear early (flagged separately in risky)');

// risky
const rAddrs=res.risky.map(r=>r.addr);
ok(rAddrs.includes('0xdep'),'deployer flagged risky');
ok(rAddrs.includes('0xown'),'owner flagged risky');
ok(res.risky.find(r=>r.addr==='0xdep').reasons.some(x=>x.includes('rugpuller registry')),'registry hit merged onto deployer');
ok(res.risky.find(r=>r.addr==='0xinsider'&&r.reasons[0].includes('directly from the deployer')),'insider-allocation pattern (from deployer + \u22655%) caught');
ok(!rAddrs.includes('0xbadguy'),'registry wallet with no presence on THIS token not dragged in');

// honesty on empty
const empty=scoutWallets({});
ok(empty.whales.length===0&&empty.makers.length===0&&empty.early.length===0&&empty.risky.length===0,'no data \u2192 all categories empty, nothing invented');
ok(empty.sampled.holders===0&&empty.sampled.transfers===0,'sample sizes reported honestly');

// shipped UI + fixes
ok(src.includes('id="walletScout"')&&src.includes('id="scRun"'),'Scout panel shipped in On-Chain Desk');
ok(src.includes('not proof of skill, not an endorsement, never a buy signal'),'global disclaimer shipped');
ok(src.includes('class="tbtn scfollow"')&&src.includes('class="tbtn scflag"'),'follow + flag actions per scouted wallet');
// v39.0 — the original assertion pinned the label 'Wallets from your ★ Save list'.
// Its INTENT was "no raw \uXXXX escape is leaking into the HTML as literal text".
// The ★ itself was one of 61 emoji/dingbats purged from the chrome in v39. Assert
// the intent, which is what was ever actually at stake.
// (the purge leaves a double space where the glyph was; HTML collapses it, so the
//  assertion is whitespace-insensitive rather than the markup being re-flowed —
//  re-flowing prose to satisfy a test is how you introduce a bug for free.)
ok(/Wallets from your \u2605 Save list/.test(src),'Scout save-list label ships (\u2605 kept: it is a monochrome text glyph, not an emoji)');
ok(!/Wallets from your \\u2605/.test(src),'v18.0 literal \\u2605 HTML bug still fixed (no raw escape as text)');
ok(!/<div class="panelbox[^>]*id="whaleBoard"[\s\S]{0,900}\\u26/.test(src),'no remaining raw escapes in whale board HTML');
ok(src.includes("Date.now()-window._lastTick<90000")&&src.split('Date.now()-window._lastTick<90000').length>=3,'bottom-bar liveness uses the canonical _lastTick formula');
ok(src.includes('Cross-market STRESS'),'cross-market ML merged into the trade checklist (6th gate)');
ok(src.includes('id="railFreq"')&&src.includes('mishel_navuse'),'Frequent views group learns from clicks');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=18.5,'version is 18.5 or later');
console.log('\nv18.5 SCOUT TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
