(function(){try{
  var ih=document.getElementById('instHead');if(!ih)return;
  var chip=document.createElement('span');chip.className='pill';chip.id='fundChip';chip.style.display='none';
  chip.title='Perp funding: current rate and time to next 8h funding (00/08/16 UTC). Source: Binance Futures public API.';
  ih.appendChild(chip);var rate=null,last=0;
  setInterval(function(){try{
    var ok=CURSYM&&(CURSYM.cls==='crypto'||CURSYM.cls==='cryptofut');
    chip.style.display=ok?'':'none';if(!ok)return;
    var now=new Date();var h=now.getUTCHours();var nx=(Math.floor(h/8)+1)*8;
    var t=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),nx%24,0,0)+(nx>=24?0:0);
    if(nx>=24)t+=0; if(t<now.getTime())t+=86400000/3;
    var m=Math.max(0,Math.floor((t-now.getTime())/60000));
    if(typeof MODE!=='undefined'&&MODE==='online'&&Date.now()-last>120000){last=Date.now();
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol='+CURSYM.sym.replace('USD','USDT'))
        .then(function(r){return r.json()}).then(function(j){if(j&&j.lastFundingRate)rate=(+j.lastFundingRate*100);window._fundRate=rate}).catch(function(){});}
    chip.innerHTML='FUND '+(rate!=null?('<b style="color:'+(rate>=0?'var(--bull)':'var(--bear)')+'">'+rate.toFixed(4)+'%</b> \u00b7 '):'')+Math.floor(m/60)+'h'+('0'+m%60).slice(-2)+'m';
  }catch(e){}},15000);
}catch(e){}})();

/* ================= v12.8 GPU RENDERER (WebGL candles under the 2D overlay) ================= */
(function(){try{
  var cvEl=document.getElementById('chart');if(!cvEl)return;
  var wrap=cvEl.parentElement;
  try{if(getComputedStyle(wrap).position==='static')wrap.style.position='relative'}catch(e){}
  var gcv=document.createElement('canvas');gcv.id='glChart';
  gcv.style.cssText='position:absolute;pointer-events:none;z-index:0;display:none';
  wrap.insertBefore(gcv,cvEl);
  cvEl.style.position='relative';cvEl.style.zIndex='1';
  var gl=null;try{gl=gcv.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false})||gcv.getContext('experimental-webgl',{alpha:true})}catch(e){}
  var GLR={ok:false,on:false,gpuName:'',why:''};window.GLR=GLR;
  function info(){var el=document.getElementById('gpuInfo');if(!el)return;
    el.textContent=GLR.ok?('WebGL: available'+(GLR.gpuName?' \u00b7 '+GLR.gpuName:'')+' \u00b7 renderer '+(GLR.on?'ACTIVE (GPU candles, 2D overlay)':'off (2D canvas)')):('WebGL: unavailable ('+(GLR.why||'no context')+') \u2014 using 2D canvas');}
  if(!gl){GLR.why='context refused';var s0=document.getElementById('setGpu');if(s0){s0.value='0';s0.disabled=true}info();return}
  function sh(t,sc){var o=gl.createShader(t);gl.shaderSource(o,sc);gl.compileShader(o);
    if(!gl.getShaderParameter(o,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(o)||'shader');return o}
  var pr;
  try{
    pr=gl.createProgram();
    gl.attachShader(pr,sh(gl.VERTEX_SHADER,'attribute vec2 p;attribute vec3 c;uniform vec2 res;varying vec3 vc;void main(){vec2 z=(p/res)*2.0-1.0;gl_Position=vec4(z.x,-z.y,0.0,1.0);vc=c;}'));
    gl.attachShader(pr,sh(gl.FRAGMENT_SHADER,'precision mediump float;varying vec3 vc;void main(){gl_FragColor=vec4(vc,1.0);}'));
    gl.linkProgram(pr);
    if(!gl.getProgramParameter(pr,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(pr)||'link');
  }catch(err){GLR.why=String(err.message||err);info();return}
  gl.useProgram(pr);
  var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
  var aP=gl.getAttribLocation(pr,'p'),aC=gl.getAttribLocation(pr,'c'),uR=gl.getUniformLocation(pr,'res');
  gl.enableVertexAttribArray(aP);gl.enableVertexAttribArray(aC);
  gl.vertexAttribPointer(aP,2,gl.FLOAT,false,20,0);
  gl.vertexAttribPointer(aC,3,gl.FLOAT,false,20,8);
  try{var dbg=gl.getExtension('WEBGL_debug_renderer_info');if(dbg)GLR.gpuName=gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)}catch(e){}
  GLR.ok=true;
  /* theme-aware colors: parsed from the live CSS vars each frame-begin */
  function col(name,fb){var v=(getComputedStyle(document.documentElement).getPropertyValue(name)||'').trim()||fb;
    var m=v.match(/^#([0-9a-f]{3})$/i);if(m)return [parseInt(m[1][0]+m[1][0],16)/255,parseInt(m[1][1]+m[1][1],16)/255,parseInt(m[1][2]+m[1][2],16)/255];
    m=v.match(/^#([0-9a-f]{6})/i);if(m)return [parseInt(m[1].slice(0,2),16)/255,parseInt(m[1].slice(2,4),16)/255,parseInt(m[1].slice(4,6),16)/255];
    m=v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);if(m)return [+m[1]/255,+m[2]/255,+m[3]/255];
    return [0.18,0.75,0.56];}
  var BULL=[0.18,0.75,0.56],BEAR=[0.94,0.38,0.43],logicalW=0,logicalH=0;
  GLR.begin=function(cv){
    if(!GLR.ok)return;
    if(!GLR.on){if(gcv.style.display!=='none')gcv.style.display='none';return}
    /* pin the GL layer exactly under the 2D chart canvas */
    gcv.style.display='block';
    gcv.style.left=cvEl.offsetLeft+'px';gcv.style.top=cvEl.offsetTop+'px';
    gcv.style.width=cvEl.offsetWidth+'px';gcv.style.height=cvEl.offsetHeight+'px';
    if(gcv.width!==cvEl.width||gcv.height!==cvEl.height){gcv.width=cvEl.width;gcv.height=cvEl.height}
    logicalW=cv._w||cvEl.offsetWidth;logicalH=cv._h||cvEl.offsetHeight;
    BULL=col('--bull','#2DBE8E');BEAR=col('--bear','#F0616D');
    if(CANDLE_SKIN==='muted'){BULL=BULL.map(function(v,i){return (v*255+(CANDLE_GREY[i]-v*255)*CANDLE_MUTE_T)/255});BEAR=BEAR.map(function(v,i){return (v*255+(CANDLE_GREY[i]-v*255)*CANDLE_MUTE_T)/255})}
    gl.viewport(0,0,gcv.width,gcv.height);
    gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  };
  GLR.candles=function(bars,x,y,cw,cv){
    if(!GLR.ok||!GLR.on||!bars.length)return;
    var n=bars.length,V=new Float32Array(n*12*5),o=0,hw=cw*0.34,ww=0.5;
    function quad(x0,y0,x1,y1,c){
      V[o++]=x0;V[o++]=y0;V[o++]=c[0];V[o++]=c[1];V[o++]=c[2];
      V[o++]=x1;V[o++]=y0;V[o++]=c[0];V[o++]=c[1];V[o++]=c[2];
      V[o++]=x0;V[o++]=y1;V[o++]=c[0];V[o++]=c[1];V[o++]=c[2];
      V[o++]=x0;V[o++]=y1;V[o++]=c[0];V[o++]=c[1];V[o++]=c[2];
      V[o++]=x1;V[o++]=y0;V[o++]=c[0];V[o++]=c[1];V[o++]=c[2];
      V[o++]=x1;V[o++]=y1;V[o++]=c[0];V[o++]=c[1];V[o++]=c[2];
    }
    for(var i=0;i<n;i++){var c=bars[i];var up=c.c>=c.o;var rgb=up?BULL:BEAR;var cx=x(i);
      quad(cx-ww,y(c.h),cx+ww,y(c.l),rgb);                                   /* wick */
      var bt=y(Math.max(c.o,c.c)),bb=y(Math.min(c.o,c.c));if(bb-bt<1)bb=bt+1;
      quad(cx-hw,bt,cx+hw,bb,rgb);                                           /* body */
    }
    gl.uniform2f(uR,logicalW,logicalH);
    gl.bufferData(gl.ARRAY_BUFFER,V,gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES,0,n*12);
  };
  GLR.set=function(v){GLR.on=!!(v&&GLR.ok);
    try{localStorage.setItem('mishel_gpu',GLR.on?'1':'0')}catch(e){}
    if(!GLR.on)gcv.style.display='none';
    var s=document.getElementById('setGpu');if(s)s.value=GLR.on?'1':'0';
    info();try{draw()}catch(e){}};
  /* restore preference (default ON when supported) */
  var saved=null;try{saved=localStorage.getItem('mishel_gpu')}catch(e){}
  GLR.set(saved==null?true:saved==='1');
  var sel=document.getElementById('setGpu');if(sel)sel.onchange=function(){GLR.set(sel.value==='1')};
  info();
}catch(e){}})();

/* ================= v13.3 GLASS wiring: fresh key (one-time reset to ON) + runtime detection ================= */
(function(){try{
  var sel=document.getElementById('setGlass');
  var supported=false;try{supported=(window.CSS&&(CSS.supports('backdrop-filter','blur(2px)')||CSS.supports('-webkit-backdrop-filter','blur(2px)')))}catch(e){}
  var saved=null;try{saved=localStorage.getItem('mishel_glass2')}catch(e){}   /* NEW key: old off-preference intentionally ignored once */
  function apply(v){document.body.classList.toggle('glass',!!v);
    try{localStorage.setItem('mishel_glass2',v?'1':'0')}catch(e){}
    if(sel){sel.value=v?'1':'0';sel.title=supported?'backdrop-filter: supported \u2713':'backdrop-filter NOT supported by this browser/GPU \u2014 glass cannot render'}}
  apply(saved==null?true:saved==='1');
  if(sel)sel.onchange=function(){apply(sel.value==='1')};
  if(!supported){try{toast('Glass unavailable: this browser/GPU does not support backdrop-filter \u2014 panels will stay solid','var(--gold)')}catch(e){}}
  /* visible state line in Settings, appended under gpuInfo without racing it */
  try{var gi=document.getElementById('gpuInfo');if(gi&&gi.parentElement&&!document.getElementById('glassInfo')){
    var d=document.createElement('div');d.id='glassInfo';d.style.cssText='font-size:10px;color:var(--muted2);grid-column:1/-1';
    d.textContent='Glass: '+(document.body.classList.contains('glass')?'ON':'OFF')+' \u00b7 backdrop-filter '+(supported?'supported \u2713':'NOT supported by this browser/GPU \u2717');
    gi.parentElement.insertBefore(d,gi.nextSibling);
    if(sel)sel.addEventListener('change',function(){d.textContent='Glass: '+(sel.value==='1'?'ON':'OFF')+' \u00b7 backdrop-filter '+(supported?'supported \u2713':'NOT supported \u2717')});}}catch(e){}
}catch(e){}})();
