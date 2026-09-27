#!/usr/bin/env python3
"""
test_db_wal.py - THE CONNECTION'S SETTINGS ARE A CLAIM, SO CHECK THEM.

`server/db/driver.py` opened the file with `sqlite3.connect(path)` and nothing
else: the default rollback journal, where a writer blocks every READER, and the
default 5s timeout. Thirteen background loops and every HTTP route share it.

MEASURED on identical workloads before changing anything:

    4 writers / 6 readers, 3s   as shipped     256 writes,  255 reads
                                WAL         12,269 writes, 12,437 reads
    1 bulk writer + 6 loops     as shipped   slowest loop wait 4.24s
                                WAL         slowest loop wait 2.49s

This does NOT claim WAL fixed the "database is locked" errors in the event log.
Those were a nested WRITE deadlocking its own thread, and `test_db_nested.py`
shows no journal mode can help that. The case here is only the measured margin:
4.24s of waiting against a 5s default is not a margin.

(An earlier version of this docstring said one such error appeared after that fix
shipped. It did not — that was a log line dated 2026-09-04 read as today.)

WHAT IS ASSERTED: that the settings are actually applied. A PRAGMA in a function
nobody checks is the same as a comment claiming it -- and CLAUDE.md records a CSS
rule that existed, applied to nothing, and was verified by reading the stylesheet
instead of the element.
"""

import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "server"))


class WalIsActuallyOn(unittest.TestCase):
    def setUp(self):
        # Point the driver at a scratch file. NOT the operator's mishel.db:
        # CLAUDE.md records four test files that wrote into it.
        self.path = os.path.join(tempfile.mkdtemp(), "wal.db")
        os.environ["MISHEL_SVC_DB"] = self.path
        os.environ.pop("IRAM_DB_URL", None)
        for mod in [m for m in list(sys.modules) if m.startswith("db")]:
            del sys.modules[mod]

    def test_the_pragmas_are_applied_not_merely_written(self):
        from db import driver

        driver.SQLITE_PATH = self.path
        c = driver.connect()
        mode = c.execute("PRAGMA journal_mode").fetchone()[0]
        busy = c.execute("PRAGMA busy_timeout").fetchone()[0]
        self.assertEqual(str(mode).lower(), "wal", "journal_mode is not WAL on a fresh connection")
        # The margin is the point: the worst measured wait under a bulk write
        # was 4.24s, and the default is 5s.
        self.assertGreaterEqual(int(busy), 10000, "busy_timeout leaves no margin over the measured worst wait")
        c.close()

    def test_a_reader_is_not_blocked_by_an_open_write(self):
        """The property WAL is for. Under the rollback journal this raises."""
        from db import driver

        driver.SQLITE_PATH = self.path
        boot = driver.connect()
        boot.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
        boot.execute("INSERT INTO t (v) VALUES ('before')")
        boot.commit()
        boot.close()

        writer = driver.connect()
        reader = driver.connect()
        writer.execute("INSERT INTO t (v) VALUES ('during')")  # transaction OPEN
        # The reader sees the pre-transaction state rather than waiting for it.
        n = reader.execute("SELECT count(*) FROM t").fetchone()[0]
        self.assertEqual(n, 1, "the reader saw uncommitted data or was blocked")
        writer.commit()
        self.assertEqual(reader.execute("SELECT count(*) FROM t").fetchone()[0], 2)
        writer.close()
        reader.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
