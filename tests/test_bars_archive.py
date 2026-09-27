"""
THE DURABLE BAR ARCHIVE — `server/svc/bars.py`.

Until v60.3 every candle this product held lived in one browser profile's
IndexedDB, evictable without warning, and `mishel.db` held no bars at all.
These pin the half that now survives a cleared browser.

WHAT IS PINNED

1. A SERIES IS (source, symbol, timeframe). The table this replaces keyed on
   (sym, tf) alone, so a broker's XAUUSD and yfinance's XAUUSD would have been
   written into one series and silently blended. Two sources must stay two.
2. ASCENDING AND UNIQUE ON THE WAY IN. A repeated timestamp reaching the
   backtest engine is what made an autonomous sweep report "85 could not be
   studied on this history" — see `ascendingUnique` in store/barstore.ts. A
   store that accepts one hands the same failure to the next reader.
3. THE FORMING BAR IS NEVER STORED. Its close changes every tick, so keeping it
   writes a number that was never a close — but only when the caller SAYS which
   bar is forming. A client that does not know must not have bars removed.
4. RE-POSTING CORRECTS, IT DOES NOT DUPLICATE. A venue revising a bar is the
   ordinary case, not an error.

Run:  python -m pytest tests/test_bars_archive.py -v
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

SERVER = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

# A throwaway database. Four test files once wrote to the operator's live
# `server/mishel.db`; this is set BEFORE the service imports, which is the only
# moment it can be set.
_TMP = tempfile.mkdtemp(prefix="iram-bars-test-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

import mishel_service as svc


@pytest.fixture
def client():
    svc.app.config["TESTING"] = True
    with svc.app.test_client() as c:
        with svc.db() as con:
            con.execute("DELETE FROM bars")
        yield c


def bars(start_t: float, n: int, price: float = 100.0):
    return [
        {"t": start_t + i * 3600.0, "o": price + i, "h": price + i + 1,
         "l": price + i - 1, "c": price + i + 0.5, "v": 10 + i}
        for i in range(n)
    ]


def test_a_series_is_source_symbol_and_timeframe(client):
    """The same instrument from two venues is two series, not one blended one."""
    client.post("/svc/bars", json={"src": "binance", "sym": "XAUUSD", "tf": "1h", "bars": bars(0, 5, 2000)})
    client.post("/svc/bars", json={"src": "mt5", "sym": "XAUUSD", "tf": "1h", "bars": bars(0, 5, 2001)})

    a = client.get("/svc/bars?src=binance&sym=XAUUSD&tf=1h").get_json()
    b = client.get("/svc/bars?src=mt5&sym=XAUUSD&tf=1h").get_json()
    assert len(a["bars"]) == 5
    assert len(b["bars"]) == 5
    # Different venues quote different prices for the same instant. If the key
    # were (sym, tf) one would have overwritten the other.
    assert a["bars"][0]["o"] != b["bars"][0]["o"]


def test_it_refuses_a_series_it_cannot_name(client):
    r = client.post("/svc/bars", json={"sym": "BTCUSDT", "tf": "1h", "bars": bars(0, 2)})
    assert r.status_code == 400
    assert "src" in r.get_json()["err"]


def test_a_repeated_timestamp_is_stored_once(client):
    """The defect this guards is not hypothetical: a duplicate reached the
    engine and every rule in a sweep was reported as unstudyable."""
    dupes = bars(0, 3) + bars(2 * 3600.0, 1)
    client.post("/svc/bars", json={"src": "binance", "sym": "BTCUSDT", "tf": "1h", "bars": dupes})
    got = client.get("/svc/bars?src=binance&sym=BTCUSDT&tf=1h").get_json()["bars"]

    assert len(got) == 3
    ts = [b["t"] for b in got]
    assert ts == sorted(ts)
    assert len(set(ts)) == len(ts)


def test_re_posting_corrects_rather_than_duplicating(client):
    """A venue revising a closed bar is ordinary. The newest copy wins."""
    client.post("/svc/bars", json={"src": "binance", "sym": "BTCUSDT", "tf": "1h", "bars": bars(0, 3)})
    revised = bars(0, 3)
    revised[1]["c"] = 999.0
    client.post("/svc/bars", json={"src": "binance", "sym": "BTCUSDT", "tf": "1h", "bars": revised})

    got = client.get("/svc/bars?src=binance&sym=BTCUSDT&tf=1h").get_json()["bars"]
    assert len(got) == 3
    assert got[1]["c"] == 999.0


def test_the_forming_bar_is_dropped_when_the_caller_names_it(client):
    """Its close changes every tick, so storing it writes a number that was
    never a close."""
    r = client.post("/svc/bars", json={
        "src": "binance", "sym": "BTCUSDT", "tf": "1h",
        "bars": bars(0, 5),
        # The newest CLOSED boundary: bar 4 (t = 4*3600) is still forming.
        "closedBefore": 4 * 3600.0,
    })
    body = r.get_json()
    assert body["stored"] == 4
    assert body["dropped_forming"] == 1


def test_nothing_is_dropped_when_the_caller_does_not_know(client):
    """Silently removing a caller's newest bar because it MIGHT be forming
    would be the store inventing a fact it was not told."""
    r = client.post("/svc/bars", json={"src": "binance", "sym": "BTCUSDT", "tf": "1h", "bars": bars(0, 5)})
    assert r.get_json()["stored"] == 5
    assert r.get_json()["dropped_forming"] == 0


def test_inventory_answers_how_much_history_there_is(client):
    """The question that could previously only be answered by opening a
    browser's developer tools."""
    client.post("/svc/bars", json={"src": "binance", "sym": "BTCUSDT", "tf": "1h", "bars": bars(0, 10)})
    client.post("/svc/bars", json={"src": "yfinance", "sym": "SPX", "tf": "1d", "bars": bars(0, 4)})

    inv = client.get("/svc/bars/inventory").get_json()
    assert inv["total_bars"] == 14
    by = {(s["src"], s["sym"], s["tf"]): s for s in inv["series"]}
    btc = by[("binance", "BTCUSDT", "1h")]
    assert btc["bars"] == 10
    assert btc["oldest"] == 0.0
    assert btc["newest"] == 9 * 3600.0


def test_a_read_is_bounded(client):
    """A typo in a query string must not ask for the whole table."""
    client.post("/svc/bars", json={"src": "binance", "sym": "BTCUSDT", "tf": "1h", "bars": bars(0, 20)})
    got = client.get("/svc/bars?src=binance&sym=BTCUSDT&tf=1h&n=5").get_json()["bars"]
    assert len(got) == 5
    # The NEWEST five, because a study window is measured back from now.
    assert got[-1]["t"] == 19 * 3600.0


def test_the_enrolment_list_is_read_not_invented(client):
    """An empty list means top up nothing. A loop that invented a default would
    be downloading instruments nobody asked for, hourly, forever."""
    from svc import bars as barsmod

    assert barsmod.enrolled() == []
    with svc.db() as c:
        c.execute(
            "INSERT INTO config(k,v) VALUES('bars_enrolled',?) "
            "ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            ("yfinance|SPX|1d, binance|BTCUSDT|1h",),
        )
    assert barsmod.enrolled() == [("yfinance", "SPX", "1d"), ("binance", "BTCUSDT", "1h")]


def test_enrolment_is_written_by_the_client(client):
    """
    THE LOOP READ THIS KEY AND NOTHING WROTE IT.

    `bars_loop` ran hourly and did nothing, because its enrolment list lived in
    a config key only the loop itself ever touched — a component reporting a
    healthy tick while producing no work. The client owns the list; this is
    where it lands.
    """
    r = client.post("/svc/bars/enrol", json={"series": [
        {"source": "binance", "symbol": "btcusdt", "timeframe": "1h"},
        {"source": "yfinance", "symbol": "SPX", "timeframe": "1d"},
    ]})
    assert r.get_json()["enrolled"] == 2

    from svc import bars as barsmod
    assert barsmod.enrolled() == [("binance", "BTCUSDT", "1h"), ("yfinance", "SPX", "1d")]

    got = client.get("/svc/bars/enrol").get_json()["series"]
    assert got[0] == {"source": "binance", "symbol": "BTCUSDT", "timeframe": "1h"}


def test_enrolment_replaces_rather_than_appends(client):
    """It is a statement of what should be current, not an append: a series the
    operator removed must stop being fetched."""
    client.post("/svc/bars/enrol", json={"series": [
        {"source": "binance", "symbol": "BTCUSDT", "timeframe": "1h"},
        {"source": "binance", "symbol": "ETHUSDT", "timeframe": "1h"},
    ]})
    client.post("/svc/bars/enrol", json={"series": [
        {"source": "binance", "symbol": "BTCUSDT", "timeframe": "1h"},
    ]})
    from svc import bars as barsmod
    assert barsmod.enrolled() == [("binance", "BTCUSDT", "1h")]


def test_a_field_carrying_a_separator_is_refused(client):
    """The list is one config string joined on `,` and `|`. A symbol carrying
    either would split into a different series on the way back out."""
    r = client.post("/svc/bars/enrol", json={"series": [
        {"source": "binance", "symbol": "BTC,USDT", "timeframe": "1h"},
        {"source": "bin|ance", "symbol": "ETHUSDT", "timeframe": "1h"},
        {"source": "binance", "symbol": "SOLUSDT", "timeframe": "1h"},
    ]})
    assert r.get_json()["enrolled"] == 1
    from svc import bars as barsmod
    assert barsmod.enrolled() == [("binance", "SOLUSDT", "1h")]
