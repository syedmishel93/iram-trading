/**
 * THE DURABLE HALF OF THE ARCHIVE.
 *
 * MEASURED on 2026-09-24, across the whole product: one series — binance
 * BTCUSDT 1h, 5,803 bars — living in one browser profile's IndexedDB, with
 * `navigator.storage.persisted()` returning **false**. The browser was free to
 * discard every candle this terminal could backtest on, without asking, and
 * nothing on the server held a single bar.
 *
 * `server/svc/bars.py` is the durable copy. This is the client half: a
 * write-through on every successful fetch, and a read of last resort when the
 * local archive is empty and no vendor answers — which is exactly the state a
 * fresh browser, or a cleared one, starts in.
 *
 * WHAT IT IS NOT: the fast path. IndexedDB stays the cache the chart reads,
 * because a 5,000-bar read over HTTP on every pan would be absurd. The server
 * is the copy that survives clearing site data, changing browser or moving
 * machine.
 *
 * A SERIES IS (source, symbol, timeframe). The table keys on all three for the
 * same reason `keyFor` does: a broker's XAUUSD and yfinance's XAUUSD are two
 * different price series, and a store that blends them is worse than one that
 * holds neither.
 */

import { svcUrl } from "./backend";
import type { BarView } from "../chart/series";

/** The server's own per-request cap — see `MAX_PER_POST` in svc/bars.py. */
export const SERVER_CHUNK = 5000;

export interface ServerBarsResult {
  readonly ok: boolean;
  readonly bars: readonly BarView[];
  /** Why there are none, addressed to the operator. Empty when ok. */
  readonly reason: string;
}

const isBar = (v: unknown): v is BarView => {
  if (v === null || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return ["t", "o", "h", "l", "c"].every((k) => typeof b[k] === "number" && Number.isFinite(b[k] as number));
};

/**
 * Read a window from the durable archive.
 *
 * Never throws: the gateway not running is the ordinary case for anyone who
 * opened the built page directly, and a chart that fails because a backup
 * store is absent would be worse than no backup store.
 */
export async function fetchServerBars(
  src: string,
  symbol: string,
  timeframe: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ServerBarsResult> {
  const q = new URLSearchParams({ src, sym: symbol, tf: timeframe, n: String(Math.max(1, Math.floor(limit))) });
  try {
    const res = await fetchImpl(svcUrl(`/svc/bars?${q.toString()}`));
    if (!res.ok) return { ok: false, bars: [], reason: `the archive service answered HTTP ${res.status}` };
    const body = (await res.json()) as { bars?: unknown };
    const bars = Array.isArray(body.bars) ? body.bars.filter(isBar) : [];
    return { ok: true, bars, reason: "" };
  } catch {
    return { ok: false, bars: [], reason: "the archive service is not answering on this address" };
  }
}

/**
 * Write bars to the durable archive, in chunks it will accept.
 *
 * `closedBefore` is the timestamp of the bar still FORMING, so the server can
 * refuse to store a close that was never a close. Passing it is the caller's
 * job because only the caller knows which bar that is; omitted, the server
 * keeps everything rather than guessing.
 *
 * Returns how many it stored. A failure is not thrown and not retried: this is
 * a mirror, and the local archive already has the bars.
 */
export async function putServerBars(
  src: string,
  symbol: string,
  timeframe: string,
  bars: readonly BarView[],
  opts: { closedBefore?: number; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const f = opts.fetchImpl ?? fetch;
  let stored = 0;
  for (let i = 0; i < bars.length; i += SERVER_CHUNK) {
    const chunk = bars.slice(i, i + SERVER_CHUNK);
    try {
      const res = await f(svcUrl("/svc/bars"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          src,
          sym: symbol,
          tf: timeframe,
          bars: chunk,
          ...(opts.closedBefore === undefined ? {} : { closedBefore: opts.closedBefore }),
        }),
      });
      if (!res.ok) break;
      const body = (await res.json()) as { stored?: unknown };
      if (typeof body.stored === "number") stored += body.stored;
    } catch {
      break; /* The mirror is best-effort; the local archive is the working copy. */
    }
  }
  return stored;
}

/**
 * Tell the server which series to keep current.
 *
 * Best-effort and never thrown: a gateway that is not running is the ordinary
 * case for anyone who opened the built page directly, and the browser's own
 * archive is unaffected either way. Returns how many the server accepted, or
 * null when it could not be asked — null is not zero, and a caller that
 * reported "0 enrolled" for "could not reach the service" would be making the
 * same mistake as a status strip reading "0 of 0 running".
 */
export async function pushEnrolment(
  series: readonly { source: string; symbol: string; timeframe: string }[],
  fetchImpl: typeof fetch = fetch,
): Promise<number | null> {
  try {
    const res = await fetchImpl(svcUrl("/svc/bars/enrol"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ series }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { enrolled?: unknown };
    return typeof body.enrolled === "number" ? body.enrolled : null;
  } catch {
    return null;
  }
}

export interface ServerSeries {
  readonly src: string;
  readonly sym: string;
  readonly tf: string;
  readonly bars: number;
  readonly oldest: number;
  readonly newest: number;
}

/**
 * What the durable archive holds — the answer to "how much history do I have",
 * which before this could only be got by opening a browser's dev tools.
 */
export async function serverInventory(fetchImpl: typeof fetch = fetch): Promise<{
  readonly ok: boolean;
  readonly series: readonly ServerSeries[];
  readonly totalBars: number;
  readonly reason: string;
}> {
  try {
    const res = await fetchImpl(svcUrl("/svc/bars/inventory"));
    if (!res.ok) return { ok: false, series: [], totalBars: 0, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { series?: unknown; total_bars?: unknown };
    const series = Array.isArray(body.series) ? (body.series as ServerSeries[]) : [];
    return {
      ok: true,
      series,
      totalBars: typeof body.total_bars === "number" ? body.total_bars : 0,
      reason: "",
    };
  } catch {
    return { ok: false, series: [], totalBars: 0, reason: "the archive service is not answering on this address" };
  }
}

export interface BulkStore {
  readonly ok: boolean;
  /** Whether duckdb and pyarrow are installed, and which is missing. */
  readonly engineReady: boolean;
  readonly engineWhy: string;
  readonly root: string;
  readonly partitions: number;
  readonly bytes: number;
  readonly budgetBytes: number;
  readonly series: readonly { kind: string; symbol: string; timeframe: string; bytes: number }[];
  readonly reason: string;
}

/**
 * The BULK archive — Parquet on disk, queried by DuckDB. The other half of the
 * durable store: `svc/bars.py` holds the recent bars a chart reads,
 * `svc/store.py` holds the gigabytes.
 *
 * Returns `ok: false` rather than throwing, for the same reason everything
 * else here does: a gateway that is not running is the ordinary case, and a
 * desk that failed because a bulk store is absent would be worse than one that
 * says so.
 */
export async function bulkStore(fetchImpl: typeof fetch = fetch): Promise<BulkStore> {
  const empty = {
    engineReady: false, engineWhy: "", root: "", partitions: 0, bytes: 0,
    budgetBytes: 0, series: [] as BulkStore["series"],
  };
  try {
    const res = await fetchImpl(svcUrl("/svc/store/inventory"));
    if (!res.ok) return { ok: false, ...empty, reason: `HTTP ${res.status}` };
    const b = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      engineReady: b["engine_ready"] === true,
      engineWhy: typeof b["engine_why"] === "string" ? b["engine_why"] : "",
      root: typeof b["root"] === "string" ? b["root"] : "",
      partitions: typeof b["partitions"] === "number" ? b["partitions"] : 0,
      bytes: typeof b["bytes"] === "number" ? b["bytes"] : 0,
      budgetBytes: typeof b["budget_bytes"] === "number" ? b["budget_bytes"] : 0,
      series: Array.isArray(b["series"]) ? (b["series"] as BulkStore["series"]) : [],
      reason: "",
    };
  } catch {
    return { ok: false, ...empty, reason: "the archive service is not answering on this address" };
  }
}

export interface DownloadJob {
  readonly state: string;
  readonly note: string;
  readonly done: number;
  readonly total: number;
  readonly fetched: number;
  readonly skipped: number;
  readonly failed: readonly string[];
  readonly bytes: number;
  readonly symbol: string;
  readonly timeframe: string;
}

/** Start filling the bulk archive. The refusal, when there is one, is the
    server's own sentence — budget full, packages missing, already running. */
export async function startBulkDownload(
  symbol: string,
  timeframe: string,
  months: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; why: string }> {
  try {
    const res = await fetchImpl(svcUrl("/svc/store/download"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol, timeframe, months }),
    });
    const b = (await res.json()) as { ok?: unknown; err?: unknown };
    if (res.ok && b.ok === true) return { ok: true, why: "" };
    return { ok: false, why: typeof b.err === "string" ? b.err : `HTTP ${res.status}` };
  } catch {
    return { ok: false, why: "the archive service is not answering on this address" };
  }
}

export async function bulkDownloadStatus(fetchImpl: typeof fetch = fetch): Promise<DownloadJob | null> {
  try {
    const res = await fetchImpl(svcUrl("/svc/store/download"));
    if (!res.ok) return null;
    return (await res.json()) as DownloadJob;
  } catch {
    return null;
  }
}

/**
 * ASK THE BROWSER TO STOP EVICTING THE ARCHIVE.
 *
 * Without this, IndexedDB is "best effort" storage: the browser may discard it
 * under disk pressure with no warning and no event. `persisted()` was measured
 * false on this product's own origin, which means every bar it had ever
 * downloaded was disposable.
 *
 * Asking is cheap and the answer is reported rather than assumed — Chrome
 * grants it silently to installed or frequently-visited origins and refuses
 * otherwise, and an operator planning to backtest on this archive deserves to
 * know which of those happened. The durable copy on the server is what makes a
 * refusal survivable rather than fatal.
 */
export async function requestPersistence(): Promise<{ readonly granted: boolean; readonly why: string }> {
  const s = typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!s?.persist || !s.persisted) {
    return { granted: false, why: "This browser does not offer persistent storage, so the local archive is evictable." };
  }
  try {
    if (await s.persisted()) return { granted: true, why: "The local archive is persistent." };
    const granted = await s.persist();
    return {
      granted,
      why: granted
        ? "The local archive is persistent — the browser will not evict it to reclaim space."
        : "The browser declined persistent storage, so it may evict the local archive under disk pressure. The copy on the server is unaffected.",
    };
  } catch {
    return { granted: false, why: "This browser refused to answer about persistent storage." };
  }
}
