#!/usr/bin/env python3
"""
v37.0 — RISK GOVERNOR  (server/mishel_risk.py)

WHAT WAS WRONG

Risk was PER-TRADE and nothing else. "1% per trade" is not a risk system; it is a
sentence. The terminal had no idea:
  · how much you had already lost TODAY (it read PAPER.bal — the DEMO balance)
  · how much risk was ALREADY OPEN across every position
  · that long EURUSD + short USDCHF + long AUDUSD is not three 1% bets.
    It is ONE 3% bet on the dollar falling. Correlation does not care that you
    opened them in different windows.
  · that you were three losses deep and tilting
  · that an open position had NO STOP ON IT

Three "uncorrelated" 1% trades that are really one 3% trade is how a good month
becomes a bad quarter, and nothing in 36 versions would have said a word.

WHAT IT DOES

  · position_size()   — lots from the BROKER'S REAL CONTRACT SPEC, not a guess.
                        (The shipped ticket divided every FX-ish symbol by 100,000 —
                        including XAUUSD, whose contract is 100 oz. That is a 1000x
                        sizing error on gold. See test RS_GOLD.)
  · net_exposure()    — decomposes every position into CURRENCY LEGS. Long EURUSD is
                        long EUR / short USD. It sums the real bet, not the ticket count.
  · unprotected()     — positions with no stop loss. The loudest thing this file says.
  · evaluate()        — the verdict: ALLOW / WARN / BLOCK, with reasons in plain English.

WHAT IT WILL NEVER DO

It cannot and must not stop you clicking Buy in MT5. Nothing here auto-executes and
nothing here can. What it CAN do is refuse to hand you the order ticket — the same
enforcement point the freshness contract uses. The last human step stays human; the
system simply declines to make a bad trade convenient.

Pure functions. No I/O. Every number below is unit-tested against a hand-computed answer.
"""

# --------------------------------------------------------------------------
# 1. CURRENCY DECOMPOSITION — the honest way to see correlation
# --------------------------------------------------------------------------
# No hard-coded correlation matrix, no rolling-window correlation that changes its mind
# every Tuesday. A pair IS its two legs. Long EURUSD is a long EUR and a short USD,
# definitionally, forever. That is not a model; it is arithmetic.

METALS = {"XAUUSD": ("XAU", "USD"), "XAGUSD": ("XAG", "USD"),
          "GOLD": ("XAU", "USD"), "SILVER": ("XAG", "USD")}

CCY = {"USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD",
       "SEK", "NOK", "SGD", "HKD", "MXN", "ZAR", "TRY", "PLN", "CNH"}


def currency_legs(symbol):
    """'EURUSD' -> ('EUR','USD'). Returns None when it is not an FX/metal pair
    (an index or a stock has no currency legs to net, and pretending otherwise
    would invent an exposure that does not exist)."""
    if not symbol:
        return None
    s = "".join(ch for ch in str(symbol).upper() if ch.isalpha())
    # strip broker suffixes: EURUSDM, EURUSDPRO, EURUSDFIX...
    for suf in ("PRO", "FIX", "ECN", "RAW", "CASH", "M", "A", "C", "I", "Z"):
        if len(s) > 6 and s.endswith(suf):
            s = s[: -len(suf)]
            break
    if s in METALS:
        return METALS[s]
    if len(s) == 6 and s[:3] in CCY and s[3:] in CCY:
        return (s[:3], s[3:])
    if s[:3] in ("XAU", "XAG") and s[3:6] in CCY:
        return (s[:3], s[3:6])
    return None


def net_exposure(positions):
    """Positions -> net risk per CURRENCY, in R.

    Each position contributes +risk_R to its base currency and -risk_R to its quote.
    A long EURUSD at 1R and a short USDCHF at 1R both bet against the dollar:
        EURUSD long  1R  -> EUR +1, USD -1
        USDCHF short 1R  -> USD -1, CHF +1
        => USD = -2R.  ONE two-R bet on a falling dollar, wearing two tickets.

    positions: [{"symbol","side","risk_R"}]
    """
    net = {}
    unmapped = []
    for p in positions or []:
        legs = currency_legs(p.get("symbol"))
        r = p.get("risk_R")
        if r is None:
            continue
        if not legs:
            unmapped.append(p.get("symbol"))
            continue
        sign = 1 if p.get("side") == "long" else -1
        base, quote = legs
        net[base] = net.get(base, 0.0) + sign * r
        net[quote] = net.get(quote, 0.0) - sign * r
    return {"net": net, "unmapped": unmapped}


def concentration(positions):
    """The single biggest one-currency bet, in R. This is the number that matters:
    not "how many trades am I in" but "how big is my largest actual bet"."""
    ex = net_exposure(positions)
    if not ex["net"]:
        return {"currency": None, "R": 0.0, "net": {}, "unmapped": ex["unmapped"]}
    ccy, val = max(ex["net"].items(), key=lambda kv: abs(kv[1]))
    return {"currency": ccy, "R": val, "net": ex["net"], "unmapped": ex["unmapped"]}


# --------------------------------------------------------------------------
# 2. POSITION SIZING — from the broker's real contract spec
# --------------------------------------------------------------------------
def position_size(equity, risk_pct, entry, stop, spec=None):
    """How many LOTS risks exactly `risk_pct` of equity if the stop is hit.

    Returns (lots, detail) or (None, reason). It returns None rather than a guess,
    because a guessed lot size is not a smaller error than a missing one — it is a
    bigger one, since you will actually trade it.

    The money at risk for `lots` lots over a price distance `d`:
        risk_money = lots * contract_size * d          (quote-currency terms)
    so
        lots = risk_money / (contract_size * d)

    EURUSD: contract 100,000. A 50-pip (0.0050) stop, $100 risk
        -> 100 / (100000 * 0.0050) = 0.20 lots.        [hand-checked]
    XAUUSD: contract 100 OUNCES, not 100,000. A $10 stop, $100 risk
        -> 100 / (100 * 10) = 0.10 lots.               [hand-checked]
    The shipped ticket used /100000 for anything matching /EUR|GBP|JPY|XAU/, which
    sized gold 1000x too small. That is what a real spec is for.
    """
    if not equity or equity <= 0:
        return None, "no account equity — connect MT5 or enter your real balance"
    if not risk_pct or risk_pct <= 0:
        return None, "risk % must be > 0"
    d = abs((entry or 0) - (stop or 0))
    if d <= 0:
        return None, "entry and stop are the same price — there is no risk to size"

    cs = (spec or {}).get("contract_size")
    if not cs:
        return None, ("no contract spec for this symbol — run the MT5 bridge (or /svc/mt5/sync) "
                      "so sizing uses the broker's REAL contract size. Guessing it is how gold "
                      "gets sized 1000x wrong.")

    risk_money = equity * risk_pct / 100.0
    lots = risk_money / (cs * d)

    step = (spec or {}).get("volume_step") or 0.01
    vmin = (spec or {}).get("volume_min") or 0.01
    # ALWAYS round DOWN to the broker's step: rounding up silently exceeds the risk
    # limit you just set, which defeats the entire point of setting one.
    #
    # BUT: 1.1000 - 1.0950 == 0.005000000000000115 in IEEE754, which makes lots_exact
    # 0.19999999999999538 instead of 0.20 — and a naive floor turns a correct 0.20 into
    # 0.19. A rounding rule that is wrong on every round number is not a rounding rule.
    # The epsilon absorbs representation noise without ever rounding a genuine 0.198 up.
    import math
    if step > 0:
        lots_r = math.floor(lots / step + 1e-9) * step
    else:
        lots_r = lots
    lots_r = round(lots_r, 8)

    detail = {"risk_money": risk_money, "contract_size": cs, "stop_distance": d,
              "lots_exact": lots, "lots": lots_r, "volume_step": step, "volume_min": vmin,
              "actual_risk_money": lots_r * cs * d}
    if lots_r < vmin:
        return 0.0, (f"the correct size ({lots:.4f} lots) is BELOW your broker's minimum "
                     f"({vmin}). Taking the minimum would risk "
                     f"{vmin * cs * d:.2f} — more than your {risk_pct}% rule allows. "
                     f"Widen the account, tighten the stop, or skip the trade.")
    return lots_r, detail


# --------------------------------------------------------------------------
# 3. UNPROTECTED POSITIONS — the loudest thing in this file
# --------------------------------------------------------------------------
def unprotected(positions):
    """Open positions with NO stop loss. There is no such thing as an acceptable
    unprotected position for a discretionary trader who is not at the screen —
    and you are always in MT5, not at this terminal."""
    return [p for p in (positions or [])
            if not p.get("sl") or float(p.get("sl") or 0) == 0.0]


# --------------------------------------------------------------------------
# 4. STATE — computed from REAL fills, not the demo account
# --------------------------------------------------------------------------
def day_bounds_ms(now_ms, reset_hour_utc=0):
    """The trading day boundary. Configurable because a daily-loss rule that resets at
    midnight UTC in the middle of the New York session is not a daily-loss rule."""
    day = 86400_000
    shift = int(reset_hour_utc * 3600_000)
    start = ((now_ms - shift) // day) * day + shift
    return start, start + day


def compute_state(recons, positions, equity, now_ms, cfg=None):
    """The governor's picture of RIGHT NOW, from reconciled real trades.

    `recons` are the output of mishel_recon.reconcile — real fills, real costs, real R.
    That is the whole point: this is your risk, not the demo's.
    """
    cfg = cfg or DEFAULTS
    start, end = day_bounds_ms(now_ms, cfg.get("day_reset_hour_utc", 0))

    today = [r for r in (recons or []) if r.get("close_ms") is not None
             and start <= r["close_ms"] < end]
    realized_R = sum(r["net_R"] for r in today if r.get("net_R") is not None)
    measured = [r for r in today if r.get("net_R") is not None]

    # consecutive losses, walking BACKWARDS from the most recent closed trade
    closed = sorted([r for r in (recons or []) if r.get("close_ms") is not None],
                    key=lambda r: r["close_ms"])
    streak, last_loss_ms = 0, None
    for r in reversed(closed):
        if (r.get("net_profit") or 0) < 0:
            streak += 1
            if last_loss_ms is None:
                last_loss_ms = r["close_ms"]
        else:
            break

    open_risk_R, open_pos = 0.0, []
    for p in positions or []:
        rr = p.get("risk_R")
        if rr is not None:
            open_risk_R += rr
        open_pos.append({"symbol": p.get("symbol"), "side": p.get("side"),
                         "risk_R": rr, "sl": p.get("sl"),
                         # carried through, or the "risk UNKNOWN" warning can never fire
                         # from the real service path — the flag would die right here.
                         "risk_unknown": bool(p.get("risk_unknown"))})

    return {
        "now_ms": now_ms, "day_start_ms": start,
        "equity": equity,
        "realized_R_today": realized_R,
        "trades_today": len(today),
        "graded_today": len(measured),
        "ungraded_today": len(today) - len(measured),
        "consecutive_losses": streak,
        "last_loss_ms": last_loss_ms,
        "open_risk_R": open_risk_R,
        "open_positions": open_pos,
        "unprotected": unprotected(positions),
        "concentration": concentration(open_pos),
    }


DEFAULTS = {
    "max_daily_loss_R": 2.0,        # stop for the day after -2R realized
    "max_open_risk_R": 3.0,         # never have more than 3R live at once
    "max_concentration_R": 2.0,     # no single currency bet bigger than 2R
    "max_trades_per_day": 5,
    "max_risk_per_trade_pct": 1.0,
    "consecutive_loss_limit": 3,
    "cooldown_minutes": 60,
    "day_reset_hour_utc": 0,
    "block_when_unprotected": True,
}


# --------------------------------------------------------------------------
# 5. THE VERDICT
# --------------------------------------------------------------------------
BLOCK, WARN, ALLOW = "block", "warn", "allow"


def evaluate(state, proposed=None, cfg=None):
    """ALLOW / WARN / BLOCK, with reasons a human can act on.

    `proposed` = {"symbol","side","risk_R","risk_pct"} — the trade being considered.
    Omit it to grade the account as it stands.

    A BLOCK is not a moral judgement. It means: the ticket will not be built. You can
    still place the trade by hand in MT5, because you are an adult and this is your
    money. The system just declines to make it convenient.
    """
    cfg = {**DEFAULTS, **(cfg or {})}
    reasons, verdict = [], ALLOW

    def esc(v):
        nonlocal verdict
        if v == BLOCK:
            verdict = BLOCK
        elif v == WARN and verdict != BLOCK:
            verdict = WARN

    # --- 1. unprotected positions: nothing else matters until this is fixed ---
    if state.get("unprotected"):
        syms = ", ".join(str(p.get("symbol")) for p in state["unprotected"])
        esc(BLOCK if cfg["block_when_unprotected"] else WARN)
        reasons.append({"rule": "unprotected", "level": BLOCK,
                        "msg": f"{len(state['unprotected'])} OPEN POSITION(S) WITH NO STOP LOSS: {syms}. "
                               f"Fix that before you think about a new trade. An unprotected position "
                               f"is not a trade, it is an open-ended bet on your own attention."})

    # --- 2. daily loss limit ------------------------------------------------
    lim = -abs(cfg["max_daily_loss_R"])
    got = state.get("realized_R_today", 0.0)
    if got <= lim:
        esc(BLOCK)
        reasons.append({"rule": "daily_loss", "level": BLOCK,
                        "msg": f"DAY IS DONE: {got:+.2f}R realized today, limit {lim:+.2f}R. "
                               f"The next trade is not a setup, it is a refund request."})
    elif got <= lim * 0.7:
        esc(WARN)
        reasons.append({"rule": "daily_loss", "level": WARN,
                        "msg": f"{got:+.2f}R today — {abs(lim - got):.2f}R from your daily stop."})

    # --- 3. consecutive losses / cooldown -----------------------------------
    streak = state.get("consecutive_losses", 0)
    if streak >= cfg["consecutive_loss_limit"]:
        mins_left = None
        if state.get("last_loss_ms") and state.get("now_ms"):
            elapsed = (state["now_ms"] - state["last_loss_ms"]) / 60000.0
            mins_left = max(0.0, cfg["cooldown_minutes"] - elapsed)
        if mins_left is None or mins_left > 0:
            esc(BLOCK)
            reasons.append({"rule": "cooldown", "level": BLOCK,
                            "msg": f"{streak} losses in a row. Cooldown active"
                                   + (f" — {mins_left:.0f} min left. " if mins_left else ". ")
                                   + "The market will still be there. Revenge trading is the only "
                                     "strategy with a proven negative expectancy."})
        else:
            esc(WARN)
            reasons.append({"rule": "cooldown", "level": WARN,
                            "msg": f"{streak} losses in a row, but the cooldown has expired. "
                                   f"Take the next setup only if you would take it on a green day."})

    # --- 4. trades per day --------------------------------------------------
    if state.get("trades_today", 0) >= cfg["max_trades_per_day"]:
        esc(BLOCK)
        reasons.append({"rule": "trade_count", "level": BLOCK,
                        "msg": f"{state['trades_today']} trades today (limit {cfg['max_trades_per_day']}). "
                               f"Past this point you are not trading, you are clicking."})

    # --- 5. open risk + the proposed trade ----------------------------------
    open_R = state.get("open_risk_R", 0.0)
    add_R = (proposed or {}).get("risk_R") or 0.0
    total = open_R + add_R
    if total > cfg["max_open_risk_R"]:
        esc(BLOCK)
        reasons.append({"rule": "open_risk", "level": BLOCK,
                        "msg": f"Live risk would be {total:.2f}R (open {open_R:.2f}R "
                               f"+ this {add_R:.2f}R), over your {cfg['max_open_risk_R']:.2f}R cap."})

    # --- 6. CORRELATION: the one nobody sees --------------------------------
    if proposed and proposed.get("symbol"):
        hypo = list(state.get("open_positions") or []) + [{
            "symbol": proposed["symbol"], "side": proposed.get("side"), "risk_R": add_R}]
    else:
        hypo = list(state.get("open_positions") or [])
    con = concentration(hypo)
    if con["currency"] and abs(con["R"]) > cfg["max_concentration_R"]:
        esc(BLOCK)
        direction = "SHORT" if con["R"] < 0 else "LONG"
        legs = [p["symbol"] for p in hypo if currency_legs(p.get("symbol"))
                and con["currency"] in currency_legs(p["symbol"])]
        reasons.append({"rule": "concentration", "level": BLOCK,
                        "msg": f"THIS IS ONE BET, NOT {len(legs)}. Your net {con['currency']} exposure "
                               f"would be {abs(con['R']):.2f}R {direction} across {', '.join(legs)} — "
                               f"over your {cfg['max_concentration_R']:.2f}R cap. Correlation does not "
                               f"care that you opened them in different windows."})
    elif con["currency"] and abs(con["R"]) > cfg["max_concentration_R"] * 0.75:
        esc(WARN)
        reasons.append({"rule": "concentration", "level": WARN,
                        "msg": f"Net {con['currency']} exposure {abs(con['R']):.2f}R — approaching your "
                               f"{cfg['max_concentration_R']:.2f}R single-currency cap."})

    # --- 7. per-trade risk --------------------------------------------------
    rp = (proposed or {}).get("risk_pct")
    if rp is not None and rp > cfg["max_risk_per_trade_pct"]:
        esc(BLOCK)
        reasons.append({"rule": "per_trade", "level": BLOCK,
                        "msg": f"{rp:.2f}% risk on one trade, over your "
                               f"{cfg['max_risk_per_trade_pct']:.2f}% rule."})

    if con["unmapped"]:
        reasons.append({"rule": "coverage", "level": WARN,
                        "msg": f"Not currency-netted (no FX legs): {', '.join(sorted(set(con['unmapped'])))}. "
                               f"Their risk counts toward open risk but NOT toward currency concentration — "
                               f"stated so you know what is and is not being watched."})

    # --- 8. THE UNKNOWN IS NOT THE SAME AS THE SAFE -------------------------
    # If we cannot see the open book, we cannot say "within every limit". A governor
    # that reports all-clear over a book it cannot read is worse than no governor,
    # because it manufactures confidence it has not earned.
    if state.get("position_source_error"):
        esc(WARN)
        reasons.append({"rule": "blind", "level": WARN,
                        "msg": f"OPEN POSITIONS UNKNOWN — {state['position_source_error']}. "
                               f"Open risk and currency concentration are NOT being checked right now. "
                               f"This is not an all-clear; it is a blind spot."})
    if state.get("equity", 0) <= 0:
        esc(WARN)
        reasons.append({"rule": "blind", "level": WARN,
                        "msg": "No account equity — position sizes cannot be checked against a real "
                               "balance. Connect the MT5 bridge, or set your real balance in Settings."})
    for p in state.get("open_positions") or []:
        if p.get("risk_unknown"):
            esc(WARN)
            reasons.append({"rule": "blind", "level": WARN,
                            "msg": f"{p['symbol']} has a stop, but no contract spec — its risk in R is "
                                   f"UNKNOWN and is NOT counted in your open risk. Run /svc/mt5/sync."})

    if verdict == ALLOW and not reasons:
        reasons.append({"rule": "ok", "level": ALLOW,
                        "msg": "Within every limit you set. Risk is not the reason to skip this one."})

    return {"verdict": verdict, "reasons": reasons, "concentration": con,
            "open_risk_R": open_R, "would_be_risk_R": total,
            "realized_R_today": state.get("realized_R_today", 0.0),
            "consecutive_losses": state.get("consecutive_losses", 0),
            "config": cfg}
