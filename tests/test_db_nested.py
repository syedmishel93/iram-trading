"""A NESTED WRITE DEADLOCKS THE THREAD THAT OPENED THE TRANSACTION.

MEASURED BEFORE IT WAS FIXED: `/svc/events` held 2,067 `pair_err` rows -- the
largest single kind in the log, 46% of every event the service had recorded --
and `onchain_seen` held ZERO rows. `pair_scan_loop` had failed on every run it
ever made, and the only trace of it was an HTTP route with no screen.

WHAT BREAKS, EXACTLY

`log_event()` opens its OWN connection and WRITES. Called from inside
`with db() as c:` it asks for the write lock the same thread already holds,
waits out the busy timeout and raises "database is locked".

A NESTED READ IS FINE, so this is not a "never nest" rule and the test says so
in both directions. Two earlier hypotheses were measured and discarded: a
4-writer/6-reader workload produced zero lock errors on the shipped settings,
and so did one built around a long bulk transaction. Only the nested write
reproduces it.

THE ROLLBACK IS THE REAL DAMAGE. The raise escapes the `with`, so sqlite3 rolls
the transaction back -- including the dedup insert that was the point of the
block. A loop that only logged an error would have been survivable; this one
silently undid its own work, forever.

The third test is the guard: it re-runs the audit over every `with db()` block
in `server/`, so the next one written is caught here rather than in production
two thousand times.
"""

import os
import re
import sqlite3
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server")


def _make_db():
    path = os.path.join(tempfile.mkdtemp(), "nest.db")
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE config (k TEXT PRIMARY KEY, v TEXT)")
    c.execute("CREATE TABLE seen (k TEXT PRIMARY KEY, t REAL)")
    c.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, t REAL, kind TEXT, msg TEXT)")
    c.execute("INSERT INTO config VALUES ('pair_scan_tg', '0')")
    c.commit()
    c.close()
    return path


class NestedConnection(unittest.TestCase):
    """The mechanism, on a scratch database shaped like the real one."""

    def setUp(self):
        self.path = _make_db()

        def db():
            # Exactly how `server/db/driver.py` opens it: no WAL, default timeout.
            conn = sqlite3.connect(self.path)
            conn.row_factory = sqlite3.Row
            return conn

        self.db = db

    def test_nested_read_is_fine(self):
        """`cfg()` reads on its own connection, and that has never been the fault."""
        with self.db() as c:
            c.execute("INSERT OR IGNORE INTO seen(k,t) VALUES(?,?)", ("np:x", time.time()))
            with self.db() as c2:
                row = c2.execute("SELECT v FROM config WHERE k=?", ("pair_scan_tg",)).fetchone()
            self.assertEqual(row["v"], "0")

    def test_nested_write_raises_database_is_locked(self):
        """`log_event()` writes on its own connection. This is the defect."""
        t0 = time.time()
        with self.assertRaises(sqlite3.OperationalError) as caught:  # noqa: SIM117 - the nesting IS the subject; flattening it hides what the test is about
            with self.db() as c:
                c.execute("INSERT OR IGNORE INTO seen(k,t) VALUES(?,?)", ("np:y", time.time()))
                with self.db() as c2:
                    c2.execute(
                        "INSERT INTO events(t,kind,msg) VALUES(?,?,?)",
                        (time.time(), "newpair", "solana:abc"),
                    )
        self.assertIn("locked", str(caught.exception).lower())
        # It is not instant: the thread burns the whole busy timeout waiting for
        # a lock it is itself holding. That is why the loop was also slow.
        self.assertGreater(time.time() - t0, 1.0)

    def test_the_raise_rolls_back_the_work(self):
        """The row the block existed to write is GONE. This is the real cost."""
        try:
            with self.db() as c:
                c.execute("INSERT OR IGNORE INTO seen(k,t) VALUES(?,?)", ("np:z", time.time()))
                with self.db() as c2:
                    c2.execute(
                        "INSERT INTO events(t,kind,msg) VALUES(?,?,?)",
                        (time.time(), "newpair", "solana:abc"),
                    )
        except sqlite3.OperationalError:
            pass
        with self.db() as c:
            n = c.execute("SELECT count(*) FROM seen WHERE k='np:z'").fetchone()[0]
        self.assertEqual(n, 0, "the dedup insert survived; the premise of this test is wrong")

    def test_announcing_after_the_block_works(self):
        """The fix: record inside, announce after. Both rows land."""
        announce = []
        with self.db() as c:
            c.execute("INSERT OR IGNORE INTO seen(k,t) VALUES(?,?)", ("np:ok", time.time()))
            announce.append("solana:abc")
        for msg in announce:
            with self.db() as c:
                c.execute("INSERT INTO events(t,kind,msg) VALUES(?,?,?)", (time.time(), "newpair", msg))
        with self.db() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM seen WHERE k='np:ok'").fetchone()[0], 1)
            self.assertEqual(c.execute("SELECT count(*) FROM events").fetchone()[0], 1)


# --------------------------------------------------------------------------
# The guard. Kept in step with `scratchpad/dbhold.py`, which is the runnable
# version of the same audit.
# --------------------------------------------------------------------------

OPEN_RE = re.compile(r"^(\s*)with\s+db\(\)\s+as\s+(\w+)\s*:")

_STR_RE = re.compile(
    '"""[\\s\\S]*?"""'
    "|'''[\\s\\S]*?'''"
    '|"(?:[^"\\\\]|\\\\.)*"'
    "|'(?:[^'\\\\]|\\\\.)*'"
)

# `send_tg` is here for a second reason as well as `cfg`: it posts to Telegram
# with a 10s timeout, and doing that inside a transaction holds the write lock
# across a network call. Same class as the 1.1 MB synchronous read inside an
# `async def` that this project already records.
FORBIDDEN = ("log_event", "send_tg", "cfg", "guarded_get", "requests", "urlopen")

CALL_RE = {
    name: re.compile("(?<![A-Za-z0-9_])" + re.escape(name) + "\\s*[(.]") for name in FORBIDDEN
}


def _strip(line):
    """Comments and STRING LITERALS are not calls.

    The first version of this matched `risk_cfg(k,v,t)` inside a SQL literal and
    accused a file that does nothing wrong.
    """
    return _STR_RE.sub('""', line.split("#")[0])


def _scan(path):
    src = open(path, encoding="utf-8").read().splitlines()  # noqa: SIM115 - read once, closed by refcount; a `with` here buys nothing
    hits, blocks = [], 0
    for i, line in enumerate(src):
        m = OPEN_RE.match(line)
        if not m:
            continue
        blocks += 1
        indent = len(m.group(1))
        for j in range(i + 1, len(src)):
            nxt = src[j]
            if not nxt.strip():
                continue
            if len(nxt) - len(nxt.lstrip()) <= indent:
                break
            code = _strip(nxt)
            if code.lstrip().startswith("def "):
                continue
            for name in FORBIDDEN:
                if CALL_RE[name].search(code):
                    hits.append("%s:%d  %s(...)  [transaction opened at line %d]"
                                % (os.path.basename(path), j + 1, name, i + 1))
                    break
    return hits, blocks


class NoNestedConnectionsInTree(unittest.TestCase):
    def test_no_transaction_holds_a_second_connection(self):
        files = []
        for dirpath, dirnames, filenames in os.walk(SERVER):
            dirnames[:] = [d for d in dirnames if d not in ("build", "venv", "__pycache__", "dist")]
            files += [os.path.join(dirpath, f) for f in filenames if f.endswith(".py")]

        found, blocks = [], 0
        for f in sorted(files):
            hits, n = _scan(f)
            blocks += n
            found += hits

        # PRINT WHAT WAS PARSED, and fail on a zero. A checker that can answer
        # "clean" because its pattern matched nothing is the defect it looks for
        # -- `/svc/health` painting "0 of 0 running" green, in a test.
        print("  scanned %d files, %d `with db()` blocks" % (len(files), blocks))
        self.assertGreater(blocks, 20, "parsed almost no transaction blocks - the pattern is wrong")
        self.assertEqual(found, [], "a transaction opens a second connection:\n  " + "\n  ".join(found))


if __name__ == "__main__":
    unittest.main(verbosity=2)
