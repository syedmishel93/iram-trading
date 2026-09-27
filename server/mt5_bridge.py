#!/usr/bin/env python3
"""
v36.0 — MT5 BRIDGE  (server/mt5_bridge.py)

WHY THIS IS THE MOST IMPORTANT FILE IN THE PROJECT

Until now the terminal analysed one price series and you traded a different one.
Bars came from yfinance (~15m delayed) or Twelve Data or Binance. Your fills come
from YOUR BROKER. So every ATR, every swing stop, every prev-day level, every
"OOS win%" was computed on prices you would never be filled at. For crypto that is
a rounding error. For XAUUSD and EURUSD on an MT5 broker with its own server time,
its own spread profile and its own daily close, it is a STRUCTURAL DEFECT.

This makes the broker the source of truth. Everything downstream becomes true.

HONEST LIMITS (stated, not hidden)
  · The MetaTrader5 package is WINDOWS-ONLY. On Linux/macOS this module imports
    cleanly and reports available() == (False, reason). It never fakes a bar.
  · MT5 must be RUNNING and logged in. We do not store or handle credentials.
  · Broker symbol names differ (EURUSD / EURUSD.a / EURUSD.m / EURUSDpro).
    resolve_symbol() finds the broker's real name from its own symbol list —
    it never guesses a name that the broker did not report.
  · Bars are the broker's BID series (MT5 convention). The ask side is spread
    away; we expose the live spread rather than pretending it is zero.

Every pure function here (tf mapping, symbol resolution, deal shaping, bar shaping)
is unit-tested WITHOUT MetaTrader5 installed. Only the thin I/O layer needs Windows.
"""
import platform
import time

# --------------------------------------------------------------------------
# guarded import — this module MUST import cleanly on every OS
# --------------------------------------------------------------------------
_MT5 = None
_IMPORT_ERR = None
try:
    import MetaTrader5 as _MT5
except Exception as _e:                 # pragma: no cover - platform dependent
    _MT5 = None
    _IMPORT_ERR = str(_e)

_STATE = {"connected": False, "last_err": None, "account": None, "symbols": None,
          # The broker's server-time offset, in seconds, and when it was taken.
          # None means "not measured", which means "do not adjust anything".
          "offset_s": None, "offset_t": 0.0, "offset_note": "not measured yet"}


# ==========================================================================
# PURE LOGIC — no MT5 needed, fully unit-tested
# ==========================================================================

# MT5 timeframe constants (hard-coded so the mapping is testable without the package)
TF_CONST = {
    "1m": 1, "5m": 5, "15m": 15, "30m": 30,
    "1h": 16385, "4h": 16388, "1d": 16408, "1w": 32769,
}
TF_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800,
              "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}


def mt5_tf(tf):
    """'1h' -> MT5 TIMEFRAME_H1 constant. Unknown -> None (never a silent default:
    a wrong timeframe silently produces a wrong chart, which is worse than an error)."""
    return TF_CONST.get(str(tf).lower())


def resolve_symbol(want, available):
    """Find the broker's ACTUAL name for a symbol.

    Brokers rename things: EURUSD may be 'EURUSD.a', 'EURUSDm', 'EURUSD.pro',
    'GOLD' instead of 'XAUUSD'. Guessing a name the broker never reported is how
    you end up charting the wrong instrument, so we only ever return a name that
    is actually present in `available`.

    Order: exact -> known alias -> prefix (shortest suffix wins) -> None.
    """
    if not want:
        return None
    want = want.upper().strip()
    avail = [str(s) for s in (available or [])]
    up = {s.upper(): s for s in avail}

    if want in up:
        return up[want]

    for alias in ALIASES.get(want, []):
        if alias.upper() in up:
            return up[alias.upper()]

    # prefix match: EURUSD -> EURUSD.a / EURUSDm / EURUSD.pro
    # shortest suffix first => prefer 'EURUSD.a' over 'EURUSD.a.fix'
    cands = sorted((s for s in avail if s.upper().startswith(want)), key=len)
    if cands:
        return cands[0]

    for alias in ALIASES.get(want, []):
        cands = sorted((s for s in avail if s.upper().startswith(alias.upper())), key=len)
        if cands:
            return cands[0]
    return None


ALIASES = {
    "XAUUSD": ["GOLD", "GOLDUSD", "XAU/USD"],
    "XAGUSD": ["SILVER", "SILVERUSD", "XAG/USD"],
    "US30":   ["DJ30", "DOW", "US30Cash"],
    "NAS100": ["USTEC", "NDX100", "NAS100Cash"],
    "SPX500": ["US500", "SP500", "SPX500Cash"],
    "BTCUSD": ["BTCUSD", "BITCOIN"],
}


# ==========================================================================
# SERVER TIME — the three-hour bug
# ==========================================================================
#
# MT5 does not stamp anything in UTC. `rates['time']`, `tick.time` and
# `deal.time` are all seconds on the BROKER'S OWN CLOCK, handed over as a bare
# integer that looks exactly like a POSIX timestamp and is not one. Multiply by
# 1000 and you have a millisecond epoch that is wrong by the broker's UTC
# offset — for the usual EET/EEST broker, two or three whole hours.
#
# MEASURED, on this machine, against this broker: +3.000 hours. Every gold and
# forex bar the terminal has ever drawn was stamped three hours into the future.
# What that broke, in order of how much it costs:
#
#   · The bar countdown FROZE. It corrects the local clock against the feed,
#     and a feed three hours ahead pins the correction at the full bar span
#     for ever — "1:00" on a 1m chart, never moving, for ever.
#   · Session shading, the London/NY opens and the economic-calendar gate
#     ("no high-impact event within 30 min") were all asked about the wrong
#     three hours. That gate is one of the ones that refuses trades.
#   · Cross-asset training joined gold against Binance's genuine UTC bars with
#     a three-hour misalignment, so every driver was silently lagged.
#
# HOW THE OFFSET IS OBTAINED, AND WHY IT IS NOT A SETTING
# A configured offset is wrong twice a year, silently, on the DST changeover —
# and it is wrong immediately for anyone whose broker is not the one this was
# written against. So it is measured instead, from the only clock reading MT5
# actually gives us: a live tick's own timestamp is "now" on the server clock,
# so `tick.time*1000 - real_utc_now` IS the offset.
#
# Two things make that measurement safe:
#   · A stale tick reads EARLIER than server-now, never later, so sampling
#     several liquid symbols and taking the MAXIMUM discards staleness rather
#     than averaging it in.
#   · Real broker offsets are whole or half hours, so the result is rounded to
#     the nearest quarter hour. That absorbs the seconds of transit latency
#     without ever inventing an offset that no venue keeps.
#
# And when it cannot be measured, NOTHING IS ADJUSTED and `health()` says so.
# A guessed offset is worse than a known-wrong one: wrong by an unknown amount
# is indistinguishable from correct.

#: Rounding granularity. Broker offsets are whole or half hours; a quarter hour
#: absorbs transit latency without inventing an offset no venue keeps.
OFFSET_QUANTUM_S = 900

#: Beyond this, the reading is not a timezone and is refused. Earth's real span
#: is UTC-12..UTC+14; anything outside it is a broken clock, not a venue.
MAX_OFFSET_S = 14 * 3600 + 60

#: How long a measured offset is trusted before it is taken again. Short enough
#: that a DST changeover is picked up within the hour it happens.
OFFSET_TTL_S = 900

#: Sampled to measure the offset. Liquid and near-24h, so at least one has a
#: fresh tick whenever any market is open at all.
OFFSET_PROBES = ("EURUSD", "XAUUSD", "GBPUSD", "USDJPY", "BTCUSD")


def quantise_offset(seconds, quantum=OFFSET_QUANTUM_S):
    """Round a raw offset reading to the nearest real timezone step.

    Returns None when the reading is not a plausible timezone — see MAX_OFFSET_S.
    Pure, so the rounding is tested without a broker.
    """
    try:
        raw = float(seconds)
    except (TypeError, ValueError):
        return None
    if raw != raw or abs(raw) > MAX_OFFSET_S:  # noqa: PLR0124  (raw != raw is NaN)
        return None
    q = int(quantum) or 1
    # round-half-away-from-zero, so -1.5 quanta goes to -2 rather than -1: a
    # negative offset must not be pulled toward zero when a positive one is not.
    n = int(raw / q + (0.5 if raw >= 0 else -0.5))
    return n * q


def offset_from_ticks(tick_times_s, now_s):
    """Best offset estimate from several tick timestamps, in seconds.

    MAX, not mean: a stale tick reads earlier than server-now and never later,
    so the freshest sample is the most correct one and averaging would drag the
    answer toward whichever symbol happened to be quiet. Returns None when
    there is nothing usable to measure from.
    """
    best = None
    for t in (tick_times_s or []):
        try:
            v = float(t)
        except (TypeError, ValueError):
            continue
        if v <= 0 or v != v:  # noqa: PLR0124  (v != v is NaN)
            continue
        if best is None or v > best:
            best = v
    if best is None:
        return None
    return quantise_offset(best - float(now_s))


def shape_bars(rates, tf, offset_ms=0):
    """MT5 rates -> the terminal's {t,o,h,l,c,v} in ms, in real UTC.

    MT5 gives seconds; the terminal is milliseconds. `offset_ms` is the broker's
    server-time offset, SUBTRACTED here so that every consumer downstream —
    chart, sessions, calendar, cross-asset join — sees one clock. `tick_volume`
    is the honest volume for FX (there is no real exchange volume in OTC forex)
    — we pass it through as v and never dress it up as traded size.
    """
    off = int(offset_ms or 0)
    out = []
    for r in (rates or []):
        try:
            out.append({
                "t": int(r["time"]) * 1000 - off,
                "o": float(r["open"]), "h": float(r["high"]),
                "l": float(r["low"]),  "c": float(r["close"]),
                "v": float(r.get("tick_volume") or 0),
            })
        except (KeyError, TypeError, ValueError):
            continue                      # a malformed bar is dropped, never patched
    out.sort(key=lambda b: b["t"])
    return out


def shape_deal(d, offset_ms=0):
    """One MT5 deal -> a plain dict. Everything the reconciliation engine needs and
    nothing it does not. Costs are kept SEPARATE (commission / swap / profit) because
    the whole point is to see where the money actually went."""
    g = (lambda k, dflt=0: d.get(k, dflt) if isinstance(d, dict) else getattr(d, k, dflt))
    return {
        "ticket":      int(g("ticket")),
        "order":       int(g("order")),
        "position_id": int(g("position_id")),
        "time_ms":     int(g("time")) * 1000 - int(offset_ms or 0),
        "type":        int(g("type")),          # 0 = BUY, 1 = SELL
        "entry":       int(g("entry")),         # 0 = IN, 1 = OUT, 2 = INOUT
        "symbol":      str(g("symbol", "")),
        "volume":      float(g("volume")),
        "price":       float(g("price")),
        "commission":  float(g("commission")),
        "swap":        float(g("swap")),
        "profit":      float(g("profit")),
        "comment":     str(g("comment", "")),
    }


def shape_symbol_info(si):
    """The cost profile that makes a backtest honest. This is what replaces the
    single flat `costBps` the whole system has been using for every instrument."""
    g = (lambda k, dflt=0: si.get(k, dflt) if isinstance(si, dict) else getattr(si, k, dflt))
    point = float(g("point") or 0)
    digits = int(g("digits") or 0)
    return {
        "symbol":         str(g("name", "")),
        "digits":         digits,
        "point":          point,
        "spread_points":  int(g("spread") or 0),
        "spread_price":   round(int(g("spread") or 0) * point, max(digits, 1)),
        "contract_size":  float(g("trade_contract_size") or 0),
        "tick_value":     float(g("trade_tick_value") or 0),
        "tick_size":      float(g("trade_tick_size") or 0),
        "volume_min":     float(g("volume_min") or 0),
        "volume_step":    float(g("volume_step") or 0),
        "stops_level":    int(g("trade_stops_level") or 0),   # min stop distance, in points
        "swap_long":      float(g("swap_long") or 0),
        "swap_short":     float(g("swap_short") or 0),
    }


# ==========================================================================
# I/O LAYER — needs Windows + a running, logged-in MT5 terminal
# ==========================================================================

def available():
    """(ok, reason). Never raises. Never lies."""
    if _MT5 is None:
        if platform.system() != "Windows":
            return False, (f"MetaTrader5 package is Windows-only (this host is "
                           f"{platform.system()}). Run the bridge on the machine where MT5 runs.")
        return False, f"MetaTrader5 package not importable: {_IMPORT_ERR}"
    return True, "ok"


def connect():
    """Attach to the ALREADY-RUNNING MT5 terminal. We never take credentials:
    you log in to MT5 yourself, we just read what it shows you."""
    ok, why = available()
    if not ok:
        _STATE["last_err"] = why
        return False, why
    try:
        if not _MT5.initialize():
            e = _MT5.last_error()
            _STATE["connected"] = False
            _STATE["last_err"] = f"initialize() failed: {e}"
            return False, _STATE["last_err"]
        _STATE["connected"] = True
        _STATE["last_err"] = None
        return True, "connected"
    except Exception as e:
        _STATE["connected"] = False
        _STATE["last_err"] = str(e)
        return False, str(e)


def _ensure():
    if not _STATE["connected"]:
        ok, why = connect()
        if not ok:
            raise RuntimeError(why)


def symbols():
    """Every symbol the broker exposes — the ground truth for resolve_symbol()."""
    _ensure()
    if _STATE["symbols"] is None or (time.time() - _STATE.get("_sym_t", 0)) > 600:
        _STATE["symbols"] = [s.name for s in (_MT5.symbols_get() or [])]
        _STATE["_sym_t"] = time.time()
    return _STATE["symbols"]


def measure_offset(force=False):
    """The broker's server-time offset in seconds, measured from live ticks.

    Returns (seconds, note). `seconds` is None when it could not be measured, and
    a None offset means NOTHING IS ADJUSTED — see the section header above.
    Cached for OFFSET_TTL_S so that a per-request read costs nothing.
    """
    now = time.time()
    if (not force
            and _STATE.get("offset_s") is not None
            and now - _STATE.get("offset_t", 0) < OFFSET_TTL_S):
        return _STATE["offset_s"], _STATE.get("offset_note", "")

    try:
        _ensure()
        known = symbols()
    except Exception as e:
        return _STATE.get("offset_s"), f"not re-measured: {e}"

    samples, probed = [], []
    for want in OFFSET_PROBES:
        name = resolve_symbol(want, known)
        if not name:
            continue
        try:
            _MT5.symbol_select(name, True)
            t = _MT5.symbol_info_tick(name)
        except Exception:
            continue
        if t is None or not getattr(t, "time", 0):
            continue
        samples.append(float(t.time))
        probed.append(name)

    # Re-read the wall clock AFTER the probes: measuring against a `now` taken
    # before several round trips would charge their latency to the offset.
    off = offset_from_ticks(samples, time.time())
    if off is None:
        note = ("could not measure the broker's server time — no probe symbol "
                "returned a tick. Timestamps are being passed through unadjusted.")
        _STATE["offset_note"] = note
        return _STATE.get("offset_s"), note

    _STATE["offset_s"] = off
    _STATE["offset_t"] = now
    _STATE["offset_note"] = (
        f"measured from {len(samples)} live tick(s) ({', '.join(probed[:3])})"
    )
    return off, _STATE["offset_note"]


def offset_ms():
    """The measured offset in milliseconds, or 0 when it is unknown."""
    off, _ = measure_offset()
    return int(off * 1000) if off is not None else 0


def bars(sym, tf, n=500):
    """Real broker bars, timestamped in real UTC. (bars, None) or (None, reason).

    Never invents a candle — and, since the server-time fix, never mis-stamps one
    either. See the SERVER TIME section above for what the raw timestamps are.
    """
    try:
        _ensure()
        code = mt5_tf(tf)
        if code is None:
            return None, f"unsupported timeframe '{tf}'"
        name = resolve_symbol(sym, symbols())
        if not name:
            return None, f"'{sym}' is not offered by this broker"
        _MT5.symbol_select(name, True)
        rates = _MT5.copy_rates_from_pos(name, code, 0, int(n))
        if rates is None or len(rates) == 0:
            return None, f"broker returned no bars for {name} {tf} ({_MT5.last_error()})"
        shaped = shape_bars([dict(zip(rates.dtype.names, r)) for r in rates], tf, offset_ms())
        return shaped, None
    except Exception as e:
        return None, str(e)


def tick(sym):
    """Live bid/ask + the REAL spread you are actually paying right now."""
    try:
        _ensure()
        name = resolve_symbol(sym, symbols())
        if not name:
            return None, f"'{sym}' is not offered by this broker"
        _MT5.symbol_select(name, True)
        t = _MT5.symbol_info_tick(name)
        if t is None:
            return None, f"no tick for {name}"
        si = shape_symbol_info(_MT5.symbol_info(name))
        return {"symbol": name, "bid": float(t.bid), "ask": float(t.ask),
                "spread": round(float(t.ask) - float(t.bid), max(si["digits"], 1)),
                "t_ms": int(t.time) * 1000 - offset_ms(), "digits": si["digits"]}, None
    except Exception as e:
        return None, str(e)


def symbol_info(sym):
    try:
        _ensure()
        name = resolve_symbol(sym, symbols())
        if not name:
            return None, f"'{sym}' is not offered by this broker"
        si = _MT5.symbol_info(name)
        if si is None:
            return None, f"no symbol_info for {name}"
        return shape_symbol_info(si), None
    except Exception as e:
        return None, str(e)


def account():
    """Balance / equity / margin — the inputs a Risk Governor cannot work without."""
    try:
        _ensure()
        a = _MT5.account_info()
        if a is None:
            return None, "no account_info (is MT5 logged in?)"
        return {"login": int(a.login), "currency": str(a.currency),
                "balance": float(a.balance), "equity": float(a.equity),
                "margin": float(a.margin), "margin_free": float(a.margin_free),
                "leverage": int(a.leverage), "server": str(a.server)}, None
    except Exception as e:
        return None, str(e)


def positions():
    try:
        _ensure()
        ps = _MT5.positions_get() or []
        off = offset_ms()
        return [{"ticket": int(p.ticket), "symbol": str(p.symbol), "type": int(p.type),
                 "volume": float(p.volume), "price_open": float(p.price_open),
                 "sl": float(p.sl), "tp": float(p.tp), "profit": float(p.profit),
                 "swap": float(p.swap),
                 "time_ms": int(p.time) * 1000 - off} for p in ps], None
    except Exception as e:
        return None, str(e)


def deals(days=90):
    """Closed-deal history — the raw material for reconciliation.
    THIS is what turns "the system's record" into "YOUR record"."""
    try:
        _ensure()
        import datetime as dt
        # NAIVE, deliberately. `history_deals_get` is MetaTrader5's own API and
        # takes naive datetimes; handing it an aware one changes what the
        # terminal returns. Left as the library wants it rather than made
        # tz-aware to satisfy a rule that does not know this callee.
        to = dt.datetime.now()  # noqa: DTZ005  (MetaTrader5 API takes naive)
        frm = to - dt.timedelta(days=int(days))
        ds = _MT5.history_deals_get(frm, to)
        if ds is None:
            return None, f"history_deals_get returned None ({_MT5.last_error()})"
        off = offset_ms()
        return [shape_deal(d, off) for d in ds], None
    except Exception as e:
        return None, str(e)


def _offset_label(off_s):
    """`UTC+3` / `UTC-4:30` / `UTC` — how a venue actually states its clock."""
    if off_s is None:
        return "unknown"
    sign = "-" if off_s < 0 else "+"
    total = abs(int(off_s))
    h, m = total // 3600, (total % 3600) // 60
    if h == 0 and m == 0:
        return "UTC"
    return f"UTC{sign}{h}" + (f":{m:02d}" if m else "")


def health():
    ok, why = available()
    out = {"available": ok, "reason": why, "connected": _STATE["connected"],
           "last_err": _STATE["last_err"], "platform": platform.system()}

    # The clock correction is REPORTED, never applied silently. A terminal that
    # quietly moves every timestamp three hours is a terminal you cannot debug.
    off = _STATE.get("offset_s")
    # Not gated on _STATE["connected"]: on a fresh process that flag is False
    # until something connects, and health() gating on it reported "could not
    # measure" while /ohlc measured UTC+3 in the same second. measure_offset()
    # connects for itself and swallows its own failures.
    if ok:
        try:
            off, _ = measure_offset()
        except Exception as e:                      # never let health() throw
            _STATE["offset_note"] = f"offset probe failed: {e}"
    out["clock"] = {
        "offset_ms": int(off * 1000) if off is not None else 0,
        "offset_s": off,
        "label": _offset_label(off),
        "measured": off is not None,
        "note": _STATE.get("offset_note", ""),
        "measured_at_ms": int(_STATE.get("offset_t", 0) * 1000) or None,
        "explain": (
            "MT5 stamps bars, ticks and deals on the broker's own clock, not in "
            "UTC. This offset is measured from a live tick and subtracted from "
            "every timestamp, so the terminal and the venue agree on when a bar "
            "opened." if off is not None else
            "The broker's clock offset could not be measured, so timestamps are "
            "passed through unadjusted and may be hours out."
        ),
    }
    return out


if __name__ == "__main__":
    import json
    print(json.dumps(health(), indent=2))
    ok, _ = available()
    if ok:
        connect()
        print(json.dumps(account()[0], indent=2, default=str))
