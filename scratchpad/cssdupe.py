"""TWO DECLARATIONS OF ONE CLASS THAT SET THE SAME PROPERTY DIFFERENTLY.

THE DEFECT THIS FOUND, measured in the browser. `.cal-row` was declared twice in
`desks.css` — the economic calendar's five-column grid at line 522, and the
calibration card's four-column grid 1,280 lines later. The later one won, so the
CALENDAR's rows, which have five children, were laid out on four tracks:

    calendar row   children: 5   computed: 48px minmax(0px, 1fr) 48px 56px

The fifth child wrapped to an implicit row and an 82px time column was squeezed
into 48. Nothing failed, nothing was red, and the desk rendered in another
desk's clothes — the `.sy-` defect this project already records, arriving inside
a single sheet where the cross-sheet prefix audit could not see it.

WHY IT IS NARROWER THAN "DECLARED TWICE"

A first pass flagged any class declared twice with a layout property, and its
first finding was composition rather than collision:

    .sy-cadences, .sy-actions, .sy-guards { display: grid; gap: ... }
    .sy-guards { grid-template-columns: ... }

That is correct CSS and reporting it teaches people to ignore the tool. The
defect is specifically the SAME PROPERTY given DIFFERENT VALUES by two bare
declarations of one class, because then one of them is dead and which one
depends on file order.

PRINTS WHAT IT PARSED. A zero there is a broken pattern, not a clean tree.
"""

import glob
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
STYLES = os.path.join(HERE, "..", "app", "src", "styles")

# A BARE class selector only: `.x {`. `.a .x {`, `.x.y {` and `.x[data-…] {`
# are specialisations and are supposed to override.
BARE = re.compile(r"(?:^|\n)\s*\.([a-zA-Z][\w-]*)\s*\{")

# Properties where a silent override changes the layout rather than the paint.
WATCHED = (
    "display",
    "grid-template-columns",
    "grid-template-rows",
    "flex-direction",
    "position",
)


def decls(body):
    out = {}
    for part in body.split(";"):
        if ":" not in part:
            continue
        k, _, v = part.partition(":")
        k = k.strip().lower()
        if k in WATCHED:
            out[k] = " ".join(v.split())
    return out


def top_level_spans(src):
    """Byte ranges that are NOT inside `@media`, `@supports` or any at-block.

    A rule redeclared inside a media query is the entire point of a media query.
    The first version of this ignored nesting and reported ten responsive
    overrides as conflicts — one of them my own mobile rule — which is the
    "audit that cries wolf" failure: a checker people learn to ignore is worse
    than no checker at all.
    """
    spans = []
    depth = 0
    at_depth = None
    start = 0
    i = 0
    n = len(src)
    while i < n:
        c = src[i]
        if c == "@" and depth == 0:
            j = src.find("{", i)
            semi = src.find(";", i)
            if j > 0 and (semi < 0 or j < semi):
                spans.append((start, i))
                at_depth = depth
                depth += 1
                i = j + 1
                continue
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if at_depth is not None and depth == at_depth:
                at_depth = None
                start = i + 1
        i += 1
    spans.append((start, n))
    return spans


def scan(path):
    src = io.open(path, encoding="utf-8").read()
    spans = top_level_spans(src)

    def top_level(pos):
        return any(a <= pos < b for a, b in spans)

    seen = {}
    hits = []
    for m in BARE.finditer(src):
        if not top_level(m.start()):
            continue
        name = m.group(1)
        end = src.find("}", m.end())
        if end < 0:
            continue
        line = src[: m.start()].count("\n") + 2
        d = decls(src[m.end() : end])
        if not d:
            continue
        prev = seen.get(name)
        if prev is None:
            seen[name] = (line, d)
            continue
        pline, pd = prev
        for k, v in d.items():
            if k in pd and pd[k] != v:
                hits.append((name, k, pline, pd[k], line, v))
        # keep the later one, which is what the browser uses
        merged = dict(pd)
        merged.update(d)
        seen[name] = (line, merged)
    return hits


def main():
    sheets = sorted(glob.glob(os.path.join(STYLES, "*.css")))
    print("PARSED: %d stylesheets" % len(sheets))
    if not sheets:
        print("FAIL: found no stylesheets - the path is wrong, not the tree")
        return 2

    total = 0
    classes = 0
    for p in sheets:
        src = io.open(p, encoding="utf-8").read()
        classes += len(set(BARE.findall(src)))
        for name, prop, l1, v1, l2, v2 in scan(p):
            total += 1
            print("  %s  .%s sets %s twice:" % (os.path.basename(p), name, prop))
            print("      line %-5d %s" % (l1, v1))
            print("      line %-5d %s   <- this one wins" % (l2, v2))
    print("PARSED: %d distinct bare class selectors" % classes)
    if classes == 0:
        print("FAIL: parsed no selectors")
        return 2
    print("CONFLICTING REDECLARATIONS: %d" % total)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())
