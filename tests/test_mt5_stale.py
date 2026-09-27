#!/usr/bin/env python3
"""
A STALE MT5 HANDLE, AND THE EMPTY BOOK THAT HID IT.

MEASURED against this operator's running terminal, logged in to a JustMarkets
demo account at the time:

    GET /mt5/health     -> {"available": true, ...}
    GET /mt5/account    -> {"error": "no account_info (is MT5 logged in?)"}
    GET /mt5/deals      -> {"error": "history_deals_get returned None
                                      ((-10001, 'IPC send failed'))"}
    GET /mt5/positions  -> {"positions": []}          <-- THE PROBLEM

TWO DEFECTS, and the second is the dangerous one.

1. `_ensure()` only calls `connect()` when `_STATE["connected"]` is falsy, and
   nothing ever sets it back. `initialize()` succeeded once when the service
   started; after the operator logged into a different account the handle went
   dead, `connected` stayed True, and every later call went down a pipe with
   nothing on the other end. `-10001 IPC send failed` is that pipe.

2. `positions()` does `positions_get() or []`. MT5 returns None to mean THE CALL
   FAILED and an empty tuple to mean YOU HAVE NO POSITIONS, and `or []` makes
   them the same answer. So the one endpoint that should have shouted reported a
   flat book, calmly, to a risk desk.

   This project already records the rule twice — "Zero is a value; absence is
   not", and a status strip that painted "0 of 0 running" green. An empty book is
   the single most reassuring thing this bridge can say, and it must never be
   what a failure looks like.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

import mt5_bridge


class _MT5Stub:
    """Just enough MT5 to drive the two paths."""

    def __init__(self, *, positions, err=(0, "ok"), initialize=True):
        self._positions = positions
        self._err = err
        self._initialize = initialize
        self.initialize_calls = 0

    def initialize(self):
        self.initialize_calls += 1
        return self._initialize

    def positions_get(self):
        return self._positions

    def last_error(self):
        return self._err


class _Pos:
    ticket = 1
    symbol = "XAUUSD"
    type = 0
    volume = 0.1
    price_open = 2600.0
    sl = 0.0
    tp = 0.0
    profit = 4.2
    swap = 0.0
    time = 1_700_000_000


def _run(stub, fn, *, connected=True):
    real_mt5, real_state = mt5_bridge._MT5, dict(mt5_bridge._STATE)
    real_avail = mt5_bridge.available
    mt5_bridge._MT5 = stub
    mt5_bridge._STATE["connected"] = connected
    mt5_bridge.available = lambda: (True, "ok")
    try:
        return fn()
    finally:
        mt5_bridge._MT5 = real_mt5
        mt5_bridge._STATE.clear()
        mt5_bridge._STATE.update(real_state)
        mt5_bridge.available = real_avail


def test_AN_EMPTY_BOOK_IS_AN_EMPTY_BOOK():
    """The honest empty case must still work, or the fix is worse than the bug."""
    stub = _MT5Stub(positions=())
    rows, err = _run(stub, mt5_bridge.positions)
    assert err is None, err
    assert rows == [], rows


def test_A_FAILED_CALL_IS_NOT_AN_EMPTY_BOOK():
    """None from `positions_get` means the call failed. It must not read as flat.

    This is the whole file. A risk desk shown a flat book stops asking questions.
    """
    stub = _MT5Stub(positions=None, err=(-10001, "IPC send failed"))
    rows, err = _run(stub, mt5_bridge.positions)
    assert rows is None, rows
    assert err, "a failed positions_get returned no error"
    assert "IPC" in err or "10001" in err, err


def test_a_real_position_still_comes_back():
    stub = _MT5Stub(positions=(_Pos(),))
    rows, err = _run(stub, mt5_bridge.positions)
    assert err is None, err
    assert len(rows) == 1 and rows[0]["symbol"] == "XAUUSD", rows


def test_A_STALE_HANDLE_IS_RECONNECTED_ONCE():
    """`connected` stays True forever, so a dead pipe is never noticed.

    `reconnect()` drops the flag and re-initialises, which is what lets a switch
    of trading account recover without restarting the service.
    """
    stub = _MT5Stub(positions=())
    mt5_bridge._STATE["connected"] = True
    _run(stub, lambda: mt5_bridge.reconnect(), connected=True)
    assert stub.initialize_calls == 1, stub.initialize_calls


def test_reconnect_reports_failure_rather_than_claiming_success():
    stub = _MT5Stub(positions=(), initialize=False, err=(-10003, "no terminal"))
    ok, why = _run(stub, lambda: mt5_bridge.reconnect(), connected=True)
    assert ok is False
    assert why, "a failed reconnect said nothing"


def test_the_error_is_recognised_as_a_dropped_link():
    """Which errors mean "the pipe died" is a decision worth naming and testing,
    because retrying a genuine refusal forever is its own defect."""
    assert mt5_bridge.is_link_error("IPC send failed")
    assert mt5_bridge.is_link_error("(-10001, 'IPC send failed')")
    assert mt5_bridge.is_link_error("no account_info (is MT5 logged in?)")
    # A symbol nobody has is a real answer, not a dropped link.
    assert not mt5_bridge.is_link_error("symbol NOSUCH not found")


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"  ok   {name}")
        except AssertionError as e:
            fails += 1
            print(f"  FAIL {name}: {e}")
        except Exception as e:  # noqa: BLE001  (a harness, not a service)
            fails += 1
            print(f"  ERR  {name}: {type(e).__name__}: {e}")
    print(f"\n{'FAILED' if fails else 'PASSED'} — {fails} failure(s)")
    sys.exit(1 if fails else 0)
