"""Find every free-text field that is really asking for one of a known set.

WHY THIS EXISTS

The Playbook's Market box is an `<input type="text">`. You have to KNOW that
"XAUUSD" is spelled that way and that the archive holds it — and the desk
already knows both, because it reads the inventory to build its own plan. A
field that asks you to type a value the program can enumerate is undiscoverable
(you cannot see what exists), unforgiving (a typo is a refusal) and
inconsistent (the chart's own symbol box is a picker).

CLAUDE.md records the matching rule from the other direction: a SUBSTRING match
over a CLOSED vocabulary is a false positive waiting, so match the open field
loosely and the closed one exactly. The same distinction decides the control:
an open-ended field is a text box, a closed one is a picker.

WHAT IT PARSES, PRINTED

Every check prints what it read and a zero fails, because `scratchpad/xref.py`
shipped with two checks that reported "ok" while matching nothing.

HOW IT DECIDES

It finds `h("input", { ... type: "text" ... })` in the desks, then reports the
label nearest above it. It cannot know whether a vocabulary exists, so it does
not guess: it prints every one and leaves the judgement to a person, which is
the only honest thing a heuristic can do here.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src", "ui")

NOISE = re.compile(
    r"/\*.*?\*/|//[^\n]*|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`",
    re.S,
)
#: `h("input", {` — the start of an input element in this codebase's builder.
INPUT = re.compile(r'h\(\s*"input"\s*,\s*\{', re.S)
#: A `type:` inside one.
TYPE = re.compile(r'type:\s*"([a-z-]+)"')
#: The nearest `text:`/`label`/`placeholder` above, for naming it.
NEAR = re.compile(r'(?:text|label|placeholder|title):\s*"([^"]{2,60})"')


def blank(s: str) -> str:
    """Strings kept, comments blanked — we need the string CONTENTS here."""
    return re.sub(r"/\*.*?\*/|//[^\n]*", lambda m: re.sub(r"[^\n]", " ", m.group(0)), s, flags=re.S)


def body_of(src: str, open_brace: int) -> tuple[str, int]:
    depth = 0
    i = open_brace
    while i < len(src):
        c = src[i]
        if c in "{([":
            depth += 1
        elif c in "})]":
            depth -= 1
            if depth == 0:
                return src[open_brace : i + 1], i
        i += 1
    return "", len(src)


def scan(path: str) -> list[tuple[int, str, str]]:
    raw = open(path, encoding="utf-8").read()
    src = blank(raw)
    out = []
    for m in INPUT.finditer(src):
        brace = src.index("{", m.end() - 1)
        body, end = body_of(src, brace)
        t = TYPE.search(body)
        kind = t.group(1) if t else "text"
        if kind not in ("text", "search"):
            continue
        # The nearest label-ish string in the 600 characters before it.
        before = src[max(0, m.start() - 600) : m.start()]
        labels = NEAR.findall(before)
        label = labels[-1] if labels else "?"
        line = src.count("\n", 0, m.start()) + 1
        out.append((line, label, kind))
    return out


def main() -> int:
    files = []
    for base, _dirs, names in os.walk(ROOT):
        for n in names:
            if n.endswith(".ts"):
                files.append(os.path.join(base, n))

    total_inputs = 0
    findings: list[str] = []
    for f in sorted(files):
        src = blank(open(f, encoding="utf-8").read())
        total_inputs += len(INPUT.findall(src))
        for line, label, kind in scan(f):
            rel = os.path.relpath(f, ROOT).replace("\\", "/")
            findings.append(f"  {rel}:{line}  [{kind}]  near: {label}")

    print(f"PARSED : {len(files)} desk/ui modules")
    print(f"PARSED : {total_inputs} `h(\"input\")` elements")
    if len(files) == 0 or total_inputs == 0:
        print("FAIL   : parsed nothing, so this reported success about nothing")
        return 2

    print(f"\nFREE-TEXT FIELDS ({len(findings)}):")
    for f in findings:
        print(f)
    print("\nJudgement is a person's: a market name is enumerable here, a note is not.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
