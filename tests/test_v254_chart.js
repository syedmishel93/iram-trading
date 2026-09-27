// v25.4 — TradingView-class chart: true fullscreen, floating toolbar, keyboard, gestures
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// F1 true fullscreen
ok((src.includes('.app.chart-max{grid-template-columns:0 1fr 0!important')
  && /\.app\.chart-max\{[^}]*grid-template-rows:0 0 1fr 0!important/.test(src))  /* v39.0: shell went 3 rows -> 4; behaviour unchanged. Row-count invariant is asserted once, properly, in test_v251_gridfix.js. */,'F1: fullscreen grid = chart only (top+status rows collapsed)');
ok(src.includes('.app.chart-max .top,.app.chart-max .status,.app.chart-max #status{display:none!important}'),'F1: top bar + status hidden in fullscreen');
ok(src.includes('requestFullscreen||document.documentElement.webkitRequestFullscreen'),'F1: real browser Fullscreen API (whole monitor)');
ok(src.includes("addEventListener('fullscreenchange'")&&src.includes('toggleMax(false)'),'F1: native Esc/exit syncs back to normal layout');

// F2 floating toolbar
ok(src.includes('id="fsToolbar"')&&src.includes('.app.chart-max #fsToolbar{display:flex}'),'F2: floating toolbar shows only in fullscreen');
ok(src.includes("['1m','5m','15m','1h','4h','1d']")&&src.includes('fstf'),'F2: TF buttons in the floating toolbar (proxy real tfBar)');
ok(src.includes('id="fsSym"')&&src.includes('id="fsExit"'),'F2: symbol + exit in toolbar');

// F3 + C6 gestures
ok(src.includes("addEventListener('dblclick'")&&src.includes('toggleMax()'),'F3: double-click chart toggles fullscreen');
ok(src.includes('x>RENDER.W-RENDER.padR')&&src.includes("barsFit');if(f)f.click()"),'C6: double-click price axis = reset zoom');

// C2 keyboard
ok(src.includes("if(k==='f'||k==='F'){ev.preventDefault();toggleMax()"),'C2: F key toggles fullscreen');
ok(src.includes("k==='+'||k==='='")&&src.includes("k==='-'||k==='_'"),'C2: +/- zoom keys');
ok(src.includes("k==='ArrowLeft'||k==='ArrowRight'")&&src.includes('VIEW.off'),'C2: arrow-key panning');
ok(src.includes("{'1':'1m','5':'5m','3':'15m','h':'1h','H':'1h','4':'4h','d':'1d','D':'1d','w':'1w'}"),'C2: quick timeframe keys (1/5/3/h/4/d/w)');
ok(src.includes("var typing=t&&(t.tagName==='INPUT'")&&src.includes('ev.metaKey||ev.ctrlKey||ev.altKey'),'C2: shortcuts guarded (never hijack typing or cmd/ctrl)');

// C7 letter -> symbol search
ok(src.includes("/^[a-z]$/i.test(k)")&&src.includes('window.openMsp(k)'),'C7: any letter opens symbol search pre-typed');
ok(src.includes('function openMsp(prefill)')&&src.includes('window.openMsp=openMsp'),'C7: openMsp exposed with prefill');

// C3 readout range%
ok(src.includes('Rng ${c.l?((c.h-c.l)/c.l*100).toFixed(2)'),'C3: hover readout adds candle range %');

ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=25.4,'version 25.4+');
console.log('\nv25.4 CHART POWER TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
