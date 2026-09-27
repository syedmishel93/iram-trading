(function(){try{
  var top=document.getElementById('topbar');if(!top)return;
  var brand=top.querySelector('.brand');
  var symBtn=document.getElementById('symBtn');
  var ph=top.querySelector('.price-head');

  /* (1) symbol pill: pull symBtn + the (previously hidden) price block into one pill after the brand */
  if(symBtn){
    var pill=document.createElement('div');pill.className='sym-pill';
    top.insertBefore(pill,brand?brand.nextSibling:top.firstChild);
    pill.appendChild(symBtn);
    if(ph){ph.classList.add('in-pill');pill.appendChild(ph);}
  }

  /* (3) connection cluster: join the Offline/Online toggle with the feed indicator */
  var mode=document.getElementById('modeToggle'),feed=document.getElementById('feedInd');
  if(mode&&feed&&mode.parentNode){
    var conn=document.createElement('div');conn.className='conn-cluster';
    mode.parentNode.insertBefore(conn,mode);conn.appendChild(mode);conn.appendChild(feed);
  }

  /* (4) DEMO tag on the account chip */
  var acct=document.getElementById('acctChip');
  /* v39.1: the markup ships #topAcctTag now; a second injected DEMO would duplicate. */
  if(acct&&!document.getElementById('topAcctTag')&&!acct.querySelector('.demo-tag')){
    var dt=document.createElement('span');dt.className='demo-tag';dt.textContent='DEMO';
    acct.insertBefore(dt,acct.firstChild);
  }

  /* (5)+(7) fold theme-select / density / fullscreen / minimize into the ⋯ workspace menu */
  var mp=document.getElementById('morePanel');
  if(mp){
    var sec=document.createElement('div');sec.className='more-sec';sec.textContent='Workspace';
    var wrap=document.createElement('div');
    function item(label,srcId){var it=document.createElement('div');it.className='more-item';it.textContent=label;
      it.onclick=function(){var b=document.getElementById(srcId);if(b)b.click();mp.style.display='none';};wrap.appendChild(it);}
    item('\u26f6 Fullscreen','fsBtn');
    item('Aa Density / font size','densBtn');
    item('\u25be Minimize top bar','minTop');
    mp.insertBefore(wrap,mp.firstChild);
    mp.insertBefore(sec,mp.firstChild);
  }

  /* (2) zone dividers between the major clusters */
  ['.sym-pill','.topgrp-mkt','.conn-cluster','.topgrp-icons'].forEach(function(sel){
    var el=top.querySelector(sel);
    if(el&&el.parentNode&&!(el.previousElementSibling&&el.previousElementSibling.classList&&el.previousElementSibling.classList.contains('top-sep'))){
      var sp=document.createElement('div');sp.className='top-sep';el.parentNode.insertBefore(sp,el);
    }
  });
}catch(e){}})();


/* ---- v5.9a: robust symbol picker (whole pill opens it; render is defensive) ---- */
(function(){try{
  function openPicker(anchor){
    var d=document.getElementById('symDrop');if(!d)return;
    if(d.parentElement!==document.body)document.body.appendChild(d);
    d.style.zIndex='620';
    var a=anchor||document.querySelector('.sym-pill')||document.getElementById('symBtn');
    var r=a?a.getBoundingClientRect():{left:12,bottom:52};
    d.style.left=Math.max(8,Math.min(r.left,innerWidth-320))+'px';
    d.style.top=(r.bottom+6)+'px';d.style.display='block';
    try{if(typeof fillSymDropCls==='function')fillSymDropCls();}catch(e){}
    try{if(typeof renderSymList==='function')renderSymList('');}catch(e){}
    try{var si=document.getElementById('symSearch');if(si){si.value='';setTimeout(function(){si.focus()},0);}}catch(e){}
  }
  window.openSymbolPicker=openPicker;
  var pill=document.querySelector('.sym-pill'),symBtn=document.getElementById('symBtn');
  var target=pill||symBtn;
  if(target){target.addEventListener('click',function(e){e.stopPropagation();
    var d=document.getElementById('symDrop');
    if(d&&d.style.display==='block'){d.style.display='none';}else{openPicker(target);}});}
}catch(e){}})();

/* ---- v5.9b: resizable + collapsible right panel, persisted ---- */
(function(){try{
  var side=document.getElementById('side');if(!side)return;
  try{var sw=parseInt(localStorage.getItem('mishel_sidew'));if(sw>=280&&sw<=600)window.SIDE_W=sw;}catch(e){}
  try{if(localStorage.getItem('mishel_sidecol')==='1')window.SIDE_COLLAPSED=true;}catch(e){}

  var rz=document.createElement('div');rz.className='side-resizer';rz.title='Drag to resize';document.body.appendChild(rz);
  var cb=document.createElement('button');cb.className='side-collapse';cb.title='Hide panel';cb.innerHTML='\u203a';document.body.appendChild(cb);
  var re=document.createElement('button');re.className='side-reopen';re.title='Show panel';re.innerHTML='\u2039';document.body.appendChild(re);

  window.layoutSide=function(){
    var chartOn=document.getElementById('v-chart').classList.contains('on');
    var show=chartOn&&!window.SIDE_COLLAPSED, w=window.SIDE_W||344;
    rz.style.display=show?'block':'none';rz.style.right=(w-4)+'px';
    cb.style.display=show?'flex':'none';cb.style.right=(w+6)+'px';
    re.classList.toggle('show',chartOn&&!!window.SIDE_COLLAPSED);
  };

  var drag=false,raf=0;
  rz.addEventListener('pointerdown',function(e){drag=true;rz.classList.add('drag');try{rz.setPointerCapture(e.pointerId)}catch(_){}document.body.style.cursor='col-resize';e.preventDefault();});
  window.addEventListener('pointermove',function(e){if(!drag)return;
    var w=Math.max(280,Math.min(600,Math.round(innerWidth-e.clientX)));window.SIDE_W=w;window.SIDE_COLLAPSED=false;
    if(window.syncAppGrid)syncAppGrid();
    if(!raf)raf=requestAnimationFrame(function(){raf=0;try{if(window.draw)draw()}catch(e){}});});
  window.addEventListener('pointerup',function(){if(!drag)return;drag=false;rz.classList.remove('drag');document.body.style.cursor='';
    try{localStorage.setItem('mishel_sidew',window.SIDE_W);localStorage.setItem('mishel_sidecol','0')}catch(e){}
    try{if(window.draw)draw()}catch(e){}});
  function setCol(v){window.SIDE_COLLAPSED=v;if(window.syncAppGrid)syncAppGrid();
    try{localStorage.setItem('mishel_sidecol',v?'1':'0')}catch(e){}try{if(window.draw)draw()}catch(e){}}
  cb.onclick=function(){setCol(true)};re.onclick=function(){setCol(false)};

  if(window.syncAppGrid)syncAppGrid(); else if(window.layoutSide)layoutSide();
}catch(e){}})();

/* ---- v5.9c: restore pinned sidebar ---- */
(function(){try{
  /* v19: sidebar OPEN by default so groups/search/Frequent are visible; collapsing it is remembered */
  if(localStorage.getItem('mishel_pin')!=='0'){
    var app=document.querySelector('.app');if(app){app.classList.add('rail-pinned');
      var pin=document.getElementById('railPin'),l=pin&&pin.querySelector('.lbl');if(l)l.textContent='Collapse sidebar';
      if(window.syncAppGrid)syncAppGrid();}
  }
}catch(e){}})();


/* ---- v6.0a: Lin/Log price-scale toggle ---- */
