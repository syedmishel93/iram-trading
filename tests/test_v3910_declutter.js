/* v39.10 — declutter, ticket-not-black, ticker, fonts, no-duplicate-plan */
const fs = require('fs'); const path = require('path');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let P = 0, F = 0;
const ok = (n, c, d) => { if (c) { P++; console.log('  ok  ', n); } else { F++; console.log('  FAIL', n, d || ''); } };

console.log('\n=== v39.10 DECLUTTER + POLISH ===\n');
ok('Z1: ticket card has a real background even when collapsed (never black)',
  idx.includes('#brokerCard.collapsed{ background:var(--panel)') || idx.includes('#brokerCard{ background:var(--panel)'));
ok('Z1: profile select moved OUT of the h3 into the body', idx.includes('bk-profwrap') && idx.includes("class=\"bk-prof\""));
ok('Z2: duplicate Trade Plan killed (plan/sizer deleted before loose-render)', idx.includes('delete cards.plan; delete cards.sizer'));
ok('declutter: hard KEEP_OPEN rule caps the default-open cards', idx.includes('KEEP_OPEN') && idx.includes("'Order ticket':1"));
ok('declutter: late-injected cards get re-wired (collapse applies to them too)', idx.includes('catch late-injected cards') || idx.includes('_ws >= 6'));
ok('N1: news ticker element + scroll animation', idx.includes("id = 'newsTicker'") && idx.includes('tkscroll'));
ok('N1: ticker reuses existing feeds, no fabrication (quiet state honest)', idx.includes('tape quiet') && idx.includes('_macroCal'));
ok('N1: hot items (event <30m, anomaly) highlight', idx.includes('tk-hot') && idx.includes('past patterns may not hold'));
ok('F1: Inter is the UI font', idx.includes("--ui:'Inter'") && idx.includes('family=Inter'));
ok('F1: numbers use tabular figures for column alignment', idx.includes('font-variant-numeric:tabular-nums'));
ok('F1: Space Grotesk demoted (not the UI face)', idx.includes("--ui:'Inter'"));
ok('O2: single semantic bull/bear palette defined', idx.includes('--bull:#26C281') && idx.includes('--bear:#E5484D'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
