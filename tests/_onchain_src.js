function shortAddr(a){a=String(a||'');return a.length>12?a.slice(0,6)+'\u2026'+a.slice(-4):a}
function launchBand(ageH){return ageH==null?['?','']:ageH<6?['\u26a1 <6h','memehi']:ageH<24?['<24h','mememid']:ageH<72?['<3d','memelo']:['>3d','']}
function parseHolders(d){
  const hs=Array.isArray(d.holders)?d.holders:[];
  const rows=hs.map(x=>({addr:x.address||'',pct:(+x.percent||0)*100,tag:x.tag||'',isContract:x.is_contract==1,locked:x.is_locked==1})).sort((a,b)=>b.pct-a.pct);
  const top10=rows.slice(0,10).reduce((a,x)=>a+x.pct,0);
  const lpLocked=Array.isArray(d.lp_holders)?d.lp_holders.reduce((a,x)=>a+((x.is_locked==1)?(+x.percent||0):0),0)*100:null;
  return {rows,top10,lpLocked,holderCount:+d.holder_count||rows.length,
    honeypot:d.is_honeypot=='1'||d.cannot_sell_all=='1',buyTax:(+d.buy_tax||0)*100,sellTax:(+d.sell_tax||0)*100};
}
function normalizeTransfer(it,wallet){
  const w=(wallet||'').toLowerCase();
  const from=((it.from&&it.from.hash)||it.from||'').toLowerCase(),to=((it.to&&it.to.hash)||it.to||'').toLowerCase();
  const dir=to===w?'in':from===w?'out':'\u2014';
  const tok=it.token||{};const dec=+((it.total&&it.total.decimals)!=null?it.total.decimals:tok.decimals)||18;
  const raw=(it.total&&it.total.value!=null)?it.total.value:(it.value!=null?it.value:0);
  const amt=(+raw||0)/Math.pow(10,dec);
  return {time:it.timestamp||it.block_timestamp||'',token:tok.symbol||'?',name:tok.name||'',dir,amount:amt,counterparty:dir==='in'?from:to,hash:(it.tx_hash||it.transaction_hash||'')};
}
module.exports={shortAddr,launchBand,parseHolders,normalizeTransfer};
