"""Which surfaces present a long flat list where a structure would do.

Counts, per UI module, with comments and string bodies left IN (we are counting
markup, not identifiers): top-level panels, prose paragraphs, and whether the
file uses any of the three structures this terminal already has — a disclosure
(`pkWhy`/`pkFold`/`details`), a section switcher (`seg-btn`), or grouping
(`group`/`pk-group`).

A file with many panels or much prose and NONE of the three is the shape the
Data desk was in.
"""
import io
import os
import re

ROOT = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src\ui"

rows = []
for base, _dirs, files in os.walk(ROOT):
    for name in files:
        if not name.endswith(".ts") or name.endswith(".test.ts"):
            continue
        p = os.path.join(base, name)
        s = io.open(p, encoding="utf-8").read()
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        panels = len(re.findall(r'"panel-title"', s))
        prose = len(re.findall(r'prose"', s))
        fold = len(re.findall(r"pkWhy|pkFold|\"details\"", s))
        seg = len(re.findall(r"seg-btn", s))
        grp = len(re.findall(r"pk-group|lib-group|\bgroup:", s))
        if panels >= 3 or prose >= 6:
            rows.append((rel, panels, prose, fold, seg, grp))

rows.sort(key=lambda r: (-(r[1] * 2 + r[2]), r[0]))
print("%-26s %6s %6s %6s %6s %6s   %s" % ("file", "panels", "prose", "fold", "seg", "group", "verdict"))
for rel, panels, prose, fold, seg, grp in rows:
    structured = fold + seg + grp
    verdict = "STRUCTURED" if structured > 0 else "*** FLAT ***"
    print("%-26s %6d %6d %6d %6d %6d   %s" % (rel, panels, prose, fold, seg, grp, verdict))
