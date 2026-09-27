# IRAM Terminal v40 — frontend rewrite

The v40 terminal. Lives alongside the v39 single-file build (`index.html`,
`src/`, `tools/build.py`), which is **untouched and still shipping**, so there is
never a day where the working terminal is broken because the rewrite is midway.

```bash
npm --prefix app install     # once
npm --prefix app run dev     # http://localhost:5173, HMR
npm --prefix app run build   # -> app/dist/index.html, one self-contained file
npm --prefix app test        # vitest
npm --prefix app run check   # tsc --noEmit
```

`bash tests/run_tests.sh` runs the v39 suite **and** this one, so one command
still tells you whether the whole build is good.

---

## Why this exists

v39 is 16,657 lines in one HTML file, assembled from 75 modules. The engineering
around it is genuinely good — manifest-driven build, `node --check` per module,
sha256 byte-identity proof, ~1,600 assertions. What it could not fix is the
inside of the stylesheet and the shape of the render path:

| v39 | v40 |
|---|---|
| `.app` grid defined **5 times** (lines 283, 511, 535, 753, 923 of `00-head.html`), later generations winning by force | **one** `.shell` rule; every layout mode is a data attribute that re-points tracks |
| **198 `!important`** declarations arbitrating between them | zero |
| duplicate token families (`--r-s`/`--r-sm`, `--fs-N`/`--fz-N`, `--rail-w`/`--railw`) | two-layer tokens: palette → semantic roles |
| four themes, all dark | five, including a real light theme |
| bars as `{t,o,h,l,c,v}` objects | six parallel `Float64Array` columns |
| one canvas — crosshair movement repaints every candle | two layers — a crosshair move costs two strokes |
| hand-rolled tick bus + `renderIfChanged` content hashes per module | typed signals; unchanged values do no work by construction |
| untyped | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |

## What is deliberately preserved

**The shipped artefact is still ONE self-contained `index.html`.** It opens from
a double-click with no server and no network. That is why the build uses
`vite-plugin-singlefile` and inlines everything — it is a product requirement
inherited from v39, not a bundling preference, and it keeps the existing habit
of testing against the shipped file intact.

**The honesty contract.** It is enforced in code, not by convention:

- `data/feed.ts` never falls back to generated data. A failed load leaves the
  previous bars frozen and sets an **offline** state that every surface labels.
- Demo data is a mode the operator selects. `quality` stays `"demo"` while it is
  on, and a banner says so. Nothing can silently transition into it.
- Freshness separates **tick age** (is the socket alive?) from **vendor lag**
  (is the data current?). A vendor streaming a healthy socket of 15-minute-old
  prices is reported `delayed`, never plain `live`.
- The contract degrades on a timer, so a dead feed cannot sit on its last
  "live" reading for ever.
- Staleness scales to the **measured** bar spacing, never the UI timeframe —
  4 minutes is dead on a 1m chart and healthy on a 1h chart.

## Layout

```
app/src/
  core/
    signal.ts    fine-grained reactivity (signal / computed / effect / batch)
    frame.ts     frame scheduling that still works when rAF is starved
  chart/
    series.ts    columnar OHLCV over typed arrays
    viewport.ts  index/price <-> pixel maths, pure and unit-tested
    engine.ts    layered canvas renderer + pointer interaction
  data/
    feed.ts      bar sources + the freshness contract
    stream.ts    generic live socket: backoff, watchdog, resync, pluggable parse
    sources.ts   source registry: failover, circuit breaker, provenance
    history.ts   archive + registry joined; cache-first loads, deep backfill
    binance.ts   REST endpoints for the universe scan
    derivs.ts    funding, open interest, positioning, taker flow
  store/
    segments.ts  interval algebra — what is held vs never fetched
    barstore.ts  IndexedDB bar archive, typed arrays, per-segment provenance
  backtest/
    engine.ts     bar-by-bar runner; refuses the four standard backtest lies
    metrics.ts    performance stats, each paired with its caveat
    strategies.ts transparent rules, incl. the confluence engine on trial
    validate.ts   walk-forward and PBO via CSCV
  scan/
    confluence.ts  glass-box scoring — no number without its reason
    scanner.ts     universe scan: concurrency, cancellation, honest failure
  detect/
    pivots.ts      swing detection; every pivot carries `confirmedAt`
    structure.ts   BOS / CHoCH / clustered S-R levels
    zones.ts       fair value gaps, order blocks, mitigation tracking
    formations.ts  doubles, head & shoulders, trendlines, divergence
    index.ts       detector registry
  ui/
    dom.ts       typed hyperscript with signal binding
    shell.ts     the application shell
  styles/
    tokens.css   THE design system — the only place raw values live
    base.css     reset + shared primitives
    shell.css    THE ONE GRID
    components.css
```

### `data/stream.ts` — three things a naive socket client gets wrong

1. **An open socket is not a live feed.** TCP holds a connection open long after
   the far end stops sending, so `readyState === OPEN` will happily report LIVE
   on a dead tape. A watchdog treats silence past a threshold as failure and
   reconnects, whatever the socket claims.
2. **Reconnecting in a tight loop attacks your own vendor.** Backoff is
   exponential, capped, and jittered — without jitter every client that dropped
   on the same blip retries on the same schedule for ever.
3. **A gap in the socket is a gap in the data.** Bars that closed during an
   outage were never sent. A reconnect fires `onResync`, and the feed refetches
   history rather than splicing the hole shut and calling it continuous.

The transport is injected, so the reconnect ladder and the watchdog — the parts
most likely to be wrong and hardest to reproduce by hand — are unit-tested
against a fake socket and a fake clock rather than against the network.

### `scan/` — the screener, and why there is no worker pool

Confluence over 400 bars is roughly 50k operations; the whole universe costs
tens of milliseconds. The bottleneck is the **network** — one klines request per
symbol against a rate-limited vendor. So `scanner.ts` is about request
concurrency, cancellation and honest partial failure, not compute. A worker pool
here would be theatre. `confluence()` is pure, so when the compute does grow to
justify one, it moves across a `postMessage` boundary unchanged.

Three things the scan refuses to do:

- **Silently drop a failed symbol.** A screener showing 47 rows when you asked
  for 50, with no explanation, is lying about its coverage. Failed rows survive
  carrying their error.
- **Write results after being superseded.** Changing timeframe mid-scan aborts
  the old one; stale rows from the previous timeframe never reach the table.
- **Hammer the vendor.** A 429 is a statement about the client, not about one
  symbol, so it parks every worker rather than retrying six-wide.

Rows rank by **conviction** — `|score| × confidence` — never by raw score. A
strong-looking read the engine does not trust must not outrank a moderate one it
does; that is the whole reason confidence is tracked separately.

`confluence.ts` enforces one rule: **no number without its reason.** There is no
path through it that produces a contribution without the sentence explaining it,
and the tests assert that for every signal, including the ones that abstain.
Volatility and absent trend structure scale *confidence* and never vote on
direction — a market can be violently trending or quietly trending, and momentum
without structure is a weaker read than the same momentum inside a clean stack.

### `backtest/` — and what it actually found

A backtest is a machine for producing believable numbers, and nearly every way
it lies makes results *better*. So the engine's job is mostly refusing:

- **You cannot trade the close you are evaluating.** A rule reading bar `i`'s
  close fills at bar `i+1`'s OPEN. Filling at `close[i]` is the most common
  backtest lie and is worth several imaginary percent a year.
- **A bar containing both your stop and your target is assumed to hit the
  STOP.** It tells you nothing about the order, and assuming the target turns
  losing systems into winners on paper.
- **Costs on both sides.** Spread, commission, slippage.
- **A series with holes is not a series.** The run is refused below a coverage
  floor rather than treating a three-week gap as one enormous bar.

`validate.ts` adds the two checks a backtest cannot perform on itself:
walk-forward (choose on one slice, measure on the next) and **PBO via CSCV**
(Bailey, Borwein, López de Prado & Zhu) — split the period into blocks, take
every balanced train/test partition, and ask how often the best-in-sample
configuration lands *below* the out-of-sample median.

#### The result, on real data

Run over **6,800 archived BTC 1h bars (283 days, coverage 1.0, no gaps)**, after
costs:

| strategy | trades | expectancy | profit factor | verdict |
|---|---|---|---|---|
| Confluence ≥ 0.35 | 146 | +0.023R | 1.04 | weak |
| EMA 10/30 | 127 | +0.025R | 1.03 | weak |
| EMA 20/50 | 104 | −0.015R | 0.87 | weak |
| RSI reversion | 16 | −0.189R | 0.54 | unproven |

And across a 16-configuration grid: **PBO = 89%**, with the selected
configuration out-of-sample-positive only 10% of the time.

**Read plainly: there is no demonstrated edge here.** The confluence engine is
break-even before you account for anything the backtest cannot model. A PBO of
89% says selecting the best of these configurations has *worse than no*
predictive value — the winner is the luckiest, not the best.

Walk-forward on the same run reported "233% of in-sample expectancy retained",
which looks excellent and means nothing: it rests on **22 out-of-sample trades**,
and the tool says so in its own warning. That contradiction is the entire reason
both checks exist.

Caveat in the other direction: this is one symbol, one timeframe, 283 days, and a
grid whose configurations are variations on two or three ideas — correlated
candidates inflate PBO. It is evidence, not a verdict on the whole approach.

### `store/` + `data/history.ts` — the research archive

History is persisted to IndexedDB as contiguous runs of bars held in typed
arrays. Measured on a real series: a **warm boot reads 800 bars in 1.8ms**
instead of a network round trip, and a backfill pulled **283 days / 6,800 bars
into 319KB** in under two seconds.

Two rules make it usable for backtesting and ML rather than just faster:

**1. It never returns a series without its gaps.** `read()` hands back the bars
AND the ranges it does not hold, plus a coverage ratio. A backtest over a series
with an invisible hole does not crash — it produces a confident wrong number,
and an ML training set learns the discontinuity as if it were a market move. So
a caller can refuse to run on a series that is 60% present rather than
discovering it from a strange equity curve.

This is also why a stored segment must be a *contiguous run*: chunking purely by
bar count let one segment straddle a three-week absence and report it as
covered. Contiguity decides segment boundaries; the size cap only subdivides
within a run.

**2. Provenance is per segment and never mixed.** Each segment records its
source and whether that source was live, delayed, or **demo**. Generated bars are
written under their own source key so they can never merge into a real series,
and `read()` reports every quality present. A model trained on synthetic candles
blended into real ones is worse than one with no data, because it looks trained.

`history.ts` joins the archive to the source registry. A cache hit is only taken
when the newest stored bar could still *be* the newest bar — otherwise yesterday's
close would masquerade as today's. When every source is down it falls back to
stale archived bars and says so, because stale-but-labelled beats an empty chart.

### `data/sources.ts` — no single vendor can take the terminal dark

Sources are tried in priority order, and every attempt is recorded with the
reason it failed: a silent fallback is how you end up reading 15-minute-delayed
equity data believing it is live crypto. Binance covers crypto and offers a
socket; the local Python proxy covers forex, metals and equities and is marked
`delayed`, with **no** stream — returning `null` there is how the shell knows not
to claim live updates it will never receive.

A per-source **circuit breaker** matters more than it sounds: without it, a
screener scanning 200 symbols against a dead vendor takes 200 timeouts before
falling through, every single time. Three consecutive failures open it; one probe
is allowed through after the cooldown. An abort is not counted as a failure — the
user switching symbols quickly must not blacklist a healthy vendor.

### `data/derivs.ts` + the Flow desk — why there is no embedded browser

The obvious way to get CoinGlass or Arkham numbers into a terminal is to embed
those sites and read them. That does not work, and the reason matters. Measured,
not assumed:

| site | embeds in an iframe? | can script read it? |
|---|---|---|
| Arkham (`intel.arkm.com`) | yes | **no** — cross-origin |
| CoinGlass | **no** — refuses to be framed | no |
| TradingView | yes | **no** — cross-origin |

A page can never read another origin's DOM. That is the same-origin policy, and
it is the one rule stopping every site you visit from reading your logged-in
Arkham session or your exchange account. A terminal that defeated it would not
be a secure browser; it would be the capability malware wants.

It turns out not to matter, because the metrics are not proprietary. Funding,
open interest, account positioning and taker flow are published by the exchange
itself on **keyless, CORS-open** endpoints, and liquidations stream over a public
socket. The Flow desk reads them directly: faster than scraping, no
Terms-of-Service exposure, no API key to leak, no dependency on a third party's
uptime.

Each reading states its reasoning and refuses to overclaim, because every one of
these has a well-known failure mode:

- **Funding** is read as *crowding*, not direction. Longs paying 40% annualised
  is a squeeze risk against longs — not a forecast that price falls.
- **Open interest is directionless alone.** It only means something alongside
  price, so the reason always states both: "OI up 2.5% while price fell — new
  money entering short, which confirms the move but builds the fuel for a
  squeeze against it."
- **Lopsided positioning is contrarian**, and the reason says out loud that
  crowds can stay crowded for a long time.

For sites with genuinely no public endpoint (Arkham entity labels), see
`docs/capture-bridge.md` — a localhost capture design that keeps the security
boundary intact instead of breaking it.

### `detect/` — auto pattern detection and auto-drawing

**What this is, plainly:** deterministic structural detection — swing pivots,
market structure, imbalances, classical formations, divergence. It is not a
neural network, and it is labelled as what it is. Every result is reproducible
from the bars alone and carries the rule that produced it, which is the point:
a structure you cannot audit is one you cannot trust on a live trade.

The single most important property is the **look-ahead guarantee**. A pivot high
is not knowable until `right` bars have closed after it, so every pivot carries
`confirmedAt`, and structure logic compares against that rather than the pivot's
own index. A detector that skips this reads the future — at bar *i* it uses bars
*i+1...i+right* that had not happened yet — and that is the single most common
way a chart-pattern backtest produces impossible returns.

The same discipline runs through the rest:

- **Breaks confirm on close, never on wick.** A wick through a level that closes
  back inside is precisely the liquidity sweep the level exists to describe.
- **BOS vs CHoCH is preserved.** A break with the trend is continuation; a break
  against it is the first sign the leg is over. Labelling both "BOS" throws away
  the only information that made the concept worth having.
- **Formations are confirmed, never anticipated.** A double top is two highs and
  a hope until price closes through the neckline.
- **Zones track mitigation.** A gap price already traded back through stops
  being drawn as if it were live.
- **Three touches make a trendline.** Two points make a line through any two
  points that happen to exist.

Detectors return shapes in **data space** (bar index + price), never pixels, so
annotations stay glued to the bars through any pan or zoom and the same
detection can be drawn, listed, or fed to a strategy without recomputation.

With all thirteen detectors on, 800 bars produce well over a hundred structures and
the chart becomes unreadable — which makes the feature worse than useless,
because the one structure that matters is buried in ninety that are not. Only
the most recent of each kind is drawn, the engine culls anything off screen, and
the counter reads "128 found - 34 drawn". Capping is fine; capping silently is
not.

### `core/frame.ts` — the least obvious file

`requestAnimationFrame` makes one promise it does not keep: that a requested
callback eventually runs. It does not run in a backgrounded tab, and it does not
run at all in a context that never composites.

**This terminal is always a background tab** — you are in MT5, not here. A paint
path that silently stalls is the normal case, not an edge case, and a stalled
paint means the numbers on screen are quietly wrong. So `scheduleFrame` requests
a frame *and* arms a 250 ms timer; whichever fires first wins and cancels the
other. Under normal compositing the timer never fires and this is exactly rAF.
Returning to the tab flushes everything pending immediately.

The chart also **re-measures its host at the top of every paint** rather than
trusting `ResizeObserver` alone. A host that measures zero at construction — what
happens when the terminal is opened in a background tab, since a backgrounded
document is not laid out — used to leave the canvases at their 300×150 default
for the life of the page.

Both were found by running the real thing, not by reading the code.

## The desks

### Signals — alerts that follow structure
An alert here can be anchored to a **detected structure** rather than to a price you typed. Pick a
trendline, an order block, a fair-value gap or a level from the dropdown (or press *Alert me* on any
detection in the inspector) and the alert re-resolves against a fresh detection run every bar: the
line re-fits and the alert moves with it.

Rules the engine will not bend:

- Judged on **closes**. `Wick touches` is the only condition that reads a wick, and it says so in the
  fire text — "price touched it" and "price closed through it" are different claims.
- Never fires on a **forming bar**.
- Never fires on or before the bar that **revealed** the structure it is anchored to.
- **Hysteresis**: the condition must reset before it can fire again, so one crossing is one alert.
- A structure that is invalidated makes its alert **ORPHANED** and visibly amber. It never goes
  quietly dead.

Alerts evaluate on every desk, not just this one. Close the tab and they stop — unless you run the
daemon.

### Always-on
`Export book` writes `alerts.json`. Drop it in `server/` and run:

```
node server/alert_daemon.mjs --every 60
```

It runs the **same compiled engine** as the browser (`server/engine/alert-engine.mjs`, built by
`npm run build:engine` from the same TypeScript), so there is no second set of rules to disagree
with these. It writes `server/alerts.log` and can POST to `--webhook`. Its first pass per symbol is
silent, because a book against months of history legitimately contains dozens of past fires.

It reports. It cannot place an order.

### Strategy — the lab
There is no way to see an equity curve here without the two numbers that qualify it. Every run
sweeps a parameter grid, walks forward across folds, and computes **PBO** (probability of backtest
overfitting, via CSCV) — together, always. The verdict card sits above the curve and is styled to
outrank it.

The lab fetches its own history (default 5,000 bars, backfilling if short); the chart's window is
too small for a sweep to mean anything. Coverage discounts hours the venue was shut, so a complete
forex series is not refused for missing its weekends.

Read the verdict, not the curve. `No demonstrated edge` means selection among those variants was a
coin flip, however good the curve looks.

### Flow — positioning
Funding, open interest, account positioning and taker flow, plus derived reads no charting platform
offers: **spot–perp basis**, the four-way **open-interest read** (new longs / short covering / new
shorts / long liquidation), **funding-vs-price divergence**, and **liquidation shelves** — the
price bands where leverage actually died, grouped out of the live tape.

### Screener — and correlation
After a scan, the correlation card compares the symbols it just loaded, aligned by timestamp. Five
setups that all move together are one setup.

## The palette, the menus and the keyboard

Press **Ctrl+K** (⌘K on macOS). Type what you want.

That is the fastest thing in this terminal and there is no equivalent in
TradingView, MetaTrader or TrendSpider. Bloomberg is quick for the same reason —
it is a command line — and unguessable for the same reason too. A palette is the
only interface that is both fast and discoverable, because the keystrokes that
run a command you know also list the ones you do not.

The matched characters are shown in bold. That is not decoration: it is the
palette telling you why a row is on screen, and a fuzzy result you cannot
account for reads as a guess.

Prefixes narrow it:

| Prefix | Searches |
|---|---|
| *(none)* | symbols and commands together |
| `>` | commands only |
| `@` | structures the detectors have found on this chart |

With nothing typed you get **what you used last**, not an alphabetical dump —
a session has phases, and the thing you reached for a minute ago is far more
likely to be next than the thing you reach for every morning.

### The menu bar

Answers a different question. The palette answers "how do I do the thing I
already want"; the menu bar answers "what can this program do". You cannot
fuzzy-search for a feature whose name you have never heard.

Every item shows its own accelerator, which is how you graduate from clicking it
to pressing it.

### Keys

Press **?** for the full sheet — it is generated from the live keymap, so it
cannot drift out of date the way a hand-written cheat sheet does.

| Key | |
|---|---|
| `Ctrl/⌘ K` | palette |
| `Ctrl/⌘ ⇧ P` | palette, commands only |
| `1`–`6` | timeframe |
| `F` | focus mode |
| `B` | inspector dock |
| `L` | jump to the live edge |
| `R` | reload history |
| `⇧R` | replay mode |
| `A` | ask the analyst |
| `⇧B` | brief me on this chart |
| `G` then `C/S/T/K/F/D/A` | go to a desk |

Single letters do nothing while the cursor is in a text field — a bare `f` in
the symbol box is the letter f. Sequences like `G` `C` are typed one key after
the other; the half-typed prefix appears in the status bar, because a mode you
cannot see is a mode you are stuck in.

## Where the data comes from

Six sources, tried in order, with automatic failover:

| | Covers | Why it is in the chain |
|---|---|---|
| **Binance** | crypto spot | Deepest book on most pairs, and the cache is already warm |
| **MT5** | forex, metals, indices | The venue you are actually filled at, so its prices are the only ones true for you |
| **Coinbase** | crypto, quoted in **USD** | Real dollars rather than USDT — a different instrument, and occasionally the whole story |
| **Bybit** | crypto spot | Depth outside one book |
| **OKX** | crypto spot | Depth outside one book |
| **Proxy** | everything else | The delayed floor |

Until v43.1 a crypto chart came from Binance or from nowhere. That mattered most
in exactly the situation you least want it to: the request governor parks a
banned host for the full duration of a Binance 418, because probing extends the
ban — and that used to mean no chart for hours.

Each venue is a genuinely different payload, and each difference would fail
silently rather than loudly. Coinbase returns `[time, low, high, open, close,
volume]` with time in **seconds** and **newest first** — a seconds timestamp
puts the series in 1970, and a reversed one renders as a mirror image of the
market. Bybit answers HTTP 200 with an error code in the body. OKX marks the
still-forming candle, which is dropped, because a partial candle presented as
closed is exactly what the structure detectors refuse to reason about.

Every host has its own budget in the request governor, sized well under its
published limit. These are failover sources: they matter most when Binance has
already parked us, and arriving at a second venue with an aggressive rate would
trade one ban for another.

## Fundamentals

In the inspector, beside the chart. A candle tells you what price did; it cannot
tell you that only 6% of the eventual supply exists yet.

| | |
|---|---|
| **Market cap** and rank | Scale. The same pattern on a $40bn asset and a $4m one is not the same trade |
| **Fully diluted**, as a multiple of cap | What the price must survive if everything unissued arrives |
| **Float** — circulating over max | The most under-read number in crypto |
| **Turnover** — 24h volume over cap | Whether anyone is actually there |
| **From the high**, with the date | Context a 90-day chart hides |
| 24h / 7d / 30d | Your timeframe placed inside the ones you are not on |

Each figure earns a plain sentence when it is worth noticing — a float under a
fifth, dilution over 3×, turnover under 1% or above 100%. They describe the
number; they never say what to do about it. Turnover above the entire market cap
says outright that it **cannot tell you** whether that is a real event or wash
trading.

**Only the price changes are coloured.** A low float is not bad and high
turnover is not good; both are facts whose meaning depends entirely on what you
are doing, and colouring them would be the panel having an opinion it has not
earned.

The source is CoinGecko, an aggregator, and **circulating supply is
self-reported by projects** — float and dilution are both computed from it. That
line is on the panel, not in a footnote, because a number whose provenance you
cannot see is a number you should not size against.

Metals, FX and equities are not in a crypto aggregator, and the panel says so
rather than showing an empty frame that looks like a load that never finishes.

## No demo mode

There is no synthetic-data mode, and no code that could produce one.

Earlier builds had one: bars you switched on deliberately, labelled `demo`
everywhere downstream so nothing could drift into them unnoticed. That was a
reasonable design, and it is gone, because the strongest version of *this
terminal never shows you a fake price* is not a carefully-labelled fake-price
mode. It is the absence of a generator.

When a feed fails you get an empty chart that tells you why.

## Decision

The desk that reads everything else.

Press it and you get one line: **"SHORT at 28% confidence — 57% of the
directional weight agrees, on 50% coverage."** Underneath it, every source that
contributed, what each one said, where it came from, and what would change it.

Three numbers, and the third is the one nobody else shows you:

- **Coverage** — how much of the evidence it expected actually answered.
- **Agreement** — how much of the directional weight pulls the same way.
- **Confidence** — agreement × coverage, and it can never exceed coverage.

That last constraint is the whole design. Four sources agreeing out of ten
possible is not the same read as four out of four, and every naive blend reports
them identically. A direction on 30% coverage is not a *weak* signal, it is an
**unsupported** one — the headline leads with coverage for that reason, and the
score bar is drawn in the neutral colour whenever confidence is zero so a
strong-looking number cannot borrow authority it has not earned.

### What did not answer is shown as prominently as what did

A source that **failed** should have answered and did not — that is fixable, and
until it is the read is thinner than it looks. A source that is **absent** does
not cover this instrument, or has not been switched on, or has not been run.
They are rendered differently because the response to them is different.

### Not everything has a direction

Fundamentals, cross-venue pricing and correlation are marked *context*. They
count toward coverage and contribute nothing to the score. A 6% float is not
bullish — it changes what a breakout is worth, and the moment it is allowed to
vote it becomes a thesis rather than a constraint.

### One table of weights

Every weight lives in `core/decision.ts`, with a comment saying what it is
relative to. None is fitted. Fitting weights to past outcomes is exactly how the
confluence score reached a probability of backtest overfitting of 89%, and this
assembly would inherit it.

**Do not automate off this desk.** A number assembled from more inputs looks
more authoritative without being more reliable. The desk says so on screen.

## Cross-venue

Four books on one instrument, so you can tell the market from the venue.

A wick that exists on one exchange and nowhere else is a thin-book liquidation,
not a move — and from inside a single feed those are indistinguishable. Binance
quotes USDT and Coinbase quotes dollars; when those drift, the price you are
watching moved for a reason that has nothing to do with the asset.

The reference is the **median**, not the mean, so one lagging venue cannot drag
it. When the gap is wide the panel says so — and says explicitly that it is
**not free money**, because fees, withdrawal time and transfer risk all sit in
front of a spread by the time you can see it.

## Correlation

Portfolio heat sums your positions as though they were independent. On a
correlated book that is an understatement: five 1% positions in five assets that
move together is one 5% bet with five tickets.

Computed on **log returns**, not prices — two assets both drifting upward
correlate near-perfectly on price and can still have uncorrelated daily moves,
and it is the moves that hedge or fail to. Series are joined on **timestamp**,
never by array position, because a gap in one feed otherwise pairs Tuesday with
Wednesday and produces a confident, meaningless number.

Pairs with fewer than 30 overlapping bars are reported as **unjudged** rather
than shown: with 30 points a coefficient of 0.35 is not distinguishable from
zero, and a number that precise-looking invites trust it has not earned.

It costs no extra requests — the screener already fetched and retained those
closes, and until now discarded them.

## Risk

Every other desk answers **whether**. This one answers **how much** — the
question that decides whether an account survives being wrong.

It is a calculator, not an advisor. You give it your equity, the risk you are
willing to take, an entry and a stop; it multiplies. It never proposes a risk
percentage, never says whether a trade is worth taking, and **has no broker
connection** — it cannot see your account and cannot close anything. It says so
on screen, because a risk panel that looks like it is watching your positions
when it is not is worse than no risk panel.

### What it refuses to round off

The headline number is the risk you will **actually** take after the venue's
quantity step, not the one you asked for. Round 0.0187 BTC down to 0.018 and
your 1% trade is a 0.963% trade — the desk shows both, and always rounds down,
because rounding up raises risk silently.

Three things it will refuse outright, and say why:

- **A stop at the entry.** That is not a very large position; it is not a
  position. Same for any stop inside one basis point, where the venue's tick
  rounding is wider than the stop itself.
- **A size the exposure cap will not allow.** A 0.05% stop turns 1% of equity
  into a 2000% notional. The cap binds, and it tells you the resulting risk is
  now *smaller* than you asked for.
- **A size below the venue minimum**, rather than quietly offering one you
  cannot submit.

It also warns when round-trip costs are large next to the amount at risk. On a
1-minute chart a 1.5×ATR stop is roughly 0.06% wide, and the fees to enter and
leave can be **more than the money you are risking**. That trade looks fine
until somebody multiplies.

### Reward to risk

Always shown with the **break-even win rate**. 3:1 is not a good trade; it is a
trade that needs 25% to break even. Knowing which is which is the whole point.

### The book

Positions you enter by hand, with portfolio heat. A position with **no stop** is
outlined in red and named, and the heat figure is reported as a **floor** rather
than a total — an unbounded loss cannot be summed.

The guardrails (daily loss stop, maximum open risk, maximum positions) are
limits you set, checked against numbers you report. Nothing enforces them but
you.

## Drawing

Eight tools on the left of the chart: trend line, ray, horizontal, vertical,
rectangle, Fibonacci, measure and note. `T` for a trend line, `H` for a
horizontal, `Shift+F` for Fibonacci, `M` toggles the magnet, `Ctrl+Z` undoes,
`Esc` returns to the pointer.

The **magnet** snaps to the nearest open, high, low or close — but only when one
is genuinely close, because a magnet that always fires cannot draw anything that
is not on a bar.

**Drawings are anchored to time and price, never to a bar index.** That sounds
like a detail and is the whole design: an index is a position in whatever array
happens to be loaded, so the first time the archive backfills a gap, every
index-anchored drawing slides down the chart — and it looks like the *chart*
moved. Yours survive a reload, a backfill, a timeframe change and a source
failover.

They render through the same path as the automatic structure detection, so a
line you drew and a line the detectors found are pixel-identical and pan, zoom
and re-theme together.

Right-click nothing special is needed: click a drawing to select it, drag its
handles to adjust, drag its body to move it. A horizontal line has no handles on
purpose — its anchor's *time* is meaningless, so the whole line is the handle.

## The symbol list

The palette searches **every symbol the venue lists** — a little over three
thousand — cached for a day.

They are ranked by liquidity, not alphabetically, so typing `BT` gives you
BTCUSDT rather than BTCDOWNUSDT. Ranking is by quote currency tier first and
volume within the tier: a pair's reported volume is denominated in its *quote*
asset, so a rupiah-quoted pair carries a number about 16,000× larger than the
same pair in dollars. Sorting on that raw figure put `USDTIDRT` and `BTCBIDR` at
the top of the whole exchange. There is no honest way to convert them without an
FX table, so instead of inventing rates the ranking demotes them — they are
still reachable by typing the symbol in full.

Typing `btc usd` finds BTCUSDT, even though that space is not in the symbol.

## The Analyst

An assistant that cannot make anything up.

Ask it something and it answers **only from tools that read the terminal's live
state** — the same numbers the panels are showing. Every call appears as a row
above the answer, and every row expands to the raw JSON that came back. If the
agent tells you the RSI is 71, there is a `get_indicators → RSI 71.2` row above
it and you can check it against the chart.

An answer with no tool rows above it is an answer about nothing, and it looks
like one.

It can compute as well as read: position sizing, ATR stops, reward-to-risk,
a walk-forward backtest, a market scan, and drawing a level or promoting a
detected structure into a drawing you can drag. What it will not do is choose
your risk percentage — that is advice, and it is yours. The offline analyst goes
further and declines to size at all, because it has no argument extraction and
guessing two prices out of a sentence is exactly the kind of heuristic that must
not exist near a position size. It reports your risk state and points at the
desk.

**It cannot trade.** Not as a policy in a prompt that can be argued with: there
is no order tool, no position tool, no wallet or credential tool. The capability
does not exist in the process.

### Which brain

| Provider | Where the conversation goes |
|---|---|
| **Offline analyst** (default) | nowhere — no model is used at all |
| OpenAI-compatible | the endpoint you type. Point it at `localhost:11434` (Ollama) or `localhost:1234` (LM Studio) and nothing leaves the machine |
| Anthropic | api.anthropic.com |

The **offline analyst** is the default and needs no key, no account and no
network beyond the terminal's own sources. It picks tools from your question,
runs them, and writes the answer from templates over the results. It cannot
hallucinate because it never generates a number — it only places one. Its worst
failure is being terse.

The key you supply is sent to the endpoint you named and nowhere else. It is
stored under a name containing "credential", which is what makes the vault
exporter **withhold it from every backup** — see the Data desk.

The tools relay limits, not just values. Ask about the forecast when the
classifier's Brier score is at or above 0.25 and the offline analyst withholds
the probability outright and says why, rather than repeating a number the model
itself has already reported is inside the noise.

## Layout

Two rows of chrome, split by what they are about. The **menu row** is about the
program — menus, palette, analyst, theme, density, dock, focus. The **topbar**
is about the chart — symbol, timeframe, style, moving averages, feed health.
Which row you reach for depends on what you are changing.

Notifications land in the log behind the **◉** in the status bar, with an unread
count. A toast you missed is not a notification, so nothing that fires is only a
toast. Errors do not auto-dismiss at all: a failure that erases itself is
indistinguishable from a success.

## Desktop

`desktop/` is a Tauri shell — the OS webview, not a bundled Chromium, so the
installer is single-digit megabytes.

The reason it exists is not the window frame. Binance sends
`x-mbx-used-weight-1m` on every response and **a browser cannot read it**: the
header is on the wire, but with no `Access-Control-Expose-Headers` naming it the
fetch specification hides it from page script. So the web build runs its request
governor on a local estimate at a third of the published ceiling. Requests from
Rust are not subject to CORS, so the desktop build reads what the exchange
actually thinks you have spent.

See `desktop/README.md`.

## The workspace

Press `G` then `W`, or pick a layout from the **Workspace** menu.

A binary split tree, not a menu of vendor-drawn layouts. MetaTrader gives you
tile and cascade; TradingView gives you a fixed list. Both are the same
admission — if the layout you need is not on the list, you do not get it. Here
the presets are just the common cases, and every one of them is reachable by
splitting from any other.

Each pane owns its own feed and its own canvas, sharing one archive and one
request governor. Four panes on four timeframes of the same instrument usually
cost zero extra network requests: the bars are already local, and the governor
de-duplicates whatever is not.

### Link channels

The dot in a pane's header is its channel. **Change the symbol in one pane and
every pane wearing the same colour follows.** A pane set to *unlinked* stays put
while the rest of the desk moves.

That is Bloomberg's best idea and no retail platform copied it. It is how you
get a four-timeframe view of an instrument that follows you when you switch
instruments, without four symbol boxes to keep in sync by hand.

Right-click any pane for its own menu: split, channel, timeframe, send the
symbol to the Chart desk, close. `Ctrl+Alt+→` and `Ctrl+Alt+↓` split the focused
pane; `Ctrl+Alt+W` closes it — and that command is unavailable, visibly, when
one pane is all that is left.

Layouts persist. Retention pins every series on screen in every pane, so a sweep
cannot delete the bars under a chart you are looking at.

## Data — storage, budget, backup

The **Data** desk is where everything the terminal keeps and everything it sends
is visible and adjustable. You cannot manage what you cannot see.

### How much data is kept

Bars live in IndexedDB as Float64 columns — six per bar, 48 bytes. Retention runs
hourly, and applies in two stages.

**By age, per timeframe.** A 1-minute bar from eight months ago is 48 bytes of
weight; a daily bar from 2009 is the whole point of having an archive.

| Timeframe | Kept | Cost per symbol |
|---|---|---|
| 1m | 30 days | ~43k bars, 2.1 MB |
| 5m | 90 days | ~26k bars, 1.2 MB |
| 15m | 180 days | ~17k bars, 0.8 MB |
| 1h | 3 years | ~26k bars, 1.3 MB |
| 4h | 5 years | ~11k bars, 0.5 MB |
| 1d / 1w | **forever** | ~17 KB per year |

Daily and weekly are kept forever deliberately: they are the only series long
enough to contain more than one market regime, which is what a decade-long
walk-forward needs, and they will never be the reason you run out of room.

**By budget, only if still over.** 512 MB total, dropping whole series coldest
first — where "cold" means when it was last *fetched*, not how old its bars are.

Two things retention will never do. It will not touch a **pinned** series: the
symbol and timeframe on your chart right now cannot be swept out from under it.
And it will not leave a **remnant** — every series keeps at least 300 bars,
because a 40-bar series is not a cheaper series, it is a broken one that still
claims coverage.

Press **Preview what would be removed** first. It shows every series it would
trim or drop and why, and the delete button then applies *that* plan — not a
freshly recomputed one. Some of this history is not re-downloadable at any
price.

### Not getting blocked

Every outbound request in the terminal spends from one budget per host.

Binance publishes 1200 weight per minute — 20/second. This sustains **8/second**
with a burst of 120. Spending two thirds of the allowance to buy "never banned"
is the right trade: the terminal is not throughput-bound, and a 418 is an IP ban
measured in hours that gets *longer* every time you retry into it.

- Request **weight** is real: `/ticker/24hr` with no symbol costs 40, not 1.
- A **429** halves the sustained rate rather than pausing and returning to it.
- A **418** parks the host for the full ban. It is not probed.
- A request you are waiting on outranks a background scan.
- Two panels asking for the same URL at the same instant make one request.

Where a venue publishes its own usage counter *and* the browser is allowed to
read it, that counter overrides the local estimate. Binance sends no
`Access-Control-Expose-Headers`, so from a tab it cannot be read at all — the
desk says so rather than showing a counter stuck at zero.

### Backup and moving machines

**Export settings** writes a single vault file. **Export settings + history**
includes your bars as well. Anything that looks like a credential is withheld
and named in the file, so it is safe to email, share, or attach to an issue.

The checksum detects corruption, not tampering. A vault file from someone else
is untrusted input; **Import** always shows you what is inside before writing
anything, and defaults to keeping whichever copy is newer.

### Sync

Alerts, layouts and watchlists across machines. Bars do **not** sync — they are
the same public data everywhere and a re-fetch rebuilds them for free.

Three targets:

- **Local service** — the Python service on 127.0.0.1. Nothing leaves the
  machine, survives a browser cache clear, no account anywhere.
- **Supabase** — see the setup SQL in `src/store/supabase.ts`. The anon key is
  public by design; row level security is what protects your rows, and with the
  single-user policy the space id *is* the secret, so make it long.
- **Custom endpoint** — `GET /sync/pull?since=` and `POST /sync/push`. That is
  the whole contract.

Conflicts resolve last-write-wins and are **reported**, with both timestamps and
both machine names. A sync that silently discards an hour of work is how people
stop trusting sync.

## Type and density

Numbers use tabular figures everywhere, so a price does not change width as its
digits tick. Prose opts out. The terminal ships no font files: it uses faces
that are actually present on the platform, and builds hierarchy from size,
weight and tracking rather than from a family that might not arrive.

The density control beside the theme picker (compact / standard / comfortable)
scales the whole type ramp. Use it rather than browser zoom, which would also
scale the chart canvas off device resolution.

## Higher timeframes

The inspector's **4H / 1D** toggles project higher-timeframe structure onto the current chart. A 4h
structure is marked knowable at the bar that **closed** its 4h candle, never the one that opened it
— drawing it earlier would hand you a head start the live market never gave.

## Replay

`Replay` steps through history bar by bar. The terminal genuinely cannot see past the cursor: replay
hands every consumer a **shorter array**, so there is no future to leak. Detections, indicators,
alerts and the legend all recompute on the visible prefix.

## Regime, forecast and context

The dock's **Regime & model** panel asks the Python service (`python server/mishel_service.py`) for
a GMM regime read and a walk-forward classifier. A forecast whose Brier score is at or above 0.25 is
struck through: that is worse than always saying 50%, so the probability is not usable no matter how
confident it looks.

**Context** shows seasonality by hour, day or month — in UTC, with thin buckets greyed out and
labelled with their sample count — and the next high-impact USD releases from the feature store.

## Chart mouse

Wheel zooms about the cursor; drag pans; vertical drag detaches the price axis;
double-click returns to the live edge.

The keyboard is documented under **The palette, the menus and the keyboard**
above, and the authoritative list is the sheet behind **?** — that one is
generated from the live keymap and cannot go stale.

## Status

Done, and verified by **826 tests across 34 files** (plus the repository suite:
93 files, 0 failures): build and toolchain, the design system, the shell and its
layout modes, the chart engine (columnar `Float64Array` OHLCV, layered canvases,
cursor-anchored zoom, self-healing sizing), the data layer and freshness
contract, indicators (21 functions: SMA/EMA/RSI/ATR/MACD/Bollinger/VWAP/Stochastic/ADX/Keltner/squeeze/Donchian/Ichimoku/Chandelier/anchored VWAP/relative strength/ROC/Williams %R/CCI/MFI/SuperTrend), nine chart sub-panes, live
WebSocket streaming (forming-bar dedup, backoff, silence watchdog,
resync-on-reconnect), the screener over the live Binance universe with per-symbol
glass-box reasoning, automatic structure detection and drawing (pivots,
BOS/CHoCH, S/R levels, FVGs, order blocks, double tops and bottoms, head and
shoulders, trendlines, divergence), the Flow desk, a persistent bar archive with
gap and provenance tracking, multi-source failover, the backtest and validation
suite (walk-forward, PBO/CSCV), alerts with a headless daemon, the whole data
layer (request governor, versioned settings store, response cache, retention,
vault, sync), and — new in v42 — the command palette, the menu bar, the keyboard
registry, notifications, the Analyst, and a native desktop shell.

Not yet built, and explicitly requested: replay and the desks following the
focused workspace pane; alerts running inside the desktop process with a tray
icon; on-chain evidence (the contributor and its shape exist, nothing populates
it, so it truthfully reports absent); multi-timeframe alert conditions; a
desktop installer, code signing and updater; and an accessibility audit. Also
still outstanding: tick storage.

One boundary worth knowing: the **Workspace** desk is additive. Replay, the
alert engine and the other desks all still run off the **Chart** desk's single
feed, not off whichever workspace pane has focus. The topbar and the timeframe
commands do follow the focused pane; the status bar says "chart desk:" there so
the distinction is never implied away.

Live streaming currently covers Binance symbols only. A proxy-served symbol
loads history but does **not** start a socket — the terminal must never claim
live updates it is not receiving.

Still open: an always-on tier so signals keep running with the browser closed,
and a UI for the backtester (it is currently library-only, driven from code).
