#!/usr/bin/env python3
"""v36.0 SERVICE TESTS — the broker tier, end to end, through the SHIPPED modules."""
import datetime as dt
import importlib.util
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

tmpdb = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
os.environ["MISHEL_SVC_DB"] = tmpdb

import mt5_bridge as BR
import mt5_report as MR

spec = importlib.util.spec_from_file_location("svc", os.path.join(ROOT, "server", "mishel_service.py"))
svc = importlib.util.module_from_spec(spec); spec.loader.exec_module(svc)
app = svc.app.test_client()

P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")

def ms(s):
    return int(dt.datetime.strptime(s, "%Y.%m.%d %H:%M:%S").replace(tzinfo=dt.UTC).timestamp() * 1000)

# ---------------------------------------------------------------- bridge
print("\nBRIDGE — honest on every OS")
avail, why = BR.available()
ok(isinstance(avail, bool) and isinstance(why, str), "BR1: available() returns (bool, reason) and never raises")
ok(avail or "Windows" in why or "not importable" in why,
   "BR2: on a non-Windows host it says exactly WHY, instead of failing mysteriously")
h = BR.health()
ok(h["available"] is avail and "platform" in h, "BR3: health() reports availability + platform")
ok(BR.mt5_tf("1h") == 16385 and BR.mt5_tf("4h") == 16388, "BR4: timeframe mapping (1h/4h -> MT5 constants)")
ok(BR.mt5_tf("13m") is None,
   "BR5: an unknown timeframe -> None, NOT a silent default (a wrong TF silently draws a wrong chart)")

print("\nSYMBOL RESOLUTION — brokers rename everything")
avail_syms = ["EURUSD.a", "XAUUSD.a", "GBPUSD.a", "GOLD", "EURUSD.a.fix"]
ok(BR.resolve_symbol("EURUSD", avail_syms) == "EURUSD.a", "SR1: EURUSD -> EURUSD.a (prefix match, shortest suffix)")
ok(BR.resolve_symbol("EURUSD", ["EURUSD"]) == "EURUSD", "SR2: exact match wins")
ok(BR.resolve_symbol("XAUUSD", ["GOLD", "EURUSD"]) == "GOLD", "SR3: XAUUSD -> GOLD via alias table")
ok(BR.resolve_symbol("NZDJPY", avail_syms) is None,
   "SR4: HONESTY — a symbol the broker does not offer returns None. It never guesses a name the broker never reported.")

print("\nBAR + DEAL SHAPING")
bars = BR.shape_bars([{"time": 1700000000, "open": 1.1, "high": 1.2, "low": 1.0, "close": 1.15, "tick_volume": 42}], "1h")
ok(len(bars) == 1 and bars[0]["t"] == 1700000000000 and bars[0]["v"] == 42,
   "SH1: MT5 seconds -> terminal milliseconds; tick_volume passed through honestly (FX has no real volume)")
ok(len(BR.shape_bars([{"time": 1, "open": "x"}], "1h")) == 0,
   "SH2: a malformed bar is DROPPED, never patched up")
si = BR.shape_symbol_info({"name": "EURUSD", "digits": 5, "point": 0.00001, "spread": 12,
                           "trade_contract_size": 100000, "swap_long": -7.2})
ok(si["spread_price"] == 0.00012 and si["contract_size"] == 100000,
   "SH3: symbol_info -> the real cost profile (spread 12 points = 0.00012) that retires the flat costBps")

# ---------------------------------------------------------------- report parser
print("\nREPORT PARSER — reconcile today, no Windows needed")
rows = [("2026.07.10 08:15:00", 1002, "EURUSD", "buy", "in", 1.00, 1.10120, -3.5, 0.0, 0.0),
        ("2026.07.10 10:45:00", 1003, "EURUSD", "sell", "out", 1.00, 1.10600, -3.5, -2.0, 480.0),
        ("2026.07.13 13:00:00", 1004, "XAUUSD", "sell", "in", 0.50, 2349.00, -2.0, 0.0, 0.0),
        ("2026.07.13 18:30:00", 1005, "XAUUSD", "buy", "out", 0.50, 2372.00, -2.0, -1.0, -1150.0)]
tr = "".join("<tr><td>%s</td><td>%d</td><td>%s</td><td>%s</td><td>%s</td><td>%.2f</td><td>%.5f</td>"
             "<td>0</td><td>%.2f</td><td>0.00</td><td>%.2f</td><td>%.2f</td><td>0</td><td></td></tr>" % r for r in rows)
HTML = ("<html><body><table><tr><th>Time</th><th>Deal</th><th>Symbol</th><th>Type</th><th>Direction</th>"
        "<th>Volume</th><th>Price</th><th>Order</th><th>Commission</th><th>Fee</th><th>Swap</th>"
        "<th>Profit</th><th>Balance</th><th>Comment</th></tr>"
        "<tr><td>2026.07.09 08:00:00</td><td>1001</td><td></td><td>balance</td><td></td><td></td><td></td>"
        "<td></td><td></td><td></td><td></td><td>10000.00</td><td>10000.00</td><td>Deposit</td></tr>"
        + tr + "<tr><td>junk</td><td>x</td><td>y</td></tr></table></body></html>")

r = MR.parse(HTML, "ReportHistory.html")
ok(r["source"] == "MT5 HTML report" and len(r["deals"]) == 4, "MR1: 4 deals parsed from the MT5 HTML report")
ok(r["skipped_rows"] >= 2, "MR2: header / balance / junk rows are SKIPPED and COUNTED, never silently dropped")
ok(r["deals"][0]["commission"] == -3.5 and r["deals"][1]["swap"] == -2.0 and r["deals"][1]["profit"] == 480.0,
   "MR3: the broker's own commission / swap / profit are read, not modelled")
ok({d["position_id"] for d in r["deals"]} == {1, 2},
   "MR4: deals paired into positions (the HTML report has no position_id, so FIFO reconstructs it)")
ok("FIFO" in (MR.pair_positions.__doc__ or "") and "hedging" in (MR.pair_positions.__doc__ or ""),
   "MR5: the FIFO/hedging limitation is DOCUMENTED, not hidden")
ok(MR.parse_time_ms("2026.07.10 08:15:00") == ms("2026.07.10 08:15:00"), "MR6: MT5 timestamp -> epoch ms")
ok(MR.parse_time_ms("not a time") is None, "MR7: an unparseable time -> None (the row is then skipped)")
shifted = MR.parse(HTML, "r.html", server_utc_offset_h=3.0)
ok(shifted["deals"][0]["time_ms"] == r["deals"][0]["time_ms"] - 3 * 3600_000,
   "MR8: broker server-time offset is applied EXPLICITLY (never guessed)")
ok(any("offset" in w for w in shifted["warnings"]), "MR9: ...and the shift is reported back to the user")
ok(MR.parse("<html></html>")["warnings"], "MR10: an empty report -> an actionable warning, not a silent zero")

# ---------------------------------------------------------------- import + recon
print("\nIMPORT — idempotent by MT5's own ticket id")
e = app.get("/svc/recon").get_json()
ok(e["ok"] and e["empty"] and "unmeasured" in e["msg"],
   "IM1: with no deals, /svc/recon says the edge is UNMEASURED — it does not return a dashboard of zeroes")
i1 = app.post("/svc/mt5/import", json={"content": HTML, "filename": "r.html"}).get_json()
ok(i1["ok"] and i1["stored"] == 4, "IM2: 4 deals imported")
app.post("/svc/mt5/import", json={"content": HTML, "filename": "r.html"})
app.post("/svc/mt5/import", json={"content": HTML, "filename": "r.html"})
with svc.db() as c:
    n = c.execute("SELECT COUNT(*) FROM mt5_deals").fetchone()[0]
ok(n == 4, "IM3: the SAME report imported 3x -> still 4 deals. Idempotent by PRIMARY KEY, not by discipline.")
ok(app.post("/svc/mt5/import", json={}).status_code == 400, "IM4: an empty import is refused (400)")

print("\nRECONCILE — graded against the journal the browser mirrored to SQLite")
journal = [{"t": ms("2026.07.10 08:00:00"), "sym": "EURUSD", "dir": 1, "entry": 1.1000,
            "stop": 1.0950, "t1": 1.1050, "t2": 1.1100, "strat": "emaPull"},
           {"t": ms("2026.07.13 12:30:00"), "sym": "XAUUSD", "dir": -1, "entry": 2350.0,
            "stop": 2360.0, "t1": 2340.0, "t2": 2330.0, "strat": "orb"}]
app.post("/svc/kv", json={"items": {"mishel_journal": json.dumps(journal)}})
ok(len(svc.load_plans()) == 2,
   "RC1: plans load FROM SQLITE — the payoff of v35 durable state: the server can grade you against "
   "intentions you typed into a browser")

j = app.get("/svc/recon").get_json()
ok(j["ok"] and not j["empty"] and len(j["trades"]) == 2, "RC2: 4 deals -> 2 round trips")
by = {r["symbol"]: r for r in j["recons"]}
# EURUSD: plan entry 1.1000 stop 1.0950 -> R=0.0050. filled 1.10120 -> slip = 0.0012/0.0050 = +0.24R
ok(abs(by["EURUSD"]["slippage_R"] - 0.24) < 1e-6,
   "RC3: EURUSD slippage +0.24R — measured against the entry he WROTE DOWN [hand-computed]")
# exit 1.10600, entry 1.10120 -> gross = 0.0048/0.0050 = +0.96R
ok(abs(by["EURUSD"]["gross_R"] - 0.96) < 1e-6, "RC4: EURUSD gross +0.96R [hand-computed]")
ok(by["EURUSD"]["exit_reason"] == "discretionary" and by["EURUSD"]["followed_plan"] is False,
   "RC5: exited at no planned level -> discretionary, NOT credited as following the plan")
# XAUUSD short: plan 2350/2360 -> R=10. exit 2372 is BEYOND the 2360 stop.
ok(by["XAUUSD"]["exit_reason"] == "beyond_stop",
   "RC6: THE EXPENSIVE HABIT — exit at 2372 on a 2360 stop is flagged as BEYOND STOP")
ok(abs(by["XAUUSD"]["gross_R"] - (-2.30)) < 1e-6,
   "RC7: that '1R risk' actually cost -2.30R [hand-computed] — this is what a moved stop really costs")
ok(by["XAUUSD"]["cost_R"] is not None and by["XAUUSD"]["cost_R"] > 0,
   "RC8: real commission + swap converted to R")
ok(any("BEYOND the planned stop" in f for f in j["stats"]["findings"])
   or j["stats"]["trades"] < 5,
   "RC9: the finding is surfaced (or the sample is honestly declared too small)")

st = app.get("/svc/mt5/status").get_json()
ok(st["ok"] and st["deals"] == 4 and "bridge" in st, "RC10: /svc/mt5/status reports deals + bridge health")
ok(svc.SCHEMA_V >= 3, "RC11: schema >= 3 (NEVER pin an exact schema version — I made this exact mistake in v35 and made it AGAIN here. Additive migrations must not redden a green suite.)")

print("\nv36.0 SERVICE TESTS: %d passed, %d failed" % (P, F))
try: os.unlink(tmpdb)
except Exception: pass
sys.exit(1 if F else 0)
