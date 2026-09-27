// v14.3 — meme radar scoring tested against SHIPPED functions (extracted from index.html).
const {memeMomentum,memeRug,rugBand}=require('./_meme_src.js');
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m));};
ok(memeMomentum({})>=0,'momentum handles empty');
ok(memeMomentum({liq:5e5,vol24:15e5,chg24:45,buys:900,sells:200})>memeMomentum({liq:5e4,vol24:2e4,chg24:2,buys:50,sells:50}),'active+rising > quiet');
ok(memeMomentum({liq:1,vol24:1e9,chg24:1000,buys:1e6,sells:0})<=100,'momentum <=100');
ok(memeRug({liq:8e5,fdv:2e6,vol24:4e5,ageH:2000,hasSocials:true}).score<25,'clean -> Lower');
ok(memeRug({liq:3000,fdv:5e6,vol24:9e4,ageH:2,hasSocials:false}).score>=50,'sketchy -> High+');
const hp=memeRug({liq:1e5,fdv:2e5,vol24:5e4,ageH:500,hasSocials:true},{honeypot:true});
ok(hp.score>=75&&rugBand(hp.score)[0]==='EXTREME','honeypot -> EXTREME');
ok(hp.notes.some(n=>/honeypot/i.test(n)),'honeypot noted');
const cs=memeRug({liq:2e5,fdv:4e5,vol24:5e4,ageH:500,hasSocials:true},{honeypot:false,buyTax:1,sellTax:1,lpLocked:90,top10:20,mintable:false,openSource:true});
ok(memeRug({liq:2e5,fdv:4e5,vol24:5e4,ageH:500,hasSocials:true},{honeypot:false,buyTax:1,sellTax:35,lpLocked:90,top10:20}).score>cs.score,'high tax raises risk');
ok(memeRug({liq:2e5,fdv:4e5,vol24:5e4,ageH:500,hasSocials:true},{honeypot:false,lpLocked:10,top10:70,mintable:true,openSource:false}).score>cs.score,'unlocked LP+concentration raise risk');
for(const s of [0,24,25,49,50,74,75,100]) ok(rugBand(s)&&rugBand(s).length===2,'rugBand @'+s);
ok(memeRug({}).score>=0&&memeRug({}).score<=100,'rug bounded');
console.log(`\nMEME RADAR SCORING: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
