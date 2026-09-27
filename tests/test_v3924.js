/* v39.24 — dropdown text, bold IRAM, API-key persistence, ticker reprioritized. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.24 FIXES ===\n');
ok('UI: arkham dropdown/input text is readable (color set, options styled)',
   idx.includes('html[data-theme="arkham"] input,html[data-theme="arkham"] select,html[data-theme="arkham"] textarea{ background:#08090C; border-color:var(--edge); color:var(--txt) !important') && idx.includes('select option{ background:#0B0D11'));
ok('BRAND: IRAM is bold + uppercase', idx.includes('font-weight:900') && idx.includes('text-transform:uppercase; font-size:17px'));
ok('KEY: Save + Remove buttons on the API key field', idx.includes('id="dsKeySave"') && idx.includes('id="dsKeyClear"'));
ok('KEY: persisted + auto-loaded every session', idx.includes("localStorage.setItem(K,v)") && idx.includes("localStorage.getItem(K)") && idx.includes('mishel_apikey'));
ok('KEY: saving reconnects the live feed', idx.includes("setMode('online')"));
ok('TICKER: the read (consensus bias) leads the strip', idx.includes("k: 'bias'") && idx.includes("'read <b>'"));
ok('TICKER: jargon softened (candle -> next bar)', idx.includes("'next bar <b>'") && !idx.includes("txt: 'candle <b>'"));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
