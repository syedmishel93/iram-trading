"""
The claims ledger: what the terminal said, and what happened next.

WHY THIS IS ON THE SERVER AND NOT ONLY IN THE BROWSER
-----------------------------------------------------
`app/src/learn/` already records claims and resolves them from bars. It keeps
them in the browser's KV store, which is localStorage: about five megabytes,
shared with the drawing store and the bar archive, capped at five thousand
entries, and — as `app/src/store/durability.ts` exists to point out — capable of
accepting a write and discarding it on teardown without telling anybody.

That is an acceptable place for a preference. It is a poor place for the single
asset in this system that cannot be regenerated. Bars can be re-fetched from a
vendor for free; a claim the terminal made in March, before the outcome was
known, cannot be reconstructed from anything, at any price. Losing it does not
degrade the track record, it silently rewrites it — and it is always the newest
write that fails when a quota is hit, so the claims lost are the recent ones.

So this is the durable copy, in SQLite, next to the nightly backup that already
runs for everything else in `mishel.db`.

WHAT IT ADDS BEYOND STORAGE
---------------------------
Questions the browser cannot answer, because they need SQL over the whole
history rather than a filtered array in one tab:

  * hit rate by setup kind, by symbol, by timeframe, by session
  * TAKES versus STAND-DOWNS as two populations — the comparison
    `learn/claim.ts` says nothing else in the repository can produce, and the
    only way to find out whether the gates earn their refusals or merely say no
  * calibration: when the terminal was more confident, was it more often right?

WHAT IT DOES NOT DO
-------------------
Nothing here feeds back into any score, weight or threshold. Same refusal, for
the same reason, as `app/src/learn/store.ts`: the measured PBO of the shipped
strategy set is 89%, and closing the loop on a few dozen samples from one
operator's instruments is that failure with a shorter cycle and no out-of-sample
split to catch it. The ledger measures the terminal and stops. A human changes
the rules.
"""

import math
import time

# The columns a claim is stored under. Kept in one list because three separate
# statements below have to agree about the order, and they drifted once.
COLUMNS = (
    "id", "at", "symbol", "timeframe", "side", "verdict", "setup_kind",
    "gates_failed", "score", "coverage", "confidence", "probability",
    "entry", "stop", "target", "expires_at",
    "outcome", "resolved_at", "resolved_price", "held_ms", "r_realised",
    "device", "updated",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS claims(
    id TEXT PRIMARY KEY,
    at REAL NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    side TEXT NOT NULL,
    verdict TEXT NOT NULL,
    setup_kind TEXT,
    gates_failed INTEGER,
    score REAL, coverage REAL, confidence REAL, probability REAL,
    entry REAL, stop REAL, target REAL, expires_at REAL,
    outcome TEXT NOT NULL DEFAULT 'pending',
    resolved_at REAL, resolved_price REAL, held_ms REAL, r_realised REAL,
    device TEXT, updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS claims_at ON claims(at);
CREATE INDEX IF NOT EXISTS claims_sym ON claims(symbol, timeframe);
CREATE INDEX IF NOT EXISTS claims_outcome ON claims(outcome);
CREATE INDEX IF NOT EXISTS claims_verdict ON claims(verdict);
"""


def init(conn):
    """Create the table. Additive only — an accumulated ledger is never wiped."""
    conn.executescript(SCHEMA)


# --------------------------------------------------------------------------- #
# writing                                                                      #
# --------------------------------------------------------------------------- #

_OUTCOMES = ("pending", "target", "stop", "expired", "unknowable")
_SIDES = ("long", "short")
_VERDICTS = ("take", "stand-down")


def _num(v, lo=None, hi=None):
    """A finite float, or None. NaN and inf are rejected, not stored."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    if lo is not None and f < lo:
        return None
    if hi is not None and f > hi:
        return None
    return f


def sanitise(raw):
    """
    One claim from the wire, or None.

    Rejects rather than repairs. A claim missing its stop is not a claim with a
    default stop — it is a row that would score a trade nobody could have taken,
    and `learn/claim.ts` refuses to build one for exactly the same reason.
    """
    if not isinstance(raw, dict):
        return None

    cid = raw.get("id")
    if not isinstance(cid, str) or not cid:
        return None

    at = _num(raw.get("at"), lo=0)
    entry = _num(raw.get("entry"), lo=0)
    stop = _num(raw.get("stop"), lo=0)
    target = _num(raw.get("target"), lo=0)
    if at is None or entry is None or stop is None or target is None:
        return None

    side = raw.get("side")
    verdict = raw.get("verdict")
    if side not in _SIDES or verdict not in _VERDICTS:
        return None

    outcome = raw.get("outcome", "pending")
    if outcome not in _OUTCOMES:
        outcome = "pending"

    # Realised R, computed HERE rather than trusted from the client, so a row
    # written by an older build cannot carry a differently-defined R into the
    # same column as the rows around it.
    risk = abs(entry - stop)
    r = None
    if risk > 0:
        if outcome == "target":
            r = abs(target - entry) / risk
        elif outcome == "stop":
            r = -1.0
        elif outcome == "expired":
            px = _num(raw.get("resolvedPrice"))
            if px is not None:
                r = ((px - entry) if side == "long" else (entry - px)) / risk

    return {
        "id": cid,
        "at": at,
        "symbol": str(raw.get("symbol") or "")[:64],
        "timeframe": str(raw.get("timeframe") or "")[:16],
        "side": side,
        "verdict": verdict,
        "setup_kind": (str(raw["setupKind"])[:48] if isinstance(raw.get("setupKind"), str) else None),
        "gates_failed": int(_num(raw.get("gatesFailed"), lo=0) or 0),
        "score": _num(raw.get("score"), lo=-1, hi=1),
        "coverage": _num(raw.get("coverage"), lo=0, hi=1),
        "confidence": _num(raw.get("confidence"), lo=0, hi=1),
        "probability": _num(raw.get("probability"), lo=0, hi=1),
        "entry": entry, "stop": stop, "target": target,
        "expires_at": _num(raw.get("expiresAt"), lo=0),
        "outcome": outcome,
        "resolved_at": _num(raw.get("resolvedAt"), lo=0),
        "resolved_price": _num(raw.get("resolvedPrice"), lo=0),
        "held_ms": _num(raw.get("heldMs"), lo=0),
        "r_realised": r,
        "device": str(raw.get("device") or "unknown")[:64],
        "updated": time.time(),
    }


def upsert(conn, claims):
    """
    Write claims, newest wins.

    RESOLVED NEVER GOES BACK TO PENDING. Two browsers hold the same claim; one
    has resolved it from bars the other has not loaded. A plain last-write-wins
    would let the machine with less history unresolve it, and the claim would
    then re-resolve later against whatever bars happened to be around — which is
    a track record that quietly depends on which laptop was open.
    """
    written = 0
    for raw in claims:
        row = sanitise(raw)
        if row is None:
            continue
        cols = ", ".join(COLUMNS)
        marks = ", ".join("?" for _ in COLUMNS)
        sets = ", ".join(f"{c}=excluded.{c}" for c in COLUMNS if c != "id")
        cur = conn.execute(
            f"INSERT INTO claims({cols}) VALUES({marks}) "
            f"ON CONFLICT(id) DO UPDATE SET {sets} "
            # The guard. Only accept the incoming row if it RESOLVES something
            # still open, or updates a claim in the same state.
            f"WHERE claims.outcome = 'pending' OR excluded.outcome != 'pending'",
            tuple(row[c] for c in COLUMNS),
        )
        written += cur.rowcount or 0
    return written


# --------------------------------------------------------------------------- #
# reading                                                                      #
# --------------------------------------------------------------------------- #

def wilson(hits, n, z=1.96):
    """
    Wilson score interval. Not the normal approximation.

    The textbook `p ± 1.96·sqrt(p(1-p)/n)` gives an interval of zero width at
    zero hits — "0%, and we are certain" from a single loss — and bounds outside
    [0,1] at small n. Both failure modes land exactly where a young ledger
    lives. Matches `wilson()` in app/src/learn/scorecard.ts so the two ends of
    the system cannot quote different confidence for the same claims.
    """
    if n <= 0:
        return (0.0, 1.0)
    p = hits / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = p + z2 / (2 * n)
    margin = z * math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)
    return (max(0.0, (centre - margin) / denom), min(1.0, (centre + margin) / denom))


# Below this, a proportion is quoted with its interval and never characterised.
MIN_FOR_RATE = 20

# Distinct UTC days the sample must span before ANY verdict is stated.
#
# Sample size is not the only floor, and on this ledger it was the misleading
# one. The first real read held 283 resolved claims -- comfortably past
# MIN_FOR_RATE -- and every one of them came from a single five-and-a-half-hour
# window on one afternoon. Longs resolved at 66% and shorts at 6%, which is not
# a fact about longs; it is a fact about which way that afternoon went. The
# module confidently reported a calibration inversion from it, which is the
# module doing precisely the thing it was written to prevent.
#
# In the dimension that matters, one session is n=1 however many claims it
# contains.
MIN_DAYS = 5


def _distinct_days(rows):
    """UTC days the sample touches. 86,400,000 ms to the day."""
    return len({int(r["at"] // 86_400_000) for r in rows if r.get("at") is not None})


def dedupe(rows):
    """
    Collapse repeated recordings of the same position.

    The card re-records a claim as the read is refreshed, so one idea arrives
    many times with byte-identical geometry: measured on the first real ledger,
    283 resolved claims were 151 distinct positions, with one group holding ten
    copies. Every copy resolves the same way by construction, so counting them
    separately does not merely inflate n -- it narrows every confidence interval
    around a number that had no extra evidence behind it.

    Earliest kept: the first recording is the one made with the least hindsight.
    """
    seen = {}
    for r in sorted(rows, key=lambda x: x["at"]):
        key = (r["symbol"], r["timeframe"], r["side"],
               round(r["entry"] or 0, 8), round(r["stop"] or 0, 8), round(r["target"] or 0, 8))
        if key not in seen:
            seen[key] = r
    return list(seen.values())


def _population(rows, label):
    """
    Summarise one group.

    `unknowable` is excluded from the denominator rather than folded into
    losses. A bar that covered both barriers does not say which came first, and
    OHLC cannot be made to say it; guessing puts a coin flip inside the hit
    rate, which is worse than having no hit rate because it still looks like one.

    `expired` is excluded from the denominator for the same reason and a
    different one: A TIMEOUT IS NOT A LOSS. A claim that reached neither barrier
    inside its horizon is its own class, and folding it into "stop" would teach
    every reader that "nothing happened" looks like "I was wrong".

    AND IT IS NOW PUBLISHED, which it was not. MEASURED on the live table: 2,113
    claims, of which `pending` 1,098, `target` 523, `stop` 442 and `unknowable`
    19 — the four buckets this returned — leaving **31 `expired` counted in
    `total` and named in nothing**. So the numbers on screen did not add up to
    their own total, and a reader finding the gap could not tell a category from
    a bug. The exclusion was right; the silence was not. "Anything that tolerates
    a partial failure has to name what it lost everywhere it reports a total."

    The four outcome buckets plus `decided` now PARTITION `total` exactly, and
    `test_claims_partition.py` fails if a sixth outcome is ever added without a
    bucket — which is how this one arrived.
    """
    total = len(rows)
    pending = sum(1 for r in rows if r["outcome"] == "pending")
    unknowable = sum(1 for r in rows if r["outcome"] == "unknowable")
    expired = sum(1 for r in rows if r["outcome"] == "expired")
    decided = [r for r in rows if r["outcome"] in ("target", "stop")]
    hits = sum(1 for r in decided if r["outcome"] == "target")
    n = len(decided)
    low, high = wilson(hits, n)

    scored = [r["r_realised"] for r in rows if r["r_realised"] is not None]
    return {
        "label": label,
        "total": total,
        "pending": pending,
        "unknowable": unknowable,
        # Reached neither barrier in its horizon. Its own class, never a loss.
        "expired": expired,
        "decided": n,
        "hits": hits,
        "hitRate": (hits / n) if n else None,
        "low": low if n else None,
        "high": high if n else None,
        "reportable": n >= MIN_FOR_RATE,
        "expectancyR": (sum(scored) / len(scored)) if scored else None,
        "text": (
            f"{hits} of {n} reached target"
            if n >= MIN_FOR_RATE
            else f"only {n} resolved — too few to quote a rate"
        ),
    }


def _by(rows, key, label_of=None):
    groups = {}
    for r in rows:
        k = r[key]
        if k is None:
            continue
        groups.setdefault(k, []).append(r)
    out = [_population(v, (label_of(k) if label_of else str(k))) for k, v in groups.items()]
    return sorted(out, key=lambda p: -p["decided"])


def calibration(rows, bands=5, days=None):
    """
    Was the terminal more often right when it was more confident?

    Bucketed on `confidence`, not on `probability`. Probability is null on most
    claims by design — `learn/claim.ts` keeps "no stated chance" distinct from
    "50%" — so a reliability curve over it would describe the handful of claims
    that happened to carry one. Confidence is present on every claim, and the
    question it answers is the one that matters for a decision aid: does the
    number on the card mean anything?

    A flat curve is a real and publishable result. It says the confidence figure
    is decoration, which is worth knowing and is not visible any other way.
    """
    decided = [r for r in rows if r["outcome"] in ("target", "stop") and r["confidence"] is not None]
    if not decided:
        return {"bands": [], "note": "No resolved claim carries a confidence figure yet."}

    out = []
    for i in range(bands):
        lo = i / bands
        hi = (i + 1) / bands
        # The top band is closed at both ends so confidence == 1 lands somewhere.
        grp = [r for r in decided if (lo <= r["confidence"] < hi) or (i == bands - 1 and r["confidence"] == 1.0)]
        if not grp:
            continue
        hits = sum(1 for r in grp if r["outcome"] == "target")
        low, high = wilson(hits, len(grp))
        out.append({
            "from": lo, "to": hi,
            "n": len(grp), "hits": hits,
            "hitRate": hits / len(grp),
            "low": low, "high": high,
            "meanConfidence": sum(r["confidence"] for r in grp) / len(grp),
        })

    # ONLY BANDS WITH ENOUGH IN THEM MAY DECIDE THE VERDICT.
    #
    # The first version compared the lowest band against the highest, whichever
    # they happened to be. On the operator's real ledger the top band held ONE
    # claim, so the comparison ran against an interval of [0.00, 0.79] and came
    # back "no visible relationship" -- while the bottom band (n=156, 69% hit)
    # and the two above it (n=69 and n=50, at 29% and 32%) were separated by a
    # mile. One unlucky claim in the top bucket was hiding a strong inversion
    # in the rest of the curve.
    solid = [b for b in out if b["n"] >= MIN_FOR_RATE]

    note = "Too little resolved to read the curve."
    if days is not None and days < MIN_DAYS:
        return {"bands": out,
                "note": ("These claims span %d day%s. A curve read from one session describes that "
                         "session's direction, not the confidence figure - no verdict is offered."
                         % (days, "s" if days != 1 else ""))}
    if len(solid) >= 2:
        first, last = solid[0], solid[-1]
        # Compared on the BOUNDS, not the point estimates. Two point estimates
        # differing by ten points across overlapping intervals is not a slope,
        # it is noise with a direction.
        if last["low"] > first["high"]:
            note = "Higher confidence really did resolve better."
        elif first["low"] > last["high"]:
            note = ("Higher confidence resolved WORSE, and the intervals do not overlap. "
                    "The figure on the card is inverted, not merely uninformative.")
        else:
            note = ("No visible relationship between the confidence on the card and the outcome - "
                    "on this much data the figure is not carrying information.")
        if len(solid) < len(out):
            thin = len(out) - len(solid)
            note += (" %d band%s held fewer than %d resolved claims and did not count towards this."
                     % (thin, "s" if thin != 1 else "", MIN_FOR_RATE))
    elif len(out) >= 2:
        note = ("No confidence band holds %d resolved claims yet, so the curve cannot be read "
                "even though it has points on it." % MIN_FOR_RATE)
    return {"bands": out, "note": note}


def gate_verdict(rows, days=None):
    """
    Do the gates earn their refusals?

    The one comparison nothing else in the system can make, and it is allowed to
    come back "no". A filter that does not filter costs every opportunity it
    declines, and until both populations exist nobody can tell.
    """
    taken = _population([r for r in rows if r["verdict"] == "take"], "Cleared the gates")
    stood = _population([r for r in rows if r["verdict"] == "stand-down"], "Stood down")

    lift = None
    separated = False
    if taken["hitRate"] is not None and stood["hitRate"] is not None:
        lift = (taken["hitRate"] - stood["hitRate"]) * 100
        separated = (
            taken["reportable"] and stood["reportable"]
            and (taken["low"] > stood["high"] or stood["low"] > taken["high"])
        )

    if days is not None and days < MIN_DAYS:
        text = ("These claims span %d day%s. Whichever way that went is not a verdict on the gates, "
                "so none is offered." % (days, "s" if days != 1 else ""))
    elif lift is None:
        text = "Both populations are needed before the gates can be judged; one of them is still empty."
    elif not separated:
        text = ("The cleared and refused trades are not distinguishable on this much data. "
                "That is not evidence the gates work.")
    elif lift > 0:
        text = f"Cleared trades resolved {lift:.0f} points better than refused ones. The gates are earning their refusals."
    else:
        text = (f"Refused trades resolved {abs(lift):.0f} points BETTER than cleared ones. "
                f"The gates are costing more than they save.")

    return {"taken": taken, "stoodDown": stood, "liftPoints": lift, "separated": separated, "text": text}


def stats(conn, symbol=None, timeframe=None, since=None):
    """Everything the ledger can say, in one shape."""
    where, args = [], []
    if symbol:
        where.append("symbol = ?")
        args.append(symbol)
    if timeframe:
        where.append("timeframe = ?")
        args.append(timeframe)
    if since not in (None, ""):
        try:
            args.append(float(since))
            where.append("at >= ?")
        except (TypeError, ValueError):
            pass
    sql = "SELECT * FROM claims"
    if where:
        sql += " WHERE " + " AND ".join(where)
    # `args` IS PASSED. It was built above and dropped, so any filtered call
    # raised "Incorrect number of bindings supplied" -- every per-symbol and
    # per-timeframe read of the track record, since the filters were written.
    # The UNFILTERED call builds no placeholders, which is why the overall hit
    # rate worked perfectly and hid it.
    raw = [dict(r) for r in conn.execute(sql + " ORDER BY at ASC", tuple(args)).fetchall()]

    # Collapsed BEFORE anything is counted. See `dedupe`: repeated recordings of
    # one position are not repeated evidence of it, and letting them through
    # narrows every interval below around nothing.
    rows = dedupe(raw)
    days = _distinct_days(rows)

    if not rows:
        return {
            "ok": True, "claims": 0, "recorded": len(raw), "distinctDays": 0,
            "note": "The ledger is empty. Nothing here is a statement about the market yet.",
        }

    rows.sort(key=lambda r: r["at"])
    return {
        "ok": True,
        "claims": len(rows),
        # Both numbers, always. "283 claims" and "151 after collapsing repeats"
        # are different facts and the second is the one every rate rests on.
        "recorded": len(raw),
        "distinctDays": days,
        "from": rows[0]["at"],
        "to": rows[-1]["at"],
        "all": _population(rows, "Everything"),
        "gates": gate_verdict(rows, days),
        "bySetup": _by(rows, "setup_kind"),
        "bySymbol": _by(rows, "symbol"),
        "byTimeframe": _by(rows, "timeframe"),
        "calibration": calibration(rows, days=days),
        # Said plainly and last, so it is the thing left in mind: this is a small
        # sample of one operator's decisions, not a study.
        "caveat": ("One operator, one set of instruments, %d distinct day%s. Out of sample, unlike a "
                   "backtest, and far too small to generalise from." % (days, "s" if days != 1 else "")),
    }
