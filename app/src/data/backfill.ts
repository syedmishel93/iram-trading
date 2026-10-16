/**
 * Fetching older bars when the operator pans back to the edge of what is loaded.
 *
 * WHY IT LEFT `shell.ts`
 * It was ninety lines of async control flow inside a 7,400-line function — four
 * guards, a re-entrancy latch and a per-instrument exhaustion set — and it was
 * the only part of the auto-backfill feature with no test, because nothing in
 * `mountShell` can be constructed in one. Every guard here exists because
 * removing it produces a specific, reproducible failure, and that is exactly
 * the kind of code that should not be reachable only through a canvas.
 *
 * FOUR GUARDS, FOUR DIFFERENT FAILURES
 *
 *  1. `busy` — the chart's edge callback fires on EVERY pan frame. Without a
 *     re-entrancy latch a single drag launches thirty overlapping fetches of
 *     the same window.
 *  2. `exhausted` — a vendor that has given everything it has answers a request
 *     for more with the same bars. Retrying that on every subsequent pan is an
 *     unbounded loop against a rate limit, so the first empty answer stops this
 *     symbol and timeframe asking again.
 *  3. the key check — symbol or timeframe can change while a fetch is in
 *     flight. Bars for a chart nobody is looking at must not be applied to the
 *     one they are.
 *  4. `maxBars` — a ceiling. "Scroll back for ever" is a promise about the
 *     interaction, not an invitation to hold a decade of one-minute bars in a
 *     tab.
 *
 * WHAT IT DOES NOT DO
 * It does not move the view. `chart/anchor.ts` re-anchors on the leftmost
 * visible TIMESTAMP when the bars land, so the candles you were reading stay
 * under the cursor and the new ones appear to their left. A backfill that
 * scrolled the chart would be worse than one that never ran.
 */

export interface BackfillDeps {
  /** Symbol the feed currently holds, not the one the UI is showing. */
  loadedSymbol(): string;
  loadedTimeframe(): string;
  /** How many bars are loaded now. */
  barCount(): number;
  /** Oldest loaded bar's timestamp, for the "no history before" message. */
  oldestBarTime(): number | null;
  /** True while the replay firewall is on — see `core/replay.ts`. */
  replayActive(): boolean;
  /** Reach further back in the archive, paging the vendor as needed. */
  backfill(symbol: string, timeframe: string, target: number): Promise<unknown>;
  /** Re-read from the archive into the feed. */
  reload(symbol: string, timeframe: string, limit: number): Promise<unknown>;
  /** Record what happened, for the feed log. */
  note(entry: { ok: boolean; symbol: string; timeframe: string; text: string }): void;
  /** Drives the left-edge indicator. */
  setPending(on: boolean): void;
  /** Bars added per request. */
  step?: number;
  /** Hard ceiling on what one chart will hold. */
  maxBars?: number;
}

export interface Backfiller {
  /**
   * Ask for older bars. Safe to call on every pan frame: it returns
   * immediately when a fetch is in flight, when this instrument has already
   * run out, or when the ceiling is reached.
   */
  loadOlder(): Promise<void>;
  /** Let this instrument ask again — call when the operator returns to it. */
  reset(symbol: string, timeframe: string): void;
  /** For tests and diagnostics. */
  isExhausted(symbol: string, timeframe: string): boolean;
}

export const HISTORY_STEP = 800;
export const HISTORY_MAX = 20_000;

export function createBackfiller(d: BackfillDeps): Backfiller {
  const step = d.step ?? HISTORY_STEP;
  const ceiling = d.maxBars ?? HISTORY_MAX;
  const exhausted = new Set<string>();
  let busy = false;

  const keyOf = (symbol: string, timeframe: string): string => `${symbol}|${timeframe}`;

  return {
    isExhausted: (symbol, timeframe) => exhausted.has(keyOf(symbol, timeframe)),
    reset(symbol, timeframe) {
      exhausted.delete(keyOf(symbol, timeframe));
    },

    async loadOlder() {
      if (busy) return;

      const symbol = d.loadedSymbol();
      const timeframe = d.loadedTimeframe();
      if (!symbol || !timeframe) return;

      const key = keyOf(symbol, timeframe);
      if (exhausted.has(key)) return;

      const have = d.barCount();
      if (have === 0 || have >= ceiling) return;
      /* Replay hands out a deliberately shortened array; asking for more
         history inside it would be asking to see past the cursor. */
      if (d.replayActive()) return;

      busy = true;
      d.setPending(true);
      const want = Math.min(ceiling, have + step);
      try {
        await d.backfill(symbol, timeframe, want);

        /* The instrument may have changed while that was in flight. Applying
           these bars now would put one symbol's history on another's chart. */
        if (d.loadedSymbol() !== symbol || d.loadedTimeframe() !== timeframe) return;

        const before = d.barCount();
        await d.reload(symbol, timeframe, want);
        const after = d.barCount();

        if (after <= before) {
          /* Nothing came back. Either the vendor has no more or it refused;
             both mean stop asking, and both are worth saying rather than
             leaving the operator to pan into the same wall repeatedly. */
          exhausted.add(key);
          const oldest = d.oldestBarTime();
          const when = oldest === null ? "that point" : new Date(oldest).toISOString().slice(0, 10);
          d.note({ ok: true, symbol, timeframe, text: `no history before ${when} from this source` });
        }
      } catch (err) {
        // A refused or rate-limited vendor. Do not retry on the next pan frame.
        exhausted.add(key);
        d.note({
          ok: false,
          symbol,
          timeframe,
          text: `could not reach further back: ${String(err)}`,
        });
      } finally {
        busy = false;
        d.setPending(false);
      }
    },
  };
}
