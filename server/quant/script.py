"""
Custom indicators, written in Python.

WHAT THIS IS
You send bars and a snippet; it runs the snippet against numpy and pandas and
returns the series it produced, which the chart draws as overlays or as a
sub-pane. It is the escape hatch for everything the fifteen built-in indicators
do not cover, and it runs where the libraries already are rather than trying to
reimplement them in the browser.

WHAT THIS IS EMPHATICALLY NOT
A sandbox. Read that again, because it decides who may use this.

Python cannot be safely sandboxed in-process. Every mechanism that looks like
one — stripping ``__builtins__``, blocking ``import``, auditing the AST — has a
long history of being escaped through some attribute chain nobody thought of,
and a determined escape gets the full privileges of this process: your files,
your keys, your network. The restrictions below are a GUARD RAIL AGAINST
ACCIDENTS, not a security boundary. They will stop you from importing ``os`` by
habit. They will not stop code that is trying to get out.

So the deployment rule is the one that actually protects you, and it is not
negotiable:

  * The service binds loopback and refuses to bind anything else without an
    explicit environment variable. That is already true of the whole service.
  * Scripting is OFF unless ``IRAM_QUANT_SCRIPTS=1`` is set. Running arbitrary
    Python must be a thing you turned on, once, knowingly.
  * NEVER run a script somebody else wrote without reading it. A snippet
    pasted from a forum has the same privileges as this process.

The terminal states all of this at the point where you paste the code, rather
than in a document you will not read.

WHY A TIMEOUT AND A SIZE CAP AND NOT MUCH ELSE
Those two catch the failures that actually happen: a `while True` and a script
that allocates an array the size of memory. They are about keeping the service
answering, not about containment.
"""

from __future__ import annotations

import ast
import io
import os
import threading
from contextlib import redirect_stdout

import numpy as np

from .common import clean, parse_bars, refuse

#: Scripting is off unless this is explicitly set. See the module docstring.
ENV_FLAG = "IRAM_QUANT_SCRIPTS"

#: Wall-clock ceiling for one script, in seconds.
TIMEOUT_S = 10.0

#: Longest snippet accepted. Not security — a guard against a paste accident.
MAX_CHARS = 20_000

#: Most series one script may return, and the longest each may be.
MAX_SERIES = 8

#: Names whose import is refused. A HABIT GUARD, not a boundary — see above.
BLOCKED_IMPORTS = frozenset(
    {
        "os", "sys", "subprocess", "socket", "shutil", "pathlib", "importlib",
        "builtins", "ctypes", "multiprocessing", "threading", "http",
        "urllib", "requests", "pickle", "marshal", "code", "codeop", "runpy",
        "tempfile", "glob", "sqlite3", "webbrowser", "platform", "signal",
    }
)

#: Attribute names that are the usual first step out of a restricted namespace.
BLOCKED_ATTRS = frozenset(
    {
        "__globals__", "__builtins__", "__subclasses__", "__bases__", "__mro__",
        "__class__", "__code__", "__closure__", "__loader__", "__import__",
        "__getattribute__", "__reduce__", "__reduce_ex__",
    }
)

BLOCKED_CALLS = frozenset({"eval", "exec", "compile", "open", "input", "__import__", "breakpoint"})


def enabled() -> bool:
    return os.environ.get(ENV_FLAG) == "1"


def _screen(src: str) -> None:
    """
    Refuse the obvious ways out, before running anything.

    Parses rather than pattern-matches, so `im` + `port` concatenation and
    whitespace tricks do not get past it. This is still not a sandbox; it is a
    fence that stops you walking off the path by accident.
    """
    try:
        tree = ast.parse(src, mode="exec")
    except SyntaxError as exc:
        refuse(f"The script does not parse: line {exc.lineno}, {exc.msg}.")

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                root = a.name.split(".")[0]
                if root in BLOCKED_IMPORTS:
                    refuse(
                        f"`import {a.name}` is refused. This runs in the service's own "
                        f"process, so a script that can reach the filesystem or the "
                        f"network can reach everything this process can."
                    )
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in BLOCKED_IMPORTS:
                refuse(f"`from {node.module} import ...` is refused for the same reason.")
        elif isinstance(node, ast.Attribute) and node.attr in BLOCKED_ATTRS:
            refuse(
                f"`{node.attr}` is refused. It is the usual first step out of a "
                f"restricted namespace, and this restriction is a guard rail rather "
                f"than a security boundary — do not treat getting past it as a win."
            )
        elif isinstance(node, ast.Name) and node.id in BLOCKED_CALLS:
            refuse(f"`{node.id}` is refused.")


def _namespace(cols: dict[str, np.ndarray]) -> dict:
    """
    What the script can see.

    Deliberately small and deliberately obvious: the OHLCV columns as numpy
    arrays, numpy and pandas, and nothing else it has to go looking for. A
    script that needs scipy or sklearn imports them itself.
    """
    import pandas as pd

    ns: dict = {
        "np": np,
        "pd": pd,
        "t": cols["t"],
        "open": cols["o"],
        "high": cols["h"],
        "low": cols["l"],
        "close": cols["c"],
        "volume": cols["v"],
        "out": {},
    }
    return ns


def _run_with_timeout(code, ns: dict, seconds: float) -> tuple[Exception | None, str]:
    """
    Run on a worker thread and give up waiting after `seconds`.

    A Python thread cannot be killed, so a runaway script keeps burning a core
    until the process restarts — the timeout returns an ANSWER to the caller
    rather than reclaiming the thread, and says so. That is the honest limit of
    doing this in-process, and it is one more reason scripting is opt-in.
    """
    err: list[Exception | None] = [None]
    buf = io.StringIO()

    def target() -> None:
        try:
            with redirect_stdout(buf):
                exec(code, ns)  # noqa: S102 — the entire point of the endpoint
        except Exception as exc:  # noqa: BLE001
            err[0] = exc

    th = threading.Thread(target=target, daemon=True)
    th.start()
    th.join(seconds)
    if th.is_alive():
        refuse(
            f"The script did not finish within {seconds:.0f}s and was abandoned. "
            f"It is still running on a background thread and will keep using CPU "
            f"until this service restarts — a Python thread cannot be killed from "
            f"outside. Check for an unbounded loop."
        )
    return err[0], buf.getvalue()


def run(payload: dict) -> dict:
    """Execute one snippet against the bars the terminal sent."""
    if not enabled():
        refuse(
            "Python scripting is off. It runs unrestricted code in this service's "
            f"process, so it must be turned on deliberately: set {ENV_FLAG}=1 and "
            "restart the quant service. Only do that on a machine where you are "
            "the one writing the scripts."
        )

    src = str(payload.get("code") or "")
    if src.strip() == "":
        refuse("There is no script to run.")
    if len(src) > MAX_CHARS:
        refuse(f"The script is {len(src)} characters; the limit is {MAX_CHARS}.")

    cols = parse_bars(payload)
    n = len(cols["c"])

    _screen(src)

    try:
        code = compile(src, "<indicator>", "exec")
    except SyntaxError as exc:
        refuse(f"The script does not compile: line {exc.lineno}, {exc.msg}.")

    ns = _namespace(cols)
    err, printed = _run_with_timeout(code, ns, TIMEOUT_S)

    if err is not None:
        refuse(f"{type(err).__name__}: {err}")

    raw = ns.get("out")
    if not isinstance(raw, dict) or not raw:
        refuse(
            "The script produced nothing. Assign the series you want drawn into "
            "`out`, for example: out['fast'] = pd.Series(close).rolling(20).mean().to_numpy()"
        )
    if len(raw) > MAX_SERIES:
        refuse(f"{len(raw)} series returned; the chart draws at most {MAX_SERIES}.")

    series = []
    for name, values in raw.items():
        arr = np.asarray(values, dtype=float).ravel()
        if arr.size != n:
            refuse(
                f"Series '{name}' has {arr.size} points against {n} bars. Every "
                f"series must be the same length as the input, with NaN in the "
                f"warm-up — a shorter array cannot be aligned to a bar without "
                f"guessing which end it belongs to, and guessing wrong shifts an "
                f"indicator relative to price."
            )
        finite = int(np.isfinite(arr).sum())
        if finite == 0:
            refuse(f"Series '{name}' is entirely NaN. Check the warm-up length.")
        series.append(
            {
                "name": str(name),
                "values": [None if not np.isfinite(v) else float(v) for v in arr],
                "finite": finite,
                # A series that never leaves the price range is an overlay; one
                # that does not belongs in its own pane. The chart decides, but
                # the range is what it decides from.
                "min": float(np.nanmin(arr)),
                "max": float(np.nanmax(arr)),
            }
        )

    return clean(
        {
            "ok": True,
            "bars": n,
            "series": series,
            "stdout": printed[-4000:],
            "notes": [
                (
                    "This ran unrestricted in the quant service's own process. The "
                    "import restrictions are a guard against accidents, not a "
                    "security boundary — never run a script you have not read."
                ),
                (
                    "Every series is aligned to the bars you sent, index for index. "
                    "NaN is drawn as a gap, which is what a warm-up should look like."
                ),
            ],
        }
    )
