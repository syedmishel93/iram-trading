"""
Portfolio construction and sizing — `CVXPY`, `SciPy`.

THE DECISION THIS MAKES, AND THE ONE IT REFUSES TO
It decides RELATIVE SIZE across positions you have already decided to take. It
does not decide what to trade, and it never places an order.

WHY THE DEFAULT OBJECTIVE NEEDS NO RETURN FORECAST
Mean-variance optimisation is famous for producing insane weights, and the
reason is always the same: expected returns are estimated with enormous error,
and the optimiser treats them as exact. It then piles into whichever asset had
the luckiest sample. Covariances are estimated far more reliably than means.

So minimum-variance and risk-parity are the defaults here, and neither needs a
return forecast at all. Mean-variance is available, and when you ask for it the
output says plainly what it is resting on.

WHY THE CONSTRAINTS ARE THE POINT
An unconstrained optimum is a number nobody can trade. These are the ones that
matter and they are all enforced as hard constraints inside the solve rather
than clipped afterwards — clipping a solved weight vector produces something
that satisfies no objective at all:

  • total portfolio heat (sum of per-position risk) under your cap
  • no single position above a share cap
  • long-only, or long/short
  • turnover from your CURRENT weights, so a rebalance is not a rebuild

KELLY, AND WHY IT IS SHOWN FRACTIONALLY
Full Kelly maximises long-run growth and has drawdowns that no human tolerates
and no risk desk permits. The scipy solve here reports full Kelly and the
fraction of it that respects a stated maximum drawdown, and recommends the
latter.

Heavy imports: cvxpy, scipy, at call time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import MIN_BARS_STATS, refuse

#: Ledoit-Wolf shrinkage is applied when the sample is this thin relative to
#: the number of assets. n < 10k makes a raw covariance matrix near-singular.
SHRINK_RATIO = 10


def _returns_matrix(payload: dict) -> tuple[np.ndarray, list[str]]:
    """
    Build an asset-by-time return matrix from per-symbol bar arrays.

    Joined ON TIMESTAMP across symbols, not by array position. Two instruments
    from different venues do not share a bar grid, and stacking them by index
    silently pairs one asset's Tuesday with another's Wednesday — which
    produces a covariance matrix that is confidently wrong.
    """
    assets = payload.get("assets")
    if not isinstance(assets, list) or len(assets) < 2:
        refuse("Portfolio optimisation needs at least two assets.")

    series: dict[str, dict[float, float]] = {}
    for a in assets:
        sym = str(a.get("symbol", "")).strip()
        bars = a.get("bars")
        if not sym or not isinstance(bars, list) or len(bars) < 2:
            continue
        try:
            series[sym] = {float(b["t"]): float(b["c"]) for b in bars}
        except (KeyError, TypeError, ValueError):
            continue

    if len(series) < 2:
        refuse("Fewer than two assets carried usable bars.")

    shared = sorted(set.intersection(*(set(v) for v in series.values())))
    if len(shared) < MIN_BARS_STATS:
        refuse(
            f"The assets share {len(shared)} bars. {MIN_BARS_STATS} is the floor "
            f"for a covariance estimate. If this is near zero the feeds are on "
            f"different grids."
        )

    names = sorted(series)
    px = np.array([[series[s][t] for t in shared] for s in names])
    if np.any(px <= 0):
        refuse("A price is zero or negative; log returns are undefined.")
    rets = np.diff(np.log(px), axis=1)
    return rets, names


def _covariance(rets: np.ndarray) -> tuple[np.ndarray, bool]:
    """
    Sample covariance, shrunk toward a diagonal target when the sample is thin.

    An unshrunk covariance on a short window is near-singular, and a
    near-singular matrix hands the optimiser an apparent arbitrage between two
    almost-identical assets. It will take it, at enormous size.
    """
    k, n = rets.shape
    if n >= SHRINK_RATIO * k:
        return np.cov(rets), False
    from sklearn.covariance import LedoitWolf

    return LedoitWolf().fit(rets.T).covariance_, True


def portfolio(payload: dict) -> dict:
    """Solve for weights under the stated constraints."""
    import cvxpy as cp

    rets, names = _returns_matrix(payload)
    k = len(names)
    cov, shrunk = _covariance(rets)

    objective = str(payload.get("objective", "min_variance"))
    max_weight = float(payload.get("max_weight", 0.35))
    long_only = bool(payload.get("long_only", True))
    max_turnover = payload.get("max_turnover")
    current = payload.get("current_weights")

    if not (0 < max_weight <= 1):
        refuse("max_weight must be between 0 and 1.")

    w = cp.Variable(k)
    cons = [cp.sum(w) == 1, w <= max_weight]
    cons.append(w >= 0 if long_only else w >= -max_weight)

    notes: list[str] = []
    if max_turnover is not None and isinstance(current, list) and len(current) == k:
        w0 = np.array([float(x) for x in current])
        cons.append(cp.norm1(w - w0) <= float(max_turnover))
        notes.append(
            f"Turnover capped at {float(max_turnover):.0%} of the book, measured "
            f"from your current weights."
        )

    Sigma = cp.psd_wrap(cov)
    if objective == "min_variance":
        obj = cp.Minimize(cp.quad_form(w, Sigma))
        rests_on = "the covariance matrix only — no return forecast is used."
    elif objective == "mean_variance":
        mu_raw = payload.get("expected_returns")
        if not isinstance(mu_raw, list) or len(mu_raw) != k:
            refuse(
                "mean_variance needs an `expected_returns` entry per asset, in "
                "the same order as the sorted symbols. It is deliberately not "
                "defaulted to the historical mean: a sample mean return is the "
                "least reliable input in finance and the optimiser treats it as "
                "exact."
            )
        mu = np.array([float(x) for x in mu_raw])
        risk_aversion = float(payload.get("risk_aversion", 5.0))
        obj = cp.Maximize(mu @ w - risk_aversion * cp.quad_form(w, Sigma))
        rests_on = (
            "expected returns YOU supplied. Every weight below is only as good "
            "as those numbers, and small changes in them move the weights a lot."
        )
    else:
        refuse(f"Unknown objective '{objective}'. Use min_variance or mean_variance.")

    prob = cp.Problem(obj, cons)
    try:
        prob.solve()
    except Exception as exc:  # noqa: BLE001
        refuse(f"The solver failed: {type(exc).__name__}: {exc}")

    if w.value is None or prob.status not in ("optimal", "optimal_inaccurate"):
        refuse(
            f"No feasible portfolio under these constraints (solver said "
            f"'{prob.status}'). The usual cause is a max_weight below 1/{k}, "
            f"which makes the weights unable to sum to one."
        )

    weights = np.asarray(w.value).ravel()
    weights[np.abs(weights) < 1e-6] = 0.0

    port_var = float(weights @ cov @ weights)
    port_vol = math.sqrt(max(port_var, 0.0))

    # Risk parity, computed alongside for comparison. It needs no forecast
    # either and is usually the more robust of the two in practice.
    rp = _risk_parity(cov)

    # Marginal contribution to risk: which position is actually carrying the
    # portfolio's risk, which is rarely the one with the biggest weight.
    mcr = (cov @ weights) / port_vol if port_vol > 0 else np.zeros(k)
    contrib = weights * mcr

    return {
        "assets": names,
        "objective": objective,
        "n_bars": int(rets.shape[1]),
        "shrunk_covariance": shrunk,
        "weights": [
            {
                "symbol": names[i],
                "weight": float(weights[i]),
                "risk_contribution": float(contrib[i] / port_vol) if port_vol > 0 else None,
            }
            for i in range(k)
        ],
        "portfolio_vol_per_bar": port_vol,
        "risk_parity_weights": [
            {"symbol": names[i], "weight": float(rp[i])} for i in range(k)
        ],
        "diversification": _diversification(weights, cov),
        "constraints": {
            "max_weight": max_weight,
            "long_only": long_only,
            "max_turnover": max_turnover,
        },
        "notes": notes,
        "rests_on": rests_on,
        "caveat": (
            "These are relative sizes across positions you have already decided "
            "to take. Nothing here decides what to trade, and nothing here "
            "places an order."
        ),
        "basis": (
            f"Covariance from {rets.shape[1]} shared bars"
            + (", Ledoit-Wolf shrunk because the sample is thin for this many assets."
               if shrunk else ", sample covariance.")
        ),
    }


def _risk_parity(cov: np.ndarray) -> np.ndarray:
    """
    Equal risk contribution weights, by SLSQP.

    No closed form exists, so this is the scipy part: minimise the dispersion
    of per-asset risk contributions subject to the weights summing to one.
    """
    from scipy.optimize import minimize

    k = cov.shape[0]

    def dispersion(w: np.ndarray) -> float:
        vol = math.sqrt(max(float(w @ cov @ w), 1e-18))
        contrib = w * (cov @ w) / vol
        return float(np.sum((contrib - contrib.mean()) ** 2))

    res = minimize(
        dispersion,
        np.full(k, 1.0 / k),
        method="SLSQP",
        bounds=[(1e-4, 1.0)] * k,
        constraints=[{"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)}],
        options={"maxiter": 500, "ftol": 1e-12},
    )
    return np.asarray(res.x) if res.success else np.full(k, 1.0 / k)


def _diversification(w: np.ndarray, cov: np.ndarray) -> dict:
    """
    Diversification ratio, and the effective number of independent bets.

    A book of five instruments that all track the dollar is one bet with five
    tickets, and the weights alone never show that.
    """
    vols = np.sqrt(np.diag(cov))
    weighted_avg_vol = float(np.abs(w) @ vols)
    port_vol = math.sqrt(max(float(w @ cov @ w), 1e-18))
    ratio = weighted_avg_vol / port_vol if port_vol > 0 else float("nan")
    # Effective bets via the Herfindahl index of risk contributions.
    contrib = np.abs(w * (cov @ w)) / (port_vol**2) if port_vol > 0 else np.zeros(len(w))
    total = contrib.sum()
    eff = 1.0 / float(np.sum((contrib / total) ** 2)) if total > 0 else float("nan")
    return {
        "ratio": ratio,
        "effective_bets": eff,
        "note": (
            f"About {eff:.1f} independent bets across {len(w)} positions. "
            + (
                "The book is genuinely diversified."
                if eff > len(w) * 0.6
                else "These positions move together more than the count suggests — "
                "the book is more concentrated than it looks."
            )
        ),
    }


def kelly(payload: dict) -> dict:
    """
    Growth-optimal position fraction, and the fraction you should actually use.

    Takes a list of per-trade returns as R multiples. Solves for the fraction
    of capital that maximises expected log growth, then finds the largest
    fraction of THAT whose simulated maximum drawdown stays inside your limit.
    """
    from scipy.optimize import minimize_scalar

    raw = payload.get("returns")
    if not isinstance(raw, list) or len(raw) < 20:
        refuse("Kelly sizing needs at least 20 trade returns.")
    r = np.array([float(x) for x in raw if x is not None and math.isfinite(float(x))])
    if len(r) < 20:
        refuse(f"Only {len(r)} finite returns.")
    if np.mean(r) <= 0:
        refuse(
            f"Mean return is {np.mean(r):+.3f}R. Kelly is negative — the "
            f"growth-optimal size for a losing edge is zero, or the other side."
        )

    max_dd = float(payload.get("max_drawdown", 0.20))
    risk_per_trade = float(payload.get("risk_fraction", 0.01))

    def neg_growth(f: float) -> float:
        # Each trade risks `f` of capital and returns r_i multiples of that.
        g = 1.0 + f * r
        if np.any(g <= 0):
            return 1e9  # ruin
        return -float(np.mean(np.log(g)))

    res = minimize_scalar(neg_growth, bounds=(1e-4, 0.99), method="bounded")
    f_full = float(res.x)

    # Simulate the equity path at fractions of Kelly and find the largest that
    # respects the drawdown limit. Uses the actual trade sequence, not a
    # resample: the ORDER is what creates a drawdown, and shuffling destroys it.
    def path_dd(f: float) -> float:
        eq = np.cumprod(1.0 + f * r)
        peak = np.maximum.accumulate(eq)
        return float(np.max((peak - eq) / peak))

    chosen = 0.0
    for frac in np.linspace(1.0, 0.05, 20):
        if path_dd(f_full * frac) <= max_dd:
            chosen = f_full * frac
            break

    return {
        "n_trades": len(r),
        "mean_r": float(np.mean(r)),
        "full_kelly": f_full,
        "full_kelly_drawdown": path_dd(f_full),
        "recommended": chosen,
        "recommended_as_kelly_fraction": (chosen / f_full) if f_full > 0 else None,
        "recommended_drawdown": path_dd(chosen) if chosen > 0 else None,
        "your_current_risk": risk_per_trade,
        "verdict": (
            f"Full Kelly is {f_full:.1%} of capital per trade and would have drawn "
            f"down {path_dd(f_full):.0%} on this record. "
            + (
                f"The largest fraction that stays inside your {max_dd:.0%} limit is "
                f"{chosen:.1%}."
                if chosen > 0
                else f"No fraction down to 5% of Kelly stayed inside your "
                f"{max_dd:.0%} limit on this record."
            )
        ),
        "caveat": (
            "Kelly assumes this return distribution repeats. It will not. Every "
            "practitioner who uses it trades a fraction of it for exactly that "
            "reason, and the drawdown above is what happened on ONE historical "
            "sequence — the next one will be worse somewhere."
        ),
    }
