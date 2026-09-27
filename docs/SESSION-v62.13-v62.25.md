# What changed, in one page

`docs/HANDOVER.md` has thirteen entries for this session and each is a full
account. This is the version you can read in five minutes.

---

## The three that mattered most

### A loop that had never once succeeded

`pair_scan_loop` called `log_event()` from inside its own open write
transaction. That opens a *second* connection asking for the lock the same
thread already holds, which can never be granted — so it waited out the busy
timeout, raised `database is locked`, and **the raise rolled back the dedup
insert the block existed to make**.

    2,069 failures      46% of every event the service had ever recorded
    onchain_seen        0 rows

It had failed on every run of its life, re-detecting the same tokens every five
minutes, while its status dot stayed green — because that dot means *started*,
and a tick age is not a health check.

Fixed by shape: record inside the transaction, announce after it closes. It now
holds 50+ real tokens and climbing.

### The backtester charges 3–5× what your broker does

`DEFAULT_COSTS` charges a flat 2bp spread on every instrument. Your broker:

| | real | assumed | |
|---|---|---|---|
| XAUUSD | 0.42 bp | 2.00 bp | **4.7×** |
| EURUSD | 0.53 bp | 2.00 bp | **3.8×** |
| BTCUSD | 0.71 bp | 2.00 bp | **2.8×** |

Costs set the hurdle a strategy must clear, so this is not harmless caution: it
**discards rules that would have cleared the real spread**, silently. The
Calculator desk now shows the comparison. It reports; it does not overwrite,
because a figure that moved under you because a service answered would be worse
than a disagreement you can see.

### The learning loop had no way to close

`shell.ts` said the trial mirror *"pushes when the operator asks, from the
Learning desk"*. **Nothing asked** — `edge.push` had no caller anywhere. So the
durable `trials` table could never fill and the conditional-edge table the
Knowledge desk exists to show had nothing to read.

The comment is why it survived: it reads as a design decision that was
implemented. There is now a "Keep this replay" button; first press stored 52
outcomes.

---

## Also fixed

- **Two data feeds failing every run.** `data_mvrv` had *two* faults stacked —
  a rejected `order` parameter hiding a revoked `CapRealUSD` metric. Now stores
  a real MVRV (1.577). `forexfactory_cal` was a dead duplicate of a calendar
  that already had an owner; removed.
- **A weekly calendar fetched hourly**, rate-limited 42 times. Freshness now
  reads from the store, so a restart no longer re-fetches.
- **The symbol picker offered 132 instruments; your broker quotes 272.** A third
  of what the account can trade could not be typed in.
- **Two capabilities with no screen** — new token pairs and smart-money wallets.
- **Seven services with no screen** — broker bridge, router, vendors, backup,
  streams. The bridge row shows the broker's clock offset (3.0 hours ahead of
  UTC, measured and subtracted from every bar), which had been invisible.
- **The event log had no screen at all**, which is why the 2,069 failures went
  unnoticed. It now leads with how many jobs are failing.
- **The economic calendar was rendering on another card's grid** — `.cal-row`
  declared twice in one stylesheet, 1,280 lines apart.
- **`verify.py` died while printing which test failed** (encoding), for the
  third time in this codebase's history. Fixed at the stream, not the print.

---

## Two things I got wrong, and what I did about them

**I nearly put your API key on the server.** Wiring the settings backup, my
first draft would have uploaded `agent.credential`. `store/sync.ts` already
carried the rule *and* the scar — "is this a credential?" had two answers once
before — and I was becoming the third. It now defers to the one owner,
`syncable()`.

**A test of mine overwrote your settings backup with fixtures.** `startBackup`'s
transport defaulted to the live one, and under vitest `fetch` reaches the
running gateway. Your 13 slots came back within the minute; the transport now
has no default, so no spelling of that call can touch the network by accident.

Both came from moving fast on self-directed work. Worth knowing if you ask for
long autonomous stretches again.

---

## What is still open

- **16 of 96 routes are uncalled**, each with a reason in `CLAUDE.md` — four are
  served HTML or introspection, four deliberately dead, four read stores nothing
  fills yet, two are destructive admin actions, one is a duplicate, one needs an
  API key only you can supply. **None is capability without a screen.**
- **Two fixture wallets sit in your live database** (`0xdna1111…`,
  `0xnodna1111…`), left by tests from before they set a scratch path. They show
  up on the Whale watch card. Deleting rows from your data is your call — say
  the word.
- **FRED needs an API key** you'd set in the environment. The System desk lists
  it as "waiting for you" rather than failing.
- **No execution path.** `order_send` still appears nowhere; the bridge reads
  and cannot place an order. Unchanged and still your standing decision.

---

## What protects this now

Every defect class above is a check that runs on `python verify.py`:

    dbhold.py       a transaction holding a second connection
    classsweep.py   credentials on the wire · live network defaults ·
                    unceilinged debounce · counts from their own input ·
                    fragile reactive lists
    cssdupe.py      one class, two conflicting declarations

They fail on a **zero** as well as on a finding, because a checker whose pattern
has stopped matching reports a clean tree — which is the failure they exist to
catch, turned inward.

    gate: 7 stages, 107s, all pass
