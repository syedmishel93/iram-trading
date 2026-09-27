/* v39.28 — smart-money synthesis (direction + intensity) + sniper flow line. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.28 FLOW SYNTHESIS ===\n');
ok('synthesis fn present (direction + intensity, exposes _ofSynth)', idx.includes('function ofSynth') && idx.includes('window._ofSynth'));
ok('intensity levels (sharp/moderate/mild)', idx.includes("'sharp'") && idx.includes("'moderate'") && idx.includes("'mild'"));
ok('reads sweeps/spoofs/stop-runs/CVD/absorption into the call',
   idx.includes("'buy sweep'") && idx.includes('bid spoof pulled') && idx.includes('reversal up') && idx.includes('CVD rising') && idx.includes('absorbed'));
ok('synthesis banner rendered (#l2Synth)', idx.includes('id="l2Synth"') && idx.includes("getElementById('l2Synth')"));
ok('sniper card shows the FLOW read', idx.includes('snp-flow') && idx.includes("window._ofSynth.dir!=='balanced'") && idx.includes('>FLOW: '));
ok('honest: labeled a lean, not a prediction', idx.includes('microstructure lean, not a prediction'));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
