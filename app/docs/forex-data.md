# Free forex data — what actually works

Tested on this machine, not assumed.

## Real-time and free: your own MT5 terminal

**This is the only genuinely real-time, genuinely free forex feed available to
you**, and you already have everything for it. MetaTrader 5 is installed at
`C:\Program Files\MetaTrader 5`, the bridge exists at `server/mt5_bridge.py`,
and the proxy already ranks `mt5` ahead of every vendor for fx, metals and
stocks — because it is the venue you are actually filled at, so its prices are
the only ones that are true for *you*.

**STATUS: working.** Verified on this machine against account 1100515012
(JustMarkets-Demo2): `EURUSD` resolves to `EURUSD.s`, tick bid 1.15824 / ask
1.15835 (1.1 pip spread), and `XAUUSD` returned 4456.35 — the same price shown
in the MT5 Market Watch at that moment.

Three steps, in order:

```bash
python -m pip install MetaTrader5
```
(Already done on this machine — `MetaTrader5-5.0.6147`.)

**2. Launch MetaTrader 5 and log in** to any account, demo or live. The bridge
attaches to a running, authorised terminal; without that it reports
`Authorization failed`. Only you can do this — it involves your broker
credentials.

**3. Restart the proxy** so it picks up the newly installed package:

```bash
python server/ddt_data_server.py
```

Then `http://127.0.0.1:8787/mt5/health` should report `available: true`, and the
terminal will start serving forex from `mt5` automatically.

### Broker symbol suffixes

JustMarkets serves `EURUSD.s`, `XAUUSD.s` — every symbol suffixed. `resolve_symbol()`
in `mt5_bridge.py` already handles this (exact → alias → shortest matching
suffix), so you keep typing the canonical `EURUSD` and it finds the broker's
name. Nothing to configure.

The registry probes MT5 first for every non-crypto symbol and only falls back
when it cannot answer, so nothing needs reconfiguring when MT5 restarts.

Verify with:

```bash
curl "http://127.0.0.1:8787/ohlc?provider=mt5&symbol=EURUSD&interval=1h&limit=5"
```

## What happens until then

The registry degrades honestly, and says so at every step:

```
binance: FAIL — does not cover EURUSD        (skipped, no request wasted)
mt5:     FAIL — MetaTrader5 ... / Authorization failed
proxy:   OK   — 800 bars                     (yfinance, DELAYED)
```

So forex works right now — it is just marked `DELAYED`, with no socket, and the
status bar says `proxy · DELAYED`. When MT5 comes up, the next probe succeeds
and the source flips to `mt5 · LIVE` on its own.

## Why nothing simpler works

A browser cannot fetch most market data directly — the vendor must send CORS
headers, and almost none do. Measured:

| source | key needed | CORS from browser | intraday OHLC | real-time |
|---|---|---|---|---|
| **MT5 (your broker)** | no | n/a (local) | yes | **yes** |
| Yahoo / yfinance | no | blocked (proxy ok) | yes | no — delayed |
| Frankfurter | no | blocked | no (daily) | no |
| exchangerate.host | yes (now) | ok | no (daily) | no |
| open.er-api.com | no | ok | **no — daily rates** | no |
| Twelve Data | yes | ok | yes | free tier delayed |
| Alpha Vantage | yes | ok | yes | no |

Every keyless, CORS-open endpoint publishes one rate per day. You cannot draw an
hourly candle from that, which is why the local proxy exists at all.

## If you ever want a non-broker real-time source

**OANDA practice account** — free signup, genuine real-time streaming REST API,
no cost and no expiry. It is the best third-party option if you want FX data
independent of whichever broker you are trading through. Not wired yet; it would
be a new provider in `ddt_data_server.py` plus a source entry.

**Twelve Data** free tier (~800 req/day) is the best free *official* REST option,
but its free plan is delayed. The proxy already supports it — set
`TWELVEDATA_KEY` and it becomes available as `provider=twelvedata`.

## The rule none of this is allowed to break

A source is registered with the quality it actually has. `mt5` is `live`;
yfinance is `delayed` and exposes **no socket** (`streamUrl` returns `null`), so
the terminal can never claim a live FX feed it does not have.

Weekends are **not** staleness, and the terminal now says so explicitly. A shut
venue reports `CLOSED — market closed, last price is the close`, in neutral grey,
rather than `DELAYED` in amber.

That distinction matters more than it looks: a warning that fires every single
weekend is a warning you stop reading, and then you miss the real one on a
Wednesday. `data/sessions.ts` models the FX week (Sunday 22:00 → Friday 22:00
UTC), knows crypto never closes, and returns `unknown` for equities rather than
guessing at holidays — an unknown state falls back to judging on data age, which
is the safe default.
