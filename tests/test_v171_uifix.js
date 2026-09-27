// v17.1 UI FIX PACK — tests against SHIPPED code
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(grab('explorerUrl'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// explorerUrl: chain-correct, honest null for unknown
ok(explorerUrl('ethereum','0xAB')==='https://etherscan.io/address/0xAB','ethereum \u2192 etherscan');
ok(explorerUrl('bsc','0xAB')==='https://bscscan.com/address/0xAB','bsc \u2192 bscscan');
ok(explorerUrl('base','0xAB').includes('basescan.org'),'base \u2192 basescan');
ok(explorerUrl('solana','So1')==='https://solscan.io/account/So1','solana uses /account/ path');
ok(explorerUrl('arbitrum','0x1').includes('arbiscan'),'arbitrum \u2192 arbiscan');
ok(explorerUrl('weird','0x1')===null,'unknown chain \u2192 null (never a wrong-chain link)');
ok(explorerUrl('ethereum','')===null,'no address \u2192 null');

// topbar regression removed; picker now lives in status bar
ok(!src.includes('id="srcWrap"'),'crowded topbar SRC pill REMOVED');
// v39.0 — this used to pin the literal tag `<div class="status">` and a 1200-char
// window. The status bar grew a role/aria-live and three clusters, and the pin went
// red for a change that did not touch what this test is actually about. Same class
// as the pinned-schema-version trap: assert the INTENT (the picker lives in the
// status bar, not the crowded top bar), not the byte offsets.
const statusIdx=src.indexOf('<div class="status"');
const statusEnd=src.indexOf('</div>\n</div>',statusIdx);
const pickIdx=src.indexOf('id="srcPick"');
ok(statusIdx>0&&pickIdx>statusIdx&&(statusEnd<0||pickIdx<statusEnd),'srcPick relocated inside bottom status bar');
ok(src.includes('.rail:hover .rail-search{display:block}'),'rail search visible on hover (not only pinned)');

// whale wallet addresses: copy + follow + per-chain explorer in holder table
ok(src.includes('class="tbtn whcopy"'),'per-holder copy-address button shipped');
ok(src.includes('class="tbtn whfollow"'),'per-holder \u2605 follow button shipped');
ok(src.includes("'/svc/onchain/watch'")&&src.includes('min_usd:10000'),'follow registers server whale-alert watch');
ok(src.includes('start mishel_service for Telegram whale alerts'),'honest offline-service toast');
ok(!src.includes('https://etherscan.io/address/${_memeEsc(h.addr)}'),'hardcoded-etherscan holder link replaced by chain-aware explorerUrl');

// opportunity scanner depth
ok(src.includes('id="csLim"')&&src.includes('<option selected>15</option>'),'scanner depth selector (8/15/25/40, default 15)');
ok(!src.includes('var cand=u.slice(0,8);'),'hard 8-coin cap removed');
ok(src.includes('u.slice(0,lim)'),'slice driven by selector');

// meme radar sources merged
ok(src.match(/token-profiles\/latest\/v1/g).length>=2,'profiles feed merged into radar scan (in addition to new-pairs panel)');
ok(src.includes('boosts=boosts.slice(0,60)'),'radar cap raised to 60 merged tokens');
ok(src.includes('boosts + profiles feeds merged'),'honest source note in result message');

// rotation strip in intermarket card
ok(src.includes('id="imxRot"'),'rotation strip div inside Intermarket ML card');
ok(src.includes('ROTATION vs '),'rotation one-liner renders leading/lagging');
ok(src.includes('open \\u22653 symbols online')||src.includes('open \u22653 symbols online'),'honest empty state for rotation strip');

// version
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=17.1,'version is 17.1 or later');
console.log('\nv17.1 UI FIX TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
