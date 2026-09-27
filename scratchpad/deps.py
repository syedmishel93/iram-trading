"""
deps.py <file> <from> <to> [<func>]

Which depth-1 locals of <func> (default mountShell) does the line range use,
and which of the range's own declarations are read outside it? Comments and
strings are stripped first (CLAUDE.md rule 2). Destructured declarations are
included, multi-line ones too, which extract.py is documented to miss.
"""

import re
import sys

#: An identifier that is not a property access. `.x` is a member; `...x` is a
#: SPREAD of the local `x`, and treating it as a member once dropped every
#: spread-read dependency from the count with no symptom at all.
NOT_MEMBER = r"(?<![\w$])(?:(?<=\.\.\.)|(?<!\.))"

BS = chr(92)
QUOTES = ('"', "'", "`")


def strip(src: str) -> str:
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append("\n" * src.count("\n", i, j))
            i = j
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append("\n" * src.count("\n", i, j))
            i = j
        elif c in QUOTES:
            q, j = c, i + 1
            while j < n:
                if src[j] == BS:
                    j += 2
                    continue
                if src[j] == q:
                    j += 1
                    break
                j += 1
            out.append("\n" * src.count("\n", i, j))
            i = j
        else:
            out.append(c)
            i += 1
    return "".join(out)


def declarations(code: list[str], func: str) -> tuple[dict[str, int], int, int]:
    start = next(i for i, l in enumerate(code) if f"function {func}" in l)
    depth, body_depth, decl, end = 0, None, {}, len(code) - 1
    for i in range(start, len(code)):
        line = code[i]
        if body_depth is not None and depth == body_depth:
            m = re.match(r"\s*(?:export\s+)?(?:const|let|var|function\*?|async function|class)\s+(\w+)", line)
            if m:
                decl[m.group(1)] = i + 1
            m = re.match(r"\s*(?:const|let|var)\s+\{", line)
            if m:
                j, buf = i, line[m.end():]
                while "}" not in buf:
                    j += 1
                    buf += " " + code[j]
                for part in buf[: buf.index("}")].split(","):
                    name = part.split(":")[-1].split("=")[0].strip()
                    if re.fullmatch(r"\w+", name):
                        decl[name] = i + 1
        for ch in line:
            if ch == "{":
                depth += 1
                if body_depth is None:
                    body_depth = depth
            elif ch == "}":
                depth -= 1
        if body_depth is not None and depth < body_depth:
            end = i
            break
    return decl, start, end


def word(n: str) -> str:
    return NOT_MEMBER + re.escape(n) + r"(?![\w$])"


def main() -> None:
    path, lo, hi = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    func = sys.argv[4] if len(sys.argv) > 4 else "mountShell"
    raw = open(path, encoding="utf-8").read().replace("\r\n", "\n")
    code = strip(raw).split("\n")
    decl, start, end = declarations(code, func)
    rng = "\n".join(code[lo - 1:hi])
    used = set(re.findall(NOT_MEMBER + r"([A-Za-z_$][\w$]*)", rng))
    inside = {n for n, ln in decl.items() if lo <= ln <= hi}
    deps = sorted((n for n in used if n in decl and n not in inside), key=lambda n: decl[n])
    outside = "\n".join(code[start:lo - 1] + code[hi:end + 1])
    exports = sorted(n for n in inside if re.search(word(n), outside))
    code_lines = sum(1 for l in code[lo - 1:hi] if l.strip())
    print(f"range {lo}..{hi}: {hi - lo + 1} lines raw, {code_lines} code; {len(decl)} decls in {func}")
    print(f"deps ({len(deps)}): " + ", ".join(f"{n}@{decl[n]}" for n in deps))
    print(f"exports ({len(exports)}): " + ", ".join(exports))


main()
