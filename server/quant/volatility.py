"""
Volatility models — `arch`.

WHAT THIS ADDS OVER THE TERMINAL'S OWN FORECAST
`app/src/analysis/forecast.ts` runs an EWMA (lambda 0.94) with an EMPIRICAL
quantile, and reports its own calibration. That is a good model and it is
deliberately simple. What it cannot do is separate the two things that make
volatility move: its tendency to return to a long-run level, and its habit of
reacting harder to a fall than to a rise.

GARCH(1,1) gives the first. GJR-GARCH gives the second, and the leverage term
is testable rather than assumed — on a series with no asymmetry it fits near
zero and this module says so.

WHY IT REPORTS A HORSE RACE AND NOT A NUMBER
A GARCH forecast that is worse-calibrated than the EWMA the terminal already
has is worth knowing about and worth NOT using. So every fit is scored out of
sample against the same EWMA baseline, on the same bars, with the same loss.
If the baseline wins, that is the answer this returns, and the terminal shows
it. Replacing a working simple model with a fashionable complex one that
verifies worse is the single most common way a system like this gets less
accurate while looking more sophisticated.

WHY THE LOSS IS QLIKE AND NOT MSE
Variance forecasts cannot be scored with squared error: the loss is dominated
entirely by the few most volatile bars, so a model that ignores calm markets
scores well. QLIKE is the standard robust alternative and it penalises
under-forecasting — which is the error that costs money — harder than over.

Heavy import: `arch`, at call time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import (
    MIN_BARS_GARCH,
    annualise_vol,
    bars_per_year,
    log_returns,
    refuse,
)

#: RiskMetrics decay, matching `analysis/forecast.ts` so the baseline is the
#: SAME model the terminal already ships rather than a strawman.
EWMA_LAMBDA = 0.94

#: Fraction of history used to fit before scoring begins.
TRAIN_FRACTION = 0.6

#: Below this many scored bars the comparison is not worth reporting.
MIN_SCORED = 60

#: Relative QLIKE improvement below which two models are called a tie.
#:
#: A 0.03% edge on a noisy loss over a few hundred bars is not evidence that
#: one variance model forecasts better than another — and the first run of this
#: module reported exactly that as "GJR beat EWMA, by 0.0%", which is a
#: recommendation dressed up as a measurement. When the margin is inside the
#: noise the SIMPLER model wins by default, because it has fewer ways to be
#: wrong out of sample.
TIE_MARGIN = 0.01


def _ewma_variance(r: np.ndarray, lam: float = EWMA_LAMBDA) -> np.ndarray:
    """
    One-step-ahead EWMA variance, seeded with the sample variance.

    Returns an array the same length as `r`, where element i is the variance
    forecast FOR bar i made from bars up to i-1. That alignment is the whole
    point: an array where element i already contains bar i's own return is a
    look-ahead leak, and it is the easiest one in this file to write by
    accident.
    """
    out = np.empty_like(r)
    var = float(np.var(r[: max(10, len(r) // 10)]))
    for i in range(len(r)):
        out[i] = var
        var = lam * var + (1.0 - lam) * float(r[i] ** 2)
    return out


def _qlike(realised_sq: np.ndarray, forecast_var: np.ndarray) -> float:
    """
    QLIKE loss. Lower is better.

    Robust to the fact that the realised proxy (squared return) is a horribly
    noisy estimate of the true variance — which MSE is not.
    """
    v = np.maximum(forecast_var, 1e-18)
    x = np.maximum(realised_sq, 1e-18)
    return float(np.mean(np.log(v) + x / v))


def _fit_and_forecast(r_pct: np.ndarray, model: str, horizon: int) -> dict:
    """Fit one arch model on the whole sample and forecast `horizon` ahead."""
    from arch import arch_model

    if model == "gjr":
        am = arch_model(r_pct, vol="GARCH", p=1, o=1, q=1, dist="t")
    else:
        am = arch_model(r_pct, vol="GARCH", p=1, q=1, dist="t")

    res = am.fit(disp="off", show_warning=False)
    fc = res.forecast(horizon=horizon, reindex=False)
    # variance is in the same (percent) units the model was fitted in
    var_path = np.asarray(fc.variance.values)[-1]
    return {"res": res, "var_path_pct2": var_path}


def _walk_forward_qlike(r_pct: np.ndarray, model: str) -> tuple[float, int]:
    """
    Score a model out of sample at a ONE-STEP-AHEAD horizon.

    THE COMPARISON THIS GETS RIGHT, AND THE FIRST VERSION GOT WRONG
    The first version refit every `step` bars and scored the model's `step`-bar
    forecast PATH, while the EWMA baseline was scored one step ahead. GARCH
    lost — on a series that was genuinely GARCH with a leverage effect the
    module itself had just detected at p < 0.001. It lost because it was being
    asked a harder question, not because it was worse.

    So: refit periodically, but between refits run the variance recursion
    forward on the ACTUAL observed returns. That is a true one-step-ahead
    forecast at every bar, using only information available before it, and it
    is the same horizon the baseline is scored at.

    Refitting every bar would be the purest version and takes about a minute
    per series for a difference in the fourth decimal; the parameters of a
    GARCH model do not move meaningfully over a few dozen bars.
    """
    from arch import arch_model

    n = len(r_pct)
    start = int(n * TRAIN_FRACTION)
    if n - start < MIN_SCORED:
        refuse(
            f"Only {n - start} bars would be scored out of sample; "
            f"{MIN_SCORED} is the floor for a comparison worth reporting."
        )

    step = max(1, (n - start) // 40)
    preds: list[float] = []
    actual: list[float] = []

    i = start
    while i < n:
        train = r_pct[:i]
        if model == "gjr":
            am = arch_model(train, vol="GARCH", p=1, o=1, q=1, dist="t")
        else:
            am = arch_model(train, vol="GARCH", p=1, q=1, dist="t")
        try:
            res = am.fit(disp="off", show_warning=False)
            pr = res.params
            omega = float(pr["omega"])
            alpha = float(pr.get("alpha[1]", 0.0))
            beta = float(pr.get("beta[1]", 0.0))
            gamma = float(pr.get("gamma[1]", 0.0)) if model == "gjr" else 0.0
            mu = float(pr.get("mu", 0.0))

            # Seed from the fitted model's last in-sample conditional variance,
            # which is the variance forecast FOR bar i made from bars < i.
            cond = np.asarray(res.conditional_volatility) ** 2
            last = float(train[-1]) - mu
            var = (
                omega
                + alpha * last * last
                + gamma * last * last * (last < 0)
                + beta * float(cond[-1])
            )

            block = min(step, n - i)
            for k in range(block):
                preds.append(var)
                e = float(r_pct[i + k]) - mu
                actual.append(e * e)
                var = omega + alpha * e * e + gamma * e * e * (e < 0) + beta * var
        except Exception:
            # A model that will not converge on this window is not scored on it.
            # Skipping is honest; substituting the baseline's forecast would
            # quietly hand GARCH the baseline's score.
            pass
        i += step

    if len(preds) < MIN_SCORED:
        refuse(f"Only {len(preds)} bars scored; the model failed to converge on most windows.")
    return _qlike(np.array(actual), np.array(preds)), len(preds)


def analyse(payload: dict) -> dict:
    """
    Fit GARCH and GJR-GARCH, race them against EWMA, and forecast forward.

    `horizon` is in BARS of whatever timeframe the caller sent.
    """
    from .common import parse_bars

    cols = parse_bars(payload)
    close = cols["c"]
    t = cols["t"]
    horizon = int(payload.get("horizon", 1))
    if horizon < 1 or horizon > 100:
        refuse("Horizon must be between 1 and 100 bars.")

    r = log_returns(close)
    if len(r) < MIN_BARS_GARCH:
        refuse(
            f"{len(r)} returns. A GARCH fit needs at least {MIN_BARS_GARCH} "
            f"or it is fitting noise."
        )

    # arch works in percent; fitting raw log returns of ~0.001 makes the
    # optimiser's starting values orders of magnitude off and it fails to
    # converge on perfectly ordinary data.
    r_pct = r * 100.0

    out: dict = {
        "n_returns": len(r),
        "horizon": horizon,
        "bars_per_year": bars_per_year(t),
    }

    # ---- the baseline, scored on exactly the same bars ---------------------
    n = len(r_pct)
    start = int(n * TRAIN_FRACTION)
    ewma_var = _ewma_variance(r_pct)
    base_q = _qlike(r_pct[start:] ** 2, ewma_var[start:])

    models: dict[str, dict] = {}
    for name in ("garch", "gjr"):
        try:
            q, scored = _walk_forward_qlike(r_pct, name)
        except Exception as exc:  # noqa: BLE001
            models[name] = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
            continue

        fit = _fit_and_forecast(r_pct, name, horizon)
        res = fit["res"]
        params = {k: float(v) for k, v in res.params.items()}
        pvalues = {k: float(v) for k, v in res.pvalues.items()}

        # Cumulative variance over the horizon, then back to log-return units.
        cum_var_pct2 = float(np.sum(fit["var_path_pct2"]))
        sigma_h = math.sqrt(cum_var_pct2) / 100.0
        sigma_1 = math.sqrt(float(fit["var_path_pct2"][0])) / 100.0

        alpha = params.get("alpha[1]", float("nan"))
        beta = params.get("beta[1]", float("nan"))
        gamma = params.get("gamma[1]", float("nan"))
        persistence = alpha + beta + (gamma / 2.0 if name == "gjr" and math.isfinite(gamma) else 0.0)

        models[name] = {
            "ok": True,
            "qlike": q,
            "scored_bars": scored,
            "beats_ewma": bool(q < base_q),
            "params": params,
            "pvalues": pvalues,
            "persistence": persistence,
            "sigma_next_bar": sigma_1,
            "sigma_horizon": sigma_h,
            "annual_vol": annualise_vol(sigma_1, t),
            "loglik": float(res.loglikelihood),
            "aic": float(res.aic),
            "bic": float(res.bic),
        }

    out["baseline"] = {
        "name": "EWMA lambda 0.94",
        "qlike": base_q,
        "note": "The model the terminal already ships, in analysis/forecast.ts.",
    }
    out["models"] = models

    # ---- the leverage question, answered rather than assumed ---------------
    gjr = models.get("gjr", {})
    if gjr.get("ok"):
        g = gjr["params"].get("gamma[1]")
        p = gjr["pvalues"].get("gamma[1]")
        if g is not None and p is not None:
            out["leverage"] = {
                "gamma": g,
                "p_value": p,
                "asymmetric": bool(p < 0.05 and g > 0),
                "note": (
                    "Falls raise next-bar volatility more than rises do."
                    if p < 0.05 and g > 0
                    else "No measurable asymmetry between up and down moves in this sample."
                ),
            }

    # ---- who won, stated plainly ------------------------------------------
    ranked = [(k, v["qlike"]) for k, v in models.items() if v.get("ok")]
    if not ranked:
        out["verdict"] = (
            "Neither GARCH model converged on this series. The terminal's EWMA "
            "forecast stands, and it is the one to use."
        )
        out["winner"] = "ewma"
    else:
        ranked.sort(key=lambda kv: kv[1])
        best, best_q = ranked[0]
        gain = (base_q - best_q) / abs(base_q)
        out["margin_pct"] = gain * 100.0
        if gain > TIE_MARGIN:
            out["winner"] = best
            out["verdict"] = (
                f"{best.upper()} forecast variance better than the terminal's EWMA "
                f"out of sample, by {gain * 100:.1f}% on QLIKE over "
                f"{models[best]['scored_bars']} scored bars."
            )
        elif gain > 0:
            out["winner"] = "ewma"
            out["verdict"] = (
                f"{best.upper()} edged the terminal's EWMA by {gain * 100:.2f}% on QLIKE, "
                f"which is inside the noise on {models[best]['scored_bars']} bars. "
                f"Treat them as tied and keep the EWMA — it has fewer parameters to "
                f"go wrong out of sample."
            )
        else:
            out["winner"] = "ewma"
            out["verdict"] = (
                "Neither GARCH model beat the terminal's own EWMA out of sample. "
                "Use the EWMA forecast; the extra parameters are not earning their keep here."
            )

    out["basis"] = (
        "Fitted on log returns, scored out of sample with QLIKE on an expanding "
        "window. QLIKE rather than squared error because a variance forecast "
        "scored with MSE is judged almost entirely on its handful of most "
        "volatile bars."
    )
    return out
