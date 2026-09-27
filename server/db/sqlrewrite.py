"""
Translate the SQL this codebase already writes into the dialect in use.

WHY A REWRITER AND NOT A REWRITE
There are seventy-nine query sites in `mishel_service.py` and they are written
in SQLite's dialect: `?` placeholders, `INSERT OR REPLACE`, `INSERT OR IGNORE`.
Editing all seventy-nine to be Postgres-shaped would be a diff nobody can
review, would have to be done again for the next backend, and would break every
one of them for SQLite — which stays the default, because the product is a
single executable that needs no install.

So the dialect difference is absorbed in ONE place. Call sites keep writing the
SQLite dialect; this turns it into whatever the connection actually speaks. The
translation is pure, it is unit-tested, and it is the only file that has to be
read to know what the two dialects disagree about.

WHAT WAS SURVEYED BEFORE ANY OF THIS WAS WRITTEN
Counted across `mishel_service.py`, rather than assumed:

    INSERT OR REPLACE   5      AUTOINCREMENT   7      executescript   1
    INSERT OR IGNORE    7      PRAGMA          0      executemany     0
    ?  placeholders   151      lastrowid       0      ROWID           0

and three `strftime` calls, ALL of which are Python's `time.strftime` and none
of which are SQL. The date-function problem that a migration like this usually
runs into does not exist here, and knowing that cost one grep.

THE ONE THAT BITES SILENTLY
`psycopg` uses `format` paramstyle, so a literal `%` in the SQL is a format
specifier. There is exactly one in this codebase —

    SELECT kind, MAX(t) mt FROM events WHERE kind LIKE 'data_%' GROUP BY kind

— and untranslated it raises at execute time on a route nobody exercises often.
Every `%` is doubled before `?` becomes `%s`, in that order, because doing it
the other way round would double the `%` that was just introduced.
"""

from __future__ import annotations

import re

#: The CONFLICT TARGET per table — which is not always the primary key.
#:
#: Postgres needs to be told which constraint an upsert conflicts on; SQLite
#: infers it from whichever unique constraint the row actually violates. That
#: inference is the whole reason this map exists, and it is also why the name
#: `PRIMARY_KEYS` was wrong and got changed: for a table with a SURROGATE id,
#: the conflict that really happens is on the natural key.
#:
#:     onchain_watch(id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT UNIQUE)
#:
#: Re-adding a wallet conflicts on `wallet`, never on `id` — the id is freshly
#: generated every time and cannot collide. Targeting the primary key there
#: would produce an upsert that never fires, inserting a duplicate row per
#: attempt. `wallet_events` has the same shape, keyed on `hash`.
#:
#: A table missing from this map raises rather than guessing. A guessed
#: conflict target does not fail; it silently inserts duplicates.
CONFLICT_KEYS: dict[str, tuple[str, ...]] = {
    "config": ("k",),
    "kv": ("k",),
    "kvstore": ("k",),
    "risk_cfg": ("k",),
    "onchain_seen": ("k",),
    "db_wallets": ("wallet",),
    "ohlc_cache": ("sym", "tf", "t"),
    "sig_fired": ("sym", "tf", "strategy", "bar_t"),
    "sig_watch": ("sym", "tf", "strategy"),
    "mt5_deals": ("ticket",),
    "mt5_specs": ("symbol",),
    "terminal_sync": ("k",),
    "wallet_events": ("hash",),
    "onchain_watch": ("wallet",),
    # Surrogate-free: the natural key IS (sym, tf), one row per series.
    "auto_runs": ("sym", "tf"),
}


class UnknownTable(Exception):
    """An upsert was asked for on a table whose key this module does not know."""


def _split_literals(sql: str) -> list[tuple[str, bool]]:
    """
    Cut `sql` into (chunk, is_string_literal) runs.

    Placeholders are only placeholders OUTSIDE a quoted string, and this is the
    only reason the rewriter is not a `str.replace`. SQL escapes a quote by
    doubling it, so `'it''s'` is one literal and the scanner has to know that.
    """
    out: list[tuple[str, bool]] = []
    i = 0
    n = len(sql)
    buf = []
    while i < n:
        ch = sql[i]
        if ch in ("'", '"'):
            if buf:
                out.append(("".join(buf), False))
                buf = []
            quote = ch
            j = i + 1
            while j < n:
                if sql[j] == quote:
                    if j + 1 < n and sql[j + 1] == quote:  # doubled = escaped
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append((sql[i:j], True))
            i = j
            continue
        buf.append(ch)
        i += 1
    if buf:
        out.append(("".join(buf), False))
    return out


def qmark_to_format(sql: str) -> str:
    """
    `?` -> `%s`, and every literal `%` doubled, for psycopg's format paramstyle.

    Both transformations respect string literals for the `?`, and deliberately
    do NOT for the `%`: psycopg scans the whole statement for format specifiers,
    including inside quotes, so `LIKE 'data_%'` has to become `LIKE 'data_%%'`
    or it raises. Getting that backwards is the failure this docstring exists
    to prevent.
    """
    doubled = sql.replace("%", "%%")
    parts = _split_literals(doubled)
    return "".join(chunk if is_lit else chunk.replace("?", "%s") for chunk, is_lit in parts)


_INSERT_RE = re.compile(
    r"^\s*INSERT\s+OR\s+(REPLACE|IGNORE)\s+INTO\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)",
    re.IGNORECASE | re.DOTALL,
)


def rewrite_upsert(sql: str) -> str:
    """
    Turn SQLite's `INSERT OR REPLACE|IGNORE` into Postgres' `ON CONFLICT`.

    REPLACE becomes `DO UPDATE SET col=excluded.col` for every non-key column,
    which is what SQLite's REPLACE means in the cases this codebase uses it —
    all five name their columns explicitly, so there is no ambiguity about
    which ones are being overwritten.

    NOT the same thing as SQLite's REPLACE in general: SQLite DELETEs the
    conflicting row and inserts a new one, so columns absent from the statement
    revert to their defaults, while `DO UPDATE` leaves them alone. Every call
    site here lists every column, so the two agree. A future one that does not
    would differ, which is why this note is here and not in a commit message.
    """
    m = _INSERT_RE.match(sql)
    if not m:
        return sql
    kind, table, cols_raw = m.group(1).upper(), m.group(2), m.group(3)
    cols = [c.strip() for c in cols_raw.split(",") if c.strip()]
    body = sql[m.end() :]
    head = f"INSERT INTO {table}({cols_raw})"

    if kind == "IGNORE":
        return f"{head}{body} ON CONFLICT DO NOTHING"

    key = CONFLICT_KEYS.get(table)
    if key is None:
        raise UnknownTable(
            f"INSERT OR REPLACE INTO {table} cannot be translated: the primary key "
            f"is not declared in sqlrewrite.CONFLICT_KEYS. Add it there rather than "
            f"letting the rewriter guess — a wrong conflict target does not fail, "
            f"it silently inserts duplicates."
        )
    updates = [c for c in cols if c.lower() not in {k.lower() for k in key}]
    if not updates:
        # Every column is part of the key: there is nothing to update, and the
        # row either exists identically or does not exist.
        return f"{head}{body} ON CONFLICT DO NOTHING"
    setters = ", ".join(f"{c}=excluded.{c}" for c in updates)
    return f"{head}{body} ON CONFLICT({', '.join(key)}) DO UPDATE SET {setters}"


def to_postgres(sql: str) -> str:
    """Everything the Postgres driver needs done to a statement written for SQLite."""
    return qmark_to_format(rewrite_upsert(sql))


#: SQLite type / clause -> Postgres equivalent, applied to DDL only.
#:
#: Ordered, because `INTEGER PRIMARY KEY AUTOINCREMENT` has to be matched as a
#: whole before anything gets a chance to rewrite the bare `INTEGER` in it.
_DDL_SUBS: tuple[tuple[str, str], ...] = (
    (r"\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b", "BIGSERIAL PRIMARY KEY"),
    (r"\bREAL\b", "DOUBLE PRECISION"),
    (r"\bINTEGER\b", "BIGINT"),
)


def ddl_to_postgres(ddl: str) -> str:
    """
    Translate the schema, which is the one place the TYPES differ.

    `REAL` in SQLite is an 8-byte IEEE double; `REAL` in Postgres is a 4-byte
    single. Left alone, every timestamp and every price in this schema would
    quietly lose precision — a `t REAL` holding epoch seconds has about seven
    significant digits in Postgres, which cannot even represent the current
    year to the second. That one substitution is the difference between a
    working migration and a database of rounded timestamps.
    """
    out = ddl
    for pattern, repl in _DDL_SUBS:
        out = re.sub(pattern, repl, out, flags=re.IGNORECASE)
    return out
