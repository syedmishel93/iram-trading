# MISHEL INTELLIGENCE TRADING — SESSION HANDOVER
Terminal: **app/ v50 is the product** (see ../LEGACY.md) · index.html **v39.29** (FROZEN 2026-09-08, still openable at /legacy) + **app/ v58** (Vite/TS rewrite: 3,618 tests in 144 files, 23 desks, connected to the MT5 account for positions and equity — a Briefing, an Analyse and a Chart standing alone, the other 20 in 4 groups) + **desktop/** (Tauri native shell) · Server: proxy `ddt_data_server.py` (8787) + `mishel_service.py` (8788, **SQLite by default, PostgreSQL via `IRAM_DB_URL` — see `server/db/`**) + **`server/quant/` (8789, optional model service — GARCH, causal inference, calibrated classification; the terminal degrades to "not running" without it)** + mishel_ml.py + mishel_hmm.py + mishel_data.py · Launcher: **`run.py` — the only one** (starts `server/gateway`: all three services and the terminal on ONE port, 8787; `--status`, `--port`, `--legacy`, `--no-background`, `--build`, `--install`; `run.sh`/`.bat`/`.command` are three-line wrappers) · Tests: `tests/run_tests.sh`, `python -m pytest tests/test_quant_service.py`.

## v63.24 — HALF THE GRAPH WAS BEING DRAWN WHERE NOBODY COULD SEE IT

The owner could not zoom, and asked for more figures. The zoom was the smaller
half of it.

### THE CLIPPING, MEASURED

At 1900px the canvas was **1448x898 inside a stage 448px tall — 450 pixels of
the graph drawn under `overflow: hidden`**, half the markets below the fold with
nothing on screen to say so. A picture that is clipped silently is worse than a
broken one, because it looks complete.

The cause was a derived height: the script computed `width x 0.62` and never
asked how much room there was. **The fix is that CSS decides and the script
MEASURES what CSS decided** — `.graph-stage` carries `clamp(260px, 52vh, 720px)`
and `measure()` reads both dimensions off the box. No feedback loop, because the
stage's height no longer depends on its contents: a bar that measures itself must
not be sized by what it is showing.

**AND FIXING IT REVEALED THE SECOND HALF.** The stage became 1448x366 — wide and
short — and the graph still settled into its usual round blob: 89% of the height
against **21% of the width**. Uniform scaling is what keeps distance comparable
and it cannot rescue a square arrangement in an oblong box, so the ARRANGEMENT
now starts the shape of its canvas: seeded on an ELLIPSE matching the box rather
than a circle. **21.4% -> 55%.** Only the seeding is anisotropic; repulsion,
attraction and the final scale all stay isotropic, so a horizontal pair still
never reads as closer than a vertical pair at the same strength.

### Zoom and pan

`viz/camera.ts`, pure, with the two properties that carry the whole feel:

* **ZOOMING AT A POINT KEEPS THAT POINT STILL.** If the anchor drifts, whatever
  you were looking at slides out from under the pointer and you chase it.
* **SCREEN AND WORLD ROUND-TRIP EXACTLY.** Hit-testing runs in world coordinates
  and the pointer arrives in screen ones; a few pixels of disagreement means the
  readout names the market NEXT to the one under the cursor, which no amount of
  looking can falsify. The pointer handler now converts before hit-testing —
  without it the graph would have been right until the first zoom and quietly
  wrong after.

**THE CAMERA IS APPLIED PER POINT, NOT AS A CANVAS TRANSFORM.** `ctx.scale` would
multiply line widths, node radii and the FONT along with the positions, so at 4x
the labels become billboards. Transforming coordinates and leaving strokes and
glyphs in screen space keeps a zoomed graph looking like a map. Labels collide in
SCREEN space, so zooming in is how you read the names the dense cluster could not
show.

Wheel, drag, double-click to reset — plus **− / + / Fit buttons**, because a
control that exists only as a gesture is one somebody never discovers; this
project has already paid for a panel whose only routes back were a key and a 22px
icon. A view change resets the camera: a 4x zoom on the corner of the market web
would open a graph of background jobs somewhere meaningless.

### The figures

**STAT TILES, per view**, because a card that answers a question should lead with
the answer rather than making somebody hover every node in turn. Read off the
live desk: *Strongest link — NDX · SPX, +93% over 3,999 shared days*; *Most
connected — ETHUSDT*; *Did not hold — 1 of 29*. Every tile carries its own
qualifier; a bare number is one nobody can argue with.

**A ROLLING-CORRELATION SPARKLINE ON EVERY PAIR.** `stable` says THAT a pair
reversed and `instability` says by how much; neither says WHEN, which is the
difference between a caveat and something an operator can act on. Added to
`data/correlation.ts` — the owner — not to a fourth module.

Two traps pinned:

* **EACH POINT IS STAMPED AT THE END OF ITS WINDOW.** A correlation from bars up
  to Friday is a fact you possess on Friday; drawing it at Wednesday puts
  knowledge earlier on the axis than it existed — look-ahead in a picture, as
  invisible as reading a daily bar's close during its own day.
* **A FIXED -1..+1 DOMAIN**, never scaled to its own range: a pair that wobbled
  between +0.62 and +0.66 would otherwise draw the identical dramatic zigzag as
  one that crossed from -0.9 to +0.9. Same rule `ui/cards/plot.ts` exists for.

And a window below the overlap floor is **REFUSED, not raised to it** — silently
promoting a request for 10 days to 30 answers a different question than the
caller asked, with nothing to say so.

### Gate

`python verify.py --lint`, all 7 stages, **145s**: **4,750 tests in 222 files**
(was 4,726). Verified on the python build at :8787: clipping 532px -> **0**,
width used 21.4% -> **55%**, wheel zoom reading "1.9x · drag to move", and a
hovered node rendering **7 rows with 7 sparklines** — XRPUSDT · BTCUSDT +66% over
1,000 days.

**No exe.**

## v63.23 — CONNECTIONS: THREE GRAPHS, AND ONE OF THEM FOUND A REAL FAULT

The owner sent two screen recordings and asked for that kind of live
visualisation "where applicable". **One of the two videos had no visualisation
in it** — all 8.6s were a loading screen reading "INITIALIZING ENVIRONMENT /
000%", measured rather than assumed: mean pixel 0.14/255, 0.11% of pixels lit,
identical at every timestamp. Said so rather than inventing a reading of it.

**AND THE FRAME GRABBER'S FIRST ANSWER WAS ITS OWN DEFECT.** Twelve captured
frames hashed IDENTICALLY, and 73% of pixels lit on every one — which looks
exactly like a static video. `seeked` fires when a seek is ACCEPTED, not when a
frame has been painted, so every canvas held the same frame.
`requestVideoFrameCallback` plus a self-check that prints "distinct frames: 1 of
9 — THE CAPTURE IS BROKEN, not the video" is what turned a false finding into a
visible one. Same family as the audit script that parsed nothing and reported ok.

### Where it applies, and where it would have been decoration

Three relationships in this product are genuinely graphs, and all three had live
data. They became ONE desk with a view switch rather than three desks, because
they want the same renderer, the same layout and the same honesty rules — three
surfaces would be three places for the encoding to drift.

| view | nodes | an edge means | live result |
| --- | --- | --- | --- |
| **Markets** | 15 daily series held | they move together | 29 drawn, 76 measured and unrelated, 0 unmeasurable |
| **System** | 24 background jobs | **they are failing the same way** | **2 shared faults across 5 jobs** |
| **Search** | rules and market states | this rule was tried in this state | empty on this profile, and it says why |

### THE SYSTEM VIEW FOUND THE DEADLOCK BY ITSELF

Its first run on the real log printed:

> **3 jobs are failing the same way — "database is locked" — 2,100 entries
> between them. One cause, not 3.**

That is the nested-write deadlock this file already documents at length, found
without being told to look for it, from data that was already on screen as 24
separate rows. A second cluster came with it: two jobs sharing a blockchain.info
read timeout. **A job-to-kind graph would have been twenty little stars saying
nothing a list does not**; the relationship worth drawing was the one that has
already cost a release.

`failureSignature` is the whole difficulty: match raw text and every occurrence
is its own group, so the picture shows no shared causes at all — which looks
exactly like a healthy system. Normalise too hard and everything lands in one
cluster. Urls collapse to their host, numbers and hashes to `#`, words kept.

### ONE FACT, ONE OWNER — the near miss

The cross-asset web was about to become **the FOURTH implementation of
correlation** in this repository: `data/correlation.ts` (the Risk desk's heat
understatement), `data/context.ts` (the screener's scan), `study/stats.ts
pearsonAt` (the lag-capable one), and a new one. Caught by looking before
writing.

So the measurement stayed where it already lived and GAINED what it was missing:

* **A SUB-WINDOW STABILITY CHECK.** A pair that was +0.9 for the first half of a
  window and -0.9 for the second averages to about zero, which draws as "these
  two are unrelated" — the opposite of the truth, and indistinguishable from it
  by `r` alone. `correlate()` now slices the overlap into four and returns the
  RANGE. This reaches the Risk desk too, which is where a correlation that
  quietly reversed is most expensive.
* **A BUCKETED JOIN.** yfinance stamps a daily bar at midnight and a broker at
  its session open, so the exact-timestamp join reported ZERO overlap between two
  series covering the same days. `utcDay` is opt-in, so every existing caller is
  untouched, and one pair per key or a bucketed join inflates its own sample.
* **UNKNOWN IS NOT STABLE.** Too few bars to slice means the question was never
  asked; answering "steady" there would be the strongest claim from the least
  evidence.

`backtest/correlate.ts` is now only the PICTURE: which symbols are nodes, which
pairs earn a line, and what is refused.

### VALIDATED AGAINST ECONOMICS, NOT AGAINST ITSELF

Read off the live desk, with no fixtures:

| pair | r | days | held |
| --- | --- | --- | --- |
| DXY / EURUSD | **-57%** | 854 | yes |
| DXY / XAUUSD | **-40%** | 997 | yes |

EURUSD is ~57% of the dollar index and mechanically inverse to it; gold is priced
in dollars. The module rediscovered two relationships that are true by
construction, which is far stronger evidence than any fixture.

### THE PICTURE IS THE CLAIM, so every channel is a tested pure function

`viz/render.ts` owns the encoding and `viz/layout.ts` the positions, both pure:

* **WIDTH IS MAGNITUDE, COLOUR IS DIRECTION, DASH AND ALPHA ARE CONFIDENCE, and
  they never cross.** Gold against the dollar is one of the most reliable inverse
  pairs there is; drawing -0.9 thinner than +0.9 would say it is weaker. A strong
  pair that reversed stays THICK and goes dashed.
* **DETERMINISTIC LAYOUT.** Seeded from a hash of each node's own id, never
  `Math.random`: a picture that settles somewhere new on every draw cannot be
  compared with last night's, and the operator correctly stops reading it.
* **THE SIGN IS A COLOUR, NEVER A DISTANCE.** An inverse relationship is a
  relationship, so the layout uses the magnitude.
* **LABELS SKIP ON COLLISION**, the same rule the chart axis already uses — the
  crypto cluster put five names in fifty pixels and none was readable. The
  hovered one is always drawn.
* Every colour is a TOKEN read off the host at paint time, so a theme change
  reaches the canvas with no notification at all.

### THE LAYOUT COLLAPSED, AND GEOMETRY IS HOW IT WAS FOUND

MEASURED on the real desk by reading the painted pixels: the ink occupied
**23.3% of the canvas width and 37.9% of its height** — three quarters of the
picture empty, the dead-space defect this file has recorded on four other
surfaces. Two causes: a centring force that did NOT cool while repulsion and
attraction both did (over 400 steps it retained 4% of every distance, so a
related pair and an unrelated one ended up equally far apart — the one claim a
force graph makes), and no fit to the box afterwards.

`fitToBox` scales **UNIFORMLY**, and uniform is the load-bearing word: stretching
x and y differently to fill a wide box would make a horizontal pair look closer
than a vertical pair at the identical correlation. **51.8% x 87.7%** after.

### Three defects the tests found before the browser did

* **`new ResizeObserver` UNGUARDED THREW AND TOOK THE WHOLE DESK WITH IT.** It
  does not exist in jsdom, and CLAUDE.md already records that it delivers nothing
  in a background tab. It is now the preferred path and never the only one.
* **THE LOAD HUNG ON `onShown` ALONE**, whose check is
  `getClientRects().length > 0` — always zero in jsdom. `refresh()` is exposed as
  the second path, which is also what the Refresh button calls.
* **A GUARD TEST PINNED A COUNT.** "runs all eight, the same ones Manual runs"
  broke on the ADDITION of the search check while it would have passed if one
  check had been SWAPPED for another. It now derives the Manual set from the real
  evaluator and asserts a SUPERSET — the fact it existed to protect.

### An empty view explains itself

"Nothing to draw" and "nothing has been kept yet, so there is no field to draw"
are different facts, and only the second says whether to wait, to press
something, or to go and look. Each view supplies its own `emptyWhy`.

### Gate

`python verify.py --lint`, all 7 stages, **158s**: tsc clean, **4,726 tests in
221 files** (was 4,618), ruff within the five deferred rules, mypy clean.
`scratchpad/classcollide.py` was run BEFORE choosing `.graph-` — ten prefixes in
this project are already claimed twice, and the last sheet to import wins
silently.

**No exe.** Browser and python build only, as standing.

## v63.22 — THE ENGINE WAS CHARGING A COST OF ZERO AND CALLING IT A HURDLE

Three modules were complete, correct, tested, and reaching nothing. Measured
before building, which is what decided the order:

| built | wired to | what it cost |
| --- | --- | --- |
| `backtest/friction.ts` — venue/mode fees, `carryPerNight`, spread basis | **NOTHING. No importer anywhere.** | overnight financing charged as ZERO on every run |
| `backtest/intrabar.ts` — stop-vs-target resolver with coverage refusals | `ledger.ts` only, never the backtester | every ambiguous bar assumed a stop |
| `study/stats.ts deflatedSharpe` — the best-of-N hurdle | the Simulation DESK, never `setup/gates.ts` | the live verdict did not know its rule won a 550-arm search |

### 1. The carry, which is most of a swing's cost

Against this engine's own round trip of 0.1200% ex-carry:

| hold | carry | share of total cost |
| --- | --- | --- |
| 5-night swing | 0.05% | **29%** |
| two weeks | 0.14% | **54%** |
| two months | 0.60% | **83%** |

All charged as zero, so every swing and position result the search has ever
ranked was flattered in the direction that promotes strategies.

**`Costs.carryPerNight` IS REQUIRED, and that is the fix.** An optional field
defaulting to zero reproduces exactly the invisibility being removed at every
call site that forgets it. Required made `tsc` enumerate the five charging sites
and each one states an answer — the same shape as `startBackup`'s transport
losing its live default. The engine multiplies the RATE by the nights each trade
actually held (`nightsBetween`, UTC midnights crossed), because a caller's
"typical hold" is a guess and the engine has the real one. Spot is a stated zero.

**A UNIT ERROR CAME OUT WITH IT.** `binance-perp.carryPerNight` held Binance's
published 0.01% funding rate, which is per EIGHT HOURS, under a per-night name —
undercharging every perpetual swing threefold. `PERP_FUNDINGS_PER_DAY = 3` is now
a named constant so the unit cannot go missing again.

**AND A NaN HAZARD THE GATE FOUND FOR ME.** A stress-test fixture predating the
field made `undefined * 2` a NaN carry, and NaN compares false against every
threshold — so a promotion gate reads it as "did not clear" and a ranking reads
it as a tie. Two different cost models produced byte-identical results because
both were NaN. `runBacktest` now refuses a non-finite or negative cost term BY
NAME rather than returning a run that looks measured and says nothing.

### 2. The intrabar resolver, scoped by measurement rather than by its docstring

Its own header calls it "the largest remaining source of error in the engine".
Measured, it is not — bars holding BOTH a stop and a target:

| stop / target | BTCUSDT 1h | SPX 1d |
| --- | --- | --- |
| 2.0 ATR / 2.0 R | 0.0% | 0.0% |
| 1.0 ATR / 1.5 R | 0.8% | 0.2% |
| **0.5 ATR / 1.0 R** | **7.7%** | **5.7%** |

So it is worth wiring and worth scoping honestly: near free at wide stops,
material only for tight-stop styles. **PROVED END TO END ON REAL BARS** through
`runJob` — the path the server actually calls — over BTCUSDT 1h against 59,919
real minute bars: **6 of 6 doubtful exits settled**, 3 flipped from stop to
target, mean R **-0.2756 -> -0.2421**. This is the one change in the set that
makes results look BETTER, and it does so by replacing a guess with a
measurement rather than by lowering a bar.

`minutes` ride on `opts` where `macro` deliberately cannot, and the reason is the
key: minutes are keyed by TIME, so a sliced walk-forward run still looks up the
right ones, while macro columns are keyed by INDEX and would be silently
misaligned. Only ambiguous bars consult them, through a monotonic cursor, so five
years of 1m stays linear instead of quadratic.

`Trade.exitBasis` has THREE states. `unambiguous` is neither of the others:
folding it into `measured` would make the resolved share RISE as ambiguity fell,
so a run with nothing to resolve would report itself perfectly resolved — the
shape of the strip that painted "0 of 0 running" green.

### 3. The check that knows the rule was found by a search

`setup/gates.ts` had no reference to `trials`, to `deflatedSharpe` or to the
hurdle anywhere in 855 lines. The Simulation desk computed it and showed it; the
card proposing the live trade never asked. So the measured best arm — +0.070
against a hurdle of +0.102 — would have been offered with eight green ticks
beside it, every one about the market rather than about the rule's provenance.

`SearchCost` carries three RAW facts and `deflatedSharpe` does the arithmetic: a
caller handing over a pre-computed `deflated` would be handing over the
conclusion, and that function is the one owner of a correction defined on a
PER-TRADE Sharpe. `gatesFor` takes it as a REQUIRED fourth argument, so the
autonomous path cannot forget to pass its own and the Manual desk states `null`.
A hand-drawn setup shows no search row at all.

**A GUARD TEST PINNED A COUNT AND WAS RESTATED.** "runs all eight, the same ones
Manual runs" broke on the ADDITION of a check while it would have passed if one
had been swapped for another. It now derives the Manual set from the real
evaluator and asserts a SUPERSET, which is the fact it existed to protect: the
autonomous path is never weaker than the hand-drawn one.

### 4. Slippage that scales, and what it must not do

`slippageAtrMult` is OPTIONAL, unlike the carry, and the distinction is the
argument: an absent carry meant a real cost charged as zero, while an absent
multiple means the flat figure — this engine's stated assumption — still applies.
The charge is the GREATER of the two, so turning it on can never make a backtest
cheaper than it already was.

**THE ATR COMES FROM THE LAST CLOSED BAR.** A fill happens at a bar's OPEN, so
pricing it from that bar's own range is look-ahead — and it runs in the
flattering direction, because the bar that gapped against you is exactly the one
whose ATR would have warned you. Pinned by construction: two series identical up
to the fill bar and differing after it must produce the same entry price.

### 5. What the operator reads

`BacktestResult.friction` states what the run PAID — spread, slippage actually
charged, commission, carry, nights held — and friction as a SHARE OF THE MOVE the
trades captured. `friction.ts` had argued for exactly this in its own header
while having no importer to argue to. Measured on a real tight-stop run: costs
were **23% of what those trades moved**.

**ITS SENTENCE WAS WRONG BEFORE THE PROBE READ IT ALOUD.** A 350-night swing
charged at a zero rate printed "No position was held overnight, so nothing was
financed" — every number right, the sentence about a different run, which is
worse than being visibly wrong because nothing looks off. Three states now: no
nights, nights at a real rate, and nights on a venue that charges nothing.

Receipts go to **version 2**: all four cost terms, the multiple, what was PAID
beside what was CHARGED, and how many doubtful exits were settled. A v1 receipt
recorded three terms because the engine charged three, and gave a reader no way
to tell whether the carry was zero or unasked.

### THE LAB BUNDLE WAS STALE, AND NOTHING SAID SO

`server/engine/lab-engine.mjs` is compiled from this TypeScript and had **ZERO**
occurrences of `macro` — so v63.21's whole conditioned-arm capability existed in
the browser and had never reached the server-side autonomous loop. Rebuilt; it
now carries macro, carry, settle and the ATR scaling. **A compiled artefact is a
second copy with no type checker between it and the source**, and the only thing
that catches it is asking the bundle what it contains.

Then DRIVING it, because a bundle that CONTAINS a string is not one that RUNS it:
expectancyR 1.61377 -> 1.54661 with financing on, carry **55% of that run's total
friction over 350 nights**.

**AND THE PROBE'S FIRST RUN WAS A FALSE POSITIVE OF ITS OWN.** It sent
`{spec, bars, costs}` and both runs came back identical, which looks exactly like
a worker ignoring the carry. A STUDY job reads `job.opts.costs`; only a LEDGER
job reads `job.costs`. Two spellings of one fact on one wire format, and a caller
using the wrong one gets `DEFAULT_COSTS` silently — recorded in the backlog
rather than changed, because `lab.py` and its tests describe the format.

### The 1m tier, measured rather than estimated

`backfill.py` already supported `1m`; the capability needed no new code, only
using. **141.9 bytes per bar, measured** against the database file — so 5 years
across four markets is **1.49 GB**, not the 0.6 GB the plan had estimated.

Held now: BTCUSDT **400,132** and ETHUSDT **400,000** minute bars, 278 days each,
both reporting `short=True` honestly against the year asked for — Binance's REST
paging appears to cap near 400,000 a run, and a resumed run extends it.

**THE READ PATH IS THE REMAINING LIMIT, NOT THE STORE.** `MAX_PER_GET` is 60,000,
so a study can read at most 41 days of minutes in one call. The engine accepts
minutes and settles with them; a sweep over five years cannot yet be handed the
minutes for it. The shape that fits is TWO PASSES — run without minutes, collect
the few hundred ambiguous bar stamps, fetch only those, re-run — which is tens of
thousands of bars, well inside the cap. Not built, and not claimed.

### THE 174 TEST FILES ARE NOT TYPE-CHECKED

`tsconfig.json` includes `["src", "vite.config.ts"]`. A fixture annotated
`FlowSettings` that no longer satisfies `FlowSettings` compiles, and fails at
runtime inside a swallowed `effect` — which is how two settings fixtures went
missing a required signal with `tsc` reporting zero errors. Same mechanism as the
nineteen unlisted Python test files and as `run.py` being linted by nothing: a
path in no list is a path nobody checks. Recorded, not fixed — it is its own
piece.

### Gate

`python verify.py --lint`, all 7 stages, **307s**: tsc clean, **4,618 tests in
214 files** (was 4,584), 28 scripts, ruff within the five deferred rules, mypy
clean. Every fix was proved by DELETING it and watching the right test fail —
the carry charge (2 of 14 failed, and the "reports the total" test correctly kept
passing, which is the reported-but-not-charged state it distinguishes), and the
intrabar resolution (1 of 9, the load-bearing one).

**No exe.** Browser and python build only, as standing.

## v63.21 — THE TEST WAS UNDERPOWERED, AND DEEPENING IT DISPROVED THE RULES

The owner's reading was that traditional strategies were not producing good
output. MEASURED across 22 markets and 550 (rule x market) results: median
per-trade Sharpe **-0.109**, 35% above zero, and **0 of 334** graded arms
cleared the hurdle a 550-arm search demands. Six cleared the project's own
recorded +0.29, and three of those six were the SAME rule on correlated crypto.

**But at 42 days of history that number could not mean what it looked like.**
Every series held ~1,000 bars, so an arm got a median of 46 trades, and the
best-of-N hurdle is `sqrt(2 ln N)/sqrt(n)`: +0.524 at n=46, +0.251 at n=200. At
that depth "no edge" and "cannot see one" are the same reading.

### The deep archive, and what it actually proved

`svc/backfill.py` fetches deep history into the `bars` table the studies read —
NOT `bulkfetch`, which writes Parquet that no study has ever read. Sources
measured live rather than assumed: Binance REST pages cleanly (44 requests for
5 years of 1h); **the MT5 bridge holds ~15 YEARS** (XAUUSD 45,235 bars back to
2011, EURUSD 47,424) and is the series the operator is FILLED on; yfinance hard
-caps 1h at 730 days and says so.

| | bars held | span |
| --- | --- | --- |
| BTCUSDT, ETHUSDT (binance) | 44,000 | 5.0 y |
| XAUUSD (broker) | 43,800 | 9.3 y |
| EURUSD (broker) | 43,800 | 7.0 y |

From 1,008 each — **43x**. The macro spine went to decades of daily.

**`MAX_PER_GET` was 20,000, BELOW the 60,000 a study asks for.** Deep history
could have been stored and silently truncated on the way out, with the study
reporting its window as though 20,000 were the archive.

Then the payoff measurement, which did not go the flattering way:

| | shallow (42 days) | deep (5 years) |
| --- | --- | --- |
| median trades per arm | 58 | **821** |
| best per-trade Sharpe | +0.374 | **+0.070** |
| hurdle | +0.450 | **+0.102** |
| arms clearing it | 0 | **0** |

The hurdle fell 4.4x exactly as the arithmetic said it would — and **the best
shallow result collapsed from +0.374 to +0.070 on 14x more data.** That is the
overfitting, measured. The depth did not rescue the shipped rules; it disproved
them properly. A test that can answer, answering "no", is worth more than one
that cannot answer at all.

### THE SWEEP WAS STUDYING SERIES NOBODY CAN TRADE

`data/library.ts` MACRO_SPINE has always split itself "Traded." / "Read." — as a
COMMENT, so nothing could act on it and `auto.subjects()` handed US10Y and VIX
to the sweep. One of the six best results across 22 markets was
`williams-reversal on VIX`. The cost is not the wasted pass: every untradeable
arm RAISES the best-of-N hurdle for the rules that could be taken, so cutting
them is the cheapest reduction in N available. `read` is a field now, mirrored
by `CONTEXT_SYMBOLS` in `svc/auto.py` and cross-checked by
`tests/test_auto_context.py`, which fails on a zero parse as well as on a
disagreement — two lists naming one group is how `views.ts` and `toolsmenu.ts`
came to agree on 0 of 24.

### THE VOLUME BAND WAS 85% EMPTY AIR

It scaled linearly against the VISIBLE MAXIMUM, and volume is heavy-tailed.
MEASURED on BTCUSDT 1h into the 42px the band has: median bar 4.5-6.1px
(11-15%), up to 23% of bars under three pixels.

`chart/volscale.ts` anchors on `min(p95, median x 3)` and clips. **Not a log**,
which measured best (median 75%) and is the wrong answer: under log a bar that
traded ten times the median draws 1.3x its height, so a volume climax — the one
event anybody reads the strip for — renders ordinary. A wrong SCALE is
plausible, unlabelled and not red.

A percentile alone does not bound readability, and the first version assumed it
did: on a tame tail p95 sits near 3.3x the median (median at 30%), on a heavy
one at 9x (median back to 11%, the defect surviving its own fix). A SYNTHETIC
heavy-tail test caught that; the real-data measurement alone would not have.
Measured after: median **33% of the band at every window size**, 0-1% under
3px, 6-7% clipped — and the clipped bars carry a cap tick, because a bar drawn
at full height that is really 4x the reference is the same understatement
pointed the other way. The readout now leads with **relative** volume
("0.3x 194"): "7.83" says nothing without the window it sits in.

### 28 OF 29 DETECTORS WERE SWITCHED OFF

`detectors` was persisted and read back verbatim with no design generation, so
a set chosen once survived every later change. The owner's terminal had **one**
detector on — `structure`, which emits BOS/CHoCH and no levels at all — and the
chart truthfully reported "0 levels, 0 patterns and 0 gaps among 50 marks",
which reads as a statement about the market. The trial ledger agrees: **51 of 52
rows are bos/choch**, so the conditional-edge layer could only ever learn about
structure.

The fallback was also a hand-written `["structure","fvg","levels"]` while
`DEFAULT_DETECTORS` — imported into that same file — names nine. Two lists, one
fact, disagreeing. `DETECT_DESIGN` resets the saved set ONCE, the way
`DOCK_DESIGN` did for the v5 inspector. VERIFIED live: **"Auto-marking, 9 on"**,
84 objects on the chart carrying SSL, springs, upthrusts, prior-day levels and
confluence where there had been only BOS and CHoCH.

And the refusal now names its cause — "Levels, Order blocks and Fair value gaps
are switched off — turn them on in Auto-marking" — because a refusal an operator
cannot act on is the failure this file keeps recording. Two existing tests
pinned the old SENTENCE and were rewritten to pin the FACT in it.

### CONDITIONING: the join is the whole risk

`backtest/macro.ts` puts a macro series on traded bars. **A BAR STAMP IS NOT A
BAR'S CLOSE** — yfinance stamps a daily bar at the START of the day, so reading
DXY's 2026-09-25 close on a BTC bar at 10:00 that day is look-ahead, invisible,
and flattering. `closeTimeOf` is the one line that separates a conditioned
backtest from a leaking one, and deleting it fails the test. A CHANGE is
computed on the macro series' OWN bars and only then aligned, because a
five-row diff over carried-forward values spans three trading days across a
weekend. What is not known is NaN, never zero. A thin overlap refuses by name.

`backtest/macro.ts buildMacroColumns` turns the spine into the eleven columns
`rules.ts` now declares — `dxy`, `dxy_chg5`, `us10y`, `us02y`, `vix`, `spx`,
`usdjpy`, `copper_gold` and the changes. A series nobody downloaded is REPORTED,
not defaulted: the column fills with NaN, every comparison against NaN is false,
so a rule conditioned on missing data cannot fire. A zero would have been a real
dollar index of nought and the rule would have FIRED on it.

A bug the tests caught: `copper_gold` read an alignment map that only `put()`
fills, and neither COPPER nor XAUUSD is a column of its own — so the ratio was
NaN even with both series present.

### THE DRAWING TOOLS DID NOT NEED WORK

The plan said the gap there was reachability. MEASURED: the `DrawKind` union has
**13 members and `DRAW_KINDS` offers all 13**, each with a label and a hint,
every one reachable from the command palette and the tools menu, with magnetism
already implemented. Nothing is unreachable.

That is the THIRD plan this codebase has overturned by being opened and measured
— after the Watchlist's heatmap and the Calculator's layout. What was worth
adding is a guard that it stays true: a kind added to the union and not to
`DRAW_KINDS` compiles, renders when constructed, and can never be chosen.

### THE FIELD NOW PAIRS EVERY RULE WITH EVERY STATE

`backtest/conditioned.ts` builds the conditioned arms. Six states, three axes at
two signs — dollar, long yields, volatility — each carrying the PRIOR that
justifies spending arms on it, recorded before the run so a result can be read
against what was expected. Every state is a SIGN TEST on a change, never a level
like `vix > 20`: a threshold is a number somebody chose, and choosing it is a
second search nobody charged for. The state gates BOTH directions, because
applying a dollar prior to longs only would bake in the answer the search exists
to find.

**AND THEY ARE OFF UNLESS THE CONTEXT IS ACTUALLY LOADED.** This is a safety
property, not a preference. A conditioned arm whose column is NaN can never
fire, so adding 150 of them widens the field from ~85 to ~235 and RAISES the
hurdle (`sqrt(2 ln N)/sqrt(n)`) for every real arm while contributing nothing —
the search gets strictly harder and no better. `contextAvailable` defaults to
false and `buildField` adds none without it.

### THE ARM COUNTER WAS PUTTING THEM IN THE WRONG BUCKET

`countField` did `else library += 1`, so 150 conditioned arms were counted as
library rules — and the operator's line read `175 library rules + 10 hybrids =
185 to test`, a sentence whose two sides no longer added up. A bucket that
absorbs what it does not recognise stops adding up silently, so there is now an
`other` bucket that catches an unrecognised origin instead of one of the named
ones swallowing it, and a test asserts the parts equal the total.

Four existing tests pinned the old field width and had to be re-pointed at the
RELATIONSHIP rather than the arithmetic: "is every library rule plus hybrids"
was a test about DETERMINISM failing over a count, and "reports progress as
rules finish" now asserts one tick per entrant with the runner itself as the
witness to how many there were.

### THE LAST HOP, AND THE TRAP IN IT

A job now carries `context: { SYMBOL: [{t, c}, …] }` at daily bars. `parseJob`
aligns it ONCE per job rather than per arm — a 44,000-bar study against a
25,000-bar daily series would otherwise redo the walk for every one of 150
conditioned arms — and `runJob` reports which series it was given, because a run
that had none is not the same as one whose rules found nothing and from outside
they look identical: both complete and both report numbers.

**THE TRAP WAS THE SHARED CONTEXT.** `runBacktest` reuses a cached context keyed
on the BARS' IDENTITY, which says nothing about whether that cache carries the
context series this caller asked for. A sweep that built one plain context first
would have handed it to every conditioned arm, each would have read NaN, and 150
arms would have silently never fired — while still raising the hurdle for
everything else. The reuse now checks the macro presence too, and deleting that
check fails its test.

A malformed context series is REFUSED rather than dropped, for the same reason:
a silently dropped series leaves every conditioned arm reading NaN, which looks
exactly like a rule with no signal.

Proved end to end by `a conditioned rule fires WITH context and not WITHOUT` —
the same rule on the same bars trades when the dollar is falling, trades nothing
when it is rising, and trades nothing at all with no context loaded. Three
separate deletions of the wiring each fail it.

**Gate: `VERIFY PASSED — 7 stages, 280s`. 210 files / 4,571 tests (+56), plus
29 new pytests.** Twelve guards were deleted and watched to fail before being
believed, including one that PASSED when deleted — `store()` returning a cleaned
input length coincided with the table count until an OVERLAPPING write told them
apart, which is exactly what a resumed backfill sends.

## v63.20 — THIS TERMINAL PUBLISHED AS AN MCP SERVER, AND TWO BUTTONS THAT WERE NOT BUTTONS

`svc/mcp.py` made this product a CLIENT of other people's MCP servers. `svc/mcpserve.py`
is the other direction, which is the half the owner asked for second: Claude Desktop or
any MCP client can now read what history is held, what the broker says, and how the
machine's past reads worked out. Five read-only tools at `POST /mcp`.

**OFF UNTIL THE OPERATOR TURNS IT ON, and that is the whole consent model.** Every other
capability here reads local data onto a local screen. This one is different in kind: an
MCP client forwards what it reads to whoever runs it, so equity, open positions and a
track record leave the machine. `enabled()` is false until somebody says otherwise and
the card's switch is the feature.

**THE SECURITY BOUNDARY IS STATED HONESTLY RATHER THAN FLATTERINGLY.** The gateway has ONE
secret, `core._svc_token()`, and it is optional — with none set, `/svc/*` is reachable by
any process on the machine. This module reuses that secret rather than inventing a second,
and the card prints `reach` as a SENTENCE: "any process on this machine". A token here
would be theatre while the rest of the surface has none, and a green "secure" chip would
be a claim this product cannot make. What is bought and is not theatre: off by default,
a read-only ALLOWLIST (`TOOLS` is the whole reachable surface, so `/svc/store/evict` and
`/svc/mt5/import` cannot be reached even by a caller who knows they exist), and **every
`Origin` refused** — an MCP client never sends one and a browser always does, which closes
DNS rebinding properly instead of leaning on the gateway's deliberately permissive
loopback CORS regex.

**THREE QUERIES WERE LIFTED OUT OF ROUTE BODIES rather than copied.** `bars.read_bars`,
`bars.inventory` and `core.event_groups`/`events_summary` are now plain functions the
route and the MCP tool both call. A second copy of the failure-word classifier would have
drifted from the one the System desk shows, with nothing saying so.

**THE LOOPBACK IS THE TEST THAT MATTERS.** `tests/test_mcp_server.py` drives THIS PRODUCT'S
OWN CLIENT over `httpx.WSGITransport` into the real Flask app, so the two halves are checked
against each other rather than against a reading of the specification — a tool result is
prose-wrapping-JSON, and if the server framed it differently from what `embedded_json`
parses, no other assertion in the file would have noticed. Verified live too: the client
handshaked its own server (`iram-terminal`, protocol 2025-06-18) and read all five tools.

**MEASURED LIVE with the server briefly on, then switched back off:** 22 series / 21,996
bars from `history_inventory`; `risk_state` 50ms; `track_record` 171ms; `background_jobs`
23 kinds, 0 failing, 1 waiting on the operator (FRED); `bars` returned real BTCUSDT candles.

### What the tests caught, each a defect this file already names

- **A KEY WRITTEN BY ONE SIDE AND READ BY THE OTHER.** `serve_enable` wrote the `kvstore`
  table; `core.cfg` reads `config`. The switch returned `{ok: true, on: true}` and
  `enabled()` stayed false — success reported by a write nothing consults. Every other
  module in the tree writes `config`.
- **A REFUSAL THAT NAMED A SCREEN THAT DOES NOT EXIST.** The off-switch message said
  "Settings -> MCP server". The card is on the System desk under "Publish to an AI client".
  A refusal pointing at the wrong place is worse than one pointing nowhere: the operator
  looks, fails to find it, and concludes the feature was never built. Now pinned by a test.
- **A LIVE DEFAULT, CAUGHT BEFORE IT SHIPPED.** The card first called `serveState`/`setServe`
  directly. Under vitest the global `fetch` reaches a running gateway, so a test of the
  toggle would have TURNED THE REAL SERVER ON. The transport is now a parameter with no
  default — the fix `startBackup` needed, applied before the fourth door opened.

### `class: "btn"` IS NOT A BUTTON, AND NOTHING IN THE GATE CAN SEE THAT

The card's switch — its only action — shipped as `class: "btn"`. **This tree declares no
`.btn` anywhere.** MEASURED in the browser: transparent background, `0px` border, 21px
tall. The control that is the entire point of the card rendered as plain text. `tsc` does
not read CSS, no test opens a stylesheet, and a class matching nothing is legal in both
languages — the same shape as the undefined custom property that INHERITS rather than
being ignored, and as `.wl-table`, a class no element has.

`scratchpad/classundeclared.py` asks the question that finds it: which classes does the
TypeScript apply that no sheet declares. **It immediately found a PRE-EXISTING one** — the
Risk desk's "Analyse the book" button, the control that runs the portfolio analysis, wearing
the same dead `class: "btn"`. Both are `ghost-btn` now, which also inherits press feedback
and hover from `press.css` instead of needing its own.

**NOT GATED, and the reason is in `tests/test_audits.py`:** 98 of its findings are
`querySelector` hooks that legitimately need no rule, and a check whose normal state is 98
findings is one people learn to ignore — the failure mode `cssdupe.py` was narrowed to
avoid. Run it when adding a card. It prints what it parsed and fails on a zero in either
half, and it was PROVED against the real defect: reinstating `class: "btn"` makes it report
the row, removing it makes the row go.

Ghost rather than primary is a decision, not a fallback: turning this on opens an egress
path for the operator's account figures, and a button styled as the thing the page wants
you to press is the wrong shape for a consent control.

### THE PER-SYMBOL TRACK RECORD HAD NEVER WORKED — `mishel_claims.stats`

Sweeping all 46 GET routes with HOSTILE query values (`probe.py` calls them with
valid ones and truthfully reports 0 of 68 broken) found **68 crashes across 8
routes**. Sixty were the query-string twin of the POST defect —
`int(request.args.get("limit"))` with no guard — and `svc.core.arg_num` now owns
that at all 13 sites: coerce, clamp, never raise, and fall back to the DEFAULT
rather than refusing, because these are page sizes and windows where "show me
50" beats a stack trace.

**THE OTHER EIGHT WERE A FEATURE THAT HAS NEVER ONCE WORKED.**
`mishel_claims.stats` builds `where` and `args` from `symbol`, `timeframe` and
`since`, and then:

    raw = [dict(r) for r in conn.execute(sql + " ORDER BY at ASC").fetchall()]

**`args` is never passed.** The SQL carries `?` placeholders and sqlite3 gets
none, so every filtered read of the track record has raised "Incorrect number of
bindings supplied" since the filters were written. The question "how did this
machine do on GOLD" — which is what the claims ledger is FOR — has only ever
answered 500, and the desk rendered that as a service being down.

Why it survived: **the unfiltered call builds no placeholders**, so the card
showing the overall hit rate worked perfectly. The same shape as every other
entry in this file — the success path and the failure path were indistinguishable
from outside, and only the half nobody swept was broken.

`mishel_edge.fetch` is the same function ten lines shorter and it passes `args`
correctly, which is what proves this was a one-off rather than a house habit.

MEASURED LIVE on the operator's real ledger after the one-line fix:

    unfiltered      733 claims
    symbol=BTCUSDT  443 claims      <- a 500 for the life of the feature
    timeframe=1h    426 claims
    symbol=NOSUCH     0 claims, ok=true   (an honest empty, not an error)

Six tests were written FIRST and all six failed against the defect; reinstating
it fails them again. The fixture needed fixing twice before it measured the right
thing — three claims sharing an entry and a stop collapse under `dedupe`, which
is working as designed, so the first version was measuring the deduper rather
than the filter. It now ASSERTS its own precondition (`claims == 3`) before
testing anything.

And `since` was guarded inside `stats()` rather than at the route, because the
MCP `track_record` tool calls that function DIRECTLY — a guard at the route
would have left the tool exposed.

| | |
| --- | --- |
| hostile query values sent | 370 across 17 routes |
| crashes, first run | **68 across 8 routes** |
| after `arg_num` | 10 |
| after the `since` guards | **0** |

### THE POST SURFACE HAD NEVER BEEN ASKED ANYTHING — 26 CRASHES ACROSS 20 ROUTES

`probe.py` GETs all 68 read routes, reports 0 broken, and **skips every POST,
counting them as skipped.** That is honest of it and it is also half the surface,
unexamined: the half that writes. `scratchpad/postrefuse.py` sends five
malformed bodies to each of the 27 POST routes safe to poke. First run: **26
crashes across 20 routes.**

**TWENTY WERE ONE DEFECT.** Every route reads its body as `request.get_json(...)
or {}` and then calls `.get(...)`. That is correct for `null` and for an absent
body — both falsy, so `or {}` fires — and WRONG for every other scalar: the JSON
document `"a string"` is truthy, so `.get` reaches a `str` and raises
AttributeError. Flask then serves its HTML traceback page, so the operator gets
a stack trace where a sentence belongs.

The fix is ONE `before_request` beside `_auth_guard`, not twenty edits, because a
per-route fix leaves the twenty-first to be written the same way — nineteen test
files in no list, `run.py` linted by nothing, `tests/ fully listed`.

**IT RAN AGAINST A THROWAWAY DATABASE ON ITS OWN PORT, and the script refuses
8787 by name.** Sending a malformed body to a route that writes is the only way
to learn whether it validates, and if it does not, the garbage lands in whatever
store is behind it. Proved isolated before a byte was sent (8799 saw 0 series,
8787 saw 22) and proved clean afterwards: live archive 21,996 -> 21,998, the two
new rows real Binance bars from the hourly top-up, **0 rows from any fixture
source and 0 `XXXUSD`**.

| | |
| --- | --- |
| crashes, first run | **26 across 20 routes** |
| after the shape guard | 4 |
| after the field-level fixes | **0**, over 135 bad bodies |

The remaining four needed their own answers, and each is a distinct lesson:

- **`/svc/claims`, `/svc/edge/trials` answered 500 carrying Flask's own 400
  text.** A blanket `except Exception as e: ... 500` was catching werkzeug's
  `BadRequest` and relabelling a CLIENT error as a server one, in a field the
  operator reads. The guard now answers unparseable with a sentence — **except
  on `/mcp`**, which must answer it as JSON-RPC `-32700`.
- **`/svc/risk/size` and `/svc/risk/check` crashed on a well-formed object with
  a mistyped FIELD**, which the shape guard structurally cannot see.
  `float("lots")` raised straight out of the POSITION SIZER — the one route
  whose answer is how much money to put at risk. `_num()` coerces or names the
  field.
- **REMOVING THE FIRST ERROR REVEALED THE SECOND**, exactly as this file already
  records. Fixing the sizer surfaced `TypeError: '>' not supported between str
  and float` in the gate one route along, which had passed `risk_R` through
  untouched.
- **And my own `/svc/mcp/serve/enable` accepted garbage as an instruction.**
  `get_json(silent=True) or {}` turned an unparseable body into `{}`, so
  `bool({}.get("on"))` **switched the MCP server off and answered 200** as
  though the operator had asked. Failing to the safe side is not the same as
  understanding the request.

`tests/test_post_body_shape.py` is the gated form (13 tests). Its own first run
found a crash the audit's fixtures had missed — a mistyped `risk_pct` — because
the sweep's five bodies were a guess and the test asked a sharper question.
**Three guards were deleted and watched to fail**, including the OVERREACH
check: narrowing the guard to objects-only breaks the `/mcp` batch test, which
is what stops a future tightening silently killing the MCP server.

Live re-run after the change: `probe.py` **0 of 68 broken**, `behave.py` **36
passed, 0 failed**.

### THE 98 UNDECLARED CLASSES, TRIAGED — AND MOSTLY NOT DEFECTS

The sweep's own rule applied to itself: **a sweep for a defect class will be
mostly false positives.** Grouping the 98 by name was useless (84 looked
"suspicious" because their prefix family is styled). The discriminator that
works is whether the element carries ANY declared class: 56 had none at all, 6
were state modifiers beside a declared base, 46 were hooks.

And most of the 56 are still fine — a container whose children are styled needs
no rule of its own. `cd-stop` and `cd-fired` looked like the clearest defects in
the list and are not: both carry `data-tone`, which is the real owner of their
colour. **Three were real**, each MEASURED in the browser before and after:

| class | was | now |
| --- | --- | --- |
| `.qd-refused` | `rgb(232,228,218)` — a REFUSAL rendered identically to an answer | `--attn`, `rgb(240,138,75)` |
| `.av-failed` | `rgb(232,228,218)` — failure reasons at full body brightness | reuses `.av-reason`, `rgb(154,149,138)` |
| `.dd-mono` | the BROWSER'S generic `monospace` at 14px | `Geist Mono Variable` 11.5px |

`.qd-refused` is the one that mattered. The Quant desk ALREADY declares
`.qd-status[data-state="refused"] { color: var(--attn) }` — it knows what a
refusal looks like — and the script result's refusal had no rule at all, so the
reason a computation could not run read exactly like a computation that did.
`.av-failed` needed no new rule: `.av-reason` already existed, and adding a
second name for one thing is the defect, not the fix.

**95 distinct remain (104 uses) and they are recorded, not silently carried.**
Deciding whether `ld-body` deserves a rule needs somebody to LOOK at it; a
guess dressed as a sweep is how a checker stops being read.

### THE WHOLE SURFACE, SWEPT LIVE

Both audits that are excluded from the gate *because they need a running gateway*
were run against one. `scratchpad/probe.py`: **68 routes, 0 broken**, with the 5
by-design exceptions named (two serve HTML, two are honest 404s for a symbol not
given, and `/svc/mcp/callback` returns a PAGE because a human reads it).
`scratchpad/behave.py`, which asserts what each module COMPUTES rather than
whether it answers: **36 checks, 0 failed**, 8 modules skipped by name because
probing them would send a Telegram, download gigabytes, register a client on a
third party's service, or overwrite the browser's backup.

`behave.py` gained an `mcpserve` section, because a capability added to the
product and left out of the audit is the audit going stale the day it is written.
Seven read-only checks, none of which turns the server on: the card's tool list
and the client's `tools/list` must AGREE (one fact, one owner — `views.ts` and
`toolsmenu.ts` managed 0 of 24), nothing withheld may also be published, the
snippet must point at the address the state reports, a browser `Origin` must be
refused, a tool must refuse while off, the refusal must name a screen that
EXISTS, and no credential may appear in the body. Two of them were hardened after
being written: `over_rpc == sorted(listed)` is a PASS when both are empty, which
is exactly what a dead route looks like — "0 of 0 running" painted green, in the
checker added to stop it.

**Gate: `VERIFY PASSED — 7 stages, 118s`. 207 frontend files / 4,515 tests (+16), 46 new
pytests in `tests/test_mcp_server.py`, 15 in `app/test/mcpservecard.test.ts`.** Four server
guards and two card guards were each DELETED and watched to fail before being believed.
**No exe built**, per the standing instruction.

## v63.19 — THE LAST ONE, AND THE CONTROL WAS NEARLY DEAD ON ARRIVAL

`study/steps.ts` had a two-way cost control — `standard` or `none` — so costs-off
was reachable and the broker's real spread was not. `CostModel` is now
`standard | measured | none`, and `measured` charges the SPREAD the contract spec
reports while leaving commission and slippage at the assumption: a commission is
per-lot and account-specific, slippage belongs to the venue and the order size,
and reading either off an instrument would be a third model that is neither
measured nor assumed.

### EVERY FALLBACK LANDS ON THE HARSHER END

No spec synced, a symbol the broker does not quote, a spec with no usable spread,
no bars, a price of zero — each returns `standard`. **The direction is the safety
property**: a fallback that charged less would manufacture an edge out of a
missing broker sync, and a study charged a made-up spread would look exactly like
one charged properly. Twelve tests, and the one that matters asserts every
fallback path lands on the assumption rather than merely "not crashing".

### AND IT WOULD HAVE BEEN A BUTTON THAT DID NOTHING

`StepInput.brokerSpecs` was optional and **nothing supplied it**. The picker would
have offered "My broker", the resolver would have found no specs, and every study
would have silently charged the assumption while the UI said otherwise — the
"capability nobody can see" defect inverted into a control that lies.

Caught before shipping by asking who fills the field, and the chain is now
complete end to end: picker -> `spec.costs` -> `RunOptions.brokerSpecs` ->
`StepInput` -> `studyCosts`. The specs are fetched ONCE and cached, because a
study runs rarely and a fetch per run would put a request behind a button pressed
while watching.

**This is the third time this session a control was wired and its data source was
not** — the Survey desk's cost disclosure reading a `lastPrice` nothing filled,
and the settings card painting from one path while saving through another. The
question that catches it every time is "what fills this field?", asked before the
gate rather than after.

### THE COST CLASS IS NOW CLOSED

Four were real and all four are fixed; three were correct as written. Every
hardcoded cost that fed a DECISION — what the machine searches, how markets rank,
what gets promoted, what a study concludes — is sayable, and not one default
moved.

    gate: VERIFY PASSED - 7 stages, 214s
    frontend: 4,499 tests (12 new)

---

## v63.18 — I COUNTED EIGHT AND THERE WERE THREE

"Eight places charge `DEFAULT_COSTS`" was a GREP COUNT, not a reading, and I
quoted it four times before checking it. Read one by one:

    headless.ts     the autonomous 85-rule search        REAL -> fixed v63.15
    survey.ts       ranks markets against each other     REAL -> fixed v63.16
    spectest.ts     decides what gets promoted           REAL -> fixed v63.17
    ui/shell.ts     a search from the inspector          NOT A DEFECT
    steered.ts      nothing — display text only          NOT A CHARGING SITE
    strategy.ts     the sweep                            already had a control
    study/steps.ts  a study's rule tests                 already has none/standard

**`ui/shell.ts` was never wrong.** Its own comment said the saved row records
which costs were charged, and that is TRUE: `discovered.costs` carries them and
`sweepdriver` hashes them into the cache key, so a changed hurdle MISSES rather
than serving a conclusion nobody reached. A deliberate default with a receipt is
not the same thing as a hardcoded one.

**`steered.ts` charges nothing at all** — its `DEFAULT_COSTS` is display text
describing the assumption. I had it on a list of sites that charge.

**`study/steps.ts` already has a two-way operator control** (`none` / `standard`),
so costs-off is reachable today. A third `measured` option would need `CostModel`
widened and the UI to offer it; it is the one genuine candidate left, and it is
smaller than the three that are fixed because standard is the CONSERVATIVE end —
the measured spread is cheaper, so the current default cannot manufacture an edge.

### THIS IS THE DEFECT THIS FILE ALREADY NAMES, COMMITTED BY ME

"A BACKLOG NUMBER THAT ARGUES WITH ITSELF IS NOT A BACKLOG... when a count has to
be qualified every time it is quoted, replace the count with the list." The
uncalled-routes bullet was overstating by 2.5x for the same reason: a grep,
repeated, never re-read. Mine overstated by 2.7x. The backlog entry is now the
LIST, with what each one decides and why it is or is not a defect.

**Three were real, and all three decided something**: what the machine searches,
how markets rank, and what gets promoted. That is the useful pattern — the
hardcoded costs that mattered were exactly the ones feeding a decision nobody
watches.

    gate: VERIFY PASSED - 7 stages, 194s

---

## v63.17 — THE PROMOTION TEST, AND A BENCHMARK PRICED DIFFERENTLY FROM WHAT IT MEASURES

`runSpecTest` decides what gets PROMOTED, so the cost model is the most
consequential input it takes — and it charged a hardcoded 2bp, which is 4.8x this
operator's real spread on gold. Overcharging a promotion test rejects rules that
would have cleared the spread actually paid. `opts.costs` now says otherwise, the
default is unchanged, and the result already carried its cost model so a
promotion can be re-derived from the figures that produced it.

### THE YARDSTICK WAS PAYING A DIFFERENT PRICE FROM THE THING IT MEASURED

`randomEntryTest` is the benchmark a rule is compared AGAINST, and it took
`DEFAULT_COSTS` **directly** while the rule took `base.costs`. Today those were
the same object so nothing was wrong — but the moment a caller passes a cheaper
model, the rule would be priced one way and its benchmark another, and the
comparison would be between two different games with no error anywhere.

That is "A LEDGER MUST PRICE THE WAY THE ENGINE PRICES", arriving in the one
function whose entire job is a fair comparison. Both take the same model now, and
a test pins it.

### A FIXTURE TOO SMALL TO REACH THE CODE UNDER TEST

The benchmark assertion failed, and the cause was mine: `randomEntryTest` REFUSES
below 30 trades, and 900 bars of my wave produced **21** — so both cost models
returned the same refusal object and the assertion was comparing two identical
refusals. Measured rather than guessed, by printing both: `21 trades; 30 needed
before a random-entry comparison means anything`. Enlarged to 3,000 bars.

**A fixture that cannot reach the code under test is a test that passes on its
own emptiness** — the same shape as the desk scan that had to assert it rendered
more than ten leaves, and the audits that fail on a zero.

    gate: VERIFY PASSED - 7 stages, 194s
    frontend: 4,487 tests (5 new)

---

## v63.16 — THE SURVEY RANKED MARKETS ON A COST NONE OF THEM PAY

v63.13 said the Survey desk needed a signature change and left it at a
disclosure. This is the signature change.

That desk RANKS markets against each other, and it charged every instrument one
flat 2bp spread. Measured against this operator's broker the assumption is
**4.8x the real spread on gold and 3.8x on EURUSD** — not the same distortion, so
ranking them on one number folds two different errors into a single order and
nothing on screen said so.

`SurveyOptions.costsFor?: (symbol: string) => Costs | undefined` charges each
market its own. Only the hurdle differs: `{ ...opts, costs }` means every other
option is carried through, because a survey where two markets differed in more
than their costs would not be comparing what it claims to.

### THE DEFAULT HAS NOT MOVED, AND A TEST PINS IT BYTE-FOR-BYTE

`runSurvey` is called by a desk and by the autonomous work, so an option that
changed results **just by existing** would move every result silently. The test
asserts a `costsFor` that always returns `undefined` is INDISTINGUISHABLE from no
`costsFor` at all — `JSON.stringify` equality on the whole survey, not a spot
check. And a market the resolver does not know falls back rather than guessing: a
market charged a made-up spread would be worse than one charged the assumption,
because nothing would say which.

The opposite assertion matters as much: charging nothing must NOT produce the
same survey as charging 2bp. If those were equal the option would be inert, which
is the failure a "defaults unchanged" test cannot catch on its own.

### AND THE DESK GOT THE CONTROL, NOT JUST THE DISCLOSURE

v63.13 made the Survey desk SAY the gap, which on its own is the "capability
nobody can see" defect one step along — the operator could read that the hurdle
was wrong and change nothing. There is now a toggle, off by default, hidden
entirely when no broker spec has been synced, and flipping it CLEARS THE OLD
RANKING rather than leaving it under a new cost model.

    gate: VERIFY PASSED - 7 stages, 214s
    frontend: 4,482 tests (5 new)

---

## v63.15 — I HAD FRAMED THE ONE THAT MATTERED AS BLOCKED, AND IT WAS NOT

v63.13 left `headless.ts` — the autonomous 85-rule search — charging a hardcoded
2bp spread, with the note that it "needs a decision, not a patch". That framing
was half wrong, and re-reading this project's own rule is what showed it: what is
forbidden is the measured figure **silently replacing** the assumption. Nothing
forbids the hurdle being configurable and stated.

So the search's cost model is now sayable and **its default has not moved**:

    no `costs` field   spread 0.0002    byte-for-byte what it always charged
    opts.costs given   spread 0.000042  honoured, commission untouched

The caller decides and nothing decides for them. `LedgerJobResult.costs` states
which model was charged, because two runs of one rule under different spreads are
different findings and a result that does not carry its hurdle cannot be compared
with another or re-derived later.

**ALL THREE TERMS OR NONE.** A partial model falls back to the default entirely:
taking the spread from a job and leaving commission and slippage at theirs would
produce a third cost model, neither asked for nor assumed, and a result charged
with it could not be reproduced from either. A bad field is a REFUSAL TO THE
DEFAULT, never a throw — the autonomous loop must not stop searching because a
caller sent nonsense, and the result says which model it used either way.

### THE CHANGE WAS INERT UNTIL A COMMITTED BUNDLE WAS REBUILT

`server/lab_worker.mjs` imports `./engine/lab-engine.mjs`, which is a BUILT,
COMMITTED artifact. Editing `headless.ts` alone changes nothing the worker runs —
the same class as a UI change verified on the dev server while `app/dist` was a
day old, which this file records costing two releases. `npm run build:lab`, then
driven against the real worker to prove it.

### AND MY OWN DRIVER WAS WRONG BEFORE THE CODE WAS

The first run showed the measured spread ignored, which looked like the feature
failing. It was the test job: `parseJob` reads `job.opts`, a NESTED object, and I
had put `costs` at the top level beside `bars`. The implementation had been
reading the right place all along. **Check the harness before the code when a
brand-new feature appears not to work** — the same shape as the probe that
reported a broken route and was itself sending the wrong parameter names.

    gate: VERIFY PASSED - 7 stages, 159s
    lab format: test_lab_request.py + test_auto.py, 37 passed
    frontend: 4,477 tests (8 new)

---

## v63.14 — THE GATE COULD NOT SAY WHAT BROKE

Checking the other desks was being done by opening them in the preview pane and
looking, which is neither repeatable nor complete — the pane's own navigation
resisted reaching most of them, and this file already warns against concluding
anything from that pane. Clicking through 24 desks proves nothing about the 25th,
and proves nothing again next week.

### A DESK THAT MOUNTS MUST NOT RENDER A DEFECT SIGNATURE

`app/test/deskrender.test.ts` mounts a desk with stub dependencies and reads its
rendered text for the five signatures this codebase has actually shipped: `NaN`
(a formatter handed an unset number, where every formatter here renders an em
dash), `undefined`, `Infinity` (INFINITY IS A BUG), `[object Object]` (the Quant
desk was dead for months from exactly this), and `0 of 0`.

It PROVES ITSELF against a deliberately broken element — five signatures, five
catches — because a scan that matches nothing reports a clean tree, which is the
defect found in four of this project's own audits. It also asserts the desk
rendered more than ten leaves: a scan over an empty element passes trivially.

**SIX DESKS, each with a dependency surface small enough to stub honestly:**

    Calculator   in three states, including the two where NaN actually reaches a
                 screen: no price, and an instrument the table does not hold
    Sessions     a clock desk, which is where a bad date shows first
    Watchlist    with an EMPTY list, the state it opens in
    Screener     before anything has been scanned
    Data library with an EMPTY archive — the state a new install opens in
    Learn        with NOTHING recorded, where a rate over an empty population
                 would print 0% instead of refusing

The last two use REAL in-memory implementations rather than stubs:
`createArchive(memoryBackend())` and `createLearnStore(kv)` are the same code
`history.test.ts` and `retention.test.ts` run against, so nothing in them can
satisfy a call site and then disagree with the real thing.

All clean. Measured per desk rather than guessed: `Calculator` takes 4
dependencies, `Sessions` 3, `Watchlist` 4, `Screener` 3 — while `Workspace` takes
10 and `QuantDesk` 8. **A desk needing a chart engine and a live feed is left out
rather than mounted wrongly**, because a stub that satisfies a call site and then
disagrees with the definition has caused three defects here already. Every stub
above is a real shape, never `as any`.

The empty and unset states are the point: that is where NaN and undefined
actually reach a screen, and they are the states nobody opens a desk in to check.

**A false positive I expected and did not get:** `\bundefined\b` does not fire on
"undefinedness", because there is no word boundary there. The guard is tighter
than I credited it with, and that is now pinned rather than assumed again.

### THE GATE COULD NOT SAY WHICH TEST FAILED

Chasing an intermittent vitest failure — it failed twice and passed twice with no
code change between — none of the four runs could say which test it was.

`run()` keeps THE LAST TWELVE LINES of a stage's output. Vitest prints the
failing test, its file and the assertion, and THEN a summary block, so twelve
lines is "Test Files / Tests / Start at / Duration" and the name of the broken
test has scrolled off. **The tail exists to keep a PASSING stage quiet, and
applied to a failure it threw away the only thing the run is for.**

Same family as the two failures this file already records about its own gate: the
encoding crash that replaced a real failure with a traceback about a box-drawing
character, and the `&&` chain that once silenced eighty test files. A gate that
cannot say WHAT broke is a gate people re-run instead of read.

A failing stage now keeps 120 lines and a passing one still keeps 12. Proved
both ways against a command that prints 200 lines and then fails: the broken
test's name survives, and a passing stage still reports one line.

### A BIGGER TAIL WAS NOT ENOUGH EITHER, AND THE SECOND FIX FOUND IT

120 lines still could not name the test: vitest runs a worker per file and node
prints TWO LINES of `ExperimentalWarning: localStorage is not available` for each
of them, so a hundred lines of benign warning sat between the failure and the end
of the output. **Raising the number again would only have moved the wall.** Only
that exact known-benign pair is filtered — filtering by guess is how a checker
starts hiding what it exists to show.

With the noise gone, the cause came out in one run:

    Unhandled Rejection
    ReferenceError: requestAnimationFrame is not defined
      at scheduleFrame src/core/frame.ts:54
      at read.set src/core/signal.ts:96
      at src/ui/cards/costcard.ts:52
    This error originated in "test/deskrender.test.ts"

    Test Files  202 passed        Tests  4464 passed        Errors  3 errors

**EVERY TEST PASSED AND THE RUN FAILED.** Three unhandled rejections outside any
test, which vitest reports as errors and exits non-zero on — invisible in the
summary, which is why four earlier runs said nothing.

### AND IT WAS MINE, INCLUDING A DOOR THIS PROJECT HAS BEEN BURNED THROUGH SIX TIMES

`deskrender.test.ts` mounts the Calculator, which mounts the broker-cost card,
which calls `brokerCosts()` on construction. Two faults in one:

  1. **It reached the running gateway.** Under vitest the global `fetch` answers,
     so the render scan was hitting a live service — the exact class
     `tests/test_no_live_store.py` exists for. That guard greps frontend tests
     for `svcUrl` and CANNOT SEE a call made transitively by a desk being
     mounted, so this file closes the door itself with a stubbed `fetch`.
  2. **The fetch resolved after teardown.** The signal write scheduled a frame
     and `requestAnimationFrame` was gone. Every mount now settles its pending
     promises inside the test.

Three full vitest runs after the fix: `exit=0`, **0 unhandled**, 4,464 passed.
Two gate runs: both green.

### AND A DUPLICATE KEY THE SAME OUTPUT REVEALED

`test/setup.test.ts` declared `spreadKind` twice in one object literal, twelve
lines apart, the second mis-indented. Legal JavaScript — the later silently wins
— and esbuild had been warning about it into a stream nobody could read. Removed;
its 92 tests still pass.

**The flake was never contention.** The rising durations (63.9s, 81.0s, 96.1s)
were real and were a red herring; the cause was a test written an hour earlier
that leaked async work past its own teardown. Worth recording, because "it is
probably load" is the comfortable answer and it was wrong.

    gate: VERIFY PASSED x2 - 7 stages, 183s
    frontend: 4,464 tests, 0 unhandled rejections in 3 consecutive runs

---

## v63.13 — FIXING THE INSTANCE IS NOT FIXING THE CLASS

v63.9 gave the Playbook a measured-cost option. That is one instance, and this
file's own rule says fixing the one you are looking at is not fixing the class —
so: `grep -rn DEFAULT_COSTS app/src`. **Eight places charge the assumption and
one could be told otherwise.**

    ui/playbook.ts          one rule, one market      can charge the measurement
    ui/survey.ts            RANKS MARKETS             assumption only
    ui/strategy.ts          the sweep                 already has a cost control
    backtest/headless.ts    THE AUTONOMOUS SEARCH     assumption only
    backtest/spectest.ts    promotion tests           assumption only
    study/steps.ts          study steps               assumption only
    ui/research/steered.ts  steered research          assumption only
    ui/shell.ts             costs: () => DEFAULT_COSTS

### A COMMENT THAT WAS TRUE AND STOPPED BEING TRUE

`research/steered.ts` told the operator *"nothing reads your broker's commission
into a study yet"*. v63.9 made that half false — the Playbook now reads the
broker's measured SPREAD — and a comment that has quietly become false is worse
than one never written, because it reads as a checked fact. Narrowed to what is
still accurate, and it now names the direction of the error: the assumption is
usually the HARSHER one, so a rule refused there may clear the spread actually
paid.

### THE SURVEY DESK RANKS MARKETS, SO ITS HURDLE DECIDES THE RANKING

It charges a flat 2bp to every instrument, which means a market can rank below
another for a cost it does not pay. `runSurvey` takes ONE cost model for all
markets, so charging each its own spread is a signature change rather than a
toggle — and pretending otherwise would be worse than saying so. What it does now
is STATE THE GAP: both numbers, never the measured one silently replacing the
assumption, which is this project's stated rule.

**And the disclosure could not have fired.** It reads `lastPrice`, which nothing
filled — a spread in points needs a price to become a fraction. A control that
can never appear is the defect this session has now found three times; the run
records each market's last close, and it was caught before shipping rather than
after.

### `headless.ts` IS THE ONE THAT MATTERS AND THE LEAST SAFE TO CHANGE

It is the autonomous loop's 85-rule search. Overcharging a SEARCH discards rules
that would have cleared the real spread, silently and at scale — and switching it
changes what the machine promotes. A figure that moves under the operator because
a service answered is worse than a disagreement they can see. **It needs a
decision, not a patch**, and is recorded in CLAUDE.md's backlog as one rather
than left as an oversight.

    gate: VERIFY PASSED - 7 stages, 135s
    frontend: 4,459 tests

---

## v63.12 — A RESULT YOU CAN CHECK SIX MONTHS LATER

`docs/PLAN-v63-mcp.md` names this as a tweak: *"so any saved strategy can be
re-derived from the exact data that produced it"*. A figure written down without
the data behind it cannot be checked later, and this desk produces figures people
act on.

`backtest/receipt.ts` writes a JSON record, saved as a file or copied. MEASURED
live, the real thing the Save button produced:

    bars     40,803          asked  41,489        coverage  0.983
    source   binance         span   2022-01-29 to 2026-09-25
    costs    2bp / 4bp / 1bp        spreadKind  assumed
    rule     ema-9-21-cross  with the full spec, so it can be re-derived
    holdout  present         across  null         headToHead  null

### IT RECORDS WHAT ARRIVED, NOT WHAT WAS ASKED FOR

The distinction is the whole point, and this project has already paid for it: the
Playbook printed "1,598 bars" from the PLAN beside a trade count computed on the
999 that actually came — both honest alone, and together a claim about a
different question. A receipt built from the request would bake that into the
permanent record. So `bars`, `from`, `to` and `source` come from the loaded
history, and `asked` sits beside them so the gap is visible rather than hidden.

### THE COST MODEL IS PART OF THE RESULT

A COST MODEL IS A HURDLE, so two runs of one rule under different spreads are
different findings — "0.12R" is not reproducible even with identical bars unless
the receipt says what it was charged. `spreadKind` is `measured` or `assumed`,
which is the v63.9 control's answer preserved.

### NOTHING IS INVENTED TO FILL A FIELD

A section that did not run is `null`, never zero: `holdout: 0` would read as
"compared, and found nothing". Verified in the saved file — `holdout` present,
`across` and `headToHead` null, because those had not been run.

Coverage is clamped at 1 (a vendor returning more than the window needed is not
140% covered) and a zero request reports 0 rather than NaN. The object URL is
revoked immediately — one left behind pins the whole document in memory for the
life of the page.

### Two assumptions tsc refused, again

`current()` returns null rather than undefined, and the combine signal is
`combineId`, not `combineWith`. Both were guesses about this file's own shapes.

    gate: VERIFY PASSED - 7 stages, 129s
    frontend: 4,459 tests (16 new)

**The Playbook now answers six questions it could not this morning:** can I get
the data, did it still work recently, what does it really cost me, does it work
anywhere else, is it better than the alternative, and can I check this again
later.

---

## v63.11 — TWO RULES SIDE BY SIDE, AND WHEN THE GAP IS NOTHING

Putting two rule sets next to each other is the most natural thing a backtest
panel can offer and the easiest place in it to mislead: the eye picks the bigger
number, and the bigger number is usually noise.

`backtest/headtohead.ts` reports the DIFFERENCE and its standard error rather
than two figures for the eye to rank:

    SE = sqrt( sd_a^2 / n_a  +  sd_b^2 / n_b )

Under two standard errors it is a TIE, said in those words. MEASURED live on
BTCUSDT 1h over 40,803 bars, and it is exactly the case the feature exists for:

    Too close to call: EMA 9/21 cross -0.114R against EMA 50/200 cross -0.119R
    is a gap of 0.005R, which is 0.2 standard errors. Under 2 the data cannot
    separate them, and choosing the higher one is choosing noise.

    EMA 9/21 cross    -0.11 R   1,825 trades · 27.6% won
    EMA 50/200 cross  -0.12 R   1,526 trades · 18.4% won

**Over three thousand trades between them, and the gap is still nothing.** A
naive side-by-side would have shown −0.11 against −0.12 and invited "9/21 is
better" — which is the defect, at a sample size where most people would assume
it had been ruled out.

It never tests the means against ZERO: "A beats zero and B does not" is a weaker
claim than "A beats B", and reporting the first as the second is how two mediocre
rules become a ranking. And a real gap is bounded to its window — *"That is a
real gap ON THIS window — it is not a claim that it holds on the next one, and
this window is the one the comparison was made on."*

### A TEST CAUGHT A BUG THAT WOULD HAVE SHIPPED CONFIDENTLY

The first guard against dividing by a zero standard error was `se > 0`, and it is
wrong: **`0.1` is not exactly representable in binary floating point**, so forty
IDENTICAL trades have a standard deviation of `4.2e-17` rather than zero. The
guard passed and the comparison reported **6e16 standard errors** — it would have
printed "ahead by 0.400R (59999937404835248.0 standard errors)" for a difference
nobody measured.

An absolute epsilon would have been wrong too, because R multiples are order 1
here and could be order 0.001 elsewhere. The test is RELATIVE to the size of what
is being measured, which is the only form that survives a change of units.
INFINITY IS A BUG, NaN IS A REFUSAL — and so is 6e16.

### The layout carries the argument

The verdict LEADS and the two figures follow. A pair with the verdict underneath
invites the eye to rank them first and read the caveat second, which is the whole
failure mode. `tie` is muted — neither red nor green — because it is the most
common honest answer and the one most worth reading; colouring it as a failure
teaches people to keep clicking until something goes green.

The rival runs on the bars the last run already loaded. Re-loading history for it
would risk a different vendor answer between the two, which is the defect this
desk records as three identical runs giving 156, 480 and 480 trades.

    gate: VERIFY PASSED - 7 stages, 137s
    frontend: 4,443 tests (13 new)

---

## v63.10 — DOES IT WORK ANYWHERE ELSE?

One market cannot say whether an edge is real or a property of that market's last
few years, and the Playbook tested one market per press. **A CONTROL THAT TAKES
ONE OF SOMETHING PER PRESS IS A FORM, NOT A TOOL** — the rule this file already
states, applied to the desk where it costs most.

`backtest/across.ts` puts the same rule, same window, same bar size and the same
cost model to every market the archive holds, sequentially.

### IT COUNTS AND NAMES. IT NEVER RANKS — AND THAT IS THE WHOLE DESIGN.

The obvious build sorts by expectancy and puts the winner on top. That turns
honest measurements into a SEARCH, and this file already records what that costs:
a sorted table always has a big number at the top, "including on data with no edge
in it". The top row of a sorted list reads as a recommendation whatever the
caption says, so there is no sort control and no `best` field —
`it does not report a best market` is the test guarding it.

What it reports instead is how many markets worked, how many lost, how many could
not answer, **each group named**. Positive on one of six is `one-market`, in the
word this project already uses, and it says *"That is a finding about BTCUSDT,
not about the rule."*

### A MARKET THAT COULD NOT ANSWER IS NOT A MARKET THAT SAID NO

MEASURED live, and it is the case that proves the design:

    Only XAUUSD could answer, so this says nothing about whether the rule
    generalises. The other 1 had no history or too few trades: SOLUSDT.

    SOLUSDT   —          the archive holds no SOLUSDT 1h to run on
    XAUUSD    -0.14 R    44 trades · 25.0% won

SOLUSDT is named and counted apart — folding it into the failures would make the
rule look worse than the evidence says, and dropping it silently would make the
denominator a lie. Its row is MUTED, never red: it did not fail the rule.

**ONE ANSWER IS NOT A COMPARISON.** "It worked on 1 of 1" is a percentage over a
sample of one — the shape of a measurement without being one — so a single
answering market is refused as `one-market` rather than reported as 100%.

### SEQUENTIAL, AND THE QUEUE NAMES WHAT IS IN FLIGHT

Each market may need `loadForPlan` to reach back, and parallel backfills are how a
free vendor tier starts refusing. The button reads "Testing XAUUSD…", because an
unchanging "Running…" is indistinguishable from a hang.

Each market is planned against **its own** holding via `heldFor`, not the desk's
current one — planning them all against one series' history would ask every run
the wrong question.

### TWO ASSUMPTIONS tsc REFUSED

  * `r.refused` is the REASON STRING, not a boolean. The reason is the half worth
    keeping: the engine refuses a run over generated bars and that must reach the
    screen.
  * `heldAll` carries `SymbolOption`, not strings. Never guess a dependency's
    shape — and the fix improved the feature, because `o.held` then filters the
    chips to markets the archive actually holds, so no chip can only refuse.

    gate: VERIFY PASSED - 7 stages, 120s
    frontend: 4,430 tests (13 new)

---

## v63.9 — TWO THINGS THE PLAYBOOK COULD NOT ANSWER

The owner asked to make the panel more powerful. The two gaps worth closing were
not guessed at — the desk states the first itself, in its own result panel:
*"One rule set on one symbol over one window, with costs applied. That is a
description of the past, not evidence of an edge"* — and then sends you to
another desk.

### DID IT STILL WORK RECENTLY? — `backtest/holdout.ts`

The rule set has already been CHOSEN, usually after seeing how it did, so a
number computed over the window the choice was made on cannot argue with it.
Holding back the most recent slice is the cheapest instrument that can: the rule
was not picked for what it did there.

**ONE RUN, PARTITIONED — NOT TWO RUNS.** The obvious build slices the bars and
runs the engine twice, and it is wrong twice over: every indicator needs lead-in,
so the second run begins blind and its early trades differ for a reason that has
nothing to do with the market; and a position held across the boundary is entered
in one run and never exited in the other. The engine runs ONCE and its trades are
partitioned by ENTRY TIME.

**It splits on TIME, not on trade count.** "The last 30% of trades" is a
different and much less useful question — a rule that stopped trading would then
have no recent window at all, when that is exactly the finding worth surfacing.

**It refuses on a thin side, and that is the point.** MEASURED live: 25 and 19
trades a side reported *"Not enough to compare … 30 a side is the floor. Two
percentages over a handful of trades look like a measurement and are noise."*
Agreement is judged on the SIGN of expectancy, not the size — a rule whose edge
halved still works, and calling that a disagreement would cry wolf on every real
strategy. `data-agrees="false"` is `--attn`, never `--neg`: a rule that stopped
working is the most valuable thing this block can say, and colouring it as a
fault teaches the operator to look away from it.

On a 40,803-bar BTCUSDT run: 1,285 trades earlier at −0.09R, 540 held back at
−0.17R, agreeing. Changing the share re-splits without re-running — the trades
are already priced, and re-running would charge minutes for arithmetic.

### WHAT THE RUN IS CHARGED — `backtest/realcosts.ts`

`DEFAULT_COSTS` charges a flat 2bp spread and the Playbook had no way to say
otherwise. **MEASURED LIVE, reproducing this file's own figure independently:**

    Your broker's spread is 0.42bp; this run charges the assumed 2.00bp (4.8x).

A COST MODEL IS A HURDLE, so an assumed cost is an assumed conclusion —
overcharging is not the safe direction, it DISCARDS rules that would have cleared
the real spread, silently. Switched on, the status line reads *"costs on (0.42bp
measured spread)"*.

**It reports; it never silently replaces.** The measured figure is offered and
never adopted by default, because a number that moves under the operator because
a service answered is worse than a disagreement they can see. And only the SPREAD
is measured: commission is per-lot and account-specific, slippage belongs to the
venue and the order size, so `partial` says both stay assumed rather than
inventing a third thing that is neither.

**BTCUSDT correctly finds no spec.** The broker quotes BTCUSD, and matching the
two would be the EURUSD/EURUSDT trap this file records — real bars for a
different market, which is worse than a refusal.

### A BUG MY OWN CHECK FOUND

Toggling the cost control before any run announced *"the broker's spec for this
symbol does not give a usable spread"* — about a spec that is perfectly good. The
handler passed a price of ZERO, so `spreadFraction` divided by nothing. **A
spread in POINTS is only a fraction once you know what it is a fraction of**,
which is the units trap this project has paid for repeatedly. With no run yet
there is no price, and the honest answer is to say what will happen rather than
to invent one.

    gate: VERIFY PASSED - 7 stages, 119s
    frontend: 4,417 tests (19 new: 11 holdout, 8 costs)

---

## v63.8 — A REFUSAL THAT CAN BE FIXED NOW CARRIES THE FIX

The owner, with a screenshot of the Playbook: *"IF THERE IS NO DATA IT CAN ASK
ME TO DOWNLOAD AND DOWNLOAD FROM HERE"*. The desk said "the archive holds no
EURUSD 15m to run on" and offered nothing to do about it — a dead end for a
series the product can fetch on demand.

### `history.backfill`, NOT `startBulkDownload` — CHECKED BEFORE BUILDING

The obvious-looking control is `startBulkDownload`, which the Data library uses.
It fills the **server's Parquet store**, and this desk plans against the archive
the **browser** reads. Wiring it would have been a button that downloads into a
store the plan never consults, finishes green, and leaves the identical refusal
on screen — one fact with two owners, and a defect indistinguishable from
success. `loadForPlan` already reaches for a series it holds too little of via
`history.backfill`; holding NONE of it is the same call with a different
starting point.

### `missing` IS A TYPED DESCRIPTOR, NOT A SENTENCE TO GREP

Three refusals reach that line and **only one can be fixed by fetching**; the
other two differ from it in English alone — "…and nothing can be reached back
for", because backfill reaches BACK from what is held and cannot invent a year
the venue never listed. A button decided by `why.includes("holds no")` would be
one word away from offering a download that spins and finds nothing. So
`RunPlan` gained `missing: MissingSeries | null`, defaulted to null in `refuse()`
so a refusal added later offers nothing until somebody decides it should.

`wantedBars()` is the one owner of the depth, because the success path computes
it from the CLIPPED window and the fetch path has none yet — two copies would
mean a download that completes and leaves the plan still short. **A test found
the cap doing its job**: my first version asserted unbounded growth on four years
of 15m and the answer was 60,000, because `MAX_STUDY_BARS` had already bound it.
That is the more valuable thing to pin, and it now is.

### THE SAME SENTENCE, A THIRD TIME

v62 fixed `planLine` printing `why` beside `plan().why`, and the guard still
holds — while pressing **Run** wrote the identical string into `note`, which
renders a few inches below. The owner's screenshot shows both. Each of the three
bindings was right on its own; the SET was wrong, which is why fixing two did not
finish it. Run now says what it achieved and where to look:
*"Nothing to run yet — use Download above to fetch this series first."*

### THE NOTE CARRIES THE SERIES IT IS ABOUT

MEASURED after the first build: fetching BTCUSDT 15m and then typing EURUSD left
**"36,000 bars stored"** sitting under a refusal for EURUSD — a readout about one
series describing another. Clearing it at each of the SEVEN `readHolding()` call
sites is the version that breaks when an eighth is added; the note is tagged with
its series and cannot outlive its subject.

### DRIVEN LIVE, on the python build at :8787

    EURUSD 15m     "Download EURUSD 15m", "About 35,040 bars — the depth this
                   window needs. Kept on this machine."
    pressed        7,000 … 36,000 of about 35,040 bars, with a working Stop
    after          plan flipped to ok: "BTCUSDT 15m, 2026-01-01 to 2026-09-25 —
                   25,703 bars, 0.7 years"; the Download button removed itself
    the run        "25,703 bars from binance" — the backtest it had been blocking
    duplicate      1 rendered copy, was 2
    stale note     stays on SOLUSDT when the market changes to EURUSD
    __signalErrors 0 throughout

Zero bars is reported AS zero: a vendor that has never listed a series answers
with nothing, and a control that then said "done" would be the most alarming
possible way to say "I found none".

**No unit test for the card**, and saying so is the rule: nothing unit-tests a
mounted desk here, so the control was verified in the browser across all four
states instead. The arithmetic underneath it — `missing`, `wantedBars`, and the
two refusals that must NOT offer a fetch — has six new tests in
`app/test/runplan.test.ts`.

    gate: VERIFY PASSED - 7 stages, 136s
    frontend: 4,398 tests

---

## v63.7 — THE TWELVE ROUTES I BUILT AND LEFT UNREACHABLE

`scratchpad/routes.py` measures "capability with no screen", and CLAUDE.md
recorded that column as EMPTY. This session reopened it: the MCP engine, the
OAuth flow and the settings module added **twelve routes with no caller
anywhere in `app/src`**. The operator could not connect TradingView, sign in, or
change the disk budget except with curl — a capability nobody can see is a
capability nobody has, and I had just driven that metric to zero myself.

    before this pass   12 uncalled  (6 mcp, 4 mcpauth, 2 settings)
    after              1            -- `/svc/mcp/callback`, correctly

The callback is a browser REDIRECT TARGET: an authorization server sends the
operator's browser there after a sign-in and it returns a PAGE. A fetch of it
would mean the flow had gone wrong. Recorded in CLAUDE.md's "not a fetch target"
row beside `/` and `/legacy`.

### What was built

`app/src/data/mcp.ts`, `ui/cards/mcpcard.ts`, `ui/cards/settingscard.ts`, mounted
on the System desk beside the connections and stored-history cards — that desk
already answers "what does this machine hold and what is it doing", and a new
desk for two routes would be the "capability filed under the wrong heading"
mistake.

DRIVEN LIVE on the python build at :8787, not the dev server:

    row state      connected (green rail), "speaking 2025-03-26, no sign-in needed"
    tools          9 listed, each with its argument hint
    a real call    get_candlestick -> "Here is the Crypto.com Exchange candlestick
                   data", prose kept and the JSON parsed out beneath it
    budget         set from the screen: 5 GB -> 40 GB, and /svc/store/inventory
                   followed. RESTORED to unset afterwards -- it is the operator's
                   configuration, not mine to leave changed.
    a refusal      "half a gigabyte is the smallest budget worth setting" --
                   the server's own operator-facing sentence, shown verbatim
    __signalErrors 0 throughout
    375px          single column, no horizontal page scroll

### TWO REACTIVITY BUGS, BOTH FOUND BY DRIVING IT

**`each()` REUSES THE NODE FOR AN UNCHANGED KEY AND NEVER RE-RENDERS IT.** The
server row sat on "checking / not checked yet" for ever while the handshake had
long since answered, because every value was read once at construction. `h()`
takes a FUNCTION for text, for an attribute and as a child, and binds it — the
idiom `data/connections.ts` already uses, and the reason its rows track their
services. Rebuilding the row on each probe would have been the other fix and is
the wrong one: it discards the typed arguments and the expanded tool list every
time a probe lands. **Hide and rebind, never unmount.**

**TWO PATHS TO THE DOM AND ONLY ONE OF THEM RAN.** The settings card painted its
list from `refresh()` only, so saving updated the server, updated the signal, and
left the old value on screen: MEASURED, the budget moved to 40 GB and
`/svc/store/inventory` agreed while the line underneath still read "Still the
default (5). Nobody has chosen this yet." Replaced with a reactive slot, so there
is one path.

### CHOSEN AND MERELY DEFAULTED ARE DIFFERENT FACTS

"5 GB" because the operator picked it and "5 GB" because nobody ever has are the
same number and not the same state, and only one means it was thought about. The
server reports `isDefault` and the card says which.

`.mcp-` and `.set-` were both cleared by `classcollide.py` BEFORE being written —
it has refused a prefix of mine once already, and the `.sy-` collision it exists
for had one desk rendering in another's clothes for two releases. `cssdupe.py`
reports 0 conflicts over 2,013 selectors; `tokens.test.ts` passes, so no custom
property was invented.

    gate: VERIFY PASSED - 7 stages, 123s
    tests: 14 new frontend (mcpclient.test.ts)

---

## v63.6 — THE THREE MODULES NOTHING TESTED, AND THE BACKUP THAT ACCEPTED `{}`

`behave.py` skips eight modules by name because probing them live SENDS,
DOWNLOADS or overwrites something. Measuring which of those eight had any
coverage at all:

    auto  bulkfetch  mcpauth  router   -> covered
    alerts  signals  sync              -> NOTHING

Three modules with no behavioural coverage, uncovered PRECISELY because touching
them does something. That is `run.py` outside every gate, and nineteen test files
in no list, in its most predictable form: **an awkward surface is a surface
nobody checks.** They are covered now in-process — scratch database, stubbed
sender, nothing sent or downloaded.

### `/svc/backup` WOULD ACCEPT AN EMPTY BODY AND WIPE THE BACKUP

`INSERT OR REPLACE` over one blob, so a push carrying two slots DESTROYS the
other eleven — which is exactly how a scheduling test once overwrote the
operator's thirteen real slots. That was fixed in the CLIENT (`startBackup` lost
its live default), and this end went on accepting anything, including `{}`: an
empty push wiped the blob and answered `ok: true, bytes: 2`.

It also had **no server-side credential filter**, while `store/sync.ts` carries
one and the scar that explains it — the analyst's API key reaching a remote
endpoint because "is this a credential?" had two answers. A guard that lives only
in the client is a guard a client bug removes.

Three guards, none of which changes the contract the client already speaks:
an empty or non-object body is REFUSED; a credential key is refused BY NAME; and
the delta is reported and logged, so a push that drops eleven slots still
succeeds and **says which ones went**. Silently doing less than asked is the
defect; refusing a legitimate removal would be a different one.

The credential guard is deliberately blunt on the KEY — `tokenomicsNotes` is
refused — and that trade-off is pinned by a test rather than discovered later.

### `/svc/notify` REFUSED CORRECTLY AND SAID NOTHING USEFUL

With no credentials it answered `{"ok": false, "via": "server-secrets"}`. Right
about the outcome; `via` is an internal word for where the token lives, not a
sentence anyone can act on. It matters here more than most places because the
alert loop, the signal loop and the dead-man's-switch heartbeat all send through
this route — a refusal nobody can read is how three loops came to fire into
nothing behind twelve green dots. It now names what is missing and where to set
it, and distinguishes "no channel is set up" (go and do something) from
"Telegram would not take it" (may fix itself).

### THREE OF MY FOUR FIRST FAILURES WERE MY OWN TESTS GUESSING

`/svc/kv/manifest` is a DICT of key→rev, not a list of rows. `send_tg` sends with
`requests`, not urllib. `/svc/sig/watch` wants `sym` and `strategy`, and the 400
my invented fixture earned was correct. **Reporting a defect in a route that is
answering correctly is what a checker can least afford**, and the fix each time
was to read the contract instead of assuming it.

### AN ASYMMETRY PINNED RATHER THAN CHANGED

`POST /svc/kv` takes `v` as an object; `GET /svc/kv/<k>` returns the stored JSON
STRING. Nothing in `app/src` reads that route (only `/svc/kv/manifest`), so it is
latent rather than broken — and changing the shape of a route with no caller buys
nothing while risking the next one. Recorded in the test so whoever wires a reader
meets the fact instead of the surprise.

Both fixes proved by reinstating the shipped behaviour: 7 of 15 fail without the
backup guards, and the notify test fails against the old two-field body.

    gate: VERIFY PASSED - 7 stages, 120s
    tests: 15 new, hermetic — nothing sent, nothing downloaded

---

## v63.5 — WHAT EACH MODULE COMPUTES, AS A RUNNABLE CHECK

The three defects in v63.2–v63.4 were each found by reading one body by hand.
That is not repeatable, so `scratchpad/behave.py` is the method as a tool: **29
content assertions across 11 service modules**, each printing the numbers it
checked. Not "does the route answer" — `probe.py` does that, and this project
already records a Quant desk that was dead while reporting nineteen libraries
present.

What it asserts is arithmetic, ordering, units and brackets:

    bars      timestamps ascending and unique          200 bars, 200 distinct
              high/low bracket open/close              0 of 200 violate it
              1h spacing really is one hour            distinct gaps: [3600000]
    store     total equals the sum of its parts        sum=93840890 reported=93840890
              inventory budget matches its setting     setting=5 GB inventory=5.000 GB
    research  every group accounts for all its claims  6 groups, 0 that do not add up
              each interval contains its own rate      5 rated, 0 excluded
              the rate is hits over decided            5 checked, 0 disagree
    core      failing total = sum of failing kinds     1 failing kind, total 43
              nothing quiet is reported as failing     window 21600s, 10 held apart
    mt5       clock label matches measured offset       label UTC+3, measured +3.0 h
              specs filed under the canonical name     3 canonical of 6 keys
    features  nothing is stamped in the future         22 stamps, 0 ahead of now
    onchain   chain and address are not swapped        50 pairs, 0 suspicious

**EIGHT MODULES ARE SKIPPED BY NAME, WITH THE REASON**, because their only
surface is destructive or side-effecting: `alerts` SENDS, `bulkfetch` DOWNLOADS
gigabytes, `sync` writes the browser backup a test once overwrote, `mcpauth`
would register a client on a third party's service, `auto` is minutes of compute,
`signals` arms a strategy, `risk` is POST-only, and the router's SKILL invariant
is a property of a fitted model rather than of the service. A probe that quietly
narrows is the defect it exists to find, so the skips are printed and counted.

### THREE OF THE FIRST 27 FINDINGS WERE THE PROBE'S OWN

Better than v63.3's ten of twelve, and the same lesson:

  * The credential check was a substring search for `"token"` and fired on **"when
    the scanner finds a newly listed token"** — a sentence about crypto, in the
    copy. A credential check that trips on English prose is one people switch
    off. It now asserts the response carries only its declared FIELDS, and
    searches six credential key names.
  * `/svc/data/snapshot` returns a **bare list**; the probe assumed a dict and
    crashed, which it reported as a failure of `features`. Read the shape.
  * It asserted `skill` on `/svc/router/health`, which correctly answers
    `engine`/`minRows`/`ok`/`why`. **Asserting the wrong route's shape reports a
    defect in working code**, which is what a checker can least afford.

### THE RESULT IS A CLEAN ZERO, AND THAT IS A FINDING TOO

29 passed, 0 failed. Three earlier passes each turned up one real defect; this one
says the content invariants hold everywhere they can be read without side
effects. That is the honest shape of the answer — not "everything is perfect", but
"these 29 identities are true right now, and here are the numbers".

Accounted for in `tests/test_audits.py` as EXCLUDED with its reason: it needs a
live gateway and real data, so it cannot run inside `verify.py`. Run it beside
`python run.py`.

    gate: VERIFY PASSED - 7 stages, 122s
    behave: 29 checks, 11 modules, 8 skipped by name, 0 failures

---

## v63.4 — THE NUMBERS ON THE TRACK-RECORD CARD DID NOT ADD UP TO THEIR OWN TOTAL

v63.3 swept for PATTERNS. This asked what the modules COMPUTE — the distinction
this file already records costing it a Quant desk that was dead while reporting
nineteen libraries present. `probe.py` says a route answers; it cannot say the
answer is coherent.

Reading the live `/svc/claims/stats` body instead of counting it:

    total 723    decided 428 + pending 262 + unknowable 11  =  701

**Twenty-two claims in the total and in no bucket.** MEASURED against the table:
2,113 rows — `pending` 1,098, `target` 523, `stop` 442, `unknowable` 19, and
**`expired` 31, published nowhere**. `_OUTCOMES` has five members and
`_population` counted four.

### THE EXCLUSION WAS RIGHT. THE SILENCE WAS THE BUG.

`expired` must stay out of the hit-rate denominator, and that reasoning is
untouched: A TIMEOUT IS NOT A LOSS, and folding one into `stop` makes "nothing
happened" and "I was wrong" look the same. But a figure counted in a total and
named nowhere is the SHAPE of a bug, and a reader who sums the card and finds 22
missing cannot tell a deliberate category from an arithmetic error.

**Both screens that render a population carried a comment promising to name what
they could not settle** — `trackrecord.ts`'s "What each side could not settle —
named, not dropped" and its sentence "Not in either rate above: …" — and for 31
claims neither did. A stated guarantee, falsified.

### THE SAME GAP EXISTED INDEPENDENTLY IN THE FRONTEND

`learn/scorecard.ts` `summarise` counted the same four and put every claim in
`total`. Two implementations, the same omission, arrived at separately — which is
what makes it a class rather than a slip. And `expectancyR`'s own doc in that file
says "over everything that resolved, **expiries included**", so the module knew
about them while no field named them. That sentence is the only reason the gap was
visible at all.

Fixed in four places — `mishel_claims.py`, `data/claimstats.ts` (the type),
`learn/scorecard.ts`, and both render sites. Live, every group now adds up:

    group        total  decided  pending  unknowable  EXPIRED
    Everything     723      428      262          11       22
    XAUUSD         209      127       64           3       15   <- 7% of it, invisible
    BTCUSDT        433      287      131           8        7

### THE GUARD PINS THE RELATIONSHIP, NOT THE NUMBER

`tests/test_claims_partition.py` (7) and `app/test/scorecard-partition.test.ts`
(6). The load-bearing test in each walks the DECLARED outcome list and requires a
bucket for every member, so **a sixth outcome fails there rather than silently
reopening the hole — which is exactly how this one arrived**. Pinning "expired ==
31", or even pinning the field's existence, would pass again next time. Sibling of
"a guard test that pins a COUNT fails on addition and passes on substitution".
Proved against the shipped state: 6 of 7 python and 6 of 6 frontend fail.

### AND A CAST HID A BAD FIXTURE FROM tsc

My gate-comparison fixture used `verdict: "wait"`. `Verdict` is
`"take" | "stand-down"` — two values, and `gateVerdict` covers both exhaustively —
so the four claims went into neither population and the test blamed the code. `as
Claim` is what let it compile. **A cast is a hole in the type system the exact
size of the mistake you are about to make**; an annotated return type
(`(c): Claim => …`) refuses it. The fixture was wrong and the code was right.

Bundle rebuilt and served from :8787 — not the dev server, per the rule this file
records v59.1 and v59.2 breaking.

    gate: VERIFY PASSED - 7 stages, 123s
    live: every claims group partitions its own total; interval brackets the rate

---

## v63.3 — FOUR DEFECT CLASSES ASKED OF ALL 61 BACKEND MODULES

Endpoint health is not a code audit, so `scratchpad/svcsweep.py` asks the backend
what `classsweep.py` asks the frontend: four classes this project has already
paid for, put to every module at once, so the answer is a number and not a
feeling. Each class is an incident, not an invention:

| class | what it cost |
| --- | --- |
| a tuple-returning function read as one value | `rows = yf_bars(...)` — the success and failure paths were byte-for-byte identical from outside, and the hourly top-up had never stored a bar in its life |
| a config key read by something, written by nothing | `bars_enrolled` left a loop ticking with a fresh tick age and no work for a whole release |
| a table written and never read, or read and never written | three backlog items in one shape |
| `rstrip("/suffix")` as suffix removal | it takes a SET OF CHARACTERS; caught once in `run.py`'s own banner |

**TEN OF TWELVE FIRST-PASS FINDINGS WERE MY SWEEP'S OWN FALSE POSITIVES**, which
is what this project says to expect and why a survey must print them:

  * It resolved `fn.attr`, so `c = sqlite3.connect(...)` and
    `si = _MT5.symbol_info(name)` were reported against `mt5_bridge`'s functions
    of the same name — three findings, all somebody else's code. Bare `ast.Name`
    callees only now.
  * It asked whether a config key appeared on a line that writes config — and
    every real writer here is PARAMETERISED (`VALUES(?,?)`), so it accused
    `tg_token` and `tg_chat`, which `svc/alerts.py` has a route for. It counts
    MENTIONS instead: one mention is the read and nothing else knows the name.
  * Its `INSERT\s+INTO` missed `INSERT OR IGNORE INTO`, so `onchain_seen`,
    `sig_fired` and `wallet_events` were "written by nothing" — three tables this
    product demonstrably fills.
  * It counted `rstrip("\r")` as two characters and flagged my own correct line,
    because it compared the SOURCE TEXT of the escape. Rule 2 of Working style,
    broken by the tool written to apply it — third time a tool here has done that.

`--selftest` reinstates the `bars_loop` defect and requires the sweep to catch it
while NOT flagging the correct unpacking caller. An audit owes the same proof a
fix does.

### THE TWO THAT SURVIVED, AND ONE OF THEM MADE A REFUSAL HONEST

`store_budget_gb` and `pair_scan_tg` were read by the server and settable by
nothing.

The budget is the one that matters. `svc/store.py budget_bytes()` reads it and the
whole eviction policy enforces it — and the refusal the planner raises when a
budget cannot be met without deleting recent history advises, in this file's own
words, **"raise the budget, or drop a market"**. There was no way to raise it.
`svc/store.py`'s own comment says "anything beyond this is a deliberate choice",
describing a choice that could not be made. **A refusal must name a remedy the
product offers**, or it reads as the operator's mistake. `pair_scan_tg` is the
same shape: the new-pair Telegram alert was permanently off and unreachable.

`server/svc/settings.py` (207 lines, 2 routes) is now the one owner of
operator-settable server configuration, WHITELISTED because `cfg()` also holds
`svc_token`, `tg_token` and `tg_chat` — a route that writes any key rewrites the
service's own auth token from the browser. Verified live: the budget moved 5 GB →
120 GB and `budget_bytes()` followed.

**And my own first draft restated the default as "20" while `svc/store.py` says
5** — two owners for one default, disagreeing on the first day, on a number the
plan document also assumed was 20. The default is now a callable reading the
owning module, and `test_the_default_has_one_owner` fails if anyone restates it.

`test_settings.py`, 19 tests. The load-bearing one is
`test_the_setting_reaches_the_code_that_reads_it`: a written setting nobody reads
is the same defect from the other side, and asserting the row landed in `config`
would prove nothing about it. Proved by disconnecting the reader — 3 fail.

**One of my tests poisoned its siblings.** The credential-leak test wrote
`svc_token` as a sentinel and left it there; the auth guard then refused every
`/svc*` request, and two later route tests failed as "unauthorized" for a reason
that had nothing to do with them. A test that writes a credential into shared
config breaks the tests after it and points the failure at the wrong code.

`svcsweep.py` is gated in `tests/test_audits.py`, so it runs on every
`verify.py` — and it reports **0** now precisely because the two keys have a
writer.

    gate: VERIFY PASSED - 7 stages, 122s
    sweep: 61 modules, 17 svc, 23 tuple-returning functions, 21 tables -> 0 findings

---

## v63.2 — A SWEEP OF EVERY ROUTE AND LOOP, AND THE FAILURE COUNT WAS LYING

Booted `python run.py` and measured the whole surface rather than one module.

    routes   65 probed (46 at the last sweep; the 10 new MCP ones answer)
    BROKEN   0
    loops    13 of 13 started and ticking, IRAM_BACKGROUND=1

### THE EVENT LOG REPORTED ELEVEN FAILING JOBS AND ONE WAS FAILING

`/svc/events/summary` said `failingKinds: 11, failingTotal: 2601`. Three of the
largest were faults **repaired in v62.15**, and the source proves it: `data_mvrv`
asks only for `CapMVRVCur` (and is storing — 8 fresh rows), `forexfactory_cal` is
deleted down to a comment, and `dbhold.py` reports **zero** nested writes. Their
newest entries were 8 hours old: residue written by a process running the old
code.

**`summarise_events` had no recency notion at all.** `failing` meant "has this
kind EVER failed", so a repaired fault — and `data_forexfactory_cal`, whose job
was DELETED and which can never log again — would be reported as currently
failing FOR THE LIFE OF THE DATABASE. The card whose headline is "how many jobs
are failing" could never go green however much was fixed.

`activity.ts` had already half-noticed, labelling that kind "Economic calendar
feed (retired)" while the server went on calling it failing. One fact, two
owners, disagreeing — so the recency bound lives in `summarise_events`, where the
classification is, not as a second judgement in the client.

    before   failingKinds=11  failingTotal=2601
    after    failingKinds=1   failingTotal=43
             quietKinds=10    quietTotal=2558   (history, counted apart)

**THREE STATES, AND `quiet` IS NOT `healthy`.** Most `mishel_data.py` feeds call
`log()` only inside an `except`, so silence is the absence of a recorded failure
and not the presence of a success — calling it healthy would be the "absence of
errors is not evidence of success" mistake. Every kind also publishes `ageS`, so
a card states "last failed 8 hours ago" instead of trusting the six-hour
threshold chosen here. Proved by deleting the bound: 8 of the new checks fail.

The existing tests now pass an explicit `now`. A pure function that reads the
clock cannot be tested, and a test whose answer depends on when it runs starts
failing on its own — the same reason `sleep_ticking`'s fake clock moves both
halves.

### TWO MISTAKES OF MINE, BOTH FROM MEASURING BADLY

**I broke `core.py` into a syntax error and blamed the encoding.** Replacing a
docstring's opening line, I inserted a COMPLETE docstring ahead of the original's
body — so the original's remaining prose became stray code and the next `"""`
opened a string. The reported error was 160 lines away, on an em dash, and my
first move was to check the file for encoding damage. It decoded as clean UTF-8.
When an error points somewhere unrelated, suspect the edit, not the bytes.

**I reported the calendar store as empty when it holds 314 rows.** My query was
`GROUP BY source, k ... LIMIT 14`, and there are exactly 14 pairs ranked above
it, so `calendar` was cut off — and I wrote up "the guard can never close" from a
truncated list. Queried directly: `calendar/week` 127 rows, `calendar/high_usd`
187, both written 11 minutes earlier. **The freshness guard works.** This is
CLAUDE.md's own rule — check a surprising finding against the source before
writing it up — and a `LIMIT` in a diagnostic query is a silent one.

So the one remaining live entry, `data_calendar`, is **not broken**: an
intermittently throttled free scrape-tier mirror, 43 in ~233 cycles, whose stored
copy survives a failed refresh. The module says it is best-effort by nature.

### `probe.py` reported five broken routes on every run

It had no allowlist — the reasons lived only in CLAUDE.md prose, so every run
printed "BROKEN: 5 of 65" and a human had to remember which five were correct. A
checker that always prints five failures is one whose sixth nobody notices, and
one of the five was a route added in the same session. `BY_DESIGN` now carries a
reason per entry, and a STALE entry — one that no longer answers the way its
reason says — is reported rather than forgiven, which is the question
`test_audits.py` asks of its own audits. **BROKEN: 0 of 65.**

    gate: VERIFY PASSED - 7 stages, 126s

---

## v63.1 — MCP SIGN-IN, AND A GUARD THAT CAUGHT ITSELF BEING VACUOUS

`server/svc/mcpauth.py` (575 lines, 4 routes) is MCP's OAuth 2.1 as one generic
flow: discovery from the 401 itself, RFC 7591 dynamic registration, PKCE S256,
refresh with rotation. DRIVEN LIVE against both authenticated servers —
discovery only, because registration creates a record on somebody else's service
and that belongs to the operator's Connect press, not to mine:

    TradingView  issuer https://www.tradingview.com   register .../mcp/oauth/register
    LunarCrush   issuer https://lunarcrush.ai/        register .../oauth/register
    Crypto.com   correctly REFUSED: "did not say where to sign in ... may not use it"

**No credential is ever asked for, typed, or held.** `registration_endpoint` plus
`token_endpoint_auth_methods_supported: ["none"]` is a PUBLIC client: the client
id is issued on demand and there is no secret. The operator's password is typed
into the service's own page, in their browser, and never reaches this process.
That is the reason OAuth is used here instead of an API-key field.

### THE GUARD PASSED 26 OF 26 WHILE CHECKING NOTHING

`tests/test_mcp_secrets.py` sweeps every `/svc/mcp*` route for a sentinel token.
It passed first time — and it was vacuous: **the registry was empty, so
`/svc/mcp/servers` and `/svc/mcp/signin-status` both rendered `[]`**. The sweep
was reading two empty lists and reporting the token safe.

What found it was the test written to prove the sweep: introduce a real leak (add
the token to `status()`, one plausible careless line) and require the sweep to
CATCH it. It did not. That is "an audit script that parses nothing reports
success", inside the guard written to keep a credential off the wire — the same
shape as `/svc/health` painting "0 of 0 running" green.

Fixed by registering the server in the fixture, and pinned against recurrence: the
sweep now asserts the swept routes actually NAMED the server, so an empty
rendering fails instead of passing. Proved by deleting the registry line — 2 of 33
fail, both of them the right ones.

**A weak test is worse than no test where it covers a credential**, because it is
the thing that stops anyone looking again.

### ASKING FOR EVERY SCOPE A SERVER ADVERTISES IS ASKING FOR TOO MUCH

MEASURED: LunarCrush advertises `["profile", "api.read", "api.write"]`, and the
first version of this requested all three. So connecting a SENTIMENT READER would
have asked permission to write to the operator's account — on a consent screen
where `api.write` is one word among three and nothing would say why. They would
have approved it once and nobody would look again.

`read_scopes()` drops anything containing write / delete / admin / trade / order /
manage, and `begin()` REPORTS both what it asked for and what it withheld, because
a grant whose shape nobody can see is a grant nobody checked. Writing stays
available — a server-side watchlist or a price alert is a real use — but it takes
`allow_write`, and therefore a press. It returns the full set when every scope
looks like a write scope, rather than asking for nothing and failing the handshake
with no explanation. Proved: 3 of 33 fail with the restriction removed.

### The rest of the refusals, each a real failure mode

  * **`plain` PKCE is refused, not downgraded.** A silent fallback removes the only
    thing the challenge adds.
  * **The implicit grant is never used.** LunarCrush offers `response_types:
    ["code", "token"]`; a token in a redirect fragment is a token in browser history.
  * **A `state` that was not issued here is refused, and is single-use.**
  * **A failed refresh keeps the sign-in.** One unreachable minute is not proof a
    sign-in is dead, and silently logging somebody out of a working service is
    worse than a refusal they can see.
  * **A rotated refresh token replaces the old one.** Not following rotation fails
    days later, at the moment the connection is wanted.
  * **Signing out deletes locally even when revocation fails.** Somebody who asks
    to be signed out is signed out of THIS product whatever the remote service does.
  * **The callback returns a PAGE, not JSON**, and escapes what the service sent. A
    human is reading it in a tab they did not open from the terminal, and a blank
    page after signing in is indistinguishable from a failure.

### Also

  * The gate caught a SIXTH ruff rule (`RUF012`) on the new test and failed the
    build, which is exactly what `ruff.toml` says it is for — it gates on the rule
    NAME, not a count.
  * `scratchpad/mcpauthprobe.py` added and EXCLUDED by name in `test_audits.py`
    with its reason.

    gate: VERIFY PASSED - 7 stages, 345s
    tests: 33 sign-in + 30 engine, all hermetic

**Next:** the Connections-desk card (`classcollide.py` before a prefix), then IRAM
exposed AS an MCP server. Still no `order_send` anywhere in `server/`.

---

## v63.0 — THE MCP ENGINE, AND SIX THINGS MEASUREMENT CHANGED ABOUT IT

The ask was *"add mcp engine so i can connect trading view or other free
platforms"*, and it arrived with a pasted description of TradingView's server.
Every decision below came from probing the live services instead. The plan of
record is `docs/PLAN-v63-mcp.md`; `scratchpad/mcpprobe.py` re-runs the
measurement rather than leaving it as a paragraph to trust.

**TradingView's auth is easier than the description implied.** Its
authorization server advertises a `registration_endpoint` and accepts
`token_endpoint_auth_method: none`, so RFC 7591 dynamic registration of a
PUBLIC client applies: no client id to obtain, no secret to store, nothing for
the operator to type. Press Connect, sign in once, `refresh_token` keeps it.
**Unverified, and it is the load-bearing unknown:** whether a free plan is
served. The owner has a free plan, so that leg will ship ready and unproven and
will say so rather than claiming it works.

**A free plan cannot waste that work, because the auth is generic.** LunarCrush
advertises the identical chain — `WWW-Authenticate` → protected resource →
authorization server → dynamic registration. One implementation serves both, and
LunarCrush is the target that proves the flow if TradingView refuses.

**Exactly one market-data MCP server answers without an account.** Crypto.com:
200, nine tools. CoinDesk, AlphaVantage, TwelveData, LunarCrush and FMP all 401.
So the engine is verifiable end to end on day one with nothing from the operator,
which is why it already has been.

**Two candidates are refused BY POLICY, in code, with the reason attached.**
AlphaVantage and TwelveData publish MCP servers and this product already speaks
REST to both — with per-endpoint timezone corrections that exist because reading
them wrong once displaced every bar they ever served. A second path to one vendor
is a second owner for what a market did: the `/svc/ledger` mistake. `WONT_WIRE`
states it where the next person will meet it.

**A TOOL RESULT IS PROSE WRAPPING JSON, AND IT BROKE THE PROBE WRITTEN TO READ
IT** — on the first real call this engine ever made:

    Here is the Crypto.com Exchange candlestick data {"instrument_name":"BTC_USD",...}

`json.loads` raises on that. An MCP tool answers a language model, so its content
is model-facing text and the data is an artefact inside it. `embedded_json`
locates the object with `raw_decode` and returns the prose SEPARATELY. The
important half is what it does not do: that wording is not a contract and has no
schema behind it, so a caller validates the fields and the function refuses
rather than repairing a near-miss. This is the hand-written-client risk this
project records as its one real API-contract gap, arriving in a source with no
schema at all. `tests/test_mcp_client.py` pins it by asserting a bare
`json.loads` FAILS — without that the test passes whatever the parser does.

**MCP IS NOT A BACKFILL SOURCE, and that is measured rather than cautious.**
`get_candlestick` accepts `instrument_name` and `timeframe` and nothing else, and
returned **50 rows, newest-first**. No date range, no cursor. Fifty descending
bars cannot fill an archive a walk-forward reads, so no MCP data enters the
`bars` table. Its timestamps are honest, which is worth recording given the
history here — explicit `2026-09-25T11:00:00Z`, newest bar agreeing with the wall
clock, none of the naive-datetime displacement that once moved every TwelveData
and AlphaVantage bar. Prices are strings.

### What the transport had to get right, each one measured

  * **The reply is EITHER `application/json` OR `text/event-stream`.**
    Crypto.com answers a unary `initialize` with SSE, so a client calling
    `r.json()` fails against the only server available to verify it against.
  * **The server's protocol version wins.** Offered `2025-06-18`, told
    `2025-03-26`, and the negotiated value is what goes back out.
  * **`Mcp-Session-Id` is optional and is echoed only when issued.** Crypto.com
    issues none; requiring one refuses a working server — "absent read as
    broken", the sibling of "0 of 0 running" painted green.
  * **An expired session answers 404, which means handshake again.** Reporting
    that as a dead server is a refusal the operator cannot act on for a
    connection one request from working.
  * **Several `data:` lines are ONE message and are joined.** A parser taking the
    first truncates every message big enough to be split.

### A REAL BUG, FOUND BY THE TEST AND INVISIBLE TO THE LIVE DRIVE

`_session` returned the handshake result verbatim on a cache miss and the cached
row on a hit, and **the two spelled the session id differently** — `session`
against `id`, with `_rpc` reading `id`. So the first call after every handshake
went out with no `Mcp-Session-Id` at all. Driving it against the live server
could not show it, because **Crypto.com issues no session id**: the only server
this project can reach without an account is precisely the one where the defect
is invisible. Same class as the broker spec filed under `XAUUSD.s` and looked up
under `XAUUSD`. Proved by deleting the fix: 29 pass and 1 fails without it, 30
with. One spelling, built in one place, now.

### Two of my own test fixtures were wrong, both in the direction of passing

  * The split-SSE fixture cut a serialised object at `len // 2` and rejoined with
    `"\n"`, which cannot restore a cut landing mid-token. A real server splits on
    newlines IT wrote. The fixture was corrupting its own payload and blaming the
    parser.
  * `expire_once` reset on `initialize`, so the retry expired as well and the
    test could not tell "retries once" from "does not retry" — it only ever saw
    the refusal.

### Also

  * `scratchpad/mcpprobe.py` is in the repo because `svc/mcp.py` tells the reader
    to run it, and a comment naming a tool that does not exist is the defect
    class this file already records twice. `tests/test_audits.py` refused it as
    unaccounted on the first run, which is what that guard is for; it is now
    EXCLUDED by name with its reason.
  * The heredoc mangled a backslash again while patching a test — sixth time.
    The documented fix was applied: the edit went through a tool with no shell
    between it and the file.
  * `svc.mcp` added to `HIDDEN` in `build_binary.py`, enforced by
    `test_build_hidden_imports.py`. **No exe was built** — standing instruction.

    gate: VERIFY PASSED - 7 stages, 119s
    live: Crypto.com handshake, 9 tools, 50 real bars, 8 refusal paths named

**Still to build**, in the owner's order: the OAuth half (`svc/mcpauth.py`), the
Connections-desk card, then IRAM exposed AS an MCP server so a study can be asked
for from chat. Read-only: `order_send` still appears nowhere in `server/`.

---

## v62.28 — BOOT PERFORMANCE: MEASURED, AND THE MEASUREMENT REFUSED

Performance was the one dimension never touched this session, and the bundle had
grown 2,006 -> 2,021 KB under these changes. So it was measured. **No change was
made, and that is the result.**

### WHAT IS SOLID

`mountShell` takes **157ms**, timed around the call itself. That is a real
number and a reassuring one: building the entire shell is not the cost of a
boot, which retires the obvious suspicion.

The document also parses fast — body reached at 220ms on a 2 MB single-file
build — so the inlined 1.5 MB script and 510 KB stylesheet are not the wall they
look like.

### WHAT COULD NOT BE ESTABLISHED

First contentful paint, across three runs of the SAME page with no code change
between them:

    run 1   FCP 1,224ms
    run 2   FCP 3,356ms
    run 3   FCP 3,096ms

A 2.7x spread on an identical page. `first-raf` landed at 2,082ms in a tab that
`tabs_context` reported as active with the pane displayed — starved frames being
the signature of a tab that is not being composited.

CLAUDE.md already states the rule: *"Do not claim a measurement taken through
the browser preview pane when the pane's visibility changed during the run.
First contentful paint then reports when the pane appeared, not what the page
cost."* The variance IS the evidence that this applies.

### WHY NOTHING WAS CHANGED

An earlier hypothesis looked compelling and was wrong: that the `#boot` skeleton
could not paint because the single-file build inlines 2 MB ahead of its markup.
The byte layout supports it —

    byte     1,352  <style>    1,868       the skeleton's critical CSS
    byte     3,240  <script>   1,520,980   the whole app
    byte 1,524,256  <style>    510,898     the app CSS, still inside <head>
    byte 2,035,507  id="boot"              the skeleton markup

— and the probe disproved it: the body is parsed at 220ms and `mountShell`
finishes at 381ms, so the skeleton is in the DOM and styled long before any of
the delay.

**Optimising against an unreliable number is the thing this project's first
house rule forbids.** The chart's render path was once assumed slow and measured
at zero long tasks; a dependency count of "21, too many" was 13. Both were
corrected by measuring. Here the measurement itself did not survive scrutiny, so
the honest output is the refusal plus what it would take to do properly: a real
browser window, or a DevTools performance trace, on the operator's own machine —
neither of which is available from here.

The temporary probes in `app/index.html` and `src/main.ts` were removed and the
gate re-run clean.

**Gate: 7 stages, 107s, all pass.**

## v62.27 — THE FORWARD LEDGER IS SUPERSEDED, NOT MISSING

The last "the store is empty, wire the WRITER first" row was `/svc/ledger`. The
same lead that found the trial mirror's missing caller — so it was worth asking
whether this was the same defect twice.

It is not. Measured side by side:

    /svc/claims   2,101 recorded, 425 decided. A stated claim with LEVELS,
                  graded against real bars, with a confidence interval on every
                  rate, a calibration curve and a gate-lift figure.

    /svc/ledger   0 rows. A score's SIGN against a yfinance close at +1h/+4h.

`/svc/ledger` is the claims ledger's crude predecessor. Wiring it would create a
SECOND, worse owner for "did the machine's read work out" — the duplicate-source
defect removed with `forexfactory_cal` and declined for `/svc/auto/subjects`
earlier in this same session. One fact, one owner.

So it is recorded as SUPERSEDED rather than as backlog, and the consequence is
named with it: `ledger_loop` has no writer for its input and never will, so it
costs one query per cycle against a table that stays empty. Left running rather
than removed — deleting a loop from the operator's product is their call, and
the cost is a single SELECT.

**This closes the last row of the route ledger that was a question rather than a
decision.** The categories now read: 4 not fetch targets, 4 deliberately dead, 1
superseded, 1 duplicate, 1 needing an operator credential, 2 destructive admin,
1 genuinely awaiting data (`/svc/onchain/leaderboard`), and ZERO capability
without a screen.

## v62.26 — THE DOOR I WALKED THROUGH TODAY, CLOSED STRUCTURALLY

A test reaching the operator's real data has now happened SIX times through
THREE different doors, and the third was mine, this session.

    1  four python files that never set MISHEL_SVC_DB — each run advanced
       `sqlite_sequence` and replaced `kv.client_backup` with a fixture
    2  `createHistory` defaulting to the real `/svc/bars` client — 535 rows of
       fixture candles, sources `net`/`a`/`alive`, dated 2027, into the archive
       the backtests read
    3  `startBackup`'s transport defaulting to the live `pushBackup` — a
       SCHEDULING test POSTed two fixture slots over thirteen real ones

**Each fix was correct and local, and the next door opened anyway**, because the
rule lived in people's heads rather than in the gate. The `0xdna1111…` and
`0xnodna1111…` wallets still in the live database are what that costs: residue
nobody can now safely delete without asking.

`tests/test_no_live_store.py` makes it structural. A Python test that names the
database or imports the service must set `MISHEL_SVC_DB` to a scratch path, and
must set it BEFORE the import because the module reads it at import time — that
ordering is a separate assertion. A frontend test must not name a live service
helper at all, since under vitest the global `fetch` resolves against a running
gateway.

It is a SOURCE check, not a runtime one, on purpose: by the time a runtime guard
fires, the write already has a stack trace and the operator already has a
corrupted row.

### PROVED AGAINST ALL THREE DOORS

    sqlite3.connect("server/mishel.db") with no scratch path   -> FAILS
    import mishel_service with no scratch path                 -> FAILS
    a frontend test importing svcUrl                           -> FAILS
    the tree as it stands                                      -> passes

### AND THE GUARD ITSELF TOOK TWO PASSES

Its first version matched raw source and flagged `test_edge_count.py`, which
builds its own sqlite file in a temp directory and is entirely correct — caught
on its DOCSTRING, which names the live database while explaining this very rule.
Punishing the files that document a trap is backwards.

So the second version stripped every string literal — and then **stopped
catching the defect it exists for, because a database path IS a string
literal**. The probe sailed through. That is the same mistake as stripping
`"POST"` out of a sweep for modules that POST, made twice in one session in two
different tools.

Triple-quoted strings are prose here; short literals are arguments. Only the
first are stripped, and both halves are proved.

**Gate: 7 stages, 107s, all pass.**

## v62.25 — A WEEKLY CALENDAR, FETCHED HOURLY

The end-to-end pass after twelve releases of changes found one job still failing
live: `data_calendar`, 42 rate-limit failures.

    429 Too Many Requests  https://nfs.faireconomy.media/ff_calendar_thisweek.json

Probed directly, the same feed answers **200 with 82 events**. Nothing was broken
except the asking: the loop requests a WEEK'S calendar every hour, and again the
moment the service starts — and I restarted the gateway about eight times today,
so a good share of those 42 are mine.

### THE TIMER HAD TO SURVIVE A RESTART, WHICH IS WHY IT IS NOT A TIMER

`collect()` runs the instant the process starts, so a run of restarts is a run of
fetches with no interval at all. A module-level timestamp dies with the process —
precisely the case that needed covering. Freshness is therefore read from the
STORE: `is_fresh(last_stored("calendar", "week"), now, 6h)`.

`is_fresh` is pure and pins the two defaults that matter. **Never fetched is
STALE**, because treating a missing row as fresh would mean a new install never
fetches at all — a loop with a healthy tick age producing nothing, which is the
`bars_loop` failure this file already records. And **a future timestamp is not
trusted**, or a clock that moved backwards would pin a feed as permanently fresh
and it would never refresh again.

### THE GATE CAUGHT MY FIRST SHAPE

I put an early `return now` above the calendar block, and `test_data_v393.py`
failed on:

    STRUCTURE: D8-D14 each open with their own try
               (one dead feed never kills the rest)

That structure is why one failing vendor does not take the other six legs down,
and an early return out of the middle of `collect` is exactly what erodes it.
The guard moved INSIDE the try, where it cannot change anyone else's control
flow. The invariant was right and my shape was wrong — the test earned its place.

### PROVEN LIVE

    calendar/week stored          09-25 06:36:56
    gateway restarted, full cycle 08:29:13
    data_calendar failures        42 -> 42

A whole cycle ran and the calendar was skipped, because its stored copy is under
six hours old. Six hours still refreshes a weekly file several times over, and
every reader uses the stored copy in between — a failed fetch never removed it.

**Gate: 7 stages, 107s, all pass — 28 scripts.**

## v62.24 — THE AUDITS NOW RUN THEMSELVES

Four audits were written this session, each after a real defect, and every one
of them lived in `scratchpad/` where **nothing ran it**. That is the mechanism
this project records twice: nineteen Python test files were in no list so
breaking one was free, and `run.py` was the largest module outside every gate so
it was linted by nothing. An audit nobody runs is a one-time finding, not a
guard — and every class found this session would have been free to return.

`tests/test_audits.py` runs the three deterministic ones on every `verify.py`:

    dbhold.py       a transaction holding a SECOND connection
                    (2,069 failures, onchain_seen empty, a loop that had never
                     once succeeded)
    classsweep.py   credential egress · a parameter defaulting to live network
                    I/O · a debounce with no ceiling · a count returned from its
                    own input · a hand-rolled reactive list
    cssdupe.py      one class, two conflicting top-level declarations
                    (the calendar laid out on the calibration card's grid)

**IT FAILS ON A ZERO, NOT ONLY ON A FINDING.** Each audit exits 2 when its
pattern matches nothing, and the test asserts that separately from "clean" —
because a checker whose regex has stopped matching reports a tidy tree, which is
the `/svc/health` "0 of 0 running" painted green, inside the gate. It also
asserts each audit PRINTED what it parsed.

PROVEN: reinstating the `.cal-row` collision fails `verify.py`; removing it
passes.

### AND THE SAME RULE, ONE LEVEL UP

A second test asks whether every script in `scratchpad/` is either gated or
excluded BY NAME WITH A REASON — the `tests/ fully listed` rule applied to the
audits themselves. Its first run failed with nine unaccounted files, all of them
one-shot edit scripts.

Those moved to `scratchpad/applied/`, which now has a README explaining the
split: each already ran, each asserts its anchor matches exactly once so a second
run fails rather than corrupting a file, and none is a check. Keeping them out of
the top level is what makes "is every audit gated?" answerable at all. The top
level holds only re-runnable tools.

`ruff` then caught `subprocess.run` without an explicit `check`, and the first
fix (`# noqa`) became an unused directive once `check=False` was added — the
gate objecting twice to two different versions of the same line.

**Gate: 7 stages, 107s, all pass.**

## v62.23 — THE LEARNING LOOP HAD NO WAY TO CLOSE

The route ledger filed `/svc/edge/kinds` under "the store is empty, wire the
WRITER first". Following that note found the writer already existed and had
never once been called.

`shell.ts` says, beside `createEdge`:

> So it pushes when the operator asks, from the Learning desk, and the
> conditional read below pulls whatever has accumulated.

**Nothing asked.** `grep` for a caller of `edge.push` across `app/src` returns
nothing. So `trials` could never fill, `/svc/edge/kinds` answered empty forever,
and the conditional-edge read — the thing the Knowledge desk exists to show —
had nothing to read. **Documented behaviour with no implementation is worse than
an absent feature, because it reads as working**, and the comment explaining the
design is exactly what stops anyone looking.

### WHY IT IS STILL A BUTTON

Both reasons in the original comment hold and are now on the control:

  * the replay re-runs on every symbol, timeframe, R-multiple or bar-count
    change — every minute on a 1m chart — and produces hundreds of trials each
    time, so an effect would be a steady write load for rows identical by
    construction; and
  * the mirror's own gate treats posting to a host that is not this machine as
    a DATA-EXPORT decision rather than a sync detail, and a button is where that
    decision belongs.

The title says where the data goes and that nothing leaves the machine.

### PROVEN LIVE

    before        trials 0 rows        /svc/edge/kinds -> {"kinds": []}
    press "Keep this replay"
    on screen     "Kept 52 outcomes."
    after         trials 52 rows       /svc/edge/kinds -> bos long n=14,
                                       choch short n=13, bos short n=12,
                                       choch long n=12, ...

`written` is read back from the database rather than from the request — the
count fix from v62.18 — so "Kept 52" is what landed, and a second press reports
"Nothing new: this replay was already kept" because the ids are derived from the
trials and an upsert converges.

The failure path shows the handle's own reason verbatim, because "the service is
not running" and "it refused" want different actions from the operator.

**Gate: 7 stages, 106s, all pass.**

### WHAT THIS CLOSES

`/svc/edge/kinds` leaves the uncalled list by being FILLED rather than by being
wired to a screen — the writer was the missing half all along, which is what
that ledger row said to check.

## v62.22 — SWEEPING THE WHOLE TREE FOR EVERY CLASS THIS SESSION FOUND

The work had become discovery-driven: pull a thread, find something, fix it,
pull the next. That finds real defects and never finishes, because "are there
more like this?" cannot be answered by looking. `scratchpad/classsweep.py` asks
each class of every file at once, so the answer is a number.

    PARSED   352 TypeScript files, 59 Python files, 2 modules that POST/PUT

    credential-egress      0
    live-default           0
    debounce-no-ceiling    0   (2 reviewed and correct)
    count-from-input       0
    hand-rolled-list       0   (3 reviewed, 2 fixed)

### THE SWEEP'S OWN FIRST RUN WAS WRONG TWICE

It reported **"0 modules that POST/PUT"** on a tree that plainly has them: an
HTTP method IS a string literal, and the comment/string stripper deleted the
token being matched. A zero in the parse column is a failure, and the script now
exits non-zero on any. It also reported line numbers shifted by hundreds,
because block comments were deleted rather than blanked — the `tdz.py` defect
this file already records, committed again in the tool written to find defects.

### FOUR OF SEVEN FINDINGS WERE CORRECT AS WRITTEN

`keys.ts` is a keyboard SEQUENCE timeout, where resetting per chord is the whole
point. `whalecard.ts` reschedules from its own completion, so it always fires.
`agent.ts` builds a fragment from text, not reactively. `playbook.ts` renders
`<option>` elements that cannot throw on data. All four are in the script with
the REASON, because an allowlist without one is a way to silence a tool.

Two were real: `calibration.ts` now uses `each` (its data comes from a service
that sends null for anything it cannot grade — the shape that ate three tables
in v62.13), and `screener.ts` now builds its fragment BEFORE clearing the table,
so a row that throws leaves the previous table standing instead of an empty one.

### AND THE MEASUREMENT FOUND A COLLISION NOBODY HAD SEEN

Checking the calibration card rendered, the query returned SEVEN rows for a card
with five bands. The extra two were economic-calendar events:

    .cal-row  declared line  522  82px 34px 1fr auto 10px    (the calendar)
    .cal-row  declared line 1804  48px minmax(0,1fr) 48px 56px  (calibration)

Same sheet, 1,280 lines apart, later wins. MEASURED in the browser: a calendar
row with **five children** laid out on **four tracks**, its fifth wrapping to an
implicit row and an 82px time column squeezed into 48. The `.sy-` defect this
project already records — "the desk rendered in another desk's clothes" —
arriving INSIDE one sheet, where `classcollide.py` could not see it because it
compares prefixes ACROSS sheets.

The calibration card is now `clb-`. AFTER: calendar `82px 34px 1fr auto 10px`
with 5 children, calibration `48px 296px 48px 56px` with 4.

### THE AUDIT THAT FOUND IT TOOK THREE PASSES TO STOP CRYING WOLF

`scratchpad/cssdupe.py` first flagged any class declared twice with a layout
property, and its first finding was composition rather than collision — a shared
base rule plus one class adding its own columns, which is correct CSS. Then it
flagged ten `@media` overrides, including one of my own mobile rules, because it
ignored nesting. It now compares only TOP-LEVEL rules that set the SAME property
to DIFFERENT values.

    PARSED  34 stylesheets, 1,981 distinct bare class selectors
    CONFLICTING REDECLARATIONS: 0

Proved both ways: reinstating the `.cal-row` collision makes it report exactly
that line pair; removing it returns zero.

**Gate: 7 stages, 106s, all pass.**

## v62.21 — THE SETTINGS BACKUP HAD NO WRITER, AND WIRING IT BROKE THREE RULES

The Connections card reported "Settings backup — 15 days ago" on its first
render. Chasing that one line found four defects, three of them mine.

### THE ROUTE HAD NEVER BEEN CALLED, AND WHAT IT HELD WAS A TEST FIXTURE

`POST /svc/backup` has existed since v29 with NO caller anywhere in the
frontend. What the server held:

    {"_t": 1234, "_v": 1, "mishel_walletdb": "{\"0xabc\":{\"tier\":\"S\"}}"}

`0xabc`, tier S — the exact fixture CLAUDE.md records four test files writing
into the operator's live database. So the "durable copy on the server" was
fifteen-day-old test residue, and every setting this browser holds lived in
exactly one place: localStorage, which the browser may evict without asking.
Same shape as the bar archive before v60.3, same fix.

### I WAS ABOUT TO PUT A CREDENTIAL ON THE WIRE

The live store holds `agent.credential`. `store/sync.ts` already carries the
rule and the scar:

> when the analyst's API key arrived under `agent.credential` the vault
> correctly withheld it from every backup while sync happily pushed it, in
> plaintext... what was wrong was that "is this a credential?" had two separate
> answers.

My `buildBackup` was becoming the THIRD answer, and an early draft would have
uploaded it. It now defers to `syncable()`, the one owner, so a
credential-shaped key added tomorrow is covered without anyone remembering.
**My own diagnostic POST did upload it once**; the row was overwritten with a
filtered blob within the minute and the credential is not on the server.

### A DEBOUNCE WITH NO CEILING

Every KV write cancelled the pending timer and rescheduled it. This terminal
writes continuously, so the deadline was pushed out and the backup did not run
while the operator was using it. (It DOES fire in a genuine quiet period —
observed at 07:39 — so "never fires" overstates it; the fault is indefinite
delay under load, which for a terminal left open all day is the normal case.)
A ceiling timer, set once per quiet period and never cancelled by a later
write, bounds it at five minutes.

### AND MY TEST FOR THAT CEILING WAS VACUOUS

It passed with the ceiling line DELETED. The 15s boot push fired on the first
tick and satisfied the assertion, so the continuous-write path was never
exercised — the "audit script that parses nothing reports success" trap, in the
test written to catch a scheduling bug. Proved by removing the ceiling and
watching it still pass. The test now consumes the boot timer first, and the
proof is recorded both ways: **11 pass with the ceiling, 1 fails without it.**

### THE WORST ONE: THE TEST REACHED THE OPERATOR'S SERVER

`startBackup`'s push argument defaulted to `pushBackup`. Under vitest the global
`fetch` resolves against the running gateway, so the scheduling test POSTed its
two fixture slots over the operator's thirteen real ones. MEASURED after the
run:

    slots = 2   keys = ['pins', 'prefs']      <- my test fixtures

CLAUDE.md records this arriving through a different door (`createHistory`
defaulting to the real `/svc/bars` client) and states the rule it produced:
**make reaching a real store something a caller OPTS IN to**, because "a default
that is inert cannot be reached by a test that does not know it exists". A
default that is LIVE is the exact opposite. The transport now has NO default:
`mountShell` passes it explicitly and every test passes a stub, so there is no
spelling of the call that silently touches the network.

Restored, and proven: a full `verify.py --lint` run now leaves the row at 13
slots with its timestamp unchanged.

    before the gate   slots 13   t 07:42:20
    after  the gate   slots 13   t 07:42:20

**Gate: 7 stages, 105s, all pass.** 11 tests, and the ceiling one was proved to
fail without its fix.

## v62.20 — THE "CAPABILITY WITH NO SCREEN" COLUMN IS NOW EMPTY

Seven routes with no caller, all answering with real content, now one card on
the System desk. Two more came off the list by MEASUREMENT rather than wiring,
which is the more valuable half.

    routes called   72 -> 80        never called   24 -> 16
    of those 16, capability without a screen:       0

### THE BROKER'S CLOCK IS NOW VISIBLE

    Broker bridge   connected
    The broker stamps 3.0 hours ahead of UTC. That is measured and
    subtracted from every bar, tick and deal.

MT5 stamps bars, ticks and deals on the BROKER'S clock, not UTC. The bridge
measures the offset from a live tick and subtracts it everywhere — and that
correction was completely invisible. CLAUDE.md records what the same class of
error cost going the other way: every TwelveData bar displaced by the server's
own UTC offset, nothing failing, "the chart drew the right candles in the wrong
places, which for a session-aware terminal is the worst available outcome". **A
correction you cannot see is one you cannot check.**

`clockLine` refuses to conflate the two states that matter: an offset that has
NOT been measured means every broker timestamp is being taken at face value, and
that is a different and more worrying fact than an offset measured at zero. A
test pins each.

### AND IT FOUND SOMETHING ON ITS FIRST RENDER

    Settings backup   15 days ago   [attention]

`backup_loop` logs an event daily and has 16 of them, newest today — but that
loop copies the SQLite FILE. `/svc/backup` is the BROWSER's settings push, and
it had not run in fifteen days. Two different things wearing one word, and the
card separated them the moment it existed.

### ZERO IS NOT A FAILURE, AND IS NOT COLOURED

"0 open" live streams is the normal state of a terminal nobody has a feed open
on. It is reported as a count with `data-level="none"` and no colour — the exact
opposite of `/svc/health` painting "0 of 0 running" green, and the same
distinction from the other side.

### TWO ROUTES CLOSED BY MEASURING, NOT WIRING

**`/svc/auto/subjects` is a DUPLICATE.** It returns byte-identical data to
`ready.subjects` inside `/svc/auto/state`, which the Simulation desk already
renders at three call sites. Wiring it would have been one fact with two owners
— the reason `forexfactory_cal` was deleted earlier in this same session. A
second screen for it would have been worse than leaving it alone.

**`POST /ai` is optional and gated on a credential the OPERATOR supplies.** It
refuses without `ANTHROPIC_API_KEY` and its own message says the terminal will
use its built-in analyst instead, which is exactly what the Analyst desk does.
Not a missing screen, and not a key for me to set.

### TESTS

`services.test.ts`, 12, all failing first. The DOM is not where the risk is:
the risk is in three judgements — unmeasured versus measured-zero on the clock,
how stale a backup has to be before saying so (a week, because the loop is
daily), and summing a store while SKIPPING a slot whose size is not a number
rather than counting it as zero.

**Gate: 7 stages, 105s, all pass — 27 scripts.**

## v62.19 — THE PICKER OFFERED 132 SYMBOLS; THE BROKER QUOTES 272

`/mt5/symbols` had no caller. The picker offered what the archive holds plus
`INSTRUMENTS`, a hand-maintained table of 132 — so **a third of what this
account can actually trade could not be typed into it**, and the route that knew
was sitting there unused.

This is the other half of a complaint from earlier in this session — "it's
broken, only showing XAUUSD, no other assets". That turned out to be a
`<datalist>` filtering by box contents, fixed by using the real picker. The
underlying LIST was also short, and this is that half.

**PROVEN LIVE.** Typing `CHFPLN`, which exists at the broker and nowhere in the
instrument table:

    CHFPLN   your broker quotes this · chart only, no sizing
    1 match

**A BROKER SYMBOL IS NOT AUTOMATICALLY A SIZEABLE ONE**, and the note says so
rather than the picker pretending otherwise. Contract size, pip value and the
`contextOnly` flag all live in `INSTRUMENTS`, and everything that sizes a
position walks that table — silently promoting a symbol it does not describe is
how a position gets sized at a defaulted contract size, which is the units
defect this codebase records three times.

`canonicalBrokerSymbol` strips the broker's suffix from an EXPLICIT SET, never a
pattern: a rule that eats any short trailing `.X` turns the real ticker `BRK.B`
into `BRK`, a wrong answer that looks right and charts a different company. Its
own test pins that, mirroring the server's `canonical_symbol`.

**ONE OWNER, ONE REQUEST.** `symbolOptions` has five callers across five desks.
Fetching in each would ask the bridge five times and give the five desks five
different answers while the requests were in flight, so the list is a
module-level signal fetched once — and reading it inside `symbolOptions` is what
makes every picker re-render when the answer lands. **An empty answer is a
no-op:** a bridge that is not running must leave the picker exactly as it was,
because this is the one place where conflating "could not ask" with "there are
none" would REMOVE something from the screen.

Nine tests, all failing first.

### MEASUREMENT NOTE

Four attempts to verify this in the browser measured the wrong element — a
hidden `.sym-menu` (there are two), then a list belonging to another field.
A screenshot settled it in one look. When a DOM probe returns zero on something
you can see working, screenshot before theorising.

    routes called 71 -> 72    uncalled 25 -> 24    real backlog 10 -> 9

**Gate: 7 stages, 105s, all pass.**

## v62.18 — THE BACKTESTER CHARGES 3-5x WHAT THIS BROKER DOES

`/svc/costs` carried the broker's own contract spec and had no caller anywhere
in the frontend. Wiring it turned up the most consequential number of the
session.

    XAUUSD    18 points x 0.01  = 0.18      0.42 bp   assumed 2.00 bp   4.7x
    EURUSD     6 points x 1e-05 = 0.00006   0.53 bp   assumed 2.00 bp   3.8x
    BTCUSD   600 points x 0.01  = 6.00      0.71 bp   assumed 2.00 bp   2.8x

`DEFAULT_COSTS` charges a flat 2bp of spread on every instrument. CLAUDE.md
already states why that matters — a cost model is a HURDLE, so an assumed cost
is an assumed conclusion, and those numbers decide which rules survive a search.
**This is not harmless conservatism.** Charging three to five times the real
spread raises the bar every candidate has to clear, so rules that would have
made money on this broker are discarded as noise, and nothing on screen said so.

The headline reads "2.8-4.7x the real spread" on the Calculator desk, whose own
subtitle already promised cost-adjusted P&L — the question is "am I charged what
I think I am", which is a calculator question rather than a system one.

**IT REPORTS, IT DOES NOT OVERWRITE.** A figure that moved under the operator
because a background service answered would be worse than a disagreement they
can see — the same stance the risk sizer's broker cross-check takes.

**AND IT REFUSES PER ROW.** A spread in POINTS cannot be compared with a
fraction of PRICE without the price, so `spreadFraction` returns null rather
than defaulting, a symbol with no live quote says so in its own row, and the
headline is computed only over rows whose units are known. That is the rule the
risk desk learned at a cost of 100,000x. Seven tests, all failing first.

The direction is asymmetric and the colour follows it: charging MORE than the
broker only discards edges (attention), charging LESS manufactures them
(negative). A test pins each.

`tsc` caught me redeclaring `costPanel` — the Calculator already had one, which
prices the trade in the form. Mine is `brokerCostPanel` and the comment says why.

### AND THE ROUTE BACKLOG IS NOW AN ITEMISED LEDGER

The bullet had grown by accretion across six releases: every wiring appended a
clause, and the result stated a number and then argued with itself about what
the number meant. A reader could not tell which routes were work and which were
categorically not.

It is now a table with a reason per route:

    not a fetch target (served HTML, introspection)     4
    deliberately dead, already recorded                 4
    the store is empty — wire the WRITER first          4
    destructive or administrative, not one click away   3
    REAL CAPABILITY WITH NO SCREEN                     10
                                                       --
                                                       25

**So the real backlog is ten routes, not twenty-five**, and `/mt5/symbols` — 272
broker symbols against a picker that offers far fewer — is the one with a user
complaint attached to it.

**Gate: 7 stages, 106s, all pass.** Routes called 70 -> 71.

## v62.17 — THE LAST TWO "NO SCREEN YET" ROWS NOW HAVE SCREENS

The survey's remaining UI gap was two menu rows reading "no screen yet",
correctly greyed out. Both are built.

### NEW TOKEN PAIRS

The scanner behind it had never written a row in its life until v62.14 — it
deadlocked its own thread and rolled back its dedup insert, 2,069 times. It now
holds **40 tokens and climbing**, and `/svc/onchain/pairs` had never existed, so
the data had nowhere to go even after it started arriving.

The dedup key is the only record of what was seen, and it is one opaque string:
`np:solana:ADDRESS`. `parse_pair_key` is pure and REJECTS rather than repairs,
because a split that guesses would put the chain in the address column and
nothing would look wrong — an address is opaque to the reader too. `split(":", 2)`
and not `split(":")`, so `np:cosmos:ibc:27394FB` keeps its tail. Eleven tests.

**What the card refuses to do.** No price, no change, no volume: the service
stores none, and a column the data cannot fill is a column that invites a guess.
Newest first is the only order the data supports. The warning — "Just listed,
not vetted. Most new tokens go to zero" — is ON the card, not behind "Why?",
because what happens to most of that population is the single most important
fact about it. The full address is always in `title`, since a truncated one
copied off a screen is a transaction sent nowhere, and the explorer link is
NULL for any chain nobody mapped rather than built from a pattern: a link to a
404 reads as "no such token", which is information, and wrong.

### SMART-MONEY WALLETS

There was a POST to store the scored wallets and no GET to read them back, so
the list the alert loop watches could not be seen anywhere. A store with a
writer and no reader is the same shape as a loop with no writer for its input.
`/svc/onchain/dbwallets` added; the card sits directly after Whale watch because
it IS that card's input.

### WHAT THE MEASUREMENTS CHANGED

**1,502px.** The pairs card with all 37 rows, in a dock whose next largest panel
is 456 — it pushed everything else off the screen. Capped at twelve, measured
again at 575, and the state line carries the fact that matters: "40 tokens
recorded, 12 newest shown." Both `approxHeight` values are now MEASURED (575 and
124), not estimated, because an estimate is a measurement that has stopped being
checked.

**`--focus` does not exist.** `tokens.test.ts` caught a custom property I
invented, for the second time this session (`--fw-reg` was the first). The other
cards use `--ring`.

### A GUARD THAT FAILED FOR THE WRONG REASON

`dockpanels.test.ts` asserted twenty ABSOLUTE positions, so adding two panels to
Risk moved `evidence` from 18 to 20 and broke a test named "puts each section
heading directly before its first panel" — for a reason with nothing to do with
section headings. That trains the next person to renumber it rather than read
it. Rewritten as the invariant: a heading is immediately followed by a panel of
its OWN section, and a section with panels has a heading. It now survives every
addition and still catches a panel filed under the wrong heading, which is the
defect it exists for.

### THE `pending` BRANCH STAYS

`toolsmenu.ts` keeps its `{ label, pending }` variant with zero instances. It is
the honest mechanism for the NEXT capability that ships before its screen, and
deleting it would make that one reinvent it.

### MEASURED AFTER

    routes called by the frontend   67 -> 70      never called   27 -> 26
    GET routes declared             45 -> 47      all 46 probed answer, 0 failing
    menu rows with no screen         2 -> 0

**Gate: 7 stages, 105s, all pass — 27 scripts.** Verified live on :8787.

### NOTED, NOT ACTED ON

`onchain_watch` holds two fixture wallets (`0xdna1111…`, `0xnodna1111…`) in the
operator's live database. Both `test_service_v200.py` and `test_service_v210.py`
DO set `MISHEL_SVC_DB` to a temp file, so this is residue from before those
lines existed rather than an active leak. Deleting rows from the operator's data
is their call, not mine.

## v62.16 — THE FAILING FEEDS, FIXED BY CALLING THEM

The survey named eleven failing jobs. Nine had stopped failing months ago; two
were failing every run. Both are fixed, and the fixing turned up a defect in the
card that reported them.

### `data_mvrv`: TWO COMPOUNDING FAULTS, 225 RUNS

Calling the exact URL the service sends:

    400  "Unsupported parameter 'order'"

Not the metrics — the API stopped accepting `order`. Removing it revealed the
second fault underneath:

    403  "Requested metric 'CapRealUSD' ... is not available"

So the market-cap-over-realised-cap division could not be done at all on the
community tier. `CapMVRVCur` IS that ratio and is still served, so the same
number now comes back as ONE metric instead of two — one metric being one thing
that can be revoked. **Verified live: `coinmetrics.btc_mvrv = 1.577304652515512`
stored twice since the restart, matching the 1.5773 the API returns for
2026-09-24, after 225 consecutive failures.**

### `data_forexfactory_cal`: A DEAD DUPLICATE, 225 RUNS

`https://www.forexfactory.com/rss.php` is genuinely 404. But it was a SECOND
path to a fact that already has an owner: the calendar block twelve lines below
reads ForexFactory's own JSON at `nfs.faireconomy.media` and stores the whole
event — 82 of them on the live probe. One fact, one owner. A duplicate source
that 404s is not a backup, it is a job that fails forever and tells nobody.
Removed; its 225 historical rows keep a name ("Economic calendar (retired)")
because a reader looking at them deserves one.

**The other nine were not live faults.** `data_cg`, `data_difficulty` and
`data_hashrate` last failed on 08-31/09-02 and all answer now; `data_cot` 503'd
once on 09-19 and answers now; `data_calendar` hit a 429 on 09-24 and answers
now; `data_cointelegraph` and `data_investing` carry "database is locked" from
before the v62.14 nesting fix. Proven by calling every one of them.

### A LOG ENTRY IS NOT A RUN — a defect in the card from v62.14

The card printed "224 of 224 failed" and, for a healthy job, "223 runs". Both
read as a count of ATTEMPTS and neither is: `mishel_data.py` calls `log(...)`
inside an `except` for most feeds and never on success, so for those kinds every
row IS a failure and the denominator is the failure count printed twice. "41 of
41 failed" says it ran 41 times and failed every one, when it may have run five
hundred times and logged 41 failures. **The number was right and the sentence
was wrong, which is worse than being visibly wrong.** `entryCount` now says
"224 failures logged", "2 of 1,469 entries failed", "223 entries" — and the
verdict line says so explicitly. Five tests.

### WAL, ON THE MEASUREMENT AND NOT ON THE STORY

    4 writers / 6 readers, 3s   as shipped     256 writes,  255 reads
                                WAL         12,269 writes, 12,437 reads
    1 bulk writer + 6 loops     as shipped   slowest loop wait 4.24s
                                WAL         slowest loop wait 2.49s

4.24s against a 5s default is not a margin. `PRAGMA journal_mode=WAL`,
`synchronous=NORMAL`, `busy_timeout=30000`, wrapped so a filesystem that cannot
do WAL still starts. Verified on the live database: `journal_mode` reads `wal`.
`tests/test_db_wal.py` asserts the PRAGMAs are APPLIED, not merely written.

**I first justified this with a lock that "survived the v62.14 fix". It did
not** — I read `data_investing` at "06:12" as today when the log says
2026-09-04. The year-less-timestamp trap this project already records about
chart axis labels, committed while reading its own event log. The source comment
and the test docstring both carry the correction; the measured margin is the
whole argument.

### AND THE GATE DIED PRINTING THE FAILURE — AGAIN

`verify.py` crashed with `UnicodeEncodeError: 'charmap' codec` on the line that
names WHICH script test failed, so a real failure was replaced by a traceback
about a box-drawing character. Third time in this codebase's history
(`tests/run_tests.sh` records eighty test files silenced behind an `&&`, and
this file records fixing it once already). **Fixed at the STREAM, not at the
print** — the last fix was at a print and a different print brought it back.

The failure it was hiding was real and mine: `test_data_v393.py` pinned the old
two-metric MVRV fixture. Updated to follow the wire; the FACT it protects (a
ratio reaches the store, and it is the vendor's number) is unchanged.

### TWO MORE OF MY FINDINGS WERE FALSE

"New token pairs" and "Smart-money wallets" looked like dead controls — clicking
changed nothing. They are correctly `disabled`: opacity 0.45, `cursor:
not-allowed`, against the working sibling's opacity 1 and pointer. A real user
sees them greyed out and cannot click them; my programmatic `.click()` on a
disabled button did nothing, which is right. That is the third measurement
artefact this session, after Settings-as-an-overlay and the heartbeat's
deliberate 30s first sleep.

**Gate: 7 stages, 105s, all pass — 26 scripts.**

## v62.15 — THE WHOLE SURFACE, SURVEYED RATHER THAN SAMPLED

The previous entries fixed faults I happened to find. This one asks the question
properly: does every route answer, does every desk render, does every loop run.
`scratchpad/survey.py` is the re-runnable half.

### EVERY DECLARED GET ROUTE, CALLED

    PARSED : 59 python files, 45 GET routes declared
    PROBED : 44 (1 skipped — a path parameter with no sample value)

    answering with content      34
    empty but not refusing      10
    refusing (200 + ok:false)    0
    failing (>=400)              0

The one failure in the first run was MINE: `/svc/bars` takes `sym`/`tf`/`n` and
I probed it with `symbol`/`timeframe`/`limit`, so a working route reported 400.
The ten empties are checked individually and are correct — no alerts created, no
signals armed, no forward-test ledger, no download running, and the four
`/svc/data/*` that CLAUDE.md records as deliberately dead.

### EVERY DESK AND PANEL, OPENED

33 entries across five groups, each opened through the menu the operator uses.
**Zero page errors and zero swallowed effect errors across the whole sweep.**
Every desk rendered content: Strategy 22 panels, Calculator 10, Simulation 9,
Data 9, Briefing 9, Playbook 6,632 chars, Smart money 61,005. Six dock cards
render with real heights (Can I trade now? 188px, Whale watch 456px, AI read
266px, Key levels 258px, Price alerts 169px, Calendar 46px). Settings opens as a
760px overlay.

**TWO OF MY OWN FINDINGS WERE FALSE AND ARE RECORDED AS SUCH.** "System" and
"Settings" measured byte-identical (6,048 chars, 4 panels) and I called it a
routing bug; Settings is an OVERLAY, so the view-slot correctly still held the
previous desk. And `heartbeat_loop` reported "never ticked" — it sleeps 30s
before its first tick on purpose, to let the other loops register, and I measured
at 20s. Both were my measurement, not the product. The sweep also produced four
identical readings for four different dock cards, which is the tell that a probe
is measuring the wrong element — the same shape as `deskshape.py` matching the
first `h("section")` and reporting "GRIDS: 0".

### EVERY BACKGROUND LOOP

13 of 13 started, 13 of 13 ticking, none reporting an error. What they have
actually PRODUCED, which is the question a tick age cannot answer:

    pair_scan_loop    newpair=27 and climbing   (pair_err frozen at 2069)
    data_loop         3 of its feeds failing    (400, 404, 429 — vendors moved)
    bars_loop         bars_topup_empty=4        (VIX 1d: no data from vendor)
    backup_loop       backup=16
    daily_brief_loop  daily_brief=7
    auto_loop         auto_runs=34 rows
    6 others          no events of their own, which is correct — they log on
                      event, and there have been none

### A COUNT THAT CANNOT BE WRONG IS NOT EVIDENCE

`trials` holds ZERO rows on a database whose event log goes back to 2026-07-16
and contains `edge_push: "400 of 400 written"` dated 2026-09-03. Nothing in
`server/` deletes from `trials`, so what removed them is not recoverable and is
NOT guessed at here. What is fixable is that the log could never have said
otherwise: `mishel_edge.upsert` returned `len(rows)` — the size of its own input
— and the route logged that as "written". Both halves of the sentence came from
one number, exactly like `expect(reason).toContain(QUANT_BASE)` where both sides
were the same broken expression.

It now returns `{written, added, offered}` read back FROM THE DATABASE, the route
names anything `sanitise` dropped, and `tests/test_edge_count.py` pins that a
push of rubbish reports zero rather than its own length. Writing that test found
a second thing: the wire key is `rGross` and the column is `r_gross`, so a
fixture built from the column list sanitises to nothing and the whole push
silently reports zero.

### WHAT THIS SURVEY DOES NOT CLAIM

Two menu entries say "no screen yet" — Smart-money wallets and New token pairs —
and they are honest, not broken. The New token pairs loop now has data for the
first time (27 events, 18 rows) and remains the clearest next candidate. 27 of
94 routes are still uncalled, seven of which are not fetch targets at all.

**Gate: 7 stages, 107s, all pass — 26 scripts.**

## v62.14 — A LOOP THAT HAD NEVER SUCCEEDED, AND THE LOG THAT SAID SO

`/svc/events` held 4,548 rows and had no screen. Probing it for something worth
wiring turned up a live fault instead.

### 2,069 FAILURES, 46% OF THE WHOLE LOG, AND `onchain_seen` EMPTY

    pair_err   2,069 rows   newest 05:36   "database is locked"
    onchain_seen                    0 rows

`pair_scan_loop` had failed on EVERY run it ever made. The rate confirmed the
mechanism before the code did: the loop sleeps 300s, which is 12 failures an
hour, and the log showed exactly 12 in the preceding 54 minutes.

### THE CAUSE WAS NOT CONTENTION, AND TWO MEASUREMENTS SAID SO

The obvious hypothesis — thirteen loops on one SQLite file, no WAL — was tested
and DISCARDED. Measured on identical workloads:

    4 writers / 6 readers, as shipped        0 lock errors  (256 writes)
    same, WAL + busy_timeout                 0 lock errors  (12,269 writes)
    one bulk transaction + 6 loops           0 lock errors  (slowest wait 4.24s)

Zero either way. (The 48x throughput gap is real and is a separate finding; it
is not this bug.) What reproduces it is NESTING, and only one kind:

    cfg() inside an open write transaction     '0' in 0.003s      <- a READ, fine
    log_event() inside the same                OperationalError
                                               after 5.56s: database is locked

`log_event()` opens its OWN connection and WRITES. Inside `with db() as c:` it
asks for the write lock the same thread is holding, which can never be granted.

### THE ROLLBACK WAS THE REAL DAMAGE

The raise escapes the `with`, so sqlite3 rolls the transaction back — including
the `INSERT INTO onchain_seen` that was the whole point of the block. So the
dedup table could never fill, the same tokens were rediscovered every five
minutes forever, and a failure that merely logged was in fact silently undoing
its own work. It also held the write lock for 5.5s every five minutes, which is
why `data_cointelegraph` and `data_investing` have "database is locked" in their
own histories: collateral damage.

FIXED by shape, not by patch — record inside the transaction, announce after it
closes — in all three loops that did it. PROVEN LIVE:

    before restart   05:21, 05:26, 05:31, 05:36   pair_err: database is locked
    after  restart   05:36:59                     newpair x3, onchain_seen 0 -> 3

`scratchpad/dbhold.py` audits every `with db()` block in `server/`: 7 findings
before, 0 after, 79 blocks parsed. Its first version matched `risk_cfg(k,v,t)`
inside a SQL string and accused a clean file — CLAUDE.md rule 2, earned again.

### AND THE LOG ITSELF NOW HAS A SCREEN

`/svc/events` is `LIMIT 50`, and on fifty rows two thousand failures look like
twelve ordinary lines — counting the tail would have under-reported it
FORTY-FOLD. So `/svc/events/summary` counts per kind in SQL over the whole
table, and `svc/core.py` `summarise_events` does the part that can be wrong.

**The first classifier said ONE job was failing. Eleven were.** Asking whether
the kind ends in `_err` missed `data_mvrv` — 224 rows, every one a 400, under a
name that looks like ordinary data collection. The server counts erroring
MESSAGES too. Measured after the fix:

    11 jobs are failing
    2,597 failed runs out of 4,557 recorded, since 2026-07-16

**Three states, not two.** FRED has skipped 224 times asking for `FRED_API_KEY`.
That is not broken, it is waiting for something only the operator can supply, so
it is listed apart — filing it under failures would bury the eleven that are
genuinely broken. The key is never requested in the UI: it is a credential and
belongs in the environment.

The card leads with the count at `--fs-7` in the serif, each job carrying its
RATIO (`224 of 224` and `2 of 1,469` are the same word and different situations)
and the vendor's own last words verbatim — a 404 names a feed that moved, a 429
names a limit you can wait out, and neither survives being turned into "failed".

**A JOB IS THE UNIT, NOT AN EVENT KIND.** The first label map was flat, so
`newpair`/`pair_err` sharing a name (correct — one scanner) was indistinguishable
from `data_calendar`/`data_forexfactory_cal` sharing one (wrong — two jobs, a
404 and a 429, printed as two identical rows). Declaring the JOB and listing its
kinds makes the label unique by construction; `activity.test.ts` pins that no two
jobs answer to one name and no kind is filed under two jobs.

**Gate: 7 stages, 106s, all pass.** New: `tests/test_db_nested.py` (5, one a
tree-wide guard), `tests/test_events_summary.py`, `app/test/activity.test.ts`
(4). `tests/ fully listed` caught the unregistered file, and `tokens.test.ts`
caught `--fw-reg`, a custom property I invented that does not exist. Verified
live on :8787 after `npm run build`, zero swallowed effect errors.

## v62.13 — THE DURABLE TRACK RECORD, AND A THROW THAT ATE THREE TABLES

`/svc/claims/stats` had graded **2,063 recorded claims and 421 decided** across
five markets and eight bar sizes, with a confidence interval on every rate, a
calibration curve and a gate comparison — and no screen anywhere in the product.
The Learn desk's own scorecard grades what THIS BROWSER holds; this is the copy
that survives clearing it. Both are now shown and each is named, which is the
distinction the System desk already draws about bars.

### THE HEADLINE IS THE UNCOMFORTABLE NUMBER

    Checks: -6.5 points.
    The cleared and refused trades are not distinguishable on this much data.
    That is not evidence the gates work.

    Cleared the gates   127   47.2%   38.8%-55.9%   -0.055R
    Stood down          294   53.7%   48.0%-59.4%   +0.078R

On this sample the machine's own checks were performing WORSE than not using
them. That is exactly the figure a track record exists to surface, so it leads
rather than hiding in a fold.

### A LIFT IS A DIFFERENCE OF TWO RATES, AND BOTH BELONG ON SCREEN

`gates.taken` and `gates.stoodDown` are full POPULATIONS on the wire — decided,
hits, rate, interval, expectancy, pending, unknowable — and the hand-written
type declared both of them `number`. Nothing crashed, because the card only
read `liftPoints`; the cost was that the two most useful facts on it were
invisible. Both populations now render through the same row renderer as every
other breakdown, so `-6.5` is checkable against its own inputs, and the 261
claims still waiting plus 11 that can never be settled are named beneath them
rather than silently excluded from a total.

### ONE UNGRADEABLE ROW TOOK THE WHOLE TABLE, SILENTLY

The three breakdown tables rendered their header row and nothing else. Measured
in the live page:

    data-on              "true"        <- the same closure saw the rows
    .trk-rows children   [trk-head]    <- and not one was inserted
    server bySymbol      5

`data-on` is a renderEffect over `rows()`, and it went true. The list renderer
over the SAME `rows()` produced nothing. Both read the same function, so the
dependency graph was not the answer — and reasoning further was not going to
find it.

**`window.__signalErrors` named it in one call.** `signal.ts` keeps swallowed
effect stacks there and says in its own comment that this is what they are for:

    TypeError: Cannot read properties of null (reading 'toFixed')
      at Array.forEach ... at Object.run

`each` builds its fragment first and appends ONCE. A render that throws part-way
leaves the parent untouched, so the cost of one bad row is every good row beside
it. MEASURED on the wire: one market (ONDOUSDT) and three bar sizes (4h, 1d, 1w)
came back with `hitRate`, `low`, `high` and `expectancyR` all **null** —
populations with claims recorded and none yet decided. Five markets rendered as
none because of one of them, and eight bar sizes as none because of three.

Nothing was red. `tsc` cannot see it: the type said `number` and the wire said
null, which is CLAUDE.md's "never retype a dependency's shape" committed against
a service that has no schema to import — the API-contract backlog item, arriving
exactly where it was predicted to.

### A NULL RATE IS NOT A ZERO

`0.0%` says every claim lost. `null` says none has been answered yet. The row
keeps its place at `--text-faint` with em dashes and a reason on hover, rather
than vanishing — a market that disappears on its first recorded claim and
returns when one settles is a list that changes shape for a reason nobody can
see. AFTER:

    BTCUSDT    284   47.5%   41.8%-53.3%   -0.043R
    XAUUSD     123   61.0%   52.1%-69.1%   +0.202R
    ETHUSDT     13   53.8%   29.1%-76.8%   +0.077R
    FILUSDT      1  100.0%   20.7%-100.0%  +1.000R
    ONDOUSDT     0      -         -            -     [graded=false]

`gradedRow` is a PURE exported function for the same reason `eviction_order` and
`deflatedSharpe` are: it is the part that can be wrong, and everything around it
is DOM.

### TESTS

`app/test/trackrecord.test.ts`, 5 tests, all failing before the fix. Four pin
the refusal; the fifth pins the AMPLIFICATION — that `each` loses the whole list
when one renderer throws — so the next person tempted to let a renderer throw
"just for the odd case" reads what it costs. Its assertions pin the FACTS in the
sentence (which population, that nothing is decided, that it is a matter of time
not failure), not its wording.

**Gate: 7 stages, 94s, all pass — 188 files, 4,323 tests.** Verified live on
:8787 after `npm run build`, with zero page errors and zero swallowed effect
errors on reload. Ruff's drift notice moved (`BLE001 101 -> 105`, `SIM115 9 ->
11`) from this session's new server modules; the gate gates on the rule NAME and
no sixth code appeared.

## v62.12 — THE RISK ENGINE AND THE NOTIFICATIONS, WIRED

Both had been built, working and reachable for releases with zero callers. The
wiring turned up three faults that had made the risk engine unusable in
principle, and one I committed myself in the act of fixing them.

### `/svc/risk/size` HAD NEVER BEEN ABLE TO ANSWER

It refused every request with "run the MT5 bridge (or /svc/mt5/sync)". Running
the sync did not help, for two compounding reasons:

**Specs came only from TRADED symbols.** `/svc/mt5/sync` reads deals, collects
their symbols, and asks the bridge for a spec for each. A fresh account has no
deals — and an operator who has not traded a market yet is exactly the one who
needs sizing for it. It now also covers the ENROLLED series.

**The broker suffixes its symbols.** JustMarkets quotes `XAUUSD.s`. The sync
stored the spec under the broker's name and `/svc/risk/size` looked it up under
the canonical one:

    specs stored      -> ['BTCUSD.S']
    lookup "BTCUSD"   -> MISS
    lookup "XAUUSD"   -> MISS

So even a successful sync left sizing unable to find anything, on every broker
that suffixes. Specs are now filed under BOTH names by `spec_keys`, because the
sync knows one spelling and the caller knows the other and neither should have
to know the other's. AFTER: six rows for three instruments, and gold reads
`contract_size: 100.0` — the exact figure CLAUDE.md says a guess of 100,000 got
wrong by a factor of a thousand.

The suffix rule is an EXPLICIT SET, not a shape. The first version matched any
short trailing `.X` and turned the real ticker `BRK.B` into `BRK` — a wrong
answer that looks right and would size a different company. Its own test caught
that.

### WHAT THE BROKER SAYS, BESIDE WHAT THE TABLE SAYS

The Risk desk's sizer multiplies against `risk/instruments.ts`, a table this
product maintains. The server sizes from the broker's own contract spec. They
should agree, and a button now asks. MEASURED live on XAUUSD, $505.99 equity, a
14-point stop:

    the broker: "the correct size (0.0036 lots) is BELOW your broker's minimum
     (0.01). Taking the minimum would risk 14.00 — more than your 1.0% rule
     allows. Widen the account, tighten the stop, or skip the trade."

That is worth having: on this account gold cannot be traded within a 1% rule at
that stop, and the desk had been showing a size the broker will not accept.

### THE UNITS BUG I COMMITTED WHILE WIRING THE ROUTE THAT EXISTS TO PREVENT IT

My first cross-check compared the desk's `qty` against the broker's `lots` and
reported a 33x disagreement. There was none. The desk sizes in the INSTRUMENT'S
OWN UNITS — ounces for gold, with the operator's notional cap applied — and the
broker sizes in LOTS, where one gold lot is 100 ounces and no cap applies:

    the desk    0.118499 units   risking $1.66   (its notional cap bit)
    the broker  0.0036 lots      risking $5.04   (the 1% that was asked for)

0.0036 lots IS 0.36 ounces, which is the desk's own UNCAPPED answer. The two
agreed on the arithmetic and differed on a cap, and the number comparison hid
both facts. Caught by checking a figure that looked wrong before believing it.
The comparison is now on MONEY AT RISK — the one quantity both express the same
way — and each side's figure is printed with its own unit named.

### NOTIFICATIONS: THE ONLY PATH ANY BACKGROUND JOB HAS TO YOUR ATTENTION

The alert loop, the signal loop and the dead-man's-switch heartbeat all send
through `/svc/notify`. Until now every one of them fired into nothing. The card
sits on the System desk, beside the twelve jobs — a status page that lists the
jobs and not the channel they speak through omits whether any of them can be
heard.

The token goes to the operator's own server and is never held in the browser,
which is the route's own design: a token in browser storage is a token in every
backup of that profile, and this product backs the profile up. Password input,
cleared on success. And it says what a green tick does NOT mean — a token
revoked next week will fail inside a loop at three in the morning, so a passing
test means it worked when you pressed it and nothing more.

VERIFIED with nothing configured: "The server has no credentials stored, or
Telegram refused them." — the honest state rather than a silent nothing.

### A DUPLICATE CARD, DELETED BEFORE IT SHIPPED

I wrote a governor card for the Risk desk and `scratchpad/classcollide.py`
refused the prefix: `.gov-` is already claimed by `card-gov.css`, which imports
LAST and would have won. `ui/cards/govcard.ts` has existed all along, is mounted
in the inspector dock as "Can I trade now?", and already calls `/svc/risk/state`
— which is why that route was NOT in the orphan list and `check`/`size` were.
Deleted. Two cards for one subject is the defect this file measures at 0 of 24
agreeing, and the audit caught it before it was two.

### The gate

    PASS  tsc --noEmit                17.9s
    PASS  vitest                      55.1s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      39.5s
    PASS  24 scripts                  18.0s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.0s
    VERIFY PASSED - 7 stages, 132s total

`tests/ fully listed` caught `test_risk_specs.py` before I registered it, which
is the mechanism that exists because nineteen Python files were once invisible.

---

## v62.11 — AUDITED EVERY TOOL AND SERVICE. SIX WERE DEAD.

"all tools features not working check and fix all the tools and services". So it
was audited rather than guessed, with two new scripts that print what they
parsed, and six real defects came out — every one of them silent, and three of
them had never worked at all.

### WHAT WAS ACTUALLY BROKEN

**1. `bars_loop` had never stored a single bar, for any series, ever.**

`yf_bars` returns a TUPLE — `(rows, None)` or `(None, reason)`. The loop did
`rows = yf_bars(...)`, so `rows` was the whole tuple. `if not rows` is never
true for a two-element tuple, and `_clean` iterates its argument catching
`(KeyError, TypeError, ValueError)` PER ROW by design — so it got a list and a
None, skipped both, and returned `[]`. MEASURED:

    _clean((rows, None))       -> 0 bars stored
    _clean(rows)               -> 5 bars stored
    _clean((None, "no data"))  -> 0 bars stored

No exception, no `log_event`, a fresh `last_tick_age_s` and a green dot. The
success path and the failure path were byte-for-byte indistinguishable from
outside. Fixed: 77,259 -> 81,472 bars in the first pass after.

**2. Ten of twenty-two enrolled series were skipped outright.** The loop read
`if src != "yfinance": continue`, on the premise that yfinance was the only
source reachable without a browser. Binance's public klines need no key either,
so that premise had stopped being true. Those ten are BTCUSDT, ETHUSDT, SOLUSDT,
BNBUSDT and XRPUSDT — exactly what the autonomous loop studies. `binance_bars`
added; `TOPUP_FETCHERS` is now a module constant so a test can assert every
enrolled source has one.

**3. The proxy could not fetch a single series it had stored.**
`binance_symbol` was a SEVEN-ENTRY hardcoded map from a canonical `XXXUSD` to
`XXXUSDT`, and it returned None for Binance's own native tickers. MEASURED
against the running gateway with the archive's own holdings as the input:

    BTCUSDT  -> "binance: crypto only (BTCUSD, ETHUSD, ...)"
    ETHUSDT, SOLUSDT, FILUSDT, ONDOUSDT -> all refused
    BTCUSD   -> 200, real bars

The alias worked and the real ticker did not. It now accepts anything ending in
a quote asset Binance lists, still maps `XXXUSD`, and still refuses EURUSD and
XAUUSD — which matters, because Binance DOES list EURUSDT and passing it through
would return real bars for a different market.

**4. SPX and VIX could never be fetched.** `MACRO_SPINE` enrols both;
`YF_MAP` had neither, so an unmapped symbol fell through to itself and yfinance
has no ticker called "SPX". Four series (SPX and VIX at 1h and 1d) held ZERO
bars while the loop reported a fresh tick. The whole spine is mapped now.

**5. Eighteen of twenty-two enrolled series were permanently unstudiable.** A
300-bar top-up cannot carry a new series over the autonomous loop's 800-bar
floor, so a market could be enrolled, topped up hourly, reported healthy, and
never become studiable. The FIRST fill is now deep and every fill after it is a
top-up. AFTER: 22 of 22 above the floor, 95,269 bars held.

**6. The autonomous loop would have studied the same six markets forever.**
`subjects()` returned the richest first and took `MAX_SUBJECTS`. Once the
archive actually filled, 34 (market, bar size) pairs qualified and six were
reachable — so 28 markets the operator holds history for could never be studied
at all. Now ordered by LEAST RECENTLY STUDIED, so everything is covered in
`ceil(34/6)` passes and a newly downloaded market is next rather than last.

MEASURED after: the first pass picked **DXY, EURUSD and SPX** — three markets
that had never been reachable — and the desk now holds **14 studied markets,
up from 6**.

### WHAT WAS NOT BROKEN, MEASURED RATHER THAN ASSUMED

  * **25 of 25 desks boot cold with zero console errors.** Driven by setting the
    persisted view and reloading, which exercises the same path a cold boot
    takes — a desk that only works after you have visited another one is a desk
    that is broken on open. The two thin ones are honest idle states: Conditions
    offers "Run survey" over five markets, Opportunities is an empty scan.
  * **53 of 57 GET routes answer correctly.** The four "failures" were my own
    probe's false positives — `/` and `/legacy` serve HTML by design, and
    `/ohlc` 404s for a symbol the DEFAULT vendor does not know, which is an
    honest refusal with a clear sentence.
  * **Quant computes**, on 900 real archive bars: `/quant/volatility` and
    `/quant/stats/structure` (ADF, KPSS) and `/quant/ml/classify` all `ok: true`,
    and `/quant/forecast/seasonality` refuses by NAMING the missing library.
  * **MT5 is live** — balance 505.99 on JustMarkets-Demo2 — and 13 of 13
    background loops turn.

### The backlog figure was stale again, as it warns

    v58    36 of 48 routes never called
    v60.7  28 of 74
    v62.11 33 of 93   <- `scratchpad/routes.py`

Its first run walked `server/build/venv` and reported FastAPI's own docstring
examples — `/items/`, `/users/me`, `/send-notification/` — as uncalled routes of
this product: 7,789 files read and most of the findings somebody else's
documentation. The script excludes vendored code and prints what it parsed.

### The gate

    PASS  tsc --noEmit                 9.6s
    PASS  vitest                      37.6s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      25.8s
    PASS  23 scripts                  17.2s
    PASS  ruff (deferred set only)     0.1s
    PASS  mypy (gateway, launchers)    0.9s
    VERIFY PASSED - 7 stages, 91s total

Two new gated test files (`test_data_proxy_symbols.py`, `test_bars_topup.py`)
and two new tests in `test_auto.py` for the rotation. `scratchpad/routes.py` and
`scratchpad/probe.py` are kept so both audits can be re-run rather than
re-derived.

---

## v62.10 — THE FIRST RUN OF ANY MARKET WAS COMPUTED ON THE WRONG BARS

"WHY RESULT IS ALWAYS SHOWING 0 BACKTEST IS BROKEN." It was, and the mechanism
had been in place since the planner landed in v62.3.

### `backfill` RETURNS A COUNT, NOT A SERIES

    const hist = await opts.history.load(...);       // captured BEFORE
    if (hist.bars.length < p.wantBars * 0.9) {
      await opts.history.backfill(...);              // fetches into the archive
    }
    runBacktest(strategy, hist.bars, ...)            // ...and runs on the OLD set

`backfill` writes what it fetched into the archive and answers with how many it
added. The desk never read it back, so every run used whatever happened to be
cached when it started.

MEASURED on the running build — three consecutive runs, IDENTICAL inputs,
ETHUSDT 4h over 2022–2026 with 29% of the span held:

    run 1  ->  156 trades
    run 2  ->  480 trades
    run 3  ->  480 trades

The same question, two different answers, and the first one wrong. On the
owner's case — XAUUSD 5m, four days held against a four-year request, "about 0%
of the span" — the first run had too few bars to produce a single trade. That
is the 0.

**Nothing could have caught it.** A backtest that runs on fewer bars and reports
fewer trades is indistinguishable from a strategy that traded less: no refusal,
no error, no empty state. The verdict even said the honest thing —
"UNPROVEN — 0 trades is not a sample" — about a number that was an artefact of
the loader.

### `loadForPlan`, with the re-load as its whole point

Lifted into `backtest/runplan.ts` so it is testable and has one owner: load,
reach back ONCE if short, and READ IT BACK. One backfill rather than a loop —
a vendor with nothing older to give would otherwise be asked until a guard
stopped it, and a desk that hangs is worse than one that says how far it got.

AFTER, on ETHUSDT 1h over 2022–2026 with only 22% held, three runs:

    run 1  ->  1,916 trades
    run 2  ->  1,916 trades
    run 3  ->  1,916 trades

Right on the first, and stable.

### The result line claimed a window it had not run on

The other half, which would have survived the fix. The note printed
`planLine(plan())` — the REQUEST — beside a trade count computed on whatever
arrived: "1,598 bars" over a run that had 999. It now names what it actually
used, and `loadForPlan` supplies the sentence when a vendor could not reach as
far back as the plan asked:

    ETHUSDT 1h · 41,458 bars from binance · costs on (2bp spread)

41,458 against a plan of 41,459. The one-bar difference is real, and the point
is that it is now visible at all.

### The gate

    PASS  tsc --noEmit               100.0s
    PASS  vitest                     158.4s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                     114.8s
    PASS  21 scripts                  43.6s
    PASS  ruff (deferred set only)     0.3s
    PASS  mypy (gateway, launchers)    2.9s
    VERIFY PASSED - 7 stages, 420s total

Five new tests on `loadForPlan`, the first of which asserts the call ORDER —
`load`, `backfill`, `load` — because the defect was an absent third call and
nothing about the result's shape would have shown it.

---

## v62.9 — THE DATALIST WAS THE WRONG CONTROL, AND THE REPORT WAS RIGHT

"ITS BROKEN ONLY SHOWING XAUUSD NO OTHER ASSETS." Correct, and the cause is a
property of the element rather than of the wiring.

### A BROWSER FILTERS A `<datalist>` BY WHAT IS ALREADY IN THE BOX

These fields are PRE-FILLED — the Playbook opens on the chart's market. So
opening the list on a field reading "XAUUSD" offers exactly one row: XAUUSD.
MEASURED before changing anything: `optionsInDom: 131`, `bound: true`, the list
id matching the input's `list` attribute, and the first six options being
BTCUSDT, XAUUSD, ETHUSDT, EURUSD, GBPUSD, USDJPY. Everything was there and the
browser was hiding 130 of them. There is no attribute that turns it off.

So v62.8's control was wrong, one release after shipping. The fix is not a new
component: `ui/symbolpicker.ts` has existed since v50 and its header opens with
the same complaint in a trader's words — "I cannot change the currency pair".
It opens on the WHOLE list whatever the box says, narrows as you type, commits
only on Enter or a row click, and restores on Escape. The chart's own symbol box
uses it. Now so do all five desks.

VERIFIED live with "BTCUSDT" in the box:

    rows visible on open            131      (a datalist showed 1)
    typing "gbp"                      7      GBPUSD, GBPJPY, GBPCHF, GBPCAD…
    ArrowDown then Enter        GBPJPY       committed
    click a row                 ETHUSDT      committed, plan followed
    Escape after "NOTAREALPAIRXYZ"           restored, nothing committed

The first three rows carry what is held — `BTCUSDT 41,705 bars · 1h, 3m` — and
the other 128 carry what the instrument is. Held leads, because "what can I test
right now" is the question someone opening a backtest desk is asking.

### AND THE REFUSAL WAS PRINTED TWICE

Visible in the same screenshot: "the archive holds no XAUUSD 15m to run on",
then again underneath. `planLine` returns `why` verbatim for a refused plan, and
the desk rendered `planLine(plan())` above `plan().why`. Each binding was
correct on its own; together they said the same sentence twice, which reads as a
fault in the thing being described rather than in the thing describing it. The
caveat line now shows only when the plan RUNS — a refusal is one line, a clipped
run is a line plus its qualification. The fact is pinned in `runplan.test.ts`
rather than in the desk, because a second caller would make the same mistake for
the same reason.

### A REGRESSION THE SUITE CAUGHT

The picker commits on Enter or a row click and never on a keystroke — which is
right, and it broke the Briefing's "+ add" BUTTON, whose handler reads a draft
signal that nothing was updating any more. `today.test.ts` failed with
`expected [ 'ETHUSDT' ] to deeply equal [ 'ETHUSDT', 'SOLUSDT' ]`. A button is a
third commit path beside Enter and a click, so `symbolField` keeps an optional
`onInput` for callers that have one. The Watchlist's Add button had the same
shape and the same fix.

### The gate

    PASS  tsc --noEmit                17.9s
    PASS  vitest                      52.4s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      33.8s
    PASS  21 scripts                  18.3s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    2.0s
    VERIFY PASSED - 7 stages, 125s total

4,313 frontend tests. `rankOptions` is the new pure piece — six tests, the first
of which pins the defect: an empty query returns EVERYTHING, whatever is in the
box.

---

## v62.8 — FIVE SYMBOL BOXES THAT MADE YOU TYPE WHAT THE PROGRAM KNEW

The owner pointed at the Playbook's Market field: an `<input type="text">`
hinted "Any series the archive holds", with no way to see what those are — on a
desk that was already fetching the whole inventory to size one series and
throwing the rest away.

The question asked with it was the better one: WHERE ELSE. So it was audited
rather than guessed.

### `scratchpad/freetext.py`

    PARSED : 122 desk/ui modules
    PARSED : 80 `h("input")` elements
    FREE-TEXT FIELDS (32)

It prints all 32 and judges none of them, because it cannot know whether a
vocabulary exists — a note is open, a market is not, and a heuristic that
guessed would be the vacuous audit this file already records. Reading the list:
SIX ask for a symbol. The Data desk's download box is deliberately multi-value
and comma-separated and stays a plain field. The other five are the Playbook's
Market, the Risk desk's add-a-position, the Watchlist's add box, the Briefing's
focus list and the Analyse desk's instrument.

### A DATALIST, NOT A SELECT — and that is the whole design

The obvious fix is a dropdown and it is the wrong one. This file records, two
releases ago: THE ARCHIVE IS WHAT YOU HAVE, NOT WHAT YOU CAN GET. The Playbook
deliberately accepts a market it does not hold and reaches back for the history
— clipping the request to the archive was a defect, fixed on purpose, because
it meant you could never ask for history you did not already own. A `<select>`
would put that back permanently, as a control.

So: suggestions without a lock. VERIFIED live — typing `dogeusdt`, which is in
neither the archive nor the 129-instrument catalogue, was accepted, upper-cased
and answered with "the archive holds no DOGEUSDT 1h to run on".

What you HOLD leads, with what is held:

    BTCUSDT | 41,706 bars · 2 bar sizes (1h, 3m)
    XAUUSD  | 12,806 bars · 2 bar sizes (3m, 1m)
    ETHUSDT | 12,000 bars · 2 bar sizes (1h, 4h)
    EURUSD  | EUR/USD · forex
    GBPUSD  | GBP/USD · forex

One row per SYMBOL, not per series — a symbol held at three bar sizes from two
vendors is one thing you can type, and six suggestions for it is a list nobody
reads. Same distinction the Data desk had to be corrected on when its group
header counted rows and called them bar sizes.

### TWO THINGS THE WRAPPER BROKE, BOTH CAUGHT BEFORE SHIPPING

A `<datalist>` must live in the document to be bound by id, so `symbolField`
returns a span holding both. That span is a wrapper, and this file records
exactly what wrappers do:

  * **IT WOULD HAVE BECOME THE FLEX ITEM.** `.risk-add .field-input` is 130px
    and `.wl-add .field-input` is `flex: 1` — as flex ITEMS. Wrapped, the span
    takes the slot and the input's own width stops applying, so the field
    collapses inside a row that still looks correctly laid out. The
    `.sym-picker`/`.dd-input` trap from a third direction: there a wrapper
    could not constrain its child, here it would replace it. `display: contents`
    removes the span from layout entirely. MEASURED after: Playbook 160px in a
    column, Risk 130px on the same line as its direction select, Watchlist
    455px of a 510px row beside a 49px button.
  * **THE LABEL WOULD HAVE POINTED AT A SPAN.** `field()` in the Playbook sets
    the id on whatever it is handed, and a `<label for>` aimed at a span does
    nothing — it does not warn, it does not fail a type check, and the only
    symptom is that clicking the caption stops focusing the box. It now sets it
    on `querySelector("input") ?? el`. VERIFIED: `label[for="pb-f-1"]` reads
    "Market".

### Smaller

  * The hint changed from "Any series the archive holds" — true and useless
    without the list — to "What you hold is listed first; anything else is
    fetched", which describes the control.
  * A backtick inside a double-quoted bash string ran `symbolField` as a
    command and silently ate three words out of a CSS comment. Same family as
    the heredoc that turned `` into a backspace. Third time; the rule is
    still "write it to a FILE".

### The gate

    PASS  tsc --noEmit                10.8s
    PASS  vitest                      44.7s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      32.0s
    PASS  21 scripts                  19.8s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.0s
    VERIFY PASSED - 7 stages, 108s total

10 new tests in `symbolfield.test.ts`. `freetext.py` now reports 28 free-text
fields, and the four remaining that mention a symbol are multi-value or an
operand that also takes a number.

---

## v62.7 — THE SIMULATION DESK CHARGES FOR THE SEARCH

Three additions, and the first one changes what the desk says rather than how
it looks.

### 5 OF 6 "BEST" RULES DO NOT SURVIVE THE SEARCH

The desk carried the caveat in prose — "the best of twenty-five rules is the
best of a SEARCH" — and did not charge for it. It does now, and the answer is
not close. MEASURED across every market the loop studied:

    market   tf    best rule                  trades  per-trade  hurdle    left
    SOLUSDT  1h    Supertrend flip                22      0.277   0.434  -0.157
    ETHUSDT  4h    Break of structure             13      0.646   0.609  +0.037
    ETHUSDT  1h    Supertrend flip                24      0.140   0.410  -0.270
    BTCUSDT  1d    Break of structure             20      0.317   0.458  -0.141
    BTCUSDT  15m   Break of structure             19      0.266   0.466  -0.200
    BTCUSDT  1h    Donchian breakout              32      0.143   0.355  -0.212

One clears, by 0.037, on THIRTEEN trades. Everything else on this desk was
already true and this is the line that says what it is worth.

`study/stats.ts` `deflatedSharpe` did the arithmetic and the risk was entirely
in the UNITS: it is defined on a PER-TRADE Sharpe and takes a trade count, and
`metrics.sharpe` is annualised. This file records an annualised 4.93 over 77
trades deflated with a per-trade standard error and printed as though the
search had been paid for. So `computeMetrics` gained `perTradeSharpe` — a
separate field, named for what it is, so no caller has to convert between units
it cannot see. It is NaN when every trade returned the same R, because a finite
mean over a zero spread is an undefined ratio and not a very large one.

The count of tries includes rules that were REFUSED, because a field that
silently shrinks lowers the hurdle without telling anyone.

### THE WINNER AGAINST THE FIELD

Twenty-five equity curves on one set of axes, the winner drawn last in the
accent, the losers in the negative tone. VERIFIED on screen: the gold line sits
INSIDE a cluster of green with a mass of red beneath it — which is what "7 of 25
rules ended above the balance they started with" looks like, and what one line
out of twenty-five was hiding.

`ui/cards/plot.ts` owns the arithmetic because a wrong number in a table is
something a reader catches and a wrong SCALE is not. The property that matters
is a SHARED DOMAIN: scaled to its own range, a rule that made five dollars
draws the identical line to one that doubled, and the chart whose entire
purpose is "is the winner separated from the field" answers yes every time.
Seventeen tests, including a flat axis being padded rather than divided by, a
drawdown that can never be positive, and y flipped exactly once.

### UNDER WATER, AND THE SCATTER

  * How far below its last high the account sat, filled, with zero pinned to
    the top of the chart so a run that never fell 1% cannot be drawn to look
    like one that fell 60%.
  * Expectancy against trade count. The winner is a dot at the TOP LEFT — few
    trades, high expectancy — which is what a search produces, and a table
    sorted by expectancy puts at the top while saying nothing.
  * Every market's best rule on one centred axis, so a loss and a gain of the
    same size are the same length in opposite directions.

### THE FIGURES THAT WERE ALREADY MEASURED

Thrown away at the render until now: the longest losing streak (7 on the rule
the desk leads with), the longest spell under water (34 days, not "936 bars" —
`barSpan` converts through the series' own bar size), the account's peak and
trough, time in the market, the ulcer index, the model's sixteen inputs, and
its five FOLD BOUNDARIES with their dates. The last of those existed from the
router's first version precisely so a reader could check the forward-only claim
instead of believing a docstring, and it had never reached a screen.

### Two defects of my own, both found by measuring

  * **A GRID DOES NOT COMPLAIN ABOUT EXTRA CHILDREN — it wraps them.** Two
    columns were added to the rules table and the template was left at six, so
    both dropped onto a second line under every row and the header rendered as
    two headers. It looks like a design. MEASURED after the fix: header 24px,
    one line, eight cells. The table now scrolls rather than reflowing, because
    a number that has moved to another line is a number in the wrong column.
  * **INFINITY IS A BUG; NaN IS A REFUSAL.** An existing test asserted that no
    metric was non-finite, on a ONE-TRADE run — and one trade has no measurable
    spread, so `perTradeSharpe` is genuinely undefined there. The test was
    asking a real question and the answer was to sharpen it rather than weaken
    it: no field may be Infinity, and a field that cannot be computed says NaN,
    which every formatter here already renders as an em dash.

### The gate

    PASS  tsc --noEmit                11.0s
    PASS  vitest                      47.6s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      33.9s
    PASS  21 scripts                  19.8s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s
    VERIFY PASSED - 7 stages, 114s total

24 new tests: `plot` 17, `analytics` +7. Frontend and lab engine both rebuilt, a
fresh pass run through the live loop, everything above measured on :8787.

### Not built, and why

A per-trade log was offered and declined for now. Feature importance was
offered and argued against: on a model reporting "no skill" it is a ranking of
noise, and putting it on screen invites reading meaning into it.

---

## v62.6 — THE AUTONOMOUS LOOP, AND THE SIMULATION DESK

The terminal now studies by itself. MEASURED on the first boot after this
landed, with nothing asked of it:

    pass no 1 | studied 6 | rule runs 150 | refused 0
    background enabled: True | loops turning: 13 | auto_loop present: True

Six markets, twenty-five rules each, every setup recorded and a model fitted on
the result — unprompted, in about seventy seconds, and the desk was reading it
four minutes later.

### One engine, a second kind of job

`svc/auto.py` does NOT build the ledger. The engine does, because the Playbook
does: a Python copy would be a second implementation of "what would this setup
have done" — its own fill model, its own warm-up — and the first time the two
disagreed there would be no way to tell which a strategy's expectancy had been
measured with. So `backtest/headless.ts` gained two job kinds and
`lab_worker.mjs` dispatches on `mode`:

    study      (default)  unchanged, byte for byte
    ledger     one rule, every setup, and what it did to an account
    catalogue  the shipped library, so no caller keeps a second copy of it

VERIFIED by driving the worker directly before anything depended on it, which
caught the catalogue being useless for its own purpose: it returned
`{id, name, style}`, so a caller that listed the library had nothing it could
RUN — "spec.style must be a non-empty string" on the first attempt. It returns
whole specs now, and `specId` names a shipped rule so the loop sends an id
rather than a copy of the rule.

### The subject list has a writer

From the `bars` table: every `(sym, tf)` holding at least 800 bars, richest
source first and NAMED. This file records `bars_loop` reading its enrolment
from a config key that one module read and zero modules wrote — it ticked
hourly, showed a fresh last-tick age, and produced no work for a whole release.
A list nobody writes is a loop that does nothing and reports itself healthy. The
bars table has real writers, so "what do I hold enough of" is a question that
can only be answered truthfully — and it is also the honest reading of "popular
assets": the markets this operator keeps history for, not a hardcoded list of
somebody else's.

`/svc/auto/state` reports COUNTS, never a tick age, for the same reason.

### `backtest/account.ts` — the part every backtest gets wrong about small accounts

The engine's equity curve is a MULTIPLIER, and multipliers never reach zero:
risking 1% of a shrinking balance still leaves something after the two-hundredth
loss. Real accounts are closed out. So the account simulation reports RUIN as a
date, stops there, and COUNTS the trades it never lived to take — a curve that
carries on past the point the account died is the most flattering error
available, because every recovery after it is imaginary. The Simulation desk
marks such a rule "account died" whatever its expectancy says.

Downsampling keeps the extremes. The distance between the peak and the trough IS
the drawdown, so every-nth sampling would quietly flatten the one number that
decides whether anyone could sit through the run. `curvePoints` keeps each
bucket's highest and lowest; the test buries a spike and a crater mid-series and
requires both to survive.

### The desk

Money leads, because the question is about money. MEASURED live on BTCUSDT 1h:

    What it would have done to the account — BTCUSDT 1h
    $537.57      from $500 at 1% a trade — +7.5%
    Best rule    Donchian breakout      Worst fall  9.1%
    Trades       32                     Window      1,006 bars from binance

    Setups pooled 1,801 · scored out of sample 1,455 · base rate 24.6%

Two of the six markets learned something and four did not, and the desk says
which: SOLUSDT 1h and BTCUSDT 1h "learned", the rest "no skill". The reliability
curve is drawn from the OBSERVED rate, never the model's claim, and on the
market the desk opened on it reads like this — where it said 74.9% it was right
23.9%. That is the model being wrong in public, which is the whole point of
drawing it.

### THE PANEL NAMED ITS NUMBER AND NOT ITS SUBJECT

Found by opening it: the chart was on BTCUSDT **1h** and the desk opened on
BTCUSDT **1d** — matching on the symbol alone picked whichever bar size came
first. A different series, a different base rate, and a hero reading "$545.67"
with nothing on screen saying what it was measured over. Now the heading names
the market AND the bar size, the default honours both, and the facts carry the
bar count and the venue.

### One owner for the reliability curve

The Playbook drew it and the Simulation desk needed the same block. Two
hand-written copies of one thing is the defect this file measures at 0 of 24
agreeing, so `ui/cards/calibration.ts` owns the markup and the sentence, both
desks call it, and the `.pb-cal*` rules are gone with the elements they styled.
One class had been BORROWED by a neighbouring block and vanished with it —
renamed to `.pb-learn-sub`, which is the panel that actually owns it.

### Smaller things the work turned up

  * `h()` MAKES HTML ELEMENTS. An `<svg>` created in the HTML namespace has the
    right tag name and renders as nothing at all — no error anywhere. The
    equity curve uses `createElementNS`, as `icons.ts` and `watchrail.ts`
    already do, and an empty path is REMOVED rather than set to `""`.
  * `verify.py`'s ruff hint is still misleading and this file still says so —
    `--select` overrides the config, so four of the six findings it suggested
    reproducing were `RUF100` for rules the config does not enable. Four of my
    own `# noqa` directives were the finding.
  * A pytest that loads only `svc.auto` never reaches `mishel_service`, which is
    what calls `init()`. All fourteen tests failed with "no such table: bars" on
    their first run, which is the honest way for that to be found.

### The gate

    PASS  tsc --noEmit                14.3s
    PASS  vitest                      46.8s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      33.2s
    PASS  21 scripts                  18.7s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.5s
    VERIFY PASSED - 7 stages, 115s total

23 new tests: `account` 9, `tests/test_auto.py` 14. 4,272 frontend tests in 185
files. `npm run build` and `npm run build:lab` both run, the gateway restarted,
and everything above measured on :8787 — never the dev server.

### Still open

`svc.auto` is registered in `HIDDEN` and so is `enginepath`, but NO EXE HAS BEEN
BUILT and none should be until the owner says so. The loop runs 6 markets a
pass; `MAX_SUBJECTS` is the bound. Nothing yet feeds a learned router back into
the Autonomous card's live proposal — the model's verdict is reported and not
acted on, which is the right default and the next thing worth arguing about.

---

## v62.5 — THE MACHINE LEARNS THE OUTPUT, AND FOUR SILENT DEFECTS ON THE WAY

The sixth of the owner's six requirements: "then the machine should learn the
output." The Playbook now builds a candidate ledger from every run and asks the
server-side router what it makes of it. Getting there turned up four defects
that nothing in the stack could see, one of which had killed the Run button.

### The pipeline

    collectSignals   every bar the entry fired, open position or not
    buildFeatures    what was true there, in units a model can generalise
    buildLedger      what each setup would have done, priced like the engine
    trainRouter      POST /svc/router/train — fitted forward only, and SCORED

MEASURED end to end on BTCUSDT 1h at :8787: **24 setups found, 24 resolved,
base rate 37.5%, order measured 100%** — and the router reported honestly as
unreachable, naming the address, because the gateway the owner has running was
started before `svc/router.py` existed. The ROUTE itself was proved through the
same Flask app's test client rather than by restarting their process:
`/svc/router/health` 200, and a 40-row ledger refused with
"40 decided rows is below the 200 this will fit on".

**No price level, ever.** `backtest/features.ts` emits fifteen columns and every
one is a ratio or a bounded oscillator: distances are in ATR, not percent,
because percent is itself regime-dependent. A tree handed `close` learns the
YEAR — 2021 and 2024 are separable by price alone on BTCUSDT, both were strong,
and the model scores beautifully out of sample until it meets a price it has
never seen. It would also be untransferable: a router trained on BTC could say
nothing about XAUUSD, where 2,600 is below every threshold it holds.

`features.test.ts` proves causality rather than asserting it — it computes the
matrix over a 400-bar PREFIX and over the full 600 and requires the shared rows
to be IDENTICAL, not close. A column that peeked would differ, and nothing else
would notice: `tsc` cannot see it, the backtest cannot, and the router's own
forward-only folds would report the inflated score as a finding.

**Volume is omitted, not defaulted.** A feed reporting zero on most bars and a
tick count on a few produces a ratio that is mostly noise; the column is dropped
and `omitted` says which. Same class as the lots-versus-units defect.

### THE RUN BUTTON DID NOTHING, AND NOTHING SAID SO

`computed` in `core/signal.ts` is `effect(() => out.set(fn()))`, and an effect
runs IMMEDIATELY. So a computed written above a `const` its body names throws a
temporal-dead-zone ReferenceError at construction — and `effect` catches and
logs, so the computed then holds `undefined` for the life of the page.

`combined` and `effective` sat at lines 217 and 227 and read `all` and `current`
from 247 and 249. The console carried one line:

    [signal] effect threw {ReferenceError: Cannot access 'N' before initialization}

`combined()` was `undefined`; `effective` threw a SECOND time on
`"spec" in undefined`; and `run()` opens `const spec = effective(); if (!spec)
return;`. MEASURED with a MutationObserver over the whole desk: **zero
mutations** on click. No note, no error on screen, no disabled button — and the
two most recently added features of the desk were both dead while it looked
entirely normal. `tsc` cannot see it, because naming a later binding inside a
closure is legal and normally safe; it is only unsafe when the closure runs at
once.

Fixed by ORDER, not by defensiveness — catching `undefined` in `effective`
would have left the computed broken and hidden it better. `signal.test.ts` now
pins both halves (a computed runs once at construction; one that throws holds
`undefined` forever), and `scratchpad/tdz.py` sweeps the whole frontend:
**333 files, 205 eager reactive calls, clean.**

That audit took four passes to stop lying, which is its own lesson. It first
reported 26 findings and zero defects: same-indentation is not same-scope
(a callback parameter `r`); an object KEY is not a read (`studies:
state.studies()`); a name the body DECLARES is shadowed, not forward; and — the
house rule, broken by the tool written to enforce house rules — it counted
identifiers inside STRING LITERALS, so a placeholder reading "Describe the idea"
looked like a reference to `const idea`. Then the stripper blanked newlines
along with everything else and every reported line number was wrong by
hundreds, which is worse than reporting nothing because somebody goes and looks.

### NINE CUSTOM PROPERTIES THAT WERE READ AND NEVER DEFINED

An undefined custom property with no fallback makes the whole declaration
INVALID AT COMPUTED-VALUE TIME. That is not "ignored" — the property takes its
INHERITED value. MEASURED in the browser before the fix:

    --lh-relaxed   ""   38 reads; line-height inherited (40px probe vs 21.7)
    --buy          ""   .trust-dot[data-trust=single] background rgba(0,0,0,0)
    --text-dim     ""   .news-when colour rgb(232,228,218) — full --text
    --sell --border-strong --surface-2 --radius-1 --radius-2   all ""

So the news trust dot was TRANSPARENT, the timestamp beside a headline was as
bright as the headline, and thirty-eight prose blocks were typeset by whatever
their parent happened to say. Nothing could catch it: `tsc` does not read CSS,
no test opened a stylesheet, and an undefined custom property is legal CSS whose
result looks like a design decision. Same mechanism as the nineteen Python test
files in no list.

Eight names were repointed at the token that already meant them; `--lh-relaxed`
was DEFINED at 1.65, because "relaxed" is a real measure distinct from the 1.55
body default and thirty-eight blocks asked for it. `tokens.test.ts` is the
guard, and it reads the TypeScript too, because `quantdesk.ts` sets `--f` inline
per bar and an audit that called that broken would be one nobody reads. AFTER:
`--lh-relaxed` 1.65, the dot rgb(154,149,138), the timestamp muted.

### A CONTROL THAT SHOWED ONE BAR SIZE AND WOULD HAVE RUN ANOTHER

MEASURED live: the Playbook's bar-size select displayed **5m** while the plan
beneath it refused with "the archive holds no XAUUSD **3m** to run on". The
chart was on 3m, the desk took that as its default, and 3m is not one of the
five sizes the select offers — so the browser did what a `<select>` does with a
value outside its options, which is show the first one and say nothing. Neither
half was wrong on its own: the select was right about its options and the plan
was right about the value it was handed.

`nearestTimeframe(want, offered)` picks by DURATION on a log scale — 2h sits
between 1h and 4h, where a linear gap always favours the smaller size — and
validates the string itself rather than trusting `intervalMs`, which answers
3,600,000 for `""` and for `"banana"`. A silent default is what the function
exists to remove.

### "COULD NOT ASK" IS NOT "NOTHING STORED", AND NEITHER IS "HAVE NOT ASKED"

`readHolding()` was called from three change handlers and from nowhere at mount,
so the desk OPENED reading "the archive holds no BTCUSDT 1h to run on" against
an archive holding a thousand bars of it, and only told the truth once you
touched a control. Third instance of this family in CLAUDE.md. Now three states
— asking, error, answer — asked at mount and again through `onShown`, because a
desk is hidden rather than unmounted and a download made elsewhere would
otherwise stay invisible here until you retyped the symbol.

### A running sum is poisoned forever by one NaN

`sma` accumulated `sum += src[i]`, and every indicator in that file begins with
NaN, so the mean of an INDICATOR was NaN for the whole series — for any series,
silently. Found by asking for the mean of ATR(14) as a volatility baseline and
getting no feature rows at all. Nothing in the product hit it (`bollinger` is
the only internal caller and it averages CLOSE) but `script/sandbox.ts` hands
`sma` to user scripts, where averaging an indicator is the obvious thing to do.
Holes are now counted separately and the window answers NaN only while it
really holds one.

### Named what the sample lost

"Setups found 24" beside "Trades 34" is a contradiction until it is explained,
and the ledger is supposed to hold MORE rows than the trade log. It does — but
the feature matrix needs 220 bars before it can describe a setup where the rule
needs 25, so on a short window the collector starts later and sees less. Nothing
was wrong and no reader could have known. The panel now names the warm-up, the
setups it could not describe, the ones it could not resolve, and any column the
feed could not support.

### The gate

    PASS  tsc --noEmit                11.5s
    PASS  vitest                      45.9s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      30.6s
    PASS  21 scripts                  19.0s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.0s
    VERIFY PASSED - 7 stages, 108s total

33 new tests: `features` 10, `collect` 8, `routerclient` 7, `runplan` +4,
`signal` +2, `indicators` +1, `tokens` 1. `npm run build` run and :8787 serving
it, per the standing rule — the dev server was used once, to read an error
name, and nothing was verified on it.

### Still open

The autonomous loop, and the Simulation desk. And the owner's `python run.py`
needs restarting once to pick up `/svc/router/*`; until then the desk will keep
saying the router is not answering on that address, which is the truth.

---

## v62.4 — THE PLAYBOOK CAN COMBINE TWO RULE SETS

Surfacing, not writing: `backtest/hybrid.ts` has done this since v60 and only
the Strategy desk could reach it.

### "Only while this also holds"

`composePair(trigger, filter)` takes A's whole entry as the TRIGGER and only
B's STATE conditions as a FILTER — "the pullback rule, but only in an uptrend".
The asymmetry is argued in `hybrid.ts`'s own header and it is the reason the
feature works at all: two EVENT conditions ANDed ask for two crossings on the
same bar, which on 5,000 bars of BTCUSDT 1h is a handful of trades and not a
strategy.

VERIFIED live across eight partners — six composed, two refused:

    EMA 50/200 cross           adds 1 condition
    Triple-EMA ribbon          adds 2
    ADX trend-strength         adds 3
    Dual momentum              adds 2
    MACD signal cross          adds 1
    ROC impulse                adds 1
    RSI mean reversion         REFUSED — no standing condition to add
    Supertrend flip            REFUSED — no standing condition to add

**A refusal is a result here.** RSI mean reversion and Supertrend flip are pure
EVENT rules, so neither can act as a state filter, and the desk says exactly
that rather than producing an empty combination. "A+B gave nothing" with no
reason is the shape of a feature people stop trusting.

### The first draft broke the desk's own promise

The Playbook's subtitle says "every rule below is printed from the same data the
engine runs, so the description cannot drift from the behaviour" — and the
combine control broke it immediately: "Exactly how it trades" read `current()`,
so with a filter chosen it described rule A while the engine tested A+B.

It reads `effective()` now. The EDITOR still edits `current()`, because you
change the base rule and not the composition, but what is PRINTED has to be
what runs. MEASURED after:

    Enter long: EMA 9 crosses above EMA 21 AND Close is above EMA 9
                AND ADX(14) is above 25 AND EMA 9 is above EMA 21
                AND Close is above EMA 50

Trigger first, then the three conditions the filter contributed.

### GATE

    PASS  tsc --noEmit                10.5s
    PASS  vitest                      42.9s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      29.1s
    PASS  21 scripts                  17.6s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.0s

    VERIFY PASSED - 7 stages, 101s total

---

## v62.3 — THE PLAYBOOK GETS A BALANCE, AN ASSET AND A YEAR RANGE

"992 bars from mt5" and 73 trades. The count described the WINDOW, not the
strategy: the desk asked `history.load` for a constant 1,500 bars of whatever
the chart happened to be showing. `MAX_STUDY_BARS` has been 60,000 all along.

### Six controls the desk never had

    Market · Bar size · From · To · Balance · Risk %

The chart's symbol is now the DEFAULT rather than a lock — testing a rule set
is a different activity from watching a market, and tying them together is why
the desk could only ever test what was already on screen.

`backtest/runplan.ts` turns the six into an honest run: the bar count follows
the SPAN and the TIMEFRAME (five years of 1h is ~43,800 bars, of 1d ~1,826 —
one constant serves neither), risk becomes money (1% of $500 is $5), and the
result states the window it was measured over, because "73 trades" and "4,100
trades" are the same sentence about different questions.

The run BACKFILLS rather than settling for the cache. `load` returns what is
held, and a plan asking for four years of hours will not be met by whatever the
chart last fetched — which is exactly how 1,500 became 992.

### Running it found a design error in the planner, in one screen

The first version CLIPPED the window to the archive's oldest bar. Verified
live, and the mistake was immediate: a profile holding five weeks of BTCUSDT 1h
answered a request for **2000–2026** with

    BTCUSDT 1h, 2026-08-21 to 2026-09-24 — 810 bars, 0.1 years

Perfectly honest about the archive, and useless as a control. **The archive is
what you HAVE, not what you can GET** — `history.backfill` can reach back, so
clipping to it means you can never ask for history you do not already own,
which is the whole point of asking.

Corrected: only the FUTURE edge is a hard clip, because nobody can backfill
tomorrow. The past edge is a WARNING that names the date and the share held —
"the archive holds BTCUSDT 1h from 2022-01-23, about 12% of the span asked for.
The run will reach back for the rest." And a window ending entirely BEFORE the
oldest bar is a refusal rather than a fetch: 2010–2015 would reach for a year
the venue never listed while looking like it was trying.

Two tests had to change with it, because they encoded the wrong contract.

### Already built, and now worth surfacing

`backtest/hybrid.ts` — one rule's TRIGGER under another's STATE conditions,
"the pullback rule, but only in an uptrend" — has existed since v60 and is used
by the Strategy desk. The Playbook cannot reach it yet. That is the next piece,
not a new one to write.

### GATE

    PASS  tsc --noEmit                13.9s
    PASS  vitest                      60.5s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      41.0s
    PASS  21 scripts                  26.0s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s

    VERIFY PASSED - 7 stages, 143s total

---

## v62.2 — THE ROUTER, AND WHETHER IT KNOWS ANYTHING

`server/svc/router.py`, 11 pytests, wired at `/svc/router/train` and
`/svc/router/health`.

### sklearn, and why that was the right answer rather than a compromise

MEASURED in this checkout: **sklearn 1.9.1 present, lightgbm and xgboost
absent**. `HistGradientBoostingClassifier` is sklearn's own histogram gradient
booster — the same family — and scikit-learn is ALREADY a build dependency
(`build_binary.py` line 104), so the router costs the frozen build nothing.
lightgbm would have cost roughly 200 MB for the same algorithm.

### The two things the brief's `P(win) >= 62%` needs before it means anything

**1. The model must beat the base rate.** A classifier predicting the majority
class scores the base rate exactly and has learned nothing; "58% accurate" on a
sample that is 58% winners is a report of nothing. So `skill` is a SEPARATE
field from `accuracy`, false unless the model beats the majority out of sample
by more than its own noise (2 standard errors of an AUC at 0.5).

The test that matters is `test_REPORTS_NO_SKILL_ON_NOISE_RATHER_THAN_A_
FLATTERING_NUMBER`: on pure noise the answer must be "it knows nothing". A
router that cannot say that is one that routes on noise, and the failure is
silent — an AUC near 0.5 reported as "62% confident" loses money with
conviction. A second test pins the specific lie: 75% accuracy on a 75% base
rate is zero skill dressed as a majority.

**2. The score must be a probability.** A gradient booster emits a rank.
Isotonic calibration over the training prefix only, and the RELIABILITY CURVE
is reported — "it said 0.60, it won 0.59, n=140" — which is a threshold you can
choose. `suggestedThreshold` is read off that curve; where there is no skill it
falls back to a quantile and `thresholdBasis` says `none` rather than inventing
0.62.

### Forward-only folds, published so they can be checked

A random split on a time series puts June in train and May in test and inflates
every metric invisibly. Folds are contiguous and forward-only, and `foldSpans`
carries the boundaries so a caller can verify rather than trust — one test walks
them and asserts `trainTo <= testFrom` for every fold.

### Three things the gate caught that a build would not have

  - **`svc.router` missing from `HIDDEN`.** `test_build_hidden_imports.py` is
    the enforcement CLAUDE.md records, and it fired on the first run: a new
    `svc` module absent from `build_binary.py` is a module the frozen build
    cannot import.
  - **A test slower than the thing it measures.** 11 fits, 53s, in a gate whose
    whole pytest stage was 13s. Five tests interrogated the SAME model over the
    SAME rows; module-scoped fixtures took it to **28.5s** with no change to
    what is asserted.
  - **Two `# noqa: E402` directives for a rule this config does not enable.**
    RUF100, a code outside the deferred five, so the build failed. Worth
    recording because the failure message's own reproduction command is
    MISLEADING: `--select RUF100` overrides the config's rule list, which makes
    every `# noqa: BLE001` in the repository look unused too. Run ruff the way
    `verify.py` runs it — full defaults, `--output-format concise` — or chase
    four phantom findings in files nobody touched.

### GATE

    PASS  tsc --noEmit                13.7s
    PASS  vitest                      61.0s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      38.2s
    PASS  21 scripts                  22.4s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.3s

    VERIFY PASSED - 7 stages, 137s total

---

## v62.1 — THE CANDIDATE LEDGER: EVERY SETUP, NOT EVERY TRADE

The piece the router cannot be honest without, and it did not exist. 13 tests,
written failing first.

### The trade log is a SELECTED sample, and training on it learns the selection

The obvious training set for "will this setup win?" is the history of trades the
system took. It is the wrong one. A backtest SKIPS a signal while a position is
open, and skips whatever a filter rejected — so you never observe what the
skipped setups would have done. A model fitted to that learns the selection
rule rather than the market, and it will look excellent in backtest for exactly
that reason.

`buildLedger` records a candidate at EVERY bar the entry condition was true —
open position or not, filter or not — with the outcome it would have had. The
first test pins it: three signals one bar apart produce THREE candidates where
a backtest would produce one.

### Four things the label has to get right

  - **Resolved strictly AFTER the signal bar.** A decision on bar `i` enters at
    `i+1`'s open, per `engine.ts` rule 1. A resolver that reads bar `i` finds
    the target on the bar the decision was made — the most common backtest lie,
    one level down from the fill. Pinned by a test whose signal bar trades
    through the target and must still come back `timeout`.
  - **A TIMEOUT IS NOT A LOSS.** A setup reaching neither level inside the
    horizon is its own class. Folding it into "stop" teaches the model that
    "nothing happened" looks like "I was wrong" — and the second is the only
    one worth learning to avoid. `baseRate` excludes timeouts from its
    denominator for the same reason.
  - **The label carries its basis.** Measured from minutes, or assumed by the
    pessimistic rule. A router must be able to train on the resolved labels
    alone, and it cannot if the two are indistinguishable. `measuredShare`
    reports it for the run.
  - **It prices the way the engine prices.** Same `modelledFill`, same
    `fillable`, same costs. A ledger priced differently trains the router on a
    game the engine does not play, and the disagreement surfaces later as a
    live strategy quietly underperforming its own backtest.

`baseRate` is there because it is the first thing to check and the easiest to
forget: a classifier predicting "target" for everything scores exactly that, and
a model that cannot beat it has learned nothing.

### The coverage guard caught a fixture for the SECOND time

The minutes test first supplied two minute bars for a sixty-minute parent and
the label came back `assumed` — correctly. Two minutes cannot settle an hour,
and a resolver that accepted them would be reading the second touch as the
first. Twice now the guard has failed a test rather than a defect, which is the
right way round.

### GATE

    PASS  tsc --noEmit                14.8s
    PASS  vitest                      59.0s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      13.2s
    PASS  21 scripts                  14.8s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s

    VERIFY PASSED - 7 stages, 103s total

---

## v62.0 — THE SIMULATION ENGINE, PART 1: INTRABAR TRUTH AND REAL FRICTION

BTCUSDT first, server-side router, plus an autonomous loop. This is the
foundation both of those stand on. Two modules, 26 tests, every one written
failing first.

### The architecture question, settled by a file that already exists

`server/engine/lab-engine.mjs` is the SHIPPED TypeScript engine compiled for
Node, driven by `server/gateway/lab.py` with a warm worker pool. So the
autonomous loop runs THAT — not a Python reimplementation. `headless.ts` states
the reason in its own header: two backtest engines means the day they disagree
you find out from a strategy promoted on the server's numbers and traded on the
terminal's.

### `backtest/intrabar.ts` — which came first, the stop or the target

`engine.ts` rule 2 has always assumed the STOP when a bar holds both, and that
is right and PESSIMISTIC — it turns winners into losers, so it understates edge
rather than inventing it. It is also the largest remaining source of error, and
93.8 MB of BTCUSDT 1-minute bars are already on disk with `engine_ready: true`.

`settleBar` reads the order off the minutes. Three things it refuses to do:

  - **Claim a measurement from partial coverage.** If the first touch happened
    in a minute nobody has, walking the minutes that ARE present finds the
    SECOND touch and reports it with total confidence — a loser printed as a
    winner. Coverage is checked BEFORE anything is read.
  - **Pretend a minute is finer than it is.** A minute holding both levels is
    the original problem one level down. Fall back, and say so.
  - **Answer a malformed question.** A long whose stop sits above its target is
    a caller bug; resolving it would bury that inside a plausible result.

Every answer carries `basis: "measured" | "assumed"`, because a resolved exit
and a guessed one must not be indistinguishable downstream.

**The coverage guard caught its own test fixtures.** The first draft used a
ten-minute span with three minutes of data and four tests failed — correctly.
Three minutes cannot settle a ten-minute bar.

### `backtest/friction.ts` — what a trade costs, by how you trade

`DEFAULT_COSTS` charges a flat 2bp/4bp/1bp for a 45-minute scalp and a two-week
swing alike. Those numbers set the hurdle every rule must clear, so they decide
which rules survive.

MEASURED, and now pinned as tests rather than asserted in prose:

    binance-spot round trip           0.23% of notional
    as a share of a scalp's 0.5%      >33%
    as a share of a swing's 6%        <10%
    500 full-size scalps on $500      MORE THAN 100% OF THE ACCOUNT, in fees alone
    the same 500, risk-bounded        <30%

The document that prompted this estimated friction at "over 30% of returns".
On these inputs it is over 100% of CAPITAL when size is unbounded — which is
the sizing engine earning its place, not a footnote.

**The spread says where it came from.** Binance klines carry no bid and no ask,
so a crypto spread is ESTIMATED at best. A caller passing `measured` for a
kline-only venue is downgraded WITH A REASON rather than believed — this
repository has already shipped an estimate printed as a measurement once.

**Spot carries nothing overnight**, and the first draft of that test asserted
otherwise and failed. You own the asset; there is no funding. A perpetual pays
it. Keeping the two apart is the difference between a swing model that is right
and one that taxes spot holders.

### Still to build

Named so the shape is a decision rather than a discovery: the candidate ledger
(every setup seen with its forward outcome, taken or not — the ML training set,
and it does not exist yet), the calibrated server-side router over it, the
autonomous loop, and the Simulation desk.

### GATE

    PASS  tsc --noEmit                13.8s
    PASS  vitest                      63.6s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.7s
    PASS  21 scripts                  15.7s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.3s

    VERIFY PASSED - 7 stages, 106s total

---

## v61.9 — THE SYSTEM DESK WAS WEARING THE STUDY DESK'S CLOTHES

Two screenshots, three defects, and one of them had been shipping since v60.8.

### A class-name collision nothing could see

The System desk's service cards rendered with bordered, wrapping titles and
huge gaps. MEASURED:

    .svc-row (was .sy-row)  grid-template-columns
        DECLARED   minmax(0, 1fr) max-content        2 tracks, 2 children
        RESOLVED   122.5px 132px 90px 76px 87.5px 24px    SIX tracks
    .sy-name   border 1px solid + a background it never declares

**`study.css` owns 157 `.sy-` classes and imports AFTER `desks.css`**, which
owns the System desk's 10. Four collide by name — `sy-card`, `sy-groups`,
`sy-name`, `sy-row` — and the Study desk wins every one. Nothing failed,
nothing was red, and a desk has been rendering in another desk's clothes for
two releases.

Renamed to `svc-`, the newer and smaller surface: 10 classes moved rather than
157. Row height **93px -> 46px**, name no longer wraps, two tracks for two
children, zero stale `sy-` elements in the desk.

`scratchpad/classcollide.py` asks the question that finds this: which class
PREFIX is claimed by more than one sheet? Comparing shared class NAMES is too
noisy to act on — `press.css` deliberately owns the press state of controls
declared in six other sheets, and `v5.css` is a whole design generation written
as overrides. A prefix is a namespace claim, and two desks claiming one is
always an accident. It reports nine, of which eight are one desk's styles split
across two sheets or a proper specialisation (`.dd-row.lib-row`,
`.lib-toolbar .dd-select`); only `.sy-` was a bare steal.

### The cap was on the wrong element

`.dd` carried the 1480px measure from v61.6 — and `.dd` is ONE of the six root
classes desks actually use. The Journal is `.desk journal-desk`, so it never
got it: MEASURED at **1796px**, with

    .jr-form fields           591px EACH   (repeat(auto-fit, minmax(120px, 1fr)))
    .jr-adherence .detect-seg 1676px       for three buttons

The cap moved to `.view-slot > *`, beside the `min-width: 0` rule that is there
for the same reason and says so in its own words: setting it on every desk at
once is what stops there being a seventh root class that misses it. The chart
is unaffected — the slot carries `data-hidden` while the chart is showing.

### Two controls that took the row's width instead of their own

  - `.jr-form` is the `auto-fit` + `1fr` fault this file already records twice.
    Bounding the track at `minmax(120px, 168px)` keeps the wrap and stops the
    stretch. **591px -> 168px** per field.
  - `.detect-seg` is `flex: 1 1 auto`, which is right in the inspector it was
    written for and wrong in a desk row. Scoped override, so the inspector
    keeps its behaviour. **1676px -> 334px**.

Desk now **1796 -> 1100** with the dock open.

### GATE

    PASS  tsc --noEmit                14.8s
    PASS  vitest                      60.7s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      10.4s
    PASS  21 scripts                  12.6s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.0s

    VERIFY PASSED - 7 stages, 100s total

---

## v61.8 — THREE MORE RAILS, ONE OF THEM STICKY; PLAYBOOK ALREADY HAD ONE

Four desks asked for. Three took a rail, the fourth already had a layout.

### The splits, each argued from the desk's own content

    SMART MONEY   primary  the two detection lists
                  rail     "What to look for"                  8+4, STICKY
    PAPER         primary  the ticket, Open, Closed
                  rail     Where it stands, Cost assumptions   8+4
    SESSIONS      primary  when this instrument moves, busiest hours
                  rail     what is open now                    7+5
    PLAYBOOK      unchanged — `.pb-grid` is already 1fr 1fr

MEASURED at 1900: Paper 929/457 (2.04), Sessions 811/575 (1.41), both as
intended. Panels confirmed by title, not by eye.

### The sticky rail is the point, not a flourish

Smart money's two lists MEASURED **7,623px and 23,696px tall**, and the panel
that decides what is IN them sat above the first one. Changing a filter meant
scrolling twenty thousand pixels back. A rail that scrolls away on a desk like
that is not a rail, it is a first screen.

PROVED by scrolling, not by reading the rule:

    desk.scrollTop      0        4,000     12,000    20,000
    primary  top      271      -3,729    -11,729   -19,729
    rail     top      271         176        176        176

The primary travels 20,000px; the rail moves 95 and pins. `align-self: start`
is REQUIRED — the grid's default stretches the item to the row height, and a
sticky element as tall as its own scroll container can never move relative to
it, so the rule would have been there and done nothing.

Stacked below 1240px the rail goes `position: static`: sticky there would pin
it over the content beneath it.

### 7+5 where the content asks for it

Sessions' clock carries a sentence in its last column. At a 4-column rail that
column lands near 150px and wraps. MEASURED at 7+5: clock 543px, last column
**273px, no wrap**. One attribute (`data-split="7-5"`), not a second pair of
classes.

### Playbook already had it

`.pb-grid` has been `minmax(0,1fr) minmax(0,1fr)` — a symmetric two-column
layout — since before this pass. Left alone. That is now THREE desks in three
releases (Watchlist, Calculator, Playbook) where opening the real thing
overturned the plan to change it.

### Lift, then move — never both at once

Smart money's and Paper's panels were inline arguments to the root `h()` call.
Both scripts lift them to consts FIRST, assert that each block starts at `h(`
and ends at `),` and that its heading text is the one expected, and only then
rearrange. A line moved into the wrong panel by an off-by-one would have been
a silently wrong desk that still compiled.

### GATE

    PASS  tsc --noEmit                13.2s
    PASS  vitest                      51.2s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.7s
    PASS  21 scripts                  14.4s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s

    VERIFY PASSED - 7 stages, 92s total

---

## v61.7 — RISK TAKES THE RAIL; THE CALCULATOR ALREADY HAD ONE

Two desks asked for. One needed the work, one turned out not to.

### Risk: the desk's own subtitle decides the split

"How much, and whether that is inside the rules you set."

    PRIMARY  Position size · Open book and portfolio heat · Portfolio risk
    RAIL     Your rules · Hedge

The three on the left are all about the state of the account RIGHT NOW, and all
three want width — the book is a table and the portfolio a stat grid. The two on
the right are what the left is measured BY: the rules are the limits every
figure is checked against and you set them once a quarter, and the hedge is a
five-figure block answering a different question occasionally.

MEASURED at 1900: desk 1444, primary **929**, rail **457**, ratio **2.04** —
8:4. Panels confirmed in place by title, not by eye.

### The Calculator already had the law, and is proportioned correctly

`.calc-grid` has been `380px minmax(0, 1fr)` all along: an inputs column at a
natural width and a results column taking the rest. MEASURED: inputs 380,
results 1006, and the dead-space scan finds **zero** wide tracks holding
almost nothing.

Two things were then checked before deciding to leave it:

  - **Column balance.** Inputs 1422px tall, results 1275px. Within 10%; a
    two-column layout whose columns end far apart is the hole the Briefing
    desk's entry records, and this is not that.
  - **Whether the five result panels want to be two-up.** They do not. Their
    heights are 130 / 289 / 221 / 412 / 98, and CLAUDE.md already records that
    unequal heights make holes in a grid and want multi-column instead — but
    multi-column would break the READING ORDER, and these five are a sequence:
    what a pip is worth, then the trade, then what it ties up, then what it
    costs, then where the R multiples sit. Splitting a narrative into two
    columns to use width is using width against the content.

**So the Calculator is unchanged, and that is the finding rather than an
omission.** It is the second desk in two releases where opening the real thing
overturned the plan to restyle it — the Watchlist was the first.

### GATE

    PASS  tsc --noEmit                12.3s
    PASS  vitest                      53.2s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.8s
    PASS  21 scripts                  13.5s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s

    VERIFY PASSED - 7 stages, 92s total

---

## v61.6 — A MEASURE ON EVERY DESK, AND THE RAIL THAT SHOULD NOT BE INVENTED

"All of them." The material and the grain already reached every desk in v61.5;
this is the layout half, and it ends with a finding that changed the answer.

### `.dd` had `max-width: 100%`

That one declaration is why every desk stretched. MEASURED at 1900: Briefing
and Watchlist both ran to **1814px**, with tables capped at 1000 inside them —
which is exactly the empty space the owner photographed three times.

A desk is reading matter. Past about 1480px the eye loses the row between its
first column and its last, and nothing done inside fixes a line that long. So:

    .dd { max-width: 1480px; margin-inline: auto; }

Centred rather than left-aligned, because a left-aligned 1480 column on a 1900
screen puts all 420px of slack on ONE side, which reads as a layout that failed
rather than one that stopped. It is a CEILING, not a width — Flow keeps its
1100, Opportunities its 1180, Risk its 1444.

MEASURED after: Briefing **1814 -> 1480**, centred at x=210. Risk unchanged at
1444. One declaration, every `.dd` desk.

### The rails: what the audit actually found

The plan was to give all 23 remaining desks a primary column and a rail. Two
measurements stopped that, and both are worth keeping.

**First, several desks were never single-column.** Live, at 1900:

    Briefing       1814px   grid    98% used
    Flow           1100px   grid   100%   (already capped)
    Opportunities  1180px           100%   (already capped)
    Sessions       1444px            97%
    Smart money    1444px            97%

**Second — and this is the finding — the first desk I opened to give a rail
does not want one.** The Watchlist has exactly two blocks: your list, and the
market heatmap. The split the law asks for is "the work" against "what the work
is measured against", and on paper that is list-against-heatmap. But the heatmap
is 3,108 tiles; in a four-column rail it is unreadable. Putting it there would
have been the law applied against the content it exists for.

So the rail is a CONTENT decision, not a layout one, and it stays opt-in:
`.dd-layout` / `.dd-primary` / `.dd-rail` exist and any desk can take them in
three lines. The Data library uses them because its content genuinely splits —
the library and the composer are the work; disk, jobs and retention are what
the work is measured against.

**Twenty-one desks did not get a hand-designed rail, and that is the decision,
not an omission.** Inventing twenty-one of them from a metric would have
produced twenty-one rails that fight their own content, and the Watchlist is
the proof: one look at the real desk overturned the plan.

### A script that measured the wrong element

`scratchpad/deskshape.py` matched the FIRST `h("section", { class: ... })` in
each module, which is usually an inner panel rather than the desk root — it
reported `data.ts` as `dd-panel lib-hero` and "GRIDS: 0" for a frontend that
plainly has grid desks. Caught because zero is the answer a broken parser gives,
which is the same rule the xref audit is built on. Replaced by a live walk.

### GATE

    PASS  tsc --noEmit                12.3s
    PASS  vitest                      52.7s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      12.3s
    PASS  21 scripts                  15.7s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s

    VERIFY PASSED - 7 stages, 94s total

---

## v61.5 — THE MATERIAL, THE LAYOUT LAW, AND THE COVERAGE RIBBON

Four mockup passes ended in "BUILD ALL". This builds the system, not the
mockups: everything here is expressed in TOKENS, because this terminal ships
seven themes and a hardcoded shadow is right in exactly one.

### The pane material — every desk at once

`.dd-panel` was `background: var(--surface)` plus `border: 1px solid`. An
outline on every element gives them all the SAME EDGE, and then nothing has a
position; the owner's word for the result was "broken". A pane now separates
three ways, all in `tokens.css`:

    --pane-lip    inset 0 1px 0 0  color-mix(var(--p-fg) 5%)     WARM
    --pane-cast   0 1px 2px + 0 24px 56px -28px  of --p-bg-sunk  COOL
    --pane-bg     panel -> panel2, lit from above

The hue separation is the point. A dark interface where the light and the
shade are both neutral grey reads as unlit plastic. The lip mixes from
`--p-fg` (warm ivory on every dark theme here) and the cast from
`--p-bg-sunk` (cool), so both follow the theme rather than being painted over
it. `daylight` inverts them and turns the grain off, because noise over white
reads as a dirty screen.

MEASURED after: `.dd-panel` border-top-width **0px**, box-shadow leading with
`color(srgb 0.909 0.894 0.854 / 0.05) 0 1px 0 0 inset`.

### Film grain

4% of `feTurbulence`, `position: fixed`, `pointer-events: none`,
`mix-blend-mode: overlay`, mounted once in `mountShell`. It is the one effect
applied to the WINDOW rather than to an element, and it is most of the
difference between a dark grey rectangle and a material. Inline SVG rather
than an image: 200 bytes, no network, and resolution-independent, so it does
not soften on a HiDPI display the way a tiled PNG would.

### The layout law

    .dd-layout   12 columns
    .dd-primary  span 8   the work
    .dd-rail     span 4   what the work is measured against

Below 1240px both go full width — a 300px table is not a smaller table, it is
an unreadable one. MEASURED at 1900: primary **1176px**, rail **580px**, ratio
**2.03** (8:4), layout 1772 of 1900. The 800px void is gone. At 542px the
media query stacks them, also measured.

### The coverage ribbon — a real capability, not a restyle

The desk's whole question is "what can I back-test on, and where are the
holes", and a table of six date ranges answers it only if you hold six ranges
in your head at once. `coverageLanes` puts every market on ONE axis.

PURE, and that is not a preference: a segment drawn at the wrong percentage is
a lie about when you hold data, and no eye would catch a 3% error. Seven tests,
all written failing first, pin the four things it has to get right:

  - OVERLAPPING SPANS MERGE. A market held at 1h and 1d over the same years is
    one stretch of history; drawing both leaves a seam that is not there.
  - A REAL HOLE SURVIVES. The merge closes touching spans and nothing else,
    because the hole is the most valuable thing on the chart.
  - A SLIVER STAYS VISIBLE. One day inside five years is 0.05%, which rounds
    to nothing and reads as "you hold none of this" — the opposite of the
    truth. Floored at 0.6%, and the floor is documented rather than hidden.
  - AN EMPTY LIBRARY DOES NOT DIVIDE BY ZERO. One series held for a single
    instant is a zero-length axis, and `x / 0` puts every segment at `NaN%`,
    which CSS drops silently and draws as nothing.

Lanes sort widest-history first, so the market you can study best leads and the
thin ones below it are the ones worth filling in. The year gridlines are
positioned from the SAME axis as the segments — two independent scales drift.

MEASURED live: `ETHUSDT 99.975%`, `XAUUSD 76.26%`, `BTCUSDT 6.73%`, sorted.

### The all-caps eyebrow

`.label` is an italic serif caption, and it replaces the tracked-out ALL-CAPS
mono eyebrow on every block this pass touched. An audit found 43
uppercase-and-tracked rules, but most are BADGES — `LONG`, `DEMO`, `AI` — and a
short token in caps is a chip, not a heading. Only genuine section eyebrows
were converted; the rest are recorded as deliberate.

### What is NOT built

Said plainly rather than left to be discovered:

  - The layout law is applied to the Data library only. The other 23 desks get
    the material and the grain, and keep their old single-column layout.
  - `.pane` and `.pane-div` exist and are used by the Data library; the other
    desks still declare their own card rules.
  - The chrome is untouched. It is the weakest part of the mockups too.

### GATE

    PASS  tsc --noEmit                12.2s
    PASS  vitest                      50.6s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      10.9s
    PASS  21 scripts                  13.9s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s

    VERIFY PASSED - 7 stages, 89s total

---

## v61.4 — THE YEAR WAS NOWHERE ON AN INTRADAY CHART

"Where is gold 3 min and 1 min chart and date." Two questions with two very
different answers.

### 1m and 3m were already there

`TIMEFRAMES` is `1m 3m 5m 15m 1h 4h 1d 1w 1M`; `PINNED_TIMEFRAMES` keeps five on
the face of the row and the ends of the ladder live one click away under More,
which RENAMES ITSELF to the current timeframe when one of them is showing.
Verified on XAUUSD off MT5, not assumed: 3m loaded 800 bars, 1m loaded 801, and
the button read `3m▾` / `1m▾` with `aria-pressed` true. The More menu carries
the keys — **1 for 1m, 2 for 3m**.

Nothing to fix; the design is working. Recorded because "one click away in a
menu that renames itself" is discoverable only if somebody opens the menu.

### The year was nowhere, and that IS a defect

`axisTimeLabel` names the day when a label crosses into a new day and the time
otherwise — right, and it formatted every date as `Sep 24` WHATEVER YEAR IT
FELL IN. `formatTime(full)`, the crosshair readout, had the year on its daily
branch and not on its intraday one — the branch you are in when scrolled back
through the archive.

The archive on this machine holds BTCUSDT 1h back to **2022-01-23** and 1d back
to **2021-04-04**. So a 5m chart scrolled back a year printed exactly the string
it prints for today, on the axis and in the crosshair, and nothing on screen
could tell them apart. Reading last year's session as this one is the same class
as the TwelveData bars drawn in the wrong place: the picture is correct and it
is about a different time.

The fix is the function's OWN rule one level up — name the year when the label
crosses into a new one, exactly as the day is named when it crosses into a new
day, and stay quiet inside one year because a year on every label is a year
nobody reads. The crosshair always carries it, because that readout names ONE
bar.

Three failing tests first (`Jan 1` did not match `/2026/`, `Sep 24` did not
match `/2024/`, `Jan 2` did not match `/2026/`), then 25 pass.

MEASURED on screen, XAUUSD 3m at 800x600:

    Sep 22, 2026 | 11:00 AM | 10:20 PM | Sep 23 | 05:30 PM | Sep 24

The year appears once, on the label that anchors the axis, and never again
inside that year.

**A wider label cannot overlap.** `axisLabelFits` measures the rendered width,
so a label that no longer fits is SKIPPED — and `lastDrawnAt` only advances on a
label that was actually drawn, so a skipped year-boundary label leaves the next
drawn one still carrying the year. The mechanism was already right; nothing
needed changing for it.

### GATE

    PASS  tsc --noEmit                11.6s
    PASS  vitest                      48.9s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      10.6s
    PASS  21 scripts                  14.5s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s

    VERIFY PASSED - 7 stages, 87s total

---

## v61.3 — THE SAME TWO AUDITS, RUN OVER EVERY DESK

"Now check the other desks and menus the same way." Both methods, applied
everywhere, with the tools kept in `scratchpad/` so they can be re-run.

### 1. Cross-reference: every pair of lists that names the same fact

`scratchpad/xref.py`. Six pairings; five clean, and the sixth is expected:

    VIEWS.icon -> icons.ts              21 icons named, registry holds 74   ok
    toolsmenu cards -> DOCK_PANELS       5 cards, dock declares 23          ok
    bind(...) -> registered command     26 bindings, 55 commands            ok
    go-to shortcuts -> VIEWS             9 sequences                        ok
    VIEWS -> shell.ts render switch     24 desks; only 'chart' absent, it is
                                        the fallback branch
    palette viewList -> VIEWS            still derived                      ok

**The first version of this script had two vacuous checks and both reported
success.** The icon regex expected `name: (` where icons are `name: [`, so it
printed 21 false positives; the keymap regex parsed ZERO bindings and printed
"ok". Every check now prints what it actually parsed, and zero is a failure —
same defect as `/svc/health` painting "0 of 0 running" green.

### 2. Dead space: measured live on all 23 desks

`scratchpad/deadspace.js`, run at 1800x1000 against the python build. It finds
grid TRACKS wider than 320px whose cell holds under 24 characters, and blocks
over 1100px holding one short string. Nine desks reported something; three were
the same defect as the Data desk's 560px "Used by" column:

    desk        before                                    after
    Watchlist   525px "BTCUSDT", 375 price, 300 "-2.16%"  239 / 171 / 136
    Sessions    998px "closed — opens in 7.3h"            330
    System      844px "BTCUSDT 1h", 603px a date range    285 / 203

**The System desk one is v60.8's, and its own HANDOVER entry predicted it**: it
says NOT VERIFIED VISUALLY, because the preview pane was 379px tall for that
whole pass, so the card was checked by computed style and geometry and never by
looking at it. Geometry is real evidence about structure and no evidence at all
about whether a column is four times wider than its content.

Each cap is arithmetic, not taste: add the fixed tracks, the gaps and the
padding, decide what the flexible ones deserve, set the cap to the sum.

Checked and deliberately NOT changed, with the numbers: `.pp-empty` at 1268px
("Nothing open."), `.kb-summary` at 1690px ("Nothing harvested yet."),
`.risk-guard-head` at 1243px. These are headings and empty states — a sentence
spanning its container reads as a sentence, not as a hole between two columns.
`.shell` at 1780px is the app frame and is the scanner's one false positive.

### 3. Structure: which desks present a flat wall

`scratchpad/menu_audit.py`. One file came back with no disclosure, no switcher
and no grouping: `alerts.ts`, 5 panels. Inspected: it is a five-card
`.view-grid`, not a stacked column, so it is not the shape `data.ts` was in.
Left alone, recorded here so it is a decision.

### A dead rule, caught by measuring instead of trusting the edit

The watchlist cap first went on `.wl-table` — a class NO ELEMENT HAS, because
the head and the rows container are siblings with no wrapper. The edit script
used `replace` without an assert, so it silently no-opped, the build passed, and
the row was still 1638px. Caught because the verification measured the ROW, not
the stylesheet. Both selectors carry the cap now and `.wl-table` is gone.

### GATE

    PASS  tsc --noEmit                17.1s
    PASS  vitest                      63.7s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      10.6s
    PASS  21 scripts                  17.7s
    PASS  ruff (deferred set only)     0.4s
    PASS  mypy (gateway, launchers)    1.9s

    VERIFY PASSED - 7 stages, 111s total

---

## v61.2 — A MARKET IS A DISCLOSURE, AND THE MENU HAS ONE TAXONOMY

Two asks: expand a market to see its bar sizes, and find the other places where
the organisation is not systematic. The second turned out to be the larger one.

### The library expands per market

Ten markets at four bar sizes each is forty rows to scroll for a question whose
answer is ten lines. Shut, a market IS its summary; open, it is the rows.

Which markets start open is a PURE FUNCTION (`defaultOpenGroups`) so the rule
can be checked rather than described: the market on the chart, and nothing
else. A query overrides the state entirely rather than being ANDed with it —
otherwise searching a shut market reports "1 of 10 series" and shows nothing,
which reads as a bug. `Expand all` / `Collapse all` is ONE control, because
with everything already open the other one is a no-op.

Open state is `ReadonlySet | null`, where null means "nobody has said" and the
default is COMPUTED from what is pinned. Storing the default as a set instead
would freeze it at whatever was on the chart when the desk first rendered, so
changing symbol would leave the wrong market open with no way to tell why.

**Two things about a shut group that selection makes dangerous**, both caught by
driving it rather than by reading it:

1. A selection inside a shut market is invisible, and bulk Delete acts on it.
   The header now carries "1 selected". Same class as a bulk action that
   silently does less than it was asked.
2. The group checkbox read fully-unticked with one of two rows selected.
   `indeterminate` is a PROPERTY with no matching attribute, so it cannot go
   through props at all and needs the `ref`.

### The menu had two taxonomies, and they agreed on nothing

`toolsmenu.ts` named its own five groups — Markets, Flow and on-chain, Trading,
Research and ML, Review and system — while `VIEWS` named five different ones
for the same desks. MEASURED by cross-referencing the two lists:

    agree:  0 of 24 view-backed desks
    differ: 24

    signals      desk bar Strategy   All tools Trading
    workspace    desk bar Chart      All tools Review and system
    sessions     desk bar Chart      All tools Markets
    playbook     desk bar Strategy   All tools Research and ML

So a desk lived in one place if you reached for the desk bar and another if you
reached for the menu, and nothing could tell you which. The labels drifted too:
"Data" on the bar, "Data library" in the menu. That is not a menu needing better
names, it is two answers to one question.

`VIEWS` now owns the group and the label; `toolsmenu.ts` owns only the short
MENU note, because the desk bar's `hint` is a tooltip sentence and a menu row
wants four words. The menu is a projection of `VIEWS` plus the tools that are
not desks — inspector cards and the settings dialog — filed into those same
five groups.

Four guard tests in `status.test.ts` pin the PROJECTION, not the current
strings: same group as the desk bar, same group names in the same order, same
label, each desk listed exactly once.

MEASURED after, in the running app:

    menu groups   Today Chart Research Strategy Review
    desk bar      Today Chart Research Strategy Review
    Strategy ▸    Strategy · Playbook · Signals

### The audit that found it

`scratchpad/menu_audit.py` counts, per UI module, panels and prose against
whether the file uses ANY of the three structures this terminal already has —
a disclosure, a section switcher, or grouping. One file came back with none:
`alerts.ts` (5 panels). Inspected: it is a five-card grid, not a stacked
column, so it is not the shape `data.ts` was in and is left alone. The audit is
kept because the metric is what found the Data desk.

### GATE

    PASS  tsc --noEmit                 9.9s
    PASS  vitest                      38.3s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                       9.1s
    PASS  21 scripts                  11.0s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.0s

    VERIFY PASSED - 7 stages, 69s total

---

## v61.1 — THE DATA DESK, COMPACTED: ONE LINE PER FACT, THREE SECTIONS

The owner's verdict on v61.0 was "on the right direction but looks like a broken
project ... I DONT NEED THIS TYPE OF READ ONLY THINGS". The screenshot was the
Request budget panel: a four-line paragraph, then five hosts, each a card with a
name row, a 1700px progress bar and a mono meta line.

### The rule this file had never taken

CLAUDE.md states it under "Words on screen": one short line per fact, the
reasoning behind "Why?". `ui/panelkit.ts` `pkWhy` has existed since v59 and
eleven desks use it. `ui/data.ts` used it ZERO times and opened all six of its
panels with a `.dd-sub prose` paragraph of three to five lines. That is the
house rule broken six times in one file, and it is precisely what "read only
things" describes.

Six ledes are now one sentence at `--text`, with the full text behind a
`pkWhy` labelled for what it answers — "How the budget is set", "Why bars do
not sync", "What is withheld, and what the checksum proves". Nothing was
deleted; the detail MOVED, which is the half of the rule that is easy to skip.

### A host is a row, not a card

MEASURED: seven hosts, 30px per row, **231px for the whole list**. The card
version was roughly 100px each. The bar survives at 72px beside the numbers,
because "how much budget is left" genuinely is a proportion. Two facts that were
never per-host — "venue counter not readable in a browser", printed identically
under every Binance host — are stated once beneath the list:

    2 venues do not let a browser read their own usage counter, so those
    run on the local estimate.

A parked host still gets its second line, because that is the only state here
the operator can act on.

### Three sections

Seven panels down one column put "what do I hold" and "is Binance rate-limiting
me" on the same scroll, and five of the seven are read about once a month.

    Library      what you hold, and getting more of it
    Connection   the backend, the request budget, the cache
    Transfer     sync, and the vault file

`.seg-btn`, the same switcher every other in-desk tab set uses. Hidden with
`hidden`, not unmounted: each panel holds live state — a filter, a selection, a
pending import — and an effect running since activation. Deliberately NOT
persisted: a desk you open to answer a question should open on the question it
is named after.

The retention policy — six rules that change about once a year — moved behind
`pkFold`, which is `pkWhy` for a body rather than a sentence. `.dd-h3` had one
user and is deleted; unlike `.status`, no child class survives it.

### The defect the screenshot contained

SPX500 held 1h from mt5 and 1h from a proxy, and the group header read
**"2 timeframes"**. It was counting ROWS. A market carried by two vendors at one
bar size is not a market you hold two bar sizes of, and the difference decides
whether the next download is worth making. `SeriesGroup` now carries
`timeframes` and `sources` as distinct counts, and `groupLine` says
"1 bar size" or "2 bar sizes from 2 sources". Two tests, both failing first.

### GATE

    PASS  tsc --noEmit                12.3s
    PASS  vitest                      57.3s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.7s
    PASS  21 scripts                  14.1s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.3s

    VERIFY PASSED - 7 stages, 97s total

---

## v61.0 — THE DATA LIBRARY: A DESK YOU CAN RUN, NOT JUST READ

The owner's words were "I NEED MORE POWERFUL DATA HANDLING MENUS SO I CAN
MANAGE AND DOWNLOAD PROPERLY", with a screenshot of the desk at ~1825px. Two
separate faults, and the layout one was the smaller of them.

### The dead space was a `1fr` track

`.dd-row.rs-lib-row` gave "Used by" `minmax(100px, 1fr)`, so on that screen it
was a ~560px column holding a single em dash — the gap in the screenshot. One
block up, `.dd-stats` is `repeat(auto-fit, minmax(140px, 1fr))`: four cells of
420px each, one of them holding the character "3". `auto-fit` with `1fr` spends
every available pixel whether or not there is anything to put in it.

Both are capped at **1000px** now, which is also the width the library's other
blocks take, so the panel reads as one column instead of a strip that stretches
over a table that does not. The cap is arithmetic, not taste: the row's seven
fixed tracks, their gaps and its own padding come to 770px, so at 1000 the one
flexible track lands at 294 and there is no slack left to pool anywhere.

MEASURED at 1800x1000 after: stats 1000, download 1000, toolbar 1000, table
1000, all at x=76. At 1120x900: 958 each, no document overflow, no scroller.

**And the symbol field was 718px — the whole row.** `.dd-input` carries
`width: 100%`, which inside a flex row resolves to the row, so the field wrapped
onto a line of its own and read as a bar of empty surface; in the screenshot it
looked like the input was missing. A field states its own width. Now
`flex: 1 1 260px` with a 420px cap, MEASURED at 420.

### The real complaint was the menus

- **Download took one symbol and one bar size per press.** Filling BTCUSDT at
  1h, 1d and 5m was three trips through the form. Bar sizes are now CHIPS (a
  set, not a choice) and the field takes a comma-separated list, so one press
  queues symbols x timeframes. Sequential on purpose — six parallel backfills
  is how a free vendor tier starts refusing — with a queue line naming the leg
  in flight, because "Downloading…" for four minutes is indistinguishable from
  a hang.
- **Three presets** — On the chart, Watchlist, Macro spine — write into the same
  field they would have been typed into, so what is about to be fetched is
  visible BEFORE it is fetched rather than being a button that silently queues
  sixteen downloads.
- **Grouped by market.** BTCUSDT appeared four times, scattered among every
  other market by whatever order the store returned, so "how much BTC do I
  hold" could only be answered by reading the whole table and adding up. The
  group header carries that total.
- **Select, and act on many.** Row and group checkboxes, select-all-shown,
  bulk Update and bulk Delete.
- **Find and order.** A filter over market, bar size and source, and four
  orderings.

### Two defects the new tests found

1. **`5m` also matched `15m`.** Substring matching over the timeframe: a market
   name is open-ended and a partial one is the point, but a bar size is a short
   closed vocabulary where the only thing a substring buys is the wrong row.
   Exact match there, substring for symbol and source. The test failed first.
2. **A bulk delete would have ignored the pin.** Every single-row Delete and the
   retention sweep honour it; a bulk one that did not would be the one route in
   the product that deletes history from under the thing displaying it — and for
   a selection made with a single click on a group header, which is when the
   operator is least likely to have read it. `deletable()` returns the skipped
   ROWS, not a count, because the caller has to name them.

### Verified live, on the python build at :8787

    Macro spine preset   -> 8 symbols into the field
    1h + 4h chips        -> button reads "Download 2 bar sizes"
    2 symbols x 2 sizes  -> "Downloading 1 of 4…", queue line
                            "ETHUSDT 1h — 2,000 older bars so far"
    result               -> "4 of 4 downloaded."
    groups               -> BTCUSDT 1 timeframe · 806 bars · 37.8 KB
                            ETHUSDT 2 timeframes · 12,000 bars · 563 KB
                            SOLUSDT 2 timeframes · 12,000 bars · 563 KB
    filter "sol"         -> "2 of 5 series", one group
    filter "zzz"         -> "No series matches “zzz”. 5 are held."
    sort by size         -> ETHUSDT, SOLUSDT, BTCUSDT
    bulk delete 3 (one of them on the chart)
                         -> "Deleted 2 series: 12,000 bars, 563 KB.
                             1 left alone — on the chart right now."

The four pure parts moved to `ui/research/library.ts` — `filterSeries`,
`groupBySymbol`, `deletable` — where 15 tests in `app/test/libtable.test.ts`
check them against a fixture. As closures inside the desk the only way to check
any of them was to look at the table, which is the condition the "Used by"
column survived two releases under.

`.lib-chip` was added to BOTH lists in `press.css`. It is a new bordered control
in a row that already answers presses, which is exactly how `.tool-btn` came to
be missed twice.

### GATE

    PASS  tsc --noEmit                13.2s
    PASS  vitest                      49.7s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.0s
    PASS  21 scripts                  12.9s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s

    VERIFY PASSED - 7 stages, 88s total

---

## v60.9 — A SYSTEM DESK, AND A MENU THAT SAYS WHERE IT GOES

The owner: "YOU MAKE A VERY BAD INTERFACE AND MENUS AND FUNCTIONS MAKE A BETTER
SYSTEM." Two faults, both real.

### THE FUNCTIONS WERE FILED UNDER THE WRONG HEADING

Storage, downloads and twelve background jobs shipped inside **Research > Data**
— and the tools menu had a "Review and system" group that did not contain them.
A capability under the wrong heading is only slightly easier to find than one
with no screen at all.

`ui/system.ts` is now its own desk, in **Review**, where "what did this machine
do" sits beside "what did I do" (Journal) and "what did it learn" (Learning).
Research > Data keeps its real job — the per-series library you download and
manage — instead of doubling as the machine's status page.

VERIFIED live: Review > System shows **5,794 bars across 6 series, 272 KB**, four
job groups, 12 of 12 started. Six series, up from the one that existed before
enrolment — `bars_loop` has been filling it unattended, which is the whole point
of v60.4.

### THE MENU DID NOT SAY WHERE ANYTHING WENT

Every row looked identical, and clicking one did three different things: change
the desk, open a panel over the chart, or launch a dialog. Only inspector cards
carried a hint, so two thirds of a twenty-eight item menu was learned by trial.

Every row now carries a hint. And the labels were sentences crammed into name
slots — "Liquidations, open interest, funding", "Quant — volatility, causal,
forecasts, ML", "Can I trade now? (risk governor)". They are names again, with
the description in the hint where it belongs:

    Flow              liquidations, open interest, funding
    Quant             volatility, causality, forecasts
    Can I trade now?  the risk governor's answer
    System            stored history, downloads, background jobs

### A GUARD TEST THAT PINNED THE WRONG THING

`deskbar.test.ts` "lose no desk in the regrouping" asserted a hardcoded 23, so
it failed the moment a desk was ADDED — which is not a loss. Worse, a count can
stay right while the set is wrong: drop one and add another and 23 is still 23.
It now compares the grouped ids against `VIEWS`, which pins what its name says
and survives every future desk.

### GATE

    VERIFY PASSED - 7 stages, 100s total

---

## v60.8 — THE TWO INFRASTRUCTURE CARDS, DESIGNED RATHER THAN ASSEMBLED

The cards shipped in v60.5-60.7 worked and looked like every dashboard: a
heading, a subtitle, a flat table, some grey notes. Five specific faults, each
a default rather than a decision:

1. **The answer was mumbled.** "799 bars across 1 series - about 37 KB on disk"
   is what the card exists to say, set in body text — and it is the `A - B - C`
   middle-dot meta string, which is a generic tell. The count now LEADS, at
   `--fs-7` in `--font-serif`, which is already this terminal's voice for what
   it says on its own account (`.td-title`, `.bf-verdict-line`, `.av-empty`).
2. **The table had no hierarchy** — five columns all at `--text-muted`. The
   symbol is now the only thing at full ink because it is the subject; bars,
   span and size qualify it and drop to `--text-muted` / `--text-faint`.
   HIERARCHY IS CONTRAST, not a second colour.
3. **The header row went.** Five labels over self-evident figures is chrome: a
   count reads as a count and a date reads as a date.
4. **Both cards looked identical** despite answering different questions. They
   are deliberately different shapes now — the archive is an INVENTORY (a
   figure, then evidence), the services card is a LIVENESS readout (jobs
   against a group spine, no quantities to rank).
5. **Status dots were the SaaS default.** `.bf-event` had already established
   this file's idiom — a 2px left edge carries standing, because tinted bodies
   turn a card into a colour chart — so the rows use that instead.

And the copy described MY work rather than the operator's: "Six of them had no
mention anywhere on screen until now." Cut. Loop names were function names with
the punctuation filed off ("db alert", "pair scan"); they are now things an
operator owns — Wallet watch, New listings, Dead-man's switch.

MEASURED after, in the browser:

    .ar-figure   Instrument Serif 34px, rgb(232,228,218)   = --text
    .ar-of       12.5px, rgb(107,103,95)                   = --text-faint
    .ar-row      mono 12.5px, rgb(154,149,138)             = --text-muted
    .ar-sym      sans 600, rgb(232,228,218)                = --text
    .sy-row[on]  border-left 2px rgb(52,196,154)           = --pos
    at 1600px    .sy-groups -> 715px 715px, groups pair (802,802,1140,1140)

The one animation is a download's progress bar, on `width` with `--dur-2` — a
token, so `prefers-reduced-motion` can stop it. A literal duration never sees
that switch.

**NOT VERIFIED VISUALLY.** The preview pane was 379px tall for this whole pass
and the desk's own sticky header takes most of it, so every screenshot showed
the card's title and nothing else. The design is verified by COMPUTED STYLE and
by layout geometry, which is real evidence about colour, type and structure —
and no evidence at all about whether it reads well. Someone has to look at it.

### GATE

    VERIFY PASSED - 7 stages, 65s total

---

## v60.7 — STAGE 3 COMPLETE, AND THE INVISIBLE CAPABILITIES FOUND

### THE AUDIT, RE-RUN

CLAUDE.md recorded "36 of the 48 /svc and /mt5 routes were never called by the
frontend". That figure was measured in v58 and is now stale. Re-measured by
walking every `@bp.get/@bp.post` in `server/` and grepping `app/src` for each
path:

    74 routes | 46 called by the frontend | 28 NEVER CALLED

And of the twelve loops in `gateway/background.py`, **six appear nowhere in the
frontend at all**: `backup_loop`, `data_loop`, `ledger_loop`, `pair_scan_loop`,
`heartbeat_loop`, `daily_brief_loop`. They run every few seconds, on this
machine, and nothing on screen said so.

### STAGE 3 FINISHED — THE STORE FILLS

`server/svc/bulkfetch.py`. Binance Vision monthly klines, into the Parquet
partitions `svc/store.py` already understood.

PROVEN END TO END, from the browser:

    BTCUSDT 1m · 3 of 3 months · 2 fetched, 1 already held
    3 partitions · 4.2 MB

**"1 already held" is the resumability working**, not a rounding error: June had
been fetched by an earlier CLI run and was skipped without a request. A download
that cannot say what it holds gets re-run from zero the first time somebody
closes the lid.

One month measured: **43,200 rows** (30 x 1440 exactly), 1.40 MB Parquet+zstd
from a 2.0 MB zip. And the point of the whole design, verified with DuckDB
reading the files in place:

    rows: 43200   span: 2026-06-01 00:00 -> 2026-06-30 23:59
    hours aggregated from 1m: 720

720 = 30 x 24. That is intrabar stop-versus-target ordering, available now.

Two details worth keeping:

- **It refuses BEFORE it starts.** Missing packages, a full budget, or a job
  already running are answered without a byte fetched. A fetcher that discovers
  it had no room on the last file spent the whole download learning something
  it could have checked first.
- **The parquet is written atomically** (`.part` then `os.replace`). A partial
  file is indistinguishable from a complete one to `inventory()`, so the next
  run would skip it forever.
- **Binance switched `open_time` from ms to MICROseconds** in 2025 archives.
  Detected by magnitude, not by a cutover date: a date is a fact that goes
  stale, a magnitude is not.

### THE CAPABILITIES, ARRANGED

`ui/data/system.ts` — the twelve loops, grouped by what they are FOR rather
than listed by function name, because twelve names in one column is a process
table and not an interface:

    Data           bars, data, pair scan
    Alerts         alert, sig, db alert, daily brief
    Money          ledger, whale, smart copy
    Housekeeping   backup, heartbeat

VERIFIED live: 12 of 12 rows, every one reporting a real tick age.

**A TICK AGE IS NOT A HEALTH CHECK**, and the card says "woke 13s ago" rather
than "healthy" for a reason this session earned: `bars_loop` ticked hourly and
reported a perfectly fresh age for a whole release while doing NOTHING, because
the config key it read had no writer. The dot means STARTED. It does not mean
working.

The card also states the failure CLAUDE.md records — background services
switched off entirely — because `python run.py` sets `IRAM_BACKGROUND=1` and
starting the gateway directly does not.

### GATE

    VERIFY PASSED - 7 stages, 101s total

---

## v60.6 — THE BULK ARCHIVE, AND THE EVICTION THAT HAD TO COME FIRST

Stage 3 of the data plan. `duckdb` and `pyarrow` measured at **1 MB and 86 MB**
on disk — which would have nearly doubled the 90 MB exe, so dropping the binary
paid for this immediately. Both have cp314 wheels, checked before committing to
the design, because Python 3.14 is new enough that they might not have.

### NOTHING DOWNLOADS UNTIL EVICTION WORKS

That is the rule `server/svc/store.py` is built around. Twenty gigabytes
acquired with no bounded way to remove it is a worse problem than having no
data: a disk that fills is a machine that stops, and the owner said plainly
this is a personal computer.

`eviction_order` is a **pure function over an inventory** — it takes a list and
returns a plan, touching no files. That is the entire reason the order is
testable, and the order IS the safety property:

  1. TICKS BEFORE BARS       ticks are re-downloadable bulk; bars are what
                             every study reads
  2. CONTEXT BEFORE TRADED   a yield explains a market; the market is the one
                             you cannot replace
  3. OLDEST BEFORE NEWEST
  4. NEVER THE LAST 90 DAYS  whatever the budget says

One tuple sort rather than three passes, so the priorities COMPOSE — a newer
tick partition still goes before an older bar one, which is the intended
reading and the thing three separate passes would get wrong. Pinned by
`test_the_three_rules_compose_rather_than_fighting`.

**It refuses rather than breaking the window.** When a budget can only be met
by deleting inside the 90-day guard, the plan removes what it legitimately can,
reports `freed < over`, and says: "Raise the budget, or remove a market you no
longer study." Obeying such a budget silently would destroy the only data a
walk-forward can validate on, and the operator would discover it from a
backtest that suddenly has no out-of-sample.

`/svc/store/evict` defaults to **dry_run: true**. A route that deletes
gigabytes by default is one that deletes them by accident.

10 pytests, registered in `verify.py`.

### THE PACKAGES ARE OPTIONAL, BY NAME

`available()` reports which of duckdb/pyarrow is missing and every route
refuses with that sentence. A gateway that would not boot without an 87 MB
optional dependency would make the whole feature a hostage.

### AND IT IS ON SCREEN

`ui/data/archive.ts` gained the bulk half, under a hairline rather than in a
second card — "how much history do I have" is one question, and answering it
from two cards invites the reader to treat them as unrelated stores. VERIFIED
live on :8787:

    Stored history
    799 bars across 1 series - about 37 KB on disk
    BTCUSDT - 1h   799   2026-08-22   2026-09-24   37 KB
    The browser declined persistent storage, so it may evict the local archive
    under disk pressure. The copy on the server is unaffected.
    ---
    Bulk archive (tick data and deep history)
    Ready and empty. 5.00 GB budget, in C:/Users/.../AppData/Local/iram/data

### GATE

    VERIFY PASSED - 7 stages, 109s total

---

## v60.5 — THE SEARCH REMEMBERS, AND THE DATA BECOMES VISIBLE

### STAGE 2 — a sweep is not repeated for an answer that has not changed

`autoRun` re-studied the whole field every time: 85 rules over 5,000 bars,
MEASURED at 13s of studies and ~27s of wall clock, paid again on every reload
for a conclusion already reached. `backtest/sweepcache.ts` remembers it.

**The key carries the FIELD and the COSTS, not just the market.** A cached
result answers one question. Add a library rule, change the hybrid cap, or
change the spread you are charged and it is a different search over a different
hurdle — serving the old answer would report a conclusion nobody reached. So
`hashField` (the entrant ids) and `hashCosts` are in the key, and a changed
field MISSES rather than lying.

**Staleness is measured in TIME, not array length.** A study window is a
rolling 5,000 bars: it is still 5,000 a week later with every bar in it newer,
so `barsNow - prev.bars` reports ZERO for a market that has moved on entirely
and a cached sweep would never expire. The gap between the newest bar then and
now, divided by the timeframe's spacing, is the honest count. Threshold is
`max(25, 5% of the window)` — one new bar does not move an estimate built on
five thousand, and re-running on every close would make automatic search
indistinguishable from a busy loop.

**What is kept is deliberately small:** not the `AutoRunReport` (sixty hybrid
specs and every survivor — and the survivors are already on the shelf, where a
second copy would be a second place for a promoted rule to still look
unproven), but what the card RENDERS: the sentence, the refusal, the distinct
failure reasons, the arithmetic. A cancelled run is never cached; caching a
partial answer would freeze it in place and suppress the re-run that completes
it.

**A hit states its own age.** "Searched 2026-09-24 12:04 on 5,000 bars. Search
again to redo it now." A verdict that looks live and is three days old is worse
than no verdict.

### STAGE 1 FRONTEND — a capability nobody can see is a capability nobody has

Everything built in v60.3 and v60.4 worked and NONE of it was visible. The
owner's question — "how much historical data is in the system" — could only be
answered by opening developer tools and reading IndexedDB by hand.

`ui/data/archive.ts`, in the Research desk's Data library tab. VERIFIED live:

    Stored history
    799 bars across 1 series - about 37 KB on disk
    Series            Bars   From         To           Size
    BTCUSDT - 1h      799    2026-08-22   2026-09-24   37 KB
    The browser declined persistent storage, so it may evict the local archive
    under disk pressure. The copy on the server is unaffected.
    [Keep these markets current]  -> "22 series enrolled. They are topped up
                                      hourly, with the terminal closed."

**"Could not ask" is not "nothing stored".** A gateway that is not running
holds an unknown amount; rendering 0 bars for it would be the most alarming
possible way to say "fine". `reachable` is `boolean | null` and the three
states read differently.

The only colour that carries meaning is `--attn` on a service to go and start.
Counts are never toned: more bars is not better news, it is just more bars.

### GATE

    PASS  tsc --noEmit                12.9s
    PASS  vitest                      56.9s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.6s
    PASS  21 scripts                  13.1s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s
    VERIFY PASSED - 7 stages, 96s total

---

## v60.4 — THE LIBRARY ENROLS ITSELF, AND A TEST THAT WROTE TO THE LIVE DATABASE

Asked for: keep the data the analysis needs (BTC, XAUUSD, US10Y and the related
assets) so backtests are easy; store it durably; **no exe** — the browser build
only; roughly 20 GB, "not a must or a fixed rule ... its a personal computer".

### THE LOOP THAT REPORTED HEALTHY AND DID NOTHING

v60.3 built `bars_loop` to top the archive up hourly with the terminal closed.
It read its enrolment from a config key `bars_enrolled` — and **nothing ever
wrote that key**. Measured by grep: one reader, zero writers. So it ticked on
schedule, reported a healthy last-tick age in `/svc/health`, and produced no
work. A component that cannot be seen to be idle is worse than one that is
visibly broken.

`app/src/data/library.ts` now computes the list once — a macro spine of eight
plus whatever is on the watchlist — and pushes it through a new
`POST /svc/bars/enrol`. One list, two readers, rather than a declaration in the
browser and another in Python free to drift. VERIFIED live: 22 series enrolled
(8 spine x 2 timeframes, plus SOL, BNB, XRP from the watchlist).

### A YIELD IS NOT AN INSTRUMENT, AND THE TABLE PROVED IT

The context series (DXY, US10Y, US1Y, real yields, HY spreads, SPX, NDX, VIX,
copper) were first added to `INSTRUMENTS` with a `contextOnly` flag. **Five
calculator tests failed immediately**, correctly: a quote currency of "PCT" has
no convertible rate, because everything that sizes, converts or values a
position walks that table.

Teaching each consumer to skip a flag is the "find EVERY consumer" trap. They
are now a separate `CONTEXT_SERIES` map, so no sizing code can reach them BY
CONSTRUCTION and `sizePosition` defaulting `contractSize` to 1 can never turn
4.43% into a position measured in thousands. The failing tests were the
argument, not an obstacle.

### A TEST WROTE TO THE OPERATOR'S DATABASE. AGAIN.

`/svc/bars/inventory` on the live gateway:

    binance|BTCUSDT|1h: 798 bars   2026-08-22 -> 2026-09-24
    net|BTCUSDT|1h:     209 bars   2027-01-07 -> 2027-01-15
    a|BTCUSDT|1h:        99 bars
    alive|BTCUSDT|1h:    99 bars
    px|EURUSD|1h:        99 bars
    b|EURUSD|1h:         29 bars

`net`, `a`, `alive`, `px` and `b` are fixture source ids from
`app/test/history.test.ts`. **535 rows of invented candles, dated 2027, in the
archive the backtests read.** `createHistory` defaulted to the live `/svc/bars`
client, and the global `fetch` under vitest reaches a gateway that is running —
so `npm test` with `python run.py` up wrote test data into `mishel.db`.

This is the defect already recorded under "Four test files wrote to the
operator's live `server/mishel.db`", arriving through a door that did not exist
when that rule was written.

Fixed as a SHAPE: `createHistory`'s server argument now defaults to `NO_SERVER`,
inert, and `data/feed.ts` opts in once where the application is assembled. A
test cannot reach the real archive whatever `fetch` happens to be. The 535 rows
were deleted; a full gate run with the gateway up now leaves the database at
798 bars, unchanged. `history.test.ts` pins it, written the way a new test
would be written — with no fourth argument.

### ALSO

- **No exe.** Both binaries deleted (110 MB). `build_binary.py` kept; there is
  no exe step in the workflow any more.
- **The disk budget is a setting**, `BUDGET_SLOT`, defaulting to a modest 5 GB
  rather than a hardcoded 20. Bars for the whole spine are well under a
  gigabyte; anything beyond that should be a deliberate choice, and whatever is
  used is reported beside it.

### GATE

    PASS  tsc --noEmit                13.0s
    PASS  vitest                      52.8s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.4s
    PASS  21 scripts                  13.8s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s
    VERIFY PASSED — 7 stages, 92s total

---

## v60.2 — AUTONOMOUS MODE DECIDES FOR ITSELF, AND THE BUG THAT WAS HIDING IT

Asked for: "when it's autonomous mode it should be capable to automatically
give me entry exit stoploss and other stuffs why i need to open strategy desk
and other things."

Chosen by the owner when asked: search **automatically on first open** of an
unsearched market; **all eight checks**, the same ones Manual runs; a rule with
no target shows its **exit rule in words** plus the R its exits produced.

### THE DEFECT THAT MADE ALL OF THIS MOOT

Found while verifying the new card in the browser, and it had been breaking
every sweep for anyone who ran one:

    Nothing was searched. 85 could not be studied on this history.
    bars[4999].t is not after bars[4998].t — bars must be ascending and unique

The 5,000-bar study window ended with a repeated timestamp, `headless.ts` threw
on its ascending-and-unique contract, and all 85 rules came back as failures —
reported as a COUNT with no cause, which is why it had never been chased.

The contract was assumed in four places and guaranteed in none.
`archive.write` de-duplicates within one batch, and its own comment says why
("a feed republishing the forming bar must not create two rows"). But
`archive.read` concatenated every overlapping segment and merely SORTED, which
puts copies next to each other rather than removing them; and `history.load`
returns the VENDOR's response verbatim whenever it is longer than the archive's
holding, so nothing between the venue and the engine ever removed a duplicate.
`store/barstore.ts` `ascendingUnique` is now the one owner, applied at both
points, keeping the LAST bar for an instant because a republished bar is a
correction of the one before it.

Fixed, the same sweep reports what it is supposed to:

    Nothing survived the search of 85 strategies (765 tries).
    Nearest miss: Stochastic cross in the extreme: -0.02R expectancy out of
    sample — it lost money on data it had not seen.

### THE CARD CAN NOW ACT

**One driver, two surfaces** (`ui/model/sweepdriver.ts`). The run loop lived
inside the Strategy desk's Autonomous tab, so the only way to start a search was
to open that desk and press Run; the card could only navigate you there. Lifted
out whole, it is built once in `mountShell` and handed to BOTH the desk and the
card. One object rather than two callers of one function, because two sweeps at
once would compete for one worker pool, charge the best-of-N hurdle twice for a
field tested once, and race each other into `shelf.addAll`. Verified live: a
search started from the inspector shows the same report on the desk.

Built in the shell rather than by the desk because that desk is LAZY — asking
it for a driver would construct its whole DOM at boot for a card that only
wants to call `run`.

**Searching by itself, fenced.** The owner chose automatic after being shown the
cost, so the trigger is a list of refusals rather than a condition: visible
(`isShown`, not `isConnected` — both panes of the card sit in the DOM at once
and switch with `display`), settled for 1.5s so paging a watchlist does not
queue a sweep per symbol, once per market INCLUDING when nothing was found,
never while one is running, and switchable on the card itself.

### A FULL PLAN, FROM THE RULE'S OWN LEVELS

`ui/model/autoplan.ts`. It reuses `sizePosition` and `gatesFor`/`verdict`
whole — neither cares that the idea came from a search — and deliberately does
NOT reuse `setup/plan.ts` `buildPlan`, which takes the FURTHER of the supplied
stop and `atr x minAtrMultiple`, discards the supplied stop above
`maxAtrMultiple`, and hardcodes targets at 1R and 2R. A rule tested with
`target: {rr: 3}` would have been quoted at 1R underneath its own out-of-sample
expectancy.

**The entry price was wrong, and it is the figure everything else hangs on.**
The card printed the signal bar's CLOSE. `runBacktest` holds a signal and fills
it at the NEXT bar's open through `modelledFill` — half the spread plus
slippage, against you. So a price the engine never paid sat directly above the
figures that engine earned. Because a rule fires on the last CLOSED bar, the
bar that fills it is the one forming now and its open is known, so the fix is
exact: on the fixture, 129.50 * 1.0002 = **129.5259**, not 129.00. The card
also states the drift since that open, because a rule whose fill has run away
is no longer the trade the backtest took, and refuses outright when the stop
lands on the wrong side of the fill — the signal `runBacktest` itself drops.

**Eight checks, one environment.** `GateInputs` is twenty-six fields of which
exactly four describe the trade; the rest describe the feed, the calendar, the
book and the account. Split into `GateEnvironment` + `PlanFacts` so the Setup
model builds the readings ONCE and both panes spend them — otherwise there
would be two answers to "is there news in fourteen minutes" on one screen.

**And an empty gate list is not a pass.** `verdict()` reads a list: none
blocking and none unknown means everything passed, so handed `[]` it returns
`go` with 0 of 0 — the shape of the `/svc/health` defect where "0 of 0 running"
painted green. `UNCHECKED()` returns "CAN'T CHECK YET" instead.

### TWO MORE FOUND WHILE VERIFYING

- **The sweep subject was set when the report landed, not when the run began.**
  So a search IN FLIGHT was indistinguishable from no search for any reader
  asking "is this mine?" — the card drew its idle state, offering a Search
  button for a search already running while `running` quietly refused every
  press. This is what "it isn't doing anything" looked like.
- **The first automatic search hung entirely on ResizeObserver.** The card's
  visibility check runs during construction, when `mountShell` has not yet
  appended it, so `isShown` is false for all of it. Only `onShown` could ever
  fire — one mechanism carrying the whole feature, and absent in jsdom. A
  `scheduleFrame` re-check after mounting is the second path.

### NOT BUILT, AND WHY (asked about in the same session)

- **Level 2 / tick data.** Correcting an earlier overstatement: it is not
  unreachable, it is unwired. `data.binance.vision` serves free keyless
  archives of trades, aggTrades and bookTicker; MT5 has `copy_ticks_range` and
  the bridge only calls `symbol_info_tick` (one current tick). What stops it is
  volume and consumers: BTCUSDT aggTrades are 1-3M rows a day, ~50GB a year,
  which cannot live in IndexedDB; and `runBacktest` walks OHLC arrays, so
  nothing would read it. The two things ticks WOULD buy are named for later:
  measured spread by hour of day (which sets the hurdle every rule must clear)
  and intrabar stop-versus-target ordering.
- **RL, vectorbt, closed-loop execution.** Unchanged from v60.1's entry.

### GATE

    PASS  tsc --noEmit                11.7s
    PASS  vitest                      51.2s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      10.8s
    PASS  21 scripts                  12.8s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s
    VERIFY PASSED — 7 stages, 88s total
    Test Files 174 passed / Tests 4135 passed

`npm run build` -> app/dist, verified on :8787 through `python run.py`.
**NO EXE**, per the owner's instruction.

---

## v60.1 — THE CHROME, MEASURED: ONE CENTRE LINE, ONE CONTROL SCALE, NO EMPTY BAND

Asked for, with two screenshots and three circles: "the top panel design is
very bad inconsistent. also the btc price is too big and there are empty space
you can place something on side. then in today there are also uneven empty
spaces. fix the design problems." And: stop building the exe — the browser and
the python build only, until the design is right.

Everything below was MEASURED in the browser before and after. Nothing here
changes what the terminal says; it changes where it is.

### THE COMMAND BAR WAS ON TWO BASELINES

The one that matters, at 1920:

    desk tabs       42px, `align-self: center`  -> centred at y=29
    everything else 28px, no self-alignment     -> top-aligned at y=14.8

`.commandbar` was `align-items: stretch`, and every control in it declares its
own height — so nothing stretched, everything hugged the top, and the brand,
the two menus, the search field, the status strip, the account chip and the
four icon buttons all sat FOURTEEN PIXELS above the navigation beside them.
That is the whole of "very inconsistent"; no amount of spacing fixes a row
whose items are on two baselines.

Three scales in one row, too: 28 (brand, menus, field, strip, chip), 32 (the
four icon buttons), 42 (tabs), with 5px corners against the tabs' 10px.

Fixed as tokens on the row rather than a height per control, because every one
of them already reads `--h-ctl-sm` or `--h-ctl`:

    .commandbar { --h-ctl-sm: 34px; --h-ctl: 34px; --r-ctl: 10px }

After: thirteen children, thirteen heights of 34 (tabs 40), thirteen centres at
y=29, one corner radius. The brand went to the mockup's scale — a 24px mark and
the serif face, which is the face the terminal already uses for what it says on
its own account.

### THE PRICE, AND THE 293px OF NOTHING BESIDE IT

Two causes, both measurable, and neither of them was "the price is big".

**One.** `--fs-headline` (26px) was doing two jobs — the Today desk's answer
line, which is alone on its line, and the chart's last price, which shares a
42px band with a symbol box, five timeframes and four pills. Split:
`--fs-quote: 20px`, the mockup's size, still the largest thing in the row.

**Two.** The row was two clusters with the spacer between them, immediately
after the price: on a 1524px chart column the price ended at x=567 and the
timeframes began at x=934. The approved mockup puts the spacer AFTER
auto-marking, so symbol, price, timeframes and pills read as one left group and
only Fit, Log, Replay, the overflow and the feed badge are anchored right.

**And the fit ladder was shedding in the wrong sizes.** It steps down until the
row stops overflowing, so a rung that sheds more than the row is short by
leaves the difference as empty band. MEASURED at a 1282px column, old ladder:

    full      overflows by 289
    compact   overflows by 2      <- two pixels
    tight     293 to spare

Two pixels short of fitting, so it gave up 291 more than it needed. `compact`
was dropping all three range figures and the feed badge's words in one move.
Six rungs now, each costed: ATR alone (-127, and it is the one figure the live
bar already prints), then the two range figures (-160), then the two pill
labels (-135), then the change chip with Fit, Log and the Replay label (-184),
then the feed badge, the timeframe ladder, a narrower symbol box and a smaller
price.

And the two pixels themselves: `.topbar-spacer` was `flex: 1 0 var(--sp-5)` —
a 12px basis that could grow and never shrink, so the row reported itself as
overflowing while holding 12px of blank. `1 1 0`. After: the row settles on
`snug` at that column with a 10px spacer, and the range figures come back as
the column widens instead of at nothing.

**And the row's own gaps are a rung.** Ten items is nine gaps, so two pixels
off each is eighteen — and the two widths where a hole survived the resplit
were missing by SEVENTEEN and THIRTEEN. 12px, 10px from `snug`, 8px from
`tighter`; a row running out of room tightens its spacing before it deletes a
reading.

SWEPT, as the spacer left over at each shell width, before and after the whole
pass (chart column in brackets):

    shell    before            after
    1900     [1508]  367       compact    76   <- the owner's width
    1700     [1308]  367       snug       54
    1500     [1108]  367       tight       1
    1300     [ 908]  367       tighter    23
    1150     [ 758]  367       tightest  144
    1000     [ 608]  over 38   tightest  over 6

At 1508 the row now lands on `compact`, which means the 24-bar high and low are
back beside the price — the "something on the side" the empty band was created
by hiding.

The same token treatment as the header, one row down: the chart toolbar had
four control scales (32 symbol box, 33.6 timeframe group, 28 pills, 28 badge)
and is now one, at 32.

### A BUG THE MEASUREMENT FOUND

`.sym-picker { max-width: 110px }` at the two narrowest rungs, and
`.sym-input { width: 148px }` — an input is its wrapper's only child, not a
flex item of the row, so it OVERFLOWED the wrapper by 38px and painted over
the price. At a 574px column the wrapper ran x=13..123, the input x=13..161,
and the price, correctly laid out at x=135 and fully rendered, read "136.01"
on screen. Constrain the thing that has the width. **No unit test:** nothing
unit-tests `mountShell`; verified by measuring both boxes before and after.

### TODAY: A GRID CANNOT PACK SIX CARDS

    row 1   Where you stand 133   This chart 310   What changed 226   Where else 137
    row 2   Alerts 109            Conditions 149   (empty)            (empty)

A grid row is as tall as its tallest card whatever `align-items` says, so the
short cards left holes of 177, 84 and 173 under them, and the second row left
878px of empty grid beside it. Two kinds of hole, one cause: a grid places by
ROW, and six cards of six different heights do not make rows.

Multi-column places by column and balances. MEASURED, as column bottoms:

    four columns   149 / 327 / 308 / 318   block 327 tall
    three          457 / 414 / 165         block 457
    two            457 / 575               block 575

`columns: 4 380px`: four is the cap, 380px decides how many of the four a desk
actually gets (1852 -> four at 454 each, 1472 -> three, narrower -> two, one).
Reading order becomes column-major, which is the pairing the file's own comment
already said it wanted.

The band above it — the AI brief and your plan — was 203 against 359, and the
plan is a FORM, so that hole is permanent rather than today's data. Stretched,
with the brief's actions pushed to the foot of the card: both cards now end in
a row of controls at the same height. A NAMED DEVIATION from this file's own
"no card is taller than its content", argued where it is made.

### THE NEWS PANEL WAS TALKING TO A DEVELOPER

    ECB   unreachable: [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify
          failed: unable to get local issuer certificate (_ssl.c:1082)

`URLError.reason` is the underlying EXCEPTION, and it was being interpolated
straight into the feed's error line — a C source file and a line number on the
screen of somebody reading the news. `reach_error` translates the four causes
that differ in what the operator can DO about them (trust the certificate, fix
the name, start the thing, wait); `reach_detail` keeps the raw for the log.
Six tests, failing first. Verified live on :8787:

    screen  "its security certificate could not be verified on this machine"
    log     [iram] rss: ECB at https://www.ecb.europa.eu/rss/press.html —
            SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] ...

### GATE

    PASS  tsc --noEmit                11.3s
    PASS  vitest                      50.4s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      10.8s
    PASS  21 scripts                  19.6s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s
    VERIFY PASSED — 7 stages, 94s total

`npm run build` -> app/dist, served and re-measured on :8787 through
`python run.py`. **NO EXE**: the owner asked for the browser and the python
build until the design is settled, and said they will say when.

---

## v60.0 — AUTONOMOUS MODE: THE WHOLE LIBRARY, AND THE COST OF LOOKING

Asked for: "there should be 2 options like manual and autonomous ... in the
autonomous mode ai will go through all the strategies and also ai can make
hybrid strategies ... and ai can save the strategy what ai made if its
profitable for future use."

Chosen by the owner when asked: recommend AND arm alerts (never orders);
on demand plus a re-check on bar close; auto-save as unproven, promotion asks.

### THE GAP THIS CLOSES

Two strategy systems had never met. The live recommendation (`setup/*`) can
only ever choose a DETECTOR — its candidates are detections on the chart, and
nothing in it is backtested. The library (`backtest/*`) tests 25 declarative
`RuleSpec`s properly — walk-forward, PBO, costs — and `promote()` returned a
verdict **no desk acted on**. Autonomous mode is the bridge.

### THE PIPELINE (all new, all pure, 57 tests before any UI existed)

  `hybrid.ts`     one rule's TRIGGER under another's CONDITION. The rule that
                  makes hybrids trade at all: a condition is an EVENT
                  (`crossabove`, true for one bar) or a STATE (`>`, true while
                  it holds), every condition is ANDed, so a hybrid of two
                  events asks for two crossings on one bar and never fires.
                  Only STATE conditions are contributed. Refusals are reported
                  with reasons: no-filter, already-in-trigger, contradiction,
                  invalid, duplicate.
  `search.ts`     REUSES `promote()` unchanged (30 OOS trades, 40% retention,
                  PBO <= 0.5) and adds the one thing missing on this path: the
                  cost of the search, via `study/stats.ts` `deflatedSharpe`.
  `discovered.ts` the shelf: provenance (symbol, timeframe, bars, costs,
                  TRIALS), status unproven/promoted/retired, and a retirement
                  rule that compares forward results with the backtest's own
                  spread rather than a fixed percentage.
  `autorun.ts`    field -> study -> judge -> keep, with the runner injected.
  `labrunner.ts`  where studies run: the gateway's workers, else this tab.
  `sweepplan.ts`, `arming.ts`, `shelfstore.ts`, `firing.ts` (UI-side, agent)

### THE RULE THAT DECIDES EVERYTHING

A winner must beat WHAT THE SEARCH WOULD HAVE FOUND IN NOTHING. Measured
hurdle in per-trade Sharpe (`deflatedSharpe`):

    trials     120 OOS trades      300 OOS trades
       25      0.21                0.13
      100      0.25                0.16
      400      0.29                0.18

So a rule scoring 0.20 over 120 out-of-sample trades, found by a 400-arm
search, is refused — `promote()` alone would have passed it. The refusal
distinguishes "none was good enough" (`all-refused`) from "the best one is
what searching this hard finds in noise" (`beaten-by-noise`), because they
ask the operator for different things.

Trials counted = every configuration of every candidate + hybrids built and
discarded + rules that FAILED to study. A field that silently shrinks lowers
the hurdle without telling anyone.

### THE FIRST REAL RUN (BTCUSDT 1h, 4,999 bars, eight cores)

    field     25 library + 60 hybrids = 85 rules
              32 pairs considered and refused, 508 never built at the cap
    compute   20.3 s of studies, 26.7 s wall, 765 configurations charged
    result    NOTHING SURVIVED. Nearest miss: "Stochastic cross in the
              extreme", -0.02R a trade out of sample. 117 rejection rows.

That is the feature working. A sweep that always finds a winner is a sweep
that has learned the noise.

### SPEC STUDIES, END TO END (the lab could only study three families)

`runSpecStudy` beside `runStudy`, both through one private `sweep()` so
walk-forward, CSCV, metrics, headline, promotion and the too-little-history
refusal cannot diverge. `Study.family` -> `Study.subject`
(`{kind:"family"|"spec"}`). The gateway's `StudyRequest` takes either,
validated, exactly one. `server/engine/lab-engine.mjs` rebuilt and grepped.

Measured, 25 specs through `POST /api/lab/studies`:

    bars    wall     serial sum   speed-up
    2,000   3.18 s   15.7 s       4.9x
    5,000   5.75 s   26.0 s       4.5x

One spec study is ~47 ms in-process and ~384 ms through a worker: spawning
Node and warming V8 is seven times the study. Hence `REMOTE_FLOOR = 8`.

### ARMING: WHAT IS REAL

`/svc/sig/watch` was checked and REJECTED as a route for discovered rules:
`sig_loop` stores a strategy NAME and `sig_worker.js` reads the built-ins out
of the frozen root `index.html`, so a `RuleSpec` can never reach it. The only
server-side evaluator that can take one is `alert_loop` (`/svc/alerts`), which
compares one delayed quote with one number. `arming.ts` accepts exactly that
shape and refuses everything else NAMING the gap. Every shipped spec is
indicator-based, so Arm is disabled in practice — with the reason on screen as
text, not a tooltip.

### DEFECTS FOUND AND FIXED

- **A job that never ran was reported as a field that failed.** A stale
  gateway answered 422 and all 85 rules came back "could not be studied";
  `labCapacity` had said yes, so nothing fell back. Now: no studies reported
  means nothing ran, so they run in the tab. A lost job recovers the same way.
  Per-study failures are left exactly as the gateway reported them.
- **`JobResult.configs` reported 12 on the refusal path** where the study
  evaluated nothing — it read `familyGrid(f).length` instead of the study's
  own `configs`. A trial count that is wrong in the generous direction lowers
  every hurdle computed from it.
- **`WalkForwardFold` discarded its out-of-sample trades.** Reconstructing a
  spread from win/loss averages understates it and flatters every strategy
  that reaches a multiplicity correction, so the folds now keep the trades
  they already computed.

### NOT BUILT, AND WHY

- **Sentiment.** There is none in this product by policy — `mishel_rss.py`:
  "No sentiment score. Every vendor sells one and none of them is
  measurable." Nothing was invented. News stays timing risk, which the
  calendar embargo already enforces.
- **Fundamentals beyond crypto.** CoinGecko covers crypto; gold, FX and
  equities get "not available" rather than a number.
- **Server-side evaluation of a discovered rule** (see arming).
- **Auto-promotion.** The owner chose: promotion asks.

### GATE

    PASS  tsc --noEmit                10.0s
    PASS  vitest                      37.2s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                       9.0s
    PASS  21 scripts                  11.2s
    PASS  ruff (deferred set only)     0.1s
    PASS  mypy (gateway, launchers)    1.1s
    VERIFY PASSED — 7 stages, 69s total
    Test Files 173 passed (173) / Tests 4108 passed (4108)

`npm run build` -> app/dist 1,894,516 bytes; exe rebuilt from it.

---

## v59.2 — THE REDESIGN, BUILT: PANEL, DRAWER, PAGES, FONTS

Asked for: "u didnt worked as per mockups why", then "/goal build all". v59.1
had built only the command bar of the v5 mockup, and called it Stage 1 as
though the rest were close behind; the screen was still mostly the old one.
This entry is the rest.

### THE RIGHT PANEL (ui/shell/dockcards.ts, ui/dockpanels.ts)
- Every card head: icon, WHO produces it (AI / You / You + AI — `CardWho`),
  PIN (lifts it above every section, in pin order) and REMOVE (off the
  column, not deleted — "+ Add panel" lists it). Pure logic in the registry:
  `layoutOrder(pinned, removed)`, `togglePin`, `removeCard`, `addableCards`,
  `shownCards`, `sanitiseIds`; persisted as `dockPinned` / `dockRemoved`.
- Shut inspector = an ICON STRIP (36px, was a 22px vertical word): one icon
  per card, pins in the accent, each opens the inspector on that card.
- `]` is a second binding for the inspector toggle; "Hide" in the summary row.
- NEW CARDS, each over a service that had no screen:
  AI read of the chart (`scan/chartread.ts` — trend, structure, pullback,
  momentum, what is marked; its pullback step reads the SAME `keyLevels` the
  Key levels card shows) · Can I trade now? (`/svc/risk/state`) · Key levels
  (`scan/keylevels.ts`) · Price alerts (`/svc/alerts`) · Whale watch
  (`/svc/onchain/*`) · Watchlist. Diagnostics (cursor, feed, series) and the
  you-owned extras start off the column.
- YOUR SAY under the verdict: Use this plan · Adjust · Not for me (with a
  reason). Recorded in `journal/says.ts` (`verdict.says` v1); Review reads it.
- DOCK_LAYOUT 3 -> 4, so the open set resets once to the new defaults.

### THE DRAWER UNDER THE CHART (ui/chartdrawer.ts)
Collapsed to one 33px row by default. Objects (AI marks per detector with
counts, toggleable; your drawings with delete), Ask the AI (the SAME session
as the Analyst desk), Positions (MT5; offline shows the reason and "—", never
0), Alerts log (fired price alerts + `/svc/sig/fired`). Measured: spans the
chart body exactly (770px at 1440), takes 220px when open.

### THE PAGES
- TODAY (ui/today/*): the brief answer-first; "Your plan" — focus list you
  keep or drop, three limits prefilled from `/svc/risk/config` and COMMITTED
  back to it, so the governor enforces them; "AI scanned your list".
- RESEARCH (ui/research/*, study/related.ts, question.ts, explain.ts): the
  1-2-3-4 steered flow on the existing study engine; AI-chosen related assets
  each with a reason and a switch; results only from what the run measured.
  FOUND: `DXY` and `US10Y` in `data/drivers.ts` never load (404); `DX-Y.NYB`
  and `^TNX` do — 14,326 and 4,201 bars where there had been zero.
- STRATEGY (ui/strategy/*, backtest/critique.ts, draftrun.ts): conversation
  -> rules tagged by author -> backtest (+2x costs) -> Monte Carlo on click ->
  12-check critique naming each number and threshold -> Keep / Paper / Discard
  with a reason. Measured on 4,999 real BTCUSDT 1h bars: 84 trades at -0.10R,
  critique found 2 weaknesses. The old lab is intact behind a disclosure.
- REVIEW (journal/patterns.ts, ui/review/*): seven fixed checks on real fills
  or the journal, each found / not-found / too-few (minN named) /
  cannot-check (missing field named); True / Not true judgements; next week's
  rule proposed only from a finding you confirmed.

### FONTS
Geist (UI, 29,400 B) and Instrument Serif (answer lines only, 400; 21,032 B),
both OFL-1.1 from @fontsource 5.3.0, Latin files vendored. Serif is used for
the verdict, "Can I trade now?" and the day's brief — never a label or number.

### MEASURED, AND WHAT IT CHANGED
- Card heights re-measured at 360px: several v5x figures had drifted 100px+
  (setup 755 -> 808, context 1002 -> 705, feed 520 -> 1006). The default
  column is now computed from measurements; Regime and Momentum start shut,
  as in the design, and the AI read carries both in a line each.
- The top bar re-measured with Geist: all five workspaces, no overflow, no
  clipping at 1024 / 1100 / 1280 / 1366 / 1440 / 1920.

### DEFECTS FOUND IN THE BUILD
- Cards polled on `isConnected`, which is TRUE for a card removed from the
  column or in a shut inspector — the Watchlist card fetched Binance from
  behind a closed panel. `ui/cards/shown.ts`: poll only while drawn, refresh
  on coming back. Test: `test/shown.test.ts`.
- Wrapping the panel head in `.card-head` broke eight `> .panel-head` rules
  silently and made the sticky header stick inside a 32px box. Found by grep
  before shipping, not after.

### NAMED COSTS / NOT BUILT
- Watchlist card keeps its own quote snapshot (the rail's is created and
  destroyed with the rail): both on screen = two Binance calls per refresh.
  The card is off by default and refreshes only while visible.
- Research: no range forecaster, so "price range" is not offered; two of the
  data library's three AI toggles are shown disabled, "Not built yet".
- Strategy: "paper trade it" records a start time and counts later trades —
  nothing is sent anywhere; there is still no order path.
- Review: the against-trend check cannot run until trades record the trend
  at entry.
- LIVE DATABASE: `onchain_watch` / `wallet_events` hold what look like leaked
  test fixtures (`0xdna111…`, `0xlead`, `PEPE`). Not deleted; the Whale card
  marks them "not a valid address". Owner's call.
- Pre-existing, still open: at 366px "More" is clipped.

### THE LOOK (added after "it looks still same", twice)

The features landed in the terminal and the owner still saw the old product,
for two separate reasons. Both are now rules in CLAUDE.md.

1. **Nothing was rebuilt.** Everything was verified on the dev server (:5173).
   `python run.py` serves `app/dist/index.html` and the exe carries its own
   copy; dist was from the night before and both exes from ten days earlier.
   `npm run build` + `server/build_binary.py --full` are now part of finishing
   a UI change.
2. **The features were the v5 design; the LOOK was not.** Measured against the
   mockup served on :5190 (`.claude/launch.json` has a `mockups` entry) rather
   than read off a screenshot:

   - **AI is blue.** `--ai` (#9DB8FF; #3B5BC4 on the light theme) for every
     tag, card edge and control that speaks for the terminal; the brand accent
     stays YOURS. `.card-who` is one uppercase pill, used on every page.
   - **The panel is five cards.** The AI recommendation (the verdict and Your
     say, one AI-tinted card, always in view), then AI read, Can I trade now?,
     Key levels, Calendar — 14px radius, 10px apart, no section headings.
     Everything else is under "+ Add panel". The head is one row, "PANELS".
     Column/Stack moved to View ▸ Inspector shows.
   - **`DOCK_DESIGN = 5`** resets a layout saved under an earlier design ONCE
     (mode, open set, pins, removals, and the watchlist rail). Without it the
     owner's saved Stack column would have survived every change — which is
     exactly what happened the first time.
   - **Two-line workspace tabs** with each workspace's lead, a 58px header,
     and the selected tab outlined rather than filled gold.
   - **Pages are full width.** The inspector and the symbol bar belong to
     Chart; `data-ws` on the shell is what the other four read.
   - **Auto-marking, Fit and Log** are labelled buttons in the chart toolbar
     (auto-detect was the fourth row of a "⋯" menu on the workspace whose
     premise is "AI-led").

### THE CHART TOOLBAR, MEASURED

With Auto-marking, Fit and Log the row needed 1,227px and had 802 at 1440 with
the watchlist rail on — and it already overflowed before them (~1,040px),
invisible on the owner's 1911px screen. Two new steps in the EXISTING measured
fit loop (`FIT_STEPS`, styles/topbar.css), cheapest loss first:

    compact   change % beside the price; the feed badge's words
    tight     the Indicators and Auto-marking labels (icon + count stay)
    tighter   Fit and Log ("⋯" and the lin/log corner still have them); a
              narrower symbol box; the current timeframe + "More"
    tightest  the feed badge; a smaller price; the chart-style word

MEASURED after, rail ON: 1280 tightest 642/642 · 1440 tighter 802/802 ·
1920 compact 1282/1282 — no overflow at any of them.

A container query was written first and had to be removed: it hid things
BEFORE the loop measured, so the loop concluded "full" fits and put the 206px
range stats back. One mechanism, not two.

### THE MEASUREMENT THAT WAS ITSELF WRONG

Four widths were measured with `data-fit` reading `undefined`, and this entry
nearly recorded "the fit loop is dead, and was dead before v59.2". It was not:
a ResizeObserver DELIVERS NOTHING IN A BACKGROUND TAB, and the pane tab had
been backgrounded by opening the mockup beside it. A control RO added in the
page fired zero times too — which is what proved it. Fronted, the loop runs and
sets `tight` in the same frame. Same class as the rAF rule already in this
file.

### GATE

    PASS  tsc --noEmit                 8.6s
    PASS  vitest                      31.7s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      18.5s
    PASS  21 scripts                  13.0s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.1s
    VERIFY PASSED — 7 stages, 73s total
    Test Files 164 passed (164) / Tests 3963 passed (3963)

Frozen v39 (root index.html, src/, tools/, dist/): 0 files changed.

---

## v59.1 — THE REDESIGN, STAGE 1: FIVE WORKSPACES, EVERY TOOL, WHAT IS RUNNING

Asked for: the v5 mockup (`docs/iram-redesign-v5.html`), approved with
"build". Built in stages; this is the first — the command bar.

### WHAT CHANGED ON SCREEN

- **Five workspaces, each saying who leads.** Today (AI briefs · you plan),
  Chart (AI-led), Research (you steer · AI assists), Strategy (built
  together), Review (AI finds · you judge). The lead shows on the CURRENT
  workspace's tab only — five at once would cost the width the tabs need.
  Ids, icons and `view.*` commands are unchanged, so saved layouts survive
  (`ui/shell/views.ts`, `WORKSPACE_LEAD`).
- **All tools** (`ui/shell/toolsmenu.ts`): 31 tools in five groups. Three
  services run with no screen yet — whale watch, smart-money wallets, new
  pairs — and are listed DISABLED as "backend only" rather than hidden (hides
  that they exist) or linked elsewhere (a menu that lies). A test fails if
  any desk has no entry, or any entry names a desk that does not exist.
- **View** (`ui/shell/viewmenu.ts`): text size S/M/L, inspector width, and
  three layouts (Chart focus / Balanced / Analysis). NO NEW SETTING: it
  writes `state.density`, `appearance().dock` and `dockToggle` — the same
  signals Settings and the B key write — so it cannot disagree with them.
  Measured: S/M/L -> type scale 0.92/1/1.09, Analysis -> 470px inspector,
  Balanced -> 370px, Chart focus -> 32px rail.
- **The status strip** (`ui/shell/statusstrip.ts`, `data/status.ts`):
  alerts armed on the server, strategies armed, risk (live/blind), MT5
  (on/off), background services (n/m). The first surface for
  `/svc/health`'s loop report — eleven loops ran with nothing on screen.

### TWO HONESTY DEFECTS, CAUGHT BY READING THE SERVER BEFORE THE TESTS

Both failed first (3 tests red before the fix, green after):

- **`loops` lists only loops that have TICKED.** `LOOP_TICK` is filled on
  a loop's first tick, so with `IRAM_BACKGROUND` unset `/svc/health` says
  `loops: {}` — and "0/0 running" rendered GREEN as "all running". It is
  now amber: "No background service has reported yet, so alerts and armed
  signals are not being checked." The running gateway on this machine was
  exactly in that state when the strip was first opened.
- **A failed watch-list request read as "0 armed".** `armedSignals` is now
  `number | null`; null shows a dash and says the list could not be read.

### THE ROW BUDGET, MEASURED

The new controls took 356px, and at 1440 the deskbar got 458px of the 546
the five workspaces need: Strategy and Review went into "More" at the most
common laptop width. Fixed by an explicit order of what gives way, stated
once above the rules in `styles/shell.css`:

    <=1600  status values hide (icon keeps the standing colour; title keeps the reading)
    <=1500  search collapses to its icon (was 1100)
    <=1280  lead text, and the dock/focus icons (duplicated in View, with keys)
    <=1100  status strip and the account chip's risk %
    <=900   View
    <=600   All tools — at 375 its 76px took the deskbar to 0px: no tab, no More

Measured after, spilled workspaces / command-bar overflow:
1920 none/0, 1440 none/0, 1366 none/0, 1280 none/0, 1100 none/0,
1024 none/0, 768 two/0, 375 four (+More)/0.

**Pre-existing, not fixed:** at 366px the deskbar gets 69px, the current
tab is 86px, and "More" is clipped out of sight. Identical with every v59.1
control hidden, so not a regression — but a phone with no visible way to
change workspace except the IRAM menu. Next: the account chip is the
candidate to yield there.

### GATE

    PASS  tsc --noEmit                10.1s
    PASS  vitest                      35.5s
    PASS  tests/ fully listed          0.0s
    PASS  pytest                      11.3s
    PASS  21 scripts                  13.3s
    PASS  ruff (deferred set only)     0.2s
    PASS  mypy (gateway, launchers)    1.2s
    VERIFY PASSED — 7 stages, 72s total
    Test Files 147 passed (147) / Tests 3656 passed (3656)

New: `test/status.test.ts` (13). Changed: `test/deskbar.test.ts` (new
grouping, lead on current workspace only, every workspace has a lead).
**No automated test** for the give-way order — it is CSS measured in the
browser at eight widths, recorded above.

### NEXT (stage 2)

Right panel: pin / add / remove cards, icon strip when hidden; the
collapsed Objects / Ask AI / Positions / Alerts drawer under the chart.

---

## v59.0 — A DATABASE SEAM, AND THE FIRST SPLIT

Asked for: "this project is a single file with big code 102k or more, so can
you split it by use case so I can modify, debug or upgrade it more easily
without use of massive tokens. Also I have to upgrade the database part to
PostgreSQL, so if it's feasible do it in a systematic way."

### TWO PREMISES, BOTH MEASURED AND BOTH WRONG IN A USEFUL DIRECTION

It is not one 102k-line file. It is **251 TypeScript files totalling 103,273
lines**, and the largest single file is `ui/shell.ts` at 6,649. The problem is
real — you cannot edit the shell without loading 6,649 lines — but "a few files
are too big" is a far better position than "one giant file", and the fix is
different.

And the database is not spread through the codebase. Every one of the 17
tables and all 79 query sites already funnelled through ONE function,
`db()` on line 129 of `mishel_service.py`. That is what made Postgres feasible
in an afternoon rather than a fortnight.

### THE POSTGRES DEVIATION, NAMED

CLAUDE.md lists PostgreSQL under "What is deliberately NOT taken from the kit":

    The product is a single executable that needs no install. Requiring two
    servers to start it is a regression against its main advantage.

That reason still holds, so Postgres is an OPTION rather than a replacement.
`IRAM_DB_URL` selects it; unset, everything behaves exactly as `sqlite3.connect`
did and the packaged binary is untouched. Nobody downloading `iram-full.exe`
installs anything, and nobody wanting a real server for a multi-machine setup
has to run SQLite over a network share — which is the failure that makes people
want Postgres in the first place. The full argument is at the top of
`server/db/driver.py`, where anyone changing it will read it.

### THE SURVEY CAME BEFORE THE CODE

Counted across `mishel_service.py` rather than assumed:

    INSERT OR REPLACE   5      AUTOINCREMENT   7      executescript   1
    INSERT OR IGNORE    7      PRAGMA          0      executemany     0
    ?  placeholders   151      lastrowid       0      ROWID           0

and three `strftime` calls, ALL of which turned out to be Python's
`time.strftime` and none of which are SQL. The date-function rewrite that a
migration like this usually drowns in does not exist here, and knowing that
cost one grep.

### SEVENTY-NINE CALL SITES DID NOT CHANGE

`server/db/` is four files. `sqlrewrite.py` translates the dialect — `?` to
`%s`, `INSERT OR REPLACE` to `ON CONFLICT ... DO UPDATE`, `INSERT OR IGNORE` to
`ON CONFLICT DO NOTHING`. `driver.py` wraps psycopg in `sqlite3.Connection`'s
interface, because the service uses three conveniences psycopg lacks:
`.execute()` on the connection, a row that indexes by BOTH name and position,
and a `with` block that COMMITS rather than closes. `schema.py` holds the DDL,
moved verbatim. `__init__.py` is the import.

Rewriting all seventy-nine sites instead would have been a diff nobody could
review, would have broken every one of them for SQLite, and would have to be
done again for the next backend.

### THE TWO THAT FAIL SILENTLY

**`REAL` is not `REAL`.** SQLite's is an 8-byte double; Postgres' is a 4-byte
single with about seven significant digits. Every timestamp in this schema is
`t REAL` holding epoch seconds, which needs ten. Untranslated, a Postgres
install would round every timestamp and every price and nothing would raise.
`REAL -> DOUBLE PRECISION` is one line in `_DDL_SUBS` and is the difference
between a migration and a database of rounded numbers.

**`%` is a format specifier.** psycopg scans the whole statement, quoted or
not, and this codebase contains exactly one literal percent:

    SELECT kind, MAX(t) mt FROM events WHERE kind LIKE 'data_%' GROUP BY kind

Every `%` is doubled BEFORE `?` becomes `%s`, because the other order would
double the `%` just introduced.

### THE TEST THAT FAILED ON ITS FIRST RUN, CORRECTLY

`CONFLICT_KEYS` started life named `PRIMARY_KEYS`, and a test comparing it
against the real DDL failed immediately on `onchain_watch`: the map said
`wallet`, the schema said `id`. Both were right about different things —
the table has a surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT` AND
`wallet TEXT UNIQUE`, and the conflict that can actually HAPPEN is on the
wallet, because a fresh id never collides. Targeting the primary key there
produces an upsert that never fires and inserts a duplicate per attempt.

So the concept was wrong, not the value: it is a CONFLICT TARGET, not a primary
key, and the name now says so. `wallet_events` has the same shape, keyed on
`hash`. The test now asserts the target is either the declared primary key or a
declared UNIQUE, and a second test asserts a surrogate id is never the target.

### THE SPLIT, AND WHAT IT COST

`study/run.ts` 1,093 -> **600**, with `study/steps.ts` at 538. `runOne` plus
its fourteen step runners is a separate responsibility from the orchestration,
the correction and the limits — a boundary the backlog had already measured and
declared ready. A pure move, only because v57 replaced the module-level `let`
that carried the winning sweep with a carrier on the step input; across a file
boundary that would have become a mutable global shared by two modules.

### THREE SELF-INFLICTED ONES WORTH KEEPING

**A script that reported success by not running.** The import-pruner shelled
out to `npx tsc`, parsed the output for errors, found none, and printed "clean"
— because the compiler had not run at all and produced an empty string. It had
already deleted `import {` from a multi-line clause on the previous pass, so
the file was a syntax error at the moment it was declared clean. Absence of
errors is not evidence of success when the thing producing them can fail to
start. The replacement checks the return code and refuses to edit when any
non-import error is present.

**`\b` through a shell-quoted heredoc becomes a backspace.** Two regexes in a
test arrived as `UNIQUE^H` and `^HUNIQUE`, matched nothing, and made a correct
table look like a broken one. This session has now hit shell-mangled escapes
three times; the standing rule is to write Python to a FILE and run the file.

**Deleting "the line" for a multi-line import.** TS6192 reports the line a
declaration STARTS on, and this codebase writes long import clauses across many
lines. Removing one line left the bindings dangling.

### VERIFIED, AND WHAT IS NOT

SQLite is verified end to end: `verify.py` green at 7 stages, the service
booting on the new package, `/svc/health` answering with real row counts, ten
loops turning, and the database it is using now reported in that payload
(passwords never printed).

**Postgres has never talked to a real server on this machine.** psycopg 3.3.5
is installed; Docker is installed but its daemon is not running, and starting
it is a bigger change to the owner's machine than this warranted. So the
translation and the adapter are unit-tested on every run — 30 tests — and the
ROUND TRIP lives in `tests/test_db_postgres_live.py`, which skips with a stated
reason unless `IRAM_DB_URL` is set and runs for real where it is:

    docker run -d --name iram-pg -e POSTGRES_PASSWORD=iram -p 5432:5432 postgres:16
    IRAM_DB_URL=postgresql://postgres:iram@127.0.0.1:5432/postgres python -m pytest tests/test_db_postgres_live.py -v

That file is the one that proves what no unit test can: the translated DDL is
accepted, every conflict target names a constraint that exists, and an epoch
timestamp survives the type change.

### THE SECOND SPLIT: A TOOLKIT, AND A FACADE

`server/svc/core.py` (206 lines) now holds what every section of the service
leaned on and nothing imported FROM — auth, the per-host circuit breaker, the
liveness tick, `cfg`, `log_event`, the three yfinance readers and `send_tg`.
The bottom of the dependency graph moves first; the rest becomes divisible.
`mishel_service.py` 1,765 -> 1,635.

IT HAD TO BECOME A FACADE, and that is a constraint rather than a preference.
`gateway/background.py` starts all eleven loops with
`getattr(mishel_service, name)`, and twenty-one standalone test scripts reach
for `svc.app`, `svc.db`, `svc.cfg`, `svc.yf_bars`, `svc.SCHEMA_V`. Those names
have to remain attributes of that module, so the implementations moved and the
names did not. Verified directly: 11 of 11 loops still resolve by `getattr`,
and the live service reports `stale_loops: []` with all eleven alive.

`backup_loop` deliberately stayed behind: it copies the SQLite FILE and is
meaningless under Postgres, so it needs rethinking rather than relocating.

### TWO THINGS THE SPLIT BROKE, BOTH INSTRUCTIVE

**A bootstrap that covered some of the imports it existed for.** The
`sys.path.insert` that makes this module loadable by PATH sat between the two
local imports. The day `svc.core` was extracted, the new import landed ABOVE it
and every path-loaded test script died on `ModuleNotFoundError: No module named
'svc'`. It now sits above both, with a comment saying why it is there and not
three lines lower.

**A re-exported name is a SECOND binding.** `test_service_v392_loops.py`
patches `tick` and asserts `sleep_ticking` calls it repeatedly. Both used to
live in `mishel_service`, so patching `svc.tick` patched the object the
function actually called. After the move, `sleep_ticking` resolves `tick` in
`svc.core` — and rebinding the re-export left the original untouched, so the
test counted zero ticks and failed honestly. Patch the module that OWNS a
function, never the one that re-exports it. The behaviour under test did not
change; where it lives did.

### FIVE WORKSPACES (redesign phase 1)

The 23 desks are regrouped into five workspaces, one per step of a trade:
**Today** (the Briefing), **Scan** (Opportunities, Watchlist), **Trade**
(Chart first, then Decision, Smart money, Flow, Sessions, Risk, Calculator,
Paper, Signals, Analyst, Workspace), **Review** (Journal with broker fills,
Learning) and **Lab** (Analyse, Strategy, Playbook, Conditions, Knowledge,
Quant, Data). Desk ids, `view.*` commands and shortcuts are unchanged.

A workspace button now takes you IN: clicking one you are not in opens the
desk you last used there (Trade opens the chart), clicking the one you are in
opens its menu. The label is the workspace alone — "Trade · Flow" was tried
and pushed Review and Lab into "More" at 800px.

Making five tabs always fit exposed three layout defects in the desk bar,
each measured, each fixed: the bar sized itself by what it was showing (a
self-confirming spill), the fit test ignored the gaps (a clipped tab reported
as fitting), and it never re-measured when the tabs grew as the font loaded.
Measured after, on the Chart desk: nothing spilled and nothing clipped at
1440, 1280, 1110 and 1024px; at 760px Review and Lab go to "More" cleanly.
The search field now gives way first and shows only its icon below 1100px
(Ctrl+K still opens it). 7 new tests in `test/deskbar.test.ts`.

### PLAIN WORDS, AND YOUR FILLS IN THE JOURNAL

**Jargon pass**, at the owner's request ("remove unwanted jargon text"),
style chosen by them: plain and short, long explanations behind "Why?", real
trading terms kept. Covered the surfaces read most: the Setup card and its
checks (`setup/gates.ts` gained `Gate.why`, rendered with the existing
`pkWhy`), the setup engine's refusals, the verdict headlines, the dock
verdict, live-analysis events, the Briefing, the decision lanes' reasons, the
track-record line and the Feed & network panel. ~50 test assertions that
pinned exact sentences were moved to pin the FACT instead. NOT yet done: the
Regime panel text (it lives in `shell.ts`, which a parallel task was editing),
detector reasons, and the individual desks.

**A bug the new wording made visible.** With no setup there is no plan, the
view passes a stop distance of 0, and the card said "Stop is 0.00× ATR — too
tight, widen it to 0.5× ATR" about a stop that did not exist. Failing test
first; now "No plan yet — no stop to check." Fixing it exposed a SECOND one in
the same block: the can't-measure branch ended with `return gates`, so the
track-record check silently disappeared whenever ATR was missing. The stop
check is now `stopGate()`, one gate out, no early return. And the half-done
first fix pushed TWO stop gates — `find` returned the first, so its test
passed; the test now asserts exactly one.

**Your MT5 fills, in the Journal.** `data/fills.ts` calls `/svc/mt5/sync`
(pull deals from the terminal) and `/svc/recon` (round trips, graded against
your journal plans by `server/mishel_recon.py`); `ui/fillspanel.ts` shows them
as a read-only "Broker fills" panel — net P&L, costs, plan adherence, and per
trade: how it ended, R, hold time. Fills are NOT turned into journal entries:
an entry needs the stop you intended and a fill does not carry one, so that
would be invented data. 12 tests. Verified in the browser three ways: the
empty state, MT5's refusal passed through ("No module named 'MetaTrader5'"),
and a populated panel from the REAL reconciliation code run on synthetic
deals, injected into the page only (nothing stored).

**On this machine the backend's Python has no `MetaTrader5` package**, so a
real sync refuses. `pip install MetaTrader5` in that environment, with the
MT5 terminal running and logged in, and Sync works.

### THE SHELL: 6,649 -> 5,217

Seven lifts out of `mountShell`, each a programmatic text move, each with its
imports resolved from the shell's own import lines rather than retyped, each
verified in the browser as well as by the gate:

- `ui/model/setup.ts` (850) — the Setup card's view. 17 read-only inputs,
  over the <=10 rule, and argued as a named deviation in the file's header.
  Its four OUTPUTS (`lastChoice`, `lastSim`, `lastRMultiple`, `lastRec`) had
  been shell-level `let`s written from inside a computed; they are now
  `setupLast`, owned by the model. Verified on ETHUSDT 1h: the card, the dock
  verdict's label and `__iram.sim` all agree — 37 of 64, 58%, at 1R.
- `ui/shell/desks.ts` (325) — eleven desks and the agent desk, 5 siblings.
  All eleven opened in the browser with no error.
- `ui/shell/dockverdict.ts`, `ui/model/live.ts`, `ui/model/outlook.ts`,
  `ui/model/readings.ts` — the dock's derivations and its verdict.
- `ui/model/studies.ts` — see the `any` below.

`num` and `fmtPx` moved to `shell/format.ts`, where the other formatters were.

What it turned up:

- **The measuring tool under-reported twice.** `extract.py` missed
  destructured declarations (202 counted, 234 real). Its replacement,
  `scratchpad/deps.py`, then missed every SPREAD read: `...workspaceSeries()`
  looked like a member access. Found because a desk's measured dependency list
  did not contain a name visible in its source. Fixed and re-run against the
  earlier decisions; none changed, and none could have been wrong in effect —
  `tsc` fails any extraction that misses a name — but the COUNTS the rule
  decides on were low.
- **Three lying section comments**, listed in CLAUDE.md.
- **`studies` was typed `any`** in `terminalaccess.ts` and narrowed by hand in
  `risk.ts`; both now derive `Studies`.
- **Four `ReferenceError`s in the console during the work, none in the
  product.** Vite hot-reloaded half-written files while the import fixer ran
  `tsc` three times; the four errors' reload stamps are eight seconds apart,
  which is the fixer's rhythm. A clean reload since shows none. Recorded
  because "errors in the console" read without the timestamps would have been
  a false alarm or, worse, a real one dismissed.

### THE SERVICE, SPLIT BY USE CASE: 1,792 -> 414

Every section of `mishel_service.py` now lives in `server/svc/`, one module per
use case, each a Flask blueprint: `onchain` 428, `mt5` 243, `research` 219,
`core` 206, `risk` 172, `sync` 155, `signals` 141, `features` 119, `alerts` 86.
`server/svc/README.md` is the map. The facade keeps the app, auth, database
hook, health, heartbeat, the small ledger, `backup_loop` and `__main__`.

How it was proven to be a MOVE and not a change:

- the route table — method and path for all 53 — was dumped before the first
  split and diffed after every one: identical each time;
- `getattr(mishel_service, name)` resolves 11 of 11 loops;
- a live boot on a temp database, `IRAM_BACKGROUND=1`: `/api/health` reports
  11 alive, ten of the moved routes answer 200 with their honest empty
  states, `data_loop` wrote to the feature store from its new module, and the
  log is clean;
- `python verify.py --lint`: 7 stages passed.

What the split turned up, in the tests rather than the code:

- **Two tests patched a re-export.** `test_service_v230` rebound `m.send_tg`
  to capture messages and `test_service_v370` rebound `svc.PROXY` to force the
  "bridge unreachable" path. Both now patch the owning module. `PROXY` was
  given ONE owner (`svc/mt5.py`) and `risk.py` reads it as `_mt5.PROXY` at
  call time, so a single rebinding reaches both sections.
- **One test reached a library through the facade.** `test_service_v3930`
  patched `svc.requests.get`. That patches the shared `requests` module, so
  it kept working — but only while the facade happened to import `requests`,
  which it no longer needs. It imports `requests` itself now.
- **A check that had never run.** `test_service_v240` exited before its last
  check. Moved above the exit; passes.
- **Coverage that would have leaked away.** `test_db_rewrite`'s
  conflict-key check read only the facade. It reads `svc/` too now.
- **The binary would have shipped without any of it.** The service imports
  `svc.*` after a runtime `sys.path` insert PyInstaller cannot follow.
  `svc`, `svc.core` had never been added to `HIDDEN` either. All ten are now,
  and `tests/test_build_hidden_imports.py` fails the gate when one is missing
  — proved by deleting an entry and watching it fail. **The binary has NOT
  been rebuilt**; the next build is the first to carry the split.
- `sig_worker.js` is found from `__file__`, and `signals.py` is one directory
  lower than the facade. Resolved from the parent; `test_service_v350`'s real
  Node round trip passes.

### COST

`server/db/` 566 lines across four files. `mishel_service.py` 1,792 -> 1,635 across the two extractions.
`server/svc/core.py` 206. The database extraction was the enabling change
and the toolkit extraction was the first real split; the remaining use cases
are listed under Known backlog.
Tests: `test_db_rewrite.py` 255, `test_db_adapter.py` 189,
`test_db_postgres_live.py` 154 — 30 passing, 8 skipped. Gate: 7 stages, 51s.
`db`, `db.driver`, `db.schema` and `db.sqlrewrite` added to the frozen bundle's
hidden imports, because the service inserts its own directory into `sys.path`
at RUNTIME and PyInstaller's analyser cannot follow an import that depends on
it.

## v58.0 — THE ACCOUNT IS REAL NOW

Asked for: "I have many functions but it's not making use — let's make a full
plan how to structure this and add more functions so I can use it as a
professional trading platform." Then, having seen the audit: build phases 1-3
in order, and yes to real order placement with guards, on the MT5 bridge.

### THE AUDIT, BECAUSE THE ANSWER WAS NOT WHAT THE QUESTION ASSUMED

"Many functions not being used" sounds like dead code. It is not. Of 908
exported functions, **40 are genuinely unreachable** and nearly all of them are
trivial helpers. The analysis engine is tight.

What is not tight is the SEAM TO REALITY. Measured: **36 of the 48 `/svc` and
`/mt5` routes the backend serves are never called by the frontend.** Among
them `/mt5/account`, `/mt5/positions`, `/mt5/deals`, `/svc/risk/check`,
`/svc/alerts`, `/svc/telegram`, `/svc/ledger`, `/svc/recon`.

So `ui/risk.ts` said, out loud, "No positions recorded. Add the ones you are
actually in", and `core/account.ts` held an equity defaulting to 10,000 —
while the broker's real answer sat one unwired HTTP call away. Portfolio heat,
the correlation clustering that warns two positions are one bet, the
Briefing's "where you stand" and every lot size the calculator returns were
answers about a hypothetical account. Correct for their inputs; the inputs
were a guess.

There is also no execution path anywhere: `grep` for `order_send` across the
backend returns nothing. The bridge is read-only.

### WHAT LANDED: ONE BOOK, AND IT SAYS WHERE EVERY ROW CAME FROM

`data/broker.ts` is the client. Its result union has FOUR arms, not two,
because the four situations have four different things to do about them and
collapsing them into "no data" sends people to look at the wrong thing:
`ok`, `unavailable` (wrong OS, no package — nothing you do here fixes it),
`disconnected` (MT5 is shut — start it), `offline` (the gateway is down — run
`python run.py`). On the dev machine the honest answer is `unavailable`, so
that is the path that got the most attention.

`trade/book.ts` reconciles. The Risk desk goes on owning the HAND-ENTERED
rows, because those are the operator's input and must stay editable; the
broker owns what it reports; and the third state is the one that matters:

  **unmatched** — hand-entered, the broker IS connected, and it does not
  report this position. NOT counted, listed, with one click to say "it is real
  and it is at another venue", after which it counts.

Silently keeping it overstates risk; silently deleting it loses a real
position. Neither is acceptable, so the operator decides and the screen says
which rows the figures were computed from.

### THE 100,000x DEFECT THAT WAS ABOUT TO BE INTRODUCED

`portfolioHeat` computes `risk = (entry - stop) * qty * contractSize`, with
`contractSize` DEFAULTING TO 1 when absent. MT5 reports `volume` in LOTS. One
lot of EURUSD is 100,000 units, so a 20-pip stop on one lot is $200 of risk
and would have been computed as $0.002 — a risk desk reporting a flat book on
a fully loaded account, with total confidence. Same class as the v47 pip-value
bug.

So a broker row whose contract size is not known is `unsized`: shown, NOT
counted, and the book carries a refusal saying every figure below is a FLOOR.
A manual row is never unsized — the operator typed the quantity in whatever
unit they meant. Proved by mutation: making unsized rows count, and treating a
stop of zero as a price, fails 4 of the 17 tests in `test/book.test.ts`.

**A stop of ZERO is no stop.** MT5 reports it as the number, not as null. Read
as a price it makes the stop distance the entire entry price — a position
"risking" its whole notional. `hasStop` is the single place that knows it.

### A THIRD NAME, NOT A SECOND WRITER

`core/account.ts` exists because equity was stored twice and produced a lot
size 2.4x too large. A broker creates exactly that situation again, so it got
a third NAME rather than a second writer:

  `account`   — what the operator entered. Persisted, editable, never
                overwritten by a broker.
  `live`      — what the broker says. NOT persisted: a stored broker equity is
                indistinguishable from a typed one the moment MT5 closes, and
                would go on sizing trades off last Tuesday.
  `effective` — the one every lot size and risk figure must be computed from.

`riskPct` is ALWAYS the operator's. A broker reports what you hold; it has no
opinion about how much of the account you are willing to lose on one trade,
and letting the field through would silently resize every position.

### VERIFIED END TO END, WITH THE ARITHMETIC DONE BY HAND

The disconnected path was verified against the real bridge on a machine with
no MetaTrader5: it names the actual reason and offers Reconnect. The connected
path was verified with the bridge responses stubbed IN THE PAGE (nothing in
the product fabricates them), two positions and one instrument deliberately
not served so the unsized refusal fired:

  EURUSD 1 lot @ 1.10000, stop 1.09800 -> 0.002 x 1 x 100,000 = $200
  XAUUSD 0.5 lots @ 2380, stop 2390    -> 10 x 0.5 x 100      = $500
  $700 / 24,402.15 equity = 2.868%

On screen: chip **LIVE 24,402 USD 1%**, Open risk **2.87%**, Gross exposure
**229,000.00**, net **-9,000.00**, Positions **2**, status bar HEAT **2.9%**.
Every figure reproduces by hand.

### THE ONE I ALMOST SHIPPED WRONG

The first pass wired the command bar, the Briefing and the shell's heat — and
MISSED the Risk desk's own metrics, which still read `positions()`. So the
desk whose entire job is risk would have shown heat from the hand-entered rows
while the chip beside it showed the broker's equity: two numbers, two books,
side by side. Caught in the browser, not by a type or a test. The desk now
takes a `counted` SIGNAL — a signal and not a thunk, because the desk is built
eagerly, its `heat` computed evaluates during construction, and the broker
model cannot exist yet since reconciliation needs this desk's own rows.

A hand-written dependency stub went with it: `decision.ts` declared
`riskDesk: { positions(): readonly unknown[] }` and used only `.length`. It
now asks for `openPositions: () => number` — the fact it needs, not a narrowed
copy of a module. CLAUDE.md forbids that stub shape and it has caused three
defects here.

### AND A TEST THAT WAS WRONG ABOUT THE FRAMEWORK

Four of the new account tests failed because they read `effective()` on the
same tick as the write. `computed` is an `effect` that writes a signal, and
`effect` re-runs on a MICROTASK — so a synchronous read after a write returns
the previous value. Correct behaviour; the tests now yield first, and say so.

### COST AND WHAT IS NOT DONE

`data/broker.ts` 271, `trade/book.ts` 253, `ui/model/broker.ts` 202,
`ui/bookpanel.ts` 236, `test/book.test.ts` 225, plus the account seam and its
six tests. **3,618 tests in 144 files**, up from 3,595 in 143. Gate: 7 stages,
59s, green.

NOT DONE, and named rather than left to be discovered:
  - `/mt5/deals` -> the Journal. The modelling decision inside it is real: MT5
    deals carry NO STOP, so an imported trade has no R, and the journal's
    `stop` is a required number. Writing `stop = entry` would fabricate a
    breakeven stop that never existed. The answer is a read-only "filled"
    list that states what the broker knows and asks the operator for the one
    thing it does not — built end to end, not as an unreachable module.
  - The Trade Plan object (phase 2), the background surfacing (phase 3), and
    order placement (phase 4, authorised).

## v57.0 — THE STUDY: THE PRODUCT GETS A SPINE

Asked for: "think like a trader financial expert and user… if I say I will
analyze the market like an algo, what will I do. In the analyze menu there
should be some options: which asset I will analyze, for example BTC. So which
other correlated asset should be selected… then how much data I need for
machine learning, maybe 3 year or 5 year. Then what I can do with the data
like simulation probability strategy backtest… also I can automate it. Make
the product purposeful." Then: "build all, make the whole product functional."

### WHAT WAS ACTUALLY MISSING, AND IT WAS NOT A FEATURE

Every engine this desk needs already worked and every one of them shipped.
The sweep is `backtest/lab.ts`, the purged walk-forward and the CSCV are
`backtest/validate.ts`, the regime labels are `backtest/regime.ts`, the
leak-free join is `data/panel.ts`, GARCH and the calibrated classifier are the
quant service, Benjamini-Hochberg is `backtest/resample.ts`. Six desks, six
questions, six different sets of bars.

Which is exactly the problem. **Nothing could point them at one set of series
over one window, and nothing knew how many hypotheses had been tested in
total.** Running eleven methods and reporting the best one is not eleven
pieces of evidence; it is one piece of evidence and ten chances, and no desk
could say so because no desk knew what the others had tried.

`study/` is the object that makes the count possible: a question you name,
save, re-run next week and compare against what it said last time.

### THE FOUR STEPS ARE THE OPERATOR'S OWN SENTENCE

SUBJECT — the instrument, the bar size, the horizon, and a table of series
each carrying a ROLE. Four roles with four different consequences, which is
the test of whether a distinction is real: a **driver** may predict and enters
the feature matrix; a **peer** enters it but is not independent evidence (two
peers agreeing is one market agreeing with itself — `universe.ts` makes the
same argument about ETH in BTC's bloc); a **regime proxy** does NOT enter it
and slices the result instead, because a feature that says volatility is high
when it is high teaches nothing; a **control** is there to be beaten.

METHOD — fifteen cards in four groups, each carrying its cost and its
requirement, each greyed WITH THE REASON, and each declaring how many
hypotheses it tests. The last step of every pipeline is not in the catalogue
and has no control.

RUN IT — cadence, what happens to the answer, and guards. Arming a finding as
a live signal is locked in the DOMAIN (`armable`), not merely disabled.

FINDING — the headline, every step's card including the ones that refused, the
correction, and a "what this does not establish" box derived from what
actually happened in that run rather than from a fixed paragraph.

### THE JOINT WINDOW IS THE HONESTY THIS DESK IS BUILT AROUND

Asking for five years does not give you five years of study. A joint study
needs every series to cover the SAME bars, so the window is the intersection,
and the intersection is set by whichever series the archive is thinnest on.
Every tool that quietly returns the intersection produces a result about a
different period than the one asked for, and the operator finds out when two
studies with identical settings disagree.

So `jointWindow` returns the shortfall as a VALUE, naming the series and its
bar count, and the Subject step prints it beside the control that caused it.
MEASURED live: BTCUSDT 1h against five series over a 3-year request gave a
3-year joint window and **26,296 aligned rows**, split 15,720 / 5,240 / 5,241
with 48-bar embargoes — and a callout naming DXY and US10Y, which loaded no
bars from any source and are therefore not in that window at all.

### FOUR DEFECTS THE DESK ITSELF FOUND, ALL BY USING IT

**Nothing was ever blocked.** The catalogue read its verdicts out of the PLAN,
and the plan holds only what is already SELECTED. So all fifteen cards
rendered available — on a study whose one Driver had loaded no bars — and the
only way to discover a method could not run was to click it. `stepAvailability`
is now exported from `plan.ts` and called by both the card and the plan, so
the two cannot disagree. Five tests, all asked with an EMPTY selection, which
is precisely the state the plan cannot answer for.

**A failed series was silently dropped from the window and still counted as a
column.** `fetchOne` returns null on a failure so one dead vendor does not
abandon the other five — correct, and it means `loaded` quietly holds fewer
series than the study was configured with. The panel reported "3 years" over
whatever survived. The window now names what is missing, and the method
context counts columns from what LOADED rather than from what was asked for.

**The deflation was applied to the wrong units.** `metrics.ts` annualises
Sharpe by sqrt(barsPerYear); the standard error sqrt((1 + S^2/2)/n) is the
error of a PER-OBSERVATION Sharpe. Feeding one into the other mixed a figure
scaled by sqrt(8760), a trade count, and a formula expecting neither.
MEASURED on a live BTCUSDT study: an annualised **4.93 over 77 trades deflated
by 0.85** — a correction that looked like it had happened. The quantity
deflated is now the selected rule's PER-TRADE Sharpe over its own trades, in
sample, which is what the deflated Sharpe ratio is defined on. The same study
then read **0.15 -> -0.07**, and with all three rule families swept,
**0.10 -> -0.23 over 36 hypotheses**. That is the product working: the best of
36 rules is not distinguishable from the best of 36 coin flips, and the
headline now says so instead of burying it under "all three conditions are
represented in this window".

**"The joint window holds 0" before any window was measured.** Zero is a
measurement; not having looked is not. `MethodContext.checked` separates them.

### THE MODULE-LEVEL HANDOFF THAT WAS A LATENT BUG

The sweep passed its winner to the excursion and Monte-Carlo steps through a
module-level `let`. It worked only because one `runStudySpec` call holds the
thread start to finish; two studies at once would have measured the second
one's excursions against the first one's trades with nothing on screen to
suggest it. Replaced by a carrier on the step input — per run, not per module
— which also fixed a second thing: the winner is now the best across the three
rule families on the walk-forward figure, where before it was whichever family
ran last.

### WHAT IS MEASURED, WHAT IS A GUESS, AND THE SCREEN SAYS WHICH

Every method declares a cost. That declaration is a GUESS, and it is rendered
in the faintest text role and italicised until this machine has actually run
that step once, at which point `recordTiming` folds the real figure in over a
16-run window and the label changes to "measured". A terminal that prints
"estimated 2m 14s" has made a claim; a claim sourced from a constant somebody
typed is a different thing from one sourced from the last time this machine
did this work.

The parameter budget does the same for the data: **15,720 training rows at a
24-bar horizon, consecutive labels sharing 23 of their 24 bars, so about 655
independent observations, so about 32 free parameters** — with the 20
observations-per-parameter stated on screen as a convention rather than a
result, and an invitation to halve it.

### ONE THING THE DESK SURFACED THAT WAS NOT ITS OWN

`engine.ts` printed "only 1 trades — too few for the statistics to mean much"
on every thin fold. Shipped for a long time, visible nowhere anybody looked,
and on the first real report this desk produced it appeared twice. Fixed where
it is generated rather than where it was noticed.

### THE SCHEDULE NOW FIRES, AND THE SCREEN SAYS EXACTLY HOW FAR IT GOES

The cadence, the guards and the decay read were all implemented and NOTHING
CALLED nextRunAt — a Daily button that stored a preference. A minute tick in
the desk state now runs the oldest due study, one per tick, re-checking the
guard at run time rather than trusting the timer (another tab may have changed
the record since). It fetches into its own series list rather than the desk-s
own, so a scheduled run of a different study cannot redraw the coverage table
somebody is reading.

The effect has no dependencies, so it starts when the desk is first BUILT and
keeps ticking for the session — including on other desks. That is correct and
it is not "while Analyse is on screen", so the sentence under the cadence
buttons says the accurate thing. A schedule whose real scope differs from its
description by one word is a schedule nobody can plan around.

VERIFIED by seeding a saved study due immediately and leaving the tab alone:
one run recorded 75 seconds later, 8,764 rows, 57ms, failure counter 0.

Not a background service. Nothing runs with the terminal closed; that belongs
with the eleven server-side loops in gateway/background.py and needs a backend
runner this does not have.

### COST

`study/` 2,304 lines across 9 files, `ui/study/` 1,489 across 5,
`styles/study.css` 1,341, 948 lines of test in 3 files. 93 new tests,
mutation-checked: breaking the horizon correction in the parameter budget,
inverting the lead-lag sign, or making lead-lag under-report its test count
fails 6 of them. Bundle **1,388 kB -> 1,494 kB**. Gate: 7 stages, 55s, all
green; **3,595 tests in 143 files**, up from 3,502 in 140.

`study/run.ts` is 1,096 lines and is on the backlog: `runOne` plus fourteen
step runners is a separate responsibility from the orchestration, and the
split is clean now that the module-level handoff is gone. Not done in this
change — it is a pure move with no behaviour in it, and doing it at the end of
a build is churn dressed as tidiness.

## v56.0 — THE RENOVATION: A FRONT DOOR, AND A MODEL LAYER UNDER THE SHELL

Asked for: "restructure the whole functions and design like renovation". Two
halves, both measured.

### HALF ONE — THE SCREEN HAD NO FRONT DOOR

Twenty-one desks behind five dropdown menus, and the terminal opened on a
chart of whatever instrument was last looked at. Every question the product
can answer WAS answerable; none of them was answered until you knew which of
the twenty-one rooms to walk into.

`ui/briefing.ts` is that room. Six cards, one question each, in the order a
trade asks them: where you stand, this chart, what changed, where else to
look, what fired, what kind of market this is. It is the default view on a
first run — and only on a first run, because `view` is persisted, so nobody
already using the terminal is moved.

IT STATES NO NEW FACTS, AND THAT IS THE WHOLE DESIGN. Every figure is read
from the module that owns it and carries a button back to the desk that owns
it: heat from `portfolioHeat` called with the Risk desk's own positions and
the one account; the verdict from the Setup card's own `SetupView`; the
cross-symbol reads from the scan the watch rail already drives; the events
from the live engine; the fires from the alert store's log. A dashboard that
recomputes a number "for convenience" and then disagrees with the desk it came
from is the equity defect again, and `core/account.ts` already records what
that costs. It also adds nothing up: six cards on six axes cannot be netted,
and a single "readiness" score is the opaque figure this repository forbids.

Every card refuses in the operator's words. VERIFIED LIVE in all of them: no
positions ("Nothing at risk. Every figure below is hypothetical."), no scan
("The opportunity scan has not run. Open the Opportunities desk..."), nothing
fired, and the regime model answering and not answering.

THREE DEFECTS THE BUILD FOUND AND TSC COULD NOT:
- Prices printed as raw floats — `80636.16031799658 – 80783.85966208541` in
  the entry row. Fixed by using the SAME `fmt` the chart legend uses; a second
  formatter would print a different number of decimals for one price on two
  surfaces of one screen.
- The verdict chip printed the detector id, `choch`. `nameForKind` exists for
  exactly this and was written down in v55.3; the desk went straight past it.
  An id is not a word, and knowing that is not the same as applying it.
- `.bf-event[data-sev="alert"]` and `[data-sev="notice"]` matched NOTHING.
  `LiveSeverity` is `info | watch | act`. A `data-*` attribute is a string and
  a selector that matches nothing is not an error anywhere, so the severity
  rail silently drew neutral on every event. Taken from the type, and toned
  the same way `livefeed.css` tones the same three words.

A FOURTH, caught by reading the refusal rather than the code: "the only read
is on the instrument already on screen" was printed whenever the map held one
entry — and the map ALWAYS holds the chart's own read. So a scan that had
never run reported that it had run and found nothing. `scanned` is now a
separate input, answered with the screener's own `lazyDesk().built` probe.

Nine tests on `standingRows`, the one part of the desk that is not
composition — which qualifications appear on the figure that could get
somebody hurt. MUTATION-TESTED: dropping the unprotected-position warning and
re-toning heat on an absolute instead of the operator's own per-trade risk
fails 3 of 9. Every expected value is a literal.

NOT TESTED, and stated rather than implied: the other five cards are
composition — they take another module's answer and put it on screen, and a
test of that asserts that `h()` appends children. They were verified in the
browser at 1600px (three columns), 1500px with the dock open (two), and 900px
(one), in the dev build and in the shipped bundle.

### HALF TWO — `mountShell` WAS ONE FUNCTION OF 6,837 LINES

MEASURED FIRST: 7,006 raw lines, 41% of them prose, and **230 declarations at
depth 1** inside one closure. That number is why every extraction since v50
was refused by this repository's own rule — more than ten siblings means the
coupling moved into a signature rather than out. It is a property of the
SHAPE: when state, derivation, DOM and effects share one closure, "sibling"
means "any of the other 229 locals". CLAUDE.md said "fix the coupling first";
this is that.

`ui/model/` is the layer that was missing. Three modules so far:

  structure.ts  215 lines, 5 siblings — detections, the operator's filters,
                the per-kind draw cap, the alert engine's separate set. Pure
                derivation: eight `computed`s, no DOM, no effects.
  analyst.ts    233 lines, 3 siblings — the provider stack, the fallback
                rules, the session, the brief store and its watcher.
  intel.ts       48 lines, 1 sibling — the regime read, the classifier, and
                the rule that a change of instrument invalidates both.

THE ANALYST IS THE INTERESTING ONE. Counted naively it borrows TWENTY-TWO
things, which the rule refuses outright. Twenty-one of them exist for one
reason: assembling `TerminalAccess`. That object is deliberately built once,
beside the signals it reads, because a second assembly would be a second
definition of what the analyst can see. So it STAYS in `mountShell` and
arrives as one dependency — and the section's real sibling count is three.
The refusal was never about the section; it was about where the boundary was
drawn. Its twelve outward values return as one named `analyst` rather than
twelve loose bindings, because twelve loose names in the shell is the shape
this file exists to undo.

MEASURED AFTER: **7,006 → 6,596 raw lines, mountShell 6,837 → 6,426,
declarations 230 → 199** — and that is NET of the Briefing's own wiring going
in. Not one line of behaviour changed and not one comment was rewritten; the
text was moved programmatically, which is what makes it reviewable as a move.

A MEASUREMENT I GOT WRONG AND CORRECTED: the first count of those
declarations was 185, read off a terminal that `head` had truncated. The
honest figure from the pre-change file is 230. A number taken from a cut-off
listing is a number nobody measured.

`verify.py --lint` PASS, 7 stages, 68s. 3,502 tests across 140 files.
`npm run build:all`: app/dist/index.html **1,387,548 bytes** (v55.3:
1,375,450; +12,098 for the desk).

NOT DONE: the live bar still repeats the symbol, the timeframe and the price
that the context bar states four times larger at the other end of the screen —
measured as a duplicate, left alone because `fitFields` ranks price FIRST to
survive a narrow window, and re-ranking it needs the drop order measured at
several widths rather than guessed. `ui/model/` covers three subsystems; the
dock (1,661 lines) and `main` (650) are still DOM built inline and are the
next two. No DOM test for the Briefing itself.

## v55.3 — A LIVE ENGINE, A MEMORY, AND THE APPEARANCE CONTROLS

Asked for: "a more powerful realtime analysis engine", "analyse past data and
use this knowledge", "more powerful tweaks in the front UI design".

### THE LIVE ENGINE (analysis/live.ts, ui/livefeed.ts)

The terminal recomputed on every bar and told nobody what had CHANGED. It now
emits events on TRANSITIONS, each carrying the measurement and the threshold
that produced it: structure break (confidence >= 0.5 on the bar that just
closed), setup appeared / expired / flipped, gates cleared / blocked, price in
the entry zone or within 0.25R of stop or target, volatility crossing the 80th
or 20th percentile of its own history (>= 60 readings), an outlier bar at 3x
the EWMA sigma of the bars strictly before it, volume at 3x the 50-bar MEDIAN,
regime change over 400 bars, session open and close, feed degraded and
recovered. A pure `evaluate(state, snapshot)` core, clock-injected, deduped
with a cool-off, capped ring buffer. MEASURED: per tick 0.0050ms mean,
0.0261ms p99 against a 2ms budget; per bar close 1.225ms. 64 tests.
The browser found three defects the tests could not: a cold load fired five
events at once (now one), sentences printed raw floats, and volume printed a
count instead of its multiple.

### THE KNOWLEDGE BASE (learn/knowledge.ts, learn/harvest.ts, ui/knowledge.ts)

What replays have measured, kept across sessions and sliced by CONDITION on
five separate axes — overall, regime, session, hour, weekday — never crossed,
because crossing them gives 2,520 cells per setup with nothing in any of them.
One entry per study, keyed by an FNV-1a hash of its inputs, so a repeat merge
is a no-op, a deeper study replaces a shallower one, and a shallower one is
refused with the reason. R multiples are never pooled: 40% is excellent at 3R
and ruinous at 1R. Cells under 12 trials WITHHOLD their rates rather than
printing them small; cells over 30 days old are flagged stale. Versioned slot
`learn.knowledge` v2 with a real 1->2 migration, capped at 240 studies with an
eviction note naming what was dropped. The harvest reuses `deep.ts replayAll`
— no second replay engine — and is chunked so the worst chunk is 10.1ms.
It is reported BESIDE the Setup card's in-sample replay and given to the
analyst as `get_knowledge`; it is never merged into a score, for the PBO
reason this file already records. LIVE: one harvest of BTCUSDT 1m filed 42
trials across 5 studies, every rate withheld as "—" for want of 12 trials.

### APPEARANCE (settings/defs.ts, ui/appearance.ts, settings/presets.ts)

Layout presets (Focus / Analyst / Trader, with "Custom" DERIVED rather than
stored, and a note naming the seven preferences a preset overwrites), card
corners, gutter, inspector width, live-bar height, grid style (off / lines /
dots), wick weight, and a live preview drawn from the same role tokens as the
chrome. Every default reproduces the shipped look exactly. Its own versioned
slot `shell.appearance` — a named deviation, because `shell.prefs` is written
by an effect inside `mountShell`.
TWO DEFECTS FOUND WHILE BUILDING IT: every `.set-select` displayed its FIRST
option regardless of the saved value (Density read "compact" while the
terminal was on "standard") because `dom.ts` applies props before children, so
`value` hit a `<select>` with no options yet; and a saved appearance
preference never applied at boot, because the store was lazy and only Settings
woke it.

### AN ID IS NOT A WORD

Three surfaces printed detector ids at the operator: the verdict card said
"choch", the live feed "A fvg setup", the knowledge table "bos". A
`Detection` carries a human label, but all three hold only the KIND.
`nameForKind` in detect/index.ts is now the one owner, falling back to the id
with its dashes opened so an unnamed kind reads as unnamed rather than wrong.

`verify.py --lint` PASS, 7 stages. `npm run build:all`: dist 1,375,450 bytes.
NOT DONE: clicking a live event shows its values rather than scrolling the
chart (the chart engine has no public viewport API); only the `replay` source
writes to the knowledge base (journal and claims are modelled and merge, but
nothing harvests them yet); no DOM test for the appearance preview.

## v55.2 — THE PYTHON SIDE WAS NEVER INSTALLED ON THIS MACHINE

The operator photographed the Regime panel reading "scikit-learn/numpy
missing" and "scikit-learn not installed (pip install scikit-learn numpy)".
Nothing was broken in the code: this machine's Python 3.14 had NO project
packages at all. Every Python stage of the gate had been failing for the same
reason for several sessions, and the desks that need the model service had
been degraded the whole time — the terminal said so honestly on every screen,
which is why it took a screenshot to notice.

INSTALLED (with the operator's approval, `pip install -r
server/requirements.txt` plus the dev tools): fastapi, uvicorn, pydantic,
flask, flask-cors, requests, yfinance, httpx, websockets, numpy 2.5.3,
scipy, pandas, scikit-learn 1.9.1; pytest, ruff, mypy, pyinstaller; and
statsmodels 0.15 + arch 8.0, which CLAUDE.md already names as part of the
packaged product's FULL_DEPS.

MEASURED AFTER, live at 127.0.0.1:8787:
- `/api/health`: data, svc and quant all ok; background 11 of 11 loops alive.
- `/quant/health`: degraded capabilities 14 -> 11. GARCH volatility, the
  stationarity tests and edge significance are back; the remaining eleven are
  the ones CLAUDE.md deliberately keeps out on size (torch, prophet, darts,
  econml, lightgbm and friends), and the desk names the missing package.
- The Regime panel now answers: "Sideways, 0.98 confidence, 48 of the last 48
  bars" and the 24-bar classifier "94.8% up — 62.5% out-of-sample accuracy,
  Brier 0.248 across 746 samples", with its own caveat that this is a long way
  short of a reason to size up.

THE CLASS: a dependency the product REPORTS as missing is still a dependency
nobody installed. The honest empty state did its job — and it also made the
failure comfortable enough to live with for weeks. The gate's Python stages
had been red the whole time and were being read as "environmental".

THE GATE, RUN IN FULL FOR THE FIRST TIME IN MANY SESSIONS:

    PASS  tsc --noEmit  /  vitest  /  tests/ fully listed  /  pytest
    PASS  21 scripts  /  ruff (deferred set only)  /  mypy (gateway, launchers)
    VERIFY PASSED — 7 stages, 90s

`cvxpy` had to be added on top of requirements.txt: three tests in
`tests/test_quant_service.py` exercise the portfolio optimiser, so the repo's
own gate requires it even though requirements.txt does not list it. Worth
adding there.

AND IT CONFIRMED THE RUFF STAGE HAD BEEN LYING. With ruff absent the stage
printed "deferred backlog: BLE001 0, S110 0, S112 0, SIM115 0, UP031 0" and
PASSED — "could not run" read as "clean". With ruff installed the same line
prints 101 / 14 / 14 / 9 / 46, which is exactly what CLAUDE.md records. The
stage needs to fail when the tool is missing; that is a separate fix.

A RESTART IS PART OF THE FIX: the gateway imports its services at startup, so
the instance running while pip installed kept reporting sklearn missing. It
was restarted; `/quant/health` is the check.

## v55.2 — APPEARANCE AS A REAL CONTROL SURFACE

Asked for: "more powerful tweaks in the front UI design". Settings > Appearance
went from three selects to a section with a LIVE PREVIEW, layout presets, and
the shape of the frame; Chart appearance gained the grid dialect and the wick
weight beside the candle colours.

### THE DEFAULT IS AN ABSENT ATTRIBUTE

Six new preferences (card radius, gutter, inspector width, live-bar height,
grid style, wick weight) each re-point ONE role through ONE attribute on
:root, the `data-accent` shape from v55.0. The choice that matches today sets
no attribute at all, so no upgrade changes anybody's terminal and a default
can never disagree with the token it would have copied. `Analyst` — the
middle preset — is asserted field by field against those defaults rather than
against a copy of them.

Every selector is (0,1,0), the same weight as the `[data-density]` block that
also writes `--shell-gap` and as the `:root` blocks holding `--r-card`,
`--w-dock` and `--h-status`. Ties break on ORDER, so the block must stay LAST
in tokens.css — and a test asserts the file offsets, because nothing in CSS
warns about this and the comment alone has already failed twice in this file.

### EVERY SELECT ON THE SETTINGS SCREEN SHOWED ITS FIRST OPTION

MEASURED in the running terminal, and it predates this work: `.set-select`
values read `["iram","theme","compact",…]` — the head of each list — while
:root carried `data-density="standard"`. `dom.ts` applies props BEFORE
children, so `value: () => …` assigned `select.value` with no `<option>` to
match, a write the DOM discards in silence. On a preferences screen that
means the control misreports the terminal until you touch it, and then
"changing" it to what it already claimed does nothing because `onchange`
never fires. Same class as the `setAttribute("value")` trap at the top of
`dom.ts`, one layer along. Options are now attached first and the value bound
after; a test fails 1 of 1 with the old order.

### TWO MORE, BOTH FOUND BY MEASURING RATHER THAN LOOKING

- **`.sp-body` meant two things.** The preview's candle body and the shell
  row that holds the chart card shared a class, so `position: absolute;
  width: 10px` landed on the row and the whole miniature collapsed to a
  10x24 sliver. The row reported 10x24 and `.sp-plot` a height of ZERO.
- **A preference that is saved, restored, and never applied.** The appearance
  store builds lazily and its only other caller is `buildSettings`, which
  runs when Settings is first OPENED. So a terminal saved with dots and heavy
  wicks came back as lines at 1px and re-skinned itself the moment you opened
  Settings — which reads exactly like the setting not persisting. `main.ts`
  now calls `appearance()` before `mountShell`, ahead of the chart's first
  `themeFromCss()`.

DELIBERATE DEVIATION: the six live in their own versioned KV slot
(`shell.appearance`) rather than in `shell.prefs`, because that blob is
written by one effect inside `mountShell` and this change may not edit
`ui/shell.ts` — another agent owns it this session. Same machinery, same
guarantee; `RULES_SLOT` and `data/backend.ts` are the standing precedents.
The three LAYOUT signals a preset also writes (rail, news strip, inspector
open) stay the shell's, are optional on `DefDeps`, and a build that has not
passed them in says which preferences it could not reach instead of
reporting success over one it never wrote.

MEASURED, dots: 366 pixels in a 12-column x 17-row lattice of 2x2 squares at
exactly the price and time ticks the lines used. The wick weight gets its own
path only when it is not 1 — at 1 the shared stroke-and-fill is byte for byte
what it always was, because raising `lineWidth` on that path would also grow
every body by half a pixel each side.

`verify.py --quick`: tsc PASS; vitest 3,483 of 3,486, the 3 failures in
`dockpanels` and `knowledge-desk`, both being edited by other agents in this
same session and untouched here. NOT DONE: a text-size control — density IS
`--ui-scale`, and a second knob on one number is what tokens.css forbids in
as many words, so the section carries a statement instead.

## v55.1 — THE ANALYST BECOMES THE TRADING EXPERT

Asked for: "a powerful agent that acts like a trading expert with 100 years of
fundamental and technical knowledge, that can make strategies, predict, and
suggest what I should do". The Analyst desk was upgraded rather than a second
agent built: it already had the tool loop, four providers and the honesty rule.

### WHAT THE EXPERT MAY AND MAY NOT KNOW

The old prompt forbade "typically" and "historically" outright, which also
forbade METHODOLOGY — how a break of structure works, what a stop belongs to,
why an in-sample hit rate is not an edge. The new prompt splits the two:
general methodology is allowed and labelled as such; any market FACT about
this instrument now must come from a tool; predictions are tool probabilities
carrying their basis (modelled vs measured, sample size, calibration) and
never a certainty; it remains decision support with no order tool to call.
It answers "what should I do" in six parts: the call, the market read
(technical + fundamental), scenarios with odds, the plan with size, what would
change the view, and the risks.

### FOUR NEW TOOLS

- `get_setup` — the Setup card's own verdict, gates, watch level and plan.
  The plan is WITHHELD whenever a gate blocks, exactly as the card withholds
  it, so the expert cannot quote an entry the terminal is refusing.
- `get_outlook` — the v54 simulation: the cone at 1/6/12/24 bars, the base
  rate labelled as a base rate, target-before-stop odds against break-even,
  the assumptions, and the band's MEASURED calibration.
- `find_opportunities` — the Opportunities pipeline across the universe.
- `test_strategy` — a rule set in the terminal's own rule language, validated
  (errors returned verbatim so the model can fix and retry), backtested, then
  walk-forward, Monte Carlo, random-entry and MAE/MFE. A strategy that fails
  its out-of-sample gate is reported as failing.

### THE OFFLINE EXPERT IS THE ONE MOST PEOPLE GET

No key, no model: the deterministic analyst now composes the same six-part
desk note from tool RESULTS only, and says no language model was consulted.
Verified live on BTCUSDT 1h: 13 tool rows, scenarios from the cone, "the 90%
band held 88% of the time over 229 past checks", the plan withheld because a
gate blocks, and seven silent sources NAMED rather than averaged into a
neutral reading.

### THE CLAUDE CONNECTION, BROUGHT UP TO DATE

`claude-opus-5`, adaptive thinking, effort high, max_tokens 16000, prompt
caching on the system block and the last tool, server-side refusal fallbacks
(`fallbacks: "default"`), SSE streaming with tool inputs parsed at block stop,
and thinking blocks replayed verbatim through a new opaque field — never
edited, which is what the current API requires. `refusal`, `max_tokens` and
`pause_turn` are all handled and said out loud. Tests assert the request body
with literal expectations.

DELIBERATE DEVIATION from the Claude API guidance: it prescribes the official
SDK, and this stays raw `fetch`. The provider module is one of four behind a
single interface, runs in the browser with the user's own key, and the build
must remain one self-contained file with no external references. Adding an SDK
would change the transport for every provider and break that guarantee.

`verify.py --quick` PASS. `npm run build:all`: dist 1,309,050 bytes.
NOT DONE: the expert has no eval set — its answers are checked by reading them.

## v55.0 — THE FUSION RESKIN, A WATCHLIST RAIL, AND SETUP ALERTS

Asked for: "ship the fusion", plus "more features so usability increases".
The Fusion design (canvas: three directions — Ledger, Meridian, Porcelain —
combined) was approved in the design artifact; this ships it.

### THE FLOATING-CARD SHELL (styles/shell.css, tokens.css)

Every area is a card on a sunk ground. THE GUTTERS ARE BUILT INTO THE TRACKS,
not taken from `gap`: a grid gap is laid between tracks whether or not they
have height, so a collapsed row (news off, focus, a desk the context bar does
not describe) would leave a double gutter. A present track is its content plus
one gutter, the card takes the gutter as a margin, and a zero track takes its
gutter with it. Collapsed cards are also `display: none` — a card in a zero
track still paints its 1px border (the CLAUDE.md rule, applied to cards).
The instrument header and the chart are ONE card; the rail and dock span both.
Gutter follows density (6 / 10 / 12px). New tokens: --shell-gap, --r-card,
--card-shadow, --w-watchrail.

### THEMES AND ACCENT

- `iram` stays the house Graphite & brass. NEW `ink` (navy, ice brand, amber
  and violet averages). `daylight` retuned to Porcelain: white cards, INK-BLACK
  brand so colour on the light theme only means the market; faint text
  #8A93A2 (3.0:1 on white) -> #666D7A (5.3:1); attention #B7791F (3.2:1) ->
  #B9530B (4.9:1). Theme order: iram, ink, daylight, then the presets.
- ACCENT is a new preference (Settings > Appearance): theme / brass / ice /
  violet, via `data-accent` on :root re-pointing `--p-brand` only. The light
  theme gets darker shades at (0,2,0) — pale brass on white is 1.9:1.

### THE CHROME

- Navigation: the selected desk is a filled accent pill (was chip + underline;
  the underline is kept at scaleX(0)). Brand mark solid accent, not a gradient.
- CHART HEADER (ui/shell/topbar.ts, styles/topbar.css — delegated): the
  "button farm" (7 timeframes, 6 styles, 3 averages, 6 tools) is now symbol,
  a 26px price headline with its change over 24 bars (labelled by span — the
  terminal has no true 24h figure for the chart's instrument, so none is
  invented), 5 timeframes + More, a Chart-style menu, an Indicators menu, Replay
  and an overflow menu. Every row is an existing registered command via
  `openMenu`, so shortcuts and checks are the palette's own. The row measures
  itself and sheds stats, then words, before it scrolls. 17 tests.
- VERDICT CARD: the gate count as a RING (the number and the picture are one
  fact), the engine's human setup label (not the detector id "choch"), and a
  solid "Review the full plan" button.

### USABILITY FEATURES

- WATCHLIST RAIL (ui/watchrail.ts — delegated; mounted here): the Watchlist
  desk's own list signal (one list, one owner), Binance 24h quotes every 15s
  while shown, sparklines from cached 1h bars, each symbol's setup state —
  the chart's symbol from the live verdict, others from the latest
  Opportunities scan only if one ran (the rail never starts a scan). Created on
  first show and DESTROYED when hidden, so it never polls behind a desk.
  Command "Watchlist rail" (View), persisted as `watchRail`. 19 tests (jsdom).
- WATCH FOR NEW SETUPS (scan/watch.ts — delegated): an opt-in re-scan once per
  closed bar (close + 20s), paused while the tab is hidden, never twice per
  bar, first scan never notifies. Notifies new (newSince), non-adverse setups
  confirmed within N bars via toast + the existing bell + desktop only if
  permission was already granted. The loop lives in decision.ts so it runs on
  any desk. 23 tests on a fake clock; browser-verified.

`verify.py --quick` PASS (needs PYTHONIOENCODING=utf-8 on this console —
verify.py crashes printing cp1252-unencodable output otherwise).
NOT DONE: no DOM test for the shell layout, the verdict ring or the rail
mount — all verified in the browser across graphite, ink and daylight.

## v54.0 — THE INSPECTOR AS ONE DECISION, AND A TERMINAL IN WORKFLOW ORDER

Asked for, in the owner's words: a trader cannot see everything the market is
doing, and the terminal's job is to help decide — by formula, by simulation —
including WHERE to enter. "Make changes in the right side panel for better
outcome and restructure the project interface." Then full authority to act.

### THE RIGHT PANEL WAS ORGANISED BY DATA SOURCE

Ten panels: Setup, Cursor, Regime, Studies, Structures, Feed, Series,
Context, Fundamentals, Announcements — the plumbing (Cursor, Feed, Series)
sitting among the decision, and the conclusion (Setup) above the reasoning it
depends on. It is now five sections asked in order (`DOCK_SECTIONS`):

    Market now            Regime & model · Momentum & volatility
    What's likely next    Price outlook (NEW)
    The trade             Setup & plan
    Risk check            Calendar & seasonality · Announcements · Fundamentals
    Evidence & diagnostics  Structures · Cursor · Feed · Series (closed)

with the VERDICT PINNED ABOVE THE SCROLL (`.dock-verdict`): the kind, the
first blocking gate in words, entry/stop/target, a release inside the hour,
and a jump to the full plan. Everything in it is the Setup card's own
`setupView` — nothing recomputed — so banner and card cannot disagree.

- Panel titles are read from the registry in `panel()`, so renaming is one
  edit and header, stack tab and summary cannot drift.
- LAYOUT MIGRATION. The open set is persisted, so every existing install would
  have kept the old arrangement (the theme-NAME trap again). `DOCK_LAYOUT = 2`
  is saved beside it; an older set is replaced by the defaults once. THE FIRST
  VERSION MIGRATED NOTHING: the argument had a default value, a pre-v54 install
  has no saved layout, `undefined` triggers the default, and every old install
  read as current. Caught by its own test; the parameter is now required.
- PRE-EXISTING BUG: every dock panel name was pushed against the right edge.
  `desks.css`'s `.panel-head > :first-child { margin-right: auto }` targets a
  desk card's TITLE; in the dock the first child is the CARET. Measured: caret
  x=1261, name x=1496 in a 323px header. Fixed at (0,3,0) inside the dock only.

### WHAT'S LIKELY NEXT: A REAL MULTI-BAR OUTLOOK

Nothing forecast beyond one bar. `analysis/outlook.ts` (new): filtered
historical simulation — the instrument's own past moves, standardised by the
EWMA volatility known at the time (no lookahead), redrawn and rescaled to
today's volatility; 2000 paths × 24 bars, seeded. MEASURED 4.5–5.4ms on 1000
bars. Gives the fan (p5/p25/p50/p75/p95 per bar), a base-rate share of paths
ending higher (labelled a base rate, never a direction), and the odds the plan's
target 1 comes BEFORE its stop, printed beside the break-even rate its R needs.
Every assumption is carried on the result and shown behind "How this is
simulated". Refuses under 300 bars and on any incoherent plan.

TRACK RECORD, MEASURED: the 90% band is checked out-of-sample at
non-overlapping 24-bar origins. The chart's ~800 bars give 29 checks — under
the 30 needed — so it reads the ARCHIVE (up to 6000 bars, no vendor requests),
once per instrument. Live on BTCUSDT 1h: "The 90% band held 87% of the time
over 229 past checks." Also live: the 1R plan's target came first in 50% of
paths against a 50% break-even — no simulated edge, said plainly.

### WHERE TO ENTER: THE PLAN IS DRAWN ON THE CHART

`setup/chartplan.ts`: entry-zone box, stop, target 1, target 2, from the live
edge. Dashed and labelled "(not live)" on the chart itself when the gates do
not clear it, so a screenshot cannot pass for an actionable plan. No plan, no
shapes. Tested.

### THE NAVIGATION, IN WORKFLOW ORDER

Chart · Find · Decide · Execute · Prove · Workspace (was Analyse / Trade /
Research). Opportunities and Watchlist are Find; Decision, Smart money, Flow,
Sessions and the Analyst are Decide; Risk, Calculator, Paper, Signals and
Journal are Execute; Learning (first, on purpose), Strategy, Conditions, Quant,
Playbook and Data are Prove. The same order the inspector now reads in.

`verify.py --quick` PASS. `npm run build:all`: dist 1,237,150 bytes.
NOT DONE: the chart's plan labels crowd the live edge when the zone, stop and
targets are within a few pixels; the engine places level labels itself and
de-colliding them is an engine change.

## v53.1 — THE PREMIUM PASS: QUIETER CARDS, A FIGURE FACE, ONE CHART KIT

Asked for: six design items, "build all". Each below with what it cost.

### 1. PROSE BEHIND "HOW THIS IS MEASURED", LABELS IN SENTENCE CASE

`pkWhy(text, label)` in panelkit.ts: a native `<details>`. 45 method/caveat
paragraphs moved behind one (32 across 11 desks, 11 in the Strategy lab, 2 in
the Setup card), VERBATIM — the caveats are the product's honesty and none was
removed or reworded. Inline, always: verdicts, refusals, empty and error
states, every "decision support only" line, the PBO trust line, the adverse
history warning.

44 all-caps label rules went to sentence case. THE TRAP: three classes held
text WRITTEN IN LOWERCASE in the code that only read as labels because CSS
capitalised it — `.lb-key` (atr, rsi, spread), `.setup-hist-k`, `.fm-ev-kind`.
Found by scanning every desk's DOM for lowercase-initial text in the converted
classes, not by looking. Those three are short data keys, several of them
abbreviations, and are back in caps. Also kept: direction/standing/state chips.

### 2. GEIST MONO REPLACES JETBRAINS MONO

`@fontsource-variable/geist-mono@5.3.0` (OFL), latin variable file vendored:
23,128 bytes against JetBrains Mono's 40,404. Replaced, not added. Built page
1,234,979 -> 1,217,780 bytes. The JetBrains file stays vendored, unreferenced.

### 3. ONE SMALL-CHART KIT (`ui/minichart.ts`)

The Strategy lab's four hand-drawn canvases (equity, underwater, drawdown
histogram, MAE scatter) now share axes, labels and a hover readout. MEASURED:
hover repaint on a 5,000-point curve 1.3ms mean, 2.1ms p95 (offscreen copy +
overlay). 18 tests on the pure parts; the hover itself was checked by eye.

### 4. MOTION, AND THE RULE IT HAD TO RESPECT

A flash on every price tick is the obvious premium move, and CLAUDE.md's
motion rule refuses it on frequency. So the status bar's price carries the
DIRECTION of the last print as a state — candle colours, instant, held on an
unchanged print, reset on a change of instrument (`nextTickTone`, tested).
The one animation added is the "new since last scan" row in Opportunities:
once per scan, opacity-only overlay, `--dur-note` (1400ms, 0 under reduced
motion), settling to a wash that stays, so reduced motion keeps the fact.

### 5. A RESTING TERMINAL NO LONGER LOOKS BROKEN

News health spent the loss colour on "no feeds" — a setting. Unconfigured is
now neutral (`not set up`), news failures a caution; red stays with the price
feed. AND EIGHT ERROR MESSAGES NAMED THE WRONG LAUNCHER: `python
server/mishel_service.py` (×4), `python -m quant.app` (×2),
`ddt_data_server.py`, `python -m gateway`. The first three start the
pre-consolidation layout this page cannot address; the last starts the right
server with the eleven loops off. Every one was PINNED BY A TEST, so the tests
guaranteed the wrong remedy. All now say `python run.py`, the tests assert it
and assert the old string is absent.

### 6. HOVER GATED

All 72 `:hover` rules are in `@media (hover: hover)`, in place (cascade order
unchanged; a media query adds no specificity). Five mixed selector lists were
SPLIT so keyboard/active states stay ungated. Idempotence checked: a second
pass finds nothing. Confirmed in the minified build: 72 `@media(hover:hover)`.

`verify.py --quick` PASS. `npm run build:all` rebuilt dist and both engines.

## v53.0 — GRAPHITE AND BRASS, AN OPPORTUNITY FINDER, AND RISK OF RUIN

Asked for: "a premium front UI design, also more powerful features". Asked
back, the operator chose a NEW VISUAL IDENTITY, and for features an
OPPORTUNITY FINDER plus ANALYTICS & BACKTESTING.

### THE HOUSE THEME IS NOW GRAPHITE AND BRASS

`tokens.css` only, plus two role changes. The house `iram` palette was a
blue-slate ground with a blue brand — the same two decisions as three of the
other four themes. It is now neutral-warm graphite (`#0F1012` / `#16171A`),
ivory text, a brushed-brass brand (`#D2AE6D`), jade/coral market colours, and
attention moved to burnt orange (`#F08A4B`) because brass and the old amber
were five degrees of hue apart.

**The redesign re-points `iram` rather than adding a theme.** The saved
preference stores the theme NAME, so a new name would never have reached an
install sitting on the default. The previous palette is kept verbatim as
`classic`. Anyone on binance/tradingview/institutional/daylight is untouched.

Three things the new palette forced, each now a role:
- `--text-on-accent` was a literal `#fff` in layer 2. White on pale brass is
  illegible, so every theme block now declares `--p-on-brand`. EVERY block,
  because `:root` and `[data-theme=x]` match the same element: a variable only
  the house block declares leaks into every other theme.
- The three MA lines read `--accent` / `--attn` / `--alt` directly, so EMA20
  (brass) and EMA50 (orange) were one warm line to the eye. They now read
  `--ma-fast/mid/slow`; only the house theme moves the middle one (steel blue
  `#6FA8DC`); every other theme points it at its old attention colour.
- Pressed `.tf-btn`/`.seg-btn` were SOLID brand fills — timeframe, chart type
  and each average — so the brand was the loudest thing above the chart. Now a
  wash, the idiom `.tool-btn` already used. This one applies to all themes on
  purpose: the three pressed styles disagreed.

Fonts unchanged: Inter and JetBrains Mono are embedded, and a new face means
shipping new font files.

### THE SCREENER BECAME AN OPPORTUNITY FINDER

Two engines existed and never met: the screener ranked 50 symbols by direction
and could not say where to get in or whether the idea had ever worked; the
Setup card said all of it for ONE symbol. `scan/opportunity.ts` runs the card's
pipeline per symbol, unchanged — `runDetectors` → `chooseSetup` → `buildPlan`
→ `simulateKind`. Each row now carries a setup, entry zone, stop, both
targets, the stop distance as a share of price, the replayed track record,
an edge (Wilson-low hit rate minus break-even, NULL below `MIN_TRIALS`), how
many bars ago it confirmed, and a "new" mark for setups not in the previous
scan of that timeframe. "Setups only" filters; opening a row shows the plan.

- Plans in the CANDIDATE's direction, not the read's. With the read's, a short
  setup's invalidation became a long plan's stop, on the wrong side of entry.
  The test fails with that reinstated (`expected -0.72 to be greater than 0`).
- Drops the forming bar: the chart's detectors see closed bars only.
- Ranked by engine score × grounding, then freshness; historically ADVERSE
  setups sort last; edge breaks ties only — ranking by an in-sample base rate is
  the PBO mechanism ("THE SECOND OPINION" in shell.ts).
- 1000 bars per symbol instead of 400: same Binance weight band, and 400 rarely
  holds twelve instances to replay.
- The first draft had an `R` column. Live, every row read `1.0R`: the builder
  always puts target 1 at one R. Replaced with Risk (stop distance %).
- Uses the operator's own stop band (`rules`, threaded through
  `DecisionSectionDeps`), so a row and the card agree.

MEASURED, live, 50 USDT pairs × 1000 bars on 1h: one long task in the whole
scan, 84ms, the final table render. 44 of 50 carried a setup.

Also fixed: the correlation section printed its heading over an empty list
before any scan (`data-show` with no CSS honouring it).

### BACKTESTING: RISK OF RUIN, RANDOM ENTRIES, SIX METRICS

- `metrics.ts`: Sortino, CAGR, Calmar, ulcer index, longest time under water,
  exposure, and `drawdownCurve`. Each is 0 with a stated reason when it cannot
  be computed honestly, never Infinity/NaN. CAGR refuses under a quarter-year.
- `backtest/montecarlo.ts`: `monteCarlo` (resample or reshuffle trades 2000×;
  p5/p50/p95 of max drawdown, final return, losing streak; probability of a
  30% drawdown) and `randomEntryTest` (random entries with the same side,
  holding time and costs; p-value). Both refuse under 30 trades; both seeded.
  Measured in net return per trade, not R, because a random entry has no stop.
- Strategy lab: underwater curve under the equity line, the new metrics, and
  two cards. Live on BTCUSDT 1h EMA trend, 77 trades: p95 drawdown 19.1% vs
  15.7% in the backtest, 0.1% of paths reach −30%; random entries matched or
  beat it 4.2% of the time (p = 0.042).
- MEASURED (node, 2000 draws): 200 trades 11–13ms resample, 16–23ms random
  entry; 1000 trades 53–62ms / 78–97ms. Each runs in its own frame after the
  study paints, and draws are capped so draws × trades <= 400,000.
- MAE/MFE, added in a follow-up: `Trade.maeR` / `mfeR`, in R, gross of
  costs, recorded by the engine bar by bar. The EXIT BAR is read the way fills
  are — pessimistically: a stop-out counts adverse only up to the stop and no
  favourable side; a target exit caps favourable at the target. The test fails
  with the naive full-bar read (`expected 2 to be close to 1`).
  `backtest/excursion.ts` reads winners' heat (p50/p90), losers once up 1R,
  and capture; the lab draws every trade as MAE vs final R.
  CAPTURE EXCLUDES TARGET EXITS. The first version averaged them in and read
  97.4% live on BTCUSDT — a target exit's MFE is capped at the target, so its
  capture is 100% by construction less costs. It is now null when every winner
  took its target, and says so. Live, same study: winners' heat p90 0.89R;
  38% of losers were a full R up first.
- `tsconfig` includes `src` only, so test files are NOT type-checked — adding
  a required field to `Trade` broke no build while five test fixtures lacked
  it. Fixed by hand; the gap stays.

### BUILD

`npm run build:all`: `dist/index.html` 1,206,799 -> 1,234,979 bytes. The
previous dist dated from 10 Sep and predated this whole entry, so the served
terminal was missing all of it. `server/engine/lab-engine.mjs` (49,459) is
rebuilt too and carries `maeR` — a backend study from the OLD bundle would have
returned trades without excursions and the card would refuse with "re-run".
The packaged `.exe` was NOT rebuilt: PyInstaller is not installed here.

### GATE

`tsc` and vitest PASS. The Python stages FAIL on this machine for environment
reasons only — this Python 3.14 has no pytest, requests, sklearn or mypy — and
no Python was changed. The ruff stage printed PASS with every count at 0 while
ruff is NOT INSTALLED: the gate reports "could not run" as "clean". Recorded,
not fixed here.

No automated test covers the screener's DOM or the new strategy cards; both
were verified in the browser on live Binance data.

## v52.0 — THE TOP CHROME AND THE INSPECTOR, REDESIGNED

Asked for: "redesign the right side panel and top panel". Neither was rebuilt.
Both were measured first, and the measurements decided what to change — three
of the changes below are defects the measurement found rather than design
choices, including one this session's own previous entry shipped.

### THE COMMAND ROW WAS THE ONLY PART OF THE FRAME NOT ON THE FRAME

MEASURED, live at 1600x900:

| element | was | now |
| --- | --- | --- |
| `.commandbar` | `--surface-inset` rgb(15,20,28) | `--surface` rgb(20,25,34) |
| `.topbar` | `--surface` | unchanged |
| `.dock` | `--surface` | unchanged |
| `.livebar` | `--surface` | unchanged |

Three sides of the frame were one plane and the fourth was darker — and the
darker one was the row that carries the brand, the desk switcher and the
palette. The most important band on screen was the most recessed.

The frame is now one raised plane, the chart well at `--surface-base` is the
only recessed thing in the layout, and the inset controls inside the frame
(the omnibox at `--surface-sunk`, the segmented groups and the feed badge at
`--surface-inset`) read as sunk into it. Three steps of depth, one reason each.

A side effect worth having: the omnibox previously sat at `--surface-sunk` on
`--surface-inset`, two of the closest colours in the palette. Against
`--surface` it finally reads as the field it behaves as.

The two borders were also equal. `--border` under both rows made a 42px band
and a 48px band read as two bars; the seam between them is now
`--border-hair` and the strong line is kept for the one edge that is a
boundary — where the chrome ends and the chart begins.

### THE LOWER CHROME ROW WAS TALLER THAN THE UPPER ONE

`--h-topbar: 48px` against `--h-cmdbar: 42px`. The hierarchy was inverted
geometrically as well as tonally: the row for one instrument's controls was
heavier than the row for the whole program.

48 was held up by exactly one control — the symbol box at `--h-ctl-lg` (38px).
"Anything that leads a row" is a weak reason for it to be the only 38px
control in the chrome when every other input in the terminal is 32. At
`--h-ctl` the row goes to 42 with the same 5px of air the 38px box had at 48.

```
chrome  42 + 48 + 30 = 120px   ->   42 + 42 + 30 = 114px
chart   top 90, height 750     ->   top 84, height 756
```

Nothing is clipped: every child of both rows was measured against its row's
box afterwards, and the list came back empty. The context row still fits at
1600px (scrollWidth 1600 / clientWidth 1600) and still scrolls with its fade
mask at 1000px (1134 / 1000, mask applied).

### THE TWO ROWS' EDGES DID NOT LINE UP

Measured at 1600px: the command row's first control began at x=8 and the
context row's at x=12; their last controls ended at 1592 and 1588. Every
column in the chrome was four pixels off the one above it, in both
directions — a zig-zag down both edges of the frame that nothing could point
at and everything read as slightly loose. One padding value (`--sp-5`) on
both rows: 11.99 and 11.99, 1588.01 and 1588.01.

The same pass took the two hairline dividers in the chrome to one metric.
They were 16px (`.bar-rule`) and 18px (`.topbar-actions::after`).

### TWO CONTROLS IN THE TOP ROW HAD NO PRESS FEEDBACK

`press.css` exists because an audit found 65 `:hover` selectors and one
`:active`. It missed two, both here.

`.tool-btn` is six buttons in the context row — the detector, the studies
popover, Replay, Live edge, Reload, export — plus the whole chart toolbar. It
sits directly beside `.tf-btn` and `.seg-btn`, which both have press feedback,
so the row answered a press on one button and ignored it on the next. Added to
the list, and its own `transition` declaration in `risk.css` deleted: that
file's header says the list is the single owner, and a second declaration of a
shorthand in a file that loads earlier is the trap that once silently deleted
eight colour transitions.

`.omnibox` had none either, and is in the list for its transition only. It is
460px wide at full size, and the note in `press.css` chose `scale(0.985)` to
be "deep enough to feel on a 22px icon button without becoming visible
movement on a wide one" — 1.5% of 460px is seven pixels of travel. So it
answers in colour, taking the accent border it is about to have when the
palette opens: the press previews the state it leads to.

### THE ONE CONTINUOUS MARKER IN THE CHROME COULD NOT MOVE

`.desk-tab[aria-selected="true"]::after` — the 2px accent underline — existed
only on the selected tab. It was destroyed at one x and constructed at
another, so switching desks made the marker blink out and reappear elsewhere
with nothing in between.

It is now on every tab at `scaleX(0)` and scales to 1 when selected.
MEASURED mid-flight on a real click, Chart to Workspace: outgoing
`matrix(0.357, 0, 0, 1, 0, 0)`, incoming `matrix(0.643, ...)` in the same
frame — the two cross, which is the continuity that was missing.

`transform` only, at `--dur-1` (90ms), the shortest step in the vocabulary,
because a desk switch is navigation and the marker should have arrived before
the eye does. `press.css` excludes `.desk-tab` from press scaling for a
different reason — a tab shrinking against its neighbours reads as a layout
glitch — and that exclusion is about the tab; this is a 2px pseudo-element
inside it and moves nothing. Reduced motion is covered by the token, and a CSS
transition does not run on initial style resolution, so it costs nothing at
boot.

---

### THE INSPECTOR'S SUMMARY LINE WAS WRONG BY A FACTOR OF 2.8

MEASURED, live, same frame, same element:

```
on screen   "4 panels open — 1.2 screens of scroll."
real        scrollHeight 2329 / clientHeight 682 = 3.4
```

Why it froze: `scrollHeight` is not reactive, so `shell.ts` published a tick
from the layout effect and from a ResizeObserver on the dock body. **A
ResizeObserver watches an element's own BOX**, and the body's box never
changes — what grows is the CONTENT inside it, when the Setup card fills in
asynchronously and on every refresh after that. So the figure was measured
once, before the tallest panel had any content, and then held that value for
the session. 820/682 is 1.2.

**Removed rather than repaired, and the reason is that it was a duplicate.**
The dock body scrolls with a real 10px scrollbar whose thumb IS the ratio of
viewport to content — drawn continuously, by the browser, always correct.
Keeping a second copy in text meant observing ten panels for the privilege of
restating something already on screen, with a wrong value as the cost of
falling out of step. Gone with it: `dockTick`, `dockMetrics`, the tick publish
in the render effect, the ResizeObserver, and two parameters of `dockSummary`.

The line now reads **`4 of 10 open`** — derived from its arguments alone, so
it cannot go stale. The second half is new and the redesign needs it: a shut
panel is now a row in a list, and this says how long the list is.

**No test could have caught the original**, which is the other half of the
argument for deleting it. Every argument was passed in, so the function was
correct for its inputs and its seven tests all passed; the staleness lived in
the caller, in an asynchronous DOM measurement no unit test observes. The
replacement block asserts on a pure function of state and pins the signature
with `expect(dockSummary.length).toBe(2)` — 27 tests in the file, all passing.

### A SHUT PANEL WAS AN EMPTY CARD

MEASURED at 360px on the default open set: ten panels, four open, six
collapsed to 33px — each still carrying a full card's border, an inset
background, an 8px radius and a 12px gap on both sides. Two thirds of the
inspector was bordered boxes with nothing in them, competing with the four
that held the answer.

A card is a promise of content. A shut panel has none to make: it is a name
and a way to open it. So it gives up the card and keeps the name, and the dock
reads as four cards plus a short list of what else is available.

```
                     was              now
body gap             12px             4px
open card            (gap only)       + 8px margin, top and bottom
shut row             card             transparent, radius 0, no margin
shut -> shut         12px apart       4px
shut -> card         12px             12px  (unchanged)
card -> card         12px             20px
```

**The gap is done with margins on the open panels, not with a sibling
selector, and that is not a style preference.** `.dock-body` applies visual
order through the CSS `order` property, so DOM adjacency is not visual
adjacency — measured on the live tree, DOM order runs setup(0), fundamentals(8),
cursor(1), context(7), news(9), regime(2)... and `.panel + .panel` would have
collapsed the space between two panels nowhere near each other on screen.
Margins belong to the element and travel with it wherever `order` puts it.

The click target does not shrink: `min-height: 32px` stays, for the reason
already recorded on it — a collapsed panel is nothing but its header, so the
header is the whole control.

**One correction, caught by measuring rather than by looking.** The first
version of the rule set the shut rows to `--text-muted` to quieten them. Every
panel title in the dock inherited `--text-faint` (86,96,114), the dimmest text
role in the palette, INCLUDING the heading of the tallest card in the
terminal — so "quietening" the shut rows to `--text-muted` (122,132,148) made
them BRIGHTER than the cards they were supposed to defer to. The hierarchy is
now explicit: an open card's title is a heading and takes `--text-muted`, a
shut row is a name in a list and stays at `--text-faint`, brightening on hover
(gated behind `@media (hover: hover)`).

### THE HEAD WAS CARRYING A CONTROL THAT DID NOT FIT

`.dock-head`'s own comment recorded a measured bug: at the dock's 260px
minimum the row's content came to 279px and the Column/Stack toggle — last in
the row, and unshrinkable — was clipped by the shell. The fix at the time was
a spacer, which spaces but does not shrink.

Row one is now identity only: the word, the symbol, a spacer. Two shrinkable
items cannot overflow 260px. The toggle moved down to `.dock-summary`, beside
`Collapse all`, which is where the panel's controls already were — and a
layout mode is a session-level setting that had no business in the highest-
value row in the panel. Row one says what you are looking at; row two says
what you have built and how it is laid out.

```
dock chrome   38 + 30 = 68px   ->   32 + 30 = 62px
dock body     682px            ->   694px
```

Head border to `--border-hair`, summary border to `--border`: the same
vocabulary as the top chrome, seam inside and boundary at the edge.

### BOTH OF THE INSPECTOR'S ANIMATIONS IGNORED REDUCED MOTION

`transition: transform 120ms ease`, twice — the dock's disclosure caret
(`components.css`) and the Setup card's evidence caret (`setup.css`). A
hardcoded duration cannot be re-pointed, so `tokens.css` sending every
`--dur-*` to 0ms under `prefers-reduced-motion` never reached either of them.
The glyphs turned for the people who had asked the whole terminal to stop
moving. Both now read `var(--dur-2) var(--ease)`.

### THE RAIL READS AS A HANDLE NOW

v51.9 gave the closed dock a 22px rail carrying the word Inspector. The word
says what is behind it, not that it opens. It now leads with a chevron
pointing left, the direction the panel travels — drawn from two borders on an
empty box rather than set as a glyph, for the same reason `.panel-caret` is: a
`‹` inherits the label's font metrics and is then re-laid-out by
`writing-mode: vertical-rl`, which is where a rotated latin glyph goes wrong.

### AND THE BUG v51.9 SHIPPED: THE HIDDEN RAIL KEPT ITS TRACK

MEASURED at 1000px with the dock closed: the rail was correctly
`display: none` and the track was still **22px wide**. The chart gave up 22px
to hold an invisible element, on exactly the screens with the least to spare.

```css
@media (max-width: 1100px) {
  .shell { grid-template-columns: minmax(0, 1fr) 0; }   /* (0,1,0) */
}
.shell[data-dock="closed"] { ... var(--w-dock-rail); }  /* (0,2,1) — wins */
```

**A media query adds no specificity** — which is the exact trap v51.9's own
entry recorded catching, one line further down, on the rail's `display` rule.
Caught for the rail, missed for the track, in the same change. The narrow
block now overrides at matching specificity. Verified: 1000px closed, track
0.00px, chart 1000px wide, border 0; open, `position: fixed`, 360px overlay at
top 84.

### VERIFIED

```
python verify.py --lint     7 stages PASS, 62s
python verify.py --quick    2 stages PASS, 38s  (after the CSS-only follow-ups)
test/dockpanels.test.ts     27 tests PASS
```

Measured on a fresh page load at an emulated 1600x900, dock open, focus off:

```
commandbar  41.99px  rgb(20,25,34)  border rgba(fg .08)  first child x=11.99
topbar      41.99px  rgb(20,25,34)  border rgb(35,43,56) first child x=11.99
clipped children of either row: none
chart       top 84   756px tall     1240px wide
dock head   31.99px  summary 29.71px  count "4 of 10 open"  body 694px
shut (6)    33px  bg transparent  border transparent  title rgb(86,96,114)
open (4)    margin 8px  bg rgb(15,20,28)  title rgb(122,132,148)
```

States, each measured rather than assumed:

```
1600 closed    track 21.99px, rail 21x756 at x=1579, chevron rotated, chart 1578
1600 focus on  context row 0.74px (one device pixel), rail still present
1600 focus full track 0px, rail display:none, dock border-left 0
1000 closed    track 0px, rail display:none          <- the fix above
1000 open      position:fixed, 360px, top 84
Workspace desk data-scoped="no", context row 0.74px; back to Chart, 41.99px
```

**No automated test on any of the CSS**, and that is unchanged from v51.9 for
the same reason: nothing in `app/test/` mounts `mountShell`. The TypeScript
half — the summary line — is tested, and its block now says in the test file
itself why a test could not have caught the bug it replaces.

## v51.9 — TWO LIBRARIES INTO THE BUILD, AND A CLOSED PANEL THAT SHOWS

### `statsmodels` AND `arch` ADDED TO `--full`

`/quant/health` on the previous binary reported 4 of 19 libraries and 13
degraded capabilities. These two were the ones worth the bytes, because each
restores a whole card that needs nothing else exotic:

| package | card |
| --- | --- |
| `statsmodels` | edge significance, stationarity (ADF/KPSS), lead/lag |
| `arch` | GARCH and GJR-GARCH, raced against the terminal's EWMA |

**Verified RUNNING in the frozen build, not merely present** — which is the
distinction that matters, because a listed hidden import is not a working
model. POSTed 800 real bars to the binary's own endpoints:

```
/quant/stats/structure   ok  call "unit-root"  ADF p=0.7597 stat -0.982
                             KPSS p=0.01 stat 3.509   35ms
/quant/volatility        ok  winner "gjr"
                             GJR beat the EWMA by 5.8% on QLIKE over 320 bars
                             799 returns fitted
```

Hidden imports were read off the call-time imports in `quant/stats.py` and
`quant/volatility.py` rather than guessed: statsmodels resolves much of itself
through `__getattr__` on its lazy `api` modules, so the static graph misses the
model classes even though the code imports them by name.

Cost: **82 MB → 90 MB** (86,304,716 → 94,291,754 bytes).

The remaining eleven stay out, with the reasoning per package rather than as a
blanket rule: `torch` is roughly 200 MB frozen for one neural cross-check,
`darts` drags in torch and lightgbm, `prophet` carries a Stan binary, and
`biogeme`/`causalml` need a C++ toolchain at install time.

`CORE_EXCLUDES` gained both names as well, and that is the yfinance lesson
applied before it bites: the build venv is SHARED between profiles, so the
first `--full` build leaves statsmodels and arch installed and every later core
build has them sitting there importable. `quant` is already excluded, which is
what makes them unreachable — but that was equally true of yfinance's numpy,
and a lazy import inside a function still pulled it in.

### THE DOCK WAS NEVER MISSING, AND THAT WAS NOT THE POINT

Asked twice: "where is my right side decision panel, it's gone."

The mechanism was correct and was verified as such — `dockIntent` persisted
separately from `state.dockOpen`, the snapshot writing `dockIntent()`, the
narrow auto-close never recorded as a decision. A **real** keypress (not a
synthetic `dispatchEvent`, which does not reach the keymap) round-tripped it:
360px → 0 → 360px, preference `true → false → true`. So did the toolbar icon,
which is titled "Toggle right dock (B)". Nothing was broken.

What was broken is that **a closed dock left no trace on screen at all.** The
grid track went to zero and the only routes back were a key and a 22px icon —
and `shell.ts` had already written the risk down in its own comment on
`dockIntent`: *"a toolbar icon most people never find standing between the user
and their layout."* The person who owns the product read closed as gone. A
working shortcut does not fix a screen that shows no evidence the thing exists.

So closed is now visible: the track collapses to `--w-dock-rail` (22px) instead
of zero, and the dock's first child is a full-height rail carrying the word
Inspector, vertical, which reopens it.

Four details that are decisions rather than styling:

* **It writes through `dockToggle`, not `state.dockOpen`.** Reopening from the
  rail is a DECISION and has to persist as one, exactly like the icon and the
  key. Setting the screen signal directly would reopen the panel and lose it
  again on the next launch — the original bug, reintroduced from a new door.
* **It is a child of `.dock`, not an overlay on `.main`.** `.dock-resizer` is
  positioned over the chart and can afford to be at 6px; 22px would sit across
  the price axis and cover its labels. As a child it takes the track the closed
  dock now keeps, so the chart is 22px narrower and nothing is painted over.
* **`.dock > *:not(.dock-rail)` is `display: none` when closed.** The existing
  overflow rule was enough at a zero track; at 22px it would leave a vertical
  slice of the real panel showing, which reads as a rendering fault.
* **Off below 1100px and in full focus.** There the track genuinely is zero: the
  narrow dock is an overlay that narrow closes so the desk behind stays
  reachable, and 22px of permanent rail is a real subtraction from a screen with
  none to spare. The specificity had to match to do it — `.dock-rail` alone
  inside a media query loses to `.shell[data-dock="closed"] .dock-rail`, and a
  media query adds no specificity, so the rail would have appeared on exactly
  the screens it must not.

Two token errors caught before they shipped: `--text-dim` does not exist (an
undefined var with no fallback makes the declaration invalid at computed-value
time, so `color` silently becomes `inherit`), and an invented `--surface-2` when
the palette already has `--surface-hover` and `--surface-active`. The same class
of defect as hand-writing a dependency's type, in CSS.

**No automated test.** Nothing unit-tests `mountShell` — it is a 6,300-line
closure and there is no test in `app/test/` that mounts it — so this was
verified in the browser instead: rail hidden and 0px with the dock open; 21px
wide, 730px tall, `display: flex` at x=1379 with it closed; `display: none` at
900px and under `data-focus="full"`; and clicking it restoring 360px with the
preference back to `true`.

### VERIFIED

```
python verify.py --lint     7 stages PASS, 57s
iram-full.exe               94,291,754 bytes, 14:00:47  (was 86,304,716, 13:36)
```

Nothing held the exe this time — both processes checked before the build, per
the rule the previous entry added.

## v51.8 — THE BINARY, AND WHERE ITS DATABASE WENT

Rebuilding the binary against the new launcher meant deciding what "the new
launcher" is for a frozen build, and that question found a worse bug than the
one it started from.

### THE PACKAGED PRODUCT THREW ITS DATABASE AWAY ON EVERY CLOSE

`mishel_service.py` line 40:

```python
DB = os.environ.get("MISHEL_SVC_DB", os.path.join(os.path.dirname(__file__), "mishel.db"))
```

In a one-file PyInstaller bundle `__file__` is under `sys._MEIPASS` — the
extraction directory, which is deleted when the process exits. Measured by
running the shipped `iram-full.exe` and searching for the file:

```
C:\Users\syedm\AppData\Local\Temp\_MEI0000268c2\mishel.db     139,264 bytes
```

Every run of the product people download started with an empty database. No
alerts, no journal, no ledger, no settings backup, and nothing on screen saying
so. A source checkout never saw it, because there `__file__` IS `server/` and
the file simply persists — which is why it survived every test.

`entry.py` now sets `MISHEL_SVC_DB` to the platform's per-user data directory
before the service imports, and PRINTS the path. Per-user rather than beside the
executable on purpose: an exe in `Downloads`, in `Program Files` or on a
read-only volume still has somewhere to write, and replacing the binary with a
newer one does not orphan the operator's history. Verified on the rebuilt
binary:

```
  data   C:\Users\syedm\AppData\Local\IRAM\mishel.db
  ...
  mishel.db                 147,456     <- survived the process being stopped
  mishel.db.bak-20260910    139,264     <- the backup loop had already run
```

That second file is also the proof that the loops are on.

### `entry.py` MIRRORS `run.py`'S THREE DECISIONS

Loops on (`IRAM_BACKGROUND=1`), browser opened only once `/api/health` answers,
and an already-running instance reused instead of dying on the bind. A binary
that skipped them would be a worse product than the checkout it was built from,
which is the wrong way round for the thing people download.

The browser wait replaces a `time.sleep(1.0)` whose own comment said a readiness
probe was "not worth it here". In a `--full` build a cold start is several
seconds of scipy, pandas and yfinance, so a browser arriving at one second lands
on a terminal whose every desk reports its service missing.

Deliberately NOT shared code with `run.py`: that one spawns `python -m gateway`,
this one runs the app in-process because a bundle has no interpreter to spawn.
Different bodies, same three decisions, stated in both.

### A ONE-FILE PYINSTALLER BINARY IS TWO PROCESSES

The first rebuild failed:

```
PermissionError: [WinError 5] Access is denied:
    server\build\dist\iram-full.exe
```

`Get-Process *iram*` before starting had shown nothing, and I had stopped the
binary I ran for the database measurement — but I stopped the BOOTLOADER (pid
9868) and the app process it spawns after unpacking (pid 11836) went on running,
and holding the exe, for four minutes. The existing rule in `CLAUDE.md` said
"do not rebuild while it is running, check the timestamp"; the sharper rule is
that stopping the PID you started is not the same as stopping the program.

Also worth recording: **renaming the exe succeeds while it is running.** Windows
blocks overwrite, not rename, so a rename test proves nothing about the lock.

### THE PACKAGED QUANT DESK IS NARROWER THAN THE CHECKOUT'S, AND SAYS SO

`/quant/health` on the rebuilt binary: **4 of 19 libraries present** — numpy,
pandas, scipy, sklearn — and **13 capabilities degraded**, including GARCH
(`arch`), the ADF/KPSS structure test (`statsmodels`), seasonality (`prophet`),
the model race (`darts`) and portfolio weights (`cvxpy`).

This is pre-existing and not a regression: `FULL_DEPS` in `build_binary.py` has
only ever been numpy, scipy, pandas, scikit-learn and yfinance. It is honestly
reported rather than silently broken — the desk greys those cards out and names
the missing package. But the binary's Quant desk is materially thinner than the
one a checkout runs, and nothing in the docs said so. Recorded under Known
backlog: `statsmodels` and `arch` would restore two cards for a modest size
increase; `torch` and `darts` would not be modest.

### THE DOCK WAS NOT MISSING

Reported as "where is my right side decision panel, it's gone". It was closed,
not gone, and the code is correct: `dockIntent` is persisted separately from
`state.dockOpen` so the narrow-width auto-close cannot be written to preferences
as a decision, and the snapshot writes `dockIntent()`. Verified in the browser —
360px at 1400px wide, 0px below the 1100px breakpoint, restored on widening, and
the toolbar toggle round-trips the preference (`true -> false -> true`).

What the episode does show is the residual risk the code comment already names:
"only a toolbar icon most people never find standing between the user and their
layout". A closed dock leaves a zero-width element and no edge affordance at
all. The icon exists and is titled "Toggle right dock (B)"; that was not enough
for the person who owns the product to find it. Recorded as backlog rather than
fixed here, because it is a UI change nobody asked for.

### VERIFIED

```
python verify.py --lint     7 stages PASS, 60s
  mypy (gateway, launchers)  server/gateway + run.py + server/entry.py, clean
  ruff                       BLE001 101, S110 14, S112 14, SIM115 9, UP031 46
```

`iram-full.exe` 86,304,716 bytes, 13:36 (previous: 12:32 — timestamp checked,
per the rule). On the rebuilt binary:

```
/api/health     data ok - svc ok - quant ok - background enabled, 11 of 11 alive
/quant/health   200   4 of 19 libraries, 13 capabilities degraded, named
/svc/news/rss   200   5 feeds
/ohlc XAUUSD    200   real gold bars
/               200   1,205,334 bytes, same-origin marker present,
                      and the quant call site is `Rf("/quant/health")` —
                      the fix from v51.7 is in the bundle
/legacy         200   "not present in this build" (frozen v39 is not bundled)
second launch   exit 0, "already running", no crash
```

## v51.7 — ONE LAUNCHER, AND THE 404 THAT WAS A MISSING `()`

The operator's report was "the quant server is not running" plus "there are
three files run.bat, mishel.bat and run.sh — I want a single file that works".
Both halves turned out to be the same story told from two ends.

### THE QUANT DESK HAD NEVER WORKED

`data/quant.ts` line 34:

```ts
export const QUANT_BASE = (): string => quantBase();   // a FUNCTION
...
await fetch(`${QUANT_BASE}/quant/health`)              // interpolated
```

A template literal stringifies a function **by its source**. Measured in the
shipped bundle — `el=()=>kf()` — and reproduced in the page:

```
url       "() => quantBase()/quant/health"
resolved  http://127.0.0.1:8787/()%20=%3E%20quantBase()/quant/health
status    404
```

Which is exactly the red `HTTP 404` on screen. Meanwhile the service itself,
asked directly from the same page, answered 200 with all nineteen libraries
present. Three call sites, all three broken, since the day the base became a
function.

**Why nothing caught it.** `tsc` cannot: interpolating a function into a
template is legal TypeScript. And the only test that touched the address was

```ts
expect(r.reason).toContain(QUANT_BASE);
```

— where `r.reason` had been built by the *same* interpolation. Both sides were
the same stringified function source, so it passed. **An expected value taken
from the code under test cannot fail.** That is the transferable lesson here,
not the missing parentheses.

**The fix is a shape.** `quantUrl(path)` joins the base and the path, so there
is no bare base left in the module to interpolate and the mistake has nowhere to
recur. Three new tests assert the URL `fetch` was actually called with, parsed
rather than compared to the helper that built it; 2 of 3 fail with the defect
reinstated, and the third — the one first written as `toEqual([quantUrl(path)])`
— PASSED with the defect in place until it was rewritten to parse the pathname.
Even while writing the regression test, the self-comparison was the first thing
that came out.

### NINE LAUNCHERS, TWO OF WHICH STARTED A BACKEND THE FRONTEND CANNOT ADDRESS

    run.bat  run.sh  run.command            ->  run.py
    start_mishel.bat  start_mishel.command  ->  start_mishel.py
    server/run_server.{bat,sh}              ->  ddt_data_server.py
    server/run_service.{bat,sh}             ->  mishel_service.py

`run.py` and `start_mishel.py` both started the pre-consolidation layout —
three services on :8787, :8788, :8789 — and served the terminal themselves on
:8000. `app/src/data/backend.ts` now holds ONE base address for all three,
because the gateway hosts all three in one process, and a page served from :8000
carries no `iram-backend` marker, so it falls back to the shipped default of
:8787 **for everything**. In the old layout :8787 is the data proxy, which
answers `/svc/*` and `/quant/*` with its own Flask HTML 404 page.

So: the Quant desk 404s, and the news bar reads *"the news service is not
answering on this address"* — which is the sentence `rss.ts` prints when
`res.json()` chokes on the `<` of an HTML body. **Both services were up and
healthy the entire time. They were being asked on the wrong port.**

Nine entry points are now four, one of which has any logic:

| file | what it is |
| --- | --- |
| `run.py` | the launcher. Every decision. |
| `run.sh` `run.bat` `run.command` | three lines each: find Python, exec `run.py` |

A shell script cannot be the single file: Windows will not run a `.sh` from a
double-click and `.bat` does not exist off Windows. Python is already a hard
requirement, so the logic lives in the one language guaranteed present.

`run.py` starts the gateway as a **subprocess**, not by importing it. Importing
would be a third copy of "how to start uvicorn" beside `gateway/__main__.py` and
the binary's `entry.py`, and three copies of one decision is how
`tests/run_tests.sh` came to carry a test list five files out of date.

### THE ELEVEN SERVICE LOOPS HAD NOT RUN SINCE CONSOLIDATION

`gateway/background.py` says they need `IRAM_BACKGROUND=1` and credits
`start_mishel.py` with setting it. `start_mishel.py` started three separate
processes and never went near the flag — and no other launcher set it either.
`/api/health` on the running gateway: `background: {enabled: false}`. Alerts,
backups, the ledger resolver, the OHLC cache and the dead-man's-switch heartbeat
whose entire job is to make silence audible: all silent.

`run.py` sets it. `/api/health` now reports **11 of 11 alive**, each with its
last tick age. A comment naming the component that is supposed to do something
is not evidence that anything does it.

### `run.py` WAS THE LARGEST MODULE OUTSIDE EVERY GATE

The file a first run executes was linted by nothing and type-checked by nothing.
Same mechanism as the nineteen hidden test files: a path in no list is a path
nobody checks. `verify.py` now lints `server tests run.py verify.py` and
type-checks `server/gateway run.py`, both blocking — and doing so immediately
found a **redundant second ruff pass inside `verify.py`'s own lint stage**, whose
`ok` and `tail` were both discarded. Two full lint runs for one answer, in the
file whose job is checking things.

### ALSO

* `/legacy` is now a gateway route, so `run.py --legacy` still reaches the
  frozen v39.29 terminal from the same single port. Deliberately served WITHOUT
  the `iram-backend` marker: v39 addresses :8787 and :8788 as literals of its
  own and does not read the tag, so injecting it would be claiming to configure
  something that cannot be configured.
* `str.rstrip("/legacy")` in this launcher's own banner, caught in review: it
  takes a set of CHARACTERS, not a suffix. Replaced by passing the origin and
  the target as two parameters.
* `run.py`'s `report()` first guessed `background.loops` was a list of records
  and fell back to `len(loops)`. It is a MAPPING of name to record. The guess
  would have printed "11 loops running" with three of them dead. Read the real
  shape — the same rule as never hand-writing a dependency's type.
* `-u` on the child and an explicit flush on the banner: stdout is
  block-buffered whenever it is not a terminal, so a redirected run showed the
  uvicorn lines and none of the service report.

### VERIFIED

```
python verify.py --lint     7 stages PASS, 64s
  tsc --noEmit               7.2s
  vitest                    22.7s   (3,151 tests, incl. 3 new URL assertions)
  tests/ fully listed         0.0s
  pytest                    20.0s
  21 scripts                12.3s
  ruff (deferred set only)   0.3s   BLE001 101, S110 15, S112 14, SIM115 9, UP031 46
  mypy (gateway, run.py)     1.2s
```

Live, on one port, from `python run.py`:

```
/api/health     data ok - svc ok - quant ok - background 11/11 alive
/quant/health   200   all 19 libraries present
/svc/news/rss   200   5 feeds, 49 items
/ohlc XAUUSD    200   real gold bars via yfinance
/               200   1,205,334 bytes  the current terminal
/legacy         200   1,523,307 bytes  the frozen v39.29 terminal
```

And in the browser: the Quant desk banner reads **"Quant service up on Python
3.14.4, all 19 libraries present"**, and *Trend or mean reversion* returned
ADF p=0.760, KPSS p=0.010, VR 1.01/1.04/1.10/1.23 in 0.2s.

## v51.6 — THE SHELL CONTEXT, AND THE FIRST SECTION OUT THROUGH IT

`ui/shell.ts` was 7,442 lines — three times the next-biggest file and 9% of the
codebase. Three previous attempts to break it up were abandoned, and the reason
was always the same: a section lifted out needed a twenty-argument options
object, which moves the coupling into a signature instead of removing it.

### THE MEASUREMENT THAT MADE IT TRACTABLE

| | |
|---|---|
| top-level declarations in `mountShell` | **237** |
| read by three or more sections | **99** |
| `chart` — used by 17 sections, declared at | line 1,023 |
| `bars` — used by 13, declared at | line 855 |

The coupling is not that sections share state; it is that they share state
declared *in the middle of each other*.

**And the naive dependency count was wrong.** For the decision section a grep
said twenty-one inputs. Stripping comments and string literals first: eight were
only ever mentioned in PROSE (`chart`, `data`, `evidence`, `panel`, `shell`,
`flow`, `connection`, `drawLayer`), and `status` matched `spreadResult.status` —
a property on an unrelated object. The real surface was **thirteen**, of which
five are foundation. That is the difference between "not worth extracting" and
"obviously worth extracting", and it was invisible without stripping comments.

### THE SEAM (`ui/shell/context.ts`, `ui/shell/state.ts`)

A section depends on two different KINDS of thing, and conflating them is what
made the options objects unreadable:

- **The foundation** — `kv`, `prefs`, `account`, `state`, `feed`, `toaster`,
  `lazyDesk`. Available before any section is built, wanted by nearly all of
  them, stable. Now one typed object, assembled once.
- **Its siblings** — what one section needs from another. Specific, small,
  different every time. Still explicit parameters, because naming them IS the
  documentation of what couples to what.

`ShellState` moved to its own module because it was unexported and unreachable —
every extraction had to re-declare the shape, which is how two files come to
disagree about what `dockCard` holds. `LazyDesk`/`lazyDesk` moved for the same
reason, and `keymap`/`commands`/`toaster` moved up into the foundation: they take
no arguments and everything uses them.

**The test of the split is that the sibling list is SHORT.** Eight for the
decision section. Had it really been twenty-one, leaving it inline would have
been the better call, and this note would say so.

### THE FIRST SECTION OUT (`ui/shell/decision.ts`)

Cross-venue, derivatives, correlation, macro, drivers, the forecast view, and the
`decide()` read they feed. 508 lines, 19 declarations, **12 outputs** the rest of
the shell consumes — down from 19 ambient ones.

Generated by moving the text programmatically rather than retyping it: 508 lines
of hand-transcription is a source of silent errors, and every comment in there
was written where the code lived. Including the three separate notes about
temporal dead zones, which are the reason the declaration ORDER inside that
function is load-bearing and must not be tidied.

`watchlist` is the single genuine forward reference — declared below the section,
so it arrives as a thunk. The screener's "add these" handler runs long after
assembly; a value captured at build time would be `undefined`.

**One bug the compiler caught immediately:** the first draft typed the
fundamentals dependency as a hand-written `{ find(): … }` stub. It satisfied the
call site and then failed `derive()`, which wants the whole row. Narrowing a
dependency by retyping it is how two files come to disagree — it takes the real
`FundamentalsService` now. Same lesson as the settings-test stub in v51.3.

### RESULT

| | Before | After |
|---|---|---|
| `ui/shell.ts` | 7,442 | **6,922** |
| new modules | — | `decision.ts` 649, `context.ts` 131, `state.ts` 64 |
| tests | 3,151 | 3,151 (unchanged — behaviour is identical) |

Verified in the browser, not just by the type checker: the Decision desk renders
its full read ("SHORT at 35% confidence — 45% of the directional weight agrees,
on 78% coverage", 10 of 12 sources), all three lanes present, **zero console
errors**.

### THE PATTERN, FOR THE NEXT ONE

The remaining sections in size order: **dock 1,661**, chrome 778, main 650,
topbar 445, chart lifecycle 450. Each follows the same three steps:

1. Strip comments and strings, THEN compute the dependency set. The raw grep
   over-reports by roughly a third.
2. Split it into foundation (already in `ctx`) and siblings (explicit params).
   If the sibling list is longer than about ten, do not extract — fix the
   coupling first.
3. Move the text programmatically; return the outputs the rest of the shell
   actually reads, and let the compiler find the rest.

`dock` is the biggest prize and should be measured this way before anyone
attempts it — its raw count was 101, and on this evidence the real number is
likely far smaller.

## v51.5 — BOOT SHELL, PRESS FEEDBACK, AND AN ERROR THAT WAS TALKING TO THE WRONG PERSON

A design-engineering pass, audited rather than guessed. The audit itself is the
useful artefact: most of the usual anti-patterns were already absent.

| Checked | Found |
|---|---|
| `transition: all` | **0** |
| bare `ease-in` on UI | **0** |
| `scale(0)` entry animations | **0** |
| durations over 300ms | **0** (longest is 180ms) |
| custom easing curves | present — `--ease`, `--ease-out` |
| `:active` press feedback | 6 classes of 32 — see the correction below |
| `@media (hover: hover)` gating | **0 of 76 hover rules** |
| `prefers-reduced-motion` | 3 files |

### 1. First paint had nothing to paint (`index.html`, `main.ts`)

MEASURED: `#root` was empty, so the body carried nothing paintable until
`mountShell` had built 1,615 nodes. Navigation timing: network done at 64ms,
parse+eval 97ms, DOMContentLoaded 431ms, load 454ms — and first contentful paint
at **800ms**. A third of a second of blank window after the bytes had arrived.
Only one long task in the whole boot (121ms, after FCP), so the thread was not
the problem: there was simply nothing on screen.

`index.html` now carries a static skeleton of the chrome at the real token
heights, with its critical CSS inline in the head. **CLS is 0 across the
hand-off** — zero layout-shift entries — which is the measurable proof the
geometry matches.

**No shimmer, deliberately.** A pulsing skeleton is the reflex and the wrong
call: this is seen on every launch, and an animation met hundreds of times
should not exist. It would also claim something is still arriving when the bytes
have landed and the app is merely mounting.

**`scheduleFrame`, not `requestAnimationFrame`, AND THIS ONE BIT ME.** The first
version used two nested rAFs to remove the skeleton. A bare rAF never fires in a
tab that is not being composited — so booting into a background tab, which is
how a launcher opens this, left a `position: fixed` overlay at `z-index: 9999`
sitting over every click in the application for ever. `core/frame.ts` exists
because `ui/strategy.ts` hit the same trap and it falls back to a timer.
Verified: `hiddenAtBoot: true, bootRemoved: true`.

FCP could not be re-measured honestly in the harness — the browser pane's
visibility changes during boot, after which FCP reports when the pane appeared
rather than what the page cost. The structural change is verified instead: the
skeleton's CSS is at byte 1,727 (head), the script is a deferred module, and the
parser reaches the skeleton without executing it.

### 2. Press feedback existed on six classes and was missing on twenty-six

**THE FIRST READING OF THE AUDIT WAS WRONG, and it is worth recording how.**
"Only `risk.css` contains `:active`" was true and led to the wrong conclusion —
that nothing answered a press. `risk.css` is not a desk stylesheet; its header
reads "RISK DESK, DRAWING TOOLS, AND THE MOTION PASS", and it held an APP-WIDE
press block covering the six most-pressed classes: `.primary-btn`, `.ghost-btn`,
`.icon-btn`, `.tf-btn`, `.seg-btn`, `.draw-btn` — including the timeframe
buttons and the drawing tools, which are among the most-clicked controls in the
terminal. A grep told the truth about WHERE and nothing about SCOPE.

What was actually missing: the other twenty-six controls — settings, the
learning desk, dock chrome, the detector strip, the news bar, survey tabs.

`press.css` is now the single owner, and it adopted the values that were already
there rather than inventing new ones: **`translateY(0.5px) scale(0.985)` at
`--dur-1` (90ms) with `--ease`**. The half-pixel nudge is better than the plain
`scale(0.97)` the first draft used — the control reads as pushed INTO the
surface rather than merely shrinking.

**TWO DEFECTS I INTRODUCED AND FIXED, both invisible to the compiler:**

1. **Two press depths in one toolbar.** Adding a second block meant
   `.primary-btn` pressed to 0.97/160ms while `.tf-btn` beside it pressed to
   0.985/90ms. Precisely the inconsistency a pass like this exists to remove.
2. **A clobbered `transition` shorthand.** `transition` is a shorthand — two
   rules cannot each contribute a property, the later one replaces it whole.
   Declaring `transition: transform` in a file that loads last silently deleted
   the colour transitions eight of these classes already had, so every hover in
   the terminal went from eased to instant. Nothing failed; the interface just
   got slightly worse everywhere at once. `press.css` now declares the full
   superset — background, border-color, color, transform — and is the sole owner
   of these controls' transitions. Verified in the browser: all four properties
   present on every control.

The list IS the decision, in one reviewable place: adding a control is one line,
and "what does a press look like" has a single home.

Three shapes are excluded on purpose: **full-width rows** (a row spanning a
panel makes the whole panel look like it flexed — rows already answer with a
background change), **tab strips** (one tab shrinking against its neighbours
reads as a layout glitch), and **drag handles** (the press IS the start of a
drag). Disabled controls are pinned to `transform: none` — animating a press
that does nothing is worse than no feedback, because it actively misleads.

### 3. An error addressed to the wrong person (`data/rss.ts`)

Seen on screen: *"No news service — Unexpected token '<', "<!doctype "... is not
valid JSON. Start mishel_service.py to read feeds."* Every word true and none of
it for the operator. The service was not running, the gateway answered with its
own HTML 404, and `res.json()` choked on the first `<`. Now: *"No news — the news
service is not answering on this address."* The raw text still goes to the feed
log; a status strip is not a console. An unrecognised error is passed through
rather than given an invented friendly phrase, because that is the one case
where the exact words matter.

### STILL OUTSTANDING — recorded, not claimed

- **76 `:hover` rules are not gated behind `@media (hover: hover)`.** On a touch
  screen a tap leaves hover stuck until something else is tapped. `press.css`
  gates its own contribution; retro-fitting the other 76 is a mechanical edit
  across nine files and was not slipped in beside a press rule.
- **The Inspector is a wall of undifferentiated prose.** Seven gate items at
  near-identical weight is the densest surface in the terminal and the one the
  operator reads most. It needs a typographic hierarchy pass, not a restyle.
- **The full reskin.** Still not attempted. Nineteen desks.

## v51.4 — THE PROBABILITY LATTICE, AND RIGHT-CLICK PERSONALISATION

### The lattice (`backtest/lattice.ts`, `ui/lattice.ts`)

A Galton board on the Strategy desk whose balls are the winning configuration's
ACTUAL trades. Reference was a social clip of a "Claude Fable 5" dashboard; what
was worth taking from it was the bean-machine metaphor, not the frame around it
(a hero P&L figure, "71% WIN RATE", "LIVE ON MAINNET" — everything the honesty
contract exists to refuse).

**Why it earns its place rather than being decoration.** The hardest thing to
convey about a positive edge is that it still loses constantly. A table saying
"expectancy +0.18R, win rate 41%" is correct and conveys nothing; an equity curve
conveys the opposite, because a line ending higher looks like a process that
mostly went up. A tilted board that still sends most balls left says it in one
image.

**The line between data and animation is stated, in the module and on screen.**
Each ball is a real trade's R-multiple landing in the bin its own R belongs to.
Nothing is sampled from a fitted curve — a lattice fed by a distribution you
chose will always look like the distribution you chose. `dropOrder` shuffles
WHICH trade falls next (a board filling left-to-right in time would read as a
trend); the multiset is untouched and the final histogram is exactly the run's.
`pathFor` walks a ball to a predetermined bin: it animates an outcome rather than
computing one. The card says so in its lede — "the bin is data; the bounce is
animation".

Bins are in R, not money: money makes two runs incomparable, and −1R is a
landmark everyone reads instantly. **−1R gets its own bin** because "the stop was
hit" is one outcome, not a bucket.

`latticeNote` is computed in the model, like `Study.headline`, so a picture this
persuasive cannot be separated from its caveat by a layout change. On the real
run: *"tilted right by 0.25R per trade, and 65% of balls still land on the losing
side — 7% of them exactly on the stop. That is what an edge looks like: not
winning, just leaning."*

### TWO BUGS FOUND BY RUNNING IT

- **The rail was frozen at zero.** `lattice` was a plain `let`, so the text
  bindings that read `lattice.trades` subscribed to NOTHING — they rendered once
  and never again, while the board animated correctly beside them. It is a
  signal now. A value the view reads has to be reactive or the view is a
  snapshot of the moment it was built.
- **A fixed release rate does not survive a real run.** Fourteen balls in flight
  filled a 69-trade board in about six seconds — and would take **eight minutes**
  on a five-thousand-trade sweep, on a card that pauses whenever it scrolls off
  screen and would therefore never finish. The rate is derived from the count
  now: the board always takes ~6s and a bigger run simply rains harder, which is
  also the more honest picture.

It pauses off-screen (`IntersectionObserver`) and in a hidden tab, and
`prefers-reduced-motion` draws the finished board still — reduced motion means
"do not move", not "show less", so nothing is withheld.

### Right-click on the chart

Added **Appearance** (grid, session shading, volume, all six chart styles, log
scale) and **Moving averages** submenus, plus **Copy chart summary**. Every entry
is a command id, so a checkmark here cannot disagree with the palette or the
Chart menu.

**`chart.logScale` is new.** The log/linear switch had a two-letter button on the
price gutter and nothing else — no command, no keyboard route, nothing in any
menu. On a multi-year range it is the difference between a readable chart and a
wall.

### `booleanView` (`core/signal.ts`)

The scale signal holds `"linear" | "log"`; the command wants `Signal<boolean>`.
The obvious shortcut — `{ ...signal, peek, set }` — **type-checks after a cast
and throws at runtime**, because a signal IS a function with properties and
object spread copies the properties without the callable. `booleanView` starts
as a real function and attaches its members, and holds no state: every read and
write goes through the source, so the two cannot drift the way a mirrored copy
would.

### NOT DONE — the full reskin

The request included reshaping the whole design. That was not attempted: a
wholesale restyle of nineteen desks is not something to do blind in one pass,
and the terminal's visual language is currently coherent. Targeted work only —
the lattice, the settings density in v51.3.

## v51.3 — CHART APPEARANCE SETTINGS

Asked for "more customisation options for more flexibility, like TradingView —
grid on off, candle color change, session on off".

### A new section: Settings > Trading > Chart appearance

Separate from "Chart defaults", which is about what a fresh window OPENS on.
This is about what the chart LOOKS like.

- **Session overlap shading** — moved here, and its hint rewritten: it described
  the old additive tinting ("the tints add, so the busiest stretch is the
  darkest"), which stopped being true in v51.2.
- **Grid** — the toggle had no settings entry, only a command.
- **Up candle / Down candle** — new, with a colour picker.
- **Follow the theme again** — clears both overrides.

### THE OVERRIDE, AND WHY IT IS NOT A STORED COLOUR (`chart/palette.ts`)

The obvious design stores two hex strings and paints with them. It has one flaw
that only appears later: **the moment a colour is stored, the theme stops
mattering.** Switch from Iram to Daylight and the candles keep the greens picked
for a black background, because a stored `#2DBE8E` cannot know it was only ever
a default.

So the stored value is an OVERRIDE whose empty state means "whatever the theme
says", and clearing it **removes** the custom property rather than writing the
theme's current colour into it. Verified live: with no override, switching theme
from Iram to Institutional moved `--pos` from `#2DBE8E` to `#3FB981` and
`--candle-up` followed.

### HOW IT REACHES THE CANVAS

Two new tokens, `--candle-up` and `--candle-down`, defaulting to `--pos`/`--neg`
in `tokens.css`. `themeFromCss` reads those instead of `--pos`/`--neg`, so an
override is a custom-property assignment on `:root` and needs no code path of its
own — no extra argument on `setTheme`, no second copy of the value.

**Deliberately NOT `--pos`/`--neg`.** Those also colour a P&L figure, a passing
gate, a rising correlation and the heat bar. Someone who wants blue candles has
said nothing about whether a winning trade should stop being green. Verified:
setting the up candle to `#3fa0ff` repainted the chart (29,496 blue pixels, zero
green, volume bars included via the derived wash) and left `--pos` at `#2DBE8E`.

### A new control kind: `colour`

Swatch plus hex field, both writing through the same `def.write` so neither holds
state. `readColour` accepts only `#rgb`/`#rrggbb` — the value goes straight into
a CSS custom property, and a strict pattern costs nothing when a colour picker is
what writes it.

### THE ORPHAN TEST WAS ASSERTING NOTHING

`orphanSettings(SECTIONS, [])` — "an empty list contains no orphans" — is true of
every codebase. The mistake it was written to catch, a mistyped `section:`, can
only be caught by building the definitions that ship. `test/helpers/shippedsettings.ts`
now builds the real list against a stub, and four coherence tests run over it:
no orphans, no empty sections, unique ids, and every `read()` survives being
called. The last one caught the stub itself being too thin on the first run.

### UI density

Settings rows are `align-items: start` rather than `center` — a control centred
against a three-line hint floats in the middle of nothing — with tighter padding
and a 58ch hint measure instead of 68ch. Long measure is what made the screen
read as a document rather than a settings panel.

## v51.2 — THE CHART BACKGROUND AND THE TIME AXIS

Reported as "background grid is fucked up, need options turn grid on and off,
the chart has bugs". Three defects and two new switches. Every diagnosis below
came from sampling the live canvas, not from reading the code.

### 1. The session shading said nothing at all (`chart/engine.ts`)

`drawSessions` painted one wash per OPEN session, four of them, letting the alpha
stack so a busier hour came out darker.

MEASURED, sampling a row of background pixels: the base colour `11,14,20`
appeared **nowhere inside the data** — only `17,20,26` and `23,26,31`, one wash
or two. The four windows TILE THE DAY: Sydney 21-06, Tokyo 00-09, London 07-16,
New York 12-21 covers every hour from 0 to 23, because that is what a 24-hour
market is. So "a session is open" was true of every bar, shading it carried zero
information, and all that varied was overlap depth — rendered as a five-level
difference in darkness with hard edges at arbitrary-looking places. Which is
exactly what a broken grid looks like.

Now it shades the **overlaps**: the hours two centres are open at once. London
into New York is the deepest liquidity of the day; Tokyo into London is the other
one anyone trades. Twelve hours of twenty-four, one uniform wash, so the chart
alternates between plainly-shaded and plainly-not instead of between two shades
of nearly-the-same. Verified after: two colours on the sampled row, `11,14,20`
and `17,20,26`, and the double-wash level gone.

`sessionsOpenAt` is exported and tested against the real `SESSIONS`, including
the test that pins WHY — at least one session is open at every hour of the day.

### 2. The time axis appeared to run backwards

Every intraday tick was formatted as a bare clock time. MEASURED at 800 hourly
bars on a full-width chart, the tick stride is **48 bars — two days** — so the
axis read "07:00 AM, 02:00 AM, 09:00 PM, 04:00 PM" with nothing anywhere saying
each step crossed two midnights. It looks like time running backwards.

`axisTimeLabel` now shows the DATE when a tick lands on a different day from the
last one DRAWN, and the time otherwise. At a two-day stride every label is a
date; at a six-hour stride the first tick of each day is a date and the rest are
times. Compared with `toDateString` (local), matching the local clock times the
labels are formatted in — a UTC comparison would put the date change in the wrong
place for everyone west of Greenwich.

"The last one drawn", not "the previous tick": a tick skipped by `axisLabelFits`
was never shown, so comparing against it would put a date on a label whose day
the reader never saw begin.

### 3. Two switches that did not exist

- **`chart.grid`** — new. The grid was unconditional.
- **`chart.sessions`** — the `sessionBands` preference existed and had NO user
  interface at all, so the shading could not be turned off by anyone who did not
  edit local storage.

Both are in the Chart menu and the palette, both persist. Verified all four
combinations by sampling the canvas: grid off drops the distinct colour count
from 39 to 19, both off leaves a single uniform background colour.

### `hourInBand` now normalises, matching `sessionOpenAt`

The chart's copy and `data/sessionmap.ts`'s copy answer the same question for the
same windows and disagreed at the edges — one normalised the hour, the other did
not. `utcHour` keeps its result in 0-23 for any real timestamp so nothing was
wrong on screen; two same-named rules with different edge behaviour is a trap for
whoever next passes an hour in from somewhere else.

### OPTIMISATION — measured, and there was nothing to do

Zero long tasks across zoom in, zoom out and two full-width pans. The render path
is already clean. `drawSessions` does one fill pass instead of four, which is a
correctness change that happens to do less work; it is not a speed fix, and there
was no speed problem to fix.

## v51.1 — THE BOTTOM OF THE TERMINAL

Reported as "bottom is broken, i need a separate news bar, background graph is
broken". Three separate defects, all measured in a browser rather than reasoned
about.

### 1. The news bar painted outside its own box (`styles/shell.css`)

`--h-news` collapses the news GRID ROW to 0 when the bar is off. It does not stop
the bar rendering: the element stays in the tree, `.newsbar` sets
`overflow: visible` deliberately so its list can open upward, and
`align-items: center` then centres 16-18px children on a zero-height line.

MEASURED: row at y 830, children at **y 821-839** — nine pixels over the chart's
time axis above, nine over the live bar below.

What made it look permanent rather than intermittent: the bar is off, so
`refreshNews` returns early and the feed never leaves its initial `{feeds: 0}`
state, which renders the words **"No feeds configured."** So the text smeared
across the bottom of the terminal was a placeholder for a bar that was
switched off.

Fixed with `.shell:not([data-news="on"]) .newsbar { display: none; }` — a row
height cannot contain something explicitly allowed to overflow it.

### 2. The news bar is now ON by default (`ui/shell.ts`, `ui/shell/prefs.ts`)

`mishel_rss.py` ships `DEFAULT_FEEDS` — five sources — so the bar has something
to say from the first run. Verified live: 5 feeds, 56 headlines.

**A default change alone reached nobody, and that is the part worth remembering.**
The preferences snapshot is rewritten on every save with the current value of
every field, so every existing install already held an explicit `newsBar: false`
written by the OLD default rather than chosen. `PREFS_SLOT` therefore goes to
**v2** with a migration that deletes a stored `false` exactly once. A stored
`true` is left alone — that could only have been deliberate — and any `false`
written after the migration is a real choice and survives.

### 3. Time-axis labels were being clipped (`chart/engine.ts`)

Both the tick labels and the crosshair's time tag were centred with no bounds
check, so text near an edge was sliced by the canvas. The screenshot showed a
bare **"PM"** and **"ug 31, 03:00 PM"** where "Aug 31, 03:00 PM" was meant.

Two rules, and they deliberately make OPPOSITE choices — now pure, exported and
tested in `test/axislabels.test.ts`:

- **`axisLabelFits` SKIPS** a tick label that will not fit whole. Nudging it into
  view would leave it over a bar it does not describe, and on a time axis nothing
  else on screen would contradict the wrong hour.
- **`clampTagCenter` MOVES** the crosshair tag into the plot. That tag is not
  what identifies the bar — the crosshair's vertical line is, and it does not
  move — so sliding the readout tells no lie. A tag wider than the plot is
  centred so it clips evenly rather than losing one whole end.

### VERIFIED

At 1920x940: rows `42 | 48 | 790 | 30 | 30`, main ends 880, news bar 880-910,
live bar 910-940, both gaps zero, and **no child overflows the news bar**. With
the bar off, the element measures 0x0 and no child renders at all.

### NEW TRAP

- **A zero-height grid row does not hide anything.** `.commandbar` and `.newsbar`
  both lift the shell's blanket clip so their menus can escape the row; the price
  of that is that collapsing the track cannot hide them. Anything given a
  conditional `--h-*` of 0 needs `display: none` as well.

## v51 — THE CONDITION SURVEY (which style works, in which condition, in which market)

`backtest/survey.ts` · `backtest/resample.ts` · `backtest/universe.ts` · `ui/survey.ts`
· Research → **Conditions**

### What it answers that the lab does not

`lab.ts` takes one family and one instrument and asks "does this survive out of
sample?" The question that comes BEFORE that is the one a trader actually starts
with: *the market is chopping — what works in a chop, and does it work anywhere
but here?* The survey runs all 26 shipped specs across a panel of markets, splits
every trade by the regime it was ENTERED in, and tabulates by style and by rule.

### The one idea worth keeping

**A significant edge across correlated markets is not a style finding.** BTC and
ETH agreeing is one market agreeing with itself. So `universe.ts` declares a
correlation **bloc** per instrument, agreement is counted by bloc rather than by
symbol, and a cell that is statistically significant but carried by one bloc is
reported as `one-market` — by name — rather than as a finding. Verified both ways
in the tests: the same synthetic edge is `holds` on a 4-bloc panel and refused on
a crypto-only one.

### The statistics, and why not the obvious ones

- **Block bootstrap, not a t-test.** Trade returns are a spike at −1R with a thin
  right tail, and consecutive trades are not independent. Measured calibration
  over 300 null runs: **5.7% / 10.7% / 20.7%** against nominal 5/10/20%, and 11.3%
  on a break-even R-shaped null.
- **Benjamini–Hochberg across every tested cell.** 26 rules × 3 regimes is 78
  tests; at 5% uncorrected about four come back "significant" on data with no edge.
- **Seeded from the data**, so two runs over the same bars give the same q.

### TWO STRUCTURAL BLOCKERS — a survey that CANNOT report a finding says so

Both were found by running it, not by reasoning about it, and both produce a
confident wrong answer rather than an error:

1. **`resolutionLimit`** — a bootstrap over N draws cannot report p below
   1/(N+1); BH multiplies by cells/rank; so the best reachable q is
   `cells/(N+1)`. At 75 cells and 200 draws that is 0.37 and **nothing can ever
   hold**. Found by a failing test, which had itself been written with a draw
   count too low to prove anything.
2. **`panelLimit`** — with fewer than 2 blocs loaded, `holds` is unreachable.
   Found watching a real run where only BTC downloaded and the desk said "none
   showed a positive edge that independent markets agreed on" about a panel
   containing one market.

Either one takes over the headline. "Nothing held" must never be a fact about the
setup delivered in the words used for a fact about the data.

### BUGS FOUND WHILE BUILDING IT

- **`ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_LENGTH` — a v50 regression of mine.**
  Adding `GZipMiddleware` left Flask's own `Content-Length` in the response beside
  the compressor's framing. Gold, EURUSD and the index silently would not load in
  the terminal while `curl` fetched them perfectly — because curl does not ask for
  gzip unless told to. Same "works in curl, unreachable from the browser" shape as
  the CORS duplication the bridge was already guarding. Fixed by the general rule
  rather than another special case: **a mounted WSGI app does not get to declare
  how its bytes are framed.** `content-length` and `transfer-encoding` joined
  `STRIPPED_HEADERS`; `content-encoding` deliberately did not.
- **The core binary shipped a provider that could not start.** `yfinance` was in
  `CORE_DEPS` while `numpy` and `pandas` were in `CORE_EXCLUDES`, so every gold,
  FX and index request answered `502 {"error": "yfinance: No module named
  'numpy'"}`. Dropping it from the deps was not enough — `p_yfinance` imports it
  lazily and PyInstaller follows a lazy import — so it is excluded too. Core is
  now honestly crypto-only and **28 MB → 20 MB**. `check_profile()` refuses to
  build a profile that installs a package it then breaks.

### GOLD WAS BEING DOWNLOADED AND THEN THROWN AWAY (`data/sessions.ts`)

The `--full` binary fetched 6,000 perfectly good gold bars and the survey
discarded them on every single run, at **96.2% coverage against the engine's 98%
floor** — leaving a panel meant to span four blocs measuring two.

The data was right and the calendar was wrong. Metals were judged by
`isForexOpen`, which models a continuous week with no daily break; but the proxy
serves `XAUUSD` from **`GC=F`**, the COMEX future, which halts an hour every
weekday to settle. So one hour in twenty-four of gold's "open" time was counted
as a hole.

MEASURED over 2,000 real hourly bars: 1,045 missing hours — 864 weekend (already
discounted), **89 at exactly 21:00 UTC** (one per trading day), the rest holidays.

`isMetalOpen` subtracts the break, anchored to **17:00 Eastern** via
`easternOffsetHours` rather than to a fixed UTC hour — 21:00 UTC in summer, 22:00
in winter, and a fixed hour would be wrong for four months a year.

**That alone was not enough, and measuring again is what found the rest.** The
break took a real 4,000-bar series from 91.3% to 95.2% — better, still under the
floor. Counting where the remaining 201 open-but-absent hours fell: **169 landed
on days `equityDay` already names** (New Year's, MLK, Presidents', Good Friday,
Memorial, Juneteenth, Independence, Labor), and the leftover five-hour fragments
were those same holidays seen in UTC, because 00:00–05:00 UTC is the previous
EASTERN evening. So metals keep the US holiday calendar, evaluated on the Eastern
date — shifting the instant by the Eastern offset makes `equityDay`'s UTC-based
date read as the Eastern one.

**Result: 91.32% → 99.13%.** 201 missing open hours → 35.

Two deliberate non-changes, both in the safe direction:
- **Half-days stay open.** Metals trade on them, merely shortened. Marking them
  closed would inflate coverage and hide real holes, which is what the floor is
  for.
- **`why === "weekend"` is ignored.** `isForexOpen` owns the weekend in UTC, and
  metals reopen Sunday evening Eastern — which `equityDay` would call a weekend.

It feeds `openSpanMs`, `marketState` (so the freshness contract stops raising a
staleness alarm every weekday at 21:00 on a healthy feed) and `sessionNote`
("market closed — daily settlement break", a reason the operator can check).

Spot FX is deliberately untouched: `EURUSD=X` is continuous and scored 99% while
gold scored 91.3% under the same model.

### THE INDEX WAS NEVER MAPPED AT ALL (`ddt_data_server.py`)

`yf_symbol` passed `SPX500` through unchanged, and Yahoo has no such ticker — so
the panel's equity leg answered 404 on every run. Now mapped to the **cash
index** `^GSPC`, which measures **99.70%** coverage under the RTH session model.

Cash index rather than the E-mini, for two reasons that agree: `^GSPC` trades
exactly the session `isEquityOpen` assumes, and Yahoo serves **630 days** of
hourly history for it against 189 for `ES=F`.

Only the four indices `equityhours.US_INDICES` models are mapped — SPX500,
NAS100, US30, US2000. GER40, JPN225 and the rest are deliberately left
unmapped: their `equityVenue` is null, so `openSpanMs` measures them against the
full wall clock, an RTH-only series scores about 25%, and the backtester discards
it. Adding the names without a session model would reinstate exactly the
"downloaded, then thrown away" failure the metals fix removed.

### WHAT THIS MEANS FOR RUNNING IT

**Gold, FX and indices need the full data stack.** They come from `yfinance`,
which hard-requires numpy and pandas.

- **Source checkout** — works today.
- **`python build_binary.py --full`** → `iram-full.exe`, **82 MB**, and it also
  brings the quant service up (core reports it down). Gold, EUR/USD and the
  index all serve from it.
- **`python build_binary.py`** → `iram.exe`, **20 MB**, crypto only, and it now
  says `No module named 'yfinance'` — a build that does not carry that provider —
  rather than a numpy error that reads as a broken install.

The survey needs two independent blocs before it will call anything held, so on
the core binary it will correctly refuse to report, naming the panel as the
limit. That is the honest answer, not a workaround: use `--full`.

### MEASURED

- Full survey, 4 markets × 6,000 bars × 26 rules: **1.86 s → 1.28 s**. The hot
  path was the **bootstrap** (1.13 s), not the 104 backtests (0.73 s) — a prefix
  sum over the circular-doubled series took each block from O(L) to O(1), halving
  it. Verified byte-identical against the element-wise version.
- Sharing one `StrategyContext` per market is worth **1.3×**, not the large win
  first claimed here: `rules.ts` only builds the columns a spec names, so the
  overlap across 26 specs is smaller than it looks. Passed as a positional
  argument with a `ctx.bars === bars` identity check, deliberately NOT on
  `BacktestOptions` — `walkForward` spreads `opts` into sliced runs, where a
  whole-series context would compute indicators partly from the future on the one
  code path whose job is to detect look-ahead.

### NEW TRAPS (v51)

- **`draws` must be chosen against the cell count.** Lowering it for a responsive
  UI silently makes the survey incapable of reporting. `resolutionLimit` is the
  guard; do not remove it.
- **A market can load and still not contribute** — coverage, demo data, a
  mismatched timeframe. The load report and the headline must always agree about
  what contributed, which is why a market refused AFTER download has its own
  struck-through state rather than staying green.
- **Session calendars are a coverage input, not decoration.** Gold's daily break
  plus the US holidays cost 8 points of coverage and silently removed a whole
  bloc from every survey. Model an instrument's actual closures BEFORE adding it
  to a panel — and never map a new symbol in `yf_symbol` without checking that
  `openSpanMs` models its session, or it will download and be discarded.

## NON-NEGOTIABLE DISCIPLINE (established over 30+ builds)
1. **Verify before touching**: `python3 /tmp/verify.py index.html` (CSS brace balance, extracts main <script>→/tmp/main.js + WSRC worker string→/tmp/wsrc.js, ID census with 8 known-benign orphans), then `node --check /tmp/main.js && node --check /tmp/wsrc.js`. The WSRC worker is a JS string literal `var WSRC="..."` — extract + check separately.
2. **Exact-string atomic patches** (Python; assert each anchor occurs exactly once, loud fail); backup before each stage (`cp index.html /tmp/index.vX.bak`); version bump 3 places (`BUILD vX` / `MISHEL · vX` / `APP_VER='X'`); changelog in DEVELOPMENT.md.
3. **One verified build per stage**; deliver BOTH full repo zip AND standalone index.html.
4. **Functional tests in Node/Python for every logic change** — extract the SHIPPED function from index.html and test it (see tests/_*_src.js pattern), not a copy. Plus a DOM/canvas render smoke-test for UI paths.
5. **HONESTY CONTRACT**: no fake data ever; failed feed = honest empty/frozen + banner, never synthesis; delayed vendors labeled "REAL · delayed"; distributions not promises; refuse fabricated "moon/win" oracles; NEVER auto-execute trades or touch wallet keys (glass-box decision support only — user executes manually at MT5).

## KNOWN TRAPS (hard-won)
- `.rail` has legacy `background:...!important` — glass rail rules need !important. `.rail overflow-y:auto` clips CSS flyouts → tooltips are body-level `#railTip` (JS).
- Proxy (yfinance) is DELAYED — proxy ticker is bar-authoritative (mergeBars tail-splice, NO local candle fabrication). Gap/quality uses MEASURED `barSpacingMs`, never UI TF.
- Nav→view is generic: clicking `.nav[data-view=X]` shows `#v-X` (getElementById, NO null guard — every nav button MUST have a matching view div).
- `_mean`/`_std` are GLOBAL `const` arrows (population std ÷N) at ~line 3258 — reuse them, do NOT redefine (collision). `atrPct` is a LOCAL const inside classifyRegime, NOT global.
- Reusable global helpers from on-chain/meme work: `normalizePair`, `memeRug`, `memeMomentum`, `rugBand`, `fmtUsd`, `fmtAge`, `_memeEsc`, `shortAddr`, `GP_CHAIN`, `BLOCKSCOUT`.
- On-chain/meme/backup source-of-truth for consensus votes: `consensusSignal(DATA)` returns `votes:[{name,cat,vote,w}]` (w set at ~line 3733). `IND._consensus` caches the latest.
- WINDOWS: all server entry scripts now `sys.stdout/stderr.reconfigure(encoding="utf-8", errors="replace")` (v14.5) — keep that; cp1252 consoles crash on any non-ASCII print otherwise.


## v47 — THE FEATURES THE REWRITE HAD DROPPED

**The complaint:** "you have omitted many features, like lot size calculator and
other many things, like strategies... the top menu is full of shit... the font
is also bad."

All three were correct, and measurable.

### The gap, measured rather than guessed
Legacy had 22 view panels; the rewrite had 10. Genuinely missing: Trade
Calculator, Hedge, Trading Sessions, Watchlist, Market Heatmap, Trending
Insights, Smart Money, On-Chain, Demo Trading, Intelligence Lab.

### Trade calculator (`risk/instruments.ts`, `risk/calculator.ts`, `ui/calculator.ts`)
72 instruments recovered from the legacy `SPECS` table (73 rows, one a duplicate key), now 129 after v49 added the forex crosses, exotics, indices and equities the symbol picker needed. TWO legacy data bugs and
TWO legacy arithmetic bugs fixed on the way in:

- `SHIBUSD` appeared TWICE as an object key; the second silently won.
- `GER40`/`UK100` were marked USD-quoted. DAX settles EUR, FTSE GBP.
- **Pip value was a hardcoded constant** — correct only at the rate on the day it
  was typed. Measured against `pip x contract x usdPerQuote`: USD/JPY 9.09 vs
  6.40 (+42%), USD/CAD 10.00 vs 7.29 (+37%), USD/CHF 10.00 vs 11.26 (-11%).
  Recommended lot is `risk / (stopPips x pipValue)`, so a 42% error there is a
  30% error in the position. Now DERIVED, exactly, for 65 of 72 — 62 where the
  quote IS the dollar, 3 more where USD is the base and the price you typed IS
  the rate. The other 7 ask for the one rate they need rather than guessing.
- **Margin used `entry x lots x contractSize` for every instrument**, which is
  only right when the quote currency is the dollar. On USD/JPY it returned the
  notional in YEN and labelled it dollars: $156,300 of margin for a position
  that ties up $1,000 — and that figure gates "can you open this at all".

Both now go through ONE `quoteToUsd`, so that class of bug has exactly one
place to live. 37 tests, including the identity
`notional = lots x contract x price x quoteToUsd` over all 129 instruments.

### Strategies (`backtest/rules.ts`, `backtest/specs.ts`, `ui/playbook.ts`)
Legacy advertised 35 strategies. They were 35 NAMES dispatched through a REGEX
OVER THE NAME, collapsing onto ~18 behaviours — all eight market-maker entries
(Avellaneda-Stoikov, order-flow imbalance, gamma scalping, cash-and-carry,
VWAP/TWAP) resolved to ONE Bollinger band-fade.

Shipped instead: a declarative rule engine (26 indicator columns, 6 operators,
conditions as data), 17 genuinely distinct specs named for what they DO, and a
runtime EDITOR. Two legacy entries deliberately NOT ported: "Kinetic Flux" (an
invented metric its own author called "open interpretation" — untestable) and
"RSI Divergence" (needs a column this vocabulary lacks; absent beats
approximated). New indicators: `roc`, `williamsR`, `cci`, `mfi`,
`supertrendDirection`. 33 tests including a look-ahead property over every spec
and a fingerprint test asserting no two specs trade identically.

### The other desks
- **Sessions** (`data/sessionmap.ts`): session clock (calendar fact) kept
  visibly apart from an activity map (measurement of YOUR archive). Mean bar
  RANGE by weekday x hour, sample count in every cell, thin cells drawn empty
  rather than coloured. Refuses to fill the grid from bars coarser than an hour.
  Bar spacing uses the MEDIAN gap, not `(last-first)/(n-1)` — one outlier bar
  destroys the mean and the grid then refuses itself as "too coarse".
- **Watchlist + Heatmap** (`ui/watchlist.ts`): one exchange snapshot feeds both.
  Heatmap saturates at the 90th percentile of today's moves, not a fixed scale.
- **Hedge** (`risk/hedge.ts`): on the Risk desk, because it is a question about
  the book. Sizes `-beta x notional` AND reports `varianceRemoved = R^2` beside
  it; refuses to size below the fit threshold. Residual risk is
  `sqrt(1 - R^2)`, not `1 - R^2` — an R^2 of 0.75 removes 75% of the VARIANCE
  and 50% of the VOLATILITY.
- **Paper** (`trade/paper.ts`): real prices, simulated FILLS. Not the removed
  DEMO mode, which generated synthetic BARS. Fills always adverse; stops driven
  by closed-bar high/low, not last price; stop wins when one bar holds both. A
  test pins the export list so no "trade the signal" entry point can appear.
- **Smart money** (`ui/smartmoney.ts`): the existing detectors, listed. Computes
  nothing new — a desk with its own "order block" would eventually disagree with
  the chart beside it.

NOT built, deliberately: **On-Chain**. The decision contributor and its shape
already exist and honestly report "Not watched for this instrument." Nothing
populates it and there is no configured source, so a desk would be a frame
around fabricated data. **Trending Insights** and **Intelligence Lab** are what
the Decision desk already does — every source weighed, with its coverage.

### The menus were full of noise, and here is why
Command-palette titles were leaking into menus. Under **Draw**, fourteen items
each began "Draw:". Under **Chart**, four read "Chart style: Candles". Under
**View**, eleven "Go to ..." rows duplicated the desk bar beside them.

A palette title must be globally unambiguous; a menu title sits under a heading
that already supplies the context. Those are two jobs and one string cannot do
both — so `Command` gained `menuTitle`, the command owns BOTH names, and the
menu picks the shorter. View went from 20 rows to 10.

### Sixteen desks do not fit on a row
Measured at 1200px: FIVE desks fitted, ELEVEN went into "More" — two thirds of
the terminal behind one anonymous button. Spilling is right for ten and wrong
for sixteen. The desks are now GROUPED (Chart / Analyse / Trade / Research /
Workspace): five buttons, 574px at 1200px, nothing spilled. The group holding
the current desk shows THAT DESK's name, so the row still answers "where am I".

### The font, measured
`document.fonts.check()` is useless — it returned TRUE for all eleven families
probed, fictional ones included. Measuring rendered WIDTH against a
known-missing family is the test that works, and on this Windows 10 machine:

    Segoe UI Variable Text      ABSENT  (Windows 11 only)
    Segoe UI Variable Display   ABSENT
    Inter                       ABSENT
    JetBrains Mono              ABSENT

So `--font-ui` and `--font-disp` BOTH resolved to plain Segoe UI, and the
heading hierarchy the design assumed did not exist — the exact failure the
tokens.css comment was written to fix, one layer down. Inter Variable (48 kB)
and JetBrains Mono Variable (40 kB), latin subsets, are now SHIPPED and
base64-inlined. Zero external references verified on the built file.

Also: tokens.css claimed ligatures were "switched off explicitly further down".
They were not, anywhere in the build. JetBrains Mono has arrow ligatures in
`calt`, applied by default. Now off on `:root` with BOTH properties, because
`font-feature-settings` overrides `font-variant-ligatures` in some engines.

### Bugs found and fixed while building
- Paper desk read `bars.peek()` inside a computed and a text binding — no
  reactive dependency, so the fill was correct but the live price and every
  unrealised P&L stayed frozen at build time.
- Paper rows marked to the MID while the summary marked to the close price:
  -$0.05 and -$0.91 for the same position, and the smaller was the flattering
  one. Both go through `realise` now.
- `parseOperand("")` returned `{number, 0}` because `Number("") === 0` — an
  unfilled editor field would have become a valid threshold of zero, and
  `RSI > 0` is true on every bar.
- `.pf-refuse` had no stylesheet behind it; `.pf-stats` ignored `data-on`, so
  hedge stats rendered as em dashes before anything was measured.


## v46.1 — THE LAUNCHERS OPENED THE WRONG TERMINAL

**The reason the app looked unchanged no matter what shipped.**

`run.py` served the repo root and opened `/index.html`; `start_mishel.py` opened
`file://<root>/index.html`. Both are the LEGACY v39.29 file — 1.5 MB, last
touched 16 July. The current terminal builds to `app/dist/index.html` and
NEITHER LAUNCHER REFERENCED IT. Every double-click since the `app/` rewrite
began opened the July build, so none of v40–v46 was ever reachable by the one
route the user actually uses.

- `/` now serves `app/dist/index.html`. The legacy file is untouched and still
  served, at `/legacy` (`python run.py --legacy` opens it directly).
- **Served over HTTP, not `file://`.** The terminal keeps its bar archive in
  IndexedDB and settings in localStorage; a `file://` page is an opaque origin
  where both are unreliable or partitioned per file, so settings would silently
  fail to persist between runs. `start_mishel.py` now runs a static server too.
- **Both static servers were single-threaded** (`socketserver.TCPServer` handles
  one request at a time). A browser keep-alive connection blocked every other
  request, so a reload or a second tab hung forever — indistinguishable from a
  broken launcher. Now `ThreadingTCPServer`. Verified with 6 concurrent requests.
- **`run.py` and `start_mishel.py` fought over ports.** Running both spawned a
  second proxy on 8787 that died on bind, silently. Each backend is now started
  only if its port is free, so the launchers compose in any order.
- `run.py` claimed the proxy was on **8899**; it binds **8787**. It also never
  started `mishel_service.py` (8788), which the terminal needs for the calendar
  snapshot and intel — so `run.bat` gave a half-configured stack. Both fixed.
- `run.py` had no `sys.stdout.reconfigure(encoding="utf-8")`, which KNOWN TRAPS
  requires of every entry script; its banner is now plain ASCII as well.
- A missing build now prints the `npm run build` instructions and exits, rather
  than falling back to the legacy file. A silent fallback is how the old
  terminal kept appearing when nobody asked for it.

Verified end to end: launcher banner correct, `/` = 498,932 bytes (v46),
`/legacy` = 1,523,307 bytes (v39.29, unmodified), `/HANDOVER.md` still served,
and the browser shows the v46 chrome on a live binance feed at ~209ms.

## WHAT SHIPPED — v46 (ONE COMMAND BAR · PORTFOLIO RISK · HONEST LEADING INDICATORS)

**1471 app tests (was 1443), 0 failures. SUITE GREEN — 93 files. Build 497.6 kB single file, 0 external refs.**
New modules: `risk/portfolio.ts`, `analysis/leading.ts`, `ui/deskbar.ts`.
New tests: `portfolio` (52), `leading` (58), `draw-tools` (29), `strategies-v46` (42).

### 1. The two chrome bars became one
v45 stacked an application row (brand · File/View/… · utilities), then the chart
controls, then a ten-tab desk strip. Two horizontal navigations is a question the
user answers every time, and the desk switcher sat BELOW the controls that belong
to the selected desk — so those controls read as belonging to the row above.

- One `.commandbar`: brand · menus · rule · desks · spacer · utilities.
- `ui/deskbar.ts` MEASURES its own allotted width and spills what does not fit
  into a counted "More" menu. Nothing is ever clipped; the selected desk never
  spills; visible tabs are a contiguous prefix. Break points are measured, not
  hand-picked media queries, so they survive a density change or a rename.
- The context bar (symbol, timeframe, style, MAs) now COLLAPSES on desks it does
  not describe — Risk, Screener, Data, Analyst, Workspace. A symbol box above the
  settings archive was a control claiming to change a view it cannot.
- **Eleven menus became six.** "Risk" held one command and a caption; "Replay"
  held three; "Analyst" held two plus a link to a desk already on screen beside
  it. Rule applied: a menu is a NOUN THE USER HAS. Replay/Alerts/Analyst moved
  under Tools, layouts under View, detectors under Chart. Nothing was removed.
- The two native `<select>`s in the row (theme, density) took 200px to expose two
  settings changed once a year, and made the chrome read like a settings page.
  Now one Appearance button; both remain under View as well.
- Menubar: 540px → 259px. All ten desks fit at 1600 and 1500; six spill at 1000.
- Retired dead tokens: `--h-menubar`, `--h-tabs`, `--w-rail`, `--w-rail-open`,
  `--z-rail`. Grid rows 5 → 4.

### 2. Portfolio risk — `risk/portfolio.ts`
`portfolioHeat` adds stops up as though positions were independent. They are not.
This measures the book from ITS OWN RETURN HISTORY in the local archive.

- Historical VaR + expected shortfall at 95/99. Quantile taken from an OBSERVED
  bar, never interpolated — interpolation invents a loss that never happened and
  always optimistically. Refuses below 60 shared bars, and says how short it was.
- **Component expected shortfall**: each symbol averaged over the SAME bars that
  made the portfolio tail. Sums exactly to the portfolio figure — no residual,
  no plug. A negative contribution is a real hedge and is tinted as one.
- **Diversification** as the Choueifaty ratio squared: four positions in four
  identical instruments score 1.0, four unrelated ones score 4.0.
- Factor betas with R² ALWAYS beside them, and a caveat sentence below 0.2.
- Five historical shocks (COVID, LUNA, FTX, yen carry, and an upside squeeze
  because a short book fails upward), propagated through the measured beta and
  labelled optimistic — betas from calm markets understate crashes.
- Never fetches. A symbol with no stored bars is NAMED, excluded, and the panel
  says the book is riskier than shown by exactly that much.

### 3. Leading indicators — `analysis/leading.ts`
Organised around what "leading" can actually mean, not around a list of
oscillators. Three families: COILED (constrains WHEN), COMMITTED (positioning,
points AGAINST the crowd), THINNING (durability). Everything else is labelled
lagging and is not promoted.

**The combining rule is the module.** Each component declares what it `speaks`
to — "when" / "which way" / "how much" — and the three outputs are computed from
disjoint sets. A compression reading cannot become a direction by a later edit
because there is nowhere for it to go. The headline is a SENTENCE, never a score
that has quietly averaged a clock with a compass.

Wired into the Decision desk as two contributors: `thinning` (0.4, below
derivatives) and `coiled` (0.3, lean permanently null). Only the thinning family
feeds it — funding and open interest are already read by `derivs`, and two
contributors fed by one measurement is the same vote counted twice.

### 4. Five drawing tools, composed from the existing four primitives
Parallel channel · Andrews pitchfork · Fib extension · Position · Arrow.
Thirteen tools total. No new painting path, so they pan, zoom and re-theme with
everything else. The **Position** tool draws risk and reward as boxes to scale
with the ratio in R — it reports the ratio and nothing else; the Risk desk owns
sizing and asks for equity first.

### 5. Three strategies that put the new claims on trial
`squeezeBreakout` (takes the break, never predicts its direction),
`donchianBreakout` (second baseline; no fixed target — a trend system that caps
winners throws away the tail), `regimeGatedReversion` (tests "reversion works in
ranges" against ADX, which is repeated constantly and tested almost never).

### 6. Two analyst tools, read-only
`get_leading_read` (three axes kept separate; the description tells the model in
as many words that compression has no direction) and `get_portfolio_risk` (a
block is passed straight through; the exclusion list is in the SUMMARY, not
buried in a warning it might paraphrase away). The exact-allowlist safety test
caught them being added, which is what it is for.

### BUGS FOUND — every one by a test or by running the thing
- **A false claim in my own module comment.** Inverse-HHI of risk contributions
  was documented as a diversification measure. A test on four IDENTICAL series
  scored 4, not 1. It measures CONCENTRATION; renamed `effectiveContributors`,
  and a real diversification measure added beside it.
- **A data gap read as a correlation finding.** Live, the panel said "2 positions
  behaving like 1.0 independent ones" when the second symbol had no stored bars
  and was never looked at. `diversification` now counts measured legs only, and
  missing symbols get an explicit row instead of vanishing from the table.
- **Percentile ties put a flat series at rank ZERO** — the tightest reading
  available — when the truth is exactly typical. A stablecoin pair or a halted
  instrument produces that data. Mid-rank convention; fully tied window → 0.5.
- **`.dd-danger` used five `!important` declarations** in a sheet whose header
  says it never uses them. They were doing the job of specificity; chaining
  `.primary-btn.dd-danger` wins at (0,2,0) and stays overridable.
- **"43th percentile"** on the Decision desk. `ordinal()`, with the 11/12/13
  exception every home-made version gets wrong.
- Four of my own test fixtures were wrong and each taught something real —
  see MEASURED PROPERTIES below.

### MEASURED PROPERTIES, recorded because they surprised me
- A percentile threshold fires on a FIXED FRACTION of history by construction.
  The tightest 15% of a series is 15% of it however violent the series is, so
  `squeezeBreakout` cannot be made selective by the squeeze condition alone —
  every bit of its selectivity is the close outside the band.
- A contraction that OUTLASTS the ranking window disappears, because the window
  becomes the contraction. A months-long coil is invisible on a short timeframe;
  that is why `lookback`/`rank` are parameters and not constants.
- The look-ahead test (every candidate evaluated twice, once against a physically
  truncated series) passed for the whole grid including the pre-existing ones.

## WHAT SHIPPED — v44 (THE EVIDENCE BUS: one read, from every source)

**1140 app tests (was 1041), 0 failures. SUITE GREEN — 93 files. Build 433.7 kB single file, 0 external refs.**
New desk: **Decision**. New modules: `core/evidence.ts`, `core/decision.ts`,
`ui/decision.ts`, `data/spread.ts`, `data/correlation.ts`.

### 0. THE POINT: cohesion, not more panels

The terminal had grown eight things that each knew something — structure, MTF,
confluence, regime, derivatives, fundamentals, cross-venue, correlation — and
each drew its own panel. None could see the others, so the synthesis happened in
the user's head, which is the one place it is least reliable and least auditable.

`core/evidence.ts` is a common SHAPE every source reports in: a lean, a weight,
a sentence, a provenance, a freshness, and what would flip it. The combining
function is deliberately simple; the value is in the shape.

**THREE THINGS IT DOES THAT A WEIGHTED AVERAGE DOES NOT.**

1. **ABSENCE IS EVIDENCE.** A source that could not answer is recorded and
   REDUCES COVERAGE. Four agreeing out of ten possible is not four out of four,
   and every naive blend reports them identically. Confidence is agreement ×
   coverage and can never exceed coverage — so perfect agreement among two of
   ten cannot read as high confidence.
2. **AGREEMENT IS SEPARATE FROM SCORE.** Six weak-agreeing and three-hard-each-way
   average the same. Verified live: the desk reported "SHORT at 28% confidence"
   and, unprompted, "Only 57% of the directional weight leans short. The sources
   disagree; the average hides that."
3. **NOT EVERYTHING HAS A DIRECTION.** Fundamentals, cross-venue and correlation
   carry `lean: null` — they count toward coverage, contribute nothing to the
   score, and are still shown. A 6% float is not bullish; the moment it votes it
   becomes a thesis rather than a constraint.

`core/decision.ts` holds every weight in ONE table with a comment saying what
each is relative to. None is fitted — fitting weights to past outcomes is exactly
how the confluence score reached PBO 89%, and this assembly would inherit that.

**THE HARDEST GATE:** an uncalibrated forecast contributes NOTHING and says so.
Admitting it at reduced weight would launder noise into a number that looks
considered.

### 1. A HONESTY DEFECT I SHIPPED AND CAUGHT ON SCREEN

The aggregate limit line read "*X, Y, Z do not cover this instrument*". True of
on-chain data on gold; false of a higher timeframe nobody enabled, a model
nobody ran, and a scan that had not happened. Each row's own reason was
accurate — the SUMMARY was asserting a cause it did not know. It now counts and
points ("N sources had nothing to say here… each row below says why") and states
only what is true of all of them: not answering is not answering neutral.

### 2. Cross-venue (`data/spread.ts`)

Four books on one instrument. A wick in one venue is a thin-book liquidation,
not a move; stablecoin drift means the "price" moved for a reason unrelated to
the asset. Median, not mean, so one lagging venue cannot drag the reference.
The note describes and explicitly says **NOT free money** — fees, withdrawal
time and transfer risk sit in front of any spread by the time you can see it.

**MEASURED:** OKX intermittently omits its CORS header (seen once on
`/market/ticker`, fine on retry). `allSettled` means that costs one quote, not
the read — the design already handled it.

### 3. Correlation (`data/correlation.ts`)

The Risk desk sums heat as though positions were independent. On a correlated
book that is an understatement: five 1% positions that move together are one 5%
bet with five tickets. `heatUnderstatement` returns the ratio, declared as a
LOWER BOUND (equal weights, average correlation, and correlations rise in
exactly the drawdowns that matter).

Log returns, not prices — two assets both drifting up correlate near-perfectly
on price and can have uncorrelated daily moves. And the join is on TIMESTAMP:
correlating by array position silently pairs Tuesday with Wednesday and produces
a confident, meaningless number. Costs ZERO requests — `scanUniverse` already
retained the closes and was discarding them.

### 4. Streaming, PNG export, and the `.view-slot` fix

**Streaming** (OpenAI-compatible SSE) reassembles tool calls by `index` — the
name arrives in one delta and arguments across several, and treating each delta
as a complete call is what makes streaming tool-use look broken. Streamed text
is kept OUT of the transcript and rendered as a visibly provisional dashed
bubble: the transcript is the audit record and holds finished turns only.

**PNG export** composites both canvas layers over an opaque background (a
transparent PNG is unreadable pasted into a light theme) and burns the symbol,
timeframe, source and time into the pixels — an exported chart outlives its
context.

**`.view-slot`** finally fixed at the container after being patched around three
times. Then a second form of the same trap appeared immediately: `min-width:
auto` on a grid item resolves to min-content, so the screener rendered 655px in
a 629px slot and pushed the shell. `.view-slot > * { min-width: 0 }`. Verified
zero slot overflow across all eight desks.

### NEW TRAPS (v44)

- **`effect()` and `computed()` run IMMEDIATELY, and TS cannot see it.** The
  correlation effect read `screener.rows()` from 1,200 lines above the
  screener's declaration. tsc says nothing because the reference is inside a
  closure. Second occurrence after `drawLayer` in v43.1 — assume any
  `effect`/`computed`/reactive prop referencing a later `const` is broken.
- **A summary must not assert a cause it does not know.** See §1.
- **Assert in patch scripts.** Two edits this session printed success while
  their anchor never matched (`async () =>` vs `() =>`). Both were caught by a
  test count that did not move; neither would have been caught by tsc.

### STILL NOT BUILT — asked for, not yet delivered

These were requested in the same batch and are NOT done. Listing them here so
the gap is explicit rather than discovered later:

- **Replay and the desks following the focused workspace pane.**
- **Alerts running inside the desktop process, with a tray icon.**
- **On-chain evidence.** `data/decision.ts` has the contributor and the shape;
  nothing populates it, so it reports `absent` truthfully.
- **Multi-timeframe alert conditions.**
- **Desktop installer, code signing and updater.** Still `--no-bundle`.
- **Accessibility audit.** Roles and aria exist; never tested with a screen
  reader or keyboard-only.

**STANDING RECOMMENDATION, WITH MORE FORCE THAN BEFORE: do not automate anything
off the Decision desk.** PBO 89% on the confluence score alone, and a number
assembled from more inputs looks more authoritative without being more reliable.
The desk says this on screen.

## WHAT SHIPPED — v43.1 (NO DEMO MODE, FOUR MORE VENUES, FUNDAMENTALS)

**1041 app tests (was 993), 0 failures. SUITE GREEN — 93 files. Build 404.8 kB single file, 0 external refs.**
New modules: `data/venues.ts`, `data/fundamentals.ts`, `ui/fundamentals.ts`.

### 1. DEMO MODE IS GONE — the generator, not just the button

Earlier builds shipped synthetic bars the operator selected deliberately,
labelled `demo` in every surface so nothing could silently transition into them.
That was a defensible design. It is now deleted, because the strongest version
of "this terminal never shows you a fake price" is not a carefully-labelled
fake-price mode — it is the absence of any code that can produce one.

Removed: `demoBars()`, `useDemo()`, the toolbar button, the command, the demo
banner, and `"demo"` from `FeedQuality`. The failure state is an empty chart
that says why.

`DataQuality` in barstore.ts KEEPS `"demo"` and only there. It is a persisted
enum and an archive written by an earlier build may still hold demo segments;
the reader has to keep understanding the value so the retention sweep can find
and remove them. It is a legacy value on the way out, not a mode.

### 2. Four more venues (`data/venues.ts`)

Coinbase, Bybit and OKX join Binance and the proxy. Until now a crypto chart
came from Binance or from nowhere — one venue's outage, one venue's rate limit.
Three things change:

- **A 418 stops being fatal.** The governor parks a banned host for hours
  (correctly — probing extends a Binance ban), and that meant no chart at all.
- **USD becomes available.** Binance quotes USDT, a token with its own credit
  risk and basis. Coinbase quotes dollars. The difference is occasionally the
  whole story, and `coinbaseQuote` maps a stablecoin quote onto the USD book as
  a DECLARED approximation rather than silently.
- **Depth outside one book.** A wick on one venue and nowhere else is a thin-book
  liquidation, not a market event, and you cannot tell from inside one feed.

Each venue's parser handles a genuinely different payload, and each difference
would fail silently: Coinbase is `[time, low, high, open, close, volume]` with
time in SECONDS and NEWEST FIRST (seconds land the series in 1970; a reversed
series renders as a mirror image). Bybit answers HTTP 200 with an error CODE in
the body. OKX marks the still-forming candle with `confirm: "0"` and it is
dropped, because a partial candle presented as closed is what the detectors
explicitly refuse to reason about.

Every host got its own governor policy, sized well under the published limit —
these are FAILOVER sources, and arriving at a second venue with an aggressive
rate trades one ban for another.

**A REAL BUG THE TESTS CAUGHT:** `supports()` was `splitPair(symbol) !== null`,
and `splitPair("EURUSD")` succeeds — EUR/USD IS a pair. So all three crypto
venues claimed forex and would have 404'd on it. Fixed by using `looksCrypto`,
which was ALSO the second half of the fix: that predicate lived in sources.ts
while `splitPair` lived in venues.ts, and two files with their own idea of "is
this crypto?" is how a forex request reaches a crypto exchange. `looksCrypto`
moved next to `splitPair` and is re-exported. One owner.

### 3. Fundamentals (`data/fundamentals.ts`, `ui/fundamentals.ts`)

A candle cannot tell you the float is 6%, that a fifth of the cap unlocks over
eighteen months, or that the whole capitalisation is smaller than one day of
another asset's volume. Six figures that change a decision, in the inspector
beside the chart:

market cap and rank · fully-diluted valuation and the **dilution multiple** ·
**float** (circulating over max) · **turnover** (24h volume over cap) · drawdown
from the all-time high with the date · 24h/7d/30d change.

Each derived figure earns a plain-language note on a defensible threshold — a
float under a fifth, dilution over 3×, turnover under 1% or above 100%. They
describe the number; they do not say what to do about it. Turnover above the
whole market cap says explicitly that it "cannot tell you" whether that is a
real event or wash trading.

**PROVENANCE TRAVELS WITH THE NUMBERS.** CoinGecko is an aggregator and
CIRCULATING SUPPLY IS SELF-REPORTED BY PROJECTS — float and dilution are both
computed from it. The panel says so on screen rather than presenting a computed
float as measured. One request returns 250 assets, cached for an hour.

Only the price changes are coloured. A low float is not bad and high turnover is
not good; both are facts whose meaning depends on what you are doing.

For metals, FX and equities it says there is no fundamental data rather than
rendering an empty frame that looks like a load that never finishes — and the
agent tool returns an error telling the model not to reason as though there were.

### 4. `get_fundamentals` — the 22nd agent tool

Its description carries the self-reported-supply caveat, so a connected model
relays provenance rather than stating float as fact.

### NEW TRAPS (v43.1)

- **A reactive prop runs its effect IMMEDIATELY, at `h()` time.** The drawing
  toolbar's `disabled: () => drawLayer?.selected() === null` sits several
  hundred lines above `const drawLayer = ...`, so every boot threw "Cannot
  access 'drawLayer' before initialization" — four times, inside a signal effect
  that swallowed it into a console error instead of a visible failure. `let x =
  null` hoisted next to the other state, same as `chart` and `agentDesk`.
- **THE BROWSER PANE CACHES `index.html` HARD.** A fix verified as "still
  broken" three times in a row was cached; `curl` proved the server was serving
  the corrected bytes. A FRESH TAB is the only reliable check. Mid-diagnosis I
  inferred a second faulty variable from two distinct minified names in that
  cached output — there was only ever one bug.
- **A pair splitter is not a coverage predicate.** `splitPair` correctly parses
  EURUSD; that does not mean a crypto exchange lists it.

### STILL NOT BUILT (unchanged)

Replay and the desks follow the Chart desk, not the focused workspace pane. Tick
storage. Desktop installer, signing and updater. **Do not automate anything off
the confluence score — PBO 89%.**

## WHAT SHIPPED — v43 (RISK, DRAWINGS, THE LIVE UNIVERSE, AND MORE TOOLS)

**993 app tests (was 826), 0 failures. SUITE GREEN — 93 files. Build 391 kB single file, 0 external refs.**
New desks: **Risk** — the last placeholder is gone, every tab is real.
New modules: `risk/sizing.ts`, `draw/{model,store}.ts`, `data/catalogue.ts`, `ui/{risk,drawing}.ts`, `styles/risk.css`.

### 0. A SECURITY BUG FROM v42, FOUND AND FIXED

`syncable()` had its own hand-maintained prefix list while the vault used
`looksSecret()`. When the analyst's API key arrived under `agent.credential`,
the vault correctly withheld it from every export and **sync happily pushed it,
in plaintext, to whatever Supabase project or custom endpoint was configured.**

Neither rule was wrong. The bug was that "is this a credential?" had TWO
ANSWERS, so protecting the export path did not protect the sync path.
`syncable()` now calls `looksSecret()`. Any future credential-shaped key is
covered by both automatically. Found by auditing sync scope AFTER shipping the
key, which is the wrong order and worth saying so.

### 1. The Risk desk (`risk/sizing.ts`, `ui/risk.ts`)

`server/mishel_risk.py` had been 421 lines of finished logic behind four live
endpoints that **nothing in the app ever called**. Every other desk answers
WHETHER; this one answers HOW MUCH, which is the question that decides whether
an account survives being wrong.

It is a CALCULATOR, NOT AN ADVISOR. You supply equity, risk percentage, entry
and stop; it multiplies. It never proposes a risk percentage, never says whether
a trade is worth taking, and has no broker connection — which it states on
screen, because a risk panel that looks like it is watching your positions when
it is not is worse than no risk panel.

Four things ordinary size calculators get wrong, all fixed here:

- **They report the risk you ASKED FOR.** Venue quantity steps mean the
  submittable size is not the computed one: round 0.0187 BTC down to 0.018 and a
  1% trade is a 0.963% trade. Every figure is post-rounding, with the requested
  one beside it. Rounding is always DOWN — up would raise risk silently.
- **They divide by zero and call it infinity.** A stop at the entry is not a
  very large position, it is not a position. Refused, along with anything inside
  one basis point where tick rounding exceeds the stop distance.
- **They ignore the notional.** A 0.05% stop turns 1% of equity into a 2000%
  position. The exposure cap binds and SAYS it bound, because the resulting risk
  is then smaller than requested.
- **They quote risk before costs.** Fees are optional input; when absent that
  omission is stated in `assumptions` rather than passed off as zero.

Also: portfolio heat that reports itself as a FLOOR when any position carries no
stop, reward-to-risk that always shows the BREAK-EVEN WIN RATE beside the ratio
(3:1 is not a good trade, it is a trade that needs 25%), and guardrails that are
limits you set checked against numbers you report.

**VERIFIED LIVE** on a 1-minute chart, where 1.5×ATR is a 0.064% stop: the
exposure cap bound, and the desk reported round-trip costs at **157% of the
amount at risk**. That is the tool earning its keep on a setup that looks fine
until somebody multiplies.

### 2. Drawing tools (`draw/model.ts`, `draw/store.ts`, `ui/drawing.ts`)

Eight tools: trend line, ray, horizontal, vertical, rectangle, Fibonacci,
measure, note. Magnet to OHLC, drag handles, undo, per-symbol persistence.

**ANCHORS ARE TIMES, NOT BAR INDICES.** An index is a position in whatever array
is loaded right now; backfill four hundred bars and every index shifts by four
hundred. A tool storing index 512 slides every trendline you own down the chart
the first time the archive fills a gap, and it looks like the CHART moved.
`{ t, p }` survives a reload, a backfill, a timeframe change and a source
failover.

Drawings render through `setAnnotations` — the same path the detectors have used
since v40 — so a hand-drawn trendline and a detected one are pixel-identical and
pan, zoom and re-theme together. Pointer input listens on the chart HOST in the
CAPTURE phase and calls `stopPropagation` only when it is genuinely taking the
interaction, so panning a chart with drawings on it behaves exactly as before.

**A REAL BUG THE FIRST DRAW FOUND.** `Series` pre-allocates its Float64Arrays,
so `series.t.length` is the CAPACITY (4096), not the bar count (802). Passing
the raw array to `timeAtIndex` made it read three thousand trailing zeros as
timestamps: spacing went negative and **every drawing's second anchor was stored
as `t: 0`** and rendered 26,000px off screen. `subarray(0, length)` is a view,
not a copy. Pinned by two tests, one of which asserts the unbounded array IS
wrong so the reason survives.

Also fixed by testing: a horizontal line exposed a drag handle at one arbitrary
point along it. Its anchor's TIME is meaningless — offering a handle there
invites adjusting a coordinate that does not exist. For hline and vline the
whole line is the handle.

### 3. The live symbol universe (`data/catalogue.ts`)

The palette shipped with thirteen hard-coded symbols. Now it searches every
symbol the venue lists — **3,081 of them** — cached for a day because the
universe call costs weight 40, the most expensive request the terminal makes.

**MEASURED AND WRONG ON THE FIRST TRY:** ranking by `quoteVolume` put
`USDTIDRT`, `BTCBIDR` and `ETHBIDR` at the top of the entire exchange. That
figure is denominated in the QUOTE asset and one rupiah is about 1/16,000 of a
dollar — the number was not wrong, comparing it across currencies was. With no
FX table there is no honest conversion, so the ranking sorts by quote TIER
first (dollar-quoted, then major-crypto, then everything else) and volume within
the tier. Top six now: `USDCUSDT, BTCUSDT, ETHUSDT, ETHUSDC, BTCUSDC, SOLUSDT`.

`symbolHaystacks` splits a pair into its legs, so "btc usd" finds BTCUSDT even
though that space is not in the symbol.

### 4. Eleven more agent tools (`agent/tools.ts`)

`get_risk_state`, `size_position`, `stop_from_atr`, `reward_to_risk`,
`run_backtest`, `scan_market`, `list_drawings`, `draw_level`,
`promote_detection` — the agent can now COMPUTE, not only read.

`promote_detection` turns a structure the detectors found into an editable
drawing you own, which is the honest version of "AI-powered drawing": the
detector found it, you can now drag it.

**THE SAFETY TEST WAS REBUILT.** It was a regex over tool names, and it was the
wrong shape twice over: it rejected `size_position` for containing "position"
while a tool called `submit_fill` would have sailed through. It is now an EXACT
ALLOWLIST of all 21 names, so a new capability has to be added in a test called
"the agent can reach exactly these", where a reviewer sees it.

`size_position` will not choose a risk percentage — `risk_pct` is optional and
the description says to omit it unless the user stated one, because picking a
number for somebody IS advice. The offline analyst goes further and refuses to
call it at all: it has no argument extraction, and guessing two prices out of a
sentence is exactly the brittle heuristic that must not exist near a position
size. It reports risk STATE and points at the desk.

### 5. Motion and the visual pass (`styles/risk.css`)

Desk transitions (160ms, 6px), press feedback on every control, row hover, and
skeleton shimmer. One rule governs all of it, and it is the rule most likely to
be violated by a "make it smooth" request:

**NO NUMBER ANIMATES.** Not a count-up, not a cross-fade. A risk figure that is
mid-transition is a risk figure you can misread, and "it looked nicer" is not a
defence when somebody sized a position off the frame before the last one.
`.num`, `.risk-qty`, `.legend-val`, `.ws-last` and `.scr-cell` all carry an
explicit `transition: none`.

### NEW TRAPS (v43)

- **`Float64Array.length` is the CAPACITY on a pre-allocated buffer.** `Series`
  allocates 4096 and loads 802. Any function taking `ArrayLike<number>` must be
  handed `subarray(0, series.length)`. This will recur.
- **Volume figures are denominated in the QUOTE asset** and cannot be sorted
  across quote currencies without an FX table.
- **`.dd-head` means "uppercase table header ROW" in desks.css.** Reusing it for
  a desk title block shouted the h1 AND its whole subtitle in capitals. One
  class, two meanings, in the same stylesheet.
- **A keyword regex is the wrong shape for a safety allowlist.** It rejects
  innocent names containing a scary substring and passes dangerous names that
  avoid one.

### STILL NOT BUILT (honest)

- Replay and the desks still follow the Chart desk's feed, not the focused
  workspace pane. The topbar and timeframe commands DO follow it.
- Tick storage. Bars only.
- The desktop app has no installer, code signing or updater — `--no-bundle`
  produces the executable and nothing else.
- **STANDING RECOMMENDATION UNCHANGED: do not automate anything off the
  confluence score.** PBO 89%. The alert daemon notifies; it cannot trade. The
  analyst reports and calculates; it has no tool that could trade. The Risk desk
  sizes; it has no broker connection and says so on screen.

## WHAT SHIPPED — v42 (THE FRONT END: chrome, workspace, analyst, desktop)

**826 app tests (was 632), 0 failures. SUITE GREEN — 93 files. Build 329 kB single file, 0 external refs.**
New desks: **Analyst**. New modules: `core/{fuzzy,keys,commands,workspace}.ts`,
`ui/{overlay,palette,menu,toast,shortcuts,commandset,workspace,agent}.ts`,
`agent/{tools,provider,session}.ts`, `styles/chrome.css`, and a Tauri desktop shell in `desktop/`.

### 1. One list of what the terminal can do (`core/commands.ts`, `ui/commandset.ts`)

v40 had THREE ideas of what the app could do: the tab strip, the topbar
buttons, and a `switch` on `e.key` in shell.ts. Adding a capability meant
editing three places, and the third was always the keyboard.

Now a capability is one `Command` object, and where it appears is a separate
one-line declaration. The palette, the menu bar and the shortcut sheet are all
generated from the same list, so they cannot disagree. A command carries its own
gate (`when`), its own toggle state (`checked`) and its own current value
(`detail`) — a palette offering "Toggle EMA 200" without saying which way you
are about to toggle it is a coin flip.

**Recency, not frequency.** The palette promotes what you used LAST. A session
has phases; the thing you reached for a minute ago is far likelier to be next
than the thing you reach for every morning, and frequency ranking makes the list
feel stuck. The bonus (90) is sized UNDER one boundary-match (100) so it
reorders near-ties without ever overriding a clearly better text match.

### 2. The command palette (`core/fuzzy.ts`, `ui/palette.ts`)

Neither TradingView, MetaTrader nor TrendSpider has one. Bloomberg is fast
because it is a command line and unguessable for the same reason; a menu is
discoverable and slow. A palette is the only interface that is both, because the
keystrokes that execute a known command also LIST the ones you did not know
existed.

Modes by prefix: `>` commands, `@` detected structures on the chart, bare text
searches symbols and commands together.

**Matched characters are highlighted**, which is not decoration — it is the
palette explaining why a row is on screen. A fuzzy result you cannot account for
reads as a guess.

**A REAL SCORING BUG, found by a test, not by eye.** With `S_BOUNDARY` (80)
above `S_CONSECUTIVE` (60), `"orde"` scored HIGHER against `"o r d e"` (four
word-boundary bonuses) than against `"order"` (three consecutive bonuses) — a
scattered match beat an exact prefix. The fix is fzf's rule: a character in an
unbroken run INHERITS the position bonus of the run's first character, so
matching "order" from position 0 keeps earning the head bonus for the whole run.
Boundaries still beat interiors; they no longer beat runs.

### 3. Menus, overlays and notifications (`ui/{overlay,menu,toast}.ts`)

One floating layer, one dismissal rule, one focus policy — because every popup
implemented independently fails the same four ways: Escape closes the wrong
thing, the opening click immediately closes what it opened, focus is lost to the
body, and the panel renders off-screen near an edge.

- Outside-press is on **pointerdown, in the capture phase**. `click` is too
  late: the press has already landed on whatever was under the menu.
- The outside listener attaches on the NEXT task, or the click that opened the
  overlay closes it instantly.
- Placement **flips before it clamps**. Clamping alone slides a menu up until it
  covers the button you just pressed.

**Every toast is also appended to a log that does not expire**, with an unread
count on the status bar. A toast is only useful if you happened to be looking,
and in a terminal you are looking at a chart. `error` toasts do not auto-dismiss
at all: a failure that erases itself is indistinguishable from a success.

### 4. The keyboard is data (`core/keys.ts`)

A registry, not a `switch`. Three things it gets right:

- **Typing is not a shortcut.** Bare letters are inert while focus is in a text
  field; bindings must opt in, and only Escape and the palette do. Checkboxes
  and range sliders are NOT guarded — they do not swallow text.
- **Sequences with a visible timeout.** `g c` is two keystrokes. The pending
  prefix is announced through `onPending` and shown in the status bar — a mode
  you cannot see is a mode you are stuck in, and it can clear on a TIMER with no
  input to hang a repaint off, so a poll would not have worked.
- **Mod is not Ctrl.** Resolved once from the platform; ⌃⌥⇧⌘ in that fixed order
  on macOS.

Duplicate bindings WARN and the first wins, so a clash is deterministic and
diagnosable rather than "the palette sometimes does not open".

### 5. The analyst (`agent/{tools,provider,session}.ts`, `ui/agent.ts`)

**THE CENTRAL DECISION.** Ask a language model what BTC is doing and it will
answer — with a price, a percentage and a confident sentence, every one of them
invented. In a terminal whose whole premise is that no number appears without
its source, that is the worst thing the software could do.

So the agent has no market knowledge in its prompt and no way to state a figure
it did not fetch. Every fact reachable comes from a tool; every tool reads the
same live signals the panels read; and **the transcript shows the calls above
the answer**. An answer with no tool rows over it is an answer about nothing, and
it visibly looks like one. Each row expands to the raw JSON.

**There is no order tool. No position, wallet, key or credential tool.** Not a
policy in a prompt that a jailbreak can argue with — the capability does not
exist in the process. A test asserts the toolset name list matches no
order/trade/position/withdraw pattern.

**The default provider is not a model.** `offlineProvider` picks tools from the
question's keywords, runs them, and writes the answer from templates over the
RESULTS. It cannot hallucinate because it never generates a number, only places
one. No key, no account, nothing leaving the machine. Also available: the local
Python `/svc/analyst`, any OpenAI-compatible `/v1` endpoint (Ollama and LM Studio
on localhost included), and Anthropic. **The key is the user's**; it is stored
under `agent.credential`, whose name contains "credential", which is what makes
`looksSecret` withhold it from every vault export.

The tools relay limits, not just values: `get_forecast` returns
`usable_as_signal: false` when the Brier score is at or above 0.25, and the
offline composer **withholds the probability entirely** rather than relaying a
number the model has already said is inside the noise.

The loop caps at 5 tool rounds and SAYS SO when it hits the cap, rather than
presenting the last partial thought as an answer. A second question aborts the
first — two loops appending to one transcript would interleave into nonsense.

### 6. The workspace — many live charts (`core/workspace.ts`, `ui/workspace.ts`)

A binary split tree, not a menu of vendor-drawn layouts. MetaTrader gives you
tile/cascade; TradingView gives you a fixed list up to 8. Both are the same
admission: if the layout you need is not on the list, you do not get it. A tree
expresses all of those as special cases plus the ones nobody enumerated.

**Link groups** — Bloomberg's best idea, skipped by every retail platform. A
pane wears a colour; changing the symbol in one moves every pane wearing the
same colour, while a deliberately unlinked pane stays put. Four timeframes of an
instrument that follow you when you switch instruments, with no four symbol
boxes to keep in sync by hand.

Every operation is pure and returns a new tree, which makes undo one line, a
saved layout a `JSON.stringify`, and the whole thing testable with no DOM. Panes
are reconciled by id, so a split rebuilds only what changed and every other
canvas keeps its context and its loaded history.

`sanitizeLayout` treats a stored layout as untrusted input and REPLACES what it
cannot read rather than rejecting the file — losing one pane's content type
beats losing the whole desk. A split with one dead child promotes the survivor.

Wired as its own **Workspace** desk with six presets, a right-click pane menu,
draggable splitters and a layout persisted through the KV store. The topbar
reads and writes THE PANE IN FOCUS while that desk is open — a control bar still
lit on 1m after you moved a pane to 1h is worse than no control bar, because you
will trust it. The status bar labels the Chart desk's feed explicitly there, for
the same reason.

### 7. Chrome layout and type (`styles/chrome.css`, `shell.css`)

The topbar was carrying a symbol box, six timeframes, four chart styles, three
moving averages, a feed badge, two selects and four icon buttons on one line;
below roughly 1400px they simply did not fit, and adding a menu bar made it
visibly overflow. Split into two rows by JOB: the menu row is about the
PROGRAM, the topbar about the CHART. Which row you reach for now depends on
what you are changing rather than on where a control was historically added.

Floating panels use blur + a one-pixel top highlight (`--sheen`) + a shadow
sized to the distance. Any one alone looks pasted on.

### 8. The desktop app (`desktop/`)

Tauri, not Electron: the OS webview instead of a bundled Chromium, so the
installer is single-digit megabytes and the terminal does not carry a browser
engine that needs its own security updates.

**The reason it exists is the CORS one.** Binance sends `x-mbx-used-weight-1m`
on every response and a browser cannot read it (measured in v41). Requests from
Rust are not subject to CORS, so the desktop build can read what the exchange
thinks you have spent instead of running on a local estimate at a third of the
ceiling. That is the difference between believing you are inside the limit and
knowing it — which is exactly what "my system cannot be blocked" asks for.

The capability allow-list is the whole privilege surface: no shell permission,
no general filesystem permission, an HTTP scope naming specific hosts, and
nothing that could place an order.

### NEW TRAPS (v42)
- **TWO PREDICATES FOR ONE QUESTION LEAKED AN API KEY.** The vault withheld
  `agent.credential` from every export via `looksSecret`, while `syncable()` —
  a separate hand-maintained prefix list — happily pushed it in PLAINTEXT to
  whatever Supabase project or custom endpoint was configured. Neither rule was
  wrong; the bug was that "is this a credential?" had two answers, so protecting
  the export path did not protect the sync path. `syncable()` now calls
  `looksSecret()`, so any future credential-shaped key is covered by both.
  Found by auditing sync scope AFTER shipping the key, not before.

- **`overflow: hidden` on a flex item makes `min-height: auto` resolve to 0.**
  MEASURED: a 26px tool row rendering **1.85px tall** inside the agent log,
  because the rounded corners needed `overflow: hidden` and the column then
  crushed it. `flex: 0 0 auto` on the children is the fix. This is the same
  family as v41's `min-width: 0` trap and will keep recurring.
- **`place-items: center` on `.view-slot` sizes desks to MAX-CONTENT.** Bit the
  Data desk in v41 and the Analyst desk in v42. Every full-width desk needs
  `justify-self: stretch` until `.view-slot` itself is changed.
- **`beforeBuildCommand` runs from the directory `tauri` was invoked in, while
  `frontendDist` resolves against `tauri.conf.json`.** Two different bases in
  one config block; `../../app` silently became `Downloads/app`.
- **A background task can report exit 0 while the work inside it failed.** The
  first Tauri build "succeeded" with a `beforeBuildCommand` failure in its log.
  Read the log, not the exit code.
- **Commands are registered once, so a loop over a dynamic list freezes it.**
  The higher-timeframe commands were built from `higherTimeframes(currentTf)` at
  boot and would never have offered 1d after switching to 15m. Register the
  union and gate each with `when`.
- **`color-mix(... 85%, transparent)` is not enough for a reading surface.**
  MEASURED: `backdrop-filter` was applied AND supported, and the palette was
  still hard to read over candles — blurring a high-contrast field leaves a
  high-contrast field. 96%.

### STILL NOT BUILT (honest)

- (v42 said manual drawing tools and the Risk desk were outstanding. Both
  shipped in v43 — see above.)
- **Replay and the desks do not follow the workspace.** The multi-pane view
  ships and works (its own tab, six layout presets, live link channels,
  draggable splitters, persisted layout), but it is ADDITIVE: the Chart desk's
  single feed still drives replay, the legend, the alert engine and every desk.
  Routing those through "whichever pane has focus" is a real refactor of the
  shell's data flow, and doing it carelessly puts a look-ahead firewall and an
  alert engine at risk to add a second chart. The topbar and the timeframe
  commands DO follow the active pane — that part is wired, through `applyLink`,
  so one code path moves a pane and its whole link channel.
- Tick storage. Still bars only.
- **STANDING RECOMMENDATION UNCHANGED: do not automate anything off the
  confluence score.** PBO 89%. The alert daemon notifies; it cannot trade. The
  analyst reports; it has no tool that could trade.

## WHAT SHIPPED — v41 (DATA LAYER: storage, cache, kernel, sync, typography)

**632 app tests (was 494), 0 failures. SUITE GREEN — 93 files. Build 247.95 kB single file, 0 external refs.**
New desk: **Data**. New modules: `core/kernel.ts`, `data/net.ts`, `store/{kv,cache,retention,vault,sync,supabase}.ts`, `ui/data.ts`, `styles/type.css`.

### 1. The kernel — one owner for every outbound request (`app/src/core/kernel.ts`, `app/src/data/net.ts`)
`grep -n 'fetch('` found NINE call sites across five modules, each politely paced and
each unaware of the other eight. A venue does not rate limit modules; it rate
limits an IP. All nine now go through one door.

- **One weight budget per host**, with real endpoint WEIGHT. `/ticker/24hr` with
  no symbol costs 40 — it is the screener's opening call — and counting it as 1
  understates the heaviest request in the app by 40x.
- **Sized UNDER the ceiling, not at it.** Binance allows 20 weight/s; this
  sustains 8 with a burst of 120. Spending two thirds of the budget to buy
  "never banned" is the right trade every time: throughput is not the
  constraint, and a 418 is measured in hours.
- **AIMD.** A 429 HALVES the sustained rate and drains the burst. Fixed backoff
  returns to the exact rate that was just refused, so it re-earns the 429
  forever.
- **A 418 is a ban, not an error.** The host is parked for the full duration and
  not probed. Probing a Binance ban extends it.
- **Priority + coalescing.** A chart the user just clicked outranks a 200-symbol
  scan; two panels asking for the same URL in the same instant make ONE request.

**MEASURED, and it changed the design:** Binance sends no
`Access-Control-Expose-Headers`, so a BROWSER cannot read `x-mbx-used-weight-1m`
at all — the value is on the wire and the fetch spec hides it. It is readable
from Node (the alert daemon) and through the local proxy. Rather than let a
counter sit at null and read as "zero used", a host whose declared header never
arrives is flagged `headerBlocked` and the desk says "running on the local
estimate". That is also why the self-imposed budget is a third of the limit.

### 2. Retention — the answer to "how much does it keep?" (`app/src/store/retention.ts`)
Previously: everything, forever, until IndexedDB refused a write mid-update.
That is not a policy, it is the absence of one.

Two stages, in this order. **By age, per timeframe** — 1m keeps 30 days, 1h
keeps 3 years, 1d and 1w are kept FOREVER (365 bars/year is 17 KB, and they are
the only series long enough to hold more than one market regime). Then **by
budget** — 512 MB, coldest series first, where cold means last FETCHED, not
newest bar.

Two things it will not do: touch a **pinned** series (the chart's current
symbol is pinned at sweep time, so it cannot be deleted from under you), and
leave a **remnant** — every series keeps a 300-bar floor, because a 40-bar
series is not a cheaper series, it is a broken one still claiming coverage.

`planRetention()` is pure and previews exactly what would go and why;
`applyRetention()` executes THE PLAN IT WAS HANDED, never a freshly recomputed
one. The approval was for what was on screen. Runs hourly as a supervised job.

`archive.prune()` rewrites the segment that STRADDLES the cutoff. Deleting it
wholesale would discard up to 5,000 bars the policy said to keep, and the
archive would then report full coverage of a range it had just thrown away.

### 3. The settings store (`app/src/store/kv.ts`)
Two raw `localStorage` keys and a `JSON.parse` that returned `{}` on failure —
which silently reset every preference with nothing saying why.

- **Versioned envelopes with migrations**, and a reader that meets a NEWER
  version REFUSES to write. Downgrade is the case everyone forgets and the one
  that destroys data.
- **Corrupt values are quarantined, not deleted.** Deleting the only copy of
  something you could not read is not error handling.
- **Quota is a returned result, not a throw**, so a full store degrades instead
  of dying mid-render.
- Cross-tab change events; two windows no longer silently fight over the book.

Both legacy keys (`iram.shell.v40`, `iram.alerts.v40`) are ADOPTED on first run
and left in place, not migrated-and-deleted.

### 4. The cache (`app/src/store/cache.ts`)
TTL derived from the bar interval rather than guessed: a response is fresh until
the bar that was forming when it arrived has CLOSED. Hours on a 1d chart, under
a minute on 1m, and neither is a constant that will be wrong for some timeframe.
Stale-while-revalidate reports the AGE it is serving, because a cache that hides
age lets the freshness badge present a 40-second-old price as live.

Covers derivatives (5-minute publish grid polled every 15s — 19 of every 20
requests were waste), the calendar, and the screener's per-symbol candles. It
does NOT cover the chart's history: that is the archive's job, and the archive
carries gaps and provenance that a response cache cannot.

### 5. Backup and sync (`app/src/store/{vault,sync,supabase}.ts`)
**Vault** — the whole terminal as one portable file. Secrets never leave: any
credential-shaped key is withheld AND NAMED, because a backup file gets emailed,
shared and attached to issues. Bars travel as base64 Float64 columns, not JSON
numbers. The checksum is FNV-1a and the file says so — it detects corruption,
not tampering, and claiming otherwise would invite trusting a hostile file.
Import always inspects first and defaults to merge.

**Sync** — last-write-wins by wall clock, ties broken by device id so the
outcome is deterministic. Every overwrite is REPORTED as a conflict with both
timestamps and both machines; a sync that silently discards an hour of work is
how people stop trusting sync. Deletions are tombstones (30-day TTL) or they
resurrect on the next pull. Settings sync; **bars do not** — same public data on
every machine, and a re-fetch rebuilds them free.

Three targets: the **local service** (new `/svc/sync/pull` + `/svc/sync/push` in
`mishel_service.py`, nothing leaves the machine), **Supabase** over plain
PostgREST (no SDK — 40KB and a websocket stack for two HTTP calls), and any
**custom endpoint** speaking the same two calls.

**The Supabase anon key is public by design** — it ships in every Supabase web
app. What protects the rows is ROW LEVEL SECURITY, and the setup SQL is in the
header of `supabase.ts`. With the single-user policy the space id IS the secret,
so `validateSupabaseConfig` refuses one under 16 characters: a short one is
guessable and the failure is SILENT.

### 6. Typography (`app/src/styles/type.css`, `tokens.css`)
Two measured findings, both bugs rather than taste:

- **`.num` was defined and used in ZERO places.** `base.css` declared it with
  `tabular-nums` and documented it as "Every price, size and percentage in the
  app uses this". Nothing did. Every number in the terminal rendered with
  PROPORTIONAL figures. **Measured in the browser: `78,000.00` → `79,411.11`
  shifted the readout 7.2px.** Now tabular is the DOCUMENT default and prose
  opts out — forgetting costs slightly wide letter-spacing in a paragraph, not
  a jittering price.
- **None of the three named font families existed.** Measured by canvas glyph
  width against a bogus family: `Plus Jakarta Sans` FALSE, `JetBrains Mono`
  FALSE, `Space Grotesk` FALSE. All three resolved to the same system fallback,
  so `--font-disp` was identical to `--font-ui` and the entire heading hierarchy
  the design assumed did not exist. Now two families that are genuinely present
  (`Segoe UI` TRUE, `Cascadia Mono` TRUE), with hierarchy carried by size,
  weight and tracking — which always render.

Also: Cascadia **Mono**, never Cascadia **Code** — a terminal that fuses `->` or
`!=` inside a price expression is actively misleading, and ligatures are
switched off explicitly because the fallbacks have them too. Sub-10px `--fs-1`
raised to 10.5px, optical tracking per size, and a **density** control
(compact/standard/comfortable) driving one `--ui-scale`, because browser zoom
would also scale the chart canvas off device resolution.

### NEW TRAPS (v41)
- **Vite HMR gives you MULTIPLE MODULE INSTANCES.** A module-level singleton
  (the governor) recorded ZERO requests in dev while the network tab showed the
  fetch, because `net.ts` had been loaded under several `?t=` URLs. Verify
  singletons against the BUILT bundle; dev proves nothing here.
- **`overflow-x: auto` does nothing on a flex or grid item** without
  `min-width: 0`. The default `min-width: auto` resolves to min-content, so the
  scroller refuses to shrink and widens its parent instead.
- **`place-items: center` sizes a grid item to MAX-CONTENT.** `.view-slot` was
  written for a small centred placeholder; a full-width desk inside it came out
  606px wide in a 511px slot. `justify-self: stretch` is the fix.
- **A module-level cache is shared between TEST CASES too.** One case's stubbed
  response was served to the next case's assertion. `resetNet()` in `afterEach`.
- **Base64: the final group is 2 or 3 characters, not 4.** `i + 3 < length`
  skips it, which silently ZEROED the last double of every column whose byte
  length was not a multiple of three — and a Float64Array is 8 bytes per
  element, so that was most of them. Found only because the test compared
  VALUES; an earlier test compared lengths and passed.
- **Quarantining REMOVES the key**, so a later "was anything here?" check
  reports no — and told the user their settings were never there when they had
  just been moved aside.

### STILL NOT BUILT (honest)
- Manual drawing tools. The Risk desk is still an honest placeholder.
- A worker for the universe scan: `scanner.ts` documents that the bottleneck is
  the network, not compute. A worker would be theatre.
- The archive still stores no tick data — only bars. Tick storage is a different
  shape (append-only, far larger) and belongs in its own store, not bolted onto
  a segment archive that assumes uniform intervals.
- **STANDING RECOMMENDATION UNCHANGED: do not automate anything off the
  confluence score.** PBO 89%. The alert daemon notifies; it cannot trade.

## WHAT SHIPPED — v40.1 (THE SEVEN: what makes this beat a charting platform)

**494 app tests, 0 failures. SUITE GREEN — 93 files. Build 190.80 kB single file, 0 external refs.**
`npm run build:all` builds the terminal AND the headless engine the daemon runs.

### 1. Dynamic alerts anchored to STRUCTURE (`app/src/alert/`)
A price alert is a number you typed once. These attach to a detected structure — a trendline, an
order block, a fair-value gap, a level — and re-resolve against a fresh detection run every bar. The
trendline re-fits; the alert moves with it, and the reason quotes the PROJECTED price.

Four things the design refuses to get wrong:
- **Anchors are keyed on TIME, not bar index.** Load more history and every index changes meaning;
  an index-keyed anchor silently retargets to a different structure. Times do not move.
- **`validFrom = detection.to + 1`.** An alert anchored to a structure cannot fire on or before the
  bar that REVEALED the structure. Seeded one bar early purely to learn which side price was on —
  not hindsight: at `validFrom` the structure is known AND the previous bar has already closed.
- **Hysteresis, then cooldown.** The condition must RESET before it can fire again, so a trend that
  crosses once produces one alert rather than one per bar for the rest of the move.
- **Orphans are announced.** A mitigated zone or an invalidated line makes the alert ORPHANED and
  amber, never silently dead. An alert that quietly stops is worse than none, because you are still
  counting on it.

Evaluation lives in `mountShell`, not in the desk, so alerts run on every tab. One-click "Alert me"
on every detection in the inspector, with a preset chosen for what that structure is actually
watched for (support line -> break; unmitigated zone -> return).

**A real bug this caught:** turning a chart overlay off used to be able to disarm the alert anchored
to it. `requiredDetectors()` now adds back anything an armed alert needs — a display preference must
never silently stop an alert.

### 2. The always-on tier (`server/alert_daemon.mjs` + `server/engine/alert-engine.mjs`)
The same book, evaluated with the browser CLOSED. It runs the SHIPPED engine:
`app/vite.headless.config.ts` compiles the identical TypeScript to an ES module Node imports. There
is no second implementation to drift — the same choice `sig_worker.js` made in v35, for the same
reason: two engines means the day they disagree you find out on a live trade and cannot tell which
one lied.

Export the book from the Signals desk, then `node server/alert_daemon.mjs --every 60`. Provider
failover mirrors the registry (binance for crypto, mt5 otherwise, proxy default last). **Verified
live: 999 closed BTC bars, 3 historical fires recorded and NOT announced, then silence across three
polls.** The first pass per symbol is deliberately silent — a book against months of history
legitimately contains dozens of past fires, and announcing them on startup is how the whole thing
gets muted on day one. It reports. It cannot place an order.

### 3. The strategy lab, validation as a GATE (`app/src/backtest/lab.ts`, `app/src/ui/strategy.ts`)
Every retail tester answers "what would this have made?" and none answer "given how many variants I
tried, how likely is it the winner is just the luckiest?". There is no path here that shows a curve
without both answers: `runStudy()` ALWAYS sweeps a grid, ALWAYS walks forward, ALWAYS computes PBO,
and always returns a headline computed in the library so a redesign cannot drop it.

The gate is ordered so the strongest objection wins, and **sample size outranks a flattering
degradation figure** — learned from this engine reporting "233% retained" on 22 OOS trades while PBO
said 89%.

Two more honesty fixes found by using it: a refused study printed "PBO 0%", which is the BEST
possible score, so it now prints "—"; and the lab fetches its OWN deeper history (default 5,000
bars, backfilling if short) because the chart's 800 is below the EMA family's 820-bar floor and the
lab would otherwise refuse every run.

**Measured live on 5,000 backfilled BTC 1h bars:** best in-sample EMA 20/50 +10.7%, PF 1.12 — and
walk-forward **-5.1% retained**, PBO 34%, 9 of 12 configs negative. Verdict: *Unproven — sample too
small* (18 OOS trades). That is the product.

### 4. Multi-timeframe (`app/src/detect/mtf.ts`)
4h structure projected onto a 1h chart, merged into the same detection list so it draws, lists and
can be alerted on like native structure. Verified live: 15 of 40 inspector rows were `4H · ...`,
correctly interleaved by confirmation time.

**The trap, which almost every implementation gets wrong:** a 4h structure completing on the
12:00-16:00 bar is not knowable at 12:00. Every projected `to` maps to the LTF bar that CLOSED the
HTF bar. Mapping to the bucket's OPEN would backdate every HTF signal by up to three hours — enough
to turn a losing backtest into a winning one.

Buckets are clock-aligned (`floor(t / htfMs)`), and INCOMPLETE buckets are dropped at BOTH ends —
the newest because it is still forming, the oldest because history starting at 13:00 puts three
hours in the 12:00 bucket and produces a 4h candle that never existed. Draw caps are per
(kind, timeframe) so four 1h breaks cannot crowd out the one 4h break you enabled it for.

### 5. Order flow nobody else has (`app/src/data/flowmetrics.ts`)
Spot-perp basis, the four-way OI/price read (new longs / short covering / new shorts / long
liquidation), funding-vs-price divergence, and liquidation prints grouped into price SHELVES.
**Live-verified:** basis -3.7bp, "LONG LIQUIDATION — price -2.029% with OI -0.736%".

**Bug found and fixed:** bucket width was computed from each print's own price, and
`price / (price * pct)` is the constant `1 / pct` — every print collapsed into one shelf. Width now
comes from the median price of the set.

### 6. Regime and forecast, finally wired (`app/src/data/intel.ts`)
`mishel_ml.py` and `mishel_hmm.py` have been correct for versions and the frontend never showed
them. Dock panel, asked on demand (both are seconds of server CPU). `forecastStanding()` puts the
verdict ON the number: Brier >= 0.25 is worse than always saying 50%, so the probability is struck
through rather than footnoted. `numOf()` treats null as MISSING — `Number(null)` is 0, which would
report a missing accuracy as "the model got everything wrong".

### 7. Replay with a structural firewall (`app/src/core/replay.ts`)
The terminal steps through history bar by bar and genuinely cannot see past the cursor — because
replay hands out a SHORTER ARRAY, not an index to be respected. No consumer cooperation is required
and none can be forgotten. `const bars = replay.bars` is what the whole shell reads; while replay is
off it is `feed.bars` by identity.

It doubles as a correctness test: `test/replay.test.ts` proves PREFIX STABILITY — the structure
detector reports exactly what the full run reports, never a bar early.

### 8. Breadth (`app/src/data/context.ts`)
Seasonality by hour/day/month (UTC, so the pattern does not move with the reader; thin buckets
greyed out and labelled `n=`), correlation aligned by TIMESTAMP not index, and the economic calendar
read from the feature store `mishel_data.py` ALREADY collects — no new vendor. Correlation reuses
the bars the screener already fetched, so it costs no requests.

### NEW TRAPS (v40.1)
- **`computed` is push-based on a microtask.** A read in the same tick as a write is STALE. The app
  is effect-driven and never notices; tests must `await` a settle.
- **A computed returning the SAME ARRAY REFERENCE stops propagation** (`Object.is`). Adding an alert
  changed the book without changing any value the evaluation effect could see, so new alerts were
  saved, correct, and invisible in the Active list. The effect now reads `alertStore.specs()`.
- **Raw `requestAnimationFrame` never fires in a non-compositing pane.** `await`ing one leaves a
  button stuck on "Running..." forever. Use `scheduleFrame` from `core/frame.ts` — that is what it
  exists for, and I still walked into it.
- **Archive coverage is calendar-based**, so a COMPLETE forex series scores ~71% and the backtester
  refuses to run on good data. `openCoverage()` discounts hours the venue was shut. A guard that
  fires on good data gets its threshold lowered until it stops catching anything.
- **Windows ESM:** `await import(absolutePath)` throws `ERR_UNSUPPORTED_ESM_URL_SCHEME` because
  `C:\...` parses as protocol `c:`. Use a static relative specifier.
- **Geometric series have CONSTANT log returns.** 1,2,4,8 has zero variance and correctly correlates
  with nothing — useless as correlation test data. (My test was wrong, not the code.)

### STILL NOT BUILT (honest)
- Manual drawing tools. The Risk desk is still an honest placeholder.
- A worker for the universe scan: `scanner.ts` documents that the bottleneck is the network, not
  compute, and the 12-config study finishes in well under a second. A worker would be theatre.
- **STANDING RECOMMENDATION UNCHANGED: do not automate anything off the confluence score.** PBO 89%.
  The alert daemon notifies; it does not and cannot trade.

## WHAT SHIPPED — v40.0 (FRONTEND REWRITE, phase 1 — foundation)

**v39 is untouched and still the terminal you use.** The rewrite lives in `app/` and is built and
tested separately, so there is never a day where the working terminal is broken because the rewrite
is midway. `index.html` / `src/` / `tools/build.py` still build and still pass `--verify-identity`.

### The two problems this exists to fix
- **`.app` was defined FIVE times** in `src/00-head.html` (lines 283, 511, 535, 753, 923) across
  successive redesigns, with **198 `!important`** declarations arbitrating between them. Height
  assumptions leaked into unrelated modules — that is the root of the v39.14 live-bar clipping.
- **Duplicate token families that meant the same thing**: `--r-s`/`--r-sm`, `--fs-N`/`--fz-N`,
  `--rail-w`/`--railw`. Four themes, all dark.

v40 answers both structurally: **two-layer tokens** (palette → semantic roles; a component that
reads a palette token is a bug, because it cannot be re-themed) and **ONE `.shell` grid** where
every layout mode is a data attribute that re-points tracks. Zero `!important`. Five themes,
including a real light one.

### Stack
Vite + TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), bundled by
`vite-plugin-singlefile` to **one self-contained `app/dist/index.html`** — the double-click-to-run
property and the habit of testing the shipped file both survive the rewrite. No framework: the hot
path is a tick touching a few readouts among thousands of nodes, so fine-grained signals do work
proportional to what changed, where a VDOM diff does work proportional to the tree.

### NEW TRAPS FOUND (both by running it, not by reading it)
- **`requestAnimationFrame` does not keep its promise.** It never fires in a context that does not
  composite, and is throttled to nothing in a background tab. This terminal is ALWAYS a background
  tab — you are in MT5 — so a paint path hanging off rAF alone stalls silently, and a stalled paint
  means the numbers on screen are quietly wrong. `core/frame.ts` requests a frame AND arms a 250ms
  timer; first to fire wins. `visibilitychange` flushes everything pending on tab return.
- **`ResizeObserver` alone is not enough to size a canvas.** A host that measures zero at
  construction — what happens when the page is opened in a background tab, because a backgrounded
  document is not laid out — left the canvases at their 300x150 default *for the life of the page*.
  The engine now re-measures at the top of every paint, so it heals whenever it is given a size.
- **The volume pane and the time axis were each measuring from the plot bottom** and drew on top of
  each other. Both now derive from one `axisY`.
- **An opaque canvas (`alpha:false`) clears to BLACK, not transparent.** It cannot inherit the page
  background, so a light theme rendered a black plot. The base layer paints its themed background
  explicitly — the price of the (worthwhile) blending win.

### BUG FOUND IN THE EXISTING GATE — `tests/run_tests.sh` was not gating anything
Line 27 read ``done <<'"'"'LIST'"'"'`` — shell-escaping damage baked into the file. The delimiter
never matched, so the heredoc **ran to EOF**: the `LIST` terminator, the pass/fail summary and
everything after were swallowed as heredoc content and fed to the loop as test commands. The
`SUITE GREEN` / `SUITE RED` summary never executed and the script **always exited 0**. Repaired to
`done <<'LIST'` (backup at `tests/run_tests.sh.bak`). This is pre-existing and predates the rewrite,
but it means any "suite green" claim made while it was broken was not evidence of anything.

`run_tests.sh` now also runs the v40 typecheck + Vitest, so one command still covers the whole build.
It SKIPS (does not fail) when `app/node_modules` is absent.

### Phase 2 — LIVE STREAMING (`data/stream.ts`)
Before this, the feed fetched 800 bars once and never updated: the terminal was honest (freshness
degraded it to STALE after three bars) but not actually live. Now it streams.

Three things the implementation is deliberately careful about:
- **An open socket is not a live feed.** TCP holds a connection open long after the far end stops
  sending, so `readyState===OPEN` reports LIVE on a dead tape. A silence watchdog forces a reconnect
  regardless of what the socket claims.
- **Backoff is exponential, capped AND jittered.** Without jitter every client that dropped on the
  same vendor blip retries on the same schedule for ever.
- **A gap in the socket is a gap in the data.** Bars that closed during an outage were never sent, so
  a reconnect triggers a history REFETCH instead of splicing the hole shut.

The forming bar is deduped by timestamp on both sides — `applyLiveBar` in the feed and `Series.push`
in the renderer enforce the same invariant, so the two cannot disagree. Verified live: 6 distinct
closes over 15s, all folding into ONE bar timestamp.

Transport is injected, so the reconnect ladder and watchdog are tested against a fake socket and a
fake clock (21 assertions) rather than the network.

**Streaming is Binance-only.** A proxy-served symbol loads history and starts NO socket — the
terminal must never claim live updates it is not receiving.

Also: the view tabs used to change state and render nothing. They now route, with the chart kept
MOUNTED (hidden, not unmounted) so its canvas context and loaded history survive the round trip.
Unported desks render an honest "not yet ported" panel.

### Phase 3 — SCREENER + GLASS-BOX CONFLUENCE (`src/scan/`)
`confluence.ts` enforces ONE rule: **no number without its reason.** There is no path through it
that produces a contribution without the sentence explaining it, and the tests assert that for every
signal including the ones that abstain. Consequences, all tested:
- Insufficient data returns NEUTRAL with a reason. It never extrapolates a score from a short series.
- **Volatility does not vote on direction — it scales confidence.** A market can be violently
  trending or quietly trending.
- **Absent trend structure also scales confidence.** Momentum in a chop is REAL (at the top of a
  swing RSI and MACD genuinely read up) and suppressing it throws away information — but a
  directional read with no structural backing must not outrank one that has it, or the screener
  sends you into chop. Same philosophy as the volatility gate.
- `agreement` is reported separately from `score`: unanimous-but-weak and split-but-strong average
  to the same number and are not the same read.

`scanner.ts` — TWO PASSES ON PURPOSE: one cheap `/ticker/24hr` request covers the WHOLE exchange,
and only the top N by liquidity get a klines request each. It refuses to (a) silently drop a failed
symbol — a screener showing 47 rows when you asked for 50 is lying about its coverage; (b) write
results after being superseded — changing timeframe mid-scan used to leak stale rows into the new
table; (c) hammer the vendor — a 429 is a statement about the CLIENT, so it parks every worker
rather than retrying 6-wide.

Rows rank by **conviction** (`|score| x confidence`), never raw score.

**NO WORKER POOL, deliberately.** Confluence over 400 bars is ~50k ops; the universe costs tens of
ms. The bottleneck is the network. A worker here would be theatre. `confluence()` is pure, so it
crosses a postMessage boundary unchanged if that ever changes.

Verified live: 50 symbols scanned, 0 failures, ranked by conviction; expanding UNIUSDT (LONG +0.96,
agreement 100%) showed all seven module reasons incl. "volume 2.99x the 20-bar average confirming a
long bar" and volatility marked `context` rather than a vote.

### BUG FOUND — RSI reported 100 for a FLAT market
`avgLoss === 0 ? 100 : ...` conflates two different zero cases. No losses AND no gains means the
tape did not move; RSI is undefined and 50 is the honest answer. Returning 100 told every consumer
the market was maximally bullish while it had not moved at all — and that propagated straight into
the confluence engine as a strong long signal nothing justified. Caught by a confluence test
asserting a flat series reads neutral. Fixed in `indicators.ts` (`rsiFrom`), locked by a test.

### Phase 4 — AUTO PATTERN DETECTION + AUTO-DRAWING (`src/detect/`)
**Labelled honestly: this is DETERMINISTIC structural detection, not a learned model.** Every result
is reproducible from the bars alone and carries the rule that produced it. That is deliberate — a
structure you cannot audit is one you cannot trust on a live trade.

**THE LOOK-AHEAD GUARANTEE — the most important thing in this module.** A pivot high is not knowable
until `right` bars have CLOSED after it. Every pivot carries `confirmedAt`, and structure logic
compares against THAT, never the pivot own index. A detector that skips this reads the future: at
bar i it uses bars i+1..i+right that had not happened yet. It is the single most common way a
chart-pattern backtest produces impossible returns. Tested explicitly.

Same discipline throughout:
- **Breaks confirm on CLOSE, never on wick** — a wick through a level that closes back inside IS the
  liquidity sweep the level exists to describe; treating it as a break inverts the meaning.
- **BOS vs CHoCH preserved** — with-trend break = continuation, counter-trend = first sign the leg is
  over. Labelling both "BOS" throws away the only information that made the concept worth having.
- **Formations confirmed, never anticipated** — a double top is two highs and a hope until price
  closes through the neckline.
- **Zones track mitigation** — a gap price already traded through stops being drawn as if live.
- **Three touches make a trendline**; two points make a line through any two points that exist.

Detectors emit shapes in **DATA space** (bar index + price), never pixels — annotations stay glued to
the bars through pan/zoom, and the same detection can be drawn, listed, or fed to a strategy without
recomputation. Engine culls off-screen shapes by bar range before touching the canvas.

**CLUTTER IS A REAL BUG, and it was found by looking.** All 8 detectors on 800 bars = 128 structures (13 detectors as of v49)
and an unreadable chart — worse than useless, because the one structure that matters is buried in
ninety that are not. Only the most recent of each kind is DRAWN; the panel lists everything and the
counter reads "128 found - 34 drawn (most recent of each type)". Capping is fine; capping SILENTLY is
not.

### BUG FOUND — order blocks detected twice
The id was keyed on the block candle but the detection was pushed per DISPLACEMENT bar. Two
consecutive displacement bars pointing at the same block candle produced two detections with a
COLLIDING id — the zone drawn twice, listed twice, and any UI keying on id broken. Now keyed by block
candle with the stronger displacement winning. Regression test added.

### Phase 5 — FLOW DESK (derivatives + liquidations), and why there is NO embedded browser
The ask was an in-app browser that reads Arkham / CoinGlass while you browse. **It cannot be built,
and this was measured rather than assumed:** CoinGlass refuses to be framed at all
(X-Frame-Options); Arkham and TradingView frame fine but are cross-origin, so their DOM is
unreadable by script. That is the same-origin policy — the single rule stopping every site you visit
from reading your logged-in Arkham session. Defeating it would make the terminal the thing malware
wants, not a "secure browser".

It does not matter, because the metrics are NOT proprietary to CoinGlass. Funding, open interest,
account positioning and taker flow come from the exchange's own **keyless, CORS-open** futures
endpoints (all five verified live), and liquidations stream over a public socket. Reading them
directly is faster, has no ToS exposure, no API key to leak, and no third-party uptime dependency.

Each reading refuses to overclaim, because each has a known failure mode:
- **Funding = CROWDING, not direction.** Longs paying 40% APR is squeeze risk against longs, not a
  forecast that price falls.
- **OI is directionless alone** — it only means something ALONGSIDE price, so the reason states both.
- **Lopsided positioning is contrarian**, and says out loud that crowds stay crowded.

For sites with genuinely no public endpoint (Arkham entity labels): `app/docs/capture-bridge.md`
designs a localhost capture bridge — user-initiated, origin-allowlisted, secret-gated, bound to
127.0.0.1 and never 0.0.0.0, captured data labelled as captured. Designed, NOT built.

`stream.ts` was generalised so klines and liquidations share ONE reconnect ladder and watchdog —
duplicating that logic per feed is how one of them ends up quietly missing the watchdog.

### BUGS FOUND — three, all by running it
1. **The silence watchdog was wrong for sparse feeds.** It is correct for klines (constant ticks =
   silence is failure) but a liquidation feed is EVENTS: verified live, 52 seconds of silence across
   every market on a perfectly healthy socket. The 120s watchdog would have forced pointless
   reconnects forever. `silenceMs: 0` now disables it; two tests lock both halves.
2. **The Flow desk never loaded.** It is built once at mount, but the "cancel every hidden view"
   effect also runs at mount and aborted the eager load a microtask later — and switching TO the tab
   never retriggered it. Loading is now driven by `activate()`, made idempotent by `loadedFor`.
3. **`readDerivatives` ignored takerFlow in its emptiness guard**, so a symbol carrying only taker
   flow reported "no derivatives data" while the data sat in the argument.
4. **The responsive dock overlay hid the view behind it.** Below 1100px the dock becomes a floating
   overlay, but it defaults OPEN — so at narrow widths the Flow and Screener desks were completely
   unreachable. Entering narrow now auto-closes it (restoring the user's choice on the way out), and
   the overlay is capped at 86vw so it can never take the whole screen. Found by looking at it in a
   628px pane, not by reading the CSS.

### Phase 6 — PERSISTENT ARCHIVE + MULTI-SOURCE FAILOVER (`src/store/`, `src/data/sources.ts`, `history.ts`)

**The archive (`store/`).** IndexedDB, contiguous runs of bars as typed arrays (structured-clone
handles Float64Array natively, so a segment is ONE record — not one row per bar, which is what makes
naive IndexedDB bar caches unusable at 100k rows). Measured live: warm boot reads **800 bars in
1.8ms**; a backfill pulled **283 days / 6,800 bars into 319KB** in under 2s, as ONE contiguous range.

Two rules, both from the honesty contract:
- **Never return a series without its gaps.** `read()` returns bars AND missing ranges AND a coverage
  ratio. A backtest over a hidden hole does not crash — it returns a confident WRONG number, and an
  ML training set learns the discontinuity as a market move.
- **Provenance per segment, never mixed.** Source + quality (live/delayed/**demo**) stored per
  segment; demo bars live under their own source key and can never merge into a real series.

**Sources (`sources.ts`).** Priority-ordered failover, every attempt recorded with its failure
reason — a SILENT fallback is how you end up reading 15-min-delayed equity data believing it is live
crypto. Binance (crypto, has socket) then the Python proxy (forex/metals/equities, `delayed`, socket
= null so the shell never claims live updates it will not receive). Per-source **circuit breaker**:
without it a 200-symbol screener scan against a dead vendor eats 200 timeouts EVERY time. An abort is
not a failure — switching symbols fast must not blacklist a healthy vendor.

**`history.ts`** joins them: cache-first, network on miss, persist with provenance, deep `backfill()`
walking backwards a vendor page at a time. A cache hit is only taken when the newest stored bar could
still BE the newest bar, or yesterday's close masquerades as today's. Every source down -> falls back
to stale archived bars AND says so.

### BUGS FOUND — three, plus one self-correction
1. **A segment could straddle a hole.** `write()` chunked purely by BAR COUNT, so one segment spanned
   a three-week absence and `coverage` reported the hole as covered — the exact silent gap the module
   exists to prevent. Segments are now CONTIGUOUS runs; the size cap only subdivides within a run.
2. **`coverage()` reported phantom fragmentation.** It called `normalise` with no interval tolerance,
   unlike `read()`, so segments ending 19:00 and resuming 20:00 on an hourly series looked like a
   gap. Caught by a real 6,800-bar backfill reporting 2 ranges where there was 1.
3. **Detection ran on the FORMING bar — a correctness bug, not just cost.** `detectStructure`
   confirms a break using `close`, but the forming bar's "close" is the current price, so a mid-bar
   spike registered as a confirmed break and un-registered when the bar closed lower — exactly the
   wick behaviour the detector documents that it REJECTS. Detection now depends on `closedBarCount`
   and sees closed bars only. Verified: 10 bar-writes in 20s now trigger ZERO detector runs.
4. **Self-correction on my own measurement.** I reported trendlines as "6.9ms of a 7.3ms budget".
   That was measured WITHOUT JIT warmup and overstated it. Warmed, the full 8-detector suite is
   ~1.04ms and trendlines ~0.42ms. The optimisation (unbounded O(pivots^3) -> capped at 40 pivots,
   early exit, allocation-free inner loop) is still right and trendlines is still ~40% of the budget,
   but the urgency was my bad measurement, not reality.

### Phase 7 — BACKTEST + VALIDATION (`src/backtest/`) — AND THE ANSWER IS NOT FLATTERING

The engine refuses the four standard backtest lies: (1) fills at the NEXT bar's OPEN, never the close
being evaluated; (2) a bar containing BOTH stop and target is assumed to hit the STOP; (3) spread +
commission + slippage on both sides; (4) refuses to run below a coverage floor rather than treating a
gap as one enormous bar. It also refuses demo data unless explicitly allowed, and warns loudly under
30 trades.

`validate.ts` adds walk-forward and **PBO via CSCV** (Bailey/Borwein/Lopez de Prado/Zhu).

**MEASURED RESULT — 6,800 archived BTC 1h bars, 283 days, coverage 1.0, no gaps, after costs:**
- Confluence >= 0.35 : 146 trades, **+0.023R**, PF **1.04**  -> weak
- EMA 10/30          : 127 trades, +0.025R, PF 1.03          -> weak
- EMA 20/50          : 104 trades, **-0.015R**, PF 0.87      -> weak
- RSI reversion      :  16 trades, -0.189R, PF 0.54          -> unproven
- **16-config grid: PBO = 89%**, chosen config OOS-positive only **10%** of the time.

**There is NO demonstrated edge.** The confluence engine is break-even before anything the backtest
cannot model. PBO 89% means selecting the "best" of these configs has WORSE than no predictive value.

Walk-forward on the same run said "233% of in-sample expectancy retained" — which looks superb and
means nothing, because it rests on **22 OOS trades** and the tool warns exactly that. The
contradiction between the two checks is precisely why both exist; trust PBO's 70 splits over 22
trades.

Honest caveat the other way: one symbol, one timeframe, 283 days, and a grid of correlated variations
on 2-3 ideas — correlated candidates INFLATE PBO. Evidence, not a final verdict.

**What this changes:** do not ship signal automation off the confluence score as it stands. The
machinery is now measurable, which is the point — the next move is improving the signal and
re-running this, not building more on top of an unvalidated score.

### Phase 8 — FOREX IS LIVE (via the proxy that already existed)

**BUG FOUND: `proxySourceV2` called an endpoint the server does not serve.** It requested
`/bars?symbol=&tf=` — the real contract is `/ohlc?provider=&symbol=&interval=&limit=`. Every forex
request would have 404'd. Fixed, with tests asserting the URL shape so it cannot drift again.

**Free forex, measured not assumed.** No browser-reachable endpoint gives keyless intraday FX OHLC:
Yahoo's chart API and Frankfurter are CORS-BLOCKED, exchangerate.host now demands a key, and the ones
that ARE open (open.er-api.com etc.) publish DAILY reference rates — you cannot draw an hourly candle
from one number a day. The proxy runs locally so it has no CORS constraint, and `yfinance` needs no
key. That was always the answer; it just was not wired correctly.

Verified end to end: EURUSD 1h, 800 bars at ~1.1587, served by `proxy`, archived alongside BTC
(2 series / 7,200 bars). Detection runs on FX unchanged — BOS markers, an FVG zone and a flipped
S/R level at 1.1575 all drew correctly.

**The freshness contract did its job:** the proxy is registered `delayed` with `streamUrl -> null`,
so the status bar reads `proxy · DELAYED · socket closed · vendor 2747m behind` and the terminal never
claims a live FX feed it does not have. The 2747m is the WEEKEND — FX is closed — which is the
contract telling the truth, not staleness.

Ranked options in `app/docs/forex-data.md`: yfinance-via-proxy (free, keyless, delayed) -> Twelve Data
(free tier, real key, official) -> OANDA practice (free signup, genuine real-time) -> **MT5 bridge**,
which already exists in `server/mt5_bridge.py` and is first in `PROVIDER_RANK["fx"]` — real broker
data, no third party, and the best option available if MT5 is running.

### Phase 9 — REAL-TIME FOREX = YOUR OWN MT5 (registered, awaiting login)

**There is no free third-party real-time FX feed.** Measured: every keyless CORS-open endpoint
publishes DAILY reference rates; Twelve Data's free tier is delayed; yfinance is delayed. The only
genuinely real-time free forex available is **your own broker terminal**, which is also the venue you
are filled at — so its prices are the only ones true for you. `PROVIDER_RANK["fx"]` already said this.

Found on this machine: MetaTrader 5 IS installed (`C:\Program Files\MetaTrader 5`) with a terminal
profile; `server/mt5_bridge.py` exists. Only the Python package was missing.

Done: `pip install MetaTrader5` (5.0.6147 installed). `mt5.initialize()` now reaches the terminal and
returns `(-6, 'Authorization failed')` — i.e. the bridge works, the terminal is not running/logged in.

**Registered `mt5Source` at priority 1, quality `live`, ABOVE the yfinance proxy (priority 2,
`delayed`).** Crypto deliberately stays on Binance: an MT5 crypto CFD is the broker's synthetic price,
not the exchange's, and they are not the same instrument. No reconfiguration is needed when MT5 comes
up — the circuit breaker probes it, the probe succeeds, and the source flips to `mt5 · LIVE` on its
own. Verified live, degrading honestly today:
```
binance: FAIL - does not cover EURUSD      (skipped, no request wasted)
mt5:     FAIL - MetaTrader5 not importable (proxy process predates the install)
proxy:   OK   - 100 bars                   (yfinance, DELAYED)
```

**DONE — MT5 IS NOW LIVE.** User logged into JustMarkets-Demo2 (acct 1100515012); proxy restarted
(the old PID 4544 predated the pip install). Verified: `/mt5/health` -> `available:true`; EURUSD tick
bid 1.15824 / ask 1.15835 (1.1 pips); XAUUSD 4456.35 — **the same price as the MT5 Market Watch at
that moment**. Terminal routes EURUSD/XAUUSD to `mt5`, BTCUSDT to `binance`.

**BROKER SUFFIXES: already handled.** JustMarkets serves `EURUSD.s` / `XAUUSD.s`. `resolve_symbol()`
in `mt5_bridge.py` does exact -> alias -> shortest-matching-suffix, so canonical `EURUSD` resolves to
`EURUSD.s` with nothing to configure. Confirmed live.

Full ranked options + the CORS evidence table: `app/docs/forex-data.md`.

### BUG FOUND IN A v39 SAFETY TEST — it was passing by accident
Installing MetaTrader5 turned `test_service_v370.py` RED: 4 of its "BLIND != SAFE" assertions failed.
**The code was correct** — it could finally see the book, so it correctly stopped reporting itself
blind. The TEST was the problem: it called `/svc/risk/state` with no stubbing and simply ASSUMED MT5
was absent from the machine. It had been passing by accident for as long as MT5 was uninstalled.

A safety test that only passes while a dependency happens to be missing is testing the machine, not
the property — and it would now have failed for ever on this box. Fixed by FORCING the blind
condition: point `svc.PROXY` at 127.0.0.1:9 (the discard port, always refuses) for the duration, then
restore. Added BS6 (the override is restored) and BS7 (the blind reason says UNKNOWN, never zero),
plus the sighted branch nothing had covered. 17 passed/4 failed -> **23 passed, 0 failed**.

Worth knowing: `bash tests/run_tests.sh | sed ...` MASKS the runner's exit code (you get sed's). Read
the SUITE GREEN/RED line, or do not pipe.

### NEW STATE — `closed` (`src/data/sessions.ts`)
MT5 on a Sunday reported `DELAYED - vendor 2642m behind`. Technically true, practically wrong: the
feed is perfect, the VENUE is shut. **A warning that fires every weekend is one you stop reading, and
then you miss the real staleness alarm on a Wednesday.** So a shut market is its own state:
`CLOSED - market closed, last price is the close`, in neutral grey, never amber.

`sessions.ts` models the FX week (Sun 22:00 -> Fri 22:00 UTC), knows crypto never closes, strips
broker suffixes before classifying, and returns `unknown` for equities rather than guessing at
holidays — unknown falls back to judging on data age, which is the safe default. 18 tests.

### Status
Done: toolchain, design system, shell/layout, chart engine (columnar `Float64Array` OHLCV, layered
canvases, anchored zoom, self-healing sizing, data-space annotations), data layer + freshness
contract, indicators, EMA overlays, studies readout, live streaming, view routing, screener +
confluence, auto pattern detection + auto-drawing, Flow desk, persistent archive + multi-source
failover, backtest + walk-forward + PBO, live forex via the proxy, **MT5 serving real-time FX/metals
from your own broker**, market-session awareness. **350 tests.**

Not yet ported: MANUAL drawing tools, strategy engine + tester, intelligence lab, signals/sniper,
risk + broker desks, on-chain/smart-money desks, alerts, workspace import/export.

## WHAT SHIPPED — v39.14 (the live bar was mounting but rendering COLLAPSED/clipped)
The bar was a valid child of `#tabbar` all along (jsdom confirmed 3 stats children, no hide class) but INVISIBLE in the real browser. Root cause: there are **two grid systems**, and the winning one (the "matte redesign", ~line 1700, `!important`) pins the tabbar row to a **fixed `var(--tabs-h)` = 30px**, not `auto`. The 40px tab strip filled the cell and the 26px bar overflowed BELOW it into the chart, clipped. jsdom never caught it because jsdom does no layout. Fix: tabbar grid row `var(--tabs-h)` -> `auto` in the winning grid (line ~1700) AND `.app.topmin` (line 359) so the row grows to fit; `#newsTicker` given `flex:0 0 26px;min-height:26px` so it can't be compressed. Row COUNTS unchanged (4/4) so H6b stays green. The `#wsTabs`/`#instHead` context strip (EUR·1H · ATR · X-MKT · FUND) lives in `#main` (row 3), a different grid row — no overlap. Test C9 locks the auto row. **TRAP: the winning `.app` grid is the second/matte block (~line 1700), NOT line 283 — line 283's `auto` was being overridden. Any tabbar-height assumption must target the matte grid.**

## WHAT SHIPPED — v39.13 (follow-up: the live bar showed no data + session was "—" everywhere)
- **Session was "—" everywhere.** The real session is computed in `42-draw-loop-extensions.js` (`sess()`, handles weekends/stock-hours/FX) but only written to `#stSess`. It now **publishes `window._session`** (+ `window.mishelSession`) each second and once at load, so the sniper pre-flight (`window._session || '—'`) and the live bar read the real value. `sessionNow()` never existed — stop referencing it.
- **Live bar showed "no symbol loaded" even with BTC live.** The current symbol's freshest bars live in `DATA`/`curPrice()`, NOT `BAR_CACHE` (see `62-v13.js:73`). The bar now reads the current symbol from `DATA`/`curPrice()` and other symbols by scanning `sym|*` (the codebase idiom `k.indexOf(sym+'|')===0`, longest series wins) — was doing an exact `sym|tf` lookup that always missed. Prices use `toLocaleString` (thousands separators).
- **Bar redesigned plain + professional.** LEFT = watched prices (current + up to 3 held) with %, session, current spread in money, plain-language feed-health dot (“Live — updated Nms ago” / “slow” / “stalled”). Dropped the account chips (open R/heat) — they duplicate the status bar — and the dead DXY/F&G chips. RIGHT tape reworded to plain language (“Unusual market conditions — past patterns may not hold”, “Strong signal · Buy BTC (5m)”, “Funding …”). Mount + real-data render verified in jsdom.
- Test `test_v3912_livebar.js` extended (C7 current-vs-other price source, C8 session global); `test_v3910_declutter.js` N1 hot-item assertion updated to the reworded anomaly text. Suite **1599, 0 fail**.


Built by **direct src/ edits** (not exact-string patches on index.html): edit `src/js/NN-*.js` + `src/00-head.html` → resync `src/manifest.json` `sha256_of_source` (newline='' concat of parts, pre-injection) → `python3 tools/build.py --release --verify-identity` → regen `/tmp/main.js` → `bash tests/run_tests.sh`. **No `split.py`** (module 75 is absent; split folds 76→74). Suite: **1597 assertions, 0 fail** (was 1576; +21 from the new lock-in test).
- **A · ONE spec-driven unit resolver** (`window.symUnit` in `14-symbol-universe.js`). The bug: a $64,706 crypto stop rendered as **“−15,741 pips”** — the sniper's unit logic fell to an FX fallback (`px>50?0.01:0.0001`) whenever `CURSYM.cls` momentarily read `forex`. The resolver recovers class+pip from the SPEC (`CURSYM.spec` → `SPECS[CURSYM.sym]` → `SPECS[#symSel]`) so units follow the instrument, not a volatile global; last-resort guard: a >1000-priced asset is **never** a 0.01-pip forex pair. Sniper `71` routes `dec()/distUnit()/checklist-spread/pre-flight-spread` through it via a local `_unit()` that prefers the global and keeps a correct fallback for isolation. Broker desk `72` was already spec-driven — untouched.
- **B · Tick bus** (`window.Tick`/`window.onTick`/`renderIfChanged`, top of `01`, ABOVE the ops-spine banner). `renderQuick()` (called by every feed incl. the ws kline) emits; sniper `71` + watchlist `73` + live bar `74` subscribe with a price-changed guard, rAF-batched (one repaint/frame). Old `setInterval`s stay as the quiet/offline heartbeat. **Order ticket `72` deliberately left on its 5s timer** so a live tick never clobbers a value being typed.
- **C · Docked live bar** (`74` rewrite + `00-head` CSS). Was a marquee buried in `#side`; now `#newsTicker` docks into the **`.tabbar` row** (full-width, always visible, outside any scroll — chosen over a new grid row to avoid the H6b blank-chart area/row-count trap). LEFT = always-visible stats (watchlist price+%, session via `sessionBucket`, funding when a crypto feed provides it, open R/heat from `_gov`, ws-health dot S3: amber >3s / red >10s); RIGHT = scrolling tape (calendar countdown, anomaly, A-tier signal, RSS), hot items pulse to front. Honest “—”/“tape quiet”, content-hash guarded. Kept N1 anchors (`id = 'newsTicker'`, `tkscroll`, `tape quiet`, `_macroCal`).
- **Test harness note**: `tests/test_v261_hardening.js` reads `/tmp/main.js` — regenerate it from the built `index.html` (largest inline `<script>`) before every `run_tests.sh`. `test_v350_ops.js` grabs the spine IIFE by searching **forward from the `v35.0 OPERATIONAL SPINE` marker** for the first `(function(){` — any new early IIFE in `01` MUST sit ABOVE that banner or it gets grabbed instead of Clock.
- **New test**: `tests/test_v3912_livebar.js` (21 assertions) locks in all three, incl. a `vm`-eval of the shipped resolver proving BTC→“$157”.


## WHAT SHIPPED THIS SESSION
**v35.0 — OPERATIONAL SPINE (the tab stops being the app).** Four stages, in dependency order.
- **Clock**: `setInterval` wrapped -> all 57 timers enrolled with ZERO call-site edits; one 250ms driver; per-job try-guard (a throwing job is isolated AND recorded, no longer dies silently); **wake catch-up** (every due job runs immediately on tab return); Jobs X-ray chip in the status bar.
- **Freshness contract**: `Fresh` separates **tick age** (feed alive?) from **vendor lag** (yfinance ~15m behind) — a delayed feed is NEVER labelled plain LIVE. Stale/offline => Decision Bar prints `⛔ no decision on a dead tape` AND **the MT5 ticket refuses to build**. Rationale: Chrome throttles background tabs to >=60s and the terminal is ALWAYS a background tab (you're in MT5) — it used to keep saying LIVE over a minute-old price.
- **Always-on tier**: `sig_loop` + `server/sig_worker.js` — the 26 strategies run **browser-closed** in Node, extracted VERBATIM from index.html (NOT re-implemented in Python: two sources of truth would disagree on a live trade). Structural dedup (`bar_t` in sig_fired's PK => one bar fires once, ever). `heartbeat_loop` = **dead-man's switch**: absence of the 4-hourly message IS the alarm. 🔔 now arms the SERVER, and says plainly when it can't.
- **Durable state**: 15 irreplaceable keys mirror to SQLite (`/svc/kv`, monotonic revs); localStorage demoted to cache; ~42 cosmetics stay local by design. UNSYNCED chip + requeue on failure + `sendBeacon` on tab close. Wiped Chrome profile = non-event.
- **Source layout**: `tools/split.py` -> **60 JS modules**; `tools/build.py` reassembles and **asserts byte-identity (sha256)**. Retires the triple manual version bump (now `src/VERSION`, one place), exact-string atomic patching, the WSRC string-literal extraction, and "syntax error at line 7,412".

## NEW TRAPS FOUND (hard-won, this session)
- **The suite STUBS `IND.adx`** (`d.map(()=>ADXV)` in test_v340_alpha.js) — the SHIPPED adx had never been exercised by the signal tests. `sig_worker.js` runs the real one and HARD-FAILS if the `IND.adx=` extension is missing. `IND` is a `const {...}` literal PLUS **23 top-level `IND.x=function` one-liners** — any extractor must pull both.
- **`sigScan`'s detect loop is `for(let i=60; i<d.length-1; i++)` — it NEVER scans the final bar.** A live alert on the newest CLOSED bar is only reachable if a real bar sits behind it. `sig_loop` therefore passes the still-forming bar as a **positional tail** (`lastClosedIdx = len-2`); the forming bar is never scanned for a signal, only used to skip a setup whose stop already ran intrabar.
- **Version regexes must require a dotted version**: a loose `BUILD v[\d.]+` also matches the CSS comment `INTERFACE REBUILD v5`. The `count==3` assert caught it; a blind sed would have corrupted the file.
- **Brace-counting extraction breaks on `}` inside a regex character class** (e.g. `/\s*\(\s*\)\s*[;}]/` in the Clock). Use the JS parser as the oracle instead (grow the slice until `new vm.Script()` compiles).
- **STORE is now a browser global.** Any test harness that fakes `localStorage` must also fake `STORE` (4 harnesses updated). Durable keys must NEVER call `localStorage.setItem` directly — there's a leak-check assertion for this.
- **`tests/test_v241_fixes.js` is RED and NOT REGISTERED in run_tests.sh** — pre-existing, predates this build. Left as found. Fix or delete it.

## BUILD DISCIPLINE — CHANGED
The old ritual (exact-string atomic patches + triple manual version bump) is **retired**. New flow:
```
edit src/js/NN-*.js            # ordinary file edits, 200-line files
python3 tools/build.py --verify-identity   # prove nothing changed unintentionally
python3 tools/build.py --release           # bump from src/VERSION, emit index.html
bash tests/run_tests.sh                    # 63 files
```
After a release, re-run `tools/split.py` to re-baseline the manifest sha.


## WHAT SHIPPED THIS SESSION
**v36.0 — THE BROKER IS THE SOURCE OF TRUTH.**
- `server/mt5_bridge.py` — MT5 as a first-class provider (`/ohlc?provider=mt5`), ranked ABOVE every vendor for fx/metals/stocks. New feed tier `REAL · BROKER`. Symbol resolution handles broker renaming (EURUSD.a / GOLD / EURUSDm) and returns None rather than guessing a name the broker never reported. Windows-only (MetaTrader5's constraint); imports cleanly everywhere, reports the exact reason when unavailable.
- The **live broker spread** now feeds `_oflow.spread` -> every signal's costR. Retires the hard-coded `0.0002` used by 26 strategies for 34 versions.
- `server/mishel_recon.py` — PURE reconciliation engine: slippage_R, cost_R (broker's own commission+swap), gross_R -> net_R, MFE/MAE, mfe_capture, exit_reason incl. **beyond_stop**. Aggregate findings in plain language. Headline: gross positive + net negative -> "YOUR SETUPS WORK; YOUR EXECUTION DOES NOT."
- `server/mt5_report.py` — parse an exported MT5 history report (Toolbox -> History -> right-click -> Report -> HTML). Reconcile TODAY, no Windows bridge needed. Import is idempotent by MT5's deal ticket (PRIMARY KEY).
- Service schema **v3**: `mt5_deals`, `mt5_specs`. Routes `/svc/mt5/import`, `/svc/mt5/sync`, `/svc/recon`, `/svc/mt5/status`. Plans are read FROM SQLITE (the payoff of v35 durable state).
- Client: **⚖ toolbar button** + ⌘K -> Execution Reconciliation panel. Honest empty state ("Your real edge is currently unmeasured"), a dash means NOT MEASURABLE not zero, and MFE/MAE reports which bar series it used.

## NEW TRAPS FOUND (v36)
- **The falsy-zero trap**: `not trade["open_ms"]` is True for a VALID timestamp of 0. Guard timestamps/prices/volumes with `is None`, NEVER truthiness. A known-answer test caught this; reading the code did not.
- **Never pin a schema or version in a test.** v35 pinned `SCHEMA_V == 2`; an additive migration then reddened a green suite. Same class as the pinned `APP_VER`. Use `>=`.
- **The service must `sys.path.insert(0, dirname(__file__))`** — systemd, NSSM, a test harness and a double-clicked .bat all disagree about cwd, and sibling imports (`mishel_recon`, `mt5_report`) break without it.
- **MT5's HTML report has NO position_id** — `pair_positions()` reconstructs it FIFO. On a HEDGING account with simultaneous positions in one symbol this can mis-assign a pair. The bridge returns the real position_id and has no such ambiguity.

## NEXT (the roadmap, in dependency order)
1. **Risk Governor** — account-level, not per-trade. The bridge already returns balance/equity/margin/positions, so this is now cheap: daily-loss lockout, correlated-exposure cap (long EURUSD + short USDCHF is ONE bet), consecutive-loss cooldown, and a hard block on the ticket when the account rule says no.
2. **Cost model per instrument** — `mt5_specs` is populated but the backtester still uses flat costBps. Wire it in: every historical stat gets re-costed with the real spread/swap.
3. **The ★ auto-picker is still a data-mining machine** — 26 strategies scanned, best-by-net-R promoted. PBO/DSR tooling EXISTS but is only wired to the backtest view, not the picker. This overstates the edge every single day.
4. **Pre-market ritual** — one screen, one decision, before London.


## WHAT SHIPPED THIS SESSION
**v37.0 — THE RISK GOVERNOR.** Account-level risk, from the REAL account.
- `server/mishel_risk.py` — PURE engine. **Currency-leg decomposition**: long EURUSD IS long EUR / short USD. Correlation as arithmetic, not a model. Rules: daily loss, open-risk cap, currency concentration, loss-streak cooldown, trades/day, per-trade %, and **unprotected positions** (sl=0 blocks everything). State computed from v36's reconciled REAL fills, never PAPER.bal.
- **Enforcement**: a BLOCK refuses to build the order ticket (same gate as the freshness contract). It NEVER claims to stop him trading: "Nothing is stopping you placing this by hand in MT5. This terminal just will not hand you the ticket."
- **THE 1000x GOLD BUG**: the shipped ticket did `units/100000` for `/EUR|GBP|JPY|XAU/`. XAUUSD's contract is **100 OUNCES**. Gold was sized 1000x too small since v1. Sizing now comes from the broker's real spec via `/svc/risk/size`; with no spec it prints **NOT SIZED** and refuses. The old code path is DELETED.
- **BLIND != CLEAR**: bridge down -> positions UNKNOWN (not zero) -> verdict WARN, never ALLOW, with the words "this is a blind spot, not an all-clear".
- Client: **🛡 toolbar button**, status-bar **Risk chip**, ⌘K entry, editable limits persisted to SQLite (schema v4, `risk_cfg`).

## NEW TRAPS (v37)
- **The IEEE754 lot-step trap**: `1.1000-1.0950 == 0.005000000000000115` -> `lots_exact = 0.19999999999999538` -> a naive floor turns a correct **0.20 into 0.19**. Use `math.floor(x/step + 1e-9)*step`. Pinned as PS8b.
- **Flags die in rebuild loops.** `compute_state` dropped `risk_unknown` when reconstructing positions, so a warning could never fire from the real path. Test the BEHAVIOUR, not the code.
- **NEVER pin a version or schema in a test.** I have now done this three times (`APP_VER`, `SCHEMA_V==2`, `SCHEMA_V==3`). The suite has been swept clean; keep it that way. Always `>=`.

## NEXT (roadmap, in dependency order)
1. **Wire `mt5_specs` into the backtester.** The real spread/swap per instrument is now in SQLite, but historical stats STILL use flat `costBps`. Every OOS number is currently costed with a guess. This is the last place a fabricated cost survives.
2. **The ★ auto-picker is still a data-mining machine.** 26 strategies scanned, best-by-net-R promoted, every single day. PBO/DSR tooling EXISTS but is wired only to the backtest view, not the picker. This overstates the edge daily and is now the single biggest remaining honesty gap.
3. **Pre-market ritual** — one screen, one decision, before London. The governor, the reconciliation findings and the freshness contract in a single pre-flight check.
4. **Session/ORB correctness under broker server time** — now that MT5 provides the real server-time offset, verify every session boundary against it.


## WHAT SHIPPED THIS SESSION
**v38.0 — HOTFIX + the last fabricated numbers.**
- **HOTFIX (serious)**: `Fresh` was honoured by only 2 of 4 feeds. The crypto sinks (`applyKline` ws, `startLiveReal` poll) never set `_lastTick`/`_realFeed`, so Fresh said OFFLINE on a live Binance feed — which per the v35 gate **silently killed the Decision Bar and the MT5 ticket for all of crypto**. Now pinned as an INVARIANT: every path that writes `CURSYM.px` MUST stamp the contract.
- **HOTFIX**: `\u2696`/`\ud83d\udee1` were JS escape syntax in RAW HTML (nothing decodes it) → buttons showed literal text. Use real glyphs in markup.
- **HOTFIX**: renamed the bar-completeness readout to **Integrity** (it collided with the "Data" freshness chip).
- **★ PICKER GATE**: PBO(CSCV) + Deflated Sharpe now run on the auto-pick and can **WITHHOLD** the star. Proven functionally: 26 noise strategies → best Sharpe 0.086 vs E[max]-under-null 0.082 → PBO 56%, DSR 53% → withheld. A real edge → DSR 100% → promoted.
- **REAL COSTS**: flat 2bps + ignored commission/swap + a 0.15R cap → replaced by broker tick > broker spec > live book > LABELLED assumption. Commission derived from HIS OWN FILLS via `/svc/costs`. Costs REAL/ASSUMED chip.
- **n + Wilson CI** on the Signal Accuracy panel; insignificant rows greyed and labelled "coin flip".
- **☀ PRE-MARKET RITUAL**: five checks + a verdict, before London.

## NEW TRAPS (v38)
- **`build.py` is MANIFEST-DRIVEN, not glob-driven.** A new `src/js/*.js` is SILENTLY DROPPED and the build still says "released". I lost two whole modules this way. It now HARD-FAILS on any unlisted source file — keep that guard.
- **JS escape syntax (`\u2696`) does NOT decode in raw HTML markup.** Use the real character.
- **Test the INVARIANT, not the artefact.** 1,303 assertions proved the freshness contract existed; none proved every feed honoured it. When you add a cross-cutting contract, add a test that enumerates ALL its call sites.

## NEXT (roadmap)
1. **Session/ORB under broker server time** — MT5 now gives the real offset; every session boundary, ORB and prev-day level should be verified against it (currently UTC-assumed).
2. **News blackout** — NFP/CPI windows should block the ticket, same gate as freshness and the governor.
3. **"FX desk" mode** — hide the crypto/meme/wallet/rug surface he never uses; it is pure cognitive load for a forex/metals trader.
4. **Wire `mt5_specs` into the BACKTEST view too** — sigScan now uses real costs, but `sweepStrategyConfigs(baseSpec,d,costBps)` in the overfit-audit module still takes a flat costBps argument.

## WHAT SHIPPED RECENTLY (prior sessions) (prior sessions) (prior sessions) (prior sessions)
**v34.0 (latest) — ACCURACY SPINE + 26 STRATEGIES:** habitat gating (ADX regime, trend/range/any per strategy); adaptive ATR stop pad; 40-bar time barrier (scratches, not immortal opens); walk-forward auto-pick (4 folds, TEST-fold records only, legend "WF-OOS ·"); Wilson 95% CI on every win%; net-of-cost avgR. 14 new strategies (roster 26): Stop-Run Reclaim, Equal-Highs Raid, Session Liquidity Grab, Liquidity Sweep, Imbalance Fill, Absorption Break, Late-Breakout Fade, CVD Divergence Snap, Failed Breakout Trap, Compression Break, HTF Confluence Pullback, VWAP Execution Shadow, Momentum Ignition, Ensemble Vote — all in the Signals picker (grouped), options show measured net R in place. AR1 funding-fade honestly demoted to a crowding gate (no history to measure). 🗺 Liquidity Map overlay (stop-cluster estimates); crowding meter card → Decision Bar; IN1 setup memo + IN2 quality calibration on hover; Lab gains habitat/CI/netR columns. Suite 57 files green; boot audit 0 errors.

**v33.0 — THE MASTER BUILD:** Decision Bar (read · conditions/100 · sig · next action) on every view; cockpit → DECIDE/CONTEXT/EVIDENCE sections w/ digests; judge() meanings on numbers; decision-state colors; Smart Money → Act/Wallets/Forensics; ⚡ QFA fundamentals (SOUND…HOLLOW, glass-box components, threat line) in every pack; typed entity labels; liq-zone estimates (formula shown); 🧪 Strategy Lab (OOS-sorted, use ▷); urgency-sorted notifications; search field + command syntax (btc 4h / qfa / w: / j / lab); function chips; draggable plan → sizer/ticket; ✏ auto-annotate; 📋 MT5 ticket; 🔍⚖🎯🪞 stages + the weekly mirror; CVD sub-pane w/ divergence flags (proxy labeled, real when online). Boot audit 0 errors. Suite 56 files green.

**v32.1 (prior) — fix pack:** headless jsdom boot audit added (0 errors); GLR.begin guarded (dead-chart class); draw errors → ⚠ telemetry; boot-integrity red strip + self-heal; ROOT CAUSE fixed — wsTabs innerHTML rebuilds were destroying the merged instrument header (detach/re-append at render site, proven headless); TV-grade ghost toolbar w/ ⋯ overflow + separators + icon glyphs, guaranteed one row; SIG legend → top-left; countdown fused into the last-price axis tag; air pass (hover borders). Suite 55 files green.

**v32.0 (prior) — PRO CHART + INTELLIGENCE + WORKSPACE triple arc:** **v30** flag-pill markers + ribbons, candle polish + hollow option + pulse dot, tabular numerals + tick-flash, resizable panes, magnet + per-symbol drawing persistence + properties popover, axis alerts, ▤ VPVR (POC/VAH/VAL), rAF-batched draw. **v31** session-tagged signals + per-session records, ◉ stacked-vs-solo measurement, per-symbol OOS memory + suggestions, 🔔 live-fire Telegram alerts w/ record, 📓 decision journal (stop-first honest, YOUR % vs system), Order Flow card (spread/tape/CVD), OI + L/S + divergence flags, correlation card, 📅 event lines. **v32** ⊞ Grid + workspaces, richer ⌘K (wallets/actions), 🔔 notification center, ? keyboard overlay + / search, candle right-click menu, design tokens + 2 curated themes. Suite 54 files green.

**v29.0 (prior) — TV interface + sustainability:** SIG visibility bug fixed (C10 early-return swallowed the hook); strategy registry (SIG_DETECT, pluggable); OOS honesty — ★ auto selects in-sample, reports out-of-sample ("OOS ·" in legend); T1 docked drawbar; T2 axis bubbles; T3 countdown on axis; T4 legend rows w/ ✕ + parked re-add; T5 axis drag-scale/zoom + log-linear menu; T6 segmented toolbar; T8 softer grid; T9 📋 watchlist rail; T10 signal hover cards. Durability: /svc/backup kv + 4h auto-backup + restore-on-empty; ⚠ error telemetry badge; schema versioning. Suite 53 files green.

**v28.1 (prior):** 12 signal strategies grouped by style — SCALP: VWAP Bounce/RSI Snap/BB Snapback · DAY: EMA Pullback/Momentum/ORB/Prev-Day Break · SWING: Supertrend/CHoCH/Donchian/Golden Cross/MACD Zero. Quality score 0-100 per signal (trend 40+momentum 30+vol 30) w/ Q≥50 toolbar gate; stats add profit factor; ★ auto prefers the style fitting the TF (sigStyleForTF). 22 new tests; suite 52 green.

**v28.0 (prior) — SIGNALS + DECISION LAYER:** on-chart entry/exit signals: 4 glass-box strategies (sigScan/sigStats/sigBest, known-answer tested), ▲L/▼S arrows + outcome traces + live entry/stop/T1/T2 lines via _drawPost hook, toolbar picker w/ ★ best-measured, permanent measured-record legend ("not a promise"), fresh-signal toast + plan sync, NO auto-exec (tested). Decision layer: D1 REAL/FAKE convergence verdicts (sybil cross-check) + pack/scout, D2 pattern meanings + flag, D3 SO-WHAT strips, D4 next-best-action box, D5 explainers, D6 collapsed walls. E1 Action Queue, E2 Research Pack modal (verdict stamp), E3 daily diff, E4/E5 to-chart+pin-watch, E6 dossier visit-diff, E8 notes in dossier, E9 Watching table (Δ since pinned), E10 narrative tags. 37 new tests; suite 52 files green.

**v27.2 (prior):** S/A filter no longer vanishes (controls render in empty branches + honest why + ← show all); instrument header merged into symbol-tabs row in compact (nodes moved, ids intact, ihCon hidden) — one chart header row, ~34px more chart. Suite 51 green.

**v27.1 (prior):** broken #sideJump chips REMOVED (two competing rule-sets garbled them; cockpit covers nav); candles bigger — price pane default share 0.82/0.84 (was 0.74/0.80), volume slimmed, drag-divider still overrides. Suite 51 files green.

**v27.0 (prior) — space optimization V1-V9:** toolbar never wraps (Indicators inline, V1); OHLC overlay slimmed (V2); compact header — price 17px, verTag → status bar #stVer (V3); tabs 23px (V4); status 24px (V5); side chips one scroll row (V6); side cards+MTF −20% padding (V7); side defaults narrow 300px chart-first (V8); ALL density under `body.compact`, ON by default, persisted cockpit toggle (V9). ≈100px more chart. 13/13; suite 51 files green.

**v26.2 (prior) — A+B+C triple build:** **A (v26.0)** right-side COCKPIT: 12 cards (Trade Plan w/ glass-box entry/stop/T1/T2, live Sizer, Key Levels w/ %/ATR distances, Vol&Regime, Session Clock, X-Mkt, News countdown, Funding, Smart-Money mini, Signal Accuracy, Confluence sparkline, Model Verdict w/ Wilson CI) + collapse/drag/persist + width presets. **B (v26.1)** hardening: token auth on /svc (fails closed non-localhost), loop heartbeats → /svc/health stale_loops + red client banner, per-host circuit breaker (429-aware), requirements.lock.txt, MISHEL_TG_TOKEN env secrets, collision-linter tests (grid rows/areas match, dup selectors, dup consts). **C (v26.2)** isolated draw-loop: 2 try-guarded hooks only; C8 LDN/NY session shading (◨ toggle), C9 ⇄ %-normalized compare from BAR_CACHE (honest, no hidden fetch), C10 ▲▼ wallet-move markers only on symbol match ("evidence, not signals"). Suite 50 files green.

**v25.4 (prior) — TradingView-class chart:** true browser fullscreen (top+status hidden, rows 0/1fr/0, native Esc sync); floating fs toolbar (symbol+TF+exit, proxies tfBar); dblclick chart=fullscreen, dblclick axis=reset zoom; keyboard F/+/-/arrows/1-5-3-h-4-d-w; any letter=symbol search prefilled (openMsp(prefill) global); readout range%. C4/C5 confirmed pre-existing. C8/C9/C10 (session shading, compare, SM markers) = next isolated draw-loop build. 18/18; suite 46 files green.

**v25.3 (prior):** Expand TRULY fixed — root cause was `.side{grid-area:side}` referencing an area absent from the chart-max template → CSS auto-placement dropped the whole side panel OVER the chart. Now `.app.chart-max .side{display:none!important}` (beats inline flex). 3 more tests; suite 45 files green.

**v25.2 (prior):** Expand FIXED — removed duplicate old `.app.chart-max` rule that scrambled layout; toggleMax now forces chart view first + clears all inline grid; one clean 3-row chart-max grid. Ranking area rebuilt (tighter rows, compact buttons, hover). 9/9; suite 45 files green.

**v25.1 (prior):** FIXED blank chart after v25.0 — the tab bar added a 4th grid-area row but grid-template-rows still had 3 values, collapsing the chart. Added `grid-template-rows:var(--top-h) auto 1fr var(--status-h)` (+3-row for chart-max). Boot self-check now validates the tab bar not the hidden rail. 6/6; suite 44 files green.

**v25.0 (prior) — TOP TAB BAR replaces left rail:** rail removed (`#rail{display:none}`, grid rebuilt full-width), horizontal tab bar (Chart·Smart Money·Discover·Analysis·Strategy·Tools·⌘K) with inline sub-tabs; `syncTabBar()` drives the existing `goView()` so all views intact. Expand = true fullscreen (tabbar+side hidden, Esc restores). Smart Money: quick-start banner + one-click "Get copyable wallets (EVM)" (scans Base radars→harvest). Registered v242/243/244 suites. 21/21; suite 43 files green.

**v24.4 (prior):** left bar FIXED — removed broken collapsed-label CSS (was clipping to stray chars against 12 competing breakpoint rules), rail now pinned-open by default with group headers + active accent bar. Ranking huge-gap FIXED — table-layout:fixed + 300px actions col + inline-block actions (were stacking/floating right). 10/10; suite 40 files green. Rows all "C 21 UNPROVEN WHALE" = correct (single-token Solana whales; need EVM harvest for tiers).

**v24.3 (prior):** FIXED ranking "undefined 6/undefined% conf" (rebound smartScore→walletIntel for tier+conf); table width-capped (no huge gap); COPYABLE/WATCH/UNPROVEN badge + DNA role inline per row (R3/D1); honest thin-DB hint → harvest EVM (R4); tier filter + sort (R5/D3); left bar = labels under icons always visible + group headers collapsed + active bar (L1-L4); full emoji audit clean (C1); unified table density (C2); legend opaque + RSI/FLUX finite-guards fix garbled corner (C3). 20/20; suite 39 files green.

**v24.2 (prior):** FIXED confluence NaN cascade (EUR/USD feed showed "Strong Sell NaN / score NaN±NaN / agreement NaN%"). `confluence()` now sanitizes non-finite dv/strength/weight, guards contributions, clamps score+conf so never NaN; all-NaN→neutral 0. Robustness block shows honest blank not NaN±NaN. 9/9; suite 38 files green.

**v24.1 (prior):** fixed 7 broken `\U0001f` emoji escapes (were literal "U0001f4b0 holdings" text) → valid `\u{1F...}`; ranking table redesigned (tier badge + one-line rows + compact actions, no huge gaps); whale-board ✕ remove button + server `/svc/onchain/unwatch`; chart Expand toggle FIXED (clears inline grid, expands+restores, Esc works); hybrid rail (always-visible group tabs + labels), Favorites emphasized, ⌘K hint. Chart already feature-complete (VWAP/Bollinger/EMA/SMC/drawings/Heikin); C11 compare + C13 on-price markers deferred (no blind draw-loop surgery). 13/13; suite 37 files green.

**v24.0 (prior) — DATA→DECISION:** verdict engine (tokenVerdict WATCH/RESEARCH/AVOID+conviction+F4/F5/F7, walletCopyability, feedRead F6); Opportunities Desk shortlist w/ one-tap actions; meme Verdict column (A1); interpreted feed (A3); F1 daily_brief_loop; F2 pinAdd/pinDiff watchlist-state; rail reorg TRADE·SMART MONEY·DISCOVER·AI·STRATEGY·TOOLS·SYSTEM. 25/25+4/4; suite 35 files green.

**v23.1 (prior) — dashboard/Solana fixes:** Solana wallet holdings via public Solana RPC (getTokenAccountsByOwner; transfers honestly N/A); co-holding + live-feed wallet addresses now clickable→open full DNA dashboard; token/wallet addresses copyable (⧉). 11/11; suite 33 files green.

**v23.0 (prior) — WALLET DNA:** `walletDNA` engine (dnaStyle/HoldTime/Consistency/Affinity/Timing/Risk + precise role) pure+tested; full DNA dashboard in wallet dossier (role + 6 chips atop portfolio+holdings+history); D3 `smartMomentum` gauge, D4 `earlyEntryRadar`, D2 `walletCompare`. Telegram refined: track=subscribe (client sends DNA snapshot → service "NOW TRACKING" msg + auto buy/sell stream; no per-card buttons). 25/25 client + 4/4 service; suite 32 files green.

**v22.1 (prior):** FIXED institutional theme not applying (applyTheme persists `mishel_theme`; startup applies saved-or-institutional every load); TradingView ⛶ chart Expand (collapses rail+side, Esc restores); Smart Money dossier `portfolioSummary` (bias, buy/sell%, most-active token). 15/15; suite 30 files green.

**v22.0 (prior) — INSTITUTIONAL UI:** new `institutional` theme (default on first load, slate-blue #5B8DEF accent, no neon, graphite surfaces, data-grid tables, focus rings); pro rail (buttery width transition, accent-bar active state, horizontal labeled rows when pinned, uppercase quiet headers); smooth polish (view fade, thin scrollbars, micro-transitions); chart = Option A (debounced rAF resize, draw loop untouched). Additive CSS + non-breaking JS, all features preserved. 22/22; suite 29 files green.

**v21.0 (prior) — SMART MONEY POWER ENGINE:** X1 Solana holders (GoPlus solana endpoint) fixes Scout+Harvest on Solana; `walletIntel` S/A/B/C/D tier score (P1)+confidence (P12); auto-rank (P2); P4 DB-wide alerts (`/svc/onchain/dbwallets`+`db_alert_loop`); P5 token→smart-money; P6 `clusterDetect` Sybil rings; P7 round-trip leaderboard (`/svc/onchain/leaderboard`+`profitProxy`); P8 CSV in/out; D1 nicknames (`mishel_wnick`). 16/16 engine + 3/3 service; suite 28 files green. **NEXT: v22.0 full UI redesign (user asked — do it as a focused design-system build).**

**v20.1 (prior) — fixes:** rail regroup rewritten NON-DESTRUCTIVELY (rebuild groups from scratch + orphan MORE-group safety net; v20.0 version silently failed on real DOM so Smart Money looked missing); Token Dossier gains Solana + address-shape chain auto-detect + GoPlus gated to EVM with honest Solana note (pump.fun addresses now work). No separate Intermarket nav exists (it's the right-panel Cross-Market card; user saw Intelligence Lab). 11/11; suite 26 files green.

**v20.0 (prior) — SMART MONEY DESK:** new `smart` view: wallet DB (`mishel_walletdb`, auto-harvest from every scout), Mass Harvest (radar tokens, rate-limited), cross-token ranking (`smartScore` weights×log2(tokens)×14d-decay, glass box), wallet dossier (Blockscout holdings+flows+freshness from tx count), `manipFlags` (circular/flip-flop), co-holding clusters, live feed (svc events→Blockscout fallback). **Server:** `smart_copy_loop` + `wallet_events` table + `/svc/onchain/events`; pure ML `flow_state`(EWMA, "started selling" flips)/`burst_score`/`convergence` — smart TG signals, anti-spam. A1 confluence nav hidden (+XAI link in side), A2/A3 rail regrouped with counts. 28/28 client + 12/12 service; suite 25 files green.

**v19.0 (prior) — VISIBILITY:** rail pinned by default (unpin remembered); X-MKT chip in chart header (regime·anomaly·rotation, red on stress, = checklist gate 6); Scout at TOP of On-Chain + 🎯 bridge from holder tracker; "stale" → per-class truth ("reconnecting…" / "FX/stocks: key or proxy needed" + remedy tooltip); #feedTxt ellipsis fixed topbar bleed. 15/15; suite 23 files green. NOTE: version asserts in tests must stay >= (never pin exact APP_VER).

**v18.5 (prior):** 🎯 Smart Wallet Scout (`scoutWallets` pure+tested: whales / two-way churners / early accumulators [honest profitable-trader proxy] / risk wallets incl. insider-allocation + registry cross-check; ★ follow & 🚩 flag per wallet); bottom-bar liveness now uses the canonical `_lastTick` formula (fixed "no live feed" vs REAL DATA contradiction) + nowrap; 16 literal `\uXXXX` HTML escapes swept to real chars (v18.0 Whale Board bug); cross-market anomaly = 6th checklist gate ("stand aside" on stress); rail Frequent group (learned from clicks) + first-run pinned on wide screens. 26/26; suite 22 files green.

**v18.0 MASSIVE (prior):** contract addresses + copy visible directly in New-Launch Radar AND Meme Radar main tables (+ per-row buy link & dossier jump in launches); 🐋 Whale Board (saved ∪ `/svc/onchain/watch`, copy/explorer/one-tap verdict); Source Health board in Settings (live-tests all 7 providers, honest CORS note); SRC forcing while offline warns red + "armed — go Online" label (root cause of "sources problem"); chart card merged as **Cross-Market Intelligence (CORR·ROTATION·REGIME)**, rotation renders in 1.5s. 27/27; suite 21 files green.

**v17.1 (prior) — visibility/coverage fixes from the user's live screenshot:** SRC picker moved topbar→status bar (overlay fixed); rail search on hover; holder table = full whale addresses + ⧉ copy + ★ follow (tracker + `/svc/onchain/watch` registration, chain-correct `explorerUrl`); scanner depth 8→selector(15/25/40); meme radar boosts+profiles merged (cap 60); ROTATION strip in Intermarket card. 25/25; suite 20 files green.

**v17.0 FINAL (prior) — the "user asks" arc, four verified stages:**
- **v16.1 Sources**: OKX+KuCoin+Gate.io providers (pure mappers unit-tested), 7-deep failover chain, top-bar SRC picker (`FORCE_SRC`/`window._PROV`) + live source label (2s refresh). 15/15.
- **v16.2 Meme PRO**: ⊕ row expansion — contract address + copy, verified buy links per chain (Jupiter/Raydium/Pancake/Uniswap; honest empty for unknown chains), transparent `oppScore` (rug-penalized, notes name every component), per-row dossier (`buildDossier(addr,chain,out)` param refactor), how-to-buy safety checklist. 18/18.
- **v16.3 News+Pine**: `newsParse` epoch timestamps (null when unparseable), `newsMarkerIdx` bar bucketing, "News markers" chip (diamonds, high-impact red, honest no-feed hint); full Pine v5 exporter (`pineExport`, PINE_MAP 26 vars, unsupported customs NAMED+dropped), Pine v5 ⤓ button in Strategy Tester. 19/19.
- **v16.4 RRG+Rail**: `rrgCalc`/`rrgQuadrant` JdK-style rotation (real cached bars only, honest empty), SVG quadrant panel in Heatmap w/ auto-refresh; rail search (Enter jumps), collapsible groups (localStorage `mishel_railgrp`), active-group highlight. 16/16.
- Suite: **19 files in run_tests.sh — ALL GREEN at v17.0.**

**v16.0 FINAL (previous session) — the "Cat 2-8" arc, four verified stages:**
- **v15.1 Charting (Cat 2)**: AVWAP ±1σ/±2σ vol-weighted bands on every avwap drawing (`avwapBandsFrom`); named drawing templates (`mishel_drawtpl`, drawbar button, save/apply/delete via `tplUI`); "Axis heat (vol@price)" chip (`axisHeatBuckets`, heat strip on the price axis inside `draw()` — scope vars vis/lo/hi/W/padR/priceH confirmed live). 17/17 tests.
- **v15.2 On-chain (Cat 3, user's priority)**: `whaleStats` grid on every holder scan (whale count ≥1% excl. contracts/locked, whale %, top-1/top-10, contract share, LOW→EXTREME risk); **Rugpuller Registry** (`mishel_ruggers`, "mark token as rug" captures GoPlus creator/owner, dedup+merge, manual flag/unflag panel, flags future scans + dossiers); **Token Dossier** panel (DexScreener best-pair + GoPlus + whale numbers → `dossierVerdict`: AVOID on honeypot/known-rugger hard flags, per-source honest failures); `walletFlow` ACCUMULATING/DISTRIBUTING/CHURNING pills on wallet scans; +15 SPECS coins (WIF BONK FLOKI SHIB SEI TIA JUP RENDER FET ONDO ENA PENGU HYPE TAO), GP_CHAIN +6, BLOCKSCOUT +4. 28/28 tests.
- **v15.3 Analytics (Cat 4)**: Intelligence Lab panels 8-11 — corr & lead-lag matrix (`pearson`/`leadLagBest` ±8 bars, watchlist series, labeled synthetic offline); meta-labeling gate (`metaLabelFit`/`metaLabelGate`, chronological 70/30, refuses <30 trades/<8 OOS, honest no-uplift verdicts) fed by `window._trades` + `indicatorsFor` features [side,ADX,RSI-50,ATR%,hour]; regime ribbon (POSTs DATA closes to `/svc/ml/regime`, accepts labels[]) + feature-store snapshot, honest offline states. 18/18 tests incl. known-answer lag-3.
- **v15.4 AI+Infra (Cat 7+8)**: `narrateConfluence` deterministic narration + `buildMorningBrief` (+ send-to-Telegram via `/svc/notify`) + `mtfVisionRead` (chart canvas → proxy LLM, hard-gated, honest no-key state) — three new AI Desk panels; Kraken+Coinbase chained failover after Binance→Bybit in `fetchKlines` (honest toasts, `_feedSrc`); **server**: `whale_loop` (Blockscout poll of `onchain_watch` wallets, `big_transfers` ≥min_usd → Telegram), `pair_scan_loop` (DexScreener latest, `onchain_seen` dedup, optional tg via `pair_scan_tg` config), OHLC cache `POST/GET /svc/data/ohlc` (SQLite PK upsert), threads started in __main__. 15/15 client + 14/14 service tests (flask test_client on SHIPPED module).
- Suite is now 15 files in `tests/run_tests.sh` — ALL GREEN at v16.0.

- v14.1 Frost visual set (T1 theme/T2 aurora/T3 surface/C2 candle skin). v14.2 REAL backtest robustness (MC bootstrap + PSR + real walk-forward, replaced a fabricated sweep). v14.3 forex diagnostics + demo guardrail toggle + 5 strategies + Meme Radar. v14.4 service+Vision-Desk fixes + On-Chain Desk (New-Launch Radar / Whale-Holder Tracker / Wallet Tracker). v14.5 Windows UTF-8 crash fix (proxy + service now start). **v14.6 Power Pack: Config Export/Import (Settings) · Signal Attribution (Confluence) · Backtest Explainer (Strategy Tester) · Wallet Watchlist + holder-change (On-Chain) · Session shading +Asia.** **v14.7 Overfitting Audit (Strategy Tester): real stop\u00d7target sweep (25 configs) \u2192 PBO via CSCV + Deflated Sharpe \u2014 the deferred companion to v14.2. v15.0 Seasonality / time-of-day edge finder (Strategy Tester): real trades bucketed by session & UTC hour, win-rate + Wilson-CI + avg/total R, honest small-sample dimming.**
- Tests present (all green): tests/test_analytics.py, test_terminal.js, test_frost_visual.js, test_robustness_stats.js, test_meme_radar.js, test_onchain.js, test_v146_power.js, **test_overfit_audit.js (18), test_seasonality.js (16), test_audit_integration.js (9, real end-to-end pipeline \u2014 no stubs)**. Extracted-shipped-source fixtures: tests/_meme_src.js, _onchain_src.js, _v146_src.js. New shipped fns: `cscvPBO`/`deflatedSharpe`/`expectedMaxSR`/`normInv`/`_combos`/`sweepStrategyConfigs`/`renderOverfitAudit` (audit) \u00b7 `wilson`/`sessionBucket`/`SESSION_ORDER`/`seasonalityStats`/`renderSeasonality` (seasonality). Both wired into `runBacktest` (main + N===0 paths); UI panels live under the Robustness panel in the Strategy Tester view (`#pboOut`, `#seasOut`).

## PENDING QUEUE — after v16.0 (honest deferrals with reasons)
- **C1 smooth render engine** + **C6 multi-pane indicator docks**: core canvas-loop surgery; a blind patch risks breaking the chart with no interactive browser to verify — do these in a session with browser testing.
- **Footprint / delta charts**: need a user-supplied order-flow feed (no free source).
- **Replay-with-signals overlay**: deferred (interactive-verification heavy).
- **Live verification pending user-side**: MTF vision read + LLM briefs need ANTHROPIC_API_KEY on the proxy; whale-flow/new-pair Telegram loops + dossier/holder live fetches need real network (sandbox can't reach DexScreener/GoPlus/Blockscout/Kraken/Coinbase) — logic + honest states are tested, live paths follow the proven v14.4 patterns.
- Earlier deferred, still open: N3 PatchTST benchmark lane · N4 model verdict card · S1 calibration table · TV2 Pine export · alert-panel→/svc/alerts sync · T4 typography · T5 focus dimming · U3 news chart markers · U5 weekly self-report.
## BOUNDARIES (won't build — stated to user, agreed)
No auto-execution of trades; nothing that holds/signs with wallet keys; no "guaranteed moon / guaranteed win" predictors (fabricated by nature). On-chain features are honest early-detection + risk screening; user acts himself.

## SERVER API (live-tested)
/svc/health /svc/alerts(GET/POST/DELETE) /svc/ledger(GET/POST) /svc/telegram /svc/notify /svc/events /svc/data/snapshot /svc/ml/predict /svc/ml/regime. Secrets in SQLite; nightly DB backups keep 7; schema_version=1 additive migrations. Proxy (8787): /health /providers /ohlc /quote. FRED needs env FRED_API_KEY; forex/stocks need the proxy running OR a Twelve Data key. Deps: `server/requirements.txt` (flask, flask-cors, requests, yfinance, scikit-learn, numpy) — launchers now auto-install.

## EXTERNAL DATA USED (browser-runtime, keyless, CORS-open; sandbox can't reach them so live fetches are user-verified)
DexScreener (token-boosts/latest, token-profiles/latest, latest/dex/tokens) · GoPlus (token_security/<chainId>) · Blockscout (<instance>/api/v2/addresses/<addr>/token-transfers). Chain maps: `GP_CHAIN` (EVM→numeric id), `BLOCKSCOUT` (chain→instance URL).

## USER: Nazrul — executes manually at MT5; tool is decision-support only. Prefers: feature list before build, rep-verify-deploy, no fabricated anything, full zip + standalone index.html delivery, unbranded outputs. Working dir: /home/claude/mishel_project/mishel-intelligence-trading. Original upload: mishel-intelligence-trading_2.zip.
