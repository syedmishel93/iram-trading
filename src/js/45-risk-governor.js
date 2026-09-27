/* ==================================================================
   v37.0 — RISK GOVERNOR (client)
   ------------------------------------------------------------------
   Risk was per-trade and nothing else. "1% per trade" is not a risk
   system; it is a sentence. Nothing knew how much you had lost today,
   how much risk was already open, or that long EURUSD + short USDCHF
   + long AUDUSD is not three 1% bets — it is ONE 3% bet on the dollar.

   The governor cannot stop you clicking Buy in MT5, and it must not
   try. What it can do is REFUSE TO BUILD THE TICKET. The last human
   step stays human; the system simply declines to make a bad trade
   convenient.
   ================================================================== */
(function(){
  function svc(){ return (window.SVC_URL||'http://127.0.0.1:8788') }
  function hdr(){ var h={'Content-Type':'application/json'};
    try{var t=localStorage.getItem('mishel_svctoken');if(t)h['Authorization']='Bearer '+t}catch(_){}
    return h }

  window._gov={verdict:null,state:null,at:0};

  /* Poll the governor. Enrolled in the v35 Clock, so it is try-guarded, counted,
     and catches up on tab wake like everything else. */
  window.govRefresh=function(){
    return fetch(svc()+'/svc/risk/state',{headers:hdr()})
      .then(function(r){return r.json()})
      .then(function(j){
        if(!j.ok) throw new Error('service');
        window._gov={verdict:j.verdict,state:j.state,cfg:j.config,at:Date.now()};
        govChip(); return j;
      })
      .catch(function(){
        /* The governor being DOWN is itself risk information. It is not "fine". */
        window._gov={verdict:null,state:null,at:Date.now(),down:true};
        govChip(); return null;
      });
  };

  function govChip(){
    var el=document.getElementById('stGov'); if(!el) return;
    var wrap=document.getElementById('stGovWrap')||el;
    var g=window._gov||{};
    if(g.down||!g.verdict){
      el.textContent='Risk ?'; el.style.color='var(--muted)';
      wrap.title='Risk governor unreachable \u2014 start mishel_service.py. '
             + 'Your daily loss, open risk and currency concentration are NOT being watched.';
      return;
    }
    var v=g.verdict.verdict, s=g.state||{};
    var col = v==='block'?'var(--bear)': v==='warn'?'var(--gold)':'var(--bull)';
    var txt = v==='block'?'RISK \u26d4' : v==='warn'?'RISK \u26a0' : 'Risk \u2713';
    el.textContent=txt+' '+(s.realized_R_today!=null?(s.realized_R_today>=0?'+':'')
                            +s.realized_R_today.toFixed(1)+'R':'');
    el.style.color=col;
    wrap.title=(g.verdict.reasons||[]).map(function(r){return '\u2022 '+r.msg}).join('\n\n');
  }

  /* ---------- THE GATE ----------
     Called before an order ticket is built. Returns a promise of {ok, verdict}.
     A BLOCK does not stop him trading. It stops US handing him the ticket. */
  window.govCheck=function(proposed){
    return fetch(svc()+'/svc/risk/check',{method:'POST',headers:hdr(),
      body:JSON.stringify(proposed||{})})
      .then(function(r){return r.json()})
      .then(function(j){
        if(!j.ok) throw new Error('service');
        window._gov={verdict:j.verdict,state:j.state,at:Date.now()};
        govChip();
        return {ok:j.verdict.verdict!=='block', verdict:j.verdict};
      })
      .catch(function(){
        /* Fail HONEST, not fail-open and not fail-closed-silently: say what we do not know. */
        return {ok:true, unknown:true, verdict:{verdict:'warn', reasons:[{rule:'blind',
          msg:'Risk governor unreachable — your daily loss, open risk and currency '
            + 'concentration are NOT being checked. This is a blind spot, not an all-clear.'}]}};
      });
  };

  /* ---------- the panel ---------- */
  window.govPanel=function(){
    var m=document.getElementById('govModal');
    if(!m){ m=document.createElement('div'); m.id='govModal';
      m.style.cssText='position:fixed;inset:0;z-index:770;background:rgba(4,6,10,.66);display:flex;'
        +'align-items:flex-start;justify-content:center;padding:5vh 16px;backdrop-filter:blur(3px)';
      m.onclick=function(e){ if(e.target===m) m.remove() };
      document.body.appendChild(m);
    }
    m.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;'
      +'max-width:880px;width:100%;max-height:86vh;overflow:auto;padding:18px">'
      +'<h3 style="margin:0 0 2px">\ud83d\udee1 Risk Governor \u2014 the account, not the trade</h3>'
      +'<div style="font-size:11px;color:var(--muted2);margin-bottom:10px">'
      +'Nothing here auto-executes. A BLOCK means the terminal will not build your order '
      +'ticket \u2014 you can still trade by hand. It just will not be made convenient.</div>'
      +'<div id="govBody" style="color:var(--muted);font-size:12px">loading\u2026</div></div>';
    govRender();
  };

  function govRender(){
    var b=document.getElementById('govBody'); if(!b) return;
    fetch(svc()+'/svc/risk/state',{headers:hdr()}).then(function(r){return r.json()})
      .then(function(j){
        if(!j.ok) throw new Error('service error');
        var s=j.state, v=j.verdict, c=j.config;
        var col = v.verdict==='block'?'var(--bear)': v.verdict==='warn'?'var(--gold)':'var(--bull)';
        var head='<div style="border:1px solid '+col+';border-radius:10px;padding:12px;'
          +'background:color-mix(in srgb,'+col+' 9%,transparent);margin-bottom:10px">'
          +'<div class="mono" style="font-size:16px;font-weight:800;color:'+col+';margin-bottom:6px">'
          +(v.verdict==='block'?'\u26d4 BLOCKED':v.verdict==='warn'?'\u26a0 CAUTION':'\u2713 CLEAR')+'</div>'
          + v.reasons.map(function(r){
              return '<div style="font-size:12px;line-height:1.55;color:var(--txt);margin:5px 0">\u2022 '+r.msg+'</div>';
            }).join('')
          +'</div>';

        var kb=function(l,val,cls){
          var cc = cls==='up'?'var(--bull)':cls==='dn'?'var(--bear)':'var(--txt)';
          return '<div style="flex:1;min-width:100px;background:color-mix(in srgb,var(--panel2) 60%,transparent);'
            +'border:1px solid var(--edge);border-radius:9px;padding:8px 10px">'
            +'<div style="font-size:9.5px;color:var(--muted2);text-transform:uppercase;letter-spacing:.4px">'+l+'</div>'
            +'<div class="mono" style="font-size:15px;font-weight:800;color:'+cc+'">'+val+'</div></div>';
        };
        var R=function(x){ return x==null?'\u2014':(x>=0?'+':'')+x.toFixed(2)+'R' };
        var stats='<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">'
          + kb('today', R(s.realized_R_today), s.realized_R_today>=0?'up':'dn')
          + kb('daily limit', '-'+(c.max_daily_loss_R).toFixed(1)+'R','')
          + kb('open risk', R(s.open_risk_R), s.open_risk_R>c.max_open_risk_R?'dn':'')
          + kb('trades today', s.trades_today+' / '+c.max_trades_per_day,'')
          + kb('loss streak', s.consecutive_losses+' / '+c.consecutive_loss_limit,
               s.consecutive_losses>=c.consecutive_loss_limit?'dn':'')
          + kb('equity', s.equity?('$'+(+s.equity).toLocaleString()):'\u2014', s.equity?'':'dn')
          + '</div>'
          + '<div style="font-size:10.5px;color:var(--muted2);margin-bottom:10px">equity + positions: '
          + (s.equity_source||'unknown') + '</div>';

        /* THE ONE NOBODY SEES */
        var net=(s.concentration&&s.concentration.net)||{};
        var keys=Object.keys(net).sort(function(a,b){return Math.abs(net[b])-Math.abs(net[a])});
        var conc = keys.length
          ? '<h4 style="margin:12px 0 6px;color:var(--txt);font-size:12.5px">Net currency exposure '
            +'<span style="font-weight:400;color:var(--muted2);font-size:10.5px">'
            +'\u2014 long EURUSD is long EUR / short USD. This is the bet you are actually making.</span></h4>'
            + '<div style="display:flex;gap:6px;flex-wrap:wrap">' + keys.map(function(k){
                var x=net[k], big=Math.abs(x)>c.max_concentration_R;
                var cc = big?'var(--bear)':Math.abs(x)>c.max_concentration_R*0.75?'var(--gold)':'var(--muted)';
                return '<div class="mono" style="border:1px solid '+cc+';color:'+cc+';border-radius:7px;'
                  +'padding:4px 9px;font-size:11.5px">'+k+' '+(x>=0?'+':'')+x.toFixed(2)+'R</div>';
              }).join('') + '</div>'
          : '<div style="font-size:11.5px;color:var(--muted2);margin:10px 0">'
            + (s.position_source_error
                ? '\u26a0 open positions UNKNOWN \u2014 '+s.position_source_error
                : 'No open positions.') + '</div>';

        var ups=(s.unprotected||[]);
        var upBox = ups.length
          ? '<div style="border:1px solid var(--bear);background:color-mix(in srgb,var(--bear) 12%,transparent);'
            +'border-radius:9px;padding:10px;margin:10px 0;color:var(--txt);font-size:12px;line-height:1.55">'
            +'<b>\u26d4 '+ups.length+' OPEN POSITION(S) WITH NO STOP LOSS:</b> '
            + ups.map(function(p){return p.symbol}).join(', ')
            +'<br>An unprotected position is not a trade. It is an open-ended bet on your own attention.'
            +'</div>' : '';

        var rules = '<h4 style="margin:14px 0 6px;color:var(--txt);font-size:12.5px">Your limits</h4>'
          + '<div id="govCfg" style="display:flex;gap:8px;flex-wrap:wrap">'
          + [['max_daily_loss_R','daily loss (R)'],['max_open_risk_R','max open risk (R)'],
             ['max_concentration_R','max 1-currency bet (R)'],['max_trades_per_day','trades / day'],
             ['max_risk_per_trade_pct','risk / trade (%)'],['consecutive_loss_limit','loss streak limit'],
             ['cooldown_minutes','cooldown (min)']].map(function(kv){
              return '<label style="font-size:10.5px;color:var(--muted2)">'+kv[1]+'<br>'
                +'<input class="govin" data-k="'+kv[0]+'" type="number" step="0.1" value="'+c[kv[0]]+'" '
                +'style="width:92px;background:var(--panel2);border:1px solid var(--edge);border-radius:6px;'
                +'padding:4px 6px;color:var(--txt);font-family:var(--mono)"></label>';
            }).join('') + '</div>'
          + '<button class="run" id="govSave" style="margin-top:10px">Save limits</button>'
          + '<div style="font-size:10.5px;color:var(--muted2);margin-top:8px;line-height:1.6">'
          + 'These are YOUR numbers, not ours. The defaults are a starting point. '
          + 'The governor is only worth having if you actually believe the limits you set.</div>';

        b.innerHTML = head + upBox + stats + conc + rules;

        var sv=document.getElementById('govSave');
        if(sv) sv.onclick=function(){
          var body={};
          document.querySelectorAll('.govin').forEach(function(i){ body[i.dataset.k]=+i.value });
          fetch(svc()+'/svc/risk/config',{method:'POST',headers:hdr(),body:JSON.stringify(body)})
            .then(function(r){return r.json()})
            .then(function(){ toast('Risk limits saved','var(--bull)'); govRender(); govRefresh() })
            .catch(function(){ toast('could not save \u2014 is the service running?','var(--bear)') });
        };
      })
      .catch(function(e){
        b.innerHTML='<div style="border:1px solid var(--gold);border-radius:9px;padding:12px;'
          +'color:var(--txt);font-size:12px;line-height:1.6">\u26a0 <b>The risk governor is not running.</b><br>'
          +'Your daily loss, open risk and currency concentration are <b>not being watched</b>. '
          +'That is not the same as being within your limits \u2014 it means nobody is looking.<br>'
          +'Start <span class="mono">mishel_service.py</span> (port 8788).</div>';
      });
  }

  /* poll on the Clock (try-guarded, counted, wake-catch-up) */
  setInterval(function(){ if(window.govRefresh) govRefresh() }, 45000);
  setTimeout(function(){ if(window.govRefresh) govRefresh() }, 2500);
})();

