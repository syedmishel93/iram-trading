#!/usr/bin/env python3
"""
test_data_proxy_symbols.py — CAN THE PROXY FETCH WHAT THE ARCHIVE STORES?

WHY THIS FILE EXISTS

`binance_symbol` was a SEVEN-ENTRY HARDCODED MAP from a canonical `XXXUSD` to
Binance's `XXXUSDT`, and it returned `None` for anything else — including
Binance's OWN native tickers. MEASURED against the running gateway, with the
archive's own binance holdings as the input:

    BTCUSDT   -> "binance: crypto only (BTCUSD, ETHUSD, ...)"
    ETHUSDT   -> refused          FILUSDT   -> refused
    SOLUSDT   -> refused          ONDOUSDT  -> refused
    BTCUSD    -> 200, real bars   SOLUSD    -> 200, real bars

Every binance series the archive actually holds was refused by the provider
that fetched it. The alias worked and the real ticker did not, so the proxy
could not re-fetch a single one of its own stored series.

Nothing failed loudly: `/ohlc` answered 404 with a clear sentence, which reads
as "this vendor does not have that" rather than "this vendor was never asked".
Same family as the Quant desk dead from a missing `()` — a component that
answers is not a component that works.

WHAT IS ASSERTED

No network. `binance_symbol` is a pure mapping and the whole defect lived in it,
so the test is arithmetic rather than a fetch. The expected values are written
as literals: a test that recomputes the implementation cannot disagree with it.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import ddt_data_server as D

FAILED = []


def check(name, got, want):
    if got == want:
        print(f"  ok   {name}: {got!r}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILED.append(name)


print("A NATIVE BINANCE TICKER IS ALREADY A BINANCE TICKER")
# The whole defect: these are what the archive stores and what Binance lists.
check("BTCUSDT", D.binance_symbol("BTCUSDT"), "BTCUSDT")
check("ETHUSDT", D.binance_symbol("ETHUSDT"), "ETHUSDT")
check("SOLUSDT", D.binance_symbol("SOLUSDT"), "SOLUSDT")
# Not in any hardcoded map, and held in this operator's archive.
check("FILUSDT", D.binance_symbol("FILUSDT"), "FILUSDT")
check("ONDOUSDT", D.binance_symbol("ONDOUSDT"), "ONDOUSDT")
# Binance lists thousands; a map of seven is a list that is wrong by design.
check("LINKUSDT", D.binance_symbol("LINKUSDT"), "LINKUSDT")
check("AVAXUSDT", D.binance_symbol("AVAXUSDT"), "AVAXUSDT")

print()
print("THE CANONICAL ALIAS STILL MAPS, because the terminal speaks XXXUSD")
# This is what already worked and must keep working: `data/history.ts` and the
# instrument table use a canonical USD form, and the venue wants USDT.
check("BTCUSD", D.binance_symbol("BTCUSD"), "BTCUSDT")
check("ETHUSD", D.binance_symbol("ETHUSD"), "ETHUSDT")
check("SOLUSD", D.binance_symbol("SOLUSD"), "SOLUSDT")
check("DOGEUSD", D.binance_symbol("DOGEUSD"), "DOGEUSDT")
# ...and one that was never in the seven-entry map.
check("LINKUSD", D.binance_symbol("LINKUSD"), "LINKUSDT")

print()
print("OTHER QUOTE ASSETS PASS THROUGH")
# Binance quotes against more than USDT, and a pair already in one of its quote
# assets is a pair it lists.
check("ETHBTC", D.binance_symbol("ETHBTC"), "ETHBTC")
check("SOLBTC", D.binance_symbol("SOLBTC"), "SOLBTC")
check("BTCFDUSD", D.binance_symbol("BTCFDUSD"), "BTCFDUSD")
check("BTCUSDC", D.binance_symbol("BTCUSDC"), "BTCUSDC")

print()
print("AND IT STILL REFUSES WHAT BINANCE DOES NOT LIST")
# The guard has to keep working, or the provider stops refusing FX and metals
# and starts reporting a vendor error instead of a clear one.
check("EURUSD", D.binance_symbol("EURUSD"), None)
check("XAUUSD", D.binance_symbol("XAUUSD"), None)
check("AAPL", D.binance_symbol("AAPL"), None)
check("SPX500", D.binance_symbol("SPX500"), None)
check("empty", D.binance_symbol(""), None)

print()
print("CASE IS NOT A REASON TO REFUSE")
check("btcusdt", D.binance_symbol("btcusdt"), "BTCUSDT")
check("btcusd", D.binance_symbol("btcusd"), "BTCUSDT")

print()
if FAILED:
    print(f"FAILED: {len(FAILED)} — {', '.join(FAILED)}")
    sys.exit(1)
print("ALL PASS")
