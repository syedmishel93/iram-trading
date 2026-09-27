#!/usr/bin/env python3
"""
The frozen binary's entry point — the packaged product's launcher.

WHY THIS IS NOT `gateway/__main__.py`
`python -m gateway` hands uvicorn the import string `"gateway.app:app"` and lets
it import the module itself. That is right for a source checkout — it is what
enables reload — and wrong inside a PyInstaller bundle, where the import system
is a custom loader over an archive: uvicorn's own import of that string can
resolve differently from the one the analyser saw at build time, and the failure
is a binary that starts and then 404s everything.

So this imports the app object directly and passes the OBJECT to uvicorn. There
is no string for anything to re-resolve.

WHY IT MIRRORS `run.py` RATHER THAN BEING A THINNER VERSION OF IT
`run.py` at the repository root is the launcher for a source checkout, and it
makes three decisions that are about the PRODUCT rather than about having a
checkout: turn the service loops on, wait for health before opening a browser,
and reuse an instance that is already running instead of dying on the bind. A
binary that skipped them would be a worse product than the checkout it was
built from, which is the wrong way round for the thing people download.

It is deliberately NOT shared code with `run.py`. That file starts the gateway
as a subprocess (`python -m gateway`) and this one runs it in-process, because
in a bundle there is no interpreter to spawn — so the two have different bodies
around the same three decisions, and the decisions are stated in both.
"""

from __future__ import annotations

import os
import sys
import threading
import time
import webbrowser


def data_dir() -> str:
    """Where state that must outlive the process lives.

    THE BUG THIS FIXES, MEASURED. `mishel_service.py` resolves its database as
    `os.path.dirname(__file__)/mishel.db`, and inside a one-file PyInstaller
    bundle `__file__` is under `sys._MEIPASS` — the extraction directory, which
    is DELETED when the process exits. Run the built binary and it creates

        %TEMP%/_MEI0000268c2/mishel.db      139,264 bytes

    and takes it away again on close. Every run of the packaged product started
    with an empty database: no alerts, no journal, no ledger, and no settings
    backup, with nothing on screen to say so. A source checkout never saw it,
    because there `__file__` is `server/` and the file simply persists.

    So a frozen build gets the per-user data directory the platform provides,
    and the path is PRINTED at startup — state whose location is a mystery is
    the next version of this bug. Per-user rather than beside the executable on
    purpose: an exe in `Downloads`, in `Program Files` or on a read-only volume
    still has somewhere to write, and replacing the binary with a newer one does
    not orphan the operator's history.

    Not frozen: `server/`, exactly as before. Nothing about a checkout changes.
    """
    if not getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(__file__))
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "IRAM")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/IRAM")
    xdg = os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share")
    return os.path.join(xdg, "iram")


def gateway_at(port: int, timeout: float = 2.0) -> dict | None:
    """This gateway's health on `port`, or None when what answers is not it.

    Same reasoning as `run.py`: a busy port is two different situations — this
    product already running, or something else — and only the payload tells them
    apart. A double-clicked executable is exactly where the difference matters,
    because the second double-click is an ordinary thing for someone to do and
    the old behaviour was a window that opened, said the port was in use, and
    closed.
    """
    import json
    import urllib.error
    import urllib.request

    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    return body if isinstance(body, dict) and "services" in body else None


def _hold_open_on_failure() -> None:
    """Keep a double-clicked console window up long enough to read.

    Without this, every startup failure — a port already in use, a corrupt
    database — appears as a window that opens and vanishes, which is
    indistinguishable from the program doing nothing at all.
    """
    if os.environ.get("IRAM_NO_HOLD"):
        return
    try:
        input("\nPress Enter to close…")
    except (EOFError, KeyboardInterrupt):
        pass


def open_when_ready(url: str, port: int) -> None:
    """Open the browser once `/api/health` answers, not one second after boot.

    The port is listening before the application is usable: uvicorn binds first
    and the lifespan then imports three Flask services, which on a cold start in
    a `--full` build is several seconds of scipy, pandas and yfinance. The
    previous version slept 1.0s and admitted in a comment that a readiness probe
    was "not worth it here" — but a browser that arrives early lands on a
    terminal whose every desk reports its service missing, and the operator
    reads that as a broken download at the one moment it is only slow.
    """
    deadline = time.monotonic() + 60.0
    while time.monotonic() < deadline:
        if gateway_at(port, timeout=1.0) is not None:
            break
        time.sleep(0.35)
    webbrowser.open(url)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001, S110 — cp1252 consoles; a console that
        pass               # cannot be reconfigured is still a console

    # `server/` on the path: gateway/legacy.py imports the Flask services by
    # name, and in a frozen build the working directory is wherever the user
    # happened to double-click from.
    here = os.path.dirname(os.path.abspath(__file__))
    bundled = getattr(sys, "_MEIPASS", None)
    for path in (str(bundled) if bundled else "", here):
        if path and path not in sys.path:
            sys.path.insert(0, path)

    # BEFORE the gateway imports. `gateway/config.py` builds its `Settings` at
    # module import time, so `IRAM_BACKGROUND` set after that import would be
    # read by nothing; and `mishel_service.py` resolves `DB` at ITS import, so
    # `MISHEL_SVC_DB` has to be in place before the lifespan loads it.
    # `setdefault` throughout, so an operator's own value always wins.
    store = data_dir()
    try:
        os.makedirs(store, exist_ok=True)
        os.environ.setdefault("MISHEL_SVC_DB", os.path.join(store, "mishel.db"))
    except OSError as exc:
        # Not fatal, and not silent. The service will fall back to its own
        # default — inside the bundle, where it does not survive — so say that
        # plainly rather than letting the operator discover it as lost history.
        print(f"  !! cannot write to {store}: {exc}", file=sys.stderr)
        print("     the database will not survive this session.", file=sys.stderr)

    # The eleven service loops: alerts, backups, the ledger resolver, the whale
    # watch, the dead-man's-switch heartbeat. Off by default in the gateway
    # because a gateway started to serve one backtest must not begin polling
    # vendors and writing to SQLite — and ON here, because this executable IS
    # the product and that is what `mishel_service.py`'s own `__main__` did
    # before consolidation. `IRAM_BACKGROUND=0` turns them off.
    os.environ.setdefault("IRAM_BACKGROUND", "1")

    import uvicorn
    from gateway.config import settings

    if not settings.is_loopback and not os.environ.get("IRAM_ALLOW_REMOTE"):
        print(
            f"Refusing to bind {settings.host}: this gateway has no authentication\n"
            f"of its own, and it proxies vendor API keys.",
            file=sys.stderr,
        )
        _hold_open_on_failure()
        return 2

    url = f"http://{settings.host}:{settings.port}"

    # ALREADY RUNNING: show the operator the copy they already have. Two
    # processes cannot share a port, so the alternative is not "start anyway",
    # it is "fail on the bind and close the window".
    running = gateway_at(settings.port)
    if running is not None:
        print("=" * 58)
        print("  IRAM Intelligence Trading is already running.")
        print(f"  {url}")
        print("=" * 58)
        if not os.environ.get("IRAM_NO_BROWSER"):
            webbrowser.open(url)
        return 0

    print("=" * 58)
    print("  IRAM Intelligence Trading")
    print(f"  {url}")
    print(f"  data   {os.environ.get('MISHEL_SVC_DB')}")
    print("  Close this window to stop.")
    print("=" * 58)

    if not os.environ.get("IRAM_NO_BROWSER"):
        threading.Thread(target=open_when_ready, args=(url, settings.port), daemon=True).start()

    from gateway.app import app

    try:
        uvicorn.run(app, host=settings.host, port=settings.port, log_level="info", access_log=False)
    except OSError as exc:
        print(f"\nCould not start: {exc}", file=sys.stderr)
        print(f"Something else is probably using port {settings.port}.", file=sys.stderr)
        print("Try:  IRAM_PORT=8788  before running this.", file=sys.stderr)
        _hold_open_on_failure()
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
