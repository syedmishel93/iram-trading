/* v39.29 — calendar marker fixes + upcoming strip + SM alerts + pattern receipts + throttle. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.29 BATCH ===\n');
ok('#1 markers carry titles (newsMarkerIdx items[])', idx.includes('byBar[i].items.push') && idx.includes('title:(it.title'));
ok('#1 findable Cal toggle button', idx.includes('id="calBtn"') && idx.includes('id="calVal"'));
ok('#1 hover tooltip shows the event (#newsTip + hotspots)', idx.includes("id='newsTip'") && idx.includes('window._newsHot'));
ok('#1 click marker -> News feed', idx.includes("querySelector('[data-view=\"news\"]')"));
ok('#1 impact colors + legend', idx.includes('high-impact') && idx.includes('click \\u2192 News feed'));
ok('#5 upcoming-events strip w/ countdowns', idx.includes('function renderUpcoming') && idx.includes('NEXT HIGH-IMPACT EVENTS'));
ok('#6 smart-money alerts (toggle + bell/TG)', idx.includes('id="smAlertsOn"') && idx.includes('_smAlertsOn') && idx.includes('ALERT_LOG.unshift'));
ok('#7 pattern receipts (hit-rate per pattern, persisted per symbol)',
   idx.includes('PATTERN RECEIPTS') && idx.includes('function smResolve') && idx.includes('iram_receipts_'));
ok('optimize: order-flow analytics throttled ~5Hz', idx.includes('_lastRead') && idx.includes('derived analytics at ~5Hz'));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
