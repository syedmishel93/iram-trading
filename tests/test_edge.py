"""
Tests for the conditional edge table.

Same weighting as the module: most of these are about what it REFUSES to say.
A conditional breakdown is the easiest thing in this repository to fool
yourself with, and the tests that matter are the ones that hold the guards.
"""

# ---------------------------------------------------------------------------
# This file used to live in `server/`, beside the module it tests, so
# `import mishel_edge` resolved for free. It moved here because a test
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

import mishel_edge as E

DAY = 86_400_000
HOUR = 3_600_000
# A Thursday 00:00 UTC, because 1970-01-01 was a Thursday and that keeps the
# weekday arithmetic in the test as obvious as it is in the module.
MON = 4 * DAY  # 1970-01-05, a Monday


def trial(i, outcome="target", at=None, direction="long", r=1.0, stop_pct=0.5,
          kind="spring", regime=None):
    return {
        "id": f"t{i}",
        "at": MON + i * HOUR if at is None else at,
        "symbol": "ETHUSDT",
        "timeframe": "1h",
        "kind": kind,
        "direction": direction,
        "outcome": outcome,
        "rGross": r,
        "stopPct": stop_pct,
        "regime": regime,
    }


def spread_over_days(n, days=8, **kw):
    """`n` trials spread across `days` distinct UTC days."""
    out = []
    for i in range(n):
        out.append(trial(i, at=MON + (i % days) * DAY + (i % 20) * HOUR, **kw))
    return out


class Sanitise(unittest.TestCase):
    def test_rejects_a_decided_trial_with_no_r(self):
        """Counted in the hit rate, skipped in the expectancy — two numbers
        under one heading describing different populations."""
        row = trial(1)
        del row["rGross"]
        self.assertIsNone(E.sanitise(row))

    def test_keeps_an_unknowable_trial_without_an_r(self):
        row = trial(1, outcome="unknowable")
        del row["rGross"]
        self.assertIsNotNone(E.sanitise(row))

    def test_rejects_an_unrecognised_outcome(self):
        self.assertIsNone(E.sanitise(trial(1, outcome="probably a win")))

    def test_rejects_rather_than_repairs_a_bad_direction(self):
        self.assertIsNone(E.sanitise(trial(1, direction="up")))


class Costs(unittest.TestCase):
    def test_charges_the_round_trip_twice_by_default(self):
        c = E.Costs(spread_bps=2, slippage_bps=1, round_trips=2)
        self.assertEqual(c.bps, 6.0)

    def test_converts_basis_points_to_R_through_the_stop_distance(self):
        """The same spread is a rounding error on a wide stop and a third of
        the risk on a tight one. That is the whole reason for the conversion."""
        c = E.Costs(spread_bps=5, slippage_bps=0, round_trips=2)  # 10bp
        wide = c.r_cost(1.0)    # stop 1% away
        tight = c.r_cost(0.05)  # stop 0.05% away
        self.assertAlmostEqual(wide, 0.1)
        self.assertAlmostEqual(tight, 2.0)
        self.assertGreater(tight, wide)

    def test_refuses_to_cost_a_trial_with_no_stop_distance(self):
        self.assertIsNone(E.Costs().r_cost(None))
        self.assertIsNone(E.Costs().r_cost(0))

    def test_net_is_gross_less_cost(self):
        self.assertAlmostEqual(E.net_r(1.0, 0.1), 0.9)
        self.assertIsNone(E.net_r(None, 0.1))


class Slicing(unittest.TestCase):
    def test_reports_every_open_session_rather_than_picking_one(self):
        """London and New York genuinely overlap. Assigning a trial to one of
        them would be inventing a boundary."""
        noon = MON + 13 * HOUR
        self.assertEqual(set(E.sessions_at(noon)), {"London", "New York"})

    def test_handles_a_session_that_wraps_midnight(self):
        self.assertIn("Sydney", E.sessions_at(MON + 23 * HOUR))
        self.assertIn("Sydney", E.sessions_at(MON + 2 * HOUR))

    def test_weekday_arithmetic_is_anchored_correctly(self):
        self.assertEqual(E.weekday_at(MON), "Mon")
        self.assertEqual(E.weekday_at(MON + 4 * DAY), "Fri")


class MultipleComparisons(unittest.TestCase):
    def test_sidak_tightens_the_threshold_as_cells_are_added(self):
        one = E.sidak(0.05, 1)
        twenty = E.sidak(0.05, 20)
        self.assertAlmostEqual(one, 0.05)
        self.assertLess(twenty, 0.005)

    def test_z_grows_with_the_correction(self):
        self.assertGreater(E.z_for(E.sidak(0.05, 20)), E.z_for(0.05))

    def test_refuses_to_name_a_winner_that_only_looks_good(self):
        """The core guard. A cell at 60% of 30 beats a 50% baseline on a naive
        reading and does not survive being one of twenty-four cells."""
        cells = [
            {"label": "London", "n": 30, "hits": 18, "hitRate": 0.6, "reportable": True},
        ]
        verdict = E.honest_best(cells, 0.5, comparisons=24)
        self.assertFalse(verdict["found"])
        self.assertIn("expect to see with nothing there", verdict["text"])

    def test_names_a_winner_that_does_survive(self):
        cells = [
            {"label": "London", "n": 400, "hits": 280, "hitRate": 0.7, "reportable": True},
        ]
        verdict = E.honest_best(cells, 0.5, comparisons=24)
        self.assertTrue(verdict["found"])
        self.assertIn("has not been tested", verdict["text"])

    def test_never_names_an_unreportable_cell_however_good_it_looks(self):
        cells = [{"label": "Tue", "n": 3, "hits": 3, "hitRate": 1.0, "reportable": False}]
        self.assertFalse(E.honest_best(cells, 0.5, comparisons=4)["found"])


class Conditional(unittest.TestCase):
    def test_refuses_to_slice_a_small_sample(self):
        out = E.conditional([E.sanitise(t) for t in spread_over_days(10)])
        self.assertFalse(out["available"])
        self.assertIn("Below 20", out["reason"])

    def test_refuses_a_sample_from_too_few_days(self):
        """The mistake this codebase has already made once: 283 claims from one
        afternoon is n=1 in the dimension that matters."""
        rows = [E.sanitise(t) for t in spread_over_days(60, days=2)]
        out = E.conditional(rows)
        self.assertFalse(out["available"])
        self.assertIn("span 2 days", out["reason"])

    def test_slices_a_sample_that_clears_both_floors(self):
        rows = [E.sanitise(t) for t in spread_over_days(80, days=10)]
        out = E.conditional(rows)
        self.assertTrue(out["available"])
        self.assertIn("session", out["groups"])
        self.assertIn("weekday", out["groups"])
        self.assertIn("regime", out["groups"])

    def test_counts_every_cell_examined_toward_the_correction(self):
        """Including the ones too small to report. Counting only reportable
        cells would let a table be made to look more significant by adding
        tiny ones."""
        rows = [E.sanitise(t) for t in spread_over_days(80, days=10)]
        out = E.conditional(rows)
        examined = sum(len(v) for v in out["groups"].values())
        self.assertEqual(out["comparisons"], examined)
        self.assertGreater(out["comparisons"], 4)

    def test_excludes_unknowable_from_the_denominator(self):
        """OHLC cannot order two barriers inside one bar. Folding those into
        losses puts a coin flip inside the hit rate, where it still looks like
        a measurement."""
        decided = [E.sanitise(t) for t in spread_over_days(40, days=8)]
        unknown = [E.sanitise(dict(t, id=f"u{t['id']}"))
                   for t in spread_over_days(40, days=8, outcome="unknowable")]
        out = E.conditional(decided + unknown)
        self.assertEqual(out["overall"]["n"], 40)          # denominator: decided only
        self.assertEqual(out["overall"]["hits"], 40)
        self.assertEqual(out["overall"]["unknowable"], 40)
        self.assertEqual(out["overall"]["hitRate"], 1.0)   # not 0.5

    def test_reports_uncosted_trials_rather_than_charging_them_zero(self):
        """A table half of whose rows are gross is worse than one that says so."""
        raw = spread_over_days(40, days=8)
        for r in raw[:10]:
            r["stopPct"] = None
        rows = [E.sanitise(t) for t in raw]
        out = E.conditional(rows, costs=E.Costs())
        self.assertEqual(out["overall"]["uncosted"], 10)

    def test_costs_move_expectancy_the_right_way(self):
        rows = [E.sanitise(t) for t in spread_over_days(40, days=8, r=1.0, stop_pct=0.1)]
        gross = E.conditional(rows)["overall"]["expectancyR"]
        net = E.conditional(rows, costs=E.Costs(spread_bps=5, slippage_bps=5))["overall"]["expectancyR"]
        self.assertLess(net, gross)


class Storage(unittest.TestCase):
    def setUp(self):
        self.conn = sqlite3.connect(":memory:")
        E.init(self.conn)

    def test_a_rerun_converges_instead_of_accumulating(self):
        """A replay is deterministic. Running it twice must not double every
        cell in the table."""
        batch = spread_over_days(30, days=8)
        E.upsert(self.conn, batch)
        E.upsert(self.conn, batch)
        self.assertEqual(len(E.fetch(self.conn)), 30)

    def test_round_trips_the_stop_distance(self):
        """The field the cost model depends on. It was missing from the schema
        in the first draft, and every figure silently reverted to gross."""
        E.upsert(self.conn, [trial(1, stop_pct=0.42)])
        self.assertAlmostEqual(E.fetch(self.conn)[0]["stop_pct"], 0.42)

    def test_lists_the_kinds_it_actually_holds(self):
        E.upsert(self.conn, spread_over_days(10, days=5, kind="spring"))
        rows = E.kinds(self.conn)
        self.assertEqual(rows[0]["kind"], "spring")


if __name__ == "__main__":
    unittest.main()
