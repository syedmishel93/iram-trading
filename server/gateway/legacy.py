"""
The three Flask services, imported and dispatched by path prefix.

WHAT THIS IS NOT: A REWRITE
Every route in `ddt_data_server.py`, `mishel_service.py` and `quant/app.py` runs
here as the same function it always was, reached at the same URL it always had.
Nothing was ported, so nothing could be ported wrong. That is the entire point
of doing consolidation this way round: the risky part (one process, one CORS
policy, one bind decision, one lifecycle) lands first and is provably behaviour-
preserving, and porting individual routes to native async becomes a later choice
made route by route with the tests already passing.

The three namespaces are disjoint — `/svc/*`, `/quant/*`, and the data proxy's
root-level endpoints — which is what makes a prefix table sufficient. Flask's
implicit `/static` route exists on all three and is deliberately absent from the
table: none of these services serves files, and routing it would have made the
one genuinely ambiguous prefix the one picked by import order.

A SERVICE THAT WILL NOT IMPORT IS NOT A GATEWAY THAT WILL NOT START.
`quant/app.py` needs numpy, scipy and scikit-learn; the data proxy wants
yfinance. The terminal already knows how to display a desk whose service is not
running, and a missing optional dependency should reach the operator as that,
not as a stack trace at boot with the other two services taken down beside it.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from dataclasses import dataclass, field
from typing import Any

from anyio import CapacityLimiter

from .wsgi import WSGIBridge

#: `server/` — `quant` is a package, so its parent must be importable.
SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)


@dataclass
class LegacyService:
    name: str
    module: str
    #: Path prefixes this service owns. Matched as a whole segment: `/ohlc` and
    #: `/ohlc/x` belong to it, `/ohlcx` does not.
    prefixes: tuple[str, ...]
    #: What stops working when it will not import — shown to the operator.
    provides: str
    bridge: WSGIBridge | None = None
    error: str | None = None
    detail: str = field(default="", repr=False)

    @property
    def ok(self) -> bool:
        return self.bridge is not None


SERVICES: tuple[LegacyService, ...] = (
    LegacyService(
        name="data",
        module="ddt_data_server",
        prefixes=("/ohlc", "/quote", "/fetch", "/providers", "/health", "/ai", "/mt5"),
        provides="market data proxy (yfinance, Twelve Data, Polygon, Alpaca) and the MT5 bridge",
    ),
    LegacyService(
        name="svc",
        module="mishel_service",
        prefixes=("/svc", "/mcp"),  # /mcp: svc/mcpserve.py, this product AS an MCP server
        provides="alerts, journal, sync, risk governor, on-chain desk, SQLite store",
    ),
    LegacyService(
        name="quant",
        module="quant.app",
        prefixes=("/quant",),
        provides="GARCH, causal inference, calibrated classification, portfolio optimisation",
    ),
)


def load(limiter: CapacityLimiter) -> tuple[LegacyService, ...]:
    """Import each service. Failures are recorded, never raised."""
    for svc in SERVICES:
        try:
            module = __import__(svc.module, fromlist=["app"])
            svc.bridge = WSGIBridge(module.app.wsgi_app, limiter=limiter)
            svc.error = None
        except Exception as exc:  # noqa: BLE001 — a bad import must not stop the others
            svc.error = f"{type(exc).__name__}: {exc}"
            svc.detail = traceback.format_exc()
    return SERVICES


def _matches(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


class LegacyDispatch:
    """Routes to a legacy service by prefix, or 404s in the gateway's own voice."""

    def __init__(self, services: tuple[LegacyService, ...]) -> None:
        self.services = services

    def find(self, path: str) -> LegacyService | None:
        for svc in self.services:
            if any(_matches(path, p) for p in svc.prefixes):
                return svc
        return None

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await _json(send, 404, {"error": "not found"})
            return

        svc = self.find(scope["path"])
        if svc is None:
            await _json(send, 404, {"error": f"no route for {scope['path']}"})
            return

        if svc.bridge is None:
            # 503 rather than 500: the route exists and the dependency does not.
            await _json(
                send,
                503,
                {
                    "error": f"the {svc.name!r} service failed to import",
                    "reason": svc.error,
                    "provides": svc.provides,
                    "hint": "pip install -r server/requirements.txt",
                },
            )
            return

        await svc.bridge(scope, receive, send)


async def _json(send: Any, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
