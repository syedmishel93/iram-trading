#!/usr/bin/env python3
"""
test_bars_topup.py — DID THE HOURLY TOP-UP EVER STORE A SINGLE BAR?

No. Not one, for any series, ever.

THE DEFECT

`yf_bars` returns a TUPLE — `(rows, None)` on success, `(None, reason)` on
failure. `bars_loop` did:

    rows = yf_bars(sym, tf, need=TOPUP_BARS)
    if not rows:
        continue
    clean = _clean(rows)

`rows` was therefore the whole tuple. `if not rows` is never true for a
two-element tuple, so the guard passed. `_clean` then iterated the tuple and got
a LIST and a None instead of bar dicts — and `_clean` catches
`(KeyError, TypeError, ValueError)` PER ROW and skips, by design, so it returned
`[]` without raising.

MEASURED:

    _clean((rows, None))       -> 0 bars stored
    _clean(rows)               -> 5 bars stored
    _clean((None, "no data"))  -> 0 bars stored

No exception. No `log_event`. A fresh `last_tick_age_s` in `/svc/health` and a
green dot. The success path and the failure path were byte-for-byte
indistinguishable from outside, which is why this survived: the only evidence
would have been noticing that an archive which is supposed to grow hourly never
did.

Same family as the eleven loops that had not run since consolidation, and as
`bars_loop` reading a config key nobody wrote — except this one had a writer,
had an enrolment, ticked on schedule, and still did nothing.

THE SECOND HALF

Of 22 enrolled series, 10 were binance and the loop skipped them outright on the
premise that yfinance was "the one source this process can reach without the
browser". Binance's public klines need no key, so that premise had stopped being
true. Those ten are BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT and XRPUSDT at 1h and 1d
— exactly the markets the autonomous loop and the Playbook study.

WHAT IS ASSERTED: no network. The tuple-versus-list contract is arithmetic, and
that is where the whole defect lived.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from db import init
from svc.bars import TOPUP_FETCHERS, _clean, enrolled
from svc.core import binance_bars, yf_bars
from venues import binance_symbol

# The schema, before anything reads a table. A test that loads only `svc.bars`
# never reaches `mishel_service`, which is what calls this — and the enrolment
# check below would otherwise report "(none configured)" and assert nothing,
# which is the vacuous-audit defect this project keeps finding in its own tools.
init()

FAILED = []


def check(name, got, want):
    if got == want:
        print(f"  ok   {name}: {got!r}")
    else:
        print(f"  FAIL {name}: got {got!r}, want {want!r}")
        FAILED.append(name)


BARS = [{"t": 1e12 + i * 3_600_000, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 10.0} for i in range(5)]

print("A TUPLE IS NOT A LIST OF BARS, AND `_clean` WILL NOT SAY SO")
# The defect, pinned. `_clean` skips a row it cannot read, by design, so handing
# it the fetcher's whole return value stores nothing and raises nothing.
check("tuple of (rows, None)", len(_clean((BARS, None))), 0)
check("tuple of (None, reason)", len(_clean((None, "no data"))), 0)
check("the rows themselves", len(_clean(BARS)), 5)

print()
print("BOTH FETCHERS RETURN THE SAME SHAPE, so one caller can handle either")
# This is what makes `{"yfinance": yf_bars, "binance": binance_bars}[src]` safe.
for name, fn in (("yf_bars", yf_bars), ("binance_bars", binance_bars)):
    got = fn("NOTAREALTICKERXYZ", "1h", need=5)
    check(f"{name} returns a 2-tuple", isinstance(got, tuple) and len(got) == 2, True)
    check(f"{name} refuses with a reason", got[0] is None and isinstance(got[1], str) and got[1] != "", True)

print()
print("BINANCE REFUSES A TIMEFRAME IT DOES NOT HAVE, BY NAME")
rows, why = binance_bars("BTCUSDT", "7h", need=5)
check("unknown interval refused", rows is None, True)
check("and it says which", "7h" in (why or ""), True)

print()
print("EVERY ENROLLED SOURCE HAS A HEADLESS FETCH")
# The other half: 10 of 22 enrolled series were binance and were skipped
# outright. A source with no fetcher is now logged rather than passed over.
# The registry itself, which is asserted whether or not this environment has an
# enrolment — a check that only runs when a database happens to be populated is
# a check that reports success about nothing.
check("yfinance has a fetcher", callable(TOPUP_FETCHERS.get("yfinance")), True)
check("binance has a fetcher", callable(TOPUP_FETCHERS.get("binance")), True)
check("and no source is registered twice-over as None", all(TOPUP_FETCHERS.values()), True)

# And when there IS an enrolment, every source in it must be covered.
series = enrolled()
sources = sorted({src for src, _s, _t in series})
print(f"  enrolled here: {len(series)} series across {sources or '(none yet)'}")
for src in sources:
    check(f"enrolled source {src} is covered", src in TOPUP_FETCHERS, True)

print()
print("AND THE SYMBOL MAPPING THE ENROLMENT RELIES ON")
# The enrolment stores BTCUSDT, not BTCUSD, so the mapping has to pass it
# through — which is what `test_data_proxy_symbols.py` covers in full.
check("BTCUSDT maps", binance_symbol("BTCUSDT"), "BTCUSDT")
check("XAUUSD refused", binance_symbol("XAUUSD"), None)

print()
if FAILED:
    print(f"FAILED: {len(FAILED)} — {', '.join(FAILED)}")
    sys.exit(1)
print("ALL PASS")
