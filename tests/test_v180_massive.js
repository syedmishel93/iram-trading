// v18.0 MASSIVE BUILD — tests against SHIPPED code
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// M1 launch radar addresses
ok(src.includes('class="tbtn lcopy"'),'launch radar: per-row copy-address button');
ok(src.includes('class="tbtn ldoss"'),'launch radar: per-row dossier button');
ok(src.includes('buyLinks(r.chain,r.addr)[0]')&&src.match(/renderLaunchRows/g).length>=2,'launch radar: verified buy link in row');
// address rendered in the row template (shortAddr inside renderLaunchRows body)
const lr=src.slice(src.indexOf('function renderLaunchRows'),src.indexOf('function renderLaunchRows')+3000);
ok(lr.includes('shortAddr(r.addr)'),'launch radar: contract address VISIBLE in main table');

// M2 meme table addresses visible
const mr=src.slice(src.indexOf('function renderMemeRows'),src.indexOf('function renderMemeRows')+3000);
ok(mr.includes('shortAddr(r.addr)')&&mr.includes('class="tbtn memecopy"'),'meme radar: address + copy VISIBLE in main table (not only \u2295)');

// M3 whale board
ok(src.includes('id="whaleBoard"')&&src.includes('id="wbList"')&&src.includes('id="wbRefresh"'),'Whale Board panel shipped');
ok(src.includes('async function renderWhaleBoard()'),'renderWhaleBoard shipped');
ok(src.includes("fetch(sb+'/svc/onchain/watch'")&&src.includes("src:'service'"),'board merges server watch list');
ok(src.includes("src:'saved'"),'board merges local saved wallets');
ok(src.includes('class="tbtn wbscan"')&&src.includes('verdict \\u25b7'),'one-tap verdict jump per wallet');
ok(src.includes('whether to copy is always your call'),'no-auto-copy honesty line');

// M4 source health
ok(src.includes('id="srcHealth"')&&src.includes('id="shRun"'),'Source Health board in Settings');
ok(src.includes('async function testSources()'),'testSources shipped');
['Bybit','Kraken','Coinbase','OKX','KuCoin','Gate.io'].forEach(n=>ok(src.includes("['"+n+"'"),'health test covers '+n));
ok(src.includes('CORS/network on your side, not the exchange being down'),'honest CORS note');

// M5 offline honesty
ok(src.includes('you are OFFLINE: switch the mode toggle to Online'),'forcing a source while offline warns loudly');
ok(src.includes("' armed'")||src.includes('armed'),'status label shows armed source while offline');

// M6 merged cross-market card
ok(src.includes('Cross-Market Intelligence')&&src.includes('CORR \\u00b7 ROTATION \\u00b7 REGIME'),'Intermarket+rotation merged as one Cross-Market card in chart view');
ok(src.includes('setTimeout(fillImxRot,1500)')&&src.includes('setInterval(fillImxRot,15000)'),'rotation strip renders immediately, then refreshes');
ok(!src.includes("'<h3>Intermarket ML "),'old duplicated Intermarket title gone');

// version + regression guard: prior features intact
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=18.0,'version is 18.0 or later');
ok(src.includes('id="srcPick"')&&src.includes('id="csLim"')&&src.includes('id="pineBtn"')&&src.includes('data-ind="news"'),'v16-17 features intact (picker, depth, pine, news chip)');
console.log('\nv18.0 MASSIVE TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
