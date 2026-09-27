window.renderWithheld = function(){
  try{
    var host=document.getElementById('sigPanel')||document.getElementById('sigBox');
    var SS=window._sigState; if(!SS) return;
    var old=document.getElementById('starWithheld'); if(old) old.remove();
    if(!SS.withheld || !host) return;

    var w=SS.withheld;
    var el=document.createElement('div');
    el.id='starWithheld';
    el.style.cssText='border:1px solid var(--gold);border-radius:9px;padding:10px;margin:8px 0;'
      +'background:color-mix(in srgb,var(--gold) 9%,transparent);line-height:1.55';
    el.innerHTML='<div class="mono" style="font-size:12.5px;font-weight:800;color:var(--gold);margin-bottom:6px">'
      +'\u2605 WITHHELD \u2014 no strategy promoted</div>'
      +'<div style="font-size:11.5px;color:var(--txt);margin-bottom:6px">The best of '
      +(w.trials||'?')+' strategies on this data was <b class="mono">'+(w.strat||'?')+'</b>. '
      +'It did not survive the overfitting audit, so it is <b>not</b> being shown to you as a pick.</div>'
      + (w.why||[]).map(function(r){
          return '<div style="font-size:11px;color:var(--muted);margin:3px 0">\u2022 '+r+'</div>' }).join('')
      +'<div style="font-size:10.5px;color:var(--muted2);margin-top:7px">'
      +'This is not a malfunction. Searching 26 strategies for the best one will ALWAYS produce a '
      +'winner \u2014 the question is whether that winner is real. Today, on this data, it is not '
      +'distinguishable from luck. The honest move is to trade something else, or nothing.</div>';
    host.insertBefore(el, host.firstChild);
  }catch(e){}
};

/* ---------------------------------------------------------------------
   3b. Cost provenance: he must always know what his numbers were costed with.
   --------------------------------------------------------------------- */
window.renderCostChip = function(){
  try{
    var el=document.getElementById('stCost'); if(!el||!window.costLabel) return;
    var c=window.costLabel();
    el.textContent=c.assumed?'Costs ASSUMED':'Costs REAL';
    el.style.color=c.assumed?'var(--gold)':'var(--bull)';
    var wrap=document.getElementById('stCostWrap')||el;
    wrap.title=c.assumed
      ? 'Every net-R, OOS win-rate and \u2605 pick on this screen is costed with a 2bps ASSUMPTION, '
        + 'and commission and swap are not counted at all. Gold at rollover is nothing like EURUSD '
        + 'at midday. Run the MT5 bridge and /svc/mt5/sync to cost them with your broker\u2019s real numbers.'
      : 'Costs come from your broker: real spread, real swap, and the commission you have ACTUALLY '
        + 'paid (derived from your own fills). Source: '+c.source;
  }catch(e){}
};

/* ---------------------------------------------------------------------
   4. THE PRE-MARKET RITUAL
   One screen, before London. Not a dashboard — a CHECKLIST with a verdict.
   Everything it shows, it already knows; the point is to put it in front of
   him ONCE, in order, before he is in a position and reasoning backwards.
   --------------------------------------------------------------------- */
window.preMarket = function(){
  var m=document.getElementById('pmModal');
  if(!m){ m=document.createElement('div'); m.id='pmModal';
    m.style.cssText='position:fixed;inset:0;z-index:780;background:rgba(4,6,10,.7);display:flex;'
      +'align-items:flex-start;justify-content:center;padding:4vh 16px;backdrop-filter:blur(3px)';
    m.onclick=function(e){ if(e.target===m) m.remove() };
    document.body.appendChild(m);
  }
  m.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;'
    +'max-width:760px;width:100%;max-height:88vh;overflow:auto;padding:20px">'
    +'<h3 style="margin:0 0 2px">\u2600 Pre-market \u2014 before you touch anything</h3>'
    +'<div style="font-size:11px;color:var(--muted2);margin-bottom:12px">'
    +'Five checks, in order. They are all things this terminal already knows. The point is to see '
    +'them BEFORE you are in a position and reasoning backwards.</div>'
    +'<div id="pmBody" style="font-size:12px;color:var(--muted)">loading\u2026</div></div>';
  pmRender();
};

function pmItem(state, title, body){
  var col = state==='fail'?'var(--bear)': state==='warn'?'var(--gold)':'var(--bull)';
  var ic  = state==='fail'?'\u26d4' : state==='warn'?'\u26a0' : '\u2713';
  return '<div style="display:flex;gap:10px;padding:11px;border-radius:9px;margin:6px 0;'
    +'border-left:3px solid '+col+';background:color-mix(in srgb,var(--panel2) 55%,transparent)">'
    +'<div style="font-size:15px;color:'+col+'">'+ic+'</div><div style="flex:1">'
    +'<div style="font-weight:700;color:var(--txt);font-size:12.5px">'+title+'</div>'
    +'<div style="font-size:11.5px;color:var(--muted);line-height:1.55;margin-top:3px">'+body+'</div>'
    +'</div></div>';
}

function pmRender(){
  var b=document.getElementById('pmBody'); if(!b) return;
  var out='', fails=0, warns=0;

  /* 1. Is the number on screen real? */
  try{
    var st=(window.Fresh?Fresh.state():'offline');
    if(st==='live'){ out+=pmItem('ok','The tape is live',
      (window._feedBroker?'Feed: YOUR BROKER (MT5). Every level and ATR below is computed on the '
        +'series you actually get filled on.'
        :'Feed: '+(window._feedSrc||'?')+'. For FX/metals this is a VENDOR, not your broker \u2014 '
        +'the levels are indicative. Connect MT5.')); if(!window._feedBroker) warns++; }
    else { out+=pmItem('fail','The tape is not tradeable',
      (window.Fresh?Fresh.why():'no feed')+' Decisions and the order ticket are BLOCKED until this is green.');
      fails++; }
  }catch(e){}

  /* 2. What is it costing? */
  try{
    var c=(window.costLabel?window.costLabel():null);
    if(c && c.assumed){ out+=pmItem('warn','Costs are an ASSUMPTION',
      'Every net-R and \u2605 pick on this screen is costed at a flat 2bps, with commission and swap '
      +'ignored. Run <span class="mono">/svc/mt5/sync</span> once and they become your broker\u2019s '
      +'real numbers.'); warns++; }
    else if(c){ out+=pmItem('ok','Costs are real','Spread, swap and the commission you have actually '
      +'paid, from your own fills. Source: '+c.source+'.'); }
  }catch(e){}

  /* 3. Is there anything honest to trade? */
  try{
    var SS=window._sigState;
    if(SS && SS.withheld){ out+=pmItem('warn','\u2605 withheld \u2014 no strategy survived the audit',
      'Best of '+(SS.withheld.trials||'?')+' was <b class="mono">'+SS.withheld.strat+'</b>, and it did not '
      +'clear the overfitting gate. Today the honest answer is: nothing here is distinguishable from luck. '
      +'Trading something else, or nothing, is a legitimate outcome.'); warns++; }
    else if(SS && SS.resolvedStrat){ var a=SS.audit||{};
      out+=pmItem('ok','\u2605 '+SS.resolvedStrat+' survived the audit',
      'PBO '+(a.pbo!=null?(a.pbo*100).toFixed(0)+'%':'n/a')+', deflated Sharpe '
      +(a.dsr!=null?(a.dsr*100).toFixed(0)+'%':'n/a')+' across '+(a.trials||'?')+' trials. '
      +'That is not proof of an edge \u2014 it is the absence of the specific lie we know how to test for.'); }
    else { out+=pmItem('warn','No signal engine running','Turn on Signals to get a graded pick.'); warns++; }
  }catch(e){}

  b.innerHTML=out+'<div id="pmRisk">checking the account\u2026</div>';

  /* 4 + 5. The account, and what it did to you yesterday. */
  var base=(window.SVC_URL||'http://127.0.0.1:8788');
  Promise.all([
    fetch(base+'/svc/risk/state').then(function(r){return r.json()}).catch(function(){return null}),
    fetch(base+'/svc/recon?days=30').then(function(r){return r.json()}).catch(function(){return null})
  ]).then(function(res){
    var rk=res[0], rc=res[1], o='';
    if(!rk || !rk.ok){
      o+=pmItem('warn','The risk governor is not running',
        'Your daily loss, open risk and currency concentration are NOT being watched. '
        +'That is not the same as being within your limits \u2014 it means nobody is looking.');
      warns++;
    } else {
      var v=rk.verdict, s=rk.state;
      o+=pmItem(v.verdict==='block'?'fail':v.verdict==='warn'?'warn':'ok',
        'Risk: '+(v.verdict==='block'?'BLOCKED':v.verdict==='warn'?'CAUTION':'clear'),
        v.reasons.map(function(r){return r.msg}).join('<br>'));
      if(v.verdict==='block') fails++; else if(v.verdict==='warn') warns++;
    }
    if(rc && rc.ok && !rc.empty && rc.stats && rc.stats.findings && rc.stats.findings.length){
      o+=pmItem('warn','What your execution actually did last month',
        rc.stats.findings.slice(0,3).map(function(f){return '\u2022 '+f}).join('<br>')
        +'<br><span style="color:var(--muted2)">Read this before you repeat it.</span>');
    } else if(rc && rc.empty){
      o+=pmItem('warn','Your real edge is still unmeasured',
        'No MT5 history imported. The journal\u2019s win-rate is the DEMO account\u2019s. '
        +'Click \u2696 and drop in a history report \u2014 it takes two minutes.');
      warns++;
    }

    var verdict = fails ? ['DO NOT TRADE YET','var(--bear)',
                    'At least one hard check failed. Fix it before you place anything.']
                : warns ? ['PROCEED WITH YOUR EYES OPEN','var(--gold)',
                    warns+' thing(s) above are not right. None of them stop you \u2014 they just mean '
                    +'you are trading with less information than you could have.']
                : ['CLEAR TO TRADE YOUR PLAN','var(--bull)',
                    'Every check passed. That is not a prediction and it is not permission \u2014 '
                    +'it only means nothing KNOWN is wrong.'];
    document.getElementById('pmRisk').innerHTML = o
      + '<div style="border:1px solid '+verdict[1]+';border-radius:10px;padding:12px;margin-top:12px;'
      + 'background:color-mix(in srgb,'+verdict[1]+' 10%,transparent)">'
      + '<div class="mono" style="font-size:15px;font-weight:800;color:'+verdict[1]+'">'+verdict[0]+'</div>'
      + '<div style="font-size:11.5px;color:var(--txt);margin-top:4px;line-height:1.55">'+verdict[2]+'</div></div>';
  });
}

/* costs refresh on the Clock; pre-market offered once per session at the London open */
