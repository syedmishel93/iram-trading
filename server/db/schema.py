"""
The schema, in one place, in SQLite's dialect.

WRITTEN ONCE, TRANSLATED ON THE WAY OUT
The DDL below is exactly the text that used to live inside `init()` in
`mishel_service.py` — moved, not retyped, so the diff is a move. It is kept in
SQLite's dialect because SQLite is still the default and because having one
authoritative schema beats having two that drift; `ddl_to_postgres` turns it
into the other dialect when one is configured.

THE SUBSTITUTION THAT MATTERS
`REAL` means an 8-byte double in SQLite and a 4-byte single in Postgres. Every
timestamp in this schema is `t REAL` holding epoch seconds, and a 4-byte float
has about seven significant digits — not enough to represent the current year
to the second. Left untranslated, a Postgres install would round every
timestamp and every price, and nothing would fail. See `_DDL_SUBS` in
`sqlrewrite.py`.
"""

from __future__ import annotations

from .sqlrewrite import ddl_to_postgres

#: Every table this service owns. SQLite dialect; see the module docstring.
DDL = """\
CREATE TABLE IF NOT EXISTS config(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT, t REAL);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT, sym TEXT, op TEXT,
  price REAL, note TEXT, created REAL, fired REAL);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL, sym TEXT,
  tf TEXT, score REAL, px REAL, delayed INTEGER, h1 INTEGER, h4 INTEGER);
CREATE TABLE IF NOT EXISTS features(id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL, source TEXT, k TEXT, v TEXT);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL, kind TEXT, msg TEXT);
CREATE TABLE IF NOT EXISTS onchain_watch(id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT UNIQUE,
    chain TEXT DEFAULT 'ethereum', min_usd REAL DEFAULT 10000, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS onchain_seen(k TEXT PRIMARY KEY, t REAL);
CREATE TABLE IF NOT EXISTS db_wallets(wallet TEXT PRIMARY KEY, chain TEXT, tier TEXT, score REAL, nick TEXT, alert INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS wallet_events(id INTEGER PRIMARY KEY AUTOINCREMENT, wallet TEXT, chain TEXT,
    hash TEXT UNIQUE, t REAL, token TEXT, sym TEXT, direction TEXT, amount REAL);
CREATE TABLE IF NOT EXISTS ohlc_cache(sym TEXT, tf TEXT, t REAL, o REAL, h REAL, l REAL, c REAL, v REAL,
    PRIMARY KEY(sym, tf, t));
-- v60.3 SCHEMA 5: the durable bar archive.
-- SUPERSEDES ohlc_cache, which had no SOURCE in its key -- so a broker's
-- XAUUSD and yfinance's XAUUSD were one series -- and which nothing in
-- app/src ever called. The key here is the same three things the client keys
-- its own archive by (`keyFor(source, symbol, timeframe)` in data/history.ts),
-- so the two halves cannot disagree about what a series IS.
--
-- Only CLOSED bars. A forming bar's close changes every tick, so storing one
-- writes a number that was never a close; `svc/bars.py` drops them on the way
-- in and reports how many.
CREATE TABLE IF NOT EXISTS bars(src TEXT, sym TEXT, tf TEXT, t REAL,
    o REAL, h REAL, l REAL, c REAL, v REAL,
    PRIMARY KEY(src, sym, tf, t));
CREATE INDEX IF NOT EXISTS bars_series_t ON bars(sym, tf, t);
-- v62.6 auto_runs: what the autonomous loop last found for one market.
-- ONE ROW PER SERIES, replaced each pass — a history of passes would grow
-- without bound and nothing reads an older one; the payload already carries
-- the window it was measured over. `q` is a hash of the QUESTION (the rule
-- library, the horizon, the account), so a reader can tell whether a stored
-- answer is still an answer to what is being asked now.
CREATE TABLE IF NOT EXISTS auto_runs(sym TEXT, tf TEXT, q TEXT, at REAL, payload TEXT,
    UNIQUE(sym, tf));
-- v35.0 SCHEMA 2: the always-on tier
-- sig_watch: what the server evaluates when the browser is closed.
--            The browser is now just a CRUD editor for these rows.
CREATE TABLE IF NOT EXISTS sig_watch(id INTEGER PRIMARY KEY AUTOINCREMENT,
    sym TEXT, tf TEXT, strategy TEXT, q_gate INTEGER DEFAULT 50,
    enabled INTEGER DEFAULT 1, created REAL,
    UNIQUE(sym, tf, strategy));
-- sig_fired: bar_ts is IN THE PRIMARY KEY. A signal fires once per bar,
--            ever — across restarts, across crashes. No duplicate alerts.
CREATE TABLE IF NOT EXISTS sig_fired(sym TEXT, tf TEXT, strategy TEXT, bar_t REAL,
    fired_at REAL, dir TEXT, entry REAL, stop REAL, t1 REAL, t2 REAL, q REAL, record TEXT,
    PRIMARY KEY(sym, tf, strategy, bar_t));
-- durable client state: SQLite is the source of truth, localStorage is a cache
CREATE TABLE IF NOT EXISTS kvstore(k TEXT PRIMARY KEY, v TEXT, rev INTEGER DEFAULT 1, t REAL);
-- v36.0 SCHEMA 3: YOUR REAL EXECUTION
-- Raw MT5 deals. `ticket` is MT5's own deal id => re-importing the same report
-- is idempotent by construction, not by hope.
CREATE TABLE IF NOT EXISTS mt5_deals(
    ticket INTEGER PRIMARY KEY, position_id INTEGER, time_ms INTEGER,
    type INTEGER, entry INTEGER, symbol TEXT, volume REAL, price REAL,
    commission REAL, swap REAL, profit REAL, comment TEXT, src TEXT, imported REAL);
-- The broker's real cost profile per instrument. This is what retires the single
-- flat costBps that every backtest has been using for every instrument.
-- v37.0: the governor's rules. ONE row. His limits, not ours.
CREATE TABLE IF NOT EXISTS risk_cfg(k TEXT PRIMARY KEY, v TEXT, t REAL);
CREATE TABLE IF NOT EXISTS mt5_specs(
    symbol TEXT PRIMARY KEY, digits INTEGER, point REAL, contract_size REAL,
    tick_value REAL, tick_size REAL, spread_points INTEGER,
    swap_long REAL, swap_short REAL, stops_level INTEGER, t REAL);
-- v41: terminal settings sync. One row per key; `at` is the browser's
-- write time and is what last-write-wins compares, so it is the client
-- clock deliberately -- a server clock would make every push look newer
-- than the local edit it is racing.
-- `deleted_at` is a tombstone: a deleted alert that is merely ABSENT
-- comes straight back on the next pull from any machine that still has
-- it, so deletions have to be stored, not implied.
CREATE TABLE IF NOT EXISTS terminal_sync(
    k TEXT PRIMARY KEY, v TEXT, ver INTEGER DEFAULT 1,
    at REAL NOT NULL, deleted_at REAL, device TEXT);
CREATE INDEX IF NOT EXISTS terminal_sync_at ON terminal_sync(at);
"""


def init() -> None:
    """
    Create anything missing. Safe to call on every start, and it is.

    `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` are the only
    statements here, so this is idempotent in both dialects. Schema CHANGES go
    through `migrate()` in `mishel_service.py`, which is versioned and additive
    — never destructive, because the accumulated ledger is the one thing in
    this database that cannot be recomputed.
    """
    from .driver import connect, dialect

    script = DDL if dialect() == "sqlite" else ddl_to_postgres(DDL)
    with connect() as c:
        c.executescript(script)
