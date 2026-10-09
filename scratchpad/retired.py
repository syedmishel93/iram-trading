r"""Which visible strings still name a desk by a name it no longer has.

`desklabel.test.ts` matches `text: "<exact label>"`, so a SENTENCE containing a
retired name passes it — six did, including an empty state telling the operator
to go to a desk that is not called that any more.

The trap this script exists to measure: six of the fifteen retired labels are
ordinary words (Flow, Paper, Strategy, Results, Connections, Workspace) and
three of those are a PREFIX OF THEIR OWN REPLACEMENT — "Strategy tester"
contains "Strategy". A sweep for the bare word would report the fix as the
defect. So it prints both counts per label and lets the reading decide, rather
than choosing a pattern first and believing its answer.

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

# Only strings a person can READ. A variable called `decision` is not a label.
VISIBLE = re.compile(r'\b(?:text|label|title|detail|placeholder|hint|aria-label)\s*:\s*"((?:[^"\\]|\\.)*)"')

files = 0
strings = 0
rows = []
for root, dirs, names in os.walk(SRC):
    dirs[:] = [d for d in dirs if d not in {"node_modules"}]
    for n in names:
        if not n.endswith(".ts"):
            continue
        path = os.path.join(root, n)
        files += 1
        body = io.open(path, encoding="utf-8", errors="replace").read()
        for m in VISIBLE.finditer(body):
            strings += 1
            text = m.group(1)
            line = body.count("\n", 0, m.start()) + 1
            for was, now in RETIRED:
                desk = re.search(r"\b%s desk\b" % re.escape(was), text)
                bare = re.search(r"\b%s\b" % re.escape(was), text)
                if bare is None:
                    continue
                # "Strategy tester" contains "Strategy": not a stale name.
                if re.search(r"\b%s\b" % re.escape(now), text):
                    kind = "superseded-in-place"
                elif desk is not None:
                    kind = "DESK"
                else:
                    kind = "bare"
                rows.append((kind, was, now, os.path.relpath(path, SRC), line, text))

print("files read: %d, visible strings: %d" % (files, strings))
if files == 0 or strings == 0:
    sys.exit("PARSED NOTHING — a sweep that reads nothing reports a clean tree")

for kind in ("DESK", "bare", "superseded-in-place"):
    hits = [r for r in rows if r[0] == kind]
    print("\n==== %s: %d ====" % (kind, len(hits)))
    for _, was, now, rel, line, text in hits:
        print("  %-28s %s:%d" % ("%s -> %s" % (was, now), rel, line))
        print("      %s" % (text if len(text) < 150 else text[:147] + "..."))
