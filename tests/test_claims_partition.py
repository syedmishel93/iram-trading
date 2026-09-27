#!/usr/bin/env python3
"""THE CLAIMS BUCKETS MUST ADD UP TO THEIR OWN TOTAL.

WHAT WAS WRONG, and how it was found.

`scratchpad/probe.py` asks whether a route ANSWERS. It does not ask whether the
answer is coherent — and CLAUDE.md already records why that is not enough: the
Quant desk was dead while reporting nineteen libraries present. So the live
`/svc/claims/stats` body was read rather than counted, and the four numbers it
published did not sum to the fifth:

    total 723    decided 428 + pending 262 + unknowable 11  =  701

Twenty-two claims in the total and in no bucket. MEASURED against the table:
2,113 rows — `pending` 1,098, `target` 523, `stop` 442, `unknowable` 19, and
**`expired` 31, published nowhere**.

`_OUTCOMES` has five members and `_population` counted four.

WHY THE EXCLUSION WAS RIGHT AND THE SILENCE WAS NOT

`expired` must stay out of the hit-rate denominator. CLAUDE.md: "A TIMEOUT IS NOT
A LOSS. A setup that reaches neither its stop nor its target inside the horizon is
its own class, and folding it into 'stop' teaches a model that 'nothing happened'
looks like 'I was wrong'." That reasoning is untouched.

But a figure counted in a total and named in nothing is the shape of a bug, and a
reader who sums the card and finds 22 missing cannot tell a deliberate category
from an arithmetic error. "Anything that tolerates a partial failure has to name
what it lost everywhere it reports a total."

WHAT THIS PINS, AND WHY THE SECOND TEST IS THE IMPORTANT ONE

The partition check would catch the same gap again. `test_every_outcome_has_a_bucket`
catches the CLASS: it walks `_OUTCOMES` and requires each member to be reachable
in the published population, so adding a sixth outcome without a bucket fails
here rather than quietly reopening the hole. A guard that pins the instance
teaches the next person to add a number; one that pins the relationship does not.
Sibling of "a guard test that pins a COUNT fails on addition and passes on
substitution".

Run:  python -m pytest tests/test_claims_partition.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from typing import ClassVar

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

_TMP = tempfile.mkdtemp(prefix="iram-claims-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_claims as mc


def rows(**counts):
    """Build a population with the given outcome counts.

    `r_realised` is None throughout: expectancy is not what these check, and a
    number there would make the fixtures argue about a second thing.
    """
    out = []
    for outcome, n in counts.items():
        for _ in range(n):
            out.append({"outcome": outcome, "r_realised": None})
    return out


class Partition(unittest.TestCase):
    #: Every outcome the module declares, with a count that is distinct so a
    #: mis-attributed bucket cannot accidentally still add up.
    SPREAD: ClassVar[dict[str, int]] = {"pending": 7, "target": 5, "stop": 3, "expired": 2, "unknowable": 1}

    def test_the_buckets_partition_the_total(self):
        p = mc._population(rows(**self.SPREAD), "test")
        self.assertEqual(p["total"], sum(self.SPREAD.values()))
        parts = p["pending"] + p["unknowable"] + p["expired"] + p["decided"]
        self.assertEqual(
            parts, p["total"],
            "the published buckets leave %d of %d claims unaccounted for, which is "
            "exactly the gap that was on screen" % (p["total"] - parts, p["total"]),
        )

    def test_expired_is_reported_and_is_not_folded_into_losses(self):
        p = mc._population(rows(**self.SPREAD), "test")
        self.assertEqual(p["expired"], 2)
        # A TIMEOUT IS NOT A LOSS: it stays out of the denominator.
        self.assertEqual(p["decided"], 5 + 3)
        self.assertEqual(p["hits"], 5)
        self.assertAlmostEqual(p["hitRate"], 5 / 8)

    def test_a_population_of_only_timeouts_has_no_rate_rather_than_a_zero(self):
        """A null rate says nothing was answered; 0.0 says everything lost."""
        p = mc._population(rows(expired=9), "test")
        self.assertEqual(p["expired"], 9)
        self.assertEqual(p["decided"], 0)
        self.assertIsNone(p["hitRate"], "a zero here would read as nine losses")
        self.assertIsNone(p["low"])
        self.assertIsNone(p["high"])

    def test_every_outcome_has_a_bucket(self):
        """THE CLASS, not the instance. A sixth outcome fails here.

        `expired` was already in `_OUTCOMES` and counted by nothing. Walking the
        declaration is what makes the next addition visible instead of silent.
        """
        # `target` and `stop` are the two that compose `decided`; everything else
        # must have a key of its own name.
        composed = {"target", "stop"}
        p = mc._population(rows(**{o: 1 for o in mc._OUTCOMES}), "test")
        for outcome in mc._OUTCOMES:
            if outcome in composed:
                continue
            self.assertIn(
                outcome, p,
                "outcome %r is in _OUTCOMES and has no bucket in the published "
                "population, so it is counted in `total` and named nowhere — "
                "which is the defect this file exists for" % outcome,
            )
        parts = sum(p[o] for o in mc._OUTCOMES if o not in composed) + p["decided"]
        self.assertEqual(parts, p["total"], "every declared outcome must be counted once")

    def test_an_empty_population_is_zero_everywhere_and_refuses_a_rate(self):
        p = mc._population([], "test")
        self.assertEqual((p["total"], p["pending"], p["expired"], p["unknowable"]), (0, 0, 0, 0))
        self.assertIsNone(p["hitRate"])
        self.assertFalse(p["reportable"])


class TheIntervalBracketsTheRate(unittest.TestCase):
    """Read off the LIVE body while auditing: low <= hitRate <= high.

    A Wilson interval that does not contain its own point estimate is a broken
    interval, and it would look entirely plausible on screen.
    """

    def test_the_interval_contains_the_rate(self):
        for spread in ({"target": 5, "stop": 3}, {"target": 1, "stop": 99},
                       {"target": 99, "stop": 1}, {"target": 50, "stop": 50}):
            p = mc._population(rows(**spread), "test")
            self.assertLessEqual(p["low"], p["hitRate"], spread)
            self.assertLessEqual(p["hitRate"], p["high"], spread)
            self.assertGreaterEqual(p["low"], 0.0, spread)
            self.assertLessEqual(p["high"], 1.0, spread)

    def test_the_rate_is_hits_over_decided(self):
        p = mc._population(rows(target=220, stop=208, pending=262, unknowable=11, expired=22), "test")
        self.assertEqual(p["decided"], 428)
        self.assertEqual(p["hits"], 220)
        self.assertAlmostEqual(p["hitRate"], 220 / 428)
        # And the shape that was on screen now adds up.
        self.assertEqual(p["pending"] + p["unknowable"] + p["expired"] + p["decided"],
                         p["total"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
