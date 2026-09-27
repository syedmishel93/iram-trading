"""Every backend route, and whether anything in the frontend ever calls it.

WHY THIS EXISTS

CLAUDE.md: "28 of 74 backend routes are never called by the frontend... This is
the largest single source of 'the product has functions I cannot use' and it is
a wiring problem, not a missing-feature one." It also warns that the figure goes
stale — the entry before it said "36 of 48", measured two releases earlier — so
this re-measures rather than quoting.

WHAT IT PARSES, PRINTED

Every check prints what it read and a zero fails, because `scratchpad/xref.py`
shipped with two checks that reported "ok" while matching nothing.

HOW IT DECIDES

A route is CALLED when its path appears in `app/src` outside a comment or a
string that is plainly prose. Paths are matched by their literal prefix up to
the first `<` parameter, because a client builds `/svc/bars/${id}` from a
template and the server declares `/svc/bars/<id>`.

Comments and string literals are NOT stripped here, deliberately — a URL in this
codebase only ever appears inside a string, so stripping them would leave
nothing to match. That inverts rule 2 of Working style for a good reason and
says so, rather than leaving it as silent drift.
"""

from __future__ import annotations

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
APP = os.path.join(ROOT, "app", "src")

#: `@bp.get("/svc/x")`, `@app.route("/y", methods=[...])`, `@bp.post(...)`.
ROUTE = re.compile(
    r"@(?:bp|app)\.(get|post|put|delete|patch|route)\(\s*[\"']([^\"']+)[\"']", re.M
)
#: A `methods=` list on `@app.route`.
METHODS = re.compile(r"methods\s*=\s*\[([^\]]*)\]")


def read(path: str) -> str:
    """Read a source file whatever it is encoded in.

    One file under `server/` is not UTF-8, and an audit that dies on it would
    report on a subset while looking like it had read everything. Replacing the
    undecodable bytes is right here: this is looking for ASCII route paths, and
    a mangled character cannot be one.
    """
    return io.open(path, encoding="utf-8", errors="replace").read()


#: Directories that are not this product's code. The first version of this
#: script walked `server/build/venv` and reported FastAPI's own DOCSTRING
#: EXAMPLES as uncalled routes — `/items/`, `/users/me`, `/send-notification/`
#: — which is the audit-that-parses-the-wrong-thing trap in its purest form:
#: 7,789 files read, 123 "routes" found, and most of them somebody else's
#: documentation.
SKIP = ("__pycache__", "build", "venv", "site-packages", "node_modules", "dist", "engine")


def py_files(base: str) -> list[str]:
    out = []
    for d, _dirs, names in os.walk(base):
        if any(os.sep + p in d + os.sep or d.endswith(os.sep + p) for p in SKIP):
            continue
        for n in names:
            if n.endswith(".py"):
                out.append(os.path.join(d, n))
    return out


def ts_text() -> str:
    parts = []
    for d, _dirs, names in os.walk(APP):
        for n in names:
            if n.endswith(".ts"):
                parts.append(read(os.path.join(d, n)))
    return "\n".join(parts)


def main() -> int:
    files = py_files(SERVER)
    routes: list[tuple[str, str, str]] = []  # (verb, path, file)
    for f in files:
        src = read(f)
        rel = os.path.relpath(f, ROOT).replace("\\", "/")
        for m in ROUTE.finditer(src):
            verb, path = m.group(1).upper(), m.group(2)
            if verb == "ROUTE":
                tail = src[m.end() : m.end() + 200]
                mm = METHODS.search(tail)
                verb = (
                    ",".join(v.strip().strip("\"'") for v in mm.group(1).split(","))
                    if mm
                    else "GET"
                )
            routes.append((verb, path, rel))

    app_src = ts_text()

    print("PARSED : {} python files under server/".format(len(files)))
    print("PARSED : {} routes declared".format(len(routes)))
    print("PARSED : {:,} characters of app/src".format(len(app_src)))
    if not files or not routes or len(app_src) < 10000:
        print("FAIL   : parsed nothing worth reporting on")
        return 2

    called: list[tuple[str, str, str]] = []
    orphan: list[tuple[str, str, str]] = []
    for verb, path, rel in routes:
        # `/svc/bars/<id>` (Flask) and `/api/lab/studies/{job_id}` (FastAPI) are
        # both built as `${...}` templates by the client, so match the fixed
        # head. Splitting on `<` alone reported every FastAPI route with a
        # parameter as uncalled.
        head = re.split(r"[<{]", path)[0].rstrip("/")
        if head and head in app_src:
            called.append((verb, path, rel))
        else:
            orphan.append((verb, path, rel))

    print()
    print("CALLED FROM app/src : {}".format(len(called)))
    print("NEVER CALLED        : {}".format(len(orphan)))
    print()
    by_file: dict[str, list[str]] = {}
    for verb, path, rel in sorted(orphan, key=lambda x: (x[2], x[1])):
        by_file.setdefault(rel, []).append("{:<6} {}".format(verb, path))
    for rel, rows in by_file.items():
        print("  {}  ({})".format(rel, len(rows)))
        for r in rows:
            print("      " + r)
    return 0


if __name__ == "__main__":
    sys.exit(main())
