/**
 * Structural columns — turning what the detectors FIND into something the
 * rule engine can TEST.
 *
 * WHY THIS IS THE MOST USEFUL THING THAT COULD BE ADDED TO THE LAB
 * The seventeen shipped specs are, with one exception, arithmetic on price:
 * EMA crosses, band fades, oscillator extremes. Meanwhile eight — now thirteen
 * — detectors find structure the chart draws and nobody can test, because the
 * rule vocabulary in `rules.ts` has no way to say "a sweep completed here".
 *
 * So the terminal has been in the position of showing you a liquidity sweep on
 * the chart, telling you its confidence, and having no idea whether sweeps
 * make money. That is the gap this closes, and it matters more than another
 * moving-average variant would: these are the entries you would actually take.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE LOOK-AHEAD PROBLEM, WHICH IS THE WHOLE DIFFICULTY
 *
 * A detection knows two bar indices: `from`, where the structure begins, and
 * `to`, the bar at which it became KNOWABLE. Writing an event at `from` would
 * be the single most damaging bug available in this file — a backtest entering
 * on the bar a pattern started, using the fact that it later completed, reads
 * information from the future and produces returns that cannot be achieved.
 *
 * Every column here is written at `to` and nowhere else. `detect/pivots.ts`
 * makes the same point at length about `confirmedAt`, and this obeys it.
 *
 * The zone columns are subtler: "close is inside an unmitigated fair value
 * gap" is only knowable from bar `to` onward, so the zone is painted forward
 * from `to`, never backward over the bars that formed it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * COST
 *
 * The detectors run once per backtest, not once per bar. Over 5,000 bars that
 * is a few milliseconds, against the tens of thousands of bar evaluations a
 * walk-forward sweep performs — so this is worth doing eagerly and caching,
 * which is what `structuralColumns` does.
 */

import { detectStructure } from "../detect/structure";
import { detectFVG, detectOrderBlocks } from "../detect/zones";
import { detectSweeps } from "../detect/liquidity";
import { detectRanges } from "../detect/ranges";
import type { DetectInput, Detection } from "../detect/types";
import type { StrategyContext } from "./engine";

/** The structural vocabulary, added to `COLUMNS` in `rules.ts`. */
export const STRUCTURAL_COLUMNS = {
  /** +1 on the bar a bullish break of structure completed, −1 bearish, else 0. */
  bos: "Break of structure (+1 up / −1 down)",
  /** +1 / −1 on the bar a change of character completed. */
  choch: "Change of character (+1 up / −1 down)",
  /** +1 on the bar a buy-side sweep was reclaimed, −1 for sell-side. */
  sweep: "Liquidity sweep (+1 long / −1 short)",
  /** +1 while close sits inside an unmitigated bullish FVG, −1 bearish. */
  infvg: "Inside a fair value gap (+1 bull / −1 bear)",
  /** +1 while close sits inside a bullish order block, −1 bearish. */
  inob: "Inside an order block (+1 bull / −1 bear)",
  /** +1 on the bar price closed out of a range upward, −1 downward. */
  expansion: "Range expansion (+1 up / −1 down)",
  /** 1 while price is inside a detected range, else 0. */
  inrange: "Inside a range (1 / 0)",
} as const;

export type StructuralColumnId = keyof typeof STRUCTURAL_COLUMNS;

/**
 * The caps are lifted, and that is a CORRECTNESS fix rather than a tuning one.
 *
 * MEASURED, by the look-ahead test that already existed. Every detector caps
 * its output with `slice(-maxResults)` — the most recent N — which is exactly
 * right for a chart, where the question is what to draw. It is a look-ahead
 * leak in a backtest: whether a sweep at bar 200 survives the cap depends on
 * how many sweeps happened AFTER it, so truncating the series at bar 320
 * changed the decision the engine made at bar 320. The test caught it on the
 * first run of `sweep-reclaim`.
 *
 * So the detectors are called here directly, with caps set high enough never
 * to bind, rather than through `runDetectors` with its display defaults. A
 * column is not a chart: it wants every event, at the bar it became knowable.
 */
const UNCAPPED = 1e9;

export type StructuralColumns = Partial<Record<StructuralColumnId, Float64Array>>;

const cache = new WeakMap<StrategyContext, StructuralColumns>();

const sign = (d: Detection): number => (d.direction === "long" ? 1 : d.direction === "short" ? -1 : 0);

/**
 * Build the structural columns a spec actually references.
 *
 * Cached per context, the same way `rules.ts` caches its indicator columns, so
 * a walk-forward sweep over twenty folds runs the detectors once rather than
 * twenty times.
 */
export function structuralColumns(
  ctx: StrategyContext,
  needed: ReadonlySet<string>,
): StructuralColumns {
  let table = cache.get(ctx);
  if (table === undefined) {
    table = {};
    cache.set(ctx, table);
  }

  const wanted = (Object.keys(STRUCTURAL_COLUMNS) as StructuralColumnId[]).filter(
    (id) => needed.has(id) && table[id] === undefined,
  );
  if (wanted.length === 0) return table;

  const data: DetectInput = {
    t: ctx.time,
    o: ctx.open,
    h: ctx.high,
    l: ctx.low,
    c: ctx.close,
    v: ctx.volume,
  };
  const n = ctx.close.length;
  const want = new Set(wanted);

  const found: Detection[] = [];
  if (want.has("bos") || want.has("choch")) {
    found.push(...detectStructure(data, {}, n));
  }
  if (want.has("sweep")) {
    found.push(...detectSweeps(data, { maxResults: UNCAPPED }, n));
  }
  /**
   * `hideMitigated: false`, and this is the opposite of what the chart wants.
   *
   * MEASURED: with the default (true) the `infvg` column was zero on every
   * bar of every fixture, and it took a probe to see why. An UNMITIGATED gap
   * is by definition one price has never traded back into — so filtering to
   * unmitigated zones and then asking "is price inside one" is a question
   * whose answer is always no, by construction. The rule could never fire.
   *
   * The display filter and the backtest need genuinely pull opposite ways. A
   * chart wants live zones only, because a dead one is clutter. A retest rule
   * wants every zone, and cares about exactly the moment price came back —
   * which is the moment the chart stops drawing it. So all zones are taken
   * here and the loop below closes each one itself, at the close that goes
   * through its far side.
   */
  if (want.has("infvg")) {
    found.push(...detectFVG(data, { maxZones: UNCAPPED, hideMitigated: false }, n));
  }
  if (want.has("inob")) {
    found.push(...detectOrderBlocks(data, { maxZones: UNCAPPED, hideMitigated: false }, n));
  }
  if (want.has("expansion") || want.has("inrange")) {
    found.push(...detectRanges(data, { maxResults: UNCAPPED }, n));
  }

  const blank = (): Float64Array => new Float64Array(n);

  for (const id of wanted) {
    const col = blank();

    if (id === "bos" || id === "choch") {
      for (const d of found) {
        if (d.kind !== id) continue;
        /* `to`, never `from`. See the header: writing the event at `from`
           would let a backtest enter on the bar a pattern started using the
           fact that it later completed. */
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "sweep") {
      for (const d of found) {
        if (d.kind !== "liquidity-sweep") continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "expansion") {
      for (const d of found) {
        if (d.kind !== "expansion") continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "inrange") {
      for (const d of found) {
        if (d.kind !== "range") continue;
        /* A range is a STATE, so it is painted across the bars it covers —
           but only from `to` onward, because that is when it was knowable. */
        for (let i = d.to; i < n; i++) {
          const box = d.shapes.find((s) => s.type === "box");
          if (box === undefined || box.type !== "box") break;
          const c = ctx.close[i] as number;
          if (c < Math.min(box.y0, box.y1) || c > Math.max(box.y0, box.y1)) break;
          col[i] = 1;
        }
      }
    } else {
      /**
       * The RETEST, as an event — not zone membership as a state.
       *
       * The first version marked every bar whose close sat inside any live
       * zone. Measured on the fixtures that lit 531 of 700 bars, because
       * zones overlap and most closes are inside one of them. A filter that is
       * true three-quarters of the time is not a filter, and a "retest" rule
       * built on it would fire on almost every bar rather than on the return
       * it is named for.
       *
       * So each zone contributes exactly ONE bar: the first close back inside
       * it. That matches every other column here — an event at the bar it
       * became knowable — and it is what "retest" actually means.
       */
      const kind = id === "infvg" ? "fvg" : "order-block";
      for (const d of found) {
        if (d.kind !== kind) continue;
        const box = d.shapes.find((s) => s.type === "box");
        if (box === undefined || box.type !== "box") continue;
        const lo = Math.min(box.y0, box.y1);
        const hi = Math.max(box.y0, box.y1);
        const s = sign(d);
        for (let i = d.to + 1; i < n; i++) {
          const c = ctx.close[i] as number;
          if (c >= lo && c <= hi) {
            col[i] = s;
            break;
          }
          /* A close through the FAR side mitigates the zone. It has stopped
             being a level anyone is defending, and a later touch of the same
             prices is not a retest of it. */
          if (s > 0 && c < lo) break;
          if (s < 0 && c > hi) break;
        }
      }
    }

    table[id] = col;
  }

  return table;
}

export function isStructuralColumn(v: string): v is StructuralColumnId {
  return Object.prototype.hasOwnProperty.call(STRUCTURAL_COLUMNS, v);
}
