"""
The quant service — Flask, port 8789.

WHERE THIS SITS
The repository already runs two services and this is the third, deliberately
separate from both:

    8787  ddt_data_server.py   market data proxy
    8788  mishel_service.py    alerts, ledger, sync
    8789  quant                this one — models, on demand

WHY A SEPARATE PROCESS AND NOT A BLUEPRINT ON 8788
Because the work here is CPU-bound and slow. A GARCH walk-forward takes ten
seconds and a model race takes a minute; folding those into the alert service
would block the loop that fires price alerts, and a missed alert is a worse
failure than a slow analysis. Separate process, separate failure domain: if
this one dies or is not running, the terminal loses the analytics panel and
nothing else.

BINDS TO LOCALHOST AND STAYS THERE
Same posture as `mishel_service.py`. There is no authentication here because
there is nothing to authenticate — the service holds no state, no credentials
and no positions. It takes bars in the request and returns numbers. Exposing it
to a network would still be a mistake, so the default host refuses to be
anything but loopback unless the operator sets IRAM_QUANT_HOST explicitly.

Run:  python -m quant.app          (from the server/ directory)
      IRAM_QUANT_PORT=9001 python -m quant.app
"""
from __future__ import annotations

import importlib
import os
import sys

from flask import Flask, jsonify
from flask_cors import CORS

from . import (
    causal,
    choice,
    crossasset,
    forecast,
    ml,
    optimize,
    panel,
    script,
    stats,
    volatility,
)
from .common import endpoint

PORT = int(os.environ.get("IRAM_QUANT_PORT", "8789"))
HOST = os.environ.get("IRAM_QUANT_HOST", "127.0.0.1")

#: Bars are large. 64 MB covers ~200k bars of JSON with room to spare, and
#: refuses a body that could only be a mistake or an attack.
MAX_BODY = 64 * 1024 * 1024

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY
# The terminal is served from :8000 (or :5173 in dev) and calls this from the
# browser, so cross-origin is the normal case rather than an exception.
CORS(app)


#: Every library this service can use, and what stops working without it.
LIBRARIES: dict[str, str] = {
    "numpy": "everything",
    "scipy": "risk parity, Kelly sizing",
    "pandas": "every endpoint that builds a table",
    "statsmodels": "edge significance, stationarity, lead/lag",
    "arch": "GARCH volatility",
    "sklearn": "the ML baseline and calibration",
    "xgboost": "one of the gradient boosters",
    "lightgbm": "one of the gradient boosters",
    "catboost": "one of the gradient boosters",
    "torch": "the neural-net cross-check",
    "darts": "the forecasting model race",
    "sktime": "the forecasting baselines",
    "prophet": "session and day-of-week seasonality",
    "cvxpy": "portfolio weights under constraints",
    "linearmodels": "cross-sectional factor premia",
    "dowhy": "causal refutation tests",
    "econml": "causal effect and CATE",
    "causalml": "the independent causal cross-check",
    "biogeme": "the revealed decision rule",
}


@app.get("/quant/health")
def health():
    """
    What this service can actually do right now.

    Reports every library as present or absent WITH the capability it gates, so
    a missing package reads as "seasonality is unavailable" rather than as a
    mysterious failure later. The terminal calls this on load and greys out the
    panels it cannot serve.
    """
    present: dict[str, str] = {}
    missing: dict[str, str] = {}
    for mod, gates in LIBRARIES.items():
        try:
            m = importlib.import_module(mod)
            present[mod] = str(getattr(m, "__version__", "present"))
        except Exception:  # noqa: BLE001
            missing[mod] = gates
    return jsonify(
        {
            "ok": True,
            "service": "iram-quant",
            "python": sys.version.split()[0],
            "present": present,
            "missing": missing,
            "degraded": sorted(set(missing.values())) if missing else [],
        }
    )


# --------------------------------------------------------------------------
# Endpoints. Each is a thin route over a module function; `endpoint` turns a
# refusal into `{"ok": false, "reason": ...}` at HTTP 200 — see common.py.
# --------------------------------------------------------------------------

app.post("/quant/volatility")(endpoint(volatility.analyse))
app.post("/quant/stats/edge")(endpoint(stats.edge))
app.post("/quant/stats/structure")(endpoint(stats.structure))
app.post("/quant/stats/leadlag")(endpoint(stats.leadlag))
app.post("/quant/forecast/race")(endpoint(forecast.race))
app.post("/quant/forecast/seasonality")(endpoint(forecast.seasonality))
app.post("/quant/ml/classify")(endpoint(ml.classify))
app.post("/quant/causal/effect")(endpoint(causal.effect))
app.post("/quant/portfolio")(endpoint(optimize.portfolio))
app.post("/quant/kelly")(endpoint(optimize.kelly))
app.post("/quant/panel/factors")(endpoint(panel.factors))
app.post("/quant/choice/revealed")(endpoint(choice.revealed))
app.post("/quant/crossasset/train")(endpoint(crossasset.train))
app.post("/quant/script/run")(endpoint(script.run))


@app.get("/quant/endpoints")
def endpoints():
    """A machine-readable index, so the terminal need not hard-code the list."""
    return jsonify(
        {
            "ok": True,
            "endpoints": [
                {
                    "path": str(r.rule),
                    "methods": sorted(m for m in r.methods if m in ("GET", "POST")),
                }
                for r in app.url_map.iter_rules()
                if str(r.rule).startswith("/quant/")
            ],
        }
    )


def main() -> None:
    if HOST not in ("127.0.0.1", "localhost", "::1") and not os.environ.get(
        "IRAM_QUANT_ALLOW_REMOTE"
    ):
        print(
            f"Refusing to bind {HOST}: this service has no authentication.\n"
            f"Set IRAM_QUANT_ALLOW_REMOTE=1 only if it sits behind something "
            f"that does.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    print(f"IRAM quant service on http://{HOST}:{PORT}")
    print(f"  health: http://{HOST}:{PORT}/quant/health")
    # threaded: a GARCH fit takes ten seconds and the health check must still
    # answer while one is running, or the terminal marks the service dead.
    app.run(host=HOST, port=PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()
