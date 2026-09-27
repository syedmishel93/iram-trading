/* ================= v14.1 AURORA DIMMER (T2) + CANDLE SKIN (C2) wiring ================= */
(function(){try{
  /* candle skin */
  var cs=null;try{cs=localStorage.getItem('mishel_candle')}catch(e){}
  if(cs==='muted'){CANDLE_SKIN='muted';_cbull=_cbear=null}
  var csel=document.getElementById('setCandle');
  if(csel){csel.value=CANDLE_SKIN;csel.onchange=function(){setCandleSkin(csel.value)}}
  /* aurora dimmer */
  var AUR={off:0,subtle:.4,balanced:.75,vivid:1},ORDER=['off','subtle','balanced','vivid'];
  function applyAur(k){if(!(k in AUR))k='balanced';document.body.style.setProperty('--aurora-op',String(AUR[k]));try{localStorage.setItem('mishel_aurora',k)}catch(e){}var s=document.getElementById('setAurora');if(s)s.value=k}
  var av=null;try{av=localStorage.getItem('mishel_aurora')}catch(e){}
  if(!av||!(av in AUR))av='balanced';
  applyAur(av);
  var asel=document.getElementById('setAurora');if(asel)asel.onchange=function(){applyAur(asel.value)};
  window.cycleAurora=function(){var cur='balanced';try{cur=localStorage.getItem('mishel_aurora')||'balanced'}catch(e){}var i=(ORDER.indexOf(cur)+1)%ORDER.length;applyAur(ORDER[i]);try{toast('Aurora: '+ORDER[i],var_bull())}catch(e){}};
}catch(e){}})();
/* ================= v12.9 TELEGRAM NOTIFICATIONS (analysis → your phone; you execute at your broker) ================= */
(function(){try{
  var cfg={token:'',chat:'',on:false};
  try{var s0=JSON.parse(localStorage.getItem('mishel_tg')||'null');if(s0&&typeof s0==='object')cfg={token:s0.token||'',chat:s0.chat||'',on:!!s0.on}}catch(e){}
  var tk=document.getElementById('tgToken'),ch=document.getElementById('tgChat'),on=document.getElementById('tgOn');
  if(tk)tk.value=cfg.token;if(ch)ch.value=cfg.chat;if(on)on.value=cfg.on?'1':'0';
  function save(){cfg.token=tk?tk.value.trim():cfg.token;cfg.chat=ch?ch.value.trim():cfg.chat;cfg.on=!!(on&&on.value==='1');
    try{localStorage.setItem('mishel_tg',JSON.stringify(cfg))}catch(e){}}
  if(tk)tk.addEventListener('input',save);if(ch)ch.addEventListener('input',save);if(on)on.addEventListener('change',save);
  var lastErr=0,lastSend=0;
  window.sendTG=async function(text,force){try{
    if(!cfg.token||!cfg.chat)return false;
    if(!cfg.on&&!force)return false;
    var now=Date.now();if(!force&&now-lastSend<3000)return false;lastSend=now; /* throttle auto-sends */
    try{var sv=await fetch('http://127.0.0.1:8788/svc/notify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:String(text).slice(0,3900)}),signal:AbortSignal.timeout(1500)});
      var sj=await sv.json();if(sj&&sj.ok)return true;}catch(e){}  /* server-side secrets first; fall back to browser token */
    if(!cfg.token||!cfg.chat)return false;
    var r=await fetch('https://api.telegram.org/bot'+cfg.token+'/sendMessage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:cfg.chat,text:String(text).slice(0,3900),disable_web_page_preview:true})});
    var j=await r.json();
    if(!j.ok){if(now-lastErr>60000){lastErr=now;toast('Telegram: '+(j.description||'send failed'),'var(--bear)')}return false}
    return true;
  }catch(e){var n2=Date.now();if(n2-lastErr>60000){lastErr=n2;toast('Telegram unreachable (network)','var(--bear)')}return false}};
  window.tgSnapshot=async function(){try{
    var txt='\ud83d\udcca '+CURSYM.sym+' \u00b7 '+TF+' \u00b7 '+new Date().toLocaleString()+'\n'+analystContextString()
      +'\n\u2014 analysis only \u00b7 not financial advice \u00b7 execute at your broker only if it fits your plan';
    var ok=await sendTG(txt,true);
    toast(ok?'Analysis sent to Telegram \u2713':'Telegram not configured \u2014 Settings \u2192 Telegram',ok?var_bull():'var(--gold)');
  }catch(e){}};
  var bt=document.getElementById('tgTest');if(bt)bt.onclick=async function(){save();
    var ok=await sendTG('\u2705 iram Intelligence \u2014 Telegram link works. Alert & analysis notifications will arrive here. (Analysis only \u2014 you execute at your broker.)',true);
    if(ok)toast('Telegram test sent \u2713',var_bull());};
  var bs=document.getElementById('tgSnap');if(bs)bs.onclick=function(){save();tgSnapshot()};
}catch(e){}})();
/* ================= v13.4 RAIL TOOLTIP (body-level, unclippable) ================= */
(function(){try{
  var tip=document.createElement('div');tip.id='railTip';document.body.appendChild(tip);
  var hideT=null;
  function pinned(){return document.querySelector('.app')&&document.querySelector('.app').classList.contains('rail-pinned')}
  function show(el){if(pinned())return;                       /* inline labels when pinned */
    var lbl=el.querySelector('.lbl');var txt=(lbl&&lbl.textContent)||el.title||'';if(!txt)return;
    var r=el.getBoundingClientRect();
    tip.textContent=txt;tip.style.left=(r.right+10)+'px';tip.style.top=(r.top+r.height/2)+'px';
    tip.classList.add('show');}
  function hide(){tip.classList.remove('show')}
  document.querySelectorAll('.rail .nav, .rail .rail-pin').forEach(function(el){
    el.addEventListener('mouseenter',function(){clearTimeout(hideT);show(el)});
    el.addEventListener('mouseleave',function(){hideT=setTimeout(hide,60)});
    el.addEventListener('click',hide);});
  window.addEventListener('scroll',hide,true);
}catch(e){}})();
/* ================= v13.5 #1 SIGNAL → PLAN → TELEGRAM (consensus-flip pipeline) ================= */
(function(){try{
  var sel=document.getElementById('tgPlan');var on=false;try{on=localStorage.getItem('mishel_tgplan')==='1'}catch(e){}
  if(sel){sel.value=on?'1':'0';sel.onchange=function(){on=sel.value==='1';try{localStorage.setItem('mishel_tgplan',on?'1':'0')}catch(e){}}}
  var last={sign:null,sentAt:0};
  setInterval(function(){try{
    if(!on||typeof MODE==='undefined'||MODE!=='online')return;
    if(!(window._lastTick&&Date.now()-window._lastTick<90000))return;   /* REAL fresh data only */
    var con=IND._consensus||consensusSignal(DATA);if(!con||!Number.isFinite(con.score))return;
    var s=Math.abs(con.score)>=25?(con.score>0?1:-1):0;
    if(last.sign===null){last.sign=s;return}                            /* baseline — never fire on boot */
    if(s===0||s===last.sign)return;
    last.sign=s;
    if(Date.now()-last.sentAt<600000)return;last.sentAt=Date.now();     /* ≥10 min between plans */
    var p=planTrade(s);var f2=function(v){return (+v).toFixed(p.dec!=null?p.dec:2)};
    var tps=p.tps.map(function(t,i){return 'TP'+(i+1)+' '+t.name+': '+f2(t.p)+' ('+t.rr.toFixed(1)+'R)'}).join('\n');
    var txt='\ud83d\udccb PLAN \u2014 '+CURSYM.sym+' '+TF+' \u00b7 consensus flipped \u2192 '+(s>0?'BUY':'SELL')+' (score '+con.score+(con.confidence?', conf '+con.confidence+'%':'')+')'
      +'\nEntry (mkt) '+f2(p.entry)
      +'\nStop '+f2(p.sl)+' ('+(p.stopDist/p.entry*100).toFixed(2)+'%)'
      +(tps?'\n'+tps:'')
      +'\nSize @'+p.riskPct+'% risk: '+(p.lots?p.lots.toFixed(2)+' lots':p.units.toFixed(4)+' units')+' ($'+p.dollars.toFixed(0)+')'
      +(!p.aligned?'\n\u26a0 counter-consensus \u2014 reduce size or skip':'')
      +(window._feedDelay?'\n\u26a0 data is DELAYED (yfinance) \u2014 verify price at your broker first':'')
      +'\n\u2014 analysis, not advice \u00b7 you decide & execute at your broker';
    if(window.sendTG)sendTG(txt,true);
    try{toast('Plan pushed to Telegram: '+(s>0?'BUY':'SELL')+' '+CURSYM.sym,var_bull())}catch(e){}
  }catch(e){}},45000);
}catch(e){}})();

/* v37.0 — the ticket builder, now sized from the BROKER'S REAL CONTRACT SPEC.
   The old path did units/100000 for anything matching /EUR|GBP|JPY|XAU/. XAUUSD's
   contract is 100 OUNCES, not 100,000 — so gold was sized 1000x too small, silently,
   for 36 versions. A guessed contract size is not a smaller error than a missing one;
   it is a bigger one, because you will actually trade it. */
function buildTicket5(x,pl,dec,sym5,acct5,risk5){
  var svcU=(window.SVC_URL||'http://127.0.0.1:8788');
  var side=(pl.dir||'').toLowerCase().indexOf('long')>=0?'long':'short';
  var entry=(pl.entryLo+pl.entryHi)/2;
  fetch(svcU+'/svc/risk/size',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({symbol:sym5,entry:entry,stop:pl.stop,risk_pct:risk5,equity:acct5})})
    .then(function(r){return r.json()})
    .then(function(j){
      var sizeLine, warn='';
      if(j.ok && j.detail){
        sizeLine='volume: '+j.lots.toFixed(2)+' lots   (contract '+j.detail.contract_size
          +', risks $'+j.detail.actual_risk_money.toFixed(2)+' = '+risk5+'% of $'+(+j.equity).toLocaleString()+')';
      } else if(j.ok && j.note){
        sizeLine='volume: \u2014';  warn='\n\u26a0 '+j.note;
      } else {
        /* HONEST: no spec -> no lot size. We do NOT fall back to the /100000 guess
           that has been wrong on gold since v1. */
        sizeLine='volume: \u2014 (NOT SIZED)';
        warn='\n\u26a0 '+(j.err||'no contract spec')
           +'\n\u26a0 Size this yourself in MT5. This terminal will not guess a contract size.';
      }
      var tkt='MT5 ORDER TICKET (manual entry \u2014 nothing auto-executes)\n'
        +'symbol: '+sym5+'\nside: '+pl.dir
        +'\ntype: limit @ '+fmtN(entry,dec)+' (zone '+fmtN(pl.entryLo,dec)+'\u2013'+fmtN(pl.entryHi,dec)+')'
        +'\n'+sizeLine
        +'\nSL: '+fmtN(pl.stop,dec)+'\nTP: '+fmtN(pl.t2,dec)+' (T1 '+fmtN(pl.t1,dec)+')'
        +'\nplan generated '+new Date().toISOString().slice(0,16).replace('T',' ')+' UTC'
        +(window._feedBroker?'\nfeed: YOUR BROKER (MT5)':'\n\u26a0 feed: '+(window._feedSrc||'vendor')
          +' \u2014 NOT your broker. Verify the price in MT5 before you place this.')
        + warn
        +'\n\u2014 analysis, not advice \u00b7 you decide & execute';
      prompt('Copy for MT5 (Ctrl+C):',tkt);
    })
    .catch(function(){
      alert('\u26a0 Could not size this ticket: the service (8788) is not running.\n\n'
        +'This terminal will NOT guess a contract size \u2014 that is how gold ends up sized '
        +'1000x wrong. Start mishel_service.py, or size it yourself in MT5.');
    });
}

