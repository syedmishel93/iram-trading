/* v36.0 CLIENT TESTS — MT5 as the source of truth.
   Asserted against the SHIPPED index.html, not a copy. */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let P = 0, F = 0;
const ok = (c, m) => { if (c) { P++; console.log('  ' + m + ' \u2713') } else { F++; console.log('  ' + m + ' \u2717 FAIL') } };

console.log('\nTHE BROKER TIER — the only price you actually get');
ok(/if \(window\._feedBroker\) return 'REAL \\u00b7 BROKER'/.test(src),
   'B1: Fresh.label() has a BROKER tier above every vendor');
ok(/broker: function\(\)\{ return !!window\._feedBroker \}/.test(src),
   'B2: Fresh.broker() — downstream code can ask "is this the series I get filled on?"');
ok(/window\._feedBroker=\(prov==='mt5'\)/.test(src),
   'B3: the live proxy ticker sets _feedBroker when the provider is mt5');
ok(/YOUR broker's bars and YOUR spread/.test(src) || /YOUR broker\\'s bars and YOUR spread/.test(src),
   'B4: Fresh.why() states plainly that levels/ATR/stops are computed on YOUR fill series');
ok(/a vendor series is not the market you trade/.test(src),
   'B5: HONESTY — a non-broker feed on FX says so, instead of implying the chart is tradeable');
ok(src.indexOf("window._feedBroker") < src.indexOf("window._feedDelay ? 'REAL \\u00b7 delayed'"),
   'B6: BROKER is checked BEFORE delayed — a broker feed is never mislabelled as a vendor feed');

console.log('\nTHE REAL SPREAD — retiring a 34-version-old guess');
ok(/\/mt5\/tick\?symbol=/.test(src), 'S1: the client pulls the live broker tick');
ok(/window\._oflow\.spread=\{bid:t\.bid,ask:t\.ask\}/.test(src),
   'S2: the broker\u2019s REAL bid/ask feeds _oflow.spread \u2014 which is what signal costR reads');
ok(/hard-coded 0\.0002 guess/.test(src),
   'S3: the code says WHY: gold\u2019s spread at rollover is nothing like EURUSD\u2019s at midday');
ok(/_mt5SpreadAt/.test(src), 'S4: spread polling is throttled (15s), not hammered per tick');

console.log('\nRECONCILIATION PANEL — planned vs actual');
ok(/window\.reconPanel=function/.test(src), 'R1: reconPanel ships');
ok(/id="reconBtn"/.test(src), 'R2: \u2696 toolbar button next to the journal');
ok(/Execution reconciliation \(MT5\)/.test(src), 'R3: reachable from the \u2318K palette');
ok(/\/svc\/recon\?days=180/.test(src), 'R4: it reads the SERVER\u2019s reconciliation, not a browser guess');
ok(/\/svc\/mt5\/import/.test(src) && /\/svc\/mt5\/sync/.test(src),
   'R5: two ways in \u2014 drop an MT5 report file, or sync via the bridge');
ok(/Toolbox \\u2192 <b style="color:var\(--txt\)">History<\/b>/.test(src),
   'R6: it tells you exactly where to click in MT5 to get the file');

console.log('\nHONESTY IN THE PANEL');
ok(/Your real edge is currently unmeasured/.test(src),
   'R7: EMPTY STATE names the problem \u2014 it does not render a dashboard of zeroes');
ok(/come from the <b>demo<\/b> account \\u2014 '\s*\+\s*'they are not your numbers/.test(src)
   || /they are not your numbers/.test(src),
   'R8: it says out loud that the journal\u2019s win-rate is the DEMO account\u2019s, not his');
ok(/a dash means '\s*\+\s*'<b>not measurable<\/b> \\u2014 not zero/.test(src) || /not measurable<\/b> \\u2014 not zero/.test(src),
   'R9: a dash means NOT MEASURABLE, not zero \u2014 stated in the footer');
ok(/costs are the broker\\u2019s own commission \+ swap \(never modelled\)/.test(src),
   'R10: costs are the broker\u2019s own numbers, never modelled');
ok(/we do NOT guess it, because a wrong offset silently misaligns/.test(src),
   'R11: broker server-time offset is asked for, never guessed');
ok(/bar_sources/.test(src) && /MFE\/MAE bars:/.test(src),
   'R12: it REPORTS which bar series MFE/MAE was computed from (broker vs vendor) \u2014 no false precision');

console.log('\nSETTINGS');
ok(/id="mt5Test"/.test(src) && /\/mt5\/health/.test(src),
   'C1: a Test-MT5-connection button that reports the real reason on failure');

console.log('\nv36.0 MT5 + RECONCILIATION: ' + P + ' passed, ' + F + ' failed');
process.exit(F ? 1 : 0);
