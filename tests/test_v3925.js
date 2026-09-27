/* v39.25 — the full deferred batch: news RSS, logo CDN, order-flow sparkline, jargon glossary, clean startup, denser watchlist. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.25 DEFERRED BATCH ===\n');
// #1 news keyless
ok('#1 news: RSS/Atom parser added', idx.includes('function rssToItems'));
ok('#1 news: keyless default source + auto-load without setup',
   idx.includes('DEFAULT_NEWS_RSS') && idx.includes("kind!=='calendar')url=DEFAULT_NEWS_RSS") && idx.includes("newsU||DEFAULT_NEWS_RSS"));
// #4 sparkline
ok('#4 order-flow: imbalance-history sparkline', idx.includes('imbHist') && idx.includes('IMBALANCE TREND'));
// #5 jargon
ok('#5 jargon: glossary tooltip injector', idx.includes('window.GLOSSARY') && idx.includes('function applyGloss') && idx.includes('cursor=\'help\''));
ok('#5 jargon: covers X-MKT / HEAT / R:R / Integrity / Engine', idx.includes("'X-MKT'") && idx.includes("'HEAT'") && idx.includes("'R:R'") && idx.includes("'Integrity'"));
// #8 logo CDN
ok('#8 logos: default CDN with brand-disc fallback', idx.includes('function _defaultLogo') && idx.includes('cryptocurrency-icons') && idx.includes("onerror"));
ok('#8 logos: lazy/async (perf)', idx.includes('loading="lazy" decoding="async"'));
// #7 watchlist
ok('#7 watchlist: denser cards', idx.includes('wl-card" data-sym="${s}" style="padding:9px 10px'));
// startup
ok('startup: clean default overlays (EMAs + S/R, no heavy SMC)',
   idx.includes("const ON=new Set(['ema20','ema50','ema200','sr'])"));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
