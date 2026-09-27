"""
The psycopg adapter, checked without a Postgres server.

WHY THIS EXISTS SEPARATELY FROM `test_db_rewrite.py`
That file checks the SQL translation, which is a pure function. This one checks
the OBJECT the service is handed — the thing that has to behave like
`sqlite3.Connection` at seventy-nine call sites. Those two can be wrong
independently: a perfect translation handed to a connection whose `with` block
closes instead of committing loses every write on the busiest route.

A stub stands in for psycopg. That is not a shortcut around a real database:
what is being checked here is entirely on this side of the wire — which SQL
text comes out, whether a row indexes by name and by position, and whether the
transaction is committed or rolled back. A live server cannot answer those any
better, and would make this test unrunnable on the machine that needs it most.

Live Postgres behaviour — types, constraints, the conflict targets actually
existing — is checked by `test_db_rewrite.py` against the real schema, and by
running the service against a real server, which is a manual step recorded in
docs/HANDOVER.md.
"""

from __future__ import annotations

import os
import sys
from typing import Any, Self

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

from db.driver import Row, _PgConnection


class FakeCursor:
    """Records what it was asked, returns what it was told to."""

    def __init__(self, owner: FakeRaw) -> None:
        self.owner = owner
        self.rowcount = 0
        self._rows: list[Any] = []

    def execute(self, sql: str, params: Any = None) -> None:
        self.owner.executed.append((sql, params))
        self._rows = list(self.owner.next_rows)
        self.rowcount = len(self._rows)

    def fetchone(self) -> Any:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[Any]:
        return list(self._rows)

    def __iter__(self) -> Any:
        return iter(self._rows)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def close(self) -> None:
        pass


class FakeRaw:
    """A psycopg connection, as far as the adapter is concerned."""

    def __init__(self) -> None:
        self.executed: list[tuple[str, Any]] = []
        self.next_rows: list[Any] = []
        self.commits = 0
        self.rollbacks = 0
        self.closed = 0

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1

    def close(self) -> None:
        self.closed += 1


# ── the row ────────────────────────────────────────────────────────────────

def test_a_row_indexes_by_name_and_by_position():
    """
    `sqlite3.Row` does both and this codebase uses both: `r["id"]` nearly
    everywhere, and `.fetchone()[0]` for every scalar `COUNT(*)`. psycopg's
    own row factories give you one or the other.
    """
    r = Row(("id", "sym"), (7, "BTCUSDT"))
    assert r["id"] == 7
    assert r["sym"] == "BTCUSDT"
    assert r[0] == 7
    assert r[1] == "BTCUSDT"


def test_a_row_is_still_a_dict():
    """Several handlers do `dict(r)` to build a JSON payload."""
    r = Row(("a", "b"), (1, 2))
    assert dict(r) == {"a": 1, "b": 2}
    assert sorted(r.keys()) == ["a", "b"]


# ── the connection ─────────────────────────────────────────────────────────

def test_execute_translates_the_sql_on_the_way_out():
    raw = FakeRaw()
    conn = _PgConnection(raw)
    conn.execute("SELECT v FROM kv WHERE k=?", ("x",))
    sql, params = raw.executed[0]
    assert sql == "SELECT v FROM kv WHERE k=%s"
    assert params == ("x",)


def test_an_upsert_is_translated_too():
    raw = FakeRaw()
    _PgConnection(raw).execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)", ("a", "b", 1.0))
    sql, _ = raw.executed[0]
    assert "ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t" in sql
    assert "?" not in sql


def test_no_params_passes_none_rather_than_an_empty_tuple():
    """psycopg treats `()` as "there are parameters" and then finds none."""
    raw = FakeRaw()
    _PgConnection(raw).execute("SELECT 1")
    assert raw.executed[0][1] is None


def test_execute_returns_something_you_can_chain_fetchone_onto():
    """Every call site is written `c.execute(...).fetchone()`."""
    raw = FakeRaw()
    raw.next_rows = [Row(("n",), (3,))]
    got = _PgConnection(raw).execute("SELECT COUNT(*) n FROM alerts").fetchone()
    assert got["n"] == 3
    assert got[0] == 3


def test_a_successful_block_commits():
    """
    `sqlite3`'s contract, which is what seventy-nine `with db() as c:` blocks
    were written against.
    """
    raw = FakeRaw()
    with _PgConnection(raw) as c:
        c.execute("INSERT INTO events(t,kind,msg) VALUES(?,?,?)", (1, "k", "m"))
    assert raw.commits == 1
    assert raw.rollbacks == 0


def test_a_failing_block_rolls_back_and_does_not_swallow():
    raw = FakeRaw()
    with pytest.raises(ValueError), _PgConnection(raw) as c:
        c.execute("INSERT INTO events(t,kind,msg) VALUES(?,?,?)", (1, "k", "m"))
        raise ValueError("boom")
    assert raw.rollbacks == 1
    assert raw.commits == 0


def test_executescript_runs_a_multi_statement_string():
    """`init()` uses it, once, for the whole schema."""
    raw = FakeRaw()
    _PgConnection(raw).executescript("CREATE TABLE a(x INT); CREATE TABLE b(y INT);")
    assert len(raw.executed) == 1
    assert "CREATE TABLE b" in raw.executed[0][0]


def test_rowcount_survives_the_wrapper():
    """
    `INSERT OR IGNORE INTO wallet_events ...` is followed by a rowcount check
    to decide whether the transfer was new. Postgres reports 0 on a conflict,
    same as SQLite, but only if the wrapper forwards it.
    """
    raw = FakeRaw()
    raw.next_rows = [Row(("x",), (1,))]
    cur = _PgConnection(raw).execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", ("k", 1))
    assert cur.rowcount == 1
