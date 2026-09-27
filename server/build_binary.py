#!/usr/bin/env python3
"""
Build IRAM as one executable: no Python install, no pip, no terminal.

    python server/build_binary.py            # core  — data, store, terminal
    python server/build_binary.py --full     # + the quant service
    python server/build_binary.py --clean    # discard the build venv first

WHY THIS EXISTS
The terminal charts Binance and nothing else until `ddt_data_server.py` is
running, because forex, metals and equities have no browser-reachable feed. So
the instruments most people actually trade are gated behind installing Python,
installing six packages, and starting a process from a shell — for a product
whose headline is that it opens from a double-click. Every analytic in this
repository is worth nothing on an instrument that will not load.

The gateway made this buildable: one process now serves the data proxy, the
store, the model service, the streaming socket AND the terminal itself, so a
single executable is the whole product rather than one of its four parts.

TWO PROFILES, AND THE REASON IS SIZE RATHER THAN TASTE
`quant/` needs numpy, scipy, pandas and scikit-learn. Frozen, that is roughly
300 MB against roughly 60 MB without — a five-fold increase to a download, for
a service the terminal already degrades gracefully without and which most
operators never open. So CORE is the default and `--full` is a deliberate ask.
`/api/health` names the missing service either way, so a core build is honest
about what it is rather than silently lacking a desk.

THE BUILD VENV IS ISOLATED, DELIBERATELY
It installs into `server/build/venv`, never into the Python running this script.
A build tool that mutates the developer's environment to build is a build tool
that has to be undone, and PyInstaller pulls a compiler shim and a hook library
that have no business in a runtime environment.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import venv

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "build")
VENV = os.path.join(BUILD, "venv")
TERMINAL = os.path.join(REPO, "app", "dist", "index.html")

#: Runtime dependencies of a CORE build.
#:
#: `yfinance` IS NOT HERE, AND THAT WAS A BUG FOR SEVERAL RELEASES.
#: It used to be, and the core binary shipped it broken: yfinance imports pandas
#: and numpy at module scope, both of which `CORE_EXCLUDES` removes, so every
#: request to that provider answered
#: `502 {"error": "yfinance: No module named 'numpy'"}`.
#:
#: The exclusion was not the mistake — the comment on `CORE_EXCLUDES` calls those
#: imports "optional", which is true of scipy and sklearn inside yfinance and
#: false of numpy and pandas. The mistake was paying to install a provider the
#: same build then guaranteed could not start. Core is crypto-only, honestly:
#: Binance needs nothing but `requests` and `websockets`.
#:
#: Gold, FX and the indices — and so any cross-market survey from a packaged
#: binary — need `--full`. `check_profile()` below now refuses to build a
#: combination like this again.
CORE_DEPS = [
    "fastapi>=0.115",
    "uvicorn>=0.30",
    "pydantic>=2.7",
    "flask>=3.0",
    "flask-cors>=4.0",
    "requests>=2.31",
    "httpx>=0.27",
    "websockets>=12.0",
]

#: What `--full` adds. Each one is large; together they are most of the binary.
#:
#: `yfinance` rides here because it cannot run without the first two, and it is
#: what serves every non-crypto market the terminal knows about.
#:
#: WHAT THIS LIST COSTS THE QUANT DESK, MEASURED ON THE BUILT BINARY.
#: `/quant/health` on the `--full` exe reported **4 of 19 libraries present**
#: and **13 capabilities degraded** — honestly reported, and far thinner than
#: the desk a source checkout runs. `statsmodels` and `arch` were the two worth
#: adding, because each one restores a whole card that has no exotic dependency
#: of its own:
#:
#:   statsmodels  edge significance, stationarity (ADF/KPSS), lead/lag
#:   arch         GARCH and GJR-GARCH volatility, raced against the EWMA
#:
#: The rest stay out on size, and the reasoning is theirs rather than a blanket
#: rule: `torch` is ~200 MB frozen for one neural cross-check, `darts` drags in
#: torch and lightgbm for the forecasting race, `prophet` carries a Stan
#: binary, and `biogeme`/`causalml` need a C++ toolchain at install time. The
#: desk greys those cards out and names the missing package, which is the
#: correct behaviour for a capability that was not shipped.
FULL_DEPS = [
    "numpy>=1.26",
    "scipy>=1.11",
    "pandas>=2.0",
    "scikit-learn>=1.3",
    "yfinance>=0.2.40",
    "statsmodels>=0.14",
    "arch>=6.3",
]

#: Modules PyInstaller cannot see, because nothing imports them by name.
#:
#: uvicorn resolves its protocol implementations from configuration strings at
#: runtime, so a static import graph misses every one of them and the binary
#: starts and then fails to serve anything. This list is the difference between
#: a working executable and one that boots to a stack trace.
HIDDEN = [
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.loops.asyncio",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.protocols.websockets.websockets_impl",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # The legacy services are reached through `__import__` in gateway/legacy.py,
    # which is a runtime string and therefore invisible to the analyser too.
    "ddt_data_server",
    "mishel_service",
    # The database package. `mishel_service` imports it normally, but only
    # AFTER inserting its own directory into sys.path at runtime — which the
    # analyser does not execute, so it cannot follow the import and would
    # bundle a service that dies on `ModuleNotFoundError: No module named 'db'`
    # the first time anyone ran the packaged product.
    "db",
    "db.driver",
    "db.schema",
    "db.sqlrewrite",
    # The service's own sections, same reason. Every module added under
    # `server/svc/` has to be named here or the binary ships without it.
    "svc",
    "svc.bars",
    "svc.bulkfetch",
    "svc.store",
    "svc.core",
    "svc.onchain",
    "svc.mt5",
    "svc.risk",
    "svc.research",
    "svc.sync",
    "svc.alerts",
    "svc.signals",
    "svc.features",
    # The router (v62.2). sklearn only — lightgbm and xgboost are excluded on
    # size, and HistGradientBoosting is the same family already installed.
    "svc.mcp",
    "svc.mcpserve",
    "svc.backfill",
    "svc.mcpauth",
    "svc.settings",
    "svc.router",
    # The autonomous loop (v62.6), and the paths it shares with `gateway/lab.py`.
    # `enginepath` is imported by BOTH and belongs to neither, so the analyser
    # reaches it only through the same runtime `sys.path` insert that hides `db`.
    "svc.auto",
    "enginepath",
    "mishel_data",
    "mishel_rss",
    "mishel_risk",
    "mishel_recon",
    "mishel_edge",
    "mishel_claims",
    "mishel_analyst",
]

#: Hidden imports for the `--full` profile.
#:
#: `statsmodels` resolves a great deal of itself through `__getattr__` on its
#: lazy `api` modules, so the static graph misses the model classes even though
#: `quant/stats.py` imports them by name; `arch` reaches its Cython recursions
#: the same way. Both are listed rather than discovered, because the failure
#: mode is a binary that starts and then answers one card with an
#: `ImportError` — which reads as the service being broken.
FULL_HIDDEN = [
    "quant.app",
    "sklearn.utils._typedefs",
    "scipy._lib.array_api_compat.numpy.fft",
    # Read off the call-time imports in `quant/stats.py` and
    # `quant/volatility.py` rather than guessed: `statsmodels.api` (58),
    # `statsmodels.stats.stattools` (59), `statsmodels.stats.diagnostic` (87),
    # `statsmodels.tsa.stattools` (172, 294), and `from arch import arch_model`
    # (volatility.py 99, 133).
    "statsmodels.api",
    "statsmodels.stats.stattools",
    "statsmodels.stats.diagnostic",
    "statsmodels.tsa.stattools",
    "arch",
    "arch.univariate",
    "arch.univariate.recursions_python",
]

#: Excluded from a CORE build. Without this, PyInstaller follows an optional
#: import inside yfinance or flask and pulls the entire scientific stack into
#: the build that exists specifically to not contain it.
#:
#: `yfinance` IS EXCLUDED TOO, and dropping it from `CORE_DEPS` was not enough.
#: `ddt_data_server.p_yfinance` imports it inside the function, and PyInstaller
#: follows a lazy import as readily as a top-level one — so as long as the build
#: venv had it installed (from an earlier full build, or from `--full`), it kept
#: being bundled without numpy beside it. The provider then answered
#: `yfinance: No module named 'numpy'`, which reads as a broken install rather
#: than as a build that does not carry that provider.
#:
#: Excluded, the same code path answers `yfinance: No module named 'yfinance'` —
#: the honest message for a core build, produced by the `try` the data server
#: already has around it.
#: `statsmodels` and `arch` are here for the yfinance reason exactly, and the
#: trap is sharper for them: the build venv is SHARED between profiles, so the
#: first `--full` build installs both and every later core build has them
#: sitting there importable. `quant` is already excluded, which is what makes
#: them unreachable — but that was true of yfinance's numpy too, and the lazy
#: import inside a function still pulled it in. Excluding them by name means a
#: core build cannot start carrying 60 MB of models it has no numpy to run.
CORE_EXCLUDES = [
    "scipy", "sklearn", "matplotlib", "pandas", "numpy",
    "quant", "IPython", "tkinter", "yfinance",
    "statsmodels", "arch",
]


def check_profile(python: str, deps: list[str], excludes: list[str]) -> None:
    """Refuse to build a profile that installs a package it then breaks.

    THE FAILURE THIS PREVENTS, which shipped: `yfinance` was a core dependency
    while `numpy` and `pandas` were core exclusions. pip installed it, PyInstaller
    stripped what it imports at module scope, and the packaged binary answered
    every gold, FX and index request with a `ModuleNotFoundError` wearing a 502.
    Nothing in the build said a word — the binary was produced, it started, and
    it served the terminal perfectly.

    A build that cannot work is worth catching at BUILD time, where the message
    can name both halves of the contradiction, rather than in a browser three
    weeks later where it reads as "gold is broken".

    Only top-level requirements are checked, and optional extras are ignored: an
    `extra ==` marker is exactly the "optional import" the exclusions are for.
    """
    import re

    excluded = {e.lower() for e in excludes}
    named = {re.split(r"[><=!\[]", d, 1)[0].strip().lower() for d in deps}

    probe = (
        "import importlib.metadata as m, sys\n"
        "try:\n"
        "    reqs = m.requires(sys.argv[1]) or []\n"
        "except Exception:\n"
        "    reqs = []\n"
        "print(chr(10).join(reqs))\n"
    )

    problems: list[str] = []
    for dep in sorted(named):
        out = subprocess.run(  # noqa: PLW1510  (checked below)
            [python, "-c", probe, dep], capture_output=True, text=True
        )
        if out.returncode != 0:
            continue
        for line in out.stdout.splitlines():
            # An `extra ==` marker IS the optional import the exclusions exist
            # for — scipy inside yfinance is genuinely optional, numpy is not.
            if "extra ==" in line:
                continue
            req = re.split(r"[><=!;\[ ]", line.strip(), 1)[0].strip().lower()
            if req in excluded:
                problems.append(f"{dep} requires {req}, which this profile excludes")

    if not problems:
        return

    detail = "\n  ".join(problems)
    raise SystemExit(
        "! this build profile contradicts itself:\n  "
        + detail
        + "\n\n  Either drop the dependency from the profile, or stop excluding what it needs."
        + "\n  Building anyway produces a binary that starts and then fails every request"
        + "\n  to that provider — which is how the yfinance/numpy bug reached users."
        + "\n\n  For the full data providers (gold, FX, indices), build with --full."
    )


def run(cmd: list[str], **kw: object) -> None:
    print(f"  $ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, **kw)  # type: ignore[arg-type]


def venv_python() -> str:
    exe = "python.exe" if os.name == "nt" else "python"
    sub = "Scripts" if os.name == "nt" else "bin"
    return os.path.join(VENV, sub, exe)


def ensure_venv(full: bool, clean: bool) -> str:
    if clean and os.path.isdir(VENV):
        print("· discarding the previous build venv")
        shutil.rmtree(VENV)

    py = venv_python()
    if not os.path.isfile(py):
        print(f"· creating an isolated build venv at {VENV}")
        venv.EnvBuilder(with_pip=True, clear=True).create(VENV)
        py = venv_python()

    deps = [*CORE_DEPS, *(FULL_DEPS if full else []), "pyinstaller>=6.0"]
    print(f"· installing {len(deps)} build dependencies (this is the slow part)")
    run([py, "-m", "pip", "install", "--upgrade", "pip", "--quiet"])
    run([py, "-m", "pip", "install", "--quiet", *deps])

    # Checked after install, because the answer comes from the installed
    # metadata rather than from the pin strings above — an optional extra and a
    # hard requirement look identical in a requirements list.
    check_profile(py, deps, CORE_EXCLUDES if not full else [])
    return py


def build(py: str, full: bool) -> str:
    name = "iram" if not full else "iram-full"
    dist = os.path.join(BUILD, "dist")

    cmd = [
        py, "-m", "PyInstaller",
        "--onefile",
        "--name", name,
        "--distpath", dist,
        "--workpath", os.path.join(BUILD, "work"),
        "--specpath", BUILD,
        "--noconfirm",
        # Console, not windowed: this IS a server and its log is the only place
        # "the port is in use" or "that vendor refused us" can be read.
        "--console",
        "--paths", HERE,
    ]

    for mod in [*HIDDEN, *(FULL_HIDDEN if full else [])]:
        cmd += ["--hidden-import", mod]
    if not full:
        for mod in CORE_EXCLUDES:
            cmd += ["--exclude-module", mod]

    if os.path.isfile(TERMINAL):
        # `sep` differs by platform and PyInstaller is strict about it.
        sep = ";" if os.name == "nt" else ":"
        cmd += ["--add-data", f"{TERMINAL}{sep}terminal"]
        print(f"· bundling the terminal ({os.path.getsize(TERMINAL) // 1024} kB)")
    else:
        print("! app/dist/index.html is missing — the binary will serve the API only.")
        print("  Build it first:  npm --prefix app install && npm --prefix app run build")

    cmd.append(os.path.join(HERE, "entry.py"))

    print(f"· freezing ({'full' if full else 'core'} profile)")
    run(cmd, cwd=HERE)

    exe = os.path.join(dist, name + (".exe" if os.name == "nt" else ""))
    return exe


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--full", action="store_true", help="include the quant service (~5x larger)")
    ap.add_argument("--clean", action="store_true", help="discard the build venv first")
    args = ap.parse_args()

    os.makedirs(BUILD, exist_ok=True)
    py = ensure_venv(args.full, args.clean)
    exe = build(py, args.full)

    if not os.path.isfile(exe):
        print("! PyInstaller reported success but produced no executable", file=sys.stderr)
        return 1

    mb = os.path.getsize(exe) / (1024 * 1024)
    print()
    print(f"  {exe}")
    print(f"  {mb:.0f} MB · run it, then open http://127.0.0.1:8787")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
