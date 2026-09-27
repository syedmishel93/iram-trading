"""server/svc/backfill.py — DEEP history into the table the studies actually read.

WHY THIS EXISTS, AND WHY IT IS NOT `svc/bulkfetch.py`

`bulkfetch` downloads Binance monthly kline zips into a **Parquet** store. That
store has no reader on the study path: nothing moves a Parquet file into the
`bars` table, so downloading a decade of it deepens no backtest at all. It is
the "a store with a writer and no reader" shape this project already records,
and the fix for THIS problem is not to wire those two together — a Parquet
archive is for tick-scale bulk, and the studies want one table they can query.

WHAT THE DEPTH IS WORTH, MEASURED

The whole archive held ~1,000 bars per series: **42 days at 1h**. A study's
arm therefore got a median of 46 trades, and the best-of-N hurdle a 550-arm
search has to clear is `sqrt(2 ln N) / sqrt(n)`:

    n =  46 trades  ->  hurdle +0.524 per-trade Sharpe   (0 of 334 arms cleared)
    n = 200 trades  ->  hurdle +0.251                    (6 arms already sit above)

So at 42 days the search **cannot tell "no edge" from "not enough data to see
one"**. Depth is not a nice-to-have here; it is the difference between a test
that can answer and one that cannot. Raising `n` is also the only lever
available — `N`, the number of arms, can only be cut, and cutting it is a
separate decision.

WHERE EACH SYMBOL'S HISTORY COMES FROM, AND WHY

Measured live, 2026-09-26, rather than assumed:

  * **Binance REST** pages cleanly with `startTime`; 5 years of 1h is 44
    requests. `svc/core.binance_bars` cannot do this — it fetches the most
    recent `need` bars and never pages, which is right for an hourly top-up and
    useless for reaching backwards.
  * **The MT5 bridge holds ~15 YEARS of 1h** — XAUUSD 45,235 bars back to 2011,
    EURUSD 47,424. It is also the series the operator is actually filled on, so
    a cost model measured from their broker matches the bars the rule was
    tested on.
  * **yfinance hard-caps 1h at 730 days** and says so: "The requested range
    must be within the last 730 days." It is the LAST resort here, and when it
    is used the ceiling is reported rather than silently delivering less.

WHAT IT REFUSES TO DO

Refuse before it starts, never after: an unknown symbol, no source that can
serve it, or a job already running are all answered without a byte fetched.
And the count it reports is **read back from the table**, never the length of
what was offered — `mishel_edge.upsert` returned `len(rows)` and a route logged
that as "400 of 400 written" on a table that holds zero, which is a sentence
whose two halves came from one number and could never disagree.
"""

import json
import threading
import time
import urllib.error
import urllib.request

from db import db
from flask import Blueprint, jsonify, request

from svc.core import log_event

bp = Blueprint("backfill", __name__)

try:
    import mt5_bridge as MT5
except Exception:  # noqa: BLE001 - the bridge is optional and absent off Windows
    MT5 = None

BINANCE = "https://api.binance.com/api/v3/klines"
TIMEOUT_S = 25

#: One REST page. Binance's own ceiling.
PAGE = 1000

#: Bars per timeframe per year, for turning "5 years" into a bar count.
PER_YEAR = {"1m": 525_600, "5m": 105_120, "15m": 35_040, "30m": 17_520,
            "1h": 8_760, "4h": 2_190, "1d": 365, "1w": 52}

MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
      "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000}

#: Quote assets Binance actually lists. An EXPLICIT set, not a shape: matching
#: any trailing three letters turns EURUSD into a Binance pair it does not
#: list, and EURUSDT IS listed — so a shape test would return real bars for a
#: different market, which is worse than a refusal.
BINANCE_QUOTES = ("USDT", "USDC", "FDUSD", "TUSD", "BTC", "ETH", "BNB")

_lock = threading.Lock()
_job: dict = {"state": "idle"}


def source_for(sym: str) -> tuple[str, str]:
    """(source, why). The ORDER is an honesty order, not a convenience one.

    The broker comes before a vendor for anything it quotes, because a rule
    tested on the broker's own series is tested on the bars it would have been
    filled on. A vendor's XAUUSD is a different series with a different spread,
    and this project already records reporting one as the other as a defect.
    """
    s = (sym or "").strip().upper()
    if not s:
        return "", "no symbol given"
    if any(s.endswith(q) for q in BINANCE_QUOTES):
        return "binance", ""
    if MT5 is not None:
        try:
            if MT5.available()[0]:
                return "mt5", ""
        except Exception:  # noqa: BLE001 - an unavailable bridge is not an error here
            pass
    return "yfinance", ("the broker is not reachable, so this falls back to a "
                        "vendor, which caps 1h history at 730 days")


def _binance_deep(sym: str, tf: str, want: int) -> tuple[list, str]:
    """Page BACKWARDS from now until `want` bars are held or the listing ends."""
    step = MS.get(tf)
    if not step:
        return [], "this bar size is not one Binance publishes"
    end = int(time.time() * 1000)
    out: dict[float, dict] = {}
    guard = 0
    while len(out) < want and guard < 400:
        guard += 1
        start = end - PAGE * step
        url = f"{BINANCE}?symbol={sym}&interval={tf}&startTime={start}&endTime={end}&limit={PAGE}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "IRAM/63 (local terminal)"})
            # The URL is built from the constant above and never from input.
            with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
                page = json.loads(res.read())
        except urllib.error.HTTPError as e:
            return list(out.values()), f"Binance answered HTTP {e.code}"
        except Exception as e:  # noqa: BLE001 - reported, never raised at a route
            return list(out.values()), f"Binance was not reachable ({type(e).__name__})"
        if not page:
            break
        for k in page:
            t = float(k[0])
            # Binance switched open_time from milliseconds to MICROseconds in
            # its 2025 archives. Detect by MAGNITUDE; a cutover date goes stale.
            if t > 1e14:
                t /= 1000.0
            out[t] = {"t": t, "o": float(k[1]), "h": float(k[2]),
                      "l": float(k[3]), "c": float(k[4]), "v": float(k[5])}
        oldest = min(float(k[0]) for k in page)
        if oldest >= end:
            break
        end = int(oldest) - step
        _job["fetched"] = len(out)
        time.sleep(0.12)   # a free tier refuses a caller that does not pace itself
    return sorted(out.values(), key=lambda r: r["t"]), ""


def _mt5_deep(sym: str, tf: str, want: int) -> tuple[list, str]:
    if MT5 is None:
        return [], "the broker bridge is not installed on this machine"
    try:
        rows, err = MT5.bars(sym, tf, int(want))
    except Exception as e:  # noqa: BLE001
        return [], f"the broker bridge refused ({type(e).__name__})"
    if not rows:
        return [], err or "the broker returned no bars for this symbol"
    return rows, ""


def _yf_deep(sym: str, tf: str, years: float) -> tuple[list, str]:
    """yfinance over an explicit PERIOD, not the fixed one `yf_bars` uses.

    `YF_PERIOD["1d"]` is "5y" — correct for an hourly top-up, and it silently
    capped a ten-year request at five. Intraday is a different story: yfinance
    refuses 1h beyond 730 days outright ("The requested range must be within
    the last 730 days"), and that ceiling is NAMED rather than worked around.
    """
    try:
        import yfinance as yf
    except Exception:  # noqa: BLE001
        return [], "yfinance is not installed on this machine"
    from svc.core import YF_INTERVAL, YF_MAP

    interval = YF_INTERVAL.get(tf, tf)
    intraday = tf not in ("1d", "1w")
    period = "730d" if intraday else ("max" if years > 9 else f"{int(max(1, round(years)))}y")
    try:
        h = yf.Ticker(YF_MAP.get(sym, sym)).history(period=period, interval=interval)
    except Exception as e:  # noqa: BLE001
        return [], f"the vendor refused: {str(e)[:120]}"
    rows = []
    for ts, r in h.iterrows():
        try:
            rows.append({"t": float(ts.timestamp() * 1000), "o": float(r["Open"]),
                         "h": float(r["High"]), "l": float(r["Low"]),
                         "c": float(r["Close"]), "v": float(r.get("Volume") or 0.0)})
        except Exception:  # noqa: BLE001, S112 - a row we cannot read is skipped
            continue
    note = ""
    if intraday:
        note = "yfinance caps 1h history at 730 days, so this is as far back as it goes"
    return rows, ("" if rows else (note or "the vendor returned no bars"))


def fetch_deep(sym: str, tf: str, want: int, years: float = 5.0) -> tuple[str, list, str]:
    """(source, rows, note). `note` NAMES a ceiling rather than hiding it.

    A FALLBACK THAT SUCCEEDS DOES NOT CARRY THE FIRST SOURCE'S ERROR. The first
    version returned the broker's "'DXY' is not offered by this broker"
    alongside 1,254 bars that yfinance had just supplied perfectly well — so the
    run reported a real shortfall against a reason that had nothing to do with
    it, and an operator would have gone looking at their broker. Report the
    reason belonging to the source that ANSWERED.
    """
    src, why = source_for(sym)
    if src == "binance":
        rows, err = _binance_deep(sym, tf, want)
        return src, rows, err
    if src == "mt5":
        rows, err = _mt5_deep(sym, tf, want)
        if rows:
            return src, rows, err
        # The broker did not know it. A vendor still might, and if it does then
        # the broker's refusal is not what limited the result.
        rows, err2 = _yf_deep(sym, tf, years)
        return "yfinance", rows or [], (err2 if rows else (err or err2))
    rows, err = _yf_deep(sym, tf, years)
    return "yfinance", rows or [], (err or ("" if rows else why))


def _held(src: str, sym: str, tf: str) -> int:
    with db() as c:
        r = c.execute("SELECT COUNT(*) AS n FROM bars WHERE src=? AND sym=? AND tf=?",
                      (src, sym, tf)).fetchone()
    return int(r["n"] if r else 0)


def store(src: str, sym: str, tf: str, rows: list) -> int:
    """Upsert, then READ THE COUNT BACK. Returns bars actually held afterwards.

    Never `len(rows)`: a count that comes from the input cannot disagree with
    the database, so it is not evidence that anything landed.
    """
    good = []
    for r in rows or []:
        try:
            t = float(r["t"])
            rec = (src, sym, tf, t, float(r["o"]), float(r["h"]),
                   float(r["l"]), float(r["c"]), float(r.get("v") or 0.0))
        except (KeyError, TypeError, ValueError):
            continue   # a row we cannot read is skipped, never repaired
        if not all(x == x for x in rec[4:]):   # noqa: PLR0124 - the NaN test
            continue
        good.append(rec)
    if good:
        with db() as c:
            c.executemany(
                "INSERT INTO bars(src,sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(src,sym,tf,t) DO UPDATE SET o=excluded.o,h=excluded.h,"
                "l=excluded.l,c=excluded.c,v=excluded.v",
                good)
    return _held(src, sym, tf)


def _run(targets: list[tuple[str, str]], years: float) -> None:
    _job.update({"state": "running", "done": 0, "total": len(targets), "fetched": 0,
                 "note": "", "years": years, "series": []})
    try:
        for sym, tf in targets:
            want = int(PER_YEAR.get(tf, 8760) * years)
            _job["note"] = f"{sym} {tf} — asking for {want:,} bars"
            _job["fetched"] = 0
            src, rows, err = fetch_deep(sym, tf, want, years)
            held = store(src, sym, tf, rows) if rows else _held(src, sym, tf)
            span_days = 0.0
            if rows:
                span_days = (rows[-1]["t"] - rows[0]["t"]) / 86_400_000.0
            _job["series"].append({
                "sym": sym, "tf": tf, "src": src, "asked": want,
                "returned": len(rows or []), "held": held,
                "days": round(span_days, 1),
                # A vendor that could not reach as far back as asked must SAY so
                # — "the archive is what you have, not what you can get". But
                # judge the SPAN, not the bar count: `PER_YEAR["1d"]` is 365 and
                # an index trades ~252 days a year, so a COMPLETE ten-year fetch
                # of DXY returns 2,514 of 3,650 and a count test would call it
                # short. One number cannot serve a 24/7 market and a five-day
                # one — the same trap this project records for study windows.
                "short": bool(rows) and span_days < years * 365.25 * 0.9,
                "why": err or "",
            })
            _job["done"] += 1
        _job["state"] = "done"
    except Exception as e:  # noqa: BLE001 - a job thread must report, never vanish
        _job["state"] = "failed"
        _job["note"] = str(e)[:300]
    finally:
        _lock.release()
    # Announced AFTER the lock is released and outside any transaction: a nested
    # write asks for the lock this thread is holding, and the rollback is the
    # real damage.
    try:
        done = sum(1 for s in _job.get("series") or [] if s.get("held"))
        log_event("backfill", f"deep backfill finished: {done} series")
    except Exception:  # noqa: BLE001
        pass


@bp.post("/svc/bars/backfill")
def start_backfill():
    """Fetch deep history for one or more series into the `bars` table.

    REFUSES BEFORE IT STARTS: no symbols, an unusable bar size, or a job already
    running are all answered without a request made.
    """
    d = request.get_json(silent=True)
    if not isinstance(d, dict):
        return jsonify(ok=False, err='send {"symbols": ["BTCUSDT"], "timeframe": "1h", "years": 5}'), 400
    syms = d.get("symbols")
    if isinstance(syms, str):
        syms = [s.strip() for s in syms.split(",")]
    syms = [str(s).strip().upper() for s in (syms or []) if str(s).strip()]
    tf = str(d.get("timeframe") or "1h").strip()
    try:
        years = max(0.1, min(20.0, float(d.get("years") or 5)))
    except (TypeError, ValueError):
        years = 5.0

    if not syms:
        return jsonify(ok=False, err="at least one symbol is required"), 400
    if tf not in PER_YEAR:
        return jsonify(ok=False, err=f"{tf} is not a bar size this can backfill",
                       accepts=sorted(PER_YEAR)), 400
    if not _lock.acquire(blocking=False):
        return jsonify(ok=False, err="A backfill is already running.", job=_job), 409

    targets = [(s, tf) for s in syms]
    plan = [{"sym": s, "tf": tf, "source": source_for(s)[0],
             "note": source_for(s)[1]} for s in syms]
    threading.Thread(target=_run, args=(targets, years), daemon=True).start()
    return jsonify(ok=True, started=True, years=years, timeframe=tf, plan=plan)


@bp.get("/svc/bars/backfill")
def backfill_status():
    return jsonify(ok=True, **_job)


__all__ = ["backfill_status", "bp", "fetch_deep", "source_for", "start_backfill", "store"]
