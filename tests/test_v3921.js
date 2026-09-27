/* v39.21 — Arkham Trending Insights dashboard (deferred build). */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.21 TRENDING INSIGHTS ===\n');
ok('INS: view + grid container present', idx.includes('id="v-insights"') && idx.includes('id="insightsGrid"'));
ok('INS: nav button + first in Discover subviews', idx.includes('data-view="insights"') && idx.includes('data-views="insights,'));
ok('INS: nav renders it', /if\(v==='insights'\)try\{renderInsights/.test(idx));
ok('INS: builds cards from live reads (buildInsights + renderInsights)', idx.includes('function buildInsights') && idx.includes('function renderInsights'));
ok('INS: draws from confluence, order-flow, news, funding, regime, F&G, MTF',
   idx.includes('consensus') && idx.includes('_ofRead') && idx.includes('_macroCal') && idx.includes('_fundRate') && idx.includes('Fear & Greed') && idx.includes('mtfMatrix'));
ok('INS: Arkham tag pills used', /class="pill /.test(idx) && idx.includes("label:'Order Flow'"));
ok('INS: honest empty state (nothing fabricated)', idx.includes('Nothing is fabricated here'));
ok('INS: cards route to the symbol on click', idx.includes('data-ins-sym'));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
