"""
THE BULK ARCHIVE'S EVICTION ORDER — `server/svc/store.py`.

NOTHING DOWNLOADS UNTIL THIS PASSES. Twenty gigabytes acquired with no bounded
way to remove it is a worse problem than having no data: a disk that fills is a
machine that stops, and this is a personal computer.

`eviction_order` is a PURE function over an inventory, which is the whole
reason the order is testable at all — no files are written here, and the four
rules below are checked as arithmetic rather than as filesystem side effects.

WHAT IS PINNED

1. TICKS GO BEFORE BARS. Ticks are re-downloadable bulk; bars are what every
   study reads.
2. CONTEXT GOES BEFORE TRADED. A yield explains a market; the market is the
   one you cannot replace.
3. OLDEST GOES BEFORE NEWEST.
4. THE LAST 90 DAYS ARE NEVER TOUCHED, whatever the budget says — and when the
   budget can only be met by breaking that, it REFUSES and says so rather than
   quietly destroying the only window a walk-forward can validate on.

Run:  python -m pytest tests/test_bar_store.py -v
"""

from __future__ import annotations

import os
import sys

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

from svc.bulkfetch import months_back
from svc.store import DAY_MS, eviction_order, partition

GB = 1_073_741_824
NOW = 1_800_000_000_000.0  # a fixed clock; nothing here depends on the real one


def item(kind, symbol, months_ago, gb, timeframe="1h"):
    """One partition. `months_ago` is approximate on purpose — the order is
    decided by relative age, never by calendar arithmetic."""
    return {
        "path": f"/{kind}/{symbol}/{timeframe}/{months_ago}",
        "kind": kind,
        "symbol": symbol,
        "timeframe": timeframe,
        "month_start_ms": NOW - months_ago * 30 * DAY_MS,
        "bytes": int(gb * GB),
    }


def names(plan):
    return [i["path"] for i in plan["remove"]]


def test_nothing_is_removed_when_under_budget():
    plan = eviction_order([item("bars", "BTCUSDT", 12, 1)], 5 * GB, NOW)
    assert plan["remove"] == []
    assert plan["over"] == 0
    # The reason is populated even when there is nothing to do: a card that
    # shows a blank where a policy should be teaches nobody anything.
    assert "nothing to remove" in plan["why"]


def test_ticks_go_before_bars():
    """Ticks are bulk you can download again. Bars are what studies read."""
    items = [
        item("bars", "BTCUSDT", 12, 3),
        item("ticks", "BTCUSDT", 12, 3),
    ]
    plan = eviction_order(items, 3 * GB, NOW, tradeable={"BTCUSDT"})
    assert names(plan) == ["/ticks/BTCUSDT/1h/12"]


def test_context_series_go_before_traded_ones():
    """A yield explains a market you trade; the market is the irreplaceable one."""
    items = [
        item("bars", "BTCUSDT", 12, 2),
        item("bars", "US10Y", 12, 2),
    ]
    plan = eviction_order(items, 2 * GB, NOW, tradeable={"BTCUSDT"})
    assert names(plan) == ["/bars/US10Y/1h/12"]


def test_oldest_goes_before_newest():
    items = [
        item("bars", "BTCUSDT", 6, 2),
        item("bars", "BTCUSDT", 24, 2),
        item("bars", "BTCUSDT", 12, 2),
    ]
    plan = eviction_order(items, 4 * GB, NOW, tradeable={"BTCUSDT"})
    assert names(plan) == ["/bars/BTCUSDT/1h/24"]


def test_the_three_rules_compose_rather_than_fighting():
    """
    One sort, not three passes. A newer TICK partition still goes before an
    older BAR one, because the kind outranks the age — which is the intended
    reading of the order and the thing three separate passes would get wrong.
    """
    items = [
        item("ticks", "BTCUSDT", 4, 1),
        item("bars", "BTCUSDT", 36, 1),
        item("ticks", "US10Y", 4, 1),
    ]
    plan = eviction_order(items, 1 * GB, NOW, tradeable={"BTCUSDT"})
    # context ticks, then traded ticks, then bars — however old the bars are.
    assert names(plan) == ["/ticks/US10Y/1h/4", "/ticks/BTCUSDT/1h/4"]


def test_the_last_ninety_days_are_never_removed():
    """Whatever the budget says. This is the window a walk-forward validates on."""
    items = [item("ticks", "BTCUSDT", 1, 10)]  # ~30 days old, huge
    plan = eviction_order(items, 1 * GB, NOW, tradeable={"BTCUSDT"})
    assert plan["remove"] == []
    assert plan["protected"] == 1


def test_it_refuses_rather_than_breaking_the_window():
    """
    A budget that can only be met by deleting recent history is a
    misconfiguration. Obeying it silently would destroy the data and leave the
    operator to discover it from a backtest that suddenly has no out-of-sample.
    """
    items = [
        item("ticks", "BTCUSDT", 1, 8),   # protected, and most of the weight
        item("bars", "BTCUSDT", 40, 1),   # removable
    ]
    plan = eviction_order(items, 1 * GB, NOW, tradeable={"BTCUSDT"})
    assert plan["freed"] < plan["over"]
    assert "not enough" in plan["why"]
    assert "Raise the budget" in plan["why"]
    # It still removes what it legitimately can.
    assert names(plan) == ["/bars/BTCUSDT/1h/40"]


def test_it_stops_as_soon_as_it_is_under_budget():
    """Removing more than necessary is data loss with extra steps."""
    items = [item("bars", "X", 20 + i, 1) for i in range(6)]
    plan = eviction_order(items, 4 * GB, NOW)
    assert len(plan["remove"]) == 2
    assert plan["freed"] >= plan["over"]


def test_the_plan_always_explains_itself():
    plan = eviction_order([item("bars", "BTCUSDT", 30, 6)], 1 * GB, NOW, tradeable={"BTCUSDT"})
    assert plan["why"]
    assert "budget" in plan["why"]


def test_the_layout_partitions_by_month():
    """
    Monthly, because that is the unit things are DOWNLOADED and EVICTED in:
    Binance publishes monthly archives, and a month frees real space without
    losing a year.
    """
    p = partition("ticks", "btcusdt", "1m", 1_767_225_600_000).replace("\\", "/")
    assert p.endswith("ticks/BTCUSDT/1m/year=2026/month=01")


# --------------------------------------------------------------------------
# The downloader's month arithmetic. Everything else about it is network and
# filesystem; this is the part that can be wrong in a way nobody notices.
# --------------------------------------------------------------------------

#: 2026-09-24, fixed. A test whose expected months depend on today is a test
#: that starts failing on the first of a month for no reason.
SEP_24_2026 = 1_790_000_000.0


def test_it_asks_only_for_COMPLETE_months():
    """
    Binance publishes a month's archive after the month ENDS. Asking for the
    current one is a guaranteed 404 that reads exactly like a broken symbol, so
    the newest month offered is always the previous one.
    """
    got = months_back(3, SEP_24_2026)
    assert got[0] == (2026, 8), "the current month must never be requested"
    assert got == [(2026, 8), (2026, 7), (2026, 6)]


def test_it_walks_back_across_a_year_boundary():
    got = months_back(4, 1_768_000_000.0)  # mid-January 2026
    assert got == [(2025, 12), (2025, 11), (2025, 10), (2025, 9)]


def test_it_returns_newest_first():
    """Newest first so an interrupted run has the RECENT months, which are the
    ones a walk-forward validates on."""
    got = months_back(6, SEP_24_2026)
    assert got == sorted(got, reverse=True)
