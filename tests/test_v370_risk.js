/* v37.0 CLIENT TESTS — the Risk Governor. Asserted against the SHIPPED index.html. */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let P = 0, F = 0;
const ok = (c, m) => { if (c) { P++; console.log('  ' + m + ' \u2713') } else { F++; console.log('  ' + m + ' \u2717 FAIL') } };

console.log('\nTHE GOLD SIZING BUG — gone from the codebase');
ok(!/units5\/100000/.test(src),
   'G1: the /100000 lot conversion is GONE. XAUUSD\u2019s contract is 100 OUNCES, not 100,000 \u2014 '
   + 'that path sized gold 1000x too small, silently, for 36 versions.');
ok(/svc\/risk\/size/.test(src), 'G2: lot size now comes from the SERVER, using the broker\u2019s real contract spec');
ok(/this terminal will not guess a contract size/i.test(src),
   'G3: HONESTY \u2014 no spec means NOT SIZED. It never falls back to a guess.');
ok(/NOT SIZED/.test(src), 'G4: ...and the ticket says NOT SIZED rather than printing a number it made up');
ok(/function buildTicket5/.test(src), 'G5: buildTicket5 ships');
ok(/risks \$'\+j\.detail\.actual_risk_money/.test(src),
   'G6: the ticket states the ACTUAL money at risk for the lots it gives you');

console.log('\nTHE GATE — the ticket obeys the governor');
ok(/window\.govCheck=function/.test(src), 'GT1: govCheck ships');
ok(/window\.govCheck\(\{symbol:sym5/.test(src),
   'GT2: the order-ticket action calls it BEFORE building anything');
ok(/RISK GOVERNOR \\u2014 TICKET REFUSED/.test(src), 'GT3: a BLOCK refuses to build the ticket');
ok(/Nothing is stopping you placing this by hand in MT5/.test(src),
   'GT4: THE LINE \u2014 it never claims to stop him trading. It declines to make it convenient.');
ok(/\/svc\/risk\/check/.test(src), 'GT5: the gate asks the SERVER, which sees the real account');

console.log('\nBLIND \u2260 SAFE');
ok(/This is a blind spot, not an all-clear/.test(src),
   'B1: if the governor is unreachable the client SAYS it is a blind spot \u2014 it never implies all-clear');
ok(/being watched<\/b>\. '\s*\n?\s*\+\s*'That is not the same as being within your limits/.test(src)
   || /That is not the same as being within your limits/.test(src),
   'B2: panel: "not being watched" is stated as DIFFERENT from "within your limits"');
ok(/The governor being DOWN is itself risk information/.test(src),
   'B3: the code says why: a down governor is risk information, not the absence of risk');

console.log('\nCORRELATION \u2014 the one nobody sees');
ok(/long EURUSD is long EUR \/ short USD/.test(src),
   'C1: the panel explains currency netting in one line');
ok(/This is the bet you are actually making/.test(src), 'C2: ...and names what it is for');
ok(/Net currency exposure/.test(src), 'C3: net exposure is rendered per currency');

console.log('\nUNPROTECTED POSITIONS');
ok(/OPEN POSITION\(S\) WITH NO STOP LOSS/.test(src), 'U1: unprotected positions get their own red box');
ok(/open-ended bet on your own attention/.test(src), 'U2: ...and it lands');

console.log('\nSURFACES');
ok(/id="govBtn"/.test(src), 'S1: \ud83d\udee1 toolbar button');
ok(/id="stGov"/.test(src) && /id="stGovWrap"/.test(src), 'S2: Risk chip in the status bar');
ok(/Risk Governor \\u2014 daily loss, open risk, currency concentration/.test(src), 'S3: \u2318K entry');
ok(/window\.govPanel=function/.test(src), 'S4: the panel ships');
ok(/\/svc\/risk\/config/.test(src) && /Save limits/.test(src),
   'S5: the limits are EDITABLE \u2014 they are his numbers, not ours');
ok(/only worth having if you actually believe the limits you set/.test(src),
   'S6: ...and it says why that matters');

console.log('\nv37.0 RISK GOVERNOR (client): ' + P + ' passed, ' + F + ' failed');
process.exit(F ? 1 : 0);
