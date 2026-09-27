// v32.1 — F1-F7: boot integrity, root-cause header fix, TV toolbar, legend/tag/air
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

ok(src.includes("typeof GLR.begin==='function'"),'F1: GLR.begin guarded \u2014 the every-frame throw class killed');
ok(src.includes("kind:'draw'")&&src.includes('_lastDrawErr'),'F1: draw-loop errors feed the \u26a0 telemetry (throttled)');
ok(src.includes('BOOT INTEGRITY')&&src.includes('tab bar unpainted'),'F1/F2: visible boot-integrity gate w/ self-heal');
ok(src.includes('ROOT-CAUSE FIX')&&src.includes('window._ihNode&&document.body.classList')&&src.includes('bar.appendChild(window._ihNode)'),'F2 ROOT CAUSE: instHead detached before innerHTML rebuild, re-appended after \u2014 chips can\u2019t vanish');
ok(src.includes('.chart-toolbar{flex-wrap:nowrap!important')&&src.includes('border:1px solid transparent'),'F3: ghost icon toolbar, one row guaranteed');
ok(src.includes('id="tbOverflow"')||src.includes("of.id='tbOverflow'"),'F3: \u22ef overflow menu exists');
ok(src.includes("['replayBtn','cmpBtn','wlBtn','jrnBtn','layoutSel','barCtl']"),'F3: secondary controls relocated to overflow (v33: + bars widget)');
ok(src.includes('tsep'),'F3: group separators');
ok(src.includes('two-line button disease'),'F4: global nowrap discipline');
ok(src.includes('legend lives top-left'),'F5: SIG legend anchored top-left (TV-style)');
ok(src.includes('fused under the last-price tag'),'F6: price+countdown as one axis tag');
ok(src.includes('.ih-chip{border-color:transparent')&&src.includes('.wtab{border-color:transparent'),'F7: air pass \u2014 hover borders instead of permanent boxes');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=32.1,'version 32.1');
console.log('\nv32.1 FIXPACK TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
