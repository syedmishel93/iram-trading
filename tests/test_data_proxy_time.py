#!/usr/bin/env python3
"""
test_data_proxy_time.py — WHAT TIME IS THAT BAR?

WHY THIS FILE EXISTS
`server/ddt_data_server.py` is the proxy every bar in the terminal comes
through, and until this file nothing tested it. That is how the bug below
survived: two providers hand back a formatted local string, both were parsed
with `strptime(...).timestamp()`, and `.timestamp()` reads a NAIVE datetime as
LOCAL time. So every TwelveData and AlphaVantage bar was displaced by the
server's own UTC offset — two hours on the machine this was found on, a
different number on the next machine, and a different number again after
daylight saving.

Nothing failed. The chart just drew the right candles in the wrong places, which
is the worst available outcome for a session-aware terminal: the 08:00 London
open sat at 06:00, and every conclusion drawn from a session overlay was wrong
without ever looking wrong.

WHAT IS ASSERTED, AND WHY IT IS ASSERTED THIS WAY
The network is mocked. A test that calls TwelveData is a test that fails when
somebody's key expires, and it cannot pin a timestamp anyway because live data
moves. Each provider gets a canned payload with a KNOWN wall-clock string, and
the assertion is the exact epoch millisecond that string must become.

The expected values are written as literals, not computed from the same
expression the module uses — a test that recomputes the implementation cannot
disagree with it.

THE ZONE IS PER ENDPOINT. That is the part worth protecting:
  * TwelveData is asked for UTC explicitly (`timezone=UTC`), so it parses as UTC.
  * AlphaVantage FX_* is documented UTC.
  * AlphaVantage TIME_SERIES_* intraday is US/Eastern.
  * Daily bars anchor to midnight UTC on every provider, so one source's daily
    candle does not sit five hours from another's.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import ddt_data_server as D

P = F = 0


def ok(name, cond, detail=""):
    global P, F
    if cond:
        P += 1
        print("  ok  ", name)
    else:
        F += 1
        print("  FAIL", name, ("\n        " + str(detail)) if detail else "")


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class FakeRequests:
    """Captures the params so the `timezone=UTC` request can be asserted too."""

    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def get(self, url, **kw):
        self.calls.append((url, kw.get("params", {})))
        return FakeResponse(self.payload)


def with_fake(payload, fn):
    """Swap in the fake transport and run `fn` inside a Flask request context.

    The context is needed because `env_key` reads the API key from
    `request.args` first and falls back to the environment. Outside a request
    that raises rather than falling back -- which is correct behaviour for the
    server and a thing a test has to arrange for.
    """
    real = D.requests
    fake = FakeRequests(payload)
    D.requests = fake
    try:
        with D.app.test_request_context("/ohlc"):
            return fn(), fake
    finally:
        D.requests = real


# ---------------------------------------------------------------------------
# TwelveData
# ---------------------------------------------------------------------------
os.environ["TWELVEDATA_KEY"] = "test-key"

payload = {"values": [
    {"datetime": "2026-09-10 14:00:00", "open": "1", "high": "2", "low": "0.5", "close": "1.5", "volume": "10"},
    {"datetime": "2026-09-10", "open": "1", "high": "2", "low": "0.5", "close": "1.5"},
]}
rows, fake = with_fake(payload, lambda: D.p_twelvedata("EURUSD", "1h", 10))

# 2026-09-10 14:00:00 UTC == 1789041600 s. Written out, not recomputed:
#   days from epoch to 2026-09-10 = 20706 ; 20706*86400 = 1789 -- see below.
EXPECT_INTRADAY_MS = 1789048800000   # 2026-09-10T14:00:00Z
EXPECT_DAILY_MS = 1788998400000      # 2026-09-10T00:00:00Z

ok("twelvedata: 14:00 parses as 14:00 UTC, not local",
   rows[0]["t"] == EXPECT_INTRADAY_MS, f"got {rows[0]['t']}, want {EXPECT_INTRADAY_MS}")
ok("twelvedata: a date-only bar anchors at midnight UTC",
   rows[1]["t"] == EXPECT_DAILY_MS, f"got {rows[1]['t']}, want {EXPECT_DAILY_MS}")
ok("twelvedata: the request ASKS for UTC rather than assuming it",
   fake.calls and fake.calls[0][1].get("timezone") == "UTC",
   f"params were {fake.calls[0][1] if fake.calls else None}")

# ---------------------------------------------------------------------------
# AlphaVantage — the zone depends on which endpoint was called
# ---------------------------------------------------------------------------
os.environ["ALPHAVANTAGE_KEY"] = "test-key"

fx = {"Time Series FX (60min)": {
    "2026-09-10 14:00:00": {"1. open": "1", "2. high": "2", "3. low": "0.5", "4. close": "1.5"},
}}
rows, _ = with_fake(fx, lambda: D.p_alphavantage("EURUSD", "1h", 10))
ok("alphavantage FX intraday is UTC (as documented)",
   rows[0]["t"] == EXPECT_INTRADAY_MS, f"got {rows[0]['t']}, want {EXPECT_INTRADAY_MS}")

eq = {"Time Series (60min)": {
    "2026-09-10 14:00:00": {"1. open": "1", "2. high": "2", "3. low": "0.5", "4. close": "1.5", "5. volume": "7"},
}}
rows, _ = with_fake(eq, lambda: D.p_alphavantage("AAPL", "1h", 10))
# 14:00 US/Eastern on 2026-09-10 is EDT (UTC-4) -> 18:00 UTC.
EXPECT_EASTERN_MS = 1789063200000    # 2026-09-10T18:00:00Z
ok("alphavantage equity intraday is US/Eastern, so 14:00 ET == 18:00 UTC",
   rows[0]["t"] == EXPECT_EASTERN_MS, f"got {rows[0]['t']}, want {EXPECT_EASTERN_MS}")

eq_daily = {"Time Series (Daily)": {
    "2026-09-10": {"1. open": "1", "2. high": "2", "3. low": "0.5", "4. close": "1.5", "5. volume": "7"},
}}
rows, _ = with_fake(eq_daily, lambda: D.p_alphavantage("AAPL", "1d", 10))
ok("alphavantage daily anchors at midnight UTC, not 00:00 Eastern",
   rows[0]["t"] == EXPECT_DAILY_MS, f"got {rows[0]['t']}, want {EXPECT_DAILY_MS}")

# ---------------------------------------------------------------------------
# The property that made the bug invisible: it must not depend on the machine.
# ---------------------------------------------------------------------------
import time as _time


def parsed_under_tz(tz):
    """Re-parse the same payload with the process in a different timezone."""
    old = os.environ.get("TZ")
    os.environ["TZ"] = tz
    if hasattr(_time, "tzset"):
        _time.tzset()
    try:
        rows, _f = with_fake(payload, lambda: D.p_twelvedata("EURUSD", "1h", 10))
        return rows[0]["t"]
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        if hasattr(_time, "tzset"):
            _time.tzset()


if hasattr(_time, "tzset"):
    a = parsed_under_tz("UTC")
    b = parsed_under_tz("Asia/Tokyo")
    c = parsed_under_tz("America/Los_Angeles")
    ok("the same payload gives the same epoch in UTC, Tokyo and Los Angeles",
       a == b == c == EXPECT_INTRADAY_MS, f"UTC={a} Tokyo={b} LA={c}")
else:
    # Windows has no tzset, so the process timezone cannot be changed in-flight.
    # Saying so beats a silently skipped assertion.
    print("  --   machine-independence check skipped: no time.tzset on this platform")

print(f"\n{P} passed, {F} failed")
sys.exit(1 if F else 0)
