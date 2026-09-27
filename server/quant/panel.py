"""
Cross-sectional factor tests — `linearmodels`.

THE QUESTION THIS ANSWERS THAT A SINGLE-SYMBOL BACKTEST CANNOT
"Does momentum pay in the instruments I actually trade?" is not the same
question as "did momentum pay on SOLUSDT". The first is about a characteristic
earning a premium ACROSS a universe; the second is one draw from it, and a
strategy that works on one symbol out of forty is what you would expect from
noise.

Fama-MacBeth is the standard answer: run a cross-sectional regression at every
date, then test whether the average slope across dates is different from zero.
The reason it is the standard is that it handles the thing that breaks a naive
pooled regression — everything moves together on the same day, so pooled
standard errors are far too small and every factor looks significant.

WHAT ELSE IS HERE
A pooled PanelOLS with entity and time effects, as a cross-check. When the two
disagree, the answer depends on the specification, and that is worth knowing
before sizing anything on it.

THE HONEST LIMIT
Forty crypto pairs are not forty independent assets. They are mostly one asset
— beta to BTC — wearing forty tickers, and a factor premium measured across
them has far fewer effective degrees of freedom than the row count suggests.
The output reports the average cross-sectional correlation for exactly this
reason, and says so when it is high.

Heavy import: `linearmodels`, at call time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import refuse

#: Dates needed before an average slope means anything.
MIN_PERIODS = 60
#: Instruments needed in the cross-section at each date.
MIN_ENTITIES = 8


def _build(payload: dict):
    """
    Assemble a (symbol, date) panel of characteristics and forward returns.

    The forward return at date t is the return from t to t+1, so a regression
    of it on characteristics known AT t contains no look-ahead. Getting this
    off by one is the classic way a factor study produces a t-stat of 12.
    """
    import pandas as pd

    assets = payload.get("assets")
    if not isinstance(assets, list) or len(assets) < MIN_ENTITIES:
        refuse(
            f"{len(assets) if isinstance(assets, list) else 0} instruments. "
            f"{MIN_ENTITIES} is the floor — a cross-sectional regression on "
            f"fewer is fitting a line through a handful of points, once per date."
        )

    frames = []
    for a in assets:
        sym = str(a.get("symbol", "")).strip()
        bars = a.get("bars")
        if not sym or not isinstance(bars, list) or len(bars) < 120:
            continue
        try:
            t = np.array([float(b["t"]) for b in bars])
            c = np.array([float(b["c"]) for b in bars])
            h = np.array([float(b["h"]) for b in bars])
            low = np.array([float(b["l"]) for b in bars])
        except (KeyError, TypeError, ValueError):
            continue
        if np.any(c <= 0) or np.any(np.diff(t) <= 0):
            continue

        r = np.diff(np.log(c), prepend=np.nan)
        n = len(c)

        # Characteristics, all known at t.
        mom = np.full(n, np.nan)
        mom[20:] = np.log(c[20:] / c[:-20])
        rev = np.full(n, np.nan)
        rev[1:] = r[1:]  # last bar's return — short-term reversal
        vol = np.full(n, np.nan)
        rng_ = np.full(n, np.nan)
        for i in range(20, n):
            vol[i] = float(np.std(r[i - 19 : i + 1]))
            rng_[i] = float(np.mean((h[i - 19 : i + 1] - low[i - 19 : i + 1]) / c[i - 19 : i + 1]))

        # Forward return: t -> t+1. Shifted so row t holds the NEXT bar's move.
        fwd = np.full(n, np.nan)
        fwd[:-1] = r[1:]

        frames.append(
            pd.DataFrame(
                {
                    "symbol": sym,
                    "date": pd.to_datetime(t, unit="ms", utc=True).tz_localize(None),
                    "momentum": mom,
                    "reversal": rev,
                    "volatility": vol,
                    "range": rng_,
                    "fwd": fwd,
                }
            )
        )

    if len(frames) < MIN_ENTITIES:
        refuse(f"Only {len(frames)} instruments carried at least 120 usable bars.")

    df = pd.concat(frames).dropna()
    if df.empty:
        refuse("No rows survived the warm-up and the forward-return shift.")

    # Keep only dates where enough instruments are present, or the
    # cross-sectional regression at that date is meaningless.
    counts = df.groupby("date")["symbol"].count()
    good_dates = counts[counts >= MIN_ENTITIES].index
    df = df[df["date"].isin(good_dates)]
    n_dates = df["date"].nunique()
    if n_dates < MIN_PERIODS:
        refuse(
            f"{n_dates} dates have at least {MIN_ENTITIES} instruments. "
            f"{MIN_PERIODS} is the floor for averaging cross-sectional slopes."
        )

    # Standardise characteristics WITHIN each date. This is the step that makes
    # the slope interpretable as a spread return, and it also removes the
    # market-wide level that would otherwise dominate every regression.
    factors = ["momentum", "reversal", "volatility", "range"]
    for f in factors:
        df[f] = df.groupby("date")[f].transform(
            lambda s: (s - s.mean()) / s.std() if s.std() > 0 else s * 0.0
        )

    return df.set_index(["symbol", "date"]), factors, n_dates


def factors(payload: dict) -> dict:
    """Fama-MacBeth across the supplied universe, with a PanelOLS cross-check."""
    from linearmodels.panel import FamaMacBeth, PanelOLS

    df, facs, n_dates = _build(payload)
    n_entities = df.index.get_level_values(0).nunique()

    import warnings

    exog = df[facs].copy()
    exog["const"] = 1.0

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fm = FamaMacBeth(df["fwd"], exog).fit(cov_type="kernel")

        try:
            po = PanelOLS(df["fwd"], df[facs], entity_effects=True, time_effects=True)
            po_res = po.fit(cov_type="clustered", cluster_entity=True, cluster_time=True)
            pooled = {
                f: {"coef": float(po_res.params[f]), "p_value": float(po_res.pvalues[f])}
                for f in facs
            }
        except Exception as exc:  # noqa: BLE001
            pooled = {"error": f"{type(exc).__name__}: {exc}"}

    rows = []
    for f in facs:
        coef = float(fm.params[f])
        p = float(fm.pvalues[f])
        t = float(fm.tstats[f])
        agree = None
        if isinstance(pooled, dict) and f in pooled:
            agree = bool((pooled[f]["coef"] > 0) == (coef > 0) and pooled[f]["p_value"] < 0.05) if p < 0.05 else None
        rows.append(
            {
                "factor": f,
                "premium_per_bar": coef,
                "t_stat": t,
                "p_value": p,
                "significant": bool(p < 0.05),
                "pooled_agrees": agree,
            }
        )
    rows.sort(key=lambda r: abs(r["t_stat"]), reverse=True)

    # How independent is this universe, really?
    wide = df.reset_index().pivot_table(index="date", columns="symbol", values="fwd")
    corr = wide.corr().to_numpy()
    off = corr[~np.eye(len(corr), dtype=bool)]
    mean_corr = float(np.nanmean(off)) if off.size else float("nan")
    eff_n = (
        len(corr) / (1 + (len(corr) - 1) * mean_corr)
        if math.isfinite(mean_corr) and mean_corr > -1 / max(1, len(corr) - 1)
        else float("nan")
    )

    live = [r for r in rows if r["significant"]]

    return {
        "n_entities": int(n_entities),
        "n_dates": int(n_dates),
        "n_observations": len(df),
        "factors": rows,
        "pooled_panel_ols": pooled,
        "universe": {
            "mean_pairwise_correlation": mean_corr,
            "effective_independent_assets": eff_n,
            "note": (
                f"The {n_entities} instruments behave like about {eff_n:.1f} "
                f"independent ones (mean pairwise correlation {mean_corr:.2f}). "
                + (
                    "That is a genuinely broad cross-section."
                    if math.isfinite(eff_n) and eff_n > n_entities * 0.4
                    else "The cross-section is far narrower than the instrument "
                    "count suggests, so every t-statistic above is more "
                    "optimistic than it looks."
                )
            ),
        },
        "verdict": (
            "No characteristic earned a premium distinguishable from zero across "
            "this universe. That is a real finding: it says the cross-sectional "
            "edge you are looking for is not in these instruments at this horizon."
            if not live
            else "; ".join(
                f"{r['factor']} pays {r['premium_per_bar'] * 1e4:+.1f} bp per bar "
                f"(t = {r['t_stat']:+.2f})"
                for r in live
            )
        ),
        "basis": (
            f"Fama-MacBeth over {n_dates} dates and {n_entities} instruments, "
            f"characteristics standardised within each date, forward return "
            f"shifted so nothing in the regression is known after the fact. "
            f"Kernel (HAC) standard errors on the average slope."
        ),
    }
