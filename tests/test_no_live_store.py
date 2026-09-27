#!/usr/bin/env python3
"""
test_no_live_store.py - NO TEST MAY REACH THE OPERATOR'S REAL DATA.

THIS HAS NOW HAPPENED SIX TIMES, THROUGH THREE DIFFERENT DOORS.

  1. FOUR PYTHON TEST FILES wrote to `server/mishel.db` because they never set
     `MISHEL_SVC_DB`. Measured by hashing every table before and after: each run
     advanced `sqlite_sequence`, and replaced `kv.client_backup` -- the browser's
     settings backup -- with a fixture (`0xabc`, tier S). Their siblings all set
     the variable; these four never got the line.

  2. `createHistory` DEFAULTED to the real `/svc/bars` client, and the global
     `fetch` under vitest reaches a running gateway. `npm test` with `python
     run.py` up wrote 535 rows of fixture candles -- sources `net`, `a`, `alive`,
     dated 2027 -- into the archive the backtests read.

  3. THIS SESSION, `startBackup`'s transport defaulted to the live `pushBackup`.
     A SCHEDULING test, which had nothing to do with the network, POSTed two
     fixture slots over the operator's thirteen real ones. The server row came
     back `{pins, prefs}`.

Each fix was correct and local, and the next door opened anyway, because the
rule lived in people's heads. The `0xdna1111...` and `0xnodna1111...` wallets
still sitting in the live database are what that costs: residue nobody can now
safely delete without asking.

WHAT THIS ASSERTS

A Python test that imports the service, or names the database, must set
`MISHEL_SVC_DB` to a scratch path FIRST -- before the import, because the module
reads it at import time. A frontend test must not name a live service URL at all.

It is a source check rather than a runtime one on purpose: by the time a runtime
guard fires, the write has a stack trace and the operator has a corrupted row.
This fails before anything runs.
"""

import os
import re
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
APP_TEST = os.path.join(ROOT, "app", "test")

# Naming the real database, or importing something that opens it.
TOUCHES_DB = re.compile(
    r"mishel\.db"
    r"|\bimport\s+mishel_service\b"
    r"|\bfrom\s+mishel_service\s+import\b"
    r"|\bfrom\s+svc\.\w+\s+import\b.*\bdb\b"
    r"|\bimport\s+svc\.core\b"
)
SETS_SCRATCH = re.compile(r"MISHEL_SVC_DB")

# A frontend test naming a live service. `svcUrl`/`apiUrl`/`proxyBase` resolve
# against the running gateway under vitest; a literal port does too.
LIVE_URL = re.compile(r"127\.0\.0\.1:87\d\d|localhost:87\d\d|\bsvcUrl\s*\(|\bapiUrl\s*\(|\bproxyBase\s*\(")

#: Python tests that legitimately name the database WITHOUT a scratch path,
#: with the reason. Each is READ-ONLY or builds its own file.
PY_ALLOW = {
    "test_no_live_store.py": "this file: it names the paths it is checking",
    "test_db_nested.py": "builds its own sqlite file in a temp dir; never names mishel.db",
    "test_db_wal.py": "points the driver at a temp path before importing it",
    "test_audits.py": "runs audits as subprocesses; touches no database",
}

#: Frontend tests that legitimately mention a service helper, with the reason.
TS_ALLOW = {
    "backend.test.ts": "it is the test OF the URL builders; it calls them and asserts strings",
    "quant.test.ts": "asserts the URL a fetch was called with, using a stubbed fetch",
    "routerclient.test.ts": "stubs fetch and asserts the path it was handed",
    "brokercosts.test.ts": "pure arithmetic; imports the module but calls only pure functions",
    "services.test.ts": "pure arithmetic; imports the module but calls only pure functions",
    "claimstats.test.ts": "stubs fetch",
    "activity.test.ts": "label map only; no network call",
    "settingsbackup.test.ts": "passes an inert transport explicitly — see its own note",
}


def read(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


_TRIPLE_D = '"' * 3
_TRIPLE_S = "'" * 3
_PY_DOC = re.compile(
    _TRIPLE_D + r"[\s\S]*?" + _TRIPLE_D + "|" + _TRIPLE_S + r"[\s\S]*?" + _TRIPLE_S
)
_PY_COMMENT = re.compile(r"#.*?$", re.MULTILINE)


def py_code(src):
    """Strip PROSE only — docstrings and comments — never short literals.

    Two passes to get this right, and the second is the interesting one.

    Matching the raw source flagged `test_edge_count.py`, which builds its own
    sqlite file in a temp directory and is entirely correct: it was caught on
    its DOCSTRING, which names the live database while explaining this very
    rule. Punishing the files that document a trap is exactly backwards.

    So the first fix stripped every string literal — and then the guard stopped
    catching the defect it exists for, because **a database path is a string
    literal**. A probe containing `sqlite3.connect("server/mishel.db")` sailed
    through. That is the same mistake as stripping `"POST"` out of a sweep for
    modules that POST: the token being searched for was the token removed.

    Triple-quoted strings are prose here; short literals are arguments. Only the
    first are stripped.
    """
    return _PY_COMMENT.sub("", _PY_DOC.sub('""', src))


class NoTestTouchesLiveData(unittest.TestCase):
    def test_python_tests_use_a_scratch_database(self):
        offenders = []
        checked = 0
        for name in sorted(os.listdir(HERE)):
            if not (name.startswith("test_") and name.endswith(".py")):
                continue
            checked += 1
            if name in PY_ALLOW:
                continue
            src = read(os.path.join(HERE, name))
            if not TOUCHES_DB.search(py_code(src)):
                continue
            # The env var is set as a STRING KEY, so this looks at the raw
            # source: stripping literals would remove the thing being sought.
            if not SETS_SCRATCH.search(src):
                offenders.append(name)
        self.assertGreater(checked, 10, "found almost no python tests — the pattern is wrong")
        self.assertEqual(
            offenders, [],
            "these tests reach the service or the database without setting "
            "MISHEL_SVC_DB to a scratch path first:\n  " + "\n  ".join(offenders),
        )

    def test_scratch_is_set_before_the_import(self):
        """The module reads it AT IMPORT TIME, so the order is the whole rule."""
        wrong = []
        for name in sorted(os.listdir(HERE)):
            if not (name.startswith("test_") and name.endswith(".py")) or name in PY_ALLOW:
                continue
            src = read(os.path.join(HERE, name))
            if not SETS_SCRATCH.search(src):
                continue
            set_at = src.index("MISHEL_SVC_DB")
            imp = re.search(r"^\s*(?:import\s+mishel_service|from\s+mishel_service\s+import)", src, re.MULTILINE)
            if imp and imp.start() < set_at:
                wrong.append(name)
        self.assertEqual(
            wrong, [],
            "these set MISHEL_SVC_DB AFTER importing the service, which is too "
            "late — it is read at import time:\n  " + "\n  ".join(wrong),
        )

    def test_frontend_tests_do_not_name_a_live_service(self):
        if not os.path.isdir(APP_TEST):
            self.skipTest("no app/test directory")
        offenders = []
        checked = 0
        for name in sorted(os.listdir(APP_TEST)):
            if not name.endswith(".test.ts"):
                continue
            checked += 1
            if name in TS_ALLOW:
                continue
            src = read(os.path.join(APP_TEST, name))
            # Comments explain these defects at length; they are not calls.
            code = re.sub(r"/\*[\s\S]*?\*/", "", src)
            code = re.sub(r"//.*?$", "", code, flags=re.MULTILINE)
            if LIVE_URL.search(code):
                offenders.append(name)
        self.assertGreater(checked, 50, "found almost no frontend tests — the pattern is wrong")
        self.assertEqual(
            offenders, [],
            "these frontend tests name a live service helper or port. Under vitest "
            "the global fetch reaches a running gateway, so this is how 535 rows of "
            "fixture candles and a fixture settings backup reached the operator's "
            "real store. Stub the transport, or add the file to TS_ALLOW with a "
            "reason:\n  " + "\n  ".join(offenders),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
