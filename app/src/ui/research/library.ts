/**
 * The data library's reasoning, with no DOM: which studies use a series,
 * what the system has stored about its own results, and which series a
 * background top-up should refresh next.
 *
 * Pure so each of those can be tested against a fixture rather than trusted
 * because the table looked right. The Data desk (`ui/data.ts`) renders them.
 */

import type { SeriesInventory } from "../../store/barstore";
import type { StudyRecord } from "../../study/store";
import type { Timings } from "../../study/plan";
import type { KnowledgeEntry } from "../../learn/knowledge";
import { intervalMs } from "../../data/history";

/**
 * What uses one stored series.
 *
 * A saved study uses it when the series is its subject or one of its related
 * assets AT THE SAME TIMEFRAME — a study of BTCUSDT 1h does not read the 4h
 * bars, and saying it does would make deleting them look riskier than it is.
 */
export function usedBy(
  series: Pick<SeriesInventory, "symbol" | "timeframe" | "key">,
  studies: readonly StudyRecord[],
  pinned: ReadonlySet<string>,
): string[] {
  const sym = series.symbol.toUpperCase();
  const out: string[] = [];
  if (pinned.has(series.key)) out.push("the chart");
  for (const r of studies) {
    if (r.spec.timeframe !== series.timeframe) continue;
    const symbols = [r.spec.symbol, ...r.spec.context.map((c) => c.symbol)].map((s) => s.toUpperCase());
    if (symbols.includes(sym)) out.push(r.spec.name);
  }
  return out;
}

/** One stored result the system can forget. */
export interface LearnedItem {
  /** Stable id: `kind:detail`, so the desk can confirm the right one. */
  readonly id: string;
  readonly kind: "study-runs" | "knowledge" | "timings";
  readonly title: string;
  /** What is stored, with its count. */
  readonly detail: string;
  /** How many things forgetting it removes. */
  readonly count: number;
  /** The study id, or the `SYMBOL|tf` of a knowledge group. */
  readonly ref: string;
}

/**
 * Everything the system has stored about its own results.
 *
 * Three stores, one list: saved studies' run histories, the knowledge base's
 * replayed setups grouped by market, and the measured step timings that make
 * the run-time estimates real. Bars are NOT in this list — they are the
 * library above it, and forgetting a result never touches them.
 */
export function learnedItems(
  studies: readonly StudyRecord[],
  knowledge: readonly KnowledgeEntry[],
  timings: Timings,
): LearnedItem[] {
  const out: LearnedItem[] = [];

  for (const r of studies) {
    if (r.runs.length === 0) continue;
    const last = r.runs[r.runs.length - 1];
    out.push({
      id: `study-runs:${r.spec.id}`,
      kind: "study-runs",
      title: r.spec.name,
      detail: `${r.runs.length} run${r.runs.length === 1 ? "" : "s"} of a saved study${last === undefined ? "" : ` — latest: ${last.headline}`}`,
      count: r.runs.length,
      ref: r.spec.id,
    });
  }

  const groups = new Map<string, number>();
  for (const e of knowledge) {
    const k = `${e.symbol}|${e.timeframe}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    const [symbol = "", timeframe = ""] = k.split("|");
    out.push({
      id: `knowledge:${k}`,
      kind: "knowledge",
      title: `${symbol} ${timeframe}`,
      detail: `${n} replayed setup stud${n === 1 ? "y" : "ies"} — the odds the Setup card quotes`,
      count: n,
      ref: k,
    });
  }

  const measured = Object.keys(timings).length;
  if (measured > 0) {
    out.push({
      id: "timings:all",
      kind: "timings",
      title: "Run-time estimates",
      detail: `How long ${measured} check${measured === 1 ? "" : "s"} took on this machine — used for "about N seconds"`,
      count: measured,
      ref: "all",
    });
  }

  return out;
}

export interface TopUp {
  readonly symbol: string;
  readonly timeframe: string;
  /** Bars missing between the newest stored bar and now. */
  readonly missing: number;
}

/** Bars fetched per series per pass — one vendor page. */
export const TOPUP_PAGE = 1000;
/** Series refreshed per pass — a budget, so a large library cannot flood a vendor. */
export const TOPUP_PER_PASS = 8;

/**
 * Which series to refresh, stalest first.
 *
 * A series is due when its newest bar is more than two intervals old — the
 * same freshness test `data/history.ts` applies before it trusts a cache.
 * Demo-only series are skipped: they are generated, and "keeping them up to
 * date" would mean generating more. One entry per symbol and timeframe, since
 * the same series held from two sources is refreshed by one fetch.
 */
export function planTopUp(
  inventory: readonly SeriesInventory[],
  now: number,
  max = TOPUP_PER_PASS,
): TopUp[] {
  /* The FRESHEST copy decides, across sources: a series whose Binance copy is
     current does not need its proxy copy refreshed to be up to date. */
  const newest = new Map<string, { symbol: string; timeframe: string; newest: number }>();
  for (const s of inventory) {
    if (s.qualities.length > 0 && s.qualities.every((q) => q === "demo")) continue;
    if (!Number.isFinite(s.newest)) continue;
    const k = `${s.symbol}|${s.timeframe}`;
    const prev = newest.get(k);
    if (prev === undefined || s.newest > prev.newest) newest.set(k, { symbol: s.symbol, timeframe: s.timeframe, newest: s.newest });
  }
  const due: TopUp[] = [];
  for (const s of newest.values()) {
    const step = intervalMs(s.timeframe);
    if (now - s.newest <= step * 2) continue;
    due.push({ symbol: s.symbol, timeframe: s.timeframe, missing: Math.ceil((now - s.newest) / step) });
  }
  return due.sort((a, b) => b.missing - a.missing).slice(0, Math.max(0, max));
}

// ------------------------------------------------- finding and acting on many

/** How the library's table is ordered. */
export type LibrarySort = "symbol" | "bars" | "size" | "fresh";

/**
 * The rows a filter and a sort leave, in the order they will be drawn.
 *
 * PURE and exported for the same reason `eviction_order` in `svc/store.py` is:
 * an ordering is only checkable as arithmetic. Written as a closure inside the
 * desk it would have been verifiable only by looking at the table, which is how
 * the "Used by" column came to be 560px wide for two releases.
 *
 * It sorts a COPY. `inventory()` is the signal's own array and sorting it in
 * place mutates state behind every other reader's back.
 */
export function filterSeries(
  rows: readonly SeriesInventory[],
  query: string,
  sort: LibrarySort,
): SeriesInventory[] {
  const q = query.trim().toLowerCase();
  const kept = rows.filter(
    (x) =>
      q === "" ||
      x.symbol.toLowerCase().includes(q) ||
      x.source.toLowerCase().includes(q) ||
      /* EXACTLY, for the bar size alone. A timeframe is a short closed
         vocabulary, so a substring match has no upside and one guaranteed
         collision: "5m" also matches "15m", and "1m" matches both. A market
         name is open-ended and a partial one is the whole point. */
      x.timeframe.toLowerCase() === q,
  );
  return [...kept].sort((p, n) =>
    sort === "bars"
      ? n.bars - p.bars
      : sort === "size"
        ? n.approxBytes - p.approxBytes
        : sort === "fresh"
          ? n.newest - p.newest
          : /* By market, then by bar size ASCENDING — 5m before 1h before 1d.
               Alphabetical would read 15m, 1d, 1h, 4h, 5m, which is an order
               nobody holds in their head. */
            p.symbol === n.symbol
            ? intervalMs(p.timeframe) - intervalMs(n.timeframe)
            : p.symbol.localeCompare(n.symbol),
  );
}

/** One market and every series held for it. */
export interface SeriesGroup {
  readonly symbol: string;
  readonly rows: readonly SeriesInventory[];
  readonly bars: number;
  readonly bytes: number;
  /**
   * DISTINCT bar sizes, and distinct sources — not the row count.
   *
   * MEASURED on the owner's screen: SPX500 held 1h from mt5 and 1h from a
   * proxy, two rows, and the header read "2 timeframes". A market carried by
   * two vendors at one bar size is not a market you hold two bar sizes of, and
   * the difference is exactly what decides whether the next download is worth
   * making. Two counts, because they answer two different questions.
   */
  readonly timeframes: number;
  readonly sources: number;
}

/**
 * Group by market, keeping the incoming order.
 *
 * The flat table listed BTCUSDT once per timeframe, scattered among every other
 * market, so "how much BTC do I hold" could only be answered by reading the
 * whole table and adding up. The group carries that total itself.
 */
export function groupBySymbol(rows: readonly SeriesInventory[]): SeriesGroup[] {
  const out = new Map<string, { symbol: string; rows: SeriesInventory[]; bars: number; bytes: number }>();
  for (const r of rows) {
    const g = out.get(r.symbol) ?? { symbol: r.symbol, rows: [], bars: 0, bytes: 0 };
    g.rows.push(r);
    g.bars += r.bars;
    g.bytes += r.approxBytes;
    out.set(r.symbol, g);
  }
  return [...out.values()].map((g) => ({
    ...g,
    timeframes: new Set(g.rows.map((r) => r.timeframe)).size,
    sources: new Set(g.rows.map((r) => r.source)).size,
  }));
}

/** The group's own line: what it holds, in the fewest words that stay true. */
export function groupLine(g: SeriesGroup, bytes: (n: number) => string): string {
  const sizes = `${g.timeframes} bar size${g.timeframes === 1 ? "" : "s"}`;
  const from = g.sources > 1 ? ` from ${g.sources} sources` : "";
  return `${sizes}${from} · ${g.bars.toLocaleString()} bars · ${bytes(g.bytes)}`;
}

/**
 * What a bulk delete may actually remove, and what it must leave alone.
 *
 * A pinned series is on the chart. The retention sweep honours the pin and so
 * does every single-row Delete, so a bulk one that ignored it would be the one
 * route in the product that deletes history from under the thing displaying it
 * — and it would do so for a selection the operator made with a single click on
 * a group header, which is exactly when they are least likely to have read it.
 *
 * Returns the skipped rows rather than a count, because the caller has to NAME
 * them: a bulk action that silently does less than it was asked is the same
 * shape as a study whose dead vendors vanished from its reported window.
 */
export function deletable(
  rows: readonly SeriesInventory[],
  selected: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): { remove: SeriesInventory[]; skipped: SeriesInventory[] } {
  const remove: SeriesInventory[] = [];
  const skipped: SeriesInventory[] = [];
  for (const r of rows) {
    if (!selected.has(r.key)) continue;
    if (pinned.has(r.key)) skipped.push(r);
    else remove.push(r);
  }
  return { remove, skipped };
}

/**
 * Which markets a freshly opened library shows expanded.
 *
 * Everything open is the flat list this replaced; everything shut is ten lines
 * and no way to tell them apart without clicking. The answer is the market you
 * are ALREADY LOOKING AT — a series on the chart is the one the operator did
 * not have to ask for — and nothing else.
 *
 * Pure, so the rule can be checked rather than described. A filtered library
 * overrides it entirely (the caller opens every match), because typing a query
 * IS asking to see what matches.
 */
export function defaultOpenGroups(
  rows: readonly SeriesInventory[],
  pinned: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (pinned.has(r.key)) out.add(r.symbol);
  return out;
}

// ------------------------------------------------------- coverage, drawn ---

/** One market's held history, as percentages of a shared axis. */
export interface CoverageLane {
  readonly symbol: string;
  /** Left edge and width, both 0..100, of each span this market covers. */
  readonly segments: readonly { readonly left: number; readonly width: number }[];
  readonly bars: number;
  readonly bytes: number;
  /** Share of the whole axis this market actually holds, 0..100. */
  readonly held: number;
}

export interface Coverage {
  readonly from: number;
  readonly to: number;
  readonly lanes: readonly CoverageLane[];
}

/** Below this a segment is invisible, so it is drawn at this width instead. */
const MIN_SEGMENT_PCT = 0.6;

/**
 * Every market's history on ONE time axis.
 *
 * The desk exists to answer "what can I back-test on, and where are the
 * holes", and a table of six date ranges answers it only if you hold six
 * ranges in your head at once. On a shared axis the answer is the shape.
 *
 * Pure, because the arithmetic IS the claim: a segment at the wrong
 * percentage is a lie about when you hold data, and no eye would catch a 3%
 * error. Four things it has to get right, each with a test:
 *
 *  - OVERLAPPING SPANS MERGE. A market held at 1h and at 1d over the same
 *    years is one stretch of history, not two; drawing both leaves a seam
 *    that does not exist.
 *  - A REAL HOLE SURVIVES. The merge closes touching spans and nothing else,
 *    because the hole is the most valuable thing on the chart.
 *  - A SLIVER STAYS VISIBLE. One day inside five years is 0.05% of the axis,
 *    which rounds to nothing and reads as "you hold none of this" — the
 *    opposite of the truth. It is floored, and the floor is documented rather
 *    than hidden, because it means a very short bar is not to scale.
 *  - AN EMPTY LIBRARY DOES NOT DIVIDE BY ZERO. One series held for a single
 *    instant has a zero-length axis, and `x / 0` would put every segment at
 *    `NaN%`, which CSS drops silently and draws as nothing.
 */
export function coverageLanes(rows: readonly SeriesInventory[]): Coverage {
  const live = rows.filter((r) => r.bars > 0 && r.newest > 0 && r.newest >= r.oldest);
  if (live.length === 0) return { from: 0, to: 0, lanes: [] };

  const from = Math.min(...live.map((r) => r.oldest));
  const to = Math.max(...live.map((r) => r.newest));
  /* A single instant is a zero-length axis. One millisecond keeps every
     division finite; the floor below then makes the segment visible. */
  const span = Math.max(1, to - from);

  const bySymbol = new Map<string, SeriesInventory[]>();
  for (const r of live) {
    const held = bySymbol.get(r.symbol);
    if (held) held.push(r);
    else bySymbol.set(r.symbol, [r]);
  }

  const lanes: CoverageLane[] = [];
  for (const [symbol, held] of bySymbol) {
    const ranges = held
      .map((r) => ({ a: r.oldest, b: r.newest }))
      .sort((p, n) => p.a - n.a);

    const merged: { a: number; b: number }[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last !== undefined && r.a <= last.b) last.b = Math.max(last.b, r.b);
      else merged.push({ a: r.a, b: r.b });
    }

    lanes.push({
      symbol,
      segments: merged.map((m) => ({
        left: ((m.a - from) / span) * 100,
        width: Math.max(MIN_SEGMENT_PCT, ((m.b - m.a) / span) * 100),
      })),
      bars: held.reduce((acc, r) => acc + r.bars, 0),
      bytes: held.reduce((acc, r) => acc + r.approxBytes, 0),
      held: (merged.reduce((acc, m) => acc + (m.b - m.a), 0) / span) * 100,
    });
  }

  /* Widest history first: the market you can study best leads, and the thin
     ones below it are the ones worth filling in. */
  lanes.sort((p, n) => n.held - p.held || p.symbol.localeCompare(n.symbol));
  return { from, to, lanes };
}

/** The year boundaries inside a coverage axis, for the gridlines behind it. */
export function coverageYears(c: Coverage): readonly { readonly year: number; readonly left: number }[] {
  if (c.to <= c.from) return [];
  const out: { year: number; left: number }[] = [];
  const span = c.to - c.from;
  const first = new Date(c.from).getUTCFullYear();
  const last = new Date(c.to).getUTCFullYear();
  /* A five-year library gets five labels; a fifty-year one would get fifty,
     so the stride opens up to keep them readable. */
  const stride = Math.max(1, Math.ceil((last - first + 1) / 8));
  for (let y = first; y <= last; y += stride) {
    const t = Date.UTC(y, 0, 1);
    if (t < c.from || t > c.to) continue;
    out.push({ year: y, left: ((t - c.from) / span) * 100 });
  }
  return out;
}
