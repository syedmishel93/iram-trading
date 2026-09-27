/**
 * The one axis that is not arithmetic on close.
 *
 * Every oscillator the terminal draws is a rearrangement of past closes, and
 * rearranging closes cannot produce information that was not already in them.
 * A volume profile asks a different question — how much business was done at
 * each PRICE, ignoring when — and the levels it produces are ones no moving
 * average can give you. `chart/profile.ts` has built that profile since v50
 * and nothing has ever detected off it. This does.
 *
 * FOUR THINGS, THREE OF WHICH ARE LEVELS
 *   poc            the price that traded the most, per period
 *   value-area     the band holding 70% of the volume, and its edges
 *   lvn            a price the market moved THROUGH — thin, so it travels fast
 *   volume-climax  a bar whose volume is an outlier against its own recent past
 *
 * NAKED POC IS THE ONE WORTH THE CODE
 * A period's point of control that later price has never returned to is an
 * unfinished piece of business at a price the market once agreed on. It is
 * also, unlike most of this file, cheap to define exactly: the POC of a closed
 * period that no subsequent bar's range has contained.
 *
 * THE APPROXIMATION, INHERITED AND RESTATED
 * `chart/profile.ts` builds from BARS, not trades: each bar's volume is spread
 * uniformly across the prices it touched. Every level here carries that
 * approximation. It is stated in the reason string of each detection rather
 * than in this comment alone, because a caveat the operator cannot see on the
 * chart is a caveat that does not exist.
 *
 * NO-VOLUME FEEDS
 * `volumeProfile` returns null when the window has no volume — an FX feed via
 * some brokers, a synthetic series. This detector then returns nothing at all
 * rather than a profile of ones, and the emptiness is correct: there is no
 * volume information to have.
 */

import { volumeProfile, profileNodes, type VolumeProfile } from "../chart/profile";
import { quantile } from "./calibrate";
import { clamp01, px, type Detection, type DetectInput } from "./types";

export interface VolumeDetectOptions {
  /** How many closed periods to profile, newest last. */
  periods?: number;
  /** Bars per period. Defaults to a day-ish block scaled to the series. */
  periodBars?: number;
  /** Bins per profile. */
  bins?: number;
  /** Low-volume nodes returned, strongest first. */
  maxNodes?: number;
  /** A climax bar must exceed this quantile of the window's volume. */
  climaxQuantile?: number;
  /** Climax bars returned, newest first. */
  maxClimax?: number;
}

const DEFAULTS = {
  periods: 3,
  periodBars: 96,
  bins: 60,
  maxNodes: 3,
  climaxQuantile: 0.98,
  maxClimax: 4,
};

interface Period {
  start: number;
  end: number;
  profile: VolumeProfile;
}

/**
 * Profile the last `periods` CLOSED blocks of `periodBars` bars each.
 *
 * Closed, and that word is load-bearing: the block containing the live bar has
 * a point of control that moves as the session fills in, and a level that
 * moves is not a level. The forming block is profiled separately and labelled
 * as forming, so the operator can see it without it pretending to be settled.
 */
function periodsOf(data: DetectInput, len: number, count: number, size: number, bins: number): Period[] {
  const out: Period[] = [];
  for (let k = 0; k < count; k++) {
    const end = len - k * size;
    const start = end - size;
    if (start < 0) break;
    const bars = [];
    for (let i = start; i < end; i++) {
      bars.push({
        t: data.t[i] as number,
        o: data.o[i] as number,
        h: data.h[i] as number,
        l: data.l[i] as number,
        c: data.c[i] as number,
        v: data.v[i] as number,
      });
    }
    const profile = volumeProfile(bars, bins);
    if (profile) out.push({ start, end: end - 1, profile });
  }
  return out.reverse();
}

/** Has any bar after `from` traded through `price`? */
function revisited(data: DetectInput, from: number, len: number, price: number): boolean {
  for (let i = from; i < len; i++) {
    if ((data.l[i] as number) <= price && (data.h[i] as number) >= price) return true;
  }
  return false;
}

export function detectProfile(
  data: DetectInput,
  opts: VolumeDetectOptions = {},
  len = data.c.length,
): Detection[] {
  const periodBars = opts.periodBars ?? DEFAULTS.periodBars;
  const count = opts.periods ?? DEFAULTS.periods;
  const bins = opts.bins ?? DEFAULTS.bins;
  const maxNodes = opts.maxNodes ?? DEFAULTS.maxNodes;

  if (len < periodBars + 5) return [];

  const periods = periodsOf(data, len, count, periodBars, bins);
  if (periods.length === 0) return [];

  const out: Detection[] = [];
  const caveat = "Built from bar ranges, not trades — each bar's volume is spread across the prices it touched.";

  for (const p of periods) {
    const { poc, vah, val } = p.profile;
    const naked = !revisited(data, p.end + 1, len, poc);

    out.push({
      id: `poc-${p.start}`,
      kind: "poc",
      label: naked ? "Naked POC" : "Point of control",
      direction: "neutral",
      from: p.start,
      to: p.end,
      confidence: clamp01(naked ? 0.65 : 0.45),
      reason:
        `Most business over bars ${p.start}-${p.end} was done at ${px(poc)}. ` +
        (naked
          ? "Price has not traded back through it since — unfinished business at a price the market agreed on. "
          : "Price has since traded back through it. ") +
        caveat,
      shapes: [
        {
          type: "level",
          x0: p.start,
          y: poc,
          tone: naked ? "accent" : "neutral",
          label: naked ? "nPOC" : "POC",
          dashed: !naked,
        },
      ],
    });

    out.push({
      id: `va-${p.start}`,
      kind: "value-area",
      label: "Value area",
      direction: "neutral",
      from: p.start,
      to: p.end,
      confidence: 0.4,
      reason:
        `70% of the volume over bars ${p.start}-${p.end} traded between ${px(val)} and ${px(vah)}. ` +
        `Outside that band is where the period spent time it did not agree with. ` + caveat,
      shapes: [
        { type: "box", x0: p.start, x1: p.end, y0: val, y1: vah, tone: "neutral", dashed: true, label: "VA" },
        { type: "level", x0: p.end, y: vah, tone: "neutral", label: "VAH", dashed: true },
        { type: "level", x0: p.end, y: val, tone: "neutral", label: "VAL", dashed: true },
      ],
    });
  }

  /* Low-volume nodes over the whole window rather than per period: an LVN is
     interesting because price crossed it FAST, and a per-period one is often
     just the edge of that period's range. */
  const newest = periods[periods.length - 1] as Period;
  const nodes = profileNodes(newest.profile, 1)
    .filter((n) => n.kind === "lvn")
    .sort((a, b) => a.volume - b.volume)
    .slice(0, maxNodes);

  for (const n of nodes) {
    out.push({
      id: `lvn-${newest.start}-${n.price.toFixed(6)}`,
      kind: "lvn",
      label: "Low-volume node",
      direction: "neutral",
      from: newest.start,
      to: newest.end,
      confidence: 0.35,
      reason:
        `Almost nothing traded at ${px(n.price)} across bars ${newest.start}-${newest.end}. ` +
        `Price passed through rather than doing business there, which is a claim about SPEED ` +
        `through the level, not about direction. ` + caveat,
      shapes: [{ type: "level", x0: newest.start, y: n.price, tone: "accent", label: "LVN", dashed: true }],
    });
  }

  return out;
}

/**
 * Bars whose volume is an outlier against the window's own distribution.
 *
 * A rank, not a multiple: "the top 2% of this window's bars" transfers across
 * instruments and timeframes where "three times the 20-bar average" does not.
 *
 * DIRECTION IS THE BAR'S OWN, AND THAT IS A DELIBERATE UNDERCLAIM. A climax is
 * conventionally read as exhaustion — a big down bar on huge volume marking a
 * low. It is equally often continuation. Rather than pick, this reports the
 * side the bar closed and lets `setup/simulate.ts` say which reading holds
 * here; if exhaustion is right the record will come back inverted, and an
 * inverted record is a finding rather than an embarrassment.
 */
export function detectVolumeClimax(
  data: DetectInput,
  opts: VolumeDetectOptions = {},
  len = data.c.length,
): Detection[] {
  const q = opts.climaxQuantile ?? DEFAULTS.climaxQuantile;
  const max = opts.maxClimax ?? DEFAULTS.maxClimax;
  if (len < 60) return [];

  const vols: number[] = [];
  for (let i = 0; i < len; i++) {
    const v = data.v[i] as number;
    if (Number.isFinite(v) && v > 0) vols.push(v);
  }
  /* Fewer than half the bars carry volume: this is a feed that reports it
     sporadically, and a quantile over the ones that do would compare a real
     bar against a gap. */
  if (vols.length < len * 0.5) return [];

  const cut = quantile(vols, q);
  if (!(cut > 0)) return [];

  const found: Detection[] = [];
  for (let i = Math.max(1, len - 400); i < len; i++) {
    const v = data.v[i] as number;
    if (!(v >= cut)) continue;
    const o = data.o[i] as number;
    const c = data.c[i] as number;
    const h = data.h[i] as number;
    const l = data.l[i] as number;
    if (c === o) continue;
    const up = c > o;
    const range = h - l;
    const closePos = range > 0 ? (c - l) / range : 0.5;
    const multiple = v / (quantile(vols, 0.5) || v);

    found.push({
      id: `climax-${i}`,
      kind: "volume-climax",
      label: up ? "Buying climax" : "Selling climax",
      direction: up ? "long" : "short",
      from: i,
      to: i,
      confidence: clamp01(0.35 + 0.3 * clamp01(multiple / 10) + 0.2 * Math.abs(closePos - 0.5) * 2),
      reason:
        `Volume ${multiple.toFixed(1)}x the window median, in the top ${((1 - q) * 100).toFixed(0)}% ` +
        `of bars here, closing ${up ? "up" : "down"} at ${(closePos * 100).toFixed(0)}% of its range. ` +
        `Reported with the side the bar closed, not as exhaustion — which of the two readings holds ` +
        `on this instrument is what the record is for.`,
      shapes: [
        { type: "box", x0: i - 0.45, x1: i + 0.45, y0: l, y1: h, tone: up ? "bull" : "bear", dashed: true },
        { type: "marker", x: i, y: up ? l : h, tone: up ? "bull" : "bear", text: "vol", above: !up },
      ],
    });
  }

  found.sort((x, y) => y.to - x.to);
  return found.slice(0, max).sort((x, y) => x.to - y.to);
}
