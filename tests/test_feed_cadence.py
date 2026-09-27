#!/usr/bin/env python3
"""
test_feed_cadence.py - A WEEKLY RESOURCE DOES NOT NEED AN HOURLY FETCH.

`data_calendar` has 42 rate-limit failures:

    429 Too Many Requests  https://nfs.faireconomy.media/ff_calendar_thisweek.json

The feed answers 200 when asked once; the vendor is throttling a loop that asks
for a WEEK'S calendar every hour, and asks again immediately on every service
restart. Probed directly: HTTP 200, 82 events.

TWO FAULTS, AND ONLY ONE OF THEM IS THE INTERVAL

The loop sleeps an hour, but `collect()` runs the moment the process starts, so
a run of restarts is a run of fetches with no interval at all. A module-level
timer would not help: it dies with the process, which is exactly the case that
needs covering. So freshness is read from the STORE, which survives restarts.

WHAT IS ASSERTED: the decision is arithmetic on a timestamp, it treats "never
fetched" as stale rather than fresh, and a clock that goes backwards does not
make a stale row look current.

`is_fresh` is pure. The fetch around it is not, and that is the point of
separating them.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

from svc.features import is_fresh

FAILED = []


def check(name, got, want):
    if got == want:
        print("  ok   %s: %r" % (name, got))
    else:
        print("  FAIL %s: got %r, want %r" % (name, got, want))
        FAILED.append(name)


NOW = 1_790_000_000.0
SIX_HOURS = 6 * 3600

print("A ROW WRITTEN RECENTLY IS FRESH")
check("one hour old", is_fresh(NOW - 3600, NOW, SIX_HOURS), True)
check("just now", is_fresh(NOW, NOW, SIX_HOURS), True)

print()
print("AND ONE OLDER THAN THE WINDOW IS NOT")
check("seven hours old", is_fresh(NOW - 7 * 3600, NOW, SIX_HOURS), False)
check("exactly at the edge", is_fresh(NOW - SIX_HOURS, NOW, SIX_HOURS), False)

print()
print("NEVER FETCHED IS STALE, NOT FRESH")
# The dangerous default. Treating "no row" as fresh would mean a brand new
# install never fetches anything at all -- the loop would look healthy and
# produce nothing, which is the `bars_loop` failure this project already records.
check("no row", is_fresh(None, NOW, SIX_HOURS), False)
check("zero", is_fresh(0, NOW, SIX_HOURS), False)
check("negative", is_fresh(-1, NOW, SIX_HOURS), False)

print()
print("A TIMESTAMP FROM THE FUTURE IS NOT TRUSTED")
# A clock that moved backwards, or a row written by a machine an hour ahead,
# must not pin a feed as permanently fresh.
check("an hour ahead", is_fresh(NOW + 3600, NOW, SIX_HOURS), False)

print()
print("AND RUBBISH IS STALE RATHER THAN AN EXCEPTION")
check("a string", is_fresh("nonsense", NOW, SIX_HOURS), False)
check("nan", is_fresh(float("nan"), NOW, SIX_HOURS), False)

print()
if FAILED:
    print("FAILED: %d" % len(FAILED))
    for f in FAILED:
        print("  - %s" % f)
    sys.exit(1)
print("ALL PASS")
