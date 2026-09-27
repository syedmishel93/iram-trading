"""The router — a model over the candidate ledger, and whether it knows anything.

WHAT THIS IS, AND THE TWO THINGS IT REFUSES TO DO

The brief routes on ``P(win) >= 62%``. That number is meaningless until two
separate things are true, and neither happens by itself:

1. **The model must beat the base rate.** A classifier that predicts the
   majority class for every row scores the base rate exactly and has learned
   nothing. "58% accurate" on a sample that is 58% winners is a report of
   nothing, and it is the single easiest way for a router to look like it works.
   So `skill` is a separate field from `accuracy`, and it is False unless the
   model beats the base rate out of sample by more than its own noise.

2. **The score must be a probability.** A gradient booster emits a score, not a
   chance. Thresholding an uncalibrated score at 0.62 is thresholding a rank.
   So the model is calibrated, and the RELIABILITY CURVE is reported — "in the
   bucket where it said 0.60 it actually won 0.59 of the time, n=140" — which is
   a threshold you can choose. A constant is not.

THE SPLIT IS TIME-ORDERED, ALWAYS
A random train/test split on a time series puts June in train and May in test,
so the model is scored on a past it has already seen. Every metric inflates and
nothing looks wrong. Folds here are contiguous and forward-only, and
`foldSpans` publishes the boundaries so a caller can check rather than trust.

WHY SKLEARN AND NOT LIGHTGBM
`HistGradientBoostingClassifier` is sklearn's own histogram gradient booster —
the same family, already installed, and no new dependency for the frozen build,
where lightgbm and xgboost are excluded on size (~200 MB). MEASURED in this
checkout: sklearn 1.9.1 present, lightgbm and xgboost absent.
"""

from __future__ import annotations

import math
from typing import Any

from flask import Blueprint, jsonify, request

bp = Blueprint("router", __name__)

try:
    import numpy as np
    from sklearn.calibration import CalibratedClassifierCV
    from sklearn.ensemble import HistGradientBoostingClassifier

    HAVE_SKLEARN = True
except Exception:  # pragma: no cover - exercised only where sklearn is absent
    HAVE_SKLEARN = False


#: Below this a fit is noise fitted to noise, whatever it scores.
MIN_ROWS = 200

#: Buckets across [0, 1] for the reliability curve.
CAL_BUCKETS = 10


def _refuse(why: str) -> dict[str, Any]:
    return {
        "ok": False,
        "why": why,
        "rows": 0,
        "scored": 0,
        "auc": 0.5,
        "accuracy": 0.0,
        "baseRate": 0.0,
        "lift": 0.0,
        "skill": False,
        "folds": 0,
        "timeOrdered": True,
        "foldSpans": [],
        "calibration": [],
        "suggestedThreshold": 0.0,
        "thresholdBasis": "none",
        "features": [],
    }


def _auc(y_true: np.ndarray, score: np.ndarray) -> float:
    """Rank-based AUC. Ties share their average rank, as they must."""
    n1 = float((y_true == 1).sum())
    n0 = float((y_true == 0).sum())
    if n1 == 0 or n0 == 0:
        return 0.5
    order = np.argsort(score, kind="mergesort")
    ranks = np.empty(len(score), dtype=float)
    ranks[order] = np.arange(1, len(score) + 1, dtype=float)
    # Average the ranks of tied scores, or a constant predictor scores 1.0.
    s_sorted = score[order]
    i = 0
    while i < len(s_sorted):
        j = i
        while j + 1 < len(s_sorted) and s_sorted[j + 1] == s_sorted[i]:
            j += 1
        if j > i:
            ranks[order[i : j + 1]] = ranks[order[i : j + 1]].mean()
        i = j + 1
    return float((ranks[y_true == 1].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def train_router(
    candidates: list[dict[str, Any]],
    *,
    min_rows: int = MIN_ROWS,
    folds: int = 5,
) -> dict[str, Any]:
    """Fit and SCORE a router over candidates, out of sample and in time order.

    `candidates` are rows from the ledger: ``t``, ``features`` (a flat mapping
    of name to number), ``outcome`` (``target`` / ``stop`` / ``timeout``).

    A TIMEOUT IS NOT A TRAINING ROW. It is neither a win nor a loss, and calling
    it a loss teaches the model that a quiet market looks like a mistake — the
    ledger's own rule, one layer up.
    """
    if not HAVE_SKLEARN:
        return _refuse("scikit-learn is not installed, so no router can be fitted here")

    rows = [c for c in candidates if c.get("outcome") in ("target", "stop")]
    rows.sort(key=lambda c: c.get("t", 0))
    if len(rows) < min_rows:
        return _refuse(
            f"{len(rows)} decided rows is below the {min_rows} this will fit on — "
            "a model under that is noise fitted to noise whatever it scores"
        )

    names = sorted({k for c in rows for k in (c.get("features") or {})})
    if not names:
        return _refuse("no features on the candidates, so there is nothing to learn from")

    X = np.array(
        [[float((c.get("features") or {}).get(n, 0.0)) for n in names] for c in rows],
        dtype=float,
    )
    y = np.array([1 if c["outcome"] == "target" else 0 for c in rows], dtype=int)

    if y.min() == y.max():
        return _refuse("every decided row has the same class, so there are no two classes to separate")

    base_rate = float(y.mean())
    base_major = max(base_rate, 1.0 - base_rate)

    # ---------------------------------------------------------- time folds --
    # Contiguous, forward-only. Fold k trains on everything before its test
    # block and scores only that block, so no row is ever scored by a model
    # that has seen its future.
    n = len(rows)
    folds = max(3, min(folds, n // 100 if n >= 300 else 3))
    block = n // (folds + 1)
    if block < 20:
        return _refuse("too few rows to cut into forward-only folds without tiny blocks")

    oof_score = np.full(n, np.nan, dtype=float)
    spans: list[dict[str, int]] = []

    for k in range(folds):
        train_end = block * (k + 1)
        test_end = min(n, train_end + block)
        if test_end <= train_end:
            break
        Xtr, ytr = X[:train_end], y[:train_end]
        if ytr.min() == ytr.max():
            continue  # this prefix has one class; nothing to fit yet
        Xte = X[train_end:test_end]

        clf = HistGradientBoostingClassifier(
            max_iter=200,
            learning_rate=0.06,
            max_leaf_nodes=15,
            min_samples_leaf=20,
            l2_regularization=1.0,
            random_state=0,
        )
        # Calibrated so the output is a PROBABILITY rather than a score. The
        # inner CV is over the training prefix only, which keeps the forward
        # guarantee intact.
        inner = min(3, int(ytr.sum()), int((ytr == 0).sum()))
        model: Any = clf
        if inner >= 2:
            model = CalibratedClassifierCV(clf, method="isotonic", cv=inner)
        model.fit(Xtr, ytr)
        oof_score[train_end:test_end] = model.predict_proba(Xte)[:, 1]

        spans.append(
            {
                "trainFrom": int(rows[0]["t"]),
                "trainTo": int(rows[train_end - 1]["t"]),
                "testFrom": int(rows[train_end]["t"]),
                "testTo": int(rows[test_end - 1]["t"]),
                "trainRows": int(train_end),
                "testRows": int(test_end - train_end),
            }
        )

    mask = ~np.isnan(oof_score)
    scored = int(mask.sum())
    if scored < 50:
        return _refuse("too few rows were scored out of sample to judge the model")

    ys, ss = y[mask], oof_score[mask]
    auc = _auc(ys, ss)
    acc = float(((ss >= 0.5).astype(int) == ys).mean())
    lift = acc - base_major

    # SKILL IS A SEPARATE QUESTION FROM ACCURACY. The standard error of an AUC
    # near 0.5 over `scored` rows is about 1/sqrt(12 n); two of those is the
    # bar, and accuracy has to beat the majority class as well.
    se = 1.0 / math.sqrt(12.0 * max(1, scored))
    skill = bool(auc - 0.5 > 2.0 * se and lift > 0.0)

    # --------------------------------------------------------- calibration --
    cal: list[dict[str, Any]] = []
    edges = np.linspace(0.0, 1.0, CAL_BUCKETS + 1)
    for b in range(CAL_BUCKETS):
        lo, hi = edges[b], edges[b + 1]
        sel = (ss >= lo) & (ss < hi) if b < CAL_BUCKETS - 1 else (ss >= lo) & (ss <= hi)
        cnt = int(sel.sum())
        cal.append(
            {
                "from": float(lo),
                "to": float(hi),
                "n": cnt,
                "predicted": float(ss[sel].mean()) if cnt else float((lo + hi) / 2),
                "observed": float(ys[sel].mean()) if cnt else 0.0,
            }
        )

    # A THRESHOLD READ OFF THE CURVE, not assumed. The lowest bucket whose
    # OBSERVED rate clears the base rate by a margin and holds enough rows to
    # mean anything. Without one, say so rather than inventing 0.62.
    threshold = 0.0
    basis = "none"
    if skill:
        for b in cal:
            if b["n"] >= 30 and b["observed"] > base_rate + 0.05:
                threshold = b["from"]
                basis = "calibration"
                break
    if basis == "none":
        threshold = float(np.quantile(ss, 0.75))

    why = ""
    if not skill:
        why = (
            f"no skill: AUC {auc:.3f} against 0.500, and accuracy {acc:.3f} "
            f"against a {base_major:.3f} majority. Predicting the common class "
            "would do as well, so this must not route anything."
        )

    return {
        "ok": True,
        "why": why,
        "rows": len(rows),
        "scored": scored,
        "auc": float(auc),
        "accuracy": acc,
        "baseRate": base_rate,
        "lift": float(lift),
        "skill": skill,
        "folds": len(spans),
        "timeOrdered": True,
        "foldSpans": spans,
        "calibration": cal,
        "suggestedThreshold": float(threshold),
        "thresholdBasis": basis,
        "features": names,
    }


@bp.post("/svc/router/train")
def router_train():
    """Fit and SCORE a router over candidates the caller supplies.

    The caller owns the ledger — `backtest/ledger.ts` builds it beside the
    engine that will trade on it, so the features and the labels are the
    engine's own rather than a second opinion computed here.

    Answers with the report whatever happens: a refusal carries `ok: false` and
    a reason, and a fitted model that learned nothing carries `skill: false` and
    says so. Neither is an error, and both are things the desk has to show.
    """
    try:
        payload = request.get_json(force=True) or {}
        rows = payload.get("candidates") or []
        if not isinstance(rows, list):
            return jsonify(_refuse("candidates must be a list")), 400
        report = train_router(
            rows,
            min_rows=int(payload.get("minRows", MIN_ROWS)),
            folds=int(payload.get("folds", 5)),
        )
        return jsonify(report)
    # A blanket catch on purpose: a route that 500s on a malformed payload
    # tells the desk nothing, and this one always has a reason to give. BLE001
    # is deferred in ruff.toml, so no directive is needed here.
    except Exception as e:
        return jsonify(_refuse(f"the router could not run: {e}")), 200


@bp.get("/svc/router/health")
def router_health():
    """Whether a router can be fitted here at all, and with what."""
    return jsonify(
        ok=HAVE_SKLEARN,
        engine="sklearn HistGradientBoosting + isotonic calibration",
        why="" if HAVE_SKLEARN else "scikit-learn is not installed, so nothing can be fitted",
        minRows=MIN_ROWS,
    )
