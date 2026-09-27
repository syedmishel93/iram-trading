// Functional test of C2 candle-mute logic — 2D vs GPU parity + boundary correctness.
const CANDLE_GREY=[126,138,158], CANDLE_MUTE_T=0.34;

// ---- 2D path (as patched into var_bull/var_bear) ----
function _hex2rgb(x){x=(x||'').trim();let m=x.match(/^#([0-9a-f]{3})$/i);if(m)return[parseInt(m[1][0]+m[1][0],16),parseInt(m[1][1]+m[1][1],16),parseInt(m[1][2]+m[1][2],16)];m=x.match(/^#([0-9a-f]{6})/i);if(m)return[parseInt(m[1].slice(0,2),16),parseInt(m[1].slice(2,4),16),parseInt(m[1].slice(4,6),16)];m=x.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);if(m)return[+m[1],+m[2],+m[3]];return null}
function _muteRGB(rgb){return[Math.round(rgb[0]+(CANDLE_GREY[0]-rgb[0])*CANDLE_MUTE_T),Math.round(rgb[1]+(CANDLE_GREY[1]-rgb[1])*CANDLE_MUTE_T),Math.round(rgb[2]+(CANDLE_GREY[2]-rgb[2])*CANDLE_MUTE_T)]}
function twoD_mute(hex){const rgb=_hex2rgb(hex);const m=_muteRGB(rgb);return m;}

// ---- GPU path (as patched into GLR.begin) — works in 0..1 ----
function col(hex){const m=hex.match(/^#([0-9a-f]{6})/i);return[parseInt(m[1].slice(0,2),16)/255,parseInt(m[1].slice(2,4),16)/255,parseInt(m[1].slice(4,6),16)/255];}
function gpu_mute(hex){let c=col(hex);return c.map((v,i)=>(v*255+(CANDLE_GREY[i]-v*255)*CANDLE_MUTE_T)/255);}

let pass=0,fail=0;
function assert(cond,msg){if(cond){pass++}else{fail++;console.log("  FAIL:",msg)}}

// Test 1: 2D and GPU produce the SAME color (within rounding) for every theme's bull/bear
const themes={
  midnight:['#2DBE8E','#F0616D'], binance:['#0ECB81','#F6465D'],
  tradingview:['#26A69A','#EF5350'], trendspider:['#22C55E','#EF4444'],
  light:['#12A67A','#E0455A'], oled:['#00D68F','#FF5C6C'], frost:['#5FB8A6','#D08691']
};
for(const [name,[bull,bear]] of Object.entries(themes)){
  for(const hex of [bull,bear]){
    const a=twoD_mute(hex);                       // [0..255] ints
    const g=gpu_mute(hex).map(v=>Math.round(v*255)); // 0..1 -> [0..255]
    assert(a[0]===g[0]&&a[1]===g[1]&&a[2]===g[2], `${name} ${hex}: 2D=${a} GPU=${g}`);
  }
}

// Test 2: muting moves toward grey (each channel between base and grey, distance reduced)
for(const [name,[bull]] of Object.entries(themes)){
  const base=_hex2rgb(bull), m=twoD_mute(bull);
  for(let i=0;i<3;i++){
    const d0=Math.abs(CANDLE_GREY[i]-base[i]), d1=Math.abs(CANDLE_GREY[i]-m[i]);
    assert(d1<=d0, `${name} ch${i} not moved toward grey (d0=${d0} d1=${d1})`);
  }
}

// Test 3: exact expected value for the default midnight bull (regression anchor)
const mb=twoD_mute('#2DBE8E'); // 45,190,142
// r:45+(126-45)*.34=72.5->73 ; g:190+(138-190)*.34=172.3->172 ; b:142+(158-142)*.34=147.4->147
assert(mb[0]===73&&mb[1]===172&&mb[2]===147, `midnight bull mute expected [73,172,147] got [${mb}]`);
const mr=twoD_mute('#F0616D'); // 240,97,109
// r:240+(126-240)*.34=201.2->201 ; g:97+(138-97)*.34=110.9->111 ; b:109+(158-109)*.34=125.7->126
assert(mr[0]===201&&mr[1]===111&&mr[2]===126, `midnight bear mute expected [201,111,126] got [${mr}]`);

// Test 4: vivid path (skin!=='muted') returns base untouched — simulate _candleTint
function _candleTint(base,skin){if(skin!=='muted')return base;const rgb=_hex2rgb(base);if(!rgb)return base;const m=_muteRGB(rgb);return 'rgb('+m[0]+','+m[1]+','+m[2]+')';}
assert(_candleTint('#2DBE8E','vivid')==='#2DBE8E','vivid returns base');
assert(_candleTint('#2DBE8E','muted')==='rgb(73,172,147)','muted returns rgb string');

// Test 5: bad input safety — non-color returns null in _hex2rgb, tint returns base
assert(_hex2rgb('none')===null,'_hex2rgb bad input -> null');
assert(_candleTint('not-a-color','muted')==='not-a-color','tint bad input returns base unchanged');

// Test 6: aurora level map is coherent (mirrors boot IIFE)
const AUR={off:0,subtle:.4,balanced:.75,vivid:1};
assert(AUR.off<AUR.subtle&&AUR.subtle<AUR.balanced&&AUR.balanced<AUR.vivid,'aurora levels monotonic');
assert(AUR.off===0&&AUR.vivid===1,'aurora bounds 0..1');

console.log(`\nC2/T2 LOGIC TESTS: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
