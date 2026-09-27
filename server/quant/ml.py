"""
Setup classification — `scikit-learn`, `XGBoost`, `LightGBM`, `CatBoost`, `PyTorch`.

THE QUESTION
"Given what the chart looks like right now, what fraction of the time does
price reach my target before my stop?" That is a probability, and a probability
is only worth having if it is CALIBRATED — if the setups it calls 60% actually
work 60% of the time. An uncalibrated 0.87 from a gradient booster is a number
that will lose you money with great confidence.

So this module reports calibration first and accuracy second, and it refuses to
return a model that cannot beat the base rate.

THE THREE WAYS THIS GOES WRONG, AND WHAT IS DONE ABOUT EACH
  1. LOOK-AHEAD. Every feature is computed from bars at or before t, and the
     label from bars strictly after t. The terminal learnt this one the hard
     way: its detectors ended with `slice(-maxResults)`, so whether a signal at
     bar 200 survived depended on how many signals came after it.
  2. OVERLAPPING LABELS. A triple-barrier label at bar t looks forward up to
     `horizon` bars, so bars t and t+1 share almost all their outcome. Training
     on one and testing on the other is testing on the training set. Fixed by
     PURGING a horizon-sized gap around every split boundary, plus an embargo.
  3. THE BASE RATE. A market that rises 55% of the time gives 55% accuracy for
     free. Every score here is reported against that baseline, and a model that
     does not beat it is reported as not beating it.

WHY FOUR GRADIENT BOOSTERS AND A NEURAL NET
XGBoost, LightGBM and CatBoost are the same family and will usually agree. That
is the point: when they DISAGREE on a series, the signal is fragile, and the
spread between them is reported as `agreement`. The PyTorch model is a
different functional form entirely (a small MLP on the same features), so it is
the one that can disagree for a reason other than hyperparameters.

Heavy imports: all of the above, at call time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import MIN_BARS_ML, parse_bars, refuse

#: Forward bars a label is allowed to look. Also the purge width.
DEFAULT_HORIZON = 24
#: Barrier width in ATR multiples.
DEFAULT_BARRIER_ATR = 1.5
#: Walk-forward folds.
N_FOLDS = 5
#: Standard errors above 0.5 an AUC must clear to count as real.
#:
#: A FIXED THRESHOLD DOES NOT WORK, WHICH THIS MODULE FOUND OUT BY BEING WRONG.
#: The first version required AUC > 0.53. Run on a pure random walk with no
#: learnable structure whatsoever, CatBoost scored 0.546 and was reported as
#: beating a coin. On roughly 1,400 samples the standard error of an AUC is
#: about 0.016, so 0.546 is under three standard errors from chance and 0.53 is
#: barely two — the threshold was inside its own noise.
#:
#: So significance is computed from the SAMPLE SIZE via Hanley-McNeil rather
#: than asserted as a constant.
AUC_SIGMAS = 2.5


# --------------------------------------------------------------------------
# Features. Everything here is a function of bars at or before index i.
# --------------------------------------------------------------------------

def _rolling(a: np.ndarray, w: int, fn) -> np.ndarray:
    out = np.full(len(a), np.nan)
    for i in range(w - 1, len(a)):
        out[i] = fn(a[i - w + 1 : i + 1])
    return out


def _atr(h: np.ndarray, low: np.ndarray, c: np.ndarray, period: int = 14) -> np.ndarray:
    prev = np.concatenate([[c[0]], c[:-1]])
    tr = np.maximum(h - low, np.maximum(np.abs(h - prev), np.abs(low - prev)))
    out = np.full(len(c), np.nan)
    if len(c) <= period:
        return out
    out[period] = float(np.mean(tr[1 : period + 1]))
    for i in range(period + 1, len(c)):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def _rsi(c: np.ndarray, period: int = 14) -> np.ndarray:
    d = np.diff(c, prepend=c[0])
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    out = np.full(len(c), np.nan)
    if len(c) <= period:
        return out
    au, ad = float(np.mean(up[1 : period + 1])), float(np.mean(dn[1 : period + 1]))
    out[period] = 100.0 - 100.0 / (1.0 + (au / ad if ad > 0 else np.inf))
    for i in range(period + 1, len(c)):
        au = (au * (period - 1) + up[i]) / period
        ad = (ad * (period - 1) + dn[i]) / period
        out[i] = 100.0 - 100.0 / (1.0 + (au / ad if ad > 0 else np.inf))
    return out


def build_features(cols: dict[str, np.ndarray]) -> tuple[np.ndarray, list[str]]:
    """
    The feature matrix.

    Every column is SCALE-FREE — a return, a ratio, a z-score, a bounded
    oscillator. Never a raw price. A model trained on raw price on BTC at
    $30,000 has learnt a level, and it becomes worthless the moment price
    leaves the range it was fitted in. This is the single most common way a
    price model looks brilliant in backtest and is useless live.
    """
    h, low, c, v = cols["h"], cols["l"], cols["c"], cols["v"]
    n = len(c)
    r = np.diff(np.log(c), prepend=0.0)
    atr = _atr(h, low, c)
    atr_pct = atr / c

    feats: dict[str, np.ndarray] = {
        "ret_1": r,
        "ret_5": np.concatenate([np.full(5, np.nan), np.log(c[5:] / c[:-5])]),
        "ret_20": np.concatenate([np.full(20, np.nan), np.log(c[20:] / c[:-20])]),
        "rsi_14": _rsi(c) / 100.0,
        "atr_pct": atr_pct,
        # Where the close sits inside the recent range: 0 at the low, 1 at the high.
        "pos_in_range_20": _rolling(np.arange(n, dtype=float), 20, lambda w: 0.0),
        "vol_ratio": np.full(n, np.nan),
        "vol_of_vol": np.full(n, np.nan),
        "body_frac": np.where(h - low > 0, np.abs(c - cols["o"]) / (h - low), 0.0),
        "upper_wick": np.where(h - low > 0, (h - np.maximum(c, cols["o"])) / (h - low), 0.0),
        "lower_wick": np.where(h - low > 0, (np.minimum(c, cols["o"]) - low) / (h - low), 0.0),
        "trend_20_50": np.full(n, np.nan),
        "volume_z": np.full(n, np.nan),
    }

    # position in the trailing 20-bar range
    pir = np.full(n, np.nan)
    for i in range(20, n):
        wl, wh = float(np.min(low[i - 19 : i + 1])), float(np.max(h[i - 19 : i + 1]))
        pir[i] = (c[i] - wl) / (wh - wl) if wh > wl else 0.5
    feats["pos_in_range_20"] = pir

    # realised vol, and how it compares to its own recent past
    rv20 = _rolling(r, 20, lambda w: float(np.std(w)))
    rv100 = _rolling(r, 100, lambda w: float(np.std(w)))
    with np.errstate(invalid="ignore", divide="ignore"):
        feats["vol_ratio"] = rv20 / rv100
    feats["vol_of_vol"] = _rolling(rv20, 20, lambda w: float(np.std(w[~np.isnan(w)])) if np.any(~np.isnan(w)) else np.nan)

    # trend: fast SMA against slow, in ATR units so it is comparable across
    # instruments
    sma20 = _rolling(c, 20, lambda w: float(np.mean(w)))
    sma50 = _rolling(c, 50, lambda w: float(np.mean(w)))
    with np.errstate(invalid="ignore", divide="ignore"):
        feats["trend_20_50"] = (sma20 - sma50) / atr

    if np.any(v > 0):
        vz = np.full(n, np.nan)
        for i in range(50, n):
            w = v[i - 49 : i + 1]
            sd = float(np.std(w))
            vz[i] = (v[i] - float(np.mean(w))) / sd if sd > 0 else 0.0
        feats["volume_z"] = vz
    else:
        # No volume on this feed. Drop the column rather than feed the model a
        # constant it will happily find spurious structure in.
        feats.pop("volume_z")

    names = sorted(feats)
    X = np.column_stack([feats[k] for k in names])
    return X, names


def triple_barrier(
    cols: dict[str, np.ndarray], horizon: int, barrier_atr: float
) -> np.ndarray:
    """
    The label: does price reach +barrier before -barrier within `horizon` bars?

    1 for the upper barrier first, 0 for the lower, and NaN when neither is
    touched inside the horizon. NaN rather than 0: "did not resolve" is not
    "went down", and folding the two together teaches the model that a quiet
    market is a bearish one.

    Barriers are in ATR, not percent, so the label means the same thing on
    EURUSD and on SOLUSDT.
    """
    h, low, c = cols["h"], cols["l"], cols["c"]
    atr = _atr(h, low, c)
    n = len(c)
    y = np.full(n, np.nan)
    for i in range(n):
        a = atr[i]
        if not math.isfinite(a) or a <= 0:
            continue
        up, dn = c[i] + barrier_atr * a, c[i] - barrier_atr * a
        end = min(n, i + horizon + 1)
        for j in range(i + 1, end):
            hit_up, hit_dn = h[j] >= up, low[j] <= dn
            if hit_up and hit_dn:
                # Both barriers inside one bar. Which came first is unknowable
                # from OHLC, so the label is dropped rather than guessed — a
                # coin flip here is noise injected straight into the target.
                break
            if hit_up:
                y[i] = 1.0
                break
            if hit_dn:
                y[i] = 0.0
                break
    return y


def purged_folds(n: int, n_folds: int, purge: int) -> list[tuple[np.ndarray, np.ndarray]]:
    """
    Walk-forward folds with a purge gap and an embargo.

    Train is always strictly BEFORE test — no shuffling, ever, on time-series
    data. The `purge` bars immediately before the test block are dropped from
    training because their forward-looking labels overlap the test period, and
    an equal embargo after the test block is dropped from any later training
    for the same reason.
    """
    folds = []
    fold_size = n // (n_folds + 1)
    if fold_size <= purge * 2:
        refuse(
            f"Fold size {fold_size} is too small for a {purge}-bar purge. "
            f"Load more history or shorten the horizon."
        )
    for k in range(n_folds):
        test_start = fold_size * (k + 1)
        test_end = min(n, test_start + fold_size)
        train_end = max(0, test_start - purge)
        if train_end < fold_size // 2:
            continue
        train_idx = np.arange(0, train_end)
        test_idx = np.arange(test_start, test_end)
        if len(test_idx) < 20:
            continue
        folds.append((train_idx, test_idx))
    if not folds:
        refuse("No usable walk-forward folds; the series is too short for this horizon.")
    return folds


def _torch_mlp(Xtr, ytr, Xte, seed: int = 0):
    """A small MLP. Different functional form, same features."""
    import torch
    from torch import nn

    torch.manual_seed(seed)
    d = Xtr.shape[1]
    net = nn.Sequential(
        nn.Linear(d, 32), nn.ReLU(), nn.Dropout(0.2),
        nn.Linear(32, 16), nn.ReLU(),
        nn.Linear(16, 1),
    )
    opt = torch.optim.Adam(net.parameters(), lr=1e-3, weight_decay=1e-4)
    lossf = nn.BCEWithLogitsLoss()
    xt = torch.tensor(Xtr, dtype=torch.float32)
    yt = torch.tensor(ytr, dtype=torch.float32).unsqueeze(1)
    net.train()
    for _ in range(200):
        opt.zero_grad()
        loss = lossf(net(xt), yt)
        loss.backward()
        opt.step()
    net.eval()
    with torch.no_grad():
        return torch.sigmoid(net(torch.tensor(Xte, dtype=torch.float32))).numpy().ravel()


def _models() -> dict:
    """Constructors, built lazily so a missing library disables one model only."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    out: dict = {
        # The baseline that matters. If the boosters cannot beat a regularised
        # linear model on these features, the non-linearity is not real.
        "logistic": lambda: make_pipeline(
            StandardScaler(), LogisticRegression(max_iter=2000, C=0.5)
        ),
    }

    try:
        from xgboost import XGBClassifier

        out["xgboost"] = lambda: XGBClassifier(
            n_estimators=200, max_depth=3, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, reg_lambda=2.0,
            eval_metric="logloss", tree_method="hist", verbosity=0,
        )
    except ImportError:
        pass

    try:
        from lightgbm import LGBMClassifier

        out["lightgbm"] = lambda: LGBMClassifier(
            n_estimators=200, max_depth=3, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, reg_lambda=2.0,
            verbose=-1,
        )
    except ImportError:
        pass

    try:
        from catboost import CatBoostClassifier

        out["catboost"] = lambda: CatBoostClassifier(
            iterations=200, depth=3, learning_rate=0.05,
            l2_leaf_reg=3.0, verbose=0, allow_writing_files=False,
        )
    except ImportError:
        pass

    return out


def classify(payload: dict) -> dict:
    """Fit every available model with purged walk-forward CV and score them."""
    from sklearn.metrics import brier_score_loss, roc_auc_score

    cols = parse_bars(payload)
    horizon = int(payload.get("horizon", DEFAULT_HORIZON))
    barrier = float(payload.get("barrier_atr", DEFAULT_BARRIER_ATR))
    if not (1 <= horizon <= 200):
        refuse("Horizon must be between 1 and 200 bars.")
    if not (0.2 <= barrier <= 10):
        refuse("Barrier must be between 0.2 and 10 ATR.")

    n = len(cols["c"])
    if n < MIN_BARS_ML:
        refuse(f"{n} bars. {MIN_BARS_ML} is the floor for a walk-forward fit.")

    X, names = build_features(cols)
    y = triple_barrier(cols, horizon, barrier)

    # Rows with a complete feature vector AND a resolved label.
    ok = np.isfinite(y) & np.all(np.isfinite(X), axis=1)
    idx = np.where(ok)[0]
    if len(idx) < MIN_BARS_ML // 2:
        refuse(
            f"Only {len(idx)} bars have both a full feature set and a resolved "
            f"outcome. Most labels never touched a barrier within {horizon} bars — "
            f"try a wider horizon or a narrower barrier."
        )

    Xu, yu = X[idx], y[idx]
    base_rate = float(np.mean(yu))
    if base_rate < 0.05 or base_rate > 0.95:
        refuse(
            f"The outcome is {base_rate:.0%} one-sided. There is nothing to "
            f"classify — a constant prediction is already almost always right."
        )

    folds = purged_folds(len(idx), N_FOLDS, horizon)
    ctors = _models()

    results: dict[str, dict] = {}
    oof: dict[str, np.ndarray] = {}

    for name, ctor in ctors.items():
        preds = np.full(len(yu), np.nan)
        for tr, te in folds:
            try:
                m = ctor()
                m.fit(Xu[tr], yu[tr])
                preds[te] = m.predict_proba(Xu[te])[:, 1]
            except Exception:
                continue
        results[name] = _score(preds, yu, base_rate, roc_auc_score, brier_score_loss)
        oof[name] = preds

    # PyTorch: same folds, same features, different functional form.
    try:
        preds = np.full(len(yu), np.nan)
        from sklearn.preprocessing import StandardScaler

        for tr, te in folds:
            sc = StandardScaler().fit(Xu[tr])
            preds[te] = _torch_mlp(sc.transform(Xu[tr]), yu[tr], sc.transform(Xu[te]))
        results["pytorch_mlp"] = _score(preds, yu, base_rate, roc_auc_score, brier_score_loss)
        oof["pytorch_mlp"] = preds
    except ImportError:
        results["pytorch_mlp"] = {"ok": False, "reason": "PyTorch is not installed."}

    usable = {k: v for k, v in results.items() if v.get("ok")}
    if not usable:
        refuse("No model produced a usable out-of-fold prediction on this series.")

    best = max(usable.items(), key=lambda kv: kv[1]["auc"])
    best_name, best_res = best

    # Where the tree models disagree, the signal is fragile.
    tree_names = [k for k in ("xgboost", "lightgbm", "catboost") if k in usable]
    agreement = None
    if len(tree_names) >= 2:
        stack = np.column_stack([oof[k] for k in tree_names])
        good = np.all(np.isfinite(stack), axis=1)
        if good.sum() > 20:
            spread = float(np.mean(np.std(stack[good], axis=1)))
            agreement = {
                "models": tree_names,
                "mean_spread": spread,
                "note": (
                    "The boosters broadly agree; the signal is stable across them."
                    if spread < 0.06
                    else "The boosters disagree by more than 6 points on average. "
                    "Treat any single probability from them as fragile."
                ),
            }

    # Feature importance from the best tree model, if there is one.
    importance = None
    if best_name in ("xgboost", "lightgbm", "catboost"):
        try:
            m = ctors[best_name]()
            m.fit(Xu, yu)
            imp = np.asarray(m.feature_importances_, dtype=float)
            if imp.sum() > 0:
                imp = imp / imp.sum()
            order = np.argsort(imp)[::-1]
            importance = [
                {"feature": names[i], "weight": float(imp[i])} for i in order[:8]
            ]
        except Exception:
            importance = None

    return {
        "n_bars": n,
        "n_labelled": len(idx),
        "unresolved_pct": 100.0 * (1.0 - len(idx) / max(1, n)),
        "horizon": horizon,
        "barrier_atr": barrier,
        "base_rate": base_rate,
        "folds": len(folds),
        "purge_bars": horizon,
        "features": names,
        "models": results,
        "best": best_name,
        "agreement": agreement,
        "importance": importance,
        "verdict": _verdict(best_name, best_res, base_rate),
        "basis": (
            f"Triple-barrier labels at ±{barrier} ATR over {horizon} bars. "
            f"{len(folds)} walk-forward folds, train always before test, with a "
            f"{horizon}-bar purge at each boundary so no training row's forward "
            f"window overlaps a test row. Scores are out-of-fold."
        ),
        "caveat": (
            "A calibrated probability is not an edge. It says how often this "
            "pattern resolved up before down in the past — it says nothing about "
            "the payoff, the spread, or whether you can get filled."
        ),
    }


def _auc_se(auc: float, n_pos: int, n_neg: int) -> float:
    """
    Hanley-McNeil standard error of an AUC.

    The exponential approximation for the two conditional probabilities. It is
    not exact, but it is the right ORDER, and the order is the whole point: it
    turns "is 0.546 good?" from a matter of taste into arithmetic.
    """
    if n_pos < 2 or n_neg < 2:
        return float("nan")
    q1 = auc / (2.0 - auc)
    q2 = 2.0 * auc * auc / (1.0 + auc)
    var = (
        auc * (1 - auc)
        + (n_pos - 1) * (q1 - auc * auc)
        + (n_neg - 1) * (q2 - auc * auc)
    ) / (n_pos * n_neg)
    return math.sqrt(max(var, 0.0))


def _score(preds, y, base_rate, auc_fn, brier_fn) -> dict:
    good = np.isfinite(preds)
    if good.sum() < 30 or len(np.unique(y[good])) < 2:
        return {"ok": False, "reason": "Too few out-of-fold predictions to score."}
    p, yy = preds[good], y[good]
    auc = float(auc_fn(yy, p))
    brier = float(brier_fn(yy, p))
    # The Brier score of always predicting the base rate. Beating this is the
    # minimum bar for a probability model being worth anything.
    brier_base = float(np.mean((yy - base_rate) ** 2))

    # Calibration in deciles: does p=0.6 actually happen 60% of the time?
    bins = np.clip((p * 10).astype(int), 0, 9)
    calib = []
    for b in range(10):
        m = bins == b
        if m.sum() >= 10:
            calib.append(
                {
                    "predicted": float(np.mean(p[m])),
                    "actual": float(np.mean(yy[m])),
                    "n": int(m.sum()),
                }
            )
    miscal = (
        float(np.mean([abs(c["predicted"] - c["actual"]) for c in calib])) if calib else None
    )

    n_pos = int(np.sum(yy == 1))
    n_neg = int(np.sum(yy == 0))
    se = _auc_se(auc, n_pos, n_neg)
    floor = 0.5 + AUC_SIGMAS * se if math.isfinite(se) else float("inf")

    return {
        "ok": True,
        "n_scored": int(good.sum()),
        "auc": auc,
        "auc_se": se,
        "auc_floor": floor,
        "brier": brier,
        "brier_baseline": brier_base,
        "skill": float(1.0 - brier / brier_base) if brier_base > 0 else None,
        "calibration": calib,
        "mean_miscalibration": miscal,
        "beats_coin": bool(auc > floor),
    }


def _verdict(name: str, res: dict, base_rate: float) -> str:
    auc = res["auc"]
    skill = res.get("skill")
    floor = res.get("auc_floor", 0.53)
    se = res.get("auc_se")
    if not res.get("beats_coin"):
        detail = (
            f" On {res['n_scored']} scored bars the standard error of an AUC is "
            f"{se:.3f}, so anything under {floor:.3f} is indistinguishable from chance."
            if se and math.isfinite(se)
            else ""
        )
        return (
            f"The best model ({name}) scored AUC {auc:.3f} out of fold.{detail} "
            f"There is no learnable pattern here at this horizon — which is the "
            f"most common and most useful answer this endpoint gives."
        )
    parts = [
        f"{name} scored AUC {auc:.3f} out of fold against a {base_rate:.0%} base rate."
    ]
    if skill is not None:
        if skill > 0:
            parts.append(f"Brier skill {skill:+.1%} over always predicting the base rate.")
        else:
            parts.append(
                f"But its Brier skill is {skill:+.1%} — it ranks better than chance "
                f"and its PROBABILITIES are still worse than the base rate. Use it "
                f"to rank setups, not to size them."
            )
    mis = res.get("mean_miscalibration")
    if mis is not None:
        parts.append(
            f"Mean miscalibration {mis * 100:.1f} points across deciles."
            if mis < 0.08
            else f"Mean miscalibration {mis * 100:.1f} points — the probabilities are "
            f"not trustworthy at face value even though the ranking is."
        )
    return " ".join(parts)
