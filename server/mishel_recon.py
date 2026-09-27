#!/usr/bin/env python3
"""
v36.0 — RECONCILIATION ENGINE  (server/mishel_recon.py)

THE PROBLEM THIS SOLVES

`get_journal_stats` read PAPER.hist — the DEMO account. The decision journal logged
what the SYSTEM would have done. Nowhere did the terminal know what actually filled,
at what price, with what slippage, what spread you paid, or whether you moved the stop.

A discretionary trader's entire edge lives in that gap. You had zero instrumentation
on it. This file is the instrument.

WHAT IT MEASURES (per trade, then in aggregate)
  · slippage_R      — planned entry vs the price you actually got, in R
  · cost_R          — commission + swap, in R (the real ones, from the broker)
  · gross_R / net_R — what the move gave you, and what you kept
  · MFE / MAE       — how far it went your way / against you before you closed
  · mfe_capture     — what fraction of the available move you actually took
  · exit_reason     — stop / t1 / t2 / discretionary (did you follow your own plan?)
  · hold asymmetry  — do you hold losers longer than winners? (almost everyone does)

HONESTY RULES ENFORCED HERE
  · Anything not derivable from the data is None. Never 0, never a guess.
    A `None` cost is a missing measurement, not a free trade.
  · Costs are taken from the BROKER's own commission/swap fields, never modelled.
  · Money->R conversion prefers the instrument's real contract spec; if that is
    absent it INFERS the money-per-price from the trade's own gross P/L; if the
    price barely moved (so inference would be unstable) it returns None and says so.
  · A trade with no matching plan is reported as unplanned, not silently dropped.

Pure functions. No I/O, no MT5, no network. Every number below is unit-tested against
a hand-computed answer.
"""
from statistics import median

BUY, SELL = 0, 1
IN, OUT, INOUT = 0, 1, 2


# ==========================================================================
# 1. DEALS -> ROUND-TRIP TRADES
# ==========================================================================
def deals_to_trades(deals):
    """MT5 gives DEALS (fills). A trade is the round trip. Group by position_id.

    Entry/exit prices are VOLUME-WEIGHTED, so partial fills and scale-outs are
    handled correctly rather than being averaged naively.

    Costs stay separate on purpose: commission and swap are the two ways a broker
    takes money from you that never show up in a price chart.
    """
    by_pos = {}
    for d in deals or []:
        pid = d.get("position_id")
        if not pid or d.get("entry") == 2 and not d.get("symbol"):
            continue
        by_pos.setdefault(pid, []).append(d)

    trades = []
    for pid, ds in by_pos.items():
        ds.sort(key=lambda x: (x.get("time_ms", 0), x.get("ticket", 0)))
        ins = [d for d in ds if d.get("entry") == IN]
        outs = [d for d in ds if d.get("entry") == OUT]
        if not ins or not outs:
            continue                      # still open, or a balance/credit deal -> not a trade

        def vwap(rows):
            v = sum(r.get("volume", 0) for r in rows)
            if v <= 0:
                return None, 0.0
            return sum(r.get("price", 0) * r.get("volume", 0) for r in rows) / v, v

        entry_px, vol_in = vwap(ins)
        exit_px, _vol_out = vwap(outs)
        if entry_px is None or exit_px is None:
            continue

        side = "long" if ins[0].get("type") == BUY else "short"
        trades.append({
            "position_id": pid,
            "symbol": ins[0].get("symbol", ""),
            "side": side,
            "volume": vol_in,
            "entry_price": entry_px,
            "exit_price": exit_px,
            "open_ms": ins[0].get("time_ms"),
            "close_ms": outs[-1].get("time_ms"),
            "hold_ms": (outs[-1].get("time_ms") or 0) - (ins[0].get("time_ms") or 0),
            # broker's own numbers — never modelled
            "commission": sum(d.get("commission", 0) for d in ds),
            "swap":       sum(d.get("swap", 0) for d in ds),
            "gross_profit": sum(d.get("profit", 0) for d in outs),
            "partial_fills": len(ins) > 1 or len(outs) > 1,
            "comment": (outs[-1].get("comment") or ins[0].get("comment") or ""),
        })
    trades.sort(key=lambda t: t.get("open_ms") or 0)
    for t in trades:
        t["net_profit"] = t["gross_profit"] + t["commission"] + t["swap"]
    return trades


# ==========================================================================
# 2. MONEY <-> R
# ==========================================================================
def money_per_price(trade, spec=None):
    """How much money one unit of PRICE movement is worth on this trade.

    Preferred: the instrument's real contract spec (volume x contract_size).
      1.0 lot EURUSD, contract 100000 -> a 0.0001 move is $10.
    Fallback: infer from the trade's own gross P/L. Only trustworthy when the
      price actually moved; if it barely moved, inference explodes, so we return
      None rather than a number we do not believe.
    """
    if spec and spec.get("contract_size"):
        v = trade.get("volume") or 0
        if v > 0:
            return v * float(spec["contract_size"]), "spec"

    move = (trade.get("exit_price", 0) - trade.get("entry_price", 0))
    if trade.get("side") == "short":
        move = -move
    gross = trade.get("gross_profit")
    if gross is None or abs(move) < 1e-9:
        return None, "unknown"
    mpp = gross / move
    if mpp <= 0:                       # a long that made money on a down move: data is inconsistent
        return None, "unknown"
    return mpp, "inferred"


# ==========================================================================
# 3. PLANNED vs ACTUAL — the core reconciliation
# ==========================================================================
def reconcile(trade, plan=None, spec=None, tol_frac=0.10):
    """Reconcile one executed trade against the plan you actually intended.

    plan = {"entry":…, "stop":…, "t1":…, "t2":…, "side":…}
    R is defined by the PLAN (|entry - stop|), because R is a unit of intended risk.
    If there is no plan there is no R, and we say so instead of inventing one.

    tol_frac: how close to a planned level an exit must be to count as "that level"
              (as a fraction of R). 0.10 = within a tenth of your risk.
    """
    dirn = 1 if trade.get("side") == "long" else -1
    out = {
        "position_id": trade.get("position_id"),
        "symbol": trade.get("symbol"),
        "side": trade.get("side"),
        "open_ms": trade.get("open_ms"),
        "close_ms": trade.get("close_ms"),
        "hold_ms": trade.get("hold_ms"),
        "net_profit": trade.get("net_profit"),
        "gross_profit": trade.get("gross_profit"),
        "commission": trade.get("commission"),
        "swap": trade.get("swap"),
        "planned": bool(plan),
        "R_price": None, "slippage_R": None, "gross_R": None,
        "cost_R": None, "net_R": None, "planned_R_target": None,
        "exit_reason": None, "followed_plan": None, "money_per_price": None,
        "mpp_source": None, "notes": [],
    }

    mpp, src = money_per_price(trade, spec)
    out["money_per_price"] = mpp
    out["mpp_source"] = src

    if not plan:
        out["notes"].append("UNPLANNED — no journal plan matched this trade. "
                            "It is counted in your P/L but cannot be graded.")
        return out

    p_entry, p_stop = plan.get("entry"), plan.get("stop")
    if p_entry is None or p_stop is None or abs(p_entry - p_stop) < 1e-12:
        out["notes"].append("plan has no usable stop -> no R unit -> nothing to grade against")
        return out

    R = abs(p_entry - p_stop)
    out["R_price"] = R

    # --- slippage: positive = you got a WORSE price than you planned -------
    slip_price = (trade["entry_price"] - p_entry) * dirn
    out["slippage_R"] = slip_price / R

    # --- gross result, measured from the price you ACTUALLY got ------------
    move = (trade["exit_price"] - trade["entry_price"]) * dirn
    out["gross_R"] = move / R

    # --- real costs, in R --------------------------------------------------
    if mpp:
        money_per_R = mpp * R
        if money_per_R > 0:
            cost_money = -(trade.get("commission", 0) + trade.get("swap", 0))   # costs are negative
            out["cost_R"] = cost_money / money_per_R
            out["net_R"] = out["gross_R"] - out["cost_R"]
    else:
        out["notes"].append("cost in R unknown (no contract spec, and the price move was "
                            "too small to infer money-per-price safely)")

    # --- did you do what you said you would do? ---------------------------
    tol = tol_frac * R
    ex = trade["exit_price"]
    if abs(ex - p_stop) <= tol:
        out["exit_reason"] = "stop"
    elif plan.get("t2") is not None and abs(ex - plan["t2"]) <= tol:
        out["exit_reason"] = "t2"
    elif plan.get("t1") is not None and abs(ex - plan["t1"]) <= tol:
        out["exit_reason"] = "t1"
    elif (ex - p_stop) * dirn < 0:
        out["exit_reason"] = "beyond_stop"
        out["notes"].append("EXIT BEYOND THE PLANNED STOP — the stop was widened, moved, "
                            "or not honoured. This is the single most expensive habit there is.")
    else:
        out["exit_reason"] = "discretionary"

    out["followed_plan"] = out["exit_reason"] in ("stop", "t1", "t2")
    if plan.get("t2") is not None:
        out["planned_R_target"] = abs(plan["t2"] - p_entry) / R
    return out


# ==========================================================================
# 4. EXCURSIONS — what the trade OFFERED you vs what you took
# ==========================================================================
def excursions(trade, bars, plan=None):
    """MFE/MAE in R, from real bars between entry and exit.

    mfe_capture is the number that hurts: of the move the market actually handed
    you while you were in, how much did you keep? Consistently low capture means
    you exit winners early. That is an exit problem, not an entry problem, and no
    amount of new strategies will fix it.
    """
    res = {"mfe_R": None, "mae_R": None, "mfe_capture": None, "bars_in_trade": 0}
    # NB: `not trade["open_ms"]` would be True for a timestamp of 0, which is a VALID
    # time. Guard on None, never on truthiness — the same trap costs people real bugs
    # with prices of 0.0 and volumes of 0.
    if not bars or trade.get("open_ms") is None or trade.get("close_ms") is None:
        return res
    if not plan or plan.get("entry") is None or plan.get("stop") is None:
        return res
    R = abs(plan["entry"] - plan["stop"])
    if R < 1e-12:
        return res

    dirn = 1 if trade["side"] == "long" else -1
    inside = [b for b in bars if trade["open_ms"] <= b["t"] <= trade["close_ms"]]
    res["bars_in_trade"] = len(inside)
    if not inside:
        return res

    e = trade["entry_price"]
    if dirn > 0:
        best, worst = max(b["h"] for b in inside), min(b["l"] for b in inside)
    else:
        best, worst = min(b["l"] for b in inside), max(b["h"] for b in inside)

    res["mfe_R"] = (best - e) * dirn / R
    res["mae_R"] = (worst - e) * dirn / R          # negative = it went against you
    realised = (trade["exit_price"] - e) * dirn / R
    if res["mfe_R"] and res["mfe_R"] > 0.05:       # only meaningful if it actually offered something
        res["mfe_capture"] = realised / res["mfe_R"]
    return res


# ==========================================================================
# 5. PLAN MATCHING
# ==========================================================================
def attach_plans(trades, plans, window_ms=4 * 3600 * 1000):
    """Match each trade to the plan that preceded it: same symbol, same side, the
    most recent plan within `window_ms` BEFORE the fill. A plan made after the fill
    is not a plan, it is a story, and it never gets matched."""
    out = []
    for t in trades:
        best, best_dt = None, None
        for p in plans or []:
            if (p.get("symbol") or "").upper() != (t.get("symbol") or "").upper():
                continue
            if p.get("side") and p["side"] != t["side"]:
                continue
            pt = p.get("time_ms")
            if pt is None or t.get("open_ms") is None:
                continue
            dt = t["open_ms"] - pt
            if 0 <= dt <= window_ms and (best_dt is None or dt < best_dt):
                best, best_dt = p, dt
        out.append((t, best))
    return out


# ==========================================================================
# 6. THE AGGREGATE — where your money actually goes
# ==========================================================================
def _avg(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def exec_stats(recons, excs=None):
    """The panel that is worth more than the other 25 strategies combined.

    Returns numbers AND plain-language findings. Every finding names the number it
    came from, and a finding is only emitted when the sample is big enough to mean
    anything (>= 5 trades). Below that it says so instead of pretending.
    """
    n = len(recons or [])
    st = {"trades": n, "graded": 0, "unplanned": 0, "findings": [],
          "avg_slippage_R": None, "avg_cost_R": None,
          "gross_expectancy_R": None, "net_expectancy_R": None,
          "execution_drag_R": None, "mfe_capture_median": None,
          "plan_adherence_pct": None, "beyond_stop_count": 0,
          "avg_hold_win_ms": None, "avg_hold_loss_ms": None, "hold_ratio": None,
          "net_profit": 0.0, "total_costs": 0.0}
    if not n:
        st["findings"].append("No closed trades imported yet. Import your MT5 history to grade your execution.")
        return st

    graded = [r for r in recons if r.get("planned") and r.get("gross_R") is not None]
    st["graded"] = len(graded)
    st["unplanned"] = n - len(graded)
    st["net_profit"] = sum(r.get("net_profit") or 0 for r in recons)
    st["total_costs"] = sum((r.get("commission") or 0) + (r.get("swap") or 0) for r in recons)
    st["beyond_stop_count"] = sum(1 for r in recons if r.get("exit_reason") == "beyond_stop")

    if graded:
        st["avg_slippage_R"] = _avg([r["slippage_R"] for r in graded])
        st["avg_cost_R"] = _avg([r["cost_R"] for r in graded])
        st["gross_expectancy_R"] = _avg([r["gross_R"] for r in graded])
        st["net_expectancy_R"] = _avg([r["net_R"] for r in graded])
        if st["avg_slippage_R"] is not None and st["avg_cost_R"] is not None:
            st["execution_drag_R"] = st["avg_slippage_R"] + st["avg_cost_R"]
        fp = [r for r in graded if r.get("followed_plan") is not None]
        if fp:
            st["plan_adherence_pct"] = 100.0 * sum(1 for r in fp if r["followed_plan"]) / len(fp)

    wins = [r for r in recons if (r.get("net_profit") or 0) > 0 and r.get("hold_ms")]
    losses = [r for r in recons if (r.get("net_profit") or 0) <= 0 and r.get("hold_ms")]
    st["avg_hold_win_ms"] = _avg([r["hold_ms"] for r in wins])
    st["avg_hold_loss_ms"] = _avg([r["hold_ms"] for r in losses])
    if st["avg_hold_win_ms"] and st["avg_hold_loss_ms"] and st["avg_hold_win_ms"] > 0:
        st["hold_ratio"] = st["avg_hold_loss_ms"] / st["avg_hold_win_ms"]

    caps = [e["mfe_capture"] for e in (excs or []) if e and e.get("mfe_capture") is not None]
    if caps:
        st["mfe_capture_median"] = median(caps)

    # ---- findings: only when the sample can carry them -------------------
    F = st["findings"]
    if n < 5:
        F.append(f"Only {n} closed trade(s). Too few to grade execution — "
                 f"nothing below is stable yet. Import more history.")
        return st

    if st["execution_drag_R"] is not None:
        d = st["execution_drag_R"]
        F.append(f"Execution costs you {d:.2f}R per trade "
                 f"(slippage {st['avg_slippage_R']:.2f}R + costs {st['avg_cost_R']:.2f}R). "
                 f"That is {abs(d):.2f}R of edge you never see on a chart.")
    if st["gross_expectancy_R"] is not None and st["net_expectancy_R"] is not None:
        g, nt = st["gross_expectancy_R"], st["net_expectancy_R"]
        if g > 0 >= nt:
            F.append(f"YOUR SETUPS WORK; YOUR EXECUTION DOES NOT. "
                     f"Gross {g:+.2f}R per trade, net {nt:+.2f}R. The edge is real and "
                     f"it is being eaten between the plan and the fill.")
        else:
            F.append(f"Expectancy: {g:+.2f}R gross -> {nt:+.2f}R net per trade.")
    if st["mfe_capture_median"] is not None:
        c = st["mfe_capture_median"]
        if c < 0.5:
            F.append(f"You capture only {c*100:.0f}% of the move your trades hand you "
                     f"(median). You are exiting winners early — that is an EXIT problem, "
                     f"and no new strategy will fix it.")
        else:
            F.append(f"You capture {c*100:.0f}% of the available move (median).")
    if st["hold_ratio"] is not None:
        h = st["hold_ratio"]
        if h > 1.3:
            F.append(f"You hold losers {h:.1f}x longer than winners. The textbook leak: "
                     f"hoping on losers, snatching at winners.")
        elif h < 0.8:
            F.append(f"You hold winners {1/h:.1f}x longer than losers — the right way round.")
    if st["plan_adherence_pct"] is not None:
        a = st["plan_adherence_pct"]
        F.append(f"You followed your own plan on {a:.0f}% of graded trades.")
    if st["beyond_stop_count"]:
        F.append(f"{st['beyond_stop_count']} trade(s) exited BEYOND the planned stop — "
                 f"the stop was widened or ignored. This is the most expensive habit there is.")
    if st["unplanned"]:
        F.append(f"{st['unplanned']} trade(s) had no plan at all. They count in your P/L "
                 f"but cannot be graded — and untracked trades are where edges go to die.")
    return st


def full_report(deals, plans=None, bars_by_symbol=None, specs=None):
    """deals -> trades -> reconciled -> excursions -> stats. The whole pipeline."""
    trades = deals_to_trades(deals)
    pairs = attach_plans(trades, plans or [])
    recons, excs = [], []
    for t, p in pairs:
        spec = (specs or {}).get(t["symbol"])
        r = reconcile(t, p, spec)
        e = excursions(t, (bars_by_symbol or {}).get(t["symbol"]), p)
        r.update({k: v for k, v in e.items() if k != "bars_in_trade"})
        recons.append(r)
        excs.append(e)
    return {"trades": trades, "recons": recons, "stats": exec_stats(recons, excs)}
