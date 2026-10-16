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
import { detectBreakers, detectRanges } from "../detect/ranges";
import { detectFailedBreaks, detectMitigation, detectSprings } from "../detect/failure";
import { detectVolumeClimax } from "../detect/volume";
import { detectDivergence } from "../detect/formations";
import { volumeProfile } from "../chart/profile";
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

  /* ───────────────────────────────────────────────────────── v63.26
   * NINE MORE DETECTORS, MADE TESTABLE.
   *
   * MEASURED: 24 of 29 registered detectors drew on the chart and could not be
   * named by a rule. The four families most often asked for — Wyckoff, volume
   * profile, price-action failures and the rest of SMC — were every one of them
   * already DETECTED and drawn, and there was no way to ask whether any of them
   * made money. A store with a writer and no reader.
   *
   * They are columns rather than new hand-written strategies on purpose: the
   * chart and the backtester then call the SAME detector, so the two cannot
   * disagree about what a spring is.
   */

  /** +1 on the bar a Wyckoff spring was reclaimed, −1 for an upthrust. */
  spring: "Spring (+1) / upthrust (−1)",
  /** +1 buying climax, −1 selling climax, on the bar itself. */
  climax: "Volume climax (+1 up / −1 down)",
  /** The PREVIOUS completed period's point of control, as a price. */
  poc: "Prior point of control (price)",
  /** The previous completed period's value area high, as a price. */
  vah: "Prior value area high (price)",
  /** The previous completed period's value area low, as a price. */
  val: "Prior value area low (price)",
  /** +1 on the bar a bearish structure break failed, −1 for a bullish one. */
  failbreak: "Failed break (+1 long / −1 short)",
  /** +1 on the bar a broken level was retested and held, −1 bearish. */
  retest: "Break retested and held (+1 / −1)",
  /** +1 on the bar price returned to a bullish breaker block, −1 bearish. */
  breaker: "Breaker block retest (+1 / −1)",
  /** +1 bullish RSI divergence, −1 bearish, at the bar it completed. */
  divergence: "RSI divergence (+1 bull / −1 bear)",
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

/**
 * AND THE WINDOW IS A CAP TOO.
 *
 * `detectSweeps` and `detectRanges` scan `from = len - lookback` with a default
 * of 400 bars. MEASURED bar by bar, 700 against 900: an event at bar 400 EXISTS
 * in the shorter run and does not exist in the longer one, so the column rewrote
 * its own past as the series grew. Three shipped columns were affected —
 * `sweep`, `infvg` and `expansion` — and the spec-level look-ahead test did not
 * see it because it samples three bar indices and the window edge fell between
 * them.
 *
 * Passed everywhere a detector accepts it. `UNCAPPED` names the same idea for
 * both fields because it IS the same defect: a number that makes the answer
 * depend on how long the series happens to be.
 */
const FULL_HISTORY = UNCAPPED;

/**
 * The profile grid.
 *
 * 96 bars is `detect/volume.ts`'s own `periodBars` default — a day of 15m, four
 * days of 1h — and it is taken from there rather than chosen again so the levels
 * a rule trades are the same size of period the chart draws. 60 bins likewise.
 */
const PROFILE_PERIOD_BARS = 96;
const PROFILE_BINS = 60;

/**
 * How far back a volume climax is measured.
 *
 * 400 bars is the span `detectVolumeClimax` already scans for display, reused
 * here as the MEASUREMENT window so the two describe the same neighbourhood.
 * Long enough that a quiet week does not make every bar a climax, short enough
 * that a bar is judged against business anyone still remembers.
 */
const CLIMAX_WINDOW = 400;

/** The same idea for the fair-value-gap size floor, and the same span. */
const FVG_FLOOR_WINDOW = 400;

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
/**
 * Append without spreading.
 *
 * `push(...arr)` passes every element as a separate ARGUMENT and the engine's
 * limit is a few tens of thousands, so an uncapped detector on a real study —
 * 41,538 bars is an ordinary request here — throws `Maximum call stack size
 * exceeded`. Every cap in this file is lifted ON PURPOSE, which makes that the
 * normal case rather than an edge one.
 */
function pushAll(into: Detection[], from: readonly Detection[]): void {
  for (const d of from) into.push(d);
}

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
    pushAll(found, detectStructure(data, {}, n));
  }
  if (want.has("sweep")) {
    pushAll(found, detectSweeps(data, { maxResults: UNCAPPED, lookback: FULL_HISTORY }, n));
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
    pushAll(found, detectFVG(
      data,
      /* A ROLLING SIZE FLOOR. The default is a quantile over every gap in the
         series, so the same three bars are a gap at 700 bars and not at 900. */
      { maxZones: UNCAPPED, hideMitigated: false, floorWindow: FVG_FLOOR_WINDOW },
      n,
    ));
  }
  if (want.has("inob")) {
    pushAll(found, detectOrderBlocks(
        data,
        { maxZones: UNCAPPED, hideMitigated: false, floorWindow: FVG_FLOOR_WINDOW },
        n,
      ),
    );
  }
  if (want.has("expansion") || want.has("inrange")) {
    pushAll(found, detectRanges(
        data,
        /* `scanFrom: "start"` — see the option. The chart tiles ranges backward
           from the last bar, which re-tiles the whole history every time a bar
           arrives. */
        { maxResults: UNCAPPED, lookback: FULL_HISTORY, scanFrom: "start" },
        n,
      ),
    );
  }

  /*
   * THE v63.26 DETECTORS, EVERY CAP LIFTED.
   *
   * `maxPerKind`, `maxResults` and `maxClimax` are display defaults and every
   * one of them is a look-ahead leak here, for the reason UNCAPPED already
   * records: whether an event at bar 200 survives a `slice(-4)` depends on how
   * many events happened AFTER it.
   *
   * `lookback` is the same defect wearing a different name. `detectFailedBreaks`
   * keeps only breaks with `d.to >= len - lookback`, so at 700 bars a break at
   * bar 250 is in scope and at 900 bars it is not — the column would rewrite its
   * own past as the series grew. `detectorcolumns.test.ts` compares 700 against
   * 900 for exactly this.
   */
  if (want.has("spring")) {
    pushAll(found, detectSprings(
        data,
        { maxPerKind: UNCAPPED, lookback: FULL_HISTORY, sourceCap: UNCAPPED, causal: true },
        n,
      ),
    );
  }
  if (want.has("failbreak") || want.has("retest")) {
    pushAll(
      found,
      detectFailedBreaks(
        data,
        { maxPerKind: UNCAPPED, lookback: FULL_HISTORY, sourceCap: UNCAPPED, causal: true },
        n,
      ),
    );
    pushAll(
      found,
      detectMitigation(data, { maxPerKind: UNCAPPED, sourceCap: UNCAPPED, causal: true }, n),
    );
  }
  if (want.has("breaker")) {
    pushAll(found, detectBreakers(
      data,
      { maxResults: UNCAPPED, sourceCap: UNCAPPED, requireRetest: true, causal: true },
      n,
    ));
  }
  if (want.has("climax")) {
    /* A ROLLING THRESHOLD, not the whole series. See `climaxWindow`: the
       detector's default asks whether this bar is loud against all of history,
       which is a different number every time history gets longer. */
    pushAll(found, detectVolumeClimax(data, { maxClimax: UNCAPPED, climaxWindow: CLIMAX_WINDOW }, n),
    );
  }
  if (want.has("divergence")) {
    pushAll(found, detectDivergence(data, { maxAgeBars: UNCAPPED }, n));
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
    } else if (id === "poc" || id === "vah" || id === "val") {
      /**
       * THE PRIOR PERIOD'S LEVELS, ON A FIXED BAR GRID.
       *
       * `detectProfile` IS NOT USED HERE, and that is the one place in this file
       * where the chart's own detector had to be left behind. It slices periods
       * as `end = len - k * size`, anchored to the LAST bar — exactly right for
       * "the last three sessions" on a chart, and meaningless in a backtest,
       * where the boundaries would slide every time the series grew and
       * yesterday's value area would stop being yesterday's.
       *
       * So the framing is fixed here and the ARITHMETIC is still shared:
       * `volumeProfile` is the one owner of the CME value-area walk, called by
       * the chart study, by the detector, and by this. A second implementation
       * would be a second place for the 70% band to disagree with itself.
       *
       * Period k covers bars [k*SIZE, (k+1)*SIZE) and governs the bars AFTER it.
       * Nothing governs the first period: a profile built from bars 0-95 is only
       * knowable at bar 96, and filling bar 0 with it would hand the backtest
       * the session's own outcome.
       */
      /* NOT KNOWN IS NaN, NOT ZERO, and that is a correctness fix rather than a
         nicety. A price column reading 0 makes `close > val` trivially true and
         `close crossbelow vah` fire on the very bar the first level appears -
         price crosses a threshold that jumped from 0 to 98, which is an event
         about the column filling in and not about the market. Every operator
         here answers false against NaN, so an unknown level simply cannot
         satisfy a condition. */
      col.fill(Number.NaN);
      const size = PROFILE_PERIOD_BARS;
      for (let k = 0; (k + 1) * size <= n; k++) {
        const start = k * size;
        const end = (k + 1) * size;
        const p = volumeProfile(ctx.bars.slice(start, end), PROFILE_BINS);
        /* NULL IS AN ANSWER: an FX feed carries no volume, and a flat block with
           an arbitrary point of control is worse than no level at all. Those
           bars keep 0, which every rule here reads as "not known". */
        if (p === null) continue;
        const level = id === "poc" ? p.poc : id === "vah" ? p.vah : p.val;
        if (!Number.isFinite(level)) continue;
        const until = Math.min(n, end + size);
        for (let i = end; i < until; i++) col[i] = level;
      }
    } else if (id === "spring") {
      for (const d of found) {
        if (d.kind !== "spring" && d.kind !== "upthrust") continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "climax" || id === "divergence") {
      const kind = id === "climax" ? "volume-climax" : "divergence";
      for (const d of found) {
        if (d.kind !== kind) continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "failbreak" || id === "retest" || id === "breaker") {
      /* `retest` takes BOTH kinds that mean "price came back and the level
         held": a structure break retested, and an order block mitigated. They
         are one fact with two detectors, and a rule asking for the return does
         not care which found it. */
      const kinds =
        id === "failbreak"
          ? ["failed-break"]
          : id === "breaker"
            ? ["breaker"]
            : ["retest", "mitigation"];
      for (const d of found) {
        if (!kinds.includes(d.kind)) continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "expansion") {
      for (const d of found) {
        if (d.kind !== "expansion") continue;
        if (d.to >= 0 && d.to < n) col[d.to] = sign(d);
      }
    } else if (id === "inrange") {
      for (const d of found) {
        /**
         * BOTH KINDS, KEYED ON `settledAt`.
         *
         * Filtering on `kind === "range"` was a look-ahead leak that no cap or
         * window could reach, because it lived in the detection's IDENTITY: a
         * range becomes an `expansion` the moment price closes out of it, so the
         * same box was a range at 261 bars and an expansion at 900, and bars
         * 259-260 were inside a range in one run and not in the other.
         *
         * `settledAt` is the box's last bar and never moves. The loop below
         * already stops the moment a close leaves the box, so a range that later
         * breaks is painted up to its break and no further — which is what the
         * column meant all along.
         */
        if (d.kind !== "range" && d.kind !== "expansion") continue;
        const settled = d.settledAt ?? d.to;
        /* A range is a STATE, so it is painted across the bars it covers —
           but only from the bar it was settled, because that is when it was
           knowable. */
        for (let i = settled; i < n; i++) {
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
