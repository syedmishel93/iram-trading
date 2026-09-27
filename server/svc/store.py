"""
THE BULK ARCHIVE — Parquet on disk, queried in place by DuckDB.

`svc/bars.py` is the HOT store: recent bars in SQLite, small, read on every
chart load. This is the other half — deep history and tick data, measured in
gigabytes, which cannot live in SQLite rows and must never be loaded into RAM
in one piece.

WHY PARQUET AND DUCKDB
Columnar with zstd, so OHLCV compresses hard (delta-encoded timestamps, RLE
prices) and a query touches only the columns it names. DuckDB reads those files
straight off disk without materialising them, and runs in-process — no server
to start, nothing to keep alive. MEASURED on `data.binance.vision`: one day of
BTCUSDT aggTrades is 15.8 MB zipped, ~5.8 GB a year, which is the scale this
exists for and the scale SQLite would not survive.

NOTHING DOWNLOADS UNTIL EVICTION WORKS
That is the rule this module is built around, and `eviction_order` is a PURE
FUNCTION over an inventory so it can be tested without writing a single file.
Twenty gigabytes acquired with no bounded way to remove it is a worse problem
than having no data at all: a disk that fills is a machine that stops, and the
operator said plainly this is a personal computer.

THE ORDER THINGS GO IN, and each is a judgement rather than an accident:

  1. TICKS BEFORE BARS.        Ticks are re-downloadable bulk; bars are what
                               every study actually reads.
  2. CONTEXT BEFORE TRADED.    A yield series explains a market you trade; the
                               market you trade is the one you cannot replace.
  3. OLDEST BEFORE NEWEST.     The near past is what a walk-forward validates
                               on.
  4. NEVER THE LAST 90 DAYS.   Of anything, ever, whatever the budget says. A
                               budget small enough to delete recent history is
                               a misconfiguration, and the honest response is
                               to refuse and say so rather than to obey it.

THE PACKAGES ARE OPTIONAL. `duckdb` and `pyarrow` are ~87 MB together, and a
gateway that would not boot without them would make this feature a hostage.
`available()` reports their absence by name and every route refuses with it.
"""

from __future__ import annotations

import os
import shutil
import time

from flask import Blueprint, jsonify, request

bp = Blueprint("store", __name__)

DAY_MS = 86_400_000
#: Never evicted, whatever the budget says.
KEEP_RECENT_DAYS = 90
#: Default ceiling. Deliberately modest: the owner's words were "20 gb is not a
#: must or a fixed rule ... its a personal computer". Bars for the whole macro
#: spine are well under a gigabyte; anything beyond this is a deliberate choice.
DEFAULT_BUDGET_GB = 5


def data_root() -> str:
    """
    Where the bulk archive lives.

    Beside the per-user database `entry.py` already writes, and deliberately
    NOT inside the repository — a 20 GB directory under the checkout would end
    up in backups and in any future `git add`, and the first `git status` after
    a download would be unusable.
    """
    override = os.environ.get("IRAM_DATA_DIR")
    if override:
        return override
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    return os.path.join(base, "iram", "data")


def available() -> tuple[bool, str]:
    """Whether the bulk archive can run here, and which package is missing."""
    missing = []
    for name in ("duckdb", "pyarrow"):
        try:
            __import__(name)
        except ImportError:
            missing.append(name)
    if missing:
        return False, (
            f"The bulk archive needs {' and '.join(missing)}, which "
            f"{'are' if len(missing) > 1 else 'is'} not installed. "
            f"Install with: pip install {' '.join(missing)}"
        )
    return True, ""


def partition(kind: str, symbol: str, timeframe: str, at_ms: float) -> str:
    """
    `kind/SYMBOL/timeframe/year=YYYY/month=MM` — the layout DuckDB globs.

    Partitioned by month because that is the unit things are DOWNLOADED and
    EVICTED in: Binance publishes monthly archives, and a month is small enough
    that dropping one frees real space without losing a year.
    """
    t = time.gmtime(at_ms / 1000)
    return os.path.join(
        data_root(), kind, symbol.upper(), timeframe,
        f"year={t.tm_year}", f"month={t.tm_mon:02d}",
    )


def inventory() -> list[dict]:
    """
    Every partition held, with its size. Walks the filesystem rather than
    keeping an index: an index is a second source of truth that can disagree
    with the disk, and the disk is the one that fills up.
    """
    root = data_root()
    out: list[dict] = []
    if not os.path.isdir(root):
        return out
    for dirpath, _dirs, files in os.walk(root):
        parquet = [f for f in files if f.endswith(".parquet")]
        if not parquet:
            continue
        rel = os.path.relpath(dirpath, root).replace("\\", "/").split("/")
        if len(rel) < 5:
            continue
        kind, symbol, timeframe = rel[0], rel[1], rel[2]
        try:
            year = int(rel[3].split("=")[1])
            month = int(rel[4].split("=")[1])
        except (IndexError, ValueError):
            continue
        out.append({
            "path": dirpath,
            "kind": kind,
            "symbol": symbol,
            "timeframe": timeframe,
            "month_start_ms": _month_start_ms(year, month),
            "bytes": sum(os.path.getsize(os.path.join(dirpath, f)) for f in parquet),
            "files": len(parquet),
        })
    return out


def _month_start_ms(year: int, month: int) -> float:
    import calendar

    return calendar.timegm((year, month, 1, 0, 0, 0, 0, 0, 0)) * 1000.0


def eviction_order(
    items: list[dict],
    budget_bytes: int,
    now_ms: float,
    tradeable: set[str] | None = None,
    keep_days: int = KEEP_RECENT_DAYS,
) -> dict:
    """
    What to remove to get under budget, in order, with the reason.

    PURE. Takes an inventory and returns a plan; touches no files. That is what
    makes the order above testable at all, and the order is the entire safety
    property of a 20 GB store.

    Returns `{"over": bytes, "remove": [...], "freed": n, "protected": n,
    "why": str}`. `why` is always populated, including when nothing needs to go.
    """
    traded = tradeable or set()
    total = sum(int(i["bytes"]) for i in items)
    over = total - budget_bytes
    cutoff = now_ms - keep_days * DAY_MS

    if over <= 0:
        return {
            "over": 0, "remove": [], "freed": 0, "protected": 0, "total": total,
            "why": f"{_gb(total)} held against a {_gb(budget_bytes)} budget — nothing to remove.",
        }

    protected = [i for i in items if i["month_start_ms"] >= cutoff]
    candidates = [i for i in items if i["month_start_ms"] < cutoff]

    # The order, as documented at the top of this file. A tuple sort so the
    # priorities compose rather than being three passes that can disagree.
    candidates.sort(key=lambda i: (
        0 if i["kind"] != "bars" else 1,                       # ticks first
        0 if i["symbol"].upper() not in traded else 1,         # context first
        i["month_start_ms"],                                   # oldest first
    ))

    remove: list[dict] = []
    freed = 0
    for item in candidates:
        if freed >= over:
            break
        remove.append(item)
        freed += int(item["bytes"])

    if freed < over:
        # REFUSE RATHER THAN DELETE RECENT HISTORY. A budget that can only be
        # met by removing the last ninety days is a misconfiguration, and
        # obeying it would quietly destroy the only data a walk-forward can
        # validate on.
        why = (
            f"{_gb(total)} held against a {_gb(budget_bytes)} budget. Removing every partition older "
            f"than {keep_days} days frees {_gb(freed)}, which is not enough — the rest is inside the "
            f"{keep_days}-day window this never deletes. Raise the budget, or remove a market you no "
            f"longer study."
        )
    else:
        why = (
            f"{_gb(total)} held against a {_gb(budget_bytes)} budget. Removing {len(remove)} "
            f"partition{'s' if len(remove) != 1 else ''} frees {_gb(freed)}; "
            f"{len(protected)} inside the {keep_days}-day window were never considered."
        )

    return {
        "over": over, "remove": remove, "freed": freed,
        "protected": len(protected), "total": total, "why": why,
    }


def _gb(n: float) -> str:
    gb = n / 1_073_741_824
    if gb >= 0.1:
        return f"{gb:.2f} GB"
    mb = n / 1_048_576
    return f"{mb:.1f} MB" if mb >= 1 else f"{int(n)} B"


def apply_eviction(plan: dict) -> dict:
    """
    Remove what the plan named, and REPORT IT. Deletion nobody was told about
    is indistinguishable from data loss — the rule `store/retention.ts` states
    for the browser archive, applied to the one on disk.
    """
    removed, freed, failed = 0, 0, []
    for item in plan.get("remove", []):
        try:
            shutil.rmtree(item["path"])
            removed += 1
            freed += int(item["bytes"])
        except OSError as e:
            failed.append(f"{item['path']}: {e}")
    return {"removed": removed, "freed": freed, "failed": failed}


def budget_bytes() -> int:
    from svc.core import cfg

    try:
        gb = float(cfg("store_budget_gb", str(DEFAULT_BUDGET_GB)) or DEFAULT_BUDGET_GB)
    except (TypeError, ValueError):
        gb = DEFAULT_BUDGET_GB
    return int(max(0.1, gb) * 1_073_741_824)


# ---------------------------------------------------------------- routes ---

@bp.get("/svc/store/inventory")
def store_inventory():
    ok, why = available()
    items = inventory()
    by_series: dict[tuple[str, str, str], int] = {}
    for i in items:
        key = (i["kind"], i["symbol"], i["timeframe"])
        by_series[key] = by_series.get(key, 0) + int(i["bytes"])
    return jsonify(
        ok=True,
        engine_ready=ok,
        engine_why=why,
        root=data_root(),
        partitions=len(items),
        bytes=sum(by_series.values()),
        budget_bytes=budget_bytes(),
        series=[
            {"kind": k, "symbol": s, "timeframe": t, "bytes": n}
            for (k, s, t), n in sorted(by_series.items(), key=lambda kv: -kv[1])
        ],
    )


@bp.post("/svc/store/evict")
def store_evict():
    """
    Plan an eviction, and apply it only when asked to.

    `dry_run` defaults TRUE. A route that deletes gigabytes by default is one
    that deletes them by accident.
    """
    d = request.get_json(force=True, silent=True) or {}
    dry = d.get("dry_run", True) is not False
    plan = eviction_order(inventory(), budget_bytes(), time.time() * 1000)
    if dry:
        return jsonify(ok=True, dry_run=True, **{k: v for k, v in plan.items() if k != "remove"},
                       remove=[{"path": i["path"], "bytes": i["bytes"]} for i in plan["remove"]])
    result = apply_eviction(plan)
    return jsonify(ok=True, dry_run=False, why=plan["why"], **result)


__all__ = [
    "apply_eviction",
    "available",
    "bp",
    "budget_bytes",
    "data_root",
    "eviction_order",
    "inventory",
    "partition",
    "store_evict",
    "store_inventory",
]
