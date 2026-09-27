// v25.0 — top tab bar replaces rail, wiring, fullscreen, smart money quick-start
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// tab bar exists + replaces rail
ok(src.includes('<nav class="tabbar" id="tabbar"'),'top tab bar added');
ok(src.includes('#rail{display:none!important}'),'left rail hidden (replaced)');
ok(src.includes('grid-template-areas:"top top top" "tabbar tabbar tabbar" "main main side"'),'grid rebuilt: tabbar row, full-width main');
// the six tabs
['data-tab="chart"','data-tab="smart"','data-tab="discover"','data-tab="analysis"','data-tab="strategy"','data-tab="tools"'].forEach(t=>
  ok(src.includes(t),'tab present: '+t.replace('data-tab=','')));
// grouping
ok(src.includes('data-views="smart,intel"'),'Smart Money tab groups smart+intel');
ok(src.includes('data-views="insights,heatmap,screener,onchain,news"'),'Discover groups insights/heatmap/screener/onchain/news');

// wiring drives goView + subtabs
ok(src.includes('function syncTabBar')&&src.includes('syncTabBar(v)'),'view switches sync the active tab');
ok(src.includes('function showSubtabs')&&src.includes('.subtab'),'sub-tabs render for multi-view tabs');
ok(src.includes('.tab[data-views]').forEach!==undefined||src.includes(".tab[data-views]').forEach"),'tabs wired to goView');
ok(src.includes('VIEW_LABELS'),'view label map for sub-tabs');

// true fullscreen expand
// v39.0 — this pinned the literal areas string `"top top top" "main main main"`.
// The shell went from 3 rows to 4 (top / tabbar / main / status), so the areas
// string legitimately changed while the BEHAVIOUR did not. Assert the behaviour:
// rail + side collapsed to 0, tab bar hidden, main gets the whole width.
ok(src.includes('.app.chart-max{grid-template-columns:0 1fr 0!important')
  && /"main main main"/.test(src)
  && src.includes('.app.chart-max .tabbar{display:none}'),'Expand = true fullscreen (tab bar + side hidden)');

// smart money functional quick-start
ok(src.includes('id="smQuickStart"')&&src.includes('To get COPYABLE wallets'),'Smart Money quick-start guidance shown');
ok(src.includes('id="smGetCopyable"')&&src.includes('Get copyable wallets (EVM)'),'one-click EVM harvest button');
ok(src.includes("scanLaunches==='function')await scanLaunches()")&&src.includes('smMassHarvest'),'button scans EVM radars then harvests');

// ⌘K preserved
ok(src.includes('id="tabCmdK"'),'command palette entry in tab bar');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=25.0,'version 25.0+');
console.log('\nv25.0 TAB BAR TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
