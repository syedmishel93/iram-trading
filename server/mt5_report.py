#!/usr/bin/env python3
"""
v36.0 — MT5 HISTORY REPORT PARSER  (server/mt5_report.py)

WHY, WHEN THE BRIDGE EXISTS
The bridge needs Windows + a running MT5. This parser needs a FILE. It means you can
reconcile your real execution TODAY, from any machine, before you set up anything:

    MT5 -> Toolbox -> History -> right-click -> Report -> HTML   (or export CSV)
    then drop the file into the terminal.

It reads the DEALS table (fills), which is the only thing a reconciliation engine can
honestly work from. The "Positions"/"Orders" tables are summaries; deals are truth.

HONESTY
  · Rows it cannot parse are COUNTED and REPORTED, never silently dropped.
  · Balance / credit / commission-only deals are excluded from trades (they are not
    trades) but are reported so the totals still add up.
  · Nothing is inferred. If MT5 did not write a column, the value is None.

Stdlib only (html.parser + csv). No bs4, no lxml, no new dependency.
"""
import csv
import io
import re
from html.parser import HTMLParser


# --------------------------------------------------------------------------
class _TableGrab(HTMLParser):
    """Pull every <tr>/<td> row out of the document, flat. MT5 reports are one big
    table with section-header rows in it, so structure-aware parsing is more fragile
    than just taking every row and classifying by content."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows, self._row, self._cell, self._in_cell = [], [], [], False

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th"):
            self._in_cell, self._cell = True, []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._in_cell:
            self._row.append(" ".join("".join(self._cell).split()))
            self._in_cell = False
        elif tag == "tr":
            if self._row:
                self.rows.append(self._row)
            self._row = []

    def handle_data(self, data):
        if self._in_cell:
            self._cell.append(data)


_NUM = re.compile(r"^-?[\d\s,\u00a0]*\.?\d+$")


def _num(s, default=None):
    """MT5 writes 1 234.56 / 1,234.56 / -3.50 / '' depending on locale. '' -> None."""
    if s is None:
        return default
    s = str(s).replace("\u00a0", "").replace(" ", "").replace(",", "").strip()
    if not s or s in ("-", "—"):
        return default
    try:
        return float(s)
    except ValueError:
        return default


_TIME = re.compile(r"(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?")


def parse_time_ms(s):
    """MT5 writes '2026.07.10 14:32:01'. Returns epoch ms, or None if unparseable.

    IMPORTANT AND DELIBERATE: this is the BROKER'S SERVER TIME, not UTC. Most MT5
    brokers run UTC+2/+3. We do NOT silently convert, because a wrong assumed offset
    silently misaligns every session, ORB and prev-day level. The offset is applied
    explicitly by the caller via `server_utc_offset_h`, and it is shown in the UI.
    """
    if not s:
        return None
    m = _TIME.search(str(s))
    if not m:
        return None
    import datetime as dt
    y, mo, d, h, mi = (int(m.group(i)) for i in range(1, 6))
    sec = int(m.group(6) or 0)
    try:
        naive = dt.datetime(y, mo, d, h, mi, sec, tzinfo=dt.UTC)
        return int(naive.timestamp() * 1000)
    except ValueError:
        return None


DIR_IN = ("in", "entry", "buy in")
DIR_OUT = ("out", "exit", "sell out")


def _classify(cells, server_utc_offset_h=0.0):
    """One report row -> a deal dict, or None if it is not a deal row.

    MT5 deals table columns (typical):
      Time | Deal | Symbol | Type | Direction | Volume | Price | Order |
      Commission | Fee | Swap | Profit | Balance | Comment
    Column count and order vary by build and language, so we locate by CONTENT:
    a deal row must have a parseable time, a symbol, a buy/sell type and a direction.
    """
    if len(cells) < 6:
        return None
    t_ms = parse_time_ms(cells[0])
    if t_ms is None:
        return None
    t_ms -= int(server_utc_offset_h * 3600_000)      # broker server time -> UTC, explicitly

    low = [str(c).strip().lower() for c in cells]
    try:
        ti = next(i for i, c in enumerate(low) if c in ("buy", "sell"))
    except StopIteration:
        return None                                   # balance/credit row: not a deal
    try:
        di = next(i for i, c in enumerate(low) if c in DIR_IN + DIR_OUT)
    except StopIteration:
        return None

    sym = ""
    for i in range(1, ti):
        c = cells[i].strip()
        if c and not _NUM.match(c) and len(c) <= 24:
            sym = c
    if not sym:
        return None

    nums = [(_num(c), i) for i, c in enumerate(cells)]
    vol = next((v for v, i in nums if v is not None and i > di), None)
    price = next((v for v, i in nums if v is not None and i > di and v != vol), None)
    tail = [v for v, i in nums if v is not None and i > di][-5:]      # comm, fee, swap, profit, balance

    comm = swap = profit = 0.0
    if len(tail) >= 5:
        comm, _fee, swap, profit = tail[0], tail[1], tail[2], tail[3]
    elif len(tail) == 4:
        comm, swap, profit = tail[0], tail[1], tail[2]

    deal_id = int(_num(cells[1], 0) or 0)
    is_in = low[di] in DIR_IN
    return {
        "ticket": deal_id, "order": 0,
        "position_id": None,                # filled in by pair_positions()
        "time_ms": t_ms,
        "type": 0 if low[ti] == "buy" else 1,
        "entry": 0 if is_in else 1,
        "symbol": sym,
        "volume": vol or 0.0,
        "price": price or 0.0,
        "commission": comm or 0.0,
        "swap": swap or 0.0,
        "profit": profit or 0.0,
        "comment": cells[-1] if len(cells) > di + 6 else "",
    }


def pair_positions(deals):
    """MT5's HTML report does NOT expose position_id. Reconstruct it: within a symbol,
    an OUT deal closes the oldest still-open IN deal (FIFO, which is how MT5 nets).

    Stated plainly because it matters: with hedging accounts and multiple simultaneous
    positions in one symbol, FIFO pairing can mis-assign a pair. The BRIDGE returns the
    real position_id and has no such ambiguity. If you run hedged, use the bridge.
    """
    deals = sorted(deals, key=lambda d: (d["time_ms"], d["ticket"]))
    open_by_sym, pid = {}, 0
    for d in deals:
        s = d["symbol"]
        if d["entry"] == 0:
            pid += 1
            d["position_id"] = pid
            open_by_sym.setdefault(s, []).append(pid)
        else:
            q = open_by_sym.get(s) or []
            d["position_id"] = q.pop(0) if q else None
    return [d for d in deals if d["position_id"] is not None]


def parse(content, filename="", server_utc_offset_h=0.0):
    """HTML or CSV -> {deals, skipped, source, warnings}. Never raises on bad input."""
    if isinstance(content, bytes):
        content = content.decode("utf-8", errors="replace")
    warnings, rows, source = [], [], "unknown"

    looks_html = "<html" in content[:2000].lower() or "<table" in content[:4000].lower()
    if looks_html or filename.lower().endswith((".html", ".htm")):
        source = "MT5 HTML report"
        p = _TableGrab()
        try:
            p.feed(content)
        except Exception as e:
            warnings.append(f"HTML parse warning: {e}")
        rows = p.rows
    else:
        source = "CSV"
        try:
            sample = content[:4000]
            delim = csv.Sniffer().sniff(sample, delimiters=",;\t").delimiter
        except Exception:
            delim = ","
        rows = [r for r in csv.reader(io.StringIO(content), delimiter=delim) if r]

    deals, skipped = [], 0
    for r in rows:
        d = _classify([str(c) for c in r], server_utc_offset_h)
        if d:
            deals.append(d)
        else:
            skipped += 1

    deals = pair_positions(deals)
    if not deals:
        warnings.append("No deal rows found. Export from MT5: Toolbox -> History -> "
                        "right-click -> Report (HTML), and make sure the DEALS section is included.")
    if server_utc_offset_h:
        warnings.append(f"Times shifted by {server_utc_offset_h:+.1f}h (broker server time -> UTC). "
                        f"If your sessions look wrong, this offset is the first thing to check.")
    return {"deals": deals, "skipped_rows": skipped, "source": source, "warnings": warnings}
