#!/usr/bin/env python3
"""v36.0 RECONCILIATION — KNOWN-ANSWER TESTS.
Every expected value below is computed BY HAND in the comment above it. If the engine
disagrees with arithmetic, the engine is wrong. This is the file that stops the
reconciliation panel from quietly lying to Nazrul about his own edge."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import mishel_recon as R

P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")

def close(a, b, eps=1e-6):
    return a is not None and abs(a - b) < eps

HR = 3600_000
def deal(pid, entry, typ, px, vol=1.0, t=0, comm=0.0, swap=0.0, profit=0.0, sym="EURUSD"):
    return {"position_id": pid, "entry": entry, "type": typ, "price": px, "volume": vol,
            "time_ms": t, "commission": comm, "swap": swap, "profit": profit,
            "symbol": sym, "ticket": pid * 10 + entry, "order": 0, "comment": ""}

# =====================================================================
print("\nDEALS -> ROUND-TRIP TRADES")
# A long EURUSD: in @1.1000 (1 lot), out @1.1050. 1 lot = 100,000 units.
# gross = (1.1050-1.1000) * 100000 = $500. commission -7, swap -2.
# net = 500 - 7 - 2 = $491
ds = [deal(1, R.IN,  R.BUY,  1.1000, 1.0, 0,      comm=-3.5),
      deal(1, R.OUT, R.SELL, 1.1050, 1.0, 2 * HR, comm=-3.5, swap=-2.0, profit=500.0)]
ts = R.deals_to_trades(ds)
ok(len(ts) == 1, "T1: one round trip from two deals")
t = ts[0]
ok(t["side"] == "long" and close(t["entry_price"], 1.1000) and close(t["exit_price"], 1.1050),
   "T2: side + entry/exit prices")
ok(close(t["commission"], -7.0) and close(t["swap"], -2.0) and close(t["gross_profit"], 500.0),
   "T3: broker's OWN commission/swap/gross carried through, never modelled")
ok(close(t["net_profit"], 491.0), "T4: net = gross + commission + swap = 500 - 7 - 2 = $491")
ok(close(t["hold_ms"], 2 * HR), "T5: hold time = 2h")

# partial fills: in 0.5 @1.1000 and 0.5 @1.1020 -> VWAP entry = 1.1010
ds2 = [deal(2, R.IN,  R.BUY,  1.1000, 0.5, 0),
       deal(2, R.IN,  R.BUY,  1.1020, 0.5, 1000),
       deal(2, R.OUT, R.SELL, 1.1100, 1.0, HR, profit=900.0)]
t2 = R.deals_to_trades(ds2)[0]
ok(close(t2["entry_price"], 1.1010) and close(t2["volume"], 1.0) and t2["partial_fills"],
   "T6: partial fills -> VOLUME-WEIGHTED entry (1.1010), flagged as partial")

# an open position (IN with no OUT) is not a trade
ok(len(R.deals_to_trades([deal(3, R.IN, R.BUY, 1.1, 1.0, 0)])) == 0,
   "T7: a still-open position is NOT counted as a closed trade")

# =====================================================================
print("\nMONEY <-> R")
spec = {"contract_size": 100000}
mpp, src = R.money_per_price(t, spec)
ok(close(mpp, 100000) and src == "spec", "M1: 1.0 lot x 100,000 contract -> $100k per 1.0 price unit (from spec)")
mpp2, src2 = R.money_per_price(t, None)
# inferred: gross 500 / move 0.0050 = 100000
ok(close(mpp2, 100000, 1e-3) and src2 == "inferred", "M2: with no spec, INFERRED from the trade's own P/L = 100,000")
flat = {"side": "long", "entry_price": 1.1, "exit_price": 1.1 + 1e-12, "gross_profit": 0.0, "volume": 1.0}
mpp3, src3 = R.money_per_price(flat, None)
ok(mpp3 is None and src3 == "unknown",
   "M3: HONESTY — a ~zero price move makes inference unstable, so it returns None, not a guess")

# =====================================================================
print("\nRECONCILE — planned vs actual")
# plan: long, entry 1.1000, stop 1.0950, t1 1.1050, t2 1.1100  ->  R = 0.0050
# actual entry 1.1010 (10 pips WORSE than planned for a long)
#   slippage_R = (1.1010 - 1.1000) / 0.0050 = +0.20R   <- adverse
# actual exit 1.1100 -> gross_R = (1.1100 - 1.1010)/0.0050 = 0.0090/0.0050 = 1.80R
# costs: commission -7, swap -2 => cost_money = 9
#   money_per_R = 100000 * 0.0050 = $500  =>  cost_R = 9/500 = 0.018R
#   net_R = 1.80 - 0.018 = 1.782R
plan = {"symbol": "EURUSD", "side": "long", "entry": 1.1000, "stop": 1.0950,
        "t1": 1.1050, "t2": 1.1100, "time_ms": -HR}
tr = {"position_id": 9, "symbol": "EURUSD", "side": "long", "volume": 1.0,
      "entry_price": 1.1010, "exit_price": 1.1100, "open_ms": 0, "close_ms": 2 * HR,
      "hold_ms": 2 * HR, "commission": -7.0, "swap": -2.0, "gross_profit": 900.0,
      "net_profit": 891.0, "partial_fills": False, "comment": ""}
r = R.reconcile(tr, plan, spec)
ok(close(r["R_price"], 0.0050), "R1: R = |entry - stop| = 0.0050 (R is a unit of INTENDED risk)")
ok(close(r["slippage_R"], 0.20), "R2: slippage = +0.20R (filled 10 pips worse than planned) [hand-computed]")
ok(close(r["gross_R"], 1.80), "R3: gross = 1.80R, measured from the price you ACTUALLY got [hand-computed]")
ok(close(r["cost_R"], 0.018), "R4: cost = $9 / ($500 per R) = 0.018R [hand-computed]")
ok(close(r["net_R"], 1.782), "R5: net = 1.80 - 0.018 = 1.782R [hand-computed]")
ok(r["exit_reason"] == "t2" and r["followed_plan"] is True, "R6: exit at t2 -> plan FOLLOWED")

# exit at the stop
tr_s = dict(tr, exit_price=1.0950, gross_profit=-600.0, net_profit=-609.0)
rs = R.reconcile(tr_s, plan, spec)
ok(rs["exit_reason"] == "stop" and rs["followed_plan"] is True, "R7: exit at the stop -> plan FOLLOWED (a stop is not a failure)")

# THE EXPENSIVE HABIT: exit far BEYOND the planned stop
tr_b = dict(tr, exit_price=1.0900, gross_profit=-1100.0, net_profit=-1109.0)
rb = R.reconcile(tr_b, plan, spec)
ok(rb["exit_reason"] == "beyond_stop" and rb["followed_plan"] is False,
   "R8: exit BEYOND the stop -> flagged (stop widened/ignored)")
ok(any("most expensive habit" in n for n in rb["notes"]), "R9: ...and it says so, in words")
# gross_R = (1.0900-1.1010)/0.0050 = -2.20R : a 1R plan that lost 2.2R
ok(close(rb["gross_R"], -2.20), "R10: a '1R risk' became a -2.20R loss [hand-computed]")

# discretionary exit (not at any planned level)
rd = R.reconcile(dict(tr, exit_price=1.1035, gross_profit=250.0, net_profit=241.0), plan, spec)
ok(rd["exit_reason"] == "discretionary" and rd["followed_plan"] is False,
   "R11: an exit at no planned level -> discretionary, NOT counted as following the plan")

# short side
plan_s = {"symbol": "EURUSD", "side": "short", "entry": 1.1000, "stop": 1.1050, "t2": 1.0900, "time_ms": -HR}
tr_sh = dict(tr, side="short", entry_price=1.0990, exit_price=1.0900)
rsh = R.reconcile(tr_sh, plan_s, spec)
# short filled at 1.0990 vs planned 1.1000 = 10 pips WORSE for a short -> +0.20R adverse
ok(close(rsh["slippage_R"], 0.20), "R12: SHORT slippage sign is correct (filled 10 pips worse = +0.20R adverse)")
# gross = (1.0990 - 1.0900)/0.0050 = 1.80R
ok(close(rsh["gross_R"], 1.80), "R13: SHORT gross_R = 1.80R [hand-computed]")

# unplanned trade
ru = R.reconcile(tr, None, spec)
ok(ru["planned"] is False and ru["gross_R"] is None and any("UNPLANNED" in n for n in ru["notes"]),
   "R14: no plan -> no R, no grade, and it SAYS unplanned (not silently dropped)")

# no spec + tiny move -> cost_R honestly unknown
rn = R.reconcile({"position_id": 1, "symbol": "X", "side": "long", "volume": 1.0,
                  "entry_price": 1.1, "exit_price": 1.1, "open_ms": 0, "close_ms": HR,
                  "hold_ms": HR, "commission": -5, "swap": 0, "gross_profit": 0.0,
                  "net_profit": -5}, plan, None)
ok(rn["cost_R"] is None and any("unknown" in n for n in rn["notes"]),
   "R15: HONESTY — cost_R is None (not 0!) when it cannot be derived. A missing measurement is not a free trade.")

# =====================================================================
print("\nEXCURSIONS — what the trade OFFERED vs what you took")
# long from 1.1010, R=0.0050. Bars run to a high of 1.1160 and a low of 1.0985.
#   MFE = (1.1160-1.1010)/0.0050 = 0.0150/0.0050 = 3.00R
#   MAE = (1.0985-1.1010)/0.0050 = -0.0025/0.0050 = -0.50R
#   exit 1.1100 -> realised 1.80R -> capture = 1.80/3.00 = 0.60
bars = [{"t": 0, "o": 1.101, "h": 1.1030, "l": 1.0985, "c": 1.102, "v": 1},
        {"t": HR, "o": 1.102, "h": 1.1160, "l": 1.1010, "c": 1.110, "v": 1},
        {"t": 2 * HR, "o": 1.110, "h": 1.1120, "l": 1.1090, "c": 1.110, "v": 1}]
e = R.excursions(tr, bars, plan)
ok(close(e["mfe_R"], 3.00), "E1: MFE = 3.00R — the move it HANDED you [hand-computed]")
ok(close(e["mae_R"], -0.50), "E2: MAE = -0.50R — how far it went against you [hand-computed]")
ok(close(e["mfe_capture"], 0.60), "E3: capture = 1.80R / 3.00R = 60% — you left 40% on the table [hand-computed]")
ok(R.excursions(tr, [], plan)["mfe_R"] is None, "E4: no bars -> None, not zero")

# =====================================================================
print("\nPLAN MATCHING")
plans = [{"symbol": "EURUSD", "side": "long", "entry": 1.10, "stop": 1.095, "time_ms": -HR},
         {"symbol": "EURUSD", "side": "long", "entry": 1.20, "stop": 1.195, "time_ms": -100 * HR},
         {"symbol": "EURUSD", "side": "long", "entry": 1.30, "stop": 1.295, "time_ms": +HR}]
pairs = R.attach_plans([tr], plans)
ok(pairs[0][1] is plans[0], "P1: matches the MOST RECENT plan before the fill (not the oldest)")
ok(pairs[0][1] is not plans[2],
   "P2: a plan made AFTER the fill is never matched — that is not a plan, it is a story")
ok(R.attach_plans([tr], [dict(plans[1])])[0][1] is None,
   "P3: a plan 100h stale falls outside the window -> unmatched, not force-fitted")
ok(R.attach_plans([tr], [{"symbol": "GBPUSD", "side": "long", "entry": 1.1, "stop": 1.09, "time_ms": -HR}])[0][1] is None,
   "P4: never matches across symbols")

# =====================================================================
print("\nEXEC STATS — the leaks")
ok(R.exec_stats([])["trades"] == 0 and "No closed trades" in R.exec_stats([])["findings"][0],
   "X1: empty -> honest empty state")
few = R.exec_stats([r, r, r])
ok(any("Too few to grade" in f for f in few["findings"]),
   "X2: <5 trades -> refuses to draw conclusions and SAYS the sample is too small")

# Build 6 trades: gross +0.50R each but a heavy -0.60R execution drag => net NEGATIVE.
# This is the headline finding: the setups work, the execution does not.
def mk(gross_R, slip, cost, net_profit, hold, exit_reason="discretionary", cap=None):
    return {"planned": True, "gross_R": gross_R, "slippage_R": slip, "cost_R": cost,
            "net_R": gross_R - cost - slip, "net_profit": net_profit, "hold_ms": hold,
            "commission": -5, "swap": -1, "exit_reason": exit_reason,
            "followed_plan": exit_reason in ("stop", "t1", "t2"), "mfe_capture": cap}
rs6 = [mk(0.5, 0.4, 0.2, 100, 1 * HR, "t1", 0.4), mk(0.5, 0.4, 0.2, 120, 1 * HR, "t1", 0.35),
       mk(0.5, 0.4, 0.2, -80, 4 * HR, "discretionary", 0.45), mk(0.5, 0.4, 0.2, -90, 5 * HR, "discretionary", 0.30),
       mk(0.5, 0.4, 0.2, 110, 1 * HR, "t1", 0.5), mk(0.5, 0.4, 0.2, -70, 3 * HR, "beyond_stop", 0.40)]
excs6 = [{"mfe_capture": r_["mfe_capture"]} for r_ in rs6]
st = R.exec_stats(rs6, excs6)
ok(close(st["avg_slippage_R"], 0.40) and close(st["avg_cost_R"], 0.20),
   "X3: avg slippage 0.40R + avg cost 0.20R [hand-computed]")
ok(close(st["execution_drag_R"], 0.60), "X4: EXECUTION DRAG = 0.60R per trade [hand-computed]")
ok(close(st["gross_expectancy_R"], 0.50) and close(st["net_expectancy_R"], -0.10),
   "X5: gross +0.50R -> net -0.10R per trade [hand-computed]")
ok(any("YOUR SETUPS WORK; YOUR EXECUTION DOES NOT" in f for f in st["findings"]),
   "X6: THE HEADLINE — gross positive, net negative -> it names the problem exactly")
ok(close(st["mfe_capture_median"], 0.40), "X7: median capture 40% [hand-computed: median of .30,.35,.40,.40,.45,.50]")
ok(any("exiting winners early" in f and "EXIT problem" in f for f in st["findings"]),
   "X8: capture < 50% -> tells him it is an EXIT problem, and that no new strategy fixes it")
# winners hold 1h avg (3 wins @1h); losers 4,5,3 -> 4h avg. ratio = 4.0
ok(close(st["hold_ratio"], 4.0), "X9: holds losers 4.0x longer than winners [hand-computed]")
ok(any("hold losers 4.0x longer" in f for f in st["findings"]), "X10: ...and says so plainly")
ok(close(st["plan_adherence_pct"], 50.0), "X11: plan adherence 50% (3 of 6) [hand-computed]")
ok(st["beyond_stop_count"] == 1 and any("BEYOND the planned stop" in f for f in st["findings"]),
   "X12: counts and names exits beyond the stop")

# =====================================================================
print("\nFULL PIPELINE")
rep = R.full_report(ds, plans=[{"symbol": "EURUSD", "side": "long", "entry": 1.1000,
                                "stop": 1.0950, "t1": 1.1050, "t2": 1.1100, "time_ms": -HR}],
                    bars_by_symbol={"EURUSD": bars}, specs={"EURUSD": spec})
ok(len(rep["trades"]) == 1 and len(rep["recons"]) == 1 and rep["stats"]["trades"] == 1,
   "FP1: deals -> trades -> reconciled -> stats, end to end")
ok(rep["recons"][0]["planned"] is True and rep["recons"][0]["gross_R"] is not None,
   "FP2: the plan was matched and the trade graded")

print("\nv36.0 RECONCILIATION TESTS: %d passed, %d failed" % (P, F))
sys.exit(1 if F else 0)
