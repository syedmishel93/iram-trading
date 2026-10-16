"""
EVERY SOURCE FILE IS IN VERSION CONTROL, and a .gitignore rule cannot quietly
say otherwise.

WHY THIS EXISTS

`.gitignore` carried a bare `data/`, written for the bulk market archive. A
pattern with no leading slash matches a directory of that name AT ANY DEPTH, so
it was also excluding `app/src/data/` - 53 files holding every vendor client, the
backend address resolution and the history and archive clients - and
`app/src/ui/data/`.

MEASURED when it was found: 58 of 408 source files under `app/src` were
untracked. A clone of this repository would not have compiled, and nothing said
so: `verify.py` passes, `tsc` passes, the tests pass, the product runs. Every
check in this project reads the WORKING TREE, so a file missing from the index is
invisible to all of them.

The archive that rule was written for lives in `%LOCALAPPDATA%/iram/data/`,
outside the repository entirely, so it protected nothing at all.

This is the same mechanism as the nineteen unlisted Python test files and as
`run.py` being linted by nothing: A PATH IN NO LIST IS A PATH NOBODY CHECKS. The
fix is not to anchor the one rule - that was done - but to make the question
answerable on every gate, because the next such rule will look just as ordinary.
"""

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: Trees whose contents are genuinely not source, checked as PREFIXES.
NOT_SOURCE = (
    "node_modules",
    "venv",
    "__pycache__",
    os.path.join("app", "dist"),
    os.path.join("server", "build"),
    os.path.join("desktop", "src-tauri", "target"),
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
)

#: Where source lives. `src/` and `tools/` at the root are frozen v39 (LEGACY.md)
#: and are deliberately not swept here.
TREES = (
    os.path.join("app", "src"),
    os.path.join("app", "test"),
    "server",
    "tests",
    "scratchpad",
)

EXTS = (".ts", ".tsx", ".py", ".css", ".mjs")


def _walk(tree):
    base = os.path.join(ROOT, tree)
    out = set()
    for cur, dirs, names in os.walk(base):
        rel_dir = os.path.relpath(cur, ROOT)
        # PRUNED, NOT FILTERED, so a 40,000-file `node_modules` is never walked.
        # Written as a plain loop on purpose: the first version was a nested
        # comprehension that rebound its own loop variable, and I could not read
        # it well enough to say whether it was right.
        parts = rel_dir.split(os.sep)
        if any(skip in parts or rel_dir.startswith(skip) for skip in NOT_SOURCE):
            dirs[:] = []
            continue
        for n in names:
            if n.endswith(EXTS):
                out.add(os.path.relpath(os.path.join(cur, n), ROOT).replace(os.sep, "/"))
    return out


def main():
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        print("SKIP: not a git repository, so tracking cannot be checked")
        return 0

    tracked = set(
        subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
    )

    on_disk = set()
    for tree in TREES:
        on_disk |= _walk(tree)

    # PRINT WHAT WAS PARSED, AND FAIL ON A ZERO. A sweep that matched nothing
    # reports a clean tree, which is how `scratchpad/xref.py` shipped with two
    # vacuous checks.
    print("PARSED : %d source files across %d trees" % (len(on_disk), len(TREES)))
    print("PARSED : %d paths in the git index" % len(tracked))
    if len(on_disk) == 0 or len(tracked) == 0:
        print("FAIL   : parsed nothing, so this reported success about nothing")
        return 1

    missing = sorted(on_disk - tracked)
    if missing:
        print()
        print("SOURCE FILES NOT IN VERSION CONTROL (%d):" % len(missing))
        for m in missing[:40]:
            why = subprocess.run(
                ["git", "check-ignore", "-v", m],
                cwd=ROOT,
                capture_output=True,
                text=True,
                # NOT BOILERPLATE. `git check-ignore` exits 1 when the path is
                # NOT ignored, which is the ordinary case here (the file was
                # simply never added), so raising would turn the explanation
                # this line exists to print into a crash.
                check=False,
            ).stdout.strip()
            print("  %s%s" % (m, "   <- " + why.split("\t")[0] if why else "   (never added)"))
        if len(missing) > 40:
            print("  ... and %d more" % (len(missing) - 40))
        print()
        print("A .gitignore pattern with no leading slash matches that name at ANY depth.")
        return 1

    print("OK     : every source file under %s is tracked" % ", ".join(TREES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
