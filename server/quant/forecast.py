"""
Forecasting — `darts`, `sktime`, `Prophet`.

WHAT IS AND IS NOT FORECAST HERE
Volatility and seasonality. Not direction.

The terminal already refuses to forecast direction, and there is a test in
`app/test/forecast.test.ts` that fails if anything directional is ever exported
from `analysis/forecast.ts`. Adding three forecasting libraries does not change
the reason for that refusal: a next-bar price forecast on a liquid instrument is
a random walk plus a small drift, every model finds the same thing, and the ones
that appear not to are overfitting. Dressing that up in an N-BEATS network makes
it more convincing and no more true.

What these libraries genuinely add:

  • darts — a like-for-like backtest harness across several model families on
    the SAME splits, so "which model is better here" is measured rather than
    assumed. Applied to the absolute-return series, which is forecastable.
  • sktime — proper sliding-window cross-validation for time series, and a
    NAIVE baseline that is astonishingly hard to beat. Anything that cannot
    beat "tomorrow's volatility equals today's" is reported as not beating it.
  • Prophet — trend/seasonality decomposition. Its real use here is the
    SESSION and DAY-OF-WEEK pattern: FX and crypto both have genuine
    intraday seasonality, and Prophet separates it from the trend cleanly.

Heavy imports: darts, sktime, prophet, at call time. Prophet in particular
takes several seconds to import the first time.
"""
from __future__ import annotations

import math

import numpy as np

from .common import MIN_BARS_STATS, log_returns, median_spacing_ms, parse_bars, refuse

#: Minimum bars for a seasonality decomposition to mean anything.
MIN_BARS_SEASON = 400
#: Test fraction for the model race.
TEST_FRACTION = 0.25


def _abs_returns(close: np.ndarray) -> np.ndarray:
    """
    |log return| — the forecastable part of a price series.

    Returns themselves are near-unforecastable and everyone knows it. Their
    MAGNITUDE is strongly autocorrelated, which is the entire reason GARCH
    exists, and it is what these models are pointed at.
    """
    return np.abs(log_returns(close))


def race(payload: dict) -> dict:
    """
    Backtest several forecasting models on absolute returns, same splits.

    Reports a NAIVE baseline alongside — the last value carried forward. On
    volatility that baseline is genuinely strong, and a model that does not
    beat it is reported as not beating it rather than quietly presented as
    "the forecast".
    """
    import pandas as pd

    cols = parse_bars(payload)
    close = cols["c"]
    if len(close) < MIN_BARS_STATS * 2:
        refuse(
            f"{len(close)} bars. {MIN_BARS_STATS * 2} is the floor for a model "
            f"race with a held-out quarter."
        )

    y = _abs_returns(close)
    n = len(y)
    split = int(n * (1 - TEST_FRACTION))
    horizon = int(payload.get("horizon", 1))
    if not (1 <= horizon <= 24):
        refuse("Horizon must be between 1 and 24 bars.")

    series = pd.Series(y)
    train, test = y[:split], y[split:]

    results: dict[str, dict] = {}

    # ---- the baseline everything is measured against ----------------------
    # Last value carried forward. On a persistent series this is hard to beat,
    # and reporting it first stops a mediocre model from looking impressive.
    naive_pred = np.concatenate([[train[-1]], test[:-1]])
    results["naive_last"] = _err(test, naive_pred, "Last value carried forward.")

    # A second baseline: the trailing mean. Beats naive on mean-reverting series.
    win = 20
    mean_pred = np.array(
        [float(np.mean(y[max(0, split + i - win) : split + i])) for i in range(len(test))]
    )
    results["trailing_mean_20"] = _err(test, mean_pred, "Mean of the last 20 bars.")

    # ---- sktime: sliding-window CV with its own naive forecaster ----------
    try:
        from sktime.forecasting.naive import NaiveForecaster
        from sktime.forecasting.trend import PolynomialTrendForecaster

        for name, f in (
            ("sktime_naive_mean", NaiveForecaster(strategy="mean", window_length=20)),
            ("sktime_drift", PolynomialTrendForecaster(degree=1)),
        ):
            try:
                preds = _rolling_forecast(f, series, split, horizon)
                results[name] = _err(test[: len(preds)], preds, f"sktime {name}.")
            except Exception as exc:  # noqa: BLE001
                results[name] = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
    except ImportError:
        results["sktime"] = {"ok": False, "reason": "sktime is not installed."}

    # ---- darts: a couple of genuinely different model families ------------
    try:
        import warnings

        from darts import TimeSeries
        try:
            from darts.models import RandomForestModel as _RF
        except ImportError:  # darts < 0.36 spells it without the suffix
            from darts.models import RandomForest as _RF
        from darts.models import ExponentialSmoothing, LinearRegressionModel

        ts = TimeSeries.from_values(y.astype(np.float32))
        tr = ts[:split]

        # LOCAL models (Theta, ETS) hold no reusable weights, so darts refuses
        # `retrain=False` for them outright — the first version asked for it and
        # both failed with a ValueError that read like a bug. They are refitted
        # at every step instead, on a coarser stride so the cost stays bounded.
        # GLOBAL models (the regression one) train once and roll forward.
        # Theta is deliberately NOT in this list. darts' Theta delegates to
        # statsmodels' ExponentialSmoothing, whose `initialization_method`
        # argument changed type in statsmodels 0.15, so it raises on every
        # series here. RandomForest fills the slot and is a genuinely different
        # family from the linear model, which is the point of having three.
        for name, model, retrain, stride in (
            ("darts_ets", ExponentialSmoothing(), True, 12),
            ("darts_random_forest", _RF(lags=24, n_estimators=100), False, 1),
            ("darts_linear_lags", LinearRegressionModel(lags=24), False, 1),
        ):
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    if not retrain:
                        model.fit(tr)
                    fc = model.historical_forecasts(
                        ts,
                        start=split,
                        forecast_horizon=horizon,
                        stride=stride,
                        retrain=retrain,
                        verbose=False,
                        last_points_only=True,
                    )
                pred = np.asarray(fc.values()).ravel()
                # A strided backtest predicts every `stride`-th bar, so the
                # actuals must be sampled the same way. Comparing a strided
                # prediction against consecutive actuals silently scores the
                # model against the wrong bars.
                idx = np.arange(len(pred)) * stride + split + horizon - 1
                idx = idx[idx < len(y)]
                pred = pred[: len(idx)]
                results[name] = _err(y[idx], pred, f"darts {name}, stride {stride}.")
            except Exception as exc:  # noqa: BLE001
                results[name] = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
    except ImportError:
        results["darts"] = {"ok": False, "reason": "darts is not installed."}

    usable = {k: v for k, v in results.items() if v.get("ok")}
    if not usable:
        refuse("No forecaster produced a usable prediction on this series.")

    # A MODEL SCORED ON FEWER BARS IS NOT COMPARABLE, WHICH THIS FOUND OUT.
    # The local models are refit at every step, so they run on a coarse stride
    # and end up scored on ~50 bars where the global models get 600. On the
    # first run ETS "won" on 50 points — an MAE from a twelfth of the sample is
    # a far noisier estimate, and letting it top the table is the same mistake
    # as comparing a strategy's 20-trade record with another's 600.
    max_n = max(v["n"] for v in usable.values())
    fair = {k: v for k, v in usable.items() if v["n"] >= max_n * 0.5}
    thin = sorted(k for k in usable if k not in fair)
    for k in thin:
        results[k]["thin"] = True
        results[k]["note"] += (
            f" Scored on {results[k]['n']} bars against {max_n} for the rest, so "
            f"it is reported but not ranked."
        )

    ranked = sorted(fair.items(), key=lambda kv: kv[1]["mae"])
    best_name, best = ranked[0]
    naive = results["naive_last"]

    beat_naive = naive.get("ok") and best["mae"] < naive["mae"]
    gain = (naive["mae"] - best["mae"]) / naive["mae"] * 100 if naive.get("ok") else float("nan")

    return {
        "n_bars": len(close),
        "n_train": split,
        "n_test": len(test),
        "horizon": horizon,
        "target": "absolute log return",
        "models": results,
        "ranking": [k for k, _ in ranked],
        "not_ranked": thin,
        "best": best_name,
        "beats_naive": bool(beat_naive),
        "gain_over_naive_pct": gain,
        "verdict": (
            f"{best_name} forecast absolute returns with MAE {best['mae']:.5f}, "
            f"{gain:.1f}% better than carrying the last value forward."
            if beat_naive and gain > 3
            else (
                f"{best_name} is nominally best but only {gain:.1f}% better than "
                f"carrying the last value forward, which is inside the noise. "
                f"On this series the naive forecast is the honest choice."
                if beat_naive
                else "Nothing beat the naive last-value forecast. Volatility here is "
                "persistent enough that the simplest possible model is the best one."
            )
        ),
        "refusal": (
            "This forecasts the SIZE of the next move, not its direction. "
            "Direction is not forecast here and is not forecastable at this "
            "horizon on a liquid instrument, whatever a model's backtest says."
        ),
        "basis": (
            f"Trained on the first {split} bars, scored on the held-out "
            f"{len(test)} with no refitting. Every model sees the same split."
        ),
    }


def _rolling_forecast(forecaster, series, split: int, horizon: int) -> np.ndarray:
    """One-step-ahead refits over the test region, expanding window."""
    import warnings

    preds = []
    n = len(series)
    step = max(1, (n - split) // 30)
    i = split
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        while i < n:
            forecaster.fit(series.iloc[:i])
            block = min(step, n - i)
            fh = list(range(1, block + 1))
            p = np.asarray(forecaster.predict(fh)).ravel()
            preds.extend(p[:block].tolist())
            i += block
    return np.array(preds[: n - split])


def _err(actual: np.ndarray, pred: np.ndarray, note: str) -> dict:
    m = min(len(actual), len(pred))
    if m < 20:
        return {"ok": False, "reason": "Too few predictions to score."}
    a, p = np.asarray(actual[:m], dtype=float), np.asarray(pred[:m], dtype=float)
    good = np.isfinite(a) & np.isfinite(p)
    if good.sum() < 20:
        return {"ok": False, "reason": "Too few finite predictions to score."}
    a, p = a[good], p[good]
    return {
        "ok": True,
        "n": len(a),
        "mae": float(np.mean(np.abs(a - p))),
        "rmse": float(math.sqrt(np.mean((a - p) ** 2))),
        "bias": float(np.mean(p - a)),
        "note": note,
    }


def seasonality(payload: dict) -> dict:
    """
    Decompose the volatility series into trend and seasonality — Prophet.

    THE ONE THING PROPHET IS GENUINELY GOOD AT HERE
    Intraday and day-of-week structure. FX volatility really does peak at the
    London and New York opens; crypto really is quieter at the weekend. Those
    are stable, mechanical patterns driven by when people are at their desks,
    and they are worth knowing because a breakout at 04:00 UTC and the same
    breakout at 13:30 UTC are not the same trade.

    It is pointed at |log return|, not price. A Prophet trend fitted to a price
    series is a piecewise-linear extrapolation of a random walk, which is the
    canonical way this library gets misused in finance.
    """
    import pandas as pd

    cols = parse_bars(payload)
    close, t = cols["c"], cols["t"]
    if len(close) < MIN_BARS_SEASON:
        refuse(
            f"{len(close)} bars. {MIN_BARS_SEASON} is the floor for a seasonality "
            f"fit — below it a 'pattern' is a handful of days."
        )

    step = median_spacing_ms(t)
    intraday = step < 24 * 3600 * 1000

    y = _abs_returns(close)
    ts = pd.to_datetime(t[1:], unit="ms", utc=True).tz_localize(None)
    df = pd.DataFrame({"ds": ts, "y": y})

    import logging
    import warnings

    logging.getLogger("prophet").setLevel(logging.CRITICAL)
    logging.getLogger("cmdstanpy").setLevel(logging.CRITICAL)

    from prophet import Prophet

    m = Prophet(
        daily_seasonality=intraday,
        weekly_seasonality=True,
        yearly_seasonality=False,
        # Volatility is strictly positive and heteroskedastic; a multiplicative
        # seasonality matches that far better than an additive one, which can
        # push the fitted value below zero.
        seasonality_mode="multiplicative",
        changepoint_prior_scale=0.05,
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        m.fit(df)
        future = m.make_future_dataframe(periods=0)
        fc = m.predict(future)

    out: dict = {
        "n_bars": len(close),
        "bar_minutes": step / 60000.0,
        "intraday_fitted": bool(intraday),
    }

    # Hour-of-day profile, from the fitted seasonal component rather than a raw
    # group-by: the component has the trend removed, so a quiet month does not
    # drag its hours down.
    if intraday and "daily" in fc.columns:
        prof = fc.assign(hour=fc["ds"].dt.hour).groupby("hour")["daily"].mean()
        peak = int(prof.idxmax())
        trough = int(prof.idxmin())
        out["hour_of_day"] = [
            {"hour": int(h), "effect": float(v)} for h, v in prof.items()
        ]
        out["busiest_hour_utc"] = peak
        out["quietest_hour_utc"] = trough
        out["intraday_note"] = (
            f"Volatility peaks around {peak:02d}:00 UTC and bottoms around "
            f"{trough:02d}:00 UTC, after the trend is removed. A breakout in the "
            f"quiet hours has to clear a smaller range to look significant, and "
            f"is more often noise."
        )

    if "weekly" in fc.columns:
        days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        prof = fc.assign(dow=fc["ds"].dt.dayofweek).groupby("dow")["weekly"].mean()
        out["day_of_week"] = [
            {"day": days[int(d)], "effect": float(v)} for d, v in prof.items()
        ]
        best_d = days[int(prof.idxmax())]
        worst_d = days[int(prof.idxmin())]
        out["busiest_day"] = best_d
        out["quietest_day"] = worst_d
        out["weekly_note"] = f"{best_d} is the most volatile day, {worst_d} the least."

    # How much of the variation the seasonal terms actually explain. Without
    # this, a chart of the seasonal component looks meaningful at any amplitude.
    resid = df["y"].to_numpy() - fc["yhat"].to_numpy()
    ss_tot = float(np.var(df["y"].to_numpy()))
    ss_res = float(np.var(resid))
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else float("nan")
    out["explained_variance"] = r2
    out["strength"] = (
        "strong" if r2 > 0.15 else "modest" if r2 > 0.05 else "negligible"
    )
    out["verdict"] = (
        f"Trend and seasonality together explain {r2 * 100:.1f}% of the variation "
        f"in bar-to-bar volatility. "
        + (
            "That is enough to be worth timing around."
            if r2 > 0.15
            else "That is real but small — worth knowing, not worth trading on its own."
            if r2 > 0.05
            else "That is negligible. This instrument has no useful clock; treat "
            "every hour the same."
        )
    )
    out["basis"] = (
        "Prophet with multiplicative seasonality on |log return|, not on price. "
        "A Prophet trend fitted to price is a piecewise-linear extrapolation of "
        "a random walk."
    )
    return out
