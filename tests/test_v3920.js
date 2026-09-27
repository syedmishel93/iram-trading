/* v39.20 — theme migration fix + real-time metals/forex (Twelve Data WebSocket). */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.20 THEME MIGRATION + TWELVE DATA WS ===\n');
ok('THEME: one-time arkham migration flag (applies over an old saved theme)',
   /mishel_arkham_v39\d\d/.test(idx));
ok('THEME: migration forces arkham once, then respects saved choice',
   /if\(!_mig\)\{[^]*applyTheme\('arkham'\)/.test(idx));
ok('WS: startLiveForexWS present, connects to Twelve Data websocket',
   idx.includes('function startLiveForexWS') && idx.includes('wss://ws.twelvedata.com'));
ok('WS: subscribes to the mapped symbol', idx.includes("action:'subscribe'") && idx.includes('tdSym'));
ok('WS: only updates on a valid price, never fabricates', idx.includes('never fabricate') && idx.includes('event!==\'price\''));
ok('WS: falls back to REST poller if the socket cannot open', /if\(!opened&&!fellBack\)[^]*startLiveForex\(\)/.test(idx));
ok('WS: routed in when a Twelve Data key is set', idx.includes("startLiveForexWS);return}"));
ok('WS: stopLive tears down the socket + heal timer', idx.includes('_fxws') && idx.includes('_fxHealTimer'));
ok('WS: labels the feed as real-time (not delayed)', idx.includes("_feedSrc='Twelve Data") && idx.includes('WS'));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
