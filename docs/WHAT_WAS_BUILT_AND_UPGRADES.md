# Mishel Intelligence Trading — Build Handoff & Upgrade Roadmap
**Current build: v9.0** (the version is stamped on the loading splash, in the chart header "MISHEL · v9.0", and in the browser tab title — always verify this first).

Paste this file into a new conversation to continue development seamlessly.

---

## 1. What this is
A **glass-box trading analysis terminal** in a single `index.html` (no build step, no frameworks) plus an optional Python proxy (`server/ddt_data_server.py`) for live data and the LLM agent. Guiding principles: every signal shows its reasoning; **no fabricated data** (news/order-flow/derivatives are fetched live or honestly absent); everything deterministic is tested headlessly before shipping. Not financial advice; demo trading only.

## 2. How to run (professional startup, v9.0)
- **One command:** `python run.py` → serves the app on `http://localhost:8000`, **auto-starts the data proxy** on `:8899`, and opens the browser. (`run.bat` / `run.sh` / `run.command` wrap it per-OS.)
- In Settings → Workspace, tick **"Remember my setup"** — then theme, layout, symbol, drawings, demo account, alerts **and Online mode auto-resume** on every launch (it reconnects live data by itself).
- Without Python: double-click `index.html` (offline synthetic mode; crypto live data often still works directly from Binance).

## 3. Architecture (single file + proxy)
- `index.html` — all UI, chart engine (canvas), indicator engine, consensus/AI, demo account (~9k lines).
- `server/ddt_data_server.py` — Flask proxy: `/ohlc` `/quote` (yfinance/TwelveData/AlphaVantage/Polygon/Alpaca/Binance), `/fetch` (CORS passthrough for news/derivatives), `/ai` (Anthropic agentic endpoint; set `ANTHROPIC_API_KEY`).
- Docs: `README.md`, `DEVELOPMENT.md` (**full changelog #1–#41**), `UPGRADE_GUIDE.md` (function map), `HOW_TO_RUN.md`, `AI_PROMPTS.md`.

Key globals/functions (for the next developer/AI):
`SPECS` (all symbols incl. `cls:'cryptofut'` perps) · `DATA/CURSYM/TF/VIEW` · `draw()` (chart) · `recompute()` (indicator cache `IND._*`) · `consensusSignal(d,acc)` (20+ indicator fusion, −100..+100 + confidence) · `indicatorAccuracy(d)` (per-indicator forward hit-rates, cached, idle-computed) · `annealCategoryWeights(d)` (simulated annealing) · `deskAnalyst(q)` (offline analyst intents) · `AI_TOOLS/runAgent` (LLM agent tools incl. `get_portfolio_risk`) · `portfolioRisk()` (VaR/CVaR/heat/correlations over real demo positions) · `planTrade(side)` (trade planner + futures liquidation) · `runScan()` (watchlist setup scanner) · `PAPER` (demo account, leverage) · `persistSave/persistRestore` · `runSelfTest()` (13 in-app checks) · `applyTheme/applyLayout` · `startInertia/animBars` (chart physics).

## 4. Everything built so far (by area)
**Charting:** candles/Heikin-Ashi/bars/line/area · 30+ overlay indicators in a categorized dropdown (Trend/Levels/Smart-Money/Signals/Volume&Profile) · RSI/MACD/MFI sub-panes + collapsible volume, each with on-canvas × close · drawing tools with undo/redo (Ctrl-Z/Y), right-click context menu, select/delete · auto trendlines, auto-fib, anchored VWAP, Nadaraya, predictive ranges, volume/market profile, SMC (FVG/OB/liquidity/BOS/inducements), divergence scanner · crosshair with price+time axis tags · **inertial pan + eased zoom** · dblclick reset, arrows pan, +/- zoom · multi-chart 1/2/4/6 grid.
**Analysis/AI:** 20+ indicator **consensus** with % agreement, **accuracy-tuned** to each instrument's measured hit-rates; robust stats (median/MAD/winsorize) filter outliers; objectivity **checklist** (5 bias gates); regime classifier; **offline desk analyst** (bias/why/levels/targets/risk/setup/MTF/session/accuracy/quantum/portfolio-risk intents, TTS 🔊 + mic 🎤, chat Clear); **LLM agent** via proxy with 8 tools + chart-image vision + session memory; quantum-inspired annealing optimizer (honest labeling); XAI scorecard (weight + hit% per factor).
**Trading tools:** demo account with leverage (futures liq-price warnings), Trade Planner (entry/stop/TP-ladder/lots/R:R/checklist → execute), position sizer (lots-aware), Risk view with **VaR/CVaR/correlations/heat over real positions**, journal analytics, alerts (price/RSI/consensus) with 🔔 inbox, backtester (5 strategies, costs, equity/drawdown, Monte Carlo), watchlist with consensus badges + **setup scanner**, screener, heatmap, sessions map, hedge calculator, Derivatives card (**live Binance OI/funding**), News & Economic Calendar view (free sources listed, proxy-fetched).
**Markets:** FX majors/crosses, **26+ crypto spot**, **10 crypto perpetual futures** (fapi/fstream live), metals, indices, stocks; generic Binance mapping; per-class symbol dropdown filters (v9.0).
**Platform/UX:** 5 themes (Midnight/Binance/TradingView/TrendSpider/Light) with glassmorphism layer · command palette ⌘K · keyboard shortcuts + `?` help · onboarding tour · layout presets + save-your-own · opt-in persistence + **auto-resume online** · splash with version stamp · error boundary + self-test panel · labeled nav rail, instrument header (big live price + consensus chip), decluttered top bar with ⋯ menu, mobile slide-over analysis drawer · PNG/CSV export · density scaling.

## 5. Verified-testing convention (keep this!)
Every change: extract JS → `node --check`; run headless tests with the DOM-stub harness (assert on logic, not DOM); `python3 -m py_compile` the proxy; repackage zip + standalone `index.html`; bump `APP_VER` so stale files are instantly detectable.

## 6. Known limitations (honest)
- Offline data is synthetic (labeled); accuracy/backtests on it are illustrative. Live = real.
- Liquidation estimate uses simplified isolated-margin (0.5% MMR).
- No L2/tick/footprint (needs paid feed) · options analytics not built yet.
- SpeechRecognition (mic) is Chrome/Edge only. Annealer/accuracy are in-sample measures.
- localStorage persistence requires a non-locked-down browser profile.

## 7. Upgrade roadmap (prioritized — pick and continue)
1. **Confidence calibration** — audit consensus confidence vs actual outcomes; calibration curve.
2. **Proactive analyst** — pushes alerts: consensus flips, fresh divergence, heat breach, funding extremes.
3. **Scenario stress lab** — shock the book ("BTC −10%, DXY +2%"), factor/beta decomposition, Kelly/risk-of-ruin.
4. **Walk-forward optimizer** — OOS-guarded parameter search; strategy-from-consensus; sensitivity heatmaps.
5. **Drawing editor v2** — drag-to-move/resize, magnet snap, per-drawing styles.
6. **Compare/spread overlay**, Renko/Kagi, per-indicator settings gears.
7. **Web Worker offload** (accuracy/anneal/Monte-Carlo off-thread) + data-health layer (gap/stale detection, WS backoff-reconnect UI).
8. **Notification center**, PDF session report, PWA/desktop (Tauri) packaging, proxy hardening (auth/rate-limit/allowlist).
9. **Options analytics** via Deribit public API (IV, Greeks, chains) — the real "crypto options" module.
10. Trade-replay trainer, daily AI briefing, natural-language alert/strategy builder, multi-symbol agent reasoning.

## 8. Continuation prompt for a new thread
> "Continue developing Mishel Intelligence Trading from the attached zip. Read WHAT_WAS_BUILT_AND_UPGRADES.md and DEVELOPMENT.md first. Keep the glass-box/no-fake-data principles, keep the headless testing convention, bump APP_VER on every build, and implement roadmap item(s) N."
