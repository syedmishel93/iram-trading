/**
 * Replaying setups over deep history, off the chart's own window.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT THAT MADE THIS NECESSARY
 *
 * `simulate.ts` works. It was starved. The chart loads 800 bars by default,
 * and 800 bars of one instrument simply does not contain many instances of any
 * one pattern. Counted on ETHUSDT 15m, after collapsing same-bar duplicates
 * and excluding the unresolvable tail:
 *
 *     choch          17        double-top       6
 *     bos            14        order-block      6
 *     liquidity-sweep 5        head-shoulders   4
 *     double-bottom   2        trendline        2
 *
 * Only two kinds cleared the twelve-trial floor. Every other setup the card
 * could name reported "too few to characterise" — correct, honest, and almost
 * always useless.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * AND THE MEASUREMENT THAT MADE IT CHEAP
 *
 * The obvious objection is cost: re-running thirteen detectors over thousands
 * of bars sounds like something that needs a worker and a progress bar. It was
 * timed before it was designed, which is the only reason this module is as
 * simple as it is:
 *
 *     n=800    detect 21ms   replay 3ms    trials 1
 *     n=2,000  detect  9ms   replay 1ms    trials 3
 *     n=5,000  detect 11ms   replay 1ms    trials 11
 *     n=10,000 detect 13ms   replay 1ms    trials 20
 *
 * A full pass over ten thousand bars costs thirteen milliseconds, and the
 * detectors are close to flat in the length because the expensive part is
 * pivot-finding, which is linear and small. The trial count, meanwhile, scales
 * straight with the history. There was never a compute problem — only a
 * bar-count one — so this runs inline on a memoised path with no worker.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT DOES NOT BACKFILL BY ITSELF
 *
 * `history.backfill` reaches further back by paging a vendor, and doing that
 * automatically on every symbol change would fire dozens of requests at a
 * proxy the operator is often running on their own machine, for a panel they
 * may not be looking at. So the default pass reads what the ARCHIVE already
 * holds — which after a few sessions is frequently much more than 800 bars —
 * and reaching further is an explicit request that says how far it got.
 *
 * The degradation is honest either way: the card reports the sample it had,
 * and `deepen()` is offered rather than assumed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT PRODUCES, AND WHY IT IS EVERY KIND AND NOT JUST THE CHOSEN ONE
 *
 * One pass yields a base rate for EVERY setup kind on the chart, not only the
 * one the engine picked. That is what makes an honest recommendation possible:
 * the engine ranks by structure, and this says what each of those structures
 * has historically been worth, so the two can be shown side by side and
 * disagree in public. A recommendation that cannot disagree with its own
 * evidence is a slogan.
 */

import type { BarView } from "../chart/series";
import type { Detection, DetectInput } from "../detect/types";
import { CONTEXT_KINDS, runDetectors, toDetectInput, type DetectorId } from "../detect/index";
import type { HistoryService } from "../data/history";
import { signal, type ReadSignal } from "../core/signal";
import { HORIZON_BARS } from "../learn/claim";
import { simulateKind, type Simulation } from "./simulate";

/**
 * How far back a deep pass tries to read.
 *
 * Six thousand bars is about ten weeks of 15-minute data and twenty years of
 * daily — deliberately generous at the fast end, where instances are what the
 * sample is short of, and irrelevant at the slow end, where the archive will
 * never hold that much anyway.
 */
export const DEEP_TARGET_BARS = 6000;

/** Kinds that are context rather than setups. One definition, in detect/index.ts. */
/* One definition, in detect/index.ts, because two lists that must agree
   and are edited separately is how this repository breaks. */
const CONTEXT_ONLY = CONTEXT_KINDS;

/** A base rate keyed by what it describes. */
export interface DeepReplay {
  readonly symbol: string;
  readonly timeframe: string;
  /** Bars actually replayed over. The number that licenses everything below. */
  readonly bars: number;
  /** The reward-to-risk every trial was priced at. */
  readonly rMultiple: number;
  /** `${kind}|${direction}` → what happened. */
  readonly sims: ReadonlyMap<string, Simulation>;
  /** Whether this came from the archive alone or after reaching further back. */
  readonly deepened: boolean;
  /** One sentence about the pass itself, safe to render. */
  readonly note: string;
}

export interface DeepReplayOptions {
  readonly history: HistoryService;
  /** Which detectors to run. Read at call time so a settings change is seen. */
  readonly detectors: () => readonly DetectorId[];
  /** The operator's own minimum stop, in ATR. Applied as the trial floor. */
  readonly minStopAtr: () => number;
  readonly targetBars?: number;
}

export interface DeepReplayHandle {
  readonly result: ReadSignal<DeepReplay | null>;
  readonly busy: ReadSignal<boolean>;
  /** Progress while reaching further back. Empty when idle. */
  readonly progress: ReadSignal<string>;
  /**
   * Replay `symbol`/`timeframe` at `rMultiple` from what is already held.
   *
   * Memoised: repeat calls with the same key resolve to the same pass rather
   * than re-running it, because `refreshDecision` runs on ticks and this is
   * the expensive end of the panel.
   */
  request(symbol: string, timeframe: string, rMultiple: number): void;
  /** Reach further back, then replay again. Explicit — see the header. */
  deepen(symbol: string, timeframe: string, rMultiple: number): Promise<void>;
  /** Look one setup up in the current pass. Null when it is not for this chart. */
  lookup(symbol: string, timeframe: string, kind: string, direction: "long" | "short"): Simulation | null;
  stop(): void;
}

/**
 * What identifies a pass.
 *
 * Deliberately does NOT include whether the pass reached further back. It did
 * once, and the result was that `deepen()` finished, wrote a 1,806-bar sample,
 * and was then immediately overwritten by the next tick's ordinary `request()`
 * — a different key, so it re-ran, shallow, and threw the deep pass away. The
 * operator saw a correct-looking bar count only because backfill had persisted
 * those bars into the archive, so the replacement pass happened to reload the
 * same ones. On a chart where the vendor served the extra history without the
 * archive keeping it, the sample would have silently halved.
 *
 * With depth out of the key, a deepened chart simply IS the current pass, and
 * `request` recognises it as already done.
 */
const keyOf = (symbol: string, timeframe: string, r: number): string =>
  `${symbol}|${timeframe}|${r.toFixed(2)}`;

/**
 * Replay every setup kind present in `data`.
 *
 * Exported for tests, which is the only way to check the thing that matters
 * about it: that a kind with no completed instance still appears in the map,
 * carrying its refusal, rather than being silently absent. An absent key and a
 * key holding "no history" read identically at a call site using `?.`, and
 * only one of them is a fact about the market.
 */
export function replayAll(
  detections: readonly Detection[],
  data: DetectInput,
  len: number,
  rMultiple: number,
  minStopAtr: number,
): Map<string, Simulation> {
  const out = new Map<string, Simulation>();
  const seen = new Set<string>();
  for (const d of detections) {
    if (d.direction === "neutral") continue;
    if (CONTEXT_ONLY.has(d.kind)) continue;
    seen.add(`${d.kind}|${d.direction}`);
  }
  for (const k of seen) {
    const [kind, direction] = k.split("|") as [string, "long" | "short"];
    out.set(
      k,
      simulateKind(kind, direction, detections, data, len, {
        rMultiple,
        horizonBars: HORIZON_BARS,
        atrStopMultiple: minStopAtr,
        minAtrMultiple: minStopAtr,
      }),
    );
  }
  return out;
}

export function createDeepReplay(opts: DeepReplayOptions): DeepReplayHandle {
  const result = signal<DeepReplay | null>(null);
  const busy = signal(false);
  const progress = signal("");
  const target = opts.targetBars ?? DEEP_TARGET_BARS;

  /* The key of the pass currently held or in flight. Guards against the tick
     storm: `refreshDecision` can ask for the same pass many times a second. */
  let currentKey = "";
  let stopped = false;

  const run = async (symbol: string, timeframe: string, rMultiple: number, deep: boolean): Promise<void> => {
    const key = keyOf(symbol, timeframe, rMultiple);
    if (stopped || key === currentKey) return;
    currentKey = key;
    busy.set(true);
    try {
      if (deep) {
        progress.set("reaching further back…");
        try {
          await opts.history.backfill(symbol, timeframe, target, {
            onProgress: (added, want) => progress.set(`backfilled ${added} of ${want}…`),
          });
        } catch {
          /* A vendor limit or a dead proxy. Replay what is held and say so
             rather than refusing — a shorter sample honestly labelled beats no
             sample at all. */
          progress.set("could not reach further back — replaying what is held");
        }
      }

      const res = await opts.history.load(symbol, timeframe, { limit: target });
      if (stopped || currentKey !== key) return;

      const bars: readonly BarView[] = res.bars;
      /* The forming bar is excluded for the same reason detection excludes it:
         its "close" is the current price, not a close. */
      const len = Math.max(0, bars.length - 1);
      if (len < 60) {
        result.set({
          symbol,
          timeframe,
          bars: len,
          rMultiple,
          sims: new Map(),
          deepened: deep,
          note: `Only ${len} closed bars are held for ${symbol} ${timeframe} — too short to replay anything.`,
        });
        return;
      }

      const data = toDetectInput(bars.slice(0, len));
      const dets = runDetectors(data, opts.detectors());
      const sims = replayAll(dets, data, len, rMultiple, opts.minStopAtr());

      const usable = [...sims.values()].filter((s) => s.enough).length;
      result.set({
        symbol,
        timeframe,
        bars: len,
        rMultiple,
        sims,
        deepened: deep,
        note:
          usable === 0
            ? `Replayed ${len.toLocaleString()} bars; no setup kind has enough completed instances yet to characterise.`
            : `Replayed ${len.toLocaleString()} bars — ${usable} setup ${usable === 1 ? "kind has" : "kinds have"} enough history to characterise.`,
      });
    } finally {
      if (!stopped) {
        busy.set(false);
        progress.set("");
      }
    }
  };

  return {
    result,
    busy,
    progress,
    request(symbol, timeframe, rMultiple) {
      void run(symbol, timeframe, rMultiple, false);
    },
    async deepen(symbol, timeframe, rMultiple) {
      /* Force the pass even when a shallow one for this chart is already held.
         Afterwards the key matches, so the tick-rate `request` sees the chart
         as done and leaves the deeper sample alone. */
      currentKey = "";
      await run(symbol, timeframe, rMultiple, true);
    },
    lookup(symbol, timeframe, kind, direction) {
      const r = result();
      if (r === null || r.symbol !== symbol || r.timeframe !== timeframe) return null;
      return r.sims.get(`${kind}|${direction}`) ?? null;
    },
    stop() {
      stopped = true;
    },
  };
}
