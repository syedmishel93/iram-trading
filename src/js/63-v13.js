/* ================= v13.7 J: CANDLE DNA (this pattern on THIS data — how did it resolve?) ================= */
(function(){try{
  function bb(closes,n){var out=[];for(var i=0;i<closes.length;i++){if(i<n){out.push(null);continue}
    var s=0;for(var j=i-n+1;j<=i;j++)s+=closes[j];var m=s/n,v=0;
    for(var j2=i-n+1;j2<=i;j2++)v+=(closes[j2]-m)*(closes[j2]-m);var sd=Math.sqrt(v/n);
    out.push({u:m+2*sd,l:m-2*sd})}return out}
  function sig(D,rsi,bands,i){if(i<3||!bands[i])return null;
    var d3='';for(var k=2;k>=0;k--)d3+=(D[i-k].c>=D[i-k].o?'U':'D');
    var pos=D[i].c>bands[i].u?'hi':D[i].c<bands[i].l?'lo':'mid';
    var r=rsi[i]==null?'na':rsi[i]<30?'os':rsi[i]>70?'ob':'nm';
    return d3+'|'+pos+'|'+r}
  function render(){try{
    var host=document.getElementById('imxCard')||document.querySelector('.side .card');if(!host)return;
    var card=document.getElementById('dnaCard');
    if(!card){card=document.createElement('div');card.className='card';card.id='dnaCard';
      card.innerHTML='<h3>Candle DNA <span class="tag" title="The current 3-bar pattern + band position + RSI state, matched against every prior occurrence in the LOADED series. Outcome = close 10 bars later. Pure measurement of this data \u2014 no model, no simulation.">MEASURED</span></h3><div id="dnaBody" style="font-size:11.5px;color:var(--muted);line-height:1.6"></div>';
      host.parentElement.insertBefore(card,host.nextSibling);}
    var b=document.getElementById('dnaBody');if(!b||!DATA||DATA.length<80)return;
    var closes=DATA.map(function(c){return c.c});
    var rsi=IND.rsi(closes),bands=bb(closes,20),H=10;
    var n=DATA.length-1,cursig=sig(DATA,rsi,bands,n);
    if(!cursig){b.textContent='warming up\u2026';return}
    var up=0,tot=0,sum=0;
    for(var i=30;i<n-H;i++){if(sig(DATA,rsi,bands,i)!==cursig)continue;
      var mv=(DATA[i+H].c-DATA[i].c)/DATA[i].c;tot++;if(mv>0)up++;sum+=mv;}
    var lbl={'hi':'above upper band','mid':'mid-band','lo':'below lower band'}[cursig.split('|')[1]];
    var rl={'os':'RSI oversold','ob':'RSI overbought','nm':'RSI neutral','na':''}[cursig.split('|')[2]];
    var pat=cursig.split('|')[0].replace(/U/g,'\u25b2').replace(/D/g,'\u25bc');
    /* v39.7 A1: publish the stat so the Brain can EAT it (feature ctx.dna).
       Only with a real sample -- a 3-occurrence pattern is noise, not a feature. */
    try{window._dnaStat=(tot>=15)?{p:up/tot,n:tot,sig:cursig}:null;}catch(e){}
    b.innerHTML='Pattern <b class="mono">'+pat+'</b> \u00b7 '+lbl+' \u00b7 '+rl
      +(tot?'<br>Seen <b>'+tot+'\u00d7</b> in the loaded series \u2192 <b style="color:'+(up/tot>=0.5?'var(--bull)':'var(--bear)')+'">'+Math.round(up/tot*100)+'% up</b> after '+H+' bars \u00b7 avg <b>'+(sum/tot*100).toFixed(2)+'%</b>'
        +(tot<15?'<br><span style="color:var(--gold)">\u26a0 small sample ('+tot+') \u2014 weak evidence</span>':'')
       :'<br>No prior occurrence of this exact pattern in the loaded series \u2014 no statistical read.');
  }catch(e){}}
  setInterval(render,20000);setTimeout(render,4000);
}catch(e){}})();
/* ================= v13.8 O+X: AI SECOND OPINION + DEVIL'S ADVOCATE (vision) ================= */
(function(){try{
  function ensure(){var host=document.getElementById('dnaCard')||document.getElementById('imxCard')||document.querySelector('.side .card');if(!host)return null;
    var c=document.getElementById('aiOpCard');
    if(!c){c=document.createElement('div');c.className='card';c.id='aiOpCard';
      c.innerHTML='<h3>AI Vision Desk <span class="tag" title="Sends the ACTUAL rendered chart image to your vision LLM (via the proxy). Second Opinion = independent read compared against the consensus engine. Devil\u2019s Advocate = the strongest case AGAINST the current consensus \u2014 a confirmation-bias antidote. Needs: Use LLM via proxy + proxy URL in Settings.">VISION</span></h3>'
        +'<div style="display:flex;gap:6px;margin:8px 0"><button class="run" id="aiOpBtn" style="flex:1;padding:7px 0;font-size:11px">Second Opinion \u25b7</button><button class="run" id="aiDaBtn" style="flex:1;padding:7px 0;font-size:11px;background:linear-gradient(180deg,#f47a86,var(--bear));box-shadow:0 4px 14px -6px var(--bear)">Devil\u2019s Advocate \u25b7</button></div>'
        +'<div id="aiOpConflict" style="display:none;margin-bottom:6px;padding:6px 9px;border-radius:8px;background:var(--bear-dim);border:1px solid var(--bear);color:var(--bear);font-size:11px;font-weight:700"></div>'
        +'<div id="aiOpOut" style="font-size:11.5px;color:var(--muted);line-height:1.6;white-space:pre-wrap;max-height:260px;overflow-y:auto"></div>';
      host.parentElement.insertBefore(c,host.nextSibling);}
    var _llm0=document.getElementById('aiUseLLM'); c.style.display=(_llm0&&_llm0.checked)?'':'none';   /* v39.26: omit the card entirely until the LLM is enabled */
    return c}
  function guard(out){var _on=document.getElementById('aiUseLLM');if(!_on||!_on.checked||typeof proxyBase!=='function'||!proxyBase()){
    out.textContent='Needs the vision LLM: enable \u201cUse LLM via proxy\u201d and set the proxy URL in Settings \u2192 Data sources. Nothing is faked in its absence.';return false}return true}
  async function ask(kind){try{var c=ensure();if(!c)return;
    var out=document.getElementById('aiOpOut'),cf=document.getElementById('aiOpConflict');cf.style.display='none';
    if(!guard(out))return;
    var img=chartImageB64();if(!img){out.textContent='could not capture the chart canvas';return}
    var con=IND._consensus||consensusSignal(DATA);
    var q= kind==='op'
      ? 'You are an independent technical analyst. Read the ATTACHED chart image only. Reply in this exact structure:\nBIAS: BULLISH|BEARISH|NEUTRAL\nSTRUCTURE: <one line>\nKEY LEVELS: <only prices visible on the axis>\nINVALIDATION: <level>\nCONFIDENCE: <0-100>\nREASONING: <3 short lines>\nDo not invent prices that are not visible. Do not mention any consensus \u2014 be independent.'
      : 'The terminal\u2019s consensus for '+CURSYM.sym+' '+TF+' is '+(con?con.label+' (score '+con.score+')':'unknown')+'. Argue the STRONGEST case AGAINST it using the attached chart image and this data snapshot:\n'+analystContextString()+'\nGive exactly: 3 concrete counter-reasons grounded in the chart, the level that would prove the consensus wrong, and what would change your mind. Do not be agreeable.';
    out.textContent=kind==='op'?'vision read\u2026':'building the counter-case\u2026';
    var txt=await runAgent(q,function(s){out.textContent=s+'\u2026'},[{type:'image',source:{type:'base64',media_type:'image/png',data:img}}]);
    out.textContent=txt;
    if(kind==='op'&&con&&Number.isFinite(con.score)){
      var m=/BIAS:\s*(BULLISH|BEARISH|NEUTRAL)/i.exec(txt);
      if(m){var ai=m[1].toUpperCase()==='BULLISH'?1:m[1].toUpperCase()==='BEARISH'?-1:0;
        var eng=Math.abs(con.score)>=25?Math.sign(con.score):0;
        if(ai!==0&&eng!==0&&ai!==eng){cf.style.display='block';cf.textContent='\u26a0 DISAGREEMENT: vision says '+m[1].toUpperCase()+', consensus says '+con.label+' \u2014 conflicting evidence, size down or stand aside.'}
        else if(ai!==0&&ai===eng){cf.style.display='block';cf.style.background='var(--bull-dim)';cf.style.borderColor='var(--bull)';cf.style.color='var(--bull)';cf.textContent='\u2713 AGREEMENT: two independent reads align ('+m[1].toUpperCase()+').'}}}
  }catch(e){var o=document.getElementById('aiOpOut');if(o)o.textContent='error: '+(e&&e.message||e)}}
  setTimeout(function(){var c=ensure();if(!c)return;
    var b1=document.getElementById('aiOpBtn'),b2=document.getElementById('aiDaBtn');
    if(b1)b1.onclick=function(){ask('op')};if(b2)b2.onclick=function(){ask('da')};
    var _llm=document.getElementById('aiUseLLM'); if(_llm){var _sync=function(){var cc=document.getElementById('aiOpCard');if(cc)cc.style.display=_llm.checked?'':'none'};_llm.addEventListener('change',_sync);_sync();}},3500);
}catch(e){}})();

/* ================= v13.8 Y: DESK NARRATOR (deterministic, level-aware — cannot hallucinate) ================= */
(function(){try{
  function render(){try{
    var host=document.getElementById('aiOpCard')||document.getElementById('dnaCard')||document.querySelector('.side .card');if(!host)return;
    var c=document.getElementById('deskNarr');
    if(!c){c=document.createElement('div');c.className='card';c.id='deskNarr';
      c.innerHTML='<h3>Desk Narrator <span class="tag" title="A plain-language read composed ONLY from the terminal\u2019s real numbers (consensus, trend, RSI/ADX, VWAP, PDH/PDL, ATR). Template over data \u2014 it cannot invent a level.">DATA-ONLY</span></h3><div id="deskNarrBody" style="font-size:11.5px;color:var(--muted);line-height:1.65"></div>';
      host.parentElement.insertBefore(c,host.nextSibling);}
    var b=document.getElementById('deskNarrBody');if(!b||!DATA||DATA.length<30)return;
    var x=analystContext();var f=function(v){return v==null?'n/a':(+v).toFixed(x.dec)};
    var lad=null;try{lad=levelLadder(x)}catch(e){}
    var above=lad&&lad.above&&lad.above[0],below=lad&&lad.below&&lad.below[0];
    var vsV=x.vwap!=null?(x.price>=x.vwap?'above':'below'):null;
    var mom=x.rsi>70?'stretched (overbought)':x.rsi<30?'stretched (oversold)':x.adx>=25?'firm':'modest';
    var s='<b>'+x.name+' '+x.tf+'</b> at <b>'+f(x.price)+'</b>. Consensus: <b style="color:'+(x.rep.score>0?'var(--bull)':x.rep.score<0?'var(--bear)':'var(--muted)')+'">'+x.rep.label+' ('+(x.rep.score>=0?'+':'')+x.rep.score.toFixed(0)+')</b>. '
      +'Trend '+x.trend+'; momentum '+mom+' (RSI '+x.rsi.toFixed(0)+', ADX '+x.adx.toFixed(0)+'); regime: '+x.reg.regime+'. '
      +(vsV?('Trading '+vsV+' VWAP '+f(x.vwap)+'. '):'')
      +(above?('Overhead: '+above.name+' '+f(above.p)+' ('+((above.p-x.price)/x.price*100).toFixed(2)+'%). '):'')
      +(below?('Beneath: '+below.name+' '+f(below.p)+' ('+((below.p-x.price)/x.price*100).toFixed(2)+'%). '):'')
      +'ATR '+(x.atr/x.price*100).toFixed(2)+'%.'
      +(below&&x.rep.score>0?' A close through '+f(below.p)+' weakens the long read.':'')
      +(above&&x.rep.score<0?' A close through '+f(above.p)+' weakens the short read.':'');
    b.innerHTML=s;
  }catch(e){}}
  setInterval(render,25000);setTimeout(render,4500);
}catch(e){}})();
/* ================= v13.9 CRYPTO OPPORTUNITY SCANNER (measured, never promised) ================= */
(function(){try{
  var B='https://data-api.binance.vision/api/v3';
  function pct(a,b){return b?(a-b)/b*100:0}
  window.ensureCoinScan=function(){var host=document.querySelector('#v-screener .pad')||document.getElementById('v-screener');if(!host)return;
    if(document.getElementById('coinScan'))return;
    var p=document.createElement('div');p.className='panelbox';p.id='coinScan';
    p.innerHTML='<h4>Crypto Opportunity Scanner <span class="tag" title="Ranks Binance USDT pairs by measured multi-window momentum + volume surge + breakout proximity, then shows what ACTUALLY happened historically after identical states on that coin. Distributions, not promises \u2014 past frequency is not a guarantee.">MEASURED</span></h4>'
      +'<div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap"><button class="run" id="csRun" style="padding:7px 16px;font-size:11px">Scan market \u25b7</button><label style="font-size:10.5px;color:var(--muted);align-self:center">depth <select id="csLim" style="background:var(--panel);border:1px solid var(--edge);border-radius:6px;color:var(--txt);font-family:var(--mono);font-size:10.5px;padding:2px 4px"><option>8</option><option selected>15</option><option>25</option><option>40</option></select> coins</label><span id="csStat" style="font-size:11px;color:var(--muted);align-self:center"></span></div><div id="csOut"></div>';
    host.insertBefore(p,host.firstChild);
    document.getElementById('csRun').onclick=scan;};
  async function scan(){var st=document.getElementById('csStat'),out=document.getElementById('csOut');
    try{
      st.textContent='pulling 24h tickers\u2026';out.innerHTML='';
      var all=await (await fetch(B+'/ticker/24hr')).json();
      var u=all.filter(function(t){return /USDT$/.test(t.symbol)&&!/UP|DOWN|BULL|BEAR/.test(t.symbol)&&+t.quoteVolume>3e6});
      u.sort(function(a,b){return (+b.priceChangePercent)-(+a.priceChangePercent)});
      var lim=+((document.getElementById('csLim')||{}).value)||15;
      var cand=u.slice(0,lim);st.textContent='deep-scanning top '+cand.length+' (2 requests each)\u2026';
      var rows=[];
      for(var ci=0;ci<cand.length;ci++){var t=cand[ci];
        try{var k=await (await fetch(B+'/klines?symbol='+t.symbol+'&interval=1h&limit=1000')).json();
          if(!Array.isArray(k)||k.length<200)continue;
          var C=k.map(function(r){return +r[4]}),H=k.map(function(r){return +r[2]}),L=k.map(function(r){return +r[3]}),V=k.map(function(r){return +r[5]});
          var n=C.length-1,px=C[n];
          var m1=pct(px,C[n-1]),m4=pct(px,C[n-4]),m24=pct(px,C[n-24]),m168=n>168?pct(px,C[n-168]):0;
          var v24=0,i;for(i=n-23;i<=n;i++)v24+=V[i];var vAvg=0;for(i=Math.max(0,n-24*30);i<n-24;i++)vAvg+=V[i];vAvg=vAvg/Math.max(1,(Math.min(n-24,24*30)-0))*24;
          var surge=vAvg?v24/vAvg:1;
          var hi7=Math.max.apply(null,H.slice(-168));var brk=pct(px,hi7);
          var atr=0;for(i=n-13;i<=n;i++)atr+=Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));atr/=14;
          var score=m24*1.2+m4*0.8+m168*0.3+(surge-1)*10+(brk>-2?8:0);
          /* (2) forward-return stats: same state historically = 24-bar mom bucket + surge>1.5 */
          var bkt=function(m){return m>8?2:m>3?1:m>-3?0:-1};var cur=bkt(m24),fwd=[],j;
          for(j=48;j<n-72;j++){var mj=pct(C[j],C[j-24]);var vs=0,va=0;for(i=j-23;i<=j;i++)vs+=V[i];for(i=Math.max(0,j-24*15);i<j-24;i++)va+=V[i];va=va/Math.max(1,Math.min(j-24,24*15))*24;
            if(bkt(mj)===cur&&(va?vs/va:1)>1.3)fwd.push(pct(C[j+72],C[j]));}
          fwd.sort(function(a,b){return a-b});
          var med=fwd.length?fwd[fwd.length>>1]:null,pos=fwd.length?Math.round(fwd.filter(function(x){return x>0}).length/fwd.length*100):null,worst=fwd.length?fwd[0]:null;
          /* (4) deterioration flags */
          var flags=[];var bt=await (await fetch(B+'/ticker/bookTicker?symbol='+t.symbol)).json();
          var spr=bt&&+bt.askPrice?pct(+bt.askPrice,+bt.bidPrice):0;
          if(surge<0.4)flags.push('volume collapse ('+(surge*100).toFixed(0)+'% of baseline)');
          if(m24<-15)flags.push('drawdown velocity '+m24.toFixed(1)+'%/24h');
          if(spr>0.4)flags.push('spread blowout '+spr.toFixed(2)+'%');
          var athW=Math.max.apply(null,H);if(pct(px,athW)<-70)flags.push((pct(px,athW)).toFixed(0)+'% under window high');
          rows.push({s:t.symbol,px:px,m1:m1,m4:m4,m24:m24,m168:m168,surge:surge,brk:brk,atr:atr,score:score,med:med,pos:pos,worst:worst,nf:fwd.length,flags:flags,spr:spr});
        }catch(e){}}
      rows.sort(function(a,b){return b.score-a.score});
      st.textContent=rows.length+' candidates \u00b7 '+new Date().toLocaleTimeString();
      out.innerHTML=rows.map(function(r,ix){
        var f=r.px<1?6:r.px<100?4:2;
        var fw=r.nf?('seen <b>'+r.nf+'\u00d7</b> \u2192 median <b style="color:'+(r.med>0?'var(--bull)':'var(--bear)')+'">'+r.med.toFixed(1)+'%</b> /3d \u00b7 '+r.pos+'% positive \u00b7 worst '+r.worst.toFixed(1)+'%'+(r.nf<15?' <span style="color:var(--gold)">\u26a0 small sample</span>':''))
                     :'no prior identical state in 41d window \u2014 no statistical read';
        return '<div style="border:1px solid var(--edge);border-radius:10px;padding:9px 11px;margin-bottom:8px">'
          +'<div style="display:flex;justify-content:space-between;align-items:center"><b>'+(ix+1)+'. '+r.s+'</b><span class="mono">'+r.px.toFixed(f)+' \u00b7 score '+r.score.toFixed(0)+'</span></div>'
          +'<div style="font-size:10.5px;color:var(--muted);margin:3px 0">mom 1h '+r.m1.toFixed(1)+'% \u00b7 4h '+r.m4.toFixed(1)+'% \u00b7 24h <b>'+r.m24.toFixed(1)+'%</b> \u00b7 7d '+r.m168.toFixed(1)+'% \u00b7 vol surge <b>'+r.surge.toFixed(1)+'\u00d7</b> \u00b7 '+(r.brk>-0.5?'<b style="color:var(--gold)">at 7d high</b>':r.brk.toFixed(1)+'% from 7d high')+'</div>'
          +'<div style="font-size:10.5px;color:var(--muted)">history: '+fw+'</div>'
          +(r.flags.length?'<div style="font-size:10.5px;color:var(--bear);margin-top:3px">\u26a0 risk flags: '+r.flags.join(' \u00b7 ')+'</div>':'')
          +'<div style="margin-top:6px"><button class="run" style="padding:4px 12px;font-size:10.5px" onclick="csPlan('+ix+')">Plan \u25b7</button> <button class="run" style="padding:4px 12px;font-size:10.5px;background:linear-gradient(180deg,#2AABEE,#1f8fd0)" onclick="csTg('+ix+')">\u2708 Telegram</button></div>'
          +'<div id="csP'+ix+'" style="display:none;font-family:var(--mono);font-size:10.5px;margin-top:6px;color:var(--txt)"></div></div>'}).join('')
        +'<div style="font-size:9.5px;color:var(--muted2)">Measured on real Binance data \u00b7 historical frequency \u2260 promise \u00b7 rug-risk flags are market-side heuristics (volume/liquidity/drawdown), not on-chain contract audits \u00b7 you decide & execute.</div>';
      window._csRows=rows;
    }catch(e){st.textContent='scan failed: '+(e&&e.message||e)}}
  window.csPlan=function(ix){var r=window._csRows[ix];var d=document.getElementById('csP'+ix);if(!d)return;
    var bal=(window.PAPER&&PAPER.bal)||10000,risk=1;var stop=r.px-1.5*r.atr;var dist=r.px-stop;
    var units=(bal*risk/100)/dist;var f=r.px<1?6:r.px<100?4:2;
    d.style.display='block';
    d.textContent='PLAN (long, measured): entry '+r.px.toFixed(f)+' \u00b7 stop '+stop.toFixed(f)+' ('+(dist/r.px*100).toFixed(2)+'%, 1.5\u00d7ATR) \u00b7 TP1 '+(r.px+dist).toFixed(f)+' (1R) \u00b7 TP2 '+(r.px+2*dist).toFixed(f)+' (2R) \u00b7 TP3 '+(r.px+3*dist).toFixed(f)+' (3R) \u00b7 size @'+risk+'% of $'+bal.toFixed(0)+': '+units.toFixed(4)+' units \u00b7 spread '+r.spr.toFixed(3)+'% ('+(r.spr/(dist/r.px*100)*100).toFixed(0)+'% of stop) \u2014 analysis, not advice';};
  window.csTg=function(ix){var r=window._csRows[ix];window.csPlan(ix);
    var d=document.getElementById('csP'+ix);
    var hist=r.nf?('history: '+r.nf+'x -> median '+r.med.toFixed(1)+'%/3d, '+r.pos+'% positive, worst '+r.worst.toFixed(1)+'%'):'no historical analogue';
    var txt='\ud83d\udd0e SCANNER \u2014 '+r.s+'\nmom24h '+r.m24.toFixed(1)+'% \u00b7 vol '+r.surge.toFixed(1)+'x \u00b7 '+hist+(r.flags.length?'\n\u26a0 '+r.flags.join(' \u00b7 '):'')+'\n'+(d?d.textContent:'')+'\n\u2014 measured, not promised \u00b7 you decide';
    if(window.sendTG)sendTG(txt,true);try{toast('Sent to Telegram',var_bull())}catch(e){}};
}catch(e){}})();


/* ================= v39.26 COLLAPSIBLE SIDE CARDS — click a header to omit that card (persisted) ================= */
document.addEventListener('DOMContentLoaded',function(){ setTimeout(function(){ try{
  var col={}; try{col=JSON.parse(localStorage.getItem('iram_collapsed')||'{}')||{}}catch(e){}
  function wire(){ document.querySelectorAll('.side .card > h3').forEach(function(h){ if(h._cw)return; h._cw=1;
    var card=h.parentElement, id=card.id||(h.textContent||'').trim().slice(0,24);
    h.style.cursor='pointer'; h.insertAdjacentHTML('beforeend',' <span class="cc-caret" style="float:right;color:var(--muted2);font-size:10px">\u25be</span>');
    var body=[]; for(var el=h.nextElementSibling;el;el=el.nextElementSibling)body.push(el);
    function apply(){ var c=!!col[id]; body.forEach(function(el){el.style.display=c?'none':''}); var cv=h.querySelector('.cc-caret'); if(cv)cv.textContent=c?'\u25b8':'\u25be'; }
    h.addEventListener('click',function(){ col[id]=!col[id]; try{localStorage.setItem('iram_collapsed',JSON.stringify(col))}catch(e){} apply(); });
    apply();
  }); }
  wire(); setInterval(wire,4000);
}catch(e){} },2000); });
