"""
The SQLite -> Postgres translation, which is the whole risk of the migration.

Seventy-nine query sites keep writing SQLite's dialect and one module turns it
into the other one. If that module is wrong, the failure is not a crash on
line one — it is a wrong CONFLICT TARGET inserting duplicates where an upsert
was meant, or a `REAL` column silently rounding every timestamp in the
database. Neither raises. Both are found months later.

So this file checks the translation itself, and then checks the translation
against the REAL schema and the REAL call sites in `mishel_service.py`, so that
a table added next year without a primary-key entry fails here rather than in
production.

A pytest module, run by `verify.py`. It touches no database and needs no
Postgres: the translation is a pure function.
"""

from __future__ import annotations

import glob
import os
import re
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
if SERVER not in sys.path:
    sys.path.insert(0, SERVER)

from db.schema import DDL
from db.sqlrewrite import (
    CONFLICT_KEYS,
    UnknownTable,
    ddl_to_postgres,
    qmark_to_format,
    rewrite_upsert,
    to_postgres,
)

# ── placeholders ───────────────────────────────────────────────────────────

def test_qmark_becomes_format():
    assert qmark_to_format("SELECT v FROM kv WHERE k=?") == "SELECT v FROM kv WHERE k=%s"


def test_every_placeholder_is_converted():
    sql = "INSERT INTO ohlc_cache(sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)"
    assert qmark_to_format(sql).count("%s") == 8
    assert "?" not in qmark_to_format(sql)


def test_a_question_mark_inside_a_string_is_left_alone():
    """A literal is data. Converting it would change what gets stored."""
    sql = "INSERT INTO events(t,kind,msg) VALUES(?,?,'really?')"
    out = qmark_to_format(sql)
    assert out.endswith("VALUES(%s,%s,'really?')")
    assert out.count("%s") == 2


def test_doubled_quotes_do_not_end_the_literal():
    sql = "SELECT * FROM events WHERE msg='it''s ok?' AND kind=?"
    out = qmark_to_format(sql)
    assert "'it''s ok?'" in out
    assert out.count("%s") == 1


def test_percent_is_doubled_even_inside_a_literal():
    """
    THE ONE THAT BITES SILENTLY.

    psycopg's format paramstyle scans the entire statement for `%`, quoted or
    not. This exact query is in `mishel_service.py` and would raise at execute
    time on a route nobody runs often.
    """
    sql = "SELECT kind, MAX(t) mt FROM events WHERE kind LIKE 'data_%' GROUP BY kind"
    assert "LIKE 'data_%%'" in qmark_to_format(sql)


def test_percent_doubling_happens_before_placeholders():
    """Otherwise the `%` of a freshly-made `%s` would itself be doubled."""
    assert qmark_to_format("SELECT ? WHERE k LIKE '%x'") == "SELECT %s WHERE k LIKE '%%x'"


# ── upserts ────────────────────────────────────────────────────────────────

def test_insert_or_ignore_becomes_do_nothing():
    out = rewrite_upsert("INSERT OR IGNORE INTO onchain_seen(k,t) VALUES(?,?)")
    assert out.startswith("INSERT INTO onchain_seen(k,t)")
    assert out.rstrip().endswith("ON CONFLICT DO NOTHING")
    assert "OR IGNORE" not in out


def test_insert_or_replace_updates_every_non_key_column():
    out = rewrite_upsert("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)")
    assert "ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t" in out
    assert "k=excluded.k" not in out  # the key is not updated


def test_a_composite_key_names_every_column():
    out = rewrite_upsert("INSERT OR REPLACE INTO ohlc_cache(sym,tf,t,o,h,l,c,v) VALUES(?,?,?,?,?,?,?,?)")
    assert "ON CONFLICT(sym, tf, t) DO UPDATE SET" in out
    for col in ("o", "h", "l", "c", "v"):
        assert f"{col}=excluded.{col}" in out


def test_an_all_key_insert_has_nothing_to_update():
    """`onchain_seen` is (k PRIMARY KEY, t); an upsert of k alone updates nothing."""
    out = rewrite_upsert("INSERT OR REPLACE INTO onchain_seen(k) VALUES(?)")
    assert out.rstrip().endswith("ON CONFLICT DO NOTHING")


def test_an_unknown_table_raises_rather_than_guessing():
    """
    A guessed conflict target does not fail — it inserts duplicates where an
    upsert was meant. Refusing is the only safe behaviour.
    """
    with pytest.raises(UnknownTable) as e:
        rewrite_upsert("INSERT OR REPLACE INTO not_a_table(a,b) VALUES(?,?)")
    assert "CONFLICT_KEYS" in str(e.value)


def test_an_ordinary_insert_is_untouched():
    sql = "INSERT INTO events(t,kind,msg) VALUES(?,?,?)"
    assert rewrite_upsert(sql) == sql


def test_to_postgres_does_both():
    out = to_postgres("INSERT OR REPLACE INTO kv(k,v,t) VALUES(?,?,?)")
    assert "%s" in out and "ON CONFLICT(k)" in out and "?" not in out


# ── the schema ─────────────────────────────────────────────────────────────

def test_real_becomes_double_precision():
    """
    SQLite REAL is an 8-byte double; Postgres REAL is a 4-byte single with
    about seven significant digits — not enough to hold an epoch timestamp to
    the second. Every `t REAL` in this schema would round, and nothing would
    fail.
    """
    assert "DOUBLE PRECISION" in ddl_to_postgres("CREATE TABLE x(t REAL)")
    assert "REAL" not in ddl_to_postgres("CREATE TABLE x(t REAL)")


def test_autoincrement_becomes_bigserial():
    out = ddl_to_postgres("CREATE TABLE x(id INTEGER PRIMARY KEY AUTOINCREMENT, a INTEGER)")
    assert "id BIGSERIAL PRIMARY KEY" in out
    assert "AUTOINCREMENT" not in out
    # the bare INTEGER still converts, and the key one was not double-rewritten
    assert "a BIGINT" in out
    assert "BIGSERIAL PRIMARY KEY BIGINT" not in out


def test_the_whole_real_schema_translates():
    out = ddl_to_postgres(DDL)
    for banned in ("AUTOINCREMENT", " REAL", "INTEGER"):
        assert banned not in out, f"{banned!r} survived the DDL translation"
    assert out.count("CREATE TABLE IF NOT EXISTS") == DDL.count("CREATE TABLE IF NOT EXISTS")


# ── the map against reality ────────────────────────────────────────────────

def _declared_keys(ddl: str) -> dict[str, tuple[str, ...]]:
    """Primary keys as the DDL actually declares them."""
    out: dict[str, tuple[str, ...]] = {}
    for m in re.finditer(r"CREATE TABLE IF NOT EXISTS (\w+)\((.*?)\);", ddl, re.DOTALL):
        table, body = m.group(1), m.group(2)
        tail = re.search(r"PRIMARY\s+KEY\s*\(([^)]*)\)", body, re.IGNORECASE)
        if tail:
            out[table] = tuple(c.strip() for c in tail.group(1).split(","))
            continue
        col = re.search(r"(\w+)\s+[\w ]*?PRIMARY\s+KEY", body, re.IGNORECASE)
        if col:
            out[table] = (col.group(1),)
    return out


def _unique_columns(ddl: str, table: str) -> set[str]:
    """
    Columns carrying a UNIQUE constraint, column-level or table-level.

    Both forms appear in this schema — `hash TEXT UNIQUE` on `wallet_events`
    and `UNIQUE(sym, tf, strategy)` on `sig_watch` — and a conflict target may
    legally name either. Missing one of the two forms made this helper return
    nothing and the check below fail on a table that was perfectly correct.
    """
    m = re.search(r"CREATE TABLE IF NOT EXISTS " + table + r"\((.*?)\);", ddl, re.DOTALL)
    if not m:
        return set()
    body = m.group(1)
    cols = {c.group(1) for c in re.finditer(r"(\w+)\s+\w+\s+UNIQUE\b", body, re.IGNORECASE)}
    for u in re.finditer(r"\bUNIQUE\s*\(([^)]*)\)", body, re.IGNORECASE):
        cols.update(c.strip() for c in u.group(1).split(","))
    return cols


def test_every_conflict_key_is_a_real_constraint():
    """
    The map and the schema are two copies of one fact, and this is the test
    that stops them drifting. A conflict target that is not backed by a unique
    constraint is rejected by Postgres at execute time; one that names the
    WRONG constraint is worse, because it never fires and inserts a duplicate
    per attempt.

    The target must be either the declared primary key or a declared UNIQUE —
    both are legal, and for a table with a surrogate id the unique one is the
    only target that can ever conflict.
    """
    declared = _declared_keys(DDL)
    for table, key in CONFLICT_KEYS.items():
        pk = declared.get(table)
        uniques = _unique_columns(DDL, table)
        ok = (pk is not None and tuple(key) == pk) or set(key) <= uniques
        assert ok, (
            f"{table}: conflict target {key} is neither the primary key {pk} "
            f"nor a unique constraint {sorted(uniques) or None}"
        )


def test_a_surrogate_id_is_never_the_conflict_target():
    """
    `onchain_watch` and `wallet_events` both have an autoincrement id AND a
    natural unique key. The id is freshly generated on every insert and can
    never collide, so an upsert targeting it would never fire.
    """
    declared = _declared_keys(DDL)
    for table in ("onchain_watch", "wallet_events"):
        assert declared.get(table) == ("id",), f"{table} is expected to have a surrogate id"
        assert CONFLICT_KEYS[table] != ("id",)


def test_every_upserted_table_has_a_key_declared():
    """
    Every `INSERT OR REPLACE` in the service names a table this module can
    translate. A new one added without a key entry fails here, at build time,
    rather than at the first conflict in production.
    """
    # The facade AND every section split out of it into server/svc/. Reading
    # only the facade would pass more easily with every section moved, which
    # is coverage leaving without anything failing.
    paths = [os.path.join(SERVER, "mishel_service.py")] + sorted(
        glob.glob(os.path.join(SERVER, "svc", "*.py"))
    )
    svc = "".join(open(p, encoding="utf-8").read() for p in paths)  # noqa: SIM115
    tables = set(re.findall(r"INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)", svc, re.IGNORECASE))
    assert tables, "no INSERT OR REPLACE found — did the service move?"
    missing = sorted(t for t in tables if t not in CONFLICT_KEYS)
    assert not missing, f"no primary key declared for: {missing}"


def test_unique_only_tables_are_keyed_by_their_unique_column():
    """
    `wallet_events` has an autoincrement id AND `hash TEXT UNIQUE`, and the
    conflict that actually happens is on the hash — that is the whole reason
    the column is unique. The map has to say `hash`, not `id`, or re-importing
    the same transfer inserts it twice.
    """
    assert CONFLICT_KEYS["wallet_events"] == ("hash",)
    assert "hash TEXT UNIQUE" in DDL
