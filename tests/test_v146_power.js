const {collectConfig,applyConfig,attributeConsensus,explainBacktest,holderDelta,sessionOf}=require("./_v146_src.js");
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m));};

// --- F8 config round-trip ---
function mockStore(init){const m={...init};return {get length(){return Object.keys(m).length},key(i){return Object.keys(m)[i]},getItem(k){return k in m?m[k]:null},setItem(k,v){m[k]=String(v)},_dump(){return m}};}
const A=mockStore({mishel_theme:'frost',mishel_guard:'0',mishel_wallets:'[]',other_key:'ignore'});
const cfg=collectConfig(A);
ok(Object.keys(cfg.keys).length===3&&cfg.keys.mishel_theme==='frost','collectConfig grabs only mishel_* keys');
ok(!('other_key' in cfg.keys),'collectConfig ignores non-mishel keys');
const B=mockStore({});
const n=applyConfig(cfg,B);
ok(n===3&&B.getItem('mishel_theme')==='frost'&&B.getItem('mishel_guard')==='0','applyConfig restores round-trip');
ok(applyConfig({bad:1},B)===0,'applyConfig handles malformed input safely');

// --- F4 attribution ---
const con={score:0,votes:[
  {name:'EMA',cat:'trend',vote:1,w:1.2},{name:'RSI',cat:'momentum',vote:1,w:1.0},
  {name:'Boll',cat:'volatility',vote:-1,w:0.8},{name:'Vol',cat:'volume',vote:0,w:0.9}]};
const attr=attributeConsensus(con);
ok(attr.length===4,'attribution returns all votes');
ok(attr[0].contribution!==0,'top contributor is nonzero');
const ema=attr.find(a=>a.name==='EMA'),boll=attr.find(a=>a.name==='Boll'),vol=attr.find(a=>a.name==='Vol');
ok(ema.contribution>0,'bullish vote (EMA) contributes positively to score');
ok(boll.contribution<0,'bearish vote (Boll) contributes negatively');
ok(vol.contribution===0,'neutral vote contributes exactly 0');
{const total=attr.reduce((a,x)=>a+x.contribution,0);ok(Math.abs(total-35.9)<0.5,'contributions sum to score ('+total.toFixed(1)+' ~ 35.9)');}
ok(attributeConsensus({votes:[]}).length===0 && attributeConsensus(null).length===0,'attribution empty-safe');
// sorted by |contribution| desc
ok(Math.abs(attr[0].contribution)>=Math.abs(attr[attr.length-1].contribution),'sorted by magnitude');

// --- F7 explainer ---
const good=explainBacktest({trades:120,pf:1.8,sharpe:1.2,psr:0.95,ror:0.03,mdd:18,oosR:5,isR:8});
ok(good.verdict[0].startsWith('Promising')&&good.strong.length>=3&&good.weak.length===0,'strong system -> Promising');
const bad=explainBacktest({trades:60,pf:0.8,sharpe:0.1,psr:0.4,ror:0.35,mdd:55,oosR:-3,isR:6});
ok(bad.verdict[0].startsWith('Weak')&&bad.weak.length>=3,'poor system -> Weak');
const thin=explainBacktest({trades:5,pf:2.0,sharpe:1.5});
ok(thin.verdict[0].startsWith('Insufficient')&&thin.notes.length>=1,'thin data -> Insufficient evidence');
ok(explainBacktest({}).verdict!=null,'explainer handles empty input');

// --- F3 holder delta ---
ok(holderDelta(40,55)===15,'holderDelta positive');
ok(holderDelta(60,50)===-10,'holderDelta negative');
ok(holderDelta(null,50)===null&&holderDelta(50,null)===null,'holderDelta null-safe');

// --- F2 sessions ---
ok(JSON.stringify(sessionOf(3))==='["asia"]','03:00 UTC -> asia');
ok(sessionOf(8).includes('asia')&&sessionOf(8).includes('london'),'08:00 UTC -> asia+london overlap');
ok(sessionOf(13).includes('london')&&sessionOf(13).includes('ny'),'13:00 UTC -> london+ny overlap');
ok(sessionOf(22).length===0,'22:00 UTC -> no major session');
ok(JSON.stringify(sessionOf(27))==='["asia"]','hour wraps (27 -> 3 -> asia)');

console.log(`\nv14.6 PURE LOGIC: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
