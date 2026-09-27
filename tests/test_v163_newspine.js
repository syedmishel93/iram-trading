// v16.3 NEWS MARKERS + PINE EXPORT — tests against SHIPPED code
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name,kw){kw=kw||'function ';const i=src.indexOf(kw+name);if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
// PINE_MAP/PINE_DECL are const objects — grab to closing brace works
const bundle=['var '+grab('PINE_MAP=','const ').replace(/^const /,''),'var '+grab('PINE_DECL=','const ').replace(/^const /,'')]
  .concat(['pineTerm','pineCond','pineExport','newsMarkerIdx','newsParse'].map(n=>grab(n))).join('\n');
eval(bundle);
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// --- news time parsing ---
const feed=JSON.stringify({results:[
  {title:'CPI beats',published_at:'2026-07-01T12:00:00Z',url:'http://x'},
  {title:'no time headline'},
]});
const items=newsParse('news',feed);
ok(items.length===2&&Number.isFinite(items[0].t)&&items[0].t===Date.parse('2026-07-01T12:00:00Z'),'published_at parsed to epoch');
ok(items[1].t===null,'undated item gets t=null (never guessed)');
const cal=newsParse('calendar',JSON.stringify([{event:'FOMC',date:'2026-07-02T18:00:00Z',impact:'High'}]));
ok(cal[0].impact==='High'&&Number.isFinite(cal[0].t),'calendar keeps impact + time');

// --- marker bucketing ---
const vis=Array.from({length:100},(_,i)=>({t:1000000+i*3600000,c:1}));
let mk=newsMarkerIdx([{t:1000000+50*3600000+10},{t:1000000+50*3600000+20},{t:null},{t:999}],vis);
ok(mk.length===1&&mk[0].i===50&&mk[0].n===2,'two same-bar items merge into one marker n=2; null/out-of-range dropped');
mk=newsMarkerIdx([{t:1000000+3*3600000,impact:'High'}],vis);
ok(mk[0].hi===true,'high-impact flag survives to marker');
ok(newsMarkerIdx([],vis).length===0&&newsMarkerIdx([{t:5}],[]).length===0,'empty inputs \u2192 empty (no fabrication)');

// --- Pine export ---
const spec={name:'EMA cross',long:[['ema9','crossabove','ema20']],exitLong:[['ema9','crossbelow','ema20']],
  short:[['ema9','crossbelow','ema20']],exitShort:[['ema9','crossabove','ema20']],stop:{type:'atr',mult:2},tp:{type:'rr',value:2}};
let out=pineExport(spec,'EMA cross');
ok(out.complete===true&&out.unsupported.length===0,'fully supported spec \u2192 complete export');
ok(out.code.startsWith('//@version=5'),'Pine v5 header');
ok(out.code.includes('ta.crossover(ta.ema(close,9), ta.ema(close,20))'),'crossabove \u2192 ta.crossover with mapped EMAs');
ok(out.code.includes('strategy.entry("S", strategy.short)'),'short side emitted');
ok(out.code.includes('ta.atr(14)*2'),'ATR stop mult carried');
ok(out.code.includes('*2')&&out.code.includes('strategy.exit("XL"'),'R-multiple target wired into strategy.exit');

const spec2={name:'Flux',long:[['flux','>',0],['rsi','<',30]],exitLong:[['rsi','>',70]],stop:{type:'pct',value:1.5}};
out=pineExport(spec2,'Flux');
ok(out.complete===false&&out.unsupported.includes('flux'),'Mishel-custom var named as unsupported');
ok(out.code.includes('DROPPED (not approximated)'),'honesty note in script header');
const execLines=out.code.split('\n').filter(l=>!l.trim().startsWith('//')).map(l=>l.split('//')[0]);
ok(!execLines.some(l=>l.includes('flux')),'unsupported var never appears in executable code (comments only)');
const numRule=pineExport({name:'n',long:[['rsi','<',25]],exitLong:[['rsi','>',60]],stop:{type:'pct',value:1}},'n');
ok(numRule.code.includes('(ta.rsi(close,14) < 25)'),'numeric right-hand side passes through');

// stoch/macd decls only when used
out=pineExport({name:'m',long:[['macd','crossabove','macds']],exitLong:[['macdh','<',0]],stop:{type:'pct',value:1}},'m');
ok(out.code.includes('ta.macd(close,12,26,9)'),'macd trio declared once when used');
ok(!out.code.includes('ta.supertrend'),'unused decls not emitted');

// shipped UI
ok(src.includes('data-ind="news"')&&src.includes('id="pineBtn"'),'news chip + Pine button shipped');
console.log('\nv16.3 NEWS+PINE TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
