// v14.4 — on-chain helpers tested against SHIPPED functions (extracted from index.html).
const {shortAddr,launchBand,parseHolders,normalizeTransfer}=require('./_onchain_src.js');
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m));};
ok(shortAddr('0x1234567890abcdef1234')==='0x1234\u2026'+'1234','shortAddr truncates');
ok(launchBand(2)[0].includes('<6h')&&launchBand(12)[0]==='<24h'&&launchBand(48)[0]==='<3d'&&launchBand(200)[0]==='>3d'&&launchBand(null)[0]==='?','launchBand bands');
const gp={holder_count:'1234',is_honeypot:'0',buy_tax:'0.01',sell_tax:'0.12',holders:[{address:'0xaaa',percent:'0.35'},{address:'0xbbb',percent:'0.15',is_locked:1,tag:'team'},{address:'0xccc',percent:'0.05',is_contract:1}],lp_holders:[{address:'0xlp1',percent:'0.6',is_locked:1},{address:'0xlp2',percent:'0.2',is_locked:0}]};
const hi=parseHolders(gp);
ok(hi.rows[0].pct===35&&Math.abs(hi.top10-55)<1e-9&&Math.abs(hi.lpLocked-60)<1e-9,'parseHolders %/top10/lpLocked');
ok(hi.holderCount===1234&&hi.sellTax===12&&hi.buyTax===1,'holderCount + taxes scaled');
ok(hi.rows[1].locked===true&&hi.rows[1].tag==='team','holder flags');
ok(parseHolders({}).rows.length===0&&parseHolders({}).top10===0,'parseHolders empty safe');
const w='0xWALLETaddress';
const tIn=normalizeTransfer({from:{hash:'0xSender'},to:{hash:w.toUpperCase()},token:{symbol:'PEPE',decimals:'18'},total:{value:'2500000000000000000',decimals:'18'},timestamp:'2026-07-09T12:00:00Z'},w);
ok(tIn.dir==='in'&&Math.abs(tIn.amount-2.5)<1e-9&&tIn.counterparty==='0xsender','transfer IN decoded');
const tOut=normalizeTransfer({from:{hash:w},to:{hash:'0xRecv'},token:{symbol:'USDC',decimals:'6'},total:{value:'1500000',decimals:'6'}},w);
ok(tOut.dir==='out'&&Math.abs(tOut.amount-1.5)<1e-9&&tOut.counterparty==='0xrecv','transfer OUT decoded (6-dec)');
ok(normalizeTransfer({from:{hash:'0xA'},to:{hash:'0xB'},token:{decimals:'18'},value:'0'},w).dir==='\u2014','unrelated -> neutral');
console.log(`\nON-CHAIN HELPERS: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
