"""
Client state that has to outlive the browser: backup, sync, and the KV store.

Three generations of the same need, kept together because they answer the same
question -- "where does the terminal's state live when localStorage is not
enough?" -- and because a change to one is usually a question about the others:

  /svc/backup      v29  one blob of localStorage-critical state, overwritten
  /svc/kv*         v35  per-key, last-write-wins with a monotonic rev; the
                        browser compares revs on boot and pulls only what changed
  /svc/sync/*      v41  the two-call contract the Supabase and custom-endpoint
                        adapters also speak, so "cloud" never means one vendor

Moved out of `mishel_service.py` in v59.

BARS ARE NOT SYNCED and /svc/sync/push will not accept them. They are the same
public data on every machine and a re-fetch rebuilds them for free.
"""

import json
import time

from db import db
from flask import Blueprint, jsonify, request

from svc.core import arg_num

bp = Blueprint("sync", __name__)


#: A key whose NAME says credential. The client's `syncable()` in
#: `store/sync.ts` is the first filter and this is the second, on purpose.
#:
#: DEFENCE IN DEPTH, because this has nearly happened. CLAUDE.md records the
#: analyst's API key reaching a remote endpoint when "is this a credential?" had
#: two answers, and `settingsbackup.ts` becoming a third within one session. A
#: guard that lives only in the client is a guard a client bug removes, and the
#: cost here is a credential written to disk in a file the operator then backs up.
SECRET_HINTS = ("token", "secret", "apikey", "api_key", "password", "passwd",
                "credential", "bearer", "privatekey", "private_key")


def _looks_secret(name: str) -> bool:
    n = (name or "").replace("-", "").replace("_", "").lower()
    return any(h.replace("_", "") in n for h in SECRET_HINTS)


@bp.post("/svc/backup")
def svc_backup_post():
    """v29 #3: client auto-backup of localStorage-critical state.

    THE WHOLE BLOB IS REPLACED, which is right for a snapshot and dangerous
    without guards. `INSERT OR REPLACE` means a push carrying two slots DESTROYS
    the other eleven, and that is not hypothetical: a scheduling test once POSTed
    two fixture slots over the operator's thirteen real ones. The fix at the time
    was in the client (`startBackup`'s transport lost its live default), and it
    left this end accepting anything -- including `{}`, which wiped the backup and
    answered `ok: true, bytes: 2`.

    Three guards, none of which changes the contract the client already speaks:

      1. AN EMPTY BODY IS REFUSED. Nothing legitimate backs up nothing, and the
         only thing an empty push can do is destroy.
      2. A CREDENTIAL IS REFUSED BY NAME. See `SECRET_HINTS`.
      3. THE DELTA IS REPORTED AND LOGGED. `removed` names the slots this push
         dropped, so a destructive one is visible instead of silent -- the rule
         this project states as "a bulk action must name what it skipped".

    A push that legitimately drops a slot still succeeds. It just says so.
    """
    try:
        blob = request.get_json(force=True, silent=True)
        if not isinstance(blob, dict):
            return jsonify(ok=False, why="a backup has to be an object of slots"), 200
        if not blob:
            return jsonify(
                ok=False,
                why="that backup is empty, so storing it would only delete the one "
                    "already here. Nothing was changed.",
            ), 200

        secret = sorted(k for k in blob if _looks_secret(k))
        if secret:
            return jsonify(
                ok=False,
                why="refusing to store %s: that looks like a credential, and this "
                    "backup is written to disk. Keep it in the browser."
                    % ", ".join(secret),
                refused=secret,
            ), 200

        con = db()
        row = con.execute("SELECT v FROM kv WHERE k='client_backup'").fetchone()
        had = set()
        if row and row[0]:
            try:
                prev = json.loads(row[0])
                had = set(prev) if isinstance(prev, dict) else set()
            except ValueError:
                had = set()
        now = set(blob)

        con.execute("INSERT OR REPLACE INTO kv(k,v,t) VALUES('client_backup',?,?)",
                    (json.dumps(blob), time.time()))
        con.commit()
        removed = sorted(had - now)
        added = sorted(now - had)
        if removed:
            # Announced after the write, and only when something was lost -- a log
            # line on every ordinary backup is a log nobody reads.
            from svc.core import log_event
            log_event("backup_shrank",
                      "backup replaced; %d slot(s) no longer present: %s"
                      % (len(removed), ", ".join(removed)[:160]))
        return jsonify(ok=True, bytes=len(json.dumps(blob)), t=time.time(),
                       slots=len(now), added=added, removed=removed)
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

@bp.get("/svc/backup")
def svc_backup_get():
    try:
        row = db().execute("SELECT v,t FROM kv WHERE k='client_backup'").fetchone()
        if not row: return jsonify(ok=True, backup=None)
        return jsonify(ok=True, backup=json.loads(row[0]), t=row[1])
    except Exception as e:
        return jsonify(ok=False, error=str(e)), 500

# ---------------------------------------------------------------- v41: sync --
# The zero-setup sync target for the terminal: alerts, layouts and watchlists
# across browsers and machines on this LAN, with nothing leaving the machine and
# no account anywhere. The contract is deliberately two calls -- the same two the
# Supabase and custom-endpoint adapters speak -- so "cloud" never has to mean one
# vendor, and so a self-hosted target is an afternoon rather than a project.
#
# BARS ARE NOT SYNCED and this endpoint will not accept them. They are the same
# public data on every machine, a re-fetch rebuilds them for free, and pushing
# hundreds of megabytes through SQLite to reconstruct something free is a cost
# with no benefit. History moves by vault file, when you actually want it moved.

@bp.get("/svc/sync/pull")
def sync_pull():
    try:
        since = arg_num("since", 0.0, lo=0.0, cast=float)
    except ValueError:
        return jsonify(err="since must be a number"), 400
    limit = arg_num("limit", 1000, lo=1, hi=5000)
    with db() as c:
        rows = c.execute(
            "SELECT k,v,ver,at,deleted_at,device FROM terminal_sync "
            "WHERE at >= ? ORDER BY at ASC LIMIT ?", (since, limit)).fetchall()
    out = []
    for r in rows:
        try:
            value = json.loads(r["v"]) if r["v"] is not None else None
        except (ValueError, TypeError):
            # A row we cannot parse is skipped, not served as null: null is a
            # TOMBSTONE here, and serving one would delete the client's copy.
            continue
        out.append({"key": r["k"], "value": value, "v": int(r["ver"] or 1),
                    "at": float(r["at"]), "deletedAt": r["deleted_at"],
                    "device": r["device"] or "unknown"})
    return jsonify(out)

@bp.post("/svc/sync/push")
def sync_push():
    d = request.get_json(force=True) or {}
    records = d.get("records") if isinstance(d, dict) else d
    if not isinstance(records, list):
        return jsonify(ok=False, err="expected {records: [...]}"), 400
    if len(records) > 2000:
        return jsonify(ok=False, err="too many records in one push"), 400

    # Counted as rows CHANGED, not records received. A push whose rows all lost
    # the last-write-wins comparison changed nothing, and reporting "written: 12"
    # for it would tell the client its edits landed when they were refused.
    written = 0
    skipped = 0
    with db() as c:
        for r in records:
            if not isinstance(r, dict): continue
            k = r.get("key")
            at = r.get("at")
            if not isinstance(k, str) or not k or not isinstance(at, (int, float)):
                continue
            body = json.dumps(r.get("value"))
            # A payload big enough to be bar data does not belong here.
            if len(body) > 512_000:
                continue
            # Last write wins, and the WHERE clause is what makes the push
            # idempotent: a retried push cannot move a row backwards, so a
            # network failure mid-sync is safe to simply repeat.
            cur = c.execute(
                "INSERT INTO terminal_sync(k,v,ver,at,deleted_at,device) VALUES(?,?,?,?,?,?) "
                "ON CONFLICT(k) DO UPDATE SET v=excluded.v, ver=excluded.ver, at=excluded.at, "
                "deleted_at=excluded.deleted_at, device=excluded.device "
                "WHERE excluded.at > terminal_sync.at",
                (k, body, int(r.get("v") or 1), float(at), r.get("deletedAt"),
                 str(r.get("device") or "unknown")[:64]))
            if cur.rowcount > 0:
                written += 1
            else:
                skipped += 1
    return jsonify(ok=True, written=written, skipped=skipped)

# ---------------- v35.0: durable client state (SQLite is the source of truth) ----------------
@bp.get("/svc/kv/manifest")
def kv_manifest():
    """Cheap revision list. The browser compares revs on boot and only pulls what changed."""
    with db() as c:
        rows = c.execute("SELECT k, rev, t, LENGTH(v) AS bytes FROM kvstore").fetchall()
    return jsonify(ok=True, manifest={r["k"]: {"rev": r["rev"], "t": r["t"], "bytes": r["bytes"]} for r in rows})

@bp.get("/svc/kv/<path:k>")
def kv_get(k):
    with db() as c:
        r = c.execute("SELECT v, rev, t FROM kvstore WHERE k=?", (k,)).fetchone()
    if not r: return jsonify(ok=True, k=k, v=None, rev=0)
    return jsonify(ok=True, k=k, v=r["v"], rev=r["rev"], t=r["t"])

@bp.post("/svc/kv")
def kv_put():
    """Last-write-wins with a monotonic rev. Correct for one user on one account;
    the rev is what lets a fresh browser know the server is ahead of it."""
    d = request.get_json(force=True) or {}
    items = d.get("items") or ({d["k"]: d["v"]} if "k" in d else {})
    if not items: return jsonify(ok=False, err="items required"), 400
    out = {}
    with db() as c:
        for k, v in items.items():
            c.execute("INSERT INTO kvstore(k,v,rev,t) VALUES(?,?,1,?)"
                      " ON CONFLICT(k) DO UPDATE SET v=excluded.v, rev=kvstore.rev+1, t=excluded.t",
                      (k, v if isinstance(v, str) else json.dumps(v), time.time()))
            out[k] = c.execute("SELECT rev FROM kvstore WHERE k=?", (k,)).fetchone()[0]
    return jsonify(ok=True, revs=out)
