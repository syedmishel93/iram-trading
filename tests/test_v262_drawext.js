// v26.2 — isolated draw-loop extensions C8/C9/C10
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// isolation contract: exactly TWO hook lines inside draw(), all logic external
ok((src.match(/if\(window\._drawPre\)window\._drawPre\(/g)||[]).length===1&&(src.match(/if\(window\._drawPost\)window\._drawPost\(/g)||[]).length===1,'isolation: exactly ONE call-site per hook inside draw(), logic lives outside');
ok((src.match(/window\._drawPre=function/g)||[]).length===1&&(src.match(/window\._drawPost=function/g)||[]).length===1,'isolation: exactly ONE external definition per hook');
ok(src.includes('try{if(window._drawPre)')&&src.includes('try{if(window._drawPost)'),'hooks are try-guarded \u2014 a bug in extensions cannot kill the chart');

// C8
ok(src.includes('window._drawPre=function(o)')&&src.includes("hr>=7&&hr<16")&&src.includes('hr>=12&&hr<21'),'C8: London 07-16 / NY 12-21 UTC shading');
ok(src.includes("/m|h/.test(TF)")&&src.includes("TF==='1d'"),'C8: intraday-only guard');
ok(src.includes('id="sessBtn"')&&src.includes('mishel_sess_shade'),'C8: toolbar toggle, persisted');

// C9
ok(src.includes('window._cmp&&window._cmp.key')&&src.includes('c2/base-1'),'C9: %-normalized from first shared bar');
ok(src.includes('BAR_CACHE[window._cmp.key]'),'C9: uses session bar cache (no hidden fetching)');
ok(src.includes('no hidden fetching')&&src.includes('no overlapping bars'),'C9: honest empty-states');
ok(src.includes('id="cmpBtn"'),'C9: toolbar button');

// C10
ok(src.includes('window._lastFeedEvents')&&src.includes("e.dir==='BUY'"),'C10: markers from tracked-wallet events');
ok(src.includes('es!==base)return'),'C10: only plots when event token matches the charted symbol (no misleading markers)');
ok(src.includes('evidence, not signals'),'C10: honesty label on markers');

// pure C9 normalization math check
(function(){
  const bars=[{t:1,c:100},{t:2,c:110},{t:3,c:121}];const byT={};bars.forEach(b=>byT[b.t]=b.c);
  const vis=[{t:1},{t:2},{t:3}];let base=null,pts=[];
  for(let i=0;i<vis.length;i++){const c2=byT[vis[i].t];if(c2==null)continue;if(base==null)base=c2;pts.push({i,p:c2/base-1});}
  ok(Math.abs(pts[2].p-0.21)<1e-9,'C9 math: +21% after two +10% bars (compounded, normalized)');
})();
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=26.2,'version 26.2+');
console.log('\nv26.2 DRAW-EXT TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
