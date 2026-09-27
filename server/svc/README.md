# `server/svc/` — the service, by use case

`mishel_service.py` was one 1,792-line file holding eleven background loops,
53 HTTP routes and the helpers all of them lean on. It is now a **414-line
facade** plus one module per use case. To change something, open the one file
in the table and nothing else.

| file | lines | what it owns | routes | loops |
| --- | ---: | --- | ---: | ---: |
| `core.py` | 206 | auth token, circuit breaker, `tick`/`sleep_ticking`, `cfg`, `log_event`, yfinance readers, `send_tg` | – | – |
| `onchain.py` | 428 | whale flow, smart-copy signals, DB-wide wallet alerts, new pairs, daily brief | 7 | 5 |
| `mt5.py` | 243 | your fills (import / sync), broker specs, reconciliation, costs, status. **Owns `PROXY`** | 5 | – |
| `risk.py` | 172 | the risk governor: state, check, size, config | 4 | – |
| `research.py` | 219 | claims ledger, edge trials, news RSS, analyst | 9 | – |
| `sync.py` | 155 | client state: backup, `/svc/kv*`, `/svc/sync/*` | 7 | – |
| `alerts.py` | 86 | price alerts, Telegram credentials, notify | 5 | 1 |
| `signals.py` | 141 | armed strategies, `sig_worker.js`, fired signals | 4 | 1 |
| `features.py` | 119 | feature store, OHLC cache, ML predict / regime | 7 | 1 |
| `settings.py` | 207 | the server settings an operator may change, each with a validator and the module that reads it | 2 | – |
| `mcpauth.py` | 575 | MCP sign-in: OAuth 2.1 discovery, dynamic registration, PKCE, refresh. Tokens server-side only | 4 | – |
| `mcp.py` | 539 | the MCP engine: Streamable HTTP JSON-RPC to any MCP server, the connector registry, `embedded_json` | 6 | – |

**Still in `mishel_service.py`:** the Flask `app`, the auth guard, the
database hook and `migrate()`, `/svc/health`, `/svc/events`, the small
forward-test ledger (`ledger_loop` and two routes), `heartbeat_loop`,
`backup_loop` (it copies the SQLite FILE, so it needs rethinking for Postgres
rather than moving), and `__main__`.

The database is in `server/db/`; see its README.

## The three rules

**1. `mishel_service` stays a facade.** `gateway/background.py` starts every
loop with `getattr(mishel_service, name)`, and the test scripts call
`svc.flow_state`, `svc.store_deals` and the rest. So the facade re-exports
every public name from every module here. A new loop needs adding to the
facade's import list AND to `LOOP_NAMES` in `gateway/background.py`, or it
never starts.

**2. Patch the module that OWNS a name, never the facade.** A re-export is a
second binding. Code in `svc/onchain.py` calls `send_tg` from its own globals,
so `mishel_service.send_tg = fake` changes nothing and the test silently tests
the real thing. Patch `sys.modules["svc.onchain"].send_tg`. `PROXY` is the
sharp case: `risk.py` reads it as `_mt5.PROXY` at call time precisely so that
there is ONE binding, in `mt5.py`, and repointing that one repoints both.

**3. A new module goes in `HIDDEN` in `server/build_binary.py`.** The
service imports these after a runtime `sys.path` insert that PyInstaller
cannot follow, so a module missing from the list is missing from the shipped
.exe — and a checkout never shows it. `tests/test_build_hidden_imports.py`
fails the gate until it is added.

## Adding a route

Put it in the module whose use case it serves, on that module's `bp`:

```python
@bp.get("/svc/risk/whatever")
def svc_risk_whatever():
    ...
```

Routes are blueprints so a module never needs the `app`. The auth guard is an
`@app.before_request` on the app, which Flask runs for every blueprint mounted
on it — nothing to repeat per module.

## Anything that uses `__file__`

These modules sit one directory below `mishel_service.py`. `signals.py`
resolves `sig_worker.js` from its PARENT directory for that reason; anything
new that finds a sibling file by `__file__` has to do the same.
