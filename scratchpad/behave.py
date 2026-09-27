"""WHAT EACH SERVICE MODULE COMPUTES — one behavioural invariant per module.

WHY THIS IS NOT `probe.py`

`probe.py` asks whether a route ANSWERS. This project already records why that is
not enough: the Quant desk reported all nineteen libraries present while every
request went to the literal path `() => quantBase()/quant/health`. A 200 is not a
correct answer, and the three defects found in this session's audits were all
found by reading a body rather than a status:

  * `/svc/events/summary` called eleven jobs failing when one was — no recency
    bound, so a DELETED job was reported failing forever.
  * `store_budget_gb` was read by the eviction policy and settable by nothing,
    while the refusal it raises advises raising it.
  * `/svc/claims/stats` published four buckets that did not sum to the fifth:
    31 `expired` claims counted in `total` and named nowhere.

So each check below asserts something about CONTENT — an arithmetic identity, an
ordering, a unit, a bracket — and PRINTS THE NUMBERS IT CHECKED. A check that
cannot say what it saw is a check nobody can audit.

SKIPS ARE COUNTED AND REASONED. A module whose only surface is destructive
(`bulkfetch` downloads, `alerts` sends) is skipped BY NAME with its reason rather
than quietly dropped — "a probe that quietly narrows is the defect it exists to
find". A zero in the checked column fails the run.

Run with the gateway up:  python run.py    then    python scratchpad/behave.py
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from itertools import pairwise

BASE = "http://127.0.0.1:8787"
TIMEOUT = 30

results: list[tuple[str, str, bool, str]] = []
skips: list[tuple[str, str]] = []


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=TIMEOUT) as f:
        return json.loads(f.read().decode("utf-8", "replace"))


def _post(payload, origin=None):
    """A JSON-RPC POST to /mcp. Returns (status, body). Read-only by choice: the
    only methods used here list or refuse, and none turns the server on."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + "/mcp", data=data,
                                 headers={"Content-Type": "application/json"})
    if origin:
        req.add_header("Origin", origin)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as f:
            return f.status, json.loads(f.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def post_rpc(payload):
    return _post(payload)[1]


def post_rpc_status(payload, origin=None):
    return _post(payload, origin)[0]


def check(module: str, what: str, ok: bool, detail: str) -> None:
    results.append((module, what, bool(ok), detail))


def skip(module: str, why: str) -> None:
    skips.append((module, why))


# --------------------------------------------------------------------- bars --
def c_bars():
    d = get("/svc/bars?sym=BTCUSDT&tf=1h&n=200")
    bars = d.get("bars") or []
    if not bars:
        skip("bars", "the archive holds no BTCUSDT 1h to check ordering on")
        return
    ts = [b["t"] for b in bars]
    # THE CONTRACT THE WHOLE BACKTESTER RESTS ON. A repeated timestamp reaching
    # the engine is what made every autonomous sweep report "85 could not be
    # studied" — a bulk refusal with no cause, for releases.
    check("bars", "timestamps ascending and unique",
          all(b > a for a, b in pairwise(ts)),
          "%d bars, %d distinct" % (len(ts), len(set(ts))))
    bad = [b for b in bars
           if not (b["l"] <= min(b["o"], b["c"]) and b["h"] >= max(b["o"], b["c"]))]
    check("bars", "every bar's high and low bracket its open and close",
          not bad, "%d of %d violate it" % (len(bad), len(bars)))
    # A 1h series whose spacing is not an hour is a mislabelled series.
    gaps = {b - a for a, b in pairwise(ts)}
    check("bars", "1h spacing really is one hour (gaps aside)",
          3_600_000 in gaps, "distinct gaps seen: %s" % sorted(gaps)[:4])


# -------------------------------------------------------------------- store --
def c_store():
    d = get("/svc/store/inventory")
    series = d.get("series") or []
    total = sum(s.get("bytes", 0) for s in series)
    check("store", "the reported total equals the sum of its parts",
          total == d.get("bytes"),
          "sum(series)=%d reported=%d" % (total, d.get("bytes", -1)))
    check("store", "usage is inside the budget it reports",
          d.get("bytes", 0) <= d.get("budget_bytes", 0),
          "%.2f GB of %.2f GB" % (d.get("bytes", 0) / 2**30, d.get("budget_bytes", 1) / 2**30))
    # The budget is now settable (v63.3); it must agree with what is stored.
    st = get("/svc/settings")
    row = next((s for s in st["settings"] if s["key"] == "store_budget_gb"), None)
    check("store", "the inventory's budget matches the setting that controls it",
          row is not None and abs(float(row["value"]) * 2**30 - d["budget_bytes"]) < 2,
          "setting=%s GB inventory=%.3f GB" % (row and row["value"], d["budget_bytes"] / 2**30))


# ----------------------------------------------------------------- research --
def c_research():
    d = get("/svc/claims/stats")
    groups = [d["all"], *d.get("bySymbol", []), *d.get("bySetup", [])]
    bad = [g for g in groups
           if g["decided"] + g["pending"] + g["unknowable"] + g.get("expired", 0) != g["total"]]
    check("research", "every claims group accounts for all of its claims",
          not bad,
          "%d groups, %d that do not add up" % (len(groups), len(bad)))
    rated = [g for g in groups if g.get("hitRate") is not None]
    off = [g for g in rated if not (g["low"] <= g["hitRate"] <= g["high"])]
    check("research", "each interval contains its own rate",
          not off, "%d rated groups, %d whose interval excludes it" % (len(rated), len(off)))
    wrong = [g for g in rated if abs(g["hitRate"] - g["hits"] / g["decided"]) > 1e-9]
    check("research", "the rate is hits over decided",
          not wrong, "%d checked, %d disagree with their own counts" % (len(rated), len(wrong)))
    # A NULL RATE IS NOT A ZERO. A population with nothing decided must refuse.
    undecided = [g for g in groups if g["decided"] == 0]
    check("research", "a group with nothing decided reports no rate rather than 0%",
          all(g.get("hitRate") is None for g in undecided),
          "%d undecided groups" % len(undecided))


# -------------------------------------------------------------------- core --
def c_core():
    d = get("/svc/events/summary")
    kinds = d["kinds"]
    failing = [k for k in kinds if k["failing"]]
    check("core", "the failing total is the sum of the failing kinds",
          sum(k["failed"] for k in failing) == d["failingTotal"],
          "%d failing kinds, total %d" % (len(failing), d["failingTotal"]))
    # THE RECENCY BOUND (v63.2): nothing older than the window may be `failing`.
    stale = [k for k in failing if k["ageS"] is not None and k["ageS"] > d["staleAfterS"]]
    check("core", "nothing that stopped recurring is reported as failing now",
          not stale,
          "window %ds; %d quiet kinds held apart" % (d["staleAfterS"], d["quietKinds"]))
    check("core", "failing and quiet are disjoint",
          not [k for k in kinds if k["failing"] and k["quiet"]],
          "%d kinds total" % len(kinds))
    check("core", "every kind's count is at least its failure count",
          all(k["failed"] <= k["n"] for k in kinds),
          "checked %d kinds" % len(kinds))


# ---------------------------------------------------------------------- mt5 --
def c_mt5():
    d = get("/svc/mt5/status")
    clock = (d.get("bridge") or {}).get("clock") or {}
    if not clock:
        skip("mt5", "no broker bridge attached, so there is no clock to check")
    else:
        # A LABEL THAT DISAGREES WITH ITS NUMBER is the worst kind of readout.
        off_h = clock.get("offset_s", 0) / 3600
        label = clock.get("label", "")
        check("mt5", "the clock label matches the measured offset",
              label == "UTC%+d" % round(off_h),
              "label %s, measured %+.1f h" % (label, off_h))
    c = get("/svc/costs")
    specs = c.get("specs") or {}
    if not specs:
        skip("mt5", "no broker specs imported, so there are no costs to check")
        return
    bad = [k for k, v in specs.items()
           if not (v.get("contract_size", 0) > 0 and v.get("point", 0) > 0)]
    check("mt5", "every spec has a positive contract size and point",
          not bad, "%d specs, %d incomplete" % (len(specs), len(bad)))
    # THE DUAL FILING (v62.x): a broker suffix and the canonical name both
    # resolve, or sizing silently finds nothing after a successful sync.
    canon = [k for k in specs if "." not in k]
    check("mt5", "specs are filed under the canonical name as well as the broker's",
          len(canon) > 0,
          "%d canonical of %d keys" % (len(canon), len(specs)))


# ----------------------------------------------------------------- features --
def c_features():
    import time
    d = get("/svc/data/snapshot")
    # MEASURED: it returns a BARE LIST of rows. The first version assumed a dict
    # and crashed with `'list' object has no attribute 'get'` -- reported as a
    # module failure when it was the probe's. Read the shape, do not assume it.
    if isinstance(d, list):
        rows = d
    else:
        rows = d.get("rows") or d.get("snapshot") or d.get("items") or []
    if not rows:
        skip("features", "the feature store returned no rows in a shape this reads")
        return
    now = time.time()
    stamps = [r.get("t") or r.get("stored_at") for r in rows if isinstance(r, dict)]
    stamps = [t for t in stamps if isinstance(t, (int, float))]
    check("features", "every stored value carries a timestamp",
          len(stamps) == len(rows), "%d of %d rows stamped" % (len(stamps), len(rows)))
    # A FUTURE TIMESTAMP pins a feed as permanently fresh and stops it refetching.
    future = [t for t in stamps if t > now + 60]
    check("features", "nothing is stamped in the future",
          not future, "%d stamps, %d ahead of now" % (len(stamps), len(future)))


# ------------------------------------------------------------------ onchain --
def c_onchain():
    d = get("/svc/onchain/pairs")
    rows = d.get("pairs") or d.get("rows") or []
    if not rows:
        skip("onchain", "no new pairs recorded yet")
        return
    # AN OPAQUE KEY PARSED WRONG puts the chain in the address column and
    # NOTHING looks wrong, because an address is opaque to the reader too.
    swapped = [r for r in rows
               if isinstance(r.get("address"), str) and isinstance(r.get("chain"), str)
               and len(r["chain"]) > len(r["address"])]
    check("onchain", "chain and address are not swapped",
          not swapped, "%d pairs, %d suspicious" % (len(rows), len(swapped)))
    missing = [r for r in rows if not r.get("chain") or not r.get("address")]
    check("onchain", "every pair has both halves of its key",
          not missing, "%d incomplete of %d" % (len(missing), len(rows)))


# ------------------------------------------------------------------- router --
def c_router():
    """`/svc/router/health` is about the SERVICE, not about a trained model.

    The first version asserted `skill` appeared here and failed: the route
    answers `engine`, `minRows`, `ok`, `why` -- which is correct, because skill
    is a property of a fitted model and lives in the TRAIN report. Asserting the
    wrong route's shape reports a defect in working code, which is the failure
    mode a checker can least afford.
    """
    d = get("/svc/router/health")
    check("router", "the service names its engine and its sample floor",
          bool(d.get("engine")) and isinstance(d.get("minRows"), int),
          "engine=%s minRows=%s" % (str(d.get("engine"))[:34], d.get("minRows")))


# ----------------------------------------------------------------- settings --
def c_settings():
    d = get("/svc/settings")
    rows = d["settings"]
    check("settings", "every setting names the module that reads it",
          all(r.get("readBy") for r in rows), "%d settings" % len(rows))
    check("settings", "chosen and defaulted are distinguishable",
          all(isinstance(r.get("isDefault"), bool) for r in rows),
          "%d defaulted" % sum(1 for r in rows if r["isDefault"]))
    # NOT a substring search for "token". The first version failed on the word
    # inside "when the scanner finds a newly listed token" -- a sentence about
    # crypto, in the copy. A credential check that fires on English prose is one
    # people switch off, and the real question is narrower: are the FIELDS the
    # whitelisted ones, and is any credential KEY present.
    allowed = {"key", "value", "default", "isDefault", "what", "readBy"}
    stray = sorted({k for r in rows for k in r} - allowed)
    check("settings", "the listing carries only the fields it declares",
          not stray, "unexpected fields: %s" % (stray or "none"))
    body = json.dumps(d).lower()
    creds = [n for n in ("svc_token", "tg_token", "access_token", "refresh_token",
                         "client_secret", "password") if n in body]
    check("settings", "no credential key appears in the listing",
          not creds, "searched 6 credential names, found %s" % (creds or "none"))


# ---------------------------------------------------------------------- mcp --
def c_mcp():
    d = get("/svc/mcp/servers")
    check("mcp", "the registry answers with a list",
          isinstance(d.get("servers"), list), "%d registered" % len(d.get("servers") or []))
    s = get("/svc/mcp/signin-status")
    body = json.dumps(s)
    check("mcp", "sign-in status carries no token",
          "access_token" not in body and "Bearer" not in body, "body %d bytes" % len(body))


# ------------------------------------------------------------- mcp server --
def c_mcpserve():
    """THE OTHER DIRECTION: this terminal published AS an MCP server.

    Every check here is READ-ONLY and none of them turns the server on. The
    point is the invariants that decide whether it is safe, not whether it
    answers -- `probe.py` already answers that, and a route replying 200 is
    exactly the evidence this project keeps recording as insufficient.
    """
    st = get("/svc/mcp/serve/state")
    listed = [t["name"] for t in st.get("tools") or []]
    withheld = [w["name"] for w in st.get("wontPublish") or []]

    # ONE FACT, ONE OWNER. The card reads `state.tools`; a client reads
    # `tools/list` over JSON-RPC. Two lists naming the same thing will disagree,
    # and nothing would say so -- `views.ts` and `toolsmenu.ts` managed 0 of 24.
    rpc = post_rpc({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    over_rpc = sorted(t["name"] for t in (rpc.get("result") or {}).get("tools") or [])
    check("mcpserve", "the card's tool list and the client's agree",
          bool(listed) and over_rpc == sorted(listed),
          "state=%d rpc=%d" % (len(listed), len(over_rpc)))

    # An allowlist is only an allowlist if nothing withheld is also published.
    both = sorted(set(listed) & set(withheld))
    check("mcpserve", "nothing withheld is also published",
          bool(listed) and bool(withheld) and not both,
          "%d published, %d withheld, %d in both" % (len(listed), len(withheld), len(both)))

    # A snippet describing a server that is not there is worse than none.
    try:
        cfg_url = st["clientConfig"]["mcpServers"]["iram-terminal"]["url"]
    except Exception:
        cfg_url = ""
    check("mcpserve", "the setup snippet points at the address it reports",
          cfg_url == st.get("url"), "snippet=%s state=%s" % (cfg_url, st.get("url")))

    # THE DNS-REBINDING GUARD. A browser always sends Origin and an MCP client
    # never does, so any Origin means a page is calling. Under the gateway's
    # deliberately permissive loopback CORS regex this is the only thing
    # standing between a page on some other localhost port and the account.
    code = post_rpc_status({"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                           origin="http://evil.test")
    check("mcpserve", "a browser Origin is refused", code == 403, "HTTP %s" % code)

    # A tool call while OFF must refuse rather than answer. If the server is on,
    # that is the operator's choice and this check says so instead of failing.
    if st.get("on"):
        skip("mcpserve", "the operator has it ON, so the off-refusal cannot be observed")
    else:
        r = post_rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                      "params": {"name": "history_inventory", "arguments": {}}})
        res = r.get("result") or {}
        text = "".join(b.get("text", "") for b in res.get("content") or [])
        check("mcpserve", "while off, a tool refuses instead of answering",
              bool(res.get("isError")) and "switched off" in text,
              "isError=%s" % res.get("isError"))
        # AND THE REFUSAL MUST NAME A SCREEN THAT EXISTS. The first version sent
        # the operator to "Settings -> MCP server", which is not where the card
        # is -- they look, fail, and conclude the feature was never built.
        check("mcpserve", "the refusal names where the switch actually is",
              "System desk" in text and "Publish to an AI client" in text,
              "signpost present" if "System desk" in text else "WRONG OR MISSING")

    body = json.dumps(st)
    check("mcpserve", "the state route carries no credential",
          not any(k in body for k in ("access_token", "MISHEL_TOKEN=", "Bearer ey")),
          "body %d bytes" % len(body))


# ------------------------------------------------------------------- health --
def c_health():
    d = get("/api/health")
    b = d.get("background") or {}
    loops = b.get("loops") or {}
    check("core", "the background loops are enabled and reporting",
          bool(b.get("enabled")) and len(loops) > 0,
          "enabled=%s, %d loops reporting" % (b.get("enabled"), len(loops)))


CHECKS = [
    ("bars", c_bars), ("store", c_store), ("research", c_research),
    ("core", c_core), ("mt5", c_mt5), ("features", c_features),
    ("onchain", c_onchain), ("router", c_router), ("settings", c_settings),
    ("mcp", c_mcp), ("mcpserve", c_mcpserve), ("health", c_health),
]

#: Skipped by name, with the reason. Each has only a destructive or
#: side-effecting surface, and a probe that fires those is worse than no probe.
NOT_PROBED = {
    "alerts": "its surface SENDS — Telegram and /svc/notify. Probing it messages the operator.",
    "bulkfetch": "its surface DOWNLOADS gigabytes. /svc/store/evict deletes them.",
    "signals": "arming a strategy is a state change, not a read.",
    "sync": "its routes write the browser's backup; a test already overwrote 13 real slots once.",
    "auto": "starting a sweep is minutes of compute and a state change.",
    "mcpauth": "beginning a sign-in registers a client on a third party's service.",
    "router (skill)": "ACCURACY IS NOT SKILL is the invariant that matters, and it is a "
                      "property of a FITTED model, not of the service. Training is POST and "
                      "minutes of compute; `tests/test_router.py` pins no-skill-on-noise.",
    "risk": "sizing is POST-only; `tests/test_risk_specs.py` covers the money-at-risk identity.",
}


def main() -> int:
    try:
        get("/api/health")
    except (urllib.error.URLError, OSError) as e:
        print("FAIL: no gateway on %s (%s). Start it with `python run.py`." % (BASE, e))
        return 2

    for name, fn in CHECKS:
        try:
            fn()
        except Exception as e:  # noqa: BLE001 - a probe reports, it does not handle
            check(name, "the probe itself ran", False, "%s: %s" % (type(e).__name__, e))

    print("PARSED: %d checks across %d modules" % (len(results), len({r[0] for r in results})))
    if not results:
        print("FAIL: ran no checks, so this reports success about nothing")
        return 2

    print()
    failed = [r for r in results if not r[2]]
    for module, what, ok, detail in results:
        print("  %-9s %-4s %-58s %s" % (module, "ok" if ok else "FAIL", what, detail))

    print()
    print("SKIPPED BY NAME (%d):" % (len(NOT_PROBED) + len(skips)))
    for module, why in sorted(NOT_PROBED.items()):
        print("  %-11s %s" % (module, why))
    for module, why in skips:
        print("  %-11s %s (no data)" % (module, why))

    print()
    print("CHECKS: %d passed, %d failed" % (len(results) - len(failed), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
