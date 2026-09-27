"""Close the route ledger: 16 uncalled, ZERO of them capability with no screen.

Every wiring this session shrank the number; this pass shrank the CATEGORY that
mattered to nothing. The remaining sixteen are each a decision, and two of them
are decisions I made by measuring rather than by wiring:

  * `/svc/auto/subjects` returns byte-identical data to `ready.subjects` inside
    `/svc/auto/state`, which the Simulation desk already renders. Wiring it
    would be one fact with two owners -- the reason `forexfactory_cal` was
    deleted earlier in the same session.
  * `POST /ai` is an OPTIONAL server-side LLM proxy that refuses without an
    `ANTHROPIC_API_KEY` the operator supplies. The Analyst desk runs a built-in
    local analyst by design, which is what the route's own refusal message says
    it will do. Not a missing screen, and not mine to key.
"""

import io

P = r"C:\Users\syedmishel\Downloads\DOWNLOADS FOLDER COPY\IRAM TRADING\CLAUDE.md"
s = io.open(P, encoding="utf-8").read()

start = s.index("- **24 of 96 backend routes are never called by the frontend**")
end = s.index("- **There is no execution path.**")
old = s[start:end]
assert "actual backlog" in old, "paragraph not found"

new = '''- **16 of 96 backend routes are never called by the frontend, and NONE of them
  is capability without a screen.** Re-measured in v62.20 by
  `scratchpad/routes.py`, which walks every `@bp.get/@bp.post` under `server/`
  and greps `app/src` for each path. Run the script rather than quoting the
  number. (It EXCLUDES `server/build/venv`: its first run walked 7,789 files and
  reported FastAPI's own docstring examples, `/items/` and `/users/me`, as
  uncalled routes of this product.)

  | why it is uncalled | routes |
  | --- | --- |
  | **Not a fetch target.** The browser is SERVED these, or a human reads them with curl. | `GET /`, `GET /legacy`, `GET /api/routes`, `GET /quant/endpoints` |
  | **Deliberately dead**, recorded above. | `GET/POST /svc/data/ohlc`, `GET /svc/data/series`, `GET /svc/data/errors` |
  | **The store is empty**, so a screen would show nothing until something fills it. Wire the WRITER first. | `GET/POST /svc/ledger` (0 rows), `GET /svc/edge/kinds` (`trials` 0 rows), `GET /svc/onchain/leaderboard` |
  | **Destructive or administrative**, deliberately not one click away. `/svc/store/evict` deletes gigabytes and defaults to `dry_run`. | `POST /svc/store/evict`, `POST /svc/mt5/import` |
  | **A DUPLICATE of a route that already has a screen.** `/svc/auto/subjects` returns byte-identical data to `ready.subjects` inside `/svc/auto/state`, which the Simulation desk renders. Wiring it would be one fact with two owners. | `GET /svc/auto/subjects` |
  | **Optional, and gated on a credential the OPERATOR supplies.** `/ai` refuses without `ANTHROPIC_API_KEY` and says so; the Analyst desk runs a built-in local analyst by design. | `POST /ai` |

  **So the "capability with no screen" column is now empty**, which is what this
  bullet existed to drive to zero. It had been the largest single source of "the
  product has functions I cannot use". Two of the sixteen came off the list by
  MEASUREMENT rather than by wiring, and that is the more valuable half: a
  duplicate route wired to a second screen would have been worse than leaving it
  alone.

  Wired across v59-v62: `/mt5/health`, `/account`, `/positions`, `/symbol`,
  `/mt5/deals`, `/svc/recon`, `/svc/risk/check|size|state|config`, `/svc/notify`,
  `/svc/telegram`, `/svc/claims/stats`, `/svc/events` + `/svc/events/summary`,
  `/svc/onchain/pairs`, `/svc/onchain/dbwallets`, `/svc/costs` (which found the
  backtester charging 3-5x this broker's real spread), `/mt5/symbols` (272
  broker symbols against a picker offering 132), and in v62.20 the seven of the
  Connections card: `/svc/mt5/status`, `/svc/router/health`, `/providers`,
  `/providers/rank`, `/svc/backup`, `/svc/kv/manifest`, `/api/stream/status`.

  The thirteen background loops in `gateway/background.py` still produce state
  most of which is not displayed; `ui/data/system.ts`, the activity card and the
  connections card are the surfaces that exist.

'''
io.open(P, "w", encoding="utf-8").write(s[:start] + new + s[end:])
print("ledger closed: 16 uncalled, 0 capability-without-screen")
