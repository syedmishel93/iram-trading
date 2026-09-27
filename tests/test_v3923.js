/* v39.23 — rebrand to iram, stylish logo, top-bar black fix, AI decision surfaced. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.23 REBRAND + LOGO + TOP BAR + AI ===\n');
ok('BRAND: header wordmark is iram', idx.includes('<b>iram</b>'));
ok('BRAND: document title renamed to iram', idx.includes("document.title='iram Intelligence"));
ok('BRAND: splash + session report renamed', idx.includes('>iram <span') && idx.includes('iram session report'));
ok('BRAND: no visible "Mishel Intelligence Trading" heading left', !idx.includes('>Mishel Intelligence Trading \\u2014 session'));
ok('LOGO: new gradient badge mark present', idx.includes('.brand .glyph svg') || idx.includes('class="glyph"'));
ok('LOGO: arkham gives the badge a gradient + gradient wordmark',
   idx.includes('html[data-theme="arkham"] .glyph') && idx.includes('html[data-theme="arkham"] .brand-txt b'));
ok('TOPBAR: arkham top bar is solid black with the glass blur killed',
   idx.includes('html[data-theme="arkham"] .top{ background:#060708 !important; backdrop-filter:none !important'));
ok('AI: Live Decision surfaced as a hero on the Insights view (#insDecision)',
   idx.includes('id="insDecision"') && idx.includes('AI Live Decision'));
ok('AI: decideNow targets the insights hero + button wired',
   idx.includes("decideNow('insDecision')") && idx.includes('insDecideBtn'));
ok('AI: decideNow generalized to any container', idx.includes("typeof outId==='string'?outId:'decideOut'"));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
