/**
 * The Risk desk, the trade calculator, and the archive read they share.
 *
 * TWO SIBLING DEPENDENCIES after the foundation: the chart's bars and the
 * computed indicator read. Everything else it touches — `state`, `account`,
 * `kv`, `feed`, `lazyDesk` — is foundation.
 *
 * `loadArchiveCloses` is returned rather than kept private because the
 * correlation panel and the screener both want the same archive read, and two
 * readers of one function is the reason it is a function.
 *
 * DEPS ARE TYPED FROM THE SOURCE, not by hand. The first draft declared
 * `studies` as `readonly string[]` and the compiler rejected it immediately: it
 * is a `computed` returning `{ rsi, atr, atrPct, stamp }`. Retyping a
 * dependency to something convenient is how two files come to disagree — the
 * same mistake the settings stub and the fundamentals stub both made.
 */

import { h } from "../dom";
import { type ClosesSeries } from "../../data/correlation";
import { type SeriesInventory } from "../../store/barstore";
import { createCalculator } from "../calculator";
import { createRisk } from "../risk";
import { signal, type ReadSignal } from "../../core/signal";
import type { Studies } from "../model/studies";
import type { Position } from "../../risk/sizing";
import type { BarView } from "../../chart/series";
import type { ShellContext } from "./context";

export interface RiskSectionDeps {
  /** The chart's bars, replay-aware. Owned by the chrome section. */
  readonly bars: ReadSignal<readonly BarView[]>;
  /** RSI/ATR over those bars, already computed once for every reader. */
  readonly studies: ReadSignal<Studies>;
}

export function createRiskSection(ctx: ShellContext, d: RiskSectionDeps) {
  const { state, account, kv, feed, lazyDesk } = ctx;
  const { bars, studies } = d;


  /**
   * Closing history for the portfolio analytics, out of the LOCAL ARCHIVE.
   *
   * Three decisions here, each of which the panel above depends on:
   *
   * 1. IT NEVER FETCHES. A symbol with no stored bars comes back missing, and
   *    the portfolio module then names it and says it is excluded. The
   *    alternative — quietly going to the network for every symbol in a book —
   *    turns opening a panel into a request storm across ten venues, and the
   *    governor would rightly start parking hosts over it.
   *
   * 2. IT PREFERS THE LONGEST SERIES, NOT A NOMINATED SOURCE. Bars for one
   *    symbol may be stored under `binance`, `mt5` and `proxy` from different
   *    sessions, on different timeframes. The covariance wants the most
   *    observations it can get, and which venue supplied them does not change
   *    what the price did.
   *
   * 3. IT DOES NOT ALIGN ANYTHING. Series with mismatched timeframes are
   *    returned as they are, and `alignSeries` intersects on timestamps — so a
   *    daily series and an hourly one simply share very few bars and the panel
   *    reports a short sample rather than a wrong one. Resampling here would
   *    manufacture the overlap that the honest answer refuses to invent.
   */
  /**
   * Average daily traded value per symbol, filled in as a side effect of
   * reading the archive.
   *
   * A side effect and not a second pass because the bars are already in hand
   * and re-reading IndexedDB to compute a median would double the cost of
   * opening the panel for a number derived from the same rows.
   */
  const archiveAdv = new Map<string, number>();

  const loadArchiveCloses = async (symbols: readonly string[]): Promise<ClosesSeries[]> => {
    const wanted = new Set(symbols.map((x) => x.toUpperCase()));
    const adv = archiveAdv;
    adv.clear();
    const inventory = await feed.archive.inventory();

    /* One entry per symbol: whichever stored series holds the most bars. */
    const best = new Map<string, SeriesInventory>();
    for (const inv of inventory) {
      const sym = inv.symbol.toUpperCase();
      if (!wanted.has(sym)) continue;
      const held = best.get(sym);
      if (!held || inv.bars > held.bars) best.set(sym, inv);
    }

    const out: ClosesSeries[] = [];
    for (const [sym, inv] of best) {
      const read = await feed.archive.read(
        { source: inv.source, symbol: inv.symbol, timeframe: inv.timeframe },
        { from: inv.oldest, to: inv.newest },
        /* Interval inferred from what is stored, so a series whose timeframe
           label and real spacing disagree still reads correctly. */
        Math.max(1, Math.round((inv.newest - inv.oldest) / Math.max(1, inv.bars - 1))),
      );
      if (read.bars.length === 0) continue;
      out.push({ symbol: sym, closes: read.bars.map((b) => ({ t: b.t, c: b.c })) });

      /**
       * Average daily traded VALUE, for the time-to-exit read.
       *
       * Three decisions worth stating:
       *
       * 1. VALUE, not share count. A million units of a $0.02 token and a
       *    million units of BTC are not comparable liquidity, and the position
       *    it is divided into is denominated in money.
       *
       * 2. MEDIAN of the last 30 bars, not the mean of all of them. One
       *    liquidation candle can carry ten times a normal bar volume, and a
       *    mean that includes it reports a market you could exit into on the
       *    strength of a day that will not repeat.
       *
       * 3. SCALED TO A DAY from the measured bar spacing, so a 5m series and a
       *    daily series give the same answer for the same instrument. Reading
       *    a 5m bar volume as a daily one would overstate liquidity by nearly
       *    three hundred times — which is the sort of error that turns a
       *    two-week exit into "under a day".
       */
      const tail = read.bars.slice(-30).filter((b) => Number.isFinite(b.v) && b.v > 0);
      if (tail.length >= 5) {
        const values = tail.map((b) => b.c * b.v).sort((x, y) => x - y);
        const mid = values.length >> 1;
        const medianBarValue =
          values.length % 2 === 1
            ? (values[mid] as number)
            : ((values[mid - 1] as number) + (values[mid] as number)) / 2;
        const spacingMs = Math.max(1, Math.round((inv.newest - inv.oldest) / Math.max(1, inv.bars - 1)));
        const barsPerDay = 86_400_000 / spacingMs;
        adv.set(sym, medianBarValue * barsPerDay);
      }
    }
    return out;
  };

  /* The hole the broker panel goes in. Created here so the desk can place it
     in its own layout, filled by the shell once the broker model exists —
     see `bookSlot` in `ui/risk.ts` for why it is a slot and not a parameter. */
  const bookSlot = h("div", { class: "risk-book-slot" });

  /* Filled by the shell once the broker model exists. See `counted` in
     `ui/risk.ts` for why this is a signal and not a function. */
  const countedSource = signal<readonly Position[] | null>(null);

  const riskDesk = createRisk({
    bookSlot,
    counted: countedSource,
    kv,
    account,
    symbol: state.symbol,
    lastPrice: () => {
      const list = bars.peek();
      const last = list[list.length - 1];
      return last ? last.c : 0;
    },
    atr: () => studies.peek().atr,
    loadCloses: loadArchiveCloses,
    /* Read AFTER loadCloses has run — it fills this as it walks the bars. */
    advBySymbol: () => archiveAdv,
    /* The instrument every beta is measured against. BTC is not a market
       factor in any academic sense; it is simply the thing that moves
       everything else in this universe, and naming it plainly beats dressing
       it up as one. */
    factorSymbol: () => "BTCUSDT",
  });

  /* Built here, next to the Risk desk, because the two answer the same question
     in different units: Risk sizes in units against a percent of equity, the
     calculator sizes in LOTS against pips and margin. Both read the same last
     price off the chart. */
  const calculator = lazyDesk(() => createCalculator({
    kv,
    account,
    symbol: state.symbol,
    lastPrice: () => {
      const list = bars.peek();
      const last = list[list.length - 1];
      return last ? last.c : 0;
    },
  }));

  return { riskDesk, calculator, loadArchiveCloses, bookSlot, countedSource };
}
