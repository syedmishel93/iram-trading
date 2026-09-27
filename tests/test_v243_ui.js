// v24.3 — ranking bind fix, copyability, filters, thin-hint, rail labels, table density
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// R1: ranking now uses walletIntel (has tier+conf) not smartScore \u2014 fixes "undefined 6 / undefined% conf"
ok(src.includes('walletIntel(r,{now,coHoldCount:coMap[r.addr]||0})'),'R1: ranking binds to walletIntel (tier+score+conf)');
ok(!/const rows=Object\.values\(db\)\.map\(r=>\(\{r,s:smartScore/.test(src),'R1: old smartScore binding removed (no more undefined tier/conf)');
ok(src.includes('x.s.tier')&&src.includes('x.s.conf'),'R1: row reads tier + conf from walletIntel');

// R3/D1: copyability stance + DNA role on rows
ok(src.includes('x.copy.stance')&&src.includes('COPYABLE'),'R3: copyability stance badge on each row');
ok(src.includes('x.dna&&x.dna.role')&&src.includes('walletDNA({events:[],holdings:[],rec:r'),'D1: DNA role shown inline per wallet');

// R2: width cap
ok(src.includes('table-layout:fixed')||src.includes('smrank-tbl'),'R2: ranking table width controlled (fixed layout in v244+)');

// R4: thin-DB honest hint
ok(src.includes('function renderThinHint')&&src.includes('Why your wallets score low'),'R4: honest thin-DB guidance (harvest EVM)');
ok(src.includes("isn\\'t a display bug"),'R4: explains it\u2019s the honesty contract, not a bug');

// R5 + D3: filter + sort controls
ok(src.includes('function renderTierControls')&&src.includes("fb('sa','S/A only')")&&src.includes("fb('copy','copyable')"),'R5: tier filter (all / S-A / copyable)');
ok(src.includes("sb('score','tier')")&&src.includes("sb('tokens','tokens')")&&src.includes("sb('recency','recent')"),'D3: sort controls (tier/tokens/recent)');
ok(src.includes('.smtf').forEach!==undefined||src.includes(".smtf').forEach"),'R5: filter buttons wired');

// L1-L4: rail labels under icons, always visible + group headers + active bar
ok(src.includes('tabbar')||src.includes('rail pinned-open'),'L1: navigation labels visible (superseded by tab bar in v250)');
ok(src.includes('.tab')&&src.includes('data-views'),'L1: labeled navigation present (tab bar)');
ok(src.includes('subtabs')||src.includes('rail-grp-h'),'L2: grouped navigation present');
ok(src.includes('.tab.on::after')||src.includes('.nav.on::before'),'L3: active item indicator');

// C1: no broken emoji escapes anywhere
ok(!/\\U[0-9A-Fa-f]{8}/.test(src),'C1: zero broken \\U emoji escapes in the whole file');

// C2: unified table density
ok(src.includes('unified table density across meme radar, whale board, ranking, feed'),'C2: one table-density standard for all tables');

// C3: legend opaque + format guards
ok(src.includes('background:var(--panel);backdrop-filter:blur(8px)')&&src.includes('z-index:20'),'C3: legend opaque + layered (no canvas bleed-through)');
ok(src.includes('Number.isFinite(+IND._flux[n])')&&src.includes('Number.isFinite(+IND._rsi[n])'),'C3: RSI/FLUX format guards (no garbled readout)');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=24.3,'version 24.3+');
console.log('\nv24.3 UI TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
