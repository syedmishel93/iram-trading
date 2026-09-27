function memeMomentum(p){
  const liq=+p.liq||0, vol=+p.vol24||0, chg=+p.chg24||0, buys=+p.buys||0, sells=+p.sells||0;
  const churn=liq>0?Math.min(3,vol/liq):0;
  const churnS=churn/3*35;
  const chgS=Math.max(0,Math.min(30,(chg/50)*30));
  const flow=(buys+sells)>0?buys/(buys+sells):0.5;
  const flowS=Math.max(0,Math.min(20,(flow-0.5)/0.5*20));
  const liqS=Math.min(15,Math.log10(Math.max(1,liq))/6*15);
  return Math.round(Math.max(0,Math.min(100,churnS+chgS+flowS+liqS)));
}
function memeRug(p,sec){
  let r=0;const notes=[];
  const liq=+p.liq||0, fdv=+p.fdv||0, vol=+p.vol24||0, ageH=p.ageH!=null?+p.ageH:999;
  if(liq<5000){r+=25;notes.push('very low liquidity (<$5k)')}
  else if(liq<25000){r+=12;notes.push('thin liquidity (<$25k)')}
  if(fdv>0&&liq>0){const flt=liq/fdv;if(flt<0.02){r+=15;notes.push('liquidity a tiny fraction of FDV')}else if(flt<0.05){r+=8;notes.push('low liquidity vs FDV')}}
  if(ageH<6){r+=15;notes.push('extremely new (<6h)')}else if(ageH<24){r+=8;notes.push('very new (<24h)')}
  if(liq>0&&vol/liq>10){r+=12;notes.push('churning >10\u00d7 liquidity in 24h')}
  if(!p.hasSocials){r+=6;notes.push('no listed socials/website')}
  if(sec){
    if(sec.honeypot){r+=45;notes.push('flagged HONEYPOT \u2014 sells may be blocked')}
    const bt=+sec.buyTax||0,st=+sec.sellTax||0;
    if(st>30||bt>30){r+=25;notes.push('extreme tax >30%')}else if(st>10||bt>10){r+=12;notes.push('high tax >10%')}
    if(sec.lpLocked!=null&&sec.lpLocked<50){r+=15;notes.push('LP not majority-locked ('+sec.lpLocked.toFixed(0)+'%)')}
    if(sec.top10!=null&&sec.top10>50){r+=15;notes.push('top-10 holders own >50%')}
    if(sec.mintable){r+=12;notes.push('supply is mintable')}
    if(sec.openSource===false){r+=8;notes.push('contract not verified')}
    if(sec.canTakeBackOwnership||sec.hiddenOwner){r+=10;notes.push('owner can reclaim control')}
  }
  if(sec&&sec.honeypot)r=Math.max(r,90); // a honeypot = cannot sell = guaranteed loss; always EXTREME
  return {score:Math.max(0,Math.min(100,Math.round(r))),notes,hasSec:!!sec};
}
function rugBand(s){return s>=75?['EXTREME','memehi']:s>=50?['High','memehi']:s>=25?['Elevated','mememid']:['Lower','memelo']}
module.exports={memeMomentum,memeRug,rugBand};
