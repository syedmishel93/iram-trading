"""Replace the route backlog paragraph with an ITEMISED ledger.

The bullet had grown by accretion across six releases — every wiring appended a
clause, and the result was a paragraph that stated a number and then argued with
itself about what the number meant. A reader could not tell which routes were
work and which were categorically not.

So it becomes a table with a REASON PER ROUTE. 25 is then a closed decision list
rather than a backlog of unknown size, and the next person can disagree with a
specific line instead of re-deriving the whole thing.
"""

import io

P = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\CLAUDE.md"
s = io.open(P, encoding="utf-8").read()

start = s.index("- **26 of 96 backend routes are never called by the frontend**")
end = s.index("- **There is no execution path.**")
old = s[start:end]
assert "upper bound" in old, "did not find the whole paragraph"

new = '''- **25 of 96 backend routes are never called by the frontend**, re-measured in
  v62.18 by `scratchpad/routes.py`, which walks every `@bp.get/@bp.post` under
  `server/` and greps `app/src` for each path. It goes stale every release —
  run the script rather than quoting the number. (It EXCLUDES
  `server/build/venv`: its first run walked 7,789 files and reported FastAPI's
  own docstring examples, `/items/` and `/users/me`, as uncalled routes of this
  product.)

  **The number on its own has always overstated the work, so here is the whole
  list with a reason each.** Previous versions of this bullet stated a figure
  and then spent a paragraph arguing with it; a reader could not tell which
  routes were work and which were categorically not. Now the next person can
  disagree with a line instead of re-deriving the set.

  | why it is uncalled | routes |
  | --- | --- |
  | **Not a fetch target.** The browser is SERVED these, or a human reads them with curl. | `GET /`, `GET /legacy`, `GET /api/routes`, `GET /quant/endpoints` |
  | **Deliberately dead**, recorded above. | `GET/POST /svc/data/ohlc`, `GET /svc/data/series`, `GET /svc/data/errors` |
  | **The store is empty**, so a screen would show nothing until something fills it. Wire the WRITER first. | `GET/POST /svc/ledger` (0 rows), `GET /svc/edge/kinds` (`trials` 0 rows), `GET /svc/onchain/leaderboard` |
  | **Destructive or administrative**, and deliberately not one click away. `/svc/store/evict` deletes gigabytes and defaults to `dry_run`. | `POST /svc/store/evict`, `POST /svc/mt5/import`, `POST /svc/backup` |
  | **Real capability with no screen — this is the actual backlog.** | `GET /mt5/symbols` (272 broker symbols, and the symbol picker offers far fewer), `GET /providers` + `/providers/rank` (which vendor to trust per asset class), `GET /svc/mt5/status` (bridge state and the broker clock offset), `GET /svc/auto/subjects` (what the autonomous loop studies next), `GET /svc/router/health`, `GET /svc/backup` + `GET /svc/kv/manifest` (what is backed up, and how big), `GET /api/stream/status`, `POST /ai` |

  So the real backlog is **ten routes**, not twenty-five. The rest are a
  decision, and `/mt5/symbols` is the one with a user complaint attached to it.

  Wired since this bullet was first written: `/mt5/health`, `/account`,
  `/positions`, `/symbol`, `/mt5/deals`, `/svc/recon` (v59, the Journal's Broker
  fills panel), `/svc/risk/check|size|state|config` and `/svc/notify` +
  `/svc/telegram` (v62.12), `/svc/claims/stats` (v62.13), `/svc/events` +
  `/svc/events/summary` (v62.14 — finding a loop that had failed 2,069 times
  behind it is the argument for the rest of them), `/svc/onchain/pairs` and
  `/svc/onchain/dbwallets` (v62.17), and `/svc/costs` (v62.18, which found the
  backtester charging 3-5x this broker's real spread).

  The thirteen background loops in `gateway/background.py` produce state almost
  none of which is displayed — `auto_loop` (v62.6) is the exception and the
  Simulation desk is its screen, and `ui/data/system.ts` plus the activity card
  now show the loops themselves. **This remains the largest single source of
  "the product has functions I cannot use", and it is a wiring problem rather
  than a missing-feature one.**

'''
io.open(P, "w", encoding="utf-8").write(s[:start] + new + s[end:])
print("route backlog is now an itemised ledger: 25, of which 10 are real work")
