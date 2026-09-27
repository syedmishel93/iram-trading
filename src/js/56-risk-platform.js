(function(){try{
  window.renderPlaybook=function(){try{
    var el=document.getElementById('stratSignal');if(!el||typeof USER_STRATS==='undefined')return;
    var names=Object.keys(USER_STRATS).filter(function(k){return k.charAt(0)==='\u2605'});if(!names.length)return;
    var reg='';try{reg=classifyRegime(DATA).regime}catch(e){}
    var best=null;
    names.forEach(function(n){try{var sp=USER_STRATS[n].spec;var tr=runStrategy(sp,DATA);if(tr.length<3)return;
      var eq=1;tr.forEach(function(t){eq*=1+0.01*t.R});var ret=(eq-1)*100;
      if(!best||ret>best.ret)best={n:n,ret:ret,k:tr.length};}catch(e){}});
    var box=document.getElementById('playbookLine');
    if(!box){box=document.createElement('div');box.id='playbookLine';el.parentElement.appendChild(box);}
    box.innerHTML=best?('<span style="font-size:9.5px;letter-spacing:.09em;color:var(--muted2)">REGIME PLAYBOOK \u00b7 '+reg+'</span><br>Best on this chart: <b>'+best.n.replace('\u2605 ','')+'</b> '+(best.ret>=0?'+':'')+best.ret.toFixed(1)+'% over '+best.k+' signals (backtested on this exact data).')
      :'<span style="font-size:9.5px;color:var(--muted2)">REGIME PLAYBOOK</span><br>No pack strategy has 3+ signals on this chart yet.';
  }catch(e){}};
  setTimeout(renderPlaybook,3000);setInterval(renderPlaybook,180000);
  if(typeof loadSymbol==='function'){var _ls2=loadSymbol;loadSymbol=function(){_ls2.apply(this,arguments);setTimeout(function(){try{renderPlaybook();if(window.renderScout)renderScout()}catch(e){}},900)};}
}catch(e){}})();

/* ================= v9.0 RISK + PLATFORM ================= */
(function(){try{ /* portfolio heat chip in the top bar */
  var acct=document.getElementById('acctChip');if(!acct)return;
  var chip=document.createElement('div');chip.className='feed';chip.id='heatChip';chip.title='Portfolio heat: total risk-to-stops as % of equity. Click for Portfolio Risk.';
  chip.innerHTML='HEAT <b class="mono cool">0%</b>';/* v39.1 E2: portfolio heat is RISK, so it lives with the risk cluster in the status bar, not as a fourth chip in the top bar. */var _rk=document.getElementById('stGovWrap');if(_rk&&_rk.parentElement){_rk.parentElement.insertBefore(chip,_rk)}else{acct.parentElement.insertBefore(chip,acct.nextSibling)}
  chip.onclick=function(){var n=document.querySelector('.nav[data-view="risk"]');if(n)n.click()};
  setInterval(function(){try{
    var eq=PAPER.bal+(typeof unrealized==='function'?unrealized():0);
    var heat=PAPER.pos.reduce(function(x,q){return x+Math.abs(q.entry-(q.sl!=null?q.sl:q.entry))*q.qty},0)/(eq||1)*100;
    var b=chip.querySelector('b');b.textContent=heat.toFixed(1)+'%';b.className='mono '+(heat>6?'hot':heat>3?'warm':'cool');
  }catch(e){}},4000);
}catch(e){}})();

(function(){try{ /* drawdown circuit breaker + trailing stops */
  var key='mishel_day0';var today=new Date().toDateString();
  var rec=null;try{rec=JSON.parse(localStorage.getItem(key)||'null')}catch(e){}
  if(!rec||rec.d!==today){rec={d:today,eq:PAPER.bal+(typeof unrealized==='function'?unrealized():0)};try{localStorage.setItem(key,JSON.stringify(rec))}catch(e){}}
  window._cbUntil=0;
  if(typeof paperOpen==='function'){var _po3=paperOpen;paperOpen=function(side){
    try{var now=Date.now();
      if(now<window._cbUntil){toast('CIRCUIT BREAKER: daily loss limit hit. Trading paused '+Math.ceil((window._cbUntil-now)/60000)+' more min.','var(--bear)');return}
      var eq=PAPER.bal+(typeof unrealized==='function'?unrealized():0);
      var maxDL=+((document.getElementById('setMaxDL')||{}).value)||3;
      if(rec.eq&&eq<rec.eq*(1-maxDL/100)){window._cbUntil=now+60*60000;
        toast('CIRCUIT BREAKER TRIPPED: equity down '+((1-eq/rec.eq)*100).toFixed(1)+'% today (limit '+maxDL+'%). 60-min cooldown.','var(--bear)');
        try{ALERT_LOG.unshift({t:now,sym:'RISK',desc:'Daily-loss circuit breaker tripped',val:''});if(window.updateBell)updateBell()}catch(e){}
        return}
    }catch(e){}
    _po3(side);
  };}
  /* trailing stop toggle in the Quick trade card */
  var q=document.getElementById('qOpen');
  if(q&&q.parentElement){var tb=document.createElement('button');tb.className='tbtn';tb.style.cssText='width:100%;margin-top:8px;justify-content:center;font-size:11px';
    tb.textContent='Trail stops: OFF (1.5x ATR)';window.TRAIL=false;
    tb.onclick=function(){window.TRAIL=!window.TRAIL;tb.textContent='Trail stops: '+(window.TRAIL?'ON':'OFF')+' (1.5x ATR)';tb.style.color=window.TRAIL?'var(--gold)':'';toast('Trailing stops '+(window.TRAIL?'enabled for open positions':'off'))};
    q.parentElement.appendChild(tb);
    setInterval(function(){try{
      if(!window.TRAIL||!PAPER.pos.length)return;
      var atr=IND.atr(DATA).slice(-1)[0];if(!atr)return;var px=curPrice();var moved=0;
      PAPER.pos.forEach(function(p){if(p.sym!==CURSYM.sym)return;
        if(p.side>0){var ns=px-1.5*atr;if(p.sl==null||ns>p.sl){p.sl=ns;moved++}}
        else{var ns2=px+1.5*atr;if(p.sl==null||ns2<p.sl){p.sl=ns2;moved++}}});
      if(moved)toast('Trailed '+moved+' stop'+(moved>1?'s':'')+' to '+fmt(px-1.5*atr*Math.sign(PAPER.pos[0].side||1)),'var(--gold)');
    }catch(e){}},15000);}
}catch(e){}})();

(function(){try{ /* alert webhook (GET via proxy) */
  var hint=document.getElementById('alHint');if(!hint||!hint.parentElement)return;
  var row=document.createElement('div');row.className='strat-row';row.style.cssText='gap:8px;margin-top:8px;flex-wrap:wrap';
  row.innerHTML='<input id="whUrl" class="mono" placeholder="Webhook URL (GET, e.g. Telegram sendMessage) - optional" style="flex:1;min-width:240px;font-size:11px">';
  hint.parentElement.appendChild(row);
  var inp=row.querySelector('#whUrl');try{inp.value=localStorage.getItem('mishel_wh')||''}catch(e){}
  inp.onchange=function(){try{localStorage.setItem('mishel_wh',inp.value.trim())}catch(e){}};
  if(typeof fireAlert==='function'){var _fa=fireAlert;fireAlert=function(a,val){_fa(a,val);
    try{var wh=(localStorage.getItem('mishel_wh')||'').trim();if(!wh||typeof proxyBase!=='function'||!proxyBase())return;
      var msg=encodeURIComponent(a.sym+': '+alertText(a)+(val!==''&&val!=null?' @ '+(typeof val==='number'?fmt(val):val):''));
      var url=wh+(wh.indexOf('?')>=0?'&':'?')+'text='+msg;
      fetch(proxyBase()+'/fetch?url='+encodeURIComponent(url)).catch(function(){});
    }catch(e){}};}
}catch(e){}})();

(function(){try{ /* broker CSV import into the journal */
  var host=document.getElementById('journalStats');if(!host||!host.parentElement)return;
  var wrap=document.createElement('div');wrap.style.cssText='margin-top:10px;border-top:1px solid var(--edge);padding-top:8px;font-size:11px;color:var(--muted)';
  wrap.innerHTML='<span style="font-size:10px;letter-spacing:.08em;color:var(--muted2)">IMPORT REAL TRADES</span><br><input type="file" id="jrnCsv" accept=".csv,.txt" style="font-size:11px;color:var(--muted);margin-top:4px"> <span id="jrnMsg"></span>';
  host.parentElement.appendChild(wrap);
  document.getElementById('jrnCsv').onchange=function(e){var f=e.target.files[0];if(!f)return;
    var rd=new FileReader();rd.onload=function(){try{
      var lines=String(rd.result).split(/\r?\n/).filter(Boolean);var head=lines[0].toLowerCase().split(/[,;\t]/);
      var ix=function(names){for(var i=0;i<head.length;i++){for(var j2=0;j2<names.length;j2++)if(head[i].indexOf(names[j2])>=0)return i}return -1};
      var iP=ix(['pl','profit','pnl','p&l']),iSym=ix(['sym','pair','instrument','ticker']),iSide=ix(['side','type','direction']),iE=ix(['entry','open price']),iX=ix(['exit','close price']);
      if(iP<0){document.getElementById('jrnMsg').textContent='No P&L column found.';return}
      var n=0;lines.slice(1).forEach(function(L){var c=L.split(/[,;\t]/);var pl=parseFloat(c[iP]);if(!isFinite(pl))return;
        PAPER.hist.push({t:Date.now(),sym:iSym>=0?c[iSym]:'IMPORT',side:(iSide>=0&&/s|short/i.test(c[iSide]))?-1:1,entry:iE>=0?+c[iE]||0:0,exit:iX>=0?+c[iX]||0:0,pl:pl,qty:1,why:'imported'});n++;});
      document.getElementById('jrnMsg').innerHTML='<span style="color:var(--bull)">Imported '+n+' trades: edge metrics, Kelly and mistakes now use them.</span>';
      try{if(typeof renderPaper==='function')renderPaper()}catch(e2){}
    }catch(err){document.getElementById('jrnMsg').textContent='Parse failed: '+err.message}};
    rd.readAsText(f);};
}catch(e){}})();


/* ================= v10.0 QUANT ENGINE (Web Worker ML, off the UI thread) ================= */
(function(){try{
  try{var _tb=document.getElementById('tplBtn');if(_tb)_tb.onclick=tplUI;}catch(e){}
  try{var _nb=document.getElementById('narrBtn');if(_nb)_nb.onclick=renderNarration;var _bb=document.getElementById('briefBtn');if(_bb)_bb.onclick=function(){showMorningBrief(false)};var _bt=document.getElementById('briefTgBtn');if(_bt)_bt.onclick=function(){showMorningBrief(true)};var _mv=document.getElementById('mtfVisionBtn');if(_mv)_mv.onclick=mtfVisionRead;}catch(e){}
  try{var _cr=document.getElementById('corrRun');if(_cr)_cr.onclick=renderCorrMatrix;var _mr=document.getElementById('metaRun');if(_mr)_mr.onclick=renderMetaGate;renderSvcPanels();}catch(e){}
  try{var _db=document.getElementById('dossierBtn');if(_db)_db.onclick=buildDossier;var _ra=document.getElementById('rugAddBtn');if(_ra)_ra.onclick=function(){var v=(document.getElementById('rugAddrIn')||{}).value||'';if(v.trim().length<8){toast('Enter a deployer address','#E8A33D');return}markRugger(v,'manual','','manually flagged');document.getElementById('rugAddrIn').value='';toast('\ud83d\udea9 Deployer flagged','#F0616D');renderRuggerList()};renderRuggerList();}catch(e){}
  try{ /* v17.1/v18: rotation strip inside the Cross-Market card — renders fast, then refreshes */
  function fillImxRot(){try{var el=document.getElementById('imxRot');if(!el)return;
    if(typeof rrgCalc!=='function'){el.innerHTML='';return}
    var map={};Object.keys(typeof BAR_CACHE!=='undefined'?BAR_CACHE:{}).forEach(function(k){if(!/\|1h$/.test(k))return;var bars=BAR_CACHE[k];if(Array.isArray(bars)&&bars.length>=40)map[k.split('|')[0]]=bars.map(function(c){return c.c})});
    var syms=Object.keys(map);
    if(syms.length<3){el.innerHTML='<div style="font-size:10px;color:var(--muted2)"><b style="color:var(--muted)">ROTATION</b> \u00b7 open \u22653 symbols online to see who\u2019s gaining strength vs BTC \u2014 full quadrant in Market Heatmap.</div>';return}
    var pts=rrgCalc(map,map.BTCUSD?'BTCUSD':syms[0],20,5);if(!pts.length){el.innerHTML='';return}
    var lead=pts.filter(function(p){return p.quad==='LEADING'}).slice(0,3),lag=pts.filter(function(p){return p.quad==='LAGGING'}).slice(0,3);
    el.innerHTML='<div style="font-size:10px;color:var(--muted2)"><b style="color:var(--muted)">ROTATION vs '+(map.BTCUSD?'BTC':syms[0])+'</b> \u00b7 leading: '+(lead.map(function(p){return '<span class="up">'+p.sym.replace('USD','')+'</span>'}).join(' ')||'\u2014')+' \u00b7 lagging: '+(lag.map(function(p){return '<span class="dn">'+p.sym.replace('USD','')+'</span>'}).join(' ')||'\u2014')+' \u00b7 <span id="imxRotGo" style="cursor:pointer;text-decoration:underline">full quadrant \u2197</span></div>';
    var go=document.getElementById('imxRotGo');if(go)go.onclick=function(){try{var hb=document.querySelector('[data-view="heatmap"]');if(hb)hb.click()}catch(e){}};
    /* v19: mirror the merged read into the always-visible chart-header chip */
    try{var xc=document.getElementById('ihXm');if(xc){var m2=window._imx;var bits=[];
      if(m2&&m2.regime){var rg=(m2.regime.label||m2.regime.name||m2.regime);if(typeof rg==='string')bits.push(rg.replace(/\s*\(.*$/,''))}
      if(m2&&m2.anomaly)bits.push(m2.anomaly.flag?'\u26a0 ANOMALY':'structure ok');
      if(lead&&lead.length)bits.push(lead[0].sym.replace('USD','')+'\u2191');
      if(lag&&lag.length)bits.push(lag[0].sym.replace('USD','')+'\u2193');
      xc.textContent=bits.length?('X-MKT '+bits.join(' \u00b7 ')):'X-MKT warming\u2026';
      xc.style.color=(m2&&m2.anomaly&&m2.anomaly.flag)?'var(--bear)':'';}}catch(e){}}catch(e){}}
  setTimeout(fillImxRot,1500);setInterval(fillImxRot,15000);
}catch(e){}
try{var b2s=document.getElementById('ocToScout');if(b2s&&!b2s._wired){b2s._wired=1;b2s.onclick=function(){
  try{var a=((document.getElementById('ocHolderAddr')||{}).value||'').trim();if(!a){toast('Paste a token contract in the holder box first','var(--gold)');return}
    var si=document.getElementById('scAddr');if(si)si.value=a;
    var hc=((document.getElementById('ocHolderChain')||{}).value)||'ethereum';var sc2=document.getElementById('scChain');if(sc2){try{sc2.value=hc}catch(e){}}
    var pnl=document.getElementById('walletScout');if(pnl)pnl.scrollIntoView({behavior:'smooth',block:'start'});
    scoutRun();}catch(e){}};}}catch(e){}
try{ /* v20.1 A1-A3 (bulletproof): reorganize by use case WITHOUT ever hiding/losing a button.
        Rebuild groups from scratch inside the existing rail so DOM-shape assumptions can't break it. */
  var rail=document.getElementById('rail');
  if(rail&&!rail._regrouped){
    var GROUPS=[['TRADE',['chart','multi','mtf','orderflow']],
      ['SMART MONEY',['smart','intel']],
      ['DISCOVER',['insights','screener','onchain','heatmap','news']],
      ['AI & SIGNALS',['ai','confluence']],
      ['STRATEGY',['backtest','paper']],
      ['TOOLS',['watchlist','sessions','calc','hedge']],
      ['SYSTEM',['risk','alerts','settings']]];
    /* index every existing nav button by view (keep the node, we only re-parent) */
    var byView={};Array.prototype.slice.call(rail.querySelectorAll('.nav:not(.freqclone)')).forEach(function(b){if(b.dataset.view)byView[b.dataset.view]=b});
    /* A1: Confluence lives on only as a side-panel link, hide its rail button */
    if(byView.confluence){byView.confluence.style.display='none';}
    var placed={};
    var freq=document.getElementById('railFreq');
    try{if(freq){var fh=freq.querySelector('.rail-grp-h');if(fh)fh.textContent='\u2605 FAVORITES';}}catch(e){}
    /* remove old non-freq groups AFTER we've captured their buttons */
    Array.prototype.slice.call(rail.querySelectorAll('.rail-grp')).forEach(function(g){if(g.id!=='railFreq')g.parentNode.removeChild(g)});
    GROUPS.forEach(function(def){
      var present=def[1].filter(function(v){return byView[v]});
      if(!present.length)return;
      var g=document.createElement('div');g.className='rail-grp';
      var h=document.createElement('div');h.className='rail-grp-h';h.textContent=def[0]+' \u00b7 '+present.length;h.title='Click to collapse/expand';g.appendChild(h);
      present.forEach(function(v){g.appendChild(byView[v]);placed[v]=1});
      rail.appendChild(g);
    });
    /* SAFETY NET: any button not placed by the map goes into a Misc group so NOTHING vanishes */
    var orphans=Object.keys(byView).filter(function(v){return !placed[v]&&v!=='confluence'});
    if(orphans.length){var g=document.createElement('div');g.className='rail-grp';
      var h=document.createElement('div');h.className='rail-grp-h';h.textContent='MORE \u00b7 '+orphans.length;g.appendChild(h);
      orphans.forEach(function(v){g.appendChild(byView[v])});rail.appendChild(g);}
    rail._regrouped=1;
    /* re-attach collapse handlers to the new headers */
    try{var GK='mishel_railgrp2';var st={};try{st=JSON.parse(localStorage.getItem(GK)||'{}')}catch(e){}
      Array.prototype.slice.call(rail.querySelectorAll('.rail-grp')).forEach(function(g,gi){var hh=g.querySelector('.rail-grp-h');if(!hh)return;
        if(st[gi])g.classList.add('collapsed');
        hh.addEventListener('click',function(){g.classList.toggle('collapsed');st[gi]=g.classList.contains('collapsed')?1:0;try{localStorage.setItem(GK,JSON.stringify(st))}catch(e){}});});}catch(e){}
  }
  /* XAI report link in the chart side panel (A1 content preserved) */
  var firstCard=document.querySelector('.side .card');
  if(firstCard&&!document.getElementById('xaiLink')){var xl=document.createElement('div');xl.id='xaiLink';
    xl.style.cssText='font-size:10px;color:var(--muted2);margin-top:6px;cursor:pointer;text-decoration:underline';
    xl.textContent='Full XAI confluence report \u2197';xl.onclick=function(){try{goView('confluence')}catch(e){}};
    firstCard.appendChild(xl);}
}catch(e){}
try{var smv=document.querySelector('[data-view="smart"]');if(smv)smv.addEventListener('click',function(){setTimeout(function(){try{renderSmartDesk();renderSmartFeed()}catch(e){}},300)});
  var smh=document.getElementById('smHarvest');if(smh&&!smh._wired){smh._wired=1;smh.onclick=function(){try{smMassHarvest()}catch(e){}}}
  var sms=document.getElementById('smHarvestStop');if(sms&&!sms._wired){sms._wired=1;sms.onclick=function(){window._smStop=true}}
  var smr=document.getElementById('smRefresh');if(smr&&!smr._wired){smr._wired=1;smr.onclick=function(){try{renderSmartDesk()}catch(e){}}}
  var smf=document.getElementById('smFeedRefresh');if(smf&&!smf._wired){smf._wired=1;smf.onclick=function(){try{renderSmartFeed()}catch(e){}}}
  var smtb=document.getElementById('smTokBtn');if(smtb&&!smtb._wired){smtb._wired=1;smtb.onclick=function(){try{renderTokenSM()}catch(e){}}}
  var sme=document.getElementById('smExport');if(sme&&!sme._wired){sme._wired=1;sme.onclick=function(){try{var csv=wdbExportCSV(wdbLoad());var b=new Blob([csv],{type:'text/csv'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='mishel_smartmoney.csv';a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},2000);toast('\u2b07 '+Object.keys(wdbLoad()).length+' wallets exported','var(--gold)')}catch(e){}}}
  var smi=document.getElementById('smImport');if(smi&&!smi._wired){smi._wired=1;smi.onclick=function(){try{var t=prompt('Paste addresses (one per line, or CSV):','');if(!t)return;var n=wdbImportCSV(t);var st=document.getElementById('smDbStat');if(st)st.textContent=n+' added';renderSmartDesk();toast('\u2b06 '+n+' wallets imported','var(--gold)')}catch(e){}}}
  var smrr=setInterval(function(){try{var v=document.getElementById('v-smart');if(v&&v.classList.contains('on'))renderSmartDesk()}catch(e){}},45000);
  var gcw=document.getElementById('smGetCopyable');if(gcw&&!gcw._wired){gcw._wired=1;gcw.onclick=async function(){
    gcw.disabled=true;gcw.textContent=' scanning EVM launches…';
    try{var ch=document.getElementById('launchChain');if(ch){try{ch.value='base'}catch(e){}}
      if(typeof scanLaunches==='function')await scanLaunches();
      gcw.textContent=' scanning EVM memes…';var mc=document.getElementById('memeChain');if(mc){try{mc.value='base'}catch(e){}}
      if(typeof scanMeme==='function')await scanMeme();
      gcw.textContent=' harvesting wallets…';
      if(typeof smMassHarvest==='function')await smMassHarvest();
      gcw.textContent='✓ done — check the ranking';
    }catch(e){gcw.textContent=' Get copyable wallets (EVM)';}
    setTimeout(function(){gcw.disabled=false;gcw.textContent=' Get copyable wallets (EVM)'},4000);
    try{renderSmartDesk()}catch(e){}};}
  try{var vb=document.getElementById('smVerBadge');if(vb&&typeof APP_VER!=='undefined')vb.textContent='v'+APP_VER+' \u2713 live';}catch(e){}
  setInterval(function(){try{var v=document.getElementById('v-smart');if(v&&v.classList.contains('on'))renderSmartFeed()}catch(e){}},60000);
}catch(e){}
try{var sc=document.getElementById('scRun');if(sc&&!sc._wired){sc._wired=1;sc.onclick=function(){try{scoutRun()}catch(e){}}}}catch(e){}
try{var wr=document.getElementById('wbRefresh');if(wr&&!wr._wired){wr._wired=1;wr.onclick=function(){try{renderWhaleBoard()}catch(e){}}}
  var ov=document.querySelector('[data-view="onchain"]');if(ov)ov.addEventListener('click',function(){setTimeout(function(){try{renderWhaleBoard()}catch(e){}},350)});
  var sh=document.getElementById('shRun');if(sh&&!sh._wired){sh._wired=1;sh.onclick=function(){try{testSources()}catch(e){}}}
}catch(e){}
try{var rr=document.getElementById('rrgRun');if(rr&&!rr._wired){rr._wired=1;rr.onclick=function(){try{renderRRG()}catch(e){}};
  var hv=document.querySelector('[data-view="heatmap"]');if(hv)hv.addEventListener('click',function(){setTimeout(function(){try{renderRRG()}catch(e){}},400)});}}catch(e){}
try{ /* v16.4 rail UX: collapsible groups + view search + active-group highlight */
  var GK='mishel_railgrp';var st={};try{st=JSON.parse(localStorage.getItem(GK)||'{}')}catch(e){}
  document.querySelectorAll('.rail-grp').forEach(function(g,gi){var h=g.querySelector('.rail-grp-h');if(!h)return;
    if(st[gi])g.classList.add('collapsed');
    h.title='Click to collapse/expand this group';
    h.addEventListener('click',function(){g.classList.toggle('collapsed');st[gi]=g.classList.contains('collapsed')?1:0;
      try{localStorage.setItem(GK,JSON.stringify(st))}catch(e){}});});
  function markAct(){var on=document.querySelector('.nav.on');document.querySelectorAll('.rail-grp-h').forEach(function(h){h.classList.remove('act')});
    if(on){var g=on.closest('.rail-grp');var h=g&&g.querySelector('.rail-grp-h');if(h)h.classList.add('act');}}
  var UK='mishel_navuse';var use={};try{use=JSON.parse(localStorage.getItem(UK)||'{}')}catch(e){}
  function rebuildFreq(){try{var grp=document.getElementById('railFreq');if(!grp)return;
    var top=Object.entries(use).filter(function(e){return e[1]>=3}).sort(function(a,b){return b[1]-a[1]}).slice(0,4);
    grp.querySelectorAll('.nav').forEach(function(n){n.remove()});
    if(!top.length){grp.style.display='none';return}
    top.forEach(function(e){var orig=document.querySelector('.nav[data-view="'+e[0]+'"]:not(.freqclone)');if(!orig)return;
      var c=orig.cloneNode(true);c.classList.add('freqclone');c.classList.remove('on');c.removeAttribute('data-view');
      c.onclick=function(){orig.click()};grp.appendChild(c);});
    grp.style.display='';}catch(e){}}
  document.querySelectorAll('.nav').forEach(function(b){b.addEventListener('click',function(){setTimeout(markAct,50);
    try{var v=b.dataset.view;if(v){use[v]=(use[v]||0)+1;localStorage.setItem(UK,JSON.stringify(use));rebuildFreq()}}catch(e){}})});markAct();rebuildFreq();
  try{if(!localStorage.getItem('mishel_railpin_seen')&&window.innerWidth>1500){document.querySelector('.app').classList.add('rail-pinned');if(window.syncAppGrid)syncAppGrid();localStorage.setItem('mishel_railpin_seen','1')}}catch(e){}
  var rs=document.getElementById('railSearch');if(rs&&!rs._wired){rs._wired=1;
    rs.addEventListener('input',function(){var q=rs.value.trim().toLowerCase();
      document.querySelectorAll('.rail-grp').forEach(function(g){var any=false;
        g.querySelectorAll('.nav').forEach(function(b){var lbl=(b.querySelector('.lbl')||{}).textContent||'';
          var hit=!q||lbl.toLowerCase().indexOf(q)>=0;b.classList.toggle('searchhide',!hit);if(hit)any=true;});
        if(q&&any)g.classList.remove('collapsed');});});
    rs.addEventListener('keydown',function(ev){if(ev.key==='Enter'){var first=document.querySelector('.nav:not(.searchhide)');if(first){first.click();rs.value='';rs.dispatchEvent(new Event('input'))}}});}
}catch(e){}
try{var pb=document.getElementById('pineBtn');if(pb&&!pb._wired){pb._wired=1;pb.onclick=function(){
  try{var nm=document.getElementById('stratSel').value;if(!nm){toast('Pick a strategy first','var(--gold)');return}
    var spec=specFor(nm,CURSTYLE);var out=pineExport(spec,nm);
    var blob=new Blob([out.code],{type:'text/plain'});var a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download=nm.replace(/[^a-z0-9]+/gi,'_').toLowerCase()+'.pine';a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},2000);
    toast(out.complete?'Pine v5 exported \u2014 paste into TradingView':'Pine exported \u2014 '+out.unsupported.length+' custom indicator(s) marked unsupported: '+out.unsupported.join(', '),out.complete?'var(--up,#6fd08c)':'var(--gold)');
  }catch(e){try{toast('Pine export failed: '+e.message,'var(--bear)')}catch(_){}}};}}catch(e){}
try{var sp=document.getElementById('srcPick');if(sp&&!sp._wired){sp._wired=1;
  sp.onchange=function(){window.FORCE_SRC=sp.value||null;
    var offline=false;try{offline=(typeof MODE!=='undefined'&&MODE!=='online')}catch(_){}
    try{toast(sp.value?('Data source forced: '+sp.options[sp.selectedIndex].text+(offline?' \u2014 you are OFFLINE: switch the mode toggle to Online to use it (crypto symbols)':'')):'Data source: Auto (Binance \u2192 failovers)',offline&&sp.value?'var(--bear)':'var(--gold)')}catch(_){}
    try{if(typeof MODE!=='undefined'&&MODE==='online')loadSymbol()}catch(_){}};
  setInterval(function(){try{var el=document.getElementById('srcLive');if(!el)return;
    var online=false;try{online=(typeof MODE!=='undefined'&&MODE==='online')}catch(_){}
    var isCrypto=false;try{isCrypto=!!(typeof CURSYM!=='undefined'&&CURSYM.sym&&typeof SPECS!=='undefined'&&SPECS[CURSYM.sym]&&String(SPECS[CURSYM.sym].cls).indexOf('crypto')===0)}catch(_){}
    var live=online&&(isCrypto||window._realFeed)&&window._lastTick&&(Date.now()-window._lastTick<90000);
    el.textContent=live?(window._feedSrc||'Binance'):(online?(isCrypto?'reconnecting\u2026':'FX/stocks: key or proxy needed'):('offline'+(window.FORCE_SRC?' \u00b7 '+window.FORCE_SRC+' armed':'')));
    el.title=live?'live feed: '+(window._feedSrc||'Binance'):(online?(isCrypto?'crypto feed briefly stale \u2014 auto-failover is trying the 7 providers':'This symbol class has no browser-direct free vendor. Set a Twelve Data key (forex/metals) or run the local proxy \u2014 Settings \u2192 External data. Crypto symbols stream live with zero setup.'):'Offline mode \u2014 synthetic/CSV only');
    el.style.color=live?'var(--up,#6fd08c)':(online?'var(--gold)':'var(--muted)');}catch(_){}},2000);}}catch(e){}
try{ /* v22 Option A: smoothed hover crosshair + debounced resize — polish only, draw loop untouched */
  var _cv=document.getElementById('chartCanvas')||document.querySelector('#v-chart canvas');
  if(_cv&&!_cv._smoothWired){_cv._smoothWired=1;
    var _rt=null;window.addEventListener('resize',function(){if(_rt)cancelAnimationFrame(_rt);_rt=requestAnimationFrame(function(){try{if(typeof draw==='function'&&document.getElementById('v-chart').classList.contains('on'))draw()}catch(e){}})});
    _cv.style.transition='';
  }
}catch(e){}
try{ /* v22.1: TradingView-style chart maximize */
  var _mx=document.getElementById('chartMax');
  if(_mx&&!_mx._wired){_mx._wired=1;
    function fsToolbarSync(){try{var sy=document.getElementById('fsSym');if(sy&&typeof CURSYM!=='undefined')sy.textContent=CURSYM.sym||'\u2014';
      var box=document.getElementById('fsTfs');if(box&&!box._built){box._built=1;
        box.innerHTML=['1m','5m','15m','1h','4h','1d'].map(function(t){return '<button class="fstf" data-t="'+t+'">'+t.toUpperCase()+'</button>'}).join('');
        box.querySelectorAll('.fstf').forEach(function(b){b.onclick=function(){var tb=document.querySelector('#tfBar [data-tf="'+b.dataset.t+'"]');if(tb)tb.click();fsToolbarSync()}});}
      if(box)box.querySelectorAll('.fstf').forEach(function(b){var tb=document.querySelector('#tfBar [data-tf="'+b.dataset.t+'"]');b.classList.toggle('on',!!(tb&&tb.classList.contains('on')))});}catch(e){}}
    function toggleMax(force){var app=document.querySelector('.app');var on=force!=null?force:!app.classList.contains('chart-max');
      if(on){try{if(!document.getElementById('v-chart').classList.contains('on'))goView('chart')}catch(e){}}
      app.classList.toggle('chart-max',on);_mx.innerHTML=on?'\u26f6 Restore':'\u26f6 Expand';
      app.style.gridTemplateColumns='';app.style.gridTemplateRows='';app.style.gridTemplateAreas='';
      /* F1: real browser fullscreen like TradingView */
      try{if(on&&!document.fullscreenElement){(document.documentElement.requestFullscreen||document.documentElement.webkitRequestFullscreen).call(document.documentElement)}
          else if(!on&&document.fullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen).call(document)}}catch(e){}
      if(on)fsToolbarSync();
      if(!on&&window.syncAppGrid){window.syncAppGrid();setTimeout(window.syncAppGrid,60);setTimeout(window.syncAppGrid,300);}
      setTimeout(function(){try{if(typeof draw==='function')draw();if(window.GLR&&GLR.resize)GLR.resize();}catch(e){}},60);
      setTimeout(function(){try{if(typeof draw==='function')draw()}catch(e){}},350);}
    window.toggleChartMax=toggleMax;
    _mx.onclick=function(){toggleMax()};
    var fx=document.getElementById('fsExit');if(fx)fx.onclick=function(){toggleMax(false)};
    document.addEventListener('fullscreenchange',function(){try{if(!document.fullscreenElement&&document.querySelector('.app').classList.contains('chart-max'))toggleMax(false)}catch(e){}});
    document.addEventListener('keydown',function(ev){if(ev.key==='Escape'&&document.querySelector('.app').classList.contains('chart-max'))toggleMax(false)});
    /* F3 + C6: double-click chart = fullscreen; double-click price axis = reset zoom */
    var _cv2=document.getElementById('chart');
    if(_cv2&&!_cv2._dblWired){_cv2._dblWired=1;_cv2.addEventListener('dblclick',function(ev){
      try{var r=_cv2.getBoundingClientRect();var x=ev.clientX-r.left;
        if(RENDER&&x>RENDER.W-RENDER.padR){var f=document.getElementById('barsFit');if(f)f.click();}   /* C6 axis reset */
        else toggleMax();}catch(e){}});}
    /* C2 + C7: TradingView keyboard — F fullscreen, +/- zoom, arrows pan, TF keys, letter = symbol search */
    if(!window._tvKeysWired){window._tvKeysWired=1;
      document.addEventListener('keydown',function(ev){
        try{
          var t=ev.target;var typing=t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable);
          if(typing||ev.metaKey||ev.ctrlKey||ev.altKey)return;
          var chartOn=document.getElementById('v-chart').classList.contains('on');if(!chartOn)return;
          var msp=document.getElementById('mspOverlay');if(msp&&msp.style.display==='block')return;
          var k=ev.key;
          if(k==='f'||k==='F'){ev.preventDefault();toggleMax();return}
          if(k==='+'||k==='='){ev.preventDefault();var bm=document.getElementById('barsMinus');if(bm)bm.click();return}
          if(k==='-'||k==='_'){ev.preventDefault();var bp=document.getElementById('barsPlus');if(bp)bp.click();return}
          if(k==='ArrowLeft'||k==='ArrowRight'){ev.preventDefault();try{if(typeof VIEW!=='undefined'){var st=Math.max(2,Math.round((VIEW.bars||120)*0.08));VIEW.off=Math.max(0,(VIEW.off||0)+(k==='ArrowLeft'?st:-st));if(typeof draw==='function')draw()}}catch(e){}return}
          var TFK={'1':'1m','5':'5m','3':'15m','h':'1h','H':'1h','4':'4h','d':'1d','D':'1d','w':'1w'};
          if(TFK[k]){ev.preventDefault();var tb=document.querySelector('#tfBar [data-tf="'+TFK[k]+'"]');if(tb)tb.click();fsToolbarSync();return}
          if(/^[a-z]$/i.test(k)){ev.preventDefault();if(typeof window.openMsp==='function')window.openMsp(k);return}   /* C7 */
        }catch(e){}
      });}
  }
}catch(e){}
try{ /* v27.0: V8 chart-first default side width + V9 compact density (default ON, toggleable) */
  if(!localStorage.getItem('mishel_sidew')){localStorage.setItem('mishel_sidew','300');document.documentElement.style.setProperty('--side-w','300px');}
  var _cmpct=localStorage.getItem('mishel_compact');
  if(_cmpct!=='0')document.body.classList.add('compact');
  /* version tag into the status bar (freed from instHead) */
  var _st=document.querySelector('.status');
  if(_st&&!document.getElementById('stVer')){var v=document.createElement('span');v.id='stVer';v.className='s';/* v39.1: the slot owns the bar's ONLY margin-left:auto */v.style.cssText='opacity:.7';v.textContent='v26.2'.replace('26.2',(typeof APP_VER!=='undefined'?APP_VER:''));(document.getElementById('stSlot')||_st).appendChild(v);}
  /* v27.2: move the instrument header into the symbol-tabs row (nodes keep their ids — all live updaters intact) */
  setTimeout(function(){try{
    var ih=document.getElementById('instHead'),ws=document.getElementById('wsTabs');
    if(ih&&ws&&document.body.classList.contains('compact')&&ih.parentElement!==ws)ws.appendChild(ih);
  }catch(e){}},900);
}catch(e){}
try{ /* v25.0: init top tab bar to the active view */
  var _av=(document.querySelector('.view.on')||{id:'v-chart'}).id.replace('v-','');
  if(typeof syncTabBar==='function')syncTabBar(_av);
}catch(e){}
try{ /* v24.4 (legacy rail, now hidden): no-op */
  var _rp=null;try{_rp=localStorage.getItem('mishel_rail_pinned')}catch(e){}
  var _app=document.querySelector('.app');
  if(_app&&_rp!=='0')_app.classList.add('rail-pinned');
}catch(e){}
try{ /* v39.19: theme applies on EVERY load. One-time migration moves existing users
        (who have an old saved theme) onto the new Arkham default; after that, a saved
        choice is always respected. */
  var _sv=null;try{_sv=localStorage.getItem('mishel_theme')}catch(e){}
  var _mig=null;try{_mig=localStorage.getItem('mishel_arkham_v3922')}catch(e){}
  if(!_mig){
    if(typeof applyTheme==='function')applyTheme('arkham');else document.documentElement.setAttribute('data-theme','arkham');
    try{localStorage.setItem('mishel_theme','arkham');localStorage.setItem('mishel_arkham_v3922','1')}catch(e){}
  }else if(_sv){if(typeof applyTheme==='function')applyTheme(_sv);else document.documentElement.setAttribute('data-theme',_sv==='midnight'?'':_sv);}
  else{if(typeof applyTheme==='function')applyTheme('arkham');else document.documentElement.setAttribute('data-theme','arkham');try{localStorage.setItem('mishel_theme','arkham')}catch(e){}}
}catch(e){}
var WSRC="\nfunction corr(a,b){var n=Math.min(a.length,b.length);var ma=0,mb=0;for(var i=0;i<n;i++){ma+=a[i];mb+=b[i]}ma/=n;mb/=n;\n  var nu=0,da=0,db=0;for(var j=0;j<n;j++){nu+=(a[j]-ma)*(b[j]-mb);da+=(a[j]-ma)*(a[j]-ma);db+=(b[j]-mb)*(b[j]-mb)}\n  return nu/Math.sqrt((da*db)||1e-12);}\nfunction cov(rows){var k=rows.length,n=rows[0].length,mu=rows.map(function(r){var s2=0;for(var i=0;i<n;i++)s2+=r[i];return s2/n});\n  var C=[];for(var a=0;a<k;a++){C.push([]);for(var b=0;b<k;b++){var s3=0;for(var i2=0;i2<n;i2++)s3+=(rows[a][i2]-mu[a])*(rows[b][i2]-mu[b]);C[a].push(s3/(n-1))}}return {C:C,mu:mu};}\nfunction inv(M){var n=M.length,A=M.map(function(r,i){return r.concat(Array.from({length:n},function(_,j){return i===j?1:0}))});\n  for(var c=0;c<n;c++){var p=c;for(var r2=c+1;r2<n;r2++)if(Math.abs(A[r2][c])>Math.abs(A[p][c]))p=r2;\n    var t=A[c];A[c]=A[p];A[p]=t;var pv=A[c][c]||1e-12;\n    for(var j2=0;j2<2*n;j2++)A[c][j2]/=pv;\n    for(var r3=0;r3<n;r3++){if(r3===c)continue;var f=A[r3][c];for(var j3=0;j3<2*n;j3++)A[r3][j3]-=f*A[c][j3]}}\n  return A.map(function(r){return r.slice(n)});}\nfunction mahal(x,mu,Ci){var d=x.map(function(v,i){return v-mu[i]});var s4=0;\n  for(var a=0;a<d.length;a++)for(var b=0;b<d.length;b++)s4+=d[a]*Ci[a][b]*d[b];return Math.sqrt(Math.max(0,s4));}\n/* isolation forest */\nfunction iTree(X,idx,depth,maxD,rnd){\n  if(depth>=maxD||idx.length<=1)return {leaf:true,n:idx.length};\n  var f=(rnd()*X[0].length)|0;var lo=1e18,hi=-1e18;\n  idx.forEach(function(i){var v=X[i][f];if(v<lo)lo=v;if(v>hi)hi=v});\n  if(hi-lo<1e-12)return {leaf:true,n:idx.length};\n  var sp=lo+rnd()*(hi-lo);var L=[],R=[];\n  idx.forEach(function(i){(X[i][f]<sp?L:R).push(i)});\n  return {f:f,sp:sp,L:iTree(X,L,depth+1,maxD,rnd),R:iTree(X,R,depth+1,maxD,rnd)};}\nfunction pathLen(t,x,d){if(t.leaf)return d+(t.n>1?2*(Math.log(t.n-1)+0.5772)-2*(t.n-1)/t.n:0);\n  return pathLen(x[t.f]<t.sp?t.L:t.R,x,d+1);}\nfunction iforest(X,trees,sub){trees=trees||40;sub=Math.min(sub||64,X.length);\n  var seed=1234;var rnd=function(){seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff};\n  var F=[];for(var t=0;t<trees;t++){var idx=[];for(var i=0;i<sub;i++)idx.push((rnd()*X.length)|0);F.push(iTree(X,idx,0,Math.ceil(Math.log2(sub)),rnd));}\n  var c=2*(Math.log(sub-1)+0.5772)-2*(sub-1)/sub;\n  return function(x){var s5=0;F.forEach(function(tr){s5+=pathLen(tr,x,0)});return Math.pow(2,-(s5/F.length)/c)};}\n/* 2-state gaussian mixture EM on 1D series */\nfunction gmm2(x,iters){iters=iters||30;var n=x.length;\n  var mn=Math.min.apply(null,x),mx=Math.max.apply(null,x);\n  var mu=[mn+(mx-mn)*0.25,mn+(mx-mn)*0.75],sd=[(mx-mn)/4+1e-9,(mx-mn)/4+1e-9],pi=[0.5,0.5];\n  function pdf(v,m,s6){var z=(v-m)/s6;return Math.exp(-0.5*z*z)/(s6*2.5066282746);}\n  var G=new Array(n);\n  for(var it=0;it<iters;it++){\n    for(var i=0;i<n;i++){var a=pi[0]*pdf(x[i],mu[0],sd[0]),b=pi[1]*pdf(x[i],mu[1],sd[1]);var t2=a+b||1e-12;G[i]=a/t2;}\n    for(var k2=0;k2<2;k2++){var w=0,m2=0;for(var i2=0;i2<n;i2++){var g=k2===0?G[i2]:1-G[i2];w+=g;m2+=g*x[i2]}\n      mu[k2]=m2/(w||1e-9);var v2=0;for(var i3=0;i3<n;i3++){var g2=k2===0?G[i3]:1-G[i3];v2+=g2*(x[i3]-mu[k2])*(x[i3]-mu[k2])}\n      sd[k2]=Math.sqrt(v2/(w||1e-9))+1e-9;pi[k2]=w/n;}}\n  var hiState=mu[0]>mu[1]?0:1;\n  var pHi=hiState===0?G[n-1]:1-G[n-1];\n  return {pHighVol:pHi,muLo:Math.min(mu[0],mu[1]),muHi:Math.max(mu[0],mu[1])};}\nself.onmessage=function(ev){\n  var t0=Date.now();\n  try{\n    var D=ev.data; /* {names:[4], rets:[4][n]} aligned returns, oldest->newest */\n    var names=D.names,rets=D.rets,n=rets[0].length;var K=names.length;\n    var win=Math.min(60,n);\n    var tail=rets.map(function(r){return r.slice(-win)});\n    /* correlation matrix */\n    var CM=[];for(var a=0;a<K;a++){CM.push([]);for(var b=0;b<K;b++)CM[a].push(a===b?1:corr(tail[a],tail[b]))}\n    /* spreads z: cum log spread over win, z of last */\n    function spreadZ(i,j,invert){var sp=[];var ca=0,cb=0;\n      for(var k3=0;k3<win;k3++){ca+=tail[i][k3];cb+=(invert?-1:1)*tail[j][k3];sp.push(ca-cb)}\n      var m3=0;sp.forEach(function(v){m3+=v});m3/=sp.length;var v3=0;sp.forEach(function(v){v3+=(v-m3)*(v-m3)});\n      var sd2=Math.sqrt(v3/sp.length)||1e-9;return (sp[sp.length-1]-m3)/sd2;}\n    var IX={};names.forEach(function(nm2,ii){IX[nm2]=ii});var spreads=[];function addSp(a4,b4,lbl){if(IX[a4]!=null&&IX[b4]!=null)spreads.push({k:lbl,z:spreadZ(IX[a4],IX[b4],true)})}addSp('BTCUSD','DXY','BTC vs DXY');addSp('XAUUSD','DXY','XAU vs DXY');addSp('XAUUSD','US10Y','XAU vs US10Y');\n    /* features per time step for anomaly detection */\n    var X=[];for(var t=5;t<win;t++){\n      var row=[];for(var a2=0;a2<K;a2++){row.push(tail[a2][t]);\n        var v4=0;for(var q=t-4;q<=t;q++)v4+=tail[a2][q]*tail[a2][q];row.push(Math.sqrt(v4/5));}\n      X.push(row);}\n    var score=iforest(X,40,Math.min(64,X.length));\n    var anomIF=score(X[X.length-1]);\n    var cv2=cov(X[0].map(function(_,c2){return X.map(function(r){return r[c2]})}));\n    var md=0;try{md=mahal(X[X.length-1],cv2.mu,inv(cv2.C))}catch(e){md=0}\n    var dof=X[0].length;var mdNorm=md/Math.sqrt(dof*2);\n    /* regime: GMM on base asset vol proxy (abs returns) */\n    var absr=tail[0].map(Math.abs);\n    var reg=gmm2(absr,25);\n    self.postMessage({ok:true,ms:Date.now()-t0,names:names,corr:CM,spreads:spreads,\n      anomaly:{iforest:+anomIF.toFixed(3),mahal:+mdNorm.toFixed(2),flag:anomIF>0.62&&mdNorm>1.5},\n      regime:{pHighVol:+reg.pHighVol.toFixed(2),state:reg.pHighVol>0.5?'RISK-OFF / high-vol':'RISK-ON / low-vol'}});\n  }catch(e){self.postMessage({ok:false,err:String(e&&e.message||e)})}\n};\n";
  var worker=null;try{worker=new Worker(URL.createObjectURL(new Blob([WSRC],{type:'text/javascript'})))}catch(e){}
  var COMPLEX=['BTCUSD','XAUUSD','US10Y','DXY'];
  /* synthetic specs for the two macro series (real via proxy when Online) */
  if(typeof SPECS!=='undefined'){if(!SPECS.US10Y)SPECS.US10Y={name:'US 10Y yield',cls:'index',pip:0.001,contract:1,dpp:1,px:4.25};
    if(!SPECS.DXY)SPECS.DXY={name:'Dollar Index',cls:'index',pip:0.01,contract:1,dpp:1,px:104.2};}
  function cachedBars(sym){for(var k in BAR_CACHE){if(k.indexOf(sym+'|')===0&&BAR_CACHE[k].length>80)return BAR_CACHE[k]}return null}
  function seriesReal(sym){var d=cachedBars(sym);            /* REAL bars or nothing — never fabricates */
    if(d){if(window._imxSrc&&window._imxSrc[sym]==='synthetic')window._imxSrc[sym]='live cache';return d.slice(-160)}
    return null;}
  function series(sym){var d=seriesReal(sym);if(d)return d;  /* offline-only synthetic fallback */
    if(window._imxSrc)window._imxSrc[sym]='synthetic';
    return genData(240,(SPECS[sym]||{px:100}).px,(sym.charCodeAt(0)+sym.length)*13+7).slice(-160);}
  window.renderIMXPaused=function(){try{renderIMX();var b=document.getElementById('imxBody');if(!b)return;
    var s=window._imxSrc||{};var rows=['BTCUSD','XAUUSD','US10Y','DXY'].map(function(k2){var v=s[k2]||'?';var real=v!=='synthetic'&&v.indexOf('unavailable')<0;
      return '<div style="display:flex;justify-content:space-between;padding:2px 0"><span style="color:var(--muted2)">'+k2+'</span><b style="color:'+(real?'var(--bull)':'var(--bear)')+'">'+v+'</b></div>'}).join('');
    b.innerHTML='<div style="font-size:10.5px;color:var(--gold);margin-bottom:6px">Engine paused \u2014 Online mode computes over REAL legs only, and fewer than 2 are live (BTC required as base).</div>'+rows
      +'<div style="font-size:9.5px;color:var(--muted2);margin-top:6px">Add a Twelve Data key (XAU) and/or run the local proxy (10Y, DXY) in Settings \u2192 Data sources. Nothing here is ever synthesised in Online mode.</div>';
  }catch(e){}};
  /* unified pipeline: align on the base clock, forward-fill gaps, PAST DATA ONLY (no look-ahead) */
  function alignedReturns(){
    var online=(typeof MODE!=='undefined'&&MODE==='online');
    var use=[];COMPLEX.forEach(function(sym){
      var d=online?seriesReal(sym):series(sym);   /* Online: REAL legs only, no fabrication */
      if(d)use.push({sym:sym,d:d});
      else if(online&&window._imxSrc)window._imxSrc[sym]='unavailable \u2014 excluded';});
    if(!use.length||use[0].sym!=='BTCUSD'||use.length<2)return null;   /* BTC base + \u22652 legs or pause */
    var base=use[0].d,out=[],names=[];
    use.forEach(function(u){var d=u.d,r=[],j=0,lastC=d[0].c;
      for(var i=1;i<base.length;i++){var t=base[i].t;
        while(j<d.length-1&&d[j+1].t<=t)j++;      /* only bars at or before t */
        var c=d[j].c;r.push(Math.log(c/(lastC||c)));lastC=c;}
      names.push(u.sym);out.push(r);});
    return {names:names,rets:out};}
  window._imx=null;window._latMs=null;
  function tick(){try{if(!worker)return;var payload=alignedReturns();if(!payload){window._imx=null;renderIMXPaused();return}var t0=performance.now();
    worker.onmessage=function(ev){try{
      window._latMs=Math.round(performance.now()-t0);
      if(!ev.data.ok)return;window._imx=ev.data;renderIMX();
      var lt=document.getElementById('stLatV');if(lt){lt.textContent=window._latMs+'ms';lt.className=window._latMs>50?'slow':''}
      if(ev.data.anomaly.flag){try{ALERT_LOG.unshift({t:Date.now(),sym:'INTERMARKET',desc:'Structural anomaly: iForest '+ev.data.anomaly.iforest+' + Mahalanobis '+ev.data.anomaly.mahal+'sigma agree',val:''});if(window.updateBell)updateBell()}catch(e){}}
    }catch(e){}};
    worker.postMessage(payload);
  }catch(e){}}
  /* SMT divergence: BTC vs ETH unconfirmed highs/lows */
  function smt(){try{var onl=(typeof MODE!=='undefined'&&MODE==='online');var A=onl?seriesReal('BTCUSD'):series('BTCUSD'),B=onl?seriesReal('ETHUSD'):series('ETHUSD');if(!A||!B)return null;
    var sa=swings(A,3),sb=swings(B,3);
    if(sa.hi.length<2||sb.hi.length<2)return null;
    var aHH=A[sa.hi[sa.hi.length-1]].h>A[sa.hi[sa.hi.length-2]].h;
    var bHH=B[sb.hi[sb.hi.length-1]].h>B[sb.hi[sb.hi.length-2]].h;
    var aLL=A[sa.lo[sa.lo.length-1]].l<A[sa.lo[sa.lo.length-2]].l;
    var bLL=B[sb.lo[sb.lo.length-1]].l<B[sb.lo[sb.lo.length-2]].l;
    if(aHH!==bHH)return {kind:'bearish SMT',txt:'BTC/ETH highs unconfirmed: '+(aHH?'BTC':'ETH')+' made a higher high alone (smart-money warning at highs)'};
    if(aLL!==bLL)return {kind:'bullish SMT',txt:'BTC/ETH lows unconfirmed: '+(aLL?'BTC':'ETH')+' made a lower low alone (accumulation signal at lows)'};
    return null;}catch(e){return null}}
  window.renderIMX=function(){try{
    var anchor=document.getElementById('scoutCard')||document.querySelector('.side .card');if(!anchor)return;
    var card=document.getElementById('imxCard');
    if(!card){card=document.createElement('div');card.className='card';card.id='imxCard';
      card.innerHTML='<h3>Cross-Market Intelligence <span class="tag" title="One merged brain in the chart view: (1) correlation/anomaly ML — rolling correlations, z-spreads, isolation forest + Mahalanobis, volatility regime on the BTC/XAU/US10Y/DXY complex; (2) rotation — who is gaining or losing relative strength vs BTC across your cached symbols. Correlation says do-they-move-together; rotation says who-is-winning.">CORR \u00b7 ROTATION \u00b7 REGIME</span></h3><div id="imxBody">warming up\u2026</div><div id="imxRot" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--edge)"></div>';
      anchor.parentElement.insertBefore(card,anchor.nextSibling);}
    var m=window._imx;if(!m)return;var b=document.getElementById('imxBody');
    var SHORTN={BTCUSD:'BTC',XAUUSD:'XAU',US10Y:'10Y',DXY:'DXY'};var nm=(m.names||COMPLEX).map(function(s5){return SHORTN[s5]||s5});
    var grid='<div class="imx-grid" style="grid-template-columns:auto repeat('+nm.length+',1fr)"><span></span>'+nm.map(function(x){return '<span class="h" style="text-align:center">'+x+'</span>'}).join('');
    m.corr.forEach(function(row,i){grid+='<span class="h">'+nm[i]+'</span>'+row.map(function(v){
      var op=Math.min(.75,Math.abs(v)*.75);var col=v>=0?'rgba(45,190,142,'+op+')':'rgba(240,97,109,'+op+')';
      return '<span class="c" style="background:'+col+'">'+v.toFixed(2)+'</span>'}).join('');});
    grid+='</div>';
    var zs=m.spreads.map(function(sp){var pct=Math.max(-1,Math.min(1,sp.z/3));
      return '<div class="zg"><span style="min-width:88px;color:var(--muted2)">'+sp.k+'</span><span class="bar"><i style="'+(pct>=0?'left:50%;width:'+(pct*50)+'%':'right:50%;left:auto;width:'+(-pct*50)+'%')+'"></i></span><b class="'+(Math.abs(sp.z)>2?'hot':'')+'">'+sp.z.toFixed(2)+'z</b></div>'}).join('');
    var an=m.anomaly;var cls=an.flag?'alert':(an.iforest>0.55?'warn':'ok');
    var sm=smt();
    b.innerHTML='<span style="font-size:9.5px;letter-spacing:.08em;color:var(--muted2)">ROLLING CORRELATION (60)</span>'+grid
      +'<span style="font-size:9.5px;letter-spacing:.08em;color:var(--muted2)">SPREAD Z-SCORES</span>'+zs
      +'<div id="imxAnom">Anomaly: <b class="'+cls+'">'+(an.flag?'FLAGGED':an.iforest>0.55?'elevated':'normal')+'</b> \u00b7 iForest '+an.iforest+' \u00b7 Mahal '+an.mahal+'\u03c3'
      +'<br>Regime: <b style="color:'+(m.regime.pHighVol>0.5?'var(--bear)':'var(--bull)')+'">'+m.regime.state+'</b> (p='+m.regime.pHighVol+')'
      +(sm?'<br><b style="color:var(--gold)">'+sm.kind.toUpperCase()+'</b>: '+sm.txt:'')
      +'</div>';
  }catch(e){}};
  setTimeout(tick,2500);setInterval(tick,45000);
  /* latency HUD */
  try{var st=document.querySelector('.status');var tail=st.querySelector('.s[style*="margin-left"]');
    var e2=document.createElement('div');e2.className='s';e2.id='stLat';e2.innerHTML='Engine <b id="stLatV">\u2014</b>';st.insertBefore(e2,tail);}catch(e){}
}catch(e){}})();

