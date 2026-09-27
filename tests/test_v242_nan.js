// v24.2 — confluence NaN hardening (the "Strong Sell NaN / score NaN±NaN" bug)
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
global.CATW={trend:1,momentum:1,volatility:1,structure:1,volume:1};
eval(grab('confluence'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// clean signals \u2192 finite score
let r=confluence([
  {source:'RSI',category:'momentum',dv:1,strength:0.8,weight:1,reason:'x',dirLabel:'up'},
  {source:'MACD',category:'momentum',dv:-1,strength:0.5,weight:1,reason:'y',dirLabel:'dn'}]);
ok(Number.isFinite(r.score)&&Number.isFinite(r.conf),'clean signals \u2192 finite score + agreement');

// NaN in a signal \u2192 still finite (the actual bug)
r=confluence([
  {source:'RSI',category:'momentum',dv:NaN,strength:0.8,weight:1,reason:'x',dirLabel:'up'},
  {source:'MACD',category:'momentum',dv:-1,strength:NaN,weight:1,reason:'y',dirLabel:'dn'},
  {source:'EMA',category:'trend',dv:1,strength:0.5,weight:NaN,reason:'z',dirLabel:'up'}]);
ok(Number.isFinite(r.score),'NaN dv/strength/weight \u2192 score still finite (NOT NaN)');
ok(Number.isFinite(r.conf),'NaN inputs \u2192 agreement still finite');
ok(r.score.toFixed(2)!=='NaN','score.toFixed() never yields "NaN" string');

// all-NaN \u2192 neutral 0, not NaN
r=confluence([{source:'X',category:'trend',dv:NaN,strength:NaN,weight:NaN,reason:'',dirLabel:''}]);
ok(r.score===0,'all-NaN signals \u2192 neutral 0 (honest), not NaN');

// empty \u2192 0
ok(confluence([]).score===0,'no signals \u2192 0, not NaN');

// shipped guards
ok(src.includes('Number.isFinite(contrib)')&&src.includes('sanitize'),'confluence sanitizes signal contributions');
ok(src.includes('not enough clean signal data on this feed to test robustness'),'robustness shows honest blank when score non-finite (no NaN\u00b1NaN)');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=24.2,'version 24.2+');
console.log('\nv24.2 NaN TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
