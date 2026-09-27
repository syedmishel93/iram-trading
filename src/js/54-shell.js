(function(){try{
  if(typeof addUserStrat!=='function')return;
  var PACK=[
    {name:'\u2605 EMA Pullback Trend',style:'custom',timeframe:'15m\u20134H',hold:'hours',
     long:[["ema50",">","ema200"],["close","crossabove","ema20"]],
     short:[["ema50","<","ema200"],["close","crossbelow","ema20"]],
     stop:{type:'atr',mult:2},tp:{type:'rr',value:2}},
    {name:'\u2605 Volatility Breakout',style:'custom',timeframe:'1H\u20131D',hold:'hours\u2013days',
     long:[["close","crossabove","bbu"]],short:[["close","crossbelow","bbl"]],
     stop:{type:'atr',mult:1.5},tp:{type:'rr',value:2.5}},
    {name:'\u2605 RSI-2 Mean Revert',style:'custom',timeframe:'1H\u20131D',hold:'1\u20135 bars',
     long:[["close",">","ema200"],["rsi","<","10"]],exitLong:[["rsi",">","60"]],
     stop:{type:'pct',value:2},tp:{type:'rr',value:1.5}},
    {name:'\u2605 MACD Momentum',style:'custom',timeframe:'1H\u20134H',hold:'hours',
     long:[["macdh","crossabove","0"],["close",">","ema200"]],
     short:[["macdh","crossbelow","0"],["close","<","ema200"]],
     stop:{type:'atr',mult:2},tp:{type:'rr',value:2}},
    {name:'\u2605 Stoch Scalp',style:'custom',timeframe:'1m\u201315m',hold:'minutes',
     long:[["stochk","crossabove","stochd"],["stochk","<","30"]],
     short:[["stochk","crossbelow","stochd"],["stochk",">","70"]],
     stop:{type:'atr',mult:1.2},tp:{type:'rr',value:1.5}},
    {name:'\u2605 VWAP Reclaim',style:'custom',timeframe:'5m\u20131H',hold:'intraday',
     long:[["close","crossabove","vwap"],["ema20",">","ema50"]],
     short:[["close","crossbelow","vwap"],["ema20","<","ema50"]],
     stop:{type:'atr',mult:1.5},tp:{type:'rr',value:2}}
  ];
  PACK.forEach(function(sp){try{if(typeof USER_STRATS==='undefined'||!USER_STRATS[sp.name])addUserStrat(sp)}catch(e){}});
}catch(e){}})();

/* ---- v8.0b: portfolio backtest across the watchlist ---- */
(function(){try{
  var runBtn=document.getElementById('runBt');if(!runBtn||!runBtn.parentElement)return;
  var b=document.createElement('button');b.className='tbtn';b.id='pbRun';b.textContent='\u25a4 Portfolio (watchlist)';b.title='Run the selected strategy across every watchlist symbol';
  runBtn.parentElement.appendChild(b);
  b.onclick=function(){try{
    var name=document.getElementById('stratSel').value;if(!name){toast('Pick a strategy first','var(--gold)');return}
    var spec;try{spec=specFor(name,CURSTYLE)}catch(e){toast('Cannot load strategy rules','var(--bear)');return}
    var syms=(typeof WATCH!=='undefined'&&WATCH.length?WATCH:['BTCUSD','ETHUSD','SOLUSD','EURUSD','XAUUSD']).slice(0,10);
    var rows=[],sum=0,nT=0;
    syms.forEach(function(sym){try{
      var d=genData(600,(SPECS[sym]||{px:100}).px,(sym.charCodeAt(0)+sym.length)*13+(TF.length*7));
      var tr=runStrategy(spec,d);var eq=1;tr.forEach(function(t){eq*=1+0.01*t.R});var ret=(eq-1)*100;
      sum+=ret;nT+=tr.length;
      rows.push({sym:sym,ret:ret,n:tr.length});}catch(e){rows.push({sym:sym,ret:null,n:0})}});
    rows.sort(function(a,c){return (c.ret||-999)-(a.ret||-999)});
    var host=document.getElementById('pbOut');
    if(!host){host=document.createElement('div');host.id='pbOut';host.className='panelbox';host.style.marginTop='16px';
      var anchor=document.getElementById('btStats');anchor.parentElement.insertBefore(host,anchor);}
    host.innerHTML='<h4>Portfolio backtest \u2014 '+name.replace(/</g,'&lt;')+' across '+rows.length+' symbols</h4>'
      +'<table class="log"><thead><tr><th>Symbol</th><th>Trades</th><th>Net return</th></tr></thead><tbody>'
      +rows.map(function(r){return '<tr><td><b>'+r.sym+'</b></td><td class="mono">'+r.n+'</td><td class="mono '+(r.ret>=0?'up':'dn')+'">'+(r.ret==null?'\u2014':(r.ret>=0?'+':'')+r.ret.toFixed(1)+'%')+'</td></tr>'}).join('')
      +'</tbody></table><div style="font-size:11px;color:var(--muted);margin-top:8px">Average <b class="'+(sum/rows.length>=0?'up':'dn')+'">'+(sum/rows.length>=0?'+':'')+(sum/rows.length).toFixed(1)+'%</b> \u00b7 '+nT+' total trades \u00b7 1% risk per trade \u00b7 synthetic data offline, real candles when Online. An edge that only works on one symbol is usually noise.</div>';
    toast('Portfolio backtest done','var(--bull)');
  }catch(e){toast('Portfolio backtest failed: '+e.message,'var(--bear)')}};
}catch(e){}})();

/* ---- v8.0c: named workspaces (save/load complete setups) ---- */
(function(){try{
  var mp=document.getElementById('morePanel');if(!mp)return;
  var sec=mp.querySelector('.more-sec');
  var s1=document.createElement('div');s1.className='more-item';s1.textContent='\ud83d\udcbe Save workspace as\u2026';
  var s2=document.createElement('div');s2.className='more-item';s2.textContent='\ud83d\udcc2 Load workspace\u2026';
  mp.insertBefore(s2,sec);mp.insertBefore(s1,s2);
  function names(){var out=[];for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('mishel_ws_')===0)out.push(k.slice(10))}return out}
  s1.onclick=function(){try{
    var n=prompt('Workspace name:','my-setup');if(!n)return;
    if(typeof persistSnapshot!=='function'){toast('Persistence engine unavailable','var(--bear)');return}
    localStorage.setItem('mishel_ws_'+n,JSON.stringify(persistSnapshot()));
    toast('Workspace \u201c'+n+'\u201d saved','var(--bull)');mp.style.display='none';
  }catch(e){toast('Save failed: '+e.message,'var(--bear)')}};
  s2.onclick=function(){try{
    var ns=names();if(!ns.length){toast('No saved workspaces yet','var(--gold)');return}
    var n=prompt('Load which workspace?\n\u2022 '+ns.join('\n\u2022 '),ns[0]);if(!n)return;
    var raw=localStorage.getItem('mishel_ws_'+n);if(!raw){toast('Not found: '+n,'var(--bear)');return}
    localStorage.setItem('mishel_state_v1',raw);localStorage.setItem('mishel_state_v1_on','1');
    toast('Loading \u201c'+n+'\u201d\u2026');setTimeout(function(){location.reload()},400);
  }catch(e){toast('Load failed: '+e.message,'var(--bear)')}};
}catch(e){}})();

/* ---- v8.0d: session report export (HTML download) ---- */
(function(){try{
  var mp=document.getElementById('morePanel');if(!mp)return;
  var anchor=mp.querySelector('[data-act="exportCsv"]');if(!anchor)return;
  var it=document.createElement('div');it.className='more-item';it.textContent='\ud83d\udcca Export session report';
  anchor.parentElement.insertBefore(it,anchor.nextSibling);
  it.onclick=function(){try{
    var h=PAPER.hist||[];var w=h.filter(function(t){return t.pl>0});
    var con=IND._consensus||{label:'\u2014',score:0,confidence:0};
    var mrows=(window.MISTAKES||[]).slice(-20).map(function(m){return '<tr><td>'+new Date(m.t).toLocaleString()+'</td><td>'+m.sym+'</td><td>'+m.tags.join(', ')+'</td><td style="color:'+(m.pl>=0?'#2DBE8E':'#F0616D')+'">'+m.pl.toFixed(2)+'</td></tr>'}).join('');
    var trows=h.slice(-30).map(function(t){return '<tr><td>'+(t.sym||'')+'</td><td>'+(t.side>0?'Long':'Short')+'</td><td>'+(t.entry!=null?t.entry.toFixed(2):'')+'</td><td>'+(t.exit!=null?t.exit.toFixed(2):'')+'</td><td style="color:'+(t.pl>=0?'#2DBE8E':'#F0616D')+'">'+(t.pl>=0?'+':'')+t.pl.toFixed(2)+'</td><td>'+(t.why||'')+'</td></tr>'}).join('');
    var html='<!doctype html><html><head><meta charset="utf-8"><title>iram session report</title><style>body{font-family:system-ui;background:#0B0E14;color:#D4DAE3;padding:32px;max-width:860px;margin:auto}h1{font-size:22px}h2{font-size:15px;margin-top:28px;color:#E8A33D}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:6px 8px;border-bottom:1px solid #232B38;text-align:left}small{color:#7A8494}</style></head><body>'
      +'<h1>iram Intelligence \u2014 session report</h1><small>'+new Date().toLocaleString()+' \u00b7 '+CURSYM.name+' \u00b7 '+TF+'</small>'
      +'<h2>Account</h2><p>Balance $'+PAPER.bal.toFixed(2)+' \u00b7 closed trades '+h.length+' \u00b7 win rate '+(h.length?Math.round(w.length/h.length*100):0)+'%</p>'
      +'<h2>Current consensus</h2><p>'+con.label+' \u00b7 score '+con.score+' \u00b7 agreement '+con.confidence+'%</p>'
      +'<h2>Closed trades (last 30)</h2><table><tr><th>Sym</th><th>Side</th><th>Entry</th><th>Exit</th><th>P&L</th><th>Exit by</th></tr>'+(trows||'<tr><td colspan=6>none</td></tr>')+'</table>'
      +'<h2>Mistake ledger</h2><table><tr><th>When</th><th>Sym</th><th>Tags</th><th>P&L</th></tr>'+(mrows||'<tr><td colspan=4>none tagged</td></tr>')+'</table>'
      +'<p><small>Demo account \u00b7 decision-support terminal \u00b7 not financial advice.</small></p></body></html>';
    var blob=new Blob([html],{type:'text/html'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);
    a.download='mishel-report-'+new Date().toISOString().slice(0,10)+'.html';a.click();
    toast('Report downloaded','var(--bull)');mp.style.display='none';
  }catch(e){toast('Report failed: '+e.message,'var(--bear)')}};
}catch(e){}})();


/* ================= v9.0 SHELL: living dock, tabs, hover cards, focus ================= */
(function(){try{
  function nav(v){return document.querySelector('.nav[data-view="'+v+'"]')}
  function ensure(el,cls){var e=el.querySelector('.'+cls.split(' ')[0]);if(!e){e=document.createElement('span');e.className=cls;el.appendChild(e)}return e}
  var seenAlerts=0;
  setInterval(function(){try{
    var a=nav('alerts');if(a){var n=(typeof ALERT_LOG!=='undefined'?ALERT_LOG.length:0);var b=ensure(a,'bdg');
      b.textContent=Math.min(99,Math.max(0,n-seenAlerts));b.classList.toggle('show',n>seenAlerts);
      a.addEventListener('click',function(){seenAlerts=(typeof ALERT_LOG!=='undefined'?ALERT_LOG.length:0);b.classList.remove('show')},{once:true});}
    var p=nav('paper');if(p&&typeof PAPER!=='undefined'){var pl=(PAPER.hist||[]).filter(function(t){return new Date(t.t||Date.now()).toDateString()===new Date().toDateString()}).reduce(function(x,t){return x+t.pl},0);
      var c=ensure(p,'chipv');if(Math.abs(pl)>=0.01){c.textContent=(pl>=0?'+':'-')+'$'+Math.abs(pl).toFixed(0);c.className='chipv show '+(pl>=0?'up':'dn')}else c.className='chipv';}
    var r=nav('risk');if(r&&typeof PAPER!=='undefined'){var eq=PAPER.bal+(typeof unrealized==='function'?unrealized():0);
      var heat=PAPER.pos.reduce(function(x,q){return x+Math.abs(q.entry-(q.sl!=null?q.sl:q.entry))*q.qty},0)/(eq||1)*100;
      var g=ensure(r,'ring');g.className='ring'+(heat>6?' hot':heat>3?' warm':'');g.title='Portfolio heat '+heat.toFixed(1)+'% of equity';}
  }catch(e){}},4000);
  var lastReg=null;setInterval(function(){try{var rg=classifyRegime(DATA).regime;var c2=nav('chart');
    if(c2&&lastReg&&rg!==lastReg)ensure(c2,'dotN').classList.add('show');
    if(c2)c2.addEventListener('click',function(){var d=c2.querySelector('.dotN');if(d)d.classList.remove('show')},{once:true});
    lastReg=rg;}catch(e){}},30000);
  var order=Array.from(document.querySelectorAll('.rail .nav'));
  document.addEventListener('keydown',function(e){
    var tag=(e.target.tagName||'').toLowerCase();if(tag==='input'||tag==='textarea'||tag==='select'||e.target.isContentEditable)return;
    if(e.ctrlKey&&e.key.toLowerCase()==='b'){e.preventDefault();document.querySelector('.app').classList.toggle('rail-hidden');return}
    if(!e.ctrlKey&&!e.metaKey&&!e.altKey){
      if(e.key==='z'||e.key==='Z'){document.querySelector('.app').classList.toggle('focusmode');try{fit();draw()}catch(_){}return}
      var k=parseInt(e.key,10);if(k>=1&&k<=9&&order[k-1])order[k-1].click();}
  });
}catch(e){}})();

