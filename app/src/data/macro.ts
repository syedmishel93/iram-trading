/**
 * The macro lane — one decision across both markets.
 *
 * WHY THIS EXISTS
 * "BTC depends on gold and the dollar" is a real observation and it is also
 * the single easiest place in this terminal to build something confidently
 * wrong. Both halves of that need saying.
 *
 * The real half: crypto, metals and equities are not independent bets. A long
 * BTC position taken while the dollar is breaking out is a different trade
 * from the same position taken while it is breaking down, and nothing in this
 * terminal has ever said so. `data/correlation.ts` has been able to measure it
 * for versions — Pearson on log returns, joined on TIMESTAMP rather than array
 * position, with the overlap reported — and nothing ever asked it about
 * anything outside the watchlist.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HALF THAT MUST NOT BE GOT WRONG
 *
 * BTC's relationship to the dollar and to gold is UNSTABLE. It has run
 * strongly negative to DXY, near zero, and positive, in stretches of months.
 * Any version of this feature that encodes "BTC falls when DXY rises" will be
 * confidently wrong for a quarter at a time, and it will be wrong in the most
 * damaging way available: it will agree with you right up until the regime
 * turns.
 *
 * So nothing here is hard-coded. There is no table of expected relationships
 * and no sign anybody typed in. Every statement is the CURRENTLY MEASURED
 * coefficient with its sample size attached, and it falls silent on its own
 * when the measurement is weak — which is what `correlate` already does by
 * returning NaN below thirty overlapping bars rather than a number.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THESE FOUR
 *
 * DXY, gold, US 10-year yields and the S&P are the four series that the rest
 * of the market is quoted against, and between them they span the two axes
 * that matter: the price of money, and the appetite for risk. Adding a fifth
 * is a decision about relevance; adding twenty is a correlation matrix, which
 * the Risk desk already has and which answers a different question.
 */

import { correlate, MIN_OVERLAP, type ClosesSeries } from "./correlation";
import type { BarView } from "../chart/series";
import type { Evidence } from "../core/evidence";

export interface MacroSeries {
  readonly id: string;
  readonly symbol: string;
  readonly label: string;
  /** What a RISE in this series means, in plain language. Never a direction. */
  readonly meaning: string;
}

/**
 * The lane.
 *
 * `meaning` describes what the series IS, not what it implies for anything
 * else. "The dollar is stronger" is a fact; "so crypto falls" is the claim
 * this file refuses to make in advance.
 */
export const MACRO_LANE: readonly MacroSeries[] = [
  {
    id: "dxy",
    symbol: "DXY",
    label: "Dollar index",
    meaning: "the dollar is stronger against a basket of major currencies",
  },
  {
    id: "gold",
    symbol: "XAUUSD",
    label: "Gold",
    meaning: "gold is bid, which historically happens for several unrelated reasons at once",
  },
  {
    id: "us10y",
    symbol: "US10Y",
    label: "US 10-year yield",
    meaning: "longer-dated money costs more",
  },
  {
    id: "spx",
    symbol: "SPX500",
    label: "S&P 500",
    meaning: "risk appetite in the largest equity market is rising",
  },
];

export interface MacroRead {
  readonly id: string;
  readonly label: string;
  readonly symbol: string;
  /** −1..+1 over the joined window, or NaN when the overlap was too short. */
  readonly r: number;
  /** Bars present in BOTH series. The number that makes `r` trustworthy. */
  readonly overlap: number;
  /** Percent change of the macro series over the window. */
  readonly changePct: number;
  /** True when `r` is strong enough to be worth a sentence. */
  readonly meaningful: boolean;
}

/**
 * Below this the coefficient exists but is not worth acting on.
 *
 * 0.35 is not a statistical threshold; it is a usefulness one. With a hundred
 * overlapping bars an r of 0.3 is distinguishable from zero and still explains
 * under a tenth of the variance, which is not something to size a position on.
 */
export const MEANINGFUL_R = 0.35;

const toSeries = (symbol: string, bars: readonly BarView[]): ClosesSeries => ({
  symbol,
  closes: bars.map((b) => ({ t: b.t, c: b.c })),
});

/**
 * Measure the current instrument against each macro series.
 *
 * A series the feed could not supply is simply absent from the result rather
 * than present with a zero — the difference between "uncorrelated" and "not
 * loaded" is exactly the sort of thing that must never be blurred.
 */
export function readMacro(
  symbol: string,
  bars: readonly BarView[],
  lane: ReadonlyMap<string, readonly BarView[]>,
): MacroRead[] {
  if (bars.length < MIN_OVERLAP) return [];
  const subject = toSeries(symbol, bars);
  const out: MacroRead[] = [];

  for (const entry of MACRO_LANE) {
    const other = lane.get(entry.symbol);
    if (other === undefined || other.length === 0) continue;

    const pair = correlate(subject, toSeries(entry.symbol, other));
    const first = (other[0] as BarView).c;
    const last = (other[other.length - 1] as BarView).c;
    const changePct = first > 0 ? ((last - first) / first) * 100 : 0;

    out.push({
      id: entry.id,
      label: entry.label,
      symbol: entry.symbol,
      r: pair.r,
      overlap: pair.overlap,
      meaningful: Number.isFinite(pair.r) && Math.abs(pair.r) >= MEANINGFUL_R,
      changePct,
    });
  }

  /* Strongest relationship first, by absolute value: a −0.7 is exactly as
     informative as a +0.7 and burying it under a +0.4 would be sorting by
     sign rather than by strength. */
  return out.sort((a, b) => (Math.abs(b.r) || 0) - (Math.abs(a.r) || 0));
}

/**
 * Turn the measurement into evidence the decision layer can weigh.
 *
 * THE DIRECTION IS DERIVED, NEVER ASSUMED. The lean is the measured
 * correlation multiplied by the macro series' own recent move — so if DXY has
 * risen and the measured correlation to it is −0.6, the lean is short; and if
 * that same correlation flips positive next quarter, the lean flips with it
 * without anybody editing this file. That is the entire design.
 *
 * Weight scales with |r| so a weak relationship contributes weakly rather than
 * equally, and nothing below `MEANINGFUL_R` produces evidence at all.
 */
export function macroEvidence(reads: readonly MacroRead[], asOf: number): Evidence[] {
  const out: Evidence[] = [];

  for (const m of reads) {
    if (!m.meaningful) continue;
    /* A macro series that has not moved says nothing, whatever the
       correlation is. Correlation is a relationship, not a signal; the move is
       what makes it actionable. */
    if (Math.abs(m.changePct) < 0.5) continue;

    const lean = Math.max(-1, Math.min(1, m.r * Math.sign(m.changePct)));
    const dir = m.changePct > 0 ? "up" : "down";

    out.push({
      id: `macro-${m.id}`,
      group: "correlation",
      label: m.label,
      lean,
      /* Never the top weight. This is context: it is a real input and it is
         not the reason to take a trade, and a weighting that let it outrank
         structure would make it one. */
      weight: Math.min(0.5, Math.abs(m.r) * 0.6),
      reason:
        `${m.label} is ${dir} ${Math.abs(m.changePct).toFixed(1)}% over this window, and this instrument ` +
        `has run at ${m.r >= 0 ? "+" : ""}${m.r.toFixed(2)} to it across ${m.overlap} shared bars. ` +
        `That is the CURRENTLY measured relationship, not a rule — it has been the other sign before.`,
      source: `${m.symbol} · measured`,
      asOf,
      state: "fresh",
      flip: `The correlation falling below ${MEANINGFUL_R}, or changing sign — both of which happen.`,
    });
  }
  return out;
}

/**
 * The line the Decision desk prints above the lane.
 *
 * Says what was measured and what it does not mean, in that order. The second
 * half is not a disclaimer bolted on; it is the finding — a relationship that
 * has been the other sign before is a different kind of fact from one that has
 * not, and the reader has no way to know which they are looking at unless the
 * tool says.
 */
export function macroLine(reads: readonly MacroRead[]): string {
  if (reads.length === 0) {
    return "No macro series loaded. Nothing is being inferred from the dollar, gold or rates.";
  }
  const useful = reads.filter((m) => m.meaningful);
  if (useful.length === 0) {
    const best = reads[0] as MacroRead;
    return Number.isFinite(best.r)
      ? `Nothing in the macro lane is running above ${MEANINGFUL_R} against this instrument right now — the strongest is ${best.label} at ${best.r.toFixed(2)} over ${best.overlap} bars. It is trading on its own.`
      : `Not enough overlapping history to measure anything against the macro lane. ${MIN_OVERLAP} shared bars is the floor.`;
  }
  const parts = useful.map(
    (m) => `${m.label} ${m.r >= 0 ? "+" : ""}${m.r.toFixed(2)} (${m.overlap} bars)`,
  );
  return `Measured over the loaded window: ${parts.join(", ")}. These are current readings, not rules — every one of them has been a different number, and some a different sign, within the last year.`;
}
