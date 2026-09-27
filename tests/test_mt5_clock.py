#!/usr/bin/env python3
"""
THE THREE-HOUR BUG — known-answer tests for the MT5 server-time correction.

WHAT WAS WRONG
`shape_bars` did `int(r["time"]) * 1000` and called the result a millisecond
epoch. It is not one. MT5 reports `rates['time']`, `tick.time` and `deal.time`
in seconds on the BROKER'S OWN CLOCK, handed over as a bare integer that looks
exactly like POSIX and is not. Measured against the broker this was found on:

    tick t_ms    1788366445000
    real now ms  1788355647597
    offset       10797.4 s  =  2.999 hours

Every gold and forex bar the terminal had ever drawn was stamped three hours
into the future. The visible symptom was a bar countdown frozen at "1:00" on a
live 1m chart, but the expensive ones were silent: session shading, the
economic-calendar embargo gate — which REFUSES TRADES — and the cross-asset
join against Binance's genuine UTC bars were all asked about the wrong three
hours.

Every expected value below is computed by hand in the comment above it.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import mt5_bridge as B

P = F = 0


def ok(cond, msg):
    global P, F
    if cond:
        P += 1
        print("  " + msg + " ✓")
    else:
        F += 1
        print("  " + msg + " ✗ FAIL")


print("\nquantise_offset — a reading becomes a timezone, or it is refused")

# 10797.4s is 2h 59m 57.4s. The nearest quarter hour is 10800 = exactly 3h.
ok(B.quantise_offset(10797.4) == 10800, "the measured 10797.4s rounds to UTC+3")
ok(B._offset_label(10800) == "UTC+3", "and is stated the way a venue states it")

# A broker on UTC-4 measured with 3s of transit latency: -14400 + 3.
ok(B.quantise_offset(-14397) == -14400, "a negative offset rounds away from zero, not toward it")
ok(B._offset_label(-14400) == "UTC-4", "and reads as UTC-4")

# Half-hour venues are real (India, parts of Australia). 19800 = 5h30m.
ok(B._offset_label(19800) == "UTC+5:30", "a half-hour venue keeps its minutes")
ok(B._offset_label(0) == "UTC", "a broker genuinely on UTC says so, not '+0'")

# 99999s is 27.7 hours. No venue on Earth; a broken clock, not a timezone.
ok(B.quantise_offset(99999) is None, "an impossible offset is refused, not clamped")
ok(B.quantise_offset(float("nan")) is None, "NaN is refused")
ok(B.quantise_offset(None) is None, "so is a missing reading")
ok(B._offset_label(None) == "unknown", "and an unmeasured clock says 'unknown', never 'UTC'")


print("\noffset_from_ticks — MAX, because a stale tick reads early and never late")

# Server-now is 1000. Three symbols: one current, two stale by 100s and 20s.
# The freshest sample is the correct one; a mean of the three would be 60s out.
ok(
    B.offset_from_ticks([1000.0, 900.0, 980.0], 1000.0 - 10800) == 10800,
    "the freshest tick sets the offset; stale ones are discarded",
)
ok(B.offset_from_ticks([], 0) is None, "no ticks means no measurement, not zero")
ok(B.offset_from_ticks([0, -5], 0) is None, "a zero or negative tick time is not a reading")
ok(B.offset_from_ticks(["nonsense", 1000.0], 1000.0) == 0, "garbage entries are skipped, not fatal")


print("\nshape_bars — the correction is applied to every timestamp")

RAW = [{"time": 1788366360, "open": 4348.96, "high": 4355.66,
        "low": 4348.63, "close": 4354.89, "tick_volume": 242}]

# Unadjusted: 1788366360 * 1000. This is the value that shipped, and it is the
# bug — three hours into the future.
ok(B.shape_bars(RAW, "1m")[0]["t"] == 1788366360000, "an unmeasured clock adjusts nothing at all")

# 1788366360000 - 10800000 = 1788355560000.
ok(
    B.shape_bars(RAW, "1m", 10800000)[0]["t"] == 1788355560000,
    "UTC+3 is subtracted: 1788366360000 - 10800000 = 1788355560000",
)
ok(B.shape_bars(RAW, "1m", 10800000)[0]["c"] == 4354.89, "prices are untouched by a clock fix")

# A broker WEST of UTC: subtracting a negative offset moves the stamp forward.
ok(
    B.shape_bars(RAW, "1m", -14400000)[0]["t"] == 1788366360000 + 14400000,
    "a UTC-4 broker is corrected in the other direction",
)

# A malformed bar is dropped, never patched — unchanged by this work.
ok(B.shape_bars([{"time": "x"}], "1m", 10800000) == [], "a malformed bar is still dropped, not guessed")
ok(B.shape_bars(None, "1m", 10800000) == [], "no rates is an empty list, not a crash")


print("\nshape_deal — fills carry the same clock as the bars they are read against")

# 1788366445 * 1000 - 10800000 = 1788355645000.
d = B.shape_deal({"ticket": 1, "order": 1, "position_id": 1, "time": 1788366445,
                  "type": 0, "entry": 0, "symbol": "XAUUSD", "volume": 0.1,
                  "price": 4354.89, "commission": -0.7, "swap": 0.0, "profit": 12.3},
                 10800000)
ok(d["time_ms"] == 1788355645000, "a deal's time is corrected too: 1788366445000 - 10800000")
ok(d["commission"] == -0.7, "and its costs are left exactly as the broker reported them")

# The default is ZERO, not "guess": a caller that has not measured must not have
# a correction invented for it.
ok(
    B.shape_deal({"ticket": 1, "order": 1, "position_id": 1, "time": 1788366445,
                  "type": 0, "entry": 0, "symbol": "X", "volume": 0.1, "price": 1.0,
                  "commission": 0.0, "swap": 0.0, "profit": 0.0})["time_ms"]
    == 1788366445000,
    "with no offset supplied, nothing is adjusted",
)


print("\nhealth() — the correction is REPORTED, never applied silently")
h = B.health()
ok("clock" in h, "health carries a clock block")
ok(set(h["clock"]) >= {"offset_ms", "label", "measured", "note", "explain"},
   "and it states the offset, whether it was measured, and why")
ok(h["clock"]["measured"] is False or h["clock"]["offset_ms"] != 0 or h["clock"]["label"] == "UTC",
   "an unmeasured clock never reports itself as a measured zero")

print(f"\n{P} passed, {F} failed")
sys.exit(1 if F else 0)
