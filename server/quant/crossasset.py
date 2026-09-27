"""
Cross-asset training.

WHAT QUESTION THIS ANSWERS
"Does knowing what the dollar, the ten-year, the S&P and gold just did tell me
anything about what this instrument does next, over and above what its own
return already told me?"

That last clause is the whole design. A model fitted on drivers plus the
target's own return will score better than chance on most series simply because
the target's own return is autocorrelated, and reporting that as "the drivers
work" is the mistake this endpoint exists to avoid. So TWO models are fitted on
identical folds:

    baseline  the target's own return only
    full      the target's own return plus every driver

and the answer is the DIFFERENCE, measured against the standard error of the
difference. If the drivers add nothing, this says so — which is the likeliest
outcome and a genuinely useful one, because it is the difference between "I do
not have an edge here" and "I have not found it yet".

WHY IT REFUSES MORE OFTEN THAN IT ANSWERS
IRAM's own confluence score has a PBO of 89%. That is what fitting noise looks
like once you finally test for it, and it happened on this same data with fewer
columns. Everything here is therefore built to make a false positive hard:
walk-forward only, purged and embargoed, no shuffling, an improvement threshold
derived from the sample size rather than asserted, and a refusal whenever the
sample cannot support the question.
"""

from __future__ import annotations

import math

import numpy as np

from .common import clean, refuse

# --------------------------------------------------------------------------
# Floors. Each is the point below which the ANSWER stops meaning anything,
# not the point below which the code stops running.
# --------------------------------------------------------------------------

#: Rows needed before a walk-forward has enough test blocks to be worth it.
MIN_ROWS = 400

#: Folds. Five leaves each test block ~1/6 of the sample, which keeps the
#: per-fold standard error inside the effect sizes worth reporting.
N_FOLDS = 5

#: How many standard errors of improvement count as an improvement.
#:
#: 2.0, and applied to the standard error of the DIFFERENCE between two AUCs
#: on the same folds — not to either AUC on its own. Two models scored on the
#: same rows have correlated errors, so the difference is measured more
#: precisely than either term, and using the single-model SE here would be
#: needlessly conservative in one direction and wrong in the other.
IMPROVE_SIGMAS = 2.0


def _auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """
    AUC by rank, which is exact and needs no threshold sweep.

    Ties get the average rank, so a model that outputs a constant scores
    exactly 0.5 rather than 0 or 1 depending on sort order.
    """
    order = np.argsort(scores, kind="mergesort")
    ranks = np.empty(len(scores), dtype=float)
    ranks[order] = np.arange(1, len(scores) + 1, dtype=float)

    # average ranks within tied groups
    s_sorted = scores[order]
    i = 0
    while i < len(s_sorted):
        j = i
        while j + 1 < len(s_sorted) and s_sorted[j + 1] == s_sorted[i]:
            j += 1
        if j > i:
            avg = (i + j + 2) / 2.0
            ranks[order[i : j + 1]] = avg
        i = j + 1

    n_pos = int(labels.sum())
    n_neg = int(len(labels) - n_pos)
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    return float((ranks[labels == 1].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def _auc_se(auc: float, n_pos: int, n_neg: int) -> float:
    """Hanley-McNeil. Same estimator `ml.py` uses, for the same reason."""
    if n_pos < 2 or n_neg < 2 or not math.isfinite(auc):
        return float("nan")
    q1 = auc / (2.0 - auc)
    q2 = 2.0 * auc * auc / (1.0 + auc)
    var = (
        auc * (1 - auc)
        + (n_pos - 1) * (q1 - auc * auc)
        + (n_neg - 1) * (q2 - auc * auc)
    ) / (n_pos * n_neg)
    return math.sqrt(max(var, 0.0))


def _folds(n: int, n_folds: int, purge: int) -> list[tuple[np.ndarray, np.ndarray]]:
    """
    Expanding-window walk-forward with a purge gap.

    Train is always strictly BEFORE test. The `purge` rows immediately before
    each test block are dropped from training, because their labels look
    forward INTO the test block — without that gap the model has seen the
    answer, and the score is a measurement of the leak.
    """
    out: list[tuple[np.ndarray, np.ndarray]] = []
    fold = n // (n_folds + 1)
    if fold <= purge * 2:
        refuse(
            f"A fold would be {fold} rows against a {purge}-row purge gap. "
            f"Load more history, or shorten the horizon."
        )
    for k in range(n_folds):
        test_start = fold * (k + 1)
        test_end = min(n, test_start + fold)
        train_end = max(0, test_start - purge)
        if train_end < fold // 2 or test_end - test_start < 30:
            continue
        out.append((np.arange(0, train_end), np.arange(test_start, test_end)))
    if not out:
        refuse("No usable walk-forward folds. The panel is too short for this horizon.")
    return out


def _fit_predict(x_tr, y_tr, x_te):
    """
    Logistic regression, deliberately.

    A gradient booster on six columns and a few thousand rows will fit the
    noise and win the in-sample comparison every time. The question here is
    whether the drivers carry ANY linear information about the next move; if
    they do not carry that, a more flexible model finding something is far more
    likely to be overfitting than discovery. `ml.py` is where the boosters live
    for the questions that warrant them.
    """
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler

    scaler = StandardScaler().fit(x_tr)
    model = LogisticRegression(max_iter=1000, C=1.0)
    model.fit(scaler.transform(x_tr), y_tr)
    return model.predict_proba(scaler.transform(x_te))[:, 1], model


def train(payload: dict) -> dict:
    """
    Fit baseline and full models on identical purged folds and compare them.

    Expects the payload `panelPayload` in app/src/data/panel.ts produces.
    """
    cols = payload.get("columns") or []
    x_raw = payload.get("x") or []
    y_raw = payload.get("y") or []
    horizon = int(payload.get("horizon") or 1)
    symbol = str(payload.get("symbol") or "?")
    timeframe = str(payload.get("timeframe") or "?")

    x = np.asarray(x_raw, dtype=float)
    y_ret = np.asarray(y_raw, dtype=float)

    if x.ndim != 2 or len(x) != len(y_ret):
        refuse("The panel is malformed: x and y do not describe the same rows.")
    if len(y_ret) < MIN_ROWS:
        refuse(
            f"{len(y_ret)} labelled rows is below the {MIN_ROWS} this needs. "
            f"Below that the standard error on any score is larger than the "
            f"effect being looked for, so a result would not be distinguishable "
            f"from chance either way."
        )
    if not np.isfinite(x).all() or not np.isfinite(y_ret).all():
        refuse("The panel contains non-finite values; it was not cleaned before sending.")

    # The label: did the next `horizon` bars go up. Sign only — magnitude is a
    # different question and needs a different loss.
    y = (y_ret > 0).astype(int)
    base_rate = float(y.mean())
    if min(base_rate, 1 - base_rate) < 0.2:
        refuse(
            f"The label is {base_rate:.0%} one class. A model that always guesses "
            f"the majority scores well on that and has learned nothing; the "
            f"comparison would not mean what it appears to."
        )

    n_drivers = x.shape[1] - 1
    if n_drivers < 1:
        refuse("The panel has no driver columns — there is nothing to test against the baseline.")

    # The purge is the label horizon: every row within `horizon` of the test
    # block has a label that overlaps it.
    folds = _folds(len(y), N_FOLDS, max(1, horizon))

    oof_base = np.full(len(y), np.nan)
    oof_full = np.full(len(y), np.nan)
    coefs: list[np.ndarray] = []

    for tr, te in folds:
        if len(np.unique(y[tr])) < 2:
            continue
        p_b, _ = _fit_predict(x[tr][:, :1], y[tr], x[te][:, :1])
        p_f, model = _fit_predict(x[tr], y[tr], x[te])
        oof_base[te] = p_b
        oof_full[te] = p_f
        coefs.append(np.asarray(model.coef_).ravel())

    scored = np.isfinite(oof_base) & np.isfinite(oof_full)
    n_scored = int(scored.sum())
    if n_scored < 100:
        refuse(f"Only {n_scored} out-of-fold predictions were produced. Too few to score.")

    ys = y[scored]
    n_pos = int(ys.sum())
    n_neg = int(len(ys) - n_pos)

    auc_base = _auc(oof_base[scored], ys)
    auc_full = _auc(oof_full[scored], ys)
    se_base = _auc_se(auc_base, n_pos, n_neg)
    se_full = _auc_se(auc_full, n_pos, n_neg)

    # The SE of the difference between two AUCs on the SAME rows. Their errors
    # are correlated, and treating them as independent would overstate the
    # uncertainty; `r` is estimated from the correlation of the two predictors,
    # which is the cheap and honest approximation.
    r = float(np.corrcoef(oof_base[scored], oof_full[scored])[0, 1])
    r = r if math.isfinite(r) else 0.0
    se_diff = math.sqrt(max(se_base**2 + se_full**2 - 2 * r * se_base * se_full, 1e-12))

    delta = auc_full - auc_base
    sigmas = delta / se_diff if se_diff > 0 else float("nan")
    adds_information = bool(math.isfinite(sigmas) and sigmas >= IMPROVE_SIGMAS)

    # Mean standardised coefficient per driver, across folds. A DESCRIPTION of
    # the fitted models, never a claim of causation — the causal endpoint is a
    # different question with different assumptions.
    mean_coef = np.mean(np.vstack(coefs), axis=0) if coefs else np.zeros(x.shape[1])
    contributions = [
        {"column": "self", "coef": float(mean_coef[0])},
        *[
            {"column": cols[i] if i < len(cols) else f"col{i}", "coef": float(mean_coef[i + 1])}
            for i in range(n_drivers)
        ],
    ]
    contributions.sort(key=lambda c: -abs(c["coef"]))

    if adds_information:
        verdict = (
            f"The drivers add {delta:+.4f} AUC over the instrument's own return "
            f"({sigmas:.1f} standard errors). On this sample, and out of fold, "
            f"they carry information the price alone did not."
        )
    elif math.isfinite(sigmas) and sigmas <= -IMPROVE_SIGMAS:
        verdict = (
            f"Adding the drivers made it WORSE by {abs(delta):.4f} AUC "
            f"({abs(sigmas):.1f} standard errors). That is what fitting noise "
            f"in extra columns looks like out of sample."
        )
    else:
        verdict = (
            f"The drivers add {delta:+.4f} AUC, which is {abs(sigmas):.1f} standard "
            f"errors — inside the noise. On this sample they do not tell you "
            f"anything the instrument's own return did not already."
        )

    notes = [
        ("Walk-forward only. Training is always strictly before testing, with a "
        f"{max(1, horizon)}-row purge gap so no training label overlaps a test block."),
        ("The comparison is against the instrument's own return, not against a "
        "coin. Beating a coin is easy on an autocorrelated series and means "
        "nothing about the drivers."),
        ("Direction only, over the label horizon. This says nothing about size "
        "of move, and nothing about whether the edge survives costs."),
        ("A fitted coefficient describes the model, not the world. It is not a "
        "causal claim and must not be read as one."),
    ]
    if auc_full < 0.5:
        notes.append(
            "The full model scored below a coin out of fold. That is a real "
            "result on this sample, not a bug — it is what no signal looks like."
        )

    return clean(
        {
            "ok": True,
            "symbol": symbol,
            "timeframe": timeframe,
            "horizon": horizon,
            "rows_scored": n_scored,
            "folds": len(folds),
            "base_rate": base_rate,
            "drivers": list(cols),
            "baseline": {"auc": auc_base, "se": se_base},
            "full": {"auc": auc_full, "se": se_full},
            "delta_auc": delta,
            "delta_sigmas": sigmas,
            "adds_information": adds_information,
            "contributions": contributions,
            "verdict": verdict,
            "notes": notes,
        }
    )
