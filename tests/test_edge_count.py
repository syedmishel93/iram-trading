#!/usr/bin/env python3
"""
test_edge_count.py - A COUNT THAT CANNOT BE WRONG IS NOT EVIDENCE.

`mishel_edge.upsert` returned `len(rows)` -- the size of its own INPUT -- and
`/svc/edge/push` logged that as "400 of 400 written". Both halves of that
sentence came from the same number, so it could never disagree with itself
whatever the database did. Same defect as the test that asserted
`expect(reason).toContain(QUANT_BASE)` where both sides were the same broken
expression.

It matters here because `trials` holds ZERO rows on a database whose event log
goes back to 2026-07-16 and contains "400 of 400 written" dated 2026-09-03. What
removed them is not recoverable and is not guessed at; what IS fixable is that
the log could never have told anyone.

WHAT IS ASSERTED: the returned count comes from the DATABASE, not from the
argument -- so a push whose rows are all discarded reports zero, and a re-push
of the same trials reports them written but not ADDED.

On a scratch database. CLAUDE.md records four test files that wrote into the
operator's live mishel.db; this is not the fifth.
"""

import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server"))

import mishel_edge

FAILED = []


def check(name, got, want):
    if got == want:
        print("  ok   %s: %r" % (name, got))
    else:
        print("  FAIL %s: got %r, want %r" % (name, got, want))
        FAILED.append(name)


def fresh():
    conn = sqlite3.connect(os.path.join(tempfile.mkdtemp(), "edge.db"))
    conn.row_factory = sqlite3.Row
    mishel_edge.init(conn)
    return conn


def trial(tid):
    """One trial in the shape `sanitise` actually accepts."""
    return {
        "id": tid,
        "at": 1790000000000,
        "symbol": "BTCUSDT",
        "timeframe": "1h",
        "kind": "breakout",
        "direction": "long",
        "outcome": "target",
        # THE WIRE KEY IS camelCase. `sanitise` reads `rGross`, and the COLUMN
        # is `r_gross`; a fixture written from the column list sanitises to None
        # and the whole push silently reports zero. The browser sends the wire
        # shape, so the test must too.
        "rGross": 1.4,
        "stopPct": 0.9,
        "mfeR": 2.0,
        "maeR": -0.4,
        "barsHeld": 12,
        "confidence": 0.6,
        "regime": "trend",
        "device": "test",
    }


print("A PUSH REPORTS WHAT LANDED")
c = fresh()
r = mishel_edge.upsert(c, [trial("a"), trial("b")])
check("written", r["written"], 2)
check("added", r["added"], 2)
check("offered", r["offered"], 2)
check("rows in the table", c.execute("SELECT count(*) FROM trials").fetchone()[0], 2)

print()
print("RE-PUSHING THE SAME TRIALS WRITES THEM AND ADDS NONE")
# A replay is deterministic, so re-running it must converge rather than
# accumulate. "written 2, added 0" is the honest description of that.
r = mishel_edge.upsert(c, [trial("a"), trial("b")])
check("written", r["written"], 2)
check("added", r["added"], 0)
check("rows still", c.execute("SELECT count(*) FROM trials").fetchone()[0], 2)

print()
print("A PUSH OF RUBBISH REPORTS ZERO, NOT ITS OWN LENGTH")
c2 = fresh()
r = mishel_edge.upsert(c2, [{"id": "x"}, {"nope": 1}, None])
check("written", r.get("written", 0) if isinstance(r, dict) else r, 0)
check("rows in the table", c2.execute("SELECT count(*) FROM trials").fetchone()[0], 0)

print()
print("AND THE COUNT COMES FROM THE DATABASE, NOT THE ARGUMENT")
# The proof that the two are no longer the same number: offer three, one of
# which cannot be stored, and the written count must be two.
c3 = fresh()
r = mishel_edge.upsert(c3, [trial("p"), {"broken": True}, trial("q")])
check("offered", r["offered"], 2)
check("written", r["written"], 2)
check("rows in the table", c3.execute("SELECT count(*) FROM trials").fetchone()[0], 2)

print()
if FAILED:
    print("FAILED: %d" % len(FAILED))
    for f in FAILED:
        print("  - %s" % f)
    sys.exit(1)
print("ALL PASS")
