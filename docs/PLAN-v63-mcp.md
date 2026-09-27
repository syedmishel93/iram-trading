# v63 — the MCP engine

The owner's ask: *"add mcp engine so i can connect trading view or other free
platforms"*.

Everything below rests on probes run 2026-09-25 against the live servers, not on
the description the ask arrived with. Where the two disagree, the probe wins;
where I could not probe, it says so.

---

## What was measured before anything was designed

### TradingView is real, and its auth is easier than expected

`POST https://mcp.tradingview.com/mcp` answers **401** with a spec-correct
`WWW-Authenticate: Bearer resource_metadata=...`. Walking the chain:

    protected resource   -> authorization_servers: ["https://www.tradingview.com"]
    authorization_server -> authorization_endpoint  /mcp/oauth/authorize
                            token_endpoint          /mcp/oauth/token
                            registration_endpoint   /mcp/oauth/register
                            code_challenge_methods  ["S256"]
                            token_endpoint_auth     ["none", ...]
                            grant_types             ["authorization_code", "refresh_token"]
                            scopes                  ["mcp:read", "mcp:tools"]

`registration_endpoint` plus `"none"` means **RFC 7591 dynamic registration of a
PUBLIC client**: there is no client id to obtain, no client secret to store, and
nothing for the operator to type. They press Connect, sign in in the browser
once, and `refresh_token` keeps it alive.

**NOT VERIFIED, and it is the load-bearing unknown:** whether a free account is
served. The owner has a free plan, so the TradingView leg ships *ready and
unproven*, and says so on screen rather than claiming it works.

### The OAuth work is generic, so a free plan cannot waste it

LunarCrush advertises the identical chain — `WWW-Authenticate` -> protected
resource -> authorization server -> `registration_endpoint`, scopes
`profile api.read api.write`. One implementation of MCP-spec auth serves both,
and LunarCrush is the target that PROVES the flow if TradingView refuses.

### Exactly one market-data MCP server answers without an account

| server | handshake |
| --- | --- |
| **Crypto.com** `mcp.crypto.com/market-data/mcp` | **200**, 9 tools, no auth |
| CoinDesk, AlphaVantage, TwelveData, LunarCrush, FMP | 401 |

So the engine is verifiable end to end on day one with nothing from the operator.

### Two of the candidates would be a SECOND OWNER for a fact already owned

AlphaVantage and TwelveData both publish MCP servers, and this product already
speaks REST to both — with per-provider, per-endpoint timezone corrections
documented above `p_twelvedata` because reading them wrong once displaced every
bar they ever served. A second path to the same vendor is the `/svc/ledger`
mistake: a worse duplicate owner for "what did this market do". **Not wired.**

### A tool result is PROSE WRAPPING JSON, and it broke the probe written to read it

    Here is the Crypto.com Exchange candlestick data {"instrument_name":"BTC_USD",...}

`json.loads` on the text block raises. An MCP tool answers a language model, so
its content is model-facing text and the JSON is an artefact inside it. Two
consequences, and the second is the one that matters:

1. An adapter must LOCATE the object (`raw_decode` from the first `{`), never
   parse the whole string.
2. That prose is not a contract. It can change wording without notice, so an
   adapter VALIDATES the field set and REFUSES by name when it does not match —
   it never best-effort repairs. This is the hand-written-client risk this
   project already records as its one real API-contract gap, arriving in a
   source with no schema at all.

### The timestamps are honest, and that is worth stating

`"timestamp":"2026-09-25T11:00:00Z"` — explicit `Z`, correct UTC, newest bar
agreeing with the wall clock. The single most expensive defect in this
codebase's history is naive datetimes read as local time; this vendor does not
have it. Prices are STRINGS and need converting.

### MCP is not a backfill source — measured, not assumed

`get_candlestick` takes `instrument_name` and `timeframe` and **nothing else**.
It returned **50 rows, newest-first**. No date range, no cursor, no depth
parameter. Fifty descending bars cannot fill the `bars` archive and cannot be
walked forward.

**So no MCP data enters the bars archive in this work.** That is a measurement
about the tool's shape, not caution about a new vendor.

---

## What is being built

### 1. `server/svc/mcp.py` — the engine

Streamable HTTP JSON-RPC. Four things it must get right, each one measured:

- The reply is **either** `application/json` **or** `text/event-stream`. Crypto.com
  returns SSE for a unary `initialize`, so a client that calls `r.json()` fails
  against the one server available to verify it.
- **Accept the server's protocol version.** Asked for `2025-06-18`, told
  `2025-03-26`. A client that insists on its own cannot talk to it.
- **Echo `Mcp-Session-Id` only when issued.** Crypto.com issues none; requiring
  one would refuse a working server.
- A non-2xx, a JSON-RPC `error`, or `isError` become NAMED REFUSALS, in the
  `_refuse` idiom `svc/router.py` already uses. Never an exception reaching a
  route, never a credential in a message.

### 2. `server/svc/mcpauth.py` — MCP-spec OAuth, once

The discovery chain walked above, then RFC 7591 registration, PKCE S256, `state`,
redirect to `127.0.0.1:8787/svc/mcp/callback`. `response_types` is forced to
`code` — LunarCrush also offers `token`, and the implicit grant has no place
here.

**Tokens live server-side in SQLite and never reach the browser.** This product
backs the browser's own storage up to the server, so a token there is a token in
every copy of that backup; the rule already exists as `syncable()` and was
already nearly broken once with an analyst API key. A guard test asserts the key
is not syncable and proves itself by failing when it is added.

### 3. A connector registry

One config row per server: name, url, enabled, auth kind, scopes, added-at.
Written by the client, read by the server, one owner. Adding tomorrow's MCP
server is a row, not a release.

### 4. The adapter boundary — where the honesty lives

- **Any tool is callable and its raw result viewable.** This needs no adapter,
  and it is the proof a connection works.
- **Data becomes an IRAM shape only through a named adapter** per (server, tool),
  which locates the embedded JSON, validates the fields, converts strings,
  requires an explicit zone, and refuses with a reason otherwise.
- Every value carries its source, so an MCP figure can never be read as one of
  this product's measured vendor feeds — the `spread_kind` rule applied again.

### 5. One card on the Connections desk

That desk already owns the seven service rows from v62.20; this belongs beside
them rather than in a new home. Per server: name, one of
**connected / needs sign-in / refused (reason)**, tool count, last call. A tool
runner that shows the raw result, because "connected" with nothing readable is
the green dot that means `started`.

`scratchpad/classcollide.py` runs BEFORE a CSS prefix is chosen. It has already
refused one of mine.

### 6. Then: IRAM as an MCP server

The owner asked for this second, and it reuses the JSON-RPC layer above. The
archive, the 46 GET routes and the backtester become tools, so a study can be
asked for from chat. Read-only to begin with: there is still no `order_send`
anywhere in `server/`, and that is the owner's standing decision, not an
oversight.

---

## Tests, each from the failing case

| file | what fails without the fix |
| --- | --- |
| `tests/test_mcp_client.py` | an SSE reply; a JSON reply; the server's protocol version accepted over ours; a session id echoed only when issued; a JSON-RPC error as a refusal rather than a raise |
| `tests/test_mcp_adapter.py` | **prose-wrapped JSON parses and a bare `json.loads` fails** — the defect that broke this session's own probe; a missing field refuses; a zoneless timestamp refuses; string prices convert |
| `tests/test_mcp_secrets.py` | the token key is not syncable, proved by failing when it is added to the syncable set |

Both lists in `verify.py`, or `tests/ fully listed` fails. `svc/mcp.py` into
`HIDDEN` in `build_binary.py`, or `test_build_hidden_imports.py` fails — the exe
is not being built, and the gate enforces it anyway.

`scratchpad/classsweep.py` needs reviewing once this lands: an MCP client is by
definition a module that POSTs, and `credential-egress` is watching for exactly
that shape. It gets an entry with its reason, or the sweep gets ignored.

---

## Not building, and why

- **AlphaVantage / TwelveData MCP.** Second owner for a vendor already wired.
- **MCP bars into the archive.** 50 descending rows, no date range. Measured.
- **stdio or the deprecated SSE transport.** Nothing to spawn in a served
  product, and Streamable HTTP is what all four probed servers speak.
- **An exe.** Standing instruction. `python run.py` and the browser build only.

---

## Verification

1. `python verify.py --lint` — 7 stages, real output pasted.
2. The engine driven live against Crypto.com: handshake, 9 tools, a real
   `get_candlestick` call, adapted and refused where it should refuse.
3. The OAuth flow driven live against LunarCrush, which is the leg TradingView's
   free plan may not prove.
4. The browser build at :8787 — never the dev server.
