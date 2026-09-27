# `server/db/` — the database seam

Four files, 566 lines. Read this instead of the code when you just need to
*use* it.

```
__init__.py    the import:  from db import db, init, dialect, describe
driver.py      which backend, and the psycopg-as-sqlite3 adapter
schema.py      the DDL (SQLite dialect), translated on the way out
sqlrewrite.py  what the two dialects disagree about — the whole surface
```

## Which database am I on?

SQLite, unless `IRAM_DB_URL` is set.

```bash
# default — a file, no install, what the packaged .exe ships with
python run.py

# Postgres
IRAM_DB_URL=postgresql://user:pass@host:5432/iram python run.py
```

`GET /svc/health` reports it as `"database"`, with any password stripped.

## Why SQLite is still the default

`CLAUDE.md` rejected PostgreSQL because the product is a single executable that
needs no install, and requiring a server to start it is a regression against
its main advantage. That is still true, so Postgres is an **option**, not a
replacement. The full argument is at the top of `driver.py`.

Use Postgres when more than one machine shares the data, or when you want real
backups and concurrent writers. Stay on SQLite for a single desktop.

## Adding a query

Write it in **SQLite's dialect** — `?` placeholders, `INSERT OR REPLACE`,
`INSERT OR IGNORE`. `sqlrewrite.py` translates it. That is the whole point of
the seam: seventy-nine existing call sites did not change when Postgres was
added, and the eightieth should not have to either.

```python
from db import db

with db() as c:                                   # commits on exit, rolls back on raise
    row = c.execute("SELECT v FROM kv WHERE k=?", ("x",)).fetchone()
    print(row["v"], row[0])                       # by name AND by position
```

## Adding a table

1. Add the `CREATE TABLE IF NOT EXISTS` to `DDL` in `schema.py`, in SQLite's
   dialect.
2. If anything will `INSERT OR REPLACE` into it, add its **conflict target** to
   `CONFLICT_KEYS` in `sqlrewrite.py`.

Step 2 is not optional and the gate enforces it. `test_db_rewrite.py` fails if
an upserted table has no entry, and fails again if the entry does not match a
real constraint in the DDL.

**The conflict target is not always the primary key.** A table with a surrogate
`id INTEGER PRIMARY KEY AUTOINCREMENT` and a natural `UNIQUE` column conflicts
on the *unique* one — a fresh id can never collide, so an upsert aimed at it
never fires and inserts a duplicate per attempt, silently. `onchain_watch` and
`wallet_events` are both this shape.

## The two things that fail silently

**`REAL` is not `REAL`.** SQLite's is an 8-byte double; Postgres' is a 4-byte
single with ~7 significant digits. Every timestamp here is `t REAL` holding
epoch seconds, which needs 10. `ddl_to_postgres` maps it to `DOUBLE PRECISION`.
Without that, every timestamp and price rounds and nothing raises.

**`%` is a format specifier.** psycopg scans the whole statement, quoted or
not. `LIKE 'data_%'` must become `LIKE 'data_%%'`. Handled — and the doubling
happens *before* `?` becomes `%s`, or it would double the `%` it just made.

## Testing

Two suites run on every `python verify.py`:

- `tests/test_db_rewrite.py` — the translation, plus the map checked against
  the real schema and the real call sites.
- `tests/test_db_adapter.py` — the psycopg wrapper against a stub: SQL out,
  row indexing, commit on success, rollback on raise.

The round trip needs a real server and **skips** without one:

```bash
docker run -d --name iram-pg -e POSTGRES_PASSWORD=iram -p 5432:5432 postgres:16
IRAM_DB_URL=postgresql://postgres:iram@127.0.0.1:5432/postgres \
  python -m pytest tests/test_db_postgres_live.py -v
```

That file proves what the unit tests cannot: the translated DDL is accepted,
every conflict target names a constraint that exists, and an epoch timestamp
survives the type change. **It has not yet been run on this machine** — Docker
is installed here but its daemon was not running when the seam was built.

## Migrating existing data

There is no automated SQLite→Postgres copy. `init()` creates an empty schema;
moving rows is a one-off you should do deliberately, not something a service
should attempt on boot. The tables are small and flat — `pgloader`, or a short
script reading each table through `db()` on one URL and writing through another,
will do it.
