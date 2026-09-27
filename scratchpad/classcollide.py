"""Which two-or-three-letter class PREFIX is claimed by more than one sheet?

The System desk rendered in the STUDY desk's clothes for two releases: both
claim a `.sy-` prefix, `study.css` imports last, and so `.sy-row` resolved to a
six-track grid on a row with two children while `.sy-name` picked up a chip
border it never declares. Nothing failed and nothing was red.

Comparing shared CLASS NAMES is too noisy to act on — `press.css` deliberately
owns the press state of controls declared in six other sheets, and `v5.css` is
a whole design generation written as overrides. A PREFIX is different: it is a
namespace claim, and two desks claiming one is always an accident.

A prefix is reported only when BOTH sheets declare several classes under it,
which is what separates a namespace from a stray name that happens to rhyme.
"""
import io
import os
import re
from collections import defaultdict

S = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src\styles"
MAIN = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src\main.ts"

order = re.findall(r'import "\./styles/([^"]+)"', io.open(MAIN, encoding="utf-8").read())
# Sheets that are overrides BY DESIGN, and say so in their own headers.
BY_DESIGN = {"press.css", "v5.css"}

prefixes = defaultdict(lambda: defaultdict(set))
for f in order:
    p = os.path.join(S, f)
    if not os.path.exists(p) or f in BY_DESIGN:
        continue
    text = re.sub(r"/\*.*?\*/", "", io.open(p, encoding="utf-8").read(), flags=re.S)
    for m in re.finditer(r"([^{}]+)\{", text):
        for c in re.findall(r"\.([a-zA-Z][a-zA-Z0-9_-]*)", m.group(1)):
            if "-" not in c:
                continue
            prefixes[c.split("-", 1)[0]][f].add(c)

MIN = 3
bad = 0
print("%-10s %s" % ("prefix", "sheets that each declare %d+ classes under it" % MIN))
for pre in sorted(prefixes):
    owners = {f: cs for f, cs in prefixes[pre].items() if len(cs) >= MIN}
    if len(owners) < 2:
        continue
    bad += 1
    late = [f for f in order if f in owners][-1]
    print("\n  .%-8s CLAIMED TWICE — %s imports last and wins" % (pre + "-", late))
    for f, cs in owners.items():
        print("      %-16s %2d classes" % (f, len(cs)))
    shared = set.intersection(*owners.values())
    if shared:
        print("      colliding by name: %s" % ", ".join(sorted("." + c for c in shared)))
print("\n%d prefix(es) claimed by more than one sheet." % bad)


# ---------------------------------------------------------------------------
# DUPLICATES WITHIN ONE SHEET.
#
# The original audit compared PREFIXES ACROSS sheets, and missed `.cal-row`
# being declared twice inside `desks.css`: the economic calendar's five-column
# grid and the calibration card's four-column one, 1,280 lines apart. The later
# won, so the calendar was laid out on the wrong grid — measured in the browser
# as `48px minmax(0px, 1fr) 48px 56px` on a row with five children.
#
# A class declared twice in one file is not automatically wrong (a base rule
# plus a state rule is normal), so only BARE, UNQUALIFIED declarations of the
# same class with a `display` or `grid-template-columns` are reported: two
# different layouts for one name is the defect.
# ---------------------------------------------------------------------------

LAYOUT = re.compile(r"(display|grid-template-columns)\s*:", re.I)
BARE = re.compile(r"^\.([a-zA-Z][\w-]*)\s*\{", re.M)


def intra_sheet_duplicates(path):
    src = io.open(path, encoding="utf-8").read()
    seen = {}
    dupes = []
    for m in BARE.finditer(src):
        name = m.group(1)
        end = src.find("}", m.end())
        body = src[m.end():end if end > 0 else m.end()]
        if not LAYOUT.search(body):
            continue
        if name in seen:
            dupes.append((name, seen[name], src[:m.start()].count(chr(10)) + 1))
        else:
            seen[name] = src[:m.start()].count(chr(10)) + 1
    return dupes


def report_intra():
    import glob
    here = os.path.dirname(os.path.abspath(__file__))
    sheets = sorted(glob.glob(os.path.join(here, "..", "app", "src", "styles", "*.css")))
    print()
    print("PARSED: %d stylesheets for intra-sheet layout duplicates" % len(sheets))
    if not sheets:
        print("FAIL: no stylesheets found")
        return 2
    total = 0
    for p in sheets:
        for name, first, second in intra_sheet_duplicates(p):
            total += 1
            print("  %s: .%s declares a layout at line %d AND line %d"
                  % (os.path.basename(p), name, first, second))
    print("INTRA-SHEET LAYOUT DUPLICATES: %d" % total)
    return total


if __name__ == "__main__":
    report_intra()
