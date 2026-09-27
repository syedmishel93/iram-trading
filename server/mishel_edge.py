"""
Conditional edge: the same trials, sliced by the conditions they happened under.

WHY THIS EXISTS, AND WHAT IT IS NOT
-----------------------------------
`app/src/setup/simulate.ts` replays every historical instance of a detection
kind and reports one number per kind. That number came back flat: on ~6,000
bars of ETHUSDT at 1R, all ten characterisable kinds sat between 42% and 53%
with expectancy from -0.09R to +0.10R. Nothing there is tradeable.

The obvious next move is to ask whether the flat aggregate is hiding structure
-- a kind that works in the London killzone and not in Asia, in trend and not
in chop, on Tuesdays and not on Fridays. That question is worth asking and it
is the single most dangerous question in this repository, because slicing a
sample enough ways will always produce a cell that looks like an edge.

So this module's real content is the REFUSALS, and there are four:

  1. MIN_FOR_RATE per cell, inherited from mishel_claims. A cell with eleven
     trials is quoted with an interval and never characterised.
  2. MIN_DAYS across the whole sample, also inherited. 283 claims from one
     afternoon is n=1 in the dimension that matters, and that mistake has
     already been made once in this codebase.
  3. MULTIPLE COMPARISONS, which is new here and is the whole point. Cutting
     one sample four ways into twenty-odd cells means the best cell is expected
     to look good at p<0.05 whether or not anything is there. Every response
     states how many cells were examined and applies a Sidak correction to the
     threshold, and `honest_best` refuses to name a winner that does not clear
     the corrected bar.
  4. NET, NOT GROSS. A hit rate computed on gross R is a hit rate for a trader
     who pays nothing. Costs are subtracted before anything is counted.

WHAT IT DOES NOT DO
-------------------
It does not feed back. Nothing here adjusts a score, a weight, a threshold or
a detector default. The measured PBO of the shipped strategy set is 89%; a
conditional table over a few hundred trials from one operator's instruments is
that same failure with more cells to be fooled by. This measures and stops.
"""

import math
import time

from mishel_claims import MIN_DAYS, MIN_FOR_RATE, wilson

# ---------------------------------------------------------------- storage --

COLUMNS = (
    "id", "at", "symbol", "timeframe", "kind", "direction",
    "outcome", "r_gross", "stop_pct", "mfe_r", "mae_r", "bars_held", "confidence",
    "regime", "device", "updated",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS trials(
    id TEXT PRIMARY KEY,
    at REAL NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    outcome TEXT NOT NULL,
    r_gross REAL,
    -- Stop distance as a PERCENTAGE of entry price. The only field here that
    -- is not an outcome, and it is stored because it is the only way to turn a
    -- cost in basis points into a cost in R. Without it `Costs.r_cost` returns
    -- None and every figure silently reverts to gross, which is exactly the
    -- flattering failure this module exists to avoid.
    stop_pct REAL,
    mfe_r REAL, mae_r REAL,
    bars_held REAL,
    confidence REAL,
    regime TEXT,
    device TEXT,
    updated REAL NOT NULL);
CREATE INDEX IF NOT EXISTS trials_at ON trials(at);
CREATE INDEX IF NOT EXISTS trials_sym ON trials(symbol, timeframe);
CREATE INDEX IF NOT EXISTS trials_kind ON trials(kind, direction);
"""

OUTCOMES = ("target", "stop", "unknowable", "open")


def init(conn):
    """Create the table. Additive only, like the claims ledger beside it."""
    conn.executescript(SCHEMA)
    conn.commit()


def _num(v, lo=None, hi=None):
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
    Reject rather than repair.

    A trial with a missing outcome or a nonsense R is not a trial with a small
    problem; it is a row that would silently move a hit rate. The same stance
    `mishel_claims.sanitise` takes, and for the same reason.
    """
    if not isinstance(raw, dict):
        return None
    tid = raw.get("id")
    if not isinstance(tid, str) or not tid.strip():
        return None
    at = _num(raw.get("at"), lo=0)
    if at is None:
        return None
    outcome = raw.get("outcome")
    if outcome not in OUTCOMES:
        return None
    direction = raw.get("direction")
    if direction not in ("long", "short"):
        return None
    symbol = raw.get("symbol")
    timeframe = raw.get("timeframe")
    kind = raw.get("kind")
    if not all(isinstance(x, str) and x.strip() for x in (symbol, timeframe, kind)):
        return None

    r_gross = _num(raw.get("rGross"), lo=-100, hi=100)
    # A decided trial with no R is not usable: it would be counted in the hit
    # rate and skipped in the expectancy, so the two would describe different
    # populations under the same heading.
    if outcome in ("target", "stop") and r_gross is None:
        return None

    return {
        "id": tid.strip()[:120],
        "at": at,
        "symbol": symbol.strip()[:32],
        "timeframe": timeframe.strip()[:8],
        "kind": kind.strip()[:40],
        "direction": direction,
        "outcome": outcome,
        "r_gross": r_gross,
        "stop_pct": _num(raw.get("stopPct"), lo=0, hi=100),
        "mfe_r": _num(raw.get("mfeR"), lo=-100, hi=100),
        "mae_r": _num(raw.get("maeR"), lo=-100, hi=100),
        "bars_held": _num(raw.get("barsHeld"), lo=0, hi=100_000),
        "confidence": _num(raw.get("confidence"), lo=0, hi=1),
        "regime": (raw.get("regime") or None),
        "device": (raw.get("device") or None),
        "updated": time.time() * 1000.0,
    }


def upsert(conn, trials):
    """Insert or replace by id. A replay is deterministic, so re-running it
    must converge rather than accumulate duplicates."""
    rows = [t for t in (sanitise(r) for r in trials) if t is not None]
    if not rows:
        # SAME SHAPE AS THE OTHER RETURN. A function with two return types is a
        # caller that has to test which one it got, and the caller here is a
        # route that logs the result.
        return {"written": 0, "added": 0, "offered": 0}
    cols = ", ".join(COLUMNS)
    marks = ", ".join("?" for _ in COLUMNS)
    before = conn.execute("SELECT count(*) FROM trials").fetchone()[0]
    cur = conn.executemany(
        f"INSERT INTO trials({cols}) VALUES({marks}) "
        f"ON CONFLICT(id) DO UPDATE SET " +
        ", ".join(f"{c}=excluded.{c}" for c in COLUMNS if c != "id"),
        [tuple(r[c] for c in COLUMNS) for r in rows],
    )
    conn.commit()
    # WHAT LANDED, NOT WHAT WAS ASKED FOR. This returned `len(rows)` — the size
    # of the input — and the route logs it as "written", so "400 of 400 written"
    # was a sentence the code could not falsify. A count that cannot be wrong is
    # not evidence, which is the same defect as an expected value taken from the
    # code under test. `rowcount` counts inserts AND conflict-updates, which is
    # exactly what "written" should mean for an upsert; the row delta is kept
    # beside it so a caller can tell a new trial from a re-run of an old one.
    after = conn.execute("SELECT count(*) FROM trials").fetchone()[0]
    affected = cur.rowcount if cur.rowcount is not None and cur.rowcount >= 0 else (after - before)
    return {"written": affected, "added": after - before, "offered": len(rows)}


# ------------------------------------------------------------ cost model --

class Costs:
    """
    What a trade costs before it is allowed to count as a win.

    Expressed in basis points of PRICE and converted to R using the trial's own
    stop distance, because that is the only conversion that is instrument- and
    setup-independent: the same 2bp spread is a rounding error on a 3-ATR stop
    and a third of the risk on a 0.1-ATR one.

    `entry_bps` is charged twice by default -- once in, once out -- because a
    round trip is two crossings of the spread and two commissions, and a model
    that charges one is flattering by exactly a factor of two.
    """

    def __init__(self, spread_bps=2.0, slippage_bps=1.0, commission_bps=0.0, round_trips=2):
        self.spread_bps = max(0.0, float(spread_bps))
        self.slippage_bps = max(0.0, float(slippage_bps))
        self.commission_bps = max(0.0, float(commission_bps))
        self.round_trips = max(1, int(round_trips))

    @property
    def bps(self):
        return (self.spread_bps + self.slippage_bps + self.commission_bps) * self.round_trips

    def r_cost(self, stop_distance_pct):
        """
        Cost as a fraction of one R.

        `stop_distance_pct` is the stop distance as a percentage of entry
        price. Returns None when it is missing or zero -- a cost of "infinity R"
        is not a number to put in a table, and the trial is dropped instead.
        """
        d = _num(stop_distance_pct, lo=0)
        if d is None or d <= 0:
            return None
        return (self.bps / 100.0) / d


def net_r(r_gross, r_cost):
    """Gross R less the round-trip cost, in R."""
    if r_gross is None:
        return None
    if r_cost is None:
        return r_gross
    return r_gross - r_cost


# ---------------------------------------------------------- the slicing --

# UTC hour -> session name. The same windows as data/sessionmap.ts; duplicated
# here rather than imported because the browser module is TypeScript, and noted
# so a change to one is known to need the other.
SESSION_WINDOWS = (
    ("Tokyo", 0, 9),
    ("London", 7, 16),
    ("New York", 12, 21),
    ("Sydney", 21, 6),
)

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def sessions_at(ms):
    """Every session open at that instant. Overlaps are real and are kept."""
    hour = int((ms // 3_600_000) % 24)
    out = []
    for name, start, end in SESSION_WINDOWS:
        inside = (start <= hour < end) if start <= end else (hour >= start or hour < end)
        if inside:
            out.append(name)
    return out or ["Closed"]


def weekday_at(ms):
    """UTC weekday. 1970-01-01 was a Thursday, index 3 in WEEKDAYS."""
    return WEEKDAYS[int((ms // 86_400_000 + 3) % 7)]


def _distinct_days(rows):
    return len({int(r["at"] // 86_400_000) for r in rows if r.get("at") is not None})


def cell(rows, label, costs=None):
    """
    Summarise one cell, NET.

    `unknowable` is excluded from the denominator rather than counted as a
    loss: OHLC cannot order two barriers inside one bar, and guessing puts a
    coin flip inside the hit rate where it still looks like a measurement.
    """
    decided = [r for r in rows if r["outcome"] in ("target", "stop")]
    n = len(decided)
    hits = sum(1 for r in decided if r["outcome"] == "target")
    low, high = wilson(hits, n)

    scored = []
    uncosted = 0
    for r in decided:
        rc = costs.r_cost(r.get("stop_pct")) if costs else None
        if costs is not None and rc is None:
            # No stop distance means no honest conversion from basis points to
            # R. Counted and reported rather than quietly charged zero, because
            # a table half of whose rows are gross is worse than one that says
            # so.
            uncosted += 1
        v = net_r(r["r_gross"], rc)
        if v is not None:
            scored.append(v)

    return {
        "label": label,
        "n": n,
        "hits": hits,
        "unknowable": sum(1 for r in rows if r["outcome"] == "unknowable"),
        "uncosted": uncosted,
        "hitRate": (hits / n) if n else None,
        "low": low if n else None,
        "high": high if n else None,
        "expectancyR": (sum(scored) / len(scored)) if scored else None,
        "reportable": n >= MIN_FOR_RATE,
    }


def sidak(alpha, comparisons):
    """
    The per-test threshold that keeps the FAMILY-wise error at `alpha`.

    1 - (1 - alpha)^(1/m). Slightly less brutal than Bonferroni and exact for
    independent tests; the cells here are not independent (a trial is in one
    session cell and one weekday cell at once), so this is an approximation in
    the conservative direction, which is the right direction.
    """
    m = max(1, int(comparisons))
    return 1.0 - (1.0 - alpha) ** (1.0 / m)


def z_for(alpha_two_sided):
    """
    Rational approximation to the inverse normal CDF, good to ~4.5e-4.

    Adequate here: the number is used to widen an interval, and the difference
    between z=2.87 and z=2.8701 does not change any verdict this module issues.
    """
    p = 1.0 - alpha_two_sided / 2.0
    if p <= 0.5:
        return 0.0
    t = math.sqrt(-2.0 * math.log(1.0 - p))
    c0, c1, c2 = 2.515517, 0.802853, 0.010328
    d1, d2, d3 = 1.432788, 0.189269, 0.001308
    return t - ((c2 * t + c1) * t + c0) / (((d3 * t + d2) * t + d1) * t + 1.0)


def honest_best(cells, baseline_rate, comparisons, alpha=0.05):
    """
    Name a winning cell only if it survives the correction for having looked.

    The cell with the highest hit rate in a table of twenty is not evidence.
    This recomputes each reportable cell's lower bound at the Sidak-corrected
    confidence and only names one whose corrected lower bound still clears the
    baseline. When nothing does -- which is the expected outcome -- it says so
    in those words rather than returning the best of a bad set.
    """
    corrected = sidak(alpha, comparisons)
    z = z_for(corrected)
    survivors = []
    for c in cells:
        if not c["reportable"] or c["hitRate"] is None:
            continue
        low, _high = wilson(c["hits"], c["n"], z=z)
        if baseline_rate is not None and low > baseline_rate:
            survivors.append({**c, "correctedLow": low})

    if not survivors:
        return {
            "found": False,
            "comparisons": comparisons,
            "alpha": alpha,
            "correctedAlpha": corrected,
            "z": z,
            "text": (
                f"{comparisons} cells were examined, so the threshold for any one of them is "
                f"{corrected * 100:.3f}% rather than {alpha * 100:.0f}%. "
                f"No cell clears the {(baseline_rate or 0) * 100:.1f}% baseline at that "
                f"threshold. The best-looking cell in a table this size is what you would "
                f"expect to see with nothing there at all."
            ),
        }

    survivors.sort(key=lambda c: -c["correctedLow"])
    best = survivors[0]
    return {
        "found": True,
        "cell": best,
        "comparisons": comparisons,
        "alpha": alpha,
        "correctedAlpha": corrected,
        "z": z,
        "text": (
            f"{best['label']}: {best['hits']} of {best['n']}, lower bound "
            f"{best['correctedLow'] * 100:.1f}% after correcting for {comparisons} cells "
            f"examined. That clears the {(baseline_rate or 0) * 100:.1f}% baseline. "
            f"It is one finding from one operator's history and it has not been tested "
            f"out of sample."
        ),
    }


def conditional(rows, costs=None, alpha=0.05):
    """
    The full conditional table, with every guard applied.

    Returns `available: False` and a reason whenever the sample cannot support
    the question, rather than a table of cells that would each individually
    look like an answer.
    """
    rows = [r for r in rows if r["outcome"] != "open"]
    days = _distinct_days(rows)

    if len(rows) < MIN_FOR_RATE:
        return {
            "available": False,
            "reason": f"{len(rows)} trials. Below {MIN_FOR_RATE} nothing is sliced, because "
                      f"every cell would hold single figures.",
            "trials": len(rows),
            "days": days,
        }
    if days < MIN_DAYS:
        return {
            "available": False,
            "reason": f"These trials span {days} day{'' if days == 1 else 's'}. Whichever way "
                      f"that went is a fact about {'that day' if days == 1 else 'those days'}, "
                      f"not about the condition — so no breakdown is offered.",
            "trials": len(rows),
            "days": days,
        }

    overall = cell(rows, "All", costs)
    baseline = overall["hitRate"]

    groups = {}

    by_session = {}
    for r in rows:
        for s in sessions_at(r["at"]):
            by_session.setdefault(s, []).append(r)
    groups["session"] = [cell(v, k, costs) for k, v in by_session.items()]

    by_day = {}
    for r in rows:
        by_day.setdefault(weekday_at(r["at"]), []).append(r)
    groups["weekday"] = [cell(v, k, costs) for k, v in by_day.items()]

    by_regime = {}
    for r in rows:
        by_regime.setdefault(r.get("regime") or "unlabelled", []).append(r)
    groups["regime"] = [cell(v, k, costs) for k, v in by_regime.items()]

    by_dir = {}
    for r in rows:
        by_dir.setdefault(r["direction"], []).append(r)
    groups["direction"] = [cell(v, k, costs) for k, v in by_dir.items()]

    for key, cells in groups.items():
        groups[key] = sorted(cells, key=lambda c: -c["n"])

    # Every cell that was LOOKED AT counts toward the correction, including the
    # ones too small to report. Counting only the reportable ones would let a
    # table be made to look more significant by having more tiny cells in it.
    comparisons = sum(len(v) for v in groups.values())

    return {
        "available": True,
        "trials": len(rows),
        "days": days,
        "overall": overall,
        "groups": groups,
        "comparisons": comparisons,
        "best": honest_best(
            [c for v in groups.values() for c in v], baseline, comparisons, alpha
        ),
        "costs": None if costs is None else {
            "bps": costs.bps,
            "note": (
                f"{costs.bps:.1f} bp charged per round trip and converted to R using each "
                f"trial's own stop distance. Gross figures are not reported anywhere here."
            ),
        },
    }


def fetch(conn, symbol=None, timeframe=None, kind=None, since=None):
    """Rows as dicts, filtered. `stop_pct` rides along when the client sent it."""
    where, args = [], []
    if symbol:
        where.append("symbol = ?")
        args.append(symbol)
    if timeframe:
        where.append("timeframe = ?")
        args.append(timeframe)
    if kind:
        where.append("kind = ?")
        args.append(kind)
    if since not in (None, ""):
        try:
            args.append(float(since))
            where.append("at >= ?")
        except (TypeError, ValueError):
            pass
    sql = "SELECT * FROM trials"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY at"
    cur = conn.execute(sql, args)
    names = [d[0] for d in cur.description]
    return [dict(zip(names, row)) for row in cur.fetchall()]


def kinds(conn, symbol=None, timeframe=None):
    """What kinds have trials at all, so a UI can offer only those."""
    where, args = [], []
    if symbol:
        where.append("symbol = ?")
        args.append(symbol)
    if timeframe:
        where.append("timeframe = ?")
        args.append(timeframe)
    sql = "SELECT kind, direction, COUNT(*) n FROM trials"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " GROUP BY kind, direction ORDER BY n DESC"
    return [
        {"kind": k, "direction": d, "n": n}
        for (k, d, n) in conn.execute(sql, args).fetchall()
    ]
