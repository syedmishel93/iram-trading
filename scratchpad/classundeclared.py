#!/usr/bin/env python3
"""Which classes does the TypeScript apply that NO stylesheet declares?

WHY THIS EXISTS. `ui/cards/mcpservecard.ts` shipped its only action as
`class: "btn"`. This codebase declares no `.btn` anywhere, so the computed style
was a transparent 21px box with no border and the card's switch -- the whole
point of the card -- rendered as plain text. Nothing failed: `tsc` does not read
CSS, no test opens a stylesheet, and a class that matches nothing is legal in
both languages. Same family as the undefined custom property that INHERITS
rather than being ignored, and as `.wl-table`, a class no element has.

WHY IT IS NOT GATED. Most of what it finds is legitimate: a class used only as a
`querySelector` hook needs no rule, and this tree has 99 of them. A check whose
normal state is 99 findings is one people learn to ignore -- the failure mode
`cssdupe.py` was narrowed to avoid. Run it when ADDING a card and read the rows
that belong to the file you just wrote; that is the moment it pays.

It prints WHAT IT PARSED and fails on a zero in either half, because a checker
whose pattern has stopped matching reports a clean tree.
"""

import collections
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent / "app" / "src"
SHEETS = sorted((ROOT / "styles").glob("*.css"))


def main() -> int:
    css = "\n".join(p.read_text(encoding="utf-8", errors="replace") for p in SHEETS)
    declared = set(re.findall(r"\.([A-Za-z][\w-]*)", css))

    used: collections.Counter[str] = collections.Counter()
    where: dict[str, str] = {}
    files = 0
    for p in ROOT.rglob("*.ts"):
        files += 1
        for m in re.finditer(r'class:\s*"([^"]+)"', p.read_text(encoding="utf-8", errors="replace")):
            for c in m.group(1).split():
                used[c] += 1
                where.setdefault(c, p.name)

    print("PARSED: %d stylesheets, %d declared class names" % (len(SHEETS), len(declared)))
    print("PARSED: %d TypeScript files, %d distinct classes applied" % (files, len(used)))
    if not declared or not used:
        print("FAIL: parsed nothing -- the patterns have stopped matching")
        return 1

    missing = {c: n for c, n in used.items() if c not in declared}
    print("UNDECLARED: %d distinct (%d uses)" % (len(missing), sum(missing.values())))
    for c, n in sorted(missing.items(), key=lambda kv: (-kv[1], kv[0])):
        print("    %-28s %2d use(s)   %s" % (c, n, where[c]))
    print("\nA container used only as a querySelector hook is FINE. What is not "
          "fine is a class carrying an intended look that no rule provides.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
