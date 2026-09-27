# OPERATIONS — running this as a desk, not a tab

v35.0 split the system into three tiers. This document is about keeping the
always-on tier alive, because that is the tier that has to work when you are
not looking at it.

| Tier | Runs where | Holds |
|---|---|---|
| **Always-on** | `mishel_service.py` (headless) | signal evaluation, price alerts, Telegram, heartbeat |
| **Durable** | SQLite (`server/mishel.db`) | journal, armed strategies, drawings, wallet DB |
| **View** | the browser tab | rendering only |

The tab is now a *window onto* the desk. Close it and the desk keeps running.

---

## 1. Start the always-on tier

```bash
cd server
python3 mishel_service.py        # port 8788 — SQLite, loops, Telegram
python3 ddt_data_server.py       # port 8787 — data proxy
```

Server-side signals need **Node.js** on PATH (`node -v`). The service shells out to
`server/sig_worker.js`, which extracts the 26 strategies **out of `index.html` itself** —
so the server can never drift from what you see on the chart. If Node is missing the
service still runs; it logs `node not installed` and raises no signal alerts. It does
not fake them.

Prove the sidecar works:

```bash
node server/sig_worker.js --selftest
# -> {"ok":true,"strategies":26,...}
```

## 2. Arm a strategy so it fires with the browser closed

1. Pick a strategy in **Signals…** on the chart.
2. Click **🔔 sig**.

That now writes a row to `sig_watch` on the service. `sig_loop` re-evaluates it every
60s against **its own freshly fetched bars** (never the browser's stale cache) and
Telegrams you the fire with its measured record attached.

If the service is unreachable, the toast says so in plain words — *"armed IN THIS TAB
ONLY … it will NOT fire if you close the browser."* It never implies cover it does not have.

Manual control:
```bash
curl localhost:8788/svc/sig/watch                      # what is armed
curl -X POST localhost:8788/svc/sig/watch \
     -H 'Content-Type: application/json' \
     -d '{"sym":"XAUUSD","tf":"1h","strategy":"orb","q_gate":60}'
curl localhost:8788/svc/sig/fired                      # what has fired
```

## 3. The dead-man's switch — read this one twice

`stale_loops` in `/svc/health` tells you a loop is stuck **if you look**. If the whole
service dies, nothing tells you anything, and **silence is indistinguishable from "no
setups today."** That is the failure mode that costs money.

So it is inverted. Every 4 hours the service sends:

```
✅ MISHEL alive · 9/9 loops green
3 strategies armed · 2 price alerts · 1 signals fired (24h)
— if this message stops arriving, the desk is DOWN.
```

**The absence of that message is the alarm.** You will notice a missing 08:00 heartbeat
before the London open, not after you missed the trade.

Tune it: `MISHEL_HEARTBEAT_SEC=14400` (default 4h). Set Telegram first, or it has no mouth:
```bash
curl -X POST localhost:8788/svc/telegram -H 'Content-Type: application/json' \
     -d '{"token":"...","chat":"..."}'
```

## 4. Make it restart itself

**Linux** — the unit already has `Restart=always`:
```bash
sudo cp server/mishel-service.service /etc/systemd/system/
sudo systemctl enable --now mishel-service
```

**Windows** — this is the one that matters, because MT5 lives here.

*Option A — NSSM (recommended):*
```cmd
nssm install mishel "C:\Python312\python.exe" "C:\path\to\server\mishel_service.py"
nssm set mishel AppDirectory C:\path\to\server
nssm set mishel AppExit Default Restart
nssm set mishel AppRestartDelay 5000
nssm start mishel
```

*Option B — Task Scheduler:*
- Trigger: **At startup**
- ✅ *Run whether user is logged on or not*
- Settings → ✅ *Restart the task if it fails*, every **1 minute**, up to **999** times
- Uncheck *Stop the task if it runs longer than…* (it is a daemon; it never finishes)

## 5. Durable state

The 15 keys that cannot be recreated — `mishel_journal`, `mishel_sigalerts`, `mishel_sigmem`,
`mishel_drawmap`, `mishel_drawtpl`, `mishel_annot`, `mishel_pins`, `mishel_actionq`,
`mishel_layouts`, `mishel_guard`, `mishel_ck_acct`, `mishel_ck_risk`, `mishel_ruggers`,
`mishel_walletdb`, `mishel_wnick` — are mirrored to SQLite via `/svc/kv` on every write
(debounced 2s, flushed on tab close via `sendBeacon`).

Cosmetics (theme, pane heights, glass, compact, rail width — ~42 keys) stay in
localStorage. Those *should* be per-device; syncing them would be a bug.

The **Sync** chip in the status bar is the truth:
- `Sync 8s` — mirrored, your journal is safe on disk
- `Sync ⚠ UNSYNCED (3)` — the service is unreachable, 3 writes queued, **your journal is
  not yet safe.** Click the chip to force a retry.

New laptop / wiped Chrome profile: open the terminal with the service running and
`STORE.hydrate()` pulls everything back. It is a non-event.

## 6. The freshness contract

Two clocks, never conflated:

- **tick age** — how long since the feed moved. *Is it alive?*
- **vendor lag** — yfinance is ~15m behind. *Is it current?*

A feed can be perfectly **alive** and still 15 minutes behind your broker. The **Data**
chip says which:

| Chip | Meaning | Decisions |
|---|---|---|
| `LIVE` | websocket, ticking | allowed |
| `REAL · delayed` | alive, but the vendor is ~15m back | allowed, **verify at broker** |
| `LAG 45s` | slowing | allowed, warned |
| `STALE 180s` | the tape is dead | **BLOCKED** |
| `OFFLINE` | synthetic / no real feed | **BLOCKED** |

Blocked is not cosmetic. The Decision Bar refuses to print a verdict (`⛔ no decision on a
dead tape`) and **the MT5 order ticket refuses to build** — that is the one artefact that
turns a number into money, and it is never built from a price we cannot vouch for.

Why this matters more than it sounds: Chrome throttles background-tab timers to ≥60s.
You are always in MT5, so the terminal is *always* a background tab. Before v35.0 it kept
rendering the last value and still said LIVE. That is not fragility — that is **a wrong
number at the moment of decision.** We cannot defeat the browser's throttling. We can
refuse to lie about it, and on tab wake the Clock runs every due job immediately.

## 7. The Clock

Every recurring job is on one scheduler. Click the **Jobs** chip in the status bar for the
X-ray: name · interval · runs · **errors** · last run · last error.

A job that throws is now isolated and counted. It can no longer die silently and take its
work with it — which is what 57 independent `setInterval`s allowed for 34 versions.

## 8. Security

Both servers bind `127.0.0.1` by default. Keep it that way.

- Set `MISHEL_TOKEN` — `/svc/*` fails closed for non-localhost without it.
- Want it from your phone? **Tailscale.** Not a port-forward.
- Never expose 8788. Secrets (Telegram token, API keys) live in that SQLite file.

---

## 9. MT5 — making the broker the source of truth  (v36.0)

Until v36 the terminal analysed one price series and you traded another. This section
closes that.

### 9a. Bars + spread from your broker

The bridge needs **Windows** with MT5 **running and logged in** (that is the MetaTrader5
package's constraint, not ours). It never takes your credentials — you log in to MT5
yourself; it just reads what MT5 already shows you.

```cmd
pip install MetaTrader5
python server\ddt_data_server.py          :: the bridge lives inside the proxy (8787)
```

Then in the terminal: **Settings → Test MT5 connection**. Green means the proxy can see
your terminal. Set the proxy provider to `mt5` and the feed chip turns **REAL · BROKER**.

What changes the moment it does:
- Every ATR, swing stop, prev-day level, ORB and session boundary is computed on **the
  series you are actually filled on** — same server time, same daily close.
- The **live spread** flows into every signal's cost estimate, replacing a hard-coded
  0.0002 that 26 strategies had used for 34 versions. Gold at rollover is not EURUSD at
  midday, and the system finally knows the difference.
- Symbol renaming is handled (EURUSD.a, GOLD, EURUSDm). If your broker does not offer a
  symbol, it says so — it never guesses a name the broker never reported.

`/mt5/health` never 500s. It tells you exactly why it cannot serve.

### 9b. Execution reconciliation — the ⚖ button

**You do not need Windows or the bridge for this.** Do it now:

1. MT5 → Toolbox → **History** → set the date range → right-click → **Report** → **HTML**
2. In the terminal, click **⚖** (next to 📓) or press ⌘K → "Execution reconciliation"
3. Drop the file in.

If your broker's server time is UTC+2/+3, set the offset field. **We do not guess it** —
a wrong offset silently misaligns every session, ORB and prev-day level, and a silent
misalignment is worse than an error.

Already running the bridge? Press **↻ Sync via MT5 bridge** instead and it pulls deals
*and* each instrument's real cost profile (spread, contract size, tick value, swap
long/short, min stop distance).

Re-importing the same report is safe: deals are keyed on MT5's own ticket id, so
importing it ten times still leaves one copy of each deal.

### 9c. What the panel is actually telling you

Each closed trade is graded against **the plan you wrote down in the journal** (which the
service reads straight out of SQLite — the payoff of v35's durable state):

| Column | What it means |
|---|---|
| **slip** | the gap between the entry you planned and the price you got, in R |
| **cost** | the broker's OWN commission + swap, in R — never modelled |
| **gross → NET** | what the move gave you, and what you actually kept |
| **MFE** | how far it went your way before you closed it |
| **capture** | how much of that you took. Low capture = an EXIT problem |
| **exit** | stop / t1 / t2 / discretionary / **beyond_stop** |

`beyond_stop` is the one to watch. It means you exited past your own stop — it was
widened, moved, or ignored. In the test data a single such trade turned a "1R risk" into
a **-2.30R** loss, and that one trade was the whole negative expectancy.

The findings are written in plain language, and the honest ones hurt:

> *"YOUR SETUPS WORK; YOUR EXECUTION DOES NOT. Gross +0.50R per trade, net -0.10R."*
> *"You capture only 40% of the move your trades hand you. You are exiting winners early —
> that is an EXIT problem, and no new strategy will fix it."*
> *"You hold losers 2.6x longer than winners."*

### 9d. What it will NOT do

- **Fewer than 5 trades → it refuses to grade you** and says the sample is too small.
- A **dash means NOT MEASURABLE, not zero.** A missing measurement is not a free trade.
- A trade with no matching plan is reported **UNPLANNED**, never force-fitted to the
  nearest plan. A plan written *after* the fill is not a plan; it is a story, and it is
  never matched.
- MFE/MAE says **which bar series it used** (broker-exact vs vendor). A capture% computed
  off vendor bars is never passed off as broker-exact.
- On a **hedging** account, the HTML report's FIFO pairing can mis-assign simultaneous
  positions in one symbol. Use the bridge — it returns the real position_id.

Until you import something, the panel says exactly one thing: **"Your real edge is
currently unmeasured."** Because it is. The journal's win-rate is the demo account's.

---

## 10. The Risk Governor  (v37.0)

Open it with **🛡** in the toolbar, the **Risk** chip in the status bar, or ⌘K → "Risk Governor".

### What it watches that nothing watched before

| Rule | Why it exists |
|---|---|
| **daily loss** | after your limit, the next trade is not a setup — it is a refund request |
| **open risk** | total live R across every position, not per-ticket |
| **currency concentration** | long EURUSD + short USDCHF + long AUDUSD is **ONE 3R bet on the dollar**, not three 1R bets |
| **loss-streak cooldown** | revenge trading is the only strategy with a proven negative expectancy |
| **trades / day** | past a point you are not trading, you are clicking |
| **no stop loss** | an unprotected position is an open-ended bet on your own attention |

The **Net currency exposure** row is the one to look at. It decomposes every open position
into its legs — long EURUSD *is* long EUR and short USD — and shows the bet you are actually
making. Correlation does not care that you opened the tickets in different windows.

### What a BLOCK actually does

It refuses to build your order ticket. **It does not, and cannot, stop you trading** — you
execute by hand in MT5 and nothing here auto-executes. The alert says so in as many words.
The last human step stays human; the system simply declines to make a bad trade convenient.

If you no longer believe a limit, change it. The limits are yours — all seven are editable in
the panel and persist to SQLite. A governor is only worth having if you actually believe the
numbers you set.

### Sizing — and the bug it fixes

The order ticket previously converted lots with `units / 100000` for anything matching
EUR/GBP/JPY/**XAU**. XAUUSD's contract is **100 ounces**, not 100,000. Gold was being sized
**1000× too small** — a $100 risk on a $10 stop should be 0.10 lots; the ticket said 0.0001.

Sizing now comes from your broker's real contract spec. Run `/svc/mt5/sync` (or press **↻ Sync
via MT5 bridge** in the ⚖ panel) once, and every ticket is sized from the actual contract.
**Without a spec the ticket says NOT SIZED and refuses.** A guessed contract size is not a
smaller error than a missing one — it is a bigger one, because you will actually trade it.

### If the governor is down

The chip reads **Risk ?** and the panel says, in as many words: *"Your daily loss, open risk
and currency concentration are not being watched. That is not the same as being within your
limits — it means nobody is looking."*

A governor that reports all-clear over a book it cannot read manufactures confidence it has
not earned. When it cannot see your positions it says **WARN**, never **CLEAR**.
