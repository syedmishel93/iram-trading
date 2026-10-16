#!/usr/bin/env python3
"""
DEMO OR LIVE — the one field the account payload was missing.

WHAT WAS WRONG

`/mt5/account` returned login, currency, balance, equity, margin, margin_free,
leverage and server. Everything a risk governor needs to size a position, and
nothing that says whether the account it is sizing against is REAL.

MT5 knows. `account_info().trade_mode` is 0 for a demo, 1 for a contest and 2
for a real account, and the bridge was dropping it.

WHY IT MATTERS HERE MORE THAN IN MOST PRODUCTS

This terminal's whole discipline is that a figure states what it is measured
from. `/mt5/deals` is described in its own docstring as "what turns 'the
system's record' into YOUR record" — it feeds the Journal, the reconciliation
engine and `/svc/costs`, which measures this broker's real spread and found the
backtester charging 3-5x too much.

A DEMO FILL IS NOT A REAL FILL. It has no queue position, no partial fills, no
requote, and its slippage is whatever the simulator felt like. Feeding demo
deals into a spread measurement produces a cost model that is confidently wrong
in the cheap direction, and every strategy searched against it clears a hurdle
that does not exist. The account would look identical in the payload either way.

So the mode travels with the account, and anything derived from it can say which
kind of account it came from.

THE TEST IS A KNOWN-ANSWER TEST against a fake `account_info`, because MT5 is
not installed on the machine this gate runs on and a test that needs a live
broker is a test that never runs.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

import mt5_bridge


class _FakeAccount:
    """Exactly the attributes `account()` reads, plus the one being added."""

    def __init__(self, trade_mode):
        self.login = 12345678
        self.currency = "USD"
        self.balance = 10_000.0
        self.equity = 10_050.0
        self.margin = 120.0
        self.margin_free = 9_930.0
        self.leverage = 500
        self.server = "JustMarkets-Demo"
        self.name = "A Trader"
        self.company = "Just Global Markets Ltd."
        self.trade_mode = trade_mode


class _FakeMT5:
    def __init__(self, acct):
        self._acct = acct

    def account_info(self):
        return self._acct


def _with_account(acct):
    """Swap the module's MT5 handle and neutralise its connect guard."""
    real_mt5 = mt5_bridge._MT5
    real_ensure = mt5_bridge._ensure
    mt5_bridge._MT5 = _FakeMT5(acct)
    mt5_bridge._ensure = lambda: None
    try:
        return mt5_bridge.account()
    finally:
        mt5_bridge._MT5 = real_mt5
        mt5_bridge._ensure = real_ensure


def test_demo_is_reported_as_demo():
    d, err = _with_account(_FakeAccount(0))
    assert err is None, err
    assert d["trade_mode"] == 0
    assert d["account_kind"] == "demo", d["account_kind"]


def test_real_is_reported_as_live():
    d, err = _with_account(_FakeAccount(2))
    assert err is None, err
    assert d["account_kind"] == "live", d["account_kind"]


def test_contest_is_its_own_kind_not_folded_into_live():
    """A contest account is not a demo and is not the operator's money either.

    Folding it into either would be a claim. It is rare and it is cheap to name.
    """
    d, err = _with_account(_FakeAccount(1))
    assert err is None, err
    assert d["account_kind"] == "contest", d["account_kind"]


def test_an_unknown_mode_refuses_rather_than_guessing():
    """A future MT5 constant must not be silently reported as live.

    Guessing "live" would let demo fills through; guessing "demo" would make a
    real account's results look like practice. `unknown` is the only honest
    answer and every reader can then decide.
    """
    d, err = _with_account(_FakeAccount(7))
    assert err is None, err
    assert d["account_kind"] == "unknown", d["account_kind"]


def test_a_broker_that_omits_trade_mode_is_unknown_not_live():
    """The attribute has to be ABSENT-SAFE.

    `getattr` with a default of 2 would report every such broker as live.
    """

    class _NoMode(_FakeAccount):
        def __init__(self):
            super().__init__(0)
            del self.trade_mode

    d, err = _with_account(_NoMode())
    assert err is None, err
    assert d["account_kind"] == "unknown", d["account_kind"]


def test_the_existing_fields_are_untouched():
    """Adding a field must not move one. The governor reads all of these."""
    d, _ = _with_account(_FakeAccount(2))
    for k in ("login", "currency", "balance", "equity", "margin",
              "margin_free", "leverage", "server"):
        assert k in d, f"{k} disappeared from the account payload"
    assert d["balance"] == 10_000.0
    assert d["equity"] == 10_050.0


def test_the_broker_is_named():
    """`server` is a hostname; `company` is who you are actually trading with.

    Both are kept: the first identifies the endpoint, the second the counterparty,
    and a reconciliation that cannot name the counterparty is harder to audit.
    """
    d, _ = _with_account(_FakeAccount(2))
    assert d.get("company") == "Just Global Markets Ltd."


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
    print(f"\n{'FAILED' if fails else 'PASSED'} — {fails} failure(s)")
    sys.exit(1 if fails else 0)
