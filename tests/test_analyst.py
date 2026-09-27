"""v39.18 -- the standalone decision engine (mishel_analyst.py)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import mishel_analyst as A

P = 0; F = 0
def ok(m, c):
    global P, F
    if c: P += 1; print("  " + m + " \u2713")
    else: F += 1; print("  " + m + " \u2717 FAIL")

print("\n=== v39.18 STANDALONE DECISION ENGINE ===\n")

# determinism
s = {"confluence": {"score": 40, "agree_pct": 60}, "mtf": [{"tf": "1H", "score": 0.3, "weight": 1}]}
ok("D1: deterministic (same input -> same output)", A.analyze(s) == A.analyze(s))

# grounded: empty state never invents a decision
z = A.analyze({})
ok("D2: empty state -> Neutral, zero conviction, no fabrication", z["bias"] == "Neutral" and z["conviction"] == 0)

# a clean bullish stack reads Buy
bull = {"regime": "trending", "adx": 30,
        "confluence": {"score": 55, "agree_pct": 65},
        "mtf": [{"tf": "1H", "score": 0.4, "weight": 1}, {"tf": "4H", "score": 0.5, "weight": 1.4}, {"tf": "1D", "score": 0.3, "weight": 1.8}],
        "orderflow": {"imbalance": 0.66, "taker_buy": 0.62},
        "news_min": None, "account": {"heat": 1, "locked": False}}
rb = A.analyze(bull)
ok("D3: clean bullish stack -> Buy/Strong Buy, direction +1", rb["direction"] == 1 and "Buy" in rb["bias"])
ok("D4: trending regime + aligned + not-coin-flip lifts conviction", rb["conviction"] >= 40)

# a bearish stack reads Sell
bear = dict(bull, confluence={"score": -55, "agree_pct": 65},
            mtf=[{"tf": "1H", "score": -0.4, "weight": 1}, {"tf": "4H", "score": -0.5, "weight": 1.4}, {"tf": "1D", "score": -0.3, "weight": 1.8}],
            orderflow={"imbalance": 0.34, "taker_buy": 0.4})
rs = A.analyze(bear)
ok("D5: bearish stack -> Sell, direction -1", rs["direction"] == -1 and "Sell" in rs["bias"])

# the news gate caps conviction even on a strong read
newsy = dict(bull, news_min=12)
rn = A.analyze(newsy)
gate = next((g for g in rn["gates"] if g["name"] == "news window clear"), None)
ok("D6: imminent high-impact event fails the news gate", gate is not None and gate["pass"] is False)
ok("D7: failing a gate lowers conviction vs the same read clear", rn["conviction"] < rb["conviction"])

# locked account -> stand down regardless of signal
lk = dict(bull, account={"heat": 1, "locked": True})
rl = A.analyze(lk)
ok("D8: locked account -> posture says stand down", "stand down" in rl["posture"].lower())

# glass-box: reasons reconstruct the drivers; gates are enumerated
ok("D9: reasons list present and non-empty (auditable)", isinstance(rb["reasons"], list) and len(rb["reasons"]) >= 2)
ok("D10: gates enumerated with pass/detail", all(("pass" in g and "detail" in g) for g in rb["gates"]))

# conflict: MTF down but this-TF confluence up -> low-conviction / neutral-ish (the screenshot case)
conflict = {"regime": "ranging", "adx": 17, "confluence": {"score": 35, "agree_pct": 43},
            "mtf": [{"tf": "5m", "score": -0.18, "weight": 0.5}, {"tf": "1D", "score": -0.08, "weight": 1.8}, {"tf": "1W", "score": -0.23, "weight": 2.2}]}
rc = A.analyze(conflict)
ok("D11: MTF/confluence conflict in a ranging regime -> low conviction", rc["conviction"] < 25)

# invalidation always tells you what would flip it
ok("D12: invalidation is always populated", isinstance(rb["invalidation"], list) and len(rb["invalidation"]) >= 1)

print("\n  %d passed, %d failed\n" % (P, F))
sys.exit(1 if F else 0)
