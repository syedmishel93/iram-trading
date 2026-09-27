// v15.4 — SHIPPED-source tests: confluence narration + morning brief (deterministic text logic).
const fs=require('fs'),path=require('path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function grab(name){let m=html.match(new RegExp('\\nfunction '+name+'\\('));if(!m)throw new Error('missing '+name);
  let i=m.index+1,j=html.indexOf('{',i),d=0,k=j;for(;k<html.length;k++){if(html[k]==='{')d++;else if(html[k]==='}'){d--;if(d===0)break}}return html.slice(i,k+1)}
const src=['narrateConfluence','buildMorningBrief'].map(grab).join('\n');
const R=new Function(src+'\nreturn {narrateConfluence,buildMorningBrief};')();
let pass=0,fail=0;const ok=(c,m)=>{c?pass++:(fail++,console.log('  FAIL:',m))};

// narration structure + honesty
{const con={label:'STRONG BUY',score:42,confidence:78,votes:new Array(12),byCat:{trend:30,momentum:8,volume:4}};
 const ck={items:[{pass:true,txt:'a'},{pass:true,txt:'b'},{pass:false,txt:'over-extended'},{pass:true,txt:'d'},{pass:true,txt:'e'}],passed:4,total:5};
 const L=R.narrateConfluence(con,ck);
 ok(L.length>=4,'4+ ordered lines');
 ok(/\+42\/100/.test(L[0])&&/78%/.test(L[0]),'line 1 carries exact score+agreement');
 ok(/trend/.test(L[1])&&/agree/.test(L[1]),'line 2 names lead category, notes trend+momentum agreement');
 ok(L.some(l=>/over-extended/.test(l)),'failing gate surfaced by name');
 ok(/disciplined|stand aside|mixed/i.test(L[L.length-1]),'ends with a verdict');}
{const con={label:'SELL',score:-20,confidence:40,votes:new Array(10),byCat:{trend:-15,momentum:9,volume:-2}};
 const ck={items:[{pass:false,txt:'x'},{pass:false,txt:'y'},{pass:false,txt:'z'},{pass:true,txt:'k'},{pass:false,txt:'w'}],passed:1,total:5};
 const L=R.narrateConfluence(con,ck);
 ok(L.some(l=>/disagree.*chop/i.test(l)),'conflicting trend/momentum called out');
 ok(/emotional|stand aside/i.test(L[L.length-1]),'1/5 gates -> advises standing aside');}
ok(R.narrateConfluence(null)[0].indexOf('No consensus')===0,'null consensus -> honest line, no crash');

// morning brief content
{const txt=R.buildMorningBrief({sym:'BTCUSD',tf:'1h',price:'64123.50',con:{label:'BUY',score:18,confidence:64},
  regime:'LOW-VOL',session:'London',levels:{above:[{name:'PDH',p:'64500'}],below:[{name:'VWAP',p:'63800'}]},
  journal:{trades:34,win_rate_pct:56,expectancy_per_trade:12.4}});
 ok(/BTCUSD/.test(txt)&&/1h/.test(txt),'symbol+tf in header');
 ok(/64123.50/.test(txt)&&/LOW-VOL/.test(txt)&&/London/.test(txt),'price/regime/session present');
 ok(/BUY \(\+18, 64% agree\)/.test(txt),'consensus formatted exactly');
 ok(/Overhead: PDH 64500/.test(txt)&&/Support: VWAP 63800/.test(txt),'levels named');
 ok(/34 trades/.test(txt)&&/\$12.40/.test(txt),'journal edge with exact expectancy');
 ok(/not advice/.test(txt)&&/you execute at your broker/.test(txt),'honesty footer present');}
{const txt=R.buildMorningBrief({});ok(/MORNING BRIEF/.test(txt)&&/not advice/.test(txt),'empty ctx still safe + honest');}

console.log(`\nv15.4 AI DESK TESTS: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
