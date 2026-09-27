"""
mishel_analyst.py  --  v39.18  --  the standalone live-decision engine.

A SEPARATE, glass-box analysis brain. It takes the terminal's live state (the
same numbers already on your screen) and returns ONE explainable decision:
bias, direction, conviction, the gates it passed/failed, the drivers with their
weights, the risk notes, and exactly what would flip the call.

Design rules (identical philosophy to the rest of Mishel):
  * DETERMINISTIC. Same input -> same output. No RNG, no LLM, no hidden state.
  * GROUNDED. Every number comes from the state you pass in. Missing inputs are
    treated as "unknown" and simply don't contribute -- never invented.
  * GLASS-BOX. The returned `reasons` and `gates` fully reconstruct the score,
    so a human (or an examiner) can audit exactly why it said what it said.
  * DECISION-SUPPORT, NOT ADVICE. It never guarantees an outcome and never
    sizes or places a trade. It tells you what the evidence leans toward and
    what would change its mind. You execute, at your broker, by hand.

Call `analyze(state) -> dict`. Pure function; import it anywhere, test it freely.
"""

from __future__ import annotations

# ---- small pure helpers -------------------------------------------------------

def _clamp(x, lo, hi):
    return lo if x < lo else min(x, hi)

def _num(x):
    try:
        f = float(x)
        if f != f or f in (float("inf"), float("-inf")):  # noqa: PLR0124  (f != f is NaN)
            return None
        return f
    except (TypeError, ValueError):
        return None

def _label(score):
    """Map a -100..100 score to a five-step bias label."""
    if score >= 45:  return "Strong Buy", 1
    if score >= 15:  return "Buy", 1
    if score <= -45: return "Strong Sell", -1
    if score <= -15: return "Sell", -1
    return "Neutral", 0


# ---- the drivers --------------------------------------------------------------
# Each driver returns (contribution in -100..100, weight, human sentence) or None
# when its input is missing. The final score is a weight-normalised blend.

def _mtf_driver(state):
    """Higher-timeframe-weighted bias. The backbone: a 5m read inside a daily
    downtrend is a different trade than inside a daily uptrend."""
    mtf = state.get("mtf")
    if not mtf:
        return None
    num = 0.0; den = 0.0; ups = 0; total = 0
    for r in mtf:
        sc = _num(r.get("score"))
        w = _num(r.get("weight")) or 1.0
        if sc is None:
            continue
        num += sc * w; den += w; total += 1
        if sc > 0: ups += 1
    if den == 0 or total == 0:
        return None
    # scores arrive on a -1..1 confluence scale -> stretch to -100..100
    val = _clamp(num / den * 100.0, -100, 100)
    agree = max(ups, total - ups) / total
    where = "up" if val > 0 else "down" if val < 0 else "flat"
    return (val, 2.2, "Higher-timeframe bias is %s (%d of %d timeframes agree, weighted)."
            % (where, max(ups, total - ups), total), {"alignment": round(agree, 2)})

def _confluence_driver(state):
    conf = state.get("confluence")
    if not conf:
        return None
    sc = _num(conf.get("score"))            # expected -100..100
    if sc is None:
        return None
    agree = _num(conf.get("agree_pct"))     # 0..100
    detail = "This-timeframe confluence reads %+d." % round(sc)
    return (_clamp(sc, -100, 100), 1.4, detail, {"agree_pct": agree})

def _orderflow_driver(state):
    of = state.get("orderflow")
    if not of:
        return None
    imb = _num(of.get("imbalance"))          # 0..1 share of near depth on the bid
    taker = _num(of.get("taker_buy"))        # 0..1 aggressor buy share, or None
    parts = []
    val = 0.0; n = 0
    if imb is not None:
        val += (imb - 0.5) * 2 * 100; n += 1
        parts.append("book %d%% bid-heavy" % round(imb * 100))
    if taker is not None:
        val += (taker - 0.5) * 2 * 100; n += 1
        parts.append("%d%% of takers buying" % round(taker * 100))
    if n == 0:
        return None
    val = _clamp(val / n, -100, 100)
    return (val, 0.9, "Order flow: " + ", ".join(parts) + " (short-term tilt).", {})

def _regime_scale(state):
    """Regime doesn't add direction; it scales how much we trust a directional
    read. Ranging markets punish trend-following; strong trends reward it."""
    reg = (state.get("regime") or "").lower()
    adx = _num(state.get("adx"))
    if "trend" in reg or (adx is not None and adx >= 25):
        return 1.15, "trending regime (directional reads carry more weight)"
    if "rang" in reg or (adx is not None and adx < 18):
        return 0.7, "ranging regime (fade extremes; directional reads carry less weight)"
    return 1.0, "transitional regime"


# ---- objectivity gates --------------------------------------------------------
# Gates don't move the score; they cap CONVICTION. A strong score behind a failed
# gate is exactly the over-confidence this engine exists to prevent.

def _gates(state, score):
    gates = []

    news_min = _num(state.get("news_min"))
    if news_min is None:
        gates.append({"name": "news window clear", "pass": True, "detail": "no scheduled high-impact event known"})
    else:
        ok = news_min > 30
        gates.append({"name": "news window clear", "pass": ok,
                      "detail": ("clear (%d min out)" % int(news_min)) if ok else
                                ("high-impact event in %d min -- spreads/volatility spike" % int(news_min))})

    conf = state.get("confluence") or {}
    agree = _num(conf.get("agree_pct"))
    if agree is not None:
        ok = agree >= 50
        gates.append({"name": "not a coin-flip", "pass": ok,
                      "detail": ("indicators agree %d%%" % round(agree)) if ok else
                                ("only %d%% of indicators agree -- edge is thin" % round(agree))})

    mtf = state.get("mtf")
    if mtf:
        ups = sum(1 for r in mtf if (_num(r.get("score")) or 0) > 0)
        total = sum(1 for r in mtf if _num(r.get("score")) is not None)
        if total:
            align = max(ups, total - ups) / total
            ok = align >= 0.66
            gates.append({"name": "timeframes aligned", "pass": ok,
                          "detail": ("%d of %d timeframes agree" % (max(ups, total - ups), total)) if ok else
                                    ("timeframes split (%d/%d) -- lower conviction" % (max(ups, total - ups), total))})

    acct = state.get("account") or {}
    if acct.get("locked"):
        gates.append({"name": "account not locked", "pass": False, "detail": "daily loss limit hit -- stand down"})
    heat = _num(acct.get("heat"))
    if heat is not None:
        ok = heat < 6
        gates.append({"name": "risk headroom", "pass": ok,
                      "detail": ("heat %d%%" % round(heat)) if ok else ("heat %d%% -- little headroom left" % round(heat))})

    reg = (state.get("regime") or "").lower()
    if reg and abs(score) >= 15:
        trend = "trend" in reg
        # a directional call in a ranging regime is a soft fail worth surfacing
        ok = trend or abs(score) < 45
        gates.append({"name": "regime matches read", "pass": ok,
                      "detail": ("%s regime supports a directional read" % reg) if ok else
                                ("strong directional read inside a %s regime -- conflicted" % reg)})

    return gates


# ---- the public entry point ---------------------------------------------------

def analyze(state):
    """state: dict of live terminal numbers (all optional). Returns a decision dict."""
    if not isinstance(state, dict):
        return {"ok": False, "err": "state must be an object"}

    drivers = []
    for fn in (_mtf_driver, _confluence_driver, _orderflow_driver):
        try:
            d = fn(state)
        except Exception:
            d = None
        if d:
            drivers.append(d)

    reasons = []
    if drivers:
        num = sum(val * w for (val, w, _t, _m) in drivers)
        den = sum(w for (_v, w, _t, _m) in drivers)
        raw = num / den if den else 0.0
    else:
        raw = 0.0

    scale, reg_txt = _regime_scale(state)
    score = _clamp(raw * scale, -100, 100)

    for (val, w, text, _m) in drivers:
        reasons.append({"driver": text, "points": round(val, 1), "weight": w})
    reasons.append({"driver": "Regime adjustment -- " + reg_txt, "points": None, "weight": round(scale, 2)})

    label, direction = _label(score)
    gates = _gates(state, score)
    passed = sum(1 for g in gates if g["pass"])
    ngate = len(gates)
    gate_ratio = (passed / ngate) if ngate else 1.0

    # conviction: magnitude of the score, throttled by how many gates cleared,
    # and by whether we even had corroborating drivers.
    base = abs(score)
    breadth = min(1.0, 0.5 + 0.25 * len(drivers))   # more independent drivers -> more trust
    conviction = round(_clamp(base * (0.35 + 0.65 * gate_ratio) * breadth, 0, 100))

    # what would flip / weaken the call
    invalidation = []
    if direction != 0:
        levels = state.get("levels") or {}
        inval = levels.get("support") if direction > 0 else levels.get("resistance")
        if _num(inval) is not None:
            invalidation.append("a clean break of %s (the level this read leans against)" % _fmt(inval))
    for g in gates:
        if not g["pass"]:
            invalidation.append("gate still failing: %s (%s)" % (g["name"], g["detail"]))
    if not invalidation:
        invalidation.append("a flip in the higher-timeframe bias or order-flow tilt")

    # posture in plain language -- support, not an order
    if state.get("account", {}).get("locked"):
        posture = "Stand down -- the account is locked by the daily loss limit."
    elif conviction < 25 or direction == 0:
        posture = "No edge worth acting on right now -- wait for alignment or a level to react to."
    elif gate_ratio < 0.6:
        posture = "%s lean, but gates are failing -- if you take it, size down and place the stop first." % label
    else:
        posture = "%s with %d%% conviction -- if it triggers at your level, plan the trade and place the stop first." % (label, conviction)

    return {
        "ok": True,
        "bias": label,
        "direction": direction,
        "score": round(score, 1),
        "conviction": conviction,
        "regime": reg_txt,
        "gates": gates,
        "gates_passed": passed,
        "gates_total": ngate,
        "reasons": reasons,
        "invalidation": invalidation,
        "posture": posture,
        "levels": state.get("levels") or {},
        "note": "Deterministic decision-support from live terminal state -- not advice, no prediction, no auto-execution.",
    }


def _fmt(x):
    n = _num(x)
    if n is None:
        return str(x)
    return ("%.1f" % n) if abs(n) >= 1000 else ("%.4f" % n if abs(n) < 1 else "%.2f" % n)


if __name__ == "__main__":
    import json
    demo = {
        "price": 64850, "adx": 17, "regime": "ranging", "session": "New York",
        "confluence": {"score": 35, "agree_pct": 43},
        "mtf": [{"tf": "5m", "score": -0.18, "weight": 0.5}, {"tf": "15m", "score": -0.35, "weight": 0.7},
                {"tf": "1H", "score": -0.13, "weight": 1.0}, {"tf": "4H", "score": -0.01, "weight": 1.4},
                {"tf": "1D", "score": -0.08, "weight": 1.8}, {"tf": "1W", "score": -0.23, "weight": 2.2}],
        "orderflow": {"imbalance": 0.44, "taker_buy": 0.47},
        "news_min": None, "levels": {"support": 64549, "resistance": 65044},
        "account": {"heat": 0, "open_risk": 0, "locked": False},
    }
    print(json.dumps(analyze(demo), indent=2))
