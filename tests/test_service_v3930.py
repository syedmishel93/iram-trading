#!/usr/bin/env python3
"""v39.30 — THE GOVERNOR'S BLIND SPOT.

A reachable proxy is not a reachable broker. `requests` does not raise on 4xx/5xx,
so an error payload was being read as "positions: []" — i.e. as the CLAIM that the
account is flat. With an equity typed in Settings, the governor then returned ALLOW
("Risk is not the reason to skip this one") while it could see nothing at all.

v37's own headline was "blind is not clear". These tests cover the path that broke it:
the HTTP-error path, which the v37 suite never exercised (it only faked a connection
exception, and passed for the wrong reason whenever the proxy happened to be down).
"""
import importlib.util
import os
import sys
import tempfile

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

os.environ["MISHEL_SVC_DB"] = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
spec = importlib.util.spec_from_file_location("svc", os.path.join(ROOT, "server", "mishel_service.py"))
svc = importlib.util.module_from_spec(spec); spec.loader.exec_module(svc)
app = svc.app.test_client()

P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")


class Resp:
    """Minimal stand-in for a requests.Response."""
    def __init__(self, status, payload):
        self.status_code = status; self._p = payload
    @property
    def ok(self): return 200 <= self.status_code < 300
    def json(self): return self._p


def with_bridge(positions_resp, account_resp):
    """Point the service's HTTP layer at scripted broker responses."""
    def fake_get(url, *a, **kw):
        if "/mt5/positions" in url: 
            if isinstance(positions_resp, Exception): raise positions_resp
            return positions_resp
        if "/mt5/account" in url:
            if isinstance(account_resp, Exception): raise account_resp
            return account_resp
        raise RuntimeError("unexpected url " + url)
    return fake_get


# `requests` is ONE module object shared by every importer, so patching its
# `get` reaches svc/risk.py wherever that code lives. It used to be reached
# through the service module, which only worked while the facade happened to
# import it — v59 moved the only caller out and the import went with it.
_real_get = requests.get
def state_under(pos_resp, acct_resp):
    requests.get = with_bridge(pos_resp, acct_resp)
    try:
        return app.get("/svc/risk/state").get_json()
    finally:
        requests.get = _real_get


def blind(st):
    """The three things that must ALL hold when the book cannot be read."""
    return (bool(st["state"]["position_source_error"])
            and st["verdict"]["verdict"] != "allow"
            and any("blind spot" in r["msg"] for r in st["verdict"]["reasons"]))


# He is told to type his balance; that must not buy him a false all-clear.
app.post("/svc/kv", json={"k": "mishel_ck_acct", "v": 25000.0, "rev": 1})

ERR = {"error": "MetaTrader5 package not importable: No module named 'MetaTrader5'"}

print("\nA REACHABLE PROXY IS NOT A REACHABLE BROKER")
st = state_under(Resp(502, ERR), Resp(502, ERR))
ok(blind(st), "BG1: proxy up, bridge 502 \u2014 positions are UNKNOWN, verdict is not ALLOW, and it says 'blind spot'")
ok("MetaTrader5" in (st["state"]["position_source_error"] or ""),
   "BG2: the broker's OWN reason is quoted, not a generic shrug")
ok(not any("Within every limit" in r["msg"] for r in st["verdict"]["reasons"]),
   "BG3: THE RULE \u2014 it never utters the all-clear line while blind, even with an equity typed in")

st = state_under(Resp(200, {"ok": True}), Resp(200, {"ok": True}))
ok(blind(st), "BG4: HTTP 200 with no 'positions' key is malformed, not empty \u2014 shape is demanded, not assumed")

st = state_under(Resp(200, {"positions": None}), Resp(200, {"equity": 1000}))
ok(blind(st), "BG5: positions:null is not positions:[]")

st = state_under(ConnectionError("refused"), ConnectionError("refused"))
ok(blind(st), "BG6: the original connection-refused path still reports blind (no regression)")

print("\nA READABLE BROKER READS CLEAN")
POS = [{"symbol": "EURUSD", "type": 0, "volume": 0.2, "price_open": 1.10, "sl": 1.095, "ticket": 1}]
st = state_under(Resp(200, {"positions": POS}), Resp(200, {"equity": 25000.0}))
ok(not st["state"]["position_source_error"], "BG7: a real 200 with a real list clears the flag")
ok(st["state"]["equity_source"] == "MT5 bridge", "BG8: ...and only then is equity labelled as the broker's")
ok(len(st["state"]["open_positions"]) == 1, "BG9: the position is actually carried through")

print("\nTHE LABEL MUST NOT LIE")
st = state_under(Resp(502, ERR), Resp(502, ERR))
ok(st["state"]["equity_source"] != "MT5 bridge",
   "BG10: equity typed by hand is NEVER labelled 'MT5 bridge' \u2014 that label is a claim about provenance")

# The falsy-zero trap, pinned: a real reading of 0 is a reading.
st = state_under(Resp(200, {"positions": []}), Resp(200, {"equity": 0.0}))
ok(not st["state"]["position_source_error"],
   "BG11: an account genuinely reporting equity 0 does not make the POSITION feed blind")

print(f"\nv39.30 BLIND-SPOT TESTS: {P} passed, {F} failed")
sys.exit(1 if F else 0)
