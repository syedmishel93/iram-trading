/* v38.0 — HOTFIX + FOUR HONESTY ARCS. Asserted against the SHIPPED index.html. */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let P = 0, F = 0;
const ok = (c, m) => { if (c) { P++; console.log('  ' + m + ' \u2713') } else { F++; console.log('  ' + m + ' \u2717 FAIL') } };

console.log('\nTHE INVARIANT \u2014 the bug that hid in plain sight for 3 versions');
/* THE REGRESSION: Fresh.state() returns 'offline' unless window._realFeed is set.
   It was set in startLiveProxy and startLiveForex ONLY. The two CRYPTO tick sinks
   (applyKline via websocket, startLiveReal via REST poll) never set it — so on a
   perfectly live Binance feed, Fresh said OFFLINE, which per the v35 gate silently
   killed the Decision Bar AND the MT5 ticket for all of crypto.
   1,303 assertions missed it because they tested that the CONTRACT EXISTS, not that
   EVERY FEED HONOURS IT. This block pins the invariant instead. */
const sinks = src.match(/CURSYM\.px\s*=\s*[^;]+;/g) || [];
ok(sinks.length >= 4, 'I1: found ' + sinks.length + ' places that write CURSYM.px (the tick sinks)');

/* every live tick sink must stamp the freshness contract */
const liveSinks = [
  { name: 'startLiveProxy (proxy/MT5)', re: /CURSYM\.px=nc;window\._lastTick=Date\.now\(\);window\._realFeed=true;/ },
  { name: 'startLiveForex (Twelve Data)', re: /CURSYM\.px=nc;window\._lastTick=now;window\._realFeed=true;/ },
  { name: 'startLiveReal (Binance REST poll)', re: /CURSYM\.px=nc;[\s\S]{0,600}?window\._lastTick=Date\.now\(\);window\._realFeed=true;window\._feedBroker=false;/ },
  { name: 'applyKline (Binance websocket)', re: /CURSYM\.px=bar\.c;[\s\S]{0,500}?window\._lastTick=Date\.now\(\);window\._realFeed=true;/ }
];
liveSinks.forEach((s, i) => ok(s.re.test(src),
  'I' + (i + 2) + ': ' + s.name + ' stamps _lastTick + _realFeed'));
ok(/A contract\s+that only some feeds honour is not a contract/.test(src),
   'I6: the invariant is stated IN the code, so the next feed cannot quietly skip it');
ok(/window\._realFeed=false/.test(src),
   'I7: the OFFLINE/synthetic path still explicitly sets _realFeed=false (it is the one path that must)');

console.log('\nGLYPHS + CHIP COLLISION');
ok(!/>\\u2696<\/button>/.test(src) && !/>\\ud83d\\udee1<\/button>/.test(src),
   'X1: no literal \\uXXXX escapes left in raw HTML (JS escape syntax does NOT decode in markup)');
// v39.0 — these two buttons had an EMOJI as their entire label (⚖ and 🛡). The original
// assertion existed because an earlier build shipped the literal escape "\u2696" as text.
// Both are now inline SVG: stroked, currentColor, so a theme can actually recolour them,
// and they rasterise identically on every OS. Assert what was ever at stake — the button
// has a visible label and it is not a raw escape.
ok(/id="reconBtn"[^>]*>\s*<svg[\s\S]{20,400}<\/svg>\s*<\/button>/.test(src)
   && !/id="reconBtn"[^>]*>\s*<\/button>/.test(src), 'X2: reconciliation button has a real (SVG) label');
ok(/id="govBtn"[^>]*>\s*<svg[\s\S]{20,400}<\/svg>\s*<\/button>/.test(src)
   && !/id="govBtn"[^>]*>\s*<\/button>/.test(src), 'X3: risk-governor button has a real (SVG) label');

ok(/Integrity <b/.test(src), 'X4: the bar-completeness readout renamed \u2014 it used to collide with the Data freshness chip');

console.log('\nARC B \u2014 REAL COSTS (the last fabricated number)');
ok(/window\.costModel = function/.test(src), 'B1: costModel ships');
ok(!/const costR=Math\.min\(0\.15,\(spr\|\|entry\*0\.0002\)\/R\);/.test(src),
   'B2: the flat 2bps guess is GONE from sigScan');
ok(/broker tick \(live\)/.test(src) && /broker spec/.test(src) && /live book/.test(src),
   'B3: order of truth \u2014 broker tick > broker spec > live book');
ok(/ASSUMED 2bps \(no broker spec\)/.test(src),
   'B4: an assumption is still ALLOWED \u2014 but it is LABELLED. An unlabelled assumption is not.');
ok(/commission_per_lot/.test(src) && /swap_long/.test(src),
   'B5: commission AND swap are counted \u2014 they were ignored entirely for 37 versions');
ok(/A cap is a lie with a ceiling/.test(src),
   'B6: the arbitrary 0.15R cost cap is gone \u2014 if a trade really costs 0.4R the system must be able to SAY so');
ok(/id="stCost"/.test(src) && /Costs ASSUMED/.test(src) && /Costs REAL/.test(src),
   'B7: a status chip tells him at a glance what his numbers were costed with');

console.log('\nARC A \u2014 THE \u2605 PICKER STOPS LYING');
ok(/window\.pickerAudit = function/.test(src), 'A1: pickerAudit ships');
ok(/cscvPBO\(rm\.M, 10\)/.test(src),
   'A2: PBO via CSCV is now RUN on the picker \u2014 the machinery has existed since v13, wired to a panel nobody opens');
ok(/deflatedSharpe\(rm\.M\[bi\], trialSRs/.test(src), 'A3: deflated Sharpe deflates the winner for the number of trials');
ok(/SS\.withheld=\{strat:b\.strat/.test(src),
   'A4: THE GATE \u2014 a pick that fails the audit is WITHHELD, not promoted');
ok(/MORE LIKELY THAN NOT[\s\S]{0,60}artefact of searching/.test(src),
   'A5: PBO>50% is explained in words: the pick is more likely than not an artefact of the search');
ok(/not distinguishable from the best of/.test(src),
   'A6: a low DSR says the winner is indistinguishable from the best of N coin flips');
ok(/A withheld \u2605 is a RESULT/.test(src),
   'A7: THE PRINCIPLE \u2014 a refusal is a result. A search through noise ALWAYS finds a hero.');
ok(/id='starWithheld'|id="starWithheld"/.test(src) && /WITHHELD \\u2014 no strategy promoted/.test(src),
   'A8: the refusal is VISIBLE \u2014 a silent refusal is indistinguishable from a bug');
ok(/It is the absence of the specific lie we know how to test for/.test(src),
   'A9: even a PASS is framed honestly \u2014 surviving the audit is not proof of an edge');

console.log('\nARC C \u2014 n + CI, OR IT IS NOT A MEASUREMENT');
ok(/Sorting a noisy[\s\S]{0,60}statistic descending and showing the top of it IS selection bias/.test(src),
   'C1: the old panel sorted a noisy stat best-first \u2014 that IS selection bias, rendered');
ok(/95% '\+\(r2\.lo\*100\)/.test(src), 'C2: every accuracy row now carries its Wilson 95% interval');
ok(/n=unknown|n unknown/.test(src), 'C3: no sample size -> it says so, instead of printing a bare percentage');
ok(/coin flip/.test(src), 'C4: an interval that straddles 50% is LABELLED a coin flip and greyed');
ok(/Not one indicator here beats a coin/.test(src),
   'C5: if nothing is significant it says THAT, rather than inviting him to pick the biggest number');

console.log('\nARC D \u2014 THE PRE-MARKET RITUAL');
ok(/window\.preMarket = function/.test(src), 'D1: preMarket ships');
ok(/id="pmBtn"/.test(src), 'D2: \u2600 toolbar button');
ok(/Pre-market ritual \\u2014 five checks before London/.test(src), 'D3: \u2318K entry');
ok(/BEFORE you are in a position and reasoning backwards/.test(src),
   'D4: it states its own purpose \u2014 see the facts before you are committed to a view');
ok(/DO NOT TRADE YET/.test(src) && /PROCEED WITH YOUR EYES OPEN/.test(src) && /CLEAR TO TRADE YOUR PLAN/.test(src),
   'D5: it ends in a VERDICT, not a dashboard');
ok(/it only means nothing KNOWN is wrong/.test(src),
   'D6: even the all-clear refuses to overclaim \u2014 it is not a prediction and not permission');
ok(/\/svc\/risk\/state/.test(src) && /\/svc\/recon\?days=30/.test(src),
   'D7: it pulls the real governor verdict AND what his execution actually did last month');

console.log('\nv38.0 HOTFIX + HONESTY: ' + P + ' passed, ' + F + ' failed');
process.exit(F ? 1 : 0);
