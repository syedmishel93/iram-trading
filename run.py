#!/usr/bin/env python3
"""
IRAM Intelligence Trading — THE launcher. One file, one server, one port.

    python run.py                  the terminal and the whole backend
    python run.py --status         say what is already running, start nothing
    python run.py --port 9000      when the default port is taken
    python run.py --legacy         open the frozen v39.29 terminal instead
    python run.py --no-background  without the eleven service loops
    python run.py --no-browser     for a headless box, or a second window
    python run.py --build          build the terminal first (needs Node.js)
    python run.py --install        install the Python dependencies and exit

===============================================================================
WHAT THIS REPLACES, AND WHY EVERY ONE OF THEM WAS WRONG
===============================================================================
Nine files started this product:

    run.bat  run.sh  run.command             ->  run.py
    start_mishel.bat  start_mishel.command   ->  start_mishel.py
    server/run_server.bat   run_server.sh    ->  ddt_data_server.py
    server/run_service.bat  run_service.sh   ->  mishel_service.py

Two of them held real and DIFFERENT logic, and both were wrong in the same way.
They started the pre-consolidation layout of three separate services --

    :8787  ddt_data_server.py   bars, quotes, the MT5 bridge
    :8788  mishel_service.py    the store, alerts, news, the journal
    :8789  quant/app.py         the models

-- and served the terminal itself on :8000. The frontend stopped being able to
work with that. `app/src/data/backend.ts` now holds ONE base address for all
three services, because `server/gateway` hosts all three in one process. A page
served from :8000 carries no `iram-backend` meta tag, so it falls back to the
shipped default of `http://127.0.0.1:8787` FOR EVERYTHING -- and :8787 in the
old layout is the data proxy, which answers `/svc/*` and `/quant/*` with its own
Flask HTML 404 page.

That is not a prediction. It is exactly the two failures an operator sees: every
Quant card reading `HTTP 404`, and the news bar reading "the news service is not
answering on this address" -- which is the sentence `data/rss.ts` prints when
`res.json()` chokes on the `<` of an HTML 404 body. Both services were running
and healthy the whole time. They were being asked on the wrong port.

So this starts `server/gateway` and NOTHING else. The gateway serves the
terminal at `/` and marks it same-origin, which removes the cross-origin hop,
takes the CORS policy out of the request path, and removes the entire class of
fault above by construction rather than by configuration.

===============================================================================
WHY THE LOGIC IS IN PYTHON AND `run.sh` IS THREE LINES
===============================================================================
A shell script cannot be the single entry point: Windows will not run a `.sh`
from a double-click, and `.bat` does not exist off Windows. Something has to
bridge that, and the only language guaranteed present is the one the backend is
already written in. So `run.sh`, `run.bat` and `run.command` are now identical
three-line wrappers whose whole job is finding an interpreter, and every
decision lives here, once, where all three platforms read the same copy.

===============================================================================
WHY THERE IS NO WATCHDOG ANY MORE
===============================================================================
`start_mishel.py` restarted a service up to three times. That existed because
three processes could die independently -- and what it actually papered over was
a MISSING DEPENDENCY: a service whose import failed got relaunched every ten
seconds forever, which is a log file that fills a disk. The gateway answers that
case properly. A service that will not import becomes a 503 naming the
dependency, the other two keep working, and `/api/health` says which is which.
One process is left to supervise, so this reports its exit and holds the window
open to be read, instead of hiding the cause behind a restart.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

# A Windows console defaults to cp1252 and raises on any character it cannot
# encode, which takes the launcher down before it can print why. Every entry
# script in this repository does this; the banners below stay inside ASCII as
# well, so the output is readable even where the reconfigure is unavailable.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
except Exception:  # noqa: BLE001, S110 — a console that cannot be reconfigured
    pass           # is still a console; failing here would lose every message

ROOT = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(ROOT, "server")
TERMINAL = os.path.join(ROOT, "app", "dist", "index.html")
REQUIREMENTS = os.path.join(SERVER, "requirements.txt")

#: The gateway's own default, and the shipped default in `data/backend.ts`.
#: They have to agree: a terminal opened from a `file://` double-click has no
#: same-origin marker to read and can only use the literal.
DEFAULT_PORT = 8787

#: What the gateway itself cannot start without. Everything else is a service it
#: hosts, and a missing dependency there degrades that service to a 503 naming
#: the package -- see `gateway/legacy.py`. Only these three are fatal.
REQUIRED: tuple[tuple[str, str], ...] = (
    ("fastapi", "fastapi"),
    ("uvicorn", "uvicorn"),
    ("pydantic", "pydantic"),
)

#: Imported by the hosted services. Absence is reported, never fatal.
OPTIONAL: tuple[tuple[str, str], ...] = (
    ("flask", "the store, the data proxy and the model service"),
    ("flask_cors", "the store, the data proxy and the model service"),
    ("requests", "every vendor call"),
    ("httpx", "the in-process /ohlc client and live streaming"),
    ("yfinance", "stocks, indices, futures and gold"),
    ("numpy", "every model on the Quant desk"),
    ("pandas", "every model on the Quant desk"),
    ("sklearn", "the ML baseline and calibration"),
)

BAR = "=" * 66


# --------------------------------------------------------------- probing -----

def port_free(port: int, host: str = "127.0.0.1") -> bool:
    """True when nothing holds the port.

    A connect probe rather than a bind probe on purpose: binding to test would
    have to release the socket before the server takes it, and on Windows a
    released socket can linger long enough for the real bind to fail.
    Connecting asks the only question that matters -- is somebody answering.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.4)
        return s.connect_ex((host, port)) != 0


def gateway_at(port: int, timeout: float = 2.0) -> dict | None:
    """This gateway's health on `port`, or None when what answers is not it.

    THE DISTINCTION THAT MAKES A SECOND RUN HARMLESS. A busy port is two
    completely different situations: this product already running, where the
    right move is to open a browser at it and start nothing; or something else
    entirely, where moving to another port is right and taking the port is
    impossible anyway. Only the payload separates them, so this reads it instead
    of treating "busy" as one state.
    """
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=timeout) as r:
            body = json.loads(r.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    return body if isinstance(body, dict) and "services" in body else None


def choose_port(wanted: int, explicit: bool) -> tuple[int, dict | None]:
    """The port to use, and the health of an instance already on it.

    An explicitly requested port is never silently moved. If `--port 9000`
    cannot be had, that is worth failing on, because the operator chose 9000 for
    a reason this cannot know -- a firewall rule, a bookmark, a reverse proxy.
    The default may drift upwards, because "8787 is busy" is not a decision
    anybody made.
    """
    found = gateway_at(wanted)
    if found is not None or port_free(wanted):
        return wanted, found
    if explicit:
        return wanted, None
    for port in range(wanted + 1, wanted + 12):
        if port_free(port):
            print(f"  note: port {wanted} is taken by something else -- using {port}.")
            return port, None
    return wanted, None


# ---------------------------------------------------------- dependencies -----

def absent(pairs: tuple[tuple[str, str], ...]) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for module, label in pairs:
        try:
            __import__(module)
        except Exception:  # noqa: BLE001 — ANY failure means "not usable here"
            # Not just ImportError. A half-installed numpy raises ValueError from
            # its own __init__, a broken sklearn raises OSError on a missing DLL,
            # and every one of those means the same thing to a launcher: this
            # package cannot be relied on. Narrowing the catch would let a
            # corrupt install crash the dependency CHECK.
            out.append((module, label))
    return out


def install_requirements() -> bool:
    """`pip install -r server/requirements.txt`, with its output on screen.

    NOT quiet. A pip run that takes four minutes to build scipy and prints
    nothing is indistinguishable from a hang, and the one conclusion a
    first-time operator must not reach is that the launcher is broken.
    """
    if not os.path.isfile(REQUIREMENTS):
        print(f"  !! {REQUIREMENTS} is missing; there is nothing to install.", file=sys.stderr)
        return False
    print("  installing dependencies ...")
    print(f"  ({sys.executable})")
    code = subprocess.call([sys.executable, "-m", "pip", "install", "-r", REQUIREMENTS])
    if code != 0:
        print("\n  !! pip failed. Install by hand, then run this again:", file=sys.stderr)
        print(f"     {sys.executable} -m pip install -r {REQUIREMENTS}", file=sys.stderr)
        return False
    return True


def check_dependencies(auto_install: bool) -> bool:
    """Fatal dependencies first, then a report on the optional ones.

    The two lists are separate because collapsing them makes a working install
    look broken. A machine without scikit-learn runs the terminal, the charts,
    the journal, the alerts and the data proxy perfectly well and loses the
    Quant desk; reporting that as "dependencies missing" would send somebody
    installing a gigabyte of scientific libraries to fix a chart that was fine.
    """
    fatal = absent(REQUIRED)
    if fatal and auto_install:
        print(f"  the gateway needs {', '.join(m for m, _ in fatal)} -- not installed yet.")
        if not install_requirements():
            return False
        fatal = absent(REQUIRED)
    if fatal:
        print(BAR, file=sys.stderr)
        print("  The gateway cannot start. Missing:", file=sys.stderr)
        for module, package in fatal:
            print(f"    {module:12s} (pip install {package})", file=sys.stderr)
        print("\n  Install everything:  python run.py --install", file=sys.stderr)
        print(BAR, file=sys.stderr)
        return False

    optional = absent(OPTIONAL)
    if optional:
        print("  optional packages absent -- everything else still runs:")
        for module, costs in optional:
            print(f"    {module:12s} without it: {costs}")
        print("  install them:  python run.py --install")
    return True


# ---------------------------------------------------------------- serving ----

def build_terminal() -> bool:
    """`npm --prefix app run build`. Only ever on request.

    Not automatic, and that is a decision rather than an omission. A build takes
    tens of seconds, writes into the tree, and needs a toolchain that has
    nothing to do with running the product -- the shipped binary carries the
    built terminal and no Node at all. A launcher that silently started a build
    would make the first run of a fresh download look like a hang.
    """
    npm = shutil.which("npm")
    if npm is None:
        print("  !! npm is not on PATH. Install Node.js from https://nodejs.org", file=sys.stderr)
        return False
    if not os.path.isdir(os.path.join(ROOT, "app", "node_modules")):
        print("  installing frontend packages (first build only) ...")
        if subprocess.call([npm, "--prefix", "app", "install"], cwd=ROOT) != 0:
            return False
    print("  building the terminal ...")
    return subprocess.call([npm, "--prefix", "app", "run", "build"], cwd=ROOT) == 0


def report(health: dict) -> None:
    """Which services imported, which did not, and what each absence costs."""
    for name, info in (health.get("services") or {}).items():
        if info.get("ok"):
            print(f"  [ok]    {name:6s} {' '.join(info.get('prefixes') or [])}")
        else:
            print(f"  [DOWN]  {name:6s} {info.get('error')}")
            print(f"          without it: {info.get('provides')}")
    background = health.get("background") or {}
    if not background.get("enabled"):
        print("  [--]    loops  off (drop --no-background for alerts and backups)")
        return

    # `loops` is a MAPPING of name -> {started, error, last_tick_age_s}, which
    # is what `gateway/background.py` actually returns. The first version of
    # this function guessed a LIST of records, iterated the keys as though they
    # were dicts, and fell back to `len(loops)` -- so it would have reported
    # "11 loops running" with three of them dead. Read the real shape.
    loops: dict = background.get("loops") or {}
    started = [n for n, s in loops.items() if s.get("started")]
    failed = [(n, s.get("error")) for n, s in loops.items() if not s.get("started")]
    print(f"  [ok]    loops  {len(started)} of {len(loops)} service loops running")
    for name, error in failed:
        print(f"  [DOWN]  loop   {name}: {error}")


def announce(base: str, target: str, health: dict | None) -> None:
    """The banner. `base` is the origin, `target` the page to open.

    Two parameters rather than deriving one from the other, because the obvious
    derivation is wrong: `str.rstrip("/legacy")` takes a SET OF CHARACTERS, not
    a suffix, so it would eat any trailing `/`, `l`, `e`, `g`, `a`, `c` or `y`
    from the origin as well. Passing both is shorter than the correct strip.
    """
    print(BAR)
    print("  IRAM Intelligence Trading")
    print(f"  Terminal   {target}")
    print(f"  Health     {base}/api/health")
    print(f"  Endpoints  {base}/docs")
    if health is not None:
        report(health)
    print("  Ctrl+C stops it.")
    print(BAR, flush=True)


def wait_for_health(port: int, seconds: float = 40.0) -> dict | None:
    """Poll `/api/health` until it answers.

    Waiting on the HEALTH endpoint rather than on the port, because the port
    opens before the application is usable: uvicorn binds first, and the
    lifespan then imports three Flask services, which on a cold start is several
    seconds of scipy and yfinance. A browser opened at the bind lands on a page
    whose desks all report their service missing, and the operator reads the
    product as broken at the one moment it is merely slow.
    """
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        found = gateway_at(port, timeout=1.0)
        if found is not None:
            return found
        time.sleep(0.35)
    return None


def hold_open() -> None:
    """Keep a double-clicked window up long enough to read the failure.

    Without it every failure -- a taken port, a missing package, a corrupt
    database -- is a window that opens and vanishes, which is indistinguishable
    from the program having done nothing at all.
    """
    if os.environ.get("IRAM_NO_HOLD") or sys.stdin is None or not sys.stdin.isatty():
        return
    try:
        input("\nPress Enter to close ...")
    except (EOFError, KeyboardInterrupt):
        pass


def serve(port: int, background: bool, legacy: bool, browser: bool) -> int:
    """Start the gateway and stay with it until it stops.

    A SUBPROCESS, NOT AN IMPORT, and that is the one choice here worth arguing
    about. Importing `gateway.app` and calling uvicorn from this file would be
    one process instead of two -- and also a THIRD copy of "how to start this
    server", beside `gateway/__main__.py` and the frozen binary's `entry.py`.
    Three copies of one decision is how `tests/run_tests.sh` came to carry a
    test list that had drifted from `verify.py` by five files. The gateway's own
    entry point stays the only place that calls uvicorn, and stdio is inherited
    so its output arrives in this window as though it were.
    """
    env = dict(os.environ)
    env["IRAM_PORT"] = str(port)
    env["IRAM_BACKGROUND"] = "1" if background else "0"
    # The gateway is loopback-only unless the operator says otherwise, and this
    # launcher never overrides that: the reason is not a preference. The gateway
    # has no authentication of its own and forwards vendor API keys.
    env.setdefault("IRAM_HOST", "127.0.0.1")

    base = f"http://127.0.0.1:{port}"
    # `-u`, and this launcher flushes its own writes below, because stdout is
    # BLOCK-BUFFERED whenever it is not a terminal. Redirect the output to a
    # file or a pipe without this and the startup report -- including which
    # service failed to import -- arrives minutes later or not at all, which is
    # precisely the situation in which somebody is reading a log.
    proc = subprocess.Popen([sys.executable, "-u", "-m", "gateway"], cwd=SERVER, env=env)

    def follow() -> None:
        health = wait_for_health(port)
        if health is None:
            # Not fatal on its own: the gateway may simply be slower than the
            # window on a cold import, and its own output is already on screen.
            print("  note: /api/health has not answered yet -- the log above says why.")
            return
        target = f"{base}/legacy" if legacy else f"{base}/"
        announce(base, target, health)
        if browser:
            webbrowser.open(target)

    threading.Thread(target=follow, daemon=True).start()

    try:
        code = proc.wait()
    except KeyboardInterrupt:
        # Ctrl+C in a console already reaches the child. This waits for it to
        # finish rather than printing "stopped" while the port is still held.
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.terminate()
        print("\nStopped.")
        return 0

    if code != 0:
        print(f"\n  !! the gateway exited with code {code}.", file=sys.stderr)
        print("  The output above is its own. The usual causes:", file=sys.stderr)
        print(f"    * something took port {port} between the check and the bind", file=sys.stderr)
        print("      -> python run.py --port 9000", file=sys.stderr)
        print("    * a dependency is missing -> python run.py --install", file=sys.stderr)
        hold_open()
    return code


# ------------------------------------------------------------------- main ----

def main() -> int:
    ap = argparse.ArgumentParser(
        prog="run.py",
        description="Start the IRAM terminal and its backend. One process, one port.",
    )
    ap.add_argument("--port", type=int, default=None, help=f"default {DEFAULT_PORT}")
    ap.add_argument("--legacy", action="store_true", help="open the frozen v39.29 terminal")
    ap.add_argument("--no-background", action="store_true", help="skip the service loops")
    ap.add_argument("--no-browser", action="store_true", help="do not open a browser")
    ap.add_argument("--build", action="store_true", help="build the terminal first (needs Node)")
    ap.add_argument("--install", action="store_true", help="install Python dependencies, then exit")
    ap.add_argument("--status", action="store_true", help="report what is running; start nothing")
    args = ap.parse_args()

    os.chdir(ROOT)

    if args.install:
        return 0 if install_requirements() else 1

    explicit = args.port is not None
    wanted = args.port if explicit else int(os.environ.get("IRAM_PORT") or DEFAULT_PORT)

    if args.status:
        print(BAR)
        print("  IRAM status")
        # The historical ports as well as the current one: an operator who last
        # ran the old three-process launcher has processes on :8788 and :8789,
        # and "nothing is running" would be the wrong thing to tell them.
        for port in sorted({wanted, DEFAULT_PORT, 8000, 8788, 8789, 8799}):
            found = gateway_at(port, timeout=0.8)
            if found is not None:
                print(f"  gateway on {port}   version {found.get('version')}")
                report(found)
            elif not port_free(port):
                print(f"  port {port} is held by something that is not this gateway")
        built = "yes" if os.path.isfile(TERMINAL) else f"no  ({TERMINAL})"
        print(f"  terminal built: {built}")
        print(BAR)
        return 0

    print(BAR)
    print("  IRAM Intelligence Trading -- starting")
    # Flushed, because the CHILD's output is unbuffered (`-u`) while this
    # process's is block-buffered whenever stdout is not a terminal. Measured
    # in a redirected run: the gateway's whole startup report printed BEFORE
    # this banner, so a log read top-down told the story backwards.
    print(BAR, flush=True)

    port, running = choose_port(wanted, explicit)

    # ALREADY UP: open a browser at it and start nothing. Two copies cannot
    # share a port, and the second one dying on bind while the console said
    # nothing about it is how `run.bat` and `start_mishel.bat` used to fight.
    if running is not None:
        print(f"  already running on {port} -- left alone.")
        base = f"http://127.0.0.1:{port}"
        target = f"{base}/legacy" if args.legacy else f"{base}/"
        announce(base, target, running)
        if not args.no_browser:
            webbrowser.open(target)
        return 0

    if not check_dependencies(auto_install=True):
        hold_open()
        return 1

    if args.build and not build_terminal():
        hold_open()
        return 1

    if not args.legacy and not os.path.isfile(TERMINAL):
        # Not fatal. The gateway serves a page at `/` that says exactly this,
        # and the API is fully usable meanwhile -- which is how the whole
        # backend is developed. Printing it here too saves the round trip.
        print("  note: the terminal is not built yet, so / will explain how to build it.")
        print("        build it now:  python run.py --build", flush=True)

    return serve(port, not args.no_background, args.legacy, not args.no_browser)


if __name__ == "__main__":
    raise SystemExit(main())
