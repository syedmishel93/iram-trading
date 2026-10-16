r"""Which visible strings still name a desk by a name it no longer has.

────────────────────────────────────────────────────────────────────────────
THIS IS THE SECOND VERSION, AND THE FIRST ONE'S BLIND SPOTS ARE THE POINT

The first pass matched `text:`/`label:`/`title:` properties holding a
double-quoted string. It found eleven and reported the class closed. It was
not: three more survived in `ui/briefing.ts` alone, each in a shape the regex
could not see —

    453  a ternary ARM            : "Not scanned yet. Open Opportunities to…"
    484  a TEMPLATE LITERAL       : `${n} more on the Opportunities desk.`
    508  a function ARGUMENT      : pkEmpty("empty", "…the Signals desk.")

— and one of them told the operator to open a desk by a name it has not had
since the rename. That is the same mistake as the guards it replaced: matching
a NAMING CONVENTION rather than the thing itself. `desklabel.test.ts` matched
`text: "<exact label>"`, this matched a slightly wider property list, and both
were shapes rather than the question.

So this version reads EVERY string literal — single, double and template —
outside comments, in the modules that produce what a person reads. The
allowlist is what carries the judgement, because the open question ("is this
string about the desk, or is it ordinary English?") is not one a regex can
answer.

Run: python -I scratchpad/retired.py
"""
import io
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src")

# was -> now, taken from the rename commit's own diff of ui/shell/views.ts.
RETIRED = [
    ("Opportunities", "Scanner"),
    ("Decision", "Confluence"),
    ("Flow", "Derivatives"),
    ("Paper", "Paper trading"),
    ("Analyst", "Ask AI"),
    ("Analyse", "Studies"),
    ("Knowledge", "Edge stats"),
    ("Conditions", "Market regime"),
    ("Connections", "Correlation"),
    ("Strategy", "Strategy tester"),
    ("Signals", "Alerts"),
    ("Results", "Test results"),
    ("Simulation", "Walk-forward"),
    ("Learning", "Track record"),
    ("Workspace", "Layouts"),
]

COMMENT = re.compile(r"/\*[\s\S]*?\*/|//[^\n]*")
# Every string literal: double, single, and template. Templates are the ones
# the first version blanked, and they held a real finding.
LITERAL = re.compile(r'"((?:[^"\\\n]|\\.)*)"' r"|'((?:[^'\\\n]|\\.)*)'" r"|`((?:[^`\\]|\\.)*)`")


def strip_comments(body):
    """Blank comments, keeping newlines so line numbers survive.

    A stripper that collapsed newlines made an earlier tool in this repository
    report every line number wrong by hundreds, and a tool that reports the
    wrong location is worse than one that reports nothing.
    """
    return COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), body)


files = 0
strings = 0
rows = []
for root, dirs, names in os.walk(SRC):
    dirs[:] = [d for d in dirs if d not in {"node_modules"}]
    for n in names:
        if not n.endswith(".ts"):
            continue
        path = os.path.join(root, n)
        rel = os.path.relpath(path, SRC).replace("\\", "/")
        files += 1
        body = strip_comments(io.open(path, encoding="utf-8", errors="replace").read())
        for m in LITERAL.finditer(body):
            text = m.group(1) or m.group(2) or m.group(3) or ""
            if len(text) < 3:
                continue
            strings += 1
            line = body.count("\n", 0, m.start()) + 1
            for was, now in RETIRED:
                if re.search(r"\b%s\b" % re.escape(was), text) is None:
                    continue
                kind = (
                    "superseded" if re.search(r"\b%s\b" % re.escape(now), text)
                    else "DESK" if re.search(r"\b%s desk\b" % re.escape(was), text)
                    else "bare"
                )
                rows.append((kind, was, now, rel, line, text))

print("files read: %d, string literals: %d" % (files, strings))
if files == 0 or strings == 0:
    sys.exit("PARSED NOTHING — a sweep that reads nothing reports a clean tree")

for kind in ("DESK", "bare", "superseded"):
    hits = [r for r in rows if r[0] == kind]
    print("\n==== %s: %d ====" % (kind, len(hits)))
    for _, was, now, rel, line, text in hits:
        print("  %-26s %s:%d" % ("%s -> %s" % (was, now), rel, line))
        print("      %s" % (text if len(text) < 120 else text[:117] + "..."))
