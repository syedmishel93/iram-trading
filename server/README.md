# Mishel data proxy (`server/`)

An optional local server that gives the terminal real market data from free /
freemium APIs a browser can't reach directly (yfinance, Polygon, Alpaca have no
CORS or browser SDK). It's the first piece of the `data/` layer from
`../docs/DEVELOPMENT.md` §7 — everything else in the terminal still runs with no backend.

It exposes one CORS-enabled contract in the terminal's own bar format, so the
front-end doesn't care which upstream served the data.

## Run

**You almost certainly do not need to start this by itself.** `python run.py` at
the repository root starts `server/gateway`, which hosts this proxy, the store
service and the model service in ONE process on ONE port:

```bash
python run.py                        # from the repository root
```

The four launchers that used to live in this folder — `run_server.sh`,
`run_server.bat`, `run_service.sh`, `run_service.bat` — are gone, and their
removal is the point rather than a tidy-up. They started this file on :8787 and
`mishel_service.py` on :8788, and the terminal can no longer talk to that layout:
`app/src/data/backend.ts` holds one base address for all three services, so a
terminal pointed at :8787 asks the DATA PROXY for `/svc/*` and `/quant/*` and
gets its Flask HTML 404 page back. See the header of `run.py`.

Standalone still works, and is the right thing for a systemd unit or a debugging
session on one service:

```bash
pip install -r requirements.txt

python -m gateway            # everything, one port          (127.0.0.1:8787)
python ddt_data_server.py    # this proxy alone               (127.0.0.1:8787)
python mishel_service.py     # the store and its loops alone  (127.0.0.1:8788)
python -m quant.app          # the model service alone        (127.0.0.1:8789)
```

The gateway reads `IRAM_HOST` / `IRAM_PORT`, and still honours the old
`DDT_HOST` / `DDT_PORT` so an existing `.env` keeps working.

## Wire it into the terminal

**Nothing to wire when the gateway serves the page.** It injects a
`meta name="iram-backend" content="same-origin"` tag, so the terminal knows the
page it came from IS the backend — the address cannot be wrong, and every
request is same-origin so nothing preflights.

Only for a standalone proxy on a different host or port, **Settings → Data
sources**:
1. Proxy URL → where you started it
2. Proxy upstream → pick a provider (yfinance & Binance need no key)
3. **Test live pull**, then flip the top-bar toggle to **Online**

## Providers & keys

`yfinance`, `twelvedata`, `alphavantage`, `polygon`, `alpaca`, `binance`.
Keyless: yfinance, binance. Others read a key from the terminal's API-key box,
from the `?key=` query param, or from environment variables:

```
TWELVEDATA_KEY  ALPHAVANTAGE_KEY  POLYGON_KEY  ALPACA_KEY  ALPACA_SECRET
```

Use **read-only market-data keys only** — never a trade/withdraw key.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /health` | liveness check |
| `GET /providers` | list providers + which are keyless |
| `GET /ohlc?provider=&symbol=&interval=&limit=&key=&secret=` | candles → `{bars:[{t,o,h,l,c,v}]}` |
| `GET /quote?provider=&symbol=` | latest price → `{price,t}` |
| `GET /fetch?url=` | personal-use passthrough for news/calendar/order-flow endpoints (avoids CORS) — only wire URLs you trust |
| `POST /ai` | AI Desk Analyst LLM — agentic tool-use `{system,messages,tools}`→`{stop_reason,content}`, or legacy `{question,context}`→`{text}` |

`interval` uses the terminal's canonical codes (`1m 5m 15m 30m 1h 4h 1d 1w 1M`).
Note: `4h` isn't native on yfinance / Alpha Vantage, so those two fall back to
hourly; Twelve Data, Polygon, Alpaca, and Binance serve `4h` natively.


## Optional: AI Desk Analyst (LLM)

The terminal's **AI Analyst** works offline with a built-in glass-box engine. To upgrade it to a real LLM, set an Anthropic key on the proxy before starting it:

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # and optionally AI_MODEL=claude-3-5-haiku-latest
python ddt_data_server.py
```
Then in the AI Analyst view, tick **Use LLM via proxy**. The model runs as an **agent**: it calls the terminal's real functions (analysis, account risk, journal, backtest, sizing) and grounds answers in your actual numbers. Use a capable model (default `claude-3-5-sonnet-latest`) for tool-use; override with `AI_MODEL`. The key stays server-side; the browser only sends the question + chart context.

## Background service (NEW)
`server/mishel_service.py` — persistent companion (port 8788, SQLite): 24/7 server-side alert loop firing Telegram with the browser closed, and server-side ledger resolution. Started for you by `python run.py` — its eleven loops run inside the gateway under `IRAM_BACKGROUND=1`, which the launcher sets (pass `--no-background` to skip them). **Those loops had stopped running:** they were started by this file's `__main__` block, so importing it under the gateway gave all fifty-three routes and none of the work behind them, and no launcher set the flag. `gateway/background.py` owns them now and `/api/health` reports which ones are turning. For a headless box, systemd via `mishel-service.service`. Configure Telegram once: `POST /svc/telegram {token, chat}`. Honest by design: no data → no evaluation, never a synthetic price.
