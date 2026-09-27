// v26.0 — right-side cockpit S1-S14
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// S1 plan: exercise planCalc logic in isolation
(function(){
  const i=src.indexOf('function planCalc(x)');ok(i>0,'S1: planCalc shipped');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}
  global.IND={_sw:{hi:[5],lo:[3]}};global.DATA=[];for(let k=0;k<10;k++)DATA.push({h:105+k,l:95+k,c:100+k});
  eval(src.slice(i,j));
  const pl=planCalc({price:109,atr:2,rep:{score:0.5}});
  ok(pl.dir==='LONG'&&pl.stop<109&&pl.t1>109&&pl.t2>pl.t1,'S1: long plan \u2014 stop below, T1<T2 above');
  ok(Math.abs((pl.t1-109)-(109-pl.stop))<1e-9,'S1: T1 is exactly 1R (glass-box math)');
  const ps=planCalc({price:109,atr:2,rep:{score:-0.5}});
  ok(ps.dir==='SHORT'&&ps.stop>109&&ps.t1<109,'S1: short plan mirrors correctly');
})();

// presence of every card
[['plan','Trade Plan'],['sizer','Position Size'],['levels','Key Levels'],['vol','Volatility & Regime'],
 ['session','Session Clock'],['xmkt','Cross-Market'],['news','Next Events'],['funding','Funding & Positioning'],
 ['smart','Smart Money'],['acc','Signal Accuracy'],['spark','Confluence Momentum'],['model','Model Verdict']]
 .forEach(c=>ok(src.includes(c[1]),'card shipped: S-'+c[0]+' ('+c[1]+')'));

// S12 Wilson CI + honesty
ok(src.includes('Wilson 95% interval')&&src.includes('context, not prediction'),'S12: honest Wilson CI framing');
// S13 collapse/drag/persist
ok(src.includes("mishel_cockpit")&&src.includes("draggable=\"true\"")&&src.includes('dragstart'),'S13: drag-reorder + persistence');
ok(src.includes("classList.toggle('closed')")&&src.includes('S2.closed[c.dataset.ck]'),'S13: collapse persisted per card');
// S14 width presets
ok(src.includes('mishel_sidew')&&src.includes("setProperty('--side-w'"),'S14: width presets persist + apply');
// honest empties
ok(src.includes('honest empty, never fake')&&src.includes('blank until fetched'),'honesty contract in cards (news, funding v31 wording)');
// hooks
ok(src.includes('window._fundRate=rate'),'funding exposed for S8');
ok(src.includes('window._lastFeedEvents=evts'),'feed events cached for S9');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=26.0,'version 26.0+');
console.log('\nv26.0 COCKPIT TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
