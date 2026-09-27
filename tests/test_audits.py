#!/usr/bin/env python3
"""
test_audits.py — THE SESSION'S DEFECT CLASSES, CHECKED ON EVERY RUN.

WHY THIS FILE EXISTS

Four audits were written this session, each after a real defect, and every one
of them lived in `scratchpad/` where nothing ran it. That is precisely the
mechanism this project records twice over: nineteen Python test files were in
no list, so breaking one was free; and `run.py` was the largest module outside
every gate, so it was linted by nothing. **A path in no list is a path nobody
checks** — and an audit nobody runs is a one-time finding, not a guard.

So the three DETERMINISTIC ones run here, on every `verify.py`. They need no
server, no network and no browser, and they are fast.

WHAT EACH ONE CATCHES, AND WHAT IT COST TO LEARN

  `dbhold.py`      A call that opens a SECOND database connection inside an open
                   transaction. `log_event()` does, and `pair_scan_loop` called
                   it from inside its own write — deadlocking its thread, raising
                   "database is locked" after the busy timeout, and ROLLING BACK
                   the dedup insert that was the point of the block. 2,069
                   failures, 46% of the whole event log, `onchain_seen` empty:
                   the loop had failed on every run it ever made.

  `classsweep.py`  Five classes at once — a credential reaching the wire, a
                   parameter defaulting to live network I/O (a test POSTed
                   fixtures over the operator's real backup through one), a
                   debounce with no ceiling, a count returned from its own input,
                   and a hand-rolled reactive list that loses every row when one
                   throws.

  `cssdupe.py`     One class declared twice at top level with the same property
                   set differently. `.cal-row` was the economic calendar's
                   five-column grid and the calibration card's four-column grid
                   in one sheet, 1,280 lines apart; the later won and the
                   calendar rendered on the wrong grid.

NOT RUN HERE: `survey.py` and `routes.py`. The first needs a live gateway and the
second reports a backlog rather than a failure — a gate that fails on a backlog
is a gate people switch off.

EACH AUDIT PRINTS WHAT IT PARSED AND EXITS 2 ON A ZERO, so a pattern that has
stopped matching fails loudly instead of reporting a clean tree. This file
asserts that too, because the alternative is a green check that means nothing —
`/svc/health` painting "0 of 0 running" green, in the gate.
"""

import os
import subprocess
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SCRATCH = os.path.join(ROOT, "scratchpad")

#: Audit, and the exit code that means "clean".
#:
#: All three use 0 clean / 1 findings / 2 the pattern broke. The last is the one
#: that matters: a checker whose regex stops matching reports success, which is
#: the defect it was written to find.
AUDITS = (
    ("dbhold.py", "a transaction holding a second connection"),
    ("classsweep.py", "credential egress, live defaults, unceilinged debounce, input counts, fragile lists"),
    ("cssdupe.py", "one class, two conflicting top-level declarations"),
    ("svcsweep.py", ("a tuple read as a scalar, a config key nothing writes, a one-way "
                     "table, a character-set strip used as a suffix strip")),
)


class Audits(unittest.TestCase):
    def _run(self, name):
        path = os.path.join(SCRATCH, name)
        self.assertTrue(os.path.exists(path), "%s is missing — the audit was deleted, not fixed" % name)
        # `check=False` is the point: the exit CODE is the result. Raising here
        # would hide WHICH audit failed and what it printed, and the printout is
        # the whole value — a finding with no file and line is not a finding.
        r = subprocess.run(
            [sys.executable, path],
            check=False,
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        )
        return r

    def test_each_audit_reports_clean(self):
        for name, what in AUDITS:
            with self.subTest(audit=name):
                r = self._run(name)
                out = (r.stdout or "") + (r.stderr or "")

                # 2 means the pattern matched nothing. That is a BROKEN CHECKER,
                # and it must never read as a pass.
                self.assertNotEqual(
                    r.returncode, 2,
                    "%s parsed nothing — its pattern has stopped matching, so its "
                    "silence is not evidence:\n%s" % (name, out),
                )
                self.assertEqual(
                    r.returncode, 0,
                    "%s found %s:\n%s" % (name, what, out),
                )

                # And it must SAY what it parsed, so a future zero is visible.
                self.assertIn(
                    "PARSED", out,
                    "%s did not report what it parsed; a count nobody prints is a "
                    "count nobody checks:\n%s" % (name, out),
                )

    def test_every_audit_in_scratchpad_is_listed_here(self):
        """The same rule `tests/ fully listed` enforces, one level up.

        An audit added to `scratchpad/` and not added here is an audit that runs
        once and then never again — which is how all four of them started.
        Deliberately excluded ones are listed BY NAME with a reason, so leaving
        one out is a decision rather than an oversight.

        Only the TOP LEVEL is scanned. One-shot edit scripts live in
        `scratchpad/applied/` — each has already run, each asserts its anchor
        matches exactly once so a second run fails rather than corrupting a
        file, and none of them is a check. Keeping them out of the top level is
        what makes this question answerable at all.
        """
        # Deliberately not gated, with the reason.
        EXCLUDED = {
            "survey.py": "needs a live gateway on :8787",
            "behave.py": ("needs a live gateway AND real data: it asserts what each module "
                          "COMPUTES (arithmetic identities, ordering, units, brackets) "
                          "rather than whether it answers. Run it beside `python run.py`."),
            "routes.py": "reports a backlog, not a failure",
            "deps.py": "a measurement tool, not a pass/fail check",
            "extract.py": "superseded by deps.py; kept for reference",
            "xref.py": "cross-reference audit; reports counts",
            "classcollide.py": "reports cross-sheet prefix overlaps, many deliberate",
            "deskshape.py": "a measurement tool",
            "tdz.py": "a measurement tool",
            "freetext.py": "a measurement tool",
            "probe.py": "an ad-hoc prober",
            "mcpprobe.py": "needs the network and a live MCP server; it MEASURES a "
                           "third party's transport rather than checking this tree",
            "mcpauthprobe.py": "needs the network; walks a live OAuth discovery chain. "
                               "Read-only by design -- registration creates a record on "
                               "somebody else's service and belongs to a Connect press",
            "menu_audit.py": "reports counts",
            "measure_shell.py": "a measurement tool",
            "postrefuse.py": ("needs a SECOND gateway on a throwaway database -- it "
                              "sends malformed bodies to routes that write, and "
                              "doing that against the operator's store is the rule "
                              "this project has broken six times. Gated form: "
                              "tests/test_post_body_shape.py"),
            "classundeclared.py": ("reports classes the TS applies that no sheet "
                                   "declares. NOT gated: most are querySelector "
                                   "hooks that need no rule, and a check whose "
                                   "normal state is 99 findings is one people "
                                   "learn to ignore. Run it when adding a card."),
        }
        listed = {name for name, _ in AUDITS}
        found = {
            f for f in os.listdir(SCRATCH)
            if f.endswith(".py") and not f.startswith("_")
        }
        # Only files that look like audits: they are run, not imported.
        unaccounted = sorted(f for f in found if f not in listed and f not in EXCLUDED)
        self.assertEqual(
            unaccounted, [],
            "these scratchpad scripts are in neither the gated list nor the "
            "excluded one, so nobody has decided whether they should run: %s"
            % ", ".join(unaccounted),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
