"""
`python -m gateway` — run the whole backend.

Run from `server/`:

    python -m gateway                       # 127.0.0.1:8787
    IRAM_BACKGROUND=1 python -m gateway     # + the eleven service loops
    IRAM_PORT=9000 python -m gateway

The bind guard is the strictest of the three services' rules applied to all of
them. `quant/app.py` refused to serve off loopback without `IRAM_QUANT_ALLOW_REMOTE`
because it has no authentication; that reasoning did not stop being true when it
moved behind a gateway, and it now covers the data proxy — which never had a
guard at all, and which will hand out whatever vendor API keys it was configured
with to anyone who can reach it.
"""

from __future__ import annotations

import sys

from .config import settings


def main() -> None:
    import uvicorn

    if not settings.is_loopback and not _allowed_remote():
        print(
            f"Refusing to bind {settings.host}: this gateway has no authentication\n"
            f"of its own, and it proxies vendor API keys. Put it behind something\n"
            f"that authenticates, then set IRAM_ALLOW_REMOTE=1.",
            file=sys.stderr,
        )
        raise SystemExit(2)

    # `reconfigure` exists on TextIOWrapper, which is what sys.stdout normally
    # is -- but the annotation is the wider `TextIO`, which does not declare it,
    # and under PyInstaller these can be something else again. The `try` is
    # already the runtime guard; these silence a type error that is really a
    # gap in the stdlib stubs, and they are narrow enough to fail if the call
    # itself ever changes shape.
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001 — cp1252 consoles; not worth failing over
        pass

    print(f"IRAM gateway  http://{settings.host}:{settings.port}")
    print(f"  docs        http://{settings.host}:{settings.port}/docs")
    print(f"  health      http://{settings.host}:{settings.port}/api/health")

    uvicorn.run(
        "gateway.app:app",
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=False,
    )


def _allowed_remote() -> bool:
    import os

    return bool(
        os.environ.get("IRAM_ALLOW_REMOTE") or os.environ.get("IRAM_QUANT_ALLOW_REMOTE")
    )


if __name__ == "__main__":
    main()
