// v32.0 — WORKSPACE: D1-D4 + B4/B5 + A1/A7
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

ok(src.includes("gb.id='gridBtn'")&&src.includes("goView('multi')"),'D1: \u229e Grid quick-jump to the multi-chart view');
ok(src.includes('applyWorkspace')&&src.includes("'Scalping'")&&src.includes("'Review'"),'D2: workspace presets (scalping/research/review)');
ok(src.includes("hint:'Wallet'")&&src.includes("hint:'Workspace'")&&src.includes("hint:'Settings'"),'D3: palette gains wallets, workspaces, settings, actions');
ok(src.includes('window._notifs')&&src.includes('notifPanel')&&src.includes('mark read'),'D4: notification center logs every toast, read/unread');
ok(src.includes('_t0.apply(this,arguments)'),'D4: toast still fires normally (wrapper, not replacement)');
ok(src.includes('showKeys')&&src.includes('\\u2328 Keyboard'),'B4: shortcuts overlay (?)');
ok(src.includes("e.key==='/'")&&src.includes('openMsp'),'B4: / opens symbol search');
ok(src.includes('candle alert (B5)')&&src.includes('aVWAP anchor here'),'B5: candle right-click menu (alert / aVWAP / measure)');
ok(src.includes('--r-s:6px')&&src.includes('--fz-2:11px')&&src.includes('.tbtn{height:26px'),'A1: design tokens + unified control heights');
// v39.0 — the ★ was purged with the other 60 pictographs, but it carried real
// information: WHICH two themes are curated. A dingbat is a bad carrier for that
// (it cannot be themed, it renders per-OS). An <optgroup> is the right one, and it
// also tells the user what "legacy" means, which the star never did.
ok(/<optgroup label="Curated">[\s\S]*?institutional[\s\S]*?tradingview[\s\S]*?<\/optgroup>/.test(src)
  && src.includes('<optgroup label="Legacy">'),'A7: two curated themes grouped, rest legacy');
// keymap safety: no double-bound keys with the legacy handler
(function(){const i=src.indexOf("document.addEventListener('keydown',e=>{");const legacy=src.slice(i,i+1400);
  const mine=["'?'","'/'","'g'","'q'","'s'"];ok(mine.every(k=>!legacy.includes('e.key==='+k)),'B4: new shortcuts don\u2019t collide with the legacy keymap');})();
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=32.0,'version 32.0');
console.log('\nv32.0 WORKSPACE TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
