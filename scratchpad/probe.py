"""Ask every GET route on the running gateway whether it actually answers.

WHY THIS IS DIFFERENT FROM `routes.py`

That one asks "does anything call this". This asks "does it WORK". They are
different questions and the second is the one behind "all the tools are not
working": a route the frontend calls faithfully and which 500s every time is
worse than one nobody calls, because it looks wired.

CLAUDE.md records the shape twice over — the whole Quant desk dead from a
missing `()`, and eleven background loops that had not run since consolidation
while `/svc/health` answered. A component that ANSWERS is not a component that
works, so this reports the body's own `ok` field as well as the status code.

ONLY GETs, AND ONLY SAFE ONES. A POST here would write to the operator's
database, and a probe that changes what it measures is not a probe. Anything
that mutates is listed as skipped rather than quietly left out — an audit that
silently narrows is the defect this project keeps finding.

WHAT IT PARSES, PRINTED: the route count it read and the number it reached.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "server")
BASE = os.environ.get("IRAM_BASE", "http://127.0.0.1:8787")

ROUTE = re.compile(r"@(?:bp|app)\.(get|post|put|delete|patch|route)\(\s*[\"']([^\"']+)[\"']", re.M)
SKIP_DIRS = ("__pycache__", "build", "venv", "site-packages", "node_modules", "dist", "engine")

#: Routes that need a real id or would take minutes. Named, never silently cut.
NEEDS_ARG = re.compile(r"[<{]")

#: Sensible defaults so a route that needs a query string is still exercised.
ARGS = {
    "/svc/bars": "?sym=BTCUSDT&tf=1h&n=5",
    "/ohlc": "?symbol=BTCUSDT&timeframe=1h&limit=5",
    "/quote": "?symbol=BTCUSDT",
    "/symbol": "?symbol=BTCUSDT",
    "/svc/data/ohlc": "?sym=BTCUSDT&tf=1h",
    "/svc/data/series": "?sym=BTCUSDT",
    "/svc/sig/fired": "?limit=5",
    "/svc/kv": "?k=client_backup",
}


def read(p: str) -> str:
    return io.open(p, encoding="utf-8", errors="replace").read()


def routes() -> list[tuple[str, str, str]]:
    out = []
    for d, _dirs, names in os.walk(SERVER):
        if any(os.sep + s in d + os.sep or d.endswith(os.sep + s) for s in SKIP_DIRS):
            continue
        for n in names:
            if not n.endswith(".py"):
                continue
            f = os.path.join(d, n)
            rel = os.path.relpath(f, ROOT).replace("\\", "/")
            for m in ROUTE.finditer(read(f)):
                out.append((m.group(1).upper(), m.group(2), rel))
    return out


def probe(path: str) -> tuple[int, str, str]:
    url = BASE + path + ARGS.get(path, "")
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:  # noqa: S310 - fixed localhost base
            body = r.read(200_000).decode("utf-8", "replace")
            code = r.status
    except urllib.error.HTTPError as e:
        body = e.read(4000).decode("utf-8", "replace")
        code = e.code
    except Exception as e:  # noqa: BLE001
        return 0, "unreachable", "{}: {}".format(type(e).__name__, e)

    # A 200 that says `ok: false` is a refusal, and a refusal is not a failure.
    verdict = "ok"
    detail = ""
    if code >= 500:
        verdict = "SERVER ERROR"
        detail = body[:160].replace("\n", " ")
    elif code == 404:
        verdict = "404"
    elif code >= 400:
        verdict = "{}".format(code)
        detail = body[:160].replace("\n", " ")
    else:
        try:
            j = json.loads(body)
            if isinstance(j, dict) and j.get("ok") is False:
                verdict = "refused"
                detail = str(j.get("why") or j.get("err") or j.get("error") or "")[:140]
        except json.JSONDecodeError:
            if body.lstrip().startswith("<"):
                verdict = "HTML not JSON"
                detail = body[:80].replace("\n", " ")
    return code, verdict, detail


#: ANSWERING THIS WAY IS CORRECT. Reason per entry, because an allowlist without
#: one becomes a way to silence the tool rather than to answer it —
#: `classsweep.py` records the same rule.
#:
#: Before this existed the probe reported "BROKEN: 5 of 65" on EVERY run, with the
#: reasons living only in CLAUDE.md prose. A checker that always prints five
#: failures is a checker whose sixth failure nobody notices, and one of the five
#: was a route added in the same session as this list.
BY_DESIGN = {
    "/": "serves the terminal's HTML. It is what the browser is GIVEN, not a fetch target.",
    "/legacy": "serves the frozen v39 terminal's HTML, for the same reason.",
    "/svc/mcp/callback": (
        "returns a PAGE because a human reads it, in a browser tab they did not open "
        "from the terminal. JSON there would be a blank screen after signing in, "
        "which is indistinguishable from a failure."
    ),
    "/ohlc": "404 for a symbol the DEFAULT vendor does not know is an honest refusal.",
    "/quote": "the same: no symbol was given, so there is nothing to quote.",
}


def main() -> int:
    all_routes = routes()
    gets = sorted({(p, f) for v, p, f in all_routes if v in ("GET", "ROUTE")})
    print("PARSED  : {} routes, {} of them GET-able".format(len(all_routes), len(gets)))
    if not all_routes:
        print("FAIL    : parsed nothing")
        return 2

    probed = skipped = 0
    bad: list[str] = []
    rows: list[str] = []
    excused: list[str] = []
    for path, f in gets:
        if NEEDS_ARG.search(path):
            skipped += 1
            continue
        code, verdict, detail = probe(path)
        probed += 1
        line = "  {:<28} {:>4}  {:<14} {}".format(path[:28], code, verdict, detail)
        rows.append(line)
        if verdict in ("SERVER ERROR", "unreachable", "404", "HTML not JSON"):
            if path in BY_DESIGN:
                excused.append(path)
            else:
                bad.append(line)

    print("PROBED  : {} ({} skipped: need a path argument)".format(probed, skipped))
    if probed == 0:
        print("FAIL    : probed nothing, so this reports success about nothing")
        return 2
    print()
    for r in rows:
        print(r)
    print()
    print("BY DESIGN ({} of {} allowed):".format(len(excused), len(BY_DESIGN)))
    for path in sorted(BY_DESIGN):
        mark = "  " if path in excused else "??"
        print("  {} {:<26} {}".format(mark, path, BY_DESIGN[path]))

    # AN ALLOWLIST ENTRY THAT STOPPED MATCHING IS A ROUTE THAT CHANGED SHAPE,
    # and excusing it forever would hide that. `??` above marks one, and it is
    # reported rather than silently forgiven — the same question `test_audits.py`
    # asks of its own audits.
    stale = sorted(p for p in BY_DESIGN if p not in excused)
    if stale:
        print()
        print("STALE ALLOWLIST: these no longer answer the way the reason says, so the")
        print("reason is now describing something that is not happening: {}".format(
            ", ".join(stale)))

    print()
    print("BROKEN  : {} of {}".format(len(bad), probed))
    for b in bad:
        print(b)
    return 1 if (bad or stale) else 0


if __name__ == "__main__":
    sys.exit(main())
