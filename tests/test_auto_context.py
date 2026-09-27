#!/usr/bin/env python3
"""A SERIES THE MACHINE READS IS NOT A SERIES IT TRADES.

`data/library.ts` MACRO_SPINE has always split itself into "Traded." and
"Read." — and until v63.21 that split was a COMMENT. Nothing could act on it,
so `svc/auto.py subjects()` handed US10Y and VIX to the sweep as trading
subjects. MEASURED across 22 markets and 334 graded arms, one of the six best
results by per-trade Sharpe was `williams-reversal on VIX`: a real number, on
an index nobody can buy.

THE COST IS NOT THE WASTED PASS. The hurdle a winner must clear is
`sqrt(2 ln N) / sqrt(n)`, so every arm spent on an untradeable series RAISES
THE BAR for the rules that could actually be taken. With 550 arms and a median
n of 46 the hurdle was +0.524 and nothing cleared it. Cutting arms nobody can
act on is the cheapest reduction in N available.

WHY THE CROSS-CHECK IS THE TEST THAT MATTERS. There are now two lists naming
one group — `CONTEXT_SYMBOLS` in Python because the sweep needs it at study
time, and `MACRO_SPINE`'s `read` flag in TypeScript because the client enrols
from it. This project has measured what happens to two such lists: `views.ts`
and `toolsmenu.ts` grouped the same 24 desks and **0 of 24 agreed**, with
nothing broken and nothing red.

So this reads the TypeScript and requires the two to agree. A test that reads
SOURCE TEXT loses coverage silently when code moves — `test_db_rewrite.py`
would have gone on passing while checking fewer and fewer call sites — so it
FAILS ON A ZERO PARSE as well as on a disagreement.

Run:  python -m pytest tests/test_auto_context.py -v
"""

from __future__ import annotations

import os
import re
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-autoctx-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_service as svc

auto = sys.modules["svc.auto"]

LIBRARY = os.path.join(ROOT, "app", "src", "data", "library.ts")


def spine_from_typescript() -> list[tuple[str, bool]]:
    """(symbol, isContext) for every MACRO_SPINE entry. Refuses to guess."""
    src = open(LIBRARY, encoding="utf-8").read()
    start = src.index("export const MACRO_SPINE")
    end = src.index("];", start)
    block = src[start:end]
    out = []
    for m in re.finditer(r'\{\s*symbol:\s*"([^"]+)"[^}]*\}', block):
        out.append((m.group(1), "read: true" in m.group(0)))
    return out


class TheTwoListsAgree(unittest.TestCase):
    def test_the_typescript_actually_parsed(self):
        """A zero here means the pattern stopped matching, not that all is well.

        This is the guard the rest of the file rests on: an audit that parses
        nothing reports a clean tree, which this project has now found in four
        of its own checkers.
        """
        spine = spine_from_typescript()
        self.assertGreaterEqual(len(spine), 8, "MACRO_SPINE did not parse")
        self.assertTrue(any(ctx for _, ctx in spine), "no `read: true` entry parsed")
        self.assertTrue(any(not ctx for _, ctx in spine), "no traded entry parsed")

    def test_every_client_context_symbol_is_excluded_server_side(self):
        """THE ONE THAT MATTERS. The client says READ; the sweep must not study it."""
        missing = [s for s, ctx in spine_from_typescript()
                   if ctx and s.upper() not in auto.CONTEXT_SYMBOLS]
        self.assertEqual(missing, [], f"the client reads these but the sweep would study them: {missing}")

    def test_no_traded_symbol_is_excluded_by_accident(self):
        """The reverse mistake silently stops the sweep studying what it should."""
        wrong = [s for s, ctx in spine_from_typescript()
                 if not ctx and s.upper() in auto.CONTEXT_SYMBOLS]
        self.assertEqual(wrong, [], f"these are traded but the sweep skips them: {wrong}")

    def test_the_four_the_operator_deepened_are_tradeable(self):
        # BTCUSDT, ETHUSDT, XAUUSD and EURUSD were backfilled to 5 years of 1h
        # precisely so they could be STUDIED. Excluding one would waste it.
        for s in ("BTCUSDT", "ETHUSDT", "XAUUSD", "EURUSD"):
            self.assertNotIn(s, auto.CONTEXT_SYMBOLS, s)


class SubjectsSkipsContext(unittest.TestCase):
    def setUp(self):
        with svc.db() as c:
            c.execute("DELETE FROM bars")

    def fill(self, sym: str, tf: str, n: int) -> None:
        rows = [("test", sym, tf, float(1_700_000_000_000 + i * 3_600_000),
                 1.0, 2.0, 0.5, 1.5, 1.0) for i in range(n)]
        with svc.db() as c:
            c.executemany(
                "INSERT INTO bars(src,sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT(src,sym,tf,t) DO NOTHING", rows)

    def test_a_context_series_deep_enough_to_qualify_is_still_skipped(self):
        # Depth is not the test. VIX holds more than MIN_BARS and must still
        # never be handed to the sweep as something to trade.
        self.fill("VIX", "1d", auto.MIN_BARS + 50)
        self.fill("BTCUSDT", "1h", auto.MIN_BARS + 50)
        got = {(s[0], s[1]) for s in auto.subjects()}
        self.assertIn(("BTCUSDT", "1h"), got)
        self.assertNotIn(("VIX", "1d"), got)

    def test_a_sweep_over_only_context_series_has_nothing_to_study(self):
        # And that is the honest answer — better than six untradeable results.
        for s in ("VIX", "US10Y", "DXY", "SPX"):
            self.fill(s, "1d", auto.MIN_BARS + 10)
        self.assertEqual(auto.subjects(), [])

    def test_the_fixture_would_have_qualified_without_the_filter(self):
        """PROVES the test is not passing on an empty archive."""
        self.fill("VIX", "1d", auto.MIN_BARS + 50)
        with svc.db() as c:
            n = c.execute("SELECT COUNT(*) AS n FROM bars WHERE sym='VIX'").fetchone()["n"]
        self.assertGreaterEqual(n, auto.MIN_BARS)


if __name__ == "__main__":
    unittest.main(verbosity=2)
