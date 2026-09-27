/* v39.26 — depth-ladder analytics, news-marker fix, chart memo, card consolidation. */
const fs = require('fs');
const idx = fs.readFileSync(__dirname + '/../index.html', 'utf8');
let P = 0, F = 0;
const ok = (m, c) => { c ? (P++, console.log('  ' + m + ' \u2713')) : (F++, console.log('  ' + m + ' \u2717 FAIL')); };
console.log('\n=== v39.26 BATCH ===\n');
ok('#4 liquidity map (persistent walls)', idx.includes('LIQUIDITY MAP (persistent walls)') && idx.includes('wallHist'));
ok('#5 CVD divergence detector', idx.includes('CVD DIVERGENCE') && idx.includes('BEARISH divergence') && idx.includes('cvdSeries'));
ok('#6 positioning (funding/OI/LS)', idx.includes('POSITIONING') && idx.includes('_fundRate') && idx.includes('_lsRatio'));
ok('#7 book-walk slippage/impact', idx.includes('BOOK-WALK') && idx.includes('function walk'));
ok('#8 large-print tape highlight', idx.includes('_big=_vs[') && idx.includes('font-weight:800'));
ok('#1 news markers: combined+capped (no wall)', idx.includes('_macroCal||[]).map') && idx.includes('.slice(0,10)') && idx.includes('never wall up'));
ok('#2 chart: axisHeatBuckets memoized', idx.includes('axisHeatBuckets._c') && idx.includes('recompute only when the view actually changes'));
ok('#2 chart: clean startup overlays retained', idx.includes("const ON=new Set(['ema20','ema50','ema200','sr'])"));
ok('#3 cards: AI Vision hidden unless LLM on', idx.includes('omit the card entirely until the LLM is enabled'));
ok('#3 cards: collapsible side cards (persisted)', idx.includes('COLLAPSIBLE SIDE CARDS') && idx.includes('iram_collapsed'));
console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
if (F) process.exit(1);
