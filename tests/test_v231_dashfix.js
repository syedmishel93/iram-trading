// v23.1 — dashboard reachable everywhere + Solana holdings + copy
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// K1 Solana holdings
ok(src.includes("chain==='solana'")&&src.includes('getTokenAccountsByOwner'),'Solana wallet holdings via public Solana RPC (no more "unavailable")');
ok(src.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),'SPL token program id used');
ok(src.includes('Solana buy/sell history needs a paid indexer')&&src.includes('rather than faked'),'Solana transfer history honestly marked N/A (not faked)');
ok(src.includes('No free data source for')&&src.includes('nothing faked'),'unknown chain \u2192 honest unavailable');

// K2 co-holding clickable + copyable
ok(src.includes('class="codash"')&&src.includes('smWalletDossier(el.dataset.a'),'co-holding wallet addresses OPEN the dashboard on click');
ok(src.includes('class="tbtn cocopy"')&&src.includes('clipboard.writeText(b.dataset.a)'),'co-holding token address is COPYABLE');

// K3 live feed clickable + copyable
ok(src.includes('class="feeddash"')&&src.includes("box.querySelectorAll('.feeddash')"),'live-activity wallet addresses OPEN the dashboard');
ok(src.includes('class="tbtn feedcopy"'),'live-activity wallet address is COPYABLE');

// dashboard content intact
ok(src.includes('\\u{1F9EC}')&&src.includes('HOLDING NOW')&&src.includes('RECENT BUYS / SELLS'),'dashboard shows DNA + holdings + buy/sell history');
ok(src.includes('portfolioSummary'),'portfolio summary present');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=23.1,'version 23.1+');
console.log('\nv23.1 DASH-FIX TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
