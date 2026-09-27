# The gateway

One FastAPI process in front of the whole backend.

```bash
cd server
pip install -r requirements.txt
python -m gateway                     # http://127.0.0.1:8787
IRAM_BACKGROUND=1 python -m gateway   # + the eleven service loops
```

Then `http://127.0.0.1:8787/docs` for the OpenAPI browser, and
`http://127.0.0.1:8787/api/health` for one answer to "is the backend up".

## What it serves

| Prefix | Served by | Notes |
|---|---|---|
| `/ohlc` `/quote` `/fetch` `/providers` `/health` `/ai` `/mt5/*` | `ddt_data_server.py` | unchanged, same URLs |
| `/svc/*` | `mishel_service.py` | 53 routes, SQLite, `X-Mishel-Token` auth |
| `/quant/*` | `quant/app.py` | GARCH, causal, calibrated classification |
| `/api/*` | the gateway | health, route inventory, lab |
| `/ws/bars` | the gateway | live bars, fanned out |

87 routes, one port.

## Why one process

Three services meant three CORS policies, three bind decisions, and three
chances to get the localhost guard wrong. It also meant the terminal hardcoding
`127.0.0.1:8787` for bars and `127.0.0.1:8788` for everything else, so half the
desks went dark on their own whenever one process was missing — the
`ERR_CONNECTION_REFUSED` a fresh checkout logs on first run.

**Nothing was ported.** Every legacy route runs as the same function it always
was, at the same URL, reached through a WSGI bridge that passes the path
through unchanged. The three still run standalone (`python ddt_data_server.py`
and friends) exactly as before. Porting a route to native async is now a choice
made one route at a time, with the tests already passing.

## CORS

Decided once, in `app.py`, as middleware — so it also covers the mounted Flask
apps, which routing-level policy would not.

- **`null` is allowed on purpose.** The shipped artefact is one self-contained
  `index.html` opened by double-click, and a `file://` page sends `Origin: null`.
  Leaving it out is how a backend works in dev on `:5173` and dies in the product.
- **Loopback on any port** via regex — `:8000` (`run.py`), `:5173` (Vite),
  `:4173` (`vite preview`), and whatever an operator picks. Not a wildcard: a
  page on the public internet cannot present a `localhost` origin.
- **`allow_credentials` is False**, deliberately. Turn it on and the spec
  forbids a wildcard, which is how backends end up reflecting whatever Origin
  they were sent — a policy that permits everyone while looking like a policy.
  Nothing needs it: `/svc` authenticates with a header, not a cookie.
- **The legacy apps' own CORS headers are stripped** on the way out
  (`wsgi.py: STRIPPED_HEADERS`). All three call `flask_cors.CORS(app)`, which was
  right on three ports and wrong now: two layers both setting
  `Access-Control-Allow-Origin` produce a response carrying it twice, and the
  browser's rule for that is to fail the request. It works in curl and is
  unreachable from the terminal — the worst shape a bug can have.

Add origins with `IRAM_CORS_ORIGINS=https://a.example,https://b.example`.

WebSockets are checked separately in `_origin_allowed`, because `CORSMiddleware`
does not apply to them. Refusal happens before `accept()`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `IRAM_HOST` / `IRAM_PORT` | `127.0.0.1` / `8787` | bind |
| `IRAM_BACKGROUND` | off | run the eleven `mishel_service` loops |
| `IRAM_CORS_ORIGINS` | — | extra allowed origins, comma-separated |
| `IRAM_WSGI_WORKERS` | 24 | threads allowed inside legacy Flask at once |
| `IRAM_LAB_WORKERS` | core count | concurrent lab studies |
| `IRAM_ALLOW_REMOTE` | off | required to bind off loopback |

Legacy `DDT_*`, `MISHEL_SVC_*` and `IRAM_QUANT_*` variables are still read.

## Background loops

The eleven loops (alerts, backups, ledger, whale watch, heartbeat, …) used to be
started by `mishel_service.py`'s `__main__` block, so they only ran when that
file was the process entry point. Import it — as the gateway does, as a test
does — and you got all 53 routes and none of the work behind them: alerts that
never evaluate, a dead-man's switch that never beats. They are now owned by the
application lifespan and reported in `/api/health`.

Off by default, because a gateway started to serve one backtest should not begin
polling vendors and writing to SQLite.

## Streaming

`/ws/bars?symbol=BTCUSDT&timeframe=1m`

The terminal already had a good WebSocket client (`data/stream.ts` — silence
watchdog, jittered backoff, `resynced`) and already distinguished `socket` from
`poll`. This adds the two things it could not do:

- **one vendor connection instead of one per tab** — each browser context opened
  its own socket to Binance, so four charts on BTCUSDT meant four subscriptions;
- **a socket for socketless sources** — yfinance and friends publish none, so
  those symbols polled once per tab. The gateway polls once for everyone.

Every frame still carries `transport: "stream" | "poll"`, so wrapping a poll in
a WebSocket cannot launder it into looking live.

Measured: 7 viewers across 2 symbols → 2 vendor connections. With the terminal
actually using it, a four-pane layout on one symbol reported 4 clients → 1
upstream.

**The terminal opts in.** Settings → Backend → "Live bars through the backend",
off by default: turning it on makes the chart's liveness depend on this process.
If the socket does not open, `feed.ts` falls back to the direct vendor path once
and logs why, so the cost of trying is one failed connection. Frames carrying
`transport: "poll"` set the terminal's transport to `poll` and its cadence from
`poll_every_ms` — the pipe never decides what the feed is called.

If the upstream goes quiet, the last bar stands and `age_s` grows. Nothing is
interpolated to keep the screen moving.

## The lab

`POST /api/lab/studies` fans studies across cores; `GET /api/lab/studies/{id}`
polls. `POST /api/lab/study` runs one and waits.

It runs `server/engine/lab-engine.mjs` — the **shipped TypeScript**, compiled by
`npm --prefix app run build:lab`, the same choice `alert_daemon.mjs` makes. A
Python re-implementation would be a second backtest engine, and the day the two
disagree you find out from a strategy you promoted on the server's numbers and
traded on the terminal's.

Send `bars`, or send a `symbol` and let the gateway fetch them — the browser no
longer needs the history in the tab to study it.

**The Strategy desk uses this automatically**, with no setting: it tries the
backend, falls back to running the study in the tab, and states which happened
on the verdict card (`backend · 232 ms` / `this tab · Failed to fetch`). It
sends bars rather than a symbol because it has already backfilled to the
family's warm-up and re-measured coverage against the venue calendar — work the
server cannot repeat, and without which every FX study scores ~71% and is
refused. One study is no faster on the backend; what it buys is that a ~1.7s
`confluence` sweep no longer blocks the thread drawing the chart.

Measured on 8 cores, 16 studies, 3,000 bars each: **9.4s → 3.1s (3.0×)**. Not
8×: each worker is a process with ~100 ms of startup, and sixteen of them
contend for memory bandwidth.

`provider` is named by the caller, never inferred. Each provider function in
`ddt_data_server.py` takes the *terminal's* symbol (`BTCUSD`) and translates to
its own vendor dialect (`BTCUSDT`, `BTC-USD`); guessing the vendor from a
`USDT` suffix reads the vendor's dialect to choose the vendor and passes on a
symbol the proxy rejects.

## Tests

```bash
python -m pytest tests/test_gateway.py -v
```

30 tests, covering the layer that is actually new: the WSGI bridge (path,
`REMOTE_ADDR`, header translation), the prefix dispatch, and the CORS policy in
both directions. The legacy routes are not re-tested here — they are the same
functions, and they have their own suites.
