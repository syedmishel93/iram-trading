#!/usr/bin/env python3
"""
Mishel Intelligence Trading — local data proxy
================================

One small server that gives the browser terminal real market data from the free
tiers of several providers. Browsers can't call yfinance / Polygon / Alpaca
directly (no CORS, no browser SDK), so this proxy sits in front of them and
speaks one simple, CORS-enabled JSON contract the terminal already understands.

Unified response schema (matches the terminal's internal bar format):
    { "bars": [ { "t": <ms epoch>, "o":.., "h":.., "l":.., "c":.., "v":.. }, ... ] }

Endpoints
---------
GET /health
GET /providers
GET /ohlc?provider=<p>&symbol=<s>&interval=<i>&limit=<n>&key=<k>&secret=<k2>
GET /quote?provider=<p>&symbol=<s>&key=<k>&secret=<k2>

`provider` is one of: yfinance, twelvedata, alphavantage, polygon, alpaca, binance
Keys may be passed as query params (?key=...) OR set as environment variables
(TWELVEDATA_KEY, ALPHAVANTAGE_KEY, POLYGON_KEY, ALPACA_KEY, ALPACA_SECRET).
yfinance and binance need no key.

Run
---
    pip install flask flask-cors requests yfinance
    python ddt_data_server.py
Then in the terminal → Settings → Data sources, set the proxy URL to
    http://127.0.0.1:8787
and pick "Local proxy" as the forex/stocks provider.

Security: this binds to localhost only by default. Use read-only market-data
keys. Never put a key with trade/withdraw permissions here.
"""

import datetime as dt
import os
import sys
import time
from zoneinfo import ZoneInfo

# `binance_symbol` and its tables live in `server/venues.py`, because
# `svc/core.py` needs them too to top up the enrolled binance series in the
# background. Those two are SIBLING mounted apps and neither may reach into the
# other; a leaf both import inverts nothing. Re-exported under its own name so
# every existing caller — and `tests/test_data_proxy_symbols.py` — still
# resolves it on this module. `__all__` is how this project states a re-export;
# `import x as x` is the other idiom and ruff flags it (PLC0414).
from venues import binance_symbol

__all__ = ["binance_symbol"]

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import requests
    from flask import Flask, Response, jsonify, request
    from flask_cors import CORS
except ImportError:
    raise SystemExit(
        "Missing dependencies. Install with:\n"
        "    pip install flask flask-cors requests yfinance\n"
    )

app = Flask(__name__)
CORS(app)  # allow the browser terminal (any localhost origin) to call us

HOST = os.environ.get("DDT_HOST", "127.0.0.1")
PORT = int(os.environ.get("DDT_PORT", "8787"))
TIMEOUT = 15

# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------

def env_key(name, fallback=""):
    return request.args.get(name) or os.environ.get(fallback, "")

def bad(msg, code=400):
    return jsonify({"error": msg}), code

def as_bars(rows):
    """rows: list of dicts already in {t,o,h,l,c,v}. Sort + clean."""
    out = []
    for r in rows:
        try:
            o, h, l, c = float(r["o"]), float(r["h"]), float(r["l"]), float(r["c"])
        except (KeyError, TypeError, ValueError):
            continue
        # `x == x` is FALSE only for NaN -- the one self-comparison that is not
        # a mistake, and the only NaN test that needs no import. Ruff's
        # PLR0124 cannot tell the two apart; suppressed here rather than
        # "fixed", because the fix silently stops dropping NaN bars.
        if not all(x == x for x in (o, h, l, c)):  # noqa: PLR0124  (drop NaN)
            continue
        out.append({
            "t": int(r["t"]),
            "o": o, "h": h, "l": l, "c": c,
            "v": float(r.get("v") or 0.0),
        })
    out.sort(key=lambda x: x["t"])
    return out

# ----------------------------------------------------------------------------
# symbol + interval normalisation (per provider)
# ----------------------------------------------------------------------------

# The terminal uses plain symbols like BTCUSD, EURUSD, XAUUSD, AAPL, NVDA.
# Each provider wants its own dialect.

FX_PAIRS = {"EURUSD","GBPUSD","USDJPY","AUDUSD","USDCHF","USDCAD","NZDUSD",
            "EURJPY","GBPJPY","EURGBP","AUDJPY","EURAUD"}
METALS   = {"XAUUSD","XAGUSD"}
CRYPTO   = {"BTCUSD","ETHUSD","SOLUSD","XRPUSD","BNBUSD","DOGEUSD","ADAUSD"}

# Index CFD names -> Yahoo CASH INDEX tickers.
#
# Only the four the terminal models a session for. `data/sessions.ts` treats an
# index CFD as a US equity and judges its coverage with `isEquityOpen`, which is
# the NYSE regular session — correct for these and wrong for GER40 or JPN225,
# whose `equityVenue` is null and whose coverage would therefore be measured
# against the full wall clock. An RTH-only European index judged that way scores
# about 25% and the backtester discards it: the same "downloaded, then thrown
# away" failure the metals calendar fix removed. Adding those names here without
# a session model for them would put it straight back.
#
# CASH INDEX (^GSPC), not the E-mini (ES=F), and that is the deliberate half:
# the cash index trades exactly the RTH session the coverage model assumes, and
# Yahoo serves 630 days of hourly history for it against 189 for the future.
YF_INDEX = {
    "SPX500": "^GSPC",
    "NAS100": "^NDX",
    "US30":   "^DJI",
    "US2000": "^RUT",
}


def yf_symbol(sym):
    s = sym.upper()
    if s in CRYPTO:  return s.replace("USD", "") + "-USD"        # BTC-USD
    if s in FX_PAIRS: return s + "=X"                            # EURUSD=X
    if s == "XAUUSD": return "GC=F"                              # gold future
    if s == "XAGUSD": return "SI=F"                              # silver future
    if s in YF_INDEX: return YF_INDEX[s]                         # SPX500 -> ^GSPC
    return s                                                     # AAPL, ^NDX...

def slash_symbol(sym):
    s = sym.upper()
    if len(s) == 6 and (s in FX_PAIRS or s in METALS or s in CRYPTO):
        return s[:3] + "/" + s[3:]                              # EUR/USD
    return s

def polygon_ticker(sym):
    s = sym.upper()
    if s in CRYPTO:  return "X:" + s.replace("USD","") + "USD"  # X:BTCUSD
    if s in FX_PAIRS or s in METALS: return "C:" + s           # C:EURUSD
    return s                                                    # AAPL

INTERVALS = {
    # canonical -> (yfinance, twelvedata, alphavantage, polygon(mult,span), binance)
    "1m":  ("1m",  "1min",  "1min",  (1,"minute"),  "1m"),
    "5m":  ("5m",  "5min",  "5min",  (5,"minute"),  "5m"),
    "15m": ("15m", "15min", "15min", (15,"minute"), "15m"),
    "30m": ("30m", "30min", "30min", (30,"minute"), "30m"),
    "1h":  ("1h",  "1h",    "60min", (1,"hour"),    "1h"),
    "4h":  ("1h",  "4h",    "60min", (4,"hour"),    "4h"),  # yf/av lack native 4h
    "1d":  ("1d",  "1day",  "daily", (1,"day"),     "1d"),
    "1w":  ("1wk", "1week", "weekly",(1,"week"),    "1w"),
    "1M":  ("1mo", "1month","monthly",(1,"month"),  "1M"),
}
def imap(interval, idx):
    return INTERVALS.get(interval, INTERVALS["1h"])[idx]

# ----------------------------------------------------------------------------
# providers — each returns a list of {t,o,h,l,c,v}
# ----------------------------------------------------------------------------

def p_yfinance(symbol, interval, limit):
    import yfinance as yf
    yint = imap(interval, 0)
    # pick a period generous enough for `limit` bars of this interval
    period = {"1m":"7d","5m":"60d","15m":"60d","30m":"60d","1h":"730d",
              "4h":"730d","1d":"5y","1wk":"10y","1mo":"max"}.get(yint, "2y")
    df = yf.download(yf_symbol(symbol), interval=yint, period=period,
                     progress=False, auto_adjust=False, threads=False)
    if df is None or df.empty:
        return []
    df = df.tail(limit)
    rows = []
    for idx, row in df.iterrows():
        ts = int(idx.timestamp() * 1000)
        # `row` is captured from the loop and that is SAFE HERE, checked rather
        # than assumed: every call to `g` is in the `rows.append` on the next
        # line, so the function never outlives the iteration that defined it.
        # Kept as-is rather than refactored on a linter's advice -- the rule is
        # right about the pattern being fragile and wrong about this instance,
        # and a speculative rewrite of working extraction code is the more
        # expensive mistake. The suppression is narrow so the rule keeps
        # watching for a closure that DOES escape.
        def g(col):
            v = row[col]  # noqa: B023  (called within this iteration only)
            try: return float(v.iloc[0]) if hasattr(v, "iloc") else float(v)
            except Exception: return float("nan")
        rows.append({"t": ts, "o": g("Open"), "h": g("High"),
                     "l": g("Low"), "c": g("Close"), "v": g("Volume")})
    return rows

# ---------------------------------------------------------------------------
# TIMEZONES, AND THE BUG THIS SECTION EXISTS TO STATE
#
# `t` in every row this module returns is epoch MILLISECONDS UTC. Two providers
# hand back a formatted local string instead, and both were parsed with
#
#     dt.datetime.strptime(s, "%Y-%m-%d %H:%M:%S").timestamp()
#
# which is wrong on every machine. `strptime` produces a NAIVE datetime and
# `.timestamp()` then reads a naive datetime as LOCAL time -- so every bar was
# displaced by the server's own UTC offset. MEASURED on the development machine
# (Romance Daylight Time, UTC+2): "2026-09-10 14:00:00" became 12:00 UTC. Not a
# constant error either; it moves with the machine and with daylight saving, so
# the same request returns different bars in March and in July.
#
# The zone is per PROVIDER and per ENDPOINT, and guessing one for all of them is
# how this gets quietly re-broken:
#
#   TwelveData      — returns EXCHANGE local time by default, and accepts a
#                     `timezone` parameter. Asked for UTC at the source below,
#                     which removes the ambiguity instead of compensating for it.
#   AlphaVantage    — no timezone parameter. FX_* endpoints are documented UTC;
#                     TIME_SERIES_* intraday is US/Eastern. The code already
#                     knows which it asked for, via `is_fx`.
#   DAILY bars      — anchored to midnight UTC regardless of provider, matching
#                     what Binance returns, so a daily candle does not sit at
#                     04:00 on one source and 00:00 on another.
# ---------------------------------------------------------------------------

def p_twelvedata(symbol, interval, limit):
    key = env_key("key", "TWELVEDATA_KEY")
    if not key: raise ValueError("twelvedata needs a key")
    r = requests.get("https://api.twelvedata.com/time_series", timeout=TIMEOUT,
        params={"symbol": slash_symbol(symbol), "interval": imap(interval,1),
                "outputsize": min(limit,5000), "apikey": key,
                # Asked for, not assumed. Without it the default is the
                # exchange's own zone, which differs per symbol.
                "timezone": "UTC"})
    j = r.json()
    if j.get("status") == "error":
        raise ValueError(j.get("message","twelvedata error"))
    vals = j.get("values", [])
    return [{"t": int(dt.datetime.strptime(v["datetime"],
             "%Y-%m-%d %H:%M:%S" if " " in v["datetime"] else "%Y-%m-%d"
             ).replace(tzinfo=dt.UTC).timestamp()*1000),
             "o": v["open"], "h": v["high"], "l": v["low"], "c": v["close"],
             "v": v.get("volume", 0)} for v in vals]

def p_alphavantage(symbol, interval, limit):
    key = env_key("key", "ALPHAVANTAGE_KEY")
    if not key: raise ValueError("alphavantage needs a key")
    intra = interval in ("1m","5m","15m","30m","1h","4h")
    s = symbol.upper()
    is_fx = s in FX_PAIRS or s in METALS
    if is_fx:
        fn = "FX_INTRADAY" if intra else "FX_DAILY"
        params = {"function": fn, "from_symbol": s[:3], "to_symbol": s[3:],
                  "outputsize": "compact", "apikey": key}
        if intra: params["interval"] = imap(interval,2)
    else:
        fn = "TIME_SERIES_INTRADAY" if intra else "TIME_SERIES_DAILY"
        params = {"function": fn, "symbol": s, "outputsize": "compact",
                  "apikey": key}
        if intra: params["interval"] = imap(interval,2)
    j = requests.get("https://www.alphavantage.co/query", params=params,
                     timeout=TIMEOUT).json()
    if "Note" in j or "Information" in j:
        raise ValueError("alphavantage rate limit — wait a minute")
    ts_key = next((k for k in j if "Time Series" in k or "FX" in k), None)
    if not ts_key: raise ValueError(j.get("Error Message","no data"))
    rows = []
    # FX intraday is UTC; equity intraday is US/Eastern; daily is anchored to
    # midnight UTC either way. See the note above p_twelvedata.
    zone = dt.UTC if (is_fx or not intra) else ZoneInfo("America/New_York")
    for tstr, ohlc in j[ts_key].items():
        fmt = "%Y-%m-%d %H:%M:%S" if " " in tstr else "%Y-%m-%d"
        rows.append({"t": int(dt.datetime.strptime(tstr, fmt)
                             .replace(tzinfo=zone).timestamp()*1000),
            "o": ohlc.get("1. open"), "h": ohlc.get("2. high"),
            "l": ohlc.get("3. low"), "c": ohlc.get("4. close"),
            "v": ohlc.get("5. volume", 0) or ohlc.get("6. volume", 0)})
    return rows[:limit]

def p_polygon(symbol, interval, limit):
    key = env_key("key", "POLYGON_KEY")
    if not key: raise ValueError("polygon needs a key")
    mult, span = imap(interval, 3)
    # The UTC date, not the machine's. `date.today()` rolls over at local
    # midnight, so for a few hours a day two servers asked for different ranges.
    end = dt.datetime.now(dt.UTC).date()
    start = end - dt.timedelta(days=730)
    url = (f"https://api.polygon.io/v2/aggs/ticker/{polygon_ticker(symbol)}"
           f"/range/{mult}/{span}/{start}/{end}")
    j = requests.get(url, timeout=TIMEOUT,
        params={"adjusted":"true","sort":"asc","limit":50000,"apiKey":key}).json()
    if j.get("status") == "ERROR" or "results" not in j:
        raise ValueError(j.get("error", j.get("message","polygon error")))
    res = j["results"][-limit:]
    return [{"t": r["t"], "o": r["o"], "h": r["h"], "l": r["l"],
             "c": r["c"], "v": r.get("v",0)} for r in res]

def p_alpaca(symbol, interval, limit):
    key = env_key("key", "ALPACA_KEY")
    sec = env_key("secret", "ALPACA_SECRET")
    if not (key and sec): raise ValueError("alpaca needs key + secret")
    tf = {"1m":"1Min","5m":"5Min","15m":"15Min","30m":"30Min","1h":"1Hour",
          "4h":"4Hour","1d":"1Day","1w":"1Week","1M":"1Month"}.get(interval,"1Hour")
    s = symbol.upper()
    hdr = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": sec}
    if s in CRYPTO:
        pair = s.replace("USD","") + "/USD"
        url = "https://data.alpaca.markets/v1beta3/crypto/us/bars"
        params = {"symbols": pair, "timeframe": tf, "limit": min(limit,10000)}
        j = requests.get(url, headers=hdr, params=params, timeout=TIMEOUT).json()
        bars = j.get("bars", {}).get(pair, [])
    else:
        url = f"https://data.alpaca.markets/v2/stocks/{s}/bars"
        params = {"timeframe": tf, "limit": min(limit,10000), "adjustment":"raw"}
        j = requests.get(url, headers=hdr, params=params, timeout=TIMEOUT).json()
        bars = j.get("bars", [])
    if not bars:
        raise ValueError(j.get("message","no bars (stocks need a data plan; crypto is free)"))
    # `fromisoformat` has parsed a trailing "Z" itself since 3.11, and this
    # project's floor is 3.12 (see ruff.toml) -- so the `.replace` was a
    # rewrite of a string into the form the parser already accepted.
    return [{"t": int(dt.datetime.fromisoformat(b["t"])
             .timestamp()*1000), "o": b["o"], "h": b["h"], "l": b["l"],
             "c": b["c"], "v": b.get("v",0)} for b in bars]

def p_binance(symbol, interval, limit):
    bs = binance_symbol(symbol)
    if not bs: raise ValueError("crypto only (BTCUSD, ETHUSD, ...)")
    j = requests.get("https://data-api.binance.vision/api/v3/klines", timeout=TIMEOUT,
        params={"symbol": bs, "interval": imap(interval,4),
                "limit": min(limit,1000)}).json()
    if isinstance(j, dict):
        # ValueError, not TypeError, and the `isinstance` above is why TRY004
        # misreads it: a dict here is not a caller passing the wrong type, it is
        # Binance answering with an error OBJECT where the contract says list.
        # That is a bad value from a remote service.
        raise ValueError(j.get("msg", "binance error"))  # noqa: TRY004
    return [{"t": k[0], "o": k[1], "h": k[2], "l": k[3], "c": k[4], "v": k[5]}
            for k in j]

# ----------------------------------------------------------------------------
# v36.0 — MT5: THE BROKER IS THE SOURCE OF TRUTH
# ----------------------------------------------------------------------------
# Everything above this line is a VENDOR's idea of the price. Only this one is the
# price you will actually be filled at. For FX and metals on an MT5 broker — with its
# own server time, its own spread profile, its own daily close — a vendor series is
# not an approximation of your market, it is a DIFFERENT market.
try:
    import mt5_bridge
except Exception:                                   # never take the proxy down over this
    mt5_bridge = None

def p_mt5(symbol, interval, limit):
    if mt5_bridge is None:
        raise RuntimeError("mt5_bridge not importable on this host")
    bars, err = mt5_bridge.bars(symbol, interval, limit)
    if err:
        raise RuntimeError(err)                     # honest failure -> the chain fails over
    return bars

PROVIDERS = {
    "mt5": p_mt5,                                   # <- broker first for FX/metals
    "yfinance": p_yfinance, "twelvedata": p_twelvedata,
    "alphavantage": p_alphavantage, "polygon": p_polygon,
    "alpaca": p_alpaca, "binance": p_binance,
}

# The honest ranking the terminal reads to pick an upstream. MT5 outranks everything
# for the instruments Nazrul actually trades; crypto stays on the exchanges, which ARE
# the venue. A provider is only offered if it can actually serve.
PROVIDER_RANK = {
    "fx":     ["mt5", "twelvedata", "yfinance"],
    "metals": ["mt5", "twelvedata", "yfinance"],
    "crypto": ["binance", "mt5", "yfinance"],
    "stocks": ["mt5", "polygon", "alpaca", "yfinance"],
}

# ----------------------------------------------------------------------------
# routes
# ----------------------------------------------------------------------------

@app.route("/health")
def health():
    return jsonify({"ok": True, "time": int(time.time()*1000)})

@app.route("/providers")
def providers():
    return jsonify({"providers": list(PROVIDERS),
                    "keyless": ["yfinance","binance"]})

@app.route("/ohlc")
def ohlc():
    provider = (request.args.get("provider") or "yfinance").lower()
    symbol   = request.args.get("symbol", "")
    interval = request.args.get("interval", "1h")
    limit    = int(request.args.get("limit", "360"))
    if provider not in PROVIDERS: return bad(f"unknown provider '{provider}'")
    if not symbol: return bad("symbol is required")
    try:
        bars = as_bars(PROVIDERS[provider](symbol, interval, limit))
    except Exception as e:
        return bad(f"{provider}: {e}", 502)
    if not bars: return bad(f"{provider}: no data for {symbol}", 404)
    out = {"provider": provider, "symbol": symbol,
           "interval": interval, "bars": bars}
    # MT5 timestamps are corrected from the broker's clock to UTC before they
    # leave the bridge. The correction travels WITH the bars rather than only in
    # /mt5/health, so the terminal can show what was applied to the series it is
    # actually drawing instead of to a separate probe made at another moment.
    if provider == "mt5" and mt5_bridge is not None:
        try:
            off, note = mt5_bridge.measure_offset()
            out["clock"] = {"offset_ms": int(off * 1000) if off is not None else 0,
                            "label": mt5_bridge._offset_label(off),
                            "measured": off is not None, "note": note}
        except Exception as e:
            out["clock"] = {"offset_ms": 0, "label": "unknown",
                            "measured": False, "note": str(e)}
    return jsonify(out)

# ----------------------------------------------------------------------------
# v36.0 MT5 routes — bars come through /ohlc?provider=mt5 like any other provider;
# these expose what ONLY the broker can tell you.
# ----------------------------------------------------------------------------
@app.route("/mt5/health")
def mt5_health():
    """Never 500s. Says exactly why it cannot serve, so the UI can show the real reason
    instead of a generic 'no data'."""
    if mt5_bridge is None:
        return jsonify({"available": False, "reason": "mt5_bridge module not importable",
                        "connected": False, "platform": "unknown"})
    return jsonify(mt5_bridge.health())

@app.route("/mt5/symbols")
def mt5_symbols():
    if mt5_bridge is None: return bad("mt5_bridge unavailable", 503)
    try:
        return jsonify({"symbols": mt5_bridge.symbols()})
    except Exception as e:
        return bad(str(e), 503)

@app.route("/mt5/tick")
def mt5_tick():
    """Live bid/ask + the REAL spread you are paying right now. This is what replaces
    the hard-coded 2bps spread guess that every signal's cost estimate has been using."""
    sym = request.args.get("symbol", "")
    if not sym: return bad("symbol is required")
    if mt5_bridge is None: return bad("mt5_bridge unavailable", 503)
    d, err = mt5_bridge.tick(sym)
    if err: return bad(err, 502)
    return jsonify(d)

@app.route("/mt5/symbol")
def mt5_symbol():
    """The instrument's real cost profile: spread, contract size, tick value, swap
    long/short, min stop distance. A backtest without these is fiction."""
    sym = request.args.get("symbol", "")
    if not sym: return bad("symbol is required")
    if mt5_bridge is None: return bad("mt5_bridge unavailable", 503)
    d, err = mt5_bridge.symbol_info(sym)
    if err: return bad(err, 502)
    return jsonify(d)

@app.route("/mt5/account")
def mt5_account():
    if mt5_bridge is None: return bad("mt5_bridge unavailable", 503)
    d, err = mt5_bridge.account()
    if err: return bad(err, 502)
    return jsonify(d)

@app.route("/mt5/positions")
def mt5_positions():
    if mt5_bridge is None: return bad("mt5_bridge unavailable", 503)
    d, err = mt5_bridge.positions()
    if err: return bad(err, 502)
    return jsonify({"positions": d})

@app.route("/mt5/deals")
def mt5_deals():
    """Your closed fills. The raw material that turns 'the system's record' into YOURS."""
    days = int(request.args.get("days", "90"))
    if mt5_bridge is None: return bad("mt5_bridge unavailable", 503)
    d, err = mt5_bridge.deals(days)
    if err: return bad(err, 502)
    return jsonify({"deals": d, "days": days})

@app.route("/providers/rank")
def providers_rank():
    return jsonify({"rank": PROVIDER_RANK,
                    "note": "mt5 outranks vendors for fx/metals/stocks: it is the venue you are filled at"})

@app.route("/quote")
def quote():
    provider = (request.args.get("provider") or "yfinance").lower()
    symbol   = request.args.get("symbol", "")
    if provider not in PROVIDERS: return bad(f"unknown provider '{provider}'")
    if not symbol: return bad("symbol is required")
    try:
        bars = as_bars(PROVIDERS[provider](symbol, "1m", 2))
        if not bars:
            bars = as_bars(PROVIDERS[provider](symbol, "1h", 2))
    except Exception as e:
        return bad(f"{provider}: {e}", 502)
    if not bars: return bad("no quote", 404)
    last = bars[-1]
    return jsonify({"provider": provider, "symbol": symbol,
                    "price": last["c"], "t": last["t"]})

@app.route("/fetch")
def fetch_ext():
    """Generic GET passthrough so the browser can reach news / economic-calendar /
    order-flow endpoints without CORS. PERSONAL USE: it can reach any URL you pass,
    so only wire endpoints you trust. Bound to localhost by default."""
    url = request.args.get("url", "")
    if not url.startswith(("http://", "https://")):
        return bad("url must start with http:// or https://")
    try:
        r = requests.get(url, timeout=20, headers={"User-Agent": "MishelTerminal/1.0"})
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get("content-type", "application/json"))
    except Exception as e:
        return bad(str(e), 502)

@app.route("/ai", methods=["POST"])
def ai():
    """AI Desk Analyst backend. Supports two modes:
    - Agentic tool-use: body = {system, messages, tools} -> returns {stop_reason, content}
      (the browser executes tool calls against the terminal's real functions and loops back).
    - Legacy single-shot: body = {question, context} -> returns {text}.
    Enable by setting ANTHROPIC_API_KEY (and optionally AI_MODEL) on the proxy."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return bad("no ANTHROPIC_API_KEY set on the proxy — the terminal will use its built-in analyst", 400)
    body = request.get_json(force=True, silent=True) or {}
    agentic = "messages" in body
    if agentic:
        payload = {"model": os.environ.get("AI_MODEL", "claude-3-5-sonnet-latest"),
                   "max_tokens": 1200, "system": body.get("system", ""),
                   "messages": body["messages"]}
        if body.get("tools"):
            payload["tools"] = body["tools"]
    else:
        payload = {"model": os.environ.get("AI_MODEL", "claude-3-5-haiku-latest"),
                   "max_tokens": 700,
                   "system": ("You are a professional trading-desk analyst. Be concise and specific, "
                              "reference the provided indicator context, stay glass-box, and never give "
                              "financial advice or promise outcomes."),
                   "messages": [{"role": "user",
                                 "content": f"Chart context:\n{body.get('context','')}\n\nQuestion: {body.get('question','')}"}]}
    try:
        r = requests.post("https://api.anthropic.com/v1/messages", timeout=60,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                                   "content-type": "application/json"}, json=payload)
        j = r.json()
        if isinstance(j, dict) and j.get("content") is not None:
            if agentic:
                return jsonify({"stop_reason": j.get("stop_reason"), "content": j["content"]})
            txt = "".join(b.get("text", "") for b in j["content"] if b.get("type") == "text")
            return jsonify({"text": txt or "(empty response)"})
        return bad(j.get("error", {}).get("message", "AI provider error"), 502)
    except Exception as e:
        return bad(str(e), 502)

if __name__ == "__main__":
    print("=" * 60)
    print("  Mishel data proxy")
    print(f"  listening on  http://{HOST}:{PORT}")
    print("  paste that URL into the terminal → Settings → Data sources")
    print("  providers:", ", ".join(PROVIDERS))
    print("=" * 60)
    app.run(host=HOST, port=PORT, threaded=True)
