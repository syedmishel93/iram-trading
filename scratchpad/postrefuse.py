#!/usr/bin/env python3
"""DOES EVERY POST ROUTE REFUSE BAD INPUT HONESTLY?

WHY THIS EXISTS. `scratchpad/probe.py` GETs all 68 read routes and reports 0
broken -- and it SKIPS every POST, counting them as skipped, which is the honest
thing for it to do and also a hole you could drive a lorry through. Half this
product's surface writes, and nothing had ever asked what those routes do when
handed nonsense.

WHAT "HONESTLY" MEANS HERE, and it is not "returns 200":

  * A 500 is a FAILURE. It means an exception reached the route, so the operator
    gets a traceback or a blank where a sentence belongs -- "an error message is
    addressed to the operator, not the developer".
  * A 4xx or a body carrying `ok: false` AND A REASON is a PASS. That is this
    product's refusal idiom everywhere else.
  * A 200 with `ok: true` on an EMPTY body is suspicious and is reported as
    such, not as a pass: it means the route accepted nothing as if it were
    something. Some are legitimate (a route whose every field is optional), so
    this prints them for reading rather than failing them.

IT RUNS AGAINST A THROWAWAY DATABASE, ON ITS OWN PORT. This is the whole reason
the script is shaped the way it is. Sending a malformed body to a route that
writes is the only way to learn whether it validates -- and if it does NOT, the
garbage lands in whatever database is behind it. This project has put fixture
rows in the operator's live store SIX times through three different doors. So
the caller starts a second gateway with `MISHEL_SVC_DB` pointing at a temp file
and passes its port; the script REFUSES to run against 8787.

EXCLUDED BY NAME, WITH THE REASON, because a scratch database does not make
them safe -- they reach outside the machine or cost real time and money.
"""

import json
import sys
import urllib.error
import urllib.request

TIMEOUT = 20

#: Reaching outside this machine, or minutes of compute. A temp DB does not help.
EXCLUDED = {
    "/svc/notify": "SENDS to the operator's alert channel; the token can come from the environment",
    "/svc/telegram": "the same, directly",
    "/ai": "costs money and needs a key the operator supplies",
    "/svc/mt5/sync": "talks to the broker bridge",
    "/svc/store/download": "downloads gigabytes from a vendor",
    "/svc/auto/run": "minutes of compute and a state change",
    "/svc/router/train": "minutes of compute",
    "/api/lab/study": "spawns a study worker",
    "/api/lab/studies": "the same, in bulk",
    "/svc/mcp/connect": "registers a client on somebody else's service",
    "/svc/mcp/call": "calls a THIRD PARTY'S MCP server",
    "/svc/news/rss": "fetches from the open internet",
    "/svc/data/ohlc": "fetches from a vendor",
}

#: What a route should never be handed by accident. Each is a body that is
#: WRONG in a different way, because a route can validate one and not another.
BAD_BODIES = [
    ("empty object", b"{}"),
    ("not an object", b'"a string"'),
    ("not JSON at all", b"{{{"),
    ("nulls where values go", b'{"symbol": null, "on": null, "url": null, "n": null}'),
    ("wrong types", b'{"symbol": 42, "on": "yes", "n": "lots", "url": []}'),
]


def post(base, path, body):
    req = urllib.request.Request(base + path, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as f:
            return f.status, f.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001 -- the reason is printed, not raised
        return 0, "could not ask: %s" % type(e).__name__


def verdict(status, text):
    """(kind, note). `kind` is one of pass / CRASH / accepted-nothing / unreachable."""
    if status == 0:
        return "unreachable", text
    if status >= 500:
        return "CRASH", "HTTP %d %s" % (status, text.strip().replace("\n", " ")[:90])
    if 400 <= status < 500:
        return "pass", "HTTP %d, refused" % status
    try:
        body = json.loads(text)
    except ValueError:
        return "pass", "HTTP %d, non-JSON body" % status
    if isinstance(body, dict):
        if body.get("ok") is False or body.get("error") or body.get("err"):
            reason = body.get("err") or body.get("error") or body.get("why") or ""
            return ("pass", "refused: %s" % str(reason)[:60]) if reason else \
                   ("pass-noreason", "ok:false with NO reason given")
        # JSON-RPC shape (the MCP server) refuses inside the envelope.
        if isinstance(body.get("error"), dict):
            return "pass", "jsonrpc error %s" % body["error"].get("code")
    return "accepted-nothing", "HTTP %d and no refusal" % status


def main(argv):
    if len(argv) < 2:
        print("usage: postrefuse.py <base-url>   e.g. http://127.0.0.1:8799")
        return 2
    base = argv[1].rstrip("/")
    if base.endswith(":8787"):
        print("REFUSING: 8787 is the operator's live gateway. Start a second one "
              "with MISHEL_SVC_DB pointed at a temp file and pass its port.")
        return 2

    routes = [r.strip() for r in sys.stdin.read().split() if r.strip().startswith("/")]
    checked = [r for r in routes if r not in EXCLUDED]
    print("PARSED: %d POST routes, %d excluded by name, %d to check"
          % (len(routes), len(routes) - len(checked), len(checked)))
    print("TARGET: %s (NOT the live gateway)\n" % base)
    if not checked:
        print("FAIL: nothing to check -- the route list did not parse")
        return 1

    crashes, loose, noreason, tested = [], [], [], 0
    for path in checked:
        for label, body in BAD_BODIES:
            status, text = post(base, path, body)
            kind, note = verdict(status, text)
            tested += 1
            if kind == "CRASH":
                crashes.append((path, label, note))
            elif kind == "accepted-nothing":
                loose.append((path, label, note))
            elif kind == "pass-noreason":
                noreason.append((path, label, note))

    print("SENT: %d bad bodies across %d routes\n" % (tested, len(checked)))

    print("CRASHED (an exception reached the route -- the operator gets a traceback): %d" % len(crashes))
    for p, lbl, note in crashes:
        print("   %-26s %-22s %s" % (p, lbl, note))

    print("\nREFUSED WITHOUT SAYING WHY (ok:false and no reason): %d" % len(noreason))
    for p, lbl, note in noreason:
        print("   %-26s %-22s %s" % (p, lbl, note))

    print("\nACCEPTED NOTHING AS SOMETHING (200, no refusal) -- read these, some are"
          "\n  legitimate routes whose every field is optional: %d" % len(loose))
    for p, lbl, note in loose:
        print("   %-26s %-22s %s" % (p, lbl, note))

    print("\nEXCLUDED BY NAME (%d):" % len(EXCLUDED))
    for p, why in sorted(EXCLUDED.items()):
        if p in routes:
            print("   %-26s %s" % (p, why))

    return 1 if crashes else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
