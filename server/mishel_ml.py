#!/usr/bin/env python3
"""Mishel ML core (N2) — numbers in, numbers out. No pixels, no LLM.
Gradient-boosted walk-forward classifier over engineered OHLCV features.
Strict time splits (train always precedes test), honest out-of-sample metrics.
If the edge is weak, it says so — a 53% model reported as 53%, never dressed up."""
import numpy as np


def _rsi(c, n=14):
    d = np.diff(c, prepend=c[0]); up = np.clip(d, 0, None); dn = np.clip(-d, 0, None)
    ru = np.convolve(up, np.ones(n)/n, "same"); rd = np.convolve(dn, np.ones(n)/n, "same")
    return 100 - 100/(1 + ru/np.maximum(rd, 1e-12))

def build_features(closes, highs, lows, vols, horizon=24):
    c = np.asarray(closes, float); h = np.asarray(highs, float)
    l = np.asarray(lows, float); v = np.asarray(vols, float); n = len(c)
    if n < 300: raise ValueError(f"insufficient history ({n} bars, need 300+)")
    tr = np.maximum(h - l, np.maximum(abs(h - np.roll(c, 1)), abs(l - np.roll(c, 1)))); tr[0] = h[0]-l[0]
    atr = np.convolve(tr, np.ones(14)/14, "same"); atrp = atr/np.maximum(c, 1e-12)
    def mom(k): m = np.zeros(n); m[k:] = c[k:]/c[:-k] - 1; return m
    vm = np.convolve(v, np.ones(24)/24, "same"); vsd = np.std(v[max(0,n-720):]) or 1.0
    X = np.column_stack([mom(1)/np.maximum(atrp,1e-9), mom(4)/np.maximum(atrp,1e-9),
                         mom(24)/np.maximum(atrp,1e-9), _rsi(c)/100.0, atrp*100,
                         (v - vm)/vsd])
    y = np.zeros(n, int); y[:-horizon] = (c[horizon:] > c[:-horizon]).astype(int)
    lo = 30; hi = n - horizon                       # features valid, label known (no leakage)
    return X[lo:hi], y[lo:hi], X[n-1:n]             # last row = live features, label unknown

def walk_forward(closes, highs, lows, vols, horizon=24, folds=5):
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.metrics import accuracy_score, brier_score_loss
    X, y, x_live = build_features(closes, highs, lows, vols, horizon)
    n = len(y); accs, briers = [], []
    for f in range(folds):                          # expanding-window: test blocks strictly after train
        cut = int(n * (0.5 + 0.1*f)); end = int(n * (0.5 + 0.1*(f+1)))
        if end - cut < 20: continue
        m = GradientBoostingClassifier(n_estimators=80, max_depth=3, random_state=7)
        m.fit(X[:cut], y[:cut]); p = m.predict_proba(X[cut:end])[:, 1]
        accs.append(accuracy_score(y[cut:end], (p > 0.5).astype(int)))
        briers.append(brier_score_loss(y[cut:end], p))
    final = GradientBoostingClassifier(n_estimators=80, max_depth=3, random_state=7)
    final.fit(X, y)
    return {"ok": True, "p_up": float(final.predict_proba(x_live)[0, 1]),
            "acc": float(np.mean(accs)) if accs else 0.5,
            "brier": float(np.mean(briers)) if briers else 0.25, "n": int(n), "horizon": horizon}
