# DEVELOPMENT.md — Mishel Intelligence Trading — continuation guide

## v38.0 — HOTFIX + THE LAST FABRICATED NUMBERS

### HOTFIX: the freshness contract was only honoured by 2 of 4 feeds
`Fresh.state()` returns `offline` unless `window._realFeed` is set — and it was set in
`startLiveProxy` and `startLiveForex` only. The two **crypto** tick sinks (`applyKline`
over websocket, `startLiveReal` over REST) updated `CURSYM.px` and stopped. So on a
perfectly live Binance feed, `Fresh` concluded there was no real feed, and per the v35
gate that **silently killed the Decision Bar and the MT5 ticket for all of crypto.**

1,303 assertions missed it because they tested that *the contract exists*, not that
*every feed honours it*. The fix pins the invariant instead: **every path that writes
`CURSYM.px` must stamp `_lastTick` + `_realFeed`.** A contract only some feeds honour is
not a contract.

Also fixed: `\u2696` / `\ud83d\udee1` were written as **JS escape syntax inside raw HTML**,
where nothing decodes them — the ⚖ and 🛡 buttons rendered as literal text. And the
bar-completeness readout ("Data 100%") was renamed **Integrity**, because it collided with
the freshness chip ("Data OFFLINE") in the same status bar.

### ARC A — the ★ picker stops lying
`sigBestWF` scans 26 strategies and promotes the best. That is a **search**, and a search
through noise always finds a hero. Nothing deflated the result for 26 trials. The PBO
(CSCV) and Deflated-Sharpe machinery has been in this codebase since **v13**, wired only
to a backtest panel nobody opens.

It is now wired to the thing that tells him what to trade — **and it can say NO.** A pick
that fails the audit is **WITHHELD**, with the reason shown where the star used to be.

Proven functionally, not just structurally (`test_v380_gate.js`): given 26 pure-noise
strategies, the best has a Sharpe of **0.086** — while E[max] under the null across 26
tries is **0.082**. The entire "edge" is 0.004. PBO 56%, DSR 53% → **withheld**. Given a
genuine edge hidden among 25 noise strategies, DSR **100%** → **promoted**. It
discriminates; a gate that refuses everything is not a gate.

### ARC B — real per-instrument costs
`const costR = Math.min(0.15, (spr || entry*0.0002)/R)` — a flat **2bps for every
instrument**, commission and swap ignored **entirely**, and an arbitrary 0.15R cap. Every
net-R, every OOS win-rate and every ★ pick for 37 versions was costed against a market
that does not exist.

Now: **broker tick > broker spec > live book > LABELLED assumption.** Commission is derived
from **his own fills** (not modelled), swap is applied per night held, and the cap is gone —
if a trade really costs 0.4R, the system must be able to say so. An assumption is still
allowed; an *unlabelled* one is not, so a **Costs REAL / Costs ASSUMED** chip sits in the
status bar.

### ARC C — n and a confidence interval, or it is not a measurement
The Signal Accuracy panel printed *"Bollinger 59%, Supertrend 51%, CMF 50%, Aroon 49%"* —
no sample size, no interval, **sorted best-first**. Sorting a noisy statistic descending and
showing the top of it *is* selection bias, rendered as a UI. Every row now carries **n** and
its **Wilson 95% interval**; anything whose interval straddles 50% is greyed and labelled a
**coin flip**; and if nothing is significant, it says so rather than inviting him to pick the
biggest number.

### ARC D — the pre-market ritual (☀)
Five checks, in order, before London: is the tape real? what is it costing? did any strategy
survive the audit? what does the risk governor say? what did your execution actually do last
month? It ends in a **verdict** — DO NOT TRADE YET / PROCEED WITH YOUR EYES OPEN / CLEAR TO
TRADE YOUR PLAN — and even the all-clear refuses to overclaim: *"it only means nothing KNOWN
is wrong."*

### Found while building (reported, not buried)
- **`build.py` silently dropped two new source modules.** It is manifest-driven, not
  glob-driven, so a new `src/js/*.js` file is simply ignored — **and the build still printed
  "released".** I only caught it by grepping the output for my own function names. `build.py`
  now **HARD-FAILS** on any source file not listed in the manifest. A build that silently
  drops source is worse than one that crashes.

Suite: **71 files · 1,352 assertions · 0 failures.** Identity proven. Verify green.



## v37.0 — THE RISK GOVERNOR (account-level risk, and a 1000x sizing bug)

Risk was per-trade and nothing else. "1% per trade" is not a risk system; it is a sentence.
Nothing in 36 versions knew how much you had lost today, how much risk was already open, or
that **long EURUSD + short USDCHF + long AUDUSD is not three 1% bets — it is ONE 3% bet on
the dollar falling.** Correlation does not care that you opened them in different windows.

### Correlation as arithmetic, not a model
`server/mishel_risk.py` decomposes every position into **currency legs**. Long EURUSD *is* a
long EUR and a short USD — definitionally, forever. No hard-coded correlation matrix, no
rolling window that changes its mind every Tuesday. The governor sums the real bet and names
it: *"THIS IS ONE BET, NOT 3. Your net USD exposure would be 3.00R SHORT across EURUSD,
USDCHF, AUDUSD."*

### The rules (his numbers, not ours — all editable, persisted to SQLite)
- **daily loss** — *"DAY IS DONE: -2.10R realized. The next trade is not a setup, it is a refund request."*
- **open risk cap** — total live R, across every position
- **currency concentration** — the single biggest one-currency bet
- **loss-streak cooldown** — *"3 losses in a row. Cooldown active — 50 min left. Revenge trading is the only strategy with a proven negative expectancy."*
- **trades/day** — *"past this point you are not trading, you are clicking."*
- **unprotected positions** — an open position with **no stop loss** blocks everything else before it is even considered. *"An unprotected position is not a trade. It is an open-ended bet on your own attention."*

State is computed from **reconciled real fills** (v36), not `PAPER.bal`. This is his risk, not the demo's.

### Enforcement, and its honest limit
The governor cannot stop him clicking Buy in MT5, and it must not try — nothing here
auto-executes. What it does is **refuse to build the order ticket**, the same enforcement
point the freshness contract uses. The alert says so explicitly: *"Nothing is stopping you
placing this by hand in MT5. This terminal just will not hand you the ticket."* The last
human step stays human; the system declines to make a bad trade convenient.

### THE 1000x SIZING BUG (found, fixed, pinned)
The shipped order ticket converted lots with `units/100000` for anything matching
`/EUR|GBP|JPY|XAU/`. **XAUUSD's contract is 100 OUNCES, not 100,000.** Gold was sized
**1000x too small**, silently, since v1. A $100 risk on a $10 stop should be 0.10 lots; the
ticket said 0.0001.

Sizing now comes from the broker's **real contract spec** via `/svc/risk/size`. With no spec
it prints **NOT SIZED** and refuses — a guessed contract size is not a smaller error than a
missing one, it is a bigger one, because you will actually trade it. The dead code path
containing the old conversion has been deleted outright.

### BLIND IS NOT CLEAR
A governor that reports all-clear over a book it cannot read manufactures confidence it has
not earned. So: bridge unreachable → open positions are **UNKNOWN, not zero** → verdict is
**WARN, never ALLOW**, and the words *"this is a blind spot, not an all-clear"* appear. A
position whose contract spec is missing has an **UNKNOWN** R and says it is not being counted.

### Found while building (reported, not buried)
- **The IEEE754 lot-step trap.** `1.1000 - 1.0950 == 0.005000000000000115`, so `lots_exact`
  came out as `0.19999999999999538` and a naive floor turned a correct **0.20 into 0.19**. A
  rounding rule that is wrong on every round number is not a rounding rule. Pinned as test PS8b.
- **`compute_state` silently dropped the `risk_unknown` flag** when rebuilding positions, so
  the "risk UNKNOWN" warning could never fire from the real service path. Caught by a test
  that asserted the *behaviour*, not the code.
- **I pinned `SCHEMA_V == 3` in the v36 tests** — the exact mistake I flagged one build ago
  after pinning `APP_VER` and `SCHEMA_V == 2`. Third time. The whole suite has now been swept:
  no exact version or schema pins remain anywhere.

Suite: **69 files · 1,303 assertions · 0 failures.** Identity proven. Verify green.



## v36.0 — THE BROKER IS THE SOURCE OF TRUTH (MT5 + execution reconciliation)

Two structural defects closed. Both were invisible because nothing was measuring them.

### Defect 1 — you analysed one price series and traded a different one
Bars came from yfinance (~15m delayed), Twelve Data or Binance. Your fills come from
YOUR MT5 broker — its own server time, its own spread profile, its own daily close.
Every ATR, swing stop, prev-day level, ORB and "OOS win%" was therefore computed on
prices you would never be filled at. For crypto that is a rounding error. For XAUUSD
and EURUSD it is a different market.

`server/mt5_bridge.py` makes the broker a first-class provider (`/ohlc?provider=mt5`),
ranked **above every vendor** for fx/metals/stocks. The feed chip gains a third tier —
`REAL · BROKER` — because there are three classes of truth and only one of them is the
price you actually get. Symbol resolution handles broker renaming (EURUSD.a, GOLD,
EURUSDm) and returns **None** rather than guessing a name the broker never reported.
The bridge is Windows-only (that is MetaTrader5's constraint, not ours); it imports
cleanly everywhere and reports `available: false` with the exact reason.

The live broker **spread** now feeds `_oflow.spread`, which is what every signal's costR
reads. This retires the hard-coded `0.0002` that 26 strategies have used for 34 versions.
Gold's spread at rollover is nothing like EURUSD's at midday, and now the system knows it.

### Defect 2 — "your edge" was the DEMO account's edge
`get_journal_stats` read `PAPER.hist`. The decision journal logged what the SYSTEM would
have done. **Nothing in this terminal knew what actually filled** — at what price, with
what slippage, what spread, or whether the stop was honoured. For a discretionary trader
who executes by hand in MT5, the entire edge lives in that gap, and it had zero
instrumentation.

`server/mishel_recon.py` is the instrument. Per trade: **slippage_R** (against the entry
you wrote down), **cost_R** (the broker's own commission + swap, never modelled),
**gross_R → net_R**, **MFE/MAE**, **mfe_capture**, and **exit_reason** — including
`beyond_stop`, which is what a widened stop actually looks like in the data. In aggregate
it names the leaks in plain language: *"Execution costs you 0.12R per trade"*,
*"You capture only 40% of the move your trades hand you — that is an EXIT problem, and no
new strategy will fix it"*, *"You hold losers 2.6x longer than winners"*, *"1 trade exited
BEYOND the planned stop"*. The headline case is explicit: **gross positive, net negative →
"YOUR SETUPS WORK; YOUR EXECUTION DOES NOT."**

`server/mt5_report.py` means you do not have to wait for the Windows bridge: export
**MT5 → Toolbox → History → right-click → Report (HTML)** and drop the file into the ⚖
panel. Import is idempotent by MT5's own deal ticket (primary key, not discipline), so
re-importing the same report ten times still yields one copy of each deal.

The plans are read **from SQLite** — the direct payoff of v35's durable state. The server
can now grade you against intentions you typed into a browser weeks ago.

### Honesty enforced in the numbers
- Anything not derivable is `None`, rendered as `—`, and the footer says **"a dash means
  not measurable, not zero."** A missing measurement is not a free trade.
- Money→R conversion prefers the broker's real contract spec; falls back to inferring from
  the trade's own P/L; and returns **None** when the price move was too small for inference
  to be stable — rather than a number it does not believe.
- Plan matching never crosses symbols, never matches a plan written *after* the fill
  ("that is not a plan, it is a story"), and reports unmatched trades as UNPLANNED instead
  of force-fitting.
- MFE/MAE reports **which bar series it used** (broker-exact vs vendor), so a capture% off
  vendor bars is never passed off as broker-exact.
- Fewer than 5 trades → it refuses to draw conclusions and says the sample is too small.
- Empty state names the problem — *"Your real edge is currently unmeasured"* — instead of
  rendering a dashboard of zeroes.

### Found while building (reported, not buried)
- `not trade["open_ms"]` was `True` for a valid timestamp of **0** — the falsy-zero trap.
  Guard timestamps/prices/volumes with `is None`, never truthiness. Caught by a
  known-answer test, not by reading the code.
- The v35 tests pinned `SCHEMA_V == 2` exactly, so an additive migration reddened a green
  suite. Same class of bug as the pinned `APP_VER`. **Schema and version asserts must be
  `>=`.**
- MT5's HTML report has **no position_id**, so `pair_positions()` reconstructs it FIFO.
  On a hedging account with two simultaneous positions in one symbol this can mis-assign a
  pair — documented in the code, and the bridge (which returns the real position_id) has no
  such ambiguity.

Suite: **66 files · 1,204 assertions · 0 failures.** Identity proven. Verify green.



## v35.0 — OPERATIONAL SPINE (the tab stops being the app)

The critique that triggered this build: *"the runtime is a browser tab; refresh, sleep or
crash it and your alerts die silently."* Four fixes, in dependency order.

**A · Clock — one governed scheduler.** `setInterval` is wrapped, so all 57 existing call
sites enrolled with **zero call-site edits**. One 250ms native driver replaces 57 timers.
Every job is try-guarded (one job dies, the other 56 keep running, and the failure is
*recorded*, not swallowed). On tab wake every due job runs **immediately** — catch-up, not
stale-then-eventually. Click the **Jobs** chip for the X-ray: name · interval · runs · errors.

**A · Freshness contract — the gate.** `Fresh` separates two clocks that were being
conflated: **tick age** (is the feed alive?) and **vendor lag** (yfinance is ~15m behind).
A delayed feed is never labelled plain "LIVE". Past threshold the Decision Bar refuses to
print a verdict (`⛔ no decision on a dead tape`) and **the MT5 ticket refuses to build**.
Rationale: Chrome throttles background-tab timers to ≥60s, and you are always in MT5, so
the terminal is always a background tab. It used to keep saying LIVE over a minute-old
price. That is not fragility — it is a wrong number at the moment of decision.

**B · Always-on signals + dead-man's switch.** New `sig_loop` in `mishel_service.py`
evaluates armed strategies every 60s **with the browser closed**. It does *not* re-implement
the 26 strategies in Python — that would be two sources of truth, and the day they disagree
you find out on a live trade. Instead `server/sig_worker.js` extracts `sigScan`/`sigStats`/
`SIG_DETECT` **verbatim out of index.html** (the same technique the test suite has used for
34 versions) and runs them in Node. One source of truth, zero drift.
Dedup is *structural*: `bar_t` is in `sig_fired`'s PRIMARY KEY, so a bar can fire once, ever
— across restarts and crashes. `heartbeat_loop` sends an alive message every 4h; **absence
of that message is the alarm**, because silence used to be indistinguishable from "no setups
today". 🔔 now arms the strategy *on the service*, and says so plainly when it cannot.

**C · Durable state.** The 15 irreplaceable keys (journal, armed strategies, drawings,
wallet DB…) mirror to SQLite via `/svc/kv` with monotonic revisions; localStorage is now a
cache. Cosmetics (theme, pane heights, ~42 keys) stay local — those *should* be per-device.
On failure the Sync chip says **UNSYNCED** and requeues; it never pretends a write landed.
Closing tab flushes via `sendBeacon`. A wiped Chrome profile is now a non-event.

**D · Source layout + build step.** `tools/split.py` carves index.html into **60 JS modules**
+ head/tail, and `tools/build.py` reassembles them — asserting the output is **byte-identical
(sha256) to the source**. A refactor that cannot change the shipped bytes cannot introduce a
bug. This retires the tax paid on every one of the last 34 builds: the triple manual version
bump (now injected from `src/VERSION`, one place), exact-string atomic patching (now ordinary
file edits), the WSRC string-literal extraction, and "syntax error at line 7,412" (now
`node --check` per 200-line module).

**Found while building (reported, not buried):**
- The suite **stubs `IND.adx`** (`d.map(()=>ADXV)`), so the *shipped* ADX had never been
  exercised by the signal tests. `sig_worker.js` runs the real one and hard-fails without it.
- `sigScan`'s detect loop is `for(let i=60; i<d.length-1; i++)` — it **never scans the final
  bar**. A live alert on the newest closed bar is only reachable if a real bar sits behind it,
  so `sig_loop` passes the still-forming bar as a *positional tail* (never scanned for a
  signal; used only to invalidate a setup whose stop already ran intrabar).
- A loose version regex also matched the CSS comment `INTERFACE REBUILD v5`. The `count==3`
  assert caught it. A blind sed bump would have corrupted the file silently.
- `tests/test_v241_fixes.js` was **already red and is not registered in `run_tests.sh`** —
  pre-existing, unrelated to this build. Left as found, flagged here.

Suite: **63 files · 1,097 assertions · 0 failures.** Boot audit 0 errors. Identity proven.



This is the single source of truth for continuing the project. Hand this file + the repo (or the zip) to yourself later, or to any AI, and you can pick up exactly where things stand. Pair it with `AI_PROMPTS.md` (copy-paste edit prompts) and `README.md` (user-facing overview).

- **What the project is:** a transparent, glass-box trading-analysis terminal.
- **What exists today:** a single self-contained `index.html` (~229 KB, ~2,100 lines) that is feature-complete as a front-end prototype. No build step, no dependencies.
- **Guiding principle:** *nothing is a black box.* Every indicator, detector, signal, strategy rule, and "intelligence" module is deterministic and shows its reasoning. Preserve this when extending.

---

## 1. Current status at a glance

| Area | State |
|---|---|
| Charting, overlays, drawing tools | ✅ complete |
| Indicator library (17) | ✅ complete, validated |
| Detectors (SMC, patterns, divergence, inducements) | ✅ complete |
| Glass-box confluence + weights | ✅ complete |
| Transparent strategy engine + visual editor | ✅ complete, validated |
| Strategy upload (JSON + Python) | ✅ complete, parser tested |
| Backtest + robustness (sweep, walk-forward) | ✅ complete |
| Intelligence Lab (MCTS, MCMC, generative, MC-dropout, regime, ensemble) | ✅ complete, algorithms tested |
| Deep-learning model upload + in-browser inference | ✅ complete, tested |
| Market heatmap | ✅ complete |
| Paper trading + guardrails | ✅ complete |
| Hedge desk (6 strategies) | ✅ complete |
| Trade calculator | ✅ complete (mirrors a real workbook) |
| MTF, order flow, portfolio risk, screener, sessions | ✅ functional |
| Alerts | ✅ real engine — rule-based, edge-triggered, browser notifications |
| Live data (Binance crypto) | ✅ **real-time WebSocket kline stream** (data-api.binance.vision REST seed + ws ticks) |
| **Live data via local proxy** (yfinance · Polygon · Alpaca · Alpha Vantage) | ✅ `server/ddt_data_server.py` |
| Live screener (real candles via proxy) | ✅ scan button in the Scanner view |
| Workspace export/import | ✅ complete (now incl. alerts + proxy config) |
| **Python production backend** | 🚧 started — data proxy shipped (`server/`); rest per §7 roadmap |

---

## 2. File structure

The app is one file: `index.html`. Layout:
- `<style>` — all CSS. Theme via `:root` variables.
- `<body>` — top bar, left nav rail (`.nav[data-view=...]`), main area with one `#v-<view>` container per view, right side panel, status bar.
- `<script>` — one script, organised into labelled sections (see §4).

Repo files: `index.html`, `README.md`, `QUICKSTART.md`, `AI_PROMPTS.md`, `DEVELOPMENT.md` (this), `run.sh`, `run.bat`, `LICENSE`, `.gitignore`.

The optional backend lives in **`server/`**: `ddt_data_server.py` (the data proxy), `requirements.txt`, `run_server.sh`, `run_server.bat`, and its own `README.md`. The terminal runs fine without it; the proxy just unlocks the data providers a browser can't call directly.

---

## 3. Core data structures & globals

- **`SPECS`** — object of ~28 instruments keyed by symbol: `{name, cls, px, pip, contract, dpp}` where `cls ∈ {forex,crypto,metal,index,stock}`. Drives the symbol list, calculator, and heatmap.
- **`genData(n, start, seed)`** — seeded synthetic OHLCV generator (`mulberry32` PRNG + regime switching + volatility clustering). Returns `[{t,o,h,l,c,v}]`.
- **`DATA`** — current bar array (synthetic, CSV, or live).
- **`CURSYM`** — `{sym, cls, px, name, ...}` current instrument.
- **`IND`** — indicator library **and** a cache of last-computed arrays (`IND._e20, _e50, _e200, _rsi, _div, _idm, _flux, _patterns, _levels, _sr, _bos`). Populated by `recompute()`.
- **`CATW`** — confluence category weights: `{trend, momentum, oscillator, volatility, smc, pattern, divergence, flux, model, volume}`.
- **`STRATS`** — built-in strategies by style: `{scalp, intraday, swing, mm, custom}`, each `[[name, timeframe, hold], ...]`.
- **`USER_STRATS`** — uploaded/saved strategies `{name: {spec, style, tf, hold}}`.
- **`MODEL`** — uploaded deep-learning model (`{type:'mlp', layers:[...]}` or `{type:'weights', ...}`), or `null`.
- **`PAPER`** — paper account `{bal, start, pos[], hist[], dayRealized, lossStreak, locked, maxDayLoss, ...}`.
- **`DRAWINGS`, `RENDER`, `TOOL`, `drawStart`, `drawPreview`** — drawing-tool state. `RENDER = {start, cw, lo, hi, priceH, W, padR}` is written each `draw()` so screen⇄chart conversion works.
- **`HEDGE`** — selected hedge strategy id.
- **`VIEW`** — chart viewport `{count, off}`. **`MOUSE`**, **`ON`** (Set of active overlay ids).
- **`MODE`** (`'offline'|'online'`), **`API_KEY`**, **`FX_PROVIDER`**, **`CSV_STORE`**, **`PREFER_CSV`**.

---

## 4. Module inventory (function-level)

**Indicators — `IND.*`** (all take price/bar arrays, return arrays; `null` during warmup):
`ema, sma, rsi, atr, macd`(→`{m,sig,hist}`)`, boll`(→`{up,mid,lo}`)`, supertrend`(→`{st,dir}`, proper trailing-band algorithm)`, stoch`(→`{K,D}`)`, willr, cci, ao, roc, mfi, adx, flux`(Kinetic Flux = normalized price-velocity × volume participation, smoothed). VWAP is computed inside `indicatorsFor`.

**Detectors:** `swings(d,k)`, `detectFVG`, `detectOB`, `detectSR`, `detectBOS`(BOS/CHoCH), `detectPatterns`(double top/bottom, H&S, triangles), `keyLevels`(PDH/PDL/session), `detectDivergence`(regular + hidden, via price-vs-RSI swings), `detectInducements`(SMC "IDM" liquidity traps).

**Confluence (glass-box):** `buildSignals(d)` → `{S, ind}`. Each signal in `S`: `{source, category, dv (−2..2), strength (0..1), reason (plain text), weight, value, dirLabel}`. `confluence(S)` → `{score (−1..1), label}` using `CATW`. To add a signal: `push(source, category, dv, strength, reason, weight, value)` inside `buildSignals`, and give its category a `CATW` entry.

**Strategy engine (transparent):**
- `indicatorsFor(d)` → object of per-bar arrays for every usable variable: `close open high low ema9 ema20 ema21 ema50 ema200 rsi atr macd macds macdh stochk stochd cci willr bbu bbl bbm stdir vwap roc adx mfi flux div`.
- Rule format: condition = `[leftVar, op, right]`, op ∈ `> < >= <= crossabove crossbelow`, `right` = number or variable name. A rule group is an array of conditions AND-ed. `_val / _triplet / _group` evaluate them.
- `_stopPx / _tpPx` — stop (`{type:'atr',mult}` or `{type:'pct',value}`) and target (`{type:'rr',value}` or `{type:'pct',value}`).
- `runStrategy(spec, d)` → `trades[]`, each `{side, entry, entryI, stop, tp, exit, exitI, reason, R, entryReason}`. **This produces real trades from real rules — the core of the glass-box tester.**
- `specFor(name, style)` — maps a strategy name to a spec (keyword matching + honest `note` for proxies). Checks `USER_STRATS` first.
- `renderRules(spec)` — renders the human-readable rules; `renderEditor(spec)` + `buildSpecFromEditor()` — the visual condition editor; `validateSpec`, `addUserStrat`, `parsePyStrategy` (extracts a `STRATEGY = {...}` dict from a `.py` file and converts Python→JSON).

**Backtest:** `runBacktest(override?)` — runs `runStrategy` on `DATA`, renders rules + real trade log (with exit reasons) + equity vs buy-hold + stats; `renderRobustness` (parameter sweep + walk-forward, illustrative).

**Intelligence Lab:**
- `mcDropout(signals, M, drop)` → score distribution (uncertainty). `renderDropout`.
- `mcmcWinRate(wins, losses, iters)` — Metropolis–Hastings over win-rate posterior; `kelly(p,b)`; `runMCMC` → Bayesian fractional-Kelly sizing.
- `genSynth(n, start, volD, seed)` — regime/vol-cluster/fat-tail path generator; `runGen` — 200 synthetic histories, backtests the selected strategy across them → outcome distribution + fan chart.
- MCTS: `MCTS_TREND/TRIG/EXIT`, `MCTS_DEPTHS`, `mctsSpec(path)`, `mctsReward(spec)`, `runMCTS` — real UCB1 tree search that discovers strategies.
- `classifyRegime(d)` + `renderRegime` — ADX/vol-rank/trend → regime + recommended playbook.
- `featVec(d)` (12 canonical features), `actF`, `mlpForward`, `modelBias(d)`, `EXAMPLE_MODEL`, `renderModel` — in-browser inference of the uploaded network.
- `renderEnsemble` — weighted meta-model over confluence + regime + learned model, scaled by MC-dropout certainty.
- `renderHeatmap` — every instrument coloured by confluence; click → load symbol.

**Chart + drawing:** `draw()` (main render), stores `RENDER`. `drawDrawings(ctx)` + `renderOne(ctx,d)` render user drawings (types: `trend, ray, hline, rect, fib, brush, text, measure`). Converters `bx(bar), byP(price), barAt(sx), priceAt(sy)`. Interaction handlers support pan (cursor tool) and draw (other tools); toolbar wired via `setTool`.

**Hedge desk:** `renderHedge()` branches on `HEDGE ∈ {funding, pairs, carry, collar, beta, grid}`, each rendering legs + operational-framework tables + metrics (and a relevant chart).

**Paper trading:** `PAPER`, `paperOpen(side)`, `paperClose(id,reason)`, `closeAll`, `markTo` (auto SL/TP), `checkGuard` (daily-loss + loss-streak lock), `renderPaper`, `renderQuick`.

**Other views:** `renderMTFDash`, `renderOrderFlow`, `renderRisk`, `fillScreener`, `renderSessions`, `calcCompute` (trade calculator).

**Data / online:** `fetchKlines` (Binance public), `fetchForex` (Twelve Data), `goOnline`, `startLive/startLiveReal`, `parseCSV`, `CSV_STORE`. `binanceSym`, `tdSym`, `tdInterval` map symbols/intervals.

**Data proxy (front-end hook):** `PROXY_URL`, `PROXY_PROVIDER` globals; `proxyBase()`, `fetchProxy(sym,tf,limit)` (calls `GET /ohlc` on `server/ddt_data_server.py`), `proxyQuote(sym)` (calls `GET /quote`); `startLiveProxy()` polls the quote endpoint on the refresh interval. `goOnline` prefers the proxy for **all** symbols when the forex/stocks provider is set to `proxy`. Wired in Settings → Data sources (`#dsProxyUrl`, `#dsProxyProv`) and the Test button.

**Alerts engine (glass-box, edge-triggered):** globals `ALERTS`, `_alertSeq`, `ALERT_LOG`. `alertMetrics(d)` computes the current field values (price, rsi, ema20/50/200, macdh, atr, adx, flux, confluence score, and boolean events conf_buy/conf_sell/bos_up/bos_down) from a bar array reusing `IND.*`, `buildSignals`, `confluence`, `detectBOS`. `evalAlerts()` runs inside `recompute()` and every live tick, firing on the false→true transition (crossings fire per-crossing). `pollForeignAlerts()` background-polls price alerts on non-loaded symbols via the proxy every 15 s. `fireAlert` → browser Notification + toast + beep + history. `addAlert/toggleAlert/delAlert/renderAlerts/fillAlertSyms` drive the Alerts view. Constants `AL_FIELDS`, `AL_EVENTS`, `AL_OPS`. **Notifies only — never trades.** Persisted in workspace export/import.

**Live screener:** `SCAN_LIST` + `screenLive()` pull real candles per symbol via the proxy and score them with the same `confluence`, throttled ~0.9 s for free-tier limits; `fillScreener()` remains the synthetic preview.

**Settings:** `wireSettings()` wires the CSV manager, data sources + API key, model manager (`renderModelInfo`), risk defaults, workspace export/import, and the strategy manager (JSON/Python + guide + AI prompt). `exportWorkspace`/`importWorkspace`.

**View routing:** the nav-rail `click` handler toggles `#v-<view>` and calls the matching render on open (`renderIntel`, `renderHeatmap`, `renderHedge`, `renderPaper`, etc.).

---

## 5. Validated behaviors (from build-time tests)

These were checked by extracting the script and running it in Node against synthetic data:
- Strategy engine produces **real, varied trades** per strategy with exit reasons; **zero NaN** across R-multiples.
- Supertrend uses a **correct trailing-band algorithm** (flips direction properly — an earlier naive version never flipped).
- New indicators (ROC, ADX, MFI, Kinetic Flux) return **finite** values; divergence/inducement/flux detectors fire at reasonable rates across seeds.
- **MCTS** discovers coherent strategies (e.g. "ADX>20 + Stoch cross, exit to Bollinger mid"); **MCMC** recovers a ~59% win-rate from 30W/20L (true 60%); **generative sim** yields a full outcome distribution; **MC-dropout** produces an uncertainty band.
- **Model inference:** 12-feature vector finite, uploaded MLP runs in-browser, wrong-dimension model fails gracefully to `null`.
- **Regime classifier** correctly labels trending vs ranging.
- **Python parser** handles both double-quote and single-quote/`None`/trailing-comma `STRATEGY` dicts.

**How to re-test after edits:** extract the `<script>` and run `node --check`; for logic, slice out the pure functions (indicators, `runStrategy`, `buildSignals`, `confluence`, the intelligence functions) into a scratch file, stub `document`/`DATA` if needed, and assert no NaN + sane ranges. (Stats helpers `_mean/_std/_pct` live in the institutional block — prepend them when slicing.)

---

## 6. Honest simplifications (keep labelling these)

- **Data is synthetic by default.** Real data requires configuring a provider + key.
- **Market-maker hedge strategies** and the MM strategy family are simplified models of the real logic (which needs order-book/funding data).
- **Kinetic Flux** is an *open, transparent interpretation* of the proprietary TradingView concept — not a copy of any closed-source script.
- **Generative simulator** is a statistical stand-in for a deep generative model (GAN/diffusion), which needs offline training.
- **Backtest robustness** parameter sweep is illustrative, not a full optimisation.
- **Alerts** evaluate indicator/confluence/BOS conditions on the loaded symbol + timeframe; price alerts on other symbols poll the proxy every 15 s. They notify only — never auto-trade.
- **Live forex/stocks** without the proxy depend on browser CORS + provider limits; crypto uses Binance's public API. The `server/` proxy removes that constraint and adds yfinance / Polygon / Alpaca / Alpha Vantage. Note `4h` isn't native on yfinance / Alpha Vantage (those fall back to hourly).
- Everything is **educational, not financial advice.**

---

## 7. Roadmap — the Python production build

The prototype is the reference spec. The production system is modular Python:

> **Shipped:** `server/ddt_data_server.py` is the first piece of the `data/` layer below — a working multi-provider proxy (yfinance / Twelve Data / Alpha Vantage / Polygon / Alpaca / Binance) the front-end already consumes. The remaining modules follow the same plan.

```
ddt/
├── data/         # ccxt (crypto), Twelve Data / yfinance (fx/stocks), websockets, caching, CSV
├── indicators/   # vectorised port of IND.* (pandas/numpy or ta-lib)
├── detectors/    # swings, FVG, OB, BOS/CHoCH, patterns, divergence, inducements
├── xai/          # buildSignals + confluence + CATW weights + explanations
├── analytics/    # MCTS, MCMC, generative sim, MC-dropout, regime, ensemble
├── backtest/     # event-driven engine (port runStrategy) + robustness/walk-forward
├── charting/     # server-rendered or streamed charts
├── models/       # ONNX Runtime / TensorFlow serving (replaces the JSON-MLP)
└── strategies/   # scalp · intraday · swing · mm · custom (same JSON + Python format)
```

**Tech suggestions:** FastAPI (or Streamlit for speed) + a JS charting lib; pandas/numpy for indicators; `ccxt` + `twelvedata`/`yfinance` for data; `onnxruntime` or `tensorflow` for models; `pytest` for tests.

**Forward-compatible already:** the JSON/Python **strategy schema** and the **model schema** are designed to carry straight over. Port `runStrategy`'s rule evaluator and `buildSignals`'s weights faithfully and the two systems stay in sync.

**Suggested build order:** (1) data + indicators, (2) detectors + confluence (must match the prototype's numbers), (3) backtest engine + strategy format, (4) analytics/intelligence, (5) model serving, (6) UI, (7) live feeds/websockets, (8) tests + CI. The exact scaffolding prompt is in `AI_PROMPTS.md` → "Convert to the Python backend".

---

## 8. Conventions & gotchas

- **Colours** are CSS variables (`--bull #2DBE8E`, `--bear #F0616D`, `--gold #E8A33D`, `--blue #4C82FB`); don't hard-code.
- **Every new signal** should emit a plain-language `reason` and a `CATW` weight — that's the glass-box contract.
- **Drawings store chart coordinates** (`{bar, price}`), not pixels, so they survive pan/zoom. Use `bx/byP/barAt/priceAt`.
- After any script edit, the file must remain **one valid HTML file**; verify the `<script>` parses.
- Uploaded strategies land under the **★ Custom** style; `specFor` checks `USER_STRATS` first.
- The chart's render mapping is only valid **after `draw()` has run** (`RENDER` may be `null` before the chart is first shown).
- No `localStorage` is used (so it runs anywhere); persistence is via **workspace export/import**.

---

## 9. Changelog (prototype build)

1. Core terminal: charting, indicators, detectors, glass-box confluence, calculator (from a real trade workbook), paper trading, MTF, order flow, portfolio risk, screener, sessions, offline/online + CSV.
2. **Transparent strategy tester**: replaced the statistical mock with a real rule engine (rules shown, real trades with reasons); visual editor; JSON upload; fixed Supertrend.
3. **Divergence, inducements, Kinetic Flux**; added ROC/ADX/MFI; flux & divergence strategies.
4. **Intelligence Lab**: replaced basic Monte Carlo with MCTS, generative simulator, MCMC sizing, MC-dropout; added market heatmap.
5. **Regime classifier, ensemble meta-model, deep-learning model upload** (in-browser MLP inference); workspace export/import; risk defaults.
6. **Drawing tools** (trend/ray/hline/rect/fib/brush/text/measure); **Python strategy upload** + guide + AI prompt; **6 hedge strategies**; model-format guidance (ONNX/TF.js).
7. **Repo packaging**: `index.html`, README, QUICKSTART, AI_PROMPTS, run scripts, LICENSE — and this DEVELOPMENT.md.
42. **v4.4 — one-command professional startup + smart resume + top-bar dedup**: `run.py` now **auto-starts the data proxy** (no second terminal) and opens the browser — one command runs everything. Persistence remembers **Online mode and auto-reconnects live data on launch**. Top bar de-duplicated (legacy asset-class row, old symbol select and duplicate price display hidden — the searchable symbol dropdown gained **asset-class filter chips** (All/FX/Crypto/Futures/Metals/Indices/Stocks) and the big price lives in the instrument header), guaranteeing ⌘K/🔔/⋯ are visible on all screen widths. Added WHAT_WAS_BUILT_AND_UPGRADES.md handoff doc.
41. **v4.2 — visible version stamp + labeled rail + instrument header**: every build is now stamped — **BUILD v4.2** on the splash, 'MISHEL · v4.2' in the chart header, and the browser tab title — so you can instantly verify you're running the newest file (if you don't see v4.2, you're opening an old copy/cache: re-download and hard-refresh with Ctrl+Shift+R). **Nav rail redesigned**: wider (78px) with **permanent labels under every icon** — no more guessing tooltips. New **instrument header strip** above the chart, TradingView-style: instrument name, **large live price** (tick-colored), change chip, **live consensus chip**, ATR% chip.
80. **v34.0 — THE ACCURACY SPINE + 26-STRATEGY ROSTER (AC1-AC6, 14 new strategies, MM liquidity mechanics, IN1/IN2, SUP1/SUP2)**: the build that makes every measured number harder to flatter and doubles the strategy roster with liquidity-mechanics and anti-crowd setups. **ACCURACY SPINE:** AC1 **habitat gating** — every strategy declares trend/range/any; sigScan silences trend strategies when ADX<22 and range strategies when trending (no more mean-reversion entries fighting a runaway trend counted against the record); AC2 **adaptive stop pad** — the ±ATR pad now scales with the volatility percentile (0.9× quiet / 1.2× normal / 1.5× hot); AC3 **40-bar time barrier** — stalled signals expire as `res:'time'` scratches instead of living forever as fake opens; AC4 **walk-forward selection** (`sigBestWF`) — 4 rolling folds, pick on train window n, record outcomes ONLY from window n+1, aggregate: auto-pick now reports a record the selection never saw at every fold (legend says **WF-OOS ·**); AC5 **Wilson 95% CI** on every win% (`38-71%` next to the point estimate — small-sample honesty made visible); AC6 **cost realism** — every signal carries a per-signal cost estimate (spread proxy, floor 0.15R min) and `netAvgR` is reported net of it. **14 NEW STRATEGIES** (roster 12 → 26, all habitat-gated, all through the same spine): *Liquidity & MM mechanics* — Stop-Run Reclaim (multi-touch sweep + reclaim), Equal-Highs Raid (engineered-liquidity pools raided and rejected), Session Liquidity Grab (Judas swing at the NY open), Liquidity Sweep, Imbalance Fill (FVG revisit with fading opposing volume), Absorption Break (effort-vs-result at a level), Late-Breakout Fade (3rd+ test on declining volume); *Flow & structure* — CVD Divergence Snap, Failed Breakout Trap, Compression Break, HTF Confluence Pullback, VWAP Execution Shadow, Momentum Ignition, Ensemble Vote (fires only when ≥3 agree). **AR1 honestly demoted**: funding-fade shipped as a crowding *gate*, not a strategy — there is no funding history to back-measure, so it cannot claim a measured record. **SUP1 🗺 Liquidity Map** overlay — multi-touch swings, equal-H/L pools, round numbers, unfilled FVGs heat-weighted by touches ("what gets hunted", estimates from YOUR bars). **SUP2 crowding meter** cockpit card (funding percentile-of-itself + L/S + round-number proximity fused, glass-box) feeding the Decision Bar positioning score. **IN1** three-bullet setup memo (fired/for/against, written from measured data) + **IN2** quality calibration (does Q≥80 actually win more? bucketed rates) on signal hover. **T-c** picker: all 26 strategies grouped in the Signals dropdown, options lazily decorated in place with their measured net R for this symbol/TF (chunked background scan). **T-d** Strategy Lab gains habitat / win% (CI) / netR columns. Caught mid-build: first detect-block insertion landed inside a function body (excised by unique marker, re-inserted at the true registry close); the aborted patch-run lesson applied again (assert-abort = NOTHING written — verified before resuming). Runtime smoke: all 26 strategies clean on 600 synthetic bars; WF end-to-end known-answer (picks the true winner every fold). Tests: `tests/test_v340_alpha.js` **46/46** (habitat dial, time-barrier expiry, exact net-cost math, WF known-answer, Wilson bounds, raid synthetic fires MM strategies, ensemble ≤ components, qCalib buckets). Suite: **57 files green**. Boot audit: 0 errors.

79. **v33.0 — THE MASTER BUILD (Waves 1-4): best-of-breed per platform + decision-first doctrine**: the largest single build. **WAVE 1 (foundation/doctrine):** R1 cockpit restructured into ⚡ DECIDE / 🧭 CONTEXT / 🔬 EVIDENCE collapsible sections with live one-line digests in headers (`mishel_cksec`); R2 dedupe (narrative read strip retired — one fact one home); R4 Smart Money split into Act/Wallets/Forensics sub-tabs (panels auto-grouped by contained ids, persisted); I1 **Decision Bar** in the tab-bar fill on every view — read · glass-box conditions score 0-100 (regime 30 + signal record 30 + session 20 + positioning 20, parts in tooltip, “never a buy signal”) · active sig record · next-best-action, all click-to-evidence; I2 **judgment layer** — `window.judge(k,v)` gives every number its meaning (ATR quiet/hot, funding crowded, ADX trending…), applied at ATR/funding/vol-percentile rows, known-answer tested; I3 decision-state color tokens (--fav/--neut/--unfav) distinct from bull/bear; I4 calm-by-default side panel (.sem opt-in emphasis); M1 precision (header 20px baseline chips borderless, watermark → 30px corner @3%, readout slides aside when the crosshair approaches, bars widget → ⋯, New Data → ⟳, off → ⏻). **WAVE 2 (intelligence):** M13 **QFA** — `qfaScore()` pure scorer: dilution/usage/depth/exit/concentration/base/contract/maturity/flow/smart-presence, each with pts/max/why, verdict SOUND · MIXED · DILUTED · FRAGILE · HOLLOW + biggest-threat line, honest neutral partials on missing data (known-answer tested across healthy/diluted/rugged/all-unknown), rendered as the hero in every Research Pack; M5 typed **entity labels** (whale/fund/deployer/mm/exchange colored chips) — type prompt in the nickname flow, chips in co-holding + dossiers; M6 insight-card tag grammar on the Action Queue; M7 **estimated liquidation zones** (recent swing entries ±1/L for 10/25/50×, OI-gated, right-edge heat strips, formula printed on-chart, “estimate, not exchange data”); M12 **Strategy Lab** modal — all 12 strategies × this symbol/TF: win/avgR/PF/resolved/OOS-avgR/best-session + equity sparklines, OOS-sorted, one-tap “use”; I7 notification center re-sorted by decision urgency (SIGNAL>ALERT>DESK>INFO tag chips + inline open). **WAVE 3 (command):** M2 first-class search field in the tab bar (opens the palette); M3 **command syntax** — `btc 4h`, `qfa <addr>`, `w:name`, `j`, `lab` parsed into runnable entries (parser known-answer tested incl. non-command passthrough); M4/I6 function chips on cards (plan → 📋 MT5 ticket + 📓 journal; levels → 🔔 alert@PDH) with a generic chips param + dispatcher; M9 **draggable plan** — grab entry/stop/T1/T2 lines at the right edge, overrides flow into the live sig + sizer + ticket; M10 **auto-annotate** (✏ in ⋯) — the engine’s own auto-trendlines + S/R zones with touch counts, detector-labeled; M11 **MT5 order ticket** — copy-ready symbol/side/zone/volume(lots for FX)/SL/TP/risk, “nothing auto-executes”; I5 **decision stages** (🔍 Scan · ⚖ Judge · 🎯 Execute · 🪞 Review buttons in the tab bar) reshaping sections/views per stage; I9 **the mirror** — Review opens with one measured sentence about YOUR week (taken/resolved/best session); plan card gains the A4-lite “breakeven win-rate @1:2 vs measured” row. **WAVE 4:** M8 **CVD sub-pane** — new CVD pane button: historical bars use the candle-direction × volume proxy (labeled), live session overlays REAL aggressor CVD when online, HH/LH **divergence flags** drawn in-pane (proxy math known-answer tested). Headless jsdom boot audit: **0 errors**, instHead alive in wsTabs. Tests: `tests/test_v330_master.js` 38/38; two stale assertions updated. Suite: **56 files green**.

78. **v32.1 — FIX PACK F1-F7 (from the TV-comparison critique) + headless boot auditing**: introduced a REAL reproduction harness — jsdom+canvas boots the actual index.html headlessly and captures every error (`/home/claude/trade/boot_audit.js` pattern) — and it found two shipped bugs static tests missed. **(F1)** `GLR.begin(cv)` was called unguarded every frame at draw start; any browser where the GL module half-initializes got an error flood and a dead chart → guarded (`typeof GLR.begin==='function'`); the rAF wrapper now also feeds draw-loop errors into the ⚠ telemetry (5s-throttled) so paint failures are visible, not just consoled. Boot-integrity gate: 8s after load, any captured errors or structural failures (tab bar unpainted, header hidden) paint a visible red diagnostics strip; includes self-heal (re-runs syncTabBar / re-moves instHead). **(F2 ROOT CAUSE, the vanishing price/ATR chips)** v27.2 moved #instHead into #wsTabs — but the tab system rebuilds that bar with innerHTML every render, DESTROYING the header seconds after boot (exactly the user's screenshot). Fix at the render site: detach the live node before innerHTML, re-append after (kept in `window._ihNode`); proven headlessly — instHead alive with parent wsTabs after 10s of renders. **(F3/F4)** TV-grade toolbar: ghost icon buttons (borders on hover/active only), guaranteed single row (`nowrap!important`), logical group separators, icon-glyphs for frequent controls (⛶ ◨ ▤ ⊞), and a ⋯ overflow menu that receives Replay/Compare/watchlist/journal/Layout — the two-line-button disease cured at the CSS root. **(F5)** SIG honesty legend relocated from bottom-left (VOL collision) to top-left under the OHLC line. **(F6)** countdown fused under the last-price tag as one two-line axis tag. **(F7)** air pass: chart chips/tabs/legend rows lose permanent borders for hover borders, panels lightened, 32px draw targets. Tests: `tests/test_v321_fixpack.js` 13/13. Suite: 55 files green. jsdom audit: 0 boot errors.

77. **v32.0 — BUILD 3 “WORKSPACE” (D1-D4, B4/B5, A1/A7 + UI cleanup)**: **D1** ⊞ Grid toolbar button + G key jump into the existing multi-chart view (independent streaming panels, ⇢ to main). **D2** workspace presets — Scalping (multi grid), Research (smart-money desk), Review (tester + journal) — via palette or `applyWorkspace`. **D3** ⌘K palette now surfaces tracked wallets (→ dossier), workspaces, settings jumps and quick actions (sig-alert, journal, profile, magnet, shortcuts). **D4** notification center: toast() wrapped (never replaced — tested) so every signal/alert/event logs to a read/unread panel behind a 🔔 badge in the status bar. **B4** keyboard layer: ? shortcuts overlay, / symbol search, G grid, Q quality gate, S signals picker — collision-checked against the legacy keymap by test. **B5** right-click any candle: alert at that price, aVWAP anchor, measure-from-here (drawing/axis menus keep precedence). **A1** design tokens (:root radii/spacing/type) + unified 26px control heights. **A7** two curated themes starred (★ Institutional, ★ TradingView), rest kept as legacy. Tests: `tests/test_v320_workspace.js` 12/12. Suite: 54 files green.
76. **v31.0 — BUILD 2 “INTELLIGENCE” (C1/C2/C4/C5/C7 + E1/E2/E4/E5)**: **C1** every signal is session-tagged (LDN/NY/LDN+NY/ASIA) at scan time; `sigSessStats` measures per-session records; legend line 2 names the best session. **C2** `sigStack` cross-checks all other strategies (same dir, ±3 bars): ◉ badge on stacked pills, stacked-vs-solo records measured separately and shown. **C4** per-symbol memory (`mishel_sigmem`): best OOS record per sym|TF saved on every auto run; switching symbols surfaces “memory: X had the best OOS record here”. **C5** 🔔 sig button registers live-fire alerts per sym|TF: fresh signal → /svc/notify (Telegram) with the measured record embedded (“you decide” framing, tested). **C7** decision journal: 📓 “I took this” on the cockpit plan logs the live setup; entries resolve with the SAME stop-first-conservative rule as the engine (known-answer tested); 📓 toolbar modal shows YOUR win% next to the system record. **E1** Order Flow cockpit card: bookTicker spread (bps), aggressor tape, session CVD sparkline (aggTrade, maker-flag math tested) — browser-direct, honest offline. **E2** funding card gains open interest + Δ%, global long/short accounts, and divergence flags (“price up + OI down = short-covering rally”). **E4** correlation card: rolling 40-bar r across loaded symbols, red >|0.8| with “one trade wearing two hats” warning. **E5** 📅 event lines on the chart from the news feed. Cockpit order auto-merges new cards into saved orders. Tests: `tests/test_v310_intel.js` 16/16. Suite green.
75. **v30.0 — BUILD 1 “PRO CHART” (A2/A3/A4/A6 + B1/B2/B6/B8 + E3 + F1; F2 verified pre-existing)**: **A2** signal markers → TV-style flag pills with stems (▲ L / ▼ S, + for Q≥70, ◉ when stacked) and outcome ribbons (gradient fills, not hairlines). **A3** candle polish: weighted wicks, subtle body borders, `CANDLE_HOLLOW` option, volume age-fade, pulsing live-price dot. **A4** tabular numerals app-wide + dimmed decimals on the header price. **A6** micro-motion: 120ms hover eases, active-press, price tick-flash (green/red). **B1** sub-panes resizable by dragging the divider (44-150px, persisted `mishel_paneh`). **B2** drawings 2.0: 🧲 magnet snaps to O/H/L/C while drawing; per-symbol+TF auto-persistence (`mishel_drw:SYM|TF`, 4s autosave + reload on switch); double-click a selected drawing → properties (color,width,dash / lock / dup / del). **B6** right-click the y-axis → option 3 creates a price alert at the cursor. **B8** user-saved layouts verified pre-existing (LAYOUTS store) — entry point confirmed. **E3** ▤ Profile: visible-range volume profile with POC + VAH/VAL (70% value-area expansion, known-answer tested). **F1** draw() wrapped in a rAF scheduler (`_drawNow` real painter) — any number of draw() calls per tick coalesce to one paint per frame; worker untouched (verified). **F2** Binance WebSocket streaming confirmed already shipped. Caught mid-build: outer-else brace consumed by the candle rewrite (restored), E4 try without catch (fixed), stale marker assertions in old tests updated — grep-tests-after-changing-shipped-strings lesson applied. Tests: `tests/test_v300_prochart.js` 18/18. Suite green.

74. **v29.0 — SIGNAL-VISIBILITY FIX + TRADINGVIEW INTERFACE (T1-T10) + SUSTAINABILITY (#1/#3/#6/#7/#8)**: **(the bug)** signals never painted because C10's `if(!ev.length)return;` exited the WHOLE _drawPost hook before SIG rendering — guard now scoped (`throw 0` within its own try), SIG runs regardless of feed state; root cause named, tested (`no early return before SIG`). **(#6 registry)** strategies refactored into `window.SIG_DETECT` — 12 self-contained `detect(ctx,i)` fns over a precomputed CTX (emas/rsi/st/atr/macd/vwap/mean20/sd20/donchian/dayOf/idxInDay/lastSwing); `sigScan` just dispatches; strategy #13 = add one object, individually testable. **(#1 OOS honesty — the selection-trap fix)** `sigOOSStats` splits 70/30; `sigBest` SELECTS on in-sample (≥6 resolved) but REPORTS the out-of-sample record (`b.oos=true`); legend prepends "OOS ·" so the number you see is from data the pick never saw. **(T1)** drawbar docked left, open by default (body.tvdock, persisted). **(T2)** crosshair axis bubbles — price on y, time on x — via `window._chartMap` exposed each draw with exact log/linear inverse. **(T3)** bar-close countdown pinned at the last-price axis level (1s tick). **(T4)** legend rebuilt as indicator rows with ✕ remove + dimmed "parked" rows for one-click re-add (checkbox UI synced). **(T5)** axis interactions: drag y-axis → YPAD scale, drag x-axis → bar zoom, right-click y-axis → reset / log-linear toggle. **(T6)** toolbar restyled into segmented tgroup pills. **(T7)** wheel zoom verified already cursor-anchored (asserted). **(T8)** grid softened (.5→.32 alpha). **(T9)** 📋 watchlist mini-rail overlay: tab + session symbols with live Δ%, click → `loadSymbolName`. **(T10)** hover any signal arrow → card with strategy, Q, entry/stop/T1/T2 and outcome (hit-boxes from SS._hit). **(#3 durability)** new kv table + `/svc/backup` POST/GET; client auto-backs walletdb/pins/queue/nicks/cockpit every 4h + `sendBeacon` on leave; on boot with an empty wallet DB it offers restore from the service copy (round-trip tested). **(#7)** window.onerror + unhandledrejection → 50-entry ring + ⚠ badge in the status bar (click = list): client failures are loud now. **(#8)** `mishel_schema` version stamp + central migrate stub — future format changes get explicit upgrades, not silent corruption. Fixed mid-build: backup used wrong storage key (`ddt_wallet_db` → `mishel_walletdb`); assert-abort protected the file, all 4 occurrences corrected. Tests: `tests/test_v290_ui.js` 20/20 + service backup round-trip (service file now 11). Suite: 53 files green.

73. **v28.1 — 12 signal strategies by trading style + quality gate + smarter auto-pick**: strategy roster tripled and categorized. **⚡ Scalping (1m-15m):** VWAP Bounce (≥0.6 ATR stretch from cumulative VWAP, close back toward fair value), RSI Extreme Snap (<25/>75 hook back through 30/70), Bollinger Snapback (close outside 20,2 band then back inside). **☀ Day (15m-1h):** EMA Pullback, Momentum Composite, Opening Range Break (first-hours UTC range), Prev-Day Break (PDH/PDL break). **🌙 Swing (4h-1D):** Supertrend Flip, SMC CHoCH, Donchian 20 Break, EMA 50/200 Cross, MACD Zero Cross. Picker grouped by style with TF hints. **(accuracy/intelligence)** every signal now carries a glass-box **quality score 0-100** (trend alignment 40 + momentum side 30 + volatility sweet-spot 30); the **Q≥50 toolbar gate** filters to aligned setups only (monotonic — never adds); `sigStats` gains **profit factor**; legend shows STYLE · win% · avgR · PF · resolved · Q-state. **★ best measured (fits TF)** — `sigStyleForTF` maps the current timeframe to a style and `sigBest` prefers strategies of that style (honest fallback to all when none qualify with ≥8 resolved). Tests: 22 more in `tests/test_v280_sig.js` — all 12 run-clean on synthetic data with signal counts, quality bounds, gate monotonicity, TF mapping, PF presence. Suite: 52 files green.

72. **v28.0 — SIGNALS ON THE CHART + DECISION LAYER + ACTION FEATURES (SIG1-5, D1-D6, E1-E6/E8-E10)**: the "data but no actionable decision" build. **(SIG engine, pure+tested)** `sigScan(d,strat)` — 4 glass-box strategies (EMA Pullback, Supertrend Flip, SMC CHoCH via swing-break, Momentum Composite), each signal = dir + entry + swing/ATR stop + T1(1R)/T2(2R), resolved forward (conservative: stop checked first per bar), 5-bar debounce; `sigStats` → measured winPct/avgR (null when nothing resolved — honest); `sigBest` auto-picks only with ≥8 resolved. Known-answer tests: geometry sides, exact 1R/2R, uptrend resolution, debounce. **(SIG2/3 chart)** rendered through the existing `_drawPost` hook (zero new draw() surgery): ▲L/▼S arrows, green/red outcome traces entry→resolution, LIVE setup (entry band + stop/T1/T2 dashed lines at right edge), and a permanent honesty legend — "X% win · avg ±Y R · N resolved — measured on THIS data, not a promise" (red when negative). **(SIG4/5)** toolbar Signals… picker (incl. ★ best measured), 15s refresh, fresh-bar signal → toast + cockpit Trade Plan sync; SIG6: no auto-execution, verified by test. **(D1)** co-holding rows now verdicts: ✓ REAL convergence (independent) vs ⚠ LIKELY FAKE (majority in a sybil ring via `clusterDetect` cross-check), scout ▷ + 📦 pack actions, address walls behind `<details>` (D6), inline jargon explainers (D5). **(D2)** manipulation panel: plain-language meanings, auto-exclusion summary, 🚩 flag-to-registry. **(D3)** SO-WHAT strips. **(D4)** "What should I do now?" rule-based next-best-action (real convergence → scout; 0 S/A → EVM harvest; rings → review) with one-tap actions. **(E1)** Action Queue inbox (producers: REAL convergences, first-seen S/A wallets; approve→pack/dossier, dismiss). **(E2)** Research Pack modal: verdict stamp + market rows + smart-holders + rug in one view, honest fetch waits, pin/scout/to-chart actions. **(E3)** since-last-visit diff banner. **(E4/E5)** to-chart + pin-and-watch from the pack. **(E9/E10)** Watching table: pinned stance, Δ since pinned, narrative tags + rotation mix, re-pack, unpin. **(E6/E8)** dossier shows your private note + since-last-look holdings delta. Caught own bug mid-build: `\u{...}` escapes written into raw HTML (JS-only syntax) — fixed with real chars. Tests: `tests/test_v280_sig.js` 12 engine + 25 surface. Suite: 52 files green.

71. **v27.2 — S/A-filter vanish fix + chart header merge**: **(the vanish bug)** clicking the S/A or COPYABLE filter with zero matches replaced the whole ranking area INCLUDING the filter chips — no way back. Filter controls now render in every branch (3 call-sites), and the empty state explains WHY honestly ("your current wallets don’t have the cross-token history that earns it — not a bug") with a one-tap "← show all" and a pointer to the EVM harvest button. **(chart header merge)** in compact mode the instrument header (name · price · chg · ATR · X-MKT · FUND) is MOVED into the symbol-tabs row (right-aligned; DOM nodes relocated so all live-updating ids stay wired; redundant consensus chip hidden) — one header row instead of two, ~34px more chart. Tests: addendum 5/5. Suite: 51 files green.

70. **v27.1 — side-panel garble fix + TradingView-size candles**: screenshot showed the side panel's top chips (Verdict/Scout/Plan…) rendering as clipped skeleton boxes — `#sideJump` had two competing rule sets (original sticky/wrap at ~1277 vs the v27.0 nowrap at ~116). Since the cockpit already covers side navigation, sideJump is now removed outright (`display:none!important`) instead of re-patched. **Bigger candles**: the volume pane was consuming ~26% of chart height mostly empty; default price-pane share raised 0.74→0.82 (plain) / 0.80→0.84 (with sub-panes) — the drag-divider still overrides, and any user-set `PANE_RATIO` is respected. Tests updated + addendum. Suite: 51 files green.

69. **v27.0 — space optimization V1-V9 (chart-first layout)**: from a screenshot showing ~6 stacked rows before the first candle. **V1** collapsed chart toolbar never wraps (`flex-wrap:nowrap` + h-scroll; `#indToggleGroup` pinned right) — Indicators no longer takes its own row. **V2** floating OHLC overlay slimmed (10px, tighter). **V3** compact instrument header: price 24→17px, name 16→13.5px, chips slimmed, header no-wrap h-scroll; `#verTag` hidden and the version now lives at the right edge of the status bar (`#stVer`). **V4** symbol tabs 28→23px. **V5** status bar `--status-h` 24px, smaller font. **V6** side jump chips (Verdict·Scout·Plan·Drivers·Sizer) forced to ONE h-scrollable row. **V7** right-panel cards padding −20%, MTF grid cells compacted, cockpit headers/bodies tightened. **V8** chart-first default: side panel defaults to the narrow 300px preset (only when the user never chose a width). **V9** all 25 density rules scoped under `body.compact` — ON by default, one persisted "compact" toggle in the cockpit bar flips comfortable/compact app-wide. Net reclaim ≈ 90-110px of chart height. Tests: `tests/test_v270_space.js` 13/13. Suite: 51 files green.

68. **v26.2 — BUILD C (isolated draw-loop): C8 session shading · C9 compare · C10 smart-money markers**: exactly TWO try-guarded hook lines added inside `draw()` (`window._drawPre` pre-candles, `window._drawPost` post-overlays) — all logic external, so an extension bug can never kill the chart (tested contract). **C8**: London 07-16 (blue) / NY 12-21 (amber) UTC shading, intraday-only, ◨ Sessions toolbar toggle persisted. **C9**: ⇄ Compare overlays a second symbol %-normalized from the first shared bar, purple dashed on its own scale — uses only `BAR_CACHE` bars already loaded this session (honest label: "no hidden fetching"; honest empties for no-cache / no-overlap). **C10**: ▲▼ tracked-wallet BUY/SELL markers plotted on price ONLY when the event token matches the charted symbol — legend says "evidence, not signals". Tests: `tests/test_v262_drawext.js` 15/15 incl. isolation contract + normalization known-answer. Suite: 50 files green.
67. **v26.1 — BUILD B (hardening H1-H6, from the external audit)**: **H1** bearer-token auth on ALL /svc routes: `MISHEL_TOKEN` env or `svc_token` config → requests need `X-Mishel-Token`; with NO token set the service now fails closed for any non-localhost caller (so flipping MISHEL_SVC_HOST can't silently expose the DB). Client auto-attaches the token from localStorage `mishel_svc_token`. **H2** every background loop calls `tick(name)`; `/svc/health` returns per-loop `last`/`stale_s` + `stale_loops` (>10 min); the frontend polls each minute and shows a red banner naming stale loops — kills the silent-failure mode. **H3** `guarded_get`: per-host exponential backoff (cap 10 min) + circuit breaker, honors 429; all 4 loop call-sites routed through it. **H4** `server/requirements.lock.txt` with exact pins (regeneration instructions inline). **H5** `MISHEL_TG_TOKEN`/`MISHEL_TG_CHAT` env vars override the DB — the secret path that never touches disk. **H6** collision linter in `tests/test_v261_hardening.js`: single-definition check for critical grid selectors, grid rows-vs-areas count match (the v25.0 bug class), zero duplicate top-level consts (the _mean/_std class). Tests: 9/9 service + 8/8 client.
66. **v26.0 — BUILD A: right-side COCKPIT (S1-S14)**: 12 decision cards appended to the chart side panel, all computed from existing glass-box internals (`analystContext`, IND._levels/_fvg/_ob/_acc, swings, classifyRegime): **S1** Trade Plan (dir from confluence sign, entry ±0.25 ATR, stop beyond swing +0.15 ATR, T1/T2 at 1R/2R, logic line shown, "not advice"); **S2** live Position Sizer (account×risk% ÷ plan stop, persisted inputs); **S3** Key Levels (PDH/PDL/PWH/PWL/VWAP/nearest FVG+OB with %-and-ATR distance, nearest-first); **S4** Volatility & Regime (ATR%, realized-vol percentile, ADX, stop-width implication); **S5** Session Clock (live session, next open/close countdowns, hour-of-day vol vs avg); **S6** Cross-Market mirror; **S7** Next Events countdown (honest empty); **S8** Funding & Positioning (live funding via exposed `window._fundRate`, OI/LS honestly "not wired"); **S9** Smart-Money mini (tracked count, 24h buys/sells from cached feed events, latest move, open-desk button); **S10** Signal Accuracy table (measured per-signal hit-rates); **S11** Confluence Momentum sparkline (session-local history, BUILDING/FADING/STABLE); **S12** Model Verdict (regime + up-bar base rate with Wilson 95% CI, "context, not prediction"). **S13** every card collapsible + drag-to-reorder, order/collapsed persisted (`mishel_cockpit`); **S14** width presets narrow/normal/wide persisted (`mishel_sidew`). Tests: `tests/test_v260_cockpit.js` 24/24 incl. plan-math known-answers.
65. **v25.465. **v25.4 — TradingView-class chart power (F1-F3, C2-C3, C6-C7)**: **(F1 true fullscreen)** Expand now requests the browser Fullscreen API (whole monitor) and collapses top bar + status — grid rows 0/1fr/0, literally nothing but chart; native Esc + fullscreenchange sync back. **(F2)** floating glass toolbar in fullscreen: symbol · 1m/5m/15m/1H/4H/1D quick-TF buttons (proxy the real tfBar, active-state synced) · ✕ exit. **(F3)** double-click the chart toggles fullscreen. **(C6)** double-click the price axis = reset zoom. **(C2 keyboard, TradingView muscle-memory)** F fullscreen · +/- zoom · ←/→ pan (VIEW.off) · 1/5/3/h/4/d/w quick-timeframes — all guarded (never hijacks typing or cmd/ctrl combos). **(C7)** press any letter on the chart → symbol search opens pre-typed (`openMsp(prefill)` exposed). **(C3)** hover readout adds candle range %. C4 (close countdown) and C5 (right-click menu: alert-at-price/H-line/V-line/aVWAP/smart-trendline/copy) verified already shipped in earlier builds. C8 session-shading + C9 compare + C10 smart-money markers deferred to the isolated draw-loop build. Tests: `tests/test_v254_chart.js` 18/18. Suite: 46 files green.

64. **v25.3 — Expand finally clean: the side panel was the culprit**: after v25.2, Expand STILL showed the Confluence/side content scrambled over the top. True root cause found: the chart-max grid template has no "side" area, but `.side{grid-area:side}` still referenced it — per CSS-grid auto-placement rules the whole side panel got auto-placed into the first implicit cell, landing OVER the chart and shoving the status row up. Fix: `.app.chart-max .side{display:none!important}` (the `!important` also beats the inline `display:flex` the view-switcher sets on the chart view). Root cause documented in the CSS itself. Tests appended to `test_v252_expand.js` (3 more). Suite: 45 files green.

63. **v25.2 — Expand fullscreen fix + ranking area rebuild**: screenshot showed Expand producing a scrambled layout (side-panel content over the top bar, status bar jammed under the header). Two causes: a **duplicate old `.app.chart-max` grid rule** (from v22.1) that set columns but not the rows/areas, overriding the correct v25.1 rule; and `toggleMax` leaving inline grid styles that fought the CSS. Fixes: removed the duplicate rule (one clean chart-max grid now: top/main/status 3-row); `toggleMax` **forces the chart view first** (fullscreen is chart-only — was maximizing whatever view was active) and clears ALL inline grid (columns+rows+areas) so the class rule wins; `syncAppGrid` bails and clears inline on chart-max. **Ranking area rebuilt**: tighter row padding (6px), compacted action buttons (10.5px), row-hover feedback — less wasted vertical space. Tests: `tests/test_v252_expand.js` 9/9. Suite: 45 files green.

62. **v25.1 — grid fix: chart was blank after the tab bar landed**: v25.0 added a 4th grid row (`tabbar`) to `grid-template-areas` but never updated `grid-template-rows` (still 3 values), so the browser couldn't size the tabbar row and the `main`/chart area collapsed to zero height — blank screen. Fix: `grid-template-rows:var(--top-h) auto 1fr var(--status-h)` on `.app`, matching 4-row template for non-chart views, and a 3-row template for `chart-max`. Also updated the boot self-check (was flagging "sidebar rail paints" as an issue since the rail is now intentionally `display:none`) to validate the tab bar instead. Tests: `tests/test_v251_gridfix.js` 6/6. Suite: 44 files green.

61. **v25.0 — TOP TAB BAR replaces the left rail + true fullscreen + functional Smart Money**: after ~5 failed attempts to fix the tangled left rail (12 conflicting breakpoint rules), replaced it entirely. **(tab bar)** horizontal nav under the top header — Chart · Smart Money · Discover · Analysis · Strategy · Tools · ⌘K — grouped by use case; clicking a multi-view tab reveals inline sub-tabs (Discover → Screener/On-Chain/Heatmap/News). Rail hidden via `#rail{display:none}` + grid rebuilt to a full-width `tabbar` row; every `data-view` button preserved so `goView()` and all views work unchanged; `syncTabBar()` keeps the active tab lit on any view switch. **(true fullscreen)** Expand/`chart-max` now hides the tab bar + side panel and goes borderless edge-to-edge (TradingView-style), Esc restores. **(Smart Money functional)** prominent quick-start banner + one-click “⚡ Get copyable wallets (EVM)” button that scans Base launches+memes then mass-harvests — turns the thin-Solana-DB dead-end into an actionable path to S/A wallets. Also registered previously-unregistered suites (v242/243/244) into run_tests. Tests: `tests/test_v250_tabbar.js` 21/21. Suite: 43 files green.

60. **v24.4 — rail + ranking layout fixes (from screenshots)**: **(left bar broken)** the v24.3 collapsed-label experiment fought ~12 competing `.nav .lbl` breakpoint rules and clipped labels to stray characters. Removed it; rail now **pinned-open by default** (clean known-good labeled layout) with styled group headers (TRADE/SMART MONEY/DISCOVER…), active-item accent bar, Favorites accent — collapses only if the user chooses (persisted). **(ranking huge gap)** `max-width` on the table didn't constrain it; switched to `table-layout:fixed` + fixed 300px actions column + actions forced `display:inline-block` (were stacking vertically and floating far-right). Tests: `tests/test_v244_layout.js` 10/10. Suite: 40 files green. NOTE: the identical `C 21 / UNPROVEN / WHALE / 1 token / 25% conf` rows are correct — all wallets are single-token Solana whales; the desk needs EVM harvests to show differentiated tiers (honesty contract, not a bug).

59. **v24.3 — ranking bug-fix + left-bar labels + consistency sweep (L1-L4, R1-R5, D1-D3, C1-C3)**: **(R1, the undefined bug)** ranking rows showed "undefined 6 / undefined% conf" — they were bound to `smartScore` (no tier/conf) while the redesigned row read `x.s.tier`/`x.s.conf`; rebound to `walletIntel` so tier + score + confidence populate correctly. **(R2)** table width capped (max 920px, 280px actions col) — killed the huge empty gap. **(R3/D1)** every row now shows a COPYABLE/WATCH/UNPROVEN/AVOID copyability badge + the DNA role (WHALE/SNIPER/ACCUMULATOR) inline. **(R4)** honest thin-DB hint: when wallets are all low-tier single-token (often Solana), explains WHY they score low and to harvest EVM tokens (Base/Arbitrum/ETH) for copyable S/A wallets — not a display bug, the honesty contract. **(R5/D3)** tier filter (all / S-A / copyable) + sort (tier/tokens/recent). **(L1-L4)** left bar rebuilt: short text label under every icon always visible (collapsed), group headers shown even collapsed, active item accent bar, unpinned-by-default. **(C1)** full-file broken-emoji audit — zero `\U`-escapes remain. **(C2)** unified table density across meme radar/whale board/ranking/feed. **(C3)** legend made opaque + z-layered (fixes garbled RSI/FLUX corner bleed-through) with finite-guards on both values. Tests: `tests/test_v243_ui.js` 20/20. Suite: 39 files green.

58. **v24.2 — confluence NaN cascade fix**: screenshot on the EUR/USD (yfinance proxy) feed showed the whole XAI panel broken — "Strong Sell **NaN**", "agreement **NaN%**", "score **NaN ± NaN** · FRAGILE". Root cause: an indicator returned a non-finite value on the thin forex feed, and `confluence()` propagated it into the score. Fix: `confluence()` now **sanitizes every signal** (non-finite dv/strength/weight → neutralized), guards each contribution, and clamps the final score + agreement so they can never be NaN; all-NaN input → honest neutral 0. The XAI robustness (signal-dropout) block shows an honest "not enough clean signal data to test robustness" blank instead of "NaN ± NaN" when a feed is too thin. Tests: `tests/test_v242_nan.js` 9/9 (NaN inputs → finite outputs, known-answer). Suite: 38 files green.

57. **v24.1 — UI bug-fix pass + chart expand fix + rail polish**: from a screenshot showing "U0001f4b0 holdings" literal text, ugly ranking table, no whale-board remove, unorganized rail. **(broken emoji)** 7 invalid `\U0001f...` Python-style escapes in JS strings converted to valid `\u{1F...}` — they were rendering as literal text; now show as real icons. **(ranking table redesign)** rows rebuilt as a tight institutional data-grid: tier badge + score, wallet + nickname + evidence + confidence on one line, compact action cluster (copy · dashboard · track · nickname · explorer) — no more huge gaps/tiny fonts. **(whale board)** ✕ remove button on every row → drops from the follow list and calls new server `/svc/onchain/unwatch` to stop tracking. **(chart Expand fix, C1/C3)** the maximize toggle now clears the inline grid override so it both expands AND restores cleanly (Esc works); `syncAppGrid` guards against fighting chart-max. **(hybrid rail + favorites + ⌘K)** always-visible group accent tab + labels so structure shows even collapsed, Favorites group emphasized and labeled, ⌘K hint on the rail search. **(honest scope note)** chart already had VWAP/Bollinger/EMA-ribbon/Supertrend/full-SMC/drawing-tools/Heikin-Ashi/measure; C11 symbol-compare + C13 on-price smart-money markers deferred rather than risk blind draw-loop surgery without a browser. Tests: `tests/test_v241_fixes.js` 13/13 + unwatch service test. Suite: 37 files green.

56. **v24.0 — DATA→DECISION: verdict engine, Opportunities Desk, decision modes, F1/F2/F4/F5/F6, rail reorg**: `tokenVerdict` (WATCH/RESEARCH/AVOID + conviction 0-100 + F4 confidence + F5 named flags + F7 regime), `walletCopyability` (COPYABLE/WATCH/UNPROVEN/AVOID), `feedRead` (F6 $ context/tier/adding-reducing). Opportunities Desk shortlist (`buildOpportunities`/`renderOpportunities`) atop Smart Money, one-tap actions. Meme radar Verdict column (A1). Live feed interpreted (A3). F1 server `daily_brief_loop`. F2 `pinAdd`/`pinDiff` watchlist-with-state. Rail reorg: TRADE·SMART MONEY·DISCOVER·AI & SIGNALS·STRATEGY·TOOLS·SYSTEM. Tests: test_v240_verdict.js 25/25 + test_service_v240.py 4/4. Suite 35 files green.

55. **v23.1 — dashboard reachability + Solana holdings fixes** (from live screenshot: "holding info useless, no dashboard, can't copy, Solana broken"): **(Solana holdings)** wallet dossier now fetches SPL token holdings via the public Solana RPC `getTokenAccountsByOwner` — Solana wallets show real holdings instead of "unavailable"; transfer history honestly marked N/A (needs a paid indexer, not faked). **(dashboard reachable everywhere)** co-holding cluster wallet addresses and live-activity feed wallet addresses are now clickable links that OPEN the full DNA dashboard — previously only the ranking table's button did. **(copyable)** co-holding token addresses and feed wallet addresses got ⧉ copy buttons. Tests: `tests/test_v231_dashfix.js` 11/11. Suite: 33 files green.
55. **v23.1 — Solana readability + confirm-the-build**: from a screenshot showing plain-text co-holding, useless holdings, dead Solana clicks — root cause was a **stale cached build** (v23.0 already made co-holding wallets clickable, feed rows clickable/copyable, and the DNA dashboard render). Genuine fixes this round: **(Solana holdings readable)** SPL mints resolved to symbols/names via Jupiter's verified token list (cached in `window._jupTokens`), readable symbol when known and short-mint fallback otherwise (never faked); **(build confidence)** a live **v-badge** on the Smart Money desk header (`v23.1 ✓ live`) so a stale cache is instantly obvious after Ctrl+Shift+R. Regression-guarded: co-holding `.codash`/`.cocopy`, feed `.feeddash`/`.feedcopy`, ranking `.smcopy`, DNA dashboard all re-verified in tests. Tests: `tests/test_v231_solana.js` 12/12. Suite: 33 files green.
54. **v23.0 — WALLET DNA ENGINE + full dashboard + power features + tracking→Telegram**: **(DNA ML, all pure+tested)** `walletDNA` assembles a behavioral fingerprint from transfer timing/direction: `dnaStyle` classifier (BOT via interval-CV, SNIPER/SCALPER/SWING via hold-time, ACCUMULATOR/DUMPER via buy%), `dnaHoldTime` (median + band), `dnaConsistency` (entropy of hold-bands → copyability), `dnaAffinity` (meme/defi/stable lean from holdings), `dnaTiming` (peak UTC hour → session), `dnaRisk` (DISCIPLINED/ELEVATED/RECKLESS), and a precise role label (WHALE/MARKET MAKER/WINNER-proxy/SNIPER/ACCUMULATOR/DUMPER/BOT/RUGGER-INSIDER) each with a plain-language "what it does". **(full dashboard)** the wallet dossier now leads with the DNA card (role + 6 facet chips + evidence) above the portfolio-summary strip, live holdings, and buy/sell history. **(D3)** `smartMomentum` group risk-on/off gauge; **(D4)** `earlyEntryRadar` (≥2 S/A wallets in one token); **(D2)** `walletCompare`. **(Telegram refined — track = subscribe)** no per-card send buttons; when you ★ track a wallet the client sends a DNA snapshot and the service Telegrams a "NOW TRACKING — role/style/risk" subscribe message, then auto-streams its buys/sells/flips. Tests: `tests/test_v230_dna.js` 25/25 (18 DNA known-answers + 7 power) + `tests/test_service_v230.py` 4/4. Suite: 32 files green.
53. **v22.1 — theme-apply fix + TradingView chart maximize + Smart Money portfolio**: v22.0's institutional theme didn't stick because `applyTheme` never persisted and the default sat behind a fragile gate — now persists `mishel_theme` + a startup block applies saved-or-institutional on EVERY load. TradingView-style ⛶ Expand collapses rail+side (Esc restores, redraws). Wallet dossier gains `portfolioSummary` (accumulating/distributing bias, buy/sell%, most-active token). Tests: test_v221_fixes.js 15/15. Suite 30 files green.
52. **v22.0 — INSTITUTIONAL UI redesign** (user: professional, not gamer; buttery-smooth; pro rail): new **Institutional theme** set as first-load default (respects any saved choice) — professional graphite surfaces, a single restrained slate-blue accent (#5B8DEF, zero neon), calmer candle green/red, hairline borders, soft depth shadows, uppercase data-grid table headers with row-hover, focus rings on inputs. **Pro left rail**: buttery width transition on pin/unpin (cubic-bezier), active view = accent left-bar + subtle surface lift (not heavy fill), pinned mode lays out as clean horizontal rows with full labels, quiet uppercase section headers, icon hover micro-scale. **Buttery polish**: smooth view fade on tab switch, refined thin scrollbars, 140ms micro-transitions on buttons/chips/inputs. **Chart smoothing = Option A** (safe): debounced rAF resize + smoothed interactions, the canvas draw loop left untouched (no blind render-loop surgery). Fully additive CSS + non-breaking JS — every feature/ID preserved (regression-guarded in tests). Tests: `tests/test_v220_ui.js` 22/22. Suite: 29 files green.
51. **v21.0 — SMART MONEY POWER ENGINE (X1-X2 + P1-P12)**: **(X1/X2)** Solana holder data via GoPlus solana endpoint — Scout + Mass Harvest now work on Solana/pump.fun tokens; harvest accepts EVM+Solana with an honest "N non-scannable rows skipped" count (fixes the "Nothing to harvest" on Solana radars). **(P1)** `walletIntel` composite 0-100 score with **S/A/B/C/D tiers**, every component listed on hover. **(P12)** confidence weighting from independent-token count. **(P2)** auto-rank: every Scout/harvest silently re-ranks the desk + 45s auto-refresh. **(P4)** top-tier (S/A) wallets pushed to the service (`/svc/onchain/dbwallets`); new `db_alert_loop` Telegrams DB-wide moves — your whole watchlist becomes the sensor. **(P5)** Token→Smart-Money view: paste a token, see which DB wallets are in it, ranked. **(P6)** `clusterDetect` Sybil/ring detection (circular-partner graph → one operator). **(P7)** round-trip leaderboard (`/svc/onchain/leaderboard`, `profitProxy`): on-chain buy→sell cycles, honestly labeled NOT realized PnL. **(P8)** CSV export/import of the ranked DB. **(D1)** wallet nicknames + private notes (`mishel_wnick`), shown everywhere. **(P10)** dossier feeds the sizer. Tests: `tests/test_v210_engine.js` 16/16 (tier truth, cluster, profit-proxy, token-view, CSV, confidence) + `tests/test_service_v210.py` 3/3. Suite: 28 files green. Next: full UI redesign (v22.0).
50. **v20.1 — critical fixes from live screenshot**: **(left bar showed no change / Smart Money missing)** the v20.0 regroup assumed nav buttons were nested a certain way and silently no-op'd on the real DOM — rewritten to **rebuild the rail groups from scratch non-destructively** with an orphan SAFETY NET (any unmapped button lands in a MORE group, so nothing can ever vanish); groups: TRADE · INTELLIGENCE (Smart Money first) · ON-CHAIN · MARKETS & TOOLS · STRATEGY · SYSTEM, live counts, persisted collapse. **(Token Dossier "not working" on a pump.fun address)** the pasted address was Solana with an empty chain select; added **Solana to the dropdown**, **auto-detect chain from address shape** (0x+40hex = EVM, base58 = Solana), and gated GoPlus to EVM-only with an honest "GoPlus is EVM-only — DexScreener price/liquidity still real" note instead of a dead card. Confirmed there is no separate "Intermarket ML" nav — the cross-market ML is the right-panel **Cross-Market Intelligence** card (merged) and the left-bar item the user saw was the distinct **Intelligence Lab**. Tests: `tests/test_v201_fixes.js` 11/11. Suite: 26 files green.
49. **v20.0 — SMART MONEY INTELLIGENCE DESK** (flagship, user-selected scope A+B+D5-D8+smart Telegram): new left-bar view. **(B1)** auto-harvesting Wallet Database — every Scout run classifies wallets into localStorage `mishel_walletdb` (whale/maker/early/risky counts, tokens, chains, manipulation flags, evidence). **(B2)** Mass Harvest — scouts every token from the Launch+Meme radars (≤12, 1.3s rate-limit, live progress, stop button). **(B3)** cross-token Smart-Money Ranking — `smartScore`: category weights (early 3× · whale 2× · maker 1.5×) × log2 distinct-token multiplier × **(D8)** 14-day half-life recency decay; every component listed on hover; risk wallets excluded and shown separately. **(B4)** Wallet Dossier — live Blockscout holdings (`token-balances`), recent BUY/SELL stream, classification evidence, **(D6)** freshness flag from real `counters.transactions_count` (≤10 txs = FRESH insider-tell, ≤50 young). **(B5)** Manipulation Patterns — `manipFlags`: circular A↔B (≥2 each way) + rapid flip-flop (≥4 direction changes) with counts, "patterns, never accusations". **(D5)** Co-Holding Clusters — tokens shared by ≥2 DB wallets. **(B6)** Live Activity feed — service `/svc/onchain/events` first, direct Blockscout fallback, 60s auto-refresh on view. **(D7)** whale-flow vs price divergence — dossier callout `divergenceRead` (top-10 delta vs 24h price: ACCUMULATION INTO WEAKNESS / DISTRIBUTION INTO STRENGTH). **(server ML — the copy-signal engine)** `smart_copy_loop` in mishel_service: records every followed-wallet transfer to `wallet_events` (SQLite, hash-deduped) and Telegrams SIGNALS not spam — pure tested ML: `flow_state` EWMA signed flow (6h half-life) fires "STARTED SELLING" on ACCUM→DISTRIB flips and accumulation onsets; `burst_score` Poisson-style last-hour vs 24h baseline; `convergence` ≥2 followed wallets buying the same token in 6h; new-token first-buys; ≤6 tg/cycle, seen-key dedup, every message ends "you decide · not advice". Route `GET /svc/onchain/events`. **(A1)** Confluence(XAI) nav removed (content reachable via "Full XAI report ↗" link in the chart side panel). **(A2/A3)** rail regrouped by use case — TRADE · INTELLIGENCE · ON-CHAIN · STRATEGY · TOOLS · SYSTEM — with live counts in headers. Tests: `tests/test_v200_smartdesk.js` 28/28 + `tests/test_service_v200.py` 12/12 (flow-flip, burst, convergence known-answers on the SHIPPED module). Suite: 25 files, all green.
48. **v19.0 — VISIBILITY build** ("features exist but the user can't see them" is a design failure, fixed at the root): **(sidebar)** the left rail now loads **pinned/open by default** — groups, search, and the Frequent section visible immediately; collapsing is remembered (`mishel_pin!=='0'`). **(merged ML you can SEE)** new **X-MKT chip in the chart header** next to price/consensus/ATR — regime · anomaly (red ⚠ on stress) · top rotation leader/laggard; tooltip states the same read votes as checklist gate 6. **(Scout first)** Smart Wallet Scout moved to the TOP of On-Chain Desk + 🎯 bridge button in the holder tracker (prefills, scrolls, runs). **(connection truth)** "stale" → per-class states: crypto "reconnecting…", forex/stocks "FX/stocks: key or proxy needed" with exact-remedy tooltip — EUR/USD was honest behavior badly labeled. **(topbar bleed)** stray "no…" was #feedTxt overflow — clamped with ellipsis. Tests: tests/test_v190_visibility.js 15/15 incl. panel-order asserts. Suite: 23 files green.
47. **v18.5 — Intelligence pack + root-cause fixes** (from live v18.0 screenshots): **(🎯 Smart Wallet Scout)** the flagship — paste any token contract and `scoutWallets` categorises its wallets from real public data with fully transparent reasons: 🐋 whales (≥1% non-contract holders), ⚖ two-way churners (≥3 in AND ≥3 out, balanced flow — market-maker-like), ⏱ early accumulators (received among the first 20% of recorded transfers AND still holding — explicitly disclosed as the closest honest proxy for "profitable trader", since realized PnL cannot be verified from free data), ⚠ risk wallets (deployer, owner, YOUR rugpuller-registry hits, and insider-allocation patterns: received directly from deployer + holds ≥5%). Each wallet: copy, chain-correct explorer, ★ follow (tracker + server alert registration) or 🚩 flag straight into the registry; contracts never suggested; empty categories say so. Data: GoPlus holders + Blockscout transfers with honest per-chain "transfers unavailable" notes. **(bottom-bar fix)** the "no live feed while REAL DATA showed" contradiction: the SRC label now uses the exact same liveness formula as the status tail (`online && (isCrypto||_realFeed) && _lastTick < 90s`) and never wraps — states: live source name / "stale" / "offline · X armed". **(HTML escape bug)** v18.0 shipped literal `\u2605` text in Whale Board HTML (escapes only work in JS strings) — swept 16 raw escapes in HTML regions to real characters, scripts untouched. **(ML merged into analysis)** the cross-market worker is now the 6th objectivity gate in the trade checklist: iForest+Mahalanobis anomaly = "Cross-market STRESS … stand aside" failing gate; honest "warming up (not blocking)" before data. **(left rail)** new Frequent group at the top that learns your 4 most-used views from clicks (localStorage `mishel_navuse`, ≥3 uses, clones proxy-click the originals) + first visit on wide screens starts with the rail pinned so the organization is visible. Tests: `tests/test_v185_scout.js` 26/26 (known-answer scout fixtures incl. insider pattern and registry cross-check). Suite: 22 files, all green.
46. **v18.0 — MASSIVE consolidation build** (user: "not 1 by one override"): **(addresses everywhere)** New-Launch Radar rows now show the contract address inline with ⧉ copy, a verified buy link, and a 🔎 per-row dossier jump (fills the Dossier panel and runs it); the Meme Radar main table shows address + copy directly (no ⊕ needed). **(🐋 Whale Board)** new On-Chain panel merging locally saved wallets + the server `/svc/onchain/watch` list (dedup) — every followed whale in one table with copy, chain-correct explorer link, and a one-tap "verdict ▷" that loads the tracker for the ACCUMULATING/DISTRIBUTING read; auto-renders on view open; explicit "whether to copy is always your call". **(source health)** Settings gains a Data Source Health board: fires one tiny REAL request at each of the 7 providers from the user's own browser and reports latency or the exact error, with an honest CORS note — what passes there is exactly what the chart failover can use. **(offline honesty)** forcing a source while in Offline mode now warns loudly in red and the status label shows "offline/synthetic · <src> armed — go Online"; this was the "data sources problem" (forcing looked dead because the terminal honestly refuses to synthesize). **(merged intelligence)** the chart-side card is retitled **Cross-Market Intelligence — CORR · ROTATION · REGIME**: correlation/anomaly ML and the rotation strip are one brain in Chart & Analysis; rotation now renders within 1.5s instead of waiting 15s. Tests: `tests/test_v180_massive.js` 27/27 incl. regression guard on all v16–17 features. Suite: 21 files, all green.
45. **v17.1 — visibility & coverage fix pack** (from user's live v17.0 screenshot): **(fix) top bar overlay** — the v16.1 SRC pill crowded the center cluster; removed from the top bar and relocated into the bottom status bar (always visible, never overlaps) with the same Auto/7-provider forcing + live real-vs-synthetic label. **(fix) left rail** — search box now also appears on hover-expand, not only when pinned (why nothing looked changed in icon mode). **(feature) whale wallet ADDRESSES** — the holder table now gives what was actually asked for: per-wallet ⧉ copy of the full address and a **★ follow** button that loads the whale into the Wallet Tracker (accumulation/distribution verdict) AND registers it with the service whale-alert loop (`POST /svc/onchain/watch`, ≥$10k transfers → Telegram; honest toast when the service is down); explorer links are now chain-correct via `explorerUrl` (15 chains, /account/ for Solana, null for unknown — never a wrong-chain link). **(coverage) Opportunity Scanner** — the hard 8-coin cap is now a depth selector (8/15/25/40, default 15). **(coverage) Meme Radar** — merges DexScreener boosts + token-profiles feeds (dedup by chain:address), cap raised to 60; result message names the sources. **(feature) rotation strip** — the Intermarket ML card now carries a live ROTATION line (top LEADING/LAGGING vs BTC from real cached bars, honest <3-symbol state, one-click jump to the full quadrant) so rotation and correlation read as two different lenses in one card. Tests: `tests/test_v171_uifix.js` 25/25. Suite: 20 files all green.
44. **v17.0 — FINAL consolidation of the "user asks" arc (v16.1→v16.4)**: full suite now 19 test files, all green (320+ assertions against SHIPPED code); verify harness clean; version bumped in 3 places. Deferred honestly: C1 smooth engine / C6 docks / replay overlay (browser-verified session), footprint (user feed), live network paths (user machine).
43. **v16.4 — RRG rotation quadrant + left-rail UX** (something genuinely different from the chart): `rrgCalc`/`rrgQuadrant` — JdK-style relative-strength index (ratio vs benchmark, normalized to its 20-bar mean) and 5-bar momentum, LEADING/WEAKENING/LAGGING/IMPROVING quadrants, 5-point tails; SVG quadrant + table panel in Market Heatmap, auto-refresh on view open. Honest: only symbols with ≥40 REAL cached 1h bars are plotted, benchmark named, "nothing synthetic is plotted here" empty state. **Rail UX**: view search box (pinned mode, Enter jumps to first hit), collapsible groups persisted in `mishel_railgrp`, active-group gold highlight, hover states. Tests: `tests/test_v164_rrg.js` 16/16 (quadrant truth table, accelerating outperformer→LEADING, mild turnaround→IMPROVING known-answers, short-series refusal).
42. **v16.3 — U3 news markers on chart + TV2 Pine v5 export**: `newsParse` now extracts epoch timestamps (`t:null` when unparseable — never guessed); `newsMarkerIdx` buckets timestamped items onto visible bars (merge count, high-impact flag); new "News markers" chip draws purple diamonds + dashed drop-lines (red for high-impact calendar events), honest hint when no feed is loaded. `pineExport`/`pineCond`/`pineTerm`/`PINE_MAP`/`PINE_DECL` — full Pine v5 strategy() exporter: 26 rule variables mapped 1:1 (EMAs, RSI, MACD trio, stoch, BB, ADX/DMI, supertrend dir with convention note, VWAP, ROC, MFI, CCI, W%R), crossabove/crossbelow→ta.crossover/under, ATR-mult & pct stops, R-multiple & pct targets, short side, exit-rule strategy.close; Mishel-custom vars (flux, div) are NAMED as unsupported and their rules dropped — never approximated. "Pine v5 ⤓" button downloads .pine next to Run backtest. Tests: `tests/test_v163_newspine.js` 19/19.
41. **v16.2 — Meme Scanner PRO**: every radar row gains a ⊕ expansion with the full **contract address + one-tap copy** (clipboard with prompt fallback), **verified buy links only** (Jupiter/Raydium for Solana, PancakeSwap for BSC, Uniswap with chain param for ETH/Base/Arbitrum/Optimism/Polygon; unknown chain → honest "no verified DEX link", never invented), a transparent **opportunity score** `oppScore` (momentum + vol/liq turnover + buy pressure + age sweet-spot − rug-risk penalty, every component named in notes, OPPORTUNITY/WATCH/PASS), per-row **full safety dossier** (buildDossier refactored to accept (addr,chain,out) — still UI-compatible), and a 4-step how-to-buy safety checklist ending "This terminal never executes trades". Tests: `tests/test_v162_memepro.js` 18/18.
40.5. **v16.1 — Sources pack**: three more free public providers — **OKX, KuCoin, Gate.io** — with unit-tested pure arg/row mappers (`_okxArgs/_okxRows/...` — column remaps, sec→ms, newest-first reversal, honest empty throws); failover chain is now Binance→Bybit→Kraken→Coinbase→OKX→KuCoin→Gate.io with honest toasts; **SRC picker in the top bar** (Auto or force any of 7 providers via `FORCE_SRC` + `window._PROV` registry, reloads live symbol) and a live source label refreshed every 2s showing exactly which feed is real vs offline/synthetic. Tests: `tests/test_v161_sources.js` 15/15.
40. **Layout System v4 — structural UI overhaul**: **top bar decluttered** — theme picker, dark/light, density and fullscreen moved into a clean **⋯ overflow menu** (with Appearance/Tools/Help sections: export PNG/CSV, tour, shortcuts, self-test); every top-bar control normalized to a 34px rhythm; the timeframe bar is now a contained segmented pill. **Side panel no longer disappears on tablets/phones** — it becomes a **slide-over drawer** (◧ floating button, smooth transform, tap-outside closes). Chart toolbar reads as one glass strip; side cards tightened (12px rhythm, smaller caps headers); readable max-width for text views; quieter status bar.
39. **Crypto Futures asset class + leverage/liquidation + planner bug fix**: new **Futures** tab with 10 perpetuals (BTC/ETH/SOL/XRP/BNB/DOGE/AVAX/LINK/PEPE/SUI-PERP, each with maxLev). Live data routes to **Binance Futures**: klines via fapi.binance.com, streams via fstream.binance.com; Derivatives card (OI/funding) works on them natively. **Leverage selector** in Quick trade (sets demo margin; shows ~liq long/short hints on futures). **Liquidation math** `liqPrice(entry,side,lev,mmr)` — the Trade Planner shows the est. liquidation on futures and **warns '⚠ inside stop!'** when leverage would liquidate before the stop. BUG FIX: plan 'Execute on demo' wrote to nonexistent inputs (qQty/qSL/qTP) so the plan's stop/size were silently ignored — now fills the real ticket (pQty/pSL/pTP) and clears risk-% override.
38. **20 more crypto pairs + buttery chart physics**: crypto universe expanded to 26+ pairs (AVAX, DOT, LINK, POL, LTC, TRX, SHIB, UNI, ATOM, NEAR, APT, ARB, OP, PEPE, SUI, TON, ICP, FIL, INJ…) with a **generic Binance mapping** so every one live-streams when online (synthetic price seeds are placeholders; live data overwrites). Chart got **physics**: **inertial panning** (drag-release glides with friction, velocity-tracked, cancels on grab) and **eased zoom** (wheel/keys/double-click animate bar-count with cubic easing) — the smoothness layer TradingView is known for.
37. **Risk Desk over real positions + Setup Scanner + consensus strip + custom layouts**: `portfolioRisk()` now computes **1-day 95% VaR & CVaR (USD and % of equity), gross/net exposure, portfolio heat (sum of risk-to-stops vs a 6% guardrail), pairwise correlations and crowding warnings** over the ACTUAL open demo positions (returns from cached live bars where available, seeded synthetic otherwise — honestly labeled). Exposed as the `get_portfolio_risk` agent tool and a 'portfolio risk / VaR / correlation' analyst intent. **Setup Scanner** in the Watchlist view: min |consensus| + near-VWAP + divergence filters, ranked results table (live vs synthetic flagged), click-to-load. **Watchlist editing** (+ Add symbol dropdown, ✕ per card). **Consensus-momentum strip** — a sparkline of the score's own history in the analytics card. **Custom named layouts** ('💾 Save current as…' in the Layout dropdown, persisted when persistence is on). UX micro-polish: button press feedback, staggered card entrances, :focus-visible rings, hover states for scanner rows.
36. **Derivatives panel + trade planner + TV-feel chart + chat clear + idle-time AI**: new **Derivatives card** — live **open interest, OI notional, funding rate (+crowding read), next-funding countdown, mark price** from Binance Futures free public endpoints (crypto, on demand, direct fetch with automatic proxy /fetch fallback — nothing simulated). New **Trade Planner card**: one click builds a full disciplined plan (entry, structure/ATR stop, TP ladder from the level ladder with R multiples, size in lots/units at 1% risk, checklist verdict, counter-trend warning) with **Execute on demo**. Chart got TradingView-feel: **time tag** on the crosshair's bottom axis, **double-click resets zoom**, **←/→ pan, +/- zoom**, ResizeObserver for instant reflow. **AI chat Clear button** (🗑 wipes the conversation + agent memory). Efficiency: the 18-indicator accuracy replay now runs in **idle time after paint** (requestIdleCallback) — recompute never blocks the chart.
35. **Professional-grade pass: persistence + reliability + performance + onboarding**: (1) **Opt-in persistence** — 'Remember my setup in this browser' (Settings → Workspace): theme, chart type, indicators, panes, drawings, demo account & alerts survive reloads via guarded localStorage (session-only if unavailable; untick to clear). (2) **Reliability** — global error boundary (errors toast + recover instead of crashing) and an in-app **self-test panel** (13 known-answer checks: SMA/EMA vectors, RSI/ATR bounds, HA/Bollinger invariants, consensus bounds, robust stats, aVWAP, sizer math, accuracy range, annealer≥baseline) with a Run button in Settings + palette. (3) **Performance** — the heavy 18-indicator accuracy replay is now cached per symbol|timeframe and refreshed only every 20 bars (was every recompute). (4) **Onboarding** — a 6-step first-run tour (auto-shows once), a **? help overlay** with all shortcuts, and palette entries for both.
34. **Voice + splash + lots fix + XAI + annealing optimizer**: fixed the **position sizer** — forex/metals/indices now show **lots** (units/contract, with '1 lot = 100,000 units' note); crypto shows units. All **side cards are collapsible** (click the header — chevron animates), including Signal drivers. **Voice**: 🔊 reads the analyst's last answer aloud (Web Speech TTS, markdown stripped) and 🎤 voice input (SpeechRecognition — Chrome/Edge; honest fallback elsewhere). **Startup splash** with brand, progress bar, staged loading messages, smooth fade. **XAI**: the factor scorecard now shows each factor's weight and measured hit-rate. **Quantum-inspired annealing optimizer** (`annealCategoryWeights` — honest label: simulated annealing, not quantum hardware) tunes trend/momentum/volatility/volume weights to maximize historical hit-rate; 'quantum/optimize' analyst intent reports optimized weights vs equal-weight baseline. Distinct nav icons for Watchlist (star), Screener (funnel), Multi-chart (grid).
33. **Accuracy-tuned AI + on-canvas pane close + categorized indicators + bug fixes**: the consensus is now **data-driven** — `indicatorAccuracy()` replays 18 indicators' votes over the last ~250 bars and measures each one's forward hit-rate on THIS instrument/timeframe; `consensusSignal` multiplies vote weights by measured accuracy (75% hit → ×1.5, 35% → ×0.7). With live data (online) the analyst is tuned to the real market and says so; a new **accuracy intent** ('which indicators are most accurate') lists best/worst with hit rates, and the agent's `get_analysis` exposes `most_reliable_indicators_here`, `tuned_to_history`, `live_data`. UX: **on-canvas × close buttons** on every sub-pane and the volume panel (TradingView-style, hover pointer, syncs the toggles); the indicators dropdown is now **categorized** (Trend / Levels / Smart Money / Signals / Volume & Profile / Context) with a boot-safe guard. Fixes: area-chart dead code, apostrophe escape.
32. **Legend fix + premium font + collapsible volume + polish**: fixed the **legend readability bug** (RSI/FLUX now sit in a readable glass pill with proper spacing, only active EMAs shown). Upgraded the UI font to **Plus Jakarta Sans** with antialiasing/legibility rendering (crisper, more premium). Made the **volume panel collapsible** (Vol toggle in the pane controls — collapses and hands the space to price, TradingView-style), alongside the RSI/MACD/MFI panes. Busy top bar now horizontally scrolls on mobile.
31. **Futuristic interface layer (v3)**: a full modern glass/glow pass — **glassmorphism** (backdrop-blur + translucency via `color-mix`) on the top bar, nav rail, side panel, status bar, panels, dropdowns and controls; layered **ambient mesh gradients** + a masked **grid texture** behind everything; **glow accents** on active nav pills, buttons, chips, and status dots; an animated **shimmer hairline** under the top bar; **gradient headings**. Theme-aware (works across Binance/TV/TrendSpider/Midnight/Light) and safely gated with `@supports (color-mix)` so older browsers keep the solid look; honors reduced-motion.
30. **Dropdowns + chart types + layouts + fluidity**: added a **chart-type dropdown** — Candles, **Heikin-Ashi**, Bars, **Line**, **Area** (`CHART_TYPE`, HA computed from OHLC). A **searchable symbol dropdown** in the top bar with a **consensus badge per row** + sparkline-quality read, click-to-load, and the button reflects the current symbol. A **layouts dropdown** (Scalp / Swing / Clean / Full presets that set timeframe, overlays, panes, and chart type in one click; `applyLayout`). All also reachable via the command palette. **Fluidity pass**: pop-in/scale animations on palette/menus/symbol-dropdown, smoother view transitions, reduced-motion support.
29. **Multi-theme system (Binance / TradingView / TrendSpider)**: added a **theme engine** with premium presets that reskin the whole app via CSS variables — **Binance** (black + #FCD535 gold, #0ECB81/#F6465D), **TradingView** (#131722 navy + #2962FF blue, #26A69A/#EF5350), **TrendSpider** (deep bg + #22D3EE cyan), plus Midnight (default) and Light. 'On steroids' accent glows on nav/buttons per theme. A **theme picker** in the top bar + **command-palette** theme switches; candle colours re-memoize on switch. `applyTheme()` is the single control.
28. **Design refresh + responsive + undo/redo + context menu**: a **visual design pass** (premium nav-rail active pills, gradient/inset panels & buttons, refined chips/inputs/focus rings/scrollbars, tighter typography) to shed the basic look. **Responsive/mobile layout** (side panel collapses ≤1024px; compact rail/top bar ≤600px; horizontal-scroll toolbar; full-width palette). **Undo/redo stack** for drawings (Ctrl-Z / Ctrl-Shift-Z / Ctrl-Y, 60-deep, snapshots every mutation). **Right-click context menu** on the chart (horizontal/vertical line, anchored VWAP, trend tool, clear — all at the clicked price/bar). **Density / font-scale** button (Aa) with default/comfortable/compact presets.
27. **Command palette + shortcuts + watchlist + news/calendar + alerts inbox**: added a **Command Palette (⌘/Ctrl-K)** that fuzzy-jumps to any symbol, timeframe, indicator, view, tool, or action (export, theme, density…). **Keyboard shortcuts**: timeframe digits 1-9, `\` drawing toolbar, `r`/`m` RSI/MACD panes, `i` indicators. New **Watchlist** view (mini-sparkline + 20-indicator consensus badge + confidence per symbol, click to load). New **News & Economic Calendar** view (fetches via the proxy `/fetch`, auto-parses CryptoPanic / Finnhub / FMP-calendar shapes, with a free-source list). **Alerts inbox**: 🔔 bell in the top bar with an unseen badge → the alerts log. Quick wins: **export chart PNG / OHLCV CSV**, **density toggle**.
26. **Consensus engine + indicator pack + objective analyst + indicator dropdown**: added a **robust-statistics layer** (median/MAD/winsorize — outlier filtering) and a **12-indicator pack** (StochRSI, OBV, CMF, Keltner, Donchian, Aroon, Vortex, Choppiness, TSI, Ultimate Osc, HV, Z-score). Built a **multi-indicator Consensus engine** (`consensusSignal`) that combines 20+ indicators into one **accuracy-weighted score (−100…+100) with a % agreement/confidence**, ADX-gated, by category (trend/momentum/volatility/volume). Rebuilt the analyst to be **objective**: consensus headline, a **probability lean** (from agreement, not opinion), and a **bias-reduction checklist** (trend-aligned? agreement≥50%? not over-extended by z-score? volatility not an outlier spike? ADX strength?) to minimise emotional/biased entries. Market Analytics card is now a **consensus focus panel** (big score, confidence, category bars, checklist). UX: a **collapsible Indicators dropdown** (📊, shows active count) so the chart stays clean.
25. **Anchored VWAP · divergence scanner · agent memory · chart-image · external data**: added an **Anchored VWAP** drawing tool (click any bar to anchor). Added a **Divergence Scanner** overlay (`divScanAll` across RSI/MACD/MFI, markers on chart). The LLM agent gained **session memory** (`get_session_memory` — viewed symbols, trades, alerts, logged via `memLog`) and **chart-image reasoning** (📷 sends the rendered canvas to the vision model). Settings gained a **③ External data** section to wire your own news / economic-calendar / order-flow endpoints (with a curated free-source list), fetched via a new proxy `GET /fetch` passthrough. True footprint/L2 flagged as needing a paid tick feed.
24. **Offline analyst → multi-factor reasoning engine**: rebuilt the built-in (no-key) Desk Analyst. It now computes a transparent **bull/bear factor scorecard** (trend, EMAs, ADX, RSI, MACD, VWAP, confluence, money-flow, order-flow, patterns, divergence — each weighted with a reason), a **sorted level ladder** (VWAP/PDH/PDL/PWH/PWL/session/Fib/predictive-range/auto-trendline projections split into resistance-above / support-below with % distance), **scenario planning** (bull/bear triggers off the nearest levels), and it's now aware of your **positions/exposure, journal edge, and can run the backtest**. New intents: why/drivers, targets, momentum, multi-timeframe, session, account, journal, backtest.
23. **Agentic AI Desk Analyst (tool-use)**: upgraded the AI Analyst to a real **tool-using agent** — the LLM calls the terminal's actual functions (`get_analysis`, `get_levels`, `get_account_risk`, `get_journal_stats`, `run_backtest`, `position_size`) so every number is grounded in live data, not hallucinated. Client-orchestrated loop (browser executes tools, proxy `/ai` passes through to Anthropic with tool schemas; legacy single-shot still supported). Read-only tools — no order execution.
22. **AI Desk Analyst + profile tools**: added an **AI Analyst** view — a chat that reads the live glass-box analysis (confluence, trend, regime, levels, patterns) and answers in plain language, working **offline with no key**; optionally routes to a **real LLM via the proxy** (`POST /ai`, server-side `ANTHROPIC_API_KEY`). Upgraded the **Volume Profile** to draw **POC + Value Area (VAH/VAL)** and added a **Market Profile (TPO)** overlay (time-at-price). Footprint/order-flow flagged as needing real bid/ask tick data.
21. **Interactive drawings + multi-chart crosshair**: drawings are now **click-to-select** (nearest-drawing hit-testing, pointer cursor on hover) with **⌫/Delete to remove** the selected one (Esc to deselect) — selection shows amber handles and a Del hint. Multi-charts gained a **hover crosshair + OHLC readout** (O/H/L/C + % change box, price tag on the axis) per panel. Undo/clear reset the selection.
20. **Premium indicators + fullscreen/minimize + bigger multi-charts**: added LuxAlgo-style overlays — **Nadaraya-Watson Envelope** (Gaussian kernel-regression band) and **Predictive Ranges** (ATR-stepped adaptive range) — plus a **Money Flow (MFI) sub-pane**. Top bar can now **minimize** (▴, floating restore) and there's a **Fullscreen** toggle (⛶) for a bigger view. **Multi-charts are larger** (height scales with layout: single ~470px) and now show **volume bars**. Added smooth view fade-in transitions.
19. **Sub-panels + raindrop + MTF auto-analysis**: added **indicator sub-panels** — RSI and MACD render in their own panes below price (RSI/MACD toggle buttons in the top bar); the price/volume layout stays pixel-identical when no pane is active. Added a **Raindrop / volume-at-price** overlay (per-bar VWAP bubbles sized by volume — a raindrop-inspired view; true tick-level raindrops need intraday data). Added **multi-timeframe auto-analysis** in the MTF view: auto-trendlines + auto-Fib + bias computed independently across 15m/1H/4H/1D with a summary table.
18. **Auto-detection + futuristic UI**: added **automatic trendline detection** (`autoTrendlines` — fits the best-respected support/resistance lines from swing pivots, fewest violations) and **auto-Fibonacci** (`autoFib` — anchors to the most significant recent swing, 0→100% levels), both as toggle chips that render on the chart (TrendSpider-style). UI polish pass: ambient radial glows, smooth transitions, active-state glows on nav/chips, gradient logo, hover depth on cards.
17. **Honest backtesting + journal edge analytics**: the backtester now applies a **round-trip cost** (spread+commission+slippage, in bps — input in the header) to every trade, so marginal strategies correctly flip to losing; added **in-sample vs out-of-sample R** stats (70/30 split) as an overfitting check; the **walk-forward chart now plots the real equity curve** split at 70% (was synthetic). Demo Trading gained a **Journal edge** panel: expectancy ($/trade), win rate, profit factor, payoff (W/L), avg win/loss, **avg R**, and breakdowns **by side and by symbol** — computed from your closed trades.
16. **Cross-platform launchers**: added a universal **`run.py`** (Windows/macOS/Linux, plus Android via Termux/Pydroid and iOS via a-Shell), a double-click **`run.command`** for macOS, and rewrote `run.sh`/`run.bat` to delegate to it. Added **`HOW_TO_RUN.md`** covering every platform including **iPad/Android** (open directly, host on GitHub Pages, or run a phone-side Python server) and LAN proxy setup for mobile live data.
39. **v16.0 — FINAL "Cat 2-8" milestone build**: version consolidation of the v15.1→v15.4 arc below. Full suite: 15 test files (10 prior + 5 new), all green — 252+ assertions against shipped code; verify harness clean (CSS balanced, `node --check` main+WSRC, ID census); version bumped in 3 places. Honest deferrals carried in HANDOVER: C1 smooth render engine and C6 multi-pane docks (core canvas-loop surgery needs interactive browser verification), footprint/delta charts (need a user-supplied order-flow feed), live LLM vision reads and live on-chain fetches (need the user's ANTHROPIC_API_KEY / real network — code paths ship with honest empty states and were logic-tested).
38. **v15.4 — AI Desk + Infra pack** (Cat 7+8): **(7) Confluence Narration** — `narrateConfluence` turns the live consensus + objectivity gates into an ordered deterministic checklist narration (no LLM; failing gates named; verdict line advises standing aside when gates fail). **(7) Morning Brief** — `buildMorningBrief` assembles a deterministic brief (price/regime/session/consensus/nearest ladder levels/journal edge) with one-tap "send to Telegram" through the service `/svc/notify`; honest footer on every brief. **(7) MTF Vision Read** — sends the actual rendered chart canvas + a 1H/4H/1D consensus table to the vision LLM via the local proxy; hard-gated behind `proxyBase()` with an honest no-key state, offline MTF rows labeled synthetic-seeded. **(8) Kraken + Coinbase failover** — two more free public providers chained after Binance→Bybit in `fetchKlines` (XBT mapping for Kraken, granularity maps, honest toasts naming the switch, `_feedSrc` label updated). **(8, server) Whale-flow alerts** — `whale_loop` polls Blockscout for wallets registered via `POST /svc/onchain/watch` and fires Telegram on transfers ≥ min_usd (pure `big_transfers` filter never guesses USD when rate/decimals are missing). **(3, server) New-pair auto-scan** — `pair_scan_loop` polls DexScreener latest profiles, SQLite-dedups (`onchain_seen`), optional Telegram ping (`pair_scan_tg` config), always logs. **(8, server) Watchlist OHLC cache** — `POST/GET /svc/data/ohlc` persists bars in SQLite (PK upsert, 2000-bar cap per push). Also fixed the v15.3 regime ribbon to POST closes (matching the real `/svc/ml/regime` contract) and accept `labels` responses. Tests: `tests/test_v154_aidesk.js` 15/15 (narration structure/honesty, brief content exactness) + `tests/test_service_v154.py` 14/14 (big-transfer USD math, dedup, OHLC round-trip/upsert/rejection, watch routes) — service tests run the SHIPPED module via flask test_client.
37. **v15.3 — Analytics pack** (Cat 4): **Correlation & Lead-Lag Matrix** (Intelligence Lab panel 8) — pairwise log-return Pearson matrix across the watchlist plus a ±8-bar cross-correlation scan (`leadLagBest`; lag>0 = A leads B) listing the strongest lead-lag pairs; computed on the same series the watchlist shows and explicitly labeled synthetic-seeded while offline. **Meta-Labeling Gate** (panel 9, López de Prado's idea, honest small version) — logistic model (`metaLabelFit`, gradient descent, z-normalized with TRAIN-only stats) on [side, ADX, RSI, ATR%, hour] fitted to the first 70% of the last backtest's real trades and judged ONLY on the last 30% (`metaLabelGate`); refuses <30 trades or <8 OOS; verdict says plainly when features don't separate winners. **Regime Ribbon + Feature Store** (panels 10/11) — service consumers with honest offline states. Tests: `tests/test_v153_analytics.js` 18/18 including a KNOWN-ANSWER lead-lag (b = a delayed 3 bars → lag 3 detected exactly, symmetric −3), planted-signal gate uplift >0.3R with >90% kept-WR, and a noise run that claims no fabricated edge.
36. **v15.2 — On-chain pack: whale numbers · rugpuller registry · token dossier · wallet flow · +15 coins · +6 chains** (Cat 3, user-priority): **Whale numbers** — `whaleStats` on every holder scan: whale count (≥1% excluding contracts/locked), combined whale %, top-1, top-10, contract share, and a LOW/ELEVATED/HIGH/EXTREME concentration grade in a stat grid. **Rugpuller Registry** — protective screening: "mark token as rug" on any holder scan remembers the GoPlus `creator_address`/`owner_address` in `mishel_ruggers` (dedup by deployer, merges chains+tokens); every future scan and dossier flags tokens by known ruggers ("KNOWN RUGGER — you marked N of their tokens"); manual flagging + removal in a new registry panel; included in Config Export. **Token Dossier** — one card merging DexScreener (best-liquidity pair) + GoPlus security + whale numbers into a deterministic verdict (`dossierVerdict`: AVOID on hard flags [honeypot / known-rugger deployer] or ≥4 flags; HIGH RISK / CAUTION / NO RED FLAGS FOUND), with per-source honest failure lines — a dead source is named, never filled in. **Wallet flow** — `walletFlow` turns any tracked wallet's fetched transfers into per-token ACCUMULATING / DISTRIBUTING / CHURNING verdicts (±15% net-flow threshold) so whale behavior is readable at a glance; explicitly framed as ideas you copy manually at your broker. **More coins**: 15 new SPECS (WIF, BONK, FLOKI, SHIB, SEI, TIA, JUP, RENDER, FET, ONDO, ENA, PENGU, HYPE, TAO + PEPE already present). **More chains**: GoPlus +blast/linea/scroll/zksync/fantom/cronos; Blockscout +arbitrum/zksync/scroll/linea. Tests: `tests/test_v152_onchain.js` 28/28 (whale math known answers, flow verdicts, registry lifecycle incl. case-insensitive owner match, dossier grading incl. rugger-deployer → AVOID with no other data).
35. **v15.1 — Charting pack: AVWAP σ-bands · drawing templates · axis heat** (Cat 2): every Anchored-VWAP drawing now renders **±1σ/±2σ volume-weighted bands** (`avwapBandsFrom`: vol-weighted mean + vol-weighted variance from the anchor, exact math verified against hand-computed two-point cases); **named drawing templates** — a drawbar button saves the current drawing set under a name (`mishel_drawtpl`), applies any saved set to any chart (deep-copied; honest note that absolute bar positions may sit off-screen on different history lengths), deletes with `-name`; **axis heat** — a new "Axis heat (vol@price)" indicator chip paints a volume-at-price heat strip along the right price axis (`axisHeatBuckets`, per-candle volume spread across its H-L range, normalized). Scope-verified against the real `draw()` locals before hooking. Tests: `tests/test_v151_charting.js` 17/17.
34. **v15.0 — Seasonality / time-of-day edge finder** (Cat 4): a new panel under the Strategy Tester buckets the backtest's **real** trades by the session and UTC hour they were *entered* (mapped from the actual candle timestamp `DATA[entryI].t`), and reports **win-rate with a 95% Wilson-score confidence interval** plus **average R and total R** per bucket. Sessions use the shipped London/NY clock (`sessionBucket`: Asia <8, London <13, London/NY overlap <17, New York <22, After-hours). Honesty first: the whole panel needs ≥12 trades before it renders anything; buckets under 5 trades are dimmed and flagged `n<5` rather than trusted; the verdict only calls out a best/worst session when the mean-R gap clears a threshold and (via the CI bars) isn't just small-sample noise — otherwise it says "no time-of-day edge here," which is an honest result, not a failure. Nothing is synthesised to fill empty buckets. Pure functions `wilson`/`sessionBucket`/`seasonalityStats`. Verified: 16/16 known-answer + invariant tests on the shipped source (`tests/test_seasonality.js` — Wilson bounds & CI-tightening, all session boundaries, bucket arithmetic, insufficient-sample flagging, out-of-range-entry safety) + the shared integration harness below; full suite green; `node --check` main+WSRC; CSS balanced; version bumped 3 places.
33. **v14.7 — Overfitting audit: PBO via CSCV + Deflated Sharpe** (the explicitly-deferred companion to v14.2's MC-bootstrap/PSR robustness work): a new panel under the Strategy Tester runs a **real stop-multiple × target-R parameter sweep** (5×5 = 25 genuine `runStrategy` passes on the loaded data — not a fabricated sweep), then applies **Combinatorially-Symmetric Cross-Validation** (Bailey, Borwein, López de Prado & Zhu 2017): the per-bar net-R of each config is time-aligned, the bars are cut into S even blocks, and across every C(S,S/2) train/test split the in-sample best-Sharpe config's **out-of-sample rank** is turned into a logit λ; **PBO = P(λ≤0)** = probability the tuned result is overfit. Alongside it, the **Deflated Sharpe Ratio** (López de Prado 2014) discounts the best config's Sharpe for the **number of trials tried** (expected-max-Sharpe under the null via `expectedMaxSR`/`normInv`), the **dispersion of trial Sharpes**, and the **series' skew & kurtosis** — reusing the shipped `_skew`/`_kurt`/`normCdf`/`sharpeR`. Renders PBO %, DSR %, best-config Sharpe, SR₀, configs-tested/traded, split count, a plain-English verdict (Holds up / Fragile / Likely overfit), and a logit histogram (mass left of 0 = overfit). Honest guard: if fewer than 2 configs clear an 8-trade floor it shows *no* PBO rather than a misleading one. Pure functions `_combos`/`normInv`/`cscvPBO`/`expectedMaxSR`/`deflatedSharpe`/`sweepStrategyConfigs`. Verified: 18/18 known-answer + invariant tests on the shipped source (`tests/test_overfit_audit.js` — combos counts, normInv/normCdf round-trip, dominant-edge→low-PBO, PBO∈[0,1], more-trials-deflates-DSR, losing-series→DSR<0.5, refusals), plus a **real end-to-end integration harness** (`tests/test_audit_integration.js`, 9/9) that extracts the actual indicator+strategy engine from the shipped file and drives genData→runStrategy→sweep→CSCV(252 splits)→DSR→seasonality with no stubs; full suite green (11 files); `node --check` main+WSRC; CSS balanced; version bumped 3 places.
32. **v14.6 — Power Pack: config backup · signal attribution · backtest explainer · wallet watchlist · session shading** (one flagship per requested category 2/3/4/7/8): **(8) Config Export/Import** — a Backup & Restore panel in Settings serialises every `mishel_*` localStorage key (themes, watchlists, strategies, alerts, tracked wallets, prefs) to a JSON file and restores it on any machine; round-trip pure functions `collectConfig`/`applyConfig` unit-tested. **(4) Signal Attribution** — a “Why this score” breakdown in the Confluence view: `attributeConsensus` gives each module's additive share of the weighted consensus (`vote×w/Σw×100`), which sums to the score and makes neutral votes exactly 0; rendered as a diverging bar chart, auto-updates every recompute. **(7) Backtest Explainer** — a deterministic plain-language read under the Strategy Tester stats: `explainBacktest` turns the real numbers (PF, per-trade Sharpe, PSR, OOS/IS, max DD) into strengths/weaknesses + a verdict (Promising / Mixed / Weak / Insufficient), no LLM, no invented claims. **(3) Wallet Watchlist + Holder-Change** — On-Chain Desk gained a ★-save wallet watchlist (persisted `mishel_wallets`, click to reload+scan, ✕ to remove) and holder-concentration change tracking (`mishel_holdersnap` → the whale/holder check now shows top-10 %Δ since your last check). **(2) Session Shading** — discovered the London/NY shading was already coded and toggleable (“Sessions” chip); enhanced it to add the Asia session so it's the full 3-session picture. Verified: 24/24 pure-logic tests (config round-trip, attribution sign+sum-to-score+neutral=0, explainer verdict classification, holder-Δ arithmetic, session-hour bands) extracted from shipped code in `tests/test_v146_power.js`; 6/6 DOM render smoke-tests (attribution/explainer/wallet-list render + honest-empty states); full suite green; `node --check` main+WSRC; CSS balanced; ID census clean; version bumped 3 places. **Scope note:** the user asked for all of categories 2/3/4/7/8 (~25 features); building all in one pass would break the verification standard, so this stage ships one fully-verified flagship per category and queues the rest (see HANDOVER).
31. **v14.5 — Windows UTF-8 crash fix (proxy + service start reliably)**: the data proxy (`ddt_data_server.py`) crashed instantly on Windows with `UnicodeEncodeError: 'charmap' codec can't encode character '\u2192'` — a `→` arrow in a startup `print()` that the default cp1252 console (and redirected log files) can't encode. The v14.4 watchdog correctly caught the crash-loop and surfaced the traceback. Fix: added a UTF-8 output preamble (`sys.stdout/stderr.reconfigure(encoding='utf-8', errors='replace')`, wrapped in try/except) to the top of `ddt_data_server.py`, `mishel_service.py`, and `start_mishel.py`, and opened the watchdog's child log files as UTF-8 — so every print is Unicode-safe regardless of console encoding or redirection. Reproduced the crash under `PYTHONIOENCODING=cp1252`, confirmed the proxy then prints the arrow line cleanly and `/health` returns `{ok:true}` in that exact environment. index.html unchanged except the version string.
30. **v14.4 — service/Vision-Desk fixes + On-Chain Desk (whale / wallet / new-launch)**: **Fixed the background service.** Two stacked bugs kept it down (hence Desk Narrator “service unreachable” and the Windows “auto-close”): (1) `mishel_service.py` called `migrate()` at import before `cfg()` was defined → `NameError` that crashed it for everyone — moved the call below `cfg`/`log_event`; reproduced the crash and confirmed `/svc/health` now returns `{ok:true}`. (2) Missing Python deps (`flask_cors`, `yfinance`). Hardened all launchers: `run_service.sh`/`.bat` and `start_mishel.py` now install `requirements.txt` when imports are missing, keep the window open / tail `service.log` on failure, and `start_mishel.py` gained a crash-loop guard (after 3 quick deaths it stops restarting and prints the log instead of looping silently). **Fixed the AI Vision Desk.** Its `guard()` checked a `useLLM` variable that wasn’t in scope (`typeof useLLM==='undefined'` was always true), so Second Opinion / Devil’s Advocate were permanently gated — they showed “Needs the vision LLM” even when enabled. Now it reads the real `#aiUseLLM` checkbox + `proxyBase()`, so it reaches the vision path once you enable LLM-via-proxy (still needs `ANTHROPIC_API_KEY` on the server). **On-Chain Desk** (new nav view) with three real-data panels: **New-Launch Radar** (DexScreener `token-profiles/latest` → newest listings, newest-first, same rug-risk screen), **Whale/Holder Tracker** (GoPlus top-holders + top-10 concentration + LP-lock, EVM), and **Wallet Tracker** (Blockscout keyless ERC-20 transfers for any address). Reuses the v14.3 rug-risk/normalizePair helpers. **Boundary held on “buy before launch”:** built as honest early-detection + risk screening — it never buys, never touches wallet keys, and isn’t a moon predictor; new launches are flagged as overwhelmingly-rug territory. Every panel shows an honest empty state when a feed is down — zero fabricated tokens/holders/transfers. Verified: on-chain helpers 19/19 in dev + 9/9 shipped (`tests/test_onchain.js`: GoPlus holder %/top10/LP-lock parsing, Blockscout transfer decoding for 18- and 6-decimal tokens, in/out direction, launch-freshness bands), meme scoring 18/18, robustness 23/23, plus DOM/fetch render smoke-tests confirming all three panels render and all three scans hit honest error paths without throwing; service boot verified live; launcher shell/py syntax checked; `node --check` main+WSRC; CSS balanced; nav↔view consistency confirmed; ID census clean; version bumped 3 places; 3 new in-app self-test checks. Sandbox can’t reach DexScreener/GoPlus/Blockscout (browser-runtime + not allowlisted) so live fetches weren’t exercised — logic + honest states were.
29. **v14.3 — data-source diagnostics, guardrail toggle, more strategies, Meme Radar**: a batch across five areas. **(A) Forex “Failed to fetch” → actionable diagnostics** — the forex/stocks live-test caught the raw network error and printed a bare “✗ Failed to fetch”; it now detects a proxy-unreachable failure and explains it: start `server/ddt_data_server.py` (or the launcher), or switch Provider to Twelve Data (in-browser, no proxy). **(B) Demo guardrail is now optional, default OFF** — the daily max-loss / 3-loss lock that blocked demo trading is gated on a persisted `PAPER.guard` flag (off by default per request); an Enable/Disable toggle sits in the demo guard box, and `checkGuard()` no-ops when off, so demo trading is never blocked unless you opt in. **(C) Five new backtest strategies** — Williams %R Reversal Scalp, ROC Impulse Scalp, ADX Trend-Strength Intraday, MFI Money-Flow Intraday, Triple-EMA Ribbon Swing; each routes through a new `specFor` branch (inserted first so its unique keyword wins) to a real, distinct rule spec using supported indicator tokens — verified 7/7 that they produce real specs and existing strategies still route correctly. **(D) Three new Hedge Desk structures** — Calendar Spread (theta-differential), Covered Call (income + payoff diagram), Vol-Target Overlay (inverse-vol sizing from real `IND.atr` realised vol); buttons + real modeled legs/framework added. Note: the desk already had 6 working strategies (funding/pairs/carry/collar/beta/grid) — now 9. **(E) Meme Radar** (Screener view) — an honest real-data DEX-token screener: pulls actually-trending tokens from DexScreener (token-boosts → tokens endpoints), scores transparent **rug-pull risk 0–100** (liquidity, age, churn, float-vs-FDV, socials, and — on demand — GoPlus honeypot/tax/LP-lock/holder-concentration/mint flags) plus a descriptive **momentum** score, sorted safest-first, with a prominent extreme-risk disclaimer. It is explicitly **not** a “will-moon” predictor — building a fabricated moon oracle would violate the no-fake-data contract and is irresponsible on the highest-risk crypto class; when a feed doesn’t respond the panel shows an honest empty state and **zero** synthetic tokens. Scoring verified 18/18 (honeypot forces EXTREME via a hard floor; monotonic in tax/LP/concentration; bounded), plus a DOM/fetch render smoke-test confirming the honest-empty error path. Full suite green; `node --check` (main+WSRC), CSS balanced, ID census clean, version bumped 3 places; 4 new in-app self-test checks. Sandbox can’t reach DexScreener/GoPlus (browser-runtime + not allowlisted), so live fetches weren’t exercised here — logic and honest states were.
28. **v14.2 — REAL backtest robustness + statistical honesty**: removed a fabrication and replaced it with genuine analysis. The Robustness panel's “parameter sweep” heatmap was **`mulberry32` random noise** dressed as swept results (a fake “coherent island”), and the walk-forward **synthesised a random equity curve** when real data was thin — both violated the no-fake-data contract. Now: (1) **Monte-Carlo trade bootstrap** — the actual net-R trade series is resampled with replacement into 600 alternate histories at 1% risk/trade; the panel draws the real **median path + 5–95% band**, and a readout reports **P(profitable), median outcome, 5–95% band, and risk-of-ruin (≥50% drawdown)**. (2) **Probabilistic Sharpe Ratio (PSR)** — Bailey & López de Prado; P(true Sharpe>0) after adjusting for the series' skew, kurtosis and length — added to the stat row alongside a **proper per-trade Sharpe** that replaces the old `return/drawdown×1.3` proxy (which was computed but never even displayed). (3) **Real walk-forward** — built from the actual trades split at 70% by entry index; when there are <4 out-of-sample trades it prints an honest “insufficient OOS trades” notice instead of drawing anything. Thin-data guards throughout (needs ≥20 trades to resample; refuses honestly otherwise). Verified: PSR asserted against its closed form, normCdf against known values (0.5/0.975/0.99), Sharpe sign/zero-variance safety, MC-bootstrap invariants (bounded P, ordered percentiles, seed-deterministic) — 23/23 in `tests/test_robustness_stats.js` (extracted from shipped code), plus a DOM/canvas render smoke-test across all three branches; 6 new checks in the in-app self-test; node --check (main + WSRC), CSS braces balanced, ID census clean, version bumped 3 places. **Deferred (needs a real multi-config param sweep): PBO via CSCV + Deflated Sharpe** — queued next.
27. **v14.1 — FROST VISUAL SET (T1+T2+T3+C2)**: a coherent visual stage built on one idea — a **unified surface recipe (T3)**. Every frosted chrome surface (rail/top/side/status/cards) now derives from a single set of CSS custom properties (`--surf-rgb/-a/-blur/-sat/-bord`) instead of the hand-tuned rgba+blur values that had been duplicated and re-overridden across the v13.1/v13.3/v13.6 layers; the new block is the winning layer (source-order + !important) and reproduces the v13.6 deep-glass look while making it retunable in one place. The rail keeps its v13.5 floating-dock full border (recipe only retints it). On that base: **T1 monochrome-frost theme** (`data-theme="frost"`) — a cool, desaturated icy palette (slate bg, icy blue-grey accent replacing gold, muted-teal bull / dusty-rose bear), its own cool body wash and `.run` skin, a near-monochrome icy aurora, and a frost override of the surface recipe (cooler/lighter/less-saturated); added to the theme dropdown and command palette. **T2 aurora dimmer** — aurora opacity is now a single `--aurora-op` knob (Off/Subtle/Balanced/Vivid) in Settings + a palette cycle, persisted (`mishel_aurora`); the light-theme aurora honours the knob via calc. **C2 muted candle skin** — an independent-of-theme candle skin that mutes the canvas up/down colours toward a cool slate (34% toward #7E8A9E); covers BOTH the 2D path (`var_bull`/`var_bear` via `_candleTint`) and the GPU path (GLR.begin), with the two implementations Node-tested for **exact colour parity across all 7 themes** (43/43 logic asserts incl. monotonic-toward-grey, null-safety, regression anchors); Settings select + palette toggle, persisted (`mishel_candle`). Visual-only stage: no data path touched, honesty contract intact. Verified: node --check (main + WSRC worker), CSS braces balanced (915), ID census clean, 15 exact-string atomic patches, version bumped 3 places.
26. **v14.0 — system status pill + proxy auto-discovery (L2/L3)** *(reconstructed — the prior session bumped the version markers to v14.0 but did not leave a changelog entry; this line is recovered from the shipped code)*: a background health prober pings the proxy (`:8787/health`), the service (`:8788/svc/health`, incl. telegram flag), and ML, painting a **system status pill (L3)**; when the proxy is discovered and the Settings proxy field is empty it **auto-configures it once (L2)** and toasts. No data fabrication; purely connectivity/status surfacing.
25. **v13.6 — dock collapse + deeper glass**: ‹ button at the dock foot hides it entirely (persisted); a slim edge handle › restores it; chart redraws on both. Glass transparency deepened across rail/top/side/status/cards (alpha .22–.38, blur up to 42px, saturate up to 2) with light-theme variants; aurora opacity raised.
24. **v13.5 — pipeline + depth ladder + outcome ledger + floating dock**: (1) **Signal→Plan→Telegram**: opt-in Settings toggle; when consensus flips (|score|≥25, hysteresis, boot-baseline so it never fires on load, ≥10 min spacing, LIVE fresh data only) the full disciplined plan (entry/stop %/TP ladder with R:R/size at risk %) is pushed to Telegram, with counter-consensus and delayed-feed warnings inline. (2) **Bybit L2 depth ladder** in the Order Flow view: real order book (orderbook.50) + trades tape via Bybit public WebSocket, 12 levels/side with size bars and live spread; crypto-only with an honest notice for other classes (never simulated); auto-disconnects when the view closes. (3) **Signal Outcome Ledger** in the Intelligence Lab: strong consensus reads recorded (one/15 min/symbol·TF, live data only), self-scored against actual price at +1h/+4h, hit-rates tabulated per symbol·TF — a true forward test, delayed-feed entries marked. (4) **Floating dock rail**: the rail is now a detached rounded glass dock (18px radius, border, shadow, inset margins) — visually distinct rather than another flat column; !important where six generations of legacy rules fight.
23. **v13.4 — rail redesigned, tooltip clipping solved**: the rail's `overflow-y:auto` forces overflow-x to clip (CSS spec), so every CSS hover-flyout label since v5.x has been cut off by the rail's own box — unfixable by styling. Tooltips are now a single **body-level position:fixed element** driven by JS (immune to clipping and stacking contexts), glass-styled in glass mode. One definitive rail layer ends the six-generation cascade war: 64px collapsed icon rail (40px rounded items, 19px icons, inset separators), 224px pinned with inline labels + group headers; the old .lbl flyouts retired with display:none.
22. **v13.3 — measure, don't assume + unmissable glass**: "599 missing bars / Data 0%" root cause — the gap classifier trusted the UI timeframe, but yfinance falls back to coarser bars on long intraday ranges, so a 15m request served as 30m bars flagged *every* interval as a defect. Gap markers, Data%, and the proxy nudge gate now classify against the **measured median bar spacing** (`barSpacingMs()`), and a granularity notice states the truth on-chart: "feed granularity ≈30m (requested 15m) — provider fallback" (Node-tested on the exact 600-bar tape: 599 missing → 0, Data% 0 → 100, notice fires). **Glass**: stored preference moved to a fresh key with a one-time reset to ON (an old off-toggle could keep glass invisible forever); runtime `CSS.supports('backdrop-filter')` detection with a Settings status line + toast when the browser/GPU can't render it (no more guessing); ambient upgraded to a slowly drifting four-color **aurora** layer (blurred, reduced-motion-safe) with brighter frost tints so vibrancy is visible even over a near-black workspace.
21. **v13.2 — bar-authoritative proxy feed + the rail that never went glass**: fixed the "curtain" corruption on delayed feeds — v13.0's wall-clock rollover is correct for real-time quotes (Twelve Data path keeps it) but wrong for a delayed bar feed: yfinance's last bar is always 15–20 min old, so `(now−t)≥TF` fabricated phantom `v:0` bars ahead of the provider's timeline, which the heal then merged real bars around (diagnosable in screenshots: zero volume under the corrupted section). The proxy ticker is now **bar-authoritative**: no local bar creation ever; the quote nudges the forming bar only while it is plausibly still forming (<3×TF old); new candles arrive solely from a 60s provider heal. `mergeBars()` rewritten as an **authoritative tail splice** (provider bars replace the overlapping local tail; sorted, strictly monotonic) which also purges phantoms already on screen — Node-tested with the exact corruption scenario: 6 phantoms → 0, monotonic ✓, tail = provider truth ✓, stale-nudge blocked ✓. Also found why the sidebar never looked glass **in any version**: the v5.4 rule `background:var(--panel2)!important` silently beat every glass tier since v12.8 — countered with matching `!important` on the vibrancy rail rules (dark + light).
20. **v13.1 — gap-classification fixes + macOS vibrancy**: fixed a v13.0 regression — the per-gap "session gap" text labels smeared into a solid orange band on gappy intraday data (gold 15M has dozens of session breaks); markers now classify gaps as **session closures (>6×TF, market closed — normal)** vs **missing bars (1.5–6×TF, real feed defects)**, draw only faint dashed lines for closures (capped at 60), and print one small summary line ("5 session breaks · 8 missing bars"). The **Data% quality metric** had the same flaw — it punished session instruments 2% per gap of *any* kind, flooring gold at 0% just for being closed overnight; now only genuinely missing bars reduce the score, with closures reported in the tooltip and a "· N brk" suffix (Node-tested: 5 closures + 8 missing → 84%, not 0%). **macOS vibrancy layer** (glass mode): the main pane goes transparent so the ambient light field shows through behind the workspace, and the rail/top/side/status get deep-blur translucency (blur 24–36px, saturate 1.6–1.9) with hairline borders and macOS-sidebar hover/active states, in both dark and light themes.
19. **v13.0 — FEED INTEGRITY PACK + visual overhaul**: fixed the "suspicious candles" root causes — `startLiveProxy` never rolled candles at TF boundaries (the old ever-growing-bar bug, fixed for the Binance WS path in #9 but never for the proxy path) and never re-fetched bars, so a chart left open silently absorbed hours into one distorted bar. Now: proper **TF rollover** (new candle opens at prior close), **`mergeBars()` history healing** every 2 min from the same upstream (Node-tested: heal/append/stale-ignore/rollover all asserted), and a matching 10-min re-sync on the Twelve Data ticker (1 credit / 10 min). The **live price tag** now reads the actual last bar instead of the last *visible* bar (was producing tag-vs-header mismatches when panned). **Vendor delay honesty**: yfinance feeds now badge as "REAL · delayed" in the status pill and footer — real data, honestly labeled as non-realtime. On-chart **session-gap markers** (dashed line + label where bar spacing > 1.5×TF) and **bad-print flags** (⚠ above bars with range > 6× median). **Glass tier rebuilt**: the v12.8 flat-rgba layer was overpainting the superior color-mix glass beneath it — replaced with a harmonized tier: theme-aware color-mix panels, ambient light field (gold/blue/teal radial glows) so the blur has something real to refract, light-theme variants. **Rail polished**: 38px rows, gradient group separators, stronger active state — the sparse floating-icon look is gone. Also fixed a latent v12.9 bug: `.imx-grid` hardcoded 4 columns, misaligning the correlation matrix when legs are excluded — columns now follow the actual leg count.
18. **v12.9 — Intelligence-layer DATA TRUTH + Telegram notifications**: fixed the Intermarket ML contamination — `series()` silently fell back to synthetic bars for any uncached leg, so correlations, z-spreads, anomaly detection, regime, and the SMT smart-money warning could be computed over fabricated XAU/10Y/DXY/ETH series in Online mode, and the anomaly flag even gated the Autopilot. Now: Online mode computes over **REAL legs only** (`seriesReal()` never fabricates); missing legs are named "unavailable — excluded"; below 2 real legs (BTC base required) the engine **pauses with an honest per-leg source card** instead of guessing. Real acquisition added: BTC+ETH legs browser-direct via Binance/Bybit (keyless), XAU via Twelve Data (10-min throttle), 10Y/DXY via proxy + FX-basket DXY as before. ML worker made **leg-count agnostic** (K×K matrix, spreads only for present pairs — functionally tested in Node with 3 legs), renderIMX names driven by the actual computation, SMT gated on real ETH, sources line now covers every leg. **Screener**: opening the view in Online mode runs the live proxy scanner; the synthetic preview is offline-only and labeled. **Telegram notifications**: Settings panel (BotFather token + chat ID, stored locally, sent only to api.telegram.org), Test + "Send analysis" buttons, `sendTG()` with throttle and error toasts, ⌘K snapshot command, and auto-send hooks on rule alerts, autopilot demo entries, and the kill-switch. Every message is framed as an **analysis snapshot — not a trade instruction**; execution stays with the trader at their own broker.
17. **v12.8 — Rail restructure + Glass tier + WebGL GPU renderer**: left rail rebuilt into **6 workflow groups** (Charting / Intelligence / Markets / Strategy Lab / Execution / Risk & System; 19/19 views placed, Intelligence Lab moved to Strategy Lab, Trade Calculator to Execution, Settings docked). **Glass interface tier**: frosted top bar/rail/status/cards via `backdrop-filter` (@supports-gated, light-theme variants, solid fallback), toggle in Settings + ⌘K, persisted, default on. **WebGL GPU renderer**: `draw()` still computes all geometry (glass-box single source of truth); when active, candle+wick rasterization is handed to a GL layer pinned under the transparent 2D canvas — one buffer upload, one draw call, theme-aware colors; grid/axes/indicators/SMC/drawings stay 2D on top. Bars/line/area + volume intentionally 2D. Auto-fallback to 2D when WebGL unavailable; `gpuInfo` reports the real GPU name (WEBGL_debug_renderer_info) and true renderer state. Known z-order nuance: FVG/OB translucent boxes now composite over GPU candles.
16. **v12.7 — Real forex/metals live ticks (Twelve Data browser-direct)**: fixed the Online-mode contradiction where forex/metals loaded real Twelve Data history but then animated **synthetic** ticks (`startLive` random walk) while the badge said "no live vendor". Added `fetchForexQuote()` (`/price`) and `startLiveForex()` — real quote polling on an 8s floor (free-tier safe), forming-candle updates + TF-boundary rollover from real prices only; on any error the chart **freezes** for the stale watchdog, never synthesises. REAL badge + hard-truth banner generalised from crypto-only to any real feed (`_realFeed`/`_lastTick`/`_feedSrc` heartbeat, set by Twelve Data and proxy tickers, cleared by synthetic/stop paths). No-vendor Online case now freezes honestly instead of simulating.
15. **Caching + more history + settings cleanup + sizer fix**: added a per-symbol/timeframe **bar cache** (`BAR_CACHE`) so switching timeframe/symbol repaints **instantly** (cached bars shown first, then refreshed); online fetch limits raised to **1000 bars** and synthetic to **600**, so you can pan back through real history and zoom like TradingView. Removed the now-redundant **Test connection** panel (each data-source section has its own test button; dsTest wiring guarded). Fixed the **position sizer** to show **USD** ($ notional) with units in parentheses.
14. **Zoom + performance + desk overlays**: rewrote wheel zoom to be **cursor-centered and proportional** (smooth, keeps the bar under the pointer fixed). Big perf win: **memoized the bull/bear colour lookups** (were calling getComputedStyle ~59×/frame) with theme-switch invalidation. Added a **VWAP + σ-band overlay** (chip) and a side-panel **Market analytics** card (trend, ADX strength, ATR% volatility, regime, RSI, distance to VWAP/PDH/PDL, order-flow pressure).
13. **Rebrand + dual test + countdown + drawing/patterns + multi-chart**: rebranded to **Mishel Intelligence Trading**. Added **separate Test-live buttons** for crypto and forex (independent of the loaded symbol). Added an on-demand **candle-close countdown** (⏱ top bar). Drawing gained **vertical line, arrow, and long/short position tools** (entry→target with auto risk zone + R:R). Chart-pattern detection extended with **rising/falling wedges, ascending/descending channels, and rectangles**, now rendered as real trendlines on the chart. Multi-chart is **rAF-throttled**, headers show **change% + RSI + bias**, and a **3×2 (6-panel)** layout was added.
12. **Separate crypto/forex sources + light-theme fix + heatmap detail**: data sources now route **independently** — a crypto provider (Binance direct-ws or Local proxy with yfinance/binance/alpaca upstream) and a separate forex/stocks provider — so each can use yfinance or its own feed; `goOnline` routes by symbol class, `fetchProxy`/`proxyQuote`/`startLiveProxy` take an explicit upstream. Fixed the **light theme** (top-bar gradient, tooltips, needle, toast, drawing overlays, and theme-aware chart grid/axis). Added a **heatmap detail panel** (click a tile) — key stats, a transparent technical-sentiment gauge (from indicators, clearly not social sentiment), and key facts; news/whale-flow are flagged as needing a live feed rather than faked.
11. **Demo account + theming + data-source split + multi-chart fix**: renamed Paper→**Demo Trading** with a MetaTrader-style account — Balance, Equity, **Margin**, **Free Margin**, **Margin Level %**, selectable **Leverage** (1:20–1:500), reset/deposit, and a live Balance/Equity chip in the top bar. Added a **light/dark theme toggle** (light palette via `html[data-theme=light]`; canvas chrome is themed via CSS vars, fine-tuning ongoing). Split **Data sources** into two labelled sections — ① Crypto (Binance, no key) and ② Forex/Stocks/Metals (Twelve Data / local proxy) — so provider routing is unambiguous. Fixed the **Multi-Chart** blank-panel bug (paint synthetic instantly, upgrade to live; retry draw until the canvas is laid out).
10. **Multi-chart + live strategy signals + UX**: added a **Multi-Chart** view (nav) — a 1/2/4-panel grid of independent mini-charts, each with its own symbol/timeframe, EMAs, last-price line, live Binance WebSocket stream, and glass-box bias header; click ⤢ to load a panel in the main chart. Added a **live strategy signal** card in the chart side panel (evaluates the selected strategy's own entry rules on the latest bar → BUY/SELL/FLAT with the trigger reason). Made the **drawing toolbar on-demand** (a pencil toggle; hidden by default). Cleaned the proxy's provider-name double-prefix in error messages (e.g. `binance: crypto only …`).
9. **Real-time streaming + chart polish**: replaced Binance REST polling with the **WebSocket kline stream** (`@kline_<tf>`) — authoritative forming candle with proper rollover (fixes the ever-growing last bar), smooth ticks, indicators re-synced on close/rollover. Default crypto endpoint moved to `data-api.binance.vision` (CORS-friendly, not geo-blocked). Added a **live current-price line**, a **bar-count control** (± / reset, plus wheel-zoom routed through it), and **rAF-throttled redraws** for the crosshair/pan/drawing/live paths (much smoother). Live feed re-subscribes on symbol/timeframe change.
8. **Live data + alerts + live screener**: added `server/ddt_data_server.py` — a CORS-enabled local data proxy over yfinance / Twelve Data / Alpha Vantage / Polygon / Alpaca / Binance (unified bar schema), wired into the front-end as a selectable "Local proxy" source. Replaced the **static alerts stub with a real edge-triggered engine** (price/indicator/confluence/BOS rules, browser notifications, triggered log, persisted in the workspace). Made the **screener pull real candles via the proxy** (synthetic preview retained). First module of the §7 Python backend.

---

*To continue: read this file + `AI_PROMPTS.md`, open `index.html`, and either edit in-app (visual editor, uploads, workspace) or hand the file + a prompt to an AI. When ready for the backend, use the "Convert to the Python backend" prompt.*

## v39.0 — SHELL (interface: professionalisation)

Five stages. No engine, strategy, risk or data-path logic was touched; every
change is chrome, geometry or copy. 1,377 assertions green (64 test files).

**Stage 0 — the shell had ten definitions.** `.app` grid: ~10 competing rules.
`.rail`: 12. `.top`: 6. `--status-h` was declared as BOTH 28px and 24px; which
won was decided by source order. One authoritative shell layer now sits last in
the stylesheet and everything is driven from tokens. `chart-max` / `focusmode` /
`topmin` were patched IN PLACE (not restated) because test_v261_hardening.js
forbids a second definition of the focusmode rule — and is right to.

**Stage 1 — top area.** 56px -> 44px, controls 34 -> 28px. Theme/density/
fullscreen folded into ⋯ (set once a year, they held four permanent slots). The
Bal/Eq chip — two static demo numbers — is replaced by DAY P&L / OPEN RISK /
LIVE SPREAD. The spread has existed since v36 (it feeds every strategy's costR)
and was displayed nowhere. 61 distinct emoji purged from the chrome; 8 icon-only
buttons given real inline SVG.

**Stage 2 — status bar.** 28px -> 34px, and it grew while total chrome shrank.
Nine identical 10px chips became three weighted clusters: SYSTEM TRUTH (mode /
source / freshness / jobs / sync, semantic colour) · CONTEXT (quiet, collapses
first) · POSITION TRUTH (open R / day R / daily-cap headroom bar, 2x weight,
red when the Governor blocks). Previously the freshness contract and the Risk
Governor — the only two things that can BLOCK a trade — were the same size as ATR.

**HONESTY FIX (v39.0).** The status bar hardcoded
"Mishel Intelligence Trading · synthetic data · not financial advice".
From v36, the moment MT5 became a provider, that string was FALSE on every real
tick — and it sat in the one place he looks 500 times a day. It is now a tag
derived from `Fresh.state()`: LOCAL DATA / REAL · DELAYED / BROKER · LIVE / STALE.

**Stage 3 — navigation.** THE LEFT RAIL HAS BEEN `#rail{display:none!important}`
SINCE v25.0. Twelve CSS strata and 21 nav buttons render nothing; the top tab bar
replaced it. The DOM and CSS are left inert on purpose (the command palette still
queries `.nav[data-view]`), and test_v390_shell.js now asserts the rail stays
explicitly dead so nobody "fixes" rail CSS again believing it ships. The tab bar
— which IS the navigation — went 40 -> 30px, emoji-free, 2px underline for active.

**Stage 4 — right panel.** 344 -> 320px. It was `grid-area` AND `position:fixed`
in two strata; settled on `grid-area`. Nine equal-weight cards in a 320px column
is a 3,000px scroll: the verdict is now a sticky hero that never scrolls away and
the rest collapse, remember, and are keyboard-operable. One card border colour,
not three. The resizer and both chevrons were pinned to `top:56px/63px/76px` — any
change to `--top-h` silently broke all three — now `calc(var(--top-h) …)`.

**Stage 5 — the lint (tests/test_v390_shell.js).** Goes RED on: an emoji in the
chrome, a shell token off-spec, a `--muted2` that fails WCAG AA, a re-hardcoded
top-bar offset, a re-enabled glass layer, or the "synthetic data" claim coming
back. Nobody added the ten `.app` grids on purpose; each was a reasonable local
fix. Only a test that fails stops the next twenty builds doing it again.

### TRAPS FOUND (v39)
- **A blanket emoji purge is a bulldozer.** The first pass turned
  `trend 🟢 3, momentum 🔴 2` into `trend  3, momentum  2` and emptied nine
  icon-only buttons. An emoji in FRONT of a text label is decoration; an emoji
  that IS the label, or that encodes a state, is load-bearing. The purge is now a
  curated REMAP (🟢->▲ 🔴->▼ ⚪->· ✅->✓ ⛔->✗ 🔒->LOCKED), and ★ is KEPT — it is a
  monochrome text glyph that inherits currentColor, not a colour emoji.
- **`applyTheme` did `themeBtn.textContent = '☀️'`** — which OVERWRITES the SVG that
  ships in the markup. The button was emoji-only in practice. Now sets an SVG.
- **A whitespace "tidy" in the purge ate HTML attribute separators**
  (`class="tbtn" id="fsBtn"` -> `class="tbtn"id="fsBtn"`). Codepoint removal ONLY.
  A leading space in a label is invisible; a mangled attribute list is a bug.
- **test_v261_hardening.js counts LITERAL string occurrences, comments included.**
  A CSS comment that spelled out the focusmode selector was counted as a second
  definition of it. The comment is now deliberately vague.
- **Six tests pinned a literal CSS string as a proxy for a behaviour** (four of them
  copy-pasting the same `.app.chart-max{...}` line). The shell went 3 rows -> 4 and
  they all went red for a change that did not touch what they were about. Re-based
  on intent — and test_v251_gridfix.js now asserts the REAL invariant it was always
  protecting: every `.app` grid has one row height per area row.

## v39.1 — RENDER AUDIT (fixes verified against a live screenshot)

v39.0 shipped with 1,377 green assertions and a VISIBLY BROKEN status bar. Every
assertion checked source strings; not one rendered the DOM. v39.1 fixes what the
screenshot showed and adds the two tests that make this class of failure
impossible to ship again.

**THE ROOT CAUSE.** Six modules locate their status-bar insertion point with
`st.querySelector('.s[style*="margin-left"]')`. That anchor WAS the "synthetic
data" disclaimer div. v39.0 deleted it (the CLAIM was false — right) but deleted
the NODE with it (wrong: it was a load-bearing anchor). `insertBefore(el, null)`
silently means appendChild, so every injected chip landed after the right-aligned
risk hero. LESSON: grep for consumers before deleting a node — a div can be data
and an anchor at the same time.

**Status bar (A).** `#stSlot` restored as the injection landing zone (matches the
legacy selector, owns the bar's ONLY `margin-left:auto`); flex `order` pins the
risk hero last even against blind appendChild; errBadge / nfBadge / stVer / stInfo
all re-homed into the slot. `Costs Costs REAL` fixed (static label + writer both
printed "Costs"). DAY/OPEN now live in the status bar ALONE; the top chip carries
the account tag + SPREAD only — one home per number.

**Bugs that predate v39 and were invisible until the DOM was actually rendered:**
- `#stClock` duplicated: the v7.0d wall clock collided with the v35 Jobs X-ray
  chip — the wall clock printed `--:--:--` for FOURTEEN VERSIONS. Now `#stWall`.
- `#pLev` duplicated across v-paper and v-settings: the settings leverage select
  was completely dead (getElementById bound the paper copy). Now `#pLevQ`, and the
  two mirror each other.
- `#aiClear` duplicated: the alert-inbox Clear collided with the AI-Desk
  conversation Clear. Now `#aiInboxClear`.
- The Bars/Regime/ATR ROTATOR (v11.x): hid two of three context chips on a 5s
  timer and BLANKED their wrapper ids (`el.id=''`), leaving three `id=""` husks.
  Retired — rotating information a trader is trying to read was never a feature;
  the v39 bar fits all three chips.
- `tools/split.py` HARDCODED `src/VERSION` to '35.0' — every re-split silently
  reset the version, and one release ran after a re-split and stamped v35.0 into
  the shipped page. split.py now derives the version from the page's own APP_VER.

**Confluence card (B).** Narrative prose was ~13px MONOSPACE — one card filled the
entire 320px panel. Prose is now UI type at 12px (mono is for numbers); section
headers are real labels; the narrative sits in a native `<details>` ("Full read",
ships closed); the sticky hero is capped at 46vh so it can never wall off the panel.

**Chrome rows (C).** The screenshot showed FOUR rows above the first candle
(~154px): top bar, tab bar, symbol-tabs+instrument-header, chart toolbar. The
instrument header was the THIRD place the price appeared — its price copies are
retired (`.ih-dead`, ids intact for their four writers); both remaining rows
compact to 32px. ~150px -> ~106px.

**Canvas (D).** Right-edge flags get a LANE REGISTRY (`window._flagLane(y,h)`) —
overlapping flags dodge downward instead of stacking (the RSI/FLUX/price pile-up).
The axis last-bar time label yields while the crosshair pill is live (same corner).
The drawing FAB moves below the canvas label lane. Native selects styled flat.

**THE TESTS (F).**
- `test_v391_dom.js` (jsdom, scripts OFF): duplicate ids, the injection-anchor
  contract, child order, single auto-margin, one-home-per-number.
- `test_v391_boot.js` (jsdom, scripts ON): BOOTS the shipped page with network/
  canvas/storage stubbed and audits the LIVE DOM — injected duplicates, id=""
  husks, runtime auto-margins, hero-last-after-injection. This is the test that
  caught what 1,377 source-string assertions could not.

### TRAPS FOUND (v39.1)
- insertBefore(el, null) is a silent appendChild. A missing anchor does not throw.
- getElementById + duplicate id = the FIRST element wins, forever, silently. Three
  separate features (wall clock, settings leverage, inbox clear) were dead for
  versions because of this. The boot test now makes it impossible.
- `el.id=''` leaves an attribute that still matches `[id]` selectors.
- A version lock (`sha256_of_source`) plus a version PIN in the splitter = a
  release that can silently time-travel. Locks must be derived, never pinned.

## v39.2 — SERVICE LOOP LIVENESS (the false alarm that hid real ones)

**THE BUG.** /svc/health judged every background loop against one 600s staleness
threshold, but backup_loop and data_loop slept 3600s between iterations,
heartbeat_loop 14400s, and daily_brief_loop exactly 600s. All four read STALE for
most of every cycle WHILE HEALTHY — the red "loops stale >10min" banner was a
false alarm by construction, on the exact surface that exists to catch silent
failure. The Telegram dead-man's heartbeat (>900s check) cried wolf the same way.
A false alarm trains the operator to ignore the alarm; then a real hang looks
exactly like Tuesday.

**THE FIX: liveness != cadence.** `sleep_ticking(name, seconds)` — a sleeping
loop keeps ticking every 20s while it waits; work still runs on its own schedule.
The single 600s threshold is now CORRECT for every loop, and a thread genuinely
hung inside its WORK (where hangs actually happen: network calls, DB locks) is
caught within minutes instead of being indistinguishable from a scheduled nap.
Six loops converted: backup, data, heartbeat, ledger, daily_brief, pair_scan
(the 30-180s loops keep bare sleep — 3x+ headroom). The client banner now prints
per-loop stale minutes and says the true consequence: "its work has NOT been
happening — restart mishel_service.py".

**THE GUARD.** tests/test_service_v392_loops.py: L2 proves a 120s wait ticks in
slices (time-compressed); L4 FAILS THE BUILD if any *_loop ever again contains a
bare time.sleep(>=300); L5 asserts every sleep_ticking name pairs with a real
tick name so staleness is attributed to the right thread.

NOTE: the running service must be RESTARTED to pick this up — the stale banner
you saw was produced by the old code and will clear on restart.

## v39.3 — V-FIXES + MACRO DESK

**V1/V2 (giant icon, invisible toolbar icons).** The v39 repair SVGs carried
viewBox but no width/height ATTRIBUTES; sizing lived in .top-scoped CSS. v32.1's
overflow collector relocated two of those buttons into the #tbOverflow popup —
outside every constrained scope — and the journal icon rendered at natural size,
crushing the menu; the toolbar's governor/recon/ritual icons were clipped by the
same mechanism. Style-by-location travels badly; attributes travel with the
element. All 53 button-child SVGs in the markup now carry width/height, plus a
global `button > svg{max-width:18px}` backstop that also caps JS-injected icons.

**V3 (dead show/hide chevron).** syncAppGrid wrote an inline
grid-template-columns — still computing a 216/74px column for the RAIL THAT DIED
IN v25 — and it LOST to the v39 `!important` shell rule, so the collapse click
changed a style that could no longer take effect. It now moves ONE CSS variable
(`--side-w-live`) that the single authoritative grid rule reads.

**V4.** The ⋯ popup inherits the design system; its labels carry words, not
OS-dependent pictographs (♨/🗺/🧪 escapes purged from injected strings too).

**MACRO DESK (the fundamental layer).** One card in the READ station: a driver
matrix per asset class. BTC: M2 tide, real 10Y, DXY, spot-ETF flow, stablecoin
float, funding, MVRV-z (from THIS terminal's accumulated history — honest about
being young), hash ribbon, halving day-count, BTC↔NDX correlation, Fear&Greed.
Gold: real 10Y, breakevens, DXY, COT managed-money net, federal debt, gold/silver
ratio, CB-buying (HONEST BLANK — no free feed exists), gold↔yield correlation.
Every row wears a SOURCE-TIER badge (LIVE / DAILY / WEEKLY / SCRAPE / MODEL /
KEY / QTR); a driver without data renders '—', never an interpolation; the
MACRO BIAS line is INFO-ONLY and says so on its face — never merged into the
price-signal verdict. No miner "cost floor $" is printed: a cost model without
electricity data is a guess wearing a suit.
Server: D8–D14 collectors in mishel_data.py (DeFiLlama, CoinMetrics community,
blockchain.info, extended FRED, Farside scrape, CFTC public API, FF calendar
mirror), each try-isolated; /svc/data/series endpoint for client-side z/trends.
NOTE: collectors are tested with MOCKED payloads (a test needing the internet is
a flaky test); live behavior needs the service restarted + FRED_API_KEY set.

### TRAPS FOUND (v39.3)
- **split.py regenerates src/ FROM index.html. A split run while index.html is
  stale silently REVERTS source edits.** This destroyed the first SVG-attr fix
  and produced an hour of contradictory evidence (source scans and built-file
  scans disagreeing). RULE: edit src -> release -> THEN split. Never split first.
- **A test can be the bug.** test_v393's first edition shipped double-escaped
  regex literals (\\d, [\\s\\S]) — its script-stripper stripped nothing and it
  reported 41 failures against builds both broken AND fixed. When a test's
  verdict contradicts a direct probe, diff the TEST's bytes before the build's.
- **bash double-quoted `node -e` mangles \" in regexes** — a shell-mangled probe
  reported the build clean while it was broken. Debug probes belong in quoted
  heredocs.

## v39.4 — SIDE-PANEL STABILITY (delegation) + PERF

**THE TWO BUGS WERE ONE BUG.** The ghost-text overlap in the screenshot and
"cards not expanding" shared a cause: the sticky Confluence hero sat OVER cards
scrolled beneath it and intercepted their header clicks; separately, v39.1's
per-<h3> listeners died whenever a renderer rebuilt its card's innerHTML.
Fix: ONE delegated click/keydown listener on #side (no innerHTML can kill it)
and the hero is simply first-in-flow — sticky removed, a nicety that cost two
bugs. The boot test now performs the killer scenario (rebuild a card's entire
innerHTML, then click) and fails if expansion ever dies again.

Also: `.side{overflow-x:hidden}` + fixed-layout MTF grid (no more horizontal
scrollbar / clipped 1D column), scout rows wrap instead of overflowing, thin
scrollbars, duplicate top-bar ⌘K hidden (the tab bar's remains — node kept, the
palette binding still lands), and perf: `contain:layout paint` +
`content-visibility:auto` on cards, and every 1s/5min repaint loop
(status bar, macro desk) now exits immediately while the tab is hidden.

## v39.5 — SIGNAL BRAIN + SCOREBOARD + EXIT GRID + AUTO S/R KEPT & FIXED

**THE COMPLAINT: "very few signals and mostly not accurate."**

**B2 SIGNAL BRAIN (js/69).** Online logistic regression (SGD, L2), trained on
the terminal's OWN resolved triggers — sigScan already labels every historical
trigger t1/t2/stop, a ready-made walk-forward training set (resolution needs
future bars that scoring never sees). Every trigger gets a 0-100 score that
DECOMPOSES on screen ("MTF +14 · session +8 · Q +11 · crowding -6") — a
reasoning trace, never an oracle. Features: Q, regime, session, side, ATR pctl,
MTF alignment, crowding, funding pctl, macro bias, candle-DNA, time-of-day.
Dedup by symbol|strat|bar so re-scans never double-teach; scratches teach
nothing. Under 60 examples it declares UNTRAINED and the gate falls back to
the legacy Q>=50 cliff verbatim — the Brain never gates on knowledge it does
not have. HARD LINES unchanged: no price prediction, no execution.

**B3 TIERS.** The Q>=50 cliff becomes A/B/C once trained: A+B surface (MORE
signals, each wearing its grade), C hidden. A-tier triggers push to Telegram
via /svc/notify with the score decomposition and a decision-support-only line.

**B1 SCOREBOARD + B6 DECAY (js/70).** Per-strategy record from the same
resolutions the Brain learns from (no second bookkeeping): win% with Wilson CI,
per-session split in the tooltip, and DECAYING flagged when the last-25 Wilson
interval detaches BELOW the full record — stop trading last year's edge.

**B4 EXIT GRID.** One click re-walks the current strategy's triggers under five
exit policies (TP1R / TP2R / breakeven-after-1R / 1.5xATR trail / 20-bar time
stop) — same entries, same costs — and crowns the measured best ONLY at n>=15
per variant. Bars spanning both stop and target resolve as the LOSS
(conservative). Exits move expectancy more than entry tweaks; now that's
measurable per strategy per market.

**A: AUTO S/R KEPT, FIXED.** It was broken because it existed TWICE ('srzones'
v51 + 'srz' v62 — two chips, two half-painters fighting one slot). Now ONE
owner: volume-weighted zones — pivot levels ranked by share of total volume
that DEFENDED them x touch count, faded by age, strength printed ON the zone
("4x · 18% vol"). The duplicate chip and painter are retired in place.

**X-fixes.** X1 capture-phase delegation on document (bubble-phase was killable
by any of the codebase's 20 stopPropagation calls — why "which cards are dead"
looked random). X2 the CAL.map crash: collectors json.dumps'd, then store()
dumps AGAIN -> doubly-encoded rows; collectors now pass RAW objects (store owns
serialization) + the client parse is tolerant of old rows already in SQLite.
X4 anonymous Clock jobs named.

RESTART NOTE: mishel_service.py must be restarted (X2 server half). The Brain
trains as charts are scanned — expect UNTRAINED for the first sessions; that is
honesty, not failure.

## v39.6 — Z-FIXES: THE THIRD CROSSHAIR, THE LEGEND LANE, THE BRAIN'S FACE

**Z1.** The "RSI/FLUX box blocking the chart" was the indicator LEGEND, parked
at top-RIGHT — the exact lane of the price axis, last-price flag and crosshair
pill. Moved to top-left under the OHLC readout (where every professional chart
puts it). The right edge is flags-only now.

**Z4 — THE REAL DOUBLE PILL.** The terminal ran TWO complete crosshair systems:
47-tv's DOM bubbles (#axPx/#axTm, the white pills) AND 51-psar's gold canvas
pills — same mouse, same information, stacked. Worse: the v39.1 "D2 fix" and
the first v39.6 attempt both patched a THIRD crosshair that had been dead-coded
inside `if(false&&...)` since some earlier hardening — four lines that could
never execute, which is why the fix "didn't take" twice. The corpse is deleted
(Z5), 51's duplicate pills are retired, 47-tv owns the crosshair.

**Z2.** Capture-phase delegation hardened: #side re-queried per event (a
closure over a node that later gets replaced dies silently). The boot test now
clicks EVERY named card the user reported dead — MTF, Position sizer, Quick
trade, AI Vision, Desk Narrator, Macro drivers — THROUGH a wrapper that calls
stopPropagation(), and demands the toggle.

**Z3.** window._flagLane existed since v39.1 with zero callers — a registry
nobody used. The last-price tag now reserves its lane.

**Z6.** SPRD formatting per asset class: crypto = $ absolute, metals = cents,
FX = pips. "SPRD 1.0" on BTC at 64k was forex math on a crypto number.

**Z7.** The Brain has a FACE: tier badge + score + top-3 decomposition on the
Strategy-signal card; untrained state says so in words.

**Z8/Z9.** KEY badges click to a how-to (FRED_API_KEY unlocks four drivers);
MACRO BIAS prints "n/m legs directional" so +0.00 reads as genuinely neutral.

**Also fixed while testing:** the Macro card only mounted inside the fetch
.then — a DOWN service meant NO card at all, indistinguishable from a bug. It
now mounts unconditionally with its honest empty state.

### TRAPS FOUND (v39.6)
- **Dead code eats fixes.** Two separate "fixes" were applied inside an
  `if(false&&...)` block and could never run. Before patching a painter, prove
  it PAINTS (grep for the guard, not just the draw call).
- **split.py derives filenames from module headers** — "THE SIGNAL BRAIN"
  became 69-the-signal-brain.js after one re-split and a test died on the
  pinned name. Tests resolve modules by pattern now.

## v39.7 — MACRO DASHES EXPLAINED + THE BRAIN LEARNS MORE

**W1 (the DXY dash was MY bug).** The macro card read window._dxy — a global
NOTHING ever set; its only references were the card itself. The terminal always
had real DXY (proxy leg DX-Y.NYB or the v11 computed FX basket). The row now
reads BAR_CACHE and CITES its source.

**W2 (window honesty).** The feature store accumulates HOURLY rows, and
trendPct(series,30) reached 30 ROWS back = 30 HOURS while the label said /30d
(M2: 90 rows labeled /90d). Series are now resampled to DAILY buckets and
windows count real days; while history is younger than the window the row says
"needs N more days" — a blank with an ETA instead of a shrug.

**W3 (dashes explain themselves).** New /svc/data/errors endpoint (last error
per collector); every blank driver row's tooltip now carries WHY BLANK: the
actual failure ("Farside page shape changed", "CoinMetrics timeout"). Needs a
service restart.

**W4 (the static trio).** Expanding any card now nudges the render pipeline so
Signal drivers / Multi-timeframe / Position sizer repopulate; if a body is
still empty 400ms after expanding, the card SAYS SO in words. The boot test
clicks all three by their EXACT names (the previous test matched "MTF" against
the wrong card — a test that passed by accident, now fixed).

**A-wiring (the Brain learns more, still glass-box):**
- A1: the Candle-DNA card publishes its stat (n>=15 only) -> ctx.dna is FED
  (the feature slot existed since v39.5; nothing filled it).
- A2: strategy identity as 4 stable hash-bucket features — the Brain learns
  WHICH strategies pay WHERE, printed like every other weight.
- A3: red-news gate — signals within 30m of a high-impact USD release carry a
  NEWS badge and a learned penalty feature (calendar leg already live).
- A5: the isolation-forest anomaly score (idle since v7) is now a feature:
  structurally weird tape counts against a trigger.
- A4: MORNING READ on the scoreboard — one paragraph composed from on-screen
  numbers (macro bias, Brain state, decay flags, next red event). A briefing,
  never a prediction.
- A6: Kelly-lite size hint on the brain line — quarter-Kelly from the Brain's
  p, arithmetic printed, INFO-ONLY.
- A8: ETF scrape tries two Farside page shapes; failures logged per-URL so the
  WHY BLANK tooltip cites the real reason.

Old persisted Brain weights lack the new feature keys and read 0 — forward
compatible by construction; no reset needed.

### TRAP (v39.7)
- A mutation block appended AFTER `return {…}` is dead code that node --check
  happily accepts. The Brain's new features silently read 0 until the literal
  became `var f = {…}; …mutations…; return f`. The wiring test caught it
  (strat flags all zero); a syntax check never would.

## v39.8 — THE SNIPER CARD (one decision surface, fixed read-order, hard gate)

Answers the trader's only real question at the moment of decision — "is there a
trade right now, and exactly what do I do?" — in ONE card, ONE fixed read-order
(verdict -> why -> plan -> checklist -> trust), gated so operational error
(missed news, wrong size, ignored exposure, fat-finger retype) cannot happen.

**Four states, one lead word:**
- TRADE (green): live trigger + EVERY checklist item green. Rare on purpose.
- CONFLICT (red): live trigger but strategy direction disagrees with macro bias
  -> NAMES the split ("strategy LONG vs macro short bias -0.27, size down/skip").
  The split-signal moment that traps discretionary traders is surfaced, not hidden.
- STAND DOWN (grey): live trigger but a red checklist item. HARD BLOCK per the
  user's explicit choice — any one red item forces STAND DOWN, plan greyed.
- ARM (amber): no trigger; plan shown greyed with the watch level + one-click
  "arm alert with this plan attached".

**The checklist (the anti-error gate):** spread sane for the class · NOT within
30m of a high-impact USD release · regime matches the strategy's nature (trend
strat in trend, revert strat in range) · exposure in bounds (Risk Governor).
Every item shows its live value. All green to fire.

**TRUST line, always shown:** the strategy's real resolved record in the current
regime, Wilson CI, DECAYING flag. A verdict without its receipts is an oracle;
this is the receipt. No verdict can be read as certainty.

**Per user's two choices:** any red = hard block (discipline over discretion);
per-trade risk is TYPED each session (no hidden default that could misprice size).

Composed ENTIRELY from existing machinery: analystContext() reads + plan inputs
(planFrom mirrors 48's planCalc), the Brain tier, the scoreboard record, the
macro calendar, the live spread. No new analysis. The now-redundant cards
(Signal drivers, MTF, sizer, Trade planner, Derivatives, Quick trade) collapse
by default — their conclusions live in Sniper, detail one click away.

HONEST LIMITS (stated in the card's own footer): a green checklist means the
RULES were followed, not that the trade will win. It removes operational error,
never market risk. No prediction, no auto-execution.

## v39.9 — THE BROKER BRIDGE (analysis -> your live order)

The reframe: this terminal exists to make the HANDOFF clean -- you analyze
here, then place the trade by hand in JustMarkets MT5 or Binance. Everything
below closes the gap TradingView left.

**T1+T3+T9 ORDER TICKET (js/72).** A card that outputs the literal numbers you
type into your broker: symbol as THEY name it, side, entry, SL, TP, and the
lot/qty computed from THEIR contract spec and YOUR account -- each field a
one-tap copy. Broker PROFILES (JustMarkets MT5 / Binance) each carry account
currency, balance, default risk%, symbol map, and per-symbol contract specs;
switch profile and the whole ticket recomputes. Specs are editable from the
card (once, from your broker's sheet). XAUUSD is 100 oz/lot -- the terminal
NEVER guesses a contract size (an unknown symbol refuses to size rather than
mis-size). Server /svc/risk/size already did correct math; this is the
client-side broker layer it needed.

**T4 PRE-FLIGHT STRIP.** Five trade-invalidators on one line atop the Sniper
card: spread / next-red-news / session / open-risk / heat. Red = don't fire,
whatever the setup says.

**T6 PHONE ALERT = THE ORDER.** Arming a Sniper plan pushes the FULL broker
ticket to Telegram -- "BTCUSD LONG, entry, SL, TP, 0.14 lots" -- so the alert
IS the instructions. Glance, place, done. Never fires without your click.

**T5 VERDICT WATCHLIST (js/73).** Your symbols, each with its live verdict from
that symbol's loaded bars. Scan the column, act on the one with a setup, click
to load. Replaces six TradingView tabs. Honest: no bars = "no data", no
fabricated verdicts.

**T7 REAL-TRADE LOG.** "I placed this" records the actual plan (symbol, side,
entry, stop, size, strategy, Brain tier) to realtrades.v1 + the alert log, so
the scoreboard and override ledger learn from your REAL trades.

**T8 CONSOLIDATION.** plan+sizer dropped from the DECIDE cockpit (SECMAP
decide:[]) -- the Sniper card + Order ticket own them now, shown once. The
cockpit keeps CONTEXT + EVIDENCE as the audit layer.

**C1 EXPLAIN-ON-HOVER (js/74).** Every known metric (FLUX, RSI, ATR, MACRO
BIAS, breakeven, confluence, MVRV, funding, DXY, Wilson, regime, crowding,
heat, slippage, conviction) gains a plain-language "what it means for the
decision" appended to its tooltip -- non-destructive, idempotent (data-c1
marker), uncertainty preserved.

### TRAP (v39.9)
- id collision across FEATURES, not just within a file: the new verdict-watch
  card used #wlAdd, already owned by the v-watchlist view (36). The boot test's
  post-injection duplicate-id scan caught it (wlAdd x2). Renamed vwAddSym. When
  adding a card, grep the WHOLE codebase for any id you introduce.

## v39.10 — PROFESSIONAL POLISH: declutter, readable ticket, live ticker, fonts

**Z1 (the black ORDER TICKET).** Three compounding causes: it started collapsed
(idx>=3), its <h3> held a <select> so header-clicks hit the dropdown not the
toggle, and collapsed+empty = black void. Fixed: primary surfaces (SNIPER /
Order ticket / Watch / Confluence) NEVER collapse; the profile select moved out
of the header into the body; the card carries a real --panel background even
when collapsed.

**Z2 (duplicate Trade Plan).** v39.9's T8 removed plan/sizer from the cockpit's
SECTIONS but the cards were still BUILT and fell through to the 'loose' render,
showing a second Trade Plan at the bottom. Now `delete cards.plan; delete
cards.sizer` before loose-render. One plan, one place.

**DECLUTTER.** A hard KEEP_OPEN rule: only SNIPER, Order ticket, Watch,
Confluence, Macro, Scoreboard stay open by default; everything else collapses,
so the panel can't drift back to a 10-card wall. wireSide re-runs for ~7s after
boot so late-injected cards (macro 1.5s, DNA/narrator 4-4.5s) get the collapse
default + delegated toggle too.

**N1 LIVE TICKER (js/75).** One scrolling line atop the panel: high-impact
calendar countdowns, funding extremes, anomaly flags, RSS headlines (from the
server's existing collectors), and Brain A-tier signals. Hot items (event <30m,
anomaly) highlight; pauses on hover. Honest quiet state ("tape quiet") -- no
fabricated headlines. Reuses existing data, no new source.

**F1 FONTS.** Inter is now the UI face (fintech standard); Space Grotesk demoted
to the logo. ALL numbers use JetBrains Mono with font-variant-numeric:tabular-
nums so price columns align -- the biggest "pro terminal" tell. Weight hierarchy
600/500/400 by role.

**O2/O3.** One semantic palette (--bull #26C281 / --bear #E5484D) meaning only
long/short & good/bad, never decoration. Confluence scale label spacing fixed.

## v39.11 — SCALP INTELLIGENCE (P1-P4) + DYNAMIC STRATEGY, HONESTLY (D1/D2/D4)

**P1 — pips AND price levels.** The plan keeps every price level and ADDS the
distance in the trader's unit per class (FX pips, metals/crypto points/$), on
stop/T1/T2, plus the $ value at session risk ("$10 -> +$20 @T2").

**P2 — entry type.** SCALP / INTRADAY / SWING classified from stop-vs-ATR and
timeframe, with an ESTIMATED time-to-target ("SCALP · ~12min"), labeled as an
estimate.

**P3 — SCALP-FIT.** The number nobody shows: how much of your T1 the spread
eats. >15% = red "edge gone before you start"; >8% = amber; else green clean
scalp. Serves the user's scalp-first preference actively.

**P4 — R:R with required win-rate** ("1:2 · need >33% to profit") on the plan.

**D1 — which strategies feed the signal.** The Sniper shows the actual named
strategies firing in your direction + how many fire against (the CONFLICT
source). Glass-box, not a black box.

**D2 — adaptive SELECTION.** Strategy Lab card: reads the scoreboard and
classifies each proven strategy trust / bench / thin by Wilson CI in current
conditions. Dynamic (changes as evidence arrives) but never invents.

**D4 — GATED PROPOSER.** Proposes pairs of existing strategies as new combos,
but every proposal must survive a real walk-forward split (test avgR > 0), the
PBO/CSCV overfitting probability (must be <=50%), and a deflated-Sharpe check
for the trial count (>=0.60). Failures shown as REJECTED with the reason; passes
labeled CANDIDATE with OOS sample, NEVER auto-live -- the user promotes. This is
the honest answer to "AI that makes strategies": it may PROPOSE, the evidence
DISPOSES, the human DECIDES. A test proves an overfit combo (great in-sample,
fails OOS) is correctly rejected by the walk-forward gate.

### TRAPS (v39.11)
- **ASI ate the plan.** A `var` compute block was inserted INTO a
  `card.innerHTML = '...' + '...'` concat chain. Automatic-semicolon-insertion
  made `node --check` pass, but the assignment silently terminated at the last
  string before the vars, and the plan-block string after them became a dead
  expression statement. Only the verdict rendered. Fix: compute BEFORE the
  assignment. A syntax check will NOT catch a semantically-dead but
  syntactically-valid split; a boot-render assertion did.
- **split.py merges adjacent modules across a skipped number.** 75 was absent,
  so split folded 76 (proposer) into 74 (ticker). The built index.html was
  always correct (it is the authority); only the round-tripped src/ merged.
  Re-separate at the 2nd banner + restore the manifest, or just don't re-split
  when identity already holds.
