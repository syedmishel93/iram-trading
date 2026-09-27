(function(){try{
  if(typeof draw!=='function'||typeof DATA==='undefined')return;
  var MEMO={len:0,key:''};
  function psar(d,af0,afmax){af0=af0||0.02;afmax=afmax||0.2;var out=new Array(d.length).fill(null);if(d.length<3)return out;
    var up=d[1].c>=d[0].c,sar=up?d[0].l:d[0].h,ep=up?d[1].h:d[1].l,af=af0;
    for(var i=2;i<d.length;i++){sar=sar+af*(ep-sar);
      if(up){if(d[i].l<sar){up=false;sar=ep;ep=d[i].l;af=af0}else{if(d[i].h>ep){ep=d[i].h;af=Math.min(afmax,af+af0)}}}
      else{if(d[i].h>sar){up=true;sar=ep;ep=d[i].h;af=af0}else{if(d[i].l<ep){ep=d[i].l;af=Math.min(afmax,af+af0)}}}
      out[i]={v:sar,up:up};}
    return out;}
  function ichimoku(d){var n=d.length,hh=function(p,i){var h=-1e18;for(var j=Math.max(0,i-p+1);j<=i;j++)h=Math.max(h,d[j].h);return h},ll=function(p,i){var l=1e18;for(var j=Math.max(0,i-p+1);j<=i;j++)l=Math.min(l,d[j].l);return l};
    var ten=[],kij=[],spA=[],spB=[];
    for(var i=0;i<n;i++){ten.push(i>=8?(hh(9,i)+ll(9,i))/2:null);kij.push(i>=25?(hh(26,i)+ll(26,i))/2:null);}
    for(var i2=0;i2<n;i2++){spA.push(ten[i2]!=null&&kij[i2]!=null?(ten[i2]+kij[i2])/2:null);spB.push(i2>=51?(hh(52,i2)+ll(52,i2))/2:null);}
    return {ten:ten,kij:kij,spA:spA,spB:spB};}
  function zigzag(d,pct){pct=pct||0.028;var pts=[],dir=0,ext=d[0].c,extI=0;
    for(var i=1;i<d.length;i++){var c=d[i].c;
      if(dir>=0&&c>ext){ext=c;extI=i}
      if(dir<=0&&c<ext){ext=c;extI=i}
      if(dir>=0&&c<ext*(1-pct)){pts.push({i:extI,p:ext});dir=-1;ext=c;extI=i}
      else if(dir<=0&&c>ext*(1+pct)){pts.push({i:extI,p:ext});dir=1;ext=c;extI=i}}
    pts.push({i:extI,p:ext});return pts;}
  function compute(){
    var key=CURSYM.sym+'|'+TF+'|'+DATA.length;if(MEMO.key===key)return;MEMO.key=key;
    MEMO.ichi=ON.has('ichimoku')?ichimoku(DATA):null;
    MEMO.kelt=ON.has('keltner')?IND.keltner(DATA):null;
    MEMO.don=ON.has('donchian')?IND.donchian(DATA):null;
    MEMO.psar=ON.has('psar')?psar(DATA):null;
    MEMO.zz=ON.has('zigzag')?zigzag(DATA):null;
    MEMO.srz=ON.has('srzones')?(function(){
      /* v39.5 A — VOLUME-WEIGHTED S/R. detectSR gave pivot levels + touch count;
         a level is only as strong as the volume that DEFENDED it, so each zone
         now carries: vw = share of total traded volume within +-0.6 ATR of the
         level, and age = bars since last touch (old zones fade). Strength is
         printed ON the zone; nothing is a mystery band. */
      var lv=detectSR(DATA);var atr=IND.atr(DATA);var a=atr[atr.length-1]||DATA[DATA.length-1].c*0.005;
      var w=a*0.6, totV=0; DATA.forEach(function(c){totV+=(c.v||0)});
      return lv.map(function(l){
        var vol=0,last=0;
        for(var i=0;i<DATA.length;i++){var c=DATA[i];
          if(c.l<=l.p+w&&c.h>=l.p-w){vol+=(c.v||0);last=i;}}
        return {p:l.p,n:l.n,w:w,vw:totV>0?vol/totV:0,age:DATA.length-1-last};
      }).sort(function(x,y){return (y.vw*y.n)-(x.vw*x.n)}).slice(0,8);
    })():null;
  }
  function painter(){
    if(!RENDER||!DATA.length)return;
    var need=['ichimoku','keltner','donchian','psar','pivots','zigzag','srzones'].some(function(k){return ON.has(k)});
    if(!need)return;
    compute();
    var g=cv.getContext('2d'),st2=RENDER.start,cw2=RENDER.cw,W2=RENDER.W,pr2=RENDER.padR,ph2=RENDER.priceH;
    var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;
    var Y=function(p){return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*ph2},X=function(i){return (i-st2)*cw2+cw2/2};
    var end2=Math.min(DATA.length,st2+Math.ceil((W2-pr2)/cw2)+1);
    g.save();g.beginPath();g.rect(0,0,W2-pr2,ph2);g.clip();
    function seg(arr,col,w2,shift){g.strokeStyle=col;g.lineWidth=w2||1.3;g.beginPath();var m=false;for(var i=st2;i<end2;i++){var v=arr[i-(shift||0)];if(v==null||i-(shift||0)<0){m=false;continue}var xx=X(i),yy=Y(v);if(!m){g.moveTo(xx,yy);m=true}else g.lineTo(xx,yy)}g.stroke();g.lineWidth=1}
    if(MEMO.ichi&&ON.has('ichimoku')){var I2=MEMO.ichi;
      /* cloud: spanA/B plotted shifted +26 */
      g.globalAlpha=.14;for(var i3=st2;i3<end2;i3++){var a2=I2.spA[i3-26],b2=I2.spB[i3-26];if(a2==null||b2==null||i3-26<0)continue;g.fillStyle=a2>=b2?'#2DBE8E':'#F0616D';var xx2=X(i3);g.fillRect(xx2-cw2/2,Math.min(Y(a2),Y(b2)),cw2,Math.abs(Y(a2)-Y(b2))||1)}g.globalAlpha=1;
      seg(I2.ten,'#4C82FB',1.2);seg(I2.kij,'#E8A33D',1.2);}
    if(MEMO.kelt&&ON.has('keltner')){seg(MEMO.kelt.up,'rgba(155,140,255,.55)');seg(MEMO.kelt.mid,'rgba(155,140,255,.85)',1.5);seg(MEMO.kelt.lo,'rgba(155,140,255,.55)')}
    if(MEMO.don&&ON.has('donchian')){seg(MEMO.don.up,'rgba(76,130,251,.6)');seg(MEMO.don.lo,'rgba(76,130,251,.6)');seg(MEMO.don.mid,'rgba(76,130,251,.3)')}
    if(MEMO.psar&&ON.has('psar')){for(var i4=st2;i4<end2;i4++){var pp2=MEMO.psar[i4];if(!pp2)continue;g.fillStyle=pp2.up?'rgba(45,190,142,.9)':'rgba(240,97,109,.9)';g.beginPath();g.arc(X(i4),Y(pp2.v),1.6,0,7);g.fill()}}
    if(ON.has('pivots')&&IND._levels&&IND._levels.pdh!=null&&IND._levels.pdl!=null&&IND._levels.pdc!=null){
      var H3=IND._levels.pdh,L3=IND._levels.pdl,C3=IND._levels.pdc,Pp=(H3+L3+C3)/3;
      var lv2=[['P',Pp,'#E8A33D'],['R1',2*Pp-L3,'#F0616D'],['S1',2*Pp-H3,'#2DBE8E'],['R2',Pp+(H3-L3),'rgba(240,97,109,.6)'],['S2',Pp-(H3-L3),'rgba(45,190,142,.6)']];
      g.font='9px JetBrains Mono';g.textAlign='left';
      lv2.forEach(function(l3){var yy3=Y(l3[1]);if(yy3<4||yy3>ph2-4)return;g.strokeStyle=l3[2];g.globalAlpha=.55;g.setLineDash([6,4]);g.beginPath();g.moveTo(0,yy3);g.lineTo(W2-pr2,yy3);g.stroke();g.setLineDash([]);g.globalAlpha=1;g.fillStyle=l3[2];g.fillText('PIV '+l3[0]+' '+fmt(l3[1]),4,yy3-4)});}
    if(MEMO.zz&&ON.has('zigzag')){g.strokeStyle='rgba(232,163,61,.85)';g.lineWidth=1.6;g.beginPath();var m2=false;MEMO.zz.forEach(function(pt){if(pt.i<st2-40)return;var xx4=X(pt.i),yy4=Y(pt.p);if(!m2){g.moveTo(xx4,yy4);m2=true}else g.lineTo(xx4,yy4)});g.stroke();g.lineWidth=1;}
    if(MEMO.srz&&ON.has('srzones')){MEMO.srz.forEach(function(z){
      var y1=Y(z.p+z.w),y2=Y(z.p-z.w);var lastC=DATA[DATA.length-1].c;
      /* opacity = evidence: volume share x touches, faded by age */
      var strength=Math.min(1, z.vw*4 + z.n*0.08);
      var fade=Math.max(.35, 1 - z.age/(DATA.length||1));
      var op=Math.max(.05, Math.min(.34, strength*.34*fade));
      g.fillStyle=z.p>lastC?'rgba(240,97,109,'+op.toFixed(3)+')':'rgba(45,190,142,'+op.toFixed(3)+')';
      g.fillRect(0,Math.min(y1,y2),W2-pr2,Math.abs(y2-y1)||1);
      g.fillStyle='rgba(212,218,227,.6)';g.font='8.5px JetBrains Mono';
      g.fillText(z.n+'\u00d7 \u00b7 '+(z.vw*100).toFixed(0)+'% vol',W2-pr2-92,Math.min(y1,y2)+9)});}
    g.restore();
  }
  var _d=draw;draw=function(){_d();try{painter()}catch(e){}};
  /* chips */
  var body=document.getElementById('indPanelBody');
  if(body){
    var cat=document.createElement('div');cat.className='tcat';
    cat.innerHTML='<span class="tcat-h">Pro Pack (new)</span>'+[
      ['ichimoku','Ichimoku Cloud','#2DBE8E'],['keltner','Keltner Channel','#9B8CFF'],['donchian','Donchian Channel','#4C82FB'],
      ['psar','Parabolic SAR','#E8A33D'],['pivots','Pivot Points (D)','#F0616D'],['zigzag','ZigZag','#E8A33D'],['srzones','Auto S/R Zones','#7A8494']
    ].map(function(x){return '<div class="chip" data-ind="'+x[0]+'" style="--k:'+x[2]+'"><span class="sw"></span>'+x[1]+'</div>'}).join('');
    body.insertBefore(cat,body.firstChild);
    cat.querySelectorAll('.chip').forEach(function(ch){ch.onclick=function(e){e.stopPropagation();
      var k=ch.dataset.ind;if(ON.has(k)){ON.delete(k)}else{ON.add(k)}ch.classList.toggle('on',ON.has(k));
      MEMO.key='';var ic=document.getElementById('indCount');if(ic)ic.textContent='('+ON.size+' on)';
      try{draw()}catch(_){}if(window.renderIndActive)setTimeout(renderIndActive,0);};});
  }
}catch(e){}})();

/* ---- v7.4d: smart alerts — MTF alignment + regime change (one-click) ---- */
(function(){try{
  var hint=document.getElementById('alHint');if(!hint||!hint.parentElement)return;
  var row=document.createElement('div');row.className='strat-row';row.style.cssText='gap:8px;flex-wrap:wrap;margin-top:8px';
  row.innerHTML='<button class="tbtn smart-al" id="saMtf" title="Fires when cross-timeframe alignment reaches 75%+">\u26a1 Alert: MTF alignment \u226575%</button><button class="tbtn smart-al" id="saReg" title="Fires when the regime flips (Trending \u2194 Mean-reverting)">\u26a1 Alert: regime change</button>';
  hint.parentElement.appendChild(row);
  var st={mtf:false,reg:false,_mtfWas:false,_regWas:null};
  function bell(sym,desc){try{ALERT_LOG.unshift({t:Date.now(),sym:sym,desc:desc,val:''});if(ALERT_LOG.length>60)ALERT_LOG.pop();if(window.updateBell)updateBell();toast('\ud83d\udd14 '+desc,'var(--gold)')}catch(e){}}
  document.getElementById('saMtf').onclick=function(){st.mtf=!st.mtf;this.classList.toggle('on',st.mtf);toast(st.mtf?'MTF-alignment alert armed':'MTF-alignment alert off');};
  document.getElementById('saReg').onclick=function(){st.reg=!st.reg;this.classList.toggle('on',st.reg);toast(st.reg?'Regime-change alert armed':'Regime-change alert off');};
  setInterval(function(){try{
    if(st.mtf){var m=mtfMatrix();var hitNow=m.agree>=75;if(hitNow&&!st._mtfWas)bell(CURSYM.sym,'MTF alignment '+m.agree+'% \u2014 timeframes agree');st._mtfWas=hitNow;}
    if(st.reg){var r=classifyRegime(DATA);if(st._regWas&&r.regime!==st._regWas)bell(CURSYM.sym,'Regime changed: '+st._regWas+' \u2192 '+r.regime);st._regWas=r.regime;}
  }catch(e){}},30000);
}catch(e){}})();


/* ---- v7.5: overlay crosshair (hover never redraws the chart) ---- */
(function(){try{
  var wrap=cv.parentElement;var ov=document.createElement('canvas');ov.id='xhair';wrap.appendChild(ov);
  var octx=ov.getContext('2d');
  window.paintOverlay=function(){
    var dpr=devicePixelRatio||1,W=cv._w||cv.clientWidth,H=cv._h||cv.clientHeight;
    if(ov.width!==W*dpr||ov.height!==H*dpr){ov.width=W*dpr;ov.height=H*dpr;ov.style.width=W+'px';ov.style.height=H+'px'}
    octx.setTransform(dpr,0,0,dpr,0,0);octx.clearRect(0,0,W,H);
    if(!MOUSE||!RENDER||!DATA.length)return;
    var padR=RENDER.padR,ph=RENDER.priceH,cw=RENDER.cw,st=RENDER.start,padB=26;
    if(MOUSE.x>=W-padR)return;
    var bi=Math.floor(MOUSE.x/cw),gi=st+bi;var c=DATA[gi];if(!c)return;window.CUR=c;
    var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;
    var xx=Math.round(bi*cw+cw/2)+0.5,yy=Math.round(MOUSE.y)+0.5;
    octx.strokeStyle='rgba(212,218,227,.28)';octx.setLineDash([3,3]);octx.beginPath();
    octx.moveTo(xx,0);octx.lineTo(xx,ph);octx.moveTo(0,yy);octx.lineTo(W-padR,yy);octx.stroke();octx.setLineDash([]);
    var pp=lg?Math.exp(la+(1-MOUSE.y/ph)*ls):RENDER.lo+(1-MOUSE.y/ph)*(RENDER.hi-RENDER.lo);
    var cy=(window._liveTagY!=null&&Math.abs(MOUSE.y-window._liveTagY)<18)?(MOUSE.y<window._liveTagY?window._liveTagY-19:window._liveTagY+19):MOUSE.y;
    octx.font='10px JetBrains Mono';octx.textBaseline='middle';
    /* v39.6 Z4b: the gold mouse-price pill duplicated 47-tv's #axPx (same mouse, same price, two pills). Retired with its time twin. */
    /* v39.6 Z4 -- THE REAL DOUBLE-PILL: this module painted its own gold
       time bubble on canvas while 47-tv's DOM #axTm painted the white one --
       TWO complete crosshair time readouts, stacked. My v39.1 and v39.6-first
       'fixes' both patched a third, dead-coded painter. One owner now: 47's
       styled DOM bubble. The gold canvas copy is retired; the y-price pill
       above stays (47's #axPx tracks the mouse, this one tracks the BAR --
       different information, both kept, different rows). */
  };
  cv.addEventListener('mouseleave',function(){try{octx.clearRect(0,0,ov.width,ov.height)}catch(e){}});
}catch(e){window.paintOverlay=null}})();

/* ---- v7.5: price tick flash ---- */
