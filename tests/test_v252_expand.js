// v25.2 — Expand fullscreen fix + ranking area rebuild
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// only ONE chart-max grid rule (the duplicate that broke layout is gone)
const maxRules=(src.match(/\.app\.chart-max\{grid-template/g)||[]).length;
ok(maxRules===1,'exactly one .app.chart-max grid rule (removed the conflicting duplicate) \u2014 found '+maxRules);
// v39.0 — third copy of the same pinned literal (v25.0, v25.1 and v25.2 each
// copy-pasted it). The shell went 3 rows -> 4; the behaviour did not change.
// The row-count invariant is asserted once, properly, in test_v251_gridfix.js.
ok(src.includes('.app.chart-max{grid-template-columns:0 1fr 0!important')
  && /\.app\.chart-max[^{]*\{[^}]*grid-template-rows:0 0? ?1fr 0!important/.test(src),
  'chart-max: chart-only grid (v25.4 true fullscreen)');

// Expand forces chart view first (fixes maximizing a non-chart view)
ok(src.includes("if(!document.getElementById('v-chart').classList.contains('on'))goView('chart')"),'Expand switches to chart view first (fullscreen is chart-only)');
// clears all inline grid so CSS wins
ok(src.includes("app.style.gridTemplateColumns='';app.style.gridTemplateRows='';app.style.gridTemplateAreas=''"),'toggleMax clears all inline grid overrides');
// v39.3 — syncAppGrid no longer writes inline grid styles AT ALL (that inline
// write was still computing a 216/74px column for the rail that died in v25,
// and it LOST to the v39 !important shell rule, which is exactly why the
// hide/show chevron went dead). It now moves one CSS variable. The INTENT of
// this assertion — chart-max is never fought by leftover inline styles — holds
// stronger than before: there are no inline grid styles to fight with.
ok(src.includes("setProperty('--side-w-live'")&&src.includes("appEl.style.gridTemplateColumns=''"),'syncAppGrid: one CSS variable, inline sediment cleared (chart-max unfought)');

// ranking rebuild: tighter rows
ok(src.includes('.smrank-tbl td{padding:6px 8px!important}'),'ranking rows tightened (less wasted vertical space)');
ok(src.includes('.smrank-tbl .tbtn{padding:3px 8px!important;font-size:10.5px!important}'),'ranking action buttons compacted');
ok(src.includes('.smrank-tbl tr:hover'),'ranking row hover feedback');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=25.2,'version 25.2+');
console.log('\nv25.2 EXPAND/RANKING TESTS: '+P+' passed, '+F+' failed');if(F)process.exit(1);

// v25.3 addendum — side panel explicitly hidden in chart-max (was auto-placing over the chart)
(function(){
const src2=require('fs').readFileSync(__dirname+'/../index.html','utf8');
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};
ok(src2.includes('.app.chart-max .side,.app.chart-max #side{display:none!important}'),'v25.3: side panel hidden in fullscreen (no grid area = was auto-placing over chart)');
ok(src2.includes('auto-places OVER the chart'),'root cause documented in the CSS');
ok(parseFloat((src2.match(/APP_VER='([\d.]+)'/)||[])[1])>=25.3,'version 25.3+');
console.log('v25.3 SIDE-FIX TESTS: '+p+' passed, '+f+' failed');
if(f)process.exit(1);
})();
