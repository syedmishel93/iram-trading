#!/usr/bin/env python3
"""One gate for the whole repository.

WHY THIS IS PYTHON AND NOT A MAKEFILE
`fullstack-project-kit` specifies a Makefile as the single source of truth, with
CI calling the same targets. That is the right idea and the wrong mechanism here:
**there is no `make` on this machine.** A gate the developer cannot run is not a
gate, and a Makefile that only CI can execute guarantees the two drift.

Python is already a hard requirement — the backend is Python and the binary is
built by `server/build_binary.py` — so a Python script is the one runner
guaranteed to work everywhere this project runs. Node is required too, but the
repository has no root `package.json` to hang scripts from, and inventing one to
hold four lines of shell would be a second manifest to keep in step.

WHAT IT IS FOR
Every turn of development so far has re-typed some variation of

    npx tsc --noEmit && npx vitest run && python -m pytest tests/test_gateway.py

by hand, which means the gate was whatever was remembered at the time. This is
that command, written down once, with the parts that were being forgotten.

HOW IT REPORTS
Every stage runs even when an earlier one fails, and the exit code is the whole
truth at the end. A runner that stops at the first failure hides the other
results — the same argument `tests/run_tests.sh` makes at the top of itself,
after a Windows console encoding error once silenced eighty test files behind an
`&&` chain.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import glob
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "app"
TESTS = ROOT / "tests"
SERVER = ROOT / "server"

#: Python test files that are pytest modules rather than standalone scripts.
#:
#: MEASURED, not guessed, and the distinction decides whether a file is tested
#: at all. These two define `def test_` functions and no `__main__` block, so
#: running them as programs imports them, collects nothing, prints nothing and
#: exits 0 — a silent pass. The reverse is just as bad: the twenty files below
#: run their assertions at import and call `sys.exit()` when they finish, which
#: makes pytest abort collection with an INTERNALERROR rather than run them.
#:
#: Neither runner works for both sets, which is why there are two lists.
PYTEST_FILES = [
    "tests/test_gateway.py",
    # THE NESTED-CONNECTION DEADLOCK (v62.13). `log_event()` opens its own
    # connection and WRITES, so calling it from inside `with db() as c:` asks
    # for the write lock the same thread is holding, raises "database is
    # locked" after the busy timeout, and the raise ROLLS BACK the work the
    # block existed to do. Measured before the fix: 2,067 `pair_err` events,
    # 46% of the whole log, and `onchain_seen` empty — the loop had failed on
    # every run it ever made. The last test is a guard over every `with db()`
    # block in server/, so the next one is caught here instead of in
    # production two thousand times.
    "tests/test_db_nested.py",
    # WAL AND A BUSY TIMEOUT (v62.15). The connection was opened with
    # `sqlite3.connect(path)` and nothing else, on a file shared by thirteen
    # loops. Measured: 256 writes vs 12,269 in three seconds, and a worst loop
    # wait of 4.24s against a 5s default. This asserts the PRAGMAs are APPLIED,
    # not merely written — a setting nobody checks is a comment.
    "tests/test_db_wal.py",
    # THE SESSION'S DEFECT CLASSES, ON EVERY RUN (v62.24). Four audits were
    # written this session, each after a real defect, and every one lived in
    # `scratchpad/` where NOTHING RAN IT — the same mechanism that hid nineteen
    # test files and left `run.py` linted by nothing. This runs the three
    # deterministic ones and fails if any parses zero, because a checker whose
    # pattern has stopped matching reports a clean tree.
    "tests/test_audits.py",
    # NO TEST MAY REACH THE OPERATOR'S REAL DATA (v62.26). This has happened SIX
    # times through THREE doors: four python files that never set
    # `MISHEL_SVC_DB`; `createHistory` defaulting to the real `/svc/bars` client
    # (535 rows of fixture candles into the archive the backtests read); and this
    # session, `startBackup`'s transport defaulting to the live one, so a
    # SCHEDULING test POSTed fixtures over thirteen real settings slots. Each
    # fix was correct and local and the next door opened anyway, because the rule
    # lived in people's heads. Proved to catch all three.
    "tests/test_no_live_store.py",
    # The durable bar archive (v60.3). Pins that a series is
    # (source, symbol, timeframe) — the table it replaces keyed on
    # (sym, tf) alone, which would have blended a broker's XAUUSD with
    # yfinance's — and that a repeated timestamp is stored once, the
    # defect that made an autonomous sweep report all 85 rules
    # unstudyable.
    "tests/test_bars_archive.py",
    # The MCP ENGINE (v63). Every case was taken from a live server rather than
    # invented, and three of them are the reasons the file exists: the reply may
    # be JSON *or* an SSE stream (the only server verifiable without an account
    # uses SSE), the SERVER's protocol version wins over the one we offer, and a
    # tool result is PROSE WRAPPING JSON — which broke the probe written to read
    # it. Hermetic: every request goes through one seam a patch replaces.
    # OPERATOR-SETTABLE SERVER CONFIG (v63.3). `svcsweep.py` found two keys read
    # by the server and settable by nothing -- one of them the disk budget the
    # eviction policy enforces, whose own refusal advises raising it. The test
    # that matters asserts the setting REACHES its reader: a written setting
    # nobody reads is the same defect from the other side.
    # THE CLAIMS BUCKETS ADD UP TO THEIR OWN TOTAL (v63.4). Found by reading what
    # `/svc/claims/stats` COMPUTES rather than whether it answers: `expired` was
    # counted in `total` and published in no bucket, so the numbers on screen did
    # not sum to the total above them. 31 of 2,113 on the live table. The test
    # that matters walks `_OUTCOMES` and requires a bucket for each, so a sixth
    # outcome fails here rather than silently reopening the hole.
    "tests/test_claims_partition.py",
    # THE THREE MODULES NOTHING TESTED (v63.6), because touching them live SENDS,
    # DOWNLOADS or overwrites the operator's backup — so `behave.py` skips them and
    # nothing else covered them either. `/svc/backup` accepted `{}` and answered
    # ok, wiping the blob; it had no server-side credential filter; and a push
    # that dropped eleven slots said nothing. Hermetic: scratch DB, stubbed sender.
    "tests/test_sideeffect_modules.py",
    "tests/test_settings.py",
    "tests/test_mcp_client.py",
    # MCP SIGN-IN (v63), separate because the rule it enforces has been broken
    # before through a different door each time. The token is stored server-side
    # and this sweeps every route for it — and PROVES the sweep by introducing a
    # real leak and requiring it to be caught. Its own first run passed 26 of 26
    # while the registry was empty and the swept routes rendered nothing, which is
    # the defect it exists for, found in itself.
    "tests/test_mcp_secrets.py",
    "tests/test_mcp_server.py",
    # THE POST SURFACE, which `probe.py` skips by design. Its sweep found 26
    # crashes across 20 routes, 20 of them one defect: every route reads the
    # body as `get_json() or {}` and a truthy SCALAR sails past the `or`.
    "tests/test_post_body_shape.py",
    # DEEP HISTORY (v63.21). The archive held 42 days of 1h, so a study's arm
    # got n=46 trades against a best-of-550 hurdle of +0.524 — nothing cleared
    # it, and at that depth "no edge" and "cannot see one" are the same reading.
    "tests/test_backfill.py",
    # A SERIES THE MACHINE READS IS NOT ONE IT TRADES (v63.21). The sweep
    # studied US10Y and VIX; one of the six best results across 22 markets was
    # `williams-reversal on VIX`. Untradeable arms also RAISE the best-of-N
    # hurdle for every arm that could be taken.
    "tests/test_auto_context.py",
    # The ROUTER (v62.2). Two of these are the reason the file exists: it must
    # report NO SKILL on noise rather than a flattering accuracy, and its folds
    # must be forward-only — a random split on a time series scores the model on
    # a past it has already seen, which inflates every metric invisibly.
    "tests/test_router.py",
    "tests/test_auto.py",
    # The bulk archive's EVICTION ORDER (v60.6). Nothing downloads until
    # this passes: 20 GB acquired with no bounded way to remove it is a
    # worse problem than no data. Pure arithmetic over an inventory, so the
    # order is tested without writing a byte.
    "tests/test_bar_store.py",
    "tests/test_quant_service.py",
    # The SQLite -> Postgres translation. Pure functions, no database and no
    # Postgres needed: it checks the rewriter, and then checks the rewriter
    # against the real schema and the real call sites, so a table added later
    # without a conflict key fails here rather than by inserting duplicates.
    "tests/test_db_rewrite.py",
    # The psycopg adapter, against a stub. Checks the OBJECT the service is
    # handed — SQL out, rows indexable by name and position, commit on success
    # and rollback on failure — none of which a live server would answer
    # better, and all of which break the moment the wrapper is wrong.
    "tests/test_db_adapter.py",
    # The Postgres ROUND TRIP. Skips unless IRAM_DB_URL is set, which on most
    # machines it is not — and the skip is the honest report of that. Where a
    # server does exist it proves what no unit test can: that the translated
    # DDL is accepted, that every conflict target names a constraint that
    # really exists, and that an epoch timestamp survives REAL -> DOUBLE
    # PRECISION, which is the failure that would otherwise be silent.
    "tests/test_db_postgres_live.py",
    # The lab's request model, after it learned about `spec` beside `family`.
    # A study has exactly ONE subject, and a request naming both or neither has
    # to be a 422 before a worker is spawned: accepting both and picking one
    # runs a real study of the rule nobody asked for and reports it under the
    # other one's name. The routes are covered in test_gateway.py; this is the
    # model, which is where that rule actually lives.
    "tests/test_lab_request.py",
    # Every module under server/db and server/svc is in the binary's HIDDEN
    # list. The service imports them after a runtime sys.path insert the
    # analyser cannot follow, so a missing one only fails in the shipped .exe.
    "tests/test_build_hidden_imports.py",
]

#: Standalone test scripts. Run as programs, with UTF-8 forced.
#:
#: WHY THIS LIST IS TWENTY LONG AND WAS TWO
#: The gate ran `test_mt5_clock` and `test_analyst` and nothing else, so
#: eighteen passing test files — roughly three hundred and forty assertions
#: covering the service, the risk governor, the reconciler, the claims ledger,
#: the edge store and the RSS reader — sat outside the build. They were not
#: broken and they were not slow; they were simply never named anywhere, so
#: breaking one of them was free.
#:
#: `PYTHONIOENCODING=utf-8` is not optional on Windows: these print a checkmark,
#: a cp1252 console cannot encode it, and the resulting `UnicodeEncodeError`
#: looks exactly like a failing test. `tests/run_tests.sh` learned this first.
#:
#: Every one of them reports through its exit code — either `sys.exit(1 if F
#: else 0)` at the end or a bare `assert`. Audited file by file: a script that
#: printed failures and exited 0 would be worse than an absent test, because it
#: would read as a passing one.
SCRIPT_TESTS = [
    "tests/test_analyst.py",
    "tests/test_analytics.py",
    "tests/test_claims.py",
    "tests/test_data_proxy_time.py",
    "tests/test_data_proxy_symbols.py",
    "tests/test_bars_topup.py",
    "tests/test_risk_specs.py",
    # THE EVENT LOG'S SUMMARY (v62.13). A recurring failure is a STANDING, not
    # an event: `/svc/events` is `LIMIT 50`, and on fifty rows a loop that had
    # failed 2,069 times looked like twelve ordinary lines. Counting the tail
    # would under-report it forty-fold. Also pins that classifying by kind NAME
    # alone reported one failing job where eleven were failing, and that "it
    # needs a key from you" is a third state rather than a failure.
    "tests/test_events_summary.py",
    # A COUNT THAT CANNOT BE WRONG IS NOT EVIDENCE (v62.14). `mishel_edge.upsert`
    # returned `len(rows)` -- its own input -- and the route logged that as
    # "400 of 400 written", a sentence whose two halves came from one number.
    # `trials` holds zero rows on a database whose log carries that line.
    "tests/test_edge_count.py",
    # THE DEDUP KEY IS THE ONLY RECORD OF WHAT THE SCANNER SAW (v62.16).
    # `onchain_seen` stores `np:chain:address` as one opaque string and the new
    # screen splits it; a split that guesses would put the chain in the address
    # column and nothing would look wrong, because an address is opaque to the
    # reader too. Pins that it REJECTS rather than repairs, and that an address
    # containing a colon keeps its tail.
    "tests/test_onchain_pairs.py",
    # A WEEKLY RESOURCE FETCHED HOURLY (v62.25). 42 `data_calendar` rate-limit
    # failures from asking a vendor for a WEEK'S calendar every hour, and again
    # on every restart — the feed answers 200 when asked once. Freshness is read
    # from the STORE, not a module timer, because a timer dies with the process
    # and the restart case is the one that needed covering. Pins that "never
    # fetched" is STALE (a new install must still fetch) and that a future
    # timestamp does not pin a feed as permanently fresh.
    "tests/test_feed_cadence.py",
    "tests/test_data_v393.py",
    "tests/test_edge.py",
    "tests/test_mt5_clock.py",
    "tests/test_recon_v360.py",
    "tests/test_risk_v370.py",
    "tests/test_rss.py",
    "tests/test_service_v154.py",
    "tests/test_service_v200.py",
    "tests/test_service_v210.py",
    "tests/test_service_v230.py",
    "tests/test_service_v240.py",
    "tests/test_service_v261.py",
    "tests/test_service_v350.py",
    "tests/test_service_v360.py",
    "tests/test_service_v370.py",
    "tests/test_service_v392_loops.py",
    "tests/test_service_v3930.py",
]


@dataclass
class Stage:
    name: str
    ok: bool
    seconds: float
    detail: str


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> tuple[bool, str]:
    """Run a command, returning success and the tail of its output."""
    merged = {**os.environ, "PYTHONIOENCODING": "utf-8", **(env or {})}
    try:
        p = subprocess.run(
            cmd, cwd=cwd, env=merged, capture_output=True, text=True,
            encoding="utf-8", errors="replace",
            # A failing command is this function's SUBJECT, not an exception:
            # every caller reads the returncode to decide a stage. Explicit
            # because the default is what a reader has to look up.
            check=False,
        )
    except FileNotFoundError:
        return False, f"{cmd[0]} not found"
    out = (p.stdout or "") + (p.stderr or "")
    ok = p.returncode == 0

    # A FAILING STAGE NEEDS MORE THAN TWELVE LINES, AND THAT IS WHY A FLAKE WENT
    # UNDIAGNOSED.
    #
    # The tail exists to keep a PASSING stage quiet. Applied to a failure it
    # threw away the thing the run is for: vitest prints the failing test, its
    # file and the assertion, and THEN a summary block — so the last twelve
    # lines are "Test Files / Tests / Start at / Duration" and the name of the
    # broken test has scrolled off. MEASURED: the vitest stage failed twice and
    # passed twice with no code change between them, and none of the four runs
    # could say which test it was.
    #
    # Same family as the two failures this file already records: the encoding
    # crash that replaced a real failure with a traceback, and the `&&` chain
    # that silenced eighty test files. A gate that cannot say WHAT broke is a
    # gate people re-run instead of reading.
    # AND THE NOISE HAS TO GO FIRST, OR A BIGGER TAIL IS STILL THE WRONG LINES.
    #
    # The first attempt kept 120 lines and STILL could not name the test: vitest
    # runs one worker per file and node prints two lines of
    # `ExperimentalWarning: localStorage is not available` for each of them, so
    # a hundred-odd lines of a benign warning sat between the failure and the
    # end of the output. Raising the number again would only move the wall.
    #
    # Only this exact known-benign pair is dropped. Filtering by guess is how a
    # checker starts hiding the thing it exists to show — the same reason
    # `classsweep.py`'s allowlist carries a reason per entry.
    noise = ("ExperimentalWarning: localStorage is not available",
             "--trace-warnings")
    lines = [ln for ln in out.strip().split("\n")
             if ln.strip() and not any(n in ln for n in noise)]
    keep = 12 if ok else 120
    return ok, "\n".join(lines[-keep:])


def npx(tool: str, *args: str) -> list[str]:
    """`npx` on Windows is a `.cmd`, which `subprocess` will not find unaided."""
    exe = shutil.which("npx") or shutil.which("npx.cmd")
    return [exe or "npx", tool, *args]


def main() -> int:
    # THE GATE MUST NOT DIE PRINTING A FAILURE.
    #
    # This crashed with `UnicodeEncodeError: 'charmap' codec` on the line that
    # names WHICH script test failed -- so a real failure was replaced by a
    # traceback about a box-drawing character, and the thing that broke was
    # invisible. It is the second time: `tests/run_tests.sh` records a Windows
    # console encoding error silencing eighty test files behind an `&&`, and
    # this file's own history records fixing it once already.
    #
    # Fixed at the STREAM rather than at the print, because the last fix was at
    # a print and a different print brought it back. `errors="replace"` means a
    # character this console cannot draw costs a `?`, never the message.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, OSError):
            pass

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true",
                    help="types and tests only — skip lint and the Python suite")
    ap.add_argument("--lint", action="store_true",
                    help="run ruff and mypy over the server (advisory: not yet clean)")
    ap.add_argument("-v", "--verbose", action="store_true", help="show output for passing stages too")
    args = ap.parse_args()

    stages: list[Stage] = []

    def say(line: str) -> None:
        """
        THE GATE MUST NOT DIE PRINTING A FAILURE.

        MEASURED: vitest reported one failing test, its output contained a
        U+276F, and this stage crashed inside `print` with a cp1252
        UnicodeEncodeError — so the run ended in a traceback about character
        encoding instead of the NAME OF THE BROKEN TEST. That is the same
        mechanism `tests/run_tests.sh` records at the top of itself, where a
        Windows console encoding error once silenced eighty test files and the
        build looked green. A reporter that cannot survive its own input is
        not a reporter.
        """
        try:
            print(line)
        except UnicodeEncodeError:
            enc = sys.stdout.encoding or "ascii"
            print(line.encode(enc, "replace").decode(enc, "replace"))

    def stage(name: str, cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
        print(f"· {name} …", flush=True)
        t0 = time.time()
        ok, tail = run(cmd, cwd, env)
        stages.append(Stage(name, ok, time.time() - t0, tail))
        if not ok or args.verbose:
            for line in tail.split("\n"):
                say(f"    {line}")

    def script_stage() -> None:
        """The twenty standalone scripts, run at once rather than in turn.

        WHY PARALLEL, AND WHY THAT IS SAFE HERE
        Serially they cost 41.7s against a 53s gate — nearly doubling it, which
        is how a gate stops being run. They are separate processes sharing no
        state, and every one of them now points at its own scratch database, so
        there is nothing for them to contend over. MEASURED before switching:
        three trials of twenty at eight workers, sixty runs, zero failures,
        17.8-18.5s. If that ever turns flaky the honest fix is serial, not
        retries — a gate that passes on the second attempt is not a gate.

        MISHEL_SVC_DB is set for the whole stage as a BELT. Four of these files
        used to write to the operator's live `server/mishel.db`: each run
        advanced its autoincrement counters and overwrote `kv.client_backup`,
        the browser's settings backup, with a test fixture. Those four now set
        their own temp path, which is the real fix; this line means the next
        file that forgets cannot do the same damage.
        """
        print(f"· {len(SCRIPT_TESTS)} scripts (parallel) …", flush=True)
        t0 = time.time()
        env = {"MISHEL_SVC_DB": os.path.join(tempfile.mkdtemp(prefix="iram-verify-"), "svc.db")}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(
                lambda f: (f, *run([sys.executable, f], ROOT, env)), SCRIPT_TESTS))
        bad = [(f, tail) for f, ok, tail in results if not ok]
        detail = "\n".join(f"{Path(f).name}: {tail.splitlines()[-1] if tail else 'no output'}"
                            for f, tail in bad)
        stages.append(Stage(f"{len(SCRIPT_TESTS)} scripts", not bad, time.time() - t0, detail))
        for f, tail in bad:
            print(f"  ── {f}")
            for line in tail.split("\n"):
                print(f"     {line}")

    #: What gets linted.
    #:
    #: `run.py` and this file are HERE and were not, which is the same mechanism
    #: that hid nineteen test files: a path in no list is a path nobody checks.
    #: The launcher is the most user-facing Python in the repository -- it is
    #: what a first run executes -- and it was the only substantial module
    #: outside every gate. Linting it immediately found a redundant second ruff
    #: pass in this very function, whose results were both discarded.
    #:
    #: A directory would be better than a file list, but there is no directory
    #: that contains these two and not `app/`, `dist/` and the frozen `tools/`.
    LINT_TARGETS = ("server", "tests", "run.py", "verify.py")

    #: Rules with a known, counted backlog. See `ruff.toml` for why each is
    #: deferred rather than fixed. These are the ONLY codes allowed to appear.
    DEFERRED = {
        "BLE001": 101,   # except Exception:
        "UP031": 46,     # "%s" % x
        "S110": 14,      # try/except/pass
        "S112": 14,      # try/except/continue
        "SIM115": 9,     # open() without a context manager
    }

    def lint_stage() -> None:
        """Ruff, gating on the RULE NAME rather than on the count.

        WHY NOT A COUNT, AND WHY NOT `ignore`
        A total ("must stay at or below 185") goes stale on the first honest
        refactor and then blocks it. An `ignore = [...]` list in ruff.toml would
        turn every existing `# noqa: BLE001` into a RUF100 "unused directive"
        violation -- so suppressing the rule would mean deleting the fourteen
        annotations that record where somebody already did this work.

        So the line is drawn here, by code. The five deferred rules may print as
        much as they like; ANY other code fails the stage. That makes a new
        finding of a new kind loud and the existing backlog quiet, which is the
        only arrangement in which both stay true.
        """
        print(f"· ruff ({', '.join(LINT_TARGETS)}) …", flush=True)
        t0 = time.time()
        # ONE ruff run. This used to call `run(...)` first and then
        # `subprocess.run` again with the same arguments, discarding both the
        # `ok` and the `tail` of the first -- two full lint passes for one
        # answer. `run` returns only the last twelve lines and 185 findings do
        # not fit in that, so the direct call is the one that stays.
        proc = subprocess.run(
            [sys.executable, "-m", "ruff", "check", *LINT_TARGETS, "--output-format", "concise"],
            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            check=False,
        )
        codes: dict[str, int] = {}
        for line in (proc.stdout or "").splitlines():
            # `path:line:col: CODE message`
            parts = line.split(": ", 1)
            if len(parts) != 2:
                continue
            code = parts[1].split(" ", 1)[0]
            if code and code[0].isalpha() and any(c.isdigit() for c in code):
                codes[code] = codes.get(code, 0) + 1
        unexpected = {c: n for c, n in codes.items() if c not in DEFERRED}
        detail = ""
        if unexpected:
            detail = ("New rule(s) outside the deferred set in ruff.toml:\n      "
                      + "\n      ".join(f"{c} x{n}" for c, n in sorted(unexpected.items()))
                      + "\n    Fix them, or add the code to DEFERRED in verify.py with a"
                        "\n    reason in ruff.toml. Run: python -m ruff check "
                      + " ".join(LINT_TARGETS)
                      + " --select " + ",".join(sorted(unexpected)))
        else:
            drift = {c: (codes.get(c, 0), n) for c, n in DEFERRED.items() if codes.get(c, 0) != n}
            detail = ("deferred backlog: "
                      + ", ".join(f"{c} {codes.get(c, 0)}" for c in sorted(DEFERRED)))
            if drift:
                # Not a failure -- fixing one of these SHOULD be allowed without
                # editing two files. Just say so, so the counts in ruff.toml can
                # be corrected while somebody is looking at them.
                detail += ("\n    counts moved since ruff.toml was written: "
                           + ", ".join(f"{c} {was} -> {now}" for c, (now, was) in sorted(drift.items())))
        stages.append(Stage("ruff (deferred set only)", not unexpected, time.time() - t0, detail))
        for line in detail.split("\n"):
            print(f"    {line}")

    # ---- the frontend gate: types first, because a type error makes the test
    # ---- output meaningless rather than merely red.
    stage("tsc --noEmit", npx("tsc", "--noEmit"), APP)
    stage("vitest", npx("vitest", "run", "--reporter=dot"), APP)

    if not args.quick:
        # ---- THE LISTS ABOVE MUST COVER `tests/`, and this is the only thing
        # ---- that will ever notice when they stop.
        #
        # The two lists were two files long while twenty passing test files sat
        # outside the build. Nothing was broken; nothing was named. Fixing the
        # lists once does not fix the mechanism — the next test file added is
        # invisible again, and invisible in exactly the same silent way.
        #
        # So the gate fails on an unlisted file. It costs one line to add a
        # test to a list, and that line is a decision about which runner it
        # needs — which the author knows and a discoverer would have to
        # reverse-engineer.
        # `tests/test_*.py` only, deliberately. The 76 `tests/test_*.js` files
        # test `../index.html`, the frozen v39 terminal (LEGACY.md), and frozen
        # code cannot regress -- so they are run by `tests/run_tests.sh` when
        # the legacy app is touched, not on every change. Saying so here rather
        # than letting a narrow glob imply it: an unexplained exclusion is how
        # the twenty python files went missing in the first place.
        known = set(PYTEST_FILES) | set(SCRIPT_TESTS)
        found = {p.replace(os.sep, "/") for p in glob.glob("tests/test_*.py", root_dir=ROOT)}
        missing = sorted(found - known)
        gone = sorted(f for f in known if not (ROOT / f).exists())
        t0 = time.time()
        detail = ""
        if missing:
            detail += ("Not in PYTEST_FILES or SCRIPT_TESTS, so never run:\n      "
                       + "\n      ".join(missing)
                       + "\n    Add each to SCRIPT_TESTS (runs its assertions at import, exits "
                         "nonzero)\n    or PYTEST_FILES (defines `def test_` functions).")
        if gone:
            detail += ("\n    Listed but absent: " + ", ".join(gone))
        stages.append(Stage("tests/ fully listed", not (missing or gone), time.time() - t0, detail))
        if missing or gone:
            for line in detail.split("\n"):
                print(f"    {line}")

        stage("pytest", [sys.executable, "-m", "pytest", *PYTEST_FILES, "-q"], ROOT)
        script_stage()

    if args.lint:
        lint_stage()
        # mypy over `server/gateway` is BLOCKING, because it is clean: ten files,
        # zero errors. It reached zero in this pass by fixing four things, three
        # of which were the stubs being right and the code being loose --
        # `Mount(app=...)` wants starlette's MutableMapping-based ASGIApp and was
        # handed a narrower `dict[str, Any]`, and `BaseRoute` genuinely has no
        # `.path`. Only `sys.stdout.reconfigure` needed a suppression.
        #
        # Scoped to `gateway/` on purpose. The flat `mishel_*` modules are
        # untyped and would report hundreds; adding them would take this from a
        # gate to a backlog, and the whole lesson of this file is that a number
        # nobody is driving to zero is a number people learn to skip.
        # `run.py` joins it because it is annotated and clean, and because it is
        # the file a first run executes: a launcher that crashes on a `None`
        # while reporting why the backend is down is the worst place in the
        # repository for a type error. Measured before adding it, not after.
        # `server/entry.py` is here for the same reason as `run.py`: it is the
        # launcher of the PACKAGED product, so a type error in it is a type
        # error in the thing people download, and it is annotated and clean.
        stage("mypy (gateway, launchers)",
              [sys.executable, "-m", "mypy", "server/gateway", "run.py", "server/entry.py"], ROOT)

    print()
    width = max(len(s.name) for s in stages)
    blocking = list(stages)
    for s in stages:
        advisory = ""
        print(f"  {'PASS' if s.ok else 'FAIL'}  {s.name:<{width}}  {s.seconds:5.1f}s{advisory}")

    failed = [s for s in blocking if not s.ok]
    print()
    if failed:
        print(f"VERIFY FAILED — {len(failed)} of {len(blocking)} blocking stages: "
              f"{', '.join(s.name for s in failed)}")
        return 1
    print(f"VERIFY PASSED — {len(blocking)} stages, {sum(s.seconds for s in stages):.0f}s total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
