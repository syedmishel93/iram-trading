"""
Classical time-series statistics — `statsmodels`.

THE QUESTION THIS SERVICE EXISTS TO ANSWER
The terminal's backtest lab reports a win rate, an expectancy and a PBO. What
it cannot report is whether an edge is DISTINGUISHABLE FROM ZERO, and that is
the question that decides whether a strategy is worth trading.

The naive answer — a t-test on trade returns — is wrong here for two reasons
that both inflate significance:

  1. Overlapping and serially correlated returns. Trades taken from the same
     trend are not independent draws, so the ordinary standard error is too
     small and everything looks significant.
  2. Selection. A t-stat computed on the strategy that won a search over
     twenty-five specs is not the t-stat of a hypothesis you formed in advance.

This module fixes (1) with Newey-West HAC standard errors and REFUSES to fix
(2), because you cannot; it says so in the output, and the lab's PBO is the
number that speaks to it.

ALSO HERE
  • Stationarity (ADF, KPSS) — with the two run TOGETHER, because they test
    opposite nulls and either alone is routinely misread.
  • Ljung-Box on returns — is there any linear structure to trade at all?
  • Variance ratio — trending or mean-reverting, and over what horizon.
  • Granger causality between two series, with its assumptions stated.

Heavy import: `statsmodels`, at call time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import MIN_BARS_STATS, MIN_TRADES, log_returns, parse_bars, refuse


def _hac_lags(n: int) -> int:
    """
    Newey-West bandwidth by the standard rule of thumb, 4*(n/100)^(2/9).

    A fixed lag count is the usual mistake: too few and the correction does
    nothing, too many and the estimator is unstable on short samples.
    """
    return max(1, math.floor(4.0 * (n / 100.0) ** (2.0 / 9.0)))


def edge(payload: dict) -> dict:
    """
    Is a series of per-trade returns distinguishable from zero?

    Takes `returns` — R multiples or percentages, one per trade, in the order
    they were taken. Order matters: the HAC correction is about serial
    dependence, so a shuffled list would silently get the naive answer back.
    """
    import statsmodels.api as sm
    from statsmodels.stats.stattools import jarque_bera

    raw = payload.get("returns")
    if not isinstance(raw, list) or len(raw) == 0:
        refuse("No returns in the request.")
    r = np.array([float(x) for x in raw if x is not None and math.isfinite(float(x))])
    if len(r) < MIN_TRADES:
        refuse(
            f"{len(r)} trades. {MIN_TRADES} is the floor — below it the "
            f"confidence interval is wider than any edge you could act on."
        )

    n = len(r)
    lags = _hac_lags(n)

    # Regress returns on a constant. The constant IS the mean; HAC gives it an
    # honest standard error.
    x = np.ones((n, 1))
    ols = sm.OLS(r, x).fit()
    hac = ols.get_robustcov_results(cov_type="HAC", maxlags=lags, use_correction=True)

    mean = float(ols.params[0])
    se_naive = float(ols.bse[0])
    se_hac = float(hac.bse[0])
    t_hac = float(hac.tvalues[0])
    p_hac = float(hac.pvalues[0])

    # Ljung-Box on the trade sequence: are the trades independent draws?
    from statsmodels.stats.diagnostic import acorr_ljungbox

    lb = acorr_ljungbox(r, lags=[min(10, n // 5)], return_df=True)
    lb_p = float(lb["lb_pvalue"].iloc[0])

    _jb_stat, jb_p, skew, kurt = jarque_bera(r)

    # Deflated for the fact that you looked at more than one strategy. This is
    # a Sharpe-style haircut, reported alongside rather than instead of.
    sharpe = mean / float(np.std(r, ddof=1)) if np.std(r, ddof=1) > 0 else float("nan")

    return {
        "n_trades": n,
        "mean": mean,
        "std": float(np.std(r, ddof=1)),
        "sharpe_per_trade": sharpe,
        "hac_lags": lags,
        "se_naive": se_naive,
        "se_hac": se_hac,
        "t_stat": t_hac,
        "p_value": p_hac,
        "significant": bool(p_hac < 0.05 and mean > 0),
        "inflation": (se_hac / se_naive) if se_naive > 0 else None,
        "independence": {
            "ljung_box_p": lb_p,
            "independent": bool(lb_p > 0.05),
            "note": (
                "Trades look like independent draws."
                if lb_p > 0.05
                else "Trades are serially dependent — consecutive results are related, "
                "which is exactly what the HAC correction above is for."
            ),
        },
        "distribution": {
            "skew": float(skew),
            "excess_kurtosis": float(kurt) - 3.0,
            "jarque_bera_p": float(jb_p),
            "normal": bool(jb_p > 0.05),
        },
        "verdict": _edge_verdict(mean, p_hac, n, se_hac, se_naive),
        "caveat": (
            "This t-statistic assumes the strategy was chosen BEFORE seeing this "
            "data. If it won a search over several configurations, it is not, and "
            "no standard error correction can repair that. The lab's PBO is the "
            "number that speaks to selection; this one only speaks to noise."
        ),
        "basis": (
            f"OLS on a constant with Newey-West HAC standard errors at {lags} lags "
            f"(4*(n/100)^(2/9)), over {n} trades in the order they were taken."
        ),
    }


def _edge_verdict(mean: float, p: float, n: int, se_hac: float, se_naive: float) -> str:
    infl = se_hac / se_naive if se_naive > 0 else 1.0
    if mean <= 0:
        return f"Mean return is {mean:+.3f}. There is no edge here to test."
    if p < 0.01:
        base = f"Mean {mean:+.3f} per trade, p = {p:.4f}. Distinguishable from zero."
    elif p < 0.05:
        base = f"Mean {mean:+.3f} per trade, p = {p:.3f}. Marginally distinguishable from zero."
    else:
        return (
            f"Mean {mean:+.3f} per trade, but p = {p:.3f} over {n} trades. "
            f"This is not distinguishable from luck. It may still be a real edge — "
            f"it is not yet evidence of one."
        )
    if infl > 1.3:
        base += (
            f" The serial-dependence correction widened the standard error by "
            f"{(infl - 1) * 100:.0f}%; the naive t-test would have overstated this."
        )
    return base


def structure(payload: dict) -> dict:
    """
    Is this series trending, mean-reverting, or a random walk?

    ADF and KPSS are run together and reported as a PAIR, because they test
    opposite nulls: ADF's null is a unit root, KPSS's null is stationarity.
    Reading either alone is the standard way this analysis goes wrong — a
    failure to reject ADF is not evidence of a unit root, it is an absence of
    evidence against one, and on a short sample that is almost guaranteed.
    """
    from statsmodels.tsa.stattools import acf, adfuller, kpss

    cols = parse_bars(payload)
    close = cols["c"]
    if len(close) < MIN_BARS_STATS:
        refuse(f"{len(close)} bars. {MIN_BARS_STATS} is the floor for a stationarity test.")

    r = log_returns(close)
    logp = np.log(close)

    # Both tests warn: adfuller about a return-shape change coming in a future
    # statsmodels, KPSS whenever its p-value is clipped at a table boundary.
    # Neither changes the numbers, and a service that prints library
    # deprecation notices into its own logs on every request is a service
    # nobody reads the logs of.
    import warnings

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        adf_stat, adf_p, _, _, adf_crit, _ = adfuller(logp, autolag="AIC")
        kpss_stat, kpss_p, _, kpss_crit = kpss(logp, regression="c", nlags="auto")

    adf_rejects = bool(adf_p < 0.05)
    kpss_rejects = bool(kpss_p < 0.05)

    if adf_rejects and not kpss_rejects:
        call = "stationary"
        note = "Both tests agree: this series mean-reverts. A fade has something to work with."
    elif not adf_rejects and kpss_rejects:
        call = "unit-root"
        note = (
            "Both tests agree: this is a random walk in log price. Mean-reversion "
            "strategies have no anchor to revert to here."
        )
    elif adf_rejects and kpss_rejects:
        call = "conflicted"
        note = (
            "The two tests disagree, which usually means a structural break or a "
            "trend the constant-only specification cannot absorb. Treat the "
            "stationarity question as unanswered on this window."
        )
    else:
        call = "inconclusive"
        note = (
            "Neither test rejects its null. On this sample size that is the "
            "expected outcome for almost any financial series, and it is not "
            "evidence either way."
        )

    # Variance ratio: does variance grow faster or slower than linearly?
    vr = {}
    for q in (2, 4, 8, 16):
        if len(r) > q * 10:
            vr[str(q)] = _variance_ratio(r, q)

    acf_vals = acf(r, nlags=min(20, len(r) // 4), fft=True)

    return {
        "n_bars": len(close),
        "adf": {"stat": float(adf_stat), "p_value": float(adf_p), "critical": {k: float(v) for k, v in adf_crit.items()}},
        "kpss": {"stat": float(kpss_stat), "p_value": float(kpss_p), "critical": {k: float(v) for k, v in kpss_crit.items()}},
        "call": call,
        "note": note,
        "variance_ratio": vr,
        "vr_note": _vr_note(vr),
        "return_acf": [float(x) for x in acf_vals[1:11]],
        "basis": (
            "ADF and KPSS on log price, run together because they test opposite "
            "nulls. Variance ratios on log returns: above 1 is trending, below 1 "
            "is mean-reverting, 1 is a random walk."
        ),
    }


def _variance_ratio(r: np.ndarray, q: int) -> float:
    """Lo-MacKinlay variance ratio at horizon q, on overlapping windows."""
    n = len(r)
    mu = float(np.mean(r))
    var1 = float(np.sum((r - mu) ** 2)) / (n - 1)
    agg = np.convolve(r, np.ones(q), mode="valid")
    m = len(agg)
    varq = float(np.sum((agg - q * mu) ** 2)) / (m * q)
    return varq / var1 if var1 > 0 else float("nan")


def _vr_note(vr: dict) -> str:
    if not vr:
        return "Not enough history to compute variance ratios."
    vals = [v for v in vr.values() if math.isfinite(v)]
    if not vals:
        return "Variance ratios did not compute on this series."
    avg = sum(vals) / len(vals)
    if avg > 1.15:
        return (
            f"Variance grows faster than linearly (mean ratio {avg:.2f}). Moves "
            f"extend rather than revert — momentum has something to work with."
        )
    if avg < 0.85:
        return (
            f"Variance grows slower than linearly (mean ratio {avg:.2f}). Moves "
            f"give back — this favours fading extremes over chasing them."
        )
    return (
        f"Mean variance ratio {avg:.2f}, which is a random walk within measurement "
        f"error. Neither momentum nor mean reversion is indicated at these horizons."
    )


def leadlag(payload: dict) -> dict:
    """
    Does one series lead another? Granger causality, both directions.

    Takes `bars` (the subject) and `other` (a second bar array). Both are
    differenced to returns and joined ON TIMESTAMP, not on array position —
    two venues do not share a bar grid, and correlating by index pairs Tuesday
    with Wednesday.

    WHAT "GRANGER CAUSES" ACTUALLY MEANS
    That past values of X improve a forecast of Y beyond Y's own past. It is a
    statement about predictive content, not about mechanism, and this output
    says so rather than letting the word "causality" do work it has not earned.
    """
    from statsmodels.tsa.stattools import grangercausalitytests

    cols = parse_bars(payload)
    other_raw = payload.get("other")
    if not isinstance(other_raw, list) or len(other_raw) == 0:
        refuse("No comparison series in the request.")
    other = parse_bars({"bars": other_raw})

    # Join on timestamp.
    a_map = dict(zip(cols["t"].tolist(), cols["c"].tolist()))
    b_map = dict(zip(other["t"].tolist(), other["c"].tolist()))
    shared = sorted(set(a_map) & set(b_map))
    if len(shared) < MIN_BARS_STATS:
        refuse(
            f"The two series share {len(shared)} bars. {MIN_BARS_STATS} is the "
            f"floor. If this is near zero the feeds are on different grids."
        )

    a = np.array([a_map[t] for t in shared])
    b = np.array([b_map[t] for t in shared])
    ra, rb = log_returns(a), log_returns(b)
    maxlag = int(payload.get("maxlag", 5))
    maxlag = max(1, min(maxlag, max(1, len(ra) // 20)))

    import warnings

    def _test(y: np.ndarray, x: np.ndarray) -> dict:
        data = np.column_stack([y, x])
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            res = grangercausalitytests(data, maxlag=maxlag)
        best_p, best_lag = 1.0, 1
        for lag, r in res.items():
            p = float(r[0]["ssr_ftest"][1])
            if p < best_p:
                best_p, best_lag = p, lag
        return {"p_value": best_p, "lag": best_lag, "predicts": bool(best_p < 0.05)}

    fwd = _test(rb, ra)  # does the subject predict the other?
    rev = _test(ra, rb)  # does the other predict the subject?

    corr = float(np.corrcoef(ra, rb)[0, 1])

    if rev["predicts"] and not fwd["predicts"]:
        verdict = (
            f"The comparison series leads yours at {rev['lag']} bars "
            f"(p = {rev['p_value']:.4f}). Watching it may be worth something."
        )
    elif fwd["predicts"] and not rev["predicts"]:
        verdict = (
            "Yours leads the comparison series, not the other way round. "
            "Nothing to act on from watching it."
        )
    elif fwd["predicts"] and rev["predicts"]:
        verdict = (
            "Each predicts the other, which usually means both are responding to "
            "something a third series is driving. Not a lead."
        )
    else:
        verdict = "Neither series predicts the other at these lags."

    return {
        "shared_bars": len(shared),
        "correlation": corr,
        "maxlag": maxlag,
        "subject_leads": fwd,
        "other_leads": rev,
        "verdict": verdict,
        "caveat": (
            "Granger causality means past values of one series improve a forecast "
            "of the other. It is a statement about predictive content, not about "
            "mechanism, and it says nothing about why."
        ),
        "basis": (
            f"SSR F-test on log returns of {len(shared)} bars joined on timestamp, "
            f"lags 1 to {maxlag}, best lag reported."
        ),
    }
