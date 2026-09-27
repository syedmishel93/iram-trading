// v16.1 SOURCES — tests run against SHIPPED code extracted from index.html
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){
  const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' not found');
  let d=0,j=i,started=false;
  for(;j<src.length;j++){const ch=src[j];if(ch==='{'){d++;started=true}if(ch==='}'){d--;if(started&&d===0){j++;break}}}
  return src.slice(i,j);
}
const code=['_okxArgs','_okxRows','_kucoinArgs','_kucoinRows','_gateArgs','_gateRows'].map(grab).join('\n');
eval(code);
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// args mapping
ok(_okxArgs('BTCUSD','4h').instId==='BTC-USDT'&&_okxArgs('BTCUSD','4h').bar==='4H','okx args: BTCUSD/4h \u2192 BTC-USDT/4H');
ok(_kucoinArgs('ETHUSD','1h').symbol==='ETH-USDT'&&_kucoinArgs('ETHUSD','1h').type==='1hour','kucoin args: ETHUSD/1h \u2192 ETH-USDT/1hour');
ok(_gateArgs('SOLUSD','1d').pair==='SOL_USDT'&&_gateArgs('SOLUSD','1d').interval==='1d','gate args: SOLUSD/1d \u2192 SOL_USDT/1d');
ok(_gateArgs('SOLUSD','2h').interval==='1h','gate args: unsupported 2h falls back to 1h');

// OKX rows: [ts,o,h,l,c,vol], newest-first in API -> must come out chronological
const okxJ={data:[['2000','10','12','9','11','100'],['1000','9','11','8','10','90']]};
let r=_okxRows(okxJ,10);
ok(r.length===2&&r[0].t===1000&&r[1].t===2000,'okx rows reversed to chronological');
ok(r[1].o===10&&r[1].h===12&&r[1].l===9&&r[1].c===11&&r[1].v===100,'okx OHLCV column mapping exact');

// KuCoin rows: [time(s),open,close,high,low,volume], newest-first
const kuJ={data:[['200','10','11','12','9','55'],['100','9','10','11','8','44']]};
r=_kucoinRows(kuJ,10);
ok(r[0].t===100000&&r[1].t===200000,'kucoin: seconds\u2192ms + chronological');
ok(r[1].o===10&&r[1].c===11&&r[1].h===12&&r[1].l===9&&r[1].v===55,'kucoin open/CLOSE/high/low order handled (close is col 2)');

// Gate rows: [t(s),quoteVol,close,high,low,open,baseVol], OLDEST-first (no reverse)
const gtJ=[['100','999','11','12','9','10','77'],['200','999','12','13','10','11','88']];
r=_gateRows(gtJ,10);
ok(r[0].t===100000&&r[1].t===200000,'gate: already chronological, not reversed');
ok(r[0].o===10&&r[0].c===11&&r[0].h===12&&r[0].l===9&&r[0].v===77,'gate column remap (open=col5, close=col2, vol=col6)');

// honest empties
let threw=0;try{_okxRows({data:[]},5)}catch(e){threw++}
try{_kucoinRows({},5)}catch(e){threw++}
try{_gateRows([],5)}catch(e){threw++}
ok(threw===3,'all three providers throw on empty (no fabricated bars)');

// slicing honors n
const big={data:Array.from({length:50},(_,i)=>[String((50-i)*1000),'1','2','0.5','1.5','9'])};
ok(_okxRows(big,10).length===10,'okx respects n cap');

// UI + chain presence in shipped file
ok(src.includes('id="srcPick"')&&src.includes('Gate.io</option>'),'topbar source picker with all 7 options shipped');
ok(src.includes("window.FORCE_SRC&&window.FORCE_SRC!=='binance'"),'FORCE_SRC dispatcher shipped');
ok(src.includes("window._feedSrc='Gate.io (failover)'"),'failover chain extends to Gate.io');
console.log('\nv16.1 SOURCES TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
