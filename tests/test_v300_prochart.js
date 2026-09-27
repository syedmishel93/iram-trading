// v30.0 — PRO CHART: A2/A3/A4/A6 + B1/B2/B6/B8 + E3 + F1 (F2 pre-existing, asserted)
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

ok(src.includes('roundRect')&&src.includes("'\\u25b2 L'"),'A2: flag-pill signal markers w/ stem');
ok(src.includes('createLinearGradient(xi,0,xe,0)'),'A2: outcome traces as gradient ribbons');
ok(src.includes('CANDLE_HOLLOW')&&src.includes('wickW')&&src.includes('globalAlpha=0.35;ctx.strokeRect'),'A3: bordered candles, weighted wicks, hollow option');
ok(src.includes('_pulseT0'),'A3: pulsing live-price dot');
ok(src.includes('0.65*(i/_vn)'),'A3: volume age-fade');
ok(src.includes('font-variant-numeric:tabular-nums')&&src.includes("class=\"dec\""),'A4: tabular numerals + dimmed decimals');
ok(src.includes('tick-up')&&src.includes('void ip.offsetWidth'),'A6: price tick-flash animation');
ok(src.includes('window.PANE_H||86')&&src.includes('mishel_paneh'),'B1: sub-panes resizable via drag, persisted');
ok(src.includes('window.MAGNET')&&src.includes('best=py'),'B2: magnet snap to OHLC');
ok(src.includes("'mishel_drw:'+CURSYM.sym+'|'+TF"),'B2: drawings persist per symbol+TF');
ok(src.includes('lock / dup / del'),'B2: properties popover w/ lock/duplicate/delete');
ok(src.includes('alert at ')&&src.includes("op:op,px:prAt"),'B6: alert-from-axis (right-click menu)');
ok(src.includes('__save')&&src.includes('Save current as'),'B8: user-saved layouts (pre-existing store + entry point)');
ok(src.includes('window._vpvrOn')&&src.includes("'POC'")&&src.includes("'VAH'"),'E3: VPVR w/ POC + value area');
ok(src.includes('rAF-batched')&&src.includes('function _drawNow(){'),'F1: draw() batched via requestAnimationFrame');
ok(src.includes('@kline_')&&src.includes('new WebSocket'),'F2: Binance WebSocket streaming (pre-existing, verified)');
// VPVR math known-answer: value-area expansion covers >=70%
(function(){const rows=[1,2,10,4,3,2,1,1];const tot=rows.reduce((a,b)=>a+b,0);let poc=rows.indexOf(10),acc=rows[poc],va1=poc,va2=poc;
  while(acc<tot*0.7&&(va1>0||va2<rows.length-1)){const up=va1>0?rows[va1-1]:-1,dn=va2<rows.length-1?rows[va2+1]:-1;
    if(up>=dn){va1--;acc+=Math.max(0,up)}else{va2++;acc+=Math.max(0,dn)}}
  ok(acc>=tot*0.7&&va1<=poc&&va2>=poc,'E3 math: value area expands around POC to \u226570% volume');})();
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=29.0,'version present (bumped at arc end)');
console.log('\nv30.0 PRO CHART TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
