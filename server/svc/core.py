"""
The service's shared toolkit: auth, backoff, config, prices, Telegram.

WHY THIS IS A SEPARATE MODULE AND WHAT IT IS NOT
`mishel_service.py` was 1,765 lines holding eleven background loops, forty-odd
HTTP routes and the handful of helpers all of them lean on. The helpers are the
part that everything else imports and that nothing imports FROM — the bottom of
the dependency graph — so they move first and the rest becomes divisible.

It is NOT a dumping ground. Everything here was already used by three or more
sections of the service before it moved; the moment something lands here that
only one route wants, it belongs beside that route instead.

WHAT DELIBERATELY STAYED BEHIND
`app`, `_auth_guard` (it is an `@app.before_request` and belongs with the app
it guards), `migrate()` and `SCHEMA_V`. And `backup_loop`, because it copies
the SQLite FILE and is meaningless under Postgres — it needs rethinking rather
than relocating, which is a different change.

HONESTY CONTRACT, CARRIED OVER UNCHANGED
Nothing here invents a price. `yf_price` and `yf_bars` return `(None, reason)`
when the vendor gives nothing, and every caller is written to stay silent
rather than guess — an alert that does not fire is correct; a fabricated one is
not.
"""

from __future__ import annotations

import datetime as dt
import os
import time

import requests
from db import db

PORT = int(os.environ.get("MISHEL_SVC_PORT", "8788"))
HOST = os.environ.get("MISHEL_SVC_HOST", "127.0.0.1")

#: Terminal symbol -> the ticker yfinance knows it by.
#: The terminal's canonical name -> what yfinance calls it.
#:
#: SPX AND VIX WERE MISSING, and `data/library.ts` `MACRO_SPINE` enrols both.
#: MEASURED: the server had been asked for them hourly and answered "no data
#: from vendor" every time, so `/svc/bars/inventory` showed 0 bars for four
#: series (SPX and VIX at 1h and 1d) while `bars_loop` reported a fresh tick.
#: An unmapped symbol falls through to itself, and yfinance has no ticker
#: called "SPX" — which reads as a dead vendor rather than a missing entry.
#:
#: The rest of the spine is here so the same thing cannot happen to the next
#: one added: every symbol `MACRO_SPINE` can enrol has a line.
YF_MAP = {"XAUUSD": "GC=F", "XAGUSD": "SI=F", "EURUSD": "EURUSD=X", "GBPUSD": "GBPUSD=X",
          "USDJPY": "USDJPY=X", "AUDUSD": "AUDUSD=X", "USDCHF": "USDCHF=X", "USDCAD": "USDCAD=X",
          "NZDUSD": "NZDUSD=X", "BTCUSD": "BTC-USD", "ETHUSD": "ETH-USD", "US10Y": "^TNX",
          "DXY": "DX-Y.NYB", "SPX": "^GSPC", "VIX": "^VIX", "NDX": "^NDX", "US30": "^DJI",
          "US02Y": "^IRX", "COPPER": "HG=F", "OIL": "CL=F", "NATGAS": "NG=F"}

#: loop name -> last tick, epoch seconds. Mutated in place by `tick()`; both
#: this module and `mishel_service` refer to the SAME dict, which is what makes
#: `/svc/health` and `gateway/background.py` agree about staleness.
LOOP_TICK: dict[str, float] = {}


def _svc_token():
    t = os.environ.get("MISHEL_TOKEN")
    if t: return t
    try:
        return cfg("svc_token")
    except Exception:
        return None

# H3: exponential backoff + circuit breaker per external host
_CIRCUIT = {}
def guarded_get(url, timeout=10, **kw):
    """requests.get with a per-host circuit breaker: after repeated failures the host is
    skipped (circuit open) for an exponentially growing window, capped at 10 minutes."""
    from urllib.parse import urlparse
    host = urlparse(url).netloc
    st = _CIRCUIT.setdefault(host, {"fails": 0, "until": 0})
    if time.time() < st["until"]:
        raise RuntimeError(f"circuit open for {host} ({int(st['until']-time.time())}s left)")
    try:
        r = requests.get(url, timeout=timeout, **kw)
        if r.status_code == 429:
            st["fails"] += 1
            st["until"] = time.time() + min(600, 2 ** st["fails"] * 5)
            raise RuntimeError(f"rate-limited by {host}; backing off")
        st["fails"] = 0
        return r
    except Exception:
        st["fails"] += 1
        st["until"] = time.time() + min(600, 2 ** st["fails"] * 5)
        raise

def tick(loop_name):
    """H2: call at the top of every loop iteration."""
    LOOP_TICK[loop_name] = time.time()

def sleep_ticking(loop_name, seconds):
    """v39.2 -- THE STALE-BY-CONSTRUCTION FIX.

    /svc/health judges every loop against ONE staleness threshold (600s), but
    backup_loop and data_loop slept 3600s, heartbeat_loop 14400s, and
    daily_brief_loop exactly 600s. All four read STALE for most of every cycle
    while doing their job perfectly -- a false alarm by construction. False
    alarms are worse than no alarms: they train the operator to ignore the
    banner, and then a REAL hang looks exactly like Tuesday.

    Fix: separate LIVENESS from CADENCE. A sleeping loop is a healthy loop, so
    it keeps ticking (every 20s) while it waits; work still runs on its own
    schedule. The single 600s threshold is now correct for every loop, and a
    thread that is genuinely hung -- inside its WORK, where hangs actually
    happen -- is caught within minutes instead of being indistinguishable from
    a scheduled nap."""
    deadline = time.time() + seconds
    while True:
        tick(loop_name)
        remaining = deadline - time.time()
        if remaining <= 0:
            return
        time.sleep(min(20, remaining))

def arg_num(key, default, lo=None, hi=None, cast=int):
    """A NUMERIC QUERY PARAMETER THAT NEVER RAISES.

    `int(request.args.get("limit") or 50)` raises ValueError on anything that is
    not a number, and a query string is the most exposed input this product has
    -- it is in a link, a bookmark and an address bar. MEASURED by sweeping all
    46 GET routes with hostile values: **68 crashes across 8 routes**, every one
    of them Flask's HTML traceback page reaching a person.

    `probe.py` could not have found it. It calls every read route with VALID
    parameters and truthfully reports 0 of 68 broken.

    A bad value takes the DEFAULT rather than refusing, because these are all
    page sizes and windows: "show me 50" is a better answer to `limit=abc` than
    a refusal, and unlike a cost model or a stop distance, nothing downstream is
    decided by it. `lo`/`hi` clamp, so a caller cannot ask for two million rows
    by spelling it correctly either.
    """
    from flask import request
    raw = request.args.get(key)
    if raw is None or raw == "":
        v = default
    else:
        try:
            v = cast(raw)
        except (TypeError, ValueError):
            v = default
    try:
        if v != v or v in (float("inf"), float("-inf")):  # noqa: PLR0124 -- the NaN test
            v = default
    except TypeError:
        v = default
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def cfg(k, default=None):
    # H5: secrets can live in env vars (never written to disk): MISHEL_TG_TOKEN / MISHEL_TG_CHAT
    if k == "tg_token" and os.environ.get("MISHEL_TG_TOKEN"): return os.environ["MISHEL_TG_TOKEN"]
    if k == "tg_chat"  and os.environ.get("MISHEL_TG_CHAT"):  return os.environ["MISHEL_TG_CHAT"]
    with db() as c:
        r = c.execute("SELECT v FROM config WHERE k=?", (k,)).fetchone()
        return r["v"] if r else default

def log_event(kind, msg):
    with db() as c: c.execute("INSERT INTO events(t,kind,msg) VALUES(?,?,?)", (time.time(), kind, msg))

# A kind whose name ends this way is a FAILURE. One owner, because the server
# orders by it and the card colours by it, and two lists would disagree -- which
# is the defect `views.ts` and `toolsmenu.ts` demonstrated with 0 of 24 groups
# agreeing.
ERR_SUFFIXES = ("_err", "_error", "_fail", "_failed")


def is_failure_kind(kind):
    """Is this event kind a failure? Asked in one place."""
    k = (kind or "").lower()
    return any(k.endswith(x) for x in ERR_SUFFIXES)


#: A failure older than this is a STANDING that has stopped recurring.
#:
#: Six hours because `data_loop` cycles hourly, so it is six chances to have
#: failed again and not taken. The threshold is not load-bearing on its own:
#: every kind also carries `ageS`, so a card can say "last failed 8 hours ago"
#: rather than trusting one number chosen here.
STALE_AFTER_S = 6 * 3600


def summarise_events(groups, now=None, stale_after=STALE_AFTER_S):
    """Classify and order grouped event counts.

    A RECURRING FAILURE IS A STANDING -- which is why this counts the whole table
    and not a tail -- BUT A STANDING NEEDS A RECENCY BOUND, or a fault that has
    been FIXED is indistinguishable from one that is live.

    MEASURED on the operator's own database, 2026-09-25: `failingKinds` was 11 and
    `failingTotal` 2,601, and three of the biggest were faults repaired in v62.15
    -- `data_mvrv`'s revoked metric, `pair_scan_loop`'s nested write, and
    `data_forexfactory_cal`, whose job was DELETED. The source proves all three
    fixed (`CapMVRVCur` only, no `rss.php`, `dbhold.py` reports zero nested
    writes), so the counts were residue from a process running the old code. With
    no recency notion they would be reported as currently failing FOR THE LIFE OF
    THE DATABASE, and the card whose headline is "how many jobs are failing" could
    never go green however much was fixed.

    The frontend had already half-noticed: `activity.ts` labels that kind
    "Economic calendar feed (retired)" while this function kept calling it
    failing. One fact, two owners, disagreeing -- so the recency lives HERE, where
    the classification is, rather than as a second judgement in the client.

    THREE STATES, AND `quiet` IS NOT `healthy`. Most `mishel_data.py` feeds call
    `log()` only inside an `except`, so silence is the ABSENCE of a recorded
    failure and not the presence of a success. Calling it healthy would be the
    "absence of errors is not evidence of success" mistake; it is reported as
    "has not failed lately" and nothing stronger.

    `now` is a parameter because a pure function that reads the clock cannot be
    tested -- the same reason `sleep_ticking`'s test moves both halves of its
    fake clock.

    `groups` comes from `SELECT kind, count(*), max(t), min(t) ... GROUP BY kind`
    -- the count is over the WHOLE table, never over a tail, because the fact
    worth reporting is that something has failed two thousand times and a
    fifty-row window cannot carry it.

    FAILURES FIRST, newest first, then everything else newest first. A reader
    opening this is asking "is anything wrong", and answering that means putting
    the answer at the top rather than in chronological order.

    AN EMPTY TABLE IS NOT A HEALTHY ONE. It gets `emptyReason` and no verdict:
    the `/svc/health` strip that built its loop list from what had already ticked
    and painted "0 of 0 running" green is the mistake being avoided here.
    """
    if now is None:
        now = time.time()
    kinds = []
    for g in groups or []:
        n = int(g.get("n") or 0)
        if n <= 0:
            # A group with no rows is not a zero to draw; it is not a group.
            continue
        kind = g.get("kind") or ""
        name_fail = is_failure_kind(kind)
        errs = int(g.get("errs") or 0)
        needs = int(g.get("needsYou") or 0)
        # A NAME IS NOT THE ONLY WAY A FAILURE ARRIVES. `data_mvrv` logged 223
        # rows, every one a 400, under a kind that does not end in `_err` -- so
        # name-only classification reported one failing kind on a log with four.
        ever_failed = name_fail or errs > 0
        newest = float(g.get("newest") or 0)
        age_s = max(0, int(now - newest)) if newest else None
        # RECENT, not merely ever. See this function's docstring: without this a
        # deleted job is reported as a failing one forever.
        recent = ever_failed and age_s is not None and age_s <= stale_after
        failing = recent
        kinds.append({
            "kind": kind,
            "n": n,
            # An `_err` kind is failures all the way down; a mixed one reports
            # only the rows that actually failed. A kind that failed twice in a
            # thousand runs must not be reported as a thousand failures.
            "failed": n if name_fail else errs,
            "newest": newest,
            "oldest": float(g.get("oldest") or 0),
            "sample": (g.get("sample") or "")[:200],
            "failing": failing,
            # How long since the newest entry. Published so a card can state the
            # fact rather than depend on `stale_after` being the right number.
            "ageS": age_s,
            # HAS failed, but not lately. NOT "healthy": these feeds log only on
            # failure, so this is absence of evidence, not evidence of health.
            "quiet": ever_failed and not recent,
            "everFailed": ever_failed,
            # "It is waiting for a key only you can supply" is a third state, not
            # a failure. Filing FRED under failures would bury the ones that are
            # genuinely broken, and the operator can act on this one.
            "needsYou": (not ever_failed) and needs > 0,
        })

    # Failing first, then what needs the operator, then what has gone quiet, then
    # the rest. A reader is asking "is anything wrong NOW", so a fault that
    # stopped recurring must not sit above one that is still happening.
    kinds.sort(key=lambda k: (
        0 if k["failing"] else 1 if k["needsYou"] else 2 if k["quiet"] else 3,
        -k["newest"],
    ))

    total = sum(k["n"] for k in kinds)
    failing = [k for k in kinds if k["failing"]]
    quiet = [k for k in kinds if k["quiet"]]
    out = {
        "ok": True,
        "kinds": kinds,
        "total": total,
        "failingTotal": sum(k["failed"] for k in failing),
        "failingKinds": len(failing),
        # Reported SEPARATELY rather than folded into the headline. It is the
        # difference between "eleven jobs are broken" and "eleven have failed at
        # some point, none in the last six hours".
        "quietKinds": len(quiet),
        "quietTotal": sum(k["quiet"] and k["failed"] or 0 for k in quiet),
        "staleAfterS": stale_after,
        "needsYouKinds": len([k for k in kinds if k["needsYou"]]),
        "since": min([k["oldest"] for k in kinds]) if kinds else 0,
    }
    if not kinds:
        out["emptyReason"] = (
            "nothing has been recorded yet - this is what the log holds, not a "
            "statement that everything worked"
        )
    return out


# The words that classify an event kind. THREE states, not two: a feed waiting
# for a key only the operator can supply is not broken, and filing it with the
# failures buries the ones that are.
ERR_WORDS = ("error", "locked", "timed out", "timeout", "refused", "exception",
             "traceback", "failed", "no data")
NEEDS_YOU_WORDS = ("set fred_api_key", "api key", "skipped: set")


def event_groups():
    """Per-kind counts over the WHOLE events table, with the newest message.

    THE COUNT HAS TO BE SQL. A 50-row tail reported a loop that had failed 2,067
    times as twelve lines, which is how it survived for releases.

    Lifted out of the facade's route so `svc/mcpserve.py` can publish it without
    writing a second copy of the classifier -- two lists of failure words would
    disagree, and nothing would say so.
    """
    # `lower(msg) LIKE` rather than `LIKE`: SQLite's LIKE ignores ASCII case and
    # Postgres's does not, and this driver supports both. A classifier that works
    # on one backend and silently matches nothing on the other is the vacuous
    # check this project keeps finding.
    errish = " OR ".join("lower(msg) LIKE '%%%s%%'" % w for w in ERR_WORDS)
    needsish = " OR ".join("lower(msg) LIKE '%%%s%%'" % w for w in NEEDS_YOU_WORDS)
    with db() as c:
        groups = [dict(r) for r in c.execute(
            "SELECT kind, count(*) AS n, max(t) AS newest, min(t) AS oldest, "
            "       sum(CASE WHEN (" + errish + ") THEN 1 ELSE 0 END) AS errs, "
            "       sum(CASE WHEN (" + needsish + ") THEN 1 ELSE 0 END) AS needsYou "
            "FROM events GROUP BY kind")]
        # THE SAMPLE IS THE NEWEST MESSAGE, not `max(msg)`. The first version used
        # the aggregate, which returns the lexicographically largest string in the
        # group -- so a kind whose newest row said "cycle done" could be
        # illustrated by an unrelated line from three weeks ago.
        newest = {r["kind"]: r["msg"] for r in c.execute(
            "SELECT kind, msg FROM events WHERE id IN (SELECT max(id) FROM events GROUP BY kind)")}
    for g in groups:
        g["sample"] = newest.get(g["kind"]) or ""
    return groups


def events_summary():
    """The background jobs' standing: what has failed, what is quiet, what waits
    on the operator. One owner for the route and the MCP tool."""
    return summarise_events(event_groups())


def yf_price(sym):
    """Last close via yfinance. Returns (price, None) or (None, reason). Never invents."""
    try:
        import yfinance as yf
        t = yf.Ticker(YF_MAP.get(sym, sym))
        p = None
        try: p = t.fast_info.last_price
        except Exception: pass
        if not p:
            h = t.history(period="1d", interval="1m")
            if len(h): p = float(h["Close"].iloc[-1])
        return (float(p), None) if p else (None, "no data")
    except Exception as e:
        return (None, str(e))

def yf_close_at(sym, ts):
    """Real close at/just before unix ts, or None (pending). Never interpolates."""
    try:
        import yfinance as yf
        # NAIVE UTC on purpose -- yfinance is handed these and this function
        # immediately compares them against an index it calls `tz_localize(None)`
        # on. `utcfromtimestamp` produced exactly that and is deprecated since
        # 3.12; this is the same value spelled in a way that keeps working.
        def _naive_utc(t):
            return dt.datetime.fromtimestamp(t, dt.UTC).replace(tzinfo=None)
        start = _naive_utc(ts - 6*3600); end = _naive_utc(ts + 3600)
        h = yf.Ticker(YF_MAP.get(sym, sym)).history(start=start, end=end, interval="1h")
        if not len(h): return None
        h = h[h.index.tz_localize(None) <= _naive_utc(ts)]
        return float(h["Close"].iloc[-1]) if len(h) else None
    except Exception:
        return None

YF_INTERVAL = {"1m":"1m","5m":"5m","15m":"15m","30m":"30m","1h":"1h","4h":"1h","1d":"1d","1w":"1wk"}
YF_PERIOD   = {"1m":"7d","5m":"60d","15m":"60d","30m":"60d","1h":"730d","4h":"730d","1d":"5y","1w":"10y"}

def yf_bars(sym, tf, need=300, keep_forming=False):
    """Real OHLC bars, headless. Returns (bars, None) or (None, reason).

    HONESTY: this is the SERVER's own fetch — it does NOT read ohlc_cache, because
    the cache is only as fresh as the last time the browser was open, and evaluating
    signals on stale cached bars is exactly the lie the freshness contract forbids.
    No bars -> no evaluation -> no alert. Never a guess.

    keep_forming=True returns (bars, None) with the forming bar last where the last element is the
    still-forming bar. Required because the SHIPPED sigScan detect loop stops at
    d.length-1, so the newest CLOSED bar is only reachable when a real bar sits
    behind it. The forming bar is never itself scanned for a signal."""
    try:
        import yfinance as yf
        iv, per = YF_INTERVAL.get(tf, "1h"), YF_PERIOD.get(tf, "730d")
        h = yf.Ticker(YF_MAP.get(sym, sym)).history(period=per, interval=iv)
        if h is None or not len(h):
            return None, "no data from vendor"
        rows = []
        for ts, r in h.iterrows():
            rows.append({"t": float(ts.timestamp() * 1000), "o": float(r["Open"]), "h": float(r["High"]),
                         "l": float(r["Low"]), "c": float(r["Close"]), "v": float(r.get("Volume") or 0)})
        # 4h is not a native yfinance interval: resample 1h -> 4h honestly (no synthesis,
        # only aggregation of real bars). Partial trailing bucket is DROPPED, not padded.
        if tf == "4h":
            out, i = [], 0
            while i + 4 <= len(rows):
                g = rows[i:i+4]
                out.append({"t": g[0]["t"], "o": g[0]["o"], "h": max(x["h"] for x in g),
                            "l": min(x["l"] for x in g), "c": g[-1]["c"], "v": sum(x["v"] for x in g)})
                i += 4
            rows = out
        # The last row is the still-forming bar. Signals fire on CLOSED bars only,
        # so it is never scanned — but sigScan's loop needs a bar behind the newest
        # closed one to reach it, so callers that alert keep it as a positional tail.
        if len(rows) < 82:
            return None, f"only {len(rows)} bars (need >=82)"
        return (rows[-need:] if keep_forming else rows[:-1][-need:]), None
    except Exception as e:
        return None, str(e)

def binance_bars(sym, tf, need=300, keep_forming=False):
    """Real OHLC bars from Binance, headless. Same contract as `yf_bars`.

    WHY THIS EXISTS

    `bars_loop` tops up the series the client enrolled, and it read:

        if src != "yfinance":
            continue

    MEASURED on the running gateway: 22 series enrolled, 10 of them binance —
    BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT and XRPUSDT at 1h and 1d — every one of
    them SKIPPED. The loop ticked hourly, reported a fresh `last_tick_age_s`,
    and did nothing for nearly half its list, which is the family CLAUDE.md
    names: a tick age is not a health check. Those are also exactly the markets
    the autonomous loop and the Playbook study.

    Binance's public klines need no key, so the comment's premise — "yfinance is
    the one source this process can reach without the browser" — was the thing
    that had stopped being true.

    THE LAST KLINE IS THE FORMING BAR and is dropped, like `yf_bars` drops its
    last row: a forming bar's close changes every tick, so storing one writes a
    number that was never a close.
    """
    try:
        import requests
        from venues import BINANCE_INTERVALS, binance_symbol, normalise_ms

        pair = binance_symbol(sym)
        if not pair:
            return None, f"binance does not list {sym}"
        iv = BINANCE_INTERVALS.get(tf)
        if not iv:
            return None, f"binance has no {tf} interval"

        # One extra, because the newest is the forming bar and gets dropped.
        limit = max(2, min(1000, int(need) + 1))
        r = requests.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": pair, "interval": iv, "limit": limit},
            timeout=20,
        )
        if r.status_code != 200:
            return None, f"binance answered {r.status_code} for {pair}"
        raw = r.json()
        if not isinstance(raw, list) or not raw:
            return None, f"no data from binance for {pair}"

        rows = [
            {
                "t": normalise_ms(k[0]),
                "o": float(k[1]),
                "h": float(k[2]),
                "l": float(k[3]),
                "c": float(k[4]),
                "v": float(k[5]),
            }
            for k in raw
        ]
        if not keep_forming:
            rows = rows[:-1]
        if not rows:
            return None, f"binance returned only a forming bar for {pair}"
        return rows[-need:], None
    except Exception as e:
        return None, str(e)


def send_tg(text):
    tok, chat = cfg("tg_token"), cfg("tg_chat")
    if not tok or not chat: return False
    try:
        r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                          json={"chat_id": chat, "text": text[:3900], "disable_web_page_preview": True}, timeout=10)
        return bool(r.ok and r.json().get("ok"))
    except Exception as e:
        log_event("tg_error", str(e)); return False
