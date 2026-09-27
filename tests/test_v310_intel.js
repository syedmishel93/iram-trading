// v31.0 — INTELLIGENCE: C1/C2/C4/C5/C7 + E1/E2/E4/E5
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};
function g(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}

// pure engines
eval(g('sigStats'));eval(g('sigSessStats'));eval(g('sigStackStats'));eval(g('jrnResolve'));
// C1 session stats
const sigs=[{sess:'NY',res:'t1'},{sess:'NY',res:'stop'},{sess:'ASIA',res:'t2'},{sess:'ASIA',res:'open'}];
const ss=sigSessStats(sigs);
ok(ss.NY&&ss.NY.resolved===2&&Math.abs(ss.NY.winPct-0.5)<1e-9,'C1: per-session records measured (NY 50%)');
ok(ss.ASIA&&ss.ASIA.resolved===1&&ss.ASIA.winPct===1,'C1: ASIA measured independently');
// C2 stacked vs solo
const st2=sigStackStats([{stack:2,res:'t2'},{stack:3,res:'t1'},{stack:0,res:'stop'},{stack:1,res:'stop'}]);
ok(st2.stacked.winPct===1&&st2.solo.winPct===0&&st2.nStacked===2,'C2: stacked vs solo measured separately');
ok(src.includes("(sg.stack||0)>=2?' \\u25c9'"),'C2: \u25c9 badge on stacked flag pills');
ok(src.includes('best session:')&&src.includes('stacked('),'C1/C2: second legend line surfaces both');
// C4
ok(src.includes('mishel_sigmem')&&src.includes('had the best OOS record here'),'C4: per-symbol strategy memory + suggestion');
// C5
ok(src.includes('mishel_sigalerts')&&src.includes("'/svc/notify'")&&src.includes('Decision support \\u2014 you decide'),'C5: signal\u2192alert bridge w/ measured record in the message');
// C7 journal: resolution honesty — stop and target same scan, stop first
const e1={barT:0,dir:1,entry:100,stop:95,t1:105,t2:110};
ok(jrnResolve(e1,[{t:1,h:106,l:94,c:100}])==='stop','C7: stop-first conservative on ambiguous bar (same as engine)');
ok(jrnResolve(e1,[{t:1,h:104,l:98,c:103},{t:2,h:111,l:99,c:110}])==='t2','C7: clean run resolves to T2');
ok(src.includes('I took this')&&src.includes('YOUR record:'),'C7: took-this button + your-vs-system record');
// E1
ok(src.includes('@bookTicker')&&src.includes('@aggTrade')&&src.includes('CVD (session)'),'E1: spread + aggressor tape + CVD card');
ok(src.includes('j.m?-q:q'),'E1: CVD aggressor math (maker flag = sell aggressor)');
// E2
ok(src.includes('fapi.binance.com/fapi/v1/openInterest')&&src.includes('globalLongShortAccountRatio'),'E2: OI + long/short free endpoints');
ok(src.includes('short-covering rally')&&src.includes('new shorts pressing'),'E2: price/OI divergence flags');
// E4
ok(src.includes('Correlation')&&src.includes('doubling one bet'),'E4: correlation card w/ concentration warning');
// E5
ok(src.includes('economic calendar markers')&&src.includes("fillText('\\u{1F4C5}'"),'E5: event lines on the chart');
console.log('\nv31.0 INTELLIGENCE TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
