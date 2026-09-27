// v23.1 — Solana holdings readable + clickable/copyable everywhere + version badge
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// Solana holdings resolve to readable symbols
ok(src.includes('tokens.jup.ag/tokens')&&src.includes('window._jupTokens'),'Solana mints resolved to symbols via Jupiter verified list (cached)');
ok(src.includes('meta?meta.sym:(mint.slice(0,4)')&&src.includes('mint:mint'),'readable symbol when known, short-mint fallback otherwise (no fake)');
ok(src.includes("getTokenAccountsByOwner"),'Solana holdings via public RPC still present');
ok(src.includes('Solana buy/sell history needs a paid indexer'),'Solana transfer history honestly N/A, not faked');

// clickable + copyable everywhere (already in v23 — regression guard)
ok(src.includes('class="codash"')&&src.includes(".codash').forEach(el=>el.onclick"),'co-holding wallet addresses clickable \u2192 dashboard');
ok(src.includes('cocopy"'),'co-holding token copyable');
ok(src.includes('class="feeddash"')&&src.includes(".feeddash').forEach"),'live-feed wallet addresses clickable \u2192 dashboard');
ok(src.includes('feedcopy"'),'live-feed wallet copyable');
ok(src.includes('smcopy"'),'ranking rows copyable');

// DNA dashboard renders (regression guard)
ok(src.includes('\\u{1F9EC}')&&src.includes('Median hold')&&src.includes('Risk DNA'),'DNA dashboard present in dossier');

// version badge — so the user can confirm cache is cleared
ok(src.includes('id="smVerBadge"')&&src.includes("'v'+APP_VER+' \\u2713 live'"),'live version badge on Smart Money desk (confirms fresh build)');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=23.1,'version 23.1+');
console.log('\nv23.1 SOLANA/UI TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
