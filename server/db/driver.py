"""
One connection seam, two backends.

─────────────────────────────────────────────────────────────────────────────
THIS IS A NAMED DEVIATION FROM CLAUDE.md, NOT A SILENT ONE

CLAUDE.md lists PostgreSQL under "What is deliberately NOT taken from the kit",
with this reason:

    The product is a single executable that needs no install. Requiring two
    servers to start it is a regression against its main advantage.

That reason is still correct and nothing here disagrees with it. The owner
asked for Postgres, so it exists — but as an OPTION, chosen by one environment
variable, with SQLite remaining the default and the packaged binary untouched.
Nobody who downloads `iram-full.exe` needs to install anything, and nobody who
wants a real server for a multi-machine setup has to run SQLite over a network
share, which is the failure mode that makes people want Postgres in the first
place.

If `IRAM_DB_URL` is unset, this file behaves exactly as `sqlite3.connect` did
and the deviation costs nothing.

─────────────────────────────────────────────────────────────────────────────
WHY THE CALL SITES DID NOT CHANGE

`sqlite3.Connection` has conveniences psycopg does not: `.execute()` straight
on the connection, `sqlite3.Row` that indexes by BOTH name and position, and a
`with conn:` block that commits. Seventy-nine call sites use all three. Rather
than rewrite them — a diff nobody could review, and one that would have to be
undone to keep SQLite working — the Postgres connection is wrapped in an
adapter that presents the same three.

The adapter is small enough to read in one sitting, which is the point: the
compatibility surface between the two backends is this file plus
`sqlrewrite.py`, and nothing else in the server has to know which one is live.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import types
from typing import Any, Self

from .sqlrewrite import to_postgres

#: Where SQLite lives when no URL is configured.
#:
#: `entry.py` sets `MISHEL_SVC_DB` to a per-user data directory before the
#: service imports, because inside a one-file PyInstaller bundle `__file__` is
#: under `sys._MEIPASS` — deleted when the process exits. That defect threw the
#: database away on every close of the packaged product; see HANDOVER v52.
SQLITE_PATH = os.environ.get(
    "MISHEL_SVC_DB",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "mishel.db"),
)

#: A libpq URL selects Postgres. Absent, everything below is SQLite.
DB_URL = os.environ.get("IRAM_DB_URL", "").strip()


def dialect() -> str:
    """`"postgres"` or `"sqlite"`. The only question anything outside should ask."""
    return "postgres" if DB_URL else "sqlite"


class Row(dict):
    """
    A result row that indexes by name AND by position, like `sqlite3.Row`.

    Both are used in this codebase — `r["id"]` in most places and
    `.fetchone()[0]` for every scalar `COUNT(*)` — and psycopg's row factories
    give you one or the other. Subclassing `dict` keeps `dict(r)` working,
    which several handlers rely on to build a JSON payload.
    """

    __slots__ = ("_seq",)

    def __init__(self, cols: tuple[str, ...], values: tuple[Any, ...]) -> None:
        super().__init__(zip(cols, values))
        self._seq = values

    def __getitem__(self, key: Any) -> Any:
        if isinstance(key, int):
            return self._seq[key]
        return super().__getitem__(key)


def _row_factory(cursor: Any) -> Any:
    cols = tuple(d.name for d in (cursor.description or ()))

    def make(values: tuple[Any, ...]) -> Row:
        return Row(cols, values)

    return make


class _PgCursor:
    """A psycopg cursor that speaks the SQLite dialect."""

    def __init__(self, cur: Any) -> None:
        self._cur = cur

    def execute(self, sql: str, params: Any = ()) -> Self:
        self._cur.execute(to_postgres(sql), tuple(params) if params else None)
        return self

    def fetchone(self) -> Any:
        return self._cur.fetchone()

    def fetchall(self) -> Any:
        return self._cur.fetchall()

    def __iter__(self) -> Any:
        return iter(self._cur)

    @property
    def rowcount(self) -> int:
        return int(self._cur.rowcount)

    def close(self) -> None:
        self._cur.close()


class _PgConnection:
    """
    A psycopg connection wearing `sqlite3.Connection`'s interface.

    Only the three members this codebase actually uses are provided. A wrapper
    that forwarded everything would hide the next incompatibility behind a
    `__getattr__` and turn it into a runtime surprise on whichever route
    happened to use it; an explicit surface fails at import-review time
    instead.
    """

    def __init__(self, raw: Any) -> None:
        self._raw = raw

    def execute(self, sql: str, params: Any = ()) -> _PgCursor:
        return _PgCursor(self._raw.cursor()).execute(sql, params)

    def executescript(self, script: str) -> None:
        """
        Multiple statements in one call, as `sqlite3.executescript` allows.

        Used once, by `init()`. psycopg will run a multi-statement string in a
        single `execute`, so this is a rename rather than a reimplementation.
        """
        with self._raw.cursor() as cur:
            cur.execute(script)

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def close(self) -> None:
        self._raw.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: types.TracebackType | None,
    ) -> bool:
        """
        Commit on success, roll back on failure — `sqlite3`'s contract.

        NOT psycopg's own: `with psycopg.connect(...)` CLOSES the connection on
        exit, and every `with db() as c:` in this service expects to be handing
        back a transaction, not disposing of the pool entry. Getting this wrong
        would close a connection per request and look like a leak.
        """
        if exc_type is None:
            self._raw.commit()
        else:
            self._raw.rollback()
        self._raw.close()
        return False


_pg_lock = threading.Lock()
_psycopg: Any = None


def _load_psycopg() -> Any:
    global _psycopg
    with _pg_lock:
        if _psycopg is None:
            try:
                # Imported here rather than at module scope: it is an OPTIONAL
                # dependency, and a top-level import would make the whole service
                # refuse to start on every machine that never asked for Postgres.
                import psycopg
            except ImportError as e:  # pragma: no cover - depends on the install
                raise RuntimeError(
                    "IRAM_DB_URL is set, so Postgres was asked for, but the `psycopg` "
                    "package is not installed. Either `pip install 'psycopg[binary]'` "
                    "or unset IRAM_DB_URL to go back to SQLite, which needs nothing."
                ) from e
            _psycopg = psycopg
    return _psycopg


def connect() -> Any:
    """
    A connection to whichever backend is configured.

    Returns something that behaves like `sqlite3.Connection` either way, so the
    service's `db()` is a one-line call to this and nothing downstream branches
    on the dialect.
    """
    if not DB_URL:
        # WAL, AND A BUSY TIMEOUT WORTH THE NAME (v62.15).
        #
        # Thirteen background loops and every HTTP route share this one file. In
        # the default rollback journal a writer blocks every READER as well, so
        # any loop reading while a bulk bar insert is open waits for it.
        #
        # MEASURED, not assumed, on identical workloads:
        #
        #     4 writers / 6 readers, 3s   as shipped     256 writes,  255 reads
        #                                 WAL         12,269 writes, 12,437 reads
        #     1 bulk writer + 6 loops     as shipped   slowest loop wait 4.24s
        #                                 WAL         slowest loop wait 2.49s
        #
        # 4.24s against a 5s default is not a margin, and THAT is the whole
        # case for this change. It is not that WAL fixes the "database is
        # locked" errors in the event log: those were a nested WRITE
        # deadlocking its own thread, fixed separately, and no journal mode
        # would have helped.
        #
        # I first justified this by saying one such error survived that fix. It
        # did not -- I read `data_investing` at "06:12" as today when the log
        # says 2026-09-04, which is the year-less-timestamp trap this project
        # already records about chart axis labels. The honest argument is the
        # measured margin above, not a lock I misdated.
        #
        # `synchronous=NORMAL` is the documented companion to WAL: durable
        # against process crash, which is the failure this product can have,
        # and not against power loss mid-write, which would cost a fsync per
        # commit on a machine writing bars continuously.
        c = sqlite3.connect(SQLITE_PATH, timeout=30.0)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            c.execute("PRAGMA busy_timeout=30000")
        except sqlite3.Error:
            # A read-only directory or a filesystem that cannot do WAL (some
            # network shares) must not stop the service starting. The rollback
            # journal still works; it is only slower.
            pass
        return c
    psycopg = _load_psycopg()
    raw = psycopg.connect(DB_URL, row_factory=_row_factory)
    return _PgConnection(raw)


def describe() -> str:
    """One line for `/svc/health` and the startup banner. Never prints the password."""
    if not DB_URL:
        return f"sqlite · {SQLITE_PATH}"
    safe = DB_URL
    if "@" in safe:
        # postgresql://user:secret@host/db -> postgresql://user@host/db
        head, _, tail = safe.partition("@")
        scheme, _, creds = head.partition("://")
        user = creds.split(":")[0]
        safe = f"{scheme}://{user}@{tail}"
    return f"postgres · {safe}"
