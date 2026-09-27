"""
FILLING THE BULK ARCHIVE — Binance Vision, month by month, into Parquet.

The last piece of the data plan, and it deliberately arrives AFTER the eviction
policy: 20 GB acquired with no bounded way to remove it is a worse problem than
having no data, so `svc/store.py` and its ten tests came first.

WHAT IT FETCHES
`data.binance.vision` publishes free, keyless monthly archives. MEASURED
2026-09-24:

    BTCUSDT-1m monthly klines      2.0 MB   (1.3 MB for 2017-09)
    BTCUSDT-aggTrades daily       15.8 MB   -> ~5.8 GB / year
    bookTicker (spot and futures)     404   not available at all

So this does KLINES, which is the tier that earns its space: 1-minute bars for
the whole macro spine cost well under a gigabyte and settle whether a stop or a
target was hit first inside a bar — the largest single source of backtest
optimism — with no tick data whatsoever. Tick ingestion is a separate piece
with a separate budget conversation.

RESUMABLE, BECAUSE IT WILL BE INTERRUPTED
A download that cannot say what it already holds gets re-run from zero the
first time somebody closes the lid. Every month is one Parquet partition, and a
month already on disk is SKIPPED without a request — so re-running after a
failure costs only the months that are actually missing, and the job reports
skipped and fetched separately rather than as one number that hides which.

IT REFUSES BEFORE IT STARTS
Not after. If the budget is already met, or the packages are missing, or the
symbol is not one Binance publishes, the answer comes back without a byte being
downloaded. A fetcher that discovers it had no room on the last file has spent
the whole download to learn something it could have checked first.
"""

from __future__ import annotations

import csv
import io
import threading
import time
import urllib.error
import urllib.request
import zipfile

from flask import Blueprint, jsonify, request

from svc.store import available, budget_bytes, data_root, inventory, partition

bp = Blueprint("bulkfetch", __name__)

BASE = "https://data.binance.vision/data/spot/monthly/klines"
TIMEOUT_S = 90
#: Binance's kline CSV, in order. Only the first six are kept: the rest are
#: derived (quote volume, taker splits) and a store that keeps derived columns
#: is a store that can disagree with itself.
KLINE_COLS = ("open_time", "open", "high", "low", "close", "volume")

#: One job at a time. Two downloads competing for the same partition directory
#: would interleave writes into one month, and the second would find a file it
#: did not finish writing.
_lock = threading.Lock()
_job: dict = {"state": "idle", "note": "", "done": 0, "total": 0, "fetched": 0,
              "skipped": 0, "failed": [], "bytes": 0, "symbol": "", "timeframe": ""}


def months_back(n: int, now_s: float | None = None) -> list[tuple[int, int]]:
    """The last `n` COMPLETE months, newest first. The current month is
    excluded: Binance publishes a month's archive after it ends, and asking for
    it is a guaranteed 404 that would look like a broken symbol."""
    t = time.gmtime(now_s if now_s is not None else time.time())
    y, m = t.tm_year, t.tm_mon
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            m, y = 12, y - 1
        out.append((y, m))
    return out


def _parquet_path(symbol: str, timeframe: str, year: int, month: int) -> str:
    import os

    d = partition("bars", symbol, timeframe, time.mktime((year, month, 1, 0, 0, 0, 0, 0, 0)) * 1000)
    return os.path.join(d, f"{symbol.upper()}-{timeframe}-{year}-{month:02d}.parquet")


def have(symbol: str, timeframe: str, year: int, month: int) -> bool:
    import os

    return os.path.exists(_parquet_path(symbol, timeframe, year, month))


def fetch_month(symbol: str, timeframe: str, year: int, month: int) -> dict:
    """
    One month, to one Parquet file. Returns what happened, never raises.

    The zip is read ENTIRELY IN MEMORY and written once: a partial .parquet on
    disk would be indistinguishable from a complete one to `inventory()`, and
    the next run would skip it forever.
    """
    import os

    import pyarrow as pa
    import pyarrow.parquet as pq

    sym = symbol.upper()
    url = f"{BASE}/{sym}/{timeframe}/{sym}-{timeframe}-{year}-{month:02d}.zip"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "IRAM/60 (local terminal)"})
        # The URL is built from BASE above and never from input, so the
        # scheme is always https and always this host.
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
            raw = res.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ok": False, "why": f"{year}-{month:02d} is not published for {sym} {timeframe}"}
        return {"ok": False, "why": f"{year}-{month:02d}: HTTP {e.code}"}
    except (urllib.error.URLError, TimeoutError) as e:
        return {"ok": False, "why": f"{year}-{month:02d}: {getattr(e, 'reason', e)}"}

    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            name = z.namelist()[0]
            text = z.read(name).decode("utf-8", "replace")
    except (zipfile.BadZipFile, IndexError) as e:
        return {"ok": False, "why": f"{year}-{month:02d}: the archive could not be opened ({e})"}

    cols: dict[str, list] = {c: [] for c in KLINE_COLS}
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 6:
            continue
        try:
            # Binance switched open_time from milliseconds to MICROseconds in
            # 2025 archives. Detected by magnitude rather than by date, because
            # a cutover date is a fact that goes stale and a magnitude is not.
            t = float(row[0])
            if t > 1e14:
                t /= 1000.0
            cols["open_time"].append(t)
            cols["open"].append(float(row[1]))
            cols["high"].append(float(row[2]))
            cols["low"].append(float(row[3]))
            cols["close"].append(float(row[4]))
            cols["volume"].append(float(row[5]))
        except ValueError:
            continue  # a header line, or a row this vendor malformed

    if not cols["open_time"]:
        return {"ok": False, "why": f"{year}-{month:02d}: no readable rows"}

    path = _parquet_path(sym, timeframe, year, month)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    table = pa.table({c: pa.array(cols[c], type=pa.float64()) for c in KLINE_COLS})
    tmp = path + ".part"
    pq.write_table(table, tmp, compression="zstd")
    os.replace(tmp, path)  # atomic: a reader never sees a half-written month
    return {"ok": True, "rows": len(cols["open_time"]), "bytes": os.path.getsize(path)}


def _run(symbol: str, timeframe: str, wanted: list[tuple[int, int]]) -> None:
    _job.update({"state": "running", "done": 0, "total": len(wanted), "fetched": 0,
                 "skipped": 0, "failed": [], "bytes": 0, "note": "",
                 "symbol": symbol.upper(), "timeframe": timeframe})
    try:
        for year, month in wanted:
            if have(symbol, timeframe, year, month):
                _job["skipped"] += 1
                _job["done"] += 1
                continue
            _job["note"] = f"{symbol.upper()} {timeframe} {year}-{month:02d}"
            out = fetch_month(symbol, timeframe, year, month)
            if out.get("ok"):
                _job["fetched"] += 1
                _job["bytes"] += int(out.get("bytes") or 0)
            else:
                _job["failed"].append(out.get("why") or "unknown")
            _job["done"] += 1
            # Room is re-checked as it goes, not only up front: a long download
            # can cross the budget it started inside.
            if sum(int(i["bytes"]) for i in inventory()) >= budget_bytes():
                _job["note"] = "stopped — the disk budget is full. Raise it or evict, then resume."
                break
        _job["state"] = "done"
    except Exception as e:  # noqa: BLE001 - a job thread must report, never vanish
        _job["state"] = "failed"
        _job["note"] = str(e)[:300]
    finally:
        _lock.release()


@bp.post("/svc/store/download")
def start_download():
    """
    Fetch monthly klines into the bulk archive.

    REFUSES BEFORE IT STARTS rather than after: missing packages, a full
    budget, or a job already running are all answered without a byte fetched.
    """
    d = request.get_json(force=True, silent=True) or {}
    symbol = str(d.get("symbol") or "").strip().upper()
    timeframe = str(d.get("timeframe") or "1m").strip()
    try:
        months = max(1, min(120, int(d.get("months") or 12)))
    except (TypeError, ValueError):
        months = 12

    if not symbol:
        return jsonify(ok=False, err="symbol is required"), 400
    ok, why = available()
    if not ok:
        return jsonify(ok=False, err=why), 503
    held = sum(int(i["bytes"]) for i in inventory())
    if held >= budget_bytes():
        return jsonify(
            ok=False,
            err=f"The disk budget is already full ({held} of {budget_bytes()} bytes). "
                f"Raise it, or evict, before downloading more.",
        ), 507
    if not _lock.acquire(blocking=False):
        return jsonify(ok=False, err="A download is already running.", job=_job), 409

    wanted = months_back(months)
    threading.Thread(target=_run, args=(symbol, timeframe, wanted), daemon=True).start()
    return jsonify(ok=True, started=True, months=len(wanted), symbol=symbol, timeframe=timeframe)


@bp.get("/svc/store/download")
def download_status():
    return jsonify(ok=True, root=data_root(), **_job)


__all__ = ["bp", "download_status", "fetch_month", "have", "months_back", "start_download"]
