/* ================= v29.0 TV-INTERFACE (T1-T10) ================= */
(function(){
  var cvEl=document.getElementById('chart');if(!cvEl)return;
  var wrap=cvEl.parentElement;
  /* T1: drawbar docked + open by default */
  if(localStorage.getItem('mishel_drawbar')!=='0'){document.body.classList.add('tvdock');var db=document.getElementById('drawbar');if(db)db.classList.add('open');}
  var dt=document.getElementById('drawToggle');
  if(dt){var _old=dt.onclick;dt.addEventListener('click',function(){var on=document.getElementById('drawbar').classList.contains('open');localStorage.setItem('mishel_drawbar',on?'1':'0');document.body.classList.toggle('tvdock',on);});}
  /* helpers from live chart map */
  function M(){return window._chartMap||null}
  function pxToPrice(yPix){var m=M();if(!m)return null;var frac=1-yPix/m.priceH;var v=m.la+frac*m.ls;return m.lg?Math.exp(v):v}
  function priceToPx(pr){var m=M();if(!m)return null;var v=m.lg?Math.log(pr>0?pr:1e-9):pr;return (1-(v-m.la)/m.ls)*m.priceH}
  function pxToBar(xPix){var m=M();if(!m)return null;var i=Math.floor(xPix/m.cw);return Math.max(0,Math.min(m.end-m.start-1,i))+m.start}
  /* T2: axis bubbles on crosshair */
  var axP=document.getElementById('axPx'),axT=document.getElementById('axTm');
  cvEl.addEventListener('mousemove',function(e){try{var m=M();if(!m){axP.style.display=axT.style.display='none';return}
    var r=cvEl.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    if(y<=m.priceH&&x<=m.W-m.padR){var pr=pxToPrice(y);
      if(pr!=null&&isFinite(pr)){axP.textContent=fmt(pr);axP.style.top=y+'px';axP.style.display='block';}
      var bi=pxToBar(x);var bar=DATA[bi];
      if(bar){var d2=new Date(bar.t);axT.textContent=d2.getUTCDate()+'/'+(d2.getUTCMonth()+1)+' '+('0'+d2.getUTCHours()).slice(-2)+':'+('0'+d2.getUTCMinutes()).slice(-2);
        axT.style.left=Math.min(m.W-60,Math.max(40,x))+'px';axT.style.display='block';}
    }else{axP.style.display=axT.style.display='none';}
    /* T10: signal hover card */
    var tip=document.getElementById('sigTip');var SS=window._sigState;
    if(tip&&SS&&SS.on&&SS._hit&&SS._hit.length){var hit=null;
      for(var i=0;i<SS._hit.length;i++){var h2=SS._hit[i];if(Math.abs(h2.x-x)<9&&Math.abs(h2.y-y)<11){hit=h2;break}}
      if(hit){var sg=hit.sig;var nm=(window.SIG_STRATS[SS.resolvedStrat||SS.strat]||{}).name||'';
        tip.innerHTML='<b style="color:'+(sg.dir===1?'var(--bull)':'var(--bear)')+'">'+(sg.dir===1?'\u25b2 LONG':'\u25bc SHORT')+'</b> \u00b7 '+nm
          +(sg.q!=null?' \u00b7 Q '+sg.q:'')+'<br>entry '+fmt(sg.entry)+' \u00b7 stop '+fmt(sg.stop)
          +'<br>T1 '+fmt(sg.t1)+' \u00b7 T2 '+fmt(sg.t2)
          +'<br>outcome: <b>'+(sg.res==='open'?'still open':sg.res==='time'?'timed out (\u00b10R)':sg.res==='stop'?'stopped (\u22121R)':sg.res.toUpperCase()+' hit (+'+(sg.res==='t2'?2:1)+'R)')+'</b>';
        try{const cal=window.qCalib(SS.sigs);if(sg.q!=null){const bk=sg.q<40?'0-40':sg.q<60?'40-60':sg.q<80?'60-80':'80+';const cb=cal[bk];
          if(cb&&cb.n>=4)tip.innerHTML+='<br><span style="color:var(--muted2);font-size:9px">Q '+bk+' here: '+(cb.rate*100).toFixed(0)+'% measured ('+cb.n+')</span>';}
        if(sg.res==='open'){const mm=window.sigMemo(sg);if(mm)tip.innerHTML+='<div style="margin-top:3px;border-top:1px dashed var(--edge);padding-top:2px;font-size:9px;color:var(--muted)">'+mm.map(function(l5){return '\u2022 '+l5}).join('<br>')+'</div>';}}catch(e){}
        tip.style.left=Math.min(x+14,(m?m.W:600)-190)+'px';tip.style.top=Math.max(6,y-14)+'px';tip.style.display='block';}
      else tip.style.display='none';}
  }catch(e){}});
  cvEl.addEventListener('mouseleave',function(){axP.style.display=axT.style.display='none';var t2=document.getElementById('sigTip');if(t2)t2.style.display='none';});
  /* T3: bar-close countdown pinned at the last-price axis level */
  var cd=document.getElementById('axCd');
  function tfMs(){var map={'1m':6e4,'5m':3e5,'15m':9e5,'1h':36e5,'4h':144e5,'1d':864e5};return map[TF]||36e5}
  setInterval(function(){try{var m=M();if(!m||!DATA.length||!document.getElementById('v-chart').classList.contains('on')){cd.style.display='none';return}
    var last=DATA[DATA.length-1];var rem=tfMs()-(Date.now()-last.t);if(rem<0)rem=((rem%tfMs())+tfMs())%tfMs();
    var mm=Math.floor(rem/60000),ss=Math.floor(rem%60000/1000);
    cd.textContent=(mm>=60?Math.floor(mm/60)+'h'+('0'+mm%60).slice(-2):mm+':'+('0'+ss).slice(-2));
    var yy=priceToPx(last.c);if(yy==null||!isFinite(yy)){cd.style.display='none';return}
    cd.style.top=yy+'px';cd.style.display='block';
  }catch(e){}},1000);
  /* T5: axis interactions — drag y to scale, drag x to zoom, right-click axis menu */
  var dragAx=null;
  cvEl.addEventListener('mousedown',function(e){var m=M();if(!m)return;var r=cvEl.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    if(x>m.W-m.padR&&y<m.priceH)dragAx={ax:'y',y0:y,pad0:window.YPAD||0.08};
    else if(y>m.H-26)dragAx={ax:'x',x0:x,c0:VIEW.count};});
  window.addEventListener('mousemove',function(e){if(!dragAx)return;var r=cvEl.getBoundingClientRect();
    if(dragAx.ax==='y'){var dy=(e.clientY-r.top)-dragAx.y0;window.YPAD=Math.max(0.02,Math.min(0.45,dragAx.pad0+dy*0.0015));try{draw()}catch(e2){}}
    else{var dx=(e.clientX-r.left)-dragAx.x0;try{setBars(dragAx.c0*(1+dx*0.004))}catch(e2){}}});
  window.addEventListener('mouseup',function(){dragAx=null});
  cvEl.addEventListener('contextmenu',function(e){var m=M();if(!m)return;var r=cvEl.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    if(x>m.W-m.padR&&y<m.priceH){e.preventDefault();e.stopPropagation();
      var prAt=pxToPrice(y);
      var pick=prompt('Y-axis:\n1 = reset scale\n2 = toggle '+(m.lg?'LINEAR':'LOG')+' scale\n3 = \u{1F514} alert at '+(prAt!=null?fmt(prAt):'?')+'\n\nType 1, 2 or 3:');
      if(pick==='1'){window.YPAD=0.08;try{draw()}catch(e2){}}
      else if(pick==='2'){window._lg=!m.lg;try{draw()}catch(e2){}toast('scale: '+(window._lg?'log':'linear'),'var(--accent,#5B8DEF)')}
      else if(pick==='3'&&prAt!=null){try{var lastC=DATA[DATA.length-1].c;var op=prAt>=lastC?'>=':'<=';
        ALERTS.push({sym:CURSYM.sym,op:op,px:prAt,note:'axis alert (B6)',fired:null});if(typeof saveAlerts==='function')saveAlerts();
        toast('\u{1F514} alert: '+CURSYM.sym+' '+op+' '+fmt(prAt),'var(--gold)')}catch(e3){toast('alert engine not available here','var(--muted)')}}
    }},true);
  /* T9: watchlist mini-rail */
  /* B2: drawings 2.0 — magnet toggle, per-symbol persistence, properties popover */
  window.MAGNET=localStorage.getItem('mishel_magnet')==='1';
  (function(){var db2=document.getElementById('drawbar');if(!db2)return;
    var mb=document.createElement('button');mb.id='magnetBtn';mb.title='Magnet: snap drawings to O/H/L/C of the bar under the cursor';mb.textContent='\u{1F9F2}';
    mb.style.cssText='font-size:13px';if(window.MAGNET)mb.style.color='var(--gold)';
    mb.onclick=function(){window.MAGNET=!window.MAGNET;localStorage.setItem('mishel_magnet',window.MAGNET?'1':'0');mb.style.color=window.MAGNET?'var(--gold)':'';toast('magnet '+(window.MAGNET?'ON \u2014 snaps to OHLC':'off'),'var(--accent,#5B8DEF)')};
    db2.appendChild(mb);})();
  function drwKey(){try{return 'mishel_drw:'+CURSYM.sym+'|'+TF}catch(e){return 'mishel_drw:?'}}
  window.drwSave=function(){try{localStorage.setItem(drwKey(),JSON.stringify((DRAWINGS||[]).slice(0,200)))}catch(e){}};
  window.drwLoad=function(){try{var v=localStorage.getItem(drwKey());if(v){DRAWINGS=JSON.parse(v);draw()}}catch(e){}};
  setTimeout(window.drwLoad,1200);
  (function(){var lastK=drwKey();setInterval(function(){try{var k=drwKey();
    if(k!==lastK){lastK=k;window.drwLoad();return}
    window.drwSave();}catch(e){}},4000);})();
  /* properties popover on double-click of a selected drawing */
  cvEl.addEventListener('dblclick',function(e){try{if(typeof SELDRAW==='undefined'||SELDRAW<0||!DRAWINGS[SELDRAW])return;
    var d3=DRAWINGS[SELDRAW];
    var c3=prompt('Drawing properties \u2014 color,width,dash (e.g. #E8A33D,2,dash) \u00b7 or type: lock / dup / del',(d3.col||'#4C82FB')+','+(d3.w||1)+','+(d3.dash?'dash':'solid'));
    if(c3==null)return;c3=c3.trim();
    if(c3==='del'){DRAWINGS.splice(SELDRAW,1);SELDRAW=-1}
    else if(c3==='dup'){var cp=JSON.parse(JSON.stringify(d3));if(cp.y1!=null){var m=window._chartMap;var off2=m?(m.hi-m.lo)*0.02:0;cp.y1+=off2;if(cp.y2!=null)cp.y2+=off2}DRAWINGS.push(cp)}
    else if(c3==='lock'){d3.lock=!d3.lock;toast(d3.lock?'locked':'unlocked','var(--muted)')}
    else{var pr3=c3.split(',');if(pr3[0])d3.col=pr3[0].trim();if(pr3[1])d3.w=+pr3[1]||1;d3.dash=/dash/.test(pr3[2]||'');}
    window.drwSave();draw();e.preventDefault();e.stopPropagation();}catch(e2){}},true);
  /* E3 toggle */
  var vpb=document.getElementById('vpvrBtn');window._vpvrOn=localStorage.getItem('mishel_vpvr')==='1';
  if(vpb){vpb.classList.toggle('on',window._vpvrOn);vpb.onclick=function(){window._vpvrOn=!window._vpvrOn;localStorage.setItem('mishel_vpvr',window._vpvrOn?'1':'0');vpb.classList.toggle('on',window._vpvrOn);try{draw()}catch(e){}}}
  /* B1: drag the divider just above the sub-panes to resize them (persisted) */
  var paneDrag=null;
  cvEl.addEventListener('mousedown',function(e){try{var m=M();if(!m)return;var r=cvEl.getBoundingClientRect(),y=e.clientY-r.top;
    var panesTop=m.H-26-((window.PANE_H||86)*(typeof PANES!=='undefined'?PANES.size:0));
    if(typeof PANES!=='undefined'&&PANES.size&&Math.abs(y-panesTop)<6){paneDrag={y0:y,h0:window.PANE_H||86};e.stopPropagation()}}catch(e2){}},true);
  window.addEventListener('mousemove',function(e){if(!paneDrag)return;var r=cvEl.getBoundingClientRect();
    var dy=paneDrag.y0-(e.clientY-r.top);window.PANE_H=Math.max(44,Math.min(150,paneDrag.h0+dy/Math.max(1,PANES.size)));try{draw()}catch(e2){}});
  window.addEventListener('mouseup',function(){if(paneDrag){localStorage.setItem('mishel_paneh',Math.round(window.PANE_H||86));paneDrag=null}});
  try{var ph0=+(localStorage.getItem('mishel_paneh')||0);if(ph0)window.PANE_H=ph0}catch(e){}
  /* C5: signal-fire alerts */
  function sigAlertsLoad(){try{return JSON.parse(localStorage.getItem('mishel_sigalerts')||'[]')}catch(e){return[]}}
  var sbell=document.getElementById('sigBellBtn');
  function sbellSync(){try{var A2=sigAlertsLoad();var on=A2.some(function(a){return a.sym===CURSYM.sym&&a.tf===TF});sbell.classList.toggle('on',on)}catch(e){}}
  if(sbell){sbell.onclick=function(){var SS=window._sigState;
    if(!SS.on||!SS.resolvedStrat){toast('pick a strategy in Signals\u2026 first','var(--muted)');return}
    var A2=sigAlertsLoad();var k={sym:CURSYM.sym,tf:TF,strat:SS.resolvedStrat};
    var ix=A2.findIndex(function(a){return a.sym===k.sym&&a.tf===k.tf});
    if(ix>=0){A2.splice(ix,1);toast('sig-alert off for '+k.sym+' '+k.tf,'var(--muted)');sigArmServer(k,false)}
    else{A2.push(k);sigArmServer(k,true)}
    try{STORE.set('mishel_sigalerts',JSON.stringify(A2))}catch(e){}sbellSync();};
    setInterval(sbellSync,5000);}

  /* ============ v35.0 STAGE E: ARM IT ON THE SERVER ============
     Before:  armed an alert that lived in this tab. Close the tab -> the alert
     is gone, and silence looked exactly like "no setup today". That is the whole
     operational bug, in one button.
     After: the same click writes a row to sig_watch on the service. sig_loop then
     runs the SAME shipped strategy (sig_worker.js extracts it from this very file)
     every 60s with the browser CLOSED, and Telegrams the fire with its measured
     record attached. If the service is down we SAY SO — we never imply cover we
     do not have. =========================================================== */
  window.sigArmServer=function(k,on){
    try{
      var base=(window.SVC_URL||'http://127.0.0.1:8788');
      var hdr={'Content-Type':'application/json'};
      try{var t=localStorage.getItem('mishel_svctoken');if(t)hdr['Authorization']='Bearer '+t}catch(_){}
      var qg=(window._sigQGate!==false)?50:0;
      var nm=(window.SIG_STRATS[k.strat]||{}).name||k.strat;
      if(on){
        fetch(base+'/svc/sig/watch',{method:'POST',headers:hdr,
          body:JSON.stringify({sym:k.sym,tf:k.tf,strategy:k.strat,q_gate:qg})})
          .then(function(r){return r.json()})
          .then(function(j){
            if(!j||!j.ok)throw new Error('service refused');
            toast('\u{1F514} '+nm+' armed ON THE SERVER \u2014 '+k.sym+' '+k.tf+
                  ' \u00b7 fires even with this tab closed','var(--gold)');
          })
          .catch(function(){
            /* honest: the tab-only alert still works, but say plainly what you do NOT have */
            toast('\u26a0 '+nm+' armed IN THIS TAB ONLY \u2014 service unreachable, so it will NOT fire '+
                  'if you close the browser. Start mishel_service.py for always-on alerts.','var(--bear)');
          });
      } else {
        fetch(base+'/svc/sig/watch',{headers:hdr}).then(function(r){return r.json()})
          .then(function(j){
            var row=(j.watch||[]).find(function(w){
              return w.sym===k.sym&&w.tf===k.tf&&w.strategy===k.strat});
            if(row)return fetch(base+'/svc/sig/watch/'+row.id,{method:'DELETE',headers:hdr});
          }).catch(function(){});
      }
    }catch(e){}
  };
  /* C7: journal button + panel */
  var jb=document.getElementById('jrnBtn');
  if(jb)jb.onclick=function(){var j=jrnLoad();
    var m2=document.getElementById('jrnModal');
    if(!m2){m2=document.createElement('div');m2.id='jrnModal';
      m2.style.cssText='position:fixed;inset:0;z-index:720;background:rgba(4,6,10,.6);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;backdrop-filter:blur(3px)';
      m2.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;max-width:680px;width:100%;max-height:80vh;overflow:auto;padding:16px 18px" id="jrnBody"></div>';
      m2.onclick=function(e){if(e.target===m2)m2.style.display='none'};document.body.appendChild(m2);}
    m2.style.display='flex';var bd=document.getElementById('jrnBody');
    var rows=j.map(function(e){var res=e.res;if((!res||res==='open')&&e.sym===CURSYM.sym&&e.tf===TF){res=jrnResolve(e,DATA);e.res=res;}
      return '<tr><td style="font-size:9.5px">'+new Date(e.t).toISOString().slice(5,16).replace('T',' ')+'</td><td class="mono" style="font-size:10px">'+e.sym+' '+e.tf+'</td><td style="color:'+(e.dir===1?'var(--bull)':'var(--bear)')+'">'+(e.dir===1?'LONG':'SHORT')+'</td><td class="mono" style="font-size:10px">'+fmt(e.entry)+'</td><td style="font-size:10px;color:'+(e.res==='stop'?'var(--bear)':e.res&&e.res!=='open'?'var(--bull)':'var(--muted2)')+'">'+(e.res||'open')+'</td></tr>'}).join('');
    jrnSave(j);
    var done=j.filter(function(e){return e.res&&e.res!=='open'});var wins=done.filter(function(e){return e.res!=='stop'}).length;
    bd.innerHTML='<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><b style="font-size:14px">\u{1F4D3} Decision Journal</b><span style="font-size:10px;color:var(--muted2)">'+j.length+' taken \u00b7 '+done.length+' resolved'+(done.length?' \u00b7 YOUR record: '+Math.round(wins/done.length*100)+'% win':'')+'</span><button class="tbtn" style="margin-left:auto" onclick="document.getElementById(\'jrnModal\').style.display=\'none\'">\u2715</button></div>'
      +(j.length?'<table class="log" style="width:100%"><thead><tr><th>when</th><th>market</th><th>side</th><th>entry</th><th>outcome</th></tr></thead><tbody>'+rows+'</tbody></table>':'<div style="font-size:11px;color:var(--muted2)">Empty \u2014 when a live signal fires, use \u201cI took this\u201d in the toastless plan (cockpit Trade Plan card gains the button). Your execution gets measured with the same stop-first honesty as the engine.</div>')
      +'<div style="font-size:9px;color:var(--muted2);margin-top:10px">resolved against bar data, stop-first conservative \u2014 same rules as the strategy record \u00b7 compare your % to the OOS legend</div>';};
  /* C4: per-symbol best-strategy suggestion (once per symbol change) */
  (function(){var lastSym=null;setInterval(function(){try{
    if(!CURSYM||CURSYM.sym===lastSym)return;lastSym=CURSYM.sym;
    var m3=sigMemGet(CURSYM.sym,TF);var SS=window._sigState;
    if(m3&&m3.strat&&!SS.on&&m3.avgR!=null)
      toast('\u{1F4A1} memory: '+((window.SIG_STRATS[m3.strat]||{}).name||m3.strat)+' had the best OOS record here ('+(m3.avgR>=0?'+':'')+(+m3.avgR).toFixed(2)+'R) \u2014 Signals\u2026 \u2192 \u2605 to use','var(--accent,#5B8DEF)');
  }catch(e){}},4000);})();
  /* M9: draggable plan \u2014 grab entry/stop/T1/T2 lines of the live setup, sizer recomputes */
  var planDrag=null;
  cvEl.addEventListener('mousedown',function(e){try{var m=M();if(!m)return;var SS=window._sigState;var lv=SS&&SS.sigs&&SS.sigs[SS.sigs.length-1];
    if(!SS||!SS.on||!lv||lv.res!=='open')return;
    var r=cvEl.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    if(x<m.W-m.padR-115||x>m.W-m.padR)return;
    var o2=window._planOv||{};var vals={entry:o2.entry!=null?o2.entry:lv.entry,stop:o2.stop!=null?o2.stop:lv.stop,t1:o2.t1!=null?o2.t1:lv.t1,t2:o2.t2!=null?o2.t2:lv.t2};
    var best=null,bd=8;Object.keys(vals).forEach(function(k6){var py=priceToPx(vals[k6]);if(py!=null&&Math.abs(py-y)<bd){bd=Math.abs(py-y);best=k6}});
    if(best){planDrag={k:best};e.stopPropagation();e.preventDefault();}}catch(e2){}},true);
  window.addEventListener('mousemove',function(e){if(!planDrag)return;try{var r=cvEl.getBoundingClientRect();var pr=pxToPrice(e.clientY-r.top);if(pr==null)return;
    window._planOv=window._planOv||{};window._planOv[planDrag.k]=pr;
    var SS=window._sigState,lv=SS.sigs[SS.sigs.length-1];
    if(lv){Object.keys(window._planOv).forEach(function(k6){lv[k6]=window._planOv[k6]});lv.r=Math.abs(lv.entry-lv.stop);}
    draw();if(window.renderCockpit)window.renderCockpit();}catch(e2){}});
  window.addEventListener('mouseup',function(){if(planDrag){planDrag=null;toast('plan adjusted \u2014 sizer & ticket use your levels now \u00b7 reset: re-pick the strategy','var(--accent,#5B8DEF)')}});
  /* M10: auto-annotate \u2014 surface what the engine already detects */
  var an=document.createElement('button');an.className='tbtn';an.textContent='Auto-annotate';
  an.title='M10: draw the engine\u2019s own detections \u2014 auto trendlines + S/R zones with touch counts, each labeled by its detector. Glass box; toggle off anytime.';
  window._annotOn=localStorage.getItem('mishel_annot')==='1';an.classList.toggle('on',window._annotOn);
  an.onclick=function(){window._annotOn=!window._annotOn;STORE.set('mishel_annot',window._annotOn?'1':'0');an.classList.toggle('on',window._annotOn);try{draw()}catch(e){}};
  try{document.getElementById('tbOverflow').appendChild(an)}catch(e){}
  var wb=document.getElementById('wlBtn'),rail=document.getElementById('wlRail');
  function railRender(){if(!rail)return;var seen={},items=[];
    try{JSON.parse(localStorage.getItem('mishel_tabs')||'[]').forEach(function(t){if(t.s&&!seen[t.s]){seen[t.s]=1;items.push(t.s)}})}catch(e){}
    try{Object.keys(BAR_CACHE||{}).forEach(function(k){var sym=k.split('|')[0];if(!seen[sym]){seen[sym]=1;items.push(sym)}})}catch(e){}
    rail.innerHTML='<div style="font-size:9px;color:var(--muted2);padding:0 6px 4px">WATCHLIST \u00b7 session</div>'+(items.length?items.slice(0,14).map(function(sym){
      var bars=null;try{for(var k in BAR_CACHE){if(k.indexOf(sym+'|')===0&&BAR_CACHE[k].length>2){bars=BAR_CACHE[k];break}}}catch(e){}
      var pc=null;if(bars){var a=bars[bars.length-2].c,b=bars[bars.length-1].c;pc=(b/a-1)*100}
      return '<div class="wl-it" data-s="'+sym+'"><span>'+sym+'</span><span style="color:'+(pc==null?'var(--muted2)':pc>=0?'var(--bull)':'var(--bear)')+'">'+(pc==null?'\u2014':(pc>=0?'+':'')+pc.toFixed(2)+'%')+'</span></div>'}).join('')
      :'<div style="font-size:9.5px;color:var(--muted2);padding:4px 6px">opens as you load symbols \u2014 honest empty</div>');
    rail.querySelectorAll('.wl-it').forEach(function(it){it.onclick=function(){try{loadSymbolName(it.dataset.s)}catch(e){try{window.openMsp&&window.openMsp(it.dataset.s)}catch(e2){}}}});}
  if(wb&&rail)wb.onclick=function(){rail.classList.toggle('open');wb.classList.toggle('on');if(rail.classList.contains('open'))railRender()};
  /* v32.1 F3: one-row toolbar — secondary controls move into a \u22ef overflow menu */
  (function(){try{
    var bar=document.querySelector('.chart-toolbar');if(!bar)return;
    var of=document.createElement('div');of.id='tbOverflow';document.body.appendChild(of);
    var ob=document.createElement('button');ob.className='tbtn';ob.id='tbMore';ob.title='more chart tools';ob.textContent='\u22ef';
    bar.appendChild(ob);
    ob.onclick=function(e){e.stopPropagation();var r=ob.getBoundingClientRect();
      of.style.left=Math.max(8,r.right-180)+'px';of.style.top=(r.bottom+6)+'px';of.classList.toggle('open');};
    document.addEventListener('click',function(e){if(!of.contains(e.target)&&e.target!==ob)of.classList.remove('open')});
    /* relocate: Replay, Compare, watchlist, timer-off, New Data, journal, layout */
    ['replayBtn','cmpBtn','wlBtn','jrnBtn','layoutSel','barCtl'].forEach(function(id){var el=document.getElementById(id);if(el)of.appendChild(el)});
    var lq=document.createElement('button');lq.className='tbtn';lq.textContent='Liq zones';lq.title='M7: estimated liquidation clusters \u2014 recent swing entries \u00b1 1/leverage (10/25/50\u00d7), OI-gated. A formula-shown ESTIMATE, never exchange liquidation data.';
    window._liqOn=localStorage.getItem('mishel_liq')==='1';lq.classList.toggle('on',window._liqOn);
    lq.onclick=function(){window._liqOn=!window._liqOn;localStorage.setItem('mishel_liq',window._liqOn?'1':'0');lq.classList.toggle('on',window._liqOn);try{draw()}catch(e){}};
    of.appendChild(lq);
    var lm=document.createElement('button');lm.className='tbtn';lm.textContent='Liquidity map';
    lm.title='SUP1: paints where resting stops cluster \u2014 multi-touch swing levels, equal highs/lows pools, round numbers, unfilled FVGs, heat-weighted by touches. What gets hunted. Estimates from YOUR bars.';
    window._liqMapOn=localStorage.getItem('mishel_liqmap')==='1';lm.classList.toggle('on',window._liqMapOn);
    lm.onclick=function(){window._liqMapOn=!window._liqMapOn;localStorage.setItem('mishel_liqmap',window._liqMapOn?'1':'0');lm.classList.toggle('on',window._liqMapOn);try{draw()}catch(e){}};
    of.appendChild(lm);
    var lab=document.createElement('button');lab.className='tbtn';lab.textContent='Strategy lab';lab.title='M12: all 12 strategies measured on THIS symbol+TF \u2014 win% \u00b7 avgR \u00b7 PF \u00b7 OOS \u00b7 best session, sortable.';
    lab.onclick=function(){try{window.openLab()}catch(e){}};of.appendChild(lab);
    try{var bc2=document.querySelector('.chart-toolbar .tf');if(bc2&&/bars/.test(bc2.textContent))of.appendChild(bc2)}catch(e){}
    [].slice.call(bar.querySelectorAll('button')).forEach(function(b2){
      if(/New Data/.test(b2.textContent)){b2.dataset.lbl='1';b2.textContent='\u27f3';b2.title='New Data \u2014 refetch bars ('+(b2.title||'')+')'}
      if(b2.textContent.trim()==='off'){b2.textContent='\u23fb';b2.title='auto-refresh timer (off)'}});
    /* Replay button has no id in HTML? find by text */
    if(!document.getElementById('replayBtn')){[].slice.call(bar.querySelectorAll('button')).forEach(function(b){
      if(/Replay|New Data/.test(b.textContent)&&b.id!=='tbMore')of.appendChild(b);
      if(b.textContent.trim()==='off'||b.title&&/auto-refresh|timer/i.test(b.title))of.appendChild(b);})}
    /* icon-only labels for the frequent ones (title keeps the words) */
    var IC={'chartMax':'\u26f6','sessBtn':'\u25e8','vpvrBtn':'\u25a4','gridBtn':'\u229e','sigQBtn':'Q\u226550'};
    Object.keys(IC).forEach(function(id){var el=document.getElementById(id);if(el&&el.title)el.textContent=IC[id]});
    /* separators between logical groups */
    function sepBefore(id){var el=document.getElementById(id);if(!el||el.parentElement!==bar)return;var sp=document.createElement('span');sp.className='tsep';bar.insertBefore(sp,el)}
    ['chartMax','sigSel','tbMore'].forEach(sepBefore);
  }catch(e){}})();
  setInterval(function(){if(rail&&rail.classList.contains('open'))railRender()},7000);
})();

