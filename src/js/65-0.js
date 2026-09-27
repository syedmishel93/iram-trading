window.costLabel = function(){
  var sym=((typeof CURSYM!=='undefined'&&CURSYM.sym)||'').toUpperCase();
  var c=window.costModel(1, 1, 0);
  if(!c) return {txt:'costs: unknown', assumed:true};
  var sp=window.COSTSPEC[sym];
  return {
    txt: 'costs: '+c.source + (sp?'':' \u2014 run /svc/mt5/sync for the real ones'),
    assumed: c.assumed, source: c.source, spec: !!sp
  };
};


/* ---------------------------------------------------------------------
   2. THE ★ PICKER HONESTY GATE
   --------------------------------------------------------------------- */

/* Per-bar return matrix: one row per strategy, time-aligned, R per bar.
   This is exactly what cscvPBO() has always wanted and never been given. */
function _returnMatrix(d, keys){
  var M=[], used=[];
  for(var a=0;a<keys.length;a++){
    var k=keys[a], row=new Array(d.length).fill(0), traded=0;
    try{
      var sigs=sigScan(d,k);
      for(var b=0;b<sigs.length;b++){
        var s=sigs[b];
        if(s.res==='open') continue;
        var out=(s.res==='t2')?2:(s.res==='t1')?1:(s.res==='stop')?-1:0;
        if(typeof outR==='function'){ try{ out=outR(s) }catch(e){} }
        var idx=(s.rEnd!=null&&s.rEnd<d.length)?s.rEnd:s.i;
        row[idx]+= out-(s.costR||0);     /* NET of the real costs above */
        traded++;
      }
    }catch(e){ continue }
    if(traded>=3){ M.push(row); used.push(k) }
  }
  return {M:M, keys:used};
}

function _sharpe(r){
  if(!r||r.length<2) return 0;
  var m=r.reduce(function(a,x){return a+x},0)/r.length;
  var v=Math.sqrt(r.reduce(function(a,x){return a+(x-m)*(x-m)},0)/(r.length-1));
  return v>1e-12 ? m/v : 0;
}

/* THE VERDICT ON THE ★.
   Returns {promote, pbo, dsr, ci, why[]}. `promote:false` means the star is NOT shown.
   A refusal is a result. Silence is what a data-mining machine sounds like. */
window.pickerAudit = function(d, best, tf){
  var out={promote:false, pbo:null, dsr:null, ci:null, trials:0, why:[]};
  try{
    if(!d || d.length<240 || !best || !best.strat){
      out.why.push('Not enough history to audit a pick (need \u2265240 bars).');
      return out;
    }
    var keys=Object.keys(window.SIG_STRATS).filter(function(k){return k!=='ensemble'});
    var rm=_returnMatrix(d, keys);
    out.trials=rm.M.length;

    if(rm.M.length<2){
      out.why.push('Fewer than 2 strategies produced enough trades to audit. Nothing to compare against.');
      return out;
    }

    /* (a) PBO via CSCV — the probability that a pick this good is an artefact of the search */
    var pbo=null;
    try{ pbo=cscvPBO(rm.M, 10) }catch(e){}
    if(pbo && pbo.ok){ out.pbo=pbo.pbo; }

    /* (b) Deflated Sharpe — is the WINNER better than the best of N random tries? */
    var bi=rm.keys.indexOf(best.strat);
    if(bi>=0){
      var trialSRs=rm.M.map(_sharpe);
      var dsr=null;
      try{ dsr=deflatedSharpe(rm.M[bi], trialSRs, rm.M[bi].length) }catch(e){}
      if(dsr && dsr.ok) out.dsr=dsr.dsr;
    }

    /* (c) the pick's own OOS interval — does it even exclude zero? */
    var st=best.stats||{};
    if(st.resolved>0 && st.winPct!=null && typeof wilson==='function'){
      var w=wilson(Math.round(st.winPct/100*st.resolved), st.resolved);
      out.ci={lo:w.lo, hi:w.hi, n:st.resolved};
    }

    /* ---- the gate ---- */
    var fail=[];
    if(out.pbo!=null && out.pbo>0.5)
      fail.push('PBO '+(out.pbo*100).toFixed(0)+'% \u2014 a pick this good is MORE LIKELY THAN NOT '
        +'an artefact of searching '+out.trials+' strategies. This is what overfitting looks like from the inside.');
    if(out.dsr!=null && out.dsr<0.90)
      fail.push('Deflated Sharpe '+(out.dsr*100).toFixed(0)+'% \u2014 once you account for having tried '
        +out.trials+' strategies, this winner is not distinguishable from the best of '+out.trials+' coin flips.');
    if(out.ci && out.ci.n<20)
      fail.push('Only '+out.ci.n+' resolved trades. At this sample size the win-rate is nearly '
        +'uninformative \u2014 the 95% interval is '+(out.ci.lo*100).toFixed(0)+'\u2013'+(out.ci.hi*100).toFixed(0)+'%.');
    if(st.netAvgR!=null && st.netAvgR<=0)
      fail.push('Net expectancy '+st.netAvgR.toFixed(2)+'R after REAL costs. It does not pay to trade this.');

    if(fail.length){ out.promote=false; out.why=fail; return out; }

    out.promote=true;
    out.why.push('Survived the audit: PBO '+(out.pbo!=null?(out.pbo*100).toFixed(0)+'%':'n/a')
      +', deflated Sharpe '+(out.dsr!=null?(out.dsr*100).toFixed(0)+'%':'n/a')
      +' across '+out.trials+' trials, '+(out.ci?out.ci.n:'?')+' resolved trades. '
      +'This is not proof. It is the absence of the specific lie we know how to test for.');
    return out;
  }catch(e){
    out.why.push('Audit failed to run ('+e.message+') \u2014 so the \u2605 is withheld. '
      +'An unaudited pick is exactly the thing this gate exists to stop.');
    return out;
  }
};
/* =====================================================================
   v38.0 — (3) THE WITHHELD ★, VISIBLE   (4) THE PRE-MARKET RITUAL
   ===================================================================== */

/* ---------------------------------------------------------------------
   3a. When the picker refuses, SAY SO. Loudly, where the star used to be.
   A silent refusal is indistinguishable from a bug, and a system that goes
   quiet when it has nothing is a system you stop trusting when it speaks.
   --------------------------------------------------------------------- */
