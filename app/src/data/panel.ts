/**
 * The training panel — one instrument's bars joined to its drivers'.
 *
 * WHAT THIS IS FOR
 * `drivers.ts` says which series are worth measuring against an instrument.
 * This turns those series into the rectangle a model can be fitted on: one row
 * per bar of the target, one column per driver, and a target column. It is the
 * only place the alignment happens, because alignment is where the look-ahead
 * gets in, and a leak here is invisible downstream — it shows up as a model
 * that works beautifully until it is traded.
 *
 * THE THREE WAYS A JOIN LIKE THIS LEAKS, AND WHAT IS DONE ABOUT EACH
 *
 * 1. FORWARD-FILLING A DRIVER FROM THE FUTURE. The obvious join is "for each
 *    target bar, take the driver's value at the nearest timestamp". Nearest
 *    includes nearest AHEAD. At bar t that hands the model a price from t+1.
 *    Every lookup here is `at or before`, never nearest.
 *
 * 2. FILLING A GAP WITH A NUMBER THAT WAS NOT OBSERVED. Markets keep different
 *    hours: BTC trades at 03:00 Sunday and the S&P does not. Carrying Friday's
 *    close across the weekend is defensible for a chart and is NOT the same as
 *    having observed it, so a carried value is marked — `staleBars` counts
 *    them and `carried` flags the row. Beyond `maxStaleBars` the row is
 *    dropped rather than carried indefinitely, because a driver frozen for two
 *    hundred bars is a constant, and a constant column teaches a model nothing
 *    while looking like data.
 *
 * 3. THE TARGET BEING VISIBLE IN THE FEATURES. The target is a FORWARD return
 *    — what happens after this bar — so the last `horizon` rows have no
 *    resolved label. They are kept with `y: NaN` rather than dropped silently
 *    or zero-filled: a zero label is a real observation of "no move", and
 *    inventing them at the live edge is how a model learns that the present is
 *    always quiet.
 *
 * WHY RETURNS AND NOT PRICES
 * Levels are non-stationary and trivially correlated with each other through
 * time; a model given two price levels will discover that both went up. Log
 * returns are what the relationship, if there is one, actually lives in.
 */

import type { BarView } from "../chart/series";

export interface PanelColumn {
  readonly symbol: string;
  readonly label: string;
  readonly role: "lead" | "context";
  /** Bars that were carried forward rather than observed on this row. */
  readonly staleBars: number;
  /** Rows where this driver had nothing at or before the target's timestamp. */
  readonly missingBars: number;
}

export interface PanelRow {
  readonly t: number;
  /** Log return of the target over this bar. */
  readonly r: number;
  /** Log return of each driver, in column order. NaN where unobserved. */
  readonly x: readonly number[];
  /**
   * Forward log return of the target over `horizon` bars, or NaN when the bar
   * is too recent for the label to have resolved.
   */
  readonly y: number;
  /** True when any driver on this row was carried rather than observed. */
  readonly carried: boolean;
}

export interface Panel {
  readonly symbol: string;
  readonly timeframe: string;
  readonly horizon: number;
  readonly columns: readonly PanelColumn[];
  readonly rows: readonly PanelRow[];
  /** Rows whose label has resolved. The only ones a fit may use. */
  readonly labelled: number;
  /** Share of cells that were actually observed, 0..1. */
  readonly coverage: number;
  /** What this panel cannot support, said out loud. */
  readonly warnings: readonly string[];
}

export interface PanelInput {
  readonly symbol: string;
  readonly timeframe: string;
  readonly target: readonly BarView[];
  readonly drivers: ReadonlyArray<{
    readonly symbol: string;
    readonly label: string;
    readonly role: "lead" | "context";
    readonly bars: readonly BarView[];
  }>;
  /** Bars ahead the label looks. Default 1. */
  readonly horizon?: number;
  /**
   * How long a driver may be carried before the row is dropped.
   *
   * Default 3. A weekend of hourly bars is ~48, so an equity driver on an
   * hourly crypto chart legitimately loses the weekend — which is correct: we
   * did not observe the S&P on Sunday, and pretending otherwise is the whole
   * problem this file exists to avoid.
   */
  readonly maxStaleBars?: number;
}

/** Index of the newest bar at or BEFORE `t`, or -1. Binary search. */
export function indexAtOrBefore(bars: readonly BarView[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const bt = (bars[mid] as BarView).t;
    if (bt <= t) {
      out = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return out;
}

const logret = (a: number, b: number): number =>
  a > 0 && b > 0 && Number.isFinite(a) && Number.isFinite(b) ? Math.log(b / a) : NaN;

export function buildPanel(input: PanelInput): Panel {
  const horizon = Math.max(1, Math.round(input.horizon ?? 1));
  const maxStale = Math.max(0, Math.round(input.maxStaleBars ?? 3));
  const target = input.target;
  const warnings: string[] = [];

  if (target.length < horizon + 2) {
    return {
      symbol: input.symbol,
      timeframe: input.timeframe,
      horizon,
      columns: [],
      rows: [],
      labelled: 0,
      coverage: 0,
      warnings: [
        `${target.length} bars of ${input.symbol} is not enough to build a panel with a ${horizon}-bar horizon.`,
      ],
    };
  }

  const stale = input.drivers.map(() => 0);
  const missing = input.drivers.map(() => 0);
  const rows: PanelRow[] = [];
  let observedCells = 0;
  let totalCells = 0;

  /* Start at 1: bar 0 has no previous bar, so it has no return. */
  for (let i = 1; i < target.length; i += 1) {
    const cur = target[i] as BarView;
    const prev = target[i - 1] as BarView;
    const r = logret(prev.c, cur.c);

    const x: number[] = [];
    let carried = false;
    let dropRow = false;

    for (let d = 0; d < input.drivers.length; d += 1) {
      const bars = (input.drivers[d] as { bars: readonly BarView[] }).bars;
      /* AT OR BEFORE. Never nearest — nearest includes nearest ahead, which
         hands bar t a price from t+1. */
      const j = indexAtOrBefore(bars, cur.t);
      totalCells += 1;
      if (j <= 0) {
        x.push(NaN);
        missing[d] = (missing[d] ?? 0) + 1;
        continue;
      }
      const dj = bars[j] as BarView;
      const dprev = bars[j - 1] as BarView;

      /* How stale is this reading, measured in TARGET bars rather than in
         wall-clock, so the tolerance means the same thing on every timeframe. */
      const targetSpan = cur.t - prev.t;
      const ageBars = targetSpan > 0 ? Math.floor((cur.t - dj.t) / targetSpan) : 0;
      if (ageBars > maxStale) {
        x.push(NaN);
        missing[d] = (missing[d] ?? 0) + 1;
        dropRow = true;
        continue;
      }
      if (ageBars > 0) {
        stale[d] = (stale[d] ?? 0) + 1;
        carried = true;
      }
      x.push(logret(dprev.c, dj.c));
      observedCells += 1;
    }

    if (dropRow) continue;

    /* The label looks FORWARD, so it does not exist for the newest `horizon`
       bars. NaN, never 0 — a zero is a real observation of "no move". */
    const fwdIdx = i + horizon;
    const y = fwdIdx < target.length ? logret(cur.c, (target[fwdIdx] as BarView).c) : NaN;

    rows.push({ t: cur.t, r, x, carried, y });
  }

  const columns: PanelColumn[] = input.drivers.map((d, i) => ({
    symbol: d.symbol,
    label: d.label,
    role: d.role,
    staleBars: stale[i] ?? 0,
    missingBars: missing[i] ?? 0,
  }));

  const labelled = rows.filter((row) => Number.isFinite(row.y)).length;
  const coverage = totalCells === 0 ? 0 : observedCells / totalCells;

  /* --- what this panel cannot support ----------------------------------- */

  if (input.drivers.length === 0) {
    warnings.push(
      `No drivers are declared for ${input.symbol}, so this panel is its own history and nothing else.`,
    );
  }
  for (const c of columns) {
    if (c.missingBars > rows.length * 0.5) {
      warnings.push(
        `${c.label} (${c.symbol}) is missing on more than half the rows. It is in the panel but a fit will be learning mostly from its absence.`,
      );
    } else if (c.staleBars > rows.length * 0.3) {
      warnings.push(
        `${c.label} (${c.symbol}) was carried forward on ${Math.round((c.staleBars / Math.max(1, rows.length)) * 100)}% of rows — it keeps different hours from ${input.symbol}. Those rows repeat a value rather than reporting a new one.`,
      );
    }
  }
  if (labelled < 200) {
    warnings.push(
      `Only ${labelled} rows have a resolved label. Anything fitted on this is a description of a small sample, not a model — the standard error on any score will be larger than the effect you are looking for.`,
    );
  }
  if (coverage < 0.6 && totalCells > 0) {
    warnings.push(
      `${Math.round(coverage * 100)}% of driver cells were actually observed. The rest are gaps.`,
    );
  }

  return {
    symbol: input.symbol,
    timeframe: input.timeframe,
    horizon,
    columns,
    rows,
    labelled,
    coverage,
    warnings,
  };
}

/**
 * The panel as the quant service wants it: plain arrays, no NaN in the labels.
 *
 * Drops the unresolved tail rather than shipping NaN labels across HTTP, and
 * SAYS how many it dropped. A service that silently received 900 rows when the
 * panel had 1,000 would report its score against the wrong denominator.
 */
export function panelPayload(p: Panel): {
  symbol: string;
  timeframe: string;
  horizon: number;
  columns: string[];
  t: number[];
  x: number[][];
  y: number[];
  dropped: number;
} {
  const usable = p.rows.filter((r) => Number.isFinite(r.y) && r.x.every((v) => Number.isFinite(v)));
  return {
    symbol: p.symbol,
    timeframe: p.timeframe,
    horizon: p.horizon,
    columns: p.columns.map((c) => c.symbol),
    t: usable.map((r) => r.t),
    x: usable.map((r) => [r.r, ...r.x]),
    y: usable.map((r) => r.y),
    dropped: p.rows.length - usable.length,
  };
}

/**
 * Why this panel cannot be fitted, in the terms of the panel — or null.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FAILURE THIS EXISTS TO STOP REPEATING
 *
 * The Quant desk's cross-asset panel was reporting, on a live BTCUSDT chart:
 *
 *     "The panel is malformed: x and y do not describe the same rows."
 *
 * That sentence is `crossasset.py`'s guard against a payload whose feature
 * matrix and label vector are different lengths — a real programming error,
 * worth refusing. It was not what happened. What happened is that every driver
 * declared for the instrument failed to load, so every row had a NaN in it,
 * so `panelPayload` correctly dropped all of them, and the service received
 * `x: []` and `y: []`. `np.asarray([])` is one-dimensional, the shape check
 * fired, and the operator was told their panel was MALFORMED — a bug report
 * about the code — when the true finding was ordinary and fixable: the driver
 * data did not arrive.
 *
 * The two are not close. One says "this is broken"; the other says "load the
 * drivers and try again". Sending an empty payload across HTTP to be
 * mis-diagnosed at the far end is the worst of both, because the far end
 * cannot see the columns, the coverage or the reason.
 *
 * So the panel diagnoses itself, here, where the evidence is, BEFORE the
 * request is made.
 */
export function panelRefusal(p: Panel, minRows = 200): string | null {
  const payload = panelPayload(p);

  if (p.rows.length === 0) {
    return `No rows could be built for ${p.symbol}: there are not enough bars loaded to form a single labelled observation at a ${p.horizon}-bar horizon.`;
  }

  if (payload.x.length === 0) {
    /* Which driver emptied it. `missingBars` is per-column and already counted
       during the build, so this names the culprit rather than describing the
       symptom. */
    const absent = p.columns.filter((c) => c.missingBars >= p.rows.length);
    if (absent.length > 0) {
      const names = absent.map((c) => `${c.label} (${c.symbol})`).join(", ");
      return `Every one of the ${p.rows.length} rows was dropped because ${names} ${absent.length === 1 ? "has" : "have"} no data at all. The panel is empty, not malformed — load the drivers and run it again.`;
    }
    const unresolved = p.rows.length - p.labelled;
    if (unresolved >= p.rows.length) {
      return `None of the ${p.rows.length} rows has a resolved label yet. At a ${p.horizon}-bar horizon the newest ${p.horizon} bars cannot have one, and there is nothing older to use.`;
    }
    return `Every one of the ${p.rows.length} rows was dropped for a gap in a driver column. ${Math.round(p.coverage * 100)}% of driver cells were observed; the rest are absent.`;
  }

  if (payload.x.length !== payload.y.length) {
    /* Kept, because it IS the real programming error the service's message
       describes — it just was not what was happening.
       Unreachable through `panelPayload`, which derives both arrays from one
       filtered row list, and deliberately left in: the guard costs a
       comparison and the alternative is that a future change to that filter
       fails as the wrong sentence again. Untested for the same reason — there
       is no way to reach it that is not itself the bug. */
    return `The panel is malformed: ${payload.x.length} feature rows against ${payload.y.length} labels. This is a defect in the panel builder, not in the data.`;
  }

  if (payload.x.length < minRows) {
    return `${payload.x.length} usable rows is below the ${minRows} a purged walk-forward needs. Below that the standard error on any score is wider than the effect being looked for, so the result would not be distinguishable from chance either way.`;
  }

  const drivers = (payload.x[0] as number[] | undefined)?.length ?? 0;
  if (drivers < 2) {
    return `The panel has no driver columns — there is nothing to test the instrument's own return against.`;
  }

  return null;
}
