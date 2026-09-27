/**
 * Sub-panes — the half of the chart that was missing.
 *
 * WHAT THIS UNBLOCKS
 * `studies.ts` says it plainly: a study is "a price overlay, and nothing else.
 * Anything that needs its own y-axis ... is a different rendering problem", and
 * those indicators "stay where they are until the engine grows a pane stack".
 *
 * This is that pane stack. Ten working functions in `indicators.ts` — rsi,
 * macd, stochastic, adx, roc, williamsR, cci, mfi, atr, squeeze — could be
 * computed and could not be DRAWN, because `LineOverlay` is plotted in price
 * space and RSI between $90,000 and $110,000 is a shape that means nothing.
 * One of them, RSI, was being computed in `shell.ts` purely to print as a
 * number. The rest were dead weight in the bundle.
 *
 * WHY A PANE OWNS ITS SCALE INSTEAD OF SHARING THE PRICE ONE
 * That is the entire distinction. RSI is bounded 0–100 and its 30/70 lines
 * carry the meaning; MACD is unbounded, centred on zero, and the SIGN is what
 * matters. Auto-fitting RSI to its visible range would hide that it never got
 * near 70; forcing MACD to a fixed range would flatten it to nothing in a
 * quiet market. So `range` is declared per pane and omitting it means fit.
 *
 * WHY ZERO IS EXPLICIT AND NOT INFERRED
 * A histogram anchored to the pane floor and a histogram anchored to zero are
 * different charts. MACD's histogram must hang from zero or the negative bars
 * point the wrong way; volume's must sit on the floor or it draws below the
 * axis. Inferring it from whether the data goes negative gets MACD wrong in
 * every window that happens to be entirely positive.
 */

import { adx, atr, cci, macd, mfi, rsi, roc, stochastic, williamsR } from "./indicators";
import { param, paramLabel, type Params } from "./params";

/** One plotted line or histogram inside a pane. Same-length-as-series contract. */
export interface PaneSeries {
  readonly id: string;
  readonly values: Float64Array;
  readonly color: string;
  readonly kind: "line" | "histogram";
  readonly width?: number;
  /** Histograms only: colour bars above `zero` differently from those below. */
  readonly colorDown?: string;
}

export interface PaneSpec {
  readonly id: string;
  readonly label: string;
  /** Height in CSS pixels. The engine clamps this. */
  readonly height: number;
  readonly series: readonly PaneSeries[];
  /**
   * Fixed y-range. Omitted means fit to the visible data.
   *
   * Fixed for bounded oscillators, because the levels are the reading: an RSI
   * pane auto-fitted to a 44–58 window looks like violent swings and is not.
   */
  readonly range?: readonly [number, number];
  /** Horizontal reference lines drawn behind the data. */
  readonly guides?: readonly number[];
  /** Baseline histograms hang from. Defaults to the bottom of the pane. */
  readonly zero?: number;
}

/** Columns a pane is built from — the same shape `StudyInput` uses. */
export interface PaneInput {
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;
  colour(token: string, fallback: string): string;
}

export interface PaneMeta {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  /** What question it answers, for the panel's grouping. */
  readonly family: "momentum" | "trend" | "volatility" | "volume";
  /** Default height in px. */
  readonly height: number;
  /** See `StudyMeta.run` — `params` is complete and legal, or absent for the
      published definition. */
  build(input: PaneInput, params?: Params): PaneSpec;
}

export const PANES: readonly PaneMeta[] = [
  {
    id: "rsi",
    label: "RSI",
    family: "momentum",
    blurb: "Relative strength, 0–100, with the 30/70 bands",
    height: 90,
    build: (d, p) => ({
      id: "rsi",
      label: `RSI ${paramLabel("rsi", p)}`,
      height: 90,
      /* Fixed, not fitted: 30 and 70 are the whole reading. */
      range: [0, 100],
      guides: [30, 50, 70],
      series: [
        {
          id: "rsi",
          values: rsi(d.c, param("rsi", p, "period")),
          color: d.colour("--accent", "#4C82FB"),
          kind: "line",
          width: 1.5,
        },
      ],
    }),
  },

  {
    id: "macd",
    label: "MACD",
    family: "momentum",
    blurb: "Moving-average convergence, with signal and histogram",
    height: 100,
    build: (d, p) => {
      const r = macd(d.c, param("macd", p, "fast"), param("macd", p, "slow"), param("macd", p, "signal"));
      return {
        id: "macd",
        label: `MACD ${paramLabel("macd", p).replace(/, /g, "/")}`,
        height: 100,
        /* Unbounded and centred: fitted range, explicit zero. */
        guides: [0],
        zero: 0,
        series: [
          {
            id: "macd-hist",
            values: r.histogram,
            color: d.colour("--pos", "#2DBE8E"),
            colorDown: d.colour("--neg", "#F0616D"),
            kind: "histogram",
          },
          {
            id: "macd-line",
            values: r.macd,
            color: d.colour("--accent", "#4C82FB"),
            kind: "line",
            width: 1.5,
          },
          {
            id: "macd-signal",
            values: r.signal,
            color: d.colour("--attn", "#E8A33D"),
            kind: "line",
            width: 1,
          },
        ],
      };
    },
  },

  {
    id: "stoch",
    label: "Stochastic",
    family: "momentum",
    blurb: "%K and %D against the 20/80 bands",
    height: 90,
    build: (d, p) => {
      const r = stochastic(
        d.h,
        d.l,
        d.c,
        param("stoch", p, "period"),
        param("stoch", p, "smoothK"),
        param("stoch", p, "smoothD"),
      );
      return {
        id: "stoch",
        label: `Stoch ${paramLabel("stoch", p).replace(/, /g, "/")}`,
        height: 90,
        range: [0, 100],
        guides: [20, 80],
        series: [
          { id: "stoch-k", values: r.k, color: d.colour("--accent", "#4C82FB"), kind: "line", width: 1.5 },
          { id: "stoch-d", values: r.d, color: d.colour("--attn", "#E8A33D"), kind: "line", width: 1 },
        ],
      };
    },
  },

  {
    id: "adx",
    label: "ADX",
    family: "trend",
    blurb: "Trend strength — the 25 line is the one that matters",
    height: 90,
    build: (d, p) => {
      const r = adx(d.h, d.l, d.c, param("adx", p, "period"));
      return {
        id: "adx",
        label: `ADX ${paramLabel("adx", p)}`,
        height: 90,
        /* 0–60 rather than 0–100: ADX above 60 is vanishingly rare, and scaling
           for it wastes half the pane on empty space in every normal market. */
        range: [0, 60],
        guides: [25],
        series: [
          /* The DI pair is drawn faint beneath the ADX line. ADX gives trend
             STRENGTH and says nothing about direction; which DI is on top is
             the direction, and separating them is the usual way this indicator
             gets misread. */
          { id: "adx-plus", values: r.plusDI, color: d.colour("--pos", "#2DBE8E"), kind: "line", width: 1 },
          { id: "adx-minus", values: r.minusDI, color: d.colour("--neg", "#F0616D"), kind: "line", width: 1 },
          { id: "adx", values: r.adx, color: d.colour("--accent", "#4C82FB"), kind: "line", width: 1.5 },
        ],
      };
    },
  },

  {
    id: "atr",
    label: "ATR",
    family: "volatility",
    blurb: "Average true range, in the instrument's own units",
    height: 80,
    build: (d, p) => ({
      id: "atr",
      label: `ATR ${paramLabel("atr", p)}`,
      height: 80,
      /* Fitted: an ATR of 0.0004 on EURUSD and 900 on BTC are both correct,
         and no fixed range serves both. */
      series: [
        {
          id: "atr",
          values: atr(d.h, d.l, d.c, param("atr", p, "period")),
          color: d.colour("--attn", "#E8A33D"),
          kind: "line",
          width: 1.5,
        },
      ],
    }),
  },

  {
    id: "mfi",
    label: "Money flow",
    family: "volume",
    blurb: "Volume-weighted RSI — needs a feed that reports volume",
    height: 90,
    build: (d, p) => ({
      id: "mfi",
      label: `MFI ${paramLabel("mfi", p)}`,
      height: 90,
      range: [0, 100],
      guides: [20, 80],
      series: [
        {
          id: "mfi",
          values: mfi(d.h, d.l, d.c, d.v, param("mfi", p, "period")),
          color: d.colour("--accent", "#4C82FB"),
          kind: "line",
          width: 1.5,
        },
      ],
    }),
  },

  {
    id: "cci",
    label: "CCI",
    family: "momentum",
    blurb: "Commodity channel index against ±100",
    height: 90,
    build: (d, p) => ({
      id: "cci",
      label: `CCI ${paramLabel("cci", p)}`,
      height: 90,
      guides: [-100, 0, 100],
      zero: 0,
      series: [
        {
          id: "cci",
          values: cci(d.h, d.l, d.c, param("cci", p, "period")),
          color: d.colour("--accent", "#4C82FB"),
          kind: "line",
          width: 1.5,
        },
      ],
    }),
  },

  {
    id: "willr",
    label: "Williams %R",
    family: "momentum",
    blurb: "Where the close sits in the recent range, −100 to 0",
    height: 80,
    build: (d, p) => ({
      id: "willr",
      label: `Williams %R ${paramLabel("willr", p)}`,
      height: 80,
      range: [-100, 0],
      guides: [-80, -20],
      series: [
        {
          id: "willr",
          values: williamsR(d.h, d.l, d.c, param("willr", p, "period")),
          color: d.colour("--accent", "#4C82FB"),
          kind: "line",
          width: 1.5,
        },
      ],
    }),
  },

  {
    id: "roc",
    label: "Rate of change",
    family: "momentum",
    blurb: "Percent change over 12 bars, as a histogram around zero",
    height: 80,
    build: (d, p) => ({
      id: "roc",
      label: `ROC ${paramLabel("roc", p)}`,
      height: 80,
      guides: [0],
      zero: 0,
      series: [
        {
          id: "roc",
          values: roc(d.c, param("roc", p, "period")),
          color: d.colour("--pos", "#2DBE8E"),
          colorDown: d.colour("--neg", "#F0616D"),
          kind: "histogram",
        },
      ],
    }),
  },
];

const BY_ID = new Map(PANES.map((p) => [p.id, p]));

/**
 * Build the enabled panes, in registry order.
 *
 * Unknown ids are SKIPPED rather than throwing: the enabled set is persisted,
 * so a pane removed in a later version would otherwise brick the chart of
 * anyone who had it on. Same reason `runStudies` skips them.
 */
export function runPanes(
  enabled: readonly string[],
  input: PaneInput,
  params: Readonly<Record<string, Params>> = {},
): PaneSpec[] {
  const want = new Set(enabled);
  const out: PaneSpec[] = [];
  for (const meta of PANES) {
    if (!want.has(meta.id)) continue;
    out.push(meta.build(input, params[meta.id]));
  }
  return out;
}

/** Family labels for the picker, mirroring `FAMILY_LABEL` in studies.ts. */
export const PANE_FAMILY_LABEL: Readonly<Record<PaneMeta["family"], string>> = {
  momentum: "Momentum",
  trend: "Trend strength",
  volatility: "Volatility",
  volume: "Volume",
};

/**
 * One line describing what is stacked below the chart.
 *
 * Names the volume-dependent pane explicitly when the feed has no volume,
 * rather than letting MFI draw a flat line that looks like a reading. Most FX
 * feeds report no volume at all — see `profile.ts`, which returns null for the
 * same reason.
 */
export function paneSummary(
  enabled: readonly string[],
  hasVolume: boolean,
  dropped: readonly string[] = [],
): string {
  const known = enabled.filter((id) => BY_ID.has(id));
  if (known.length === 0) return "No panes. The chart is price only.";

  const labels = known.map((id) => (BY_ID.get(id) as PaneMeta).label);
  const list =
    labels.length === 1
      ? (labels[0] as string)
      : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1] as string}`;

  const needsVolume = known.filter((id) => (BY_ID.get(id) as PaneMeta).family === "volume");
  const warn =
    needsVolume.length > 0 && !hasVolume
      ? ` This feed reports no volume, so ${needsVolume
          .map((id) => (BY_ID.get(id) as PaneMeta).label)
          .join(" and ")} cannot be computed.`
      : "";

  /* A pane that was switched on and is not on screen must be NAMED. Silently
     omitting it is indistinguishable from the indicator being broken. */
  const short =
    dropped.length > 0
      ? ` No room for ${dropped
          .map((id) => BY_ID.get(id)?.label ?? id)
          .join(" and ")} — make the chart taller or turn one off.`
      : "";

  return `${list} below the chart.${warn}${short}`;
}

/** Total height the panes will claim, for the engine's inset arithmetic. */
export function panesHeight(specs: readonly PaneSpec[]): number {
  return specs.reduce((sum, p) => sum + p.height, 0);
}

/** The pane stack may never take more than this share of the chart. */
export const PANES_MAX_FRACTION = 0.5;
/** Below this a pane cannot fit its label and a legible line. */
export const PANE_MIN_H = 36;

/**
 * Fit the stack into the chart, and say what did not fit.
 *
 * WHY THIS EXISTS
 * `Viewport.plotHeight` clamps at zero. So a stack taller than the chart does
 * not throw and does not warn — it drives the price plot to zero height and
 * silently renders every candle on one line, with the panes drawn off the
 * bottom of the canvas. Three panes total 280px; the chart host is 128px in a
 * short window, which is not a contrived case.
 *
 * WHY IT IS A PURE FUNCTION AND NOT A METHOD ON THE ENGINE
 * Because two callers need the same answer: the engine, to lay out, and the
 * studies panel, to tell you WHICH pane you switched on is not being drawn. A
 * pane that silently fails to appear is the worst outcome here, and it is
 * exactly what a private method inside the renderer would produce.
 *
 * The rule: scale everything proportionally down to `PANE_MIN_H`, then drop
 * from the BOTTOM of the stack — the newest-added end — until the rest fit.
 */
export function fitPanes(
  specs: readonly PaneSpec[],
  chartHeight: number,
): { visible: PaneSpec[]; dropped: string[] } {
  if (specs.length === 0) return { visible: [], dropped: [] };

  const budget = Math.floor(Math.max(0, chartHeight) * PANES_MAX_FRACTION);
  if (budget < PANE_MIN_H) return { visible: [], dropped: specs.map((p) => p.id) };

  const want = panesHeight(specs);
  if (want <= budget) return { visible: [...specs], dropped: [] };

  const scale = budget / want;
  const scaled = specs.map((p) => ({
    ...p,
    height: Math.max(PANE_MIN_H, Math.round(p.height * scale)),
  }));

  /* The floor can push the total back over budget. Drop from the end rather
     than shrinking below the point a pane is readable — half a stack you can
     read beats a full one you cannot. */
  const visible = [...scaled];
  const dropped: string[] = [];
  while (visible.length > 0 && panesHeight(visible) > budget) {
    dropped.unshift((visible.pop() as PaneSpec).id);
  }
  return { visible, dropped };
}

/**
 * Y-range for a pane over the visible window.
 *
 * Declared range wins. Otherwise fit to what is actually on screen, ignoring
 * the NaN warm-up, and pad by 8% so a line does not ride the pane border.
 *
 * A window containing no finite value at all returns null — the caller draws
 * the pane's frame and label and nothing else, which is the honest rendering
 * of "this indicator has not warmed up yet". Substituting 0..1 would draw a
 * flat line at the bottom that reads as a real reading of zero.
 */
export function paneRange(
  spec: PaneSpec,
  from: number,
  to: number,
): { lo: number; hi: number } | null {
  if (spec.range) return { lo: spec.range[0], hi: spec.range[1] };

  let lo = Infinity;
  let hi = -Infinity;
  for (const s of spec.series) {
    for (let i = from; i < to && i < s.values.length; i++) {
      const v = s.values[i] as number;
      if (!Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;

  /* A histogram must always include its baseline, or the bars are drawn from
     outside the pane and every one of them is clipped to full height. */
  if (spec.zero !== undefined && spec.series.some((s) => s.kind === "histogram")) {
    lo = Math.min(lo, spec.zero);
    hi = Math.max(hi, spec.zero);
  }
  for (const g of spec.guides ?? []) {
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
  }

  if (hi === lo) {
    /* A genuinely flat indicator. Open a window around it rather than dividing
       by a zero span. */
    const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.05 : 1;
    return { lo: lo - pad, hi: hi + pad };
  }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}
