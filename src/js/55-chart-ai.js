(function(){try{
  var ih=document.getElementById('instHead');if(!ih||!ih.parentElement)return;
  var bar=document.createElement('div');bar.id='wsTabs';ih.parentElement.insertBefore(bar,ih);
  var TABS=[];try{TABS=JSON.parse(localStorage.getItem('mishel_tabs')||'[]')}catch(e){}
  if(!TABS.length)TABS=[{s:'BTCUSD',tf:'1h'}];
  var cur=0;
  function save(){try{localStorage.setItem('mishel_tabs',JSON.stringify(TABS))}catch(e){}}
  function render(){
    /* v32.1 F2 ROOT-CAUSE FIX: the compact-mode instrument header lives inside this bar;
       innerHTML rebuilds were DESTROYING it seconds after boot (the vanishing price/ATR chips).
       Detach the live node first, rebuild, re-append. */
    var _ih=document.getElementById('instHead');if(_ih&&_ih.parentElement===bar){window._ihNode=_ih;_ih.remove()}
    bar.innerHTML=TABS.map(function(t,i){return '<div class="wtab'+(i===cur?' on':'')+'" data-i="'+i+'">'+t.s.replace('USD','')+' \u00b7 '+t.tf.toUpperCase()+(TABS.length>1?' <span class="x" data-x="'+i+'">\u00d7</span>':'')+'</div>'}).join('')
      +'<button id="wtAdd" title="New chart tab">+</button>';
    if(window._ihNode&&document.body.classList.contains('compact'))bar.appendChild(window._ihNode);
    bar.querySelectorAll('.wtab').forEach(function(el){el.onclick=function(e){
      if(e.target.dataset.x!=null){var xi=+e.target.dataset.x;TABS.splice(xi,1);if(cur>=TABS.length)cur=TABS.length-1;save();apply();return}
      cur=+el.dataset.i;apply();};});
    document.getElementById('wtAdd').onclick=function(){TABS.push({s:CURSYM.sym,tf:TF});cur=TABS.length-1;save();render();};
  }
  function apply(){var t=TABS[cur];if(!t)return;render();
    try{if(CURSYM.sym!==t.s)loadSymbolName(t.s)}catch(e){}
    try{if(TF!==t.tf){var b=document.querySelector('#tfBar button[data-tf="'+t.tf+'"]');if(b)b.click()}}catch(e){}}
  setInterval(function(){try{var t=TABS[cur];if(t&&(t.s!==CURSYM.sym||t.tf!==TF)){t.s=CURSYM.sym;t.tf=TF;save();render()}}catch(e){}},2500);
  render();
}catch(e){}})();

(function(){try{
  var side=document.getElementById('side');
  if(side){var jump=document.createElement('div');jump.id='sideJump';
    var MAP=[['Verdict','.side .card'],['Scout','#scoutCard'],['Plan','#planOut'],['Drivers','#confRows'],['Sizer','#cSub']];
    jump.innerHTML=MAP.map(function(m){return '<span class="sj" data-t="'+m[1]+'">'+m[0]+'</span>'}).join('');
    side.insertBefore(jump,side.firstChild);
    jump.querySelectorAll('.sj').forEach(function(el){el.onclick=function(){var t=document.querySelector(el.dataset.t);if(t)(t.closest('.card')||t).scrollIntoView({behavior:'smooth',block:'start'})};});}
  var hc=document.createElement('div');hc.id='hovCard';hc.innerHTML='<div class="hs"></div><div class="hl"></div><canvas width="204" height="44" style="margin-top:7px"></canvas>';
  document.body.appendChild(hc);var hT=null;
  document.addEventListener('mouseover',function(e){
    var row=e.target.closest&&e.target.closest('[data-s]');if(!row){clearTimeout(hT);hc.style.display='none';return}
    clearTimeout(hT);hT=setTimeout(function(){try{
      var sym=row.dataset.s;var d=null;for(var k in BAR_CACHE){if(k.indexOf(sym+'|')===0&&BAR_CACHE[k].length>40){d=BAR_CACHE[k].slice(-80);break}}
      if(!d)d=genData(80,(SPECS[sym]||{px:100}).px,(sym.charCodeAt(0)+sym.length)*13+7);
      var con=consensusSignal(d);
      hc.querySelector('.hs').textContent=sym+'  '+fmt(d[d.length-1].c);
      var hl=hc.querySelector('.hl');hl.textContent=con.label+' \u00b7 '+(con.score>=0?'+':'')+con.score+' \u00b7 '+con.confidence+'% agree';hl.className='hl '+(con.score>=0?'u':'d');
      var g=hc.querySelector('canvas').getContext('2d');g.clearRect(0,0,204,44);
      var lo=Math.min.apply(null,d.map(function(x){return x.c})),hi=Math.max.apply(null,d.map(function(x){return x.c}));
      g.strokeStyle=d[d.length-1].c>=d[0].c?'#2DBE8E':'#F0616D';g.lineWidth=1.4;g.beginPath();
      d.forEach(function(x,i){var X=i/(d.length-1)*200+2,Y=40-((x.c-lo)/((hi-lo)||1))*36+2;i?g.lineTo(X,Y):g.moveTo(X,Y)});g.stroke();
      var r=row.getBoundingClientRect();hc.style.left=Math.min(innerWidth-245,r.left-240>0?r.left-240:r.right+10)+'px';
      hc.style.top=Math.min(innerHeight-130,r.top)+'px';hc.style.display='block';
    }catch(e2){}},160);});
  var ts=document.getElementById('themeSel');if(ts&&!ts.querySelector('option[value="oled"]')){var o=document.createElement('option');o.value='oled';o.textContent='OLED (true black)';ts.appendChild(o);}
}catch(e){}})();

/* ================= v9.0 CHART+AI ================= */
(function(){try{
  var db=document.getElementById('drawbar');if(!db||typeof priceAt!=='function')return;
  var b=document.createElement('button');b.className='mag';b.title='Magnet: snap drawings to O/H/L/C';
  b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 3h4v5H6zM14 3h4v5h-4z" fill="currentColor" stroke="none"/></svg>';
  db.insertBefore(b,db.querySelector('#drawUndo'));
  window.MAGNET=false;b.onclick=function(){window.MAGNET=!window.MAGNET;b.classList.toggle('on',window.MAGNET);toast('Magnet '+(window.MAGNET?'ON: drawings snap to OHLC':'off'))};
  var _pa=priceAt;priceAt=function(sy){var p=_pa(sy);try{
    if(!window.MAGNET||!RENDER||!MOUSE||TOOL==='cursor')return p;
    var gi=RENDER.start+Math.floor(MOUSE.x/RENDER.cw);var c=DATA[gi];if(!c)return p;
    var best=p,bd=Math.abs(p)*0.0035;[c.o,c.h,c.l,c.c].forEach(function(v){var d2=Math.abs(v-p);if(d2<bd){bd=d2;best=v}});
    return best;}catch(e){return p}};
}catch(e){}})();

(function(){try{
  var _d5=draw;draw=function(){_d5();try{
    if(!RENDER||!ON.has('sessvp'))return;var g=cv.getContext('2d');
    var st2=RENDER.start,cw2=RENDER.cw,W2=RENDER.W,pr2=RENDER.padR,ph2=RENDER.priceH;
    var Y=function(p){var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*ph2};
    var end2=Math.min(DATA.length,st2+Math.ceil((W2-pr2)/cw2)+1);
    var SES=[['ASIA',0,9,'rgba(76,130,251,'],['LDN',8,17,'rgba(232,163,61,'],['NY',13,22,'rgba(45,190,142,']];
    var bins=36;g.save();g.beginPath();g.rect(0,0,W2-pr2,ph2);g.clip();
    SES.forEach(function(S2,si){var B=new Array(bins).fill(0),tot=0;
      for(var i=st2;i<end2;i++){var c=DATA[i];if(!c)continue;var h=new Date(c.t).getUTCHours();if(!(h>=S2[1]&&h<S2[2]))continue;
        var bi=Math.min(bins-1,Math.max(0,Math.floor((c.c-RENDER.lo)/((RENDER.hi-RENDER.lo)||1)*bins)));B[bi]+=(c.v||1);tot+=(c.v||1);}
      if(!tot)return;var mx=Math.max.apply(null,B)||1,poc=0;for(var b2=1;b2<bins;b2++)if(B[b2]>B[poc])poc=b2;
      var x0=si*34;
      for(var b3=0;b3<bins;b3++){var pv=RENDER.lo+(b3+0.5)/bins*(RENDER.hi-RENDER.lo);var yy=Y(pv);
        g.fillStyle=S2[3]+'0.18)';g.fillRect(x0,yy-(ph2/bins)*0.4,B[b3]/mx*30,(ph2/bins)*0.8);}
      var pocP=RENDER.lo+(poc+0.5)/bins*(RENDER.hi-RENDER.lo),py=Y(pocP);
      g.strokeStyle=S2[3]+'0.85)';g.setLineDash([3,3]);g.beginPath();g.moveTo(x0,py);g.lineTo(W2-pr2,py);g.stroke();g.setLineDash([]);
      g.fillStyle=S2[3]+'0.95)';g.font='8.5px JetBrains Mono';g.textAlign='left';g.fillText(S2[0]+' POC '+fmt(pocP),x0+2,py-4);});
    g.restore();
  }catch(e){}};
  var body=document.getElementById('indPanelBody');
  if(body){var host=body.querySelector('.tcat');
    var ch=document.createElement('div');ch.className='chip';ch.dataset.ind='sessvp';ch.style.cssText='--k:#4C82FB';ch.innerHTML='<span class="sw"></span>Session Profiles (POC)';
    if(host)host.appendChild(ch);
    ch.onclick=function(e){e.stopPropagation();if(ON.has('sessvp'))ON.delete('sessvp');else ON.add('sessvp');ch.classList.toggle('on',ON.has('sessvp'));
      var ic=document.getElementById('indCount');if(ic)ic.textContent='('+ON.size+' on)';try{draw()}catch(_){}};}
}catch(e){}})();

(function(){try{
  var _d6=draw;draw=function(){_d6();try{
    if(!RENDER||!CON_HIST||!CON_HIST.pts||CON_HIST.pts.length<6)return;
    var pts=CON_HIST.pts,flipT=null,flipS=0;
    for(var i=pts.length-1;i>0;i--){if(Math.sign(pts[i].s)!==Math.sign(pts[i-1].s)&&Math.sign(pts[i].s)!==0){flipT=pts[i].t;flipS=pts[i].s;break}}
    if(!flipT)return;var gi=-1;for(var j=DATA.length-1;j>=0;j--){if(DATA[j].t===flipT){gi=j;break}}
    if(gi<RENDER.start)return;
    var g=cv.getContext('2d');var xx=(gi-RENDER.start)*RENDER.cw+RENDER.cw/2;
    g.strokeStyle=flipS>=0?'rgba(45,190,142,.5)':'rgba(240,97,109,.5)';g.setLineDash([2,4]);g.beginPath();g.moveTo(xx,14);g.lineTo(xx,RENDER.priceH);g.stroke();g.setLineDash([]);
    g.fillStyle=flipS>=0?'rgba(45,190,142,.95)':'rgba(240,97,109,.95)';g.font='8.5px JetBrains Mono';g.textAlign='center';
    g.fillText('read flipped '+(flipS>=0?'\u25b2':'\u25bc')+' ('+(DATA.length-1-gi)+' bars ago)',Math.min(Math.max(xx,80),RENDER.W-RENDER.padR-80),10);
  }catch(e){}};
}catch(e){}})();

(function(){try{
  window.POSTM=[];
  if(typeof paperClose!=='function')return;
  var _pc2=paperClose;paperClose=function(id,why){
    var p=PAPER.pos.find(function(x){return x.id===id});var px=curPrice();
    _pc2(id,why);
    try{if(!p||!p._ctx)return;
      var t0=p._ctx.t,mfe=0,mae=0;
      for(var i=DATA.length-1;i>=0;i--){var c=DATA[i];if(c.t<t0)break;
        var fav=p.side>0?(c.h-p.entry):(p.entry-c.l);var adv=p.side>0?(p.entry-c.l):(c.h-p.entry);
        mfe=Math.max(mfe,fav);mae=Math.max(mae,adv);}
      var pl=(px-p.entry)*p.side*p.qty;var capture=mfe>0?Math.max(0,Math.min(150,pl/(mfe*p.qty)*100)):null;
      var risk=Math.abs(p.entry-(p.sl!=null?p.sl:p.entry))||p.entry*0.01;
      var bits=[];
      if(capture!=null&&capture<45&&pl>=0)bits.push('you banked only '+capture.toFixed(0)+'% of the max favorable move: exits are the leak');
      if(capture!=null&&capture>=70)bits.push('excellent exit: captured '+capture.toFixed(0)+'% of the move');
      if(mae>risk*0.9&&pl>0)bits.push('it nearly stopped out first (MAE '+(mae/risk).toFixed(1)+'x risk): the win was luckier than it felt');
      if(pl<0&&mfe>risk*1.2)bits.push('price paid '+(mfe/risk).toFixed(1)+'R in your favor before losing: a partial-TP rule would have saved this');
      if(!bits.length)bits.push(pl>=0?'clean execution':'plan simply did not work: that is trading, not a mistake');
      var pm={t:Date.now(),sym:p.sym,pl:pl,mfeR:+(mfe/risk).toFixed(2),maeR:+(mae/risk).toFixed(2),capture:capture!=null?Math.round(capture):null,note:bits[0]};
      POSTM.push(pm);if(POSTM.length>60)POSTM.shift();
      renderPostmortem();
      toast('Post-mortem: '+pm.note,pl>=0?'var(--bull)':'var(--gold)');
    }catch(e){}
  };
  window.renderPostmortem=function(){try{
    var host=document.getElementById('journalStats');if(!host)return;
    var box=document.getElementById('pmBox');
    if(!box){box=document.createElement('div');box.id='pmBox';host.parentElement.appendChild(box);}
    if(!POSTM.length){box.innerHTML='<span style="font-size:10px;letter-spacing:.08em;color:var(--muted2)">AI POST-MORTEM</span><br>Close a trade and I will grade the execution (MFE/MAE, capture %).';return}
    var last=POSTM[POSTM.length-1];
    var caps=POSTM.filter(function(x){return x.capture!=null});
    var avgCap=caps.length?caps.reduce(function(a,x){return a+x.capture},0)/caps.length:null;
    box.innerHTML='<span style="font-size:10px;letter-spacing:.08em;color:var(--muted2)">AI POST-MORTEM ('+POSTM.length+')</span><br>'
      +'<b>'+last.sym+'</b> '+(last.pl>=0?'+':'')+last.pl.toFixed(2)+' \u00b7 MFE '+last.mfeR+'R \u00b7 MAE '+last.maeR+'R'+(last.capture!=null?' \u00b7 captured <b>'+last.capture+'%</b>':'')
      +'<br>'+last.note+(POSTM.length>=5&&avgCap!=null?'<br>avg capture over '+POSTM.length+' trades: <b>'+avgCap.toFixed(0)+'%</b>'+(avgCap<50?' (systematic exit leak)':''):'');
  }catch(e){}};
  setTimeout(renderPostmortem,2000);
}catch(e){}})();

