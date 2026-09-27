"""Find every eager reactive body that names a binding declared BELOW it.

WHY THIS EXISTS

`core/signal.ts` builds `computed(fn)` as `effect(() => out.set(fn()))`, and an
effect runs IMMEDIATELY. So a computed written above a `const` its body names
throws a temporal-dead-zone ReferenceError at construction, `effect` catches and
logs it, and the computed holds `undefined` for the life of the page.

MEASURED in `ui/playbook.ts`: `combined` and `effective` sat above `all` and
`current`. The console carried one line — `[signal] effect threw
{ReferenceError: Cannot access 'N' before initialization}` — and the Run button
did nothing at all: no note, no visible error, zero DOM mutations. `tsc` cannot
see this, because naming a later binding inside a closure is legal and normally
safe; it is only unsafe when the closure runs at once.

WHAT IT PARSES, PRINTED

Every check prints what it read and a zero fails, because `scratchpad/xref.py`
shipped with two checks that reported "ok" while matching nothing.

HOW IT DECIDES

For each `computed(` / `effect(` / `renderEffect(` call it brace-matches the
body, then looks for identifiers declared by a `const`/`let` at a LATER offset in the
SAME BLOCK.

"Same block" is the part that had to be got right. Same indentation alone
reported 26 findings and 25 were noise — a callback parameter named `r`, or a
`const p` inside a different function at the same nesting depth. The test that
works is: walking forward from the call to the declaration, no line may be
INDENTED LESS than the call, because a shallower line means the block ended and
whatever comes after it is a different scope.

A handler passed to `h()` is not eager and is not checked, which is exactly why
those may name anything.
"""

from __future__ import annotations

import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app", "src")

EAGER = re.compile(r"(^[ \t]*)(?:[\w.]+\s*=\s*)?\b(computed|renderEffect|effect)\s*\(", re.M)
DECL = re.compile(r"^([ \t]*)(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[=:]", re.M)
IDENT = re.compile(r"\b([A-Za-z_$][\w$]*)\b")
#: `name:` — an object key or a type annotation, never a read of the binding.
KEY = re.compile(r"\s*:(?!:)")
#: Anything the body binds for itself: declarations, parameters, catch clauses.
#
# THREE SEPARATE PATTERNS, NOT THREE ALTERNATIVES IN ONE. `finditer` does not
# overlap, so in one combined regex an earlier alternative consumes the `(` that
# the parameter pattern needs and the parameter is silently missed — which is
# how `ref: (el: HTMLInputElement) => {...}` in `data.ts` came back as a
# forward reference to a `const el` fourteen hundred lines below it. Each
# pattern now gets its own pass over the text.
BINDS = (
    re.compile(r"(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)"),
    # The annotation must not cross a `(` or a newline. `[^,)]+` could, so a
    # match beginning at a comma far above swallowed the `(` that the NEXT
    # parameter needed, and `finditer` does not overlap — so `(el: ...)` was
    # never seen and `el` was reported as a forward reference.
    re.compile(r"[(,]\s*([A-Za-z_$][\w$]*)\s*(?::[^,()\n]+)?\s*(?=[,)])"),
    re.compile(r"catch\s*\(\s*([A-Za-z_$][\w$]*)"),
)


def body_of(src: str, open_paren: int) -> str:
    """Text between the call's parentheses, brace/paren matched."""
    depth = 0
    i = open_paren
    while i < len(src):
        c = src[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
            if depth == 0:
                return src[open_paren + 1 : i]
        i += 1
    return ""


def same_block(src: str, frm: int, to: int, indent: str) -> bool:
    """True when nothing between the two offsets leaves the call's block.

    A line indented LESS than the call closes the block the call sits in, so a
    declaration past it belongs to a different scope and cannot be a temporal
    dead zone for this call.
    """
    width = len(indent.expandtabs(2))
    for line in src[frm:to].split("\n")[1:]:
        if not line.strip():
            continue
        if line.lstrip().startswith(("*", "//", "/*")):
            continue
        if len(line) - len(line.lstrip()) < width:
            return False
    return True


#: Comments and string/template literals, in one pass so a quote inside a
#: comment cannot open a string and vice versa.
NOISE = re.compile(
    r"/\*.*?\*/|//[^\n]*|\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`",
    re.S,
)


def strip_noise(s: str) -> str:
    """Blank out comments and string literals, keeping every offset.

    CLAUDE.md's second working rule, and this script broke it: the first version
    reported `flow.ts` naming `idea` because a placeholder read "Describe the
    idea, or add your own rule." Prose in this codebase is long and deliberate,
    so a grep over it over-reports identifiers by roughly a third. Replacing with
    spaces rather than deleting keeps `im.start()` meaningful for the
    member-access check — AND EVERY NEWLINE, or the line numbers it reports are
    wrong. The first version blanked newlines too and pointed at `data.ts:343`,
    a `finally` block, for a `renderEffect` three hundred lines away. A tool
    that reports the wrong location is worse than one that reports nothing,
    because somebody goes and looks.
    """
    return NOISE.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), s)


def body_decls(body: str) -> set[str]:
    """Names the body binds for itself, which therefore shadow anything outside."""
    out: set[str] = set()
    for pat in BINDS:
        for m in pat.finditer(body):
            for g in m.groups():
                if g:
                    out.add(g)
    return out


def scan(path: str) -> list[str]:
    src = strip_noise(open(path, encoding="utf-8").read())
    # Declarations: name -> list of (offset, indent)
    decls: dict[str, list[tuple[int, str]]] = {}
    for m in DECL.finditer(src):
        decls.setdefault(m.group(2), []).append((m.start(), m.group(1)))

    out: list[str] = []
    for m in EAGER.finditer(src):
        indent, kind = m.group(1), m.group(2)
        paren = src.index("(", m.end() - 1)
        body = body_of(src, paren)
        if not body:
            continue
        # NOT EVERY OCCURRENCE OF A NAME IS A READ OF IT. Two kinds of noise
        # made the first version of this report nine findings and zero defects:
        # an OBJECT KEY (`studies: state.studies()` in shell.ts) and a name the
        # body DECLARES ITSELF (`const list = opts.bars()` in paper.ts, which
        # shadows a `list` three functions further down). Neither can be a
        # temporal dead zone, and an audit that reports them is one nobody reads.
        own = body_decls(body)
        seen: set[str] = set()
        for im in IDENT.finditer(body):
            name = im.group(1)
            if name in seen or name not in decls or name in own:
                continue
            if KEY.match(body, im.end()):
                continue
            # `x.group` is a property of x, not the binding `group`.
            if im.start() > 0 and body[im.start() - 1] in ".?":
                continue
            for off, dind in decls[name]:
                if off > m.start() and dind == indent and same_block(src, m.start(), off, indent):
                    line = src.count("\n", 0, m.start()) + 1
                    dline = src.count("\n", 0, off) + 1
                    out.append(
                        "{}:{}  {}(...) names `{}` declared at line {}".format(
                            os.path.relpath(path, ROOT).replace("\\", "/"), line, kind, name, dline
                        )
                    )
                    seen.add(name)
                    break
    return out


def main() -> int:
    files = []
    for base, _dirs, names in os.walk(ROOT):
        for n in names:
            if n.endswith(".ts"):
                files.append(os.path.join(base, n))

    findings: list[str] = []
    for f in sorted(files):
        findings.extend(scan(f))

    print("PARSED : {} TypeScript files under app/src".format(len(files)))
    eager = sum(len(EAGER.findall(open(f, encoding="utf-8").read())) for f in files)
    print("PARSED : {} eager reactive calls (computed / effect / renderEffect)".format(eager))
    if len(files) == 0 or eager == 0:
        print("FAIL   : parsed nothing, so this reported success about nothing")
        return 2

    if findings:
        print("\nFORWARD REFERENCES IN AN EAGER BODY ({}):".format(len(findings)))
        for f in findings:
            print("  " + f)
        return 1
    print("OK     : no eager body names a binding declared below it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
