"""WHAT IS CALLED WHILE A DATABASE TRANSACTION IS OPEN.

One SQLite file serves thirteen background loops and every HTTP route, and
`cfg()`, `log_event()` and `send_tg()` each open their OWN connection. Calling
one of them from inside `with db() as c:` asks for a lock the SAME THREAD is
already holding. That can never be granted, so it waits out the full busy
timeout and raises "database is locked" -- which `/svc/events` had been
recording twelve times an hour, with no screen anywhere in the product.

IT IS NOT CONTENTION WITH ANOTHER LOOP, and that was worth measuring rather
than assuming. A 4-writer/6-reader workload produced ZERO lock errors on the
shipped settings, and a bulk-transaction workload produced zero too (it did show
the rollback journal costing 48x the throughput of WAL, which is a separate
finding). The only thing that reproduces the error is the nesting.

PRINTS WHAT IT PARSED. A checker that can answer "none" because it matched
nothing is the defect it is looking for.

AND IT STRIPS STRINGS FIRST. The first version matched `risk_cfg(k,v,t)` inside
a SQL literal and reported `svc/risk.py` as holding a nested connection it does
not hold. CLAUDE.md rule 2, earned again.
"""

import io
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")

NESTED = {
    "cfg": "cfg() opens its own db() connection",
    "log_event": "log_event() opens its own db() connection",
    "send_tg": "send_tg() calls cfg(), which opens its own db() connection",
}

SLOW = {
    "guarded_get": "outbound HTTP GET",
    "requests": "outbound HTTP",
    "urlopen": "outbound HTTP",
    "sleep_ticking": "sleep",
    "subprocess": "subprocess",
}

OPEN_RE = re.compile(r"^(\s*)with\s+db\(\)\s+as\s+(\w+)\s*:")

# Triple-quoted first, then single-line, so a docstring is not eaten one quote
# at a time. Escapes inside a literal are consumed by the alternation itself.
_STR_RE = re.compile(
    '"""[\\s\\S]*?"""'
    "|'''[\\s\\S]*?'''"
    '|"(?:[^"\\\\]|\\\\.)*"'
    "|'(?:[^'\\\\]|\\\\.)*'"
)

CALL_RE = {
    name: re.compile("(?<![A-Za-z0-9_])" + re.escape(name) + "\\s*[(.]")
    for name in list(NESTED) + list(SLOW)
}


def strip_code(line):
    """Comments and STRING LITERALS are not calls."""
    return _STR_RE.sub('""', line.split("#")[0])


def scan(path):
    src = io.open(path, encoding="utf-8").read().splitlines()
    hits = []
    blocks = 0
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
            code = strip_code(nxt)
            if code.lstrip().startswith("def "):
                continue
            for name, what in list(NESTED.items()) + list(SLOW.items()):
                if CALL_RE[name].search(code):
                    hits.append((i + 1, j + 1, what, nxt.strip()[:74]))
                    break
    return hits, blocks


def main():
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("build", "venv", "__pycache__", "dist")]
        files += [os.path.join(dirpath, f) for f in filenames if f.endswith(".py")]

    total = 0
    findings = []
    for f in sorted(files):
        hits, blocks = scan(f)
        total += blocks
        rel = os.path.relpath(f, ROOT).replace("\\", "/")
        findings += [(rel, h) for h in hits]

    print("PARSED: %d python files, %d `with db()` blocks" % (len(files), total))
    if total == 0:
        print("FAIL: parsed no transaction blocks at all - the pattern is wrong, not the code")
        return 2

    print("CALLS INSIDE AN OPEN TRANSACTION THAT MUST NOT BE THERE: %d" % len(findings))
    for rel, (wline, cline, what, text) in findings:
        print("  %s:%d  (%s, transaction opened at line %d)" % (rel, cline, what, wline))
        print("      %s" % text)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
