"""
The claims ledger.

What is pinned here is what the ledger must refuse to say. Every one of these
was a real defect found by pointing the module at the operator's actual data,
and each of them made the numbers look MORE authoritative, not less.
"""
# ---------------------------------------------------------------------------
# This file used to live in `server/`, beside the module it tests, so
# `import mishel_claims` resolved for free. It moved here because a test
# directory that holds only some of the tests is worse than none: the gate ran
# what it could see, and three files sat outside it for months.
#
# The cost of the move is these four lines. `server/` is a flat directory of
# top-level modules rather than a package, so a test anywhere else has to put
# it on the path. Every other file in `tests/` does the same thing; see
# `conftest.py` for why the duplication stays.
# ---------------------------------------------------------------------------
import os
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import mishel_claims as mc

DAY = 86_400_000


def claim(i, **over):
    d = {"id": f"c{i}", "at": 1_700_000_000_000 + i * 60_000, "symbol": "BTCUSDT",
         "timeframe": "1h", "side": "long", "verdict": "take", "setupKind": "choch",
         "gatesFailed": 0, "score": 0.4, "coverage": 0.8, "confidence": 0.5,
         "entry": 100.0, "stop": 95.0, "target": 110.0,
         "expiresAt": 1_700_000_900_000, "outcome": "target", "resolvedPrice": 110.0}
    d.update(over)
    return d


class FilteringTheLedger(unittest.TestCase):
    """`stats()` BUILT ITS ARGUMENTS AND NEVER PASSED THEM.

    `conn.execute(sql + " ORDER BY at ASC")` -- with `args` assembled two lines
    above and dropped. The SQL carries `?` placeholders, so sqlite3 raised
    "Incorrect number of bindings supplied. The current statement uses 1, and
    there are 0 supplied", and EVERY filtered read of the track record has
    failed since the filters were written.

    Why nobody saw it: the UNFILTERED call builds no placeholders, so the card
    that shows the overall hit rate worked perfectly. Only asking "how did this
    machine do on GOLD" -- the question the filters exist for -- ever hit it,
    and it came back as a 500 the desk rendered as a service being down.

    Found by sweeping GET routes with hostile query values, which is a thing
    `probe.py` never did: it calls every read route with VALID parameters and
    reports 0 of 68 broken, truthfully.
    """

    def setUp(self):
        self.c = sqlite3.connect(":memory:")
        self.c.row_factory = sqlite3.Row
        mc.init(self.c)
        mc.upsert(self.c, [
            claim(1, symbol="XAUUSD", timeframe="1h", at=1_700_000_000_000,
                  entry=2600.0, stop=2590.0, target=2620.0, outcome="target",
                  resolvedPrice=2620.0),
            claim(2, symbol="XAUUSD", timeframe="1h", at=1_700_500_000_000,
                  entry=2700.0, stop=2680.0, target=2740.0, outcome="stop",
                  resolvedPrice=2680.0),
            claim(3, symbol="BTCUSDT", timeframe="1d", at=1_701_000_000_000,
                  entry=60000.0, stop=58000.0, target=64000.0, outcome="target",
                  resolvedPrice=64000.0),
        ])
        # The fixture must reach the code under test: three DISTINCT claims, or
        # the filter counts below are measuring `dedupe`.
        assert mc.stats(self.c)["claims"] == 3, "fixture collapsed under dedupe"

    def test_filtering_by_symbol_does_not_raise(self):
        # THE ONE THAT WAS BROKEN. It raised sqlite3.ProgrammingError.
        got = mc.stats(self.c, symbol="XAUUSD")
        self.assertTrue(got["ok"])

    def test_filtering_by_symbol_actually_narrows(self):
        # Not raising is not the same as filtering. A fix that passed `args` to
        # the wrong statement would still not raise.
        every = mc.stats(self.c)
        gold = mc.stats(self.c, symbol="XAUUSD")
        btc = mc.stats(self.c, symbol="BTCUSDT")
        self.assertEqual(every["claims"], 3)
        self.assertEqual(gold["claims"], 2)
        self.assertEqual(btc["claims"], 1)

    def test_filtering_by_timeframe_narrows(self):
        self.assertEqual(mc.stats(self.c, timeframe="1h")["claims"], 2)
        self.assertEqual(mc.stats(self.c, timeframe="1d")["claims"], 1)

    def test_two_filters_compose(self):
        self.assertEqual(mc.stats(self.c, symbol="XAUUSD", timeframe="1h")["claims"], 2)
        self.assertEqual(mc.stats(self.c, symbol="XAUUSD", timeframe="1d")["claims"], 0)

    def test_since_narrows_by_time(self):
        after_all = mc.stats(self.c, since=1e18)
        self.assertEqual(after_all.get("claims", 0), 0)
        self.assertTrue(mc.stats(self.c, since=0)["claims"] >= 1)

    def test_a_symbol_nobody_claimed_reports_empty_rather_than_raising(self):
        got = mc.stats(self.c, since=None, symbol="NOSUCHPAIR")
        self.assertTrue(got["ok"])
        self.assertEqual(got.get("claims", 0), 0)


class Ledger(unittest.TestCase):
    def setUp(self):
        self.c = sqlite3.connect(":memory:")
        self.c.row_factory = sqlite3.Row
        mc.init(self.c)

    def test_rejects_rather_than_repairs(self):
        # A claim missing its stop is not a claim with a default stop.
        bad = [{"id": "x"}, "nope", claim(1, stop=None), claim(2, side="sideways"),
               claim(3, entry=float("nan"))]
        self.assertEqual(mc.upsert(self.c, bad), 0)

    def test_resolved_never_reverts_to_pending(self):
        # Two browsers, one with less history. Without the guard the machine
        # that had not loaded the bars would unresolve the claim.
        mc.upsert(self.c, [claim(1, outcome="stop", resolvedPrice=95.0)])
        mc.upsert(self.c, [claim(1, outcome="pending", resolvedPrice=None)])
        got = self.c.execute("SELECT outcome FROM claims WHERE id='c1'").fetchone()["outcome"]
        self.assertEqual(got, "stop")

    def test_realised_r_is_computed_here(self):
        mc.upsert(self.c, [claim(1, outcome="target"), claim(2, outcome="stop", resolvedPrice=95.0)])
        rs = {r["id"]: r["r_realised"] for r in self.c.execute("SELECT id,r_realised FROM claims")}
        self.assertAlmostEqual(rs["c1"], 2.0)   # 10 reward over 5 risk
        self.assertAlmostEqual(rs["c2"], -1.0)

    def test_dedupe_collapses_repeated_recordings(self):
        # 601 recordings were 251 positions on the real ledger. Every copy
        # resolves identically, so counting them narrows the intervals around
        # evidence that was never there.
        rows = [dict(claim(i), id=f"c{i}") for i in range(10)]
        for r in rows:
            r["at"] = 1_700_000_000_000  # same instant, same geometry
        mc.upsert(self.c, rows)
        st = mc.stats(self.c)
        self.assertEqual(st["recorded"], 10)
        self.assertEqual(st["claims"], 1)

    def test_dedupe_keeps_distinct_geometry(self):
        rows = [claim(1, entry=100.0), claim(2, entry=101.0), claim(3, side="short", stop=105.0, target=90.0)]
        mc.upsert(self.c, rows)
        self.assertEqual(mc.stats(self.c)["claims"], 3)

    def test_refuses_a_verdict_from_one_session(self):
        # THE ONE THAT MATTERS. 283 resolved claims, all from one afternoon,
        # produced a confident "confidence is inverted" -- from an afternoon
        # that happened to go up.
        rows = []
        for i in range(80):
            rows.append(claim(i, entry=100.0 + i, outcome="target" if i % 2 else "stop",
                              resolvedPrice=None, verdict="take" if i % 3 else "stand-down"))
        mc.upsert(self.c, rows)
        st = mc.stats(self.c)
        self.assertEqual(st["distinctDays"], 1)
        self.assertIn("span 1 day", st["gates"]["text"])
        self.assertIn("span 1 day", st["calibration"]["note"])

    def test_offers_a_verdict_once_the_sample_spans_enough_days(self):
        rows = []
        for d in range(mc.MIN_DAYS + 2):
            for i in range(30):
                n = d * 100 + i
                rows.append(claim(n, entry=100.0 + n,
                                  at=1_700_000_000_000 + d * DAY + i * 60_000,
                                  confidence=0.1 if i % 2 else 0.9,
                                  outcome="target" if i % 2 else "stop", resolvedPrice=None))
        mc.upsert(self.c, rows)
        st = mc.stats(self.c)
        self.assertGreaterEqual(st["distinctDays"], mc.MIN_DAYS)
        self.assertNotIn("span", st["calibration"]["note"])

    def test_unknowable_is_excluded_from_the_denominator(self):
        rows = [claim(i, entry=100.0 + i, outcome="target") for i in range(5)]
        rows += [claim(50 + i, entry=200.0 + i, outcome="unknowable") for i in range(5)]
        mc.upsert(self.c, rows)
        pop = mc.stats(self.c)["all"]
        self.assertEqual(pop["decided"], 5)
        self.assertEqual(pop["unknowable"], 5)
        self.assertEqual(pop["hitRate"], 1.0)

    def test_wilson_is_not_the_normal_approximation(self):
        # Zero hits from one loss must not be "0%, and we are certain".
        low, high = mc.wilson(0, 1)
        self.assertEqual(low, 0.0)
        self.assertGreater(high, 0.5)
        self.assertLess(mc.wilson(3, 3)[0], 0.5)

    def test_empty_ledger_says_so(self):
        st = mc.stats(self.c)
        self.assertEqual(st["claims"], 0)
        self.assertIn("empty", st["note"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
