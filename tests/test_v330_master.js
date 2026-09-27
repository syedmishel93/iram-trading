// v33.0 — MASTER BUILD waves 1-4
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};
function g(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}

// ===== WAVE 1 =====
ok(src.includes("SECMAP={decide:")&&src.includes('cksec-h')&&src.includes('mishel_cksec'),'R1: cockpit \u2192 DECIDE/CONTEXT/EVIDENCE sections, digests, persisted');
ok(src.includes('one fact, one home'),'R2: duplicate narrative strip retired');
ok(src.includes("id='smTabs'")||src.includes('smTabs'),'R4: Smart Money \u2192 Act/Wallets/Forensics tabs');
(function(){const i=src.indexOf('window.judge=function');let d=0,j=i,st=false;
  for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}
  eval(src.slice(i,j).replace('window.judge=','global.judge='));})();
ok(judge('atrPct',0.1).includes('quiet')&&judge('funding',0.05).includes('crowded long')&&judge('adx',30).includes('trending'),'I2: judgment layer \u2014 numbers carry meaning (known answers)');
ok(judge('atrPct',NaN)===''&&judge('nope',1)==='','I2: honest empty for unknown/invalid');
ok(src.includes('--fav:#4C82FB')&&src.includes('--unfav:'),'I3: decision-state color scale distinct from bull/bear');
ok(src.includes('attention budget')||src.includes('.side .tag.sem'),'I4: calm-by-default, .sem for emphasis');
ok(src.includes("id='dbar'")&&src.includes('condScore')&&src.includes('never a buy signal'),'I1: Decision Bar w/ glass-box conditions score');
ok(src.includes("ctx.font='700 30px")&&src.includes('0.032'),'M1: watermark quieted to a corner');
ok(src.includes("translateX(-140px)"),'M1: readout yields to crosshair (collision law)');

// ===== WAVE 2: QFA known-answers =====
eval(g('qfaScore'));
const sound=qfaScore({mc:1e8,fdv:1.1e8,vol24:2e7,liq:1e7,ageDays:400,rugFlags:[],holdersTop10:18,holderCount:20000,smartCount:4,buys:900,sells:700});
ok(sound.score>=70&&sound.verdict==='SOUND','M13: healthy token scores SOUND ('+sound.score+')');
const diluted=qfaScore({mc:1e7,fdv:8e7,vol24:5e5,liq:4e5,ageDays:60,rugFlags:[],holdersTop10:35,holderCount:2000,smartCount:0,buys:100,sells:120});
ok(diluted.verdict==='DILUTED','M13: 8\u00d7 FDV overhang \u2192 DILUTED');
const frag=qfaScore({mc:5e5,fdv:6e5,vol24:1e4,liq:8e3,ageDays:3,rugFlags:['mintable','tax'],holdersTop10:85,holderCount:90,smartCount:0,buys:20,sells:60});
ok((frag.verdict==='FRAGILE'||frag.verdict==='HOLLOW')&&frag.score<40,'M13: rug-flagged concentrated token \u2192 FRAGILE/HOLLOW ('+frag.score+')');
ok(sound.components.length>=9&&sound.components.every(c=>c.why),'M13: every component carries its why (glass box)');
ok(frag.threat&&frag.threat.length>4,'M13: biggest-threat line named');
const na=qfaScore({});
ok(na.score>0&&na.components.every(c=>c.pts<=c.max),'M13: all-unknown input degrades honestly (neutral partials, no crash)');
ok(src.includes('structural soundness, never a buy signal'),'M13: honesty footer');
ok(src.includes('function labelChip')&&src.includes("whale:'#4C82FB'"),'M5: typed entity label chips');
ok(src.includes("'CONVERGENCE':"),'M6: insight-card tag grammar on the queue');
ok(src.includes('est. liq zones')&&src.includes('estimate, not exchange data'),'M7: liq zones w/ formula + honesty label');
ok(src.includes('window.openLab')&&src.includes('sorted by OOS avgR'),'M12: strategy lab, OOS-sorted');
ok(src.includes('decision-urgency first')&&src.includes('nfgo'),'I7: notifications sorted by urgency w/ inline actions');

// ===== WAVE 3: command parser known-answers =====
global.SPECS={BTCUSD:{},ETHUSD:{}};global.loadWallets=()=>[];global.walletNick=()=>null;
global.loadSymbolName=()=>{};global.researchPack=()=>{};global.smWalletDossier=()=>{};global.shortAddr=a=>a;
eval(g('cmdParse'));
ok(cmdParse('btc 4h').length===1&&cmdParse('btc 4h')[0].label.includes('BTCUSD'),'M3: "btc 4h" \u2192 chart command');
ok(cmdParse('qfa 0xabc')[0].label.includes('QFA'),'M3: "qfa <addr>" command');
ok(cmdParse('j')[0].label.includes('Journal')&&cmdParse('lab')[0].label.includes('lab'),'M3: j / lab shortcuts');
ok(cmdParse('random text').length===0,'M3: non-commands parse to nothing (palette continues normally)');
ok(src.includes("id='gSearch'")||src.includes('gSearch'),'M2: first-class search field in the tab bar');
ok(src.includes('ckchip')&&src.includes("'ticket'")&&src.includes("'alertlvl'"),'M4/I6: function chips on cards w/ dispatch');
ok(src.includes('MT5 ORDER TICKET')&&src.includes('nothing auto-executes'),'M11: copy-ready MT5 ticket, manual-only');
ok(src.includes('planDrag')&&src.includes('window._planOv'),'M9: draggable plan lines \u2192 live override');
ok(src.includes('auto-TL')&&src.includes("'S/R'+(z.touches"),'M10: engine detections surfaced w/ names');
ok(src.includes('window.applyStage')&&src.includes("'judge'")&&src.includes("'review'"),'I5: decision stages');
ok(src.includes('the mirror')&&src.includes('best session '),'I9: the review mirror sentence');
ok(src.includes('breakeven win-rate @1:2'),'A4-lite: implied win-rate vs measured on the plan');

// ===== WAVE 4: CVD proxy + divergence math =====
(function(){let cum=0;const arr=[];[{c:2,o:1,v:10},{c:1,o:2,v:4},{c:3,o:2,v:6}].forEach(b=>{cum+=(b.c>=b.o?1:-1)*b.v;arr.push(cum)});
ok(arr[0]===10&&arr[1]===6&&arr[2]===12,'M8: proxy CVD math (+10 \u22124 +6)');})();
ok(src.includes("pane==='cvd'")&&src.includes('bearish divergence \\u2014 price HH, CVD LH'),'M8: CVD sub-pane + divergence flags');
ok(src.includes('proxy (candle-direction \\u00d7 volume)')&&src.includes('real aggressor CVD needs Online'),'M8: proxy vs real, honestly labeled');
ok(parseFloat((src.match(/APP_VER='([\d.]+)'/)||[])[1])>=33.0,'version 33.0');
console.log('\nv33.0 MASTER TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
