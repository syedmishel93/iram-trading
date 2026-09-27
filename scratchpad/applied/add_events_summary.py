"""Give the event log a summary, so a recurring failure reads as a standing.

`/svc/events` is `ORDER BY id DESC LIMIT 50` and nothing else. On that, the
2,067 `pair_err` rows -- 46% of everything the service had ever recorded, one
per run of a loop that had never once succeeded -- appeared as twelve ordinary
lines among other ordinary lines. Counting the tail would have under-reported it
forty-fold, which is CLAUDE.md's "a count of what has REPORTED is not a count of
what EXISTS".

So the counting is done in SQL over the whole table and the classification in one
pure function, `summarise_events`, which is the part that can be wrong.

THE ROUTE STAYS THIN, because `mishel_service.py` must remain a FACADE: the
query and a call, with the judgement in `svc/core.py` beside `log_event`, which
is what writes the rows in the first place.
"""

import io

CORE = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\server\svc\core.py"
SVC = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\server\mishel_service.py"

# ------------------------------------------------------------------ core.py --
s = io.open(CORE, encoding="utf-8").read()

anchor = '''def log_event(kind, msg):
    with db() as c: c.execute("INSERT INTO events(t,kind,msg) VALUES(?,?,?)", (time.time(), kind, msg))
'''
if s.count(anchor) != 1:
    raise SystemExit("core.py: log_event anchor matched %d times" % s.count(anchor))

added = anchor + '''
# A kind whose name ends this way is a FAILURE. One owner, because the server
# orders by it and the card colours by it, and two lists would disagree -- which
# is the defect `views.ts` and `toolsmenu.ts` demonstrated with 0 of 24 groups
# agreeing.
ERR_SUFFIXES = ("_err", "_error", "_fail", "_failed")


def is_failure_kind(kind):
    """Is this event kind a failure? Asked in one place."""
    k = (kind or "").lower()
    return any(k.endswith(x) for x in ERR_SUFFIXES)


def summarise_events(groups):
    """Classify and order grouped event counts.

    `groups` comes from `SELECT kind, count(*), max(t), min(t) ... GROUP BY kind`
    -- the count is over the WHOLE table, never over a tail, because the fact
    worth reporting is that something has failed two thousand times and a
    fifty-row window cannot carry it.

    FAILURES FIRST, newest first, then everything else newest first. A reader
    opening this is asking "is anything wrong", and answering that means putting
    the answer at the top rather than in chronological order.

    AN EMPTY TABLE IS NOT A HEALTHY ONE. It gets `emptyReason` and no verdict:
    the `/svc/health` strip that built its loop list from what had already ticked
    and painted "0 of 0 running" green is the mistake being avoided here.
    """
    kinds = []
    for g in groups or []:
        n = int(g.get("n") or 0)
        if n <= 0:
            # A group with no rows is not a zero to draw; it is not a group.
            continue
        kinds.append({
            "kind": g.get("kind") or "",
            "n": n,
            "newest": float(g.get("newest") or 0),
            "oldest": float(g.get("oldest") or 0),
            "sample": (g.get("sample") or "")[:200],
            "failing": is_failure_kind(g.get("kind")),
        })

    kinds.sort(key=lambda k: (0 if k["failing"] else 1, -k["newest"]))

    total = sum(k["n"] for k in kinds)
    failing = [k for k in kinds if k["failing"]]
    out = {
        "ok": True,
        "kinds": kinds,
        "total": total,
        "failingTotal": sum(k["n"] for k in failing),
        "failingKinds": len(failing),
        "since": min([k["oldest"] for k in kinds]) if kinds else 0,
    }
    if not kinds:
        out["emptyReason"] = (
            "nothing has been recorded yet - this is what the log holds, not a "
            "statement that everything worked"
        )
    return out
'''
s = s.replace(anchor, added, 1)
io.open(CORE, "w", encoding="utf-8").write(s)
print("svc/core.py: summarise_events + is_failure_kind")

# --------------------------------------------------------- mishel_service.py --
s = io.open(SVC, encoding="utf-8").read()

anchor = '''@app.get("/svc/events")
def get_events():
    with db() as c:
        return jsonify([dict(r) for r in c.execute("SELECT * FROM events ORDER BY id DESC LIMIT 50")])
'''
if s.count(anchor) != 1:
    raise SystemExit("mishel_service.py: events anchor matched %d times" % s.count(anchor))

added = '''@app.get("/svc/events")
def get_events():
    # The tail, with a caller-chosen depth. It was a hardcoded 50, which is fine
    # for "what just happened" and useless for "how often has this happened" --
    # that is what /svc/events/summary is for.
    lim = max(1, min(500, int(request.args.get("limit") or 50)))
    with db() as c:
        return jsonify([dict(r) for r in c.execute(
            "SELECT * FROM events ORDER BY id DESC LIMIT ?", (lim,))])


@app.get("/svc/events/summary")
def get_events_summary():
    """Per-kind counts over the WHOLE table, failures first.

    The count has to be SQL. A 50-row tail reported a loop that had failed 2,067
    times as twelve lines, which is how it survived for releases.
    """
    with db() as c:
        groups = [dict(r) for r in c.execute(
            "SELECT kind, count(*) AS n, max(t) AS newest, min(t) AS oldest, "
            "       max(msg) AS sample "
            "FROM events GROUP BY kind")]
    return jsonify(summarise_events(groups))
'''
s = s.replace(anchor, added, 1)

# The facade must re-export what it uses, and `gateway/background.py` resolves
# names off this module by getattr.
imp = "from svc.core import ("
if imp in s:
    head = s.index(imp)
    # The closing paren at the START OF A LINE. The import line itself carries a
    # `# noqa: F401  (RE-EXPORTS: ...)` comment, and the first `)` after the head
    # is inside THAT -- so a naive search inserts the new name into a comment.
    end = s.index(chr(10) + ")", head) + 1
    block = s[head:end]
    if "summarise_events" not in block:
        s = s[:end] + "    summarise_events,\n" + s[end:]
        print("mishel_service.py: summarise_events added to the svc.core import")
    else:
        print("mishel_service.py: already imported")
else:
    raise SystemExit("could not find the svc.core import block in the facade")

io.open(SVC, "w", encoding="utf-8").write(s)
print("mishel_service.py: /svc/events/summary + a limit on /svc/events")
