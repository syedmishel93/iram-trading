/* v39.19 — Arkham theme (default), coin icons + monogram, risk flags, update option. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };

console.log('\n=== v39.19 ARKHAM THEME + ICONS + RISK ===\n');

// theme
ok('THEME: arkham palette defined', /html\[data-theme="arkham"\]\{[^}]*--bull:/.test(idx));
ok('THEME: arkham is the default', idx.includes("applyTheme('arkham')") && !idx.includes("localStorage.setItem('mishel_theme','institutional')"));
ok('THEME: arkham in the theme selector', idx.includes('value="arkham"'));
ok('THEME: reusable tag-pill component', idx.includes('.pill{') && idx.includes('.pill.bull{') && idx.includes('.pill.bear{'));

// icons
ok('ICON: assetIcon + monogram fallback', idx.includes('window.assetIcon=function') && idx.includes('aicon mono'));
ok('ICON: bundled brand meta (BTC/ETH/gold…)', idx.includes('window.ASSET_META') && idx.includes('BTCUSD') && idx.includes('XAUUSD'));
ok('ICON: online CDN override honored (update option)', idx.includes('window._iconCDN'));
ok('ICON: wired into ticker + watchlist + symbol button + picker',
   (idx.match(/assetIcon\(/g) || []).length >= 4);

// risk
ok('RISK: assetRisk computes low-liq from real volume/spread', idx.includes('window.assetRisk=function') && idx.includes('wide spread'));
ok('RISK: delist only from a real source (never guessed)', idx.includes('flagged by risk source') && idx.includes('volume collapsed to zero'));
ok('RISK: risk pills shown next to symbols', (idx.match(/class="pill /g) || idx.match(/class=.pill /g) || []).length >= 1);

// update option
ok('UPDATE: toggle + source fields (icons + risk lists)',
   idx.includes('id="assetUpdateOn"') && idx.includes('id="dsIconUrl"') && idx.includes('id="dsRiskUrl"'));
ok('UPDATE: updateAssetData pulls through the proxy, offline-first',
   idx.includes('window.updateAssetData=async function') && idx.includes('_assetUpdateOn'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
