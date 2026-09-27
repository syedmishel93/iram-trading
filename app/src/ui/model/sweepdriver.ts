/**
 * THE SWEEP, WITH NO SCREEN ATTACHED.
 *
 * The run loop lived inside `ui/strategy/autonomous.ts`, which is the Strategy
 * desk's Autonomous tab — so the only way to start a search was to open that
 * desk and press Run. The inspector's recommendation card could do nothing but
 * navigate you there, which is the thing the owner asked to stop doing.
 *
 * Two surfaces, one search. That has to be one OBJECT rather than two callers
 * of the same function: a sweep is twenty to thirty seconds of eighty-five
 * studies, and two of them running at once would compete for the same worker
 * pool, charge the hurdle twice and race each other to `shelf.addAll`. The
 * driver owns `running`, so the second request is refused rather than queued.
 *
 * It lives in `ui/model/` and not in `backtest/` for a layering reason worth
 * stating: it needs `LoadedBars` from `ui/strategy/load.ts`, and `backtest/`
 * must not import from `ui/`. Re-declaring that shape here to dodge the import
 * is exactly the hand-written-stub mistake CLAUDE.md records three defects for,
 * so the module sits where the real type is reachable.
 *
 * WHAT IT DOES NOT DO: decide when to run. The desk runs it on a button; the
 * card runs it on first sight of an unsearched market, with its own guards.
 * Both of those are policy, and policy belongs with the surface that shows it.
 */

import { autoRun } from "../../backtest/autorun";
import { buildField } from "../../backtest/autorun";
import { checkHistory } from "../../backtest/sweepplan";
import { createStudyRunner } from "../../backtest/labrunner";
import { scheduleFrame } from "../../core/frame";
import { signal } from "../../core/signal";
import { hashCosts, hashField, staleness, summarise, sweepKey } from "../../backtest/sweepcache";
import type { SweepCache, SweepSummary } from "../../backtest/sweepcache";
import type { AutoRunDeps, AutoRunReport, RunProgress } from "../../backtest/autorun";
import type { BarView } from "../../chart/series";
import type { Costs } from "../../backtest/engine";
import type { HistoryCheck } from "../../backtest/sweepplan";
import type { LoadHooks, LoadedBars } from "../strategy/load";
import type { ReadSignal } from "../../core/signal";
import type { ShelfStore } from "../../backtest/shelfstore";

export interface SweepDriverDeps {
  /** Survivors are saved here, automatically. */
  readonly shelf?: ShelfStore;
  /** Fetches the study window. `ui/strategy/load.ts` `loadStudyBars`. */
  readonly load: (symbol: string, timeframe: string, hooks: LoadHooks) => Promise<LoadedBars>;
  readonly costs: () => Costs;
  /** Risk per trade as a FRACTION, not a percentage. */
  readonly riskPerTrade: () => number;
  /** Rules the operator retired on this market, which must not re-enter. */
  readonly excludedFor: (symbol: string, timeframe: string) => readonly string[];
  readonly maxHybrids?: number;
  readonly now?: () => number;
  /**
   * Injectable for tests ONLY. Real callers get `createStudyRunner`, which
   * prefers the gateway's worker pool and falls back to this tab.
   */
  readonly makeRunner?: (bars: readonly BarView[], signal: AbortSignal) => AutoRunDeps["runStudies"];
  /**
   * What earlier searches found, so one is not repeated for an answer that has
   * not changed — see `backtest/sweepcache.ts`. Optional: without it every
   * request studies the field, which is correct, just slower.
   */
  readonly cache?: SweepCache;
}

/** Which market a report is about. A report with no subject is unreadable. */
export interface SweepSubject {
  readonly symbol: string;
  readonly timeframe: string;
}

export interface SweepDriver {
  /** Refused, not queued, while one is already running. */
  run(symbol: string, timeframe: string): Promise<void>;
  cancel(): void;
  readonly running: ReadSignal<boolean>;
  readonly progress: ReadSignal<RunProgress | null>;
  readonly report: ReadSignal<AutoRunReport | null>;
  /** The market the current report describes. */
  readonly subject: ReadSignal<SweepSubject | null>;
  /** Why the sweep did not run AT ALL. Distinct from "ran and found nothing". */
  readonly blocked: ReadSignal<string>;
  readonly note: ReadSignal<string>;
  readonly loaded: ReadSignal<LoadedBars | null>;
  readonly history: ReadSignal<HistoryCheck | null>;
  readonly elapsed: ReadSignal<number>;
  readonly cancelled: ReadSignal<boolean>;
  readonly savedCount: ReadSignal<number | null>;
  /** Entrant id -> the rule's name, for the run in flight. */
  readonly nameById: ReadSignal<ReadonlyMap<string, string>>;
  /**
   * A remembered search for this market, when there is one and it is still
   * current. Null means nothing is known — never "nothing was found".
   */
  readonly remembered: ReadSignal<SweepSummary | null>;
  /** Look one up without running anything, for a card deciding whether to. */
  recall(symbol: string, timeframe: string, lastBar: number): SweepSummary | null;
}

export function createSweepDriver(deps: SweepDriverDeps): SweepDriver {
  const now = deps.now ?? Date.now;

  const running = signal(false);
  const progress = signal<RunProgress | null>(null);
  const report = signal<AutoRunReport | null>(null);
  const subject = signal<SweepSubject | null>(null);
  const blocked = signal("");
  const note = signal("");
  const loaded = signal<LoadedBars | null>(null);
  const history = signal<HistoryCheck | null>(null);
  const elapsed = signal(0);
  const cancelled = signal(false);
  const savedCount = signal<number | null>(null);
  const nameById = signal<ReadonlyMap<string, string>>(new Map());
  const remembered = signal<SweepSummary | null>(null);

  let controller: AbortController | null = null;

  /**
   * The field's identity WITHOUT loading any bars.
   *
   * `recall` has to answer before a download, or the saving is spent waiting
   * for the thing it was meant to avoid. `buildField` is pure and cheap, so
   * the key can be computed up front.
   */
  const keyFor = (symbol: string, timeframe: string): string => {
    const exclude = deps.excludedFor(symbol, timeframe);
    const built = buildField({
      ...(deps.maxHybrids === undefined ? {} : { maxHybrids: deps.maxHybrids }),
      ...(exclude.length === 0 ? {} : { exclude }),
    });
    return sweepKey(symbol, timeframe, hashField(built.entrants), hashCosts(deps.costs()));
  };

  function recall(symbol: string, timeframe: string, lastBar: number): SweepSummary | null {
    const prev = deps.cache?.get(keyFor(symbol, timeframe));
    if (!prev) return null;
    /* A remembered search that the market has moved past is not an answer. */
    return staleness(prev, lastBar).stale ? null : prev;
  }

  async function run(symbol: string, timeframe: string): Promise<void> {
    if (running.peek()) return;
    running.set(true);
    report.set(null);
    /*
     * THE SUBJECT IS SET AT THE START, not when the report lands.
     *
     * It answers "which market is this run about", and that is known the moment
     * the run begins. Setting it at the end made a sweep IN FLIGHT
     * indistinguishable from no sweep at all for any reader asking "is this
     * mine?" — the recommendation card then drew its idle state, offering a
     * Search button for a search already running, while `running` quietly
     * refused every press.
     */
    subject.set({ symbol, timeframe });
    blocked.set("");
    remembered.set(null);
    progress.set(null);
    cancelled.set(false);
    savedCount.set(null);
    history.set(null);
    note.set("Loading your stored bars…");

    const costs = deps.costs();
    const risk = deps.riskPerTrade();
    const local = new AbortController();
    controller = local;

    try {
      const got = await deps.load(symbol, timeframe, { progress: (t) => note.set(t) });
      loaded.set(got);
      note.set(got.note);

      const exclude = deps.excludedFor(symbol, timeframe);
      const built = buildField({
        ...(deps.maxHybrids === undefined ? {} : { maxHybrids: deps.maxHybrids }),
        ...(exclude.length === 0 ? {} : { exclude }),
      });
      nameById.set(new Map(built.entrants.map((e) => [e.spec.id, e.spec.name])));

      const check = checkHistory(built.entrants, got.bars.length);
      history.set(check);
      if (!check.ok) {
        blocked.set(check.why);
        return;
      }

      /* Yield so "Searching…" paints before the first study blocks the thread.
         Through `scheduleFrame`: a bare rAF never fires in a background tab,
         and this terminal usually is one. */
      await new Promise((r) => scheduleFrame(() => scheduleFrame(() => r(null))));

      const studyOpts = { costs, riskPerTrade: risk, coverage: got.coverage, containsDemo: got.demo };
      const runStudies = deps.makeRunner
        ? deps.makeRunner(got.bars, local.signal)
        : createStudyRunner({ bars: got.bars, opts: studyOpts, signal: local.signal });

      const started = now();
      const result = await autoRun(
        {
          symbol,
          timeframe,
          bars: got.bars.length,
          costs,
          ...(deps.maxHybrids === undefined ? {} : { maxHybrids: deps.maxHybrids }),
          ...(exclude.length === 0 ? {} : { exclude }),
          onProgress: (p) => progress.set(p),
        },
        { runStudies, now },
      );
      elapsed.set(now() - started);
      cancelled.set(local.signal.aborted);
      report.set(result);

      /*
       * Remember it — but never a CANCELLED run. A sweep abandoned halfway
       * reports the rules it managed, and caching that would freeze a partial
       * answer in place and suppress the re-run that would complete it.
       */
      if (deps.cache && !local.signal.aborted) {
        const newest = got.bars[got.bars.length - 1];
        const summary = summarise(result, {
          key: keyFor(symbol, timeframe),
          bars: got.bars.length,
          lastBar: newest ? newest.t : 0,
          at: now(),
        });
        deps.cache.put(summary);
        remembered.set(summary);
      }

      /* Automatic, and stated on screen. A survivor the operator has to
         remember to save is a survivor that is lost. */
      if (deps.shelf && result.keep.length > 0) savedCount.set(deps.shelf.addAll(result.keep));
      else savedCount.set(0);
    } finally {
      running.set(false);
      controller = null;
    }
  }

  function cancel(): void {
    controller?.abort();
    note.set("Cancelling — the studies already running are being abandoned…");
  }

  return {
    run,
    cancel,
    running,
    progress,
    report,
    subject,
    blocked,
    note,
    loaded,
    history,
    elapsed,
    cancelled,
    savedCount,
    nameById,
    remembered,
    recall,
  };
}
