/* v39.27 — Smart-Money Flow detector (whales, sweeps, spoofs, stop-runs/inducement). */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.27 SMART-MONEY DETECTOR ===\n');
ok('panel mounted (#l2Smart + header)', idx.includes('id="l2Smart"') && idx.includes('SMART-MONEY FLOW DETECTOR'));
ok('whale prints: dedicated log + buy/sell tally', idx.includes('WHALE PRINTS') && idx.includes('whaleLog'));
ok('sweep detection (multi-level aggression)', idx.includes("'BUY SWEEP'") && idx.includes("'SELL SWEEP'") && idx.includes('sweepBuf'));
ok('spoof-pull detection (wall vanishes untraded)', idx.includes("'SPOOF PULL'") && idx.includes('possible spoof'));
ok('stop-run / inducement detection', idx.includes('STOP-RUN') && idx.includes('liquidity grab / inducement'));
ok('detectors wired into tape + book handlers', idx.includes('detectTape(m.data)') && idx.includes('detectBook(lastBids,lastAsks,lastBook)'));
ok('honest framing (heuristic, not certainty)', idx.includes('heuristic, from public L2'));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
