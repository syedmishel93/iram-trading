# Capture bridge — getting data from sites with no open API

## Why the terminal cannot just read Arkham for you

The obvious design is an in-app browser tab that reads the page while you use
it. That does not work, and it is worth being precise about why, because the
reason also tells you what the right design is.

Measured, not assumed:

| site | embeds in an iframe? | can script read it? |
|---|---|---|
| Arkham (`intel.arkm.com`) | yes | **no** — cross-origin |
| CoinGlass | **no** — refuses to be framed | no |
| TradingView | yes | **no** — cross-origin |

A page can never read another origin's DOM. That is the same-origin policy, and
it is the single rule stopping any website you visit from reading your logged-in
Arkham session, your exchange account, or your email. A terminal that defeated it
would not be a "secure browser" — it would be the exact capability malware wants.

So the data has to cross the boundary somewhere it is *allowed* to: in your own
browser, on a page you are already looking at, with you initiating it.

## What is already solved without any of this

Most of what people open CoinGlass for is not proprietary. Funding, open
interest, account positioning, taker flow and liquidations are all published by
the exchange itself on keyless, CORS-open endpoints — the **Flow desk** reads
them directly. That is faster than scraping, has no Terms-of-Service exposure,
no API key to leak, and no dependency on a third party's uptime.

Reach for the bridge only for things with no public endpoint at all — Arkham
entity labels and wallet attribution being the main one.

## The design

```
   your browser, on the page you are viewing
   ┌──────────────────────────────────────┐
   │  userscript (you install it)         │
   │  · runs ONLY on origins you list     │
   │  · extracts visible values           │
   │  · POSTs to 127.0.0.1                │
   └───────────────┬──────────────────────┘
                   │  localhost only
   ┌───────────────▼──────────────────────┐
   │  local capture endpoint              │
   │  · binds 127.0.0.1, never 0.0.0.0    │
   │  · rejects non-local origins         │
   │  · shared secret in the header       │
   │  · stores to the existing SQLite     │
   └───────────────┬──────────────────────┘
                   │
              the terminal reads it like any other source
```

### Rules this design must keep

1. **Bind to `127.0.0.1`, never `0.0.0.0`.** A capture endpoint on a laptop that
   joins coffee-shop wifi is otherwise an open write endpoint for the whole
   network.
2. **Require a shared secret**, generated once and stored locally. Any page in
   your browser can POST to localhost; without a secret, any site you visit
   could inject rows into your terminal.
3. **Never capture credentials, cookies, or session tokens.** The userscript
   extracts rendered values only. If a field looks like an auth token, it does
   not leave the page.
4. **Allowlist origins explicitly.** The userscript runs on the handful of hosts
   you name, not on every page you open.
5. **Label captured data as captured.** It enters the terminal with its source
   and timestamp and is never presented as exchange-verified. Same honesty
   contract as everything else: a scraped number and a signed API number are not
   the same thing and must not look the same.
6. **You press the button.** Capture is user-initiated on a page you have open.
   Nothing crawls, nothing logs in, nothing runs while you are away — that is
   what keeps this on the right side of both the ToS and your own security.

### Status

**Designed, not built.** It needs an endpoint in the Python service tier
(`server/mishel_service.py` already owns SQLite and would host it) plus the
userscript. It is deliberately the *last* thing to build, because the Flow desk
already covers the metrics most people want and does it from an authoritative
source.
