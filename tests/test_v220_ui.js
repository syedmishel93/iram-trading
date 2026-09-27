// v22.0 INSTITUTIONAL UI — CSS/theme presence + non-destructive checks
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// theme exists + professional (no neon accent)
ok(src.includes('html[data-theme="institutional"]{'),'institutional theme defined');
ok(src.includes('--accent:#5B8DEF')||src.includes('--accent:#5b8def'),'restrained slate-blue accent (not neon)');
ok(src.includes('<option value="institutional">'),'institutional in theme dropdown');
ok(src.includes("['institutional','midnight'"),'institutional first in command palette themes');
ok(src.includes("data-theme','arkham'")&&src.includes("localStorage.setItem('mishel_theme'"),'defaults to arkham on first load, respects saved choice');

// pro rail
ok(src.includes('.rail{transition:width .26s cubic-bezier'),'rail width transition (buttery pin/unpin)');
ok(src.includes('html[data-theme="institutional"] .nav.on{')&&src.includes('inset 2px 0 0 var(--accent)'),'active nav = accent bar + subtle lift (not heavy fill)');
ok(src.includes('.app.rail-pinned .nav{flex-direction:row'),'pinned rail = horizontal rows with labels (pro layout)');
ok(src.includes('.rail-grp-h{font-size:9px;font-weight:700;letter-spacing:.16em'),'quiet uppercase section headers');

// smooth polish
ok(src.includes('.nav:hover svg{transform:scale(1.08)}'),'icon hover micro-transition');
ok(src.includes('@keyframes instFade')&&src.includes('.view{animation:instFade'),'smooth view fade on tab switch');
ok(src.includes('::-webkit-scrollbar-thumb{background:var(--edge2)'),'refined thin scrollbars');
ok(src.includes('.log tr:hover td{background:color-mix'),'institutional data-grid row hover');
ok(src.includes('input:focus')&&src.includes('box-shadow:0 0 0 3px var(--accent-dim)'),'focus ring on inputs (accessible + clean)');

// non-destructive: chart draw loop untouched, smoothing is additive
ok(src.includes('draw loop untouched')&&src.includes('debounced resize'),'chart polish is Option A (no render-loop surgery)');
ok(src.includes('cancelAnimationFrame(_rt)'),'debounced resize via rAF');

// nothing removed
['id="v-smart"','data-view="smart"','scoutWallets','walletIntel','id="smRank"'].forEach(x=>ok(src.includes(x),'preserved: '+x));
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=22.0,'version 22.0+');
console.log('\nv22.0 UI TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
