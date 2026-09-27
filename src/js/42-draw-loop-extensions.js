/* ================= v7.0c: collapsible side cards (persisted) ================= */
(function(){try{
  var side=document.getElementById('side');if(!side)return;
  var saved={};try{saved=JSON.parse(localStorage.getItem('mishel_cards')||'{}')}catch(e){}
  side.querySelectorAll('.card').forEach(function(card,i){
    var h=card.querySelector('h3');if(!h)return;
    if(saved[i])card.classList.add('folded');
    h.addEventListener('click',function(){card.classList.toggle('folded');
      saved[i]=card.classList.contains('folded')?1:0;
      try{localStorage.setItem('mishel_cards',JSON.stringify(saved))}catch(e){}});
  });
}catch(e){}})();

/* ================= v7.0d: status bar clock + trading session ================= */
(function(){try{
  var st=document.querySelector('.status');if(!st)return;
  var tail=st.querySelector('.s[style*="margin-left"]');
  var el1=document.createElement('div');el1.className='s';/* v39.1 A3: was id=stClock, COLLIDING with the v35 Jobs X-ray chip in the markup. getElementById returns the first match, so this wall clock printed --:--:-- forever. */el1.innerHTML='<b id="stWall">--:--:--</b>';
  var el2=document.createElement('div');el2.className='s';el2.innerHTML='Session <b id="stSess">—</b>';
  st.insertBefore(el1,tail);st.insertBefore(el2,tail);
  function sess(){var d=new Date(),h=d.getUTCHours(),dow=d.getUTCDay();
    var cls=(typeof CURSYM!=='undefined'&&CURSYM&&CURSYM.cls)||'crypto';
    if(cls==='stock'||cls==='index'){
      if(dow===0||dow===6)return 'Weekend (market closed)';
      var m=h*60+d.getUTCMinutes();
      if(m>=810&&m<1200)return 'NYSE open';
      if(m>=480&&m<810)return 'Pre-market';
      if(m>=1200&&m<1440)return 'After-hours';
      return 'Closed';
    }
    if(cls==='forex'||cls==='metal'){
      if((dow===5&&h>=22)||dow===6||(dow===0&&h<22))return 'Weekend (FX closed)';
    }
    var A=[['Sydney',22,7],['Tokyo',0,9],['London',8,17],['New York',13,22]];var act=A.filter(function(w){return w[1]<w[2]?(h>=w[1]&&h<w[2]):(h>=w[1]||h<w[2])}).map(function(w){return w[0]});return act.length?act.join(' + '):'-';}
  window.mishelSession=sess; try{ window._session=sess(); }catch(e){}   /* v39.13: publish globally — the sniper pre-flight & live bar read window._session (was always '—') */
  setInterval(function(){try{
    var d=new Date();var off=-d.getTimezoneOffset()/60;var oz='UTC'+(off>=0?'+':'')+off;
    document.getElementById('stWall').textContent=d.toLocaleTimeString(undefined,{hour12:false})+' '+oz;
    var _s=sess(); window._session=_s;
    document.getElementById('stSess').textContent=_s;
  }catch(e){}},1000);
}catch(e){}})();

/* ================= v26.2 DRAW-LOOP EXTENSIONS (isolated): C8 sessions · C9 compare · C10 SM markers ================= */
(function(){
  var SESS_KEY='mishel_sess_shade';
  window._sessOn=localStorage.getItem(SESS_KEY)==='1';
  window._cmp=null;   /* {sym, key} */

  window._drawPre=function(o){ /* C8 session shading (background, before candles) */
    if(!window._sessOn)return;
    if(!/m|h/.test(TF)||TF==='1d')return;   /* intraday only */
    var g=o.g;g.save();
    for(var i=0;i<o.vis.length;i++){
      var hr=new Date(o.vis[i].t).getUTCHours();
      var ln=hr>=7&&hr<16, ny=hr>=12&&hr<21;
      if(!ln&&!ny)continue;
      g.fillStyle=ln&&ny?'rgba(122,143,90,.055)':ln?'rgba(91,141,239,.05)':'rgba(232,163,61,.05)';
      g.fillRect(o.x(i)-o.cw/2,0,o.cw,o.priceH);
    }
    g.fillStyle='rgba(140,150,165,.5)';g.font='8.5px JetBrains Mono';g.textAlign='left';
    g.fillText('sessions: LDN 07-16 \u00b7 NY 12-21 UTC',8,o.priceH-6);
    g.restore();};

  window._drawPost=function(o){ /* C9 compare + C10 smart-money markers */
    var g=o.g;
    /* C9: %-normalized overlay of a second symbol from BAR_CACHE */
    if(window._cmp&&window._cmp.key){
      var bars=(typeof BAR_CACHE!=='undefined')&&BAR_CACHE[window._cmp.key];
      if(bars&&bars.length>5){
        var byT={};bars.forEach(function(b){byT[b.t]=b.c});
        var base=null,pts=[];
        for(var i=0;i<o.vis.length;i++){var c2=byT[o.vis[i].t];if(c2==null)continue;
          if(base==null)base=c2;pts.push({i:i,p:c2/base-1});}
        if(pts.length>2){
          var mn=Infinity,mx=-Infinity;pts.forEach(function(pt){mn=Math.min(mn,pt.p);mx=Math.max(mx,pt.p)});
          var sp=(mx-mn)||1e-9;
          g.save();g.strokeStyle='rgba(201,166,255,.9)';g.lineWidth=1.4;g.setLineDash([5,3]);g.beginPath();
          pts.forEach(function(pt,k){var yy=(1-(pt.p-mn)/sp)*(o.priceH*0.9)+o.priceH*0.05;k?g.lineTo(o.x(pt.i),yy):g.moveTo(o.x(pt.i),yy)});
          g.stroke();g.setLineDash([]);
          var lastP=pts[pts.length-1];
          g.fillStyle='rgba(201,166,255,.95)';g.font='9.5px JetBrains Mono';g.textAlign='left';
          g.fillText(window._cmp.sym+' '+((lastP.p>=0?'+':'')+(lastP.p*100).toFixed(2))+'% (norm.)',8,26);
          g.restore();
        }else{g.save();g.fillStyle='rgba(201,166,255,.6)';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText('compare: no overlapping bars with '+window._cmp.sym+' on this TF',8,26);g.restore();}
      }else{g.save();g.fillStyle='rgba(201,166,255,.6)';g.font='9px JetBrains Mono';g.textAlign='left';g.fillText('compare: open '+(window._cmp.sym||'the symbol')+' once on this TF first (no hidden fetching \u2014 honest)',8,26);g.restore();}
    }
    /* C10: smart-money buy/sell markers when the tracked-wallet event token matches the charted symbol */
    try{
      var ev=window._lastFeedEvents||[];if(!ev.length)throw 0;   /* v29.0 FIX: was `return` — it exited the WHOLE hook and killed the SIG renderer below; throw exits only this try-block */
      var base=(CURSYM.sym||'').replace(/USDT?$|\/.*$/,'').toUpperCase();
      var t0=o.vis[0].t,t1=o.vis[o.vis.length-1].t,span=(o.vis[1]?o.vis[1].t-o.vis[0].t:60000);
      var drawn=0;
      ev.forEach(function(e){
        if(!e.t||e.t<t0||e.t>t1+span)return;
        var es=(e.sym||'').toUpperCase();if(!es||es!==base)return;
        var idx=Math.round((e.t-t0)/span);if(idx<0||idx>=o.vis.length)return;
        var up=e.dir==='BUY';var yy=up?o.y(o.vis[idx].l)+9:o.y(o.vis[idx].h)-9;var xx=o.x(idx);
        g.save();g.fillStyle=up?'rgba(45,190,142,.95)':'rgba(240,97,109,.95)';g.beginPath();
        if(up){g.moveTo(xx,yy-5);g.lineTo(xx-4.5,yy+3);g.lineTo(xx+4.5,yy+3);}else{g.moveTo(xx,yy+5);g.lineTo(xx-4.5,yy-3);g.lineTo(xx+4.5,yy-3);}
        g.closePath();g.fill();g.restore();drawn++;});
      if(drawn){g.save();g.fillStyle='rgba(140,150,165,.6)';g.font='8.5px JetBrains Mono';g.textAlign='left';
        g.fillText('\u25b2\u25bc tracked-wallet moves on '+base+' ('+drawn+') \u2014 evidence, not signals',8,38);g.restore();}
    }catch(e){}
    /* ===== SUP1: LIQUIDITY MAP \u2014 where the resting stops live (touch-weighted, glass-box) ===== */
    try{if(window._liqMapOn){const g=o.g;const a6=(IND.atr(DATA)[DATA.length-1])||1;const items=[];
      const sw6=IND._sw||{hi:[],lo:[]};
      const pool=(arr,isLo)=>{arr.slice(-14).forEach(ix=>{const pv=isLo?DATA[ix].l:DATA[ix].h;
        let t6=0;arr.forEach(jx=>{const v6=isLo?DATA[jx].l:DATA[jx].h;if(Math.abs(v6-pv)<=0.15*a6)t6++});
        items.push({p:pv,w:Math.min(4,t6),kind:isLo?'lows':'highs'})})};
      pool(sw6.hi,false);pool(sw6.lo,true);
      const stp=Math.pow(10,Math.floor(Math.log10(DATA[DATA.length-1].c))-1);
      for(let rr=Math.floor(o.lo/stp)*stp;rr<=o.hi;rr+=stp)items.push({p:rr,w:1.4,kind:'round'});
      (IND._fvg||[]).filter(f=>!f.filled).slice(-6).forEach(f=>items.push({p:(f.top+f.bot)/2,w:2,kind:'FVG'}));
      items.forEach(it=>{if(it.p<o.lo||it.p>o.hi)return;const yy=o.y(it.p);
        g.save();g.fillStyle=it.kind==='round'?'rgba(155,140,255,'+(0.03*it.w)+')':it.kind==='FVG'?'rgba(232,163,61,'+(0.035*it.w)+')':'rgba(91,141,239,'+(0.035*it.w)+')';
        g.fillRect(0,yy-1.5,o.W-o.padR,3);
        if(it.w>=2.5){g.fillStyle='rgba(140,150,165,.55)';g.font='7.5px JetBrains Mono';g.textAlign='left';g.fillText(it.kind+' \u00d7'+Math.round(it.w),4,yy-3)}g.restore();});
      g.save();g.fillStyle='rgba(140,150,165,.5)';g.font='8px JetBrains Mono';g.textAlign='left';
      g.fillText('\u{1F5FA} liquidity map \u00b7 multi-touch swings + equal pools + round numbers + unfilled FVGs \u00b7 stop-cluster ESTIMATES',6,o.priceH-6);g.restore();}}catch(e){}
    /* ===== M10: auto-annotations from the engine's own detectors ===== */
    try{if(window._annotOn){var g=o.g;
      (IND._atl||[]).slice(-4).forEach(function(tl){if(!tl||tl.i1==null)return;
        var x1=o.x(Math.max(0,tl.i1-o.start)),y1=o.y(tl.p1),x2=o.x(Math.min(o.end-1,tl.i2!=null?tl.i2:o.end-1)-o.start),y2=o.y(tl.p2!=null?tl.p2:tl.p1);
        g.save();g.strokeStyle='rgba(155,140,255,.5)';g.setLineDash([6,4]);g.beginPath();g.moveTo(x1,y1);g.lineTo(x2,y2);g.stroke();g.setLineDash([]);
        g.fillStyle='rgba(155,140,255,.7)';g.font='8px JetBrains Mono';g.textAlign='left';g.fillText('auto-TL',x2-34,y2-4);g.restore();});
      (IND._sr||[]).slice(-5).forEach(function(z){if(z.p==null&&z.top==null)return;var pv=z.p!=null?z.p:(z.top+z.bot)/2;if(pv<o.lo||pv>o.hi)return;
        var yy=o.y(pv);g.save();g.strokeStyle='rgba(232,163,61,.35)';g.beginPath();g.moveTo(0,yy);g.lineTo(o.W-o.padR,yy);g.stroke();
        g.fillStyle='rgba(232,163,61,.7)';g.font='8px JetBrains Mono';g.textAlign='left';g.fillText('S/R'+(z.touches?' \u00d7'+z.touches:''),4,yy-3);g.restore();});}}catch(e){}
    /* ===== M7: estimated liquidation zones (glass-box: swing entries \u00b1 1/L, OI-weighted) ===== */
    try{if(window._liqOn&&window._oflow&&window._oflow.oi&&/BTC|ETH|SOL/.test(CURSYM.sym)){
      var g=o.g;var sw2=IND._sw||{hi:[],lo:[]};var zones=[];
      [10,25,50].forEach(function(L2,li){
        sw2.lo.slice(-3).forEach(function(ix){var e2=DATA[ix].l;zones.push({p:e2*(1-1/L2),w:3-li,side:'long'})});
        sw2.hi.slice(-3).forEach(function(ix){var e2=DATA[ix].h;zones.push({p:e2*(1+1/L2),w:3-li,side:'short'})});});
      zones.forEach(function(z){if(z.p<o.lo||z.p>o.hi)return;var yy=o.y(z.p);
        g.save();g.fillStyle=z.side==='long'?'rgba(240,97,109,'+(0.05*z.w)+')':'rgba(45,190,142,'+(0.05*z.w)+')';
        g.fillRect(o.W-o.padR-70,yy-2,70,4);g.restore();});
      g.save();g.fillStyle='rgba(140,150,165,.55)';g.font='8px JetBrains Mono';g.textAlign='right';
      g.fillText('est. liq zones \u00b7 swing\u00b11/L (10/25/50\u00d7) \u00b7 estimate, not exchange data',o.W-o.padR-4,14);g.restore();}}catch(e){}
    /* ===== E5: economic calendar markers ===== */
    try{if(window._newsItems&&window._newsItems.length&&o.vis.length>1){
      var t0e=o.vis[0].t,t1e=o.vis[o.vis.length-1].t,spanE=o.vis[1].t-o.vis[0].t;
      var g=o.g;(window._newsItems||[]).forEach(function(ev2){if(!ev2.t||ev2.t<t0e||ev2.t>t1e+spanE)return;
        var xi2=o.x(Math.round((ev2.t-t0e)/spanE));
        g.save();g.strokeStyle='rgba(232,163,61,.35)';g.setLineDash([2,5]);g.beginPath();g.moveTo(xi2,0);g.lineTo(xi2,o.priceH);g.stroke();g.setLineDash([]);
        g.fillStyle='rgba(232,163,61,.8)';g.font='9px JetBrains Mono';g.textAlign='center';g.fillText('\u{1F4C5}',xi2,10);g.restore();});}}catch(e){}
    /* ===== E3: VPVR volume profile (visible range) ===== */
    try{if(window._vpvrOn){
      var NB=24,rows=new Array(NB).fill(0),lo2=o.lo,span2=(o.hi-o.lo)||1e-9;
      for(var vi=0;vi<o.vis.length;vi++){var bar2=o.vis[vi];var mid2=(bar2.h+bar2.l)/2;
        var bIx=Math.max(0,Math.min(NB-1,Math.floor((mid2-lo2)/span2*NB)));rows[bIx]+=bar2.v||1;}
      var mx2=Math.max.apply(null,rows)||1;var poc=rows.indexOf(mx2);
      /* value area: expand around POC until 70% of volume */
      var tot=rows.reduce(function(a,b){return a+b},0),acc=rows[poc],va1=poc,va2=poc;
      while(acc<tot*0.7&&(va1>0||va2<NB-1)){var up3=va1>0?rows[va1-1]:-1,dn3=va2<NB-1?rows[va2+1]:-1;
        if(up3>=dn3){va1--;acc+=Math.max(0,up3)}else{va2++;acc+=Math.max(0,dn3)}}
      var g=o.g;g.save();
      for(var ri=0;ri<NB;ri++){var w2=(rows[ri]/mx2)*90;var yv=(1-(ri+0.5)/NB)*o.priceH;
        g.fillStyle=ri>=va1&&ri<=va2?'rgba(91,141,239,.16)':'rgba(120,130,150,.09)';
        g.fillRect(o.W-o.padR-w2,yv-o.priceH/NB/2+1,w2,o.priceH/NB-2);}
      var pocY=(1-(poc+0.5)/NB)*o.priceH;
      g.strokeStyle='rgba(232,163,61,.85)';g.setLineDash([2,2]);g.beginPath();g.moveTo(0,pocY);g.lineTo(o.W-o.padR,pocY);g.stroke();g.setLineDash([]);
      g.fillStyle='rgba(232,163,61,.9)';g.font='8.5px JetBrains Mono';g.textAlign='right';g.fillText('POC',o.W-o.padR-4,pocY-3);
      var vah=(1-(va2+1)/NB)*o.priceH,val=(1-va1/NB)*o.priceH;
      g.strokeStyle='rgba(91,141,239,.5)';[vah,val].forEach(function(yv2,ix){g.setLineDash([3,4]);g.beginPath();g.moveTo(0,yv2);g.lineTo(o.W-o.padR,yv2);g.stroke();g.setLineDash([]);g.fillStyle='rgba(91,141,239,.7)';g.fillText(ix?'VAL':'VAH',o.W-o.padR-4,yv2-3)});
      g.restore();}}catch(e){}
    /* ===== SIG2: strategy signals on the chart ===== */
    try{
      var SS=window._sigState;
      if(SS&&SS.on&&SS.sigs&&SS.sigs.length){
        var stt=SS.stats||{};SS._hit=[];
        if(!window.qCalib){ /* IN2: quality calibration */
          window.qCalib=function(sigs){const B={'0-40':[0,0],'40-60':[0,0],'60-80':[0,0],'80+':[0,0]};
            (sigs||[]).forEach(function(s3){if(s3.res==='open'||s3.res==='time'||s3.q==null)return;
              const k3=s3.q<40?'0-40':s3.q<60?'40-60':s3.q<80?'60-80':'80+';B[k3][1]++;if(s3.res!=='stop')B[k3][0]++});
            const out={};Object.keys(B).forEach(function(k3){out[k3]=B[k3][1]?{rate:B[k3][0]/B[k3][1],n:B[k3][1]}:null});return out};
          /* IN1: three-bullet setup memo, written from data */
          window.sigMemo=function(sg){try{const SS2=window._sigState;const nm2=(window.SIG_STRATS[SS2.resolvedStrat]||{}).name||'';
            const b1='fired: '+nm2+' '+(sg.dir===1?'LONG':'SHORT')+((sg.stack||0)>=2?' \u00b7 \u25c9 '+sg.stack+' agree':'');
            const ses=(SS2.sessStats||{})[sg.sess];const hab=(window.SIG_STRATS[SS2.resolvedStrat]||{}).habitat;
            const b2='for: '+[(ses&&ses.winPct!=null&&ses.resolved>=4?sg.sess+' '+(ses.winPct*100).toFixed(0)+'% here':null),(hab&&hab!=='any'?'in-habitat ('+hab+')':null)].filter(Boolean).join(' \u00b7 ')||'for: record building';
            const b3='against: '+[(sg.q!=null&&sg.q<50?'quality '+sg.q:null),(SS2.stackStats&&SS2.stackStats.solo&&SS2.stackStats.solo.winPct!=null&&(sg.stack||0)<2?'solo signals run '+(SS2.stackStats.solo.winPct*100).toFixed(0)+'%':null)].filter(Boolean).join(' \u00b7 ')||'against: no flagged weakness';
            return [b1,b2,b3];}catch(e){return null}};}
        SS.sigs.forEach(function(sg){
          if(sg.i<o.start||sg.i>=o.end)return;
          var xi=o.x(sg.i-o.start);var long=sg.dir===1;
          var yy=long?o.y(DATA[sg.i].l)+12:o.y(DATA[sg.i].h)-12;
          SS._hit.push({x:xi,y:yy,sig:sg});   /* T10 hover hit-box */
          /* outcome trace first (under the arrow) */
          if(sg.res!=='open'&&sg.rEnd!=null&&sg.rEnd<o.end){
            var xe=o.x(Math.min(sg.rEnd,o.end-1)-o.start);
            var tgt=sg.res==='stop'?sg.stop:(sg.res==='t2'?sg.t2:sg.t1);
            /* A2: outcome as a soft gradient ribbon, not a hairline */
            g.save();var win2=sg.res!=='stop';var rc=win2?'45,190,142':'240,97,109';
            var y0=o.y(sg.entry),y1r=o.y(tgt);
            var grd=g.createLinearGradient(xi,0,xe,0);grd.addColorStop(0,'rgba('+rc+',.05)');grd.addColorStop(1,'rgba('+rc+',.30)');
            g.fillStyle=grd;g.beginPath();g.moveTo(xi,y0-1.5);g.lineTo(xe,y1r-1.5);g.lineTo(xe,y1r+1.5);g.lineTo(xi,y0+1.5);g.closePath();g.fill();
            g.strokeStyle='rgba('+rc+',.65)';g.lineWidth=1;g.beginPath();g.moveTo(xi,y0);g.lineTo(xe,y1r);g.stroke();g.restore();}
          /* A2: TV-style flag pill with stem */
          g.save();var col2=long?'rgba(45,190,142':'rgba(240,97,109';
          var py2=long?yy+8:yy-8;var lbl=(long?'\u25b2 L':'\u25bc S')+(sg.q!=null&&sg.q>=70?'+':'')+((sg.stack||0)>=2?' \u25c9':'');
          g.strokeStyle=col2+',.75)';g.lineWidth=1;g.beginPath();g.moveTo(xi,yy-(long?2:-2));g.lineTo(xi,py2);g.stroke();
          g.font='700 8.5px JetBrains Mono';var tw=g.measureText(lbl).width+10;
          var bx2=xi-tw/2,by2=long?py2:py2-13;
          g.fillStyle=col2+',.16)';g.strokeStyle=col2+',.9)';g.lineWidth=1;
          g.beginPath();g.roundRect?g.roundRect(bx2,by2,tw,13,4):g.rect(bx2,by2,tw,13);g.fill();g.stroke();
          g.fillStyle=col2+',1)';g.textAlign='center';g.textBaseline='middle';
          g.fillText(lbl,xi,by2+6.5);g.textBaseline='alphabetic';g.restore();});
        /* live setup: last signal still open and recent = plan on the chart */
        var lv=SS.sigs[SS.sigs.length-1];
        if(lv&&lv.res==='open'&&DATA.length-lv.i<40){
          g.save();
          var yE=o.y(lv.entry),yS=o.y(lv.stop),y1=o.y(lv.t1),y2=o.y(lv.t2);
          var x0=o.W-o.padR-110,x1=o.W-o.padR;
          g.fillStyle=lv.dir===1?'rgba(45,190,142,.08)':'rgba(240,97,109,.08)';
          g.fillRect(x0,Math.min(yE,yS),x1-x0,Math.abs(yS-yE));
          var ln=function(yv,col,lbl){g.strokeStyle=col;g.setLineDash([4,3]);g.beginPath();g.moveTo(x0,yv);g.lineTo(x1,yv);g.stroke();g.setLineDash([]);g.fillStyle=col;g.font='8.5px JetBrains Mono';g.textAlign='left';g.fillText(lbl,x0+2,yv-3)};
          ln(yS,'rgba(240,97,109,.9)','stop');ln(y1,'rgba(45,190,142,.85)','T1');ln(y2,'rgba(45,190,142,.65)','T2');ln(yE,'rgba(200,210,225,.8)',(lv.dir===1?'LONG':'SHORT')+' entry');
          g.restore();}
        /* SIG3 honesty legend */
        g.save();g.font='9px JetBrains Mono';g.textAlign='left';
        var _sm=window.SIG_STRATS[SS.resolvedStrat||SS.strat]||{};
        var _ciT=stt.ciLo!=null?' ('+(stt.ciLo*100).toFixed(0)+'\u2013'+(stt.ciHi*100).toFixed(0)+'% CI)':'';
        var _edgeT=stt.ciLo!=null?(stt.ciLo>0.5?' \u00b7 edge holds @95%':stt.ciHi<0.5?' \u00b7 NEGATIVE @95%':' \u00b7 CI crosses 50% \u2014 no edge claim'):'';
        var rec=stt.winPct!=null?((stt.winPct*100).toFixed(0)+'%'+_ciT+' \u00b7 net '+((stt.netAvgR!=null?stt.netAvgR:stt.avgR)>=0?'+':'')+(stt.netAvgR!=null?stt.netAvgR:stt.avgR).toFixed(2)+'R \u00b7 PF '+(stt.pf===Infinity?'\u221e':stt.pf)+' \u00b7 '+stt.resolved+' res'+(stt.scratches?' ('+stt.scratches+' timed out)':'')+(SS.qOn?' \u00b7 Q\u226550':'')+_edgeT):'record building \u2014 not enough resolved signals';
        rec=(_sm.style?_sm.style.toUpperCase()+' \u00b7 ':'')+(SS.oos?(SS.wf?'WF-OOS \u00b7 ':'OOS \u00b7 '):'')+rec;
        g.fillStyle=stt.avgR!=null&&stt.avgR<0?'rgba(240,97,109,.85)':'rgba(140,150,165,.75)';
        var _ly=46; /* v32.1 F5: legend lives top-left under the OHLC line, TV-style */
        g.fillText('SIG '+(window.SIG_STRATS[SS.strat]?window.SIG_STRATS[SS.strat].name:SS.strat)+' \u00b7 '+rec+' \u2014 measured on THIS data, not a promise',8,_ly);
        try{var xtra=[];
          if(SS.stackStats&&SS.stackStats.nStacked>=2&&SS.stackStats.stacked.winPct!=null)
            xtra.push('\u25c9 stacked('+SS.stackStats.nStacked+'): '+(SS.stackStats.stacked.winPct*100).toFixed(0)+'% vs solo '+(SS.stackStats.solo.winPct!=null?(SS.stackStats.solo.winPct*100).toFixed(0)+'%':'\u2014'));
          if(SS.sessStats){var bs2=null;Object.keys(SS.sessStats).forEach(function(k){var v=SS.sessStats[k];if(v.resolved>=4&&(bs2==null||v.avgR>SS.sessStats[bs2].avgR))bs2=k});
            if(bs2)xtra.push('best session: '+bs2+' ('+(SS.sessStats[bs2].winPct*100).toFixed(0)+'% \u00b7 '+SS.sessStats[bs2].resolved+' res)');}
          if(xtra.length){g.fillStyle='rgba(140,150,165,.6)';g.fillText(xtra.join('  \u00b7  '),8,_ly+11);}}catch(e){}
        g.restore();}
    }catch(e){}
  };

  /* buttons */
  var sb=document.getElementById('sessBtn');
  if(sb){sb.classList.toggle('on',window._sessOn);
    sb.onclick=function(){window._sessOn=!window._sessOn;localStorage.setItem(SESS_KEY,window._sessOn?'1':'0');sb.classList.toggle('on',window._sessOn);try{draw()}catch(e){}};}
  /* SIG4/SIG5 wiring */
  window._sigState={on:false,strat:null,sigs:[],stats:null,lastLiveI:null};
  window._labLite={};window._labLiteKey='';
  function labLiteKick(){try{var key=CURSYM.sym+'|'+TF;if(window._labLiteKey===key||typeof DATA==='undefined'||DATA.length<200)return;
    window._labLiteKey=key;window._labLite={};var ks=Object.keys(window.SIG_STRATS);var ix=0;
    (function step(){if(window._labLiteKey!==key||ix>=ks.length)return;var k7=ks[ix++];
      try{var st7=sigStats(sigScan(DATA,k7));if(st7.netAvgR!=null){window._labLite[k7]=st7.netAvgR;
        var op=document.querySelector('#sigSel option[value="'+k7+'"]');
        if(op){if(!op.dataset.base)op.dataset.base=op.textContent;var r7=st7.netAvgR;op.textContent=op.dataset.base+' \u00b7 '+(r7>=0?'+':'')+r7.toFixed(2)+'R'+(st7.n!=null?' ('+st7.n+')':'')}}}catch(e){}
      setTimeout(step,140);})();}catch(e){}}
  setInterval(labLiteKick,7000);
  window.sigRefresh=function(){try{var SS=window._sigState;if(!SS.on||!SS.strat||typeof DATA==='undefined'||DATA.length<80)return;
    var strat=SS.strat;
    if(strat==='auto'){var b=null;try{b=sigBestWF(DATA,typeof TF!=='undefined'?TF:null)}catch(e){}if(!b)b=sigBest(DATA,typeof TF!=='undefined'?TF:null);if(!b){SS.sigs=[];SS.stats={n:0,resolved:0,winPct:null,avgR:null,pf:null};SS.resolvedStrat=null;try{draw()}catch(e){}return}
      /* v38.0 THE GATE ON THE STAR.
         Best-of-26 is a SEARCH, and a search through noise always finds a hero. The
         PBO/DSR machinery has sat in this codebase since v13, wired only to a backtest
         panel nobody opens. It is now wired to the one thing that tells him what to
         trade — and it is allowed to say NO.
         A withheld ★ is a RESULT. It means: today, nothing here is distinguishable
         from luck. A trading system should be able to say that out loud. */
      var _au=null;try{_au=window.pickerAudit(DATA,b,typeof TF!=='undefined'?TF:null)}catch(e){}
      SS.audit=_au;
      if(_au && !_au.promote){
        SS.withheld={strat:b.strat,why:_au.why,pbo:_au.pbo,dsr:_au.dsr,trials:_au.trials,ci:_au.ci};
        SS.resolvedStrat=null;SS.sigs=[];SS.oos=true;SS.wf=!!b.wf;SS._oosStats=b.stats;
      }else{
        SS.withheld=null;
        SS.resolvedStrat=b.strat;SS.sigs=sigScan(DATA,b.strat);SS.oos=true;SS.wf=!!b.wf;SS._oosStats=b.stats;
      }}
    else{SS.resolvedStrat=strat;SS.sigs=sigScan(DATA,strat);SS.oos=false;SS._oosStats=null;SS.withheld=null;SS.audit=null;}
    /* v39.5 SIGNAL BRAIN.
       (1) LEARN: every resolved historical trigger in this scan is a labeled
           example (t1/t2 = 1, stop = 0; time-scratches teach nothing). Dedup
           by symbol|strat|bar so re-scans never double-count.
       (2) TIER: the Q>=50 CLIFF becomes A/B/C grades. A+B surface (more
           signals, each wearing its grade); C stays hidden. UNTRAINED
           (<60 examples) falls back to the exact old behavior -- the Brain
           never gates on knowledge it does not have. */
    try{if(window.Brain&&SS.resolvedStrat){
      var _bctx=window.brainCtx?window.brainCtx():{};_bctx.strat=SS.resolvedStrat;
      Brain.learnBatch(SS.sigs,_bctx,CURSYM.sym+'|'+TF+'|'+SS.resolvedStrat);
      SS.sigs.forEach(function(_s){_s.brain=Brain.tier(_s,_bctx);});
      SS.brainN=Brain.state().n;
    }}catch(e){}
    if(SS.qOn){
      if(window.Brain&&Brain.state().trained){SS.sigs=SS.sigs.filter(function(_s){return !_s.brain||_s.brain.tier!=='C'});}
      else{SS.sigs=sigFilterQ(SS.sigs,50);}
    }
    try{sigStack(DATA,SS.sigs,SS.resolvedStrat);SS.stackStats=sigStackStats(SS.sigs);SS.sessStats=sigSessStats(SS.sigs);}catch(e){}
    try{if(SS.oos&&SS._oosStats&&CURSYM)sigMemSave(CURSYM.sym,TF,SS.resolvedStrat,SS._oosStats)}catch(e){}
    SS.stats=SS.oos&&SS._oosStats?SS._oosStats:sigStats(SS.sigs);
    /* SIG5: live signal = a fresh open signal on one of the last 2 bars */
    var lv=SS.sigs[SS.sigs.length-1];
    if(lv&&lv.res==='open'&&DATA.length-1-lv.i<=2&&SS.lastLiveI!==lv.i){SS.lastLiveI=lv.i;
      var nm=window.SIG_STRATS[SS.resolvedStrat]?window.SIG_STRATS[SS.resolvedStrat].name:SS.resolvedStrat;
      toast((lv.dir===1?'\u25b2 LONG':'\u25bc SHORT')+' signal \u00b7 '+nm+' \u00b7 entry '+fmt(lv.entry)+' stop '+fmt(lv.stop)+' \u2014 plan card synced \u00b7 you decide',lv.dir===1?'var(--bull)':'var(--bear)');
      /* C5: registered sig-alerts -> service notify (Telegram) with the measured record */
      try{var _sa=JSON.parse(localStorage.getItem('mishel_sigalerts')||'[]');
        if(_sa.some(function(a){return a.sym===CURSYM.sym&&a.tf===TF})){
          var _st2=SS.stats||{};var _rec=_st2.winPct!=null?Math.round(_st2.winPct*100)+'% win \u00b7 avg '+(_st2.avgR>=0?'+':'')+(+_st2.avgR).toFixed(2)+'R ('+_st2.resolved+' res'+(SS.oos?', OOS':'')+')':'record building';
          var sb2=(typeof svcBase==='function'&&svcBase())||'http://127.0.0.1:8788';
          fetch(sb2+'/svc/notify',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'\u{1F4C8} SIGNAL '+(lv.dir===1?'LONG':'SHORT')+' '+CURSYM.sym+' '+TF+' \u00b7 '+nm+'\nentry '+fmt(lv.entry)+' \u00b7 stop '+fmt(lv.stop)+' \u00b7 T1 '+fmt(lv.t1)+'\nmeasured: '+_rec+'\nDecision support \u2014 you decide.'}),signal:AbortSignal.timeout(3000)}).catch(function(){});}}catch(e){}
      /* C7: remember the live setup so the plan card can offer "I took this" */
      window._liveSig={t:Date.now(),barT:DATA[lv.i].t,sym:CURSYM.sym,tf:TF,strat:SS.resolvedStrat,dir:lv.dir,entry:lv.entry,stop:lv.stop,t1:lv.t1,t2:lv.t2};
      try{if(lv.brain){window._liveSig.brain=lv.brain;window.brainPush&&window.brainPush(lv,lv.brain,CURSYM.sym,TF,SS.resolvedStrat);}}catch(e){}
      /* v39.6 Z7: the Brain gets a FACE. Tier badge + score + top-3 decomposition
         on the card the trader actually reads; untrained state says so in words. */
      try{var _el=document.getElementById('stratSignal');if(_el&&lv.brain){var _b=lv.brain;
        var _news=(window.brainCtx&&(window.brainCtx().newsMin!=null)&&window.brainCtx().newsMin<=30)?' <span style="color:var(--warn);font-weight:700" title="High-impact USD release within 30 minutes (macro desk calendar). News spikes through stops are the #2 FX account-killer; the Brain penalizes this window and so should you.">\u26a1NEWS</span>':'';
        var _line=_b.fallback
          ?'<div style="margin-top:5px;font-size:10px;color:var(--muted2)">Brain: '+(_b.n||0)+'/'+(_b.min||60)+' resolved examples \u2014 grading on the legacy Q-gate until trained. It learns as charts are scanned.</div>'
          :'<div style="margin-top:5px;font-size:10px"><span class="brain-tier '+_b.tier+'">'+_b.tier+'</span> <b class="mono">'+_b.score+'/100</b>'+(function(){
              /* v39.7 A6 -- Kelly-lite size HINT, info-only, arithmetic printed.
                 f* = 2p-1 at 1R symmetric; quarter-Kelly because full Kelly on an
                 estimated p is how accounts die. Never touches execution. */
              var p2=_b.score/100; var f=Math.max(0,(2*p2-1)/4);
              return f>0?' <span style="color:var(--muted2)" title="Kelly-lite: p='+p2.toFixed(2)+', 1R symmetric \u2192 f*=2p-1='+(2*p2-1).toFixed(2)+', quarter-Kelly \u2192 '+(f*100).toFixed(0)+'% of your max per-trade risk. INFO-ONLY \u2014 a printed suggestion, not an order.">size\u2248'+(f*100).toFixed(0)+'%R</span>':'';
            })()+' <span style="color:var(--muted2)">'
            +_b.parts.slice(0,3).map(function(_p){return _p.label+' '+(_p.v>0?'+':'')+Math.round(_p.v*100)}).join(' \u00b7 ')
            +'</span>'+_news+'</div>';
        var _old=_el.querySelector('.brainline');if(_old)_old.remove();
        var _d=document.createElement('div');_d.className='brainline';_d.innerHTML=_line;_el.appendChild(_d);}}catch(e){}
      try{if(window.renderCockpit)window.renderCockpit()}catch(e){}}
    try{draw()}catch(e){}
  }catch(e){}};
  var sgs=document.getElementById('sigSel');
  if(sgs)sgs.onchange=function(){var v=sgs.value;sgs.value='';
    if(!v)return;
    if(v==='off'){window._sigState.on=false;try{draw()}catch(e){}toast('signals off','var(--muted)');return}
    window._sigState.on=true;window._sigState.strat=v;window._sigState.lastLiveI=null;window.sigRefresh();
    var d2=window.SIG_STRATS[v];toast('SIG on \u00b7 '+(v==='auto'?'best measured strategy':d2.name+' \u2014 '+d2.desc),'var(--accent,#5B8DEF)');};
  var sqb=document.getElementById('sigQBtn');
  if(sqb){window._sigState.qOn=true;sqb.classList.add('on');
    sqb.onclick=function(){window._sigState.qOn=!window._sigState.qOn;sqb.classList.toggle('on',window._sigState.qOn);
      toast(window._sigState.qOn?'quality gate ON \u2014 only \u226550/100 setups (trend+momentum+vol aligned)':'quality gate OFF \u2014 all raw signals shown','var(--accent,#5B8DEF)');
      window.sigRefresh();};}
  setInterval(function(){try{if(window._sigState.on)window.sigRefresh()}catch(e){}},15000);
  var cb=document.getElementById('cmpBtn');
  if(cb)cb.onclick=function(){
    if(window._cmp){window._cmp=null;cb.classList.remove('on');try{draw()}catch(e){}return}
    var syms={};try{Object.keys(BAR_CACHE||{}).forEach(function(k){var p2=k.split('|');if(p2[1]===TF&&p2[0]!==CURSYM.sym)syms[p2[0]]=k})}catch(e){}
    var list=Object.keys(syms);
    var pick=prompt('Compare with which symbol? (loaded this session on '+TF+'):\n'+(list.length?list.join(' \u00b7 '):'\u2014 none cached: open another symbol on this TF once, then come back')+'\n\nType the symbol:');
    if(!pick)return;pick=pick.trim().toUpperCase();
    var key=syms[pick]||(pick+'|'+TF);
    window._cmp={sym:pick,key:key};cb.classList.add('on');try{draw()}catch(e){}};
})();

