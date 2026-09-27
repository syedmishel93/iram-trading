#!/usr/bin/env python3
"""
test_events_summary.py - A RECURRING FAILURE IS A STANDING, NOT AN EVENT.

WHY THIS EXISTS

`/svc/events` returns `ORDER BY id DESC LIMIT 50` and nothing else. Built a card
on that and it can tell you the last fifty things that happened; it can NOT tell
you that one of them has happened 2,067 times.

That distinction was not hypothetical. `pair_scan_loop` failed on every run it
ever made -- 2,067 `pair_err` rows, 46% of every event the service had recorded,
`onchain_seen` empty -- and in a 50-row tail it looked like twelve ordinary
lines among other ordinary lines. Counting the tail would have under-reported it
by a factor of forty, which is the same shape as CLAUDE.md's "a count of what has
REPORTED is not a count of what EXISTS".

So the count is done in SQL over the whole table, and this pure function does the
part that can be wrong: deciding what a failure IS, and what order the reader
meets them in.

WHAT IS ASSERTED
  - a kind is a FAILURE by its name, in one place, so the card and the server
    cannot disagree about it
  - failures come first, newest first; everything else follows
  - an EMPTY table is "nothing has been recorded", never "all healthy" -- the
    `/svc/health` strip that painted "0 of 0 running" green is the rule here
  - the totals are the SUM OF THE GROUPS, so a truncated tail cannot shrink them
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from svc.core import summarise_events

# A FIXED CLOCK, BECAUSE THE FIXTURES HAVE FIXED TIMESTAMPS.
#
# `summarise_events` gained a recency bound in v63.2 -- a failure that stopped
# recurring is no longer reported as currently failing, because otherwise a job
# DELETED in v62.15 was counted among "failing jobs" for the life of the
# database. That makes the answer depend on the clock, and a test whose result
# depends on when it is run is a test that starts failing on its own.
#
# So `now` is passed explicitly and sits just after the newest fixture row. These
# checks are then about CLASSIFICATION, which is what they were always about.
NOW = 1790306500.0

FAILED = []


def check(name, got, want):
    if got == want:
        print("  ok   %s: %r" % (name, got))
    else:
        print("  FAIL %s: got %r, want %r" % (name, got, want))
        FAILED.append(name)


# The real shape, from `SELECT kind, count(*) n, max(t), min(t) FROM events GROUP BY kind`.
GROUPS = [
    {"kind": "claims_push", "n": 1469, "newest": 1790306346.0, "oldest": 1790200000.0, "sample": "82 of 92 written"},
    {"kind": "pair_err", "n": 2067, "newest": 1790306479.7, "oldest": 1790100000.0, "sample": "database is locked"},
    {"kind": "data_collect", "n": 220, "newest": 1790304000.0, "oldest": 1790000000.0, "sample": "cycle done"},
    {"kind": "whale_err", "n": 3, "newest": 1790306000.0, "oldest": 1790305000.0, "sample": "timed out"},
]

s = summarise_events(GROUPS, now=NOW)

print("A KIND IS A FAILURE BY ITS NAME, DECIDED IN ONE PLACE")
by_kind = {k["kind"]: k for k in s["kinds"]}
check("pair_err is a failure", by_kind["pair_err"]["failing"], True)
check("whale_err is a failure", by_kind["whale_err"]["failing"], True)
check("claims_push is not", by_kind["claims_push"]["failing"], False)
check("data_collect is not", by_kind["data_collect"]["failing"], False)

print()
print("FAILURES COME FIRST, NEWEST FIRST")
check("order", [k["kind"] for k in s["kinds"]],
      ["pair_err", "whale_err", "claims_push", "data_collect"])

print()
print("THE TOTALS ARE THE SUM OF THE GROUPS, NOT OF A 50-ROW TAIL")
check("total", s["total"], 1469 + 2067 + 220 + 3)
check("failing total", s["failingTotal"], 2067 + 3)
check("failing kinds", s["failingKinds"], 2)

print()
print("THE COUNT SURVIVES, WHICH IS THE WHOLE POINT")
check("pair_err count", by_kind["pair_err"]["n"], 2067)
check("pair_err share of everything", round(100.0 * 2067 / s["total"]), 55)

print()
print("AN EMPTY TABLE IS NOT A HEALTHY ONE")
e = summarise_events([], now=NOW)
check("no kinds", e["kinds"], [])
check("total", e["total"], 0)
check("failing total", e["failingTotal"], 0)
# "0 of 0 running" painted green is the defect this is modelled on: absence of
# a recorded failure is not evidence that nothing failed.
check("says so", bool(e.get("emptyReason")), True)
check("does not claim health", "healthy" in (e.get("emptyReason") or "").lower(), False)

print()
print("A GROUP WITH NO ROWS IS DROPPED, NOT DRAWN AS A ZERO")
z = summarise_events([{"kind": "ghost", "n": 0, "newest": 0, "oldest": 0, "sample": ""}] + GROUPS,
                     now=NOW)
check("ghost dropped", "ghost" in [k["kind"] for k in z["kinds"]], False)
check("the rest survive", len(z["kinds"]), 4)

print("A KIND NAME IS NOT THE ONLY WAY A FAILURE ARRIVES")
# MEASURED on the live log: `data_mvrv` has logged 223 rows, every one of them a
# 400, and its name does not end in `_err`. Classifying by name alone reported
# "1 kind failing" on a log where at least four were -- the same shape as a
# status strip painting "0 of 0 running" green. So the SQL counts rows whose
# message looks like a failure, and a kind with any is failing whatever it is
# called.
MIXED = [
    {"kind": "data_mvrv", "n": 223, "errs": 223, "newest": 1790306000.0, "oldest": 1790000000.0,
     "sample": "400 Client Error: Bad Request for url: https://community-api..."},
    {"kind": "data_collect", "n": 222, "errs": 0, "newest": 1790306100.0, "oldest": 1790000000.0,
     "sample": "cycle done"},
    {"kind": "data_fred", "n": 223, "errs": 0, "needsYou": 223, "newest": 1790306050.0,
     "oldest": 1790000000.0, "sample": "skipped: set FRED_API_KEY (free at fred.stlouisfed.org)"},
]
m = summarise_events(MIXED, now=NOW)
mk = {k["kind"]: k for k in m["kinds"]}
check("data_mvrv is failing on its MESSAGES", mk["data_mvrv"]["failing"], True)
check("data_collect is not", mk["data_collect"]["failing"], False)
check("failing kinds counted", m["failingKinds"], 1)
# The failing TOTAL is the erroring ROWS, not the kind's whole count: 223 of 223
# here, but a kind that failed twice in a thousand runs must not report a
# thousand failures.
check("failing total is the erroring rows", m["failingTotal"], 223)

print()
print("AND \"IT NEEDS SOMETHING FROM YOU\" IS NOT A FAILURE")
# FRED is not broken; it is waiting for a key only the operator can supply.
# Filing that under failures would bury the four that are actually broken.
check("fred is not failing", mk["data_fred"]["failing"], False)
check("fred asks for something", mk["data_fred"]["needsYou"], True)
check("and it is counted apart", m["needsYouKinds"], 1)

print()
print("A KIND THAT FAILED TWICE IN A THOUSAND IS NOT A BROKEN KIND")
part = summarise_events([
    {"kind": "claims_push", "n": 1469, "errs": 2, "newest": 1790306000.0, "oldest": 1790000000.0,
     "sample": "98 of 98 written"},
], now=NOW)
pk = part["kinds"][0]
check("still flagged", pk["failing"], True)
check("but the count is honest", part["failingTotal"], 2)
check("and the run count survives", pk["n"], 1469)

print()
print("A FAULT THAT STOPPED RECURRING IS NOT A FAULT THAT IS HAPPENING")
# THE DEFECT THIS EXISTS FOR, measured on the operator's own database:
# `failingKinds` was 11 and `failingTotal` 2,601, and three of the largest were
# repaired in v62.15 -- including `data_forexfactory_cal`, whose JOB WAS DELETED
# and which can therefore never log again. With no recency bound the card whose
# headline is "how many jobs are failing" could never go green however much was
# fixed, and `activity.ts` was already labelling that same kind "(retired)" while
# the server called it failing. One fact, two owners, disagreeing.
OLD = [
    {"kind": "data_forexfactory_cal", "n": 225, "errs": 225, "sample": "404 rss.php",
     "newest": NOW - (9 * 3600), "oldest": NOW - (70 * 24 * 3600)},
    {"kind": "pair_err", "n": 2069, "sample": "database is locked",
     "newest": NOW - (8 * 3600), "oldest": NOW - (70 * 24 * 3600)},
    {"kind": "whale_err", "n": 3, "sample": "timed out",
     "newest": NOW - 120, "oldest": NOW - 600},
]
old = summarise_events(OLD, now=NOW)
ok_ = {k["kind"]: k for k in old["kinds"]}
check("a retired job is not currently failing", ok_["data_forexfactory_cal"]["failing"], False)
check("a repaired one is not either", ok_["pair_err"]["failing"], False)
check("both are QUIET, which is not healthy", ok_["pair_err"]["quiet"], True)
check("the live one still is failing", ok_["whale_err"]["failing"], True)
check("the headline counts only what is happening", old["failingKinds"], 1)
check("and the failing total is the live one alone", old["failingTotal"], 3)
# 2,294 failures did happen and are not deleted -- they are reported APART.
check("history is kept, and counted apart", old["quietKinds"], 2)
check("with its own total", old["quietTotal"], 225 + 2069)
# THE AGE IS PUBLISHED, so a card states the fact rather than trusting the
# threshold chosen in core.py.
check("the age is reported", ok_["pair_err"]["ageS"], 8 * 3600)
check("having ever failed is still recorded", ok_["pair_err"]["everFailed"], True)
# ORDERING: what is happening now must sit above what stopped.
check("the live failure sorts first", old["kinds"][0]["kind"], "whale_err")

print()
print("A KIND ON THE BOUNDARY IS NOT A COIN FLIP")
edge = summarise_events([
    {"kind": "a_err", "n": 1, "sample": "x", "newest": NOW - old["staleAfterS"], "oldest": 0},
    {"kind": "b_err", "n": 1, "sample": "x", "newest": NOW - old["staleAfterS"] - 1, "oldest": 0},
], now=NOW)
ek = {k["kind"]: k for k in edge["kinds"]}
check("exactly at the bound is still failing", ek["a_err"]["failing"], True)
check("one second past it is quiet", ek["b_err"]["failing"], False)

print()
if FAILED:
    print("FAILED: %d" % len(FAILED))
    for f in FAILED:
        print("  - %s" % f)
    sys.exit(1)
print("ALL PASS")
