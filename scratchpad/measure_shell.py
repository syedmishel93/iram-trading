"""Measure shell.ts: raw lines, code lines after stripping comments and string
literals (CLAUDE.md house rule 2), and every declaration at depth 1 inside
mountShell — which is the list the renovation has to shorten."""
import re
import pathlib

BS = chr(92)
QUOTES = ('"', "'", "`")
ROOT = pathlib.Path(
    r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\app\src"
)


def strip(src: str) -> str:
    """Blank out comments and string/template literals, preserving line count."""
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


def main() -> None:
    p = ROOT / "ui" / "shell.ts"
    raw = p.read_text(encoding="utf-8").replace("\r\n", "\n")
    lines = raw.split("\n")
    code = strip(raw).split("\n")
    nb = [l for l in code if l.strip()]
    print(
        "shell.ts: %d lines raw, %d code lines after stripping, %d%% prose/blank"
        % (len(lines), len(nb), 100 * (len(lines) - len(nb)) // len(lines))
    )

    start = None
    for i, l in enumerate(code):
        if "function mountShell" in l:
            start = i
    if start is None:
        print("mountShell not found")
        return
    depth, j, seen = 0, start, False
    while j < len(code):
        depth += code[j].count("{") - code[j].count("}")
        if code[j].count("{"):
            seen = True
        if seen and depth <= 0:
            break
        j += 1
    print("mountShell: lines %d..%d = %d lines" % (start + 1, j + 1, j - start + 1))

    print("\n=== declarations at depth 1 inside mountShell ===")
    cnt = 0
    for i in range(start, j + 1):
        if re.match(r"^  (const|let|function|async function) ", code[i]):
            cnt += 1
            print("  %5d  %s" % (i + 1, code[i].strip()[:95]))
    print("  --- %d declarations at depth 1" % cnt)


main()
