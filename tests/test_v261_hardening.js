// v26.1 — H6 collision linter + client hardening
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// H6a: no duplicate grid rules for critical selectors (the exact bug class of v25.2)
['.app.chart-max{','.app.focusmode{'].forEach(sel=>{
  const n=(src.split(sel).length-1);
  ok(n<=1,'H6: single definition of "'+sel+'" (found '+n+') \u2014 duplicates caused the v25.2 scramble');
});
// H6b: every grid-template-areas row-count matches its grid-template-rows value-count (the v25.0 blank-chart bug)
let mism=0;const re=/grid-template-rows:([^;!]+)!?[^;]*;grid-template-areas:((?:"[^"]*"\s*)+)/g;let m;
while((m=re.exec(src))){
  const rows=m[1].trim().split(/\s+/).filter(x=>x&&!x.startsWith('var(')||x.startsWith('var(')).length;
  const areas=(m[2].match(/"/g)||[]).length/2;
  if(rows!==areas)mism++;
}
ok(mism===0,'H6: grid rows-count matches areas-count everywhere ('+mism+' mismatches) \u2014 the v25.0 blank-chart bug class');
// H6c: no duplicate top-level const declarations in the main script
{const main=fs.readFileSync('/tmp/main.js','utf8');
 const names={};let d=0;const rx=/^const\s+([A-Za-z_$][\w$]*)\s*=/gm;let mm;
 while((mm=rx.exec(main))){if(names[mm[1]])d++;names[mm[1]]=1;}
 ok(d===0,'H6: zero duplicate top-level const names ('+d+' dupes) \u2014 the _mean/_std collision class');}

// client hardening
ok(src.includes("X-Mishel-Token")&&src.includes("mishel_svc_token"),'H1: client attaches service token to every /svc call');
ok(src.includes('loopStaleBanner')&&src.includes('stale_loops'),'H2: stale-loop red banner polls /svc/health');
// v39.2 — the banner's wording changed BECAUSE the risk changed: loops now tick
// while sleeping (sleep_ticking), so a shown banner means a thread is GENUINELY
// hung, not "hourly loop mid-nap". The message names that: work has NOT happened.
ok(src.includes('its work has NOT been happening')||src.includes('silently not doing their job'),'H2: banner names the silent-failure risk');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=26.1,'version 26.1+');
console.log('\nv26.1 HARDENING TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
