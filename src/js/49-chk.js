/* ================= v7.0e: boot self-check (reports broken wiring) ================= */
(function(){try{
  var badge=document.createElement('div');badge.id='diagBadge';document.body.appendChild(badge);
  window.MISHEL_DIAG=function(){
    var issues=[];
    function chk(name,fn){try{if(!fn())issues.push(name)}catch(e){issues.push(name+' (error: '+e.message+')')}}
    chk('symbol picker component',function(){return !!document.getElementById('mspOverlay')});
    chk('symbol pill in top bar',function(){return !!document.querySelector('.sym-pill,#symBtn')});
    chk('timeframe dropdown',function(){return !!document.getElementById('tfMenu')});
    chk('indicators panel',function(){return !!document.getElementById('indPanel')});
    chk('top tab bar paints',function(){var tb=document.getElementById('tabbar');if(!tb)return false;var t=tb.querySelector('.tab');if(!t)return false;var b=t.getBoundingClientRect();return b.width>0&&b.height>0});
    chk('side panel resizer',function(){return !!document.querySelector('.side-resizer')});
    chk('OHLC info bar',function(){return !!document.getElementById('ohlcBar')});
    chk('chart canvas sized',function(){return cv&&cv._w>50});
    return issues;};
  setTimeout(function(){try{
    var issues=window.MISHEL_DIAG();
    if(issues.length){badge.style.display='block';badge.textContent='UI self-check: '+issues.length+' issue(s) — click';
      badge.onclick=function(){alert('Mishel UI self-check found:\n\n\u2022 '+issues.join('\n\u2022 ')+'\n\nScreenshot or copy this to report.')};}
  }catch(e){}},1800);
}catch(e){}})();


/* ---- v7.1a: signal hierarchy — one primary read, labeled components ---- */
(function(){try{
  var defs={'GLASS-BOX':'Primary read. Rule-based and inspectable — every signal shows its reasoning. No black box.',
            'LIVE':'Evaluated on the latest bar against the strategy\u2019s own rules.',
            'DESK':'Desk-style aggregate of ~19 indicators. A COMPONENT that feeds the primary confluence read \u2014 not a second opinion.'};
  document.querySelectorAll('.card h3 .tag').forEach(function(t){
    var k=(t.textContent||'').trim();if(defs[k])t.title=defs[k];
    var h3=t.closest('h3');if(!h3)return;
    var lab=document.createElement('span');lab.className='tag2 '+(k==='GLASS-BOX'?'primary':'component');
    lab.textContent=k==='GLASS-BOX'?'PRIMARY':'COMPONENT';lab.title=defs[k]||'';
    h3.insertBefore(lab,t.nextSibling);
  });
}catch(e){}})();

/* ---- v7.1b: diagnostics HUD (Ctrl+Alt+D, or triple-click the version tag) ---- */
(function(){try{
  function show(){
    var old=document.getElementById('diagHud');if(old){old.remove();return;}
    var issues=[];try{issues=(window.MISHEL_DIAG&&MISHEL_DIAG())||[]}catch(e){issues=['MISHEL_DIAG failed: '+e.message]}
    var checks=[
      ['Build',(typeof APP_VER!=='undefined'?'v'+APP_VER:'?')],
      ['Symbol picker',(document.getElementById('mspOverlay')?'new modal present':'MISSING')],
      ['Side panel width',(window.SIDE_W||344)+'px'+(window.SIDE_COLLAPSED?' (collapsed)':'')],
      ['Price scale',(window.SCALE_MODE||'lin').toUpperCase()],
      ['Nav items',document.querySelectorAll('.rail .nav').length],
      ['Indicators on',(typeof ON!=='undefined'?ON.size:'?')],
      ['Data bars',(typeof DATA!=='undefined'?DATA.length:'?')],
      ['Mode',(typeof MODE!=='undefined'?MODE:'?')],
      ['Wiring issues',issues.length?issues.join(' · '):'none detected']];
    var d=document.createElement('div');d.id='diagHud';
    d.style.cssText='position:fixed;right:14px;bottom:44px;z-index:950;background:var(--panel);border:1px solid var(--edge2);border-radius:12px;box-shadow:0 30px 70px -18px #000;padding:14px 16px;font:11.5px/1.7 JetBrains Mono,monospace;color:var(--txt);max-width:360px';
    d.innerHTML='<b style="letter-spacing:.08em">MISHEL DIAGNOSTICS</b><br>'+checks.map(function(c){return '<span style="color:var(--muted)">'+c[0]+'</span>  '+c[1]}).join('<br>')+'<br><span style="color:var(--muted2)">Ctrl+Alt+D to close \u00b7 paste this to support</span>';
    d.onclick=function(){d.remove()};document.body.appendChild(d);
  }
  document.addEventListener('keydown',function(e){if(e.ctrlKey&&e.altKey&&(e.key==='d'||e.key==='D')){e.preventDefault();show()}});
  var vt=document.getElementById('verTag'),n=0,t0=0;
  if(vt){vt.style.cursor='default';vt.addEventListener('click',function(){var now=Date.now();n=(now-t0<650)?n+1:1;t0=now;if(n>=3){n=0;show()}});}
}catch(e){}})();


/* ---- v7.2a: price-axis drag-zoom (drag axis to compress/expand; double-click resets) ---- */
(function(){try{
  var el=document.getElementById('chart');if(!el)return;
  var az=null;
  el.addEventListener('mousedown',function(e){
    var r=el.getBoundingClientRect(),X=e.clientX-r.left,Y=e.clientY-r.top;
    if(!RENDER)return;
    if(X>RENDER.W-RENDER.padR&&Y<RENDER.priceH){az={y0:e.clientY,p0:(window.YPAD||0.08)};e.stopImmediatePropagation();e.preventDefault();document.body.style.cursor='ns-resize';}
  },true);
  window.addEventListener('mousemove',function(e){
    if(az){var d=(e.clientY-az.y0)/240;window.YPAD=Math.min(.9,Math.max(.01,az.p0+d));try{draw()}catch(_){}}
    else{try{var r=el.getBoundingClientRect(),X=e.clientX-r.left,Y=e.clientY-r.top;
      if(RENDER&&X>RENDER.W-RENDER.padR&&Y<RENDER.priceH)el.style.cursor='ns-resize';
      else if(RENDER&&typeof VOL_ON!=='undefined'&&VOL_ON&&X<RENDER.W-RENDER.padR&&Math.abs(Y-RENDER.priceH-4)<6)el.style.cursor='row-resize';}catch(_){}}
  });
  window.addEventListener('mouseup',function(){if(az){az=null;document.body.style.cursor=''}});
  el.addEventListener('dblclick',function(e){var r=el.getBoundingClientRect(),X=e.clientX-r.left;
    if(RENDER&&X>RENDER.W-RENDER.padR){window.YPAD=0.08;try{draw()}catch(_){}e.stopImmediatePropagation();}},true);
}catch(e){}})();

/* ---- v7.2b: draggable chart/volume divider ---- */
(function(){try{
  var el=document.getElementById('chart');if(!el)return;
  var pd=null;
  el.addEventListener('mousedown',function(e){
    if(!RENDER||typeof VOL_ON==='undefined'||!VOL_ON)return;
    var r=el.getBoundingClientRect(),X=e.clientX-r.left,Y=e.clientY-r.top;
    if(X<RENDER.W-RENDER.padR&&Math.abs(Y-RENDER.priceH-4)<6){pd={y0:e.clientY,r0:(window.PANE_RATIO||0.76)};e.stopImmediatePropagation();e.preventDefault();document.body.style.cursor='row-resize';}
  },true);
  window.addEventListener('mousemove',function(e){if(!pd)return;
    var h=el.getBoundingClientRect().height||600;
    window.PANE_RATIO=Math.min(.92,Math.max(.5,pd.r0+(e.clientY-pd.y0)/h));try{draw()}catch(_){}} );
  window.addEventListener('mouseup',function(){if(pd){pd=null;document.body.style.cursor='';try{localStorage.setItem('mishel_paner',String(window.PANE_RATIO||''))}catch(_){}}});
  try{var pr=parseFloat(localStorage.getItem('mishel_paner'));if(pr>=.5&&pr<=.92)window.PANE_RATIO=pr;}catch(e){}
}catch(e){}})();

/* ---- v7.2c: "Active indicators" manager inside the Indicators panel ---- */
(function(){try{
  var body=document.getElementById('indPanelBody');if(!body)return;
  var wrap=document.createElement('div');wrap.id='indActiveWrap';
  body.parentElement.insertBefore(wrap,body);
  window.renderIndActive=function(){
    var chips={},names={};
    document.querySelectorAll('#indPanelBody .chip[data-ind]').forEach(function(c){chips[c.dataset.ind]=c;names[c.dataset.ind]=c.textContent.trim()});
    var on=(typeof ON!=='undefined')?[...ON].filter(function(k){return chips[k]}):[];
    wrap.innerHTML='<div class="h">Active on chart ('+on.length+')</div>'+(on.length?on.map(function(k){
      return '<span class="ind-act" data-k="'+k+'">'+names[k]+'<span class="x" title="Remove">\u00d7</span></span>';}).join('')
      :'<div class="ind-none">Nothing active \u2014 click indicators below to add them.</div>');
    wrap.querySelectorAll('.ind-act .x').forEach(function(x){x.onclick=function(e){e.stopPropagation();
      var k=x.parentElement.dataset.k;var c=chips[k];if(c)c.click();setTimeout(window.renderIndActive,0);};});
  };
  var panel=document.getElementById('indPanel');
  if(panel){panel.addEventListener('click',function(){setTimeout(window.renderIndActive,0)});}
  var t=document.getElementById('indToggle');
  if(t){var _o=t.onclick;t.onclick=function(e){if(_o)_o.call(this,e);setTimeout(window.renderIndActive,0)};}
}catch(e){}})();

/* ---- v7.2d: settings gear in the top bar ---- */
