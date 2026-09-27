"""FOUR DEFECT CLASSES THIS PROJECT HAS ALREADY PAID FOR, ASKED OF EVERY MODULE.

`classsweep.py` does this for five frontend classes. These four are the backend's,
and each one is taken from an incident recorded in CLAUDE.md rather than invented:

  1. A TUPLE-RETURNING FUNCTION READ AS ONE VALUE.
     `yf_bars` answers `(rows, reason)`. `bars_loop` did `rows = yf_bars(...)`, so
     `rows` was the TUPLE; `if not rows` is never true for a 2-tuple; and `_clean`
     skips a row it cannot read BY DESIGN, so it returned [] without raising.
     MEASURED: the success path and the failure path were byte-for-byte identical
     from outside -- no exception, no log, a fresh tick age and a green dot -- and
     the hourly top-up had never stored a single bar in its life.

  2. A CONFIG KEY READ BY SOMETHING AND WRITTEN BY NOTHING.
     `bars_loop` read its enrolment from a key one module read and zero modules
     wrote, so it ticked hourly, reported a fresh tick age, and produced no work
     for a whole release. "A LOOP WITH NO WRITER FOR ITS INPUT reports healthy and
     does nothing."

  3. A TABLE WRITTEN AND NEVER READ, OR READ AND NEVER WRITTEN.
     `db_wallets` had a POST to fill it and no GET to read it back; `onchain_seen`
     had 40 rows of real data and no route at all; `/svc/edge/kinds` answered empty
     forever because its writer had no caller. Three backlog items, one shape.

  4. `str.rstrip("/suffix")` USED AS SUFFIX REMOVAL.
     It takes a SET OF CHARACTERS, so it eats any trailing `/`, `s`, `u`, `f`, `i`
     or `x` too. CLAUDE.md lists this under Do-not; it was caught in review inside
     `run.py`'s own banner.

PRINTS WHAT IT PARSED, AND A ZERO IN THE PARSE COLUMN IS A FAILURE, because a
sweep that matches nothing and reports a clean tree is the defect it looks for.

Findings are TRIAGED, not trusted: `REVIEWED` carries a reason per entry, since an
allowlist without one becomes a way to silence the tool rather than answer it.
"""

from __future__ import annotations

import ast
import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")

#: `build/` holds a venv and a PyInstaller work tree. An audit that walks it
#: reports FastAPI's own docstring examples as routes of this product -- which
#: `scratchpad/routes.py` did on its first run, over 7,789 files.
SKIP = {"build", "__pycache__", ".git", "node_modules", "venv"}


def walk() -> list[str]:
    out = []
    for dirpath, dirnames, filenames in os.walk(SERVER):
        dirnames[:] = [d for d in dirnames if d not in SKIP]
        for f in filenames:
            if f.endswith(".py"):
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def rel(p: str) -> str:
    return os.path.relpath(p, ROOT).replace("\\", "/")


# REVIEWED AND CORRECT AS WRITTEN. Reason per entry.
REVIEWED: dict[tuple[str, str], str] = {}

findings: list[tuple[str, str, int, str]] = []
parsed: dict[str, int] = {}


def add(cls: str, path: str, line: int, text: str) -> None:
    key = (cls, "%s:%s" % (rel(path), text[:40]))
    if key in REVIEWED:
        return
    findings.append((cls, rel(path), line, text.strip()[:110]))


# ============================================================ 1. TUPLE RETURNS
# Built from the AST, not a regex: `return a, b` and `x = f(...)` are both
# structural, and a regex over source text cannot tell a tuple return inside a
# nested function from one in the outer.
def tuple_returning(tree: ast.AST) -> dict[str, int]:
    """Function name -> tuple arity, for functions whose EVERY return is a tuple.

    Every return, not any: a function that returns a tuple on one branch and a
    single value on another has an ambiguous contract and a caller reading one
    name may be correct. Those are reported by nothing here, deliberately -- the
    defect being swept is an UNAMBIGUOUS tuple read as a scalar.
    """
    out = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        rets = [n for n in ast.walk(node) if isinstance(n, ast.Return) and n.value is not None]
        # Only returns belonging to THIS function, not to a nested one.
        inner = {id(n) for f in ast.walk(node)
                 if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef)) and f is not node
                 for n in ast.walk(f) if isinstance(n, ast.Return)}
        rets = [r for r in rets if id(r) not in inner]
        if not rets or len(rets) < 2:
            continue
        arities = {len(r.value.elts) if isinstance(r.value, ast.Tuple) else 0 for r in rets}
        if len(arities) == 1 and arities.pop() >= 2:
            out[node.name] = len(rets)
    return out


def scan_tuple_reads(files: list[str]) -> None:
    producers: dict[str, str] = {}
    trees: dict[str, ast.AST] = {}
    for p in files:
        try:
            t = ast.parse(io.open(p, encoding="utf-8").read())
        except SyntaxError:
            continue
        trees[p] = t
        for name in tuple_returning(t):
            producers[name] = rel(p)
    parsed["functions returning a tuple on every path"] = len(producers)

    for p, t in trees.items():
        for node in ast.walk(t):
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if not isinstance(target, ast.Name):
                continue  # a tuple target IS the correct read
            call = node.value
            if not isinstance(call, ast.Call):
                continue
            fn = call.func
            # BARE NAMES ONLY.
            #
            # The first run resolved `fn.attr` too, so `c = sqlite3.connect(...)`
            # and `si = _MT5.symbol_info(name)` were reported against
            # `mt5_bridge.connect` and `mt5_bridge.symbol_info` -- three findings,
            # all of them somebody else's function that happens to share a name.
            # An attribute call carries an object this sweep cannot resolve, and
            # guessing is how `deskshape.py` came to report "GRIDS: 0".
            #
            # It still catches the defect it exists for: `rows = yf_bars(...)` is
            # a bare name. `--selftest` proves that rather than asserting it.
            name = fn.id if isinstance(fn, ast.Name) else None
            if name in producers:
                add("tuple-read-as-scalar", p, node.lineno,
                    "%s = %s(...)  -- %s returns a tuple (defined in %s)"
                    % (target.id, name, name, producers[name]))


# ======================================================== 2. CONFIG WITHOUT WRITER
# MATCHED ON RAW SOURCE. A config key IS a string literal, so stripping literals
# would delete the thing being looked for -- the mistake made twice in one session,
# once by stripping "POST" out of a sweep for modules that POST.
CFG_READ = re.compile(r"\bcfg\s*\(\s*[\"']([\w.:-]+)[\"']")
CFG_WRITE = re.compile(r"INSERT\s+INTO\s+config|UPDATE\s+config|set_cfg\s*\(")


def scan_config_keys(files: list[str]) -> None:
    reads: dict[str, tuple[str, int]] = {}
    write_lines: list[str] = []
    for p in files:
        src = io.open(p, encoding="utf-8").read()
        for m in CFG_READ.finditer(src):
            reads.setdefault(m.group(1), (p, src[: m.start()].count("\n") + 1))
        for i, ln in enumerate(src.splitlines(), 1):
            if CFG_WRITE.search(ln):
                write_lines.append(ln)
    parsed["config keys read"] = len(reads)
    parsed["config write statements"] = len(write_lines)

    # A key is WRITTEN if its literal appears on any writing line, or anywhere in
    # the frontend (the client writes several through /svc/* routes).
    front = ""
    app = os.path.join(ROOT, "app", "src")
    if os.path.isdir(app):
        for dirpath, dirnames, filenames in os.walk(app):
            dirnames[:] = [d for d in dirnames if d not in SKIP]
            for f in filenames:
                if f.endswith((".ts", ".tsx")):
                    front += io.open(os.path.join(dirpath, f), encoding="utf-8",
                                     errors="replace").read()
    # A KEY MENTIONED ONCE IN THE WHOLE TREE CANNOT BE SET BY ANYTHING.
    #
    # The first version asked whether the key literal appeared on a line that
    # also writes config -- and every real writer here is PARAMETERISED
    # (`INSERT INTO config(k,v) VALUES(?,?)` with the key in a variable), so it
    # reported `tg_token` and `tg_chat` as unwritable when `svc/alerts.py` has a
    # route for exactly that. Counting MENTIONS is the honest question: one
    # mention is the read itself and nothing else knows the name; two or more
    # means something else refers to it and this sweep cannot say what.
    everywhere = front
    for p in files:
        everywhere += io.open(p, encoding="utf-8", errors="replace").read()
    for key, (p, line) in sorted(reads.items()):
        mentions = everywhere.count('"%s"' % key) + everywhere.count("'%s'" % key)
        if mentions > 1:
            continue
        # An env-var fallback is a legitimate setter and is not a SQL statement.
        if re.search(r"[\"'][A-Z_]*%s[\"']" % re.escape(key.upper()), everywhere):
            continue
        add("config-read-never-written", p, line,
            'cfg("%s") is read here and the name appears nowhere else' % key)


# ========================================================= 3. TABLES ONE-WAY
DDL = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)", re.I)


def scan_tables(files: list[str]) -> None:
    schema = os.path.join(SERVER, "db", "schema.py")
    if not os.path.exists(schema):
        parsed["tables declared"] = 0
        return
    tables = sorted(set(DDL.findall(io.open(schema, encoding="utf-8").read())))
    parsed["tables declared"] = len(tables)

    blob = ""
    for p in files:
        if p == schema:
            continue
        blob += io.open(p, encoding="utf-8", errors="replace").read()

    for t in tables:
        # `INSERT OR IGNORE INTO` and `INSERT OR REPLACE INTO` put words BETWEEN
        # the verb and the table. The first version's `INSERT\s+INTO` missed all
        # of them and reported `onchain_seen`, `sig_fired` and `wallet_events` as
        # written by nothing -- three tables this product demonstrably fills.
        wrote = re.search(
            r"(INSERT(\s+OR\s+\w+)?\s+INTO|UPDATE|REPLACE\s+INTO)\s+%s\b" % t, blob, re.I)
        read = re.search(r"FROM\s+%s\b|JOIN\s+%s\b" % (t, t), blob, re.I)
        if wrote and not read:
            add("table-written-never-read", schema, 1,
                "%s is written and never selected from" % t)
        elif read and not wrote:
            add("table-read-never-written", schema, 1,
                "%s is read and written by nothing" % t)


# ====================================================== 4. rstrip AS SUFFIX STRIP
RSTRIP = re.compile(r"\.(rstrip|lstrip)\s*\(\s*[\"']([^\"']{2,})[\"']\s*\)")


def scan_strip(files: list[str]) -> None:
    n = 0
    for p in files:
        src = io.open(p, encoding="utf-8", errors="replace").read()
        for i, ln in enumerate(src.splitlines(), 1):
            for m in RSTRIP.finditer(ln):
                n += 1
                arg = m.group(2)
                # DECODE THE ESCAPES FIRST. `rstrip("\r")` is ONE character, and
                # counting the source text called it two and reported my own
                # correct line -- rule 2 of Working style, broken by the tool
                # written to apply it.
                try:
                    arg = arg.encode("ascii", "backslashreplace").decode("unicode_escape")
                except (UnicodeDecodeError, UnicodeEncodeError):
                    pass
                # A run of ONE repeated character is a genuine character-set strip
                # (`rstrip("//")`, `strip("  ")`). A word is a suffix mistake.
                if len(set(arg)) == 1:
                    continue
                add("strip-takes-characters-not-a-suffix", p, i,
                    '.%s("%s") removes CHARACTERS, not that suffix' % (m.group(1), arg))
    parsed["strip calls with a multi-char argument"] = n


#: The `bars_loop` defect as it actually was, so the sweep is PROVED against the
#: incident rather than trusted. CLAUDE.md: "delete the fix and watch the test
#: fail before believing it" — an audit owes the same.
SELFTEST = '''
def yf_bars(sym, tf, n):
    try:
        rows = fetch(sym)
        if not rows:
            return [], "no data from vendor"
        return rows, None
    except Exception as e:
        return [], str(e)

def bars_loop():
    rows = yf_bars("BTCUSD", "1h", 300)   # THE DEFECT: rows is the TUPLE
    if not rows:
        return
    _clean(rows)

def correct_caller():
    rows, why = yf_bars("BTCUSD", "1h", 300)
    return rows
'''


def selftest() -> int:
    import tempfile
    d = tempfile.mkdtemp(prefix="svcsweep-selftest-")
    p = os.path.join(d, "fixture.py")
    io.open(p, "w", encoding="utf-8").write(SELFTEST)
    findings.clear()
    scan_tuple_reads([p])
    hits = [f for f in findings if f[0] == "tuple-read-as-scalar"]
    print("SELFTEST: the bars_loop defect, reinstated")
    for cls, path, line, text in hits:
        print("  line %d  %s" % (line, text))
    ok = len(hits) == 1 and "rows = yf_bars" in hits[0][3]
    print("  -> %s" % ("CAUGHT, and the correct caller was not flagged" if ok
                       else "NOT CAUGHT - this sweep would not have found the incident"))
    findings.clear()
    return 0 if ok else 2


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    files = walk()
    parsed["python files"] = len(files)
    svc = [f for f in files if os.sep + "svc" + os.sep in f]
    parsed["svc modules"] = len(svc)

    scan_tuple_reads(files)
    scan_config_keys(files)
    scan_tables(files)
    scan_strip(files)

    print("PARSED:")
    for k, v in parsed.items():
        print("  %-46s %d" % (k, v))
    zeros = [k for k, v in parsed.items() if v == 0]
    if zeros:
        print("FAIL: parsed ZERO of: %s - the pattern is wrong, not the tree"
              % ", ".join(zeros))
        return 2

    print()
    CLASSES = ["tuple-read-as-scalar", "config-read-never-written",
               "table-written-never-read", "table-read-never-written",
               "strip-takes-characters-not-a-suffix"]
    by: dict[str, list[tuple[str, int, str]]] = {}
    for cls, path, line, text in findings:
        by.setdefault(cls, []).append((path, line, text))
    for cls in CLASSES:
        hits = by.get(cls, [])
        print("%-38s %d" % (cls, len(hits)))
        for path, line, text in hits:
            print("    %s:%d  %s" % (path, line, text))

    if REVIEWED:
        print()
        print("REVIEWED AND ALLOWED (%d):" % len(REVIEWED))
        for (cls, where), why in sorted(REVIEWED.items()):
            print("  %-38s %s" % (cls, where))
            print("      %s" % why)

    print()
    print("TOTAL UNRESOLVED: %d" % len(findings))
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
