/**
 * The batch "learn from the past" pass.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS, IN ONE LINE
 *
 * For a list of instruments: read what the archive already holds, run the
 * detectors the operator has switched on, replay every setup kind found, file
 * each completed trial under the conditions it happened in, and merge the
 * result into `learn/knowledge.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT DOES NOT CONTAIN A REPLAY ENGINE, AND THAT IS DELIBERATE
 *
 * Every trial here comes from `setup/deep.ts:replayAll`, which calls
 * `setup/simulate.ts:simulateKind`. A second replay would be a second
 * definition of what a win is — and the moment the two disagreed, the Setup
 * card's in-sample strip and this base would be quoting incomparable numbers
 * about the same pattern on the same chart, with nothing on screen saying so.
 * `simulate.ts` already makes that argument about `learn/resolve.ts`; this is
 * the same argument one level up.
 *
 * So the whole of this file is: fetch, attribute, merge, and stay off the main
 * thread's back while doing it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NO VENDOR BACKFILL UNLESS ASKED. SAME RULE AS `deep.ts`.
 *
 * `history.backfill` pages a vendor. Doing that automatically for twenty
 * instruments would fire hundreds of requests at a proxy the operator is often
 * running on their own machine, for a desk they may have opened to look at what
 * is already there. So the default pass reads the ARCHIVE, reports the depth it
 * actually got, and reaching further is an explicit flag that says how far it
 * got.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE CHUNKING, AND WHAT IT COST WHEN MEASURED
 *
 * A harvest is not one expensive thing; it is four, and only three of them are
 * synchronous. MEASURED, via `vite-node`, over a 6,000-bar 15m random walk with
 * the default detector set — 325 detections, 7 setup kinds, 291 completed
 * trials — best of 5 runs after two warm-ups, median in brackets:
 *
 *     classifyRegimes        9.7 ms  (10.1)
 *     runDetectors           3.6 ms  ( 6.2)
 *     replayAll + attribute  6.1 ms  ( 7.1)
 *     -------------------------------------
 *     one instrument        19.4 ms  (23.4)
 *
 * Twenty milliseconds is already a dropped frame at 60Hz, and twenty
 * instruments back to back is nearly half a second of frozen terminal. So the
 * synchronous work is split at its two natural seams with a yield between them
 * — the WORST single chunk is then `classifyRegimes` at 10.1 ms, inside a
 * 16.7 ms frame — and `history.load` between targets is awaited, which yields
 * by itself.
 *
 * The regime pass being the expensive one is not obvious and is the reason it
 * got its own chunk: it looks like a cheap label and it is an O(n · 250)
 * trailing rank, which is why it costs nearly three times the thirteen
 * detectors put together.
 *
 * The yield goes through `core/frame.ts:scheduleFrame` rather than
 * `requestAnimationFrame`, because rAF never fires in an uncomposited tab and
 * this terminal is always a background tab. A harvest that silently stopped
 * when the operator switched to MT5 would be the worst available outcome: it
 * looks like it is running.
 */

import { signal, type ReadSignal } from "../core/signal";
import { scheduleFrame } from "../core/frame";
import type { BarView } from "../chart/series";
import { classifyRegimes, type Regime } from "../backtest/regime";
import { runDetectors, toDetectInput, type DetectorId } from "../detect/index";
import type { HistoryService } from "../data/history";
import { DEEP_TARGET_BARS, replayAll } from "../setup/deep";
import {
  buildEntry,
  contextAt,
  type Direction,
  type KnowledgeBase,
  type KnowledgeEntry,
  type MergeReport,
  type TrialFact,
} from "./knowledge";

/** One instrument to learn from. */
export interface HarvestTarget {
  readonly symbol: string;
  readonly timeframe: string;
}

export interface HarvestOptions {
  readonly history: HistoryService;
  readonly base: KnowledgeBase;
  readonly targets: readonly HarvestTarget[];
  /** Which detectors to run. The operator's own set, not a fixed list. */
  readonly detectors: readonly DetectorId[];
  /** The reward-to-risk every trial is priced at. */
  readonly rMultiple: number;
  /** The operator's own minimum stop, in ATR. The same floor the live plan uses. */
  readonly minStopAtr: number;
  readonly targetBars?: number;
  /** Page a vendor for older bars first. Off by default — see the header. */
  readonly backfill?: boolean;
  readonly now?: () => number;
  /**
   * How to hand the frame back between chunks.
   *
   * Injected so a test can drive the pass on a synchronous clock instead of
   * waiting on real frames. Defaults to `scheduleFrame`, which falls back to a
   * timer when frames are not being served.
   */
  readonly yieldTo?: (job: () => void) => () => void;
}

export interface HarvestProgress {
  readonly done: number;
  readonly total: number;
  readonly symbol: string;
  readonly timeframe: string;
  /** What it is doing right now, in words. */
  readonly note: string;
}

export const IDLE_PROGRESS: HarvestProgress = {
  done: 0,
  total: 0,
  symbol: "",
  timeframe: "",
  note: "",
};

/** What one instrument produced. Every target gets a row, successful or not. */
export interface HarvestRow {
  readonly symbol: string;
  readonly timeframe: string;
  readonly state: "ok" | "short" | "failed" | "cancelled";
  /** Closed bars replayed over. */
  readonly bars: number;
  /** Setup kinds that produced at least one completed trial. */
  readonly kinds: number;
  readonly trials: number;
  readonly note: string;
}

export interface HarvestReport {
  readonly rows: readonly HarvestRow[];
  /** Null when nothing reached the base. */
  readonly merged: MergeReport | null;
  readonly cancelled: boolean;
  /** Wall-clock of the whole pass. */
  readonly ms: number;
  /** One paragraph the desk can print verbatim. */
  readonly note: string;
}

export interface HarvestHandle {
  readonly progress: ReadSignal<HarvestProgress>;
  readonly running: ReadSignal<boolean>;
  /** Stop after the chunk in flight. The rows already gathered are still merged. */
  cancel(): void;
  readonly done: Promise<HarvestReport>;
}

/**
 * A study needs at least this many closed bars to be worth filing.
 *
 * Under it there is nothing to replay — `simulateKind` refuses below one
 * horizon plus five anyway — and an entry built from sixty bars would spend a
 * cap slot to say "too few".
 */
export const MIN_HARVEST_BARS = 300;

/**
 * Turn one instrument's replayed simulations into entries.
 *
 * Exported because this is the part with a decision in it: WHICH BAR'S
 * CONTEXT a trial is filed under. It is the CONFIRMATION bar — the bar whose
 * close is the trial's entry, and the last bar whose information the operator
 * would have had when deciding. Filing it under the bar it RESOLVED on would
 * be scoring a decision by conditions it could not have known, which is the
 * same error `backtest/regime.ts:byRegime` avoids by splitting on entry.
 */
export function entriesFor(
  symbol: string,
  timeframe: string,
  bars: readonly BarView[],
  len: number,
  detectors: readonly DetectorId[],
  rMultiple: number,
  minStopAtr: number,
  regimes: readonly Regime[],
  at: number,
): { entries: readonly KnowledgeEntry[]; trials: number } {
  const data = toDetectInput(bars.slice(0, len));
  const dets = runDetectors(data, detectors);
  const sims = replayAll(dets, data, len, rMultiple, minStopAtr);

  const entries: KnowledgeEntry[] = [];
  let trials = 0;

  for (const [key, sim] of sims) {
    const [kind, direction] = key.split("|") as [string, Direction];
    const facts: TrialFact[] = [];
    for (const t of sim.trials) {
      /* `unknowable` is excluded here for the same reason `simulate.ts`
         excludes it from every statistic: a bar whose range covers both
         barriers does not say which came first, and folding it into either
         bucket is how a replay manufactures an edge. */
      if (t.outcome === "unknowable" || t.r === null) continue;
      const regime = regimes[t.atBar] ?? "chop";
      facts.push({
        at: t.at,
        outcome: t.outcome,
        r: t.r,
        heldBars: t.heldBars,
        context: contextAt(t.at, regime),
      });
    }
    if (facts.length === 0) continue;
    const entry = buildEntry(
      { source: "replay", symbol, timeframe, kind, direction, bars: len, rMultiple, trials: facts },
      at,
    );
    if (entry !== null) {
      entries.push(entry);
      trials += facts.length;
    }
  }
  return { entries, trials };
}

export function runHarvest(opts: HarvestOptions): HarvestHandle {
  const progress = signal<HarvestProgress>(IDLE_PROGRESS);
  const running = signal(true);
  const now = opts.now ?? Date.now;
  const yieldTo = opts.yieldTo ?? scheduleFrame;
  const want = opts.targetBars ?? DEEP_TARGET_BARS;

  let cancelled = false;
  let cancelPending: (() => void) | null = null;

  /**
   * Hand the frame back. Resolves on the next chunk, or at once if cancelled.
   *
   * `settled` is not defensive padding. A cancel can arrive INSIDE `yieldTo`
   * — a synchronous scheduler in a test does exactly that — at which point the
   * canceller exists and the scheduler's own handle does not, so both paths
   * can reach the resolve. Resolving twice is harmless; running the rest of
   * the teardown twice is not, and this is the one place the two orders meet.
   */
  const breathe = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (cancelled) {
        resolve();
        return;
      }
      let settled = false;
      let stop: (() => void) | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cancelPending = null;
        resolve();
      };
      cancelPending = () => {
        if (stop) stop();
        finish();
      };
      stop = yieldTo(finish);
    });

  const started = now();

  const done = (async (): Promise<HarvestReport> => {
    const rows: HarvestRow[] = [];
    const gathered: KnowledgeEntry[] = [];
    const total = opts.targets.length;

    for (let i = 0; i < total; i++) {
      const target = opts.targets[i] as HarvestTarget;
      const { symbol, timeframe } = target;
      if (cancelled) {
        rows.push({
          symbol,
          timeframe,
          state: "cancelled",
          bars: 0,
          kinds: 0,
          trials: 0,
          note: "Stopped before this one was read.",
        });
        continue;
      }

      const step = (note: string): void =>
        progress.set({ done: i, total, symbol, timeframe, note });

      try {
        if (opts.backfill === true) {
          step("reaching further back…");
          try {
            await opts.history.backfill(symbol, timeframe, want, {
              onProgress: (added) => step(`backfilled ${added.toLocaleString()}…`),
            });
          } catch {
            /* A vendor limit or a dead proxy. Learn from what is held and say
               the window is short — a shorter sample honestly labelled beats
               abandoning the instrument. */
            step("could not reach further back — using what is held");
          }
        }

        step("reading the archive…");
        const res = await opts.history.load(symbol, timeframe, { limit: want });
        if (cancelled) {
          rows.push({
            symbol,
            timeframe,
            state: "cancelled",
            bars: res.bars.length,
            kinds: 0,
            trials: 0,
            note: "Stopped after the bars arrived and before they were replayed.",
          });
          continue;
        }

        /* The forming bar is excluded for the same reason detection excludes
           it: its "close" is the current price, not a close. */
        const len = Math.max(0, res.bars.length - 1);
        if (len < MIN_HARVEST_BARS) {
          rows.push({
            symbol,
            timeframe,
            state: "short",
            bars: len,
            kinds: 0,
            trials: 0,
            note:
              `Only ${len.toLocaleString()} closed bars are held — under the ${MIN_HARVEST_BARS} ` +
              `needed before a replay says anything. ${
                opts.backfill === true
                  ? "Reaching further back did not find more."
                  : "Turn on reaching further back, or open this instrument for a while."
              }`,
          });
          continue;
        }

        /* CHUNK 1 — the regime labels. The heaviest of the three at 7.4 ms on
           6,000 bars, because the volatility percentile is a trailing rank. */
        step("labelling the conditions…");
        await breathe();
        if (cancelled) {
          rows.push({ symbol, timeframe, state: "cancelled", bars: len, kinds: 0, trials: 0, note: "Stopped while labelling." });
          continue;
        }
        const regimes = classifyRegimes(res.bars.slice(0, len));

        /* CHUNK 2 — detect and replay. */
        step("replaying every setup…");
        await breathe();
        if (cancelled) {
          rows.push({ symbol, timeframe, state: "cancelled", bars: len, kinds: 0, trials: 0, note: "Stopped before replaying." });
          continue;
        }
        const made = entriesFor(
          symbol,
          timeframe,
          res.bars,
          len,
          opts.detectors,
          opts.rMultiple,
          opts.minStopAtr,
          regimes,
          now(),
        );

        gathered.push(...made.entries);
        rows.push({
          symbol,
          timeframe,
          state: "ok",
          bars: len,
          kinds: made.entries.length,
          trials: made.trials,
          note:
            made.entries.length === 0
              ? `Replayed ${len.toLocaleString()} bars and no setup kind completed a single trial. Nothing to file.`
              : `Replayed ${len.toLocaleString()} bars — ${made.trials.toLocaleString()} completed ${
                  made.trials === 1 ? "trial" : "trials"
                } across ${made.entries.length} setup ${made.entries.length === 1 ? "kind" : "kinds"}.`,
        });
      } catch (err) {
        /* One dead vendor must not abandon the other nineteen instruments.
           The failure is a ROW, with the reason, not an exception for the
           caller — a quietly absent market is what makes a coverage count a
           lie. */
        rows.push({
          symbol,
          timeframe,
          state: "failed",
          bars: 0,
          kinds: 0,
          trials: 0,
          note: err instanceof Error ? err.message : String(err),
        });
      }

      progress.set({ done: i + 1, total, symbol, timeframe, note: "" });
      if (i + 1 < total) await breathe();
    }

    /* Whatever was gathered is merged, cancelled or not. Throwing away work
       already done because the operator stopped the REST of it would make
       cancel destructive, and a destructive cancel is one nobody presses. */
    const merged = gathered.length > 0 ? opts.base.merge(gathered) : null;

    running.set(false);
    progress.set(IDLE_PROGRESS);

    const ok = rows.filter((r) => r.state === "ok").length;
    const trials = rows.reduce((s, r) => s + r.trials, 0);
    const failed = rows.filter((r) => r.state === "failed").length;
    const short = rows.filter((r) => r.state === "short").length;

    const bits: string[] = [];
    bits.push(
      `${ok} of ${total} ${total === 1 ? "instrument" : "instruments"} replayed, ` +
        `${trials.toLocaleString()} completed ${trials === 1 ? "trial" : "trials"} filed.`,
    );
    if (short > 0) bits.push(`${short} had too little history to say anything.`);
    if (failed > 0) bits.push(`${failed} could not be read at all.`);
    if (merged !== null) bits.push(merged.note);
    if (cancelled) bits.push("Stopped early — what had already been replayed was kept.");

    return {
      rows,
      merged,
      cancelled,
      ms: now() - started,
      note: bits.join(" "),
    };
  })();

  return {
    progress,
    running,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      /* Release the chunk currently waiting on a frame. Without this a cancel
         during a yield would still wait out the frame — or, in a hidden tab,
         the 250 ms fallback timer — before anything happened, and a stop
         button that takes a quarter of a second to answer reads as broken. */
      const stop = cancelPending;
      cancelPending = null;
      if (stop) stop();
    },
    done,
  };
}
