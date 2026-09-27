# UPGRADE GUIDE — Mishel Intelligence Trading

**Purpose:** hand this file (plus the repo) to yourself later or to any AI, and you can continue upgrading the terminal without re-discovering how it works. It is the *current* state of the project as of this build. Pair it with `DEVELOPMENT.md` (deeper module notes + full changelog, now through entry #16) and `AI_PROMPTS.md` (copy-paste edit prompts).

---

## 1. What this is

A transparent, **glass-box** trading-analysis terminal. One self-contained `index.html` (~2,690 lines, ~282 KB, no build step, no dependencies) plus an **optional** local data proxy in `server/`.

**Guiding principle — keep it glass-box:** every indicator, detector, signal, strategy rule, and "intelligence" module is deterministic and shows its reasoning. Preserve this when extending. Nothing is a hidden black box.

**Not financial advice; data is synthetic by default** (real data is opt-in via the providers below).

---

## 2. Run it

**Terminal (any desktop OS):** `python run.py` (or `python3 run.py`) → `http://localhost:8000`.
Double-click launchers: `run.bat` (Windows), `run.command` (macOS), `run.sh` (Linux). Or just open `index.html` (offline).
**Mobile (iPad/Android):** can't run a local server — open the file directly (offline) or host it (GitHub Pages) and open the URL. Full matrix in `HOW_TO_RUN.md`.

**Data proxy (optional, unlocks yfinance/Polygon/Alpaca/Alpha Vantage):**
```bash
cd server
./run_server.sh        # or run_server.bat ; first run installs deps
```
Serves `http://127.0.0.1:8787`. Wire it in Settings → Data sources.

---

## 3. File map

```
mishel-intelligence-trading/
├── index.html          the whole app: <style> + <body> + one <script> (starts ~line 921)
├── README.md           user-facing overview
├── DEVELOPMENT.md      deep module notes + full changelog (1–14)
├── UPGRADE_GUIDE.md    this file
├── AI_PROMPTS.md       ready-to-paste "add an indicator/strategy/theme" prompts
├── run.py              universal launcher (Win/Mac/Linux, + Android/iOS where Python exists)
├── run.command         macOS double-click launcher
├── run.sh / run.bat    Linux / Windows launchers (delegate to run.py)
├── HOW_TO_RUN.md       every-platform run guide incl. iPad/Android + hosting
├── LICENSE  .gitignore
└── server/
    ├── ddt_data_server.py    Flask data proxy (multi-provider, CORS-enabled)
    ├── requirements.txt      flask, flask-cors, requests, yfinance
    ├── run_server.sh/.bat    launchers (install + run)
    └── README.md             proxy docs
```
(The proxy file is still named `ddt_data_server.py` for stability; the product is "Mishel Intelligence Trading".)

---

## 4. Everything that's been built (feature inventory)

**Charting & drawing**
- Candles / **Heikin-Ashi / Bars / Line / Area** (`CHART_TYPE`), **layout presets** (Scalp/Swing/Clean/Full), **searchable symbol dropdown** (consensus badges), volume, **RSI/MACD indicator sub-panels** (`PANES`), **Raindrop (volume-at-price)** overlay, pan, **cursor-centered proportional wheel zoom**, crosshair, live legend, **current-price line**, theme-aware grid/axis.
- Overlays (toggle chips, `ON` set): EMA 20/50/200, Bollinger, Supertrend, S/R, FVG, Order Blocks, Liquidity, BOS/CHoCH, Chart Patterns, Divergence, Inducement (IDM), Swings HH/LL, Premium/Discount, Sessions, PDH/PDL, PD Close, PWH/PWL, Session H/L, Day Open, **AI Desk Analyst** (built-in multi-factor reasoning engine: bull/bear scorecard, level ladder, scenarios, account/journal/backtest aware; + optional agentic LLM via proxy /ai with tool-use), Volume Profile **+POC/Value Area**, **Market Profile (TPO)**, **VWAP + σ bands**, **Anchored VWAP**, **Divergence Scanner** (RSI/MACD/MFI), **Auto Trendlines**, **Auto Fib**, **Raindrop (vol-at-price)**, **Nadaraya-Watson Envelope**, **Predictive Ranges** (LuxAlgo-style). Sub-panes: RSI, MACD, MFI. Top-bar minimize + fullscreen. **Command palette (⌘/Ctrl-K)**, keyboard shortcuts, **Watchlist** (consensus badges), **News & Calendar** panel (proxy /fetch), **alerts inbox** (🔔 badge), PNG/CSV export, density/font scaling, **undo/redo** (Ctrl-Z/Y), **right-click chart context menu**, **responsive/mobile** layout, refreshed premium visual design.
- Drawing tools (**click-to-select + Delete-key removal**, hover crosshair+OHLC on multi-charts) (on-demand toolbar, pencil toggle): cursor, trend, ray, hline, **vline**, rect, fib, brush, text, measure, **arrow**, **long/short position** (entry→target with auto risk zone + R:R).
- **Bar-count control** (− / count / + ) and **candle-close countdown** (⏱, on demand).

**Analysis**
- Glass-box **confluence** engine (`buildSignals`→`confluence`, weighted by `CATW`).
- **Strategy tester** (`runStrategy`) — real rule engine, visual editor, JSON/Python upload.
- **Live strategy signal** card (evaluates the selected strategy's rules on the latest bar → BUY/SELL/FLAT).
- **Market analytics** card (trend, ADX strength, ATR% volatility, regime, RSI, distance to VWAP/PDH/PDL, order-flow pressure).
- **Backtest** with **round-trip costs**, **in-sample/out-of-sample** split, real **walk-forward**, and Monte-Carlo risk-of-ruin; **Journal edge analytics** (expectancy/payoff/avg-R by side & symbol); robustness; **Intelligence Lab** (MCTS, MCMC, generative sim, MC-dropout, regime, ensemble, uploaded MLP inference).
- **Chart patterns** (rendered as real trendlines): double top/bottom, H&S / inverse, symmetrical/ascending/descending triangles, **rising/falling wedges, ascending/descending channels, rectangle**.

**Markets & data**
- **Separate crypto and forex data routing.** Crypto: Binance direct (live WebSocket kline stream) *or* Local proxy (yfinance/binance/alpaca upstream). Forex/stocks/metals: Twelve Data / Alpha Vantage / Local proxy (yfinance/polygon/alpaca). Independent **Test-live** buttons per section.
- **Market heatmap** with a click-through **detail panel** (key stats, technical sentiment gauge, key facts; news/whale flagged as needing a live feed).
- **Live screener** (real candles via proxy) + synthetic preview.
- **Bar cache** (`BAR_CACHE`): timeframe/symbol switches repaint instantly, then refresh.
- **Multi-chart** view: 1 / 2 / 4 / 6 panels, each independent symbol+timeframe, live stream, rAF-throttled, header shows price · change% · RSI · bias, ⤢ loads a panel in the main chart.
- Alerts engine (edge-triggered, browser notifications), Multi-timeframe, Order Flow, Portfolio Risk, Trading Sessions, Trade Calculator, Hedge Desk (6 strategies).

**Account**
- **Demo Trading** (MetaTrader-style): Balance, Equity, **Margin, Free Margin, Margin Level %**, selectable **Leverage** (1:20–1:500), reset/deposit, top-bar Balance/Equity chip. Buy/Sell with SL/TP, journal, daily-loss guardrail. *Paper only — no real order execution.*

**UI**
- **Theme engine** (Midnight / Binance / TradingView / TrendSpider / Light via `applyTheme()` + top-bar picker + palette) (🌙/☀️; palette via `html[data-theme="light"]`).
- Workspace export/import (strategies, weights, guardrails, model, alerts, proxy config).

---

## 5. Core data structures & globals

- `SPECS` — instruments keyed by symbol: `{name, cls∈{forex,crypto,metal,index,stock}, px, pip, contract, dpp}`.
- `DATA` — current bar array `[{t(ms),o,h,l,c,v}]`. `CURSYM` — `{sym,cls,px,name,...}`. `TF` — active timeframe.
- `IND` — indicator library **and** cache (`_e20 _e50 _e200 _rsi _bb _st _sw _fvg _ob _sr _bos _patterns _levels _div _idm _flux _vwap`), repopulated by `recompute()`.
- `VIEW` — `{count, off}` viewport. `ON` — Set of active overlay ids. `RENDER` — screen↔chart mapping written each `draw()`.
- `MODE` (`offline|online`), data providers: `API_KEY`, `FX_PROVIDER`, `PROXY_URL`, `PROXY_PROVIDER` (forex upstream), `CRYPTO_PROVIDER` (`binance|proxy`), `CRYPTO_UPSTREAM`.
- `BAR_CACHE` — `sym|tf → bars` cache for **instant** timeframe/symbol switching (paint cached, refresh in background). Online fetch pulls up to **1000 bars**; synthetic is **600** — enough history to pan back and zoom.
- `PAPER` — demo account `{bal,start,pos[],hist[],dayRealized,lossStreak,locked,seq,maxDayLoss,leverage}`.
- `ALERTS`, `ALERT_LOG`; `MULTI`, `MULTI_LAYOUT`; `CATW` (confluence weights); `STRATS`/`USER_STRATS`; `MODEL`; `DRAWINGS`, `TOOL`.
- Colour helpers `var_bull()/var_bear()` are **memoized** (`_cbull/_cbear`); invalidate with `_cbull=_cbear=null` on theme change.

---

## 6. Function map (by subsystem) — where to edit

- **Indicators** `IND.*`: ema, sma, rsi, atr, macd, boll, supertrend, stoch, willr, cci, ao, roc, mfi, adx, flux, **vwapBands**. Add one here, return an array; wire into `recompute` cache + `draw` + `indicatorsFor` + `buildSignals` if it should feed confluence.
- **Detectors:** `swings, detectFVG, detectOB, detectSR, detectBOS, detectPatterns, keyLevels, detectDivergence, detectInducements`.
- **Confluence:** `buildSignals(d)→{S,ind}`, `confluence(S)→{score,label,...}`. New signal → `push(source,category,dv,strength,reason,weight,value)` in `buildSignals` + a `CATW` entry.
- **Strategy engine:** `indicatorsFor`, `_val/_triplet/_group`, `_stopPx/_tpPx`, `runStrategy`, `specFor`, `renderRules/renderEditor/buildSpecFromEditor`, `validateSpec`, `parsePyStrategy`. Live signal: `liveSignal`/`renderStratSignal`.
- **Chart:** `draw` (main render, writes `RENDER`), `renderOne`/`drawDrawings` (user drawings), `bx/byP/barAt/priceAt`, `requestDraw` (rAF throttle), `setBars`, wheel handler (cursor-centered zoom). Overlays are `if(ON.has('id'))…` blocks inside `draw`.
- **Data/online:** `goOnline` (routes by `CURSYM.cls` → crypto vs forex provider), `fetchKlines` (Binance REST), `fetchForex` (Twelve Data), `fetchProxy(sym,tf,limit,provider)`, `proxyQuote(sym,provider)`, `startLiveWS` (Binance kline stream), `startLiveProxy(provider)`, `startLive`/`startLiveReal`, `applyKline` (authoritative candle + rollover). `wireSettings` wires provider selects + test buttons.
- **Alerts:** `alertMetrics, evalAlerts, pollForeignAlerts, fireAlert, addAlert/toggleAlert/delAlert, renderAlerts`.
- **Multi-chart:** `renderMulti, loadMini, miniDraw, miniWS, requestMiniDraw, multiStopAll`; `MULTI_DEFAULTS`, layout buttons.
- **Heatmap:** `renderHeatmap, renderHeatDetail, heatSentiment`.
- **Demo account:** `paperOpen/paperClose/closeAll, markTo, unrealized, usedMargin/freeMargin/marginLevel, updateAcct, renderPaper, checkGuard, renderQuick`.
- **Intelligence Lab:** `runMCTS/mctsSpec/mctsReward`, `runMCMC/mcmcWinRate/kelly`, `runGen/genSynth`, `mcDropout`, `classifyRegime`, `renderEnsemble`, `featVec/mlpForward/modelBias`.
- **Analytics/status:** `renderAnalytics`, `renderStatus`, `updateCountdown`/`tfSeconds`.
- **Views routing:** the `.nav` click handler toggles `#v-<view>` and calls the matching render (`if(v==='multi')renderMulti()`, etc.). Add a view = nav button (`data-view`) + `#v-<id>` container + a render call here.

---

## 7. The data proxy (`server/ddt_data_server.py`)

Flask + flask-cors. One contract in the terminal's bar schema. Providers: `yfinance, twelvedata, alphavantage, polygon, alpaca, binance` (keyless: yfinance, binance). Endpoints: `/health`, `/providers`, `/ohlc?provider=&symbol=&interval=&limit=&key=&secret=`, `/quote?provider=&symbol=`. Keys via query param or env (`TWELVEDATA_KEY, ALPHAVANTAGE_KEY, POLYGON_KEY, ALPACA_KEY, ALPACA_SECRET`). Symbol/interval normalization is per-provider inside the file. To add a provider: write a `p_<name>(symbol, interval, limit)` returning `[{t,o,h,l,c,v}]`, register it in `PROVIDERS`, and add its option to the terminal's `dsFxProv`/`dsProxyProv`/`dsCryptoUp` selects.

---

## 8. How to extend (common recipes)

- **Add an overlay:** compute an array (in `IND` or a detector), cache it in `recompute`, add a draw block `if(ON.has('myid'))…` in `draw`, and add a chip `<div class="chip" data-ind="myid">…`.
- **Add a drawing tool:** add a `<button data-tool="x">` to `#drawbar`, a render `case` in `renderOne`, and (if drag-based) it flows through the existing mousedown/mousemove/mouseup; single-click tools handle in `mousedown` like `hline`/`vline`; add drag tools to the mouseup min-size keep list.
- **Add a chart pattern:** extend `detectPatterns` — push `{type,dir,conf,pts:[...],lines:[{a,b},...],lp,neck?}`. `lines` render as extended trendlines; `pts` as a polyline+dots; `neck` as a dashed level.
- **Add an alert field:** add to `AL_FIELDS`/`AL_EVENTS`, compute it in `alertMetrics`, and it's picklable in the Alerts UI.
- **Add a data provider:** backend `p_<name>` + `PROVIDERS`; front-end select option; routing already dispatches by class.
- **Theme:** add vars under `html[data-theme="light"]`; for canvas colours read the theme in `draw` (see `_lt/GRIDC/AXT`) and remember to `_cbull=_cbear=null` on switch.

---

## 9. Testing convention (used throughout)

After any script edit, keep `index.html` a single valid file and verify the `<script>` parses:
```bash
python3 -c "import re;s=re.findall(r'<script(?![^>]*src=)[^>]*>(.*?)</script>',open('index.html').read(),re.S)[0];open('/tmp/app.js','w').write(s)"
node --check /tmp/app.js
```
For logic, a **headless-DOM harness** stubs `document/window/canvas/fetch/WebSocket/Notification/AudioContext`, appends the extracted script, then calls the real functions (e.g. `applyKline`, `alertMetrics`, `detectPatterns`, `usedMargin`) against `genData(...)` and asserts finite/in-range/no-throw. Backend: `python -m py_compile` + Flask `test_client()` for routes. Sandboxes can't reach live market domains, so live fetches are validated by URL/shape, not real data.

---

## 10. Honest simplifications (keep labelling these)

- Data synthetic by default; real data needs a provider/proxy.
- Demo trading is **paper only** — no real order execution (a trade-enabled key in a browser is unsafe; real execution belongs server-side with confirmation guards).
- Market-maker hedge strategies & the MM family are simplified models.
- Kinetic Flux is an open interpretation, not a proprietary copy.
- Generative simulator is a statistical stand-in for a deep generative model.
- Backtest robustness sweep is illustrative.
- `4h` isn't native on yfinance/Alpha Vantage (proxy falls back to hourly).
- News, social sentiment, real liquidity depth, and whale/on-chain flow need external live feeds — **not synthesized**.

---

## 11. Suggested next steps

- **Aladdin-style portfolio analytics:** multi-position VaR/CVaR, correlation matrix, factor/beta exposure, scenario stress (builds on the Portfolio Risk view + Intelligence Lab).
- **Sub-panel indicators** (RSI/MACD/volume panes below price).
- **Click-to-select-and-delete** individual drawings (currently undo/clear only).
- **Real feeds via the proxy:** news API, Whale Alert / on-chain, funding & open interest for crypto.
- **Compare overlay** (plot a second symbol on the main chart).
- The full modular Python backend (see `DEVELOPMENT.md` §7) — the proxy is its first module.

---

*To continue: read this + `DEVELOPMENT.md`, open `index.html`, make edits, then run the parse check + headless harness. When wiring live data, run the `server/` proxy. Keep everything glass-box.*
