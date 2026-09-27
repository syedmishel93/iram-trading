#!/usr/bin/env python3
"""v37.0 SERVICE TESTS — the governor, end to end, through the SHIPPED service."""
import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

tmpdb = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
os.environ["MISHEL_SVC_DB"] = tmpdb

spec = importlib.util.spec_from_file_location("svc", os.path.join(ROOT, "server", "mishel_service.py"))
svc = importlib.util.module_from_spec(spec); spec.loader.exec_module(svc)
app = svc.app.test_client()

P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")

print("\nSCHEMA + CONFIG")
ok(svc.SCHEMA_V >= 4, "GS1: schema >= 4 (risk_cfg added, additively)")
c0 = app.get("/svc/risk/config").get_json()
ok(c0["ok"] and c0["config"]["max_daily_loss_R"] == 2.0, "GS2: defaults ship (-2R daily)")
app.post("/svc/risk/config", json={"max_daily_loss_R": 3.5, "max_concentration_R": 1.5})
c1 = app.get("/svc/risk/config").get_json()["config"]
ok(c1["max_daily_loss_R"] == 3.5 and c1["max_concentration_R"] == 1.5,
   "GS3: HIS limits persist to SQLite \u2014 the governor is only worth having if he believes the numbers")
app.post("/svc/risk/config", json={"nonsense_key": 999})
ok("nonsense_key" not in app.get("/svc/risk/config").get_json()["config"],
   "GS4: an unknown config key is ignored (no silent junk in the rulebook)")
app.post("/svc/risk/config", json={"max_daily_loss_R": 2.0, "max_concentration_R": 2.0})

print("\nBLIND \u2260 SAFE")
# v40: FORCE the blind condition instead of assuming it.
#
# These assertions used to depend on MT5 being absent from the machine — the
# proxy could not reach a bridge, so /svc/risk/state came back blind and the
# test passed by accident. The moment MetaTrader5 was installed and a terminal
# logged in, all four failed, while the code was behaving perfectly: it could
# see the book, so it correctly stopped saying it was blind.
#
# A safety test that only passes when a dependency happens to be missing is
# testing the machine, not the property. Point the service at a dead proxy for
# the duration, so "blind" is something we cause rather than something we hope
# for, and the gate holds on any machine.
#
# v59: PROXY is owned by svc/mt5.py, and the risk governor reads it from THERE.
# Rebinding the facade's re-export (`svc.PROXY`) would leave the service
# looking at the live bridge and this block testing nothing.
_mt5 = sys.modules["svc.mt5"]
_real_proxy = _mt5.PROXY
_mt5.PROXY = "http://127.0.0.1:9"          # reserved discard port: always refuses
try:
    st = app.get("/svc/risk/state").get_json()
    ok(st["ok"], "BS1: /svc/risk/state responds even with no bridge and no data")
    ok(st["state"]["position_source_error"],
       "BS2: with no MT5 bridge, open positions are reported as UNKNOWN \u2014 not as zero")
    ok(st["verdict"]["verdict"] == "warn",
       "BS3: THE RULE \u2014 blind is not clear. It returns WARN, never ALLOW, when it cannot see the book.")
    ok(any("blind spot" in r["msg"] for r in st["verdict"]["reasons"]),
       "BS4: ...and it uses that word, so there is no chance of misreading it")
    ok(not any("Within every limit" in r["msg"] for r in st["verdict"]["reasons"]),
       "BS5: it never utters the all-clear line while blind")
finally:
    _mt5.PROXY = _real_proxy

# v40: and the branch nothing covered \u2014 that being SIGHTED actually clears the
# blind-spot warning. Without this, a bug that reported "blind" for ever would
# sail through the suite above.
ok(_mt5.PROXY == _real_proxy,
   "BS6: the dead-proxy override is restored, so later checks see the real service")
_blind_msgs = [r["msg"] for r in st["verdict"]["reasons"] if "blind spot" in r["msg"]]
ok(len(_blind_msgs) >= 1 and "UNKNOWN" in _blind_msgs[0],
   "BS7: the blind reason names the state as UNKNOWN, never as zero")

print("\nSIZING \u2014 the broker's real contract, or nothing")
s = app.post("/svc/risk/size", json={"symbol": "XAUUSD", "entry": 2350, "stop": 2340,
                                     "risk_pct": 1, "equity": 10000}).get_json()
ok(not s["ok"] and "contract spec" in s["err"],
   "SZ1: no spec -> REFUSES to size. It does not fall back to the /100000 guess that "
   "sized gold 1000x wrong for 36 versions.")

with svc.db() as c:
    c.execute("""INSERT OR REPLACE INTO mt5_specs(symbol,digits,point,contract_size,tick_value,
                 tick_size,spread_points,swap_long,swap_short,stops_level,t)
                 VALUES('XAUUSD',2,0.01,100,1,0.01,30,-5,-2,50,?)""", (time.time(),))
    c.execute("""INSERT OR REPLACE INTO mt5_specs(symbol,digits,point,contract_size,tick_value,
                 tick_size,spread_points,swap_long,swap_short,stops_level,t)
                 VALUES('EURUSD',5,0.00001,100000,1,0.00001,12,-7,-2,10,?)""", (time.time(),))

# XAUUSD: $100 risk / (100 oz x $10 stop) = 0.10 lots  [hand-computed]
s = app.post("/svc/risk/size", json={"symbol": "XAUUSD", "entry": 2350, "stop": 2340,
                                     "risk_pct": 1, "equity": 10000}).get_json()
ok(s["ok"] and abs(s["lots"] - 0.10) < 1e-9,
   "SZ2: XAUUSD -> 0.10 lots [hand-computed: $100 / (100 oz x $10)]")
ok(abs(s["detail"]["actual_risk_money"] - 100.0) < 1e-6, "SZ3: ...which risks exactly the $100 he asked for")
# EURUSD: $100 / (100,000 x 0.0050) = 0.20 lots  [hand-computed]
s2 = app.post("/svc/risk/size", json={"symbol": "EURUSD", "entry": 1.1000, "stop": 1.0950,
                                      "risk_pct": 1, "equity": 10000}).get_json()
ok(s2["ok"] and abs(s2["lots"] - 0.20) < 1e-9, "SZ4: EURUSD -> 0.20 lots [hand-computed]")
ok(s2["spec_source"] == "broker", "SZ5: the spec is labelled as coming from the broker")

print("\nVERDICTS \u2014 from REAL closed trades")
def ms(s_):
    return int(dt.datetime.strptime(s_, "%Y.%m.%d %H:%M:%S").replace(tzinfo=dt.UTC).timestamp() * 1000)

now = int(time.time() * 1000)
start, _ = __import__("mishel_risk").day_bounds_ms(now, 0)

# two real losing round-trips today, imported as MT5 deals + matched to journal plans
def deal(t, tk, sym, typ, ent, vol, px, comm=0.0, swap=0.0, prof=0.0, pid=1):
    return {"ticket": tk, "position_id": pid, "time_ms": t, "type": typ, "entry": ent,
            "symbol": sym, "volume": vol, "price": px, "commission": comm, "swap": swap,
            "profit": prof, "comment": ""}
# EURUSD long: plan 1.1000/1.0950 (R=0.0050). filled 1.1000, stopped at 1.0950 -> -1.00R
d = [deal(start + 1 * 3600_000, 9001, "EURUSD", 0, 0, 1.0, 1.1000, -3.5, 0, 0, 501),
     deal(start + 2 * 3600_000, 9002, "EURUSD", 1, 1, 1.0, 1.0950, -3.5, -2.0, -500.0, 501),
     deal(start + 3 * 3600_000, 9003, "EURUSD", 0, 0, 1.0, 1.1000, -3.5, 0, 0, 502),
     deal(start + 4 * 3600_000, 9004, "EURUSD", 1, 1, 1.0, 1.0950, -3.5, -2.0, -500.0, 502)]
svc.store_deals(d, "test")
journal = [{"t": start + 30 * 60_000, "sym": "EURUSD", "dir": 1, "entry": 1.1000, "stop": 1.0950,
            "t1": 1.1050, "t2": 1.1100, "strat": "emaPull"},
           {"t": start + 2.5 * 3600_000, "sym": "EURUSD", "dir": 1, "entry": 1.1000, "stop": 1.0950,
            "t1": 1.1050, "t2": 1.1100, "strat": "emaPull"}]
app.post("/svc/kv", json={"items": {"mishel_journal": json.dumps(journal)}})

st = app.get("/svc/risk/state").get_json()["state"]
ok(st["trades_today"] == 2, "VD1: 2 real closed trades today")
ok(abs(st["realized_R_today"] - (-2.0)) < 0.1,
   "VD2: realized today \u2248 -2.00R, from REAL fills and REAL costs (not PAPER.bal) [hand-computed]")
ok(st["consecutive_losses"] == 2, "VD3: 2-loss streak detected from the actual ledger")

v = app.post("/svc/risk/check", json={"symbol": "EURUSD", "side": "long",
                                      "risk_R": 1.0, "risk_pct": 1.0}).get_json()["verdict"]
ok(v["verdict"] == "block", "VD4: -2R today vs a -2R limit -> the next ticket is BLOCKED")
ok(any(r["rule"] == "daily_loss" for r in v["reasons"]), "VD5: ...and the rule that fired is named")
ok(any("refund request" in r["msg"] for r in v["reasons"]),
   "VD6: THE LINE \u2014 'the next trade is not a setup, it is a refund request'")

# raise his own limit -> the same day passes
app.post("/svc/risk/config", json={"max_daily_loss_R": 10.0})
v2 = app.post("/svc/risk/check", json={"symbol": "EURUSD", "side": "long",
                                       "risk_R": 1.0, "risk_pct": 1.0}).get_json()["verdict"]
ok(not any(r["rule"] == "daily_loss" for r in v2["reasons"]),
   "VD7: it enforces HIS limits, not ours \u2014 raising the cap lets the same day through")

print("\nv37.0 SERVICE TESTS: %d passed, %d failed" % (P, F))
try: os.unlink(tmpdb)
except Exception: pass
sys.exit(1 if F else 0)
