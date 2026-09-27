// v16.2 MEME PRO — tests against SHIPPED code
const fs=require('fs');
const src=fs.readFileSync(__dirname+'/../index.html','utf8');
function grab(name){const i=src.indexOf('function '+name+'(');if(i<0)throw new Error(name+' missing');
  let d=0,j=i,st=false;for(;j<src.length;j++){const c=src[j];if(c==='{'){d++;st=true}if(c==='}'){d--;if(st&&d===0){j++;break}}}return src.slice(i,j)}
eval(['buyLinks','oppScore','shortAddr'].map(grab).join('\n'));
let P=0,F=0;const ok=(c,m)=>{c?(P++,console.log('  '+m+' \u2713')):(F++,console.log('  '+m+' \u2717 FAIL'))};

// buyLinks: verified DEX per chain, address embedded
let L=buyLinks('solana','So1anaAddr111');
ok(L.length===2&&L[0].name==='Jupiter'&&L[0].url.includes('So1anaAddr111'),'solana \u2192 Jupiter+Raydium with address');
L=buyLinks('bsc','0xBSC');ok(L.length===1&&L[0].name==='PancakeSwap','bsc \u2192 PancakeSwap');
L=buyLinks('base','0xB');ok(L.length===1&&L[0].url.includes('chain=base'),'base \u2192 Uniswap chain param');
ok(buyLinks('weirdchain','0x1').length===0,'unknown chain \u2192 NO invented links (honest empty)');
ok(buyLinks('ethereum','').length===0,'no address \u2192 no links');

// oppScore: transparent, bounded, penalizes rug risk
const base={_mom:50,liq:100000,vol24:250000,buys:150,sells:100,ageH:48,_rug:{score:10}};
const good=oppScore(base);
ok(good.score>=60&&good.score<=100,'hot low-risk token scores \u226560 ('+good.score+')');
ok(good.verdict==='OPPORTUNITY'||good.verdict==='WATCH','verdict maps from score');
const rugish=oppScore({...base,_rug:{score:90}});
ok(rugish.score<good.score-20,'high rug-risk slashes score ('+good.score+'\u2192'+rugish.score+')');
ok(rugish.notes.some(n=>n.includes('rug-risk penalty')),'penalty is named in notes (glass box)');
const dead=oppScore({_mom:0,liq:50000,vol24:2000,buys:10,sells:30,ageH:24*90,_rug:{score:60}});
ok(dead.score<45&&dead.verdict==='PASS','dead mature token \u2192 PASS');
const fresh=oppScore({...base,ageH:2});
ok(fresh.notes.some(n=>n.includes('very new')),'sub-6h age flagged unproven, not rewarded');
ok([good,rugish,dead,fresh].every(o=>o.score>=0&&o.score<=100),'scores clamped 0-100');

// shortAddr
ok(shortAddr('0x1234567890abcdef1234')==='0x123456\u2026ef1234','address shortened middle-ellipsis');
ok(shortAddr('')==='\u2014','empty \u2192 em-dash');

// shipped UI hooks
ok(src.includes('class="tbtn memecopy"')&&src.includes('copy full address'),'copy-address button shipped');
ok(src.includes('memedoss-${idx}')&&src.includes('full safety dossier'),'per-row dossier hook shipped');
ok(src.includes('This terminal never executes trades'),'no-execution honesty line shipped');
ok(src.includes('async function buildDossier(addrArg,chainArg,outArg)'),'buildDossier param refactor shipped');
console.log('\nv16.2 MEME PRO TESTS: '+P+' passed, '+F+' failed');process.exit(F?1:0);
