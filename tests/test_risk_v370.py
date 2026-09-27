#!/usr/bin/env python3
"""v37.0 RISK GOVERNOR — KNOWN-ANSWER TESTS.
Every expected number is hand-computed in the comment above it."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import mishel_risk as G

P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")
def close(a, b, eps=1e-6): return a is not None and abs(a - b) < eps

MIN = 60_000
HR = 3600_000

# =====================================================================
print("\nCURRENCY LEGS — correlation as arithmetic, not a model")
ok(G.currency_legs("EURUSD") == ("EUR", "USD"), "CL1: EURUSD -> (EUR, USD)")
ok(G.currency_legs("USDCHF") == ("USD", "CHF"), "CL2: USDCHF -> (USD, CHF)")
ok(G.currency_legs("XAUUSD") == ("XAU", "USD"), "CL3: XAUUSD -> (XAU, USD)")
ok(G.currency_legs("GOLD") == ("XAU", "USD"), "CL4: broker alias GOLD -> (XAU, USD)")
ok(G.currency_legs("EURUSDPRO") == ("EUR", "USD"), "CL5: broker suffixes stripped (EURUSDPRO)")
ok(G.currency_legs("NAS100") is None,
   "CL6: an index has NO currency legs -> None. It never invents an exposure that does not exist.")
ok(G.currency_legs("AAPL") is None, "CL7: a stock -> None")

# =====================================================================
print("\nNET EXPOSURE — the bet you are actually making")
# long EURUSD 1R  -> EUR +1, USD -1
# short USDCHF 1R -> USD -1, CHF +1
# long AUDUSD 1R  -> AUD +1, USD -1
# => USD = -3R. THREE tickets. ONE three-R bet on a falling dollar.
pos = [{"symbol": "EURUSD", "side": "long", "risk_R": 1.0},
       {"symbol": "USDCHF", "side": "short", "risk_R": 1.0},
       {"symbol": "AUDUSD", "side": "long", "risk_R": 1.0}]
ex = G.net_exposure(pos)["net"]
ok(close(ex["USD"], -3.0), "NE1: three 'separate' 1R trades = ONE -3R bet on the dollar [hand-computed]")
ok(close(ex["EUR"], 1.0) and close(ex["CHF"], 1.0) and close(ex["AUD"], 1.0),
   "NE2: each long leg carries +1R of its own currency")
c = G.concentration(pos)
ok(c["currency"] == "USD" and close(c["R"], -3.0),
   "NE3: concentration names the biggest single bet: USD, -3.00R [hand-computed]")

# a genuinely hedged book nets to ~0
hedge = [{"symbol": "EURUSD", "side": "long", "risk_R": 1.0},
         {"symbol": "EURUSD", "side": "short", "risk_R": 1.0}]
ok(close(G.net_exposure(hedge)["net"]["USD"], 0.0),
   "NE4: a real hedge nets to ZERO — it does not double-count two tickets as two bets")

# opposing pairs partially offset
opp = [{"symbol": "EURUSD", "side": "long", "risk_R": 2.0},
       {"symbol": "GBPUSD", "side": "short", "risk_R": 1.0}]
ok(close(G.net_exposure(opp)["net"]["USD"], -1.0),
   "NE5: long EURUSD 2R + short GBPUSD 1R -> net USD only -1R (they partially offset) [hand-computed]")
ok(G.net_exposure([{"symbol": "NAS100", "side": "long", "risk_R": 1.0}])["unmapped"] == ["NAS100"],
   "NE6: an unnettable symbol is REPORTED as unmapped, not silently ignored")

# =====================================================================
print("\nPOSITION SIZING — from the broker's REAL contract spec")
# EURUSD: equity 10,000, risk 1% = $100. stop 50 pips = 0.0050. contract 100,000.
#   lots = 100 / (100000 * 0.0050) = 100 / 500 = 0.20 lots
eur = {"contract_size": 100000, "volume_step": 0.01, "volume_min": 0.01}
lots, d = G.position_size(10000, 1.0, 1.1000, 1.0950, eur)
ok(close(lots, 0.20), "PS1: EURUSD -> 0.20 lots [hand-computed: $100 / (100,000 x 0.0050)]")
ok(close(d["actual_risk_money"], 100.0, 1e-3), "PS2: ...which risks exactly $100 if the stop is hit")

# THE BUG THIS EXISTS TO FIX -------------------------------------------
# XAUUSD contract is 100 OUNCES, not 100,000.
# equity 10,000, risk 1% = $100. stop $10.
#   correct: lots = 100 / (100 * 10) = 0.10 lots
#   the shipped ticket did units/100000 -> 10 oz / 100000 = 0.0001 lots. 1000x TOO SMALL.
gold = {"contract_size": 100, "volume_step": 0.01, "volume_min": 0.01}
glots, gd = G.position_size(10000, 1.0, 2350.0, 2340.0, gold)
ok(close(glots, 0.10), "PS3 [RS_GOLD]: XAUUSD -> 0.10 lots [hand-computed: $100 / (100 oz x $10)]")
old_wrong = (10000 * 1.0 / 100) / 10.0 / 100000          # the shipped /100000 path
ok(abs(old_wrong - 0.0001) < 1e-9 and abs(glots / old_wrong - 1000) < 1,
   "PS4 [RS_GOLD]: the SHIPPED ticket would have said 0.0001 lots \u2014 1000x too small. "
   "A real spec is not a nicety.")

ok(close(G.position_size(10000, 1.0, 2350.0, 2340.0, gold)[1]["risk_money"], 100.0),
   "PS5: risk money = 1% of REAL equity (not PAPER.bal)")

# rounding must go DOWN, never up
sp = {"contract_size": 100000, "volume_step": 0.01, "volume_min": 0.01}
l2, d2 = G.position_size(10000, 1.0, 1.1000, 1.09470)     # 53 pips -> 0.1886... lots
ok(l2 is None, "PS6: no spec -> None + a reason. It NEVER guesses a contract size.")
l3, d3 = G.position_size(10000, 1.0, 1.1000, 1.09470, sp)
ok(close(l3, 0.18) and d3["lots_exact"] > 0.18,
   "PS7: rounds DOWN to the broker's step (0.1886 -> 0.18). Rounding UP would silently "
   "exceed the limit you just set.")
ok(d3["actual_risk_money"] < 100.0, "PS8: ...so the actual risk is never MORE than you asked for")
# The float trap, pinned so it can never come back:
_l, _d = G.position_size(10000, 1.0, 1.1000, 1.0950, sp)
ok(close(_l, 0.20),
   "PS8b [FLOAT TRAP]: 1.1000-1.0950 == 0.005000000000000115 in IEEE754, so lots_exact is "
   "0.19999999999999538 and a NAIVE floor turns a correct 0.20 into 0.19. A rounding rule "
   "that is wrong on every round number is not a rounding rule.")

# below the broker's minimum
tiny, why = G.position_size(200, 1.0, 1.1000, 1.0950, sp)  # $2 risk -> 0.004 lots < 0.01 min
ok(tiny == 0.0 and "BELOW your broker's minimum" in why,
   "PS9: HONESTY — when the correct size is below the broker's minimum it says so, and refuses. "
   "It does not round UP to 0.01 and quietly break the risk rule.")
ok(G.position_size(10000, 1.0, 1.1, 1.1, sp)[0] is None, "PS10: entry == stop -> no risk to size -> None")
ok(G.position_size(0, 1.0, 1.1, 1.09, sp)[0] is None, "PS11: no equity -> None (connect MT5)")

# =====================================================================
print("\nUNPROTECTED POSITIONS — the loudest rule")
ups = G.unprotected([{"symbol": "EURUSD", "sl": 1.0950}, {"symbol": "XAUUSD", "sl": 0.0},
                     {"symbol": "GBPUSD"}])
ok(len(ups) == 2, "UP1: a position with sl=0 AND one with no sl field are both unprotected")

# =====================================================================
print("\nSTATE — from REAL fills, not the demo account")
NOW = 1_800_000_000_000
start, _ = G.day_bounds_ms(NOW, 0)
recons = [
    {"close_ms": start + 1 * HR, "net_R": -1.0, "net_profit": -100},
    {"close_ms": start + 2 * HR, "net_R": -0.8, "net_profit": -80},
    {"close_ms": start - 30 * HR, "net_R": +2.0, "net_profit": 200},   # yesterday
]
st = G.compute_state(recons, [], 10000, NOW)
ok(close(st["realized_R_today"], -1.8),
   "ST1: today's realized = -1.80R. Yesterday's +2R is NOT counted [hand-computed]")
ok(st["trades_today"] == 2, "ST2: 2 trades today")
ok(st["consecutive_losses"] == 2, "ST3: 2 losses in a row (walking back from the latest close)")
win_last = recons + [{"close_ms": start + 3 * HR, "net_R": +1.0, "net_profit": 120}]
ok(G.compute_state(win_last, [], 10000, NOW)["consecutive_losses"] == 0,
   "ST4: a win RESETS the streak")
# day reset hour
s2, _ = G.day_bounds_ms(NOW, 22)
ok(s2 != start, "ST5: the day boundary is configurable (a 00:00 UTC reset mid-NY-session is not a daily rule)")

# =====================================================================
print("\nVERDICT — allow / warn / block")
clean = G.compute_state([], [], 10000, NOW)
v = G.evaluate(clean, {"symbol": "EURUSD", "side": "long", "risk_R": 1.0, "risk_pct": 1.0})
ok(v["verdict"] == G.ALLOW, "V1: a clean book, a 1R trade -> ALLOW")
ok("Risk is not the reason to skip this one" in v["reasons"][0]["msg"],
   "V2: ...and it says so, rather than staying silent")

# daily loss
hit = G.compute_state([{"close_ms": start + HR, "net_R": -2.1, "net_profit": -210}], [], 10000, NOW)
v = G.evaluate(hit, {"symbol": "EURUSD", "side": "long", "risk_R": 1.0})
ok(v["verdict"] == G.BLOCK and any(r["rule"] == "daily_loss" for r in v["reasons"]),
   "V3: -2.10R today vs a -2R limit -> BLOCK")
ok(any("refund request" in r["msg"] for r in v["reasons"]),
   "V4: ...in words he will actually read")

# cooldown
loss3 = [{"close_ms": start + i * HR, "net_R": -0.5, "net_profit": -50} for i in (1, 2, 3)]
stc = G.compute_state(loss3, [], 10000, start + 3 * HR + 10 * MIN)
v = G.evaluate(stc, {"symbol": "EURUSD", "side": "long", "risk_R": 0.5})
ok(v["verdict"] == G.BLOCK and any(r["rule"] == "cooldown" for r in v["reasons"]),
   "V5: 3 losses in a row, 10 min later -> BLOCK (cooldown)")
ok(any("50 min left" in r["msg"] for r in v["reasons"]),
   "V6: ...and it tells him exactly how long is left [60 - 10 = 50]")
stc2 = G.compute_state(loss3, [], 10000, start + 3 * HR + 90 * MIN)
v2 = G.evaluate(stc2, {"symbol": "EURUSD", "side": "long", "risk_R": 0.5})
ok(v2["verdict"] == G.WARN and any("cooldown has expired" in r["msg"] for r in v2["reasons"]),
   "V7: 90 min later the cooldown has expired -> WARN, not BLOCK")

# THE HEADLINE: correlation
book = [{"symbol": "EURUSD", "side": "long", "risk_R": 1.0, "sl": 1.09},
        {"symbol": "USDCHF", "side": "short", "risk_R": 1.0, "sl": 0.92}]
stx = G.compute_state([], book, 10000, NOW)
v = G.evaluate(stx, {"symbol": "AUDUSD", "side": "long", "risk_R": 1.0, "risk_pct": 1.0})
ok(v["verdict"] == G.BLOCK and any(r["rule"] == "concentration" for r in v["reasons"]),
   "V8: long EURUSD + short USDCHF + a proposed long AUDUSD -> net -3R USD -> BLOCK")
msg = next(r["msg"] for r in v["reasons"] if r["rule"] == "concentration")
ok("THIS IS ONE BET, NOT 3" in msg,
   "V9: THE HEADLINE — 'THIS IS ONE BET, NOT 3.' Three tickets, one 3R dollar bet.")
ok("Correlation does not care that you opened them in different windows" in msg,
   "V10: ...and it explains WHY, in one sentence")

# unprotected blocks everything
stu = G.compute_state([], [{"symbol": "XAUUSD", "side": "long", "risk_R": 1.0, "sl": 0}], 10000, NOW)
v = G.evaluate(stu, None)
ok(v["verdict"] == G.BLOCK and any(r["rule"] == "unprotected" for r in v["reasons"]),
   "V11: an open position with NO STOP -> BLOCK before anything else is even considered")
ok(any("open-ended bet on your own attention" in r["msg"] for r in v["reasons"]), "V12: ...and it lands")

# open risk cap
sto = G.compute_state([], [{"symbol": "EURUSD", "side": "long", "risk_R": 2.5, "sl": 1.09}], 10000, NOW)
v = G.evaluate(sto, {"symbol": "USDJPY", "side": "long", "risk_R": 1.0})
ok(v["verdict"] == G.BLOCK and any(r["rule"] == "open_risk" for r in v["reasons"]),
   "V13: 2.5R open + 1R proposed = 3.5R > 3R cap -> BLOCK")

# per-trade cap
v = G.evaluate(clean, {"symbol": "EURUSD", "side": "long", "risk_R": 1.0, "risk_pct": 3.0})
ok(v["verdict"] == G.BLOCK and any(r["rule"] == "per_trade" for r in v["reasons"]),
   "V14: 3% on one trade vs a 1% rule -> BLOCK")

# trade count
many = [{"close_ms": start + i * HR, "net_R": 0.1, "net_profit": 10} for i in range(5)]
v = G.evaluate(G.compute_state(many, [], 10000, NOW), {"symbol": "EURUSD", "side": "long", "risk_R": 0.5})
ok(v["verdict"] == G.BLOCK and any("you are clicking" in r["msg"] for r in v["reasons"]),
   "V15: 5 trades today (limit 5) -> BLOCK: 'past this point you are not trading, you are clicking'")

# config is overridable
v = G.evaluate(hit, {"symbol": "EURUSD", "side": "long", "risk_R": 1.0},
               cfg={"max_daily_loss_R": 5.0})
ok(v["verdict"] == G.ALLOW, "V16: HIS limits, not mine — a 5R daily limit lets the -2.1R day through")

# unmapped coverage is disclosed
v = G.evaluate(G.compute_state([], [{"symbol": "NAS100", "side": "long", "risk_R": 1.0, "sl": 1}], 10000, NOW), None)
ok(any(r["rule"] == "coverage" for r in v["reasons"]),
   "V17: HONESTY — it states which symbols are NOT currency-netted, so he knows what is not being watched")

print("\nTHE UNKNOWN IS NOT THE SAFE")
blind = G.compute_state([], [], 10000, NOW)
blind["position_source_error"] = "MT5 bridge unreachable"
vb = G.evaluate(blind, {"symbol": "EURUSD", "side": "long", "risk_R": 1.0})
ok(vb["verdict"] == G.WARN and any(r["rule"] == "blind" for r in vb["reasons"]),
   "U1: cannot see open positions -> WARN, never ALLOW")
ok(any("This is not an all-clear; it is a blind spot" in r["msg"] for r in vb["reasons"]),
   "U2: THE RULE — a governor that reports all-clear over a book it cannot read manufactures "
   "confidence it has not earned")
ok(not any("Within every limit" in r["msg"] for r in vb["reasons"]),
   "U3: ...and it never utters the all-clear line while blind")

noeq = G.compute_state([], [], 0, NOW)
ok(G.evaluate(noeq, None)["verdict"] == G.WARN,
   "U4: no account equity -> WARN (sizes cannot be checked against a real balance)")

nospec = G.compute_state([], [{"symbol": "XAUUSD", "side": "long", "sl": 2340,
                               "risk_R": None, "risk_unknown": True}], 10000, NOW)
vn = G.evaluate(nospec, None)
ok(vn["verdict"] == G.WARN and any("is NOT counted in your open risk" in r["msg"] for r in vn["reasons"]),
   "U5: a stopped position with no contract spec -> its R is UNKNOWN and SAYS it is not being counted")

print("\nv37.0 RISK GOVERNOR TESTS: %d passed, %d failed" % (P, F))
sys.exit(1 if F else 0)
