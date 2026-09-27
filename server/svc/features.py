"""
Data the terminal accumulates: the feature store, the OHLC cache, and ML.

`data_loop` collects the D1-D7 drivers hourly into `features` through
`mishel_data`; the routes serve the latest value per key, a key's history, and
the last error per collector so a blank row can explain itself. The OHLC cache
is the browser's bars, stored so the server can compute excursions without a
vendor. `/svc/ml/*` fronts `mishel_ml` and `mishel_hmm`, which fail with the
missing package's name rather than an answer. Moved out of `mishel_service.py`
in v59.

Failures are logged, never faked: a collector that cannot reach its source
writes an event, not a value.
"""

import json
import time

from db import db
from flask import Blueprint, jsonify, request

from svc.core import arg_num, log_event, sleep_ticking, tick

bp = Blueprint("features", __name__)


@bp.post("/svc/ml/predict")
def ml_predict():
    """N2: walk-forward gradient boosting on raw numbers. Honest failure if sklearn/history missing."""
    try:
        import mishel_ml
        d = request.get_json(force=True)
        res = mishel_ml.walk_forward(d["closes"], d["highs"], d["lows"], d["vols"],
                                     int(d.get("horizon", 24)))
        return jsonify(res)
    except ImportError:
        return jsonify(ok=False, err="scikit-learn not installed (pip install scikit-learn numpy)")
    except Exception as e:
        return jsonify(ok=False, err=str(e))

def is_fresh(stored_at, now, max_age_s):
    """Was this written recently enough to skip re-fetching?

    PURE, because it is the part that can be wrong. The fetch around it is not.

    NEVER FETCHED IS STALE. Treating a missing row as fresh would mean a new
    install never fetches at all -- a loop reporting a healthy tick age while
    producing nothing, which is the `bars_loop` failure this project records.

    A FUTURE TIMESTAMP IS NOT TRUSTED either. A clock that moved backwards, or a
    row written by a machine an hour ahead, would otherwise pin a feed as
    permanently fresh and it would never refresh again.
    """
    try:
        t = float(stored_at)
    except (TypeError, ValueError):
        return False
    if t <= 0 or t != t:  # noqa: PLR0124 - t != t is the NaN test
        return False
    age = now - t
    return 0 <= age < max_age_s


def last_stored(source, key):
    """When this source/key was last written, or None."""
    with db() as c:
        r = c.execute(
            "SELECT max(t) AS t FROM features WHERE source=? AND k=?", (source, key)
        ).fetchone()
    return (r["t"] if r else None) if r else None


def data_loop():
    """M1 feature store: D1-D7 collected hourly; failures logged, never faked."""
    import mishel_data
    def store(source, key, val):
        with db() as c: c.execute("INSERT INTO features(t,source,k,v) VALUES(?,?,?,?)",
                                  (time.time(), source, key, json.dumps(val) if not isinstance(val,(int,float)) else str(val)))
    while True:
        tick("data_loop")
        def fresh(source, key, max_age_s):
            """Skip a leg whose stored copy is recent enough.

            READ FROM THE STORE, not a module timer. `collect()` runs the moment
            the process starts, so a run of restarts is a run of fetches with no
            interval at all — and a timer dies with the process, which is
            precisely the case that needs covering. MEASURED: 42 rate-limit
            failures on a WEEKLY calendar fetched hourly and again on every
            restart.
            """
            return is_fresh(last_stored(source, key), time.time(), max_age_s)

        try: mishel_data.collect(store, log_event, fresh); log_event("data_collect", "cycle done")
        except Exception as e: log_event("data_loop_error", str(e))
        sleep_ticking("data_loop", 3600)

@bp.get("/svc/data/snapshot")
def data_snapshot():
    """Latest value per source/key from the feature store (M1)."""
    with db() as c:
        rows = c.execute("""SELECT f.* FROM features f JOIN (SELECT source,k,MAX(t) mt FROM features
                            GROUP BY source,k) x ON f.source=x.source AND f.k=x.k AND f.t=x.mt
                            ORDER BY f.source,f.k""").fetchall()
    return jsonify([dict(r) for r in rows])

@bp.get("/svc/data/errors")
def data_errors():
    """v39.7 W3: the last error per data collector, so a blank driver row can
    explain ITSELF in the terminal ('why blank: Farside page shape changed').
    A dash that explains itself is decision-support; a bare dash is a shrug."""
    with db() as c:
        rows = c.execute("""SELECT e.kind, e.msg FROM events e JOIN (
                              SELECT kind, MAX(t) mt FROM events WHERE kind LIKE 'data_%' GROUP BY kind
                            ) x ON e.kind=x.kind AND e.t=x.mt""").fetchall()
    return jsonify({r["kind"]: r["msg"] for r in rows})

@bp.get("/svc/data/series")
def data_series():
    """v39.3: history for one feature-store key -- the MVRV z-score, hash
    ribbons and M2 trend are computed CLIENT-side from these accumulated
    observations, so the math is inspectable in the browser (glass-box) and
    the answer honestly degrades to '-' while history is still short."""
    src = request.args.get("source", "")[:40]
    key = request.args.get("k", "")[:60]
    n = arg_num("n", 400, lo=2, hi=2000)
    with db() as c:
        rows = c.execute("SELECT t,v FROM features WHERE source=? AND k=? ORDER BY t DESC LIMIT ?",
                         (src, key, n)).fetchall()
    return jsonify([{"t": r["t"], "v": r["v"]} for r in reversed(rows)])

@bp.post("/svc/ml/regime")
def ml_regime():
    try:
        import mishel_hmm
        d = request.get_json(force=True)
        return jsonify(mishel_hmm.regimes(d["closes"]))
    except ImportError: return jsonify(ok=False, err="scikit-learn/numpy missing")
    except Exception as e: return jsonify(ok=False, err=str(e))

@bp.post("/svc/data/ohlc")
def put_ohlc():
    d = request.get_json(force=True)
    sym = (d.get("sym") or "").upper(); tf = d.get("tf") or "1h"; bars = d.get("bars") or []
    if not sym or not isinstance(bars, list): return jsonify(ok=False, err="sym+bars required"), 400
    n = 0
    with db() as c:
        for b in bars[-2000:]:
            try:
                c.execute("INSERT OR REPLACE INTO ohlc_cache(sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)",
                          (sym, tf, float(b["t"]), float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b.get("v") or 0)))
                n += 1
            except Exception:
                continue
    return jsonify(ok=True, stored=n)

@bp.get("/svc/data/ohlc")
def get_ohlc():
    sym = (request.args.get("sym") or "").upper(); tf = request.args.get("tf") or "1h"
    lim = arg_num("n", 500, lo=1, hi=5000)
    with db() as c:
        rows = c.execute("SELECT t,o,h,l,c,v FROM ohlc_cache WHERE sym=? AND tf=? ORDER BY t DESC LIMIT ?",
                         (sym, tf, lim)).fetchall()
    return jsonify(sym=sym, tf=tf, bars=[dict(r) for r in reversed(rows)])
