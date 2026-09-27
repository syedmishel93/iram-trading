/**
 * The Strategy desk's history: fetched, backfilled, and measured for coverage.
 *
 * Lifted out of the family lab's `run()` when the desk grew a second tester —
 * the rule-set backtest in the "built together" flow — because the two must
 * read the SAME bars the SAME way. A rule tested on one window and a family
 * swept on another are two verdicts about different pasts, and nothing on
 * screen would say so.
 *
 * Behaviour is the lab's, unchanged:
 *  - ask the archive for `want` bars; short of that, backfill and ask again;
 *  - a failed backfill studies what is held and SAYS so;
 *  - coverage is re-measured with the market's own calendar (`openCoverage`),
 *    because the archive's wall-clock figure scores a complete year of FX at
 *    about 71% and the engine's floor would refuse every FX study;
 *  - a failed archive falls back to the chart's window, labelled as such.
 */

import type { BarView } from "../../chart/series";
import type { HistoryService } from "../../data/history";
import { openCoverage } from "../../data/sessions";

export interface LoadedBars {
  readonly bars: readonly BarView[];
  readonly source: string;
  /** Share of the window's OPEN hours with a bar, 0..1. */
  readonly coverage: number;
  readonly demo: boolean;
  /** What happened on the way, for the status line. "" when nothing notable. */
  readonly note: string;
}

export interface LoadHooks {
  /** Progress text while backfilling. */
  readonly progress?: (text: string) => void;
  /** True while a backfill is in flight. */
  readonly backfilling?: (on: boolean) => void;
}

/** The least the desk will ask for, whatever the depth field says. */
export const MIN_STUDY_BARS = 500;

export async function loadStudyBars(
  history: HistoryService,
  symbol: string,
  timeframe: string,
  depth: number,
  chartWindow: () => readonly BarView[],
  hooks: LoadHooks = {},
): Promise<LoadedBars> {
  const want = Math.max(MIN_STUDY_BARS, Math.round(depth));
  let note = "";
  try {
    let res = await history.load(symbol, timeframe, { limit: want });
    // Short of what the study needs: reach further back rather than refusing
    // on a window the user never chose.
    if (res.bars.length < want) {
      hooks.backfilling?.(true);
      hooks.progress?.(`have ${res.bars.length}, reaching back for ${want}…`);
      try {
        await history.backfill(symbol, timeframe, want, {
          onProgress: (added, target) => hooks.progress?.(`backfilled ${added} of ${target}…`),
        });
        res = await history.load(symbol, timeframe, { limit: want });
      } catch {
        // A dead proxy or a vendor limit. Study what we have and SAY so;
        // silently studying a short window is how a thin result looks solid.
        note = "could not reach further back — studying what is held";
      } finally {
        hooks.backfilling?.(false);
      }
    }
    const bars = res.bars;
    let coverage = 0;
    if (bars.length >= 2) {
      const first = (bars[0] as BarView).t;
      const last = (bars[bars.length - 1] as BarView).t;
      coverage = openCoverage(symbol, { from: first, to: last }, res.gaps);
    }
    return { bars, source: res.source, coverage, demo: res.containsDemo, note };
  } catch (err) {
    // The archive itself failed. Fall back to the chart's window, labelled.
    const bars = chartWindow();
    return {
      bars,
      source: "chart window",
      coverage: 1,
      demo: false,
      note: `history service failed (${String(err)}) — using the ${bars.length} bars on screen`,
    };
  }
}
