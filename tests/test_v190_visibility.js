// v19.0 VISIBILITY — nothing requires hovering or scrolling to be seen
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// V1 connection truthfulness
ok(src.includes("'FX/stocks: key or proxy needed'"),'non-crypto with no vendor says WHY, not just "stale"');
ok(src.includes("'reconnecting\\u2026'"),'crypto stale says reconnecting (failover trying)');
ok(src.includes('Twelve Data key (forex/metals) or run the local proxy'),'tooltip explains the exact remedy');

// V2 topbar bleed
ok(src.includes('#feedTxt{display:inline-block;max-width:150px'),'feedTxt clamped — no more "no…" bleeding into Candles');

// V3 left bar visible by default
ok(src.includes("localStorage.getItem('mishel_pin')!=='0'"),'sidebar PINNED BY DEFAULT (unpin remembered)');
ok(!src.includes("localStorage.getItem('mishel_pin')==='1'"),'old only-if-opted-in loader gone');

// V4 merged read on the chart itself
ok(src.includes('id="ihXm"'),'X-MKT chip lives in the chart header, next to price/consensus/ATR');
ok(src.includes("'X-MKT '+bits.join"),'chip carries regime + anomaly + rotation leaders');
ok(src.includes('votes as gate 6 of your trade checklist'),'chip tooltip states the checklist merge');
ok(src.includes('\\u26a0 ANOMALY'),'anomaly turns the chip red-flagged');

// V5 scout is the FIRST panel of On-Chain Desk
const scoutIdx=src.indexOf('id="walletScout"');
const launchIdx=src.indexOf('New-Launch Radar</h4>');
const holderIdx=src.indexOf('Whale / Holder Tracker');
ok(scoutIdx>0&&scoutIdx<launchIdx&&scoutIdx<holderIdx,'Smart Wallet Scout moved ABOVE launch radar & holder tracker');
ok(src.indexOf('id="walletScout"',scoutIdx+10)<0,'exactly one scout panel (moved, not duplicated)');

// V6 bridge
ok(src.includes('id="ocToScout"'),'holder tracker \u2192 \ud83c\udfaf scout bridge button');
ok(src.includes("pnl.scrollIntoView({behavior:'smooth',block:'start'})")&&src.includes('scoutRun();'),'bridge prefills, scrolls, runs');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=19.0,'version is 19.0 or later');
console.log('\nv19.0 VISIBILITY TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
