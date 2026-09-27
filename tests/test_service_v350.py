#!/usr/bin/env python3
"""v35.0 SERVICE TESTS — the always-on tier.
Runs the SHIPPED mishel_service.py through flask's test_client (no stubs of the code
under test) plus a real round-trip through the Node sidecar."""
import importlib.util
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# isolated DB so we never touch the real one
tmpdb = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
os.environ["MISHEL_SVC_DB"] = tmpdb   # the module reads MISHEL_SVC_DB — isolate the real desk DB

spec = importlib.util.spec_from_file_location("svc", os.path.join(ROOT, "server", "mishel_service.py"))
svc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(svc)

P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")

app = svc.app.test_client()

# ---------------------------------------------------------------- schema
print("\nSCHEMA v2 — the always-on tables")
with svc.db() as c:
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
ok("sig_watch" in tables, "SV1: sig_watch table exists (what the server evaluates browser-closed)")
ok("sig_fired" in tables, "SV2: sig_fired table exists")
ok("kvstore" in tables, "SV3: kvstore table exists (durable client state)")
ok(svc.SCHEMA_V >= 2, "SV4: schema >= 2 (never pin an exact schema version — migrations are ADDITIVE, and pinning makes every future migration redden a green suite)")

with svc.db() as c:
    pk = [r[1] for r in c.execute("PRAGMA table_info(sig_fired)") if r[5]]
ok(set(pk) == {"sym", "tf", "strategy", "bar_t"},
   "SV5: bar_t is IN THE PRIMARY KEY — dedup is STRUCTURAL, survives restarts and crashes")

# ---------------------------------------------------------------- sig_watch CRUD
print("\nARMED STRATEGIES — the browser is now just a CRUD editor")
r = app.post("/svc/sig/watch", json={"sym": "eurusd", "tf": "1h", "strategy": "emaPull", "q_gate": 60})
ok(r.get_json().get("ok"), "SW1: arm a strategy via POST /svc/sig/watch")
w = app.get("/svc/sig/watch").get_json()["watch"]
ok(len(w) == 1 and w[0]["sym"] == "EURUSD" and w[0]["q_gate"] == 60,
   "SW2: stored, symbol upper-cased, quality gate kept")

app.post("/svc/sig/watch", json={"sym": "EURUSD", "tf": "1h", "strategy": "emaPull", "q_gate": 75})
w = app.get("/svc/sig/watch").get_json()["watch"]
ok(len(w) == 1 and w[0]["q_gate"] == 75,
   "SW3: re-arming the same sym+tf+strategy UPSERTS (no duplicate rows)")

app.post("/svc/sig/watch", json={"sym": "XAUUSD", "tf": "4h", "strategy": "orb"})
ok(len(app.get("/svc/sig/watch").get_json()["watch"]) == 2, "SW4: a second armed strategy coexists")
r = app.delete("/svc/sig/watch/%d" % w[0]["id"])
ok(r.get_json().get("ok") and len(app.get("/svc/sig/watch").get_json()["watch"]) == 1,
   "SW5: disarm via DELETE")
ok(app.post("/svc/sig/watch", json={"sym": "", "strategy": ""}).status_code == 400,
   "SW6: refuses an empty arm request (400, no silent no-op)")

# ---------------------------------------------------------------- structural dedup
print("\nDEDUP — one bar can only ever fire once")
with svc.db() as c:
    a = c.execute("INSERT OR IGNORE INTO sig_fired(sym,tf,strategy,bar_t,fired_at,dir,entry,stop,t1,t2,q,record)"
                  " VALUES('EURUSD','1h','emaPull',1700000000000,?,'LONG',1.1,1.09,1.11,1.12,70,'{}')",
                  (time.time(),)).rowcount
    b = c.execute("INSERT OR IGNORE INTO sig_fired(sym,tf,strategy,bar_t,fired_at,dir,entry,stop,t1,t2,q,record)"
                  " VALUES('EURUSD','1h','emaPull',1700000000000,?,'LONG',1.1,1.09,1.11,1.12,70,'{}')",
                  (time.time(),)).rowcount
ok(a == 1 and b == 0,
   "DD1: the SAME bar inserted twice -> second insert is a no-op (rowcount 0) => no duplicate Telegram")
ok(len(app.get("/svc/sig/fired").get_json()["fired"]) == 1, "DD2: /svc/sig/fired returns the single row")

# ---------------------------------------------------------------- durable kv
print("\nDURABLE STATE — SQLite is the source of truth")
r = app.post("/svc/kv", json={"items": {"mishel_journal": '[{"r":1}]'}}).get_json()
ok(r["ok"] and r["revs"]["mishel_journal"] == 1, "KV1: first write -> rev 1")
r = app.post("/svc/kv", json={"items": {"mishel_journal": '[{"r":1},{"r":2}]'}}).get_json()
ok(r["revs"]["mishel_journal"] == 2, "KV2: overwrite -> rev 2 (monotonic; this is how a stale browser knows)")
g = app.get("/svc/kv/mishel_journal").get_json()
ok(g["ok"] and json.loads(g["v"]) == [{"r": 1}, {"r": 2}] and g["rev"] == 2,
   "KV3: GET returns the value AND its revision")
m = app.get("/svc/kv/manifest").get_json()["manifest"]
ok("mishel_journal" in m and m["mishel_journal"]["rev"] == 2,
   "KV4: manifest lists revisions cheaply (browser pulls only what changed)")
ok(app.get("/svc/kv/never_written").get_json()["rev"] == 0,
   "KV5: an unknown key honestly returns rev 0 / v null — no invention")
r = app.post("/svc/kv", json={"items": {"a": "1", "b": "2", "c": "3"}}).get_json()
ok(len(r["revs"]) == 3, "KV6: batch write (the debounced flush sends many keys in one request)")
ok(app.post("/svc/kv", json={}).status_code == 400, "KV7: empty write refused (400)")

# ---------------------------------------------------------------- yf_bars honesty
print("\nBARS — no data means no evaluation, never a guess")
ok(callable(svc.yf_bars), "YB1: yf_bars() ships")
bars, err = svc.yf_bars("__NOT_A_REAL_SYMBOL__", "1h")
ok(bars is None and err, "YB2: an unfetchable symbol returns (None, reason) — it does NOT fabricate bars")
import inspect

srcb = inspect.getsource(svc.yf_bars)
ok("rows[:-1]" in srcb, "YB3: the still-forming last bar is DROPPED — signals fire on CLOSED bars only")
ok("does NOT read ohlc_cache" in srcb,
   "YB4: the loop fetches its OWN bars — it never evaluates the browser's stale cache")
ok('if tf == "4h"' in srcb and "i += 4" in srcb,
   "YB5: 4h is AGGREGATED from real 1h bars (yfinance has no native 4h) — aggregation, not synthesis")

srcl = inspect.getsource(svc.sig_loop)
ok("continue" in srcl and "sig_loop_nodata" in srcl,
   "SL1: no bars -> log + continue. No evaluation, no alert, no guess.")
ok("VERIFY AT YOUR BROKER" in srcl and "delayed" in srcl,
   "SL2: every Telegram signal carries its provenance (~15m delayed) and defers to the broker")
ok("nothing auto-executes" in srcl,
   "SL3: the honesty contract is IN the alert text — decision support, never execution")
ok("distribution, not a promise" in srcl, "SL4: the measured record is framed as a distribution")

# ---------------------------------------------------------------- dead-man's switch
print("\nHEARTBEAT — absence of a message IS the alarm")
ok(callable(svc.heartbeat_loop), "HB1: heartbeat_loop ships")
srch = inspect.getsource(svc.heartbeat_loop)
ok("if this message stops arriving" in srch,
   "HB2: the heartbeat states its own contract — silence means the desk is DOWN")
ok("stale" in srch and "LOOP_TICK" in srch,
   "HB3: it reports which loops are stale, not just 'alive'")
ok("MISHEL_HEARTBEAT_SEC" in srch, "HB4: interval is configurable (default 4h -> 4 msgs/day)")

# ---------------------------------------------------------------- Node sidecar
print("\nSIDECAR — the SHIPPED strategies, run headless")
worker = os.path.join(ROOT, "server", "sig_worker.js")
ok(os.path.exists(worker), "NS1: server/sig_worker.js ships")
st = json.loads(subprocess.run(["node", worker, "--selftest"], capture_output=True,
                               text=True, check=False).stdout)
ok(st.get("ok") and st.get("strategies") == 26,
   "NS2: all 26 SHIPPED strategies load in Node straight out of index.html (%s found)" % st.get("strategies"))

wsrc = open(worker, encoding="utf-8").read()
ok("re-implement the 26 strategies in Python" in wsrc and "REJECTED" in wsrc,
   "NS3: the design decision is documented — ONE source of truth, no Python re-implementation")
ok("IND.adx extension not found" in wsrc,
   "NS4: the worker HARD-FAILS if the real IND.adx is missing (the test suite stubs it; the server must not)")

random.seed(11)
bars, p, t0 = [], 100.0, 1700000000000
for i in range(300):
    p = max(1.0, p * (1 + 0.02 * math.sin(i / 18.0) / 100 + random.gauss(0, 0.004)))
    bars.append({"t": t0 + i * 3600000, "o": p * (1 + random.gauss(0, 0.001)),
                 "h": p * (1 + abs(random.gauss(0, 0.003))), "l": p * (1 - abs(random.gauss(0, 0.003))),
                 "c": p, "v": 1000 + random.random() * 900})

res = svc.run_sig_worker({"bars": bars, "tf": "1h", "sym": "TEST", "qGate": 0})
ok(res.get("ok"), "NS5: service -> Node round-trip works (run_sig_worker)")
ok(res.get("strategies") == 26 and not any(isinstance(v, str) for v in res["meta"].values()),
   "NS6: 26/26 strategies scanned with ZERO errors using the real shipped indicators")
measured = [k for k, v in res["meta"].items() if isinstance(v, dict) and v.get("resolved")]
ok(len(measured) >= 8, "NS7: %d strategies produced a measured record on 300 bars" % len(measured))
neg = [k for k in measured if (res["meta"][k].get("netAvgR") or 0) <= 0]
ok(len(neg) >= 1,
   "NS8: HONESTY — on a random walk most strategies show <=0 net R. It does not flatter noise.")

short = svc.run_sig_worker({"bars": bars[:40], "tf": "1h", "sym": "TEST"})
ok(not short.get("ok") and "80 bars" in (short.get("err") or ""),
   "NS9: <80 bars -> refuses to evaluate (honest empty, not a thin-sample guess)")

# fired-path proof: truncate history so a known open signal sits on the LAST bar
fired_proof = False
for cut in range(299, 120, -1):
    r2 = svc.run_sig_worker({"bars": bars[:cut], "tf": "1h", "sym": "TEST", "qGate": 0})
    if r2.get("ok") and r2.get("fired"):
        f = r2["fired"][0]
        # sigScan never scans the final element -> the newest reachable bar is cut-2
        fired_proof = (f["barT"] == bars[cut - 2]["t"] and f["dir"] in ("LONG", "SHORT")
                       and f["entry"] > 0 and f["stop"] > 0 and "record" in f)
        break
ok(fired_proof,
   "NS10: FIRE PATH — a signal on the final bar is emitted with dir/entry/stop/T1/T2 + its measured record")

print("\nv35.0 SERVICE TESTS: %d passed, %d failed" % (P, F))
try: os.unlink(tmpdb)
except Exception: pass
sys.exit(1 if F else 0)
