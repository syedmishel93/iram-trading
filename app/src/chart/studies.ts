/**
 * The study registry — indicators the chart can actually draw.
 *
 * WHY THIS FILE EXISTS AND NOT JUST `indicators.ts`
 * `indicators.ts` holds the arithmetic and knows nothing about the chart:
 * arrays in, arrays out, NaN in the warm-up. That separation is worth keeping,
 * so something has to own the other half — which lines a study draws, what
 * colour each one is, and what to call it in a legend. Before v49 that "half"
 * was three hard-coded EMAs in `shell.ts`, which is why fifteen working
 * indicator functions had exactly three of them reachable from the chart.
 *
 * WHAT A STUDY IS ALLOWED TO BE
 * A price overlay, and nothing else. Anything that needs its own y-axis — an
 * oscillator, a histogram, a sub-pane — is a different rendering problem and
 * pretending otherwise gives you RSI drawn between $90,000 and $110,000 in a
 * shape that means nothing. Those stay where they are until the engine grows a
 * pane stack.
 *
 * WHY EACH STUDY DECLARES ITS OWN LINES RATHER THAN RETURNING ONE ARRAY
 * Ichimoku is five lines, Keltner is three, VWAP is one. A registry that
 * assumed one line per study would need five entries for Ichimoku, and turning
 * one of them off would leave a cloud with a hole in it.
 */

import {
  anchoredVwap,
  bollinger,
  chandelier,
  donchian,
  ema,
  ichimoku,
  keltner,
  vwap,
} from "./indicators";
import { volumeProfile } from "./profile";
import { param, type Params } from "./params";
import type { LineOverlay } from "./engine";
import type { BarView } from "./series";

/** Columns, built once per repaint and shared by every enabled study. */
export interface StudyInput {
  readonly t: Float64Array;
  readonly o: Float64Array;
  readonly h: Float64Array;
  readonly l: Float64Array;
  readonly c: Float64Array;
  readonly v: Float64Array;
  readonly bars: readonly BarView[];
  /** Resolve a CSS custom property to a colour string. */
  colour(token: string, fallback: string): string;
  /**
   * Bar the anchored studies hang from.
   *
   * Null means "the left edge of what is loaded", which is a defensible
   * default and a poor one — the point of an anchored VWAP is that YOU chose
   * the event. The UI offers a picker; this is what it falls back to.
   */
  readonly anchorIndex: number | null;
}

export interface StudyMeta {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  /** Which of the docket's questions this answers, for the panel's grouping. */
  readonly family: "trend" | "range" | "volume" | "exit";
  /**
   * `params` is always complete and always legal — `sanitiseParams` fills the
   * published default for anything missing — so a study reads it directly and
   * never guards. It is optional only so a caller with nothing saved can omit
   * it and get the published definition.
   */
  run(input: StudyInput, params?: Params): LineOverlay[];
}

const DASH_SOFT = [4, 4];
const DASH_FINE = [2, 3];

/** A flat line at one price, for levels that do not vary per bar. */
function level(len: number, price: number): Float64Array {
  const out = new Float64Array(len);
  out.fill(price);
  return out;
}

export const STUDIES: readonly StudyMeta[] = [
  {
    id: "ichimoku",
    label: "Ichimoku",
    family: "trend",
    blurb: "Conversion, base, both cloud spans and the lagging close",
    run: (d, p) => {
      const r = ichimoku(
        d.h,
        d.l,
        d.c,
        param("ichimoku", p, "conversion"),
        param("ichimoku", p, "base"),
        param("ichimoku", p, "spanB"),
        param("ichimoku", p, "displacement"),
      );
      const accent = d.colour("--accent", "#4C82FB");
      const attn = d.colour("--attn", "#E8A33D");
      const up = d.colour("--pos", "#2DBE8E");
      const down = d.colour("--neg", "#F0616D");
      return [
        { id: "ichi-conv", values: r.conversion, color: accent, width: 1 },
        { id: "ichi-base", values: r.base, color: attn, width: 1.5 },
        { id: "ichi-a", values: r.spanA, color: up, width: 1, dash: DASH_SOFT },
        { id: "ichi-b", values: r.spanB, color: down, width: 1, dash: DASH_SOFT },
        /* The lagging span is the close pushed 26 bars BACK, so it necessarily
           stops 26 bars short of the live edge. That gap is the indicator
           working, not a bug, and it is why this line is drawn faint: a solid
           line that stops dead in the middle of the chart reads as broken. */
        { id: "ichi-lag", values: r.lagging, color: d.colour("--text-faint", "#566072"), width: 1 },
      ];
    },
  },

  {
    id: "keltner",
    label: "Keltner",
    family: "range",
    blurb: "EMA with ATR bands — the range counterpart to Bollinger",
    run: (d, p) => {
      const r = keltner(d.h, d.l, d.c, param("keltner", p, "period"), param("keltner", p, "mult"));
      const c = d.colour("--alt", "#9B7BE8");
      return [
        { id: "kc-mid", values: r.middle, color: c, width: 1 },
        { id: "kc-up", values: r.upper, color: c, width: 1, dash: DASH_FINE },
        { id: "kc-lo", values: r.lower, color: c, width: 1, dash: DASH_FINE },
      ];
    },
  },

  {
    id: "bollinger",
    label: "Bollinger",
    family: "range",
    blurb: "20-period SMA with two standard deviations of close",
    run: (d, p) => {
      const r = bollinger(d.c, param("bollinger", p, "period"), param("bollinger", p, "mult"));
      const c = d.colour("--accent", "#4C82FB");
      return [
        { id: "bb-mid", values: r.middle, color: c, width: 1 },
        { id: "bb-up", values: r.upper, color: c, width: 1, dash: DASH_FINE },
        { id: "bb-lo", values: r.lower, color: c, width: 1, dash: DASH_FINE },
      ];
    },
  },

  {
    id: "donchian",
    label: "Donchian",
    family: "range",
    blurb: "Highest high and lowest low of the last 20 bars, current bar excluded",
    run: (d, p) => {
      /* Excluding the current bar is not a preference. A channel that includes
         the bar you are testing can never be broken by it, because the bar is
         its own high — which turns every breakout study built on it into a
         study of nothing. */
      const r = donchian(d.h, d.l, param("donchian", p, "period"), true);
      const c = d.colour("--attn", "#E8A33D");
      return [
        { id: "dc-up", values: r.upper, color: c, width: 1 },
        { id: "dc-lo", values: r.lower, color: c, width: 1 },
        { id: "dc-mid", values: r.middle, color: c, width: 1, dash: DASH_FINE },
      ];
    },
  },

  {
    id: "vwap",
    label: "Session VWAP",
    family: "volume",
    blurb: "Volume-weighted average price, reset daily",
    run: (d) => [
      {
        id: "vwap",
        values: vwap(d.h, d.l, d.c, d.v, d.t),
        color: d.colour("--alt", "#9B7BE8"),
        width: 1.5,
      },
    ],
  },

  {
    id: "avwap",
    label: "Anchored VWAP",
    family: "volume",
    blurb: "VWAP from a bar you pick — a swing, a gap, an event",
    run: (d) => [
      {
        id: "avwap",
        values: anchoredVwap(d.h, d.l, d.c, d.v, d.anchorIndex ?? 0),
        color: d.colour("--accent", "#4C82FB"),
        width: 1.5,
      },
    ],
  },

  {
    id: "profile",
    label: "Profile levels",
    family: "volume",
    blurb: "Point of control and value area, from the loaded range",
    run: (d) => {
      const p = volumeProfile(d.bars);
      /* No volume in the window — an FX feed, or a synthetic series. Drawing a
         point of control here would be a confident line across the chart
         derived from nothing. */
      if (p === null) return [];
      const len = d.c.length;
      const poc = d.colour("--attn", "#E8A33D");
      const area = d.colour("--text-muted", "#7A8494");
      return [
        { id: "vp-poc", values: level(len, p.poc), color: poc, width: 1.5 },
        { id: "vp-vah", values: level(len, p.vah), color: area, width: 1, dash: DASH_SOFT },
        { id: "vp-val", values: level(len, p.val), color: area, width: 1, dash: DASH_SOFT },
      ];
    },
  },

  {
    id: "chandelier",
    label: "Chandelier exit",
    family: "exit",
    blurb: "Trailing stop hung from the range high, in ATR — both sides",
    run: (d, p) => {
      const r = chandelier(d.h, d.l, d.c, param("chandelier", p, "period"), param("chandelier", p, "mult"));
      return [
        { id: "ce-long", values: r.long, color: d.colour("--pos", "#2DBE8E"), width: 1 },
        { id: "ce-short", values: r.short, color: d.colour("--neg", "#F0616D"), width: 1 },
      ];
    },
  },

  {
    id: "ema-ribbon",
    label: "EMA ribbon",
    family: "trend",
    blurb: "8 / 13 / 21 / 34 / 55 — fanning is trend, tangling is not",
    run: (d, p) => {
      const c = d.colour("--accent", "#4C82FB");
      const periods = ["ema1", "ema2", "ema3", "ema4", "ema5"].map((k) =>
        param("ema-ribbon", p, k),
      );
      /* Deduplicated, because two strands on the same period draw the same
         line twice and read as one thicker strand — which is exactly the
         "tangled" signal the ribbon uses to mean something else. */
      return [...new Set(periods)].map((period) => ({
        id: `ribbon-${period}`,
        values: ema(d.c, period),
        color: c,
        width: 1,
      }));
    },
  },
];

export const STUDY_IDS: readonly string[] = STUDIES.map((s) => s.id);

const BY_ID = new Map(STUDIES.map((s) => [s.id, s]));

/**
 * Build every overlay for the enabled studies.
 *
 * An unknown id is skipped rather than throwing: study ids are PERSISTED, so a
 * build that removed one would otherwise refuse to open on the preferences of
 * the build before it.
 */
export function runStudies(
  enabled: readonly string[],
  input: StudyInput,
  params: Readonly<Record<string, Params>> = {},
): LineOverlay[] {
  const out: LineOverlay[] = [];
  for (const id of enabled) {
    const study = BY_ID.get(id);
    if (study === undefined) continue;
    for (const line of study.run(input, params[id])) out.push(line);
  }
  return out;
}

export const FAMILY_LABEL: Readonly<Record<StudyMeta["family"], string>> = {
  trend: "Trend",
  range: "Range and volatility",
  volume: "Volume",
  exit: "Exits",
};

/** Columns from bars, allocated once for every study on the chart. */
export function studyColumns(bars: readonly BarView[]): Omit<StudyInput, "colour" | "anchorIndex"> {
  const n = bars.length;
  const t = new Float64Array(n);
  const o = new Float64Array(n);
  const h = new Float64Array(n);
  const l = new Float64Array(n);
  const c = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = bars[i] as BarView;
    t[i] = b.t;
    o[i] = b.o;
    h[i] = b.h;
    l[i] = b.l;
    c[i] = b.c;
    v[i] = b.v;
  }
  return { t, o, h, l, c, v, bars };
}
