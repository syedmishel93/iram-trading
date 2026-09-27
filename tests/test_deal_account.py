#!/usr/bin/env python3
"""
WHICH ACCOUNT EACH FILL CAME FROM — demo or live.

WHAT WAS WRONG

`mt5_deals` recorded `src` ("bridge" or "report") and nothing about the ACCOUNT.
The operator switches between their broker's demo and live accounts on purpose —
to test a strategy without losing money — and both sync into the same table,
indistinguishably.

Everything downstream then blends them:

  * `/svc/recon` grades demo round trips beside real ones,
  * the Journal shows one record,
  * and `/svc/costs` MEASURES THIS BROKER'S REAL SPREAD from the mixture — the
    figure that already found the backtester charging 3-5x too much.

A demo fill has no queue position, no partial fills and no requote, and its
slippage is whatever the simulator felt like. Feeding those into a spread
measurement produces a cost model confidently wrong in the CHEAP direction, and
every strategy searched against it clears a hurdle that does not exist.

The login number differs between the two accounts, so it is the natural key; the
kind is what a reader needs. Both are stamped on every deal at import.

WHY THIS IS A MIGRATION AND NOT A SCHEMA EDIT

The accumulated ledger is the one thing in this database that cannot be
recomputed — `db/schema.py` says so, and `migrate()` in `mishel_service.py` has
carried the instructions for the first real migration since it was written:
read the stored version, branch, ADDITIVE ALTERs only. This is that migration.
"""

import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

#: NEVER THE OPERATOR'S DATABASE. This project has had tests reach the live
#: store through three separate doors, and `tests/test_no_live_store.py` is the
#: gate that exists because of it.
_TMP = tempfile.mkdtemp(prefix="iram-dealacct-")
os.environ["MISHEL_SVC_DB"] = os.path.join(_TMP, "test.db")

from db import schema
from db.migrations import DEAL_ACCOUNT_COLUMNS, add_missing_columns

_N = [0]


def _fresh():
    """A database at the OLD shape, so the migration has something to do.

    A FRESH FILE PER CALL. Reusing one path and deleting it failed on Windows
    with `WinError 32`: the previous test's sqlite connection was still open, and
    Windows will not unlink a file that is. Counting up is cheaper than tracking
    every connection, and the directory is a temp one that goes with the process.
    """
    _N[0] += 1
    path = os.path.join(_TMP, f"old{_N[0]}.db")
    c = sqlite3.connect(path)
    c.execute(
        """CREATE TABLE mt5_deals(
             ticket INTEGER PRIMARY KEY, position_id INTEGER, time_ms INTEGER,
             type INTEGER, entry INTEGER, symbol TEXT, volume REAL, price REAL,
             commission REAL, swap REAL, profit REAL, comment TEXT, src TEXT,
             imported REAL)"""
    )
    c.execute(
        "INSERT INTO mt5_deals(ticket,time_ms,symbol,profit,src) VALUES(1,1000,'XAUUSD',12.5,'bridge')"
    )
    c.commit()
    return c


def _cols(c):
    return {r[1] for r in c.execute("PRAGMA table_info(mt5_deals)")}


def test_the_columns_are_added():
    c = _fresh()
    assert "account_kind" not in _cols(c), "fixture is already migrated"
    add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    cols = _cols(c)
    assert "login" in cols, cols
    assert "account_kind" in cols, cols


def test_EXISTING_ROWS_SURVIVE():
    """Additive means additive. The ledger cannot be recomputed."""
    c = _fresh()
    add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    row = c.execute("SELECT ticket, symbol, profit FROM mt5_deals").fetchone()
    assert row == (1, "XAUUSD", 12.5), row


def test_AN_OLD_ROW_IS_UNKNOWN_NOT_LIVE():
    """The rows already stored came from an unrecorded account.

    Backfilling them as "live" would promote every demo fill the operator has
    ever synced into the real cost measurement. Backfilling them as "demo" would
    throw away real history. Neither is known, so neither is claimed.
    """
    c = _fresh()
    add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    kind = c.execute("SELECT account_kind FROM mt5_deals WHERE ticket=1").fetchone()[0]
    assert kind in (None, "unknown"), kind


def test_IT_IS_IDEMPOTENT():
    """`init()` runs on every start, so a migration that only works once is a
    migration that crashes the service on the second boot."""
    c = _fresh()
    add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    assert "account_kind" in _cols(c)


def test_it_reports_what_it_added():
    """A migration that runs silently cannot be audited after the fact."""
    c = _fresh()
    added = add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    assert set(added) == {"login", "account_kind"}, added
    again = add_missing_columns(c, "mt5_deals", DEAL_ACCOUNT_COLUMNS)
    assert again == [], again


def test_a_missing_table_is_not_an_error():
    """`init()` creates tables and `migrate()` alters them, and the order between
    a fresh install and an upgrade is not worth depending on."""
    c = sqlite3.connect(":memory:")
    assert add_missing_columns(c, "no_such_table", DEAL_ACCOUNT_COLUMNS) == []


def test_the_new_schema_carries_the_columns_for_a_fresh_install():
    """A fresh database must not need the migration at all."""
    assert "account_kind" in schema.DDL, "mt5_deals DDL is missing account_kind"
    assert "login" in schema.DDL


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
