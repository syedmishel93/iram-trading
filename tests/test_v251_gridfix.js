// v25.1 — grid rows fix (chart was collapsing to blank) + self-check
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// the root cause: 4 grid areas needed 4 row heights
ok(src.includes('grid-template-rows:var(--top-h,52px) auto 1fr var(--status-h,30px)!important;grid-template-areas:"top top top" "tabbar tabbar tabbar"'),'grid-template-rows now defines the tabbar row (chart no longer collapses)');
// v39.0 — this pinned chart-max's literal row string. But the BUG v25.1 fixed was
// "4 grid areas needed 4 row heights", and a pinned string cannot see that. So assert
// the invariant itself, on every .app grid in the file: rows == area-rows, always.
// This now also covers .app.focusmode and .app.topmin, which the pin never did.
const grids=[...src.matchAll(/\.app[.\w-]*\{[^}]*grid-template-areas:([^;}]+)/g)];
ok(grids.length>=2,'found the .app grids that declare areas ('+grids.length+')');
let gridBad=[];
grids.forEach(m=>{
  const rule=m[0];
  const areaRows=(m[1].match(/"/g)||[]).length/2;
  const rowsDecl=(rule.match(/grid-template-rows:([^;}]+)/)||[])[1];
  if(!rowsDecl) return;
  const heights=rowsDecl.replace(/!important/g,'').trim().split(/\s+(?![^(]*\))/).length;
  if(heights!==areaRows) gridBad.push(rule.slice(0,40)+' -> '+heights+' heights vs '+areaRows+' area rows');
});
ok(gridBad.length===0,'every .app grid has one row height per area row (the v25.1 root cause)');
if(gridBad.length) console.log('       '+gridBad.join('\n       '));
ok(src.includes('.app:not(:has(#v-chart.on)){grid-template-columns:0 1fr 0!important;grid-template-rows:var(--top-h,52px) auto 1fr'),'non-chart views also get 4-row grid');

// self-check now validates tab bar not the hidden rail (fixes false "1 issue")
ok(src.includes("chk('top tab bar paints'")&&!src.includes("chk('sidebar rail paints'"),'boot self-check validates tab bar, not the hidden rail');

// tab bar still intact
ok(src.includes('<nav class="tabbar"')&&src.includes('#rail{display:none!important}'),'tab bar present, rail hidden');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=25.1,'version 25.1+');
console.log('\nv25.1 GRID FIX TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
