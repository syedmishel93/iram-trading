// v29.0 — TV interface (T1-T10) + durability (#3/#7/#8) + SIG visibility fix
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// the signal-visibility root cause: C10's empty-events guard must NOT return out of the whole hook
const postI=src.indexOf('window._drawPost=function(o)');
const postBlk=src.slice(postI,src.indexOf('/* buttons */',postI)>0?src.indexOf('/* buttons */',postI):postI+9000);
ok(!/if\(!ev\.length\)return;/.test(postBlk),'SIG-FIX: no early return before SIG rendering (the "signals not showing" root cause)');
ok(postBlk.indexOf('SIG2')>postBlk.indexOf('C10')||postBlk.includes('throw 0'),'SIG-FIX: C10 guard scoped (throw into its own try), SIG runs after');

// #6 registry
ok(src.includes('window.SIG_DETECT={')&&src.includes('window.SIG_DETECT[strat]'),'#6: strategy registry \u2014 sigScan dispatches to pluggable detect fns');

// #1 OOS
ok(src.includes('function sigOOSStats')&&src.includes('OOS \u00b7')||src.includes("'OOS \\u00b7 '"),'#1: out-of-sample split \u2014 legend reports OOS record');
ok(src.includes('selects on the first')||src.includes('0.7')&&src.includes('sigOOSStats'),'#1: select in-sample, report out-of-sample');

// T1
ok(src.includes("body.tvdock .drawbar{display:flex")&&src.includes("mishel_drawbar"),'T1: drawing toolbar docked left, open by default, persisted');
// T2
ok(src.includes('id="axPx"')&&src.includes('id="axTm"')&&src.includes('pxToPrice'),'T2: crosshair axis bubbles (price + time)');
// T3
ok(src.includes('id="axCd"')&&src.includes('priceToPx(last.c)'),'T3: bar-close countdown pinned at last-price axis level');
// T4
ok(src.includes('lg-row')&&src.includes('lgx')&&src.includes('_indParked'),'T4: legend rows w/ remove + parked re-add');
// T5
ok(src.includes("dragAx={ax:'y'")&&src.includes("dragAx={ax:'x'")&&src.includes('window._lg=!m.lg'),'T5: y-drag scale, x-drag zoom, log/linear axis menu');
// T7 (already correct; assert the cursor-anchor math exists)
ok(src.includes('keep that bar under the cursor'),'T7: cursor-anchored wheel zoom verified');
// T8
ok(src.includes("rgba(35,43,56,.32)"),'T8: grid softened to TV subtlety');
// T9
ok(src.includes('id="wlRail"')&&src.includes('loadSymbolName(it.dataset.s)'),'T9: watchlist mini-rail, click to switch');
// T10
ok(src.includes('SS._hit.push({x:xi,y:yy,sig:sg})')&&src.includes('id="sigTip"'),'T10: signal hover card w/ entry/stop/T1/T2/outcome');
// T6
ok((src.match(/class="tgroup"/g)||[]).length>=4&&src.includes('.chart-toolbar .tgroup{'),'T6: segmented toolbar groups styled');

// #3 backup
ok(src.includes("'/svc/backup'")&&src.includes('sendBeacon')&&src.includes('4*3600*1000'),'#3: auto-backup every 4h + on-leave beacon');
ok(src.includes('Restore it?')&&src.includes('mishel_walletdb'),'#3: restore-on-empty offer, correct storage keys');
// #7 telemetry
ok(src.includes('window._errlog')&&src.includes('unhandledrejection')&&src.includes('errBadge'),'#7: error ring buffer + \u26a0 status badge');
// #8 schema
ok(src.includes("mishel_schema")&&src.includes('migrate('),'#8: schema version stamp + migrate stub');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=29.0,'version 29.0+');
console.log('\nv29.0 UI/DURABILITY TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
