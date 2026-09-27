// v22.1 — theme persistence, chart maximize, wallet portfolio summary
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(grab('portfolioSummary'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// theme fix
ok(src.includes("localStorage.setItem('mishel_theme',name)"),'G1: applyTheme now PERSISTS the choice (the real bug)');
ok(src.includes("theme applies on EVERY load")&&src.includes("data-theme','arkham')"),'G1: theme applied at startup (saved or arkham default)');
ok(!src.includes("localStorage.getItem('mishel_theme_seen')"),'fragile theme_seen gate removed');

// chart maximize
ok(src.includes('id="chartMax"')&&src.includes('Expand'),'G2: TradingView-style Expand button in chart toolbar');
ok(src.includes('.app.chart-max{grid-template-columns:0 1fr 0!important'),'G2: maximize collapses rail + side panel');
ok(src.includes("ev.key==='Escape'")&&src.includes('chart-max'),'G2: Esc restores from maximized');
ok(src.includes('setTimeout(function(){try{if(typeof draw==')&&src.includes('280'),'G2: redraws chart after maximize transition');

// portfolio summary (P: what they hold/buy/sell)
let ps=portfolioSummary([{dir:'in',token:'PEPE'},{dir:'in',token:'PEPE'},{dir:'in',token:'WIF'},{dir:'out',token:'PEPE'}]);
ok(ps.buys===3&&ps.sells===1&&ps.buyPct===75,'portfolio: buy/sell counts + buy% correct');
ok(ps.bias==='net ACCUMULATING','75% buys \u2192 net ACCUMULATING');
ok(ps.topToken==='PEPE'&&ps.topCount===3,'most-active token identified');
ps=portfolioSummary([{direction:'SELL',sym:'X'},{direction:'SELL',sym:'X'},{direction:'BUY',sym:'X'}]);
ok(ps.bias==='net DISTRIBUTING','mostly sells \u2192 net DISTRIBUTING');
ok(portfolioSummary([])===null,'no events \u2192 null (no fake summary)');
ok(src.includes('net ACCUMULATING')&&src.includes('most active:'),'summary strip rendered in dossier');
ok(src.includes('\\u{1F4B0} dashboard')||src.includes('holdings'),'G3: dossier button surfaces holdings/dashboard (what they hold)');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=22.1,'version 22.1+');
console.log('\nv22.1 FIX TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
