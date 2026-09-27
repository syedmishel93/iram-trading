// v20.1 FIXES — regroup safety + Solana dossier
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// F1: bulletproof regroup that can't lose buttons
ok(src.includes('rail._regrouped')&&src.includes('rebuild groups from scratch')===false||src.includes('WITHOUT ever hiding/losing'),'regroup rewritten to be non-destructive');
ok(src.includes('SAFETY NET: any button not placed'),'orphan safety net: unmapped buttons go to MORE group');
ok(src.includes("['SMART MONEY',['smart','intel']]"),'smart money is its own group (v24)');
ok(src.includes("var orphans=Object.keys(byView).filter"),'orphan collection present');
ok(src.includes('byView.confluence.style.display=')&&src.includes("!placed[v]&&v!=='confluence'"),'only confluence intentionally hidden, excluded from orphans');
// smart button must exist in markup regardless
ok(src.includes('data-view="smart"')&&src.includes('Smart Money</span>'),'Smart Money nav button present in markup');

// F2/F3: Solana dossier
ok(src.includes('<option value="solana">Solana</option>'),'Solana added to dossier chain dropdown (first)');
ok(src.includes('/^0x[0-9a-fA-F]{40}$/.test(addr)')&&src.includes("'solana'"),'chain auto-detected from address shape (EVM vs base58)');
ok(src.includes('const _isEVM=!!GP_CHAIN[chain]')&&src.includes('if(_isEVM)try{const cid=GP_CHAIN[chain]'),'GoPlus fetch gated to EVM only');
ok(src.includes('GoPlus security is EVM-only'),'Solana dossier: honest GoPlus-N/A note, DexScreener still runs');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=20.1,'version 20.1+');
console.log('\nv20.1 FIX TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
