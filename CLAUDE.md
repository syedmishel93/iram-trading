# CLAUDE.md — standing instructions for this repository

Adapted from `fullstack-project-kit`. That kit is a blueprint for a **greenfield**
FastAPI + React project; this repository is a shipped desktop trading terminal
with 82,000 lines of TypeScript and a frozen predecessor. The kit's *process* is
adopted here almost wholly. Its *stack* is mostly rejected, and the rejections
are named below rather than left as silent drift — the kit's own deviation rule.

`docs/HANDOVER.md` is the running record of what was built and what it cost.
Read the most recent two entries before starting; they usually contain the trap
you are about to hit.

---

## The gate

```
python verify.py            # types, 4,135 frontend tests, 27 python test files
python verify.py --quick    # types + frontend tests only, while iterating
python verify.py --lint     # adds ruff and mypy, both BLOCKING
```

Seven stages, ~63s, every one blocking:

| stage | what it covers |
| --- | --- |
| `tsc --noEmit` | the whole frontend, types first - a type error makes test output meaningless rather than merely red |
| `vitest` | 174 files, 4,135 tests |
| `tests/ fully listed` | **fails if a `tests/test_*.py` is in neither list in `verify.py`** |
| `pytest` | the 6 real pytest modules |
| `21 scripts` | the standalone scripts, in parallel, 18s |
| `ruff (deferred set only)` | `server tests run.py verify.py` — fails on any rule outside the five deferred in `ruff.toml` |
| `mypy (gateway, run.py)` | `server/gateway` and the launcher, clean |

**The gate ran 3 of 22 Python test files** until this was fixed. The other 19
were not broken and not slow - they were simply not named anywhere, so breaking
one was free. That is why `tests/ fully listed` exists: fixing the lists once
does not fix the mechanism, and the next test file added would have been
invisible in exactly the same silent way.

**Not a Makefile**, though the kit specifies one: there is no `make` on the
development machine, and a gate only CI can run is a gate that drifts. Python is
already a hard requirement, so `verify.py` is the one runner guaranteed to work
wherever this project does.

Show its real output. "Tests pass" without the output does not count — the same
rule the kit states, for the reason `tests/run_tests.sh` records at the top of
itself: a Windows console encoding error once silenced eighty test files behind
an `&&` chain and the build looked green.

---

## One launcher

`python run.py`. Nothing else starts this product.

`run.sh`, `run.bat` and `run.command` are three-line wrappers whose only job is
finding an interpreter, because a shell script cannot be the single entry point
— Windows will not run a `.sh` from a double-click and `.bat` does not exist
off Windows. Every decision lives in `run.py`, once, so the three platforms
cannot drift apart. **Do not add a fourth launcher.** There were nine, and the
two that held real logic were both broken in the same way; the account is at the
top of `run.py` and under "What organising the project turned up".

It starts `server/gateway` as a SUBPROCESS rather than importing it, and that is
deliberate: importing would make this a third copy of "how to start uvicorn",
beside `gateway/__main__.py` and the frozen binary's `entry.py`.

It sets `IRAM_BACKGROUND=1`, which nothing did before, so the eleven service
loops actually run.

`server/entry.py` is the PACKAGED product's launcher and mirrors those
decisions rather than being a thinner version of them: loops on, browser opened
only once `/api/health` answers, an already-running instance reused instead of
dying on the bind. It is deliberately not shared code — `run.py` spawns
`python -m gateway` and `entry.py` runs the app in-process, because a bundle has
no interpreter to spawn — so the two have different bodies around the same
three decisions, stated in both. A binary that skipped them would be a worse
product than the checkout it was built from.

---

## Working style

1. **Measure before optimising, and put the numbers in the commit.** This is the
   house rule that has repeatedly overturned confident guesses. The chart's
   render path was assumed slow and measured at **zero long tasks**; the actual
   cost was 800ms to first paint with an empty `#root`. A dependency count of
   "21, too many to extract" was **13** once comment words were excluded.
2. **Strip comments and string literals before counting anything.** A grep over
   this codebase over-reports identifier usage by roughly a third, because the
   files carry long explanatory comments by design.
3. **Refuse rather than approximate.** A module that cannot answer honestly says
   so: `blocked`, `underpowered`, `one-market`, `thin`, `emptyReason`. Adding a
   metric means adding its refusal path in the same change.
4. **A bug fix starts with the failing test.** Several defects this session were
   invisible to `tsc` and to 3,151 tests — a clobbered CSS shorthand, a frozen
   signal binding, a `requestAnimationFrame` that never fires in a hidden tab.
   If a fix has no test, say so explicitly.
5. **No silent deviations** from this file or `docs/HANDOVER.md`. Name it,
   justify it in a paragraph, then do it.

---

## Hard rules

### Layering
- **Frontend:** `data/` → `chart/` `backtest/` `detect/` `scan/` → `ui/`.
  Lower layers never import from `ui/`. `data/` never imports from anything else.
- **Backend:** the gateway mounts three legacy Flask apps by prefix. It adapts;
  it does not reach into them. A mounted app never gets to declare how its bytes
  are framed — see `STRIPPED_HEADERS` in `server/gateway/wsgi.py`, which exists
  because a partial `Content-Length` broke every gzipped legacy route.
- One fact, one owner. The equity defect (two desks each holding a copy) is the
  canonical example; `core/account.ts` documents it.

### Types
- `tsc --noEmit` passes at all times. `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. No `any`.
- **Never retype a dependency's shape to narrow it.** A hand-written
  `{ find(): … }` stub satisfied a call site and then failed the real function
  twice this session. Import the real type.

### CSS
- `transition` is a **shorthand**: two rules cannot each contribute a property,
  the later one replaces it whole. A partial shorthand in a late-loading file is
  a silent subtraction. `styles/press.css` owns the complete set for the controls
  it touches, and says so.
- A zero-height grid track does not hide anything. `.commandbar` and `.newsbar`
  lift the blanket clip so their menus can escape, so collapsing the track needs
  `display: none` as well.
- Colour follows the **standing**, never the number. A sorted table always has a
  big number at the top, including on data with no edge in it.

### Motion
- Frequency decides whether it animates at all. Anything met hundreds of times a
  day — a keyboard action, a boot skeleton — does not animate.
- `transform` and `opacity` only. Press feedback is `translateY(0.5px)
  scale(0.985)` at `--dur-1`, declared once in `styles/press.css`.
- `prefers-reduced-motion` drops the movement and **keeps the acknowledgement**.
- `requestAnimationFrame` never fires in an uncomposited tab. Use
  `core/frame.ts` `scheduleFrame`, which falls back to a timer.

### Words on screen (v59)
- **One short line per fact; the reasoning goes behind "Why?".** The owner
  asked for the jargon to go, and the rule that came out of it is that
  shortening must MOVE detail, never delete it: a gate's `why`, `pkWhy(...)`
  for anything else. Three times in the v59 pass the first short version
  dropped a fact that mattered — the in-sample caveat on the replay, "the
  figures below are what-ifs", and "measured on the bars BEFORE it" — and a
  test caught each one. Read what a sentence was protecting before cutting it.
- Plain words over internal ones: "checks" not "gates", "no trade" not
  "stand down", "wider market" not "macro lane", "data coverage" not
  "evidence answered". Keep real trading terms (ATR, R, stop, spread).
- A short line still names its number and its limit. "A gate you cannot argue
  with is a gate you learn to switch off" — `evaluateGates` tests enforce it.
- A test that pins a SENTENCE should pin the fact in it. `full(g)` in
  `setup.test.ts` checks text + action + why together, so a fact can move
  behind "Why?" without the test pretending it vanished.

### Data honesty
- No fabricated data, ever. A failed feed is an honest empty state with a reason,
  never a synthesised candle.
- Any computed figure exposes its working: inputs, intermediates, named
  assumptions, and whether a value is measured or modelled. Never net different
  axes into one opaque score.
- An error message is addressed to the operator, not the developer. A JSON parse
  failure becomes "the news service is not answering on this address"; the raw
  text goes to the log. A status strip is not a console.

### File size
The kit's ≤300-line rule is adopted **as a direction, without the number** — the
kit itself says to split by responsibility rather than by line count, and these
files are deliberately comment-heavy (`backtest/resample.ts` is roughly half
prose). What the rule is right about is that this repository has genuine
offenders, and the current worst are recorded under Known backlog.

Extraction procedure, which is now proven:
0. **Check the section marker before trusting it.** The `palette` heading covered
   the palette *and* four topbar/workspace accessors, so a measurement of that
   section reported five exports for a thing that has one. Moving the heading was
   a one-line change that made every later number about it true. A boundary that
   lies makes the whole procedure lie.
1. Strip comments and strings, **then** compute the dependency set.
2. Split into foundation (already in `ShellContext`) and siblings (explicit
   parameters). **If the sibling list exceeds about ten, do not extract — fix
   the coupling first.**
3. Move the text programmatically; return only what callers actually read and let
   the compiler find the rest.
4. **Let the return type be inferred, and derive sibling types.** A hand-written
   return type was rejected by the compiler on the first attempt; a hand-written
   sibling type has now caused three defects. `ReturnType<typeof createXSection>["y"]`
   cannot drift, because there is only one definition and it is a reference to it.

---

## What is deliberately NOT taken from the kit

| Kit says | Here | Why |
|---|---|---|
| React + TanStack Query + Zustand + shadcn/ui | hand-written signals (`core/signal.ts`) + canvas | Evaluated and rejected on measurement: the render path shows **zero long tasks** under pan, zoom and live ticking. Adopting the kit's stack is an 82,000-line rewrite for no measured gain. |
| PostgreSQL + Redis + docker-compose | SQLite by default; **PostgreSQL optional since v59** via `IRAM_DB_URL`; a versioned KV store in the browser | The reason for the original rejection still holds and is why Postgres is an OPTION and not a replacement: the product is a single executable that needs no install, and requiring a server to start it is a regression against its main advantage. `server/db/driver.py` states the deviation in full. Redis is still rejected outright — nothing here needs a second datastore. |
| Alembic migrations | versioned slots in `store/kv.ts` | No SQLAlchemy here. The guarantee is the same and it is enforced — `PREFS_SLOT` v1→v2 ships a real migration. |
| Types generated from OpenAPI | hand-written clients in `data/` | The frontend mostly talks to legacy Flask routes that have no schema. **This is the one rejection with real risk attached** — see Known backlog. |
| Makefile as the single gate | `verify.py` | No `make` on the machine. |
| Coverage ≥ 90% on services | 3,595 tests, no coverage number | The gate is honest tests, not a percentage. Measuring it is worth doing; see Known backlog. |

---

## Known backlog

Recorded so it is a decision rather than an oversight.

- **16 of 96 backend routes are never called by the frontend, and NONE of them
  is capability without a screen.** Re-measured in v62.20 by
  `scratchpad/routes.py`, which walks every `@bp.get/@bp.post` under `server/`
  and greps `app/src` for each path. Run the script rather than quoting the
  number. (It EXCLUDES `server/build/venv`: its first run walked 7,789 files and
  reported FastAPI's own docstring examples, `/items/` and `/users/me`, as
  uncalled routes of this product.)

  | why it is uncalled | routes |
  | --- | --- |
  | **Not a fetch target.** The browser is SERVED these, or a human reads them with curl. | `GET /`, `GET /legacy`, `GET /api/routes`, `GET /quant/endpoints`, `GET /svc/mcp/callback` (an authorization server redirects the OPERATOR'S BROWSER here after a sign-in; it returns a PAGE, and a fetch of it would mean the flow had gone wrong) |
  | **Deliberately dead**, recorded above. | `GET/POST /svc/data/ohlc`, `GET /svc/data/series`, `GET /svc/data/errors` |
  | **SUPERSEDED.** `/svc/ledger` is the claims ledger's crude predecessor: it scores a signal's SIGN against a yfinance close at +1h/+4h. `/svc/claims` grades a stated claim with levels against real bars — 2,101 recorded, 425 decided, with an interval on every rate and a calibration curve. Wiring the older one would be a second, worse owner for "did the machine's read work out". `ledger_loop` therefore has no writer for its input and never will; it costs one query per cycle against an empty table. | `GET/POST /svc/ledger` |
  | **The store is empty**, so a screen would show nothing until something fills it. Wire the WRITER first. | `GET /svc/onchain/leaderboard` |
  | **Destructive or administrative**, deliberately not one click away. `/svc/store/evict` deletes gigabytes and defaults to `dry_run`. | `POST /svc/store/evict`, `POST /svc/mt5/import` |
  | **A DUPLICATE of a route that already has a screen.** `/svc/auto/subjects` returns byte-identical data to `ready.subjects` inside `/svc/auto/state`, which the Simulation desk renders. Wiring it would be one fact with two owners. | `GET /svc/auto/subjects` |
  | **Optional, and gated on a credential the OPERATOR supplies.** `/ai` refuses without `ANTHROPIC_API_KEY` and says so; the Analyst desk runs a built-in local analyst by design. | `POST /ai` |

  `/svc/edge/kinds` came off this list in v62.23 by being FILLED: its writer
  existed and had never been called. That is what this row means — check that
  anything can PUT data there before filing an empty store under "later".

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

- **THE COST MODEL, ITEMISED — AND THE COUNT WAS WRONG.** A COST MODEL IS A
  HURDLE, so an assumed cost is an assumed conclusion: measured against this
  operator's broker the flat 2bp spread is **4.8x** the real one on gold and
  3.8x on EURUSD. This started as "eight places charge `DEFAULT_COSTS`", which
  was a grep count rather than a reading — and this file's own rule is that when
  a count has to be qualified every time it is quoted, you replace the count with
  the list. Read one by one:

  | where | what it decides | state |
  | --- | --- | --- |
  | `backtest/headless.ts` | **the autonomous 85-rule search** | FIXED v63.15 — `opts.costs`, default unchanged, result states which |
  | `ui/survey.ts` + `backtest/survey.ts` | **ranks markets against each other** | FIXED v63.16 — `costsFor` per market, plus a desk toggle |
  | `backtest/spectest.ts` | **what gets promoted** | FIXED v63.17 — `opts.costs`, and its benchmark now prices the same way |
  | `ui/playbook.ts` | one rule, one market | can charge the broker's measured spread (v63.9) |
  | `ui/strategy.ts` | the sweep | already had an editable cost control |
  | `ui/shell.ts` | a search started from the inspector | **NOT A DEFECT.** A deliberate default, and `discovered.costs` records which model was charged — `sweepdriver` also hashes it into the cache key, so a changed hurdle MISSES rather than serving a conclusion nobody reached |
  | `ui/research/steered.ts` | nothing | **NOT A CHARGING SITE.** Display text only; it states the assumption and the direction of the error |
  | `study/steps.ts` | a study's rule tests | FIXED v63.19 — `CostModel` widened to `standard` / `measured` / `none`, wired picker -> spec -> runner -> step -> `studyCosts`, which falls back to the ASSUMPTION on every path that cannot answer |

  So FOUR were real and all four are fixed, three were correct as written. Every
  hardcoded cost that fed a decision is now sayable, and none of their defaults
  moved. **Do not flip a hardcoded cost without saying so on the screen
  that shows the result**, and do not let the measured figure silently replace the
  assumption — a number that moves under the operator because a service answered
  is worse than a disagreement they can see.

- **There is no execution path.** `grep` for `order_send` across `server/`
  returns nothing: the MT5 bridge reads account, positions, deals, ticks and
  symbol info, and cannot place, modify or close an order. Authorised by the
  owner in v58 and not yet built.

- **`server/mishel_service.py` is DONE: 1,792 -> 414 lines**, a facade over
  `server/db/` and nine modules in `server/svc/`, one per use case. The map is
  `server/svc/README.md` — open that, then the one file it names. Verified
  three ways: the 53-route table is IDENTICAL before and after (method +
  path, diffed), all eleven loops resolve by `getattr` and were seen turning
  on a live boot, and the full gate passes.

  **It must stay a FACADE.** `gateway/background.py` resolves all eleven loops
  with `getattr(mishel_service, name)`, and the test scripts reach for
  `svc.app`, `svc.db`, `svc.store_deals`, `svc.flow_state`. A new module needs
  its names re-exported there and its path in `HIDDEN` in `build_binary.py`
  — the second is now enforced by `tests/test_build_hidden_imports.py`.

  Left in the facade on purpose: `backup_loop` copies the SQLite FILE and is
  meaningless under Postgres, so it needs rethinking rather than moving; and
  the forward-test ledger is ~45 lines, below the size where a file buys
  anything but a jump.

- **`ui/shell.ts` is 5,217 lines**, down from 6,649 in v59; `mountShell`
  holds **218 declarations at depth 1**, down from 234. Still the largest file
  in the frontend. Lifted in v59, each verified live in the browser:

  | module | lines | siblings | what it is |
  | --- | --- | --- | --- |
  | `ui/model/setup.ts` | 850 | 17 | the Setup card's view — **named deviation**, see its header |
  | `ui/shell/desks.ts` | 325 | 5 | eleven desks + the agent desk |
  | `ui/shell/dockverdict.ts` | 196 | 4 | the verdict pinned above the dock |
  | `ui/model/readings.ts` | 165 | 4 | the live bar's readings |
  | `ui/model/live.ts` | 122 | 6 | live analysis: what CHANGED |
  | `ui/model/outlook.ts` | 92 | 3 | outlook, odds, track record |
  | `ui/model/studies.ts` | 60 | 0 | RSI/ATR with provenance — one TYPE for three readers |

  Earlier seams: decision 649, palette 224, command bar 224, risk 171,
  workspace 170, and v56's `ui/model/` (structure, analyst, intel).

  **What is left is wiring, and the rule refuses it correctly.** Measured with
  `scratchpad/deps.py` (comments and strings stripped, destructuring and
  spreads counted):

  | region | lines | siblings | why it stays |
  | --- | --- | --- | --- |
  | dock DOM | ~715 | ~30 | assembles every panel; reads everything by design |
  | top bar | 530 | 37 | settings desk + menus over most of the shell's state |
  | chart lifecycle | 455 | 29 | the chart engine's effects |
  | live bar call | 411 | 34 | one options object over the whole shell |
  | main DOM | 355 | 40 | mounts every desk |
  | commands | 307 | 37 | the command table IS a list of everything |
  | chrome | 504 | 15 | not a section: where shared state is DECLARED (34 exports) |

  Moving any of these relocates its coupling into a signature, which is what
  the rule exists to stop. The next real reduction is a SHAPE change again —
  most plausibly giving the shell's shared state (the "chrome" block) an
  owner object, so that DOM sections take one dependency instead of thirty.
  The setup model is the one deliberate exception, argued in its header:
  an aggregator's inputs are its specification, all seventeen are read-only,
  and the move turned seventeen implicit reads into a typed list.

  **Use `scratchpad/deps.py`, not `extract.py`.** `extract.py` misses
  destructured declarations (it reported 202 declarations; there were 234).
  `deps.py` counts them, including multi-line ones, and a v59 fix makes it
  count SPREAD reads — `...workspaceSeries()` was being read as a member
  access and dropped. Both errors under-report, silently.

  Sections under ~40 lines (catalogue, fundamentals, keyboard, drawings, dock
  resize) are deliberately **left in place**: a 12-line file buys an import and
  a jump, not modularity.

- **No CI.** `verify.py` is the gate but nothing runs it automatically, and
  **there is no git repository here** (`.gitignore` exists; `.git` does not), so
  a workflow file would be inert. `git init` first.
- **Lint: 305 -> 185, and the 185 are exactly five rules.** See `ruff.toml`,
  which states which rule is deferred and why. `--lint` gates on the rule NAME,
  not a count: the five may print freely, any sixth code fails the build. Ruff's
  defaults found a real timezone bug, a blocking read in the event loop and
  eight implicit string concatenations; a hand-picked `select` would have found
  none of them.
- **The Python floor is 3.12**, discovered by ruff rejecting `py311`:
  `mishel_service.py` puts backslash escapes inside f-strings, which is a
  SyntaxError before 3.12. Nothing said so before `ruff.toml` did.
- **The service is untyped**, like every flat `mishel_*` module — which is
  why mypy is scoped to `server/gateway`. The v59 split into `server/svc/`
  makes typing it module by module possible; nothing has been typed yet.
- **Every `:hover` rule is gated** behind `@media (hover: hover)` since
  v53.1 (72 rules). A new one must be too, or it sticks after a tap on
  touch. Mixed lists (`.x:hover, .x:focus-visible`) are split so the
  keyboard state is never gated with the pointer one.
- **No API contract test.** Nothing catches a legacy Flask route changing shape
  under a hand-written client in `data/`. The kit's generated-types rule is the
  right instinct; a contract test on the handful of endpoints that matter would
  buy most of it without an OpenAPI spec the legacy services do not have.
- **The packaged binary's Quant desk has 6 of 19 libraries, and 11 capabilities
  degraded.** `statsmodels` and `arch` were added to `FULL_DEPS` because each
  restores a whole card with no exotic dependency of its own — ADF/KPSS
  stationarity and GARCH/GJR volatility — and both were verified RUNNING in the
  frozen build rather than merely present: ADF p=0.7597, KPSS p=0.01 in 35ms,
  and GJR beating the EWMA by 5.8% on QLIKE over 320 scored bars. Cost: 82 MB
  to 90 MB. The remaining eleven stay out on size, with the reasoning per
  package rather than as a blanket rule — `torch` is roughly 200 MB frozen for
  one neural cross-check, `darts` drags in torch and lightgbm, `prophet`
  carries a Stan binary, `biogeme` and `causalml` need a C++ toolchain at
  install time. The desk greys those cards out and names the missing package.
  `CORE_EXCLUDES` gained both names too: the build venv is SHARED between
  profiles, so a core build after a full build would otherwise start carrying
  60 MB of models it has no numpy to run — the yfinance trap exactly.
- **No coverage number** on 3,618 tests.
- **77 `tests/*.js` files are outside every gate, on purpose.** 57 of them read
  `../index.html` - the frozen v39 terminal. Frozen code cannot regress, so
  running them on every change costs a minute and buys nothing. They are kept
  runnable by `tests/run_tests.sh`; run that when the legacy terminal is
  touched. Stated in `verify.py` beside the glob that excludes them, because an
  unexplained exclusion is how the 19 Python files went missing.

---

## What organising the project turned up

Kept because each one is a class, not an incident.

- **Every TwelveData and AlphaVantage bar was in the wrong place.** Parsed with
  `strptime(...).timestamp()`, and `.timestamp()` reads a NAIVE datetime as
  **local** time - so every bar was displaced by the server's own UTC offset.
  Two hours on this machine, a different number elsewhere, a different number
  again after daylight saving. Nothing failed; the chart drew the right candles
  in the wrong places, which for a session-aware terminal is the worst available
  outcome. Nothing tested `ddt_data_server.py` at all, which is how it survived.
  `tests/test_data_proxy_time.py` now fails 5 of 6 without the fix. The zone is
  **per provider and per endpoint** - see the note above `p_twelvedata`.
- **Four test files wrote to the operator's live `server/mishel.db`.** Measured
  by hashing every table before and after: each run advanced `sqlite_sequence`
  for `wallet_events` and `onchain_watch` and replaced the single
  `kv.client_backup` row - the browser's settings backup - with a fixture
  (`0xabc`, tier S). Their siblings v35.0/v36.0/v37.0 all set `MISHEL_SVC_DB`;
  these four never got the line. Fixed in the four files, with `verify.py`
  setting it for the whole stage as a belt.
- **A test that could never pass in any gate.** `test_service_v392_loops.py`
  patched `time.sleep` to compress a 120s wait and left `time.time` real - so
  `sleep_ticking`'s deadline stayed 120 real seconds while each slice shrank to
  10ms, and the loop spun ~12,000 times instead of six. It was slower than the
  thing it measures. A fake clock moves both halves: 120s -> **1.0s**.
- **A 1.1 MB synchronous read inside an `async def`** (`gateway/terminal.py`),
  blocking every other request including the SSE feeds the page it serves is
  about to open. Now `run_in_threadpool`.
- **`ruff --fix` needs a proof, not a gate pass.** 90 mechanical fixes touched
  47 files, including "unused" imports that could have been re-exports or
  side-effect imports no test reaches. The check that mattered was importing all
  36 backend modules: 36/36 clean. Only 4 were genuine deletions, all with zero
  references.
- **A linter's "fix" can be the bug.** Four `PLR0124` findings were `x == x` and
  `f != f` - the NaN test. Suppressed with the reason on the line; "fixing" them
  stops NaN bars being dropped.
- **Two `B023` closures were checked, not assumed.** In both, every call happens
  inside the same iteration that defines what is captured, so the late binding
  cannot occur. Narrow `# noqa`, so the rule keeps watching for one that escapes.
- **The entire Quant desk was dead, from a missing `()`.**
  `data/quant.ts` exported `QUANT_BASE = (): string => quantBase()` and every
  call site read `fetch(`${QUANT_BASE}${path}`)`. A template literal stringifies
  a FUNCTION BY ITS SOURCE, so every request went to the literal path
  `() => quantBase()/quant/health`. MEASURED in the shipped bundle: `el=()=>kf()`,
  resolving to `http://127.0.0.1:8787/()%20=%3E%20kf()/quant/health` — **404**,
  which is exactly the red `HTTP 404` an operator saw on a service that was up,
  healthy and reporting all nineteen libraries present. `tsc` cannot catch it:
  interpolating a function into a template is legal TypeScript. The fix is a
  shape, not a patch — `quantUrl(path)` joins the base, so no bare base is left
  in the module to interpolate.
- **A test that compared the bug to itself.** The one assertion that touched the
  address was `expect(r.reason).toContain(QUANT_BASE)` — and the reason had been
  built by the same interpolation, so both sides were the same stringified
  function source and it PASSED. **An expected value taken from the code under
  test cannot fail.** The replacement asserts the URL `fetch` was actually
  called with, parsed: `new URL(seen[0]).pathname === "/quant/stats/structure"`.
  Proved to fail 2 of 3 with the defect reinstated.
- **Nine launchers, and the two that mattered started a layout the frontend can
  no longer talk to.** `run.py` and `start_mishel.py` both started the
  pre-consolidation three services on :8787/:8788/:8789 and served the terminal
  on :8000. A page on :8000 has no `iram-backend` marker, so `backend.ts` falls
  back to its shipped default of :8787 FOR ALL THREE SERVICES — and :8787 in
  that layout is the data proxy, which answers `/svc/*` and `/quant/*` with its
  own Flask HTML 404. That is precisely the news bar reading "the news service is
  not answering on this address", which is what `rss.ts` prints when `res.json()`
  chokes on the `<` of an HTML body. **Both services were running and healthy the
  whole time.** Nine entry points are now four, one of which has any logic.
- **The eleven service loops had not run since consolidation.**
  `gateway/background.py` says they need `IRAM_BACKGROUND=1` and credits
  `start_mishel.py` with setting it. `start_mishel.py` started three separate
  processes and never went near the flag, and no other launcher set it either.
  Measured: `/api/health` reported `background: {enabled: false}` — alerts,
  backups, the ledger resolver and the dead-man's-switch heartbeat, all silent.
  `run.py` sets it; `/api/health` now reports **11 of 11 turning**, each with its
  last tick age. A comment naming the component that is supposed to do something
  is not evidence that anything does it.
- **`run.py` was the largest module outside every gate.** The most user-facing
  Python in the repository — the file a first run executes — was linted by
  nothing and type-checked by nothing, which is the same mechanism that hid
  nineteen test files: a path in no list is a path nobody checks. Adding it to
  `LINT_TARGETS` immediately found a REDUNDANT SECOND RUFF PASS inside
  `verify.py`'s own lint stage, whose `ok` and `tail` were both discarded — two
  full lint runs for one answer, in the file whose whole job is checking things.
- **The packaged binary threw its database away on every close.**
  `mishel_service.py` resolves `DB` as `os.path.dirname(__file__)/mishel.db`,
  and inside a one-file PyInstaller bundle `__file__` is under `sys._MEIPASS` —
  the extraction directory, deleted when the process exits. Measured by running
  the shipped `iram-full.exe` and searching for the file:
  `%TEMP%/_MEI0000268c2/mishel.db`, **139,264 bytes**, gone with the process.
  So every run of the product people download started with an empty database:
  no alerts, no journal, no ledger, no settings backup, and nothing on screen
  saying so. A checkout never saw it, because there `__file__` IS `server/`.
  `entry.py` now sets `MISHEL_SVC_DB` to the platform's per-user data directory
  before the service imports, and PRINTS the path — state whose location is a
  mystery is the next version of this bug.
- **A re-exported name is a SECOND binding, and patching it patches nothing.**
  A test monkey-patched `mishel_service.tick` and asserted `sleep_ticking`
  called it. Both had lived in that module, so it worked. After `sleep_ticking`
  moved to `svc/core.py` it resolved `tick` in ITS module, the patched
  re-export was never consulted, and the test counted zero. It failed loudly,
  which was luck — the same mistake in production code is a monkey-patch that
  silently does nothing. **Patch the module that owns a function, not the one
  that re-exports it.**
- **A path bootstrap must sit above EVERY import it exists for.** The
  `sys.path.insert` that makes `mishel_service` loadable by file path sat
  between its two local imports. Extracting a second package put the new import
  above it, and every path-loaded test died. A bootstrap that covers some of
  its dependents is a bootstrap that will be wrong the next time one is added.
- **A section heading that lies makes every measurement of it lie.** Three
  more found in v59's shell pass, all the same shape — a comment left behind
  when the code it described moved: "Built once and reused: a scan is
  expensive" sat above the Flow desk (the scanner had gone to
  `shell/decision.ts`); "Ticks once a second" sat above the live bar's
  readings (the timer had moved beside `nowMs`); and the dock verdict's whole
  doc comment sat above `fmtPx`, a one-line formatter, with 87 lines of live
  analysis between it and the element it described. Step 0 of the extraction
  procedure caught all three. A moved block's comment moves WITH it.
- **One value, three hand-written types, one of them `any`.** `studies` was
  an inferred computed with no named type, so each consumer wrote its own:
  `ui/shell/risk.ts` narrowed it, `terminalaccess.ts` declared it `any`. Lifting
  the body into `readStudies()` gave it `Studies = ReturnType<typeof
  readStudies>`, and all three now derive it. v60 did the same for `decision`,
  `fundamentals`, `composeChart` and `loadArchiveCloses` — and the first real
  type found a live defect `any` had hidden: the shell passed
  `composeChart: () => composeChart`, so the analyst's `see_chart` received a
  FUNCTION and threw `out.toDataURL is not a function` on every call.
  `AccessDeps` still has thirteen `any` fields (`state`, `feed`, `riskDesk`, …).
- **A bar that measures itself must not be sized by what it is showing.**
  The workspace bar decides which tabs fit by reading its own width, and with
  `flex-basis: auto` that width was the width of the tabs NOT yet hidden — so
  once two spilled it shrank to three, the search field grew into the room,
  and every later measurement agreed two did not fit. A stable wrong state
  (1024px: 349px allotted for 435). Two more in the same function: the fit
  test summed the tabs and ignored the gaps between them (so it said "fits"
  with the last tab clipped), and it observed only the bar, whose width no
  longer changes when the tabs grow as the web font arrives. The basis is now
  the measured need, gaps included, set by `ui/deskbar.ts`; the tabs are
  observed; and the window resize is a backup trigger. Check CLIPPING, not
  just "what spilled" — nothing in "More" and a cut-off tab looked identical in
  every number except the tab's right edge.
- **The preview's phone emulation (<768px) does not fire `resize` or
  `ResizeObserver` when switched into.** A layout that looked broken at 760px
  was correct on a fresh load at 760px and after a real `resize` event. Load
  fresh at the size before believing a narrow-width result.
- **A test placed after an unconditional `sys.exit` has never run.**
  `test_service_v240.py` printed its summary and exited, and the v24.1
  "unwatch disables tracking" check sat below that line for thirty-five
  versions. Found only because the split made the file worth reading. It runs
  now, and passes — which it could have failed at any point without anyone
  knowing.
- **A test that reads SOURCE TEXT loses coverage silently when code moves.**
  Four tests grep `mishel_service.py` for a string. After a split, two of them
  failed (good), but `test_db_rewrite.py`'s "every upsert has a conflict key"
  would have gone on PASSING while checking fewer and fewer call sites, until
  it checked none. It now reads the facade and every module under `svc/`.
- **Absence of errors is not evidence of success when the checker can fail to
  start.** An import-pruning script shelled out to `npx tsc`, parsed stdout for
  errors, found none and printed "clean" — because the compiler had not run and
  returned an empty string. It had already deleted `import {` from a multi-line
  clause, so the file was a SYNTAX ERROR at the moment it declared itself done.
  Check the return code, and refuse to act when the tool's output is empty in a
  way that could mean either "fine" or "never ran". Same shape as the Windows
  console encoding error that once silenced eighty test files behind an `&&`.
- **A shell-quoted heredoc turns `\b` into a backspace.** Two regexes in a new
  test arrived as `UNIQUE\x08` and matched nothing, making a perfectly correct
  table look broken. Third time this session. **Write Python to a FILE and run
  the file** — `python - <<'PY'` is safe for plain text and is not safe for
  anything containing backslash escapes.
- **The primary key is not always the conflict target.** A table with a
  surrogate `id INTEGER PRIMARY KEY AUTOINCREMENT` and a natural `UNIQUE`
  column conflicts on the UNIQUE one; the id is freshly generated and can never
  collide. An upsert aimed at the primary key there never fires and inserts a
  duplicate per attempt — silently. Caught by a test that compared the
  rewriter's key map against the real DDL on its first run, which is the only
  reason the map is now called `CONFLICT_KEYS`.
- **A UNIT that defaults is a wrong answer with no symptom.** `portfolioHeat`
  multiplies by `contractSize` and defaults it to 1. MT5 reports position size
  in LOTS, and one lot of EURUSD is 100,000 units — so a 20-pip stop on one
  lot is $200 of risk and would have been computed as $0.002. A risk desk
  reporting a flat book on a fully loaded account, with total confidence, and
  nothing on screen to suggest it. The rule that came out of it: a row whose
  unit is not KNOWN is excluded and the total is labelled a FLOOR, never
  counted at the default. Same class as the v47 pip-value bug, and the reason
  every new broker field gets asked "in what unit" before it is used.
- **Zero is a value; absence is not.** MT5 reports "no stop" as the NUMBER
  ZERO. Read as a price it makes the stop distance the entire entry price — a
  position that reports as risking its whole notional, or, with the sign the
  other way, as perfectly protected. One function (`hasStop`) knows it, and
  every conversion goes through that function rather than comparing `sl > 0`
  in four files.
- **Wiring a new source means finding EVERY consumer, and the desk that owns
  the subject is the one most easily missed.** Connecting the broker updated
  the command bar, the Briefing and the shell's heat — and left the RISK
  desk's own metrics reading the hand-entered rows, so the desk whose entire
  job is risk would have disagreed with the chip six inches above it. `tsc`
  cannot see it and no test covered it; it was caught by opening the desk.
  Grep for every read of the old source before declaring a seam replaced.
- **A verdict read out of the wrong collection is a verdict that is never
  shown.** The Analyse desk's method cards asked the PLAN whether each method
  could run, and the plan contains only the methods already SELECTED. So every
  unselected card rendered available: fifteen of them, on a study whose one
  Driver had loaded no bars, and the only way to learn that a method could not
  run was to click it. Nothing failed, nothing was red, and `tsc` cannot see it
  - `map.get()` returning `undefined` is a legal answer. The fix is a shape:
  one exported `stepAvailability` that the card and the plan both call, so they
  cannot disagree. The tests that catch it are the ones asked with an EMPTY
  selection, which is exactly the state the plan cannot answer for.
- **A correction in the wrong units is worse than no correction, because it
  looks like one.** The deflated Sharpe was computed from `metrics.ts`'s
  ANNUALISED figure - multiplied by sqrt(barsPerYear) - using
  `sqrt((1 + S^2/2) / n)`, which is the standard error of a PER-OBSERVATION
  Sharpe, with `n` set to a TRADE count. Three incompatible quantities in one
  expression, every one of them a plausible number. MEASURED on a live BTCUSDT
  study: an annualised 4.93 over 77 trades deflated by 0.85 and printed as
  though the search had been paid for. Deflating the rule's per-trade Sharpe
  instead - the quantity the deflated Sharpe ratio is defined on - took the
  same study to 0.15 -> -0.07. **Check the units of every input to a
  statistical correction, and make the function state which units it wants.**
- **A failure that is skipped is a failure that is not subtracted.** A study's
  series fetch returns null per series so one dead vendor cannot abandon the
  other five - right, and it left the joint window computed over whatever
  survived while the panel reported the full span. The table showed each dead
  row in red and the WINDOW said nothing, which is the number somebody writes
  down. Anything that tolerates a partial failure has to name what it lost
  everywhere it reports a total.
- **A closed panel with no trace on screen is a lost panel.** The inspector
  dock's track collapsed to zero, so the only routes back were the `B` key and a
  22px toolbar icon — and `shell.ts` had already written down the risk in its
  own comment: "a toolbar icon most people never find standing between the user
  and their layout". It stopped being hypothetical when the product's owner
  asked twice where the panel had gone, reading closed as GONE. Both routes
  worked, verified with a real keypress (360px -> 0 -> 360px) and the icon
  round-tripping the preference; the mechanism was never the problem. **A
  working shortcut does not fix a screen that shows no evidence the thing
  exists.** Closed is now a full-height 22px rail carrying the word Inspector,
  which reopens the dock through `dockToggle` — so reopening from it persists as
  a DECISION, like the icon and the key. Off below the 1100px breakpoint and in
  full focus, where the track really is zero. **No automated test:** nothing
  unit-tests `mountShell`, and this was verified in the browser across all
  three states instead.
- **A media query adds no specificity, and knowing that is not the same as
  applying it twice.** The closed dock's rail is hidden below the 1100px
  breakpoint by `.shell[data-dock="closed"] .dock-rail { display: none }`
  INSIDE the media query — written at matching specificity on purpose, and
  v51.9's entry recorded catching that trap. One line above it, the rule meant
  to collapse the 22px track was `.shell { grid-template-columns: ... 0 }`
  (0,1,0), which cannot beat `.shell[data-dock="closed"]` (0,2,1) outside the
  query. MEASURED at 1000px with the dock closed: rail `display: none`, track
  still **22px**. So the chart gave up 22px to hold an invisible element, on
  exactly the screens with the least to spare — for one release, in the same
  change that got the sibling rule right. **Fixing the instance you are looking
  at is not fixing the class.** Both lines now carry the attribute.
- **A ResizeObserver watches an element's own BOX.** The inspector's summary
  line reported scroll depth in screens and was frozen: it read "1.2 screens
  of scroll" while `scrollHeight / clientHeight` on the same element in the
  same frame was **3.4**. The RO was on `.dock-body`, whose box never changes;
  what grows is the CONTENT, when the Setup card fills in asynchronously.
  Deleted rather than repaired, because the figure was a DUPLICATE — the dock
  body has a real 10px scrollbar and a thumb IS that ratio, drawn by the
  browser and always correct. Keeping a text copy meant observing ten panels
  to restate something already on screen. **And no test could have caught it:**
  every argument was passed in, so the function was right for its inputs and
  its seven tests passed; the staleness lived in the caller, in a DOM
  measurement no unit test observes. A readout whose honesty depends on
  something untestable will be wrong again.
- **A hardcoded duration cannot be re-pointed, so it cannot honour reduced
  motion.** `transition: transform 120ms ease` appeared twice — the dock's
  disclosure caret and the Setup card's evidence caret — and those were the
  inspector's only two animations. `tokens.css` sends every `--dur-*` to 0ms
  under `prefers-reduced-motion`; a literal never sees it. Both glyphs turned
  for the people who had asked the whole terminal to stop moving. Grep for
  `[0-9]ms` outside `tokens.css` before believing a reduced-motion claim.
- **"Quieter" is a claim about the palette, so check the palette.** Shut
  inspector rows were set to `--text-muted` to quieten them against the open
  cards. Every panel title in the dock inherited `--text-faint` (86,96,114),
  the DIMMEST text role — so the change made the shut rows brighter than the
  cards they were meant to defer to. Caught by measuring the computed colour,
  not by looking at it. `--text-faint` < `--text-muted` < `--text`.
- **A sibling selector cannot express adjacency in a container that applies
  CSS `order`.** The inspector's shut rows sit 4px apart and its open cards
  12-20px, and the obvious way to write that is `.panel + .panel`. `.dock-body`
  applies visual order through the `order` property, so DOM order runs
  setup(0), fundamentals(8), cursor(1), context(7), news(9), regime(2)… and
  `+` would have collapsed the space between two panels nowhere near each
  other on screen. Margins belong to the element and travel with it.
- **The frame around the chart was three sides of one plane and a darker
  fourth.** `.topbar`, `.dock` and `.livebar` were `--surface`; `.commandbar`
  alone was `--surface-inset` — so the most recessed band on screen was the
  one carrying the brand, the desk switcher and the palette. The same
  inversion existed geometrically: `--h-topbar` was 48px against
  `--h-cmdbar` 42, held up by one control (the symbol box at `--h-ctl-lg`)
  when every other input in the terminal is 32. Both fixed; six pixels back to
  the chart. And the two rows' edges were four pixels apart in both
  directions — first control at x=8 and x=12, last at 1592 and 1588 — which is
  a zig-zag nothing can point at and everything reads as loose.
- **`press.css`'s audit missed two controls, and one of them is six buttons in
  the top row.** `.tool-btn` (the detector, studies, Replay, Live edge, Reload,
  export, plus the whole chart toolbar) sat directly beside `.tf-btn` and
  `.seg-btn`, which both answer a press, so the row answered on one button and
  ignored the next. `.omnibox` had none either — and it is in the transition
  list only, answering in COLOUR rather than scale: the file chose 0.985 to
  avoid "visible movement on a wide one", and 1.5% of 460px is seven pixels.
  A press list is a list; the next control added will not be on it either
  unless adding it is part of adding the control.
- **`.status` is dead CSS.** `.livebar` takes `grid-area: status`; only
  `.status-item` and `.status-spacer` are live, as ITS children. Left in place
  (deleting a container whose child classes are in use is its own change) but
  matched to the frame's surface, so reviving it cannot reintroduce the
  odd-one-out above.
- **A count of what has REPORTED is not a count of what EXISTS.**
  `/svc/health` builds `loops` from `LOOP_TICK`, which a loop enters on its
  first tick — so with the background off it is `{}`, and a status strip
  reading "0 of 0 running" rendered it green as "all running". Same class as
  a failed request read as zero: "nothing armed" and "could not ask" are
  different facts. Found by reading the server route before writing the
  fixture, not after.
- **A control added to a full row takes its width from whatever flexes.**
  In the command bar that is the deskbar: three new controls sent two
  workspaces into "More" at 1440, and at 375 took the deskbar to 0px with
  NOTHING spilled — navigation gone without a trace. What yields, in what
  order, is now written once above the rules in `styles/shell.css`; a new
  control in that row has to find its place in that list.
- **`isConnected` is not "on screen".** Every inspector card is built once
  and kept, so a card removed from the column, or in a shut inspector, is
  still connected — hidden by an attribute or a `display: none` ancestor. The
  v59.2 cards first polled on `isConnected` and kept asking their services
  from behind a closed panel; one fetched Binance. `ui/cards/shown.ts`
  (`getClientRects().length > 0`) is the guard, and `onShown` refreshes a
  card the moment it comes back.
- **Wrapping an element moves every `>` selector and every `sticky` aimed at
  it.** Putting `.panel-head` inside a new `.card-head` silently unmatched
  eight `.panel > .panel-head` rules and left the sticky header sticking
  within its 32px wrapper. Grep for `> .x` and `position: sticky` on the
  element before wrapping it.
- **An estimated height is a measurement that has stopped being checked.**
  The dock's `approxHeight` budget had drifted by 100px+ on several cards
  (feed 520 vs a measured 1,006). Re-measure in the browser when the budget
  test moves, and never tune a guess to make the test pass.
- **A ResizeObserver delivers nothing in a BACKGROUND TAB, so a layout that
  depends on one cannot be measured there.** The chart toolbar's fit loop
  (`FIT_STEPS` in shell.ts) read `data-fit: undefined` at four widths and was
  about to be written up as long dead; it was the pane tab being backgrounded
  by a second tab opened beside it. The proof is cheap: add an RO in the page
  and see whether IT fires — ours fired zero times. Front the tab
  (`tabs_select`), then measure. Same class as the rAF rule above.
- **A search pays for every arm, and the winner must beat what the search
  would have found in nothing.** v60's autonomous sweep tries 85 rules over
  765 configurations; at that width the best-of-N hurdle is ~0.29 of per-trade
  Sharpe, so a rule at 0.20 is a result of the search rather than of the
  market — and `promote()` alone would have passed it. `study/stats.ts`
  `deflatedSharpe` is the one owner of that arithmetic (PER-TRADE Sharpe, per
  its own header). Count arms that FAILED too: a field that silently shrinks
  lowers the hurdle without telling anyone.
- **A job that never ran is not a field that failed.** A stale gateway 422'd a
  batch and all 85 rules were reported "could not be studied" while the
  fallback sat unused, because capacity had said yes. Distinguish "nothing
  reported" (nothing ran — re-run locally) from a per-study failure (that arm
  really was attempted, keep its reason).
- **`align-items: stretch` does not centre a row whose items declare their own
  height — it puts them all at the TOP.** The command bar looked "very
  inconsistent" because it was: MEASURED at 1920, the desk tabs (42px,
  `align-self: center`) were centred at y=29 and the other eleven controls
  (28px) at y=14.8, so the whole row sat fourteen pixels above its own
  navigation. Nothing stretched, because everything had a height. Check the
  CENTRES of a row's children, not their tops.
- **A control scale is a token on the row, not a height on each control.**
  Re-pointing `--h-ctl-sm` / `--h-ctl` on `.commandbar` and `.topbar` moved
  eleven and nine controls respectively and covers the next one added; the
  per-control list is what `press.css` records getting wrong twice. The catch
  is INHERITANCE: the chart toolbar's popovers are its DOM children
  (`.tool-pop-wrap` is `display: contents`, the panel is fixed-positioned, and
  custom properties inherit straight through both), so a row that anchors a
  panel has to restore the defaults on the host or the panel silently comes up
  on the row's scale.
- **A ladder rung that sheds more than the row is short by leaves the
  difference as empty band.** The chart header's fit loop steps down until the
  row fits: MEASURED at a 1282px column, `compact` overflowed by TWO PIXELS and
  `tight` had 293 to spare, so a rung shedding three things at once put 293px
  of nothing across the top of the chart. Cost every rung in pixels and let it
  shed one thing. And the two pixels were their own bug: a spacer at
  `flex: 1 0 12px` can grow and never shrink, so the row reports itself as
  overflowing while holding 12px of blank.
- **`max-width` on a wrapper does not constrain a child that declares its own
  width.** `.sym-picker` was capped at 110px with `.sym-input` still at 148px;
  an input is its wrapper's only child, not a flex item of the row, so it
  overflowed by 38px and painted over the price beside it — which rendered
  correctly at the right x and read "136.01" on screen. Constrain the element
  that has the width, and `width: 100%` is not it when the wrapper is
  `flex: 0 1 auto` (the pair then collapses to the child's content).
- **A grid places by ROW, so cards of unequal height leave two kinds of hole.**
  Six briefing cards in four columns: the row is as tall as its tallest card
  whatever `align-items` says (holes of 177, 84 and 173 under the short ones)
  and six into four leaves two empty slots (878px of grid). Multi-column
  places by column and balances — four columns took the block from 457px tall
  with an empty half-row to 327 with column bottoms within 19px of each other.
  A card set whose heights come from the data does not make rows.
- **Translate an exception where you CATCH it, or the screen gets the C source
  file.** `URLError.reason` is the underlying exception object, and
  `f"unreachable: {e.reason}"` put "[SSL: CERTIFICATE_VERIFY_FAILED] ...
  (_ssl.c:1082)" in the news panel beside the source name. The rule CLAUDE.md
  already states has a mechanical form: the operator gets a sentence naming
  what they can DO about it, a sibling function keeps the raw for the log, and
  both halves get a test.
- **An invariant enforced on WRITE is not enforced on READ.**
  `archive.write` de-duplicates bars within a batch and says why; `archive.read`
  concatenated overlapping segments and only SORTED, and `history.load` hands
  the vendor's response back verbatim when it is longer than the archive's
  holding. So a repeated timestamp reached the engine untouched, `headless.ts`
  threw on its ascending-and-unique contract, and every autonomous sweep
  reported "85 could not be studied on this history" — a COUNT WITH NO CAUSE,
  which is why it survived for releases. Give a contract one owner
  (`ascendingUnique`) and apply it at every boundary that produces the value,
  and make a bulk refusal print its reasons or nobody will ever chase it.
- **A state that is only set when work FINISHES cannot describe work in
  flight.** The sweep driver set `subject` — which market this run is about —
  when the report landed, so a search already running looked exactly like no
  search to every reader asking "is this mine?". The card drew its idle state
  and offered a button that `running` then silently refused. Set the subject
  when the work starts; it is known then.
- **A feature must not hang on one mechanism that cannot fire in a test.** The
  card's first automatic search depended entirely on `onShown`'s
  ResizeObserver, because the visibility check runs during construction and
  `mountShell` appends the element afterwards — so `isShown` is false for the
  whole of it. RO is also dead in a background tab (already recorded above) and
  absent in jsdom. Anything triggered by becoming visible needs a second path.
- **Reusing a builder can silently re-price what it builds.** `setup/plan.ts`
  `buildPlan` takes the FURTHER of the supplied stop and `atr x
  minAtrMultiple`, discards the supplied stop above `maxAtrMultiple`, and
  hardcodes targets at 1R/2R. Feeding it a backtested rule's own stop would
  have printed different levels underneath that rule's out-of-sample
  expectancy — figures describing a trade nobody tested. Reuse the sizing and
  the checks, which are about the account and the market; do not reuse the part
  that decides the levels.
- **An empty list of checks is not a passing list of checks.** `verdict()`
  concludes "go" from none-blocking and none-unknown, so handed `[]` it reports
  0 of 0 as a pass — the same shape as the `/svc/health` strip that painted
  "0 of 0 running" green. Any path that can produce no gates needs its own
  "can't check yet", written out rather than inferred.
- **A LOOP WITH NO WRITER FOR ITS INPUT reports healthy and does nothing.**
  `bars_loop` read its enrolment from a config key that one module read and
  zero modules wrote, so it ticked hourly, showed a fresh last-tick age in
  `/svc/health`, and produced no work for a whole release. Same family as the
  eleven loops that had not run since consolidation, and as "a count of what
  has REPORTED is not a count of what EXISTS". When adding a component driven
  by stored configuration, grep for the WRITER before believing it runs.
- **A TEST REACHED THE OPERATOR'S LIVE DATABASE THROUGH A NEW DOOR.**
  `createHistory` defaulted to the real `/svc/bars` client; the global `fetch`
  under vitest reaches a running gateway; so `npm test` with `python run.py` up
  wrote 535 rows of fixture candles — sources `net`, `a`, `alive`, `px`, `b`,
  dated 2027 — into the archive the backtests read. The existing rule (four
  test files writing to `mishel.db`) was about `MISHEL_SVC_DB`; this arrived
  via an HTTP default instead. **Make reaching a real store something a caller
  OPTS IN to.** A default that is inert cannot be reached by a test that does
  not know it exists, whatever the environment does.
- **Failing tests are the argument, not the obstacle.** Nine context series
  (yields, spreads, index levels) were added to `INSTRUMENTS` with a
  `contextOnly` flag, and five calculator tests failed at once: a quote
  currency of "PCT" has no convertible rate, because everything that sizes or
  values a position walks that table. The fix the tests were asking for was to
  keep them OUT of it — teaching each consumer to skip a flag is the
  find-every-consumer trap, and the next consumer would not know.
- **A ROLLING WINDOW IS THE SAME LENGTH FOREVER, so counting its length
  measures nothing.** The sweep cache asked "how many bars since this was
  searched" as `barsNow - prev.bars`, and a 5,000-bar study window is still
  5,000 a week later with every bar in it newer — so the answer was always
  ZERO and a cached result could never expire. Measure elapsed TIME divided by
  the bar spacing. Any "how much newer is this" question over a fixed-size
  window has the same trap in it.
- **A cached answer must carry the QUESTION in its key.** A sweep result is
  only an answer to the field and the costs that produced it; adding a rule or
  changing the spread changes the hurdle every survivor had to clear. Hash both
  into the key so a changed question MISSES, rather than serving a conclusion
  nobody reached. And never cache a cancelled run: a partial answer frozen in
  place suppresses the re-run that would complete it.
- **A capability nobody can see is a capability nobody has.** The durable
  archive, the enrolment, the persistence request and the disk budget were all
  built, all working, and all invisible — the owner could only learn how much
  history existed by opening developer tools. Ship the surface WITH the
  mechanism, and make its three states distinct: "could not ask" is not
  "nothing stored", and rendering 0 for an unreachable service is the most
  alarming possible way to say "fine".
- **A DELETION POLICY IS A PURE FUNCTION, or it is untestable.**
  `svc/store.py` `eviction_order` takes an inventory and returns a plan; it
  writes nothing. That is the only reason its four rules (ticks before bars,
  context before traded, oldest before newest, never the last 90 days) can be
  checked as arithmetic instead of as filesystem side effects — and the order
  IS the safety property of a multi-gigabyte store. One tuple sort, never three
  passes: the priorities have to compose, or a newer tick survives an older bar
  and nobody notices until the disk is full of the wrong thing.
- **A budget that can only be met by deleting recent history is a
  misconfiguration, not an instruction.** Obeying it silently destroys the one
  window a walk-forward validates on, and the operator finds out from a
  backtest that suddenly has no out-of-sample. Remove what you legitimately
  can, then REFUSE and name the choice: raise the budget, or drop a market.
  And default any destructive route to `dry_run` — one that deletes gigabytes
  by default is one that deletes them by accident.
- **A TICK AGE IS NOT A HEALTH CHECK, and a green dot must not imply one.**
  `bars_loop` ticked hourly and reported a perfectly fresh `last_tick_age_s`
  for a whole release while doing nothing, because the config key it read had
  no writer. `ui/data/system.ts` therefore prints "woke 13s ago" and never
  "healthy", and the dot is documented as meaning STARTED. Where a loop has an
  output worth counting, show the count instead of the age.
- **A DOWNLOADER MUST REFUSE BEFORE IT STARTS, not after.** Missing packages, a
  full disk budget, a job already running: all answerable without fetching a
  byte. And write bulk files atomically (`.part` then `os.replace`) — a partial
  Parquet is indistinguishable from a complete one to an inventory that walks
  the filesystem, so the next resumable run skips it forever.
- **Detect a vendor's format change by MAGNITUDE, not by a cutover date.**
  Binance switched kline `open_time` from milliseconds to microseconds in its
  2025 archives. `if t > 1e14: t /= 1000` is right in every year; a date
  comparison is a fact that goes stale and that nobody revisits.
- **A CARD THAT ANSWERS A QUESTION SHOULD LEAD WITH THE ANSWER.** The archive
  card's whole purpose is "how much history can I backtest on", and it said so
  in body text as a three-fact meta string joined with middle dots. The count
  now leads at `--fs-7` in `--font-serif` — the face this terminal already uses
  for what it says on its own account — and everything qualifying it drops to
  `--text-faint`. Hierarchy is CONTRAST; reaching for a second colour to make
  something important is how a palette stops meaning anything.
- **Two cards that answer different questions must not be the same shape.** An
  inventory (nouns, quantities) and a liveness readout (verbs, time) were both
  `.dd-panel` + heading + flat table, and the reader had no way to tell which
  was which. And prefer the file's EXISTING idiom over the obvious one: status
  dots are what every dashboard reaches for, but `.bf-event` had already
  established a 2px left rail here, so reusing it makes a new card look like it
  belongs.
- **Copy must describe the operator's world, not the work that produced it.**
  A card subtitle read "Six of them had no mention anywhere on screen until
  now" — true, and about the changelog rather than the machine. Loop names were
  function names with the suffix stripped ("db alert", "pair scan"), which is
  internals leaking. Name things as the person using them would.
- **A MENU ROW MUST SAY WHERE IT GOES.** "All tools" had twenty-eight rows that
  looked identical and did three different things — change the desk, open a
  panel over the chart, launch a dialog — with a hint on the inspector cards
  only. Two thirds of it was learned by trial. And its labels were sentences in
  name slots ("Quant - volatility, causal, forecasts, ML"): the label is the
  NAME, the hint is what it does.
- **A capability filed under the wrong heading is barely easier to find than one
  with no screen.** Storage, downloads and twelve background jobs shipped inside
  Research > Data while the menu had a "Review and system" group that did not
  contain them. Ask which question a surface answers before choosing its home.
- **A guard test that pins a COUNT fails on addition and passes on substitution.**
  "lose no desk in the regrouping" asserted 23, so adding a desk broke it while
  dropping one and adding another would not. Compare the SET against its source
  of truth; the name of the test tells you which fact it should pin.
- **`auto-fit` WITH `1fr` SPENDS EVERY PIXEL, whether or not there is anything
  to put in it.** Two blocks of the data library did it on the same screen: the
  row's "Used by" track at `minmax(100px, 1fr)` became ~560px holding one em
  dash, and `.dd-stats` became four 420px cells, one of them holding the
  character "3". That is the "empty space" the owner photographed. A data table
  also has a width past which it stops being readable — the eye loses the row
  between the size and the buttons — so the fix is a CAP, chosen by arithmetic:
  add the fixed tracks, the gaps and the padding, decide what the flexible one
  deserves, and set the cap to their sum so there is no slack to pool.
- **A FIELD STATES ITS OWN WIDTH.** `.dd-input` is `width: 100%`, which inside a
  flex row resolves to the whole row: MEASURED at 718px, so the symbol field
  wrapped onto its own line and read as a bar of empty surface — it looked
  MISSING in a screenshot. Same class as `.sym-picker`'s `max-width` failing to
  constrain `.sym-input`, from the other direction: there the wrapper could not
  shrink the child, here the child ignored the row.
- **A SUBSTRING MATCH OVER A CLOSED VOCABULARY IS A FALSE POSITIVE WAITING.**
  The library's filter matched the timeframe by `includes`, so "5m" returned
  15m as well and "1m" would return both. A market name is open-ended and a
  partial one is the whole point; a bar size is one of six literals, where the
  only thing a substring buys is the wrong row. Match the open field loosely
  and the closed one exactly.
- **A BULK ACTION MUST HONOUR EVERY GUARD ITS SINGLE-ROW VERSION HAS, and name
  what it skipped.** The per-row Delete and the retention sweep both refuse a
  pinned series; a bulk Delete that did not would be the one route in the
  product that deletes history from under the thing displaying it — and it
  would do so for a selection made with ONE click on a group header, which is
  when the operator is least likely to have read it. `deletable()` returns the
  skipped ROWS rather than a count, because the caller has to name them:
  silently doing less than asked is the same shape as a study whose dead
  vendors vanished from its reported window.
- **A CONTROL THAT TAKES ONE OF SOMETHING PER PRESS IS A FORM, NOT A TOOL.**
  Downloading one symbol at one bar size meant three trips to fill one market,
  and nobody studies a single timeframe. A set of chips plus a comma-separated
  field turns it into one press over symbols x timeframes — run SEQUENTIALLY,
  because parallel backfills are how a free vendor tier starts refusing, and
  with a queue line naming the leg in flight, because an unchanging
  "Downloading…" is indistinguishable from a hang.
- **A DESK CAN BREAK THE HOUSE RULE SIX TIMES AND LOOK NORMAL, because every
  instance looks like one paragraph.** CLAUDE.md has said "one short line per
  fact, the reasoning behind Why?" since v59, and `pkWhy` has existed as long;
  `ui/data.ts` used it ZERO times and opened all six panels with a three-to-five
  line `.dd-sub prose`. The owner's words for the result were "read only
  things" and "looks like a broken project". Grep for the SHARED IDIOM's absence
  — a file that never imports `panelkit` is a file that never took the rule.
  And shortening must MOVE the detail: each lede's full text is now behind a
  disclosure labelled for what it answers, not deleted.
- **A CARD PER ITEM IS A DEBUG CONSOLE ONCE THERE ARE FIVE OF THEM.** Each
  rate-limited host had a name row, a full-width progress bar and a mono meta
  line — roughly 100px each, for a budget that is full in every normal state.
  As rows: 30px each, 231px for seven, MEASURED. Keep a bar only where the
  quantity really is a proportion, and shrink it to where it is read (72px).
  And a line that is identical under every item is not per-item: "venue counter
  not readable in a browser" appeared under each Binance host and now appears
  once, with a count, beneath the list.
- **A GROUP HEADER THAT COUNTS ROWS IS NOT COUNTING THE THING IT NAMES.**
  SPX500 held 1h from mt5 and 1h from a proxy; the header read "2 timeframes".
  Two vendors at one bar size is not two bar sizes, and the difference is
  exactly what decides whether the next download is worth making. Count the
  DISTINCT values of the thing the label names, and when a second dimension is
  what actually varies, name that too.
- **Hide a section, do not unmount it.** Each panel on a switched desk holds
  live state — a filter, a selection, a pending import — and an effect running
  since activation. `hidden` keeps all of it; rebuilding on every switch throws
  it away silently, and the operator only finds out when their filter is gone.
  And do NOT persist which section is open: a desk you open to answer a
  question should open on the question it is named after, not on wherever you
  left it three days ago.
- **TWO LISTS THAT NAME A GROUP FOR THE SAME THING WILL DISAGREE, and nothing
  will say so.** `views.ts` grouped the desks for the desk BAR and
  `toolsmenu.ts` grouped the same desks for the MENU, with five group names
  each and no name in common. MEASURED by cross-referencing: **0 of 24 agreed**
  — Signals was Strategy on the bar and Trading in the menu, Workspace was
  Chart and "Review and system". The labels drifted too ("Data" / "Data
  library"). Nothing was broken, nothing was red, and a desk simply lived in
  two places depending on which control you reached for. Make the second list a
  PROJECTION of the first and keep only what genuinely differs — here, a menu
  wants a four-word note where a desk bar wants a tooltip sentence — then guard
  the projection with a test, because the next hand-written list will look
  exactly as reasonable as this one did.
- **A DISCLOSURE'S DEFAULT IS A FUNCTION, NOT A STORED SET.** Which markets the
  library opens is computed from what is on the chart. Storing that as the
  initial value instead would freeze it at whatever was pinned when the desk
  first rendered, so changing symbol leaves the wrong one open with no way to
  tell why. `null` for "nobody has said", the function for the default, and the
  first click turns it into an explicit set seeded from that function.
- **A FILTER MUST OVERRIDE A COLLAPSED STATE, not be ANDed with it.** Searching
  a shut group otherwise reports "1 of 10 series" and shows nothing, which reads
  as a broken search rather than as a shut group. Typing a query IS asking to
  see what matches.
- **A SELECTION YOU CANNOT SEE IS ONE A BULK ACTION STILL ACTS ON.** Collapsing
  a group hid its ticked rows while Delete stayed aimed at them. The count goes
  on the group header. And PARTIAL IS ITS OWN STATE: a group checkbox showing
  unticked with one of two rows selected is a lie — `indeterminate` is a
  PROPERTY with no matching attribute, so it cannot be passed through props and
  needs a `ref`.
- **One control, not two, when one of them is always a no-op.** "Expand all"
  and "Collapse all" as separate buttons means one is dead at any moment; a
  single button that reads the current state is one thing to look at and always
  the answer.
- **AN AUDIT SCRIPT THAT PARSES NOTHING REPORTS SUCCESS.** The first
  cross-reference pass had two vacuous checks and both printed "ok": the icon
  regex expected `name: (` where icons are `name: [`, and the keymap regex
  matched zero bindings. Same defect as `/svc/health` painting "0 of 0 running"
  green, in the tool built to find defects. Every check prints WHAT IT PARSED,
  and a zero there fails. `scratchpad/xref.py` and `scratchpad/deadspace.js`
  are kept so both audits can be re-run rather than re-derived.
- **AN EDIT SCRIPT WITHOUT AN ASSERT IS A SILENT NO-OP, and the build will
  still pass.** A watchlist cap landed on `.wl-table`, a class no element has —
  the head and the rows container are siblings with no wrapper. `replace()` with
  no assert matched nothing, wrote a dead rule, `npm run build` succeeded and
  the row was still 1638px. Assert every replacement, and VERIFY THE ELEMENT,
  not the stylesheet: the rule existing says nothing about whether it applies.
- **GEOMETRY IS EVIDENCE ABOUT STRUCTURE AND NO EVIDENCE ABOUT PROPORTION.**
  v60.8 verified a new card by computed style and layout geometry because the
  preview pane was 379px tall, and said so in its own entry. Three releases
  later that card was measured with 844px holding "BTCUSDT 1h" and 603px holding
  a date. Every number it checked was correct. A column being four times wider
  than its content is only visible to something that compares the two — which is
  what `deadspace.js` now does, so it need not depend on somebody looking.
- **A DATE WITH NO YEAR IS A DATE THAT MATCHES EVERY YEAR.** The chart axis
  named the day when a label crossed midnight and printed `Sep 24` whatever year
  it fell in; the crosshair readout carried the year on its DAILY branch and not
  on its intraday one — the branch you are in whenever you scroll back through
  the archive. With 1h bars held to 2022 and daily to 2021, a 5m chart a year
  back printed exactly the string it prints for today and nothing on screen
  could separate them. Same class as the TwelveData bars drawn in the wrong
  place: the picture is right and it is about a different time. The fix is the
  function's own rule one level up — announce the year on the label that crosses
  into it, stay quiet inside it, and always carry it in a readout that names ONE
  bar.
- **An axis label that grows cannot overlap if the fit test measures the drawn
  text and the "last drawn" cursor only advances on a label that was drawn.**
  Adding the year widened labels and needed no other change: one that no longer
  fits is skipped, and because the cursor did not advance, the NEXT label still
  announces the year. Check both halves before widening anything on an axis; a
  fit test that compares against the tick rather than the drawn label would have
  dropped the announcement silently.
- **A BORDER ON EVERY ELEMENT GIVES THEM ALL THE SAME EDGE, and then nothing
  has a position.** Every desk was `background: var(--surface)` plus
  `border: 1px solid`, and the owner called the result broken across four
  screenshots. A surface separates by a vertical tone shift, a WARM one-pixel
  lip along its top and a COOL cast beneath — and the hue separation is the
  part that matters, because a dark interface where the light and the shade
  are both neutral grey reads as unlit plastic. Build it from the PALETTE
  variables, never hex: this terminal ships seven themes and a hardcoded
  shadow is right in exactly one.
- **A TRACKED-OUT ALL-CAPS EYEBROW ABOVE EVERY HEADING is the commonest tell
  of a generated interface**, and it had grown to sit above almost every block
  here. An italic of the serif the terminal already owns reads as a caption in
  a printed table instead. But AUDIT BEFORE CONVERTING: of 43 uppercase-and-
  tracked rules, most are badges — `LONG`, `DEMO`, `AI` — and a short token in
  caps is a chip, not a heading. Converting all 43 would have been vandalism
  dressed as consistency.
- **A PERCENTAGE DRAWN ON A SHARED AXIS IS A CLAIM NO EYE CAN CHECK.** The
  coverage ribbon places every market's history on one 2021-2026 axis, and a
  segment at the wrong percentage is a lie about when you hold data that looks
  exactly like the truth. So the arithmetic is a PURE function with the four
  traps pinned by tests: overlapping spans MERGE (or a seam appears that is not
  there), a real hole SURVIVES the merge (it is the most valuable thing on the
  chart), a one-day sliver is FLOORED to stay visible (0.05% rounds to nothing
  and reads as "you hold none of this"), and a zero-length axis cannot divide —
  `NaN%` is dropped silently by CSS and draws as nothing at all.
- **Two scales over one axis will drift.** The ribbon's year gridlines are
  positioned from the same `from`/`to` the segments use, by the same function.
  Computing the labels independently is how a chart ends up with its own axis
  disagreeing with its own data.
- **A DESK IS READING MATTER, AND `max-width: 100%` IS NOT A MEASURE.** That
  one declaration on `.dd` is why every desk stretched: MEASURED at 1900,
  Briefing and Watchlist both ran to 1814px with tables capped at 1000 inside
  them, which IS the empty space the owner photographed three times. Past about
  1480px the eye loses the row between its first column and its last, and
  nothing done inside the panels fixes a line that long. Centre the column
  rather than left-aligning it — 420px of slack on one side reads as a layout
  that failed, the same amount on both reads as one that stopped.
- **A RAIL IS A CONTENT DECISION, NOT A LAYOUT ONE, and a metric cannot make
  it.** The plan was to give all 23 desks a primary column and a rail. The
  FIRST desk opened to do it overturned the plan: the Watchlist has two blocks,
  your list and a 3,108-tile heatmap, and the heatmap in a four-column rail is
  unreadable — the law applied against the content it exists for. So
  `.dd-layout` / `.dd-primary` / `.dd-rail` stay OPT-IN, three lines per desk,
  taken where the content genuinely splits. Twenty-one desks not having a
  hand-designed rail is the decision; inventing twenty-one from a metric would
  have produced twenty-one that fight their own content.
- **A script that matches the FIRST occurrence usually matches the wrong one.**
  `deskshape.py` took the first `h("section", { class: ... })` in each module,
  which is normally an inner panel, and duly reported `data.ts` as
  `dd-panel lib-hero` and "GRIDS: 0" for a frontend with obvious grid desks.
  Zero is the answer a broken parser gives — the same tell the cross-reference
  audit is built around — so measure the rendered thing when the source shape
  is ambiguous.
- **A DESK'S OWN SUBTITLE USUALLY NAMES ITS SPLIT.** Risk says "How much, and
  whether that is inside the rules you set" — so the sizer, the book it is
  sized against and the aggregate that book adds up to are the work, and the
  rules are what the work is measured by. Read the sentence the desk already
  wrote about itself before inventing a taxonomy for it.
- **CHECK WHETHER A DESK ALREADY SOLVED IT BEFORE RESTYLING IT.** The
  Calculator was on the list for the layout law and had had it all along —
  `380px minmax(0, 1fr)`, inputs at a natural width and results taking the
  rest, columns within 10% of each other in height, and zero dead tracks under
  the scan. Two desks in two releases have now overturned the plan to change
  them by being opened and measured: the Watchlist, whose second block is a
  3,108-tile heatmap no rail can hold, and this one.
- **USING WIDTH AGAINST THE CONTENT IS NOT USING IT.** The Calculator's five
  result panels could go two-up and would fill more of the screen. They are a
  SEQUENCE — what a pip is worth, the trade, what it ties up, what it costs,
  where the R multiples sit — and splitting a narrative into two columns to
  spend horizontal space makes it read worse. Unequal heights would also have
  needed multi-column rather than a grid, which this file already records; the
  right answer was to leave it.
- **A RAIL THAT SCROLLS AWAY IS A FIRST SCREEN, NOT A RAIL.** Smart money's two
  detection lists MEASURED 7,623px and 23,696px tall with the panel that decides
  what is IN them sitting above the first, so changing a filter meant scrolling
  twenty thousand pixels back. Sticky fixes it, and `align-self: start` is
  REQUIRED — a grid stretches its item to the row height by default, and a
  sticky element as tall as its own scroll container can never move relative to
  it, so the rule would have been present and inert. PROVE it by scrolling:
  primary top went 271 -> -19,729 while the rail went 271 -> 176 and stayed.
  And stacked below the breakpoint the rail must go `position: static`, or it
  pins itself over the content beneath it.
- **LIFT, THEN MOVE — never both in one edit.** Two desks kept their panels as
  inline arguments to the root `h()`. Each script lifts them to consts first,
  asserting that every block starts at `h(` and ends at `),` AND that its
  heading text is the one expected, and only then rearranges. An off-by-one
  that moves a line into the neighbouring panel still compiles and still
  renders; it is just a silently wrong desk.
- **THE SPLIT FOLLOWS THE CONTENT, INCLUDING ITS RATIO.** Sessions is 7+5, not
  8+4, because its clock's last column carries a sentence that lands near 150px
  in a 4-column rail and wraps. MEASURED at 7+5: 273px, no wrap. One attribute
  on the layout, not a second pair of classes — the next desk that needs a
  different ratio should be able to say so in one word.
- **A PREFIX IS ONLY A NAMESPACE IF IT IS ACTUALLY UNIQUE.** The System desk
  used `.sy-` and so does the Study desk, which owns 157 of them in a sheet
  that imports LATER — so `.sy-row` resolved to a six-track grid on a row with
  two children and `.sy-name` picked up a chip border it never declares. The
  desk rendered in another desk's clothes for two releases with nothing failing
  and nothing red. `scratchpad/classcollide.py` asks the question that finds
  it: which PREFIX is claimed by more than one sheet. Comparing shared class
  NAMES is far too noisy to act on — `press.css` deliberately owns the press
  state of controls declared in six other sheets — and the test that separates
  an accident from a specialisation is whether the later sheet selects the
  class BARE (`.sy-row`) or qualified (`.dd-row.lib-row`).
- **PUT A GLOBAL RULE ON THE CONTAINER, NOT ON ONE OF THE THINGS IT CONTAINS.**
  The 1480px measure went on `.dd`, which is one of SIX root classes desks use
  — `.dd`, `.desk`, `.view`, `.screener`, `.flow`, `.journal-desk` — so the
  Journal kept stretching to 1796px with 591px price fields. It belongs on
  `.view-slot > *`, beside the `min-width: 0` rule that is already there for
  exactly this reason and whose own comment says so: setting it on every desk
  at once is what stops there being a seventh that misses it.
- **PARTIAL COVERAGE CANNOT SETTLE AN ORDER-OF-EVENTS QUESTION, and getting it
  wrong FLIPS THE SIGN.** Resolving whether a stop or a target was hit first
  from minute bars is only honest when the minutes cover the parent bar: if the
  first touch happened in a minute nobody has, walking the minutes that ARE
  present finds the SECOND touch and reports a loser as a winner with total
  confidence. Check coverage BEFORE reading anything off the data, and when it
  fails keep the pessimistic assumption and label it. The guard caught its own
  test fixtures on the first run — three minutes cannot settle a ten-minute bar.
- **A COST MODEL IS A HURDLE, SO AN ASSUMED COST IS AN ASSUMED CONCLUSION.**
  `DEFAULT_COSTS` charged a flat 2bp/4bp/1bp to a 45-minute scalp and a two-week
  swing alike, and those three numbers decide which rules survive a search.
  Charge by MODE and by VENUE, and report friction as a SHARE OF THE TARGET
  rather than in basis points: "0.23%" is unreadable, "a third of what the trade
  is trying to win" changes a decision. MEASURED on $500: 500 full-size scalps
  cost more than the whole account in fees alone, and the same 500 risk-bounded
  cost under 30%.
- **SPOT CARRIES NOTHING OVERNIGHT.** A test asserting a per-night charge on
  binance-spot failed, correctly — you own the asset and there is no funding to
  pay; a perpetual is where funding belongs. A swing model that charges both is
  wrong in a way that quietly penalises the cheaper instrument.
- **A TRADE LOG IS A SELECTED SAMPLE, so a model trained on it learns the
  SELECTION RULE, not the market.** A backtest skips a signal while a position
  is open and skips whatever a filter rejected, so the outcomes of the skipped
  setups are never observed — and a classifier fitted to what survived that
  will look excellent in backtest for exactly that reason. The training set is
  a CANDIDATE LEDGER: every bar the entry condition was true, open position or
  not, filter or not, with the outcome it would have had. Three signals one bar
  apart are three rows, where a backtest produces one.
- **A TIMEOUT IS NOT A LOSS.** A setup that reaches neither its stop nor its
  target inside the horizon is its own class, and folding it into "stop"
  teaches a model that "nothing happened" looks like "I was wrong" — only the
  second is worth learning to avoid, and the first is most of a quiet market.
  The base rate a router has to beat excludes them from its denominator too,
  because a classifier that predicts one class for everything scores exactly
  that and has learned nothing.
- **A LEDGER MUST PRICE THE WAY THE ENGINE PRICES.** Same fill model, same
  `fillable` test, same costs. One priced differently trains the router on a
  game the engine does not play, and the disagreement never shows up as an
  error — it shows up months later as a live strategy quietly underperforming
  its own backtest with no visible cause.
- **ACCURACY IS NOT SKILL, and a classifier that cannot tell you so will route
  on noise.** Predicting the majority class scores the base rate exactly, so
  "58% accurate" on a sample that is 58% winners reports nothing at all. `skill`
  is a separate field from `accuracy` and is false unless the model beats the
  majority OUT OF SAMPLE by more than its own noise. The test that matters is
  the one asserting NO skill on pure noise: a router without it fails silently,
  and an AUC near 0.5 presented as "62% confident" loses money with conviction.
- **A GRADIENT BOOSTER EMITS A RANK, NOT A PROBABILITY.** Thresholding an
  uncalibrated score at 0.62 is thresholding a rank. Calibrate, then publish the
  RELIABILITY CURVE — "it said 0.60, it won 0.59, n=140" — which is a threshold
  someone can choose. Where there is no skill, say the basis is `none` rather
  than inventing a constant.
- **A RANDOM TRAIN/TEST SPLIT ON A TIME SERIES SCORES THE MODEL ON A PAST IT
  HAS SEEN.** June in train and May in test inflates every metric and nothing
  looks wrong. Folds must be contiguous and forward-only, and the boundaries
  PUBLISHED so a caller can assert `trainTo <= testFrom` rather than trust a
  claim in a docstring.
- **`verify.py`'s ruff failure prints a MISLEADING reproduction command.** It
  suggests `--select <code>`, and `--select` OVERRIDES the config's rule list —
  which makes every `# noqa` for a now-unselected rule look unused, anywhere in
  the repository. Two real findings came back as six, four of them in files
  nobody had touched. Reproduce it the way the gate runs it: full defaults,
  `--output-format concise`, and count the codes.
- **A TRADE COUNT CAN DESCRIBE THE WINDOW RATHER THAN THE STRATEGY.** The
  Playbook reported 73 trades on "992 bars from mt5" because it asked for a
  CONSTANT 1,500 bars of whatever the chart was showing — while `MAX_STUDY_BARS`
  was 60,000 and always had been. A bar count must follow the SPAN and the
  TIMEFRAME (five years of 1h is ~43,800 bars, of 1d ~1,826; one number serves
  neither), and the result must state the window it was measured over, because
  "73 trades" and "4,100 trades" are the same sentence about different
  questions.
- **THE ARCHIVE IS WHAT YOU HAVE, NOT WHAT YOU CAN GET.** A run planner that
  clips a requested year range to the archive's oldest bar is honest and
  useless: verified live, a profile holding five weeks of BTCUSDT 1h answered a
  request for 2000–2026 with "the run covers 2026-08-21 to 2026-09-24", and you
  could never ask for history you did not already own. Clip only the FUTURE edge
  — nobody backfills tomorrow — and make the past edge a WARNING that names the
  date and the share held. But a window ending entirely BEFORE the oldest bar is
  still a refusal: backfill reaches back from what exists, it cannot invent a
  year the venue never listed.
- **A DESK THAT CAN ONLY TEST WHAT IS ON THE CHART CANNOT TEST.** Tying the
  Playbook's subject to the chart's symbol made the two activities one, and
  watching a market and back-testing a rule set are not the same job. The
  chart's symbol is the right DEFAULT and the wrong lock.
- **ADDING A CONTROL CAN BREAK A PROMISE THE SCREEN IS ALREADY MAKING.** The
  Playbook's subtitle says the description cannot drift from the behaviour, and
  the combine control broke it in one edit: "Exactly how it trades" read the
  SELECTED rule while the engine ran the COMPOSED one, so the desk described A
  and tested A+B. Where a surface states a guarantee about itself, every new
  control is a chance to falsify it — and the fix is a distinction, not a
  rename: the editor still edits the base rule, the description follows what
  actually runs.
- **A REFUSAL IS A RESULT WHEN IT NAMES ITSELF.** Two of eight rule sets cannot
  act as a filter because every one of their entry conditions is an EVENT, and
  the desk says so. "A+B produced nothing" with no reason is the shape of a
  feature people stop trusting, and the reason was already computed — `hybrid.ts`
  returns a named refusal, and it only ever needed showing.
- **A THROWING RENDERER COSTS THE WHOLE LIST, AND THE REACTION SWALLOWS THE
  REASON.** `each` builds its fragment first and appends ONCE, so a render that
  throws part-way leaves the parent untouched: one ungradeable row rendered five
  markets as none, and three rendered eight bar sizes as none. Every ordinary
  signal was healthy — `data-on` on the SAME closure read `rows().length > 0`
  and went true, proving the data was there and the dependency was tracked — so
  the two halves of the same card disagreed and neither was wrong. `tsc` cannot
  see it and no test covered it, because the defect was in data the fixtures did
  not have. **`window.__signalErrors` named it in one call**, which is precisely
  what `signal.ts` says it keeps the swallowed stacks for; reasoning about the
  graph for three rounds found nothing. When a binding that should have painted
  did not, read that log BEFORE re-reading the code.
- **A SERVICE WITH NO SCHEMA SENDS NULL WHERE THE HAND-WRITTEN TYPE SAYS
  NUMBER.** `/svc/claims/stats` returns `hitRate`, `low`, `high` and
  `expectancyR` as null for a population with claims recorded and none decided —
  the honest answer, and the one this product demands everywhere else. The
  client type declared them `number`, and `.toFixed()` on the null is the throw
  above. This is the API-contract backlog item arriving where it was predicted
  to: the risk is not that a route changes shape, it is that the shape was never
  read in the first place. **A nullable figure is the DEFAULT assumption for any
  aggregate from a service that refuses honestly** — and a null rate is not a
  zero: `0.0%` says every claim lost, null says none has been answered.
- **A NESTED WRITE DEADLOCKS THE THREAD THAT OPENED THE TRANSACTION, AND THE
  ROLLBACK IS THE REAL DAMAGE.** `cfg()`, `log_event()` and `send_tg()` each open
  their OWN connection. A nested READ is fine; a nested WRITE asks for the lock
  the same thread is holding, waits out the busy timeout and raises "database is
  locked" — and the raise escapes the `with`, so sqlite3 ROLLS BACK the work the
  block existed to do. `pair_scan_loop` had 2,069 failures, 46% of the whole
  event log, and `onchain_seen` was EMPTY: it had failed on every run it ever
  made while re-detecting the same tokens forever, and its tick age was fresh
  throughout. It also held the lock 5.5s every five minutes, which is why two
  other loops carry "database is locked" in their own histories. **Two wrong
  hypotheses were discarded on measurement first** — a 4-writer/6-reader workload
  and a bulk-transaction one both produced ZERO lock errors, so this is not
  contention and no amount of WAL would have fixed it. Record inside the
  transaction, announce after it closes. `scratchpad/dbhold.py` and
  `tests/test_db_nested.py` audit every `with db()` block in the tree.
- **A RECURRING FAILURE IS A STANDING, NOT AN EVENT, so a tail cannot report
  it.** `/svc/events` is `LIMIT 50`; on fifty rows a loop that had failed two
  thousand times looked like twelve ordinary lines, and counting the tail would
  have under-reported it FORTY-FOLD. Count in SQL over the whole table. Same
  family as "a count of what has REPORTED is not a count of what EXISTS", and
  the reason `/svc/events/summary` exists rather than more client arithmetic.
- **A FAILURE IS NOT ALWAYS NAMED LIKE ONE.** Classifying event kinds by whether
  the name ends in `_err` reported ONE failing job on a log where eleven were
  failing: `data_mvrv` had logged 224 rows, every one a 400, under a name that
  reads like ordinary data collection. Classify by the MESSAGES too. And keep
  THREE states: "waiting for a key only you can supply" (FRED, 224 skips) is not
  broken, and filing it with the failures buries the ones that are — the same
  distinction as "could not ask" versus "nothing stored".
- **A JOB IS THE UNIT, NOT THE EVENT KIND IT WRITES.** A flat kind→label map
  made two kinds sharing a name indistinguishable from a mistake: `newpair` and
  `pair_err` SHOULD share one (a scanner's success and failure), while
  `data_calendar` and `data_forexfactory_cal` must not (a 429 and a 404, two
  different things to do about them) — and the card printed "Economic calendar"
  twice with different counts beside it. Declare the JOB and list its kinds, so
  the label is unique by construction and the test can assert the thing that
  matters. Cousin of "two lists that name a group for the same thing will
  disagree": there two lists disagreed, here one list agreed too much.
- **A COUNT THAT CANNOT BE WRONG IS NOT EVIDENCE.** `mishel_edge.upsert`
  returned `len(rows)` — the size of its own INPUT — and `/svc/edge/push` logged
  that as "400 of 400 written", so both halves of the sentence came from one
  number and it could never disagree with the database. `trials` holds zero rows
  on a database whose log carries that line and which nothing deletes from; what
  removed them is not recoverable and is not guessed at. Read the count BACK from
  the store, and report what was offered separately from what landed. Same shape
  as `expect(reason).toContain(QUANT_BASE)`, and as a status strip painting
  "0 of 0 running" green.
- **A SURVEY MUST PRINT ITS OWN FALSE POSITIVES, because most of the first pass
  will be them.** Probing all 45 GET routes reported one failure, and it was the
  probe: `/svc/bars` takes `sym`/`tf`/`n`, not `symbol`/`timeframe`/`limit`.
  Sweeping all 33 desks reported "System and Settings render identically" —
  Settings is an OVERLAY, so the view-slot correctly still held the previous
  desk — and "heartbeat_loop has never ticked", which sleeps 30s on purpose to
  let the other loops register. **Four identical readings for four different
  things is the tell**: it means the probe is measuring the wrong element, the
  same way `deskshape.py` matched the first `h("section")` and reported
  "GRIDS: 0". Check a surprising finding against the code before writing it up.
- **A LOG ENTRY IS NOT A RUN, so a failure count is not a failure RATE.** Most
  `mishel_data.py` feeds call `log(...)` only inside an `except`, so every row of
  those kinds is a failure and "41 of 41 failed" is the failure count printed
  twice with a denominator that implies attempts. It may have run five hundred
  times. The number was right and the sentence was wrong, which is worse than
  being visibly wrong, because nothing looks off. Count entries and CALL them
  entries; print a ratio only where a real denominator exists. Cousin of "a
  count of what has REPORTED is not a count of what EXISTS" — there the
  numerator was mistaken for the population, here the denominator was.
- **A FEED THAT 404s MAY BE A DUPLICATE, NOT A LOSS.** `forexfactory_cal` had
  failed 225 consecutive times on a dead `rss.php`, and the calendar block
  twelve lines below it already read ForexFactory's own JSON successfully — 82
  events on the live probe. One fact, one owner: a second source for a fact that
  has an owner is not a backup, it is a job that fails forever and tells nobody.
  Ask what else writes the fact before hunting a replacement URL.
- **REMOVING THE FIRST ERROR REVEALS THE SECOND, so re-call after every fix.**
  `data_mvrv` returned 400 "Unsupported parameter 'order'"; dropping `order`
  returned 403 "CapRealUSD is not available". Two independent breakages in one
  request, and stopping at the first would have shipped a call that still could
  not work. The fix was a SHAPE: `CapMVRVCur` is the same ratio as one metric
  instead of two, and one metric is one thing that can be revoked.
- **THE GATE MUST NOT DIE PRINTING A FAILURE, AND THE FIX BELONGS ON THE
  STREAM.** `verify.py` crashed with `UnicodeEncodeError: charmap` on the line
  naming which script test failed, replacing a real failure with a traceback
  about a box-drawing character. Third time in this codebase — and the previous
  fix was applied at a PRINT, which is why a different print brought it back.
  `sys.stdout.reconfigure(encoding="utf-8", errors="replace")` at the top of
  `main()` covers every print there will ever be; a character the console cannot
  draw then costs a `?`, never the message.
- **A STORE WITH A WRITER AND NO READER IS THE SAME SHAPE AS A LOOP WITH NO
  WRITER.** `db_wallets` had a POST to fill it and no GET to read it back, so
  the list the alert loop watches could not be seen anywhere in the product. And
  `onchain_seen` had neither — 40 rows of real data and no route at all. When
  adding a store, grep for the READER as well as the writer.
- **A GUARD THAT PINS ABSOLUTE POSITIONS FAILS FOR THE WRONG REASON.**
  `dockpanels.test.ts` asserted twenty indices, so adding two panels moved
  `evidence` from 18 to 20 and broke a test called "puts each section heading
  directly before its first panel" — about section headings, failing over
  arithmetic. That teaches the next person to renumber rather than read. State
  the RELATIONSHIP (a heading is followed by a panel of its own section) and it
  survives every addition while still catching the defect it exists for. Sibling
  of "a guard test that pins a COUNT fails on addition and passes on
  substitution".
- **AN OPAQUE KEY MUST BE PARSED BY A FUNCTION THAT REFUSES.** `onchain_seen`
  stores `np:chain:address` as one string, and the screen needs two fields from
  it. A split that guesses puts the chain in the address column and NOTHING
  looks wrong, because an address is opaque to the reader too. `split(":", 2)`,
  not `split(":")` — otherwise `np:cosmos:ibc:27394FB` silently loses its tail —
  and reject anything not shaped as expected rather than repairing it.
- **A LINK BUILT FROM A PATTERN IS A CLAIM.** An explorer URL guessed for a
  chain nobody mapped sends the operator to a 404 that reads as "this token does
  not exist" — worse than no link, because it looks like information. Return
  null and render plain text.
- **AN ASSUMED COST IS NOT CONSERVATIVE, IT IS WRONG IN A DIRECTION.**
  `DEFAULT_COSTS` charges a flat 2bp spread; MEASURED against this operator's
  broker that is 4.7x the real spread on XAUUSD, 3.8x on EURUSD and 2.8x on
  BTCUSD. Because costs set the hurdle a search must clear, overcharging does
  not make results safer — it DISCARDS rules that would have cleared the real
  spread, silently, and nothing on screen says why. Undercharging is worse in
  the other direction: it manufactures edges that were never tradeable. The two
  are not symmetric and must not share a colour. Ask the broker rather than
  assuming, show both numbers, and do NOT let the measured one silently replace
  the assumption — a figure that moves under the operator because a service
  answered is worse than a disagreement they can see.
- **A BACKLOG NUMBER THAT ARGUES WITH ITSELF IS NOT A BACKLOG.** The uncalled-
  route bullet had grown by accretion over six releases — every wiring appended
  a clause — until it stated "26" and then spent a paragraph explaining which of
  the 26 did not count. Itemised with a reason per route it came to: 4 not fetch
  targets, 4 deliberately dead, 4 whose store is empty, 3 destructive, and **10
  that are real work**. The number was overstating by 2.5x. When a count has to
  be qualified every time it is quoted, replace the count with the list.
- **A LIVE DEFAULT IS THE OPPOSITE OF AN INERT ONE, AND A TEST FOUND IT AGAIN.**
  `startBackup`'s transport defaulted to the real `pushBackup`; under vitest the
  global `fetch` reaches the running gateway, so a SCHEDULING test POSTed two
  fixture slots over the operator's thirteen real ones. This file already
  records the same arrival through `createHistory` and already states the rule —
  make reaching a real store something a caller OPTS IN to — and a default that
  is live is precisely what that rule forbids. The fix is a signature: NO
  default, so `mountShell` passes the transport explicitly and every test passes
  a stub. There is then no spelling of the call that touches the network by
  accident, which a default can never promise.
- **A DEBOUNCE WITH NO CEILING IS AN OFF SWITCH under continuous load.** Every
  KV write cancelled the pending backup and rescheduled it, and this terminal
  writes constantly, so the deadline was pushed out for as long as anyone was
  using the product. It fires in a genuine quiet period, which is what makes it
  hard to see. Set a ceiling timer on the first write of a quiet period and
  NEVER cancel it. Same family as the rolling window that could never expire:
  a mechanism whose trigger is reset by the activity it exists to capture.
- **A TEST FOR A SCHEDULING BUG CAN BE SATISFIED BY THE WARM-UP.** The ceiling
  test passed with the ceiling DELETED, because the 15s boot push fired on the
  first tick and satisfied the assertion before the continuous-write path was
  ever reached. Delete the fix and watch the test fail BEFORE believing it —
  "an audit script that parses nothing reports success", in the test written to
  catch the defect.
- **THE SAME CLASS DECLARED TWICE IN ONE SHEET IS INVISIBLE TO A CROSS-SHEET
  AUDIT.** `.cal-row` was the economic calendar's five-column grid at line 522
  of `desks.css` and the calibration card's four-column grid 1,280 lines later;
  the later won, so MEASURED in the browser a calendar row had five children on
  four tracks, its fifth wrapping and an 82px time column squeezed into 48. That
  is the `.sy-` defect — "the desk rendered in another desk's clothes" —
  arriving where `classcollide.py` structurally cannot look, because it compares
  prefixes ACROSS sheets. `scratchpad/cssdupe.py` asks the other question, and
  the narrowing matters: only TOP-LEVEL rules setting the SAME property to
  DIFFERENT values. Flagging every redeclaration reported correct composition
  and ten `@media` overrides, which is how a checker teaches people to ignore it.
- **A SWEEP FOR A DEFECT CLASS WILL BE MOSTLY FALSE POSITIVES, AND THE
  ALLOWLIST MUST CARRY THE REASON.** Four of seven findings were correct as
  written: a keyboard sequence timeout SHOULD reset per chord, a poll loop that
  reschedules from its own completion always fires, a fragment built from text
  is not a reactive list, and `<option>` elements cannot throw on data. Recording
  them with the reason is what keeps the sweep runnable; an allowlist without
  one is a way to silence a tool rather than to answer it.
- **A COMMENT DESCRIBING A CONTROL IS NOT A CONTROL, AND IT STOPS ANYONE
  LOOKING.** `shell.ts` said the trial mirror "pushes when the operator asks,
  from the Learning desk". Nothing asked — `edge.push` had no caller anywhere in
  `app/src` — so `trials` could never fill, `/svc/edge/kinds` answered empty
  forever, and the conditional-edge read the Knowledge desk exists to show had
  nothing to read. The comment was the reason the gap survived: it reads as a
  design decision that was implemented. Same family as "a comment naming the
  component that is supposed to do something is not evidence that anything does
  it", and the way to find it is to grep for the CALLER of the method the
  comment describes.
- **"THE STORE IS EMPTY" IS A CLAIM ABOUT THE WRITER, NOT THE READER.** Three
  routes sat in the backlog as "nothing to show yet". Following one found the
  writer existed, was correct, and was unreachable. Before filing an empty store
  under "wire it when there is data", check that anything can PUT data there.
- **AN AUDIT NOBODY RUNS IS A ONE-TIME FINDING, NOT A GUARD.** Four audits were
  written this session, each after a real defect, and all four sat in
  `scratchpad/` where nothing ran them — the same mechanism that hid nineteen
  test files and left `run.py` linted by nothing. `tests/test_audits.py` now runs
  the deterministic ones on every gate and **fails on a ZERO as well as on a
  finding**, because a checker whose pattern has stopped matching reports a clean
  tree. A second test asks whether every script in `scratchpad/` is gated or
  excluded by name with a reason, which is `tests/ fully listed` applied to the
  checkers themselves; its first run found nine unaccounted files. One-shot edit
  scripts live in `scratchpad/applied/` so that question stays answerable.
- **A SLOW-MOVING RESOURCE FETCHED ON EVERY CYCLE GETS YOU RATE-LIMITED, AND THE
  INTERVAL IS ONLY HALF OF IT.** `data_calendar` had 42 429s asking a vendor for
  a WEEK'S calendar hourly — and `collect()` runs the instant the process starts,
  so every restart is another fetch with no interval at all. A module-level timer
  cannot fix that, because it dies with the process; read freshness from the
  STORE. `is_fresh` treats "never fetched" as STALE (or a new install never
  fetches) and refuses a FUTURE timestamp (or a backwards clock pins a feed as
  fresh for ever).
- **A GUARD THAT CHANGES CONTROL FLOW BELONGS INSIDE THE BLOCK IT GUARDS.** An
  early `return` above one leg of `collect()` broke the structure every leg
  depends on — "D8-D14 each open with their own try, so one dead feed never
  kills the rest" — and its test caught it. Put the skip inside the `try`, where
  it cannot reach anything else.
- **A RULE THAT LIVES IN PEOPLE'S HEADS OPENS A NEW DOOR EVERY TIME.** "No test
  may touch the operator's real data" has been broken SIX times through THREE
  doors: four files missing `MISHEL_SVC_DB`, `createHistory` defaulting to the
  real bars client (535 fixture candles into the archive backtests read), and
  `startBackup`'s transport defaulting to the live one (a SCHEDULING test
  overwrote thirteen real settings slots). Every fix was correct and local, and
  the next door opened anyway. `tests/test_no_live_store.py` is the rule as a
  gate, checked at SOURCE level — a runtime guard fires after the write, when
  the operator already has a corrupted row.
- **STRIP PROSE, NOT LITERALS, WHEN THE THING YOU SEEK IS A LITERAL.** That
  guard's first version matched raw source and accused a correct file on its
  DOCSTRING; its second stripped every string and then **could not catch a
  database path, because a path IS a string literal**. Same shape as stripping
  `"POST"` from a sweep for modules that POST — twice in one session, in two
  different tools. Strip triple-quoted prose and comments; keep the arguments.
  And PROVE a guard against the defect it exists for before trusting it.
- **THREE RUNS OF THE SAME PAGE GAVE FCP OF 1,224ms, 3,356ms AND 3,096ms.** A
  2.7x spread with no code change between them, in a tab `tabs_context` reported
  as active with the pane displayed, and `first-raf` at 2,082ms — starved frames
  being the signature of a tab that is not composited. The variance IS the
  finding: **boot timing cannot be measured through the preview pane**, which
  this file already says about FCP and pane visibility. What CAN be measured
  there is code that times itself: `mountShell` is 157ms, timed around its own
  call, and that retires the obvious suspicion about boot cost. Measure what the
  page reports about ITSELF; distrust what the pane reports about the page.
- **Three manifests of one build.** `tests/run_tests.sh` carried its own list of
  17 python entries beside `verify.py`'s, and had already drifted by five files.
  It now delegates the live tiers to `verify.py` and keeps only the 76 legacy
  node files. `run_tests.sh.bak`, a 311-line stale copy, is gone.

- **A KEY WRITTEN BY ONE SIDE AND READ BY THE OTHER MUST BE THE SAME KEY.**
  `/svc/mt5/sync` stored a contract spec under the BROKER's name — JustMarkets
  quotes `XAUUSD.s` — and `/svc/risk/size` looked it up under the canonical
  one. MEASURED: `specs stored ['BTCUSD.S']`, `lookup "BTCUSD"` MISS. So a
  successful sync still left sizing unable to find anything, on every broker
  that suffixes, and the route answered 200 with a sentence advising a sync that
  had just run. File it under BOTH (`spec_keys`) at the boundary where both
  spellings are known; teaching every call site to try two is the
  find-every-consumer trap. And make the suffix an EXPLICIT SET, not a shape —
  matching any short trailing `.X` turns the real ticker `BRK.B` into `BRK` and
  sizes a different company.
- **A DERIVED SET IS THE SET YOU NO LONGER NEED.** The spec sync collected
  symbols from DEALS, so a fresh account got no specs — and an operator who has
  not traded a market yet is exactly the one who needs sizing for it. The same
  shape as a top-up that only refreshes what is already deep. Ask what the
  operator is about to need, not what they have already done.
- **TWO SIZERS IN DIFFERENT UNITS DO NOT DISAGREE BY COMPARING THEM.** The Risk
  desk sizes in the INSTRUMENT'S OWN UNITS with a notional cap; the server sizes
  in LOTS from the broker's contract spec with no cap. My first cross-check
  compared `0.118499` against `0.0036` and reported a 33x disagreement — there
  was none: 0.0036 lots IS 0.36 ounces, which is the desk's own UNCAPPED answer.
  They agreed on the arithmetic and differed on a cap, and the number comparison
  hid both facts. **Compare the MONEY AT RISK** — the one quantity both express
  the same way — and print each side's figure with its unit named. Committed
  while wiring the very route that exists to stop gold being sized 1000x wrong,
  which is how easy this is.
- **A STATUS PAGE THAT LISTS THE JOBS BUT NOT THE CHANNEL THEY SPEAK THROUGH
  OMITS WHETHER ANY CAN BE HEARD.** The alert loop, the signal loop and the
  dead-man's-switch heartbeat all send through `/svc/notify`, which had no
  caller — so every one of them fired into nothing while the System desk showed
  twelve green dots. A secret collected for this goes to the operator's own
  server and never into the browser (a token in browser storage is a token in
  every backup of a profile this product backs up): password input, sent once,
  cleared on success. And say what a passing test does NOT prove — a token
  revoked next week fails inside a loop at 3am, so a green tick means "it worked
  when you pressed it".
- **BEFORE BUILDING A CARD, RUN `scratchpad/classcollide.py`.** It refused the
  `.gov-` prefix on a governor card I had just written, because `card-gov.css`
  already owned it AND imports last — and `ui/cards/govcard.ts` had existed all
  along, mounted in the dock as "Can I trade now?". That is also why
  `/svc/risk/state` was NOT in the uncalled-routes list while `check` and `size`
  were: **read the orphan list closely enough to notice which sibling routes are
  missing from it**, because that is the one that tells you a surface already
  exists.

- **A FUNCTION THAT RETURNS A TUPLE, READ AS A LIST, IS A LOOP THAT DOES
  NOTHING AND SAYS NOTHING.** `yf_bars` answers `(rows, reason)`. `bars_loop`
  did `rows = yf_bars(...)`, so `rows` was the tuple; `if not rows` is never
  true for a two-element tuple; and `_clean` skips a row it cannot read BY
  DESIGN, so it returned `[]` without raising. MEASURED: `_clean((rows, None))`
  stores 0 and `_clean(rows)` stores 5. No exception, no `log_event`, a fresh
  `last_tick_age_s` and a green dot — **the success path and the failure path
  were byte-for-byte identical from outside**, which is why the hourly top-up
  had never stored a single bar for any series in its life. A per-item `except:
  continue` is the right shape for dirty data and it will swallow a caller that
  passed the wrong thing entirely; pair it with a caller that UNPACKS.
- **A TOP-UP CANNOT CARRY A SERIES OVER A FLOOR SET BY SOMETHING ELSE.** 300
  bars an hour never reaches the autonomous loop's 800-bar minimum, so a market
  could be enrolled, topped up on schedule, reported healthy, and stay
  permanently unstudiable — 18 of 22 enrolled series were in exactly that state.
  The FIRST fill is deep and every fill after it is a top-up. When one component
  gates on a number another component has to reach, IMPORT the number rather
  than copying it (`_floor()` reads `svc.auto.MIN_BARS`), or the two drift and
  the gap is invisible from both sides.
- **A CAP THAT ALWAYS FALLS ON THE SAME MEMBERS MAKES THE REST DEAD WEIGHT.**
  `subjects()` returned the richest series first and took six. Once the archive
  actually filled, 34 (market, bar size) pairs qualified — so the loop would
  have studied the same six forever and 28 markets the operator holds history
  for could never be studied at all. Bound a pass by all means; order it by
  LEAST RECENTLY DONE, so everything is covered in `ceil(n/cap)` passes and a
  newly downloaded market is next rather than last.
- **A HARDCODED MAP OF A VENUE'S SYMBOLS IS WRONG THE WEEK IT IS WRITTEN.**
  `binance_symbol` held seven `XXXUSD -> XXXUSDT` pairs and returned None for
  Binance's OWN native tickers, so the proxy could not fetch a single series it
  had stored: BTCUSDT, ETHUSDT, SOLUSDT, FILUSDT and ONDOUSDT all refused while
  the alias BTCUSD returned real bars. Match the venue's SHAPE (anything ending
  in a quote asset it lists) and keep the alias for the terminal's canonical
  form — but keep the refusal too, because Binance lists EURUSDT and passing
  EURUSD through would return real bars for a different market, which is worse
  than a refusal.
- **A SYMBOL THE CLIENT CAN ENROL AND THE SERVER CANNOT RESOLVE HOLDS ZERO
  FOREVER.** `MACRO_SPINE` enrols SPX and VIX; `YF_MAP` had neither, and an
  unmapped symbol falls through to itself. yfinance has no ticker called "SPX",
  so four series were asked for hourly, answered "no data from vendor" every
  time, and showed 0 bars while the loop reported a fresh tick. When one side
  names a set of instruments, the other side's map needs a line for every one.
- **AN AUDIT THAT WALKS `build/venv` REPORTS SOMEBODY ELSE'S DOCUMENTATION.**
  `scratchpad/routes.py`'s first run read 7,789 Python files and listed
  FastAPI's own docstring examples — `/items/`, `/users/me`,
  `/send-notification/` — as uncalled routes of this product. Exclude vendored
  trees explicitly, print the file count, and read the first few findings before
  believing any of them. (Route backlog re-measured: **33 of 93**, from "28 of
  74" in v60.7 and "36 of 48" in v58. It goes stale every release — run the
  script.)
- **PROBE A SERVICE FOR WHAT IT COMPUTES, NOT FOR WHETHER IT ANSWERS.**
  `scratchpad/probe.py` GETs every route and reports the body's own `ok` field
  as well as the status, because CLAUDE.md already records a Quant desk that was
  dead while reporting nineteen libraries present. Its own false positives are
  worth knowing: `/` and `/legacy` serve HTML by design, and a 404 from `/ohlc`
  for a symbol the DEFAULT vendor does not know is an honest refusal. Only POSTs
  are skipped, and they are COUNTED as skipped — a probe that quietly narrows is
  the defect it exists to find.

- **A FETCH THAT WRITES TO A STORE MUST BE FOLLOWED BY A READ OF THAT STORE.**
  `history.backfill` returns a COUNT and writes the bars it fetched into the
  archive. The Playbook loaded, saw it was short, backfilled — and ran the
  backtest on `hist`, captured BEFORE. MEASURED: three consecutive runs with
  identical inputs gave **156, then 480, then 480 trades**, and on a market
  holding four days against a four-year request the first run had too few bars
  to produce any trade at all. That is what "the backtest is broken, always 0"
  looks like from outside. **Nothing could have caught it** — a backtest that
  runs on fewer bars and reports fewer trades is indistinguishable from a
  strategy that traded less: no refusal, no error, and a verdict that correctly
  called the result unproven. The fix is `loadForPlan`: load, backfill ONCE,
  read it back. Its first test asserts the call ORDER, because the defect was an
  absent third call and no assertion about the returned shape would have shown
  it. **Run the same thing twice** — a figure that changes between two identical
  runs is a figure computed from state somebody forgot to re-read.
- **A RESULT THAT NAMES THE WINDOW IT ASKED FOR IS NOT NAMING THE WINDOW IT
  RAN ON.** The Playbook printed `planLine(plan())` — the REQUEST — beside a
  trade count computed on whatever arrived: "1,598 bars" over a run that had
  999. Both halves were honest on their own and the pair was a claim about a
  different question. Report the count the engine was actually handed, and say
  so when a vendor could not reach as far back as the plan wanted.

- **A BROWSER FILTERS A `<datalist>` BY WHAT IS ALREADY IN THE BOX, so it is
  the wrong control for a PRE-FILLED field.** Opening the list on a field
  reading "XAUUSD" offers one row: XAUUSD. MEASURED before touching anything:
  131 options in the DOM, the list correctly bound, and the browser hiding 130
  of them — "it only shows XAUUSD" is exactly what that looks like, and no
  attribute turns it off. Use `ui/symbolpicker.ts`, which has existed since v50
  for this same complaint: it opens on the whole list whatever the box says,
  narrows as you type, commits on Enter or a row click, and restores on Escape.
  **Before building a control, check whether the chart already has one** — the
  operator has learned it, and a second one will differ.
- **TWO BINDINGS THAT ARE EACH CORRECT CAN STILL PRINT THE SAME SENTENCE
  TWICE.** `planLine(p)` returns `p.why` verbatim for a REFUSED plan, and the
  Playbook rendered `planLine(plan())` above `plan().why` — so a refusal said
  "the archive holds no XAUUSD 15m to run on", then said it again. Neither
  binding was wrong; the pair was. Duplication reads as a fault in the thing
  being described. Pin the relationship in the test for the FUNCTION
  (`planLine(p) === p.why` when refused) rather than in the desk, because the
  next caller will pair them the same way.
- **A COMMIT-ON-ENTER CONTROL BREAKS EVERY CALLER THAT HAS ITS OWN BUTTON.**
  Moving the symbol boxes to a picker that commits on Enter or a row click —
  correctly, since `change` fires on blur and once committed a half-typed `ETH`
  — silently broke the Briefing's "+ add", whose handler reads a draft signal
  nothing updated any more. `today.test.ts` caught it. A button is a THIRD
  commit path beside Enter and a click; a shared field needs an optional live
  hook for the callers that have one.

- **A FIELD THAT ASKS YOU TO TYPE SOMETHING THE PROGRAM CAN ENUMERATE IS A
  FIELD NOBODY CAN USE WITHOUT ALREADY KNOWING THE ANSWER.** The Playbook's
  Market box was an `<input type="text">` hinted "Any series the archive holds"
  — on a desk that was already fetching the whole inventory to size one series
  and discarding the rest. `scratchpad/freetext.py` read 122 UI modules and 80
  `h("input")` elements and printed all 32 free-text fields WITHOUT judging
  them, because a heuristic cannot know whether a vocabulary exists: a note is
  open-ended and a market is not. Six asked for a symbol; five now suggest.
- **SUGGEST, DO NOT ENFORCE — a `<select>` here would delete a feature.** The
  obvious fix for a symbol box is a dropdown, and it would undo "THE ARCHIVE IS
  WHAT YOU HAVE, NOT WHAT YOU CAN GET": the Playbook deliberately accepts a
  market it does not hold and reaches back for the history, and clipping the
  request to the archive was a defect fixed on purpose. A `<datalist>` shows
  what exists and still accepts anything — VERIFIED by typing a symbol in
  neither the archive nor the catalogue and getting an honest refusal from the
  plan rather than a control that could not express it. What is HELD leads, with
  what is held; one row per SYMBOL and not per series, because a symbol at three
  bar sizes from two vendors is one thing you can type.
- **A `<datalist>` HAS TO LIVE IN THE DOCUMENT, SO IT COMES WITH A WRAPPER, AND
  A WRAPPER BREAKS TWO THINGS THIS FILE ALREADY NAMES.** It becomes the FLEX
  ITEM, so `.risk-add .field-input { width: 130px }` and `.wl-add .field-input
  { flex: 1 }` stop applying and the field collapses inside a row that still
  looks laid out — the `.sym-picker`/`.dd-input` trap from a third direction,
  where a wrapper REPLACES its child rather than failing to constrain it. And
  it takes the `id`, so a `<label for>` points at a span and silently stops
  focusing the box. `display: contents` on the wrapper fixes the first; setting
  the id on `querySelector("input") ?? el` fixes the second. Measure the input's
  width and the label's target, not the markup.
- **A BACKTICK INSIDE A DOUBLE-QUOTED BASH STRING IS A COMMAND.** `"`symbolField`
  returns a span"` ran `symbolField`, printed "command not found", and wrote the
  comment with three words missing — a silent partial write, not a failure. Same
  family as the shell-quoted heredoc that turned `` into a backspace. The rule
  is unchanged and now has a third instance: write it to a FILE and run the file.

- **A CHART WITH A PER-SERIES SCALE IS A LIE THAT LOOKS EXACTLY LIKE THE
  TRUTH.** A wrong number in a table is something a reader catches; a wrong
  SCALE is plausible, unlabelled and not red. Overlaying twenty-five equity
  curves is only honest on ONE shared domain — scaled to its own range, a rule
  that made five dollars draws the identical line to one that doubled, and the
  chart whose entire purpose is "is the winner separated from the field"
  answers yes every time. `ui/cards/plot.ts` owns that arithmetic as pure
  functions with the traps pinned: a flat axis is PADDED rather than divided by
  (NaN in a path is dropped silently and draws as nothing, which reads as
  broken rather than as flat), a drawdown can never be positive, zero is always
  in frame on a chart where zero is the thing being compared to, and y is
  flipped exactly once.
- **A SEARCH MUST BE CHARGED FOR ON THE SCREEN THAT SHOWS ITS WINNER, and the
  units are the whole risk.** The Simulation desk carried "the best of
  twenty-five is the best of a SEARCH" as prose and did not price it. MEASURED
  once it did: **5 of 6 best-in-market rules do not survive**, and the one that
  clears does so by 0.037 on thirteen trades. `study/stats.ts` `deflatedSharpe`
  is defined on a PER-TRADE Sharpe and takes a trade count; `metrics.sharpe` is
  ANNUALISED, and mixing them is the defect this file already records turning
  4.93 into a fiction. So `computeMetrics` gained `perTradeSharpe` as a
  SEPARATE field rather than leaving callers to convert between units they
  cannot see — and the count of tries includes the rules that were REFUSED,
  because a field that silently shrinks lowers the hurdle without telling
  anyone.
- **A GRID DOES NOT COMPLAIN ABOUT EXTRA CHILDREN — IT WRAPS THEM ONTO A NEW
  LINE, and that looks like a design.** Two columns were added to a table and
  the `grid-template-columns` was left at six, so both dropped under every row
  and the header rendered as two headers. Nothing failed and `tsc` cannot see
  it. Count the cells against the template when adding one, MEASURE the header
  (one line, 24px), and let a table that no longer fits SCROLL rather than
  reflow: a number that has moved to another line is a number in the wrong
  column.
- **INFINITY IS A BUG; NaN IS A REFUSAL.** A long-standing test asserted no
  metric was non-finite, on a ONE-TRADE run — and one trade has no measurable
  spread, so a per-trade Sharpe is genuinely undefined there. The test was
  asking a real question and the answer was to SHARPEN it, not weaken it: no
  field may be Infinity, which is a division that ran away and carried on, and
  a field that cannot be computed says NaN, which every formatter here already
  renders as an em dash. Returning 0 instead would read as "measured, and no
  edge", which is a different claim.
- **A COUNT OF BARS IS A NUMBER NOBODY CAN WEIGH.** "936 bars under water" is
  thirty-nine days at 1h and six months at 4h, and only one of those changes a
  decision. Convert through the SERIES' own bar size at the point of display —
  and pass the timeframe in rather than letting `intervalMs` default, because
  it answers one hour for anything it cannot read and a silent default would
  quietly rescale the one figure the conversion exists for.

- **AN EQUITY CURVE IS A MULTIPLIER, AND MULTIPLIERS NEVER REACH ZERO.**
  Risking 1% of a shrinking balance still leaves something after the
  two-hundredth loss, so a backtest reports an account that a broker would have
  closed months earlier — and every recovery after that point is imaginary. It
  is the most flattering error available and nothing in the metrics shows it:
  expectancy, profit factor and win rate are all still correct.
  `backtest/account.ts` replays the trades against a real balance, stops at a
  ruin floor, and COUNTS the trades the account never lived to take, because
  silently doing less than the run contained is the same shape as a study whose
  dead vendors vanished from its reported window. Risk is sized on the balance
  BEFORE the trade — sizing on the balance after uses the trade's own result to
  decide how big it was.
- **DOWNSAMPLING A CURVE MUST KEEP ITS EXTREMES.** A chart wants a few hundred
  points from forty thousand bars, and every-nth sampling loses the peak and the
  trough — the distance between those two IS the drawdown, the one number that
  decides whether anyone could have sat through the run. `curvePoints` keeps
  each bucket's highest and lowest; its test buries a spike and a crater
  mid-series and requires both to survive.
- **A SECOND KIND OF WORK IS A NEW JOB MODE, NOT A SECOND ENGINE.** The
  autonomous loop needs the candidate ledger the Playbook builds, and writing it
  again in Python would have been its own fill model and its own warm-up, with
  no way to tell which a strategy's expectancy had been measured with the first
  time they disagreed. `backtest/headless.ts` gained `ledger` and `catalogue`
  modes and `lab_worker.mjs` dispatches on `mode`; a job with no `mode` is a
  study and is byte-for-byte what it always was, because `lab.py` and its tests
  describe that format. An UNKNOWN mode is refused by name rather than falling
  through to a study.
- **A CATALOGUE THAT RETURNS LABELS CANNOT BE ACTED ON.** `specCatalogue` first
  returned `{id, name, style}`, so a caller listing the rule library had nothing
  it could RUN — found by driving the worker directly before anything depended
  on it, which answered "spec.style must be a non-empty string" on the first
  attempt. It returns whole specs now, and `specId` resolves a shipped rule
  server-side so a caller sends an id rather than a copy that can drift.
- **`h()` MAKES HTML ELEMENTS, SO AN `<svg>` BUILT WITH IT RENDERS NOTHING.**
  The element has the right tag name, sits in the DOM, reports a box, and paints
  nothing at all, with no error anywhere. `createElementNS` is the route
  `icons.ts` and `watchrail.ts` already take. And REMOVE an empty `d` rather
  than setting it to `""`: an empty path attribute is a parse error in some
  engines and nothing in the rest, and "no data" and "a line at zero" are
  different facts.
- **A DESK THAT OPENS ON A DEFAULT MUST MATCH THE WHOLE SUBJECT.** The
  Simulation desk matched the chart's SYMBOL and ignored its bar size, so with
  the chart on BTCUSDT 1h it opened on BTCUSDT 1d — a different series with a
  different base rate, under a hero reading "$537.57" that named neither. A bar
  size is half of what a series IS. Name the subject in the panel that reports
  the figure, and fall back in order: exact, then symbol, then first.
- **A CLASS BORROWED FROM A NEIGHBOURING BLOCK VANISHES WITH THE NEIGHBOUR.**
  The Playbook's sample-loss note wore `.pb-cal-note` because it sat beside the
  calibration curve; when the curve moved to a shared card its classes went with
  it and the note lost its styling silently. A block gets a class from the panel
  that OWNS it. (And grep for the class before declaring it gone — `pb-cal`
  turned up once more in a comment, which is rule 2 of Working style again.)
- **A PYTEST THAT LOADS ONE `svc/` MODULE NEVER APPLIES THE SCHEMA.** `init()`
  is called by `mishel_service` on import, and a test reaching for `svc.auto`
  alone gets a connection to a database with no tables. Fourteen tests failed
  with "no such table: bars" on their first run, which is the honest way for
  that to be found — but a test that happened to read rather than write would
  have passed on an empty table and proved nothing.

- **A `computed` HERE IS EAGER, so it cannot be written above what it reads.**
  `core/signal.ts` builds it as `effect(() => out.set(fn()))`, and an effect
  runs at once — so a computed naming a `const` declared further down throws a
  temporal-dead-zone ReferenceError at construction, `effect` catches and logs
  it, and the computed holds `undefined` for the life of the page. Two of them
  sat above `all` and `current` in `ui/playbook.ts`: the first was `undefined`,
  the second threw again on `"spec" in undefined`, and `run()` — which opens
  `const spec = effective(); if (!spec) return;` — returned before its first
  line of work. MEASURED with a MutationObserver over the desk: **zero
  mutations on click**. No note, no error on screen, no disabled button, and the
  desk's two newest features both dead while it looked entirely normal. `tsc`
  cannot see it: naming a later binding in a closure is legal, and normally the
  closure runs later too. Fix the ORDER, not the symptom — catching `undefined`
  downstream leaves the computed broken and hides it better. `scratchpad/tdz.py`
  sweeps all 205 eager calls; `signal.test.ts` pins both halves.
- **AN UNDEFINED CUSTOM PROPERTY IS NOT AN IGNORED DECLARATION — IT INHERITS.**
  `var(--x)` with no definition and no fallback makes the whole declaration
  invalid at computed-value time, so the property takes its inherited value and
  the result looks like a design decision. Nine names were read and defined
  nowhere. MEASURED: `--lh-relaxed` (38 reads) left every refusal and verdict
  block typeset by its parent; `--buy` left `.trust-dot[data-trust="confirmed"]`
  at `rgba(0,0,0,0)`, an invisible dot whose whole job is showing trust; and
  `--text-dim` left the news timestamp at full `--text`, as bright as the
  headline above it. Nothing could catch it — `tsc` does not read CSS and no
  test opened a stylesheet. `app/test/tokens.test.ts` is the guard, and it reads
  the TYPESCRIPT too, because `quantdesk.ts` sets `--f` inline per bar and an
  audit that called that broken is one nobody reads.
- **A `<select>` HANDED A VALUE OUTSIDE ITS OPTIONS SHOWS THE FIRST ONE AND SAYS
  NOTHING.** The Playbook's bar-size control displayed "5m" while the plan under
  it refused on "3m": the chart was on 3m, the desk took that as its default,
  and 3m is not one of the five sizes offered. Neither half was wrong on its own
  — the select was right about its options and the plan was right about the
  value it was given — and a control that shows one thing and runs another is
  worse than one that refuses. Constrain the value to the offered set
  (`nearestTimeframe`, nearest by duration on a LOG scale so 2h does not always
  fall to 1h), and parse the input rather than trusting `intervalMs`, which
  answers one hour for `""` and for `"banana"`.
- **A RUNNING SUM IS POISONED FOREVER BY ONE NaN.** `sma` did `sum += src[i]`,
  and every indicator in that file begins with NaN, so the mean of an INDICATOR
  was NaN for the whole series, for any series, silently — indistinguishable
  from "too short to average". Nothing in the product hit it (`bollinger`
  averages CLOSE) but `script/sandbox.ts` hands `sma` to user scripts, where
  averaging an indicator is the obvious thing to do. Count the holes separately
  and answer NaN only while the window holds one.
- **NO PRICE LEVEL IN A FEATURE SET, EVER.** A tree handed `close` learns the
  YEAR: 2021 and 2024 are separable by price alone on BTCUSDT, both were strong,
  and the model scores well out of sample until it meets a price it has never
  seen, where every split evaluates on the wrong side. It is also
  untransferable — a router trained on BTC can say nothing about XAUUSD, where
  2,600 is below every threshold it holds. `backtest/features.ts` emits ratios
  and bounded oscillators only, with distances in ATR rather than percent
  because percent is itself regime-dependent. And PROVE the causality rather
  than asserting it: `features.test.ts` computes the matrix over a prefix and
  over the full series and requires the shared rows to be IDENTICAL, not close.
- **AN AUDIT SCRIPT MUST OBEY THE RULES IT ENFORCES.** `tdz.py` took four passes
  to stop lying, and every failure is already in this file. Same indentation is
  not same scope (a callback parameter `r`); an object KEY is not a read
  (`studies: state.studies()`); a name the body DECLARES is shadowed, not
  forward; and it counted identifiers inside STRING LITERALS, so "Describe the
  idea" read as a reference to `const idea` — rule 2 of Working style, broken by
  the tool written to enforce rule 2. Then its stripper blanked newlines with
  everything else and every line number it printed was wrong by hundreds. **A
  tool that reports the wrong location is worse than one that reports nothing,
  because somebody goes and looks.**
- **A MODEL THAT LEARNED NOTHING IS A RESULT, NOT AN ERROR.** "No skill" is the
  most common honest answer a router can give, and a client or a panel that
  renders it as a failure teaches the operator to ignore the one thing there
  that is reliably true. `data/router.ts` keeps three outcomes — a report (which
  may itself say `skill: false`), a refusal with its reason, and a service that
  is not answering — and the panel gives each its own state. The training set is
  the CANDIDATE LEDGER and never the trade log: a backtest skips a signal while
  a position is open, so the trade log is a SELECTED sample and a model fitted
  to it learns the selection rule.

---

## Do not

- Do not rebuild the binary while it is running. It holds its own output file
  and PyInstaller fails with `PermissionError: [WinError 5] Access is denied`.
  Check the timestamp afterwards, and check the PROCESS LIST first — a one-file
  PyInstaller binary is **two** processes: the bootloader you started, and the
  child it spawns after unpacking. Killing the one whose PID you have leaves the
  child alive and holding the exe, which is exactly how this build failed:
  `Stop-Process` on pid 9868 succeeded and pid 11836 went on holding the file
  for four minutes. `Get-Process | Where-Object { $_.ProcessName -like '*iram*' }`
  is the check. Renaming the exe SUCCEEDS while it is running — Windows blocks
  overwrite, not rename — so a rename test proves nothing.
- Do not touch `index.html`, `src/`, `tools/` or `dist/` at the repository root —
  that is frozen v39. See `LEGACY.md`.
- Do not claim a measurement taken through the browser preview pane when the
  pane's visibility changed during the run. First contentful paint then reports
  when the pane appeared, not what the page cost.
- Do not run `ruff --fix` and report the gate passing as the proof. The gate
  covers the tests; it does not cover a removed import in a module no test
  reaches. Import every backend module.
- Do not hand-write the type of a dependency when the real one can be imported
  or derived. Three separate defects came from a stub that satisfied the call
  site and then disagreed with the definition: `studies` as `readonly string[]`
  when it is a computed record, a fundamentals store narrowed to `{ find() }`,
  and an account stub of `{}`. Prefer `ReturnType<typeof x>`, and let the
  return type be inferred.
- Do not write a test whose expected value comes from the code under test.
  `expect(reason).toContain(QUANT_BASE)` passed for months on a URL that could
  never resolve, because both sides were the same broken expression. Assert the
  literal, or parse the result: `new URL(url).pathname`.
- Do not add a launcher. There is one: `run.py`. `run.sh`, `run.bat` and
  `run.command` are wrappers that find Python and must stay that way — nine
  entry points is how two of them came to start a backend layout the frontend
  had stopped being able to address.
- Do not assume a rule inside a media query overrides one outside it. A media
  query adds NO specificity. Write the narrow rule with the same attribute
  selectors as the rule it has to beat, and MEASURE in the narrow state — this
  has now bitten twice in the same block, and the second time was one line
  from the first.
- Do not write a literal duration in a `transition`. Read a `--dur-*` token, or
  `prefers-reduced-motion` cannot switch the animation off.
- Do not use `+` or `~` for spacing inside `.dock-body`, or any container whose
  children are reordered with CSS `order`. DOM adjacency is not visual
  adjacency there. Put the space on the element as a margin.
- Do not keep a readout that duplicates something the browser already draws.
  The inspector's "screens of scroll" restated the scrollbar thumb, needed an
  observer per panel to stay in step, and was wrong by 2.8x for want of one.
- Do not call a UI change done because the DEV SERVER shows it. The owner
  runs `python run.py` (the gateway serves `app/dist/index.html`) or the
  packaged exe (its own copy, built by `server/build_binary.py`). v59.1 and
  v59.2 were verified on :5173 and reported built; `app/dist` was from the
  night before and both exes from ten days earlier, so the owner's screen
  showed none of it — "it looks still same". Finish a UI change with
  `npm run build` in `app/`, check :8787 serves it, and rebuild the exe
  (process list first — see above).
- Do not restyle a saved-preference surface and expect the operator to see it.
  A layout they have saved (dock mode, open cards, pins, the rail) survives
  every redesign, so the v5 inspector needed `DOCK_DESIGN` to reset it ONCE.
  Ship a design generation with the design, or the people who have used the
  product longest are the ones who see none of it.
- Do not use `str.rstrip("/suffix")` to remove a suffix. It takes a SET OF
  CHARACTERS, so it eats any trailing `/`, `s`, `u`, `f`, `i` or `x` as well.
  Caught in review inside `run.py`'s own banner.
