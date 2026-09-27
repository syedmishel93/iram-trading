/* ================= v33.0 WAVE 1: DECISION BAR (I1) + SM TABS (R4) + COLLISION LAW (M1) ================= */
(function(){
  /* I1: the decision spine — verdict \u00b7 conditions \u00b7 signal \u00b7 next action, on every view */
  function condScore(){ /* glass-box conditions 0-100: regime fit 30 + signal record 30 + session 20 + positioning 20 */
    try{var x=analystContext();var sc=50,parts=[];
      var trending=/trend/i.test(x.reg.regime||'');var adxOk=x.adx>=22;
      parts.push(['regime',trending&&adxOk?30:x.adx<16?8:18]);
      var st=(window._sigState||{}).stats;parts.push(['signal record',st&&st.avgR!=null?(st.avgR>0.2?30:st.avgR>0?20:6):12]);
      var hr=new Date().getUTCHours();parts.push(['session',(hr>=12&&hr<21)||(hr>=7&&hr<16)?20:8]);
      var cw=window._crowdScore;var fr=window._fundRate;parts.push(['positioning',cw!=null?(cw<30?20:cw<55?12:5):(fr==null?10:Math.abs(fr)<0.01?20:8)]);
      sc=parts.reduce(function(a,b){return a+b[1]},0);
      return {score:sc,parts:parts};}catch(e){return null}}
  function paintDbar(){try{
    var fill=document.querySelector('#tabbar .fill');if(!fill)return;
    var db=document.getElementById('dbar');
    if(!db){db=document.createElement('div');db.id='dbar';fill.appendChild(db)}
    /* v35.0 THE GATE: a decision spine on top of a dead tape is worse than no
       spine at all. Refuse to render a verdict; say exactly why. */
    if(window.Fresh && Fresh.blocks()){
      db.innerHTML='<span class="db" data-go="chart" style="color:var(--bear);background:color-mix(in srgb,var(--bear) 16%,transparent)" title="'+Fresh.why().replace(/"/g,'')+'">\u26d4 <b>'+Fresh.label()+'</b> \u00b7 no decision on a dead tape</span>';
      db.querySelectorAll('.db').forEach(function(el){el.onclick=function(){try{goView(el.dataset.go)}catch(e){}}});
      return;
    }
    var x=null;try{x=analystContext()}catch(e){}
    var SS=window._sigState||{};var st=SS.stats;var cs=condScore();
    var nba='';try{var acts=nbaCompute(wdbLoad(),window._smCounts||{});if(acts[0])nba=acts[0].act}catch(e){}
    var vCol=x&&x.rep.score>0.15?'var(--bull)':x&&x.rep.score<-0.15?'var(--bear)':'var(--neut)';
    var cCol=cs?(cs.score>=65?'var(--fav)':cs.score>=45?'var(--neut)':'var(--unfav)'):'var(--neut)';
    db.innerHTML=(x?'<span class="db" data-go="chart" title="live glass-box verdict \u2014 click for the chart & confluence">read <b style="color:'+vCol+'">'+x.rep.label+'</b></span>':'')
      +(cs?'<span class="db" data-go="chart" title="conditions 0-100 (glass box): '+cs.parts.map(function(p2){return p2[0]+' '+p2[1]}).join(' + ')+' \u2014 context quality, never a buy signal"><b style="color:'+cCol+'">'+cs.score+'</b>/100</span>':'')
      +(SS.on?'<span class="db" data-go="chart" title="active strategy & its measured record">sig <b>'+((window.SIG_STRATS[SS.resolvedStrat]||{}).name||'\u2014')+(st&&st.winPct!=null?' '+(st.winPct*100).toFixed(0)+'%':'')+'</b></span>':'')
      +(nba?'<span class="db" data-go="smart" title="next best action (rule-based, from your desk state)">\u2192 '+nba.slice(0,34)+'</span>':'');
    db.querySelectorAll('.db').forEach(function(el){el.onclick=function(){try{goView(el.dataset.go)}catch(e){}}});
  }catch(e){}}
  setTimeout(paintDbar,2500);setInterval(paintDbar,6000);
  /* M2: first-class search \u2014 the palette, promoted */
  setTimeout(function(){try{var fill=document.querySelector('#tabbar .fill');if(!fill||document.getElementById('gSearch'))return;
    var inp=document.createElement('input');inp.id='gSearch';inp.placeholder='\u2318K \u00b7 symbols, wallets, commands (btc 4h \u00b7 qfa 0x\u2026 \u00b7 w:name \u00b7 lab)';
    inp.style.cssText='width:250px;background:color-mix(in srgb,var(--panel2) 65%,transparent);border:1px solid var(--edge);border-radius:8px;padding:3px 10px;color:var(--txt);font:500 10.5px var(--mono);margin-left:auto';
    inp.onfocus=function(){inp.blur();try{document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))}catch(e){}};
    fill.appendChild(inp);}catch(e){}},2800);

  /* R4: Smart Money \u2192 Act / Wallets / Forensics */
  setTimeout(function(){try{
    var v=document.getElementById('v-smart');if(!v)return;
    var GROUPS={act:['smDiff','smNBA','smQueue','smWatch','smOpps','smMomentum','smRadar'],
      wallets:['smRank','smDb','smHarvest','smTokenLookup','smLeader'],
      forensics:['smCoHold','smManip','smSybil']};
    var panels=[].slice.call(v.querySelectorAll('.panelbox, #smDiff'));
    panels.forEach(function(pn){var g='act';
      Object.keys(GROUPS).forEach(function(k){GROUPS[k].forEach(function(id){if(pn.querySelector&&(pn.id===id||pn.querySelector('#'+id)))g=k})});
      pn.dataset.smgroup=g;});
    var bar=document.createElement('div');bar.id='smTabs';
    bar.innerHTML=[['act','\u26a1 Act','what needs a decision now'],['wallets','\u{1F40B} Wallets','ranking \u00b7 database \u00b7 harvest'],['forensics','\u{1F50E} Forensics','co-holding \u00b7 patterns \u00b7 sybil evidence']].map(function(t2){return '<span class="smt" data-g="'+t2[0]+'" title="'+t2[2]+'">'+t2[1]+'</span>'}).join('');
    var first=v.firstElementChild;v.insertBefore(bar,first);
    function apply(g){bar.querySelectorAll('.smt').forEach(function(b2){b2.classList.toggle('on',b2.dataset.g===g)});
      panels.forEach(function(pn){pn.style.display=(pn.dataset.smgroup===g)?'':'none'});
      try{localStorage.setItem('mishel_smtab',g)}catch(e){}}
    bar.querySelectorAll('.smt').forEach(function(b2){b2.onclick=function(){apply(b2.dataset.g)}});
    apply(localStorage.getItem('mishel_smtab')||'act');
  }catch(e){}},3200);

  /* M1: collision law — readout yields to crosshair; time bubble clamps into the plot */
  setTimeout(function(){try{
    var cvx=document.getElementById('chart'),ro=document.getElementById('readout'),axT=document.getElementById('axTm');
    if(cvx&&ro)cvx.addEventListener('mousemove',function(e){var r=cvx.getBoundingClientRect();var x=e.clientX-r.left,y=e.clientY-r.top;
      var m=window._chartMap;if(!m)return;
      ro.style.transition='transform .12s ease';
      ro.style.transform=(x>m.W-m.padR-260&&y<90)?'translateX(-140px)':'';});
    if(axT){var obs=new MutationObserver(function(){try{var m=window._chartMap;if(!m)return;axT.style.bottom=(26+4)+'px';}catch(e){}});
      obs.observe(axT,{attributes:true,attributeFilter:['style']});}
  }catch(e){}},2600);
})();

/* ================= v32.1 F1/F2: BOOT INTEGRITY GATE + SELF-HEAL ================= */
(function(){
  setTimeout(function(){try{
    var problems=[];
    /* F2a: tab bar must be painted with an active tab */
    var tb=document.getElementById('tabbar');
    if(!tb||!tb.offsetHeight)problems.push('top tab bar not visible');
    else if(!tb.querySelector('.tab.on')){try{if(typeof syncTabBar==='function'){syncTabBar();}}catch(e){}
      if(!tb.querySelector('.tab.on'))problems.push('tab bar unpainted (no active tab)');}
    /* F2b: instrument header must live in the tabs row under compact */
    try{var ih=document.getElementById('instHead'),ws=document.getElementById('wsTabs');
      if(ih&&ws&&document.body.classList.contains('compact')&&ih.parentElement!==ws){ws.appendChild(ih);}
      if(ih&&!ih.offsetParent&&document.getElementById('v-chart').classList.contains('on'))problems.push('instrument header hidden');}catch(e){}
    /* F1: any captured errors are shown, not just counted */
    var errs=window._errlog||[];
    if(errs.length||problems.length){
      var d2=document.createElement('div');
      d2.style.cssText='position:fixed;top:6px;left:50%;transform:translateX(-50%);z-index:900;background:color-mix(in srgb,var(--bear) 16%,var(--panel));border:1px solid var(--bear);color:var(--bear);font:600 10.5px var(--mono);padding:8px 14px;border-radius:9px;max-width:70vw;line-height:1.6;cursor:pointer';
      d2.innerHTML='\u26a0 BOOT INTEGRITY: '+(problems.concat(errs.slice(0,3).map(function(x){return x.kind+': '+x.msg.slice(0,70)})).join(' \u00b7 '))+(errs.length>3?' \u00b7 +'+(errs.length-3)+' more (\u26a0 badge)':'')+' \u2014 click to dismiss';
      d2.onclick=function(){d2.remove()};document.body.appendChild(d2);
      setTimeout(function(){try{d2.remove()}catch(e){}},25000);}
  }catch(e){}},8000);
})();

/* ================= v32.0 WORKSPACE (D1/D2/D4/B4/B5) ================= */
(function(){
  /* D4: notification center — every toast becomes a logged, readable notification */
  window._notifs=[];var _t0=window.toast;
  window.toast=function(msg,col){try{window._notifs.unshift({t:Date.now(),msg:String(msg),col:col||'',read:false});
    if(window._notifs.length>80)window._notifs.pop();badge2()}catch(e){}return _t0.apply(this,arguments)};
  function badge2(){try{var bell=document.querySelector('.iconbtn[title*="lert"], #bellBtn')||null;
    var st=document.querySelector('.status');var b=document.getElementById('nfBadge');
    var un=window._notifs.filter(function(n){return !n.read}).length;
    if(!b&&st){b=document.createElement('span');b.id='nfBadge';b.style.cssText='cursor:pointer;color:var(--gold);font-weight:700;margin-left:8px';
      b.title='notification center (D4) \u2014 every signal, alert & event this session';
      b.onclick=function(){var p2=panel();p2.classList.toggle('open');if(p2.classList.contains('open'))render()};(document.getElementById('stSlot')||st).appendChild(b);/* v39.1: slot */}
    if(b){b.textContent='\u{1F514} '+un;b.style.display=window._notifs.length?'':'none'}}catch(e){}}
  function panel(){var p2=document.getElementById('notifPanel');
    if(!p2){p2=document.createElement('div');p2.id='notifPanel';document.body.appendChild(p2)}return p2}
  function nKind(msg){ /* I7: urgency from content */
    if(/\u25b2 LONG|\u25bc SHORT|SIGNAL/.test(msg))return {k:'signal',r:0,tag:'SIGNAL',col:'var(--fav)',go:'chart'};
    if(/\u{1F514}|alert/i.test(msg))return {k:'alert',r:1,tag:'ALERT',col:'var(--gold)',go:'chart'};
    if(/convergence|queue|S-tier|A-tier/i.test(msg))return {k:'desk',r:2,tag:'DESK',col:'var(--unfav)',go:'smart'};
    return {k:'info',r:3,tag:'INFO',col:'var(--neut)',go:null};}
  function render(){var p2=panel();
    var items=window._notifs.slice(0,60).map(function(n,ix){var k=nKind(n.msg);return {n:n,k:k,ix:ix}});
    items.sort(function(a,b){return (a.n.read-b.n.read)||(a.k.r-b.k.r)||(b.n.t-a.n.t)});
    p2.innerHTML='<div style="display:flex;align-items:center;margin-bottom:6px"><b style="font-size:12px">\u{1F514} Notifications</b><span style="font-size:8.5px;color:var(--muted2);margin-left:8px">decision-urgency first</span><button class="tbtn" style="margin-left:auto;padding:1px 8px;font-size:9.5px" id="nfClr">mark read</button></div>'
      +(items.length?items.slice(0,40).map(function(it){var n=it.n,k=it.k;
        return '<div class="nf-it'+(n.read?'':' unread')+'"><span class="pill sem" style="color:'+k.col+';border-color:'+k.col+';font-size:7.5px;padding:0 5px;margin-right:5px">'+k.tag+'</span><span style="font-size:8.5px;color:var(--muted2)">'+new Date(n.t).toTimeString().slice(0,5)+'</span> '+n.msg.replace(/</g,'&lt;')+(k.go?' <button class="tbtn nfgo" data-go="'+k.go+'" style="padding:0 7px;font-size:8.5px;float:right">open \u25b7</button>':'')+'</div>'}).join(''):'<div style="font-size:11px;color:var(--muted2)">quiet so far \u2014 signals, alerts and desk events land here</div>');
    p2.querySelectorAll('.nfgo').forEach(function(b3){b3.onclick=function(){try{goView(b3.dataset.go)}catch(e){}p2.classList.remove('open')}});
    var c2=document.getElementById('nfClr');if(c2)c2.onclick=function(){window._notifs.forEach(function(n){n.read=true});badge2();render()};
    window._notifs.forEach(function(n){n.read=true});setTimeout(badge2,400);}
  setTimeout(badge2,3000);
  /* D2: workspace presets */
  /* I5: decision stages \u2014 the interface reshapes to where you are in the trade */
  window.applyStage=function(st){try{
    localStorage.setItem('mishel_stage',st);
    if(st==='scan'){goView('smart');toast('\u{1F50D} SCAN \u2014 radar wall + queue: find the candidate','var(--fav)')}
    else if(st==='judge'){goView('chart');try{var cs3=JSON.parse(localStorage.getItem('mishel_cksec')||'{}');cs3.decide=false;cs3.evidence=false;localStorage.setItem('mishel_cksec',JSON.stringify(cs3));if(window.renderCockpit)window.renderCockpit()}catch(e){}
      toast('\u2696 JUDGE \u2014 evidence open: verdict, records, conditions','var(--fav)')}
    else if(st==='execute'){goView('chart');try{var cs4=JSON.parse(localStorage.getItem('mishel_cksec')||'{}');cs4.decide=false;cs4.context=true;cs4.evidence=true;localStorage.setItem('mishel_cksec',JSON.stringify(cs4));if(window.renderCockpit)window.renderCockpit()}catch(e){}
      toast('\u{1F3AF} EXECUTE \u2014 plan + sizer + ticket, nothing else loud','var(--fav)')}
    else if(st==='review'){goView('backtest');setTimeout(function(){var jb3=document.getElementById('jrnBtn');if(jb3)jb3.click();
      /* I9: the mirror \u2014 one sentence about YOU */
      try{var j2=jrnLoad();var wk=j2.filter(function(e2){return Date.now()-e2.t<7*864e5});
        var done2=wk.filter(function(e2){return e2.res&&e2.res!=='open'});var early=0;
        var best={};done2.forEach(function(e2){var hr2=new Date(e2.t).getUTCHours();var s5=hr2>=12&&hr2<21?'NY':hr2>=7?'LDN':'ASIA';best[s5]=best[s5]||{w:0,n:0};best[s5].n++;if(e2.res!=='stop')best[s5].w++});
        var bs2=Object.keys(best).sort(function(a,b){return (best[b].w/best[b].n)-(best[a].w/best[a].n)})[0];
        toast('\u{1FA9E} This week: '+wk.length+' taken \u00b7 '+done2.length+' resolved'+(bs2?' \u00b7 best session '+bs2+' ('+Math.round(best[bs2].w/best[bs2].n*100)+'%)':'')+' \u2014 the mirror','var(--gold)');}catch(e){}},700);}
  }catch(e){}};
  /* stage control in the decision bar area */
  setTimeout(function(){try{var fill2=document.querySelector('#tabbar .fill');if(!fill2||document.getElementById('stageCtl'))return;
    var sc2=document.createElement('span');sc2.id='stageCtl';sc2.style.cssText='display:inline-flex;gap:3px;margin-left:8px';
    sc2.innerHTML=[['scan','\u{1F50D}','Scan \u2014 find candidates'],['judge','\u2696','Judge \u2014 weigh evidence'],['execute','\u{1F3AF}','Execute \u2014 plan & size'],['review','\u{1FA9E}','Review \u2014 the mirror']].map(function(t3){return '<button class="tbtn" data-st="'+t3[0]+'" title="I5 stage: '+t3[2]+'" style="padding:1px 7px;font-size:11px">'+t3[1]+'</button>'}).join('');
    fill2.appendChild(sc2);
    sc2.querySelectorAll('button').forEach(function(b4){b4.onclick=function(){window.applyStage(b4.dataset.st)}});}catch(e){}},3000);
  window.applyWorkspace=function(ws){
    try{
      if(ws==='scalping'){goView('multi');toast('\u{1F5C2} Scalping workspace \u2014 multi-chart grid; set panels to 1m/5m \u00b7 signals auto-fit scalp style on the main chart','var(--accent,#5B8DEF)');}
      else if(ws==='research'){goView('smart');toast('\u{1F5C2} Research workspace \u2014 smart-money desk + queue + packs','var(--accent,#5B8DEF)');}
      else if(ws==='review'){goView('backtest');setTimeout(function(){var b=document.getElementById('jrnBtn');if(b)b.click()},600);toast('\u{1F5C2} Review workspace \u2014 tester + your decision journal','var(--accent,#5B8DEF)');}
      localStorage.setItem('mishel_ws',ws);
    }catch(e){}};
  /* D1: multi-chart quick button + TF sync broadcast */
  var gb=document.createElement('button');gb.className='tbtn';gb.id='gridBtn';gb.title='D1: multi-chart grid view \u2014 watch several markets, each streaming independently; \u21e2 loads one into the main chart';gb.textContent='\u229e Grid';
  var qb=document.getElementById('sigQBtn');if(qb&&qb.parentElement)qb.parentElement.insertBefore(gb,qb.nextSibling);
  gb.onclick=function(){goView('multi')};
  /* B4: keyboard shortcuts overlay (?) + / focus symbol search */
  window.showKeys=function(){var o2=document.getElementById('keysOverlay');
    if(!o2){o2=document.createElement('div');o2.id='keysOverlay';
      o2.innerHTML='<div style="background:var(--panel);border:1px solid var(--edge2);border-radius:14px;padding:18px 22px;max-width:560px;font-size:11.5px;line-height:2" onclick="event.stopPropagation()"><b style="font-size:13px">\u2328 Keyboard</b><div style="columns:2;margin-top:8px;font-family:var(--mono)">/ symbol search<br>F fullscreen chart<br>+ / \u2212 zoom<br>\u2190\u2192 pan<br>1-6 timeframes<br>Q quality gate<br>S signals picker<br>G grid view<br>? this help<br>Esc close</div><div style="font-size:9px;color:var(--muted2);margin-top:8px">plus: dbl-click a drawing = properties \u00b7 right-click y-axis = scale/alert \u00b7 drag axes = zoom/scale</div></div>';
      o2.onclick=function(){o2.classList.remove('open')};document.body.appendChild(o2);}
    o2.classList.add('open');};
  document.addEventListener('keydown',function(e){
    if(e.target&&/input|textarea|select/i.test(e.target.tagName))return;
    if(e.key==='?'){e.preventDefault();window.showKeys()}
    else if(e.key==='/'){e.preventDefault();try{window.openMsp&&window.openMsp('')}catch(e2){}}
    else if(e.key==='g'||e.key==='G'){goView('multi')}
    else if(e.key==='q'||e.key==='Q'){var b=document.getElementById('sigQBtn');if(b)b.click()}
    else if(e.key==='s'||e.key==='S'){var s2=document.getElementById('sigSel');if(s2){s2.focus();try{s2.showPicker&&s2.showPicker()}catch(e2){}}}});
  /* B5: right-click on a candle — contextual actions */
  var cv2=document.getElementById('chart');
  if(cv2)cv2.addEventListener('contextmenu',function(e){try{var m=window._chartMap;if(!m)return;
    var r=cv2.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;
    if(x>m.W-m.padR||y>m.priceH)return;   /* axis menus handle their zones */
    if(typeof TOOL!=='undefined'&&TOOL!=='cursor')return;   /* drawing ctx menu wins */
    if(typeof SELDRAW!=='undefined'&&SELDRAW>=0)return;
    e.preventDefault();e.stopPropagation();
    var bi=Math.max(0,Math.min(m.end-m.start-1,Math.floor(x/m.cw)))+m.start;var bar=DATA[bi];if(!bar)return;
    var pr=(function(){var frac=1-y/m.priceH;var v=m.la+frac*m.ls;return m.lg?Math.exp(v):v})();
    var pick=prompt('Candle '+new Date(bar.t).toUTCString().slice(5,22)+' \u00b7 O '+fmt(bar.o)+' H '+fmt(bar.h)+' L '+fmt(bar.l)+' C '+fmt(bar.c)+'\n\n1 = \u{1F514} alert at '+fmt(pr)+'\n2 = aVWAP anchor here\n3 = measure from here\n\nType 1, 2 or 3:');
    if(pick==='1'){try{var op=pr>=DATA[DATA.length-1].c?'>=':'<=';ALERTS.push({sym:CURSYM.sym,op:op,px:pr,note:'candle alert (B5)',fired:null});if(typeof saveAlerts==='function')saveAlerts();toast('\u{1F514} alert '+CURSYM.sym+' '+op+' '+fmt(pr),'var(--gold)')}catch(e3){}}
    else if(pick==='2'){try{setTool('avwap');toast('aVWAP tool armed \u2014 click the anchor bar','var(--accent,#5B8DEF)')}catch(e3){}}
    else if(pick==='3'){try{setTool('measure');toast('measure armed \u2014 drag from your start point','var(--accent,#5B8DEF)')}catch(e3){}}
  }catch(e2){}},true);
})();

