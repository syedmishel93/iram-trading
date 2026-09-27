(function(){
  function svc(){ return (window.SVC_URL||'http://127.0.0.1:8788') }
  function hdr(){ var h={'Content-Type':'application/json'};
    try{var t=localStorage.getItem('mishel_svctoken');if(t)h['Authorization']='Bearer '+t}catch(_){}
    return h }
  var R2 = function(v,d){ return v==null? '\u2014' : (v>=0?'+':'')+v.toFixed(d==null?2:d)+'R' };

  window.reconPanel=function(){
    var m=document.getElementById('reconModal');
    if(!m){ m=document.createElement('div'); m.id='reconModal';
      m.style.cssText='position:fixed;inset:0;z-index:760;background:rgba(4,6,10,.66);display:flex;'
        +'align-items:flex-start;justify-content:center;padding:5vh 16px;backdrop-filter:blur(3px)';
      m.onclick=function(e){ if(e.target===m) m.remove() };
      document.body.appendChild(m);
    }
    m.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;'
      +'max-width:960px;width:100%;max-height:86vh;overflow:auto;padding:18px">'
      +'<h3 style="margin:0 0 4px">\u2696 Execution Reconciliation \u2014 planned vs actual</h3>'
      +'<div id="reconBody" style="color:var(--muted);font-size:12px">loading\u2026</div></div>';
    reconLoad();
  };

  function importUI(){
    return '<div style="border:1px dashed var(--edge2);border-radius:10px;padding:14px;margin:10px 0">'
      +'<b style="color:var(--txt);font-size:12.5px">Import your MT5 history</b>'
      +'<div style="font-size:11px;color:var(--muted);line-height:1.6;margin:6px 0 10px">'
      +'MT5 \u2192 Toolbox \u2192 <b style="color:var(--txt)">History</b> \u2192 right-click \u2192 <b style="color:var(--txt)">Report</b> \u2192 HTML. '
      +'Then drop the file here. No Windows bridge needed \u2014 you can grade your execution in the next five minutes.'
      +'<br>Broker server time is usually UTC+2/+3. If your sessions look shifted, set the offset below \u2014 '
      +'we do NOT guess it, because a wrong offset silently misaligns every session, ORB and prev-day level.</div>'
      +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      +'<input type="file" id="reconFile" accept=".html,.htm,.csv" style="font-size:11px;color:var(--muted)">'
      +'<label style="font-size:11px;color:var(--muted)">broker UTC offset '
      +'<input id="reconOff" type="number" step="0.5" value="0" style="width:56px;background:var(--panel2);'
      +'border:1px solid var(--edge);border-radius:6px;padding:3px 6px;color:var(--txt);font-family:var(--mono)"></label>'
      +'<button class="run" id="reconSync">\u21bb Sync via MT5 bridge</button></div>'
      +'<div id="reconMsg" style="font-size:11px;margin-top:8px"></div></div>';
  }

  function wireImport(){
    var f=document.getElementById('reconFile');
    if(f) f.onchange=function(){
      var file=f.files&&f.files[0]; if(!file) return;
      var msg=document.getElementById('reconMsg');
      msg.innerHTML='<span style="color:var(--muted)">reading '+file.name+'\u2026</span>';
      var fr=new FileReader();
      fr.onload=function(){
        fetch(svc()+'/svc/mt5/import',{method:'POST',headers:hdr(),body:JSON.stringify({
          content:fr.result, filename:file.name,
          server_utc_offset_h:+(document.getElementById('reconOff')||{}).value||0})})
          .then(function(r){return r.json()})
          .then(function(j){
            if(!j.ok) throw new Error(j.err||'import failed');
            msg.innerHTML='<span style="color:var(--bull)">\u2713 '+j.stored+' deals imported from '+j.source
              +' ('+j.skipped_rows+' non-deal rows skipped)</span>'
              +(j.warnings&&j.warnings.length?'<div style="color:var(--gold);margin-top:4px">'
                 +j.warnings.map(function(w){return '\u26a0 '+w}).join('<br>')+'</div>':'');
            setTimeout(reconLoad,600);
          })
          .catch(function(e){ msg.innerHTML='<span style="color:var(--bear)">\u2717 '+e.message
            +' \u2014 is mishel_service.py running?</span>' });
      };
      fr.readAsText(file);
    };
    var s=document.getElementById('reconSync');
    if(s) s.onclick=function(){
      var msg=document.getElementById('reconMsg');
      msg.innerHTML='<span style="color:var(--muted)">asking the bridge\u2026</span>';
      fetch(svc()+'/svc/mt5/sync',{method:'POST',headers:hdr(),body:JSON.stringify({days:180})})
        .then(function(r){return r.json()})
        .then(function(j){
          if(!j.ok) throw new Error(j.err||'bridge unavailable');
          msg.innerHTML='<span style="color:var(--bull)">\u2713 '+j.stored+' deals \u00b7 '+j.specs
            +' instrument cost-profiles from your broker</span>';
          setTimeout(reconLoad,600);
        })
        .catch(function(e){ msg.innerHTML='<span style="color:var(--bear)">\u2717 '+e.message
          +'. The bridge needs Windows + a running, logged-in MT5. Use the report import instead \u2014 it works anywhere.</span>' });
    };
  }

  function reconLoad(){
    var b=document.getElementById('reconBody'); if(!b) return;
    fetch(svc()+'/svc/recon?days=180',{headers:hdr()})
      .then(function(r){return r.json()})
      .then(function(j){
        if(!j.ok) throw new Error(j.err||'service error');
        if(j.empty){
          /* honest empty: no dashboard of zeroes. A zero is a claim. */
          b.innerHTML='<div style="background:color-mix(in srgb,var(--bear) 10%,transparent);'
            +'border:1px solid var(--bear);border-radius:8px;padding:12px;margin-bottom:6px;'
            +'color:var(--txt);font-size:12px;line-height:1.6">'
            +'<b>Your real edge is currently unmeasured.</b><br>'
            +'The journal\u2019s win-rate and expectancy come from the <b>demo</b> account \u2014 '
            +'they are not your numbers. Nothing here knows what actually filled, at what price, '
            +'with what slippage, or whether the stop was honoured.</div>'
            + importUI();
          wireImport(); return;
        }
        var s=j.stats, F=s.findings||[];
        var head='<div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">'
          + box('trades', s.trades, '') + box('graded', s.graded+'/'+s.trades, '')
          + box('gross', R2(s.gross_expectancy_R), s.gross_expectancy_R>0?'up':'dn')
          + box('NET / trade', R2(s.net_expectancy_R), s.net_expectancy_R>0?'up':'dn')
          + box('exec drag', R2(s.execution_drag_R), 'dn')
          + box('plan adherence', s.plan_adherence_pct==null?'\u2014':s.plan_adherence_pct.toFixed(0)+'%',
                s.plan_adherence_pct>=70?'up':'dn')
          + box('capture', s.mfe_capture_median==null?'\u2014':(s.mfe_capture_median*100).toFixed(0)+'%',
                s.mfe_capture_median>=0.5?'up':'dn')
          + '</div>';
        var find = F.length ? '<div style="margin:10px 0">'+F.map(function(f){
              var bad=/DOES NOT|early|longer than winners|BEYOND|no plan/.test(f);
              return '<div style="padding:8px 10px;margin:4px 0;border-radius:8px;font-size:12px;line-height:1.55;'
                +'border-left:3px solid '+(bad?'var(--bear)':'var(--edge2)')+';'
                +'background:color-mix(in srgb,var(--panel2) 55%,transparent);color:var(--txt)">'+f+'</div>';
            }).join('')+'</div>' : '';
        var srcs=j.bar_sources||{};
        var srcNote=Object.keys(srcs).length
          ? '<div style="font-size:10.5px;color:var(--muted2);margin:6px 0">MFE/MAE bars: '
            + Object.keys(srcs).map(function(k){return k+' \u2190 '+srcs[k]}).join(' \u00b7 ') + '</div>'
          : '';
        var rows=(j.recons||[]).map(function(r){
          var bad = r.exit_reason==='beyond_stop';
          return '<tr'+(bad?' style="color:var(--bear)"':'')+'>'
            +'<td class="mono">'+r.symbol+'</td><td class="mono">'+r.side+'</td>'
            +'<td class="mono">'+R2(r.slippage_R)+'</td>'
            +'<td class="mono">'+R2(r.gross_R)+'</td>'
            +'<td class="mono">'+(r.cost_R==null?'\u2014':r.cost_R.toFixed(3)+'R')+'</td>'
            +'<td class="mono"><b>'+R2(r.net_R)+'</b></td>'
            +'<td class="mono">'+(r.mfe_R==null?'\u2014':R2(r.mfe_R))+'</td>'
            +'<td class="mono">'+(r.mfe_capture==null?'\u2014':(r.mfe_capture*100).toFixed(0)+'%')+'</td>'
            +'<td class="mono">'+(r.exit_reason||'\u2014')+'</td></tr>';
        }).join('');
        b.innerHTML = head + find + srcNote
          + '<table class="log" style="width:100%"><thead><tr><th>symbol</th><th>side</th><th>slip</th>'
          + '<th>gross</th><th>cost</th><th>NET</th><th>MFE</th><th>capture</th><th>exit</th></tr></thead>'
          + '<tbody>'+rows+'</tbody></table>'
          + '<div style="font-size:10.5px;color:var(--muted2);margin-top:8px;line-height:1.6">'
          + 'R is defined by YOUR plan (|entry \u2212 stop|). Slippage is measured against the entry you '
          + 'wrote down, costs are the broker\u2019s own commission + swap (never modelled), and a dash means '
          + '<b>not measurable</b> \u2014 not zero.</div>'
          + importUI();
        wireImport();
      })
      .catch(function(e){
        b.innerHTML='<span style="color:var(--bear)">\u2717 '+e.message
          +' \u2014 start mishel_service.py (port 8788) to reconcile.</span>'+importUI();
        wireImport();
      });
  }

  function box(lbl,val,cls){
    var col = cls==='up'?'var(--bull)':cls==='dn'?'var(--bear)':'var(--txt)';
    return '<div style="flex:1;min-width:96px;background:color-mix(in srgb,var(--panel2) 60%,transparent);'
      +'border:1px solid var(--edge);border-radius:9px;padding:8px 10px">'
      +'<div style="font-size:9.5px;color:var(--muted2);text-transform:uppercase;letter-spacing:.4px">'+lbl+'</div>'
      +'<div class="mono" style="font-size:15px;font-weight:800;color:'+col+'">'+val+'</div></div>';
  }

  /* MT5 connection tester in Settings */
  setTimeout(function(){
    var b=document.getElementById('mt5Test'); if(!b) return;
    b.onclick=function(){
      var st=document.getElementById('mt5Stat');
      st.innerHTML='<span style="color:var(--muted)">testing\u2026</span>';
      fetch(proxyBase()+'/mt5/health').then(function(r){return r.json()}).then(function(j){
        if(j.available && j.connected!==false){
          st.innerHTML='<span style="color:var(--bull)">\u2713 MT5 connected \u2014 set the proxy provider to '
            +'<b>mt5</b> and your charts become YOUR broker\u2019s prices</span>';
        } else {
          st.innerHTML='<span style="color:var(--gold)">\u26a0 '+(j.reason||'unavailable')+'</span>';
        }
      }).catch(function(e){
        st.innerHTML='<span style="color:var(--bear)">\u2717 proxy unreachable ('+e.message
          +'). Set the Proxy URL above and run ddt_data_server.py.</span>';
      });
    };
  },1500);
})();

