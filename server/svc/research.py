"""
Research routes: the claims ledger, edge trials, news headlines, the analyst.

Four thin HTTP adapters, each over a module that does the real work and is
tested on its own: `mishel_claims`, `mishel_edge`, `mishel_rss` and
`mishel_analyst`. Moved out of `mishel_service.py` in v59. They share nothing
with the rest of the service but the database and the event log.

THE CLAIMS LEDGER (v54)
The durable copy of what the terminal said and what happened next. The browser
already records and resolves claims (app/src/learn/), but it keeps them in
localStorage: ~5MB, shared with the drawing store, capped, and able to accept a
write and discard it on teardown. That is a fine place for a preference and a
poor one for the only asset here that cannot be regenerated -- bars re-fetch
for free, a claim made in March before the outcome was known does not. See the
header of mishel_claims.py.

Nothing here feeds back into any score or threshold. Same refusal, same
reason, as app/src/learn/store.ts.

The `import mishel_*` statements stay INSIDE each route, as they were: a
broken optional module then fails its own route with a reason instead of
stopping the whole service from importing.
"""

from db import db
from flask import Blueprint, jsonify, request

from svc.core import arg_num, log_event

bp = Blueprint("research", __name__)


@bp.get("/svc/news/rss")
@bp.post("/svc/news/rss")
def svc_news_rss():
    """
    Headlines from RSS and Atom feeds.

    Server-side because almost no newsroom sends CORS headers on its feed, so a
    browser-side reader gets a network error on nearly every one and cannot
    tell that apart from the feed being down. See server/mishel_rss.py.

    GET uses the default feeds; POST takes {"feeds": [{url, source}, ...]} so
    the operator can point it wherever they like. Titles, links, timestamps and
    the source name only — nothing here follows a link or fetches an article.
    """
    try:
        import mishel_rss
        feeds = None
        if request.method == "POST":
            d = request.get_json(silent=True) or {}
            feeds = mishel_rss.sanitise_feeds(d.get("feeds"))
        out = mishel_rss.load(feeds)
        return jsonify(ok=True, **out)
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.post("/svc/edge/trials")
def svc_edge_push():
    """
    Store replayed trials.

    The browser does the replay -- `app/src/setup/simulate.ts` already knows how
    to do it honestly and porting twenty-nine detectors to Python would create
    a second implementation to drift against the first. What comes here is the
    OUTCOMES, which is the part that needs to accumulate across sessions and
    survive localStorage.
    """
    try:
        import mishel_edge
        d = request.get_json(force=True) or {}
        trials = d.get("trials") if isinstance(d, dict) else d
        if not isinstance(trials, list):
            return jsonify(ok=False, err="expected {trials: [...]}"), 400
        if len(trials) > 20000:
            return jsonify(ok=False, err="too many trials in one push"), 400
        with db() as c:
            mishel_edge.init(c)
            res = mishel_edge.upsert(c, trials)
        # `written` is now what LANDED and `offered` what was sent; they differ
        # when a trial fails `sanitise`, and that gap was previously invisible
        # because both halves of the sentence came from the same number.
        dropped = res["offered"] - res["written"]
        note = f"{res['written']} of {len(trials)} written"
        if dropped > 0:
            note += f" ({dropped} dropped by sanitise)"
        log_event("edge_push", note)
        return jsonify(ok=True, received=len(trials), written=res["written"],
                       added=res["added"], dropped=dropped)
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.get("/svc/edge/conditional")
def svc_edge_conditional():
    """
    The conditional table, net of costs, with the multiple-comparisons
    correction stated rather than buried.

    Costs default to a 2bp spread and 1bp slippage charged on a round trip.
    They are deliberately not zero-able from the query string below 0: a
    frictionless backtest is the most common way this kind of table lies.
    """
    try:
        import mishel_edge

        def bps(name, default):
            try:
                return arg_num(name, float(default), lo=0.0, cast=float)
            except (TypeError, ValueError):
                return default

        costs = mishel_edge.Costs(
            spread_bps=bps("spreadBps", 2.0),
            slippage_bps=bps("slippageBps", 1.0),
            commission_bps=bps("commissionBps", 0.0),
        )
        with db() as c:
            mishel_edge.init(c)
            rows = mishel_edge.fetch(
                c,
                symbol=request.args.get("symbol"),
                timeframe=request.args.get("timeframe"),
                kind=request.args.get("kind"),
                since=request.args.get("since"),
            )
        return jsonify(ok=True, **mishel_edge.conditional(rows, costs=costs))
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.get("/svc/edge/kinds")
def svc_edge_kinds():
    """What has trials at all, so the desk offers only answerable questions."""
    try:
        import mishel_edge
        with db() as c:
            mishel_edge.init(c)
            rows = mishel_edge.kinds(
                c,
                symbol=request.args.get("symbol"),
                timeframe=request.args.get("timeframe"),
            )
        return jsonify(ok=True, kinds=rows)
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.post("/svc/claims")
def svc_claims_push():
    try:
        import mishel_claims
        d = request.get_json(force=True) or {}
        claims = d.get("claims") if isinstance(d, dict) else d
        if not isinstance(claims, list):
            return jsonify(ok=False, err="expected {claims: [...]}"), 400
        if len(claims) > 5000:
            return jsonify(ok=False, err="too many claims in one push"), 400
        with db() as c:
            mishel_claims.init(c)
            # Counted as rows CHANGED, not received. A push whose rows all lost
            # the resolved-never-unresolves guard changed nothing, and reporting
            # the received count would tell the client its writes landed.
            written = mishel_claims.upsert(c, claims)
        log_event("claims_push", f"{written} of {len(claims)} written")
        return jsonify(ok=True, received=len(claims), written=written)
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.get("/svc/claims")
def svc_claims_list():
    try:
        import mishel_claims
        limit = arg_num("limit", 500, lo=1, hi=5000)
        where, args = [], []
        for field, arg in (("symbol", "symbol"), ("timeframe", "timeframe"), ("outcome", "outcome")):
            v = request.args.get(arg)
            if v:
                where.append(f"{field} = ?")
                args.append(v)
        sql = "SELECT * FROM claims"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY at DESC LIMIT ?"
        args.append(limit)
        with db() as c:
            mishel_claims.init(c)
            rows = [dict(r) for r in c.execute(sql, tuple(args)).fetchall()]
        return jsonify(ok=True, claims=rows, count=len(rows))
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.get("/svc/claims/stats")
def svc_claims_stats():
    """Hit rate by setup, symbol and timeframe; takes against stand-downs; and
    the reliability curve. The last of those is allowed to come back flat, which
    would say the confidence figure on the card is decoration -- worth knowing,
    and not visible any other way."""
    try:
        import mishel_claims
        with db() as c:
            mishel_claims.init(c)
            return jsonify(mishel_claims.stats(
                c,
                symbol=request.args.get("symbol"),
                timeframe=request.args.get("timeframe"),
                since=request.args.get("since"),
            ))
    except Exception as e:
        return jsonify(ok=False, err=str(e)), 500


@bp.post("/svc/analyst")
def svc_analyst():
    """v39.18: the standalone glass-box decision engine. Client POSTs the live
    terminal state (mtf/confluence/orderflow/regime/news/levels/account); we
    return ONE explainable decision. Grounded, deterministic, no LLM."""
    try:
        import mishel_analyst
        d = request.get_json(force=True) or {}
        return jsonify(mishel_analyst.analyze(d))
    except Exception as e:
        return jsonify(ok=False, err=str(e))
