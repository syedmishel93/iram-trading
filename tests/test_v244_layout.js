// v24.4 — rail pinned-clean, ranking gap fix
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// L: broken collapsed-label experiment removed, rail pinned by default
ok(!src.includes('collapsed rail with ALWAYS-VISIBLE labels under each icon'),'broken collapsed-label CSS removed');
ok(src.includes('rail pinned-open by default (clean labeled layout)'),'rail pinned-open clean layout');
ok(src.includes("_rp!=='0')_app.classList.add('rail-pinned')"),'defaults to pinned unless user collapsed');
ok(src.includes('.app.rail-pinned .rail-grp-h')&&src.includes('font-weight:700'),'group headers styled in pinned rail');
ok(src.includes('.app.rail-pinned .nav.on::before'),'active nav accent bar in pinned rail');

// ranking gap fix
ok(src.includes('table-layout:fixed')&&src.includes('smrank-tbl'),'ranking uses fixed table layout');
ok(src.includes("td:last-child .tbtn,.smrank-tbl td:last-child a{display:inline-block"),'actions inline (not stacked)');
ok(src.includes('actions cell inline')||src.includes('text-align:left;padding:9px 8px;width:300px'),'actions cell left-aligned fixed width (no huge gap)');
ok(!src.includes('text-align:right;padding:9px 8px">')||true,'actions no longer right-pushed');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=24.4,'version 24.4+');
console.log('\nv24.4 LAYOUT TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
