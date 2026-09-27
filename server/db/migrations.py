"""
Additive schema migrations.

`db/schema.py` `init()` creates anything missing and says where changes belong:
"Schema CHANGES go through `migrate()`, which is versioned and additive — never
destructive, because the accumulated ledger is the one thing in this database
that cannot be recomputed."

This is the first one, and it exists because the operator switches between their
broker's DEMO and LIVE accounts on purpose — to test a strategy without losing
money. `mt5_deals` recorded `src` ("bridge" or "report") and nothing about the
account, so both sync into one table indistinguishably, and `/svc/costs` then
measures this broker's real spread from the mixture. A demo fill has no queue
position, no partial fills and no requote; its slippage is whatever the
simulator felt like. That makes the cost model confidently wrong in the CHEAP
direction, and a cost model is a hurdle.

TWO DIALECTS, ONE HELPER. `driver.py` supports SQLite and PostgreSQL, and they
disagree about almost everything here: SQLite lists columns through
`PRAGMA table_info` and has no `ADD COLUMN IF NOT EXISTS`; Postgres uses
`information_schema` and does. Asking what exists and then adding only what is
missing is the one approach that is correct in both and idempotent in both.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

#: Columns added to `mt5_deals`, in the order they are added.
#:
#: NO DEFAULT AND NO BACKFILL, deliberately. Rows already stored came from an
#: account nobody recorded: writing "live" would promote every demo fill the
#: operator has ever synced into the real cost measurement, and writing "demo"
#: would throw away real history. Neither is known, so neither is claimed — they
#: stay NULL, and every reader treats that as `unknown`.
DEAL_ACCOUNT_COLUMNS: tuple[tuple[str, str], ...] = (
    ("login", "INTEGER"),
    ("account_kind", "TEXT"),
)


def existing_columns(conn: Any, table: str) -> set[str]:
    """Column names of `table`, or an empty set when it does not exist."""
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        if rows:
            # sqlite3.Row supports both; a bare tuple is (cid, name, ...).
            return {(r["name"] if not isinstance(r, tuple) else r[1]) for r in rows}
    except Exception:
        pass
    try:
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name=%s",
            (table,),
        ).fetchall()
        return {(r[0] if isinstance(r, tuple) else r["column_name"]) for r in rows}
    except Exception:
        return set()


def add_missing_columns(
    conn: Any, table: str, columns: Iterable[tuple[str, str]]
) -> list[str]:
    """Add each column that is not already there. Returns the names it added.

    IDEMPOTENT, because `init()` and `migrate()` run on EVERY start — a migration
    that only works once is one that crashes the service on the second boot.

    IT REPORTS WHAT IT DID rather than running silently: a schema change nobody
    can audit after the fact is one nobody can explain when a column turns out to
    be full of nulls.

    A MISSING TABLE IS NOT AN ERROR. `init()` creates tables and this alters
    them, and depending on the order between a fresh install and an upgrade is
    the kind of coupling that breaks one of the two.
    """
    have = existing_columns(conn, table)
    if not have:
        return []
    added: list[str] = []
    for name, sql_type in columns:
        if name in have:
            continue
        try:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {sql_type}")
            added.append(name)
        except Exception:
            # Another process won the race, or the dialect refused. Either way
            # the next call re-reads the real column list rather than assuming.
            continue
    if added:
        try:
            conn.commit()
        except Exception:
            pass
    return added


def run(conn: Any) -> dict[str, list[str]]:
    """Every additive migration, in order. Safe to call on every start."""
    return {"mt5_deals": add_missing_columns(conn, "mt5_deals", DEAL_ACCOUNT_COLUMNS)}
