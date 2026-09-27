"""THE WHOLE SURFACE, PROBED — every GET route this product declares.

Not a sample and not the ones I happened to be working on. `scratchpad/routes.py`
walks every `@bp.get/@bp.post` under `server/`; this takes the GET half of that
list and actually CALLS each one against the running gateway, so "declared" and
"answers" stop being the same word.

WHAT COUNTS AS BROKEN IS NOT THE STATUS CODE ALONE. A route that answers 200
with `{"ok": false, "error": ...}` is refusing, and a route that answers 200 with
an empty list may be perfectly correct (nothing stored yet) or completely dead.
So three columns are reported and not conflated: the HTTP status, whether the
body carries an explicit refusal, and how big the answer is.

PRINTS WHAT IT PARSED, and a zero fails. A survey that probes nothing and reports
no failures is the defect it exists to find.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server")
BASE = "http://127.0.0.1:8787"

DECL = re.compile(r"""@(?:bp|app)\.get\(\s*["']([^"']+)["']""")

# Routes taking a required path parameter, with a real value to probe them with.
PARAMS = {
    "<symbol>": "BTCUSDT",
    "<sym>": "BTCUSDT",
    "<path:p>": "health",
    "<kind>": "calendar",
    "<key>": "week",
    "<name>": "test",
    "<wallet>": "0x0000000000000000000000000000000000000000",
}

# Query strings for routes that legitimately refuse without one. Probing them
# bare would report a working route as broken, which is its own false alarm.
QUERY = {
    "/ohlc": "?symbol=BTCUSDT&interval=1h&limit=10",
    "/quote": "?symbol=BTCUSDT",
    "/fetch": "?symbol=BTCUSDT",
    "/symbol": "?symbol=BTCUSDT",
    # `sym`/`tf`/`n`, NOT symbol/timeframe/limit. My first probe used the other
    # spelling and reported a 400 against a route that works.
    "/svc/bars": "?sym=BTCUSDT&tf=1h&n=10",
    "/svc/bars/inventory": "",
    "/svc/data/series": "?kind=calendar&key=week",
    "/svc/data/ohlc": "?symbol=BTCUSDT&interval=1h",
    "/quant/stats/structure": "?symbol=BTCUSDT&interval=1h",
}


def declared_gets():
    paths = set()
    files = 0
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in ("build", "venv", "__pycache__", "dist")]
        for f in filenames:
            if not f.endswith(".py"):
                continue
            files += 1
            src = open(os.path.join(dirpath, f), encoding="utf-8").read()
            paths |= set(DECL.findall(src))
    return sorted(paths), files


def fill(path):
    out = path
    for token, value in PARAMS.items():
        out = out.replace(token, value)
    # Anything still in angle brackets has no sample value; skip rather than
    # probe a URL that is meaningless and report a false failure.
    return None if "<" in out else out


def probe(url, timeout=30):
    t0 = time.time()
    try:
        r = urllib.request.urlopen(url, timeout=timeout)
        body = r.read()
        code = r.getcode()
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        code = e.code
    except Exception as e:
        return {"code": 0, "ms": int((time.time() - t0) * 1000), "n": 0,
                "refusal": type(e).__name__, "empty": True}
    ms = int((time.time() - t0) * 1000)
    refusal = ""
    empty = len(body) == 0
    try:
        d = json.loads(body)
        if isinstance(d, dict):
            if d.get("ok") is False:
                refusal = str(d.get("error") or d.get("err") or d.get("why") or "ok:false")[:70]
            # An empty container is worth SEEING, not worth calling a failure.
            vals = [v for v in d.values() if isinstance(v, (list, dict))]
            empty = bool(vals) and all(len(v) == 0 for v in vals)
        elif isinstance(d, list):
            empty = len(d) == 0
    except Exception:
        pass
    return {"code": code, "ms": ms, "n": len(body), "refusal": refusal, "empty": empty}


def main():
    paths, files = declared_gets()
    print("PARSED : %d python files, %d GET routes declared" % (files, len(paths)))
    if not paths:
        print("FAIL: parsed no routes - the pattern is wrong, not the server")
        return 2

    rows = []
    skipped = []
    for p in paths:
        filled = fill(p)
        if filled is None:
            skipped.append(p)
            continue
        url = BASE + filled + QUERY.get(p, "")
        rows.append((p, probe(url)))

    print("PROBED : %d routes (%d skipped: no sample value for a path parameter)"
          % (len(rows), len(skipped)))
    print()

    bad = [(p, r) for p, r in rows if r["code"] == 0 or r["code"] >= 400]
    refusing = [(p, r) for p, r in rows if r["code"] < 400 and r["refusal"]]
    emptyish = [(p, r) for p, r in rows if r["code"] < 400 and not r["refusal"] and r["empty"]]
    fine = [(p, r) for p, r in rows if r["code"] < 400 and not r["refusal"] and not r["empty"]]

    print("ANSWERING WITH CONTENT : %d" % len(fine))
    print("EMPTY BUT NOT REFUSING : %d" % len(emptyish))
    print("REFUSING (200 + ok:false) : %d" % len(refusing))
    print("FAILING (>=400 or unreachable) : %d" % len(bad))
    print()

    if bad:
        print("--- FAILING ---")
        for p, r in sorted(bad, key=lambda x: x[0]):
            print("  %-34s %s  %s" % (p, r["code"] or "unreachable", r["refusal"]))
    if refusing:
        print("--- REFUSING (a stated reason, which may be correct) ---")
        for p, r in sorted(refusing, key=lambda x: x[0]):
            print("  %-34s %s" % (p, r["refusal"]))
    if emptyish:
        print("--- EMPTY (correct if nothing is stored; dead if not) ---")
        for p, r in sorted(emptyish, key=lambda x: x[0]):
            print("  %-34s %d bytes" % (p, r["n"]))

    slow = [(p, r) for p, r in rows if r["ms"] > 3000]
    if slow:
        print()
        print("--- SLOW (>3s) ---")
        for p, r in sorted(slow, key=lambda x: -x[1]["ms"]):
            print("  %-34s %d ms" % (p, r["ms"]))

    if skipped:
        print()
        print("--- NOT PROBED (path parameter with no sample value) ---")
        print("  " + ", ".join(skipped))
    return 0


if __name__ == "__main__":
    sys.exit(main())
