#!/usr/bin/env python3
"""
test_risk_specs.py — CAN THE RISK ENGINE EVER SIZE A TRADE?

Not on this account, and not on any broker that suffixes its symbols.

THE DEFECT, MEASURED ON THE LIVE ACCOUNT

`/svc/risk/size` refuses without a contract spec, and says why:

    "no contract spec for this symbol — run the MT5 bridge (or /svc/mt5/sync)
     so sizing uses the broker's REAL contract size. Guessing it is how gold
     gets sized 1000x wrong."

Running the sync did not help, for two compounding reasons:

 1. SPECS COME ONLY FROM TRADED SYMBOLS. `/svc/mt5/sync` reads deals, collects
    the symbols in them, and asks the bridge for a spec for each. A fresh
    account has no deals, so it gets no specs — and an operator who has not
    traded a market yet is exactly the one who needs sizing for it.

 2. THE BROKER SUFFIXES ITS SYMBOLS. JustMarkets quotes `XAUUSD.s` and
    `BTCUSD.s`. The sync stores the spec under the BROKER's name and
    `/svc/risk/size` looks it up under the CANONICAL one:

        specs stored      -> ['BTCUSD.S']
        lookup "BTCUSD"   -> MISS
        lookup "XAUUSD"   -> MISS

    So even a successful sync leaves sizing unable to find anything. Nothing
    fails: the route answers 200 with `ok: false` and a sentence about running
    a sync that has already been run.

The bridge itself was never the problem — asked directly it answers for gold
with `contract_size: 100.0`, which is the correct 100oz contract and the exact
number the error message warns about guessing.

WHAT IS ASSERTED: the mapping is arithmetic, and that is where the defect was.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from venues import canonical_symbol, spec_keys

FAILED = []


def check(name, got, want):
    if got == want:
        print(f"  ok   {name}: {got!r}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILED.append(name)


print("A BROKER SUFFIX IS NOT PART OF THE INSTRUMENT")
check("XAUUSD.s", canonical_symbol("XAUUSD.s"), "XAUUSD")
check("BTCUSD.S", canonical_symbol("BTCUSD.S"), "BTCUSD")
check("EURUSD.pro", canonical_symbol("EURUSD.pro"), "EURUSD")
check("US500.cash", canonical_symbol("US500.cash"), "US500")

print()
print("AND A SYMBOL WITHOUT ONE IS LEFT ALONE")
check("EURUSD", canonical_symbol("EURUSD"), "EURUSD")
check("BTCUSDT", canonical_symbol("BTCUSDT"), "BTCUSDT")
check("empty", canonical_symbol(""), "")
check("None", canonical_symbol(None), "")

print()
print("ONLY A SHORT TRAILING SUFFIX, because over-stripping invents a symbol")
# `BRK.B` is a real ticker and its dot is part of the name. A rule that ate any
# dot would turn it into BRK and size a different company.
check("BRK.B kept", canonical_symbol("BRK.B"), "BRK.B")
# Nothing before the dot is not a suffix, it is the whole string.
check(".s alone", canonical_symbol(".s"), ".S")

print()
print("A SPEC IS FILED UNDER BOTH NAMES, so either lookup finds it")
# This is the fix: the sync knows the broker's name and the caller knows the
# canonical one, and neither should have to know the other's.
check("XAUUSD.s keys", spec_keys("XAUUSD.s"), ["XAUUSD.S", "XAUUSD"])
check("BTCUSD.S keys", spec_keys("BTCUSD.S"), ["BTCUSD.S", "BTCUSD"])
# No suffix: one key, not a duplicate.
check("EURUSD keys", spec_keys("EURUSD"), ["EURUSD"])
check("empty keys", spec_keys(""), [])

print()
if FAILED:
    print(f"FAILED: {len(FAILED)} — {', '.join(FAILED)}")
    sys.exit(1)
print("ALL PASS")
