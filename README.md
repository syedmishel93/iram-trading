# Mishel Intelligence Trading

**A transparent, glass-box trading analysis terminal.** Charting, auto-detection, an explainable confluence engine, an editable strategy tester, an intelligence lab (MCTS / MCMC / generative simulation / MC-Dropout), paper trading, a hedge desk, and a market heatmap — all in a single self-contained file, with nothing hidden.

> The whole point of DDT is that **every signal shows its reasoning**. There is no black box: indicators, detectors, strategy rules, and even the "intelligence" modules are deterministic and inspectable.

---

## Which terminal is this?

**`app/` is the product.** It builds to `app/dist/index.html`, and it is what
`run.py`, the gateway and the packaged binary serve.

**`index.html` and `src/` are v39, and they are frozen** — see
[`LEGACY.md`](LEGACY.md). Still openable at `/legacy`, not maintained, nothing
new depends on them.

```bash
cd server && pip install -r requirements.txt && python -m gateway
# then open http://127.0.0.1:8787 — terminal and backend, one port
```

---

## ⚠️ Read this first

- **This is an analysis and learning tool, not financial advice.** Nothing here is a recommendation to buy or sell anything.
- **Data is synthetic by default.** The app generates realistic mock market data so everything works offline. To use real data, configure a provider in **Settings → Data sources** (see below).
- **Backtests on synthetic data are illustrative**, meant to show the engine works — not to prove any strategy is profitable.
- A few modules are honest simplifications (market-maker hedge logic, "Kinetic Flux" as an open interpretation of a proprietary concept, generative simulator as a statistical stand-in for a deep model). These are labelled in-app.

---

## ✨ Features

**Charting & drawing**
- Candlesticks with pan/zoom, crosshair, volume, and a live legend
- Overlays: EMA/SMA, Bollinger, Supertrend, VWAP, key levels (PDH/PDL/session), support/resistance
- Smart-money detection: FVGs, order blocks, BOS/CHoCH, chart patterns, **divergence**, **inducements (IDM)**
- **TradingView-style drawing tools:** trend line, ray, horizontal line, rectangle, Fibonacci, freehand, text, and a measure tool (with undo/clear)

**Indicators**
- EMA, SMA, RSI, ATR, MACD, Bollinger, Supertrend, Stochastic, Williams %R, CCI, Awesome Oscillator, ROC, ADX, MFI, VWAP, and **Kinetic Flux** (a transparent momentum×volume oscillator)

**Glass-box confluence**
- Every module emits a signal with a direction, strength, weight, and a plain-language reason; the terminal aggregates them into one bias with a full breakdown

**Strategy tester**
- A **transparent rule engine**: each strategy shows its exact entry/exit/stop/take-profit rules, then runs them bar-by-bar producing real trades (each with the reason it entered and how it exited)
- **Visual editor** to tweak rules and re-run; **save as custom strategy**
- **Upload strategies** as `.json` or `.py` (see `docs/AI_PROMPTS.md` for the format + a copy-paste AI prompt)
- Robustness: parameter sweep and walk-forward

**Intelligence Lab**
- **MCTS Alpha Generator** — searches rule-space to discover strategies (real UCB1 tree search)
- **Generative Market Simulator** — stress-tests a strategy across many synthetic histories
- **MCMC Adaptive Sizing** — Bayesian win-rate posterior → fractional-Kelly position size
- **MC Dropout** — uncertainty band on the current read
- **Regime Classifier**, **Learned Model forecast** (your uploaded network), and an **Ensemble meta-model**

**Deep-learning model manager**
- Upload a trained model (JSON MLP or category weights); it runs **in-browser** and joins the confluence. (For real deep learning, export to ONNX / TensorFlow.js — see roadmap.)

**Trading & risk**
- Paper trading with daily-loss guardrails, a trade calculator, portfolio risk, multi-timeframe dashboard, order-flow view, screener, sessions, and a **6-strategy hedge desk**

**Market heatmap** — the whole market coloured by confluence bias; click any tile to load it.

**Sustainability** — export/import your entire workspace (custom strategies, weights, guardrails, model) as a file.

---

## 🚀 Run it

**One file, one command, one port.**

```bash
python run.py
```

Or double-click **`run.bat`** (Windows) / **`run.command`** (macOS), or run
**`./run.sh`** (Linux, macOS, Git Bash). All three are three-line wrappers whose
only job is finding Python; every decision lives in `run.py`, so the three
platforms cannot drift apart.

It opens `http://127.0.0.1:8787` — the terminal AND the whole backend, served by
one process from one port. First run installs the Python dependencies if they
are missing, and prints which of the three hosted services imported.

| flag | what it does |
| --- | --- |
| `--status` | say what is already running, start nothing |
| `--port 9000` | when 8787 is taken (an explicit port is never silently moved) |
| `--legacy` | open the frozen v39.29 terminal at `/legacy` |
| `--no-background` | without the eleven service loops (alerts, backups, ledger) |
| `--no-browser` | headless box, or a second window |
| `--build` | build the terminal first (needs Node.js) |
| `--install` | install the Python dependencies, then exit |

Running it twice is harmless: the second run finds the first, opens a browser at
it and starts nothing. Requires Python 3.12 or newer — `server/mishel_service.py`
uses backslash escapes inside f-strings, which is a `SyntaxError` before 3.12.

**There used to be nine launchers.** `run.bat`/`.sh`/`.command`,
`start_mishel.py` and its two wrappers, and four more under `server/`. Two held
real and different logic and both started the pre-consolidation layout of three
separate services on three ports — which the frontend can no longer talk to,
because `app/src/data/backend.ts` now holds one base address for all three. That
mismatch is exactly why the Quant desk read `HTTP 404` and the news bar read
"the news service is not answering on this address" while both services were up
and healthy. The full account is at the top of `run.py`.

**Live data:** open **Settings → Data sources**. Crypto pulls from
Binance's public API with no key. Forex, stocks, metals and indices come through
the gateway's own data proxy — yfinance needs no key; Twelve Data, Polygon,
Alpaca and Alpha Vantage take one if you have it. Use a **read-only**
market-data key only.

**Alerts:** the **Alerts** view is a real rule engine — price / indicator / confluence / break-of-structure conditions, evaluated live and edge-triggered, with browser notifications. It notifies only; it never places a trade.

---

## 🌍 Publish to GitHub (with a live URL)

See **`QUICKSTART.md`** for copy-paste steps. In short: push this folder to a new repo, then enable **GitHub Pages** (Settings → Pages → deploy from `main` / root). Because the app is named `index.html`, your terminal goes live at `https://<you>.github.io/<repo>/`.

---

## 🛠️ Modify it easily

The app is one file, but it's organised into clearly-labelled sections (indicators, detectors, confluence, strategy engine, intelligence lab, drawing, wiring, etc.).

**The fastest way to change anything is `docs/AI_PROMPTS.md`** — it maps the codebase and gives ready-to-copy prompts (e.g. "add an indicator", "add a strategy", "change the theme", "add a hedge strategy", "wire a real data source"). Paste a prompt + the file into any capable AI and it can make the edit safely.

**To continue developing the project later, read `docs/DEVELOPMENT.md`** — a full continuation guide: architecture, every module explained, what's real vs. simplified, validated behaviors, conventions/gotchas, and the step-by-step roadmap to the Python backend.

---

## 🧭 Roadmap — the Python build

This single-file app is the **feature-complete front-end prototype**. The production version is a modular Python system. **A first module already ships in `server/`** — a multi-provider data proxy (yfinance / Twelve Data / Alpha Vantage / Polygon / Alpaca / Binance) that the terminal consumes live:

```
ddt/
├── data/         # ✅ started: server/ddt_data_server.py — feeds, caching, websockets next
├── indicators/   # vectorised indicator library
├── detectors/    # SMC + pattern detection
├── xai/          # glass-box confluence + explanations
├── analytics/    # MCTS, MCMC, generative sim, MC-dropout, regime, ensemble
├── backtest/     # event-driven engine + robustness
├── charting/     # server-rendered / streamed charts
└── strategies/   # scalp · intraday · swing · mm · custom (JSON + Python)
```

Model serving via **ONNX Runtime / TensorFlow**, UI via Streamlit or FastAPI + React. The JSON/Python strategy format and the model schema are already forward-compatible with this build.

---

## 📄 License

MIT — see `LICENSE`. You're free to use, modify, and publish. Attribution appreciated.

---

## 🙏 Credits

Built as a research prototype for data-driven, explainable trading decision support. The trade calculator logic mirrors a personal forex/CFD workbook; the confluence philosophy follows a glass-box (XAI) approach.
