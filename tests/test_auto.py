"""The autonomous loop: what it studies, what it refuses, and what it stores.

WHAT THIS IS GUARDING AGAINST

CLAUDE.md records the same defect three times over — a component that reports
itself healthy while doing nothing. `bars_loop` read its enrolment from a config
key that one module read and zero modules wrote, so it ticked hourly, showed a
fresh last-tick age in `/svc/health`, and produced no work for a whole release.
`/svc/health` itself built its loop list from what had REPORTED and painted
"0 of 0 running" green.

So the tests that matter here are the ones about the subject list and the
refusals:

 1. THE SUBJECT LIST IS DERIVED FROM DATA THAT HAS A WRITER. It comes from the
    `bars` table, not from a config key, and a series below the floor is not a
    subject. A loop with nothing to do says so by name.
 2. A REFUSAL IS ANSWERED BEFORE ANY WORK STARTS, and it names what is missing.
 3. THE STORED ANSWER CARRIES THE QUESTION. A changed rule library or a changed
    horizon is a different question, and the key has to miss.
 4. THE UPSERT REPLACES. `auto_runs` has a natural key of (sym, tf) and no
    surrogate id; an upsert aimed at the wrong target does not fail, it silently
    inserts a duplicate per pass.

Run by `verify.py`, which sets MISHEL_SVC_DB so nothing here reaches the
operator's database.
"""

import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

# Below the bootstrap that makes it loadable. E402 is deferred in ruff.toml, so
# these need no directive — and a directive for a rule the config does not
# enable is itself a finding, which is how the gate caught this one.
from db import db, init
from svc import auto

# THE SCHEMA IS APPLIED BEFORE ANY TEST TOUCHES A TABLE. Importing `db` opens a
# connection and creates nothing; the tables come from `init()`, which
# `mishel_service` calls on import and which a test loading only `svc.auto`
# never reaches. The first run of this file failed with "no such table: bars"
# on all fourteen tests, which is the honest way for that to be found.
init()


HOUR = 3_600_000


@pytest.fixture(autouse=True)
def _clean_bars():
    """Every test owns the bars table, and puts it back.

    Module-scoped fixtures made `test_router.py` twice as fast; here the tests
    each need a DIFFERENT archive, so the saving is not available and the
    isolation is what matters.
    """
    with db() as c:
        c.execute("DELETE FROM bars")
        c.execute("DELETE FROM auto_runs")
    yield
    with db() as c:
        c.execute("DELETE FROM bars")
        c.execute("DELETE FROM auto_runs")


def put(src, sym, tf, n, start=1_700_000_000_000):
    rows = [(src, sym, tf, start + i * HOUR, 100.0, 101.0, 99.0, 100.5, 10.0) for i in range(n)]
    with db() as c:
        c.executemany(
            "INSERT INTO bars(src,sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(src,sym,tf,t) DO UPDATE SET c=excluded.c",
            rows,
        )


# ----------------------------------------------------------- the subjects --
def test_a_series_below_the_floor_is_not_a_subject():
    put("binance", "BTCUSDT", "1h", auto.MIN_BARS - 1)
    assert auto.subjects() == []
    # And the refusal NAMES the floor, so the operator knows what would fix it.
    r = auto.readiness()
    assert r["ok"] is False
    assert str(auto.MIN_BARS) in r["why"]


def test_a_series_at_the_floor_is_a_subject():
    put("binance", "BTCUSDT", "1h", auto.MIN_BARS)
    subs = auto.subjects()
    assert [(s, t, src) for s, t, src, _ in subs] == [("BTCUSDT", "1h", "binance")]


def test_the_fuller_source_wins_and_is_named():
    # A broker's XAUUSD and a proxy's XAUUSD are DIFFERENT SERIES. Blending them
    # is the defect `svc/bars.py` records the old `ohlc_cache` having, so the
    # loop picks one and says which.
    put("proxy", "XAUUSD", "1h", auto.MIN_BARS + 10)
    put("mt5", "XAUUSD", "1h", auto.MIN_BARS + 900, start=1_600_000_000_000)
    subs = auto.subjects()
    assert len(subs) == 1, "one series, not two"
    sym, tf, src, n = subs[0]
    assert (sym, tf, src) == ("XAUUSD", "1h", "mt5")
    assert n == auto.MIN_BARS + 900


def test_one_symbol_at_two_bar_sizes_is_two_subjects():
    # A bar size is part of what a series IS — the same market at 1h and 4h are
    # different questions with different base rates.
    put("binance", "BTCUSDT", "1h", auto.MIN_BARS + 5)
    put("binance", "BTCUSDT", "4h", auto.MIN_BARS + 5)
    assert {(s, t) for s, t, _, _ in auto.subjects()} == {("BTCUSDT", "1h"), ("BTCUSDT", "4h")}


def test_the_bound_rotates_rather_than_falling_on_the_same_markets():
    """A cap that always picks the same members makes the rest dead weight.

    MEASURED once `bars_loop` was fixed and the archive filled: 34 qualifying
    (market, bar size) pairs and a cap of 6, taken richest-first — so the same
    six were studied every pass forever and 28 markets the operator holds
    history for could never be studied at all.
    """
    # EXACTLY TWO PASSES' WORTH, so "the second pass reaches the other half" is
    # an exact claim rather than an approximate one. With nine and a cap of six
    # an overlap of three is correct rotation, and a test that called that a
    # failure would be asserting the wrong thing.
    n = auto.MAX_SUBJECTS * 2
    for i in range(n):
        put("binance", f"ROT{i:02d}", "1h", auto.MIN_BARS + i)

    first = [(s, t) for s, t, _src, _n in auto.subjects()]
    assert len(first) == auto.MAX_SUBJECTS
    # Studying them marks them, exactly as a pass does.
    for sym, tf in first:
        auto.store({"sym": sym, "tf": tf}, "q")

    second = [(s, t) for s, t, _src, _n in auto.subjects()]
    assert len(second) == auto.MAX_SUBJECTS
    # THE OTHER HALF, with nothing repeated: every qualifying series is covered
    # in two passes rather than six of them being covered forever.
    assert not set(second) & set(first), f"second pass repeated {set(second) & set(first)}"
    assert len(set(first) | set(second)) == n


def test_a_never_studied_market_is_reached_before_a_stale_one():
    put("binance", "OLD", "1h", auto.MIN_BARS + 500)
    auto.store({"sym": "OLD", "tf": "1h"}, "q")
    put("binance", "NEW", "1h", auto.MIN_BARS)  # thinner, but never studied
    order = [s for s, _t, _src, _n in auto.subjects()]
    assert order.index("NEW") < order.index("OLD"), order


def test_the_pass_is_bounded_however_much_is_held():
    for i in range(auto.MAX_SUBJECTS + 4):
        put("binance", f"SYM{i}", "1h", auto.MIN_BARS + i)
    subs = auto.subjects()
    assert len(subs) == auto.MAX_SUBJECTS
    # Nothing has been studied, so every one ties on recency and the tiebreak
    # is richest-first — which is what decides where a cold start begins.
    counts = [n for _, _, _, n in subs]
    assert counts == sorted(counts, reverse=True)


# ----------------------------------------------------------- the refusals --
def test_it_refuses_before_it_starts_when_nothing_is_held():
    out = auto.auto_pass()
    assert out["ok"] is False
    assert out["studied"] == 0
    assert "800" in out["why"] or "engine" in out["why"] or "node" in out["why"]
    # AND IT DID NOT MARK ITSELF AS HAVING RUN. A refused pass that bumps the
    # counter looks exactly like a pass that studied nothing.
    assert auto.STATE["running"] is False


def test_a_pass_already_running_is_refused_rather_than_doubled():
    put("binance", "BTCUSDT", "1h", auto.MIN_BARS)
    auto.STATE["running"] = True
    try:
        out = auto.auto_pass()
        assert out["ok"] is False
        assert "already running" in out["why"]
    finally:
        auto.STATE["running"] = False


# ------------------------------------------------------------ the question --
def test_the_key_changes_when_the_library_changes():
    a = auto._question(["one", "two"])
    b = auto._question(["one", "two", "three"])
    assert a != b, "adding a rule changes the field every survivor had to beat"


def test_the_key_ignores_the_order_the_rules_arrived_in():
    assert auto._question(["b", "a"]) == auto._question(["a", "b"])


def test_the_key_changes_when_the_horizon_changes():
    a = auto._question(["one"])
    old = auto.HORIZON
    auto.HORIZON = old + 1
    try:
        assert auto._question(["one"]) != a, "a different horizon is a different base rate"
    finally:
        auto.HORIZON = old


# -------------------------------------------------------------- the store --
def test_storing_the_same_series_twice_replaces_rather_than_duplicates():
    # The conflict target is the NATURAL key (sym, tf). A table with a surrogate
    # id would conflict on something that can never collide, and an upsert aimed
    # at it inserts a duplicate per pass — silently.
    auto.store({"sym": "BTCUSDT", "tf": "1h", "bars": 1}, "q1")
    auto.store({"sym": "BTCUSDT", "tf": "1h", "bars": 2}, "q2")
    got = auto.results()
    assert len(got) == 1
    assert got[0]["bars"] == 2
    assert got[0]["q"] == "q2"


def test_results_carry_when_they_were_measured():
    before = time.time()
    auto.store({"sym": "ETHUSDT", "tf": "4h"}, "q")
    got = auto.results()
    assert len(got) == 1
    assert got[0]["at"] >= before


def test_results_survive_a_row_whose_payload_is_unreadable():
    # One corrupt row must not take the whole desk down with it.
    auto.store({"sym": "BTCUSDT", "tf": "1h"}, "q")
    with db() as c:
        c.execute("INSERT INTO auto_runs(sym,tf,q,at,payload) VALUES(?,?,?,?,?)", ("X", "1h", "q", 1.0, "{broken"))
    got = auto.results()
    assert [r["sym"] for r in got] == ["BTCUSDT"]


# ------------------------------------------------------------- the engine --
def test_the_catalogue_is_the_engines_own_library_or_an_honest_refusal():
    """The library must come from the engine that runs it, never a Python copy.

    Two lists naming the same thing WILL disagree, and nothing says so — the
    desk-group defect CLAUDE.md records as 0 of 24 agreeing. Where node or the
    built engine is absent the loop refuses by name, and this asserts THAT
    rather than skipping, because a test that silently does not run is the
    mechanism that hid nineteen files.
    """
    specs = auto.catalogue()
    ready = auto.readiness()
    if not ready["node"] or not ready["engine_built"]:
        assert specs == []
        assert "node" in ready["why"] or "engine" in ready["why"]
        return
    assert len(specs) > 5, "the shipped library is not a handful of rules"
    for sp in specs:
        # A ledger job needs the RULE, not a label for it. The first version of
        # the catalogue returned {id, name, style} and could not be run.
        assert sp["id"] and sp["name"]
        assert isinstance(sp.get("long"), list)
        assert isinstance(sp.get("stop"), dict)
