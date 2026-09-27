"""
Shared plumbing for the quant service.

WHY THE TERMINAL SENDS ITS BARS INSTEAD OF THE SERVICE FETCHING THEM
The terminal already has the bars, already knows which provider they came from,
and already applied its own gap and quality checks to them. A service that
re-fetched would be answering a question about a DIFFERENT series than the one
on screen, and the first time the two disagreed nobody would be able to tell
which was right. So every endpoint takes bars in the request body.

WHY A REFUSAL IS AN HTTP 200
`{"ok": false, "reason": "..."}` is a finding, not a failure. "Ninety bars is
not enough to fit a GARCH model" is the single most useful thing this service
can say on ninety bars, and returning it as a 4xx would make the terminal
render it as a connection problem in a toast nobody reads. HTTP status codes
here describe the TRANSPORT. The `ok` flag describes the ANSWER.

WHY EVERY HEAVY IMPORT IS INSIDE A FUNCTION
torch, darts, prophet, tensorflow and causalml together take the better part of
a minute to import and several hundred megabytes of resident memory. Importing
them at module scope would mean a service that takes a minute to boot in order
to answer a question about the median bar gap. Each module imports what it
needs at call time and says so in its docstring.
"""
from __future__ import annotations

import functools
import math
import time
import traceback
from collections.abc import Callable
from typing import Any

import numpy as np

# --------------------------------------------------------------------------
# Sample-size floors.
#
# These are refusal thresholds, not warnings. Below them the endpoint returns
# `ok: false` and does not compute. Every one is stated in the reason string
# that comes back, because "not enough data" without a number is not actionable.
# --------------------------------------------------------------------------

#: Below this a volatility model is fitting noise.
MIN_BARS_GARCH = 250
#: Below this a walk-forward split has no meaningful out-of-sample half.
MIN_BARS_ML = 400
#: Below this a correlation or cointegration test is not worth reporting.
MIN_BARS_STATS = 120
#: Trades, not bars. Matches `journal/stats.ts` MIN_SAMPLE.
MIN_TRADES = 20
#: Causal effect estimation needs both arms populated this deeply.
MIN_TRADES_PER_ARM = 15


class Refusal(Exception):
    """
    A reason the question cannot be answered from this data.

    Raised freely inside endpoints and turned into `{"ok": false, "reason": ...}`
    by `endpoint`. It is deliberately NOT an error: nothing is logged as a
    failure and nothing is retried.
    """


def refuse(reason: str) -> None:
    raise Refusal(reason)


def parse_bars(payload: dict[str, Any]) -> dict[str, np.ndarray]:
    """
    Pull OHLCV columns out of a request body, validated.

    Rejects rather than repairs. A series with a non-monotonic timestamp or a
    high below its low is a feed defect, and silently sorting or swapping would
    produce a confident answer about a series that never existed.
    """
    bars = payload.get("bars")
    if not isinstance(bars, list) or len(bars) == 0:
        refuse("No bars in the request.")

    try:
        t = np.array([float(b["t"]) for b in bars], dtype=np.float64)
        o = np.array([float(b["o"]) for b in bars], dtype=np.float64)
        h = np.array([float(b["h"]) for b in bars], dtype=np.float64)
        low = np.array([float(b["l"]) for b in bars], dtype=np.float64)
        c = np.array([float(b["c"]) for b in bars], dtype=np.float64)
        v = np.array([float(b.get("v", 0.0)) for b in bars], dtype=np.float64)
    except (KeyError, TypeError, ValueError) as exc:
        refuse(f"Malformed bar: {exc}")

    if not np.all(np.isfinite(c)):
        refuse("Closes contain a non-finite value.")
    if np.any(np.diff(t) <= 0):
        refuse("Bar timestamps are not strictly increasing.")
    if np.any(h < low):
        refuse("A bar has a high below its low.")
    if np.any(c <= 0):
        refuse("A close is zero or negative; log returns are undefined.")

    return {"t": t, "o": o, "h": h, "l": low, "c": c, "v": v}


def log_returns(close: np.ndarray) -> np.ndarray:
    """
    Log returns, length n-1.

    Log rather than simple, because everything downstream — GARCH, the variance
    scaling across horizons, the aggregation of a multi-bar move — assumes
    additivity, and simple returns are not additive across time.
    """
    return np.diff(np.log(close))


def median_spacing_ms(t: np.ndarray) -> float:
    """Median gap between bars. The same measurement `chart/panes.ts` makes."""
    if t.size < 2:
        return float("nan")
    return float(np.median(np.diff(t)))


def bars_per_year(t: np.ndarray) -> float:
    """
    Bars per year, measured from the series rather than assumed.

    This is the annualisation factor, and getting it from a hard-coded table
    keyed on a timeframe label is how a 24/7 crypto series ends up annualised
    with 252 trading days. Measured spacing handles crypto, FX and equities
    without knowing which it is looking at.
    """
    step = median_spacing_ms(t)
    if not math.isfinite(step) or step <= 0:
        return float("nan")
    return (365.25 * 24 * 3600 * 1000.0) / step


def annualise_vol(sigma_per_bar: float, t: np.ndarray) -> float:
    """Per-bar sigma to annual, via the measured bar count."""
    n = bars_per_year(t)
    if not math.isfinite(n):
        return float("nan")
    return float(sigma_per_bar * math.sqrt(n))


def safe_float(x: Any) -> float | None:
    """JSON has no NaN. A number that is not a number must serialise as null."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def clean(obj: Any) -> Any:
    """Recursively make a structure JSON-safe, turning NaN/Inf into null."""
    if isinstance(obj, dict):
        return {k: clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (np.floating, float)):
        return safe_float(obj)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, np.ndarray):
        return [safe_float(v) for v in obj.tolist()]
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


def endpoint(fn: Callable[..., dict]) -> Callable[..., Any]:
    """
    Wrap a handler so refusals, timings and crashes all come back as JSON.

    A crash returns `ok: false` with the exception type and the module that
    raised it, NOT a stack trace to the browser — but it does log the trace
    server-side. A quant service that answers "500" tells the operator nothing
    about whether the model disagreed or the library is missing.
    """

    @functools.wraps(fn)
    def wrapped(*args: Any, **kwargs: Any) -> Any:
        from flask import jsonify, request

        started = time.time()
        try:
            payload = request.get_json(silent=True) or {}
            result = fn(payload, *args, **kwargs)
            result.setdefault("ok", True)
            result["ms"] = int((time.time() - started) * 1000)
            return jsonify(clean(result))
        except Refusal as r:
            return jsonify({"ok": False, "reason": str(r), "ms": int((time.time() - started) * 1000)})
        except ImportError as exc:
            # The one failure worth naming precisely: a library that is not
            # installed is an operator problem with an exact fix.
            return jsonify(
                {
                    "ok": False,
                    "reason": f"A required library is not installed: {exc}",
                    "missing": True,
                }
            )
        except Exception as exc:  # noqa: BLE001 - deliberately broad, see docstring
            traceback.print_exc()
            return jsonify(
                {
                    "ok": False,
                    "reason": f"{type(exc).__name__}: {exc}",
                    "crashed": True,
                }
            )

    return wrapped
