"""
THE BAR ARCHIVE THAT OUTLIVES A BROWSER PROFILE.

Until v60.3 every candle this product held lived in one browser's IndexedDB.
MEASURED on 2026-09-24, across the whole system: **one series** — binance
BTCUSDT 1h, 5,803 bars, 242 days, 272 KB — and `navigator.storage.persisted()`
returning false, which means the browser was free to throw it away without
asking. `mishel.db` held claims, events and features and not a single bar. So
the answer to "how much history can I backtest on" was: whatever this profile
happens to still have, and no promise it will be there tomorrow.

This is the durable copy. The browser archive stays as the fast local cache the
chart reads; the server is the master, because it is the only half that
survives clearing site data, switching browser, or moving machine — and it is
also where the lab already runs its studies.

WHY NOT `ohlc_cache`
--------------------
There was already a table and two routes for this (`/svc/data/ohlc` in
`svc/features.py`), with **zero callers in `app/src`** — the "36 of 48 routes
were never called" backlog CLAUDE.md records, in its purest form. It is not
reused, and the reason is a correctness one rather than taste: its key is
`(sym, tf, t)` with NO SOURCE, so a broker's XAUUSD and yfinance's XAUUSD would
be written into the same series and silently blended. The client has always
keyed its own archive by source (`keyFor(source, symbol, timeframe)` in
`data/history.ts`); this table now agrees with it.

The old table was empty and is left alone rather than dropped, because dropping
a table is a migration that can only be got wrong once. It is dead and its
routes are marked as such.

WHAT A ROW IS
-------------
One closed bar of one series from one venue. The FORMING bar is never stored:
its close changes every tick, so storing it writes a number that was never a
close. `store_bars` drops anything at or after the newest closed boundary the
caller reports, and says how many it dropped.
"""

from db import db
from flask import Blueprint, jsonify, request

from svc.core import binance_bars, log_event, sleep_ticking, tick, yf_bars

bp = Blueprint("bars", __name__)

# One POST is one chunk. 5,000 bars of JSON is roughly 400 KB, which is a
# reasonable request; the client chunks anything larger.
MAX_PER_POST = 5000
# A read is bounded so a typo in a query string cannot ask for the whole table.
# 20,000 until v63.21, which was BELOW the 60,000 a study asks for
# (`MAX_STUDY_BARS`): once `svc/backfill.py` put 43,800 bars of 1h in here, a
# study requesting all of them would have been silently handed the newest
# 20,000 and reported its window as though that were the archive. A cap under
# what the only caller asks for is not a guard, it is a truncation nobody sees.
MAX_PER_GET = 60000


def _clean(rows):
    """
    Ascending, unique by timestamp, numeric.

    THE SAME CONTRACT THE CLIENT LEARNED THE HARD WAY. `store/barstore.ts`
    `ascendingUnique` exists because a repeated timestamp reached the backtest
    engine and every rule in a sweep was reported as "could not be studied".
    A store that accepts a duplicate hands the same failure to whoever reads it
    next, so the invariant is enforced on the way in here too.
    """
    out = {}
    for b in rows:
        try:
            t = float(b["t"])
            out[t] = (t, float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b.get("v") or 0))
        except (KeyError, TypeError, ValueError):
            continue
    return [out[k] for k in sorted(out)]


@bp.post("/svc/bars")
def put_bars():
    d = request.get_json(force=True) or {}
    src = (d.get("src") or "").strip().lower()
    sym = (d.get("sym") or "").strip().upper()
    tf = (d.get("tf") or "").strip()
    rows = d.get("bars") or []
    if not src or not sym or not tf:
        return jsonify(ok=False, err="src, sym and tf are all required — a series is all three"), 400
    if not isinstance(rows, list):
        return jsonify(ok=False, err="bars must be a list"), 400
    if len(rows) > MAX_PER_POST:
        return jsonify(ok=False, err=f"{len(rows)} bars in one request; the limit is {MAX_PER_POST}"), 413

    clean = _clean(rows)
    # The caller states which bar is still forming. Absent, nothing is dropped:
    # a client that does not know must not have bars silently removed.
    before = d.get("closedBefore")
    dropped = 0
    if before is not None:
        try:
            cut = float(before)
            kept = [r for r in clean if r[0] < cut]
            dropped = len(clean) - len(kept)
            clean = kept
        except (TypeError, ValueError):
            pass

    with db() as c:
        c.executemany(
            "INSERT INTO bars(src,sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(src,sym,tf,t) DO UPDATE SET o=excluded.o,h=excluded.h,l=excluded.l,"
            "c=excluded.c,v=excluded.v",
            [(src, sym, tf, *r) for r in clean],
        )
    return jsonify(ok=True, stored=len(clean), dropped_forming=dropped)


def read_bars(sym, tf="1h", n=5000, src=""):
    """Bars held for one series, oldest first.

    A PLAIN FUNCTION, not just a route body, because `svc/mcpserve.py` publishes
    this as an MCP tool and the alternative was a second copy of the query. One
    fact, one owner -- and the clamp on `n` is part of the fact: an MCP client
    asking for a million bars must be bounded by the same ceiling a browser is.
    """
    src = (src or "").strip().lower()
    sym = (sym or "").strip().upper()
    tf = (tf or "1h").strip()
    if not sym:
        return {"ok": False, "err": "sym is required"}
    try:
        n = min(MAX_PER_GET, max(1, int(n)))
    except (TypeError, ValueError):
        n = 5000

    where = "sym=? AND tf=?"
    args = [sym, tf]
    if src:
        where += " AND src=?"
        args.append(src)
    with db() as c:
        rows = c.execute(
            # `where` is built from the two fixed fragments above and never
            # from input; the values are always bound parameters.
            f"SELECT t,o,h,l,c,v FROM bars WHERE {where} ORDER BY t DESC LIMIT ?",
            (*args, n),
        ).fetchall()
    return {"ok": True, "src": src or None, "sym": sym, "tf": tf,
            "bars": [dict(r) for r in reversed(rows)]}


def inventory():
    """
    What is held, per series. The answer to "how much history do I have", which
    before this existed could only be got by opening a browser's dev tools.
    """
    with db() as c:
        rows = c.execute(
            "SELECT src,sym,tf,COUNT(*) AS bars,MIN(t) AS oldest,MAX(t) AS newest "
            "FROM bars GROUP BY src,sym,tf ORDER BY bars DESC"
        ).fetchall()
    series = [dict(r) for r in rows]
    return {"ok": True, "series": series, "total_bars": sum(s["bars"] for s in series)}


@bp.get("/svc/bars")
def get_bars():
    out = read_bars(
        request.args.get("sym"),
        request.args.get("tf") or "1h",
        request.args.get("n") or 5000,
        request.args.get("src") or "",
    )
    return (jsonify(out), 400) if not out["ok"] else jsonify(out)


@bp.get("/svc/bars/inventory")
def bars_inventory():
    return jsonify(inventory())


@bp.post("/svc/bars/enrol")
def set_enrolled():
    """
    Which series the server keeps current, written by the client.

    THE LOOP BELOW READ THIS KEY AND NOTHING EVER WROTE IT, so it ran hourly and
    did nothing — a component that reports a healthy tick and produces no work.
    The list is computed in one place (`app/src/data/library.ts`) and pushed
    here, rather than declared once in the browser and again in Python where
    the two are free to drift.

    Replaces the list wholesale: this is a statement of what should be current,
    not an append, so a series the operator removed stops being fetched.
    """
    d = request.get_json(force=True) or {}
    rows = d.get("series") or []
    if not isinstance(rows, list):
        return jsonify(ok=False, err="series must be a list"), 400

    clean = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        src = str(r.get("source") or "").strip().lower()
        sym = str(r.get("symbol") or "").strip().upper()
        tf = str(r.get("timeframe") or "").strip()
        if src and sym and tf and "," not in src + sym + tf and "|" not in src + sym + tf:
            clean.append(f"{src}|{sym}|{tf}")

    with db() as c:
        c.execute(
            "INSERT INTO config(k,v) VALUES('bars_enrolled',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            (",".join(clean),),
        )
    return jsonify(ok=True, enrolled=len(clean))


@bp.get("/svc/bars/enrol")
def get_enrolled():
    rows = enrolled()
    return jsonify(ok=True, series=[{"source": a, "symbol": b, "timeframe": c} for a, b, c in rows])


# --------------------------------------------------------------------------
# The top-up loop: history accrues WITH THE TERMINAL CLOSED, which is the whole
# point of moving the archive here. A library that only fills while you are
# watching it is a library you have to remember to fill.
# --------------------------------------------------------------------------

# Hourly. Anything faster is asking a free vendor for a bar that does not exist
# yet; anything slower and a day's gap needs a backfill to close.
TOPUP_EVERY_S = 3600
# Kept small on purpose: this is a TOP-UP, not a backfill. Deep history is
# fetched once by the terminal, which can show progress and be cancelled.
TOPUP_BARS = 300

#: What a series needs before anything can study it — `svc/auto.py` MIN_BARS.
#:
#: NOT A SECOND COPY OF THAT NUMBER: it is imported below. Written here as a
#: named idea because of what it is for. A 300-bar top-up can never carry a new
#: series over an 800-bar floor, so an enrolled market was topped up hourly,
#: reported healthy, and stayed permanently unstudiable. MEASURED: 18 of 22
#: enrolled series sat below it, which is why the autonomous loop only ever
#: found six subjects out of eleven markets.
#:
#: So the FIRST fill is deep and every fill after it is a top-up. That is the
#: difference between a loop that keeps a series current and a loop that can
#: never start one.
FIRST_FILL_BARS = 1000

#: How to fetch each enrolled source without a browser.
#:
#: A MODULE CONSTANT rather than a literal inside the loop, so a test can assert
#: that every source the client can enrol has a fetcher here. Built inline, the
#: fact that ten of twenty-two enrolled series had nowhere to go was visible
#: only by reading the loop body.
#:
#: Both entries must return `(rows, reason)`. `_clean` skips a row it cannot
#: read rather than raising, so a fetcher returning anything else stores NOTHING
#: and says NOTHING — which is exactly how this loop ran for its whole life.
TOPUP_FETCHERS = {"yfinance": yf_bars, "binance": binance_bars}


def enrolled():
    """
    The series the server keeps current.

    Read from config rather than hardcoded, so the client's enrolment (the
    macro spine plus the watchlist) is the one list. Absent, nothing is topped
    up — an empty list is not an excuse to invent one.
    """
    from svc.core import cfg

    raw = cfg("bars_enrolled", "") or ""
    out = []
    for part in raw.split(","):
        bits = [x.strip() for x in part.split("|")]
        if len(bits) == 3 and all(bits):
            out.append((bits[0].lower(), bits[1].upper(), bits[2]))
    return out


def _floor():
    """The bar count `svc/auto.py` needs before it will study a series.

    IMPORTED, NEVER COPIED. Two modules holding the same threshold is two
    definitions that drift, and the whole point of the first fill is to clear
    exactly this number. The import is local because `svc.auto` imports
    `svc.router`, which imports sklearn — a cost this module has no reason to
    pay at import time.
    """
    try:
        from svc.auto import MIN_BARS

        return MIN_BARS
    except Exception:  # noqa: BLE001 - a missing auto module is not a reason to stop topping up
        return 800


def _held(src, sym, tf):
    """How many bars are already stored for one series."""
    try:
        with db() as c:
            row = c.execute(
                "SELECT COUNT(*) AS n FROM bars WHERE src=? AND sym=? AND tf=?", (src, sym, tf)
            ).fetchone()
        return int(row["n"]) if row else 0
    except Exception:  # noqa: BLE001 - an unreadable count means "fetch deep", which is safe
        return 0


def bars_loop():
    while True:
        tick("bars_loop")
        for src, sym, tf in enrolled():
            try:
                # THE SOURCE IS HONOURED, NOT ASSUMED. A series enrolled under
                # one venue is never filled from another — a broker's XAUUSD and
                # a proxy's XAUUSD are different series, which is the defect
                # `ohlc_cache` had and this table was keyed to avoid.
                #
                # It used to read `if src != "yfinance": continue`, on the
                # premise that yfinance was the only source reachable without
                # the browser. MEASURED: 22 series enrolled, 10 of them binance,
                # every one skipped while the loop reported a fresh tick age.
                # Binance's public klines need no key either.
                fetch = TOPUP_FETCHERS.get(src)
                if fetch is None:
                    log_event("bars_topup_skipped", f"{src}|{sym}|{tf}: no headless fetch for this source")
                    continue
                # A series below the studiable floor gets a DEEP first fill;
                # everything else gets a top-up. Asking for the deep one every
                # hour would be a backfill wearing a top-up's name.
                held = _held(src, sym, tf)
                need = TOPUP_BARS if held >= _floor() else FIRST_FILL_BARS
                rows, why = fetch(sym, tf, need=need)
                if not rows:
                    # A DEAD SERIES SAYS SO. Silently continuing is how a loop
                    # reports healthy while producing nothing.
                    log_event("bars_topup_empty", f"{src}|{sym}|{tf}: {why or 'no rows'}")
                    continue
                clean = _clean(rows)
                with db() as c:
                    c.executemany(
                        "INSERT INTO bars(src,sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?,?) "
                        "ON CONFLICT(src,sym,tf,t) DO UPDATE SET o=excluded.o,h=excluded.h,"
                        "l=excluded.l,c=excluded.c,v=excluded.v",
                        [(src, sym, tf, *r) for r in clean],
                    )
            # One dead series must not stop the others.
            except Exception as e:
                log_event("bars_topup_failed", f"{src}|{sym}|{tf}: {e}")
        sleep_ticking("bars_loop", TOPUP_EVERY_S)


__all__ = [
    "bars_inventory",
    "bars_loop",
    "bp",
    "enrolled",
    "get_bars",
    "get_enrolled",
    "put_bars",
    "set_enrolled",
]
