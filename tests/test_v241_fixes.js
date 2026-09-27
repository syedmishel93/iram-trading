// v24.1 — emoji fix, ranking redesign, whale-board remove, expand fix, hybrid rail, ⌘K
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// broken emoji escapes eliminated (the U0001f4b0 bug in the screenshot)
ok(!src.includes('\\U0001f'),'no invalid \\U0001f escapes remain (the "U0001f4b0 holdings" bug)');
ok(src.includes('\\u{1F4B0} dashboard'),'holdings button uses valid JS emoji \u2192 renders as \U0001F4B0');

// ranking table redesign
ok(src.includes('tier \\u00b7 evidence')||src.includes('wallet \\u00b7 tier'),'ranking header redesigned (tier + evidence + actions)');
ok(src.includes("x.s.tier+' '+x.s.score")&&src.includes('min-width:34px'),'ranking rows: tier badge, compact one-line layout');
ok(src.includes('\\u2605 track')&&src.includes('\\u{1F4B0} dashboard'),'clean action cluster: track + dashboard');

// whale board remove
ok(src.includes('class="tbtn wbremove"')&&src.includes('\\u2715 remove'),'whale board: remove/untrack button added');
ok(src.includes(".wbremove').forEach")&&src.includes('/svc/onchain/unwatch'),'remove wired: drops from list + tells service to unwatch');

// expand fix
ok(src.includes("app.style.gridTemplateColumns=''")&&src.includes("app.dataset.wasMax"),'C1/C3: expand clears inline grid so it toggles + restores');
ok(src.includes("chart-max')){return}"),'syncAppGrid respects chart-max (no fight on restore)');

// hybrid rail + favorites + ⌘K
ok(src.includes('.rail-grp::before')&&src.includes('background:color-mix(in srgb,var(--accent) 55%'),'hybrid rail: always-visible group accent tab');
ok(src.includes("fh.textContent='\\u2605 FAVORITES'"),'favorites group labeled + emphasized');
ok(src.includes('command palette')&&src.includes('rail-search'),'Cmd+K hint shown on rail search');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=24.1,'version 24.1+');
console.log('\nv24.1 FIX TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
