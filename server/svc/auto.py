"""The autonomous loop: study what is held, learn from it, and keep it current.

WHAT IT DOES, ONCE EVERY PASS

For each market the archive actually holds enough of, it runs every rule in the
shipped library through the lab worker, pools the candidate ledgers, and asks
the router what it makes of them. The result is stored with the QUESTION that
produced it, so a changed library or a changed cost model misses rather than
serving a conclusion nobody reached.

WHERE THE SUBJECT LIST COMES FROM, AND WHY NOT A CONFIG KEY

From the `bars` table: every `(sym, tf)` holding at least `MIN_BARS`. CLAUDE.md
records `bars_loop` reading its enrolment from a config key that one module read
and zero modules wrote — it ticked hourly, reported a fresh last-tick age, and
produced no work for a whole release. A list nobody writes is a loop that does
nothing and says it is healthy. The bars table has real writers (the terminal
and `bars_loop` itself), so "what do I hold enough of" is a question that can
only be answered truthfully.

It is also the honest reading of "popular assets": the markets this operator
actually keeps history for, rather than a hardcoded list of somebody else's.

IT REFUSES BEFORE IT STARTS

Node missing, engine not built, nothing held, a pass already running: all
answerable without spawning anything. A downloader that refuses after it starts
has already spent the time it was refusing to spend.

IT REPORTS COUNTS, NOT A TICK AGE

`/svc/auto/state` says how many subjects were studied, how many rules ran, how
many were refused and why. A last-tick age is not a health check — the same loop
that had no writer reported a perfectly fresh one while doing nothing.

WHY THE LEDGER IS BUILT IN THE ENGINE AND NOT HERE

Because the Playbook builds it in the engine. A Python copy would be a second
implementation of "what would this setup have done" — its own fill model, its
own warm-up — and the first time the two disagreed there would be no way to tell
which the strategy's expectancy had been measured with.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from db import db
from enginepath import ENGINE, SERVER_DIR, WORKER
from flask import Blueprint, jsonify

from svc.core import log_event, sleep_ticking, tick
from svc.router import MIN_ROWS, train_router

bp = Blueprint("auto", __name__)

#: A subject needs the feature matrix's 220-bar warm-up, the ledger's 100-bar
#: horizon and enough left over to mean anything. Below this a pass would
#: produce rows nobody should fit a model to.
MIN_BARS = 800

#: Per subject. Past this a single pass costs minutes per rule, and the oldest
#: bars describe a market that no longer exists — the same ceiling the Playbook
#: states for the same reason.
MAX_BARS = 20000

#: How many markets one pass covers. A bound, not a preference: an operator with
#: forty series held should not discover the loop running for an hour.
#: SERIES THE MACHINE READS BUT NEVER TRADES.
#:
#: `data/library.ts` MACRO_SPINE splits itself into "Traded." and "Read." — and
#: that split was a COMMENT, so nothing could act on it and the sweep studied
#: US10Y and VIX as trading subjects. A top-six result across 22 markets was
#: `williams-reversal on VIX`: a real number, on an index nobody can buy.
#:
#: The cost is not only the wasted pass. The best-of-N hurdle a winner must
#: clear is `sqrt(2 ln N) / sqrt(n)`, so every arm spent on an untradeable
#: series RAISES THE BAR for the rules that could actually be taken. Cutting
#: them is the cheapest available reduction in N.
#:
#: They stay in the archive, and matter more there than here: a macro series is
#: what a rule is CONDITIONED on. `tests/test_auto_context.py` checks this list
#: against the client's, because two lists naming one group will disagree.
CONTEXT_SYMBOLS = frozenset({"DXY", "US10Y", "US02Y", "SPX", "NDX", "VIX", "COPPER", "USDJPY"})

MAX_SUBJECTS = 6

#: Bars a setup has to resolve in. A CONSTANT across rules, because a horizon
#: that moved with the rule would make two rules' base rates incomparable, and
#: the base rate is the number the router has to beat.
HORIZON = 100

#: Seconds between passes.
PASS_EVERY_S = 6 * 3600

#: One worker is a `node` process for a few seconds. More than this and a pass
#: competes with the gateway serving the terminal that is watching it.
MAX_PARALLEL = 4

#: A wedged worker holds a core, so it gets a deadline rather than the benefit
#: of the doubt. Matches `gateway/lab.py`'s.
WORKER_TIMEOUT_S = 180.0

#: What the pass is FOR. Stored beside every result so a reader can tell whether
#: it answers their question; see `_question`.
BALANCE = 500.0
RISK_PCT = 1.0

#: Live state, for `/svc/auto/state`. Not a tick age.
STATE: dict[str, Any] = {
    "running": False,
    "started": 0.0,
    "finished": 0.0,
    "pass_no": 0,
    "subject": "",
    "studied": 0,
    "rules_run": 0,
    "rules_refused": 0,
    "last_error": "",
}
_LOCK = threading.Lock()


# --------------------------------------------------------------- refusals ---
def readiness() -> dict[str, Any]:
    """Everything answerable without spawning a thing."""
    node = shutil.which("node")
    engine = os.path.exists(ENGINE)
    worker = os.path.exists(WORKER)
    subs = subjects()
    why = ""
    if not node:
        why = "node is not on PATH, so the lab worker cannot run"
    elif not engine or not worker:
        why = "the lab engine is not built — run: npm --prefix app run build:lab"
    elif not subs:
        why = (
            f"no series in the archive holds {MIN_BARS} bars yet. Download some history, "
            "or leave the terminal open on a market, and this will pick it up by itself"
        )
    return {
        "ok": why == "",
        "why": why,
        "node": bool(node),
        "engine_built": engine,
        "subjects": [{"sym": s, "tf": t, "src": src, "bars": n} for s, t, src, n in subs],
        "minBars": MIN_BARS,
    }


def subjects() -> list[tuple[str, str, str, int]]:
    """Markets the archive holds enough of — LEAST RECENTLY STUDIED first.

    ROTATION, NOT A RANKING. This returned the richest series first and took the
    top `MAX_SUBJECTS`, which means it returned the SAME six every pass forever.
    MEASURED once `bars_loop` was fixed and the archive filled: 34 distinct
    (market, bar size) pairs qualified and six were reachable, so 28 markets the
    operator holds history for could never be studied at all. A bound on a pass
    is right; a bound that always falls on the same members is a bound that
    makes most of the archive dead weight.

    Ordering by when each was last studied means every qualifying series is
    covered within `ceil(34 / 6)` passes, and a series that has never been
    studied sorts first because its timestamp is zero.

    One SOURCE per series, chosen by how much it holds — a broker's XAUUSD and a
    proxy's XAUUSD are different series and blending them is the defect
    `svc/bars.py` records the old `ohlc_cache` having. Picking the fuller one and
    NAMING it is the honest version of choosing.
    """
    try:
        with db() as c:
            rows = c.execute(
                "SELECT sym, tf, src, COUNT(*) AS n FROM bars GROUP BY sym, tf, src "
                "HAVING n >= ? ORDER BY n DESC",
                (MIN_BARS,),
            ).fetchall()
    except Exception as e:  # noqa: BLE001 - a missing table is "nothing held"
        log_event("auto_subjects_failed", str(e))
        return []

    best: dict[tuple[str, str], tuple[str, str, str, int]] = {}
    for r in rows:
        # A series the machine only READS is not a trading subject. See
        # CONTEXT_SYMBOLS: studying it spends an arm nobody can act on and
        # raises the hurdle for every arm that could be.
        if str(r["sym"]).upper() in CONTEXT_SYMBOLS:
            continue
        key = (r["sym"], r["tf"])
        if key not in best:
            best[key] = (r["sym"], r["tf"], r["src"], int(r["n"]))

    # When each was last studied. A series with no row has never been, and sorts
    # first — which is what makes a newly downloaded market the next one covered
    # rather than the last.
    seen: dict[tuple[str, str], float] = {}
    try:
        with db() as c:
            for r in c.execute("SELECT sym, tf, at FROM auto_runs").fetchall():
                seen[(r["sym"], r["tf"])] = float(r["at"] or 0)
    except Exception as e:  # noqa: BLE001 - no history is "nothing studied yet"
        log_event("auto_seen_failed", str(e))

    # Oldest first, then richest — so a tie between two never-studied series
    # goes to the one with more to say.
    out = sorted(best.values(), key=lambda x: (seen.get((x[0], x[1]), 0.0), -x[3]))
    return out[:MAX_SUBJECTS]


# ------------------------------------------------------------ the worker ---
def _worker(job: dict[str, Any]) -> dict[str, Any]:
    """One `node lab_worker.mjs`, fed on stdin. Refuses rather than raising."""
    try:
        # Fixed argv; the payload goes on stdin, never on a command line.
        proc = subprocess.run(
            ["node", WORKER],
            input=json.dumps(job).encode(),
            capture_output=True,
            cwd=SERVER_DIR,
            timeout=WORKER_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"the worker exceeded {WORKER_TIMEOUT_S:.0f}s and was killed"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}

    raw = proc.stdout.decode(errors="replace")
    if not raw.strip():
        # ABSENCE OF OUTPUT IS NOT SUCCESS. An empty stdout can mean "fine" or
        # "never ran", and the gate has been fooled by exactly that before.
        detail = proc.stderr.decode(errors="replace")[:300]
        return {"ok": False, "error": f"the worker produced no output: {detail or 'nothing on stderr either'}"}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"ok": False, "error": f"the worker produced no JSON: {raw[:300]}"}


_CATALOGUE: dict[str, Any] = {"at": 0.0, "mtime": 0.0, "specs": []}


def catalogue() -> list[dict[str, Any]]:
    """The shipped rule library, asked of the engine that will run it.

    Cached against the ENGINE'S MTIME rather than a clock: a rebuilt engine is a
    different library, and a time-based cache would keep serving the old one for
    as long as it felt fresh.
    """
    try:
        mtime = os.path.getmtime(ENGINE)
    except OSError:
        return []
    if _CATALOGUE["specs"] and _CATALOGUE["mtime"] == mtime:
        return list(_CATALOGUE["specs"])
    res = _worker({"mode": "catalogue"})
    if not res.get("ok"):
        log_event("auto_catalogue_failed", str(res.get("error")))
        return []
    specs = res["result"]["specs"]
    _CATALOGUE.update({"at": time.time(), "mtime": mtime, "specs": specs})
    return list(specs)


def read_bars(sym: str, tf: str, src: str, n: int = MAX_BARS) -> list[dict[str, float]]:
    with db() as c:
        rows = c.execute(
            "SELECT t,o,h,l,c,v FROM bars WHERE sym=? AND tf=? AND src=? ORDER BY t DESC LIMIT ?",
            (sym, tf, src, n),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


# ------------------------------------------------------------ the question --
def _question(spec_ids: list[str]) -> str:
    """A hash of what was asked, so a changed question MISSES the cache.

    A stored result answers one library, one horizon and one account. Adding a
    rule changes the field a survivor had to beat; changing the horizon changes
    every base rate. Serving the old answer for the new question is how a system
    reports a conclusion nobody reached.
    """
    payload = json.dumps(
        {"specs": sorted(spec_ids), "horizon": HORIZON, "balance": BALANCE, "risk": RISK_PCT},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


# ------------------------------------------------------------- one subject --
def study_subject(sym: str, tf: str, src: str) -> dict[str, Any]:
    """Every shipped rule over one market, pooled, and what a model makes of it."""
    specs = catalogue()
    if not specs:
        return {"ok": False, "why": "the engine could not list its rule library"}

    bars = read_bars(sym, tf, src)
    if len(bars) < MIN_BARS:
        return {"ok": False, "why": f"only {len(bars)} bars held for {sym} {tf} from {src}"}

    opts = {"horizon": HORIZON, "balance": BALANCE, "riskPct": RISK_PCT}
    jobs = [{"mode": "ledger", "specId": sp["id"], "bars": bars, "opts": opts} for sp in specs]

    rules: list[dict[str, Any]] = []
    refused: list[dict[str, str]] = []
    pooled: list[dict[str, Any]] = []

    with ThreadPoolExecutor(max_workers=MAX_PARALLEL) as pool:
        for sp, res in zip(specs, pool.map(_worker, jobs), strict=True):
            if not res.get("ok"):
                refused.append({"id": sp["id"], "name": sp["name"], "why": str(res.get("error"))[:300]})
                continue
            r = res["result"]
            rules.append(
                {
                    "id": sp["id"],
                    "name": sp["name"],
                    "style": sp.get("style", ""),
                    "sample": r["sample"],
                    "metrics": r["metrics"],
                    "account": r["account"],
                    "ms": r["ms"],
                }
            )
            # ONE ROW PER SETUP, TAGGED WITH THE RULE THAT PRODUCED IT. Pooling
            # without the tag would train a model that cannot tell an EMA cross
            # from a mean reversion, which is most of what decides the outcome.
            for row in r["rows"]:
                row["features"]["ruleIdx"] = float(specs.index(sp))
                pooled.append(row)

    report = train_router(pooled, min_rows=MIN_ROWS) if pooled else None
    if report is None:
        report = {
            "ok": False,
            "why": "no rule produced a resolved setup on this history, so there is nothing to learn from",
        }

    return {
        "ok": True,
        "sym": sym,
        "tf": tf,
        "src": src,
        "bars": len(bars),
        "from": bars[0]["t"],
        "to": bars[-1]["t"],
        "rules": rules,
        "refused": refused,
        "pooled": len(pooled),
        "router": report,
        "balance": BALANCE,
        "riskPct": RISK_PCT,
        "horizon": HORIZON,
    }


# ----------------------------------------------------------------- storage --
def store(result: dict[str, Any], key: str) -> None:
    with db() as c:
        c.execute(
            "INSERT INTO auto_runs(sym,tf,q,at,payload) VALUES(?,?,?,?,?) "
            "ON CONFLICT(sym,tf) DO UPDATE SET q=excluded.q, at=excluded.at, payload=excluded.payload",
            (result["sym"], result["tf"], key, time.time(), json.dumps(result)),
        )


def results() -> list[dict[str, Any]]:
    try:
        with db() as c:
            rows = c.execute("SELECT sym,tf,q,at,payload FROM auto_runs ORDER BY at DESC").fetchall()
    except Exception as e:  # noqa: BLE001
        log_event("auto_results_failed", str(e))
        return []
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except json.JSONDecodeError:
            continue
        payload["at"] = r["at"]
        payload["q"] = r["q"]
        out.append(payload)
    return out


# -------------------------------------------------------------- one pass ---
def auto_pass() -> dict[str, Any]:
    """One sweep over every subject. Returns what it did, including nothing."""
    ready = readiness()
    if not ready["ok"]:
        return {"ok": False, "why": ready["why"], "studied": 0}

    with _LOCK:
        if STATE["running"]:
            return {"ok": False, "why": "a pass is already running", "studied": 0}
        STATE.update(
            running=True, started=time.time(), finished=0.0, subject="",
            studied=0, rules_run=0, rules_refused=0, last_error="",
        )
        STATE["pass_no"] += 1

    key = _question([s["id"] for s in catalogue()])
    studied = 0
    try:
        for sym, tf, src, _n in subjects():
            STATE["subject"] = f"{sym} {tf}"
            try:
                res = study_subject(sym, tf, src)
            except Exception as e:  # noqa: BLE001 - one dead market must not end the pass
                STATE["last_error"] = f"{sym} {tf}: {e}"
                log_event("auto_subject_failed", f"{sym}|{tf}: {e}")
                continue
            if not res.get("ok"):
                STATE["last_error"] = f"{sym} {tf}: {res.get('why')}"
                continue
            store(res, key)
            studied += 1
            STATE["studied"] = studied
            STATE["rules_run"] += len(res["rules"])
            STATE["rules_refused"] += len(res["refused"])
    finally:
        # A CANCELLED OR CRASHED PASS MUST NOT LOOK FINISHED. `finished` is set
        # here either way, and `studied` says how far it actually got.
        STATE.update(running=False, finished=time.time(), subject="")

    return {"ok": True, "studied": studied, "q": key}


def auto_loop() -> None:
    while True:
        tick("auto_loop")
        try:
            auto_pass()
        except Exception as e:  # noqa: BLE001
            log_event("auto_pass_failed", str(e))
        sleep_ticking("auto_loop", PASS_EVERY_S)


# ------------------------------------------------------------------ routes --
@bp.get("/svc/auto/state")
def auto_state():
    """What the loop is doing, in COUNTS. A tick age is not a health check."""
    ready = readiness()
    return jsonify(
        ok=True,
        ready=ready,
        state=dict(STATE),
        stored=len(results()),
        passEveryS=PASS_EVERY_S,
        horizon=HORIZON,
        balance=BALANCE,
        riskPct=RISK_PCT,
        maxSubjects=MAX_SUBJECTS,
    )


@bp.get("/svc/auto/results")
def auto_results():
    """Every stored result, newest first. Whole, including the refusals."""
    return jsonify(ok=True, results=results(), q=_question([s["id"] for s in catalogue()]))


@bp.post("/svc/auto/run")
def auto_run_now():
    """Run one pass now, in the background, and answer immediately.

    A pass is minutes of CPU. Holding the request open for it would time out in
    the browser and leave the operator unable to tell a slow pass from a dead
    one; `/svc/auto/state` is how progress is read.
    """
    if STATE["running"]:
        return jsonify(ok=False, why="a pass is already running"), 200
    ready = readiness()
    if not ready["ok"]:
        return jsonify(ok=False, why=ready["why"]), 200
    threading.Thread(target=auto_pass, name="auto-pass", daemon=True).start()
    return jsonify(ok=True, started=True)


@bp.get("/svc/auto/subjects")
def auto_subjects():
    """What a pass WOULD study, so the answer is knowable before it runs."""
    return jsonify(
        ok=True,
        subjects=[{"sym": s, "tf": t, "src": src, "bars": n} for s, t, src, n in subjects()],
        minBars=MIN_BARS,
        maxSubjects=MAX_SUBJECTS,
    )


__all__ = [
    "auto_loop",
    "auto_pass",
    "auto_results",
    "auto_state",
    "auto_subjects",
    "bp",
    "catalogue",
    "readiness",
    "results",
    "store",
    "study_subject",
    "subjects",
]
