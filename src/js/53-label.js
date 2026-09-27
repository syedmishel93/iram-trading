(function(){try{
  setInterval(function(){try{
    var sub=document.getElementById('cSub');if(!sub)return;
    var k=document.getElementById('kellyHint');
    if(!k){k=document.createElement('div');k.id='kellyHint';k.className='calc-sub';k.style.color='var(--muted2)';sub.parentElement.appendChild(k);}
    var h=PAPER.hist;if(!h||h.length<8){k.textContent='Kelly hint: needs 8+ closed trades to measure your edge.';return}
    var w=h.filter(function(t){return t.pl>0}),l=h.filter(function(t){return t.pl<=0});
    if(!w.length||!l.length){k.textContent='';return}
    var p=w.length/h.length,aw=w.reduce(function(a,t){return a+t.pl},0)/w.length,al=Math.abs(l.reduce(function(a,t){return a+t.pl},0)/l.length)||1;
    var b=aw/al;var f=Math.max(0,(p*b-(1-p))/b);
    k.innerHTML='Kelly (your '+h.length+'-trade edge): full '+(f*100).toFixed(1)+'% \u2192 <b style="color:var(--gold)">quarter-Kelly '+(f*25).toFixed(2)+'%</b> risk/trade';
  }catch(e){}},4000);
}catch(e){}})();

/* ---- v7.6d: bar narrator (status bar, plain language) ---- */
(function(){try{
  if(typeof recompute!=='function')return;
  var st=document.querySelector('.status');var tail=st&&st.querySelector('.s[style*="margin-left"]');
  var el=document.createElement('div');el.className='s';el.innerHTML='<span id="narrLine"></span>';if(st)st.insertBefore(el,tail);
  var prev=null;
  var _rc3=recompute;recompute=function(){_rc3();try{
    return; /* v33 R2: the narrative read strip duplicated the verdict card \u2014 one fact, one home */
    var con=IND._consensus;if(!con)return;var n=document.getElementById('narrLine');if(!n)return;
    if(prev&&(Math.sign(prev.score)!==Math.sign(con.score)||Math.abs(con.score-prev.score)>=12)){
      var dir=con.score>prev.score?'strengthened':'weakened';
      var drv=[];try{var b=con.byCat||{};var ks=Object.keys(b).sort(function(a,c){return Math.abs(b[c])-Math.abs(b[a])}).slice(0,2);drv=ks;}catch(e){}
      n.innerHTML='<b>'+(prev.score>=0?'+':'')+prev.score+' \u2192 '+(con.score>=0?'+':'')+con.score+'</b> read '+dir+(drv.length?' \u00b7 driven by '+drv.join(' & '):'');
    }
    prev={score:con.score};
  }catch(e){}};
}catch(e){}})();


/* ---- v7.7a: object tree for drawings ---- */
(function(){try{
  var db=document.getElementById('drawbar');if(!db)return;
  var btn=document.createElement('button');btn.title='Object tree (all drawings)';btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M7 12h13M10 18h10"/><circle cx="4" cy="12" r="1.4" fill="currentColor"/><circle cx="7" cy="18" r="1.4" fill="currentColor"/></svg>';
  db.appendChild(btn);
  var box=document.createElement('div');box.id='objTree';
  box.innerHTML='<div class="ot-h">Drawings <span id="otCount" style="color:var(--muted);font-weight:400"></span></div><div id="objTreeList"></div>';
  document.body.appendChild(box);
  function label(d){if(d.type==='hline')return ['H-line',fmt(d.price)];if(d.type==='vline')return ['V-line','bar '+Math.round(d.bar)];
    if(d.type==='avwap')return ['AVWAP','from bar '+Math.round(d.bar)];if(d.type==='text')return ['Text',d.text||''];
    if(d.a&&d.b)return [d.type.charAt(0).toUpperCase()+d.type.slice(1),fmt(d.a.price)+' \u2192 '+fmt(d.b.price)];
    return [d.type,''];}
  function render(){var list=document.getElementById('objTreeList');document.getElementById('otCount').textContent='('+DRAWINGS.length+')';
    list.innerHTML=DRAWINGS.length?DRAWINGS.map(function(d,i){var L=label(d);
      return '<div class="ot-row'+(d.hidden?' off':'')+'" data-i="'+i+'"><span class="t">'+L[0]+'</span><span class="p">'+L[1]+'</span><button class="vis" title="Show/hide">'+(d.hidden?'\ud83d\udc41\u200d\ud83d\udde8':'\ud83d\udc41')+'</button><button class="del" title="Delete">\u2715</button></div>';}).join('')
      :'<div style="padding:16px;color:var(--muted);font-size:11.5px">No drawings yet.</div>';
    list.querySelectorAll('.vis').forEach(function(b){b.onclick=function(){var i=+b.closest('.ot-row').dataset.i;DRAWINGS[i].hidden=!DRAWINGS[i].hidden;draw();render();};});
    list.querySelectorAll('.del').forEach(function(b){b.onclick=function(){var i=+b.closest('.ot-row').dataset.i;snapDrawings();DRAWINGS.splice(i,1);SELDRAW=-1;draw();render();};});}
  btn.onclick=function(e){e.stopPropagation();if(box.style.display==='flex'){box.style.display='none';return}
    render();var r=btn.getBoundingClientRect();box.style.left=(r.right+10)+'px';box.style.top=Math.min(r.top,innerHeight-400)+'px';box.style.display='flex';};
  document.addEventListener('click',function(e){if(box.style.display==='flex'&&!(e.target.closest&&(e.target.closest('#objTree')||e.target===btn)))box.style.display='none';});
}catch(e){}})();

/* ---- v7.7b: alert lines on the chart + drag to move ---- */
(function(){try{
  function myAlerts(){return (typeof ALERTS!=='undefined'?ALERTS:[]).filter(function(a){return a.armed&&a.sym===CURSYM.sym&&a.field==='price'&&isFinite(+a.value)})}
  function Y(p){var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*RENDER.priceH}
  var _d2=draw;draw=function(){_d2();try{
    if(!RENDER)return;var g=cv.getContext('2d');
    myAlerts().forEach(function(a){var yy=Y(+a.value);if(yy<0||yy>RENDER.priceH)return;
      g.strokeStyle='rgba(232,163,61,.8)';g.setLineDash([7,4]);g.beginPath();g.moveTo(0,yy);g.lineTo(RENDER.W-RENDER.padR,yy);g.stroke();g.setLineDash([]);
      g.fillStyle='#E8A33D';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText('\ud83d\udd14 '+fmt(+a.value)+' \u00b7 drag to move',6,yy-5);});
  }catch(e){}};
  var dragA=null;
  cv.addEventListener('mousedown',function(e){try{
    if(!RENDER)return;var r=cv.getBoundingClientRect(),X=e.clientX-r.left,Yc=e.clientY-r.top;
    if(X>=RENDER.W-RENDER.padR)return;
    var hit=null;myAlerts().forEach(function(a){if(Math.abs(Y(+a.value)-Yc)<6)hit=a});
    if(hit){dragA=hit;e.stopImmediatePropagation();e.preventDefault();document.body.style.cursor='ns-resize';}
  }catch(e){}},true);
  window.addEventListener('mousemove',function(e){if(!dragA||!RENDER)return;var r=cv.getBoundingClientRect();
    var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;
    var yv=e.clientY-r.top;var p=lg?Math.exp(la+(1-yv/RENDER.priceH)*ls):RENDER.lo+(1-yv/RENDER.priceH)*(RENDER.hi-RENDER.lo);
    dragA.value=+p;dragA._was=false;dragA._prev=null;try{draw()}catch(_){}} );
  window.addEventListener('mouseup',function(){if(dragA){toast('Alert moved to '+fmt(+dragA.value),'var(--gold)');try{if(typeof renderAlerts==='function')renderAlerts()}catch(e){}dragA=null;document.body.style.cursor='';}});
}catch(e){}})();

/* ---- v7.7c: pattern measured-move targets ---- */
(function(){try{
  var _d3=draw;draw=function(){_d3();try{
    if(!RENDER||!ON.has('patterns')||!IND._patterns)return;var g=cv.getContext('2d');
    function Y(p){var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*RENDER.priceH}
    IND._patterns.forEach(function(p){if(p.neck==null||!p.pts||!p.pts.length||p.dir==='neutral')return;
      var hi2=-1e18,lo2=1e18;p.pts.forEach(function(pt){hi2=Math.max(hi2,pt.p);lo2=Math.min(lo2,pt.p)});
      var h2=hi2-lo2;if(!(h2>0))return;var tgt=p.dir==='bull'?p.neck+h2:p.neck-h2;
      var yy=Y(tgt);if(yy<0||yy>RENDER.priceH)return;var col=p.dir==='bull'?var_bull():var_bear();
      g.strokeStyle=col;g.globalAlpha=.65;g.setLineDash([2,5]);g.beginPath();g.moveTo(RENDER.W*0.45,yy);g.lineTo(RENDER.W-RENDER.padR,yy);g.stroke();g.setLineDash([]);g.globalAlpha=1;
      g.fillStyle=col;g.font='9px JetBrains Mono';g.textAlign='right';g.fillText(p.type+' target '+fmt(tgt),RENDER.W-RENDER.padR-4,yy-5);});
  }catch(e){}};
}catch(e){}})();

/* ---- v7.7d: Flow Pack — TTM Squeeze · HMA · CVD line · Compare · Range Profile+VA ---- */
(function(){try{
  var M={key:''};
  function hma(c,p){p=p||21;function wma(a,n){var out=new Array(a.length).fill(null);var den=n*(n+1)/2;for(var i=n-1;i<a.length;i++){var s2=0;for(var j=0;j<n;j++)s2+=a[i-j]*(n-j);out[i]=s2/den}return out}
    var h=Math.round(p/2),sq=Math.round(Math.sqrt(p));var w1=wma(c,h),w2=wma(c,p);var diff=c.map(function(_,i){return (w1[i]!=null&&w2[i]!=null)?2*w1[i]-w2[i]:null});
    var valid=diff.map(function(v){return v==null?0:v});return wma(valid,sq).map(function(v,i){return i<p?null:v});}
  function compute(){var key=CURSYM.sym+'|'+TF+'|'+DATA.length+'|'+(window.CMP_SYM||'');if(M.key===key)return;M.key=key;
    var c=DATA.map(function(x){return x.c});
    M.hma=ON.has('hma')?hma(c,21):null;
    if(ON.has('squeeze')){var bb=IND.boll(c,20,2),kc=IND.keltner(DATA,20,1.5);
      M.sq=DATA.map(function(_,i){if(bb.up[i]==null||kc.up[i]==null)return null;return {on:bb.up[i]<kc.up[i]&&bb.lo[i]>kc.lo[i]}});}else M.sq=null;
    if(ON.has('cvdline')){var run=0;M.cvd=DATA.map(function(x){var body=Math.abs(x.c-x.o)/((x.h-x.l)||1e-9);run+=(x.c>=x.o?1:-1)*body*(x.v||0);return run});}else M.cvd=null;
    if(ON.has('cmp')){var other=window.CMP_SYM||(CURSYM.sym==='BTCUSD'?'ETHUSD':'BTCUSD');
      var dd=null;for(var k2 in BAR_CACHE){if(k2.indexOf(other+'|')===0&&BAR_CACHE[k2].length>60){dd=BAR_CACHE[k2];break}}
      if(!dd)dd=genData(DATA.length,(SPECS[other]||{px:100}).px,(other.charCodeAt(0)+other.length)*13+7);
      M.cmp={sym:other,d:dd};}else M.cmp=null;}
  var _d4=draw;draw=function(){_d4();try{
    if(!RENDER)return;var need=['squeeze','hma','cvdline','cmp','vrange'].some(function(k){return ON.has(k)});if(!need)return;
    compute();var g=cv.getContext('2d');var st2=RENDER.start,cw2=RENDER.cw,W2=RENDER.W,pr2=RENDER.padR,ph2=RENDER.priceH;
    var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;
    var Y=function(p){return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*ph2},X=function(i){return (i-st2)*cw2+cw2/2};
    var end2=Math.min(DATA.length,st2+Math.ceil((W2-pr2)/cw2)+1);
    g.save();g.beginPath();g.rect(0,0,W2-pr2,ph2+40);g.clip();
    if(M.hma&&ON.has('hma')){g.strokeStyle='#2DBE8E';g.lineWidth=1.7;g.beginPath();var m2=false;for(var i=st2;i<end2;i++){var v=M.hma[i];if(v==null){m2=false;continue}var xx=X(i),yy=Y(v);m2?g.lineTo(xx,yy):(g.moveTo(xx,yy),m2=true)}g.stroke();g.lineWidth=1;}
    if(M.sq&&ON.has('squeeze')){for(var i3=st2;i3<end2;i3++){var s3=M.sq[i3];if(!s3)continue;g.fillStyle=s3.on?'#E8A33D':'rgba(122,132,148,.4)';g.beginPath();g.arc(X(i3),ph2-6,s3.on?2.4:1.3,0,7);g.fill()}
      g.fillStyle='#E8A33D';g.font='8.5px JetBrains Mono';g.textAlign='left';g.fillText('SQUEEZE',4,ph2-14);}
    if(M.cvd&&ON.has('cvdline')){var lo3=1e18,hi3=-1e18;for(var i4=st2;i4<end2;i4++){lo3=Math.min(lo3,M.cvd[i4]);hi3=Math.max(hi3,M.cvd[i4])}
      var band=ph2*0.16,top=ph2*0.02;g.strokeStyle='rgba(76,130,251,.85)';g.lineWidth=1.5;g.beginPath();var m4=false;
      for(var i5=st2;i5<end2;i5++){var yv2=top+band*(1-(M.cvd[i5]-lo3)/((hi3-lo3)||1));var xx2=X(i5);m4?g.lineTo(xx2,yv2):(g.moveTo(xx2,yv2),m4=true)}g.stroke();g.lineWidth=1;
      g.fillStyle='rgba(76,130,251,.9)';g.font='8.5px JetBrains Mono';g.textAlign='left';g.fillText('CVD',4,top+9);}
    if(M.cmp&&ON.has('cmp')){var dd=M.cmp.d;var n0=Math.max(0,dd.length-(DATA.length-st2));var base=dd[n0]?dd[n0].c:1;var myBase=DATA[st2]?DATA[st2].c:1;
      g.strokeStyle='rgba(155,140,255,.9)';g.lineWidth=1.6;g.setLineDash([5,3]);g.beginPath();var m5=false;
      for(var i6=st2;i6<end2;i6++){var j=n0+(i6-st2);if(!dd[j])break;var pctv=dd[j].c/base;var mapped=myBase*pctv;var yy3=Y(mapped);var xx3=X(i6);m5?g.lineTo(xx3,yy3):(g.moveTo(xx3,yy3),m5=true)}
      g.stroke();g.setLineDash([]);g.lineWidth=1;
      g.fillStyle='rgba(155,140,255,.95)';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText('vs '+M.cmp.sym+' (%)',4,26);}
    if(ON.has('vrange')){var bins=40,B=new Array(bins).fill(0),tot=0;
      for(var i7=st2;i7<end2;i7++){var c7=DATA[i7];if(!c7)continue;var bi=Math.min(bins-1,Math.max(0,Math.floor((c7.c-RENDER.lo)/((RENDER.hi-RENDER.lo)||1)*bins)));B[bi]+=(c7.v||1);tot+=(c7.v||1);}
      var poc=0;for(var b2=1;b2<bins;b2++)if(B[b2]>B[poc])poc=b2;
      var acc=B[poc],va={lo:poc,hi:poc};while(acc<tot*0.7&&(va.lo>0||va.hi<bins-1)){var up=va.hi<bins-1?B[va.hi+1]:-1,dn=va.lo>0?B[va.lo-1]:-1;if(up>=dn){va.hi++;acc+=up}else{va.lo--;acc+=dn}}
      var mx=Math.max.apply(null,B)||1;var binP=function(bi2){return RENDER.lo+(bi2+0.5)/bins*(RENDER.hi-RENDER.lo)};
      for(var b3=0;b3<bins;b3++){var yy4=Y(binP(b3));var w3=B[b3]/mx*90;var inVA=b3>=va.lo&&b3<=va.hi;
        g.fillStyle=inVA?'rgba(45,190,142,.20)':'rgba(122,132,148,.12)';g.fillRect(0,yy4-(ph2/bins)*0.42,w3,(ph2/bins)*0.84);}
      [['POC',binP(poc),'#E8A33D'],['VAH',binP(va.hi),'rgba(45,190,142,.8)'],['VAL',binP(va.lo),'rgba(45,190,142,.8)']].forEach(function(L2){
        var yy5=Y(L2[1]);g.strokeStyle=L2[2];g.setLineDash([4,4]);g.beginPath();g.moveTo(0,yy5);g.lineTo(W2-pr2,yy5);g.stroke();g.setLineDash([]);
        g.fillStyle=L2[2];g.font='8.5px JetBrains Mono';g.textAlign='left';g.fillText(L2[0]+' '+fmt(L2[1]),96,yy5-4);});}
    g.restore();
  }catch(e){}};
  var body=document.getElementById('indPanelBody');
  if(body){var cat=document.createElement('div');cat.className='tcat';
    cat.innerHTML='<span class="tcat-h">Flow & Edge Pack</span>'+[
      ['squeeze','TTM Squeeze','#E8A33D'],['hma','Hull MA (21)','#2DBE8E'],['cvdline','CVD on chart','#4C82FB'],
      ['cmp','Compare pair (%)','#9B8CFF'],['vrange','Range Profile + VA','#7A8494']
    ].map(function(x){return '<div class="chip" data-ind="'+x[0]+'" style="--k:'+x[2]+'"><span class="sw"></span>'+x[1]+'</div>'}).join('');
    body.insertBefore(cat,body.firstChild);
    cat.querySelectorAll('.chip').forEach(function(ch){ch.onclick=function(e){e.stopPropagation();var k=ch.dataset.ind;
      if(k==='cmp'&&!ON.has('cmp')){var def=CURSYM.sym==='BTCUSD'?'ETHUSD':'BTCUSD';var v=prompt('Compare against which symbol?',def);if(v&&SPECS[v.toUpperCase()])window.CMP_SYM=v.toUpperCase();else window.CMP_SYM=def;}
      if(ON.has(k))ON.delete(k);else ON.add(k);ch.classList.toggle('on',ON.has(k));M.key='';
      var ic=document.getElementById('indCount');if(ic)ic.textContent='('+ON.size+' on)';try{draw()}catch(_){}if(window.renderIndActive)setTimeout(renderIndActive,0);};});}
}catch(e){}})();


/* ---- v8.0a: Pro Strategy Pack (verified rule DSL, appears under ★ Custom) ---- */
