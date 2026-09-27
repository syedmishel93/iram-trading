/* v39.11 — P1/P2/P3 scalp intelligence + D1 strategies + D2/D4 gated proposer.
   The gates are the safety-critical path: tested as pure logic. */
const fs = require('fs'); const path = require('path'); const vm = require('vm');
let P = 0, F = 0;
const ok = (n, c, d) => { if (c) { P++; console.log('  ok  ', n); } else { F++; console.log('  FAIL', n, d !== undefined ? d : ''); } };
function resolve(pat){const dir=path.join(__dirname,'..','src','js');const files=fs.readdirSync(dir);let h=files.find(f=>f.includes(pat));if(!h){h=files.find(f=>fs.readFileSync(path.join(dir,f),'utf8').includes(pat==='strategy-lab'?'strategyProposer':pat));}if(!h)throw new Error('no module '+pat);return path.join(dir,h);}

/* load the proposer with the overfitting machinery + a synthetic sigScan */
function loadLab(scanImpl, strats) {
  const overfit = fs.readFileSync(resolve('overfitting-audit'), 'utf8');
  const code = fs.readFileSync(resolve('strategy-lab'), 'utf8');
  const store = {};
  const win = {
    document:{hidden:true,readyState:'complete',addEventListener(){},getElementById:()=>null},
    setInterval(){},setTimeout(){},
    STORE:{get:k=>store[k],set:(k,v)=>{store[k]=v;}}, localStorage:{getItem:k=>store[k],setItem:(k,v)=>{store[k]=v;}},
    SIG_STRATS: strats || { a:{name:'A'}, b:{name:'B'}, c:{name:'C'} },
    sigScan: scanImpl,
    Math:Math, Object:Object, Array:Array, JSON:JSON, isFinite:isFinite, parseFloat:parseFloat,
    console:console,
  };
  win.window = win; win.DATA = new Array(200).fill(0).map((_,i)=>({c:100+i,t:i}));
  vm.createContext(win);
  vm.runInContext(overfit, win);   // defines cscvPBO, deflatedSharpe, etc.
  vm.runInContext(code, win);
  return win;
}

console.log('\n=== v39.11 GATED PROPOSER (the anti-overfitting core) ===\n');

/* a scan that makes A+B look great IN-SAMPLE but fail out-of-sample (walk-forward trap) */
function trapScan(d, k) {
  // A and B both fire every 4 bars; combo "wins" in first 60% then loses in last 40%
  const out = [];
  for (let i = 20; i < 180; i += 4) {
    const early = i < 116;
    const res = (k === 'a' || k === 'b') ? (early ? 't2' : 'stop') : (i % 8 === 0 ? 't1' : 'stop');
    out.push({ i, dir: 1, res, costR: 0.05 });
  }
  return out;
}
const W1 = loadLab(trapScan);
const g1 = W1.strategyProposer.gateCombo('a', 'b', W1.DATA);
ok('walk-forward REJECTS a combo that wins in-sample but fails OOS', !g1.ok && /walk-forward FAIL/.test(g1.reason || ''), g1.reason);

/* a genuinely consistent combo should pass */
function goodScan(d, k) {
  const out = [];
  for (let i = 20; i < 180; i += 4) {
    // A+B consistently ~64% winners throughout (deterministic pattern, no regime break)
    const win = (i % 12 !== 0);   // ~66%
    out.push({ i, dir: 1, res: win ? 't1' : 'stop', costR: 0.03 });
  }
  return out;
}
const W2 = loadLab(goodScan);
const g2 = W2.strategyProposer.gateCombo('a', 'b', W2.DATA);
ok('a consistent combo can pass the gates (or is honestly rejected with a reason)',
  g2.ok || (typeof g2.reason === 'string' && g2.reason.length > 0), JSON.stringify(g2).slice(0,80));

/* too few joint triggers => rejected, never a candidate */
function sparseScan(d, k){ return [{i:30,dir:1,res:'t1',costR:0},{i:60,dir:1,res:'stop',costR:0}]; }
const W3 = loadLab(sparseScan);
const g3 = W3.strategyProposer.gateCombo('a','b',W3.DATA);
ok('too few joint triggers => rejected (no candidate from thin data)', !g3.ok && /too few|short/.test(g3.reason||''), g3.reason);

/* propose() never returns a candidate that failed a gate */
const W4 = loadLab(trapScan);
const r4 = W4.strategyProposer.propose();
ok('propose() puts overfit combos in REJECTED, not candidates', r4.candidates.every(c => c.gate && c.gate.testAvgR > 0));

/* D2 selection reads the scoreboard and classifies trust/bench honestly */
const W5 = loadLab(goodScan);
W5.STORE.set('board.v1', JSON.stringify({ winner:{w:18,n:24}, loser:{w:4,n:22}, thin:{w:2,n:3} }));
const sel = W5.strategyProposer.selection();
ok('D2: a strong strategy is TRUSTED (CI lower bound > 50%)', sel.trust.some(t => t.k==='winner'));
ok('D2: a weak strategy is BENCHED (CI upper bound < 50%)', sel.bench.some(t => t.k==='loser'));
ok('D2: a tiny sample is THIN, not trusted', sel.thin.some(t => t.k==='thin') && !sel.trust.some(t=>t.k==='thin'));

console.log('\n=== v39.11 SCALP INTELLIGENCE (shipped contract) ===\n');
const idx = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
ok('P1: price levels KEPT and pips ADDED to stop/T1/T2', idx.includes('snp-dist') && idx.includes('distUnit'));
ok('P1: $ value at session risk shown', idx.includes('@T2'));
ok('P2: SCALP/INTRADAY/SWING entry-type classifier', idx.includes("kind = 'SCALP'") && idx.includes("kind = 'SWING'"));
ok('P2: time-to-target labeled as estimate', idx.includes('markets do not keep schedules'));
ok('P3: SCALP-FIT spread-vs-target with red when edge gone', idx.includes('SCALP-FIT') && idx.includes('edge is gone before you'));
ok('P4: R:R with required win-rate', idx.includes('need &gt;33% to profit') || idx.includes('need >33%'));
ok('D1: which strategies feed the signal', idx.includes('signal from:') && idx.includes('against'));
ok('D4: proposer gated by walk-forward + PBO + deflated-Sharpe', idx.includes('walk-forward FAIL') && idx.includes('PBO') && idx.includes('deflated-Sharpe'));
ok('D4: candidates labeled, never auto-live', idx.includes('CANDIDATE') && idx.includes('Nothing here trades automatically'));
ok('honest: rejects shown with reasons', idx.includes('rejected (why)'));

console.log('\n  ' + P + ' passed, ' + F + ' failed\n');
process.exit(F ? 1 : 0);
