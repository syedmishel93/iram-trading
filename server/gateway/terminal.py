"""
Serving the terminal itself, from the same process as its backend.

WHY THIS IS PART OF THE GATEWAY AND NOT A SEPARATE STATIC SERVER
The product was two processes: `run.py` served the page on :8000, the backend
answered on :8787, and the operator had to start both in the right order. Every
request between them was cross-origin, so every one of them preflighted, and a
misconfigured CORS policy took down a terminal that was otherwise fine.

Served from here, the normal case is same-origin: no preflight, no policy to get
wrong, and one thing to run. The CORS policy in `app.py` stays because `file://`
and the Vite dev server are still real ways to open this, and both genuinely are
cross-origin.

WHERE THE FILE COMES FROM, IN THREE SITUATIONS
  * A frozen binary  — bundled next to the executable by PyInstaller.
  * A source checkout — `app/dist/index.html`, if `npm run build` has been run.
  * Neither          — `/` explains how to build it. NOT a 404: a 404 at the
                       root of something you just started reads as "broken",
                       and this state is how every developer runs the project.

WHAT IT REFUSES TO DO
It serves ONE file. There is no directory listing, no path traversal surface and
no second asset, because the terminal is a single self-contained `index.html` by
deliberate design — `vite-plugin-singlefile` inlines every script, style and
font precisely so that this is true. A static file server here would be a
directory of attack surface serving a directory with one file in it.
"""

from __future__ import annotations

import hashlib
import os
import sys
from typing import Any

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, PlainTextResponse, Response


#: Where the built terminal might be, in order of preference.
#:
#: `sys._MEIPASS` is PyInstaller's extraction directory and only exists in a
#: frozen build; the repository path is what a checkout uses.
def _candidates() -> list[str]:
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # server/
    repo = os.path.dirname(here)
    out: list[str] = []

    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        out.append(os.path.join(str(bundled), "terminal", "index.html"))
        # Beside the executable, so a user can drop in a newer build without
        # rebuilding the binary.
        out.append(os.path.join(os.path.dirname(sys.executable), "terminal.html"))

    out.append(os.path.join(repo, "app", "dist", "index.html"))
    return out


def terminal_path() -> str | None:
    """The built terminal, or None when it has not been built."""
    override = os.environ.get("IRAM_TERMINAL")
    if override:
        return override if os.path.isfile(override) else None
    for path in _candidates():
        if os.path.isfile(path):
            return path
    return None


def legacy_path() -> str | None:
    """The frozen v39.29 terminal at the repository root, if it is there.

    NOT a fallback for the current terminal, and never served at `/`. It exists
    because `run.py --legacy` was a real feature of the launcher this gateway
    replaced, and dropping it would have been a silent subtraction — the old
    terminal is the only place some of the July behaviour can still be observed.

    Absent in a frozen build on purpose: `LEGACY.md` freezes that file and the
    binary ships the current terminal. `/legacy` then says so rather than 404ing.
    """
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # server/
    path = os.path.join(os.path.dirname(here), "index.html")
    return path if os.path.isfile(path) else None


NO_LEGACY = """The frozen v39.29 terminal is not present in this build.

It lives at index.html in the repository root and is not bundled into the
binary — see LEGACY.md. Run from a checkout to reach it.
"""


NOT_BUILT = """IRAM gateway is running, but the terminal has not been built.

    npm --prefix app install
    npm --prefix app run build

That writes app/dist/index.html, which this serves at /.

The API is up regardless:
    /docs          the endpoint browser
    /api/health    every service, in one answer
"""


#: Tells the terminal that the page it is on IS the backend.
#:
#: The alternative is for the frontend to guess. It cannot: the same build is
#: served from the Vite dev server on :5173, from `run.py` on :8000, from a
#: `file://` double-click and from here — and in exactly one of those four the
#: page origin is also the API. Only the server knows which case it is, so the
#: server is what says so. A page served by anything else has no such tag and
#: keeps the configured default.
MARKER = '<meta name="iram-backend" content="same-origin">'


def _mark_same_origin(html: str) -> str:
    if MARKER in html:
        return html
    head = html.find("<head>")
    if head < 0:
        return html
    at = head + len("<head>")
    return f"{html[:at]}\n    {MARKER}{html[at:]}"


def mount_terminal(app: FastAPI) -> None:
    """Serve the built terminal at `/`, or say why it is not there."""

    #: The last file served, keyed by path+mtime, with its ETag.
    #:
    #: Read once and re-read only when the file actually changes on disk. The
    #: terminal is 1.1 MB and was being read, marked and encoded on EVERY page
    #: load — which on a dev machine is every rebuild-and-refresh cycle.
    cache: dict[str, tuple[float, str, str]] = {}

    @app.get("/", include_in_schema=False)
    async def index(request: Request) -> Any:
        path = terminal_path()
        if path is None:
            # 200, not 404. The gateway IS running and this is a normal state
            # for a source checkout; a 404 at the root reads as a broken server
            # and sends the reader looking for the wrong fault.
            return PlainTextResponse(NOT_BUILT, status_code=200)

        stamp = os.path.getmtime(path)
        hit = cache.get(path)
        if hit is None or hit[0] != stamp:
            # OFF THE EVENT LOOP.
            #
            # This is a 1.1 MB read inside an `async def`, which means it does
            # not merely take time -- it blocks EVERY other request for the
            # duration, including the SSE streams the terminal holds open. The
            # cache above makes it rare (once per rebuild), and rare is not the
            # same as harmless: the one request that pays for it is the page
            # load, and the things it stalls are the live feeds that page is
            # about to depend on.
            #
            # `run_in_threadpool` is starlette's own hand-off, already a
            # dependency, and it is what FastAPI uses internally for sync route
            # handlers. The read and the marking both move, because
            # `_mark_same_origin` walks the whole 1.1 MB string.
            def _read() -> str:
                with open(path, "r", encoding="utf-8") as fh:
                    return _mark_same_origin(fh.read())

            html = await run_in_threadpool(_read)
            etag = '"' + hashlib.sha256(html.encode("utf-8")).hexdigest()[:32] + '"'
            cache[path] = (stamp, html, etag)
        _, html, etag = cache[path]

        # NO-CACHE PLUS AN ETAG, NOT NO-STORE.
        #
        # The first version sent `no-store`, which is right about the danger — a
        # cached terminal running against a newer backend is a bug report about
        # something already fixed — and pays for it by re-downloading 1.1 MB on
        # every single reload.
        #
        # `no-cache` keeps the whole guarantee: the browser MUST revalidate, so
        # it can never quietly serve a stale build. The ETag then makes that
        # revalidation a 304 with an empty body whenever the file has not
        # changed. Same correctness, a fraction of the bytes.
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"etag": etag, "cache-control": "no-cache"})

        return HTMLResponse(html, headers={"cache-control": "no-cache", "etag": etag})

    @app.get("/legacy", include_in_schema=False)
    async def legacy() -> Any:
        """The frozen v39.29 terminal, served exactly as it is.

        DELIBERATELY WITHOUT THE `iram-backend` MARKER. That tag tells the
        CURRENT terminal that the page it came from is also its API; v39 does
        not read it and addresses :8787 and :8788 as literals of its own. Adding
        the marker would be claiming to configure something that cannot be
        configured, and stripping the file of its own idea of where the backend
        is would be editing a file that is frozen.

        Also off the event loop, and for the harder version of the same reason
        as `/` — this one is 1.5 MB and has no mtime cache, because it is opened
        rarely and caching a file nobody asks for twice costs memory for nothing.
        """
        path = legacy_path()
        if path is None:
            return PlainTextResponse(NO_LEGACY, status_code=200)

        def _read() -> str:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()

        return HTMLResponse(await run_in_threadpool(_read), headers={"cache-control": "no-cache"})
