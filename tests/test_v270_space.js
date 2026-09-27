// v27.0 — space optimization V1-V9
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

ok(src.includes('.chart-toolbar.collapsed{flex-wrap:nowrap!important')&&src.includes('#indToggleGroup{margin-left:auto}'),'V1: Indicators stays inline \u2014 collapsed toolbar never wraps to a 2nd row');
ok(src.includes('body.compact #ohlcBar{top:8px')&&src.includes('font-size:10px'),'V2: floating OHLC overlay slimmed');
ok(src.includes('body.compact #ihPx{font-size:17px}')&&src.includes('body.compact #verTag{display:none}'),'V3: compact symbol header, version badge freed');
// v39.1 — stVer now lands in #stSlot (the injection landing zone), still inside
// the status bar. The old pin required the raw parent append, which was exactly
// the pattern that scattered chips loose across the bar.
ok(src.includes("v.id='stVer'")&&src.includes("(document.getElementById('stSlot')||_st).appendChild(v)"),'V3: version lives in the status bar (via the slot)');
ok(src.includes('body.compact .wtab{height:23px'),'V4: symbol tabs slimmed');
ok(src.includes('body.compact{--status-h:24px}'),'V5: status bar 24px');
ok(src.includes('#sideJump{display:none!important}'),'V6 (v27.1): broken sideJump chips removed \u2014 cockpit covers navigation');
ok(src.includes('body.compact .side .card{padding:10px 12px}')&&src.includes('body.compact #mtfSideBody table td'),'V7: right-panel cards + MTF grid tightened');
ok(src.includes("localStorage.getItem('mishel_sidew')){localStorage.setItem('mishel_sidew','300')"),'V8: chart-first \u2014 side defaults to narrow 300px (only if user never chose)');
ok(src.includes("_cmpct!=='0')document.body.classList.add('compact')"),'V9: compact ON by default, respects saved opt-out');
ok(src.includes('id="ckCompact"')&&src.includes("localStorage.setItem('mishel_compact'"),'V9: cockpit toggle persists');
const cnt=(src.match(/body\.compact/g)||[]).length;
ok(cnt>=15,'V9: all density rules scoped under body.compact ('+cnt+' rules) \u2014 one switch controls everything');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=27.1,'version 27.1+');
console.log('\nv27.0 SPACE TESTS: '+P+' passed, '+F+' failed');if(F)process.exit(1);

// v27.1 addendum — bigger candles by default
(function(){const src2=require('fs').readFileSync(__dirname+'/../index.html','utf8');
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};
ok(src2.includes('window.PANE_RATIO||0.82')&&src2.includes('window.PANE_RATIO||0.84'),'v27.1: price pane defaults to 82-84% of chart height (volume slimmed, drag still overrides)');
console.log('v27.1 ADDENDUM: '+p+' passed, '+f+' failed');if(f)process.exit(1);})();

// v27.2 addendum — S/A vanish fix + header merge
(function(){const src2=require('fs').readFileSync(__dirname+'/../index.html','utf8');
let p=0,f=0;const ok=(c,m)=>{c?(p++,console.log('  '+m+' \u2713')):(f++,console.log('  '+m+' \u2717 FAIL'))};
ok((src2.match(/renderTierControls\(filt,sortBy\)\+/g)||[]).length===3,'v27.2: filter chips render in ALL branches incl. empty (S/A no longer vanishes)');
ok(src2.includes('honest, not a bug')&&src2.includes('\\u2190 show all'),'v27.2: empty filter explains WHY + one-tap show-all');
ok(src2.includes('ws.appendChild(ih)')&&src2.includes('nodes keep their ids'),'v27.2: instrument header merged into tabs row (live ids intact)');
ok(src2.includes('body.compact #instHead{border-bottom:0')&&src2.includes('margin-left:auto'),'v27.2: merged header right-aligned, one row total');
ok(parseFloat((src2.match(/APP_VER='([\d.]+)'/)||[])[1])>=27.2,'version 27.2+');
console.log('v27.2 ADDENDUM: '+p+' passed, '+f+' failed');if(f)process.exit(1);})();
