/* ================= v13.5 #2 BYBIT DEPTH LADDER (real L2 order book, crypto only) ================= */
(function(){try{
  var ws=null,cur=null,tape=[],lastBids=[],lastAsks=[],lastBook={b:{},a:{}},imbHist=[],wallHist={},cvdSeries=[],midSeries=[],whaleLog=[],smEvents=[],sweepBuf=[],prevWalls={},midWin=[],smPending=[],smStats={},_lastRead=0;
  function bybitSym(){try{var sp=SPECS[CURSYM.sym];if(!sp)return null;
    if(sp.cls==='crypto')return CURSYM.sym.replace(/USD$/,'USDT');
    if(sp.cls==='cryptofut')return CURSYM.sym.replace(/PERP$/,'USDT');return null}catch(e){return null}}
  function ensureUI(){var host=document.querySelector('#v-orderflow .pad')||document.getElementById('v-orderflow');if(!host)return;
    if(document.getElementById('l2Panel'))return;
    var p=document.createElement('div');p.className='panelbox';p.id='l2Panel';
    p.innerHTML='<h4>Live Depth Ladder \u00b7 Bybit L2 <span class="tag" title="Real order book via Bybit public WebSocket. Crypto only \u2014 forex/metals L2 needs a paid institutional feed and is never simulated here.">REAL WS</span></h4>'
      +'<div id="l2Status" style="font-size:11px;color:var(--muted);margin-bottom:8px"></div>'
      +'<div id="l2Read" style="margin:6px 0 10px;padding:9px 11px;border:1px solid var(--edge);border-radius:7px;background:color-mix(in srgb,var(--panel2) 60%,transparent)"></div>'
      +'<div id="l2Analytics" style="margin:0 0 10px;display:grid;grid-template-columns:1fr 1fr;gap:8px"></div>'
      +'<div id="l2SmartHdr" style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:var(--accent);letter-spacing:.06em;font-weight:800;margin:2px 0 6px"><span>SMART-MONEY FLOW DETECTOR — heuristic, from public L2</span><label style="font-weight:400;color:var(--muted);letter-spacing:0;cursor:pointer"><input type="checkbox" id="smAlertsOn"> alert me</label></div>'
      +'<div id="l2Synth" style="margin:0 0 8px;padding:9px 12px;border:1px solid var(--accent);border-radius:8px;background:color-mix(in srgb,var(--accent) 8%,transparent)"></div>'
      +'<div id="l2Smart" style="margin:0 0 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px"></div>'
      +'<div id="l2Receipts" style="margin:0 0 12px"></div>'
      +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div id="l2Bids"></div><div id="l2Asks"></div></div>'
      +'<div style="font-size:9px;color:var(--muted2);margin:8px 0 4px;letter-spacing:.08em">RECENT TRADES</div>'
      +'<div id="l2Tape" style="font-family:var(--mono);font-size:10.5px;max-height:120px;overflow:hidden"></div>';
    host.insertBefore(p,host.firstChild);}
  function row(px,sz,mx,side){var w=Math.min(100,sz/mx*100);
    return '<div style="position:relative;display:flex;justify-content:space-between;padding:2px 6px;font-family:var(--mono);font-size:10.5px">'
      +'<i style="position:absolute;top:0;bottom:0;'+(side>0?'right:0':'left:0')+';width:'+w.toFixed(1)+'%;background:'+(side>0?'rgba(45,190,142,.13)':'rgba(240,97,109,.13)')+'"></i>'
      +'<span style="position:relative;color:'+(side>0?'var(--bull)':'var(--bear)')+'">'+px+'</span><span style="position:relative">'+sz+'</span></div>'}
  function stop(){if(ws){try{ws.onclose=null;ws.close()}catch(e){}ws=null}}
  function start(){var bs=bybitSym();var st=document.getElementById('l2Status');
    if(!bs){if(st)st.innerHTML='<span style="color:var(--gold)">L2 depth is crypto-only. Load a crypto symbol \u2014 forex/metals order-book data requires a paid feed and is never simulated.</span>';stop();cur=null;return}
    if(cur===bs&&ws&&ws.readyState===1)return;stop();cur=bs;
    if(st)st.textContent='connecting '+bs+'\u2026';
    try{ws=new WebSocket('wss://stream.bybit.com/v5/public/spot')}catch(e){if(st)st.textContent='WebSocket blocked by browser/network';return}
    var book={b:{},a:{}};
    ws.onopen=function(){try{ws.send(JSON.stringify({op:'subscribe',args:['orderbook.50.'+bs,'publicTrade.'+bs]}))}catch(e){}};
    ws.onmessage=function(ev){try{var m=JSON.parse(ev.data);
      if(m.topic&&m.topic.indexOf('orderbook')===0){var d=m.data||{};
        if(m.type==='snapshot'){book={b:{},a:{}}}
        (d.b||[]).forEach(function(x){if(+x[1]===0)delete book.b[x[0]];else book.b[x[0]]=+x[1]});
        (d.a||[]).forEach(function(x){if(+x[1]===0)delete book.a[x[0]];else book.a[x[0]]=+x[1]});
        var bids=Object.keys(book.b).map(Number).sort(function(a,b){return b-a}).slice(0,12);
        var asks=Object.keys(book.a).map(Number).sort(function(a,b){return a-b}).slice(0,12);
        if(!bids.length||!asks.length)return;
        var mx=1;bids.forEach(function(p){mx=Math.max(mx,book.b[p])});asks.forEach(function(p){mx=Math.max(mx,book.a[p])});
        if(st)st.innerHTML=bs+' \u00b7 spread <b>'+(asks[0]-bids[0]).toFixed(asks[0]-bids[0]<1?4:2)+'</b> \u00b7 live L2';
        var eb=document.getElementById('l2Bids'),ea=document.getElementById('l2Asks');
        if(eb)eb.innerHTML='<div style="font-size:9px;color:var(--muted2);padding:0 6px 3px">BIDS</div>'+bids.map(function(p){return row(p,book.b[p],mx,1)}).join('');
        if(ea)ea.innerHTML='<div style="font-size:9px;color:var(--muted2);padding:0 6px 3px">ASKS</div>'+asks.map(function(p){return row(p,book.a[p],mx,-1)}).join('');
        lastBids=bids;lastAsks=asks;lastBook=book;try{renderRead()}catch(e){}}
      else if(m.topic&&m.topic.indexOf('publicTrade')===0){
        (m.data||[]).forEach(function(t){tape.push({s:t.S,v:+t.v||0,p:+t.p||0,t:Date.now()})}); if(tape.length>800)tape=tape.slice(-800); try{detectTape(m.data)}catch(e){} try{renderRead()}catch(e){}
        var el=document.getElementById('l2Tape');if(!el)return;
        var _vs=tape.map(function(x){return x.v}).sort(function(a,b){return a-b}), _big=_vs[Math.floor(_vs.length*0.93)]||1e18;
        (m.data||[]).slice(0,6).forEach(function(t){var dd=document.createElement('div'); var large=(+t.v)>=_big&&(+t.v)>0;
          dd.style.cssText='display:flex;justify-content:space-between;padding:1px 6px;color:'+(t.S==='Buy'?'var(--bull)':'var(--bear)')+(large?';font-weight:800;background:'+(t.S==='Buy'?'var(--bull-dim)':'var(--bear-dim)'):'');
          dd.textContent=(large?'\u25c9 ':(t.S==='Buy'?'\u25b2 ':'\u25bc '))+(+t.p)+'  '+(+t.v);el.insertBefore(dd,el.firstChild)});
        while(el.children.length>18)el.removeChild(el.lastChild);}
    }catch(e){}};
    ws.onclose=function(){if(st)st.textContent='disconnected \u2014 reopen the view to reconnect'};}

  function nfmt(x){ x=+x; return x>=1000?x.toLocaleString('en-US',{maximumFractionDigits:1}):x.toFixed(x<1?4:2); }
  function takerFlow(){ var now=Date.now(),bv=0,sv=0; for(var i=tape.length-1;i>=0;i--){ if(now-tape[i].t>60000)break; if(tape[i].s==='Buy')bv+=tape[i].v; else sv+=tape[i].v; } return {bv:bv,sv:sv}; }
  function cell(k,v){ return '<div><span style="color:var(--muted2)">'+k+'</span> '+v+'</div>'; }
  function renderRead(){
    var el=document.getElementById('l2Read'); if(!el) return;
    var _now=Date.now(); if(_now-_lastRead<180)return; _lastRead=_now;   /* v39.29 perf: derived analytics at ~5Hz, not on every WS frame */
    var bids=lastBids,asks=lastAsks,book=lastBook;
    if(!bids.length||!asks.length){ el.innerHTML='<span style="color:var(--muted2)">waiting for book\u2026</span>'; return; }
    var N=10,bidVol=0,askVol=0;
    bids.slice(0,N).forEach(function(px){bidVol+=book.b[px]||0}); asks.slice(0,N).forEach(function(px){askVol+=book.a[px]||0});
    var tot=bidVol+askVol||1, imb=bidVol/tot;
    imbHist.push(imb); if(imbHist.length>48)imbHist.shift();                       /* 0..1 share of near depth on the bid */
    var lean=imb>0.58?'BULLISH':imb<0.42?'BEARISH':'BALANCED', lcls=imb>0.58?'up':imb<0.42?'dn':'';
    var strength=Math.abs(imb-0.5)*2, sTxt=strength>0.4?'strong':strength>0.2?'moderate':'slight';
    /* liquidity walls */
    var bWall=bids[0],aWall=asks[0]; bids.forEach(function(px){if((book.b[px]||0)>(book.b[bWall]||0))bWall=px}); asks.forEach(function(px){if((book.a[px]||0)>(book.a[aWall]||0))aWall=px});
    /* taker flow (aggressor volume, last 60s) */
    var tf=takerFlow(), ttot=tf.bv+tf.sv, tbuy=ttot?tf.bv/ttot:0.5;
    var takTxt=ttot?(tbuy>0.58?'buyers lifting offers':tbuy<0.42?'sellers hitting bids':'two-way'):'\u2014';
    /* combined short-term lean: book 60% + taker 40% */
    var blend=imb*0.6+tbuy*0.4, comb=blend>0.56?'lean UP':blend<0.44?'lean DOWN':'no clear lean', ccls=blend>0.56?'up':blend<0.44?'dn':'';
    var cvd=0,cvdPrev=0;
    for(var ci=0;ci<tape.length;ci++){ cvd+=(tape[ci].s==='Buy'?tape[ci].v:-tape[ci].v); if(ci<tape.length-40)cvdPrev=cvd; }
    var cvdUp=cvd>=cvdPrev;
    var absTxt='', last30=tape.slice(-30);
    if(last30.length>8){ var pc=(last30[last30.length-1].p||0)-(last30[0].p||0), agV=0, agBuy=0;
      last30.forEach(function(t){agV+=t.v; if(t.s==='Buy')agBuy+=t.v;}); var side=agBuy/(agV||1);
      var mid=(lastBids[0]+lastAsks[0])/2||1, moved=Math.abs(pc)/mid;
      if(agV>0 && moved<0.0004){ if(side>0.62)absTxt='buyers being absorbed (sellers defending)'; else if(side<0.38)absTxt='sellers being absorbed (buyers defending)'; } }
    try{ window._ofRead={imbalance:imb, taker_buy:(ttot?tbuy:null), lean:comb, spread:(asks[0]-bids[0]), cvd:cvd, cvdUp:cvdUp, absorption:(absTxt||null)}; }catch(e){}
    var spark='';
    if(imbHist.length>3){ var _W=150,_H=26,_n=imbHist.length,
      _pts=imbHist.map(function(v,i){return (i/(_n-1)*_W).toFixed(1)+','+((1-v)*_H).toFixed(1)}).join(' '),
      _up=imbHist[_n-1]>=imbHist[0];
      spark='<div style="margin-top:8px"><div style="font-size:9px;color:var(--muted2);letter-spacing:.06em;margin-bottom:2px">IMBALANCE TREND (bid depth share, last '+_n+' updates)</div>'
        +'<svg width="'+_W+'" height="'+_H+'" style="display:block"><line x1="0" y1="'+(_H/2)+'" x2="'+_W+'" y2="'+(_H/2)+'" stroke="var(--edge2)" stroke-width="1" stroke-dasharray="2 2"/><polyline points="'+_pts+'" fill="none" stroke="'+(_up?'var(--bull)':'var(--bear)')+'" stroke-width="1.5" stroke-linejoin="round"/></svg></div>'; }
    el.innerHTML=
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px 18px;font-size:11px;font-family:var(--mono)">'
      +cell('book pressure','<b class="'+lcls+'">'+lean+'</b> \u00b7 '+sTxt+' ('+Math.round(imb*100)+'% bid depth)')
      +cell('short-term lean','<b class="'+ccls+'">'+comb+'</b>')
      +cell('taker flow 60s', ttot?('<b class="'+(tbuy>0.55?'up':tbuy<0.45?'dn':'')+'">'+Math.round(tbuy*100)+'% buy</b> \u00b7 '+takTxt):'\u2014')
      +cell('near spread','<b>'+nfmt(asks[0]-bids[0])+'</b>')
      +cell('bid wall (support)','<b class="up">'+nfmt(bWall)+'</b> \u00b7 '+(book.b[bWall]||0).toFixed(2))
      +cell('ask wall (resistance)','<b class="dn">'+nfmt(aWall)+'</b> \u00b7 '+(book.a[aWall]||0).toFixed(2))
      +cell('CVD (buy\u2212sell)','<b class="'+(cvdUp?'up':'dn')+'">'+(cvd>=0?'+':'')+cvd.toFixed(2)+'</b> '+(cvdUp?'\u25b2':'\u25bc'))
      +(absTxt?cell('absorption','<b class="'+(absTxt.indexOf('buyers being')===0?'dn':'up')+'">'+absTxt+'</b>'):'')
      +'</div>'
      +spark
      +'<div style="font-size:9px;color:var(--muted2);margin-top:6px;line-height:1.4">Order-book pressure & aggressor flow \u2014 a short-term lean from who is stacked and who is hitting the market, NOT a price prediction. Depth can pull or refill in an instant; treat walls as intentions, not guarantees.</div>';
    try{ofAnalytics()}catch(e){} try{detectBook(lastBids,lastAsks,lastBook);smResolve();renderSmart();renderReceipts()}catch(e){}
  }
  function _card2(t,b){ return '<div style="padding:8px 10px;border:1px solid var(--edge);border-radius:7px;background:color-mix(in srgb,var(--panel2) 40%,transparent)"><div style="font-size:9px;color:var(--muted2);letter-spacing:.06em;margin-bottom:4px">'+t+'</div>'+b+'</div>'; }
  function ofAnalytics(){
    var el=document.getElementById('l2Analytics'); if(!el) return;
    var bids=lastBids,asks=lastAsks,book=lastBook; if(!bids.length||!asks.length){el.innerHTML='';return;}
    var mid=(bids[0]+asks[0])/2;
    midSeries.push(mid); if(midSeries.length>120)midSeries.shift();
    var cvd=(window._ofRead&&window._ofRead.cvd)||0; cvdSeries.push(cvd); if(cvdSeries.length>120)cvdSeries.shift();
    /* #4 liquidity map: EWMA of large resting size per price level */
    var allSz=bids.map(function(px){return book.b[px]||0}).concat(asks.map(function(px){return book.a[px]||0}));
    var med=allSz.slice().sort(function(a,b){return a-b})[Math.floor(allSz.length/2)]||0;
    bids.forEach(function(px){var sz=book.b[px]||0; if(sz>med*2){var k='b'+px; wallHist[k]={px:px,side:'bid',v:((wallHist[k]&&wallHist[k].v)||0)*0.9+sz*0.1};}});
    asks.forEach(function(px){var sz=book.a[px]||0; if(sz>med*2){var k='a'+px; wallHist[k]={px:px,side:'ask',v:((wallHist[k]&&wallHist[k].v)||0)*0.9+sz*0.1};}});
    var zones=[]; for(var k in wallHist){ wallHist[k].v*=0.995; if(wallHist[k].v<Math.max(med*0.5,1e-9)){delete wallHist[k];continue;} zones.push(wallHist[k]); }
    zones.sort(function(a,b){return b.v-a.v}); zones=zones.slice(0,4);
    var zHtml=zones.length?zones.map(function(z){return '<div style="font-size:10px"><b class="'+(z.side==='bid'?'up':'dn')+'">'+nfmt(z.px)+'</b> <span style="color:var(--muted2)">'+z.side+' \u00b7 '+z.v.toFixed(2)+'</span></div>'}).join(''):'<div style="color:var(--muted2);font-size:10px">building\u2026</div>';
    /* #7 book-walk: size to move price +/-0.1% */
    function walk(side,dir){ var tgt=mid*(1+dir*0.001),sum=0,arr=side==='ask'?asks:bids; for(var i=0;i<arr.length;i++){var px=arr[i]; if(dir>0?px<=tgt:px>=tgt)sum+=(side==='ask'?book.a[px]:book.b[px])||0;} return sum; }
    var upSize=walk('ask',1),dnSize=walk('bid',-1), lean=(upSize&&dnSize)?(dnSize>upSize*1.15?'easier UP \u2014 asks thin':upSize>dnSize*1.15?'easier DOWN \u2014 bids thin':'balanced walls'):'';
    /* #5 CVD divergence */
    var div;
    if(midSeries.length>20&&cvdSeries.length>20){ var h=Math.floor(midSeries.length/2),
      pMxA=Math.max.apply(null,midSeries.slice(0,h)),pMxB=Math.max.apply(null,midSeries.slice(h)),cMxA=Math.max.apply(null,cvdSeries.slice(0,h)),cMxB=Math.max.apply(null,cvdSeries.slice(h)),
      pMnA=Math.min.apply(null,midSeries.slice(0,h)),pMnB=Math.min.apply(null,midSeries.slice(h)),cMnA=Math.min.apply(null,cvdSeries.slice(0,h)),cMnB=Math.min.apply(null,cvdSeries.slice(h));
      if(pMxB>pMxA&&cMxB<cMxA) div='<b class="dn">BEARISH divergence</b> \u2014 price higher, delta lower (distribution)';
      else if(pMnB<pMnA&&cMnB>cMnA) div='<b class="up">BULLISH divergence</b> \u2014 price lower, delta higher (absorption)';
      else div='<span style="color:var(--muted2)">none \u2014 price & delta agree</span>'; }
    else div='<span style="color:var(--muted2)">gathering\u2026</span>';
    /* #6 positioning */
    var fr=window._fundRate,oi=window._oi,ls=window._lsRatio,pos=[];
    if(fr!=null&&isFinite(fr)) pos.push('funding <b class="'+(fr>0?'dn':'up')+'">'+(+fr).toFixed(3)+'%</b> '+(fr>0?'(longs pay)':'(shorts pay)'));
    if(oi!=null&&isFinite(oi)) pos.push('OI <b>'+nfmt(oi)+'</b>');
    if(ls!=null&&isFinite(ls)) pos.push('L/S <b>'+(+ls).toFixed(2)+'</b>');
    var posHtml=pos.length?pos.join(' \u00b7 '):'<span style="color:var(--muted2)">funding/OI feed not connected</span>';
    el.innerHTML=_card2('LIQUIDITY MAP (persistent walls)',zHtml)
      +_card2('BOOK-WALK (\u00b10.1%)','<div style="font-size:10px">to move <b class="up">UP</b> '+upSize.toFixed(2)+' \u00b7 <b class="dn">DOWN</b> '+dnSize.toFixed(2)+'</div>'+(lean?'<div style="font-size:9px;color:var(--muted2);margin-top:2px">'+lean+'</div>':''))
      +_card2('CVD DIVERGENCE','<div style="font-size:10px;line-height:1.4">'+div+'</div>')
      +_card2('POSITIONING','<div style="font-size:10px;line-height:1.4">'+posHtml+'</div>');
  }
  function smMid(){ return (lastBids.length&&lastAsks.length)?(lastBids[0]+lastAsks[0])/2:null; }
  function smLog(type,cls,note){ var l=smEvents[0]; if(l&&l.type===type&&Date.now()-l.t<2500)return; smEvents.unshift({t:Date.now(),type:type,cls:cls,note:note}); if(smEvents.length>12)smEvents.pop();
    if(window._smAlertsOn&&window.ALERT_LOG){ try{ window.ALERT_LOG.unshift({t:Date.now(),sym:(window.CURSYM&&CURSYM.sym)||'',desc:'\u26a1 '+type,val:note}); if(window.updateBell)updateBell(); if(typeof sendTG==='function')sendTG('\u26a1 '+type+' \u2014 '+note); }catch(e){} }
    if(cls==='up'||cls==='dn'){ var m=smMid(); if(m)smPending.push({type:type,cls:cls,px:m,t:Date.now()}); } }
  function smResolve(){ var m=smMid(); if(m==null)return; var now=Date.now(), spr=(lastAsks[0]-lastBids[0])||(m*1e-4), changed=false;
    smPending=smPending.filter(function(r){ if(now-r.t<30000)return true; var moved=m-r.px, hit=(r.cls==='up'&&moved>spr*2)||(r.cls==='dn'&&moved<-spr*2);
      var st=smStats[r.type]||(smStats[r.type]={h:0,n:0}); st.n++; if(hit)st.h++; changed=true; return false; });
    if(changed){ try{localStorage.setItem('iram_receipts_'+((window.CURSYM&&CURSYM.sym)||'x'),JSON.stringify(smStats))}catch(e){} } }
  function renderReceipts(){ var el=document.getElementById('l2Receipts'); if(!el)return;
    var _sym=(window.CURSYM&&CURSYM.sym)||'x'; if(window._receiptsSym!==_sym){ window._receiptsSym=_sym; try{smStats=JSON.parse(localStorage.getItem('iram_receipts_'+_sym)||'{}')||{}}catch(e){smStats={}} smPending=[]; }
    var rows=Object.keys(smStats).map(function(k){var st=smStats[k],r=st.n?Math.round(st.h/st.n*100):0; return '<div style="font-size:10px;display:flex;justify-content:space-between;gap:8px"><span>'+k+'</span><b class="'+(r>=55?'up':r<=45?'dn':'')+'">'+r+'% <span style="color:var(--muted2)">('+st.h+'/'+st.n+')</span></b></div>';}).join('');
    el.innerHTML=_card2('PATTERN RECEIPTS \u00b7 did it play out in 30s? ('+((window.CURSYM&&CURSYM.sym)||'')+')', rows||'<div style="color:var(--muted2);font-size:10px">learning \u2014 waiting for events to resolve</div>'); }
  function detectTape(data){
    var vs=tape.map(function(x){return x.v}).sort(function(a,b){return a-b}); var whaleT=vs[Math.floor(vs.length*0.96)]||1e18, medV=vs[Math.floor(vs.length/2)]||0;
    (data||[]).forEach(function(t){ var v=+t.v||0,px=+t.p||0;
      if(v>=whaleT&&v>medV*3&&v>0){ whaleLog.unshift({t:Date.now(),side:t.S,px:px,v:v}); if(whaleLog.length>8)whaleLog.pop(); }
      sweepBuf.push({t:Date.now(),px:px,side:t.S,v:v}); });
    var cut=Date.now()-1200; sweepBuf=sweepBuf.filter(function(x){return x.t>cut});
    var bset={},sset={},bv=0,sv=0; sweepBuf.forEach(function(x){ if(x.side==='Buy'){bset[x.px]=1;bv+=x.v}else{sset[x.px]=1;sv+=x.v} });
    if(Object.keys(bset).length>=4&&bv>medV*6) smLog('BUY SWEEP','up','aggressive buying consumed '+Object.keys(bset).length+' ask levels in <1.2s');
    if(Object.keys(sset).length>=4&&sv>medV*6) smLog('SELL SWEEP','dn','aggressive selling consumed '+Object.keys(sset).length+' bid levels in <1.2s');
  }
  function detectBook(bids,asks,book){
    if(!bids.length||!asks.length)return; var mid=(bids[0]+asks[0])/2;
    midWin.push({p:mid,t:Date.now()}); if(midWin.length>60)midWin.shift();
    var allSz=bids.map(function(p){return book.b[p]||0}).concat(asks.map(function(p){return book.a[p]||0}));
    var med=allSz.slice().sort(function(a,b){return a-b})[Math.floor(allSz.length/2)]||0;
    var curWalls={}; bids.slice(0,8).forEach(function(p){if((book.b[p]||0)>med*4)curWalls['b'+p]={px:p,side:'bid'}}); asks.slice(0,8).forEach(function(p){if((book.a[p]||0)>med*4)curWalls['a'+p]={px:p,side:'ask'}});
    for(var k in prevWalls){ if(!curWalls[k]){ var w=prevWalls[k], reached=w.side==='bid'?(bids[0]<=w.px):(asks[0]>=w.px);
      if(!reached) smLog('SPOOF PULL', w.side==='bid'?'dn':'up', 'a large '+w.side+' wall at '+nfmt(w.px)+' vanished without trading \u2014 possible spoof'); } }
    prevWalls=curWalls;
    if(midWin.length>15){ var ps=midWin.map(function(x){return x.p}), hi=Math.max.apply(null,ps), lo=Math.min.apply(null,ps), hiI=ps.lastIndexOf(hi), loI=ps.lastIndexOf(lo), spr=(asks[0]-bids[0])||0.1;
      if(hiI>midWin.length-8&&(hi-mid)>spr*4) smLog('STOP-RUN \u2191','dn','price swept the highs near '+nfmt(hi)+' then reversed \u2014 liquidity grab / inducement above');
      if(loI>midWin.length-8&&(mid-lo)>spr*4) smLog('STOP-RUN \u2193','up','price swept the lows near '+nfmt(lo)+' then reversed \u2014 liquidity grab / inducement below'); }
  }
  function ofSynth(){
    var r=window._ofRead||{}, score=0, drivers=[], now=Date.now(), sharp=false;
    if(r.imbalance!=null){ var d=(r.imbalance-0.5)*2; score+=d*0.8; if(Math.abs(d)>0.15)drivers.push(d>0?'bids stacked':'asks stacked'); }
    if(r.taker_buy!=null){ var d2=(r.taker_buy-0.5)*2; score+=d2*0.7; if(Math.abs(d2)>0.15)drivers.push(d2>0?'takers buying':'takers selling'); }
    if(cvdSeries.length>10){ var a=cvdSeries[cvdSeries.length-1]-cvdSeries[Math.max(0,cvdSeries.length-10)]; if(a!==0){score+=(a>0?0.4:-0.4); drivers.push(a>0?'CVD rising':'CVD falling');} }
    smEvents.forEach(function(e){ if(now-e.t>12000)return;
      if(e.type==='BUY SWEEP'){score+=0.6;sharp=true;drivers.push('buy sweep');}
      else if(e.type==='SELL SWEEP'){score-=0.6;sharp=true;drivers.push('sell sweep');}
      else if(e.type==='SPOOF PULL'){ if(e.cls==='dn'){score-=0.3;drivers.push('bid spoof pulled');}else{score+=0.3;drivers.push('ask spoof pulled');} }
      else if(e.type&&e.type.indexOf('STOP-RUN')===0){ if(e.cls==='up'){score+=0.5;sharp=true;drivers.push('stop-run low \u2192 reversal up');}else{score-=0.5;sharp=true;drivers.push('stop-run high \u2192 reversal down');} } });
    if(r.absorption){ if(/buyers being/.test(r.absorption)){score-=0.3;drivers.push('buyers absorbed');}else if(/sellers being/.test(r.absorption)){score+=0.3;drivers.push('sellers absorbed');} }
    score=Math.max(-1,Math.min(1,score));
    var dir=score>0.15?'UP':score<-0.15?'DOWN':'balanced', cls=score>0.15?'up':score<-0.15?'dn':'', mag=Math.abs(score);
    var intensity=(sharp||mag>0.55)?'sharp':mag>0.28?'moderate':'mild';
    var verb=dir==='balanced'?'no clear pressure':(dir==='UP'?(intensity==='sharp'?'sharp move up likely':'grind higher'):(intensity==='sharp'?'sharp decline likely':'drift lower'));
    var uniq=drivers.filter(function(v,i){return drivers.indexOf(v)===i}).slice(0,4);
    var text=dir==='balanced'?'Flow balanced \u2014 no edge right now':(intensity.toUpperCase()+' '+dir+' \u2014 '+verb);
    window._ofSynth={dir:dir,cls:cls,intensity:intensity,score:+score.toFixed(2),text:text,drivers:uniq,verb:verb};
    return window._ofSynth;
  }
  function renderSmart(){
    var syn=ofSynth(), sel=document.getElementById('l2Synth');
    if(sel) sel.innerHTML='<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="font-size:15px;font-weight:800" class="'+syn.cls+'">'+(syn.dir==='balanced'?'— BALANCED':(syn.dir==='UP'?'▲ ':'▼ ')+syn.intensity.toUpperCase()+' '+syn.dir)+'</span><span style="font-size:11px;color:var(--muted)">'+syn.verb+(syn.drivers.length?' · '+syn.drivers.join(', '):'')+'</span></div>';
    var el=document.getElementById('l2Smart'); if(!el)return;
    var wb=whaleLog.filter(function(w){return w.side==='Buy'}).length, wsl=whaleLog.length-wb;
    var whales=whaleLog.length?whaleLog.slice(0,5).map(function(w){return '<div style="font-size:10px"><span class="'+(w.side==='Buy'?'up':'dn')+'">'+(w.side==='Buy'?'\u25b2':'\u25bc')+' '+nfmt(w.px)+'</span> <b>'+w.v.toFixed(3)+'</b></div>'}).join(''):'<div style="color:var(--muted2);font-size:10px">watching for large prints\u2026</div>';
    var events=smEvents.length?smEvents.slice(0,6).map(function(e){var ago=Math.round((Date.now()-e.t)/1000);return '<div style="font-size:10px;margin-bottom:3px;line-height:1.35"><b class="'+(e.cls||'')+'">'+e.type+'</b> <span style="color:var(--muted2)">'+ago+'s ago</span><br><span style="color:var(--muted)">'+e.note+'</span></div>'}).join(''):'<div style="color:var(--muted2);font-size:10px">no manipulation patterns flagged yet \u2014 watching continuously</div>';
    el.innerHTML=_card2('WHALE PRINTS \u00b7 '+wb+' buy / '+wsl+' sell (last)', whales)+_card2('DETECTED EVENTS \u00b7 sweeps \u00b7 spoofs \u00b7 stop-runs', events);
  }
  window.startDepthLadder=function(){try{ensureUI();start()}catch(e){}};
  setInterval(function(){var v=document.getElementById('v-orderflow');if(!v||!v.classList.contains('on'))stop()},8000);
}catch(e){}})();

/* ================= v13.5 #3 SIGNAL OUTCOME LEDGER (live forward test) ================= */
(function(){try{
  var KEY='mishel_sigledger';
  function load(){try{return JSON.parse(localStorage.getItem(KEY)||'[]')}catch(e){return []}}
  function save(L){try{localStorage.setItem(KEY,JSON.stringify(L.slice(-500)))}catch(e){}}
  function liveOK(){return typeof MODE!=='undefined'&&MODE==='online'&&window._lastTick&&Date.now()-window._lastTick<90000}
  setInterval(function(){try{
    if(!liveOK()||!DATA||!DATA.length)return;
    var con=IND._consensus||consensusSignal(DATA);if(!con||!Number.isFinite(con.score)||Math.abs(con.score)<25)return;
    var L=load(),now=Date.now();
    for(var i=L.length-1;i>=0;i--){var e=L[i];if(e.sym===CURSYM.sym&&e.tf===TF){if(now-e.t<15*60000)return;break}}
    L.push({t:now,sym:CURSYM.sym,tf:TF,score:con.score,label:con.label||'',px:DATA[DATA.length-1].c,delayed:!!window._feedDelay});
    save(L);
  }catch(e){}},60000);
  window.renderSigLedger=function(){try{
    var host=document.querySelector('#v-intel .pad')||document.getElementById('v-intel');if(!host)return;
    var p=document.getElementById('sigLedger');
    if(!p){p=document.createElement('div');p.className='panelbox';p.id='sigLedger';host.appendChild(p)}
    var L=load(),now=Date.now(),changed=false;
    L.forEach(function(e){[['h1',36e5],['h4',144e5]].forEach(function(H){var k=H[0],ms=H[1];
      if(e[k]!=null||now-e.t<ms)return;
      var bars=BAR_CACHE[e.sym+'|'+e.tf]||((CURSYM.sym===e.sym&&TF===e.tf)?DATA:null);if(!bars||!bars.length)return;
      var target=e.t+ms,b=null;for(var i=bars.length-1;i>=0;i--){if(bars[i].t<=target){b=bars[i];break}}
      if(!b||b.t<e.t)return;
      e[k]=(Math.sign(b.c-e.px)===Math.sign(e.score))?1:0;changed=true;});});
    if(changed)save(L);
    var res=L.filter(function(e){return e.h1!=null});
    var by={};res.forEach(function(e){var k=e.sym+' '+e.tf;var v=by[k]=by[k]||{n:0,w1:0,n4:0,w4:0};v.n++;v.w1+=e.h1;if(e.h4!=null){v.n4++;v.w4+=e.h4}});
    var rows=Object.keys(by).map(function(k){var v=by[k];
      return '<tr><td><b>'+k+'</b></td><td class="mono">'+v.n+'</td><td class="mono">'+Math.round(v.w1/v.n*100)+'%</td><td class="mono">'+(v.n4?Math.round(v.w4/v.n4*100)+'%':'\u2014')+'</td></tr>'}).join('');
    p.innerHTML='<h4>Signal Outcome Ledger <span class="tag" title="Every strong consensus read (|score|\u226525, live data only, one per 15 min per symbol/TF) is recorded, then scored against what price actually did at +1h and +4h. Forward test \u2014 no hindsight, nothing simulated.">FORWARD TEST</span></h4>'
      +'<div style="font-size:11px;color:var(--muted);margin-bottom:8px">'+L.length+' recorded \u00b7 '+res.length+' resolved \u00b7 pending entries score themselves when that symbol/TF has live bars covering the horizon. Delayed-feed signals are marked at record time.</div>'
      +(rows?'<table class="log"><thead><tr><th>Symbol \u00b7 TF</th><th>N</th><th>Hit @1h</th><th>Hit @4h</th></tr></thead><tbody>'+rows+'</tbody></table>'
            :'<div style="color:var(--muted);font-size:12px">No resolved signals yet \u2014 keep the terminal online; the ledger builds itself.</div>');
  }catch(e){}};
}catch(e){}})();
/* ================= v13.6 DOCK COLLAPSE ================= */
(function(){try{
  var app=document.querySelector('.app'),rail=document.getElementById('rail');if(!app||!rail)return;
  var hide=document.createElement('button');hide.id='dockHide';hide.title='Hide dock';hide.textContent='\u2039';
  rail.appendChild(hide);
  var show=document.createElement('button');show.id='dockShow';show.title='Show dock';show.textContent='\u203a';
  document.body.appendChild(show);
  function set(hidden){app.classList.toggle('rail-hidden',hidden);show.style.display=hidden?'flex':'none';
    try{localStorage.setItem('mishel_dock',hidden?'0':'1')}catch(e){}
    try{if(typeof draw==='function'&&document.getElementById('v-chart').classList.contains('on'))setTimeout(draw,220)}catch(e){}}
  hide.onclick=function(){set(true)};show.onclick=function(){set(false)};
  try{if(localStorage.getItem('mishel_dock')==='0')set(true)}catch(e){}
}catch(e){}})();
/* ================= v13.7 G: AUTO S/R ZONES (clustered pivots, glass-box) ================= */
(function(){try{
  var CACHE={key:'',zones:[]};
  function pivots(D,k){var hi=[],lo=[];for(var i=k;i<D.length-k;i++){var isH=true,isL=true;
    for(var j=1;j<=k;j++){if(D[i].h<D[i-j].h||D[i].h<D[i+j].h)isH=false;if(D[i].l>D[i-j].l||D[i].l>D[i+j].l)isL=false;}
    if(isH)hi.push(i);if(isL)lo.push(i);}return {hi:hi,lo:lo}}
  function zones(){var D=DATA.slice(-400);if(D.length<60)return [];
    var key=CURSYM.sym+'|'+TF+'|'+DATA.length;if(CACHE.key===key)return CACHE.zones;
    var pv=pivots(D,3),pts=[];
    pv.hi.forEach(function(i){pts.push({p:D[i].h,i:i})});pv.lo.forEach(function(i){pts.push({p:D[i].l,i:i})});
    pts.sort(function(a,b){return a.p-b.p});
    var atr=0;for(var i=1;i<D.length;i++)atr+=Math.max(D[i].h-D[i].l,Math.abs(D[i].h-D[i-1].c),Math.abs(D[i].l-D[i-1].c));atr/=(D.length-1);
    var tol=Math.max(atr*0.35,D[D.length-1].c*0.0008),Z=[],cur=null;
    pts.forEach(function(pt){if(cur&&pt.p-cur.hi<=tol){cur.hi=Math.max(cur.hi,pt.p);cur.n++;cur.first=Math.min(cur.first,pt.i)}
      else{if(cur)Z.push(cur);cur={lo:pt.p,hi:pt.p,n:1,first:pt.i}}});
    if(cur)Z.push(cur);
    Z=Z.filter(function(z){return z.n>=2}).sort(function(a,b){return b.n-a.n}).slice(0,6);
    var off=DATA.length-D.length;Z.forEach(function(z){z.first+=off});
    CACHE={key:key,zones:Z};return Z}
  var _d=draw;draw=function(){_d();try{
    return; /* v39.5 A: retired — 'srzones' (51-psar) is the single Auto S/R owner */
    if(!window.RENDER||!ON.has('srz'))return;var g=cv.getContext('2d');
    var st=RENDER.start,cw2=RENDER.cw,ph=RENDER.priceH,W2=RENDER.W,pr=RENDER.padR;
    var lg=window.SCALE_MODE==='log'&&RENDER.lo>0,la=lg?Math.log(RENDER.lo):RENDER.lo,lb=lg?Math.log(RENDER.hi):RENDER.hi,ls=(lb-la)||1e-9;
    var Y=function(p){return (1-((lg?Math.log(p>0?p:1e-9):p)-la)/ls)*ph};
    var px=DATA[DATA.length-1].c;
    zones().forEach(function(z){var y1=Y(z.hi),y2=Y(z.lo);if(y2<0||y1>ph)return;
      var res=(z.lo+z.hi)/2>px;var col=res?'rgba(240,97,109,':'rgba(45,190,142,';
      var x0=Math.max(0,(z.first-st)*cw2);
      g.fillStyle=col+'.09)';g.fillRect(x0,Math.max(0,y1),(W2-pr)-x0,Math.min(ph,y2)-Math.max(0,y1));
      g.strokeStyle=col+'.35)';g.strokeRect(x0,Math.max(0,y1),(W2-pr)-x0,Math.min(ph,y2)-Math.max(0,y1));
      g.fillStyle=col+'.85)';g.font='8.5px JetBrains Mono';g.textAlign='left';
      g.fillText((res?'R':'S')+' \u00b7 '+z.n+' touches',x0+4,Math.max(9,y1-3));});
  }catch(e){}};
  /* v39.5 A — the SECOND Auto S/R chip this file used to append is retired.
     Two chips ('srz' here, 'srzones' in the Pro Pack) with two half-painters
     fought over one label — that is why the feature "worked" as a coin flip.
     ONE owner now: 'srzones' in 51-psar, upgraded to volume-weighted zones.
     ON.delete('srz') below clears any stale persisted state so a saved 'srz'
     key cannot resurrect the ghost painter. */
  try{ ON.delete('srz'); }catch(_){}
}catch(e){}})();



/* v39.29: smart-money alert toggle wiring */
document.addEventListener('DOMContentLoaded',function(){ setTimeout(function(){ try{
  var cb=document.getElementById('smAlertsOn'); if(!cb)return;
  try{cb.checked=localStorage.getItem('iram_smalerts')==='1'}catch(e){} window._smAlertsOn=cb.checked;
  cb.addEventListener('change',function(){ window._smAlertsOn=cb.checked; try{localStorage.setItem('iram_smalerts',cb.checked?'1':'0')}catch(e){} });
}catch(e){} },3000); });
