"""
The Postgres path, against a real Postgres.

SKIPPED unless `IRAM_DB_URL` is set, which on most machines it is not — and
that is the honest state of this migration: the translation and the adapter are
unit-tested on every run, and the round trip is tested only where a server
exists. A test that quietly passed by testing nothing would be worse than a
skip, so it says which one happened.

To run it:

    docker run -d --name iram-pg -e POSTGRES_PASSWORD=iram -p 5432:5432 postgres:16
    IRAM_DB_URL=postgresql://postgres:iram@127.0.0.1:5432/postgres python -m pytest tests/test_db_postgres_live.py -v

WHAT IT PROVES THAT THE UNIT TESTS CANNOT
That the translated DDL is accepted by a real server, that every conflict
target in `CONFLICT_KEYS` corresponds to a constraint that really exists, and
that `REAL -> DOUBLE PRECISION` actually preserves an epoch timestamp to the
second. The first two are rejected loudly by Postgres; the third is the one
that fails silently, so it is asserted on a value chosen to break a 4-byte
float.
"""

from __future__ import annotations

import os
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

URL = os.environ.get("IRAM_DB_URL", "").strip()

pytestmark = pytest.mark.skipif(
    not URL,
    reason="IRAM_DB_URL is not set, so there is no Postgres to talk to. "
    "The translation and the adapter are covered by test_db_rewrite.py and "
    "test_db_adapter.py on every run; this file is the round trip.",
)


@pytest.fixture(scope="module")
def conn():
    from db.driver import connect
    from db.schema import DDL
    from db.sqlrewrite import ddl_to_postgres

    raw = connect()
    # A clean slate, so a previous run cannot make this one pass.
    with raw as c:
        c.executescript(
            "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
            + ddl_to_postgres(DDL)
        )
    yield connect


def test_the_translated_schema_is_accepted(conn):
    """If the DDL were wrong, the fixture would have raised before this ran."""
    with conn() as c:
        n = c.execute(
            "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema='public'"
        ).fetchone()["n"]
    assert n >= 15, f"only {n} tables created"


def test_upsert_replaces_rather_than_duplicating(conn):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)", ("probe", "one", 1.0))
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)", ("probe", "two", 2.0))
    with conn() as c:
        rows = c.execute("SELECT v FROM kv WHERE k=?", ("probe",)).fetchall()
    assert len(rows) == 1, "the conflict target did not fire — this is the duplicate-row failure"
    assert rows[0]["v"] == "two"


def test_insert_or_ignore_keeps_the_first_write(conn):
    with conn() as c:
        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", ("dup", 1.0))
    with conn() as c:
        c.execute("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)", ("dup", 9.0))
    with conn() as c:
        rows = c.execute("SELECT t FROM onchain_seen WHERE k=?", ("dup",)).fetchall()
    assert len(rows) == 1
    assert rows[0]["t"] == 1.0


def test_a_surrogate_id_table_conflicts_on_its_natural_key(conn):
    """
    `wallet_events` has an autoincrement id and `hash TEXT UNIQUE`. Re-importing
    the same transfer must not insert it twice — which is only true if the
    conflict target is the hash and not the id.
    """
    args = ("0xabc", "ethereum", "0xhash", 1.0, "TOK", "SYM", "in", 5.0)
    for _ in range(2):
        with conn() as c:
            c.execute(
                "INSERT OR IGNORE INTO wallet_events(wallet,chain,hash,t,token,sym,direction,amount) "
                "VALUES(?,?,?,?,?,?,?,?)",
                args,
            )
    with conn() as c:
        n = c.execute("SELECT COUNT(*) n FROM wallet_events WHERE hash=?", ("0xhash",)).fetchone()["n"]
    assert n == 1


def test_an_epoch_timestamp_survives_the_round_trip(conn):
    """
    THE ONE THAT FAILS SILENTLY.

    Postgres REAL is a 4-byte float with about seven significant digits. An
    epoch second is ten. Had `REAL` not been translated to DOUBLE PRECISION,
    this value would come back rounded by minutes and nothing would raise.
    """
    now = float(int(time.time())) + 0.25
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)", ("clock", "x", now))
    with conn() as c:
        got = c.execute("SELECT t FROM kv WHERE k=?", ("clock",)).fetchone()["t"]
    assert got == pytest.approx(now, abs=1e-6), f"timestamp lost precision: {now} -> {got}"


def test_rows_index_by_name_and_position(conn):
    with conn() as c:
        row = c.execute("SELECT 1 AS a, 2 AS b").fetchone()
    assert row["a"] == 1
    assert row[1] == 2
    assert dict(row) == {"a": 1, "b": 2}


def test_a_percent_inside_a_literal_does_not_raise(conn):
    """The `LIKE 'data_%'` query in mishel_service.py, end to end."""
    with conn() as c:
        c.execute("INSERT INTO events(t,kind,msg) VALUES(?,?,?)", (1.0, "data_binance", "hi"))
    with conn() as c:
        rows = c.execute(
            "SELECT kind, MAX(t) mt FROM events WHERE kind LIKE 'data_%' GROUP BY kind"
        ).fetchall()
    assert any(r["kind"] == "data_binance" for r in rows)


def test_a_failed_block_rolls_back(conn):
    with pytest.raises(ValueError), conn() as c:
        c.execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)", ("rb", "written", 1.0))
        raise ValueError("boom")
    with conn() as c:
        rows = c.execute("SELECT v FROM kv WHERE k=?", ("rb",)).fetchall()
    assert rows == [], "the transaction committed despite the exception"
