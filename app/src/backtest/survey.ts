/**
 * The survey: which rule, and which STYLE, worked in which market condition —
 * across several markets at once.
 *
 * WHAT THIS ANSWERS THAT `lab.ts` DOES NOT
 * `lab.ts` takes one family of rules and one instrument and asks "does this
 * survive out of sample?" That is the right question once you already know what
 * you want to trade. The question before it is the one a trader actually starts
 * with: *the market is chopping — what works in a chop, and does it work
 * everywhere or only here?*
 *
 * Answering it needs three axes at once, and the interesting failures all live
 * in the interactions between them:
 *
 *   RULE      — the twenty-six specs in `specs.ts`, each tagged with a style.
 *   REGIME    — trending, chopping, violent, from `regime.ts`, at ENTRY.
 *   MARKET    — BTC, gold, an index, an FX pair, from `universe.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CENTRAL DISTINCTION: A STYLE FINDING versus ONE MARKET'S CHARACTER
 *
 * This is the whole reason the module exists rather than being a loop over
 * `runStudy`. "Mean reversion made +0.4R in chop" is either
 *
 *   (a) a fact about mean reversion, if gold and the index and EURUSD all agree,
 *       or
 *   (b) a fact about how mean-reverting BTC happened to be in this window,
 *
 * and a pooled number cannot tell you which. Worse, (b) is far more common and
 * looks identical. So the primary evidence here is not the pooled expectancy at
 * all — it is AGREEMENT ACROSS CORRELATION BLOCS, and a cell that is significant
 * on pooled trades but carried by one bloc is reported as `one-market`, by name,
 * rather than as a finding.
 *
 * Pooling R-multiples across instruments is arithmetically sound — `engine.ts`
 * makes R "the only comparable measure across symbols" by construction, since
 * every trade risks the same fraction of equity. What pooling cannot do is tell
 * you whose trades they were, and that is the thing worth knowing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS SURVEY REFUSES MORE OFTEN THAN IT REPORTS
 *
 * Twenty-six rules times three regimes is seventy-eight cells, and ranking
 * seventy-eight cells and describing the top one is a machine for manufacturing
 * findings. `lab.ts` guards its twelve-config sweep with PBO for exactly this
 * reason. A survey is the same hazard an order of magnitude larger, so it carries
 * three defences and all of them are on by default:
 *
 *  1. **A sample floor per cell.** `MIN_CELL_TRADES` per market and
 *     `MIN_CELL_TOTAL` pooled. Below either, the cell is `thin` and is not
 *     tested at all — it never enters the multiplicity correction, because a
 *     cell too small to test is not a hypothesis that was tried.
 *  2. **A block bootstrap** rather than a t-test, because trade returns are
 *     neither normal nor independent. See `resample.ts`.
 *  3. **Benjamini-Hochberg across every cell tested**, so the reported q-value
 *     already accounts for how many cells were looked at. An uncorrected p-value
 *     from a seventy-eight-cell sweep is not evidence.
 *
 * A survey whose honest answer is "nothing here is distinguishable from noise"
 * returns that, prominently, and it will be the answer more often than not.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS NOT
 *
 * **Not a substitute for the out-of-sample gate.** A surviving cell is a
 * SCREENING result: "this is worth walking forward". It has not been walked
 * forward here, and `resample.ts` sets the false-discovery rate at 10% precisely
 * because `promote.ts` is still downstream. Nothing in this module promotes
 * anything.
 *
 * **Not free of the in-sample problem.** Every cell is measured over the same
 * history it was selected on. The bootstrap accounts for sampling noise; it
 * cannot account for the fact that a rule someone wrote in 2019 was written by
 * someone who had seen 2018. That is what walk-forward is for, and the headline
 * says so.
 *
 * **Not a regime forecast.** `recommendFor` answers "what worked in a chop",
 * given that you are in one. Deciding whether you are in one is the Decision
 * desk's job, and knowing a chop is under way is not the same as knowing it will
 * continue.
 */

import type { BarView } from "../chart/series";
import { makeContext, runBacktest, type BacktestOptions, type Costs, type Trade } from "./engine";
import { compileSpec, type RuleSpec, type StrategyStyle } from "./rules";
import { classifyRegimes, REGIME_LABEL, type Regime } from "./regime";
import {
  benjaminiHochberg,
  blockBootstrap,
  DRAWS,
  FDR,
  NO_BOOTSTRAP,
  type BootstrapResult,
} from "./resample";
import { SPECS, STYLE_LABEL } from "./specs";
import { BLOC_LABEL, PANEL_BY_SYMBOL, panelCaveat, type Bloc } from "./universe";

/** One market's bars, with everything needed to refuse them. */
export interface SurveyMarket {
  readonly symbol: string;
  readonly label?: string;
  readonly timeframe: string;
  readonly bars: readonly BarView[];
  /** From `history.ts`. Below the engine's floor the market is skipped. */
  readonly coverage?: number;
  readonly containsDemo?: boolean;
}

/** A market that could not be used, and why — reported, never dropped silently. */
export interface SkippedMarket {
  readonly symbol: string;
  readonly reason: string;
}

/**
 * Per-market evidence inside one cell.
 *
 * The unit of AGREEMENT. Kept per symbol rather than collapsed to a mean because
 * "three of four markets agreed" is the finding, and a mean of four numbers
 * cannot be read back into that.
 */
export interface MarketLeg {
  readonly symbol: string;
  readonly label: string;
  readonly bloc: Bloc | null;
  readonly trades: number;
  readonly expectancyR: number;
  readonly winRate: number;
  /** True once `trades >= MIN_CELL_TRADES` — below that the sign means nothing. */
  readonly qualifies: boolean;
}

export type CellStanding =
  /** Too few trades to test. Not a hypothesis that was tried. */
  | "thin"
  /** Tested; indistinguishable from noise once multiplicity is accounted for. */
  | "no-edge"
  /** Significant pooled, but carried by a single correlation bloc. */
  | "one-market"
  /** Significant pooled, and the blocs that qualify contradict each other. */
  | "mixed"
  /** Significant, and independent blocs agree. The only reportable outcome. */
  | "holds";

export interface Cell {
  /** `style:regime` or `spec:regime` — unique within its table. */
  readonly key: string;
  readonly regime: Regime;
  /** Set on a style row; null on a rule row. */
  readonly style: StrategyStyle | null;
  /** Set on a rule row; null on a style row. */
  readonly specId: string | null;
  readonly label: string;

  readonly trades: number;
  /** Trade-weighted pooled expectancy: what this actually made, per trade. */
  readonly expectancyR: number;
  readonly winRate: number;
  /**
   * Median of the per-market expectancies, over qualifying markets only.
   *
   * Reported BESIDE the pooled figure rather than instead of it, because the two
   * disagreeing is itself the finding: a strong pooled number with a median near
   * zero means one market is carrying the cell.
   */
  readonly medianR: number;

  readonly legs: MarketLeg[];
  /** Blocs with a qualifying leg. The real sample size for a cross-market claim. */
  readonly blocs: number;
  /** Of those, how many were positive. */
  readonly agree: number;

  readonly boot: BootstrapResult;
  /** Benjamini-Hochberg adjusted p across every tested cell in this survey. */
  readonly q: number;
  readonly standing: CellStanding;
  /** One sentence, computed here so a redesign cannot drop it. */
  readonly verdict: string;
}

export interface Survey {
  readonly timeframe: string;
  /** Markets that contributed, in the order given. */
  readonly markets: { symbol: string; label: string; bars: number; bloc: Bloc | null }[];
  readonly skipped: SkippedMarket[];
  /** Style rows: the "which style" answer. */
  readonly styles: Cell[];
  /** Rule rows: the "which strategy" answer. */
  readonly rules: Cell[];
  /** Share of all classified bars in each regime, pooled across markets. */
  readonly exposure: Readonly<Record<Regime, number>>;
  /** How many cells entered the multiplicity correction. */
  readonly tested: number;
  /** Cells at or below the false-discovery rate with blocs agreeing. */
  readonly held: number;
  /** The sentence at the top. Leads with what survived, never with a return. */
  readonly headline: string;
  readonly caveats: string[];
  /**
   * Set when this survey COULD NOT have reported a finding, whatever the data.
   *
   * Two independent causes, both structural: a bootstrap too coarse to reach the
   * threshold over this many cells (`resolutionLimit`), and a panel with too few
   * independent blocs to satisfy the agreement rule (`panelLimit`). In either
   * case "nothing held" is a fact about the setup, and reporting it in the same
   * words used for a genuine null result would be a confident wrong answer.
   *
   * BOTH WERE FOUND BY RUNNING IT, not by reasoning about it. The first came
   * from a failing test; the second from watching a real run in which only BTC
   * loaded — where the desk said "none showed a positive edge that independent
   * markets agreed on" about a panel that had one market in it.
   */
  readonly blocked: string | null;
  readonly ms: number;
}

/**
 * Whether the panel that actually LOADED can support the agreement rule.
 *
 * A cell is only called held when at least `MIN_BLOCS` independent correlation
 * blocs agree. Load one bloc and no cell can ever reach that, so the survey's
 * answer is fixed before a single bar is read — and it would otherwise be
 * delivered as though the data had produced it.
 *
 * This is the common case rather than an edge case: only the crypto legs come
 * from Binance directly, so an install with no MT5 bridge and no proxy history
 * gets exactly one bloc and a table full of "no edge".
 */
export function panelLimit(blocs: number, markets: number): string | null {
  if (blocs >= MIN_BLOCS) return null;
  const m = `${markets} market${markets === 1 ? "" : "s"}`;
  if (markets === 0) return "No market produced usable bars — there is nothing to survey.";
  return (
    `Only ${blocs === 1 ? "one correlation bloc" : "no correlation bloc"} loaded (${m}). ` +
    `A cell is only called held when ${MIN_BLOCS} independent blocs agree, so NOTHING can hold ` +
    `here however strong the edge — the limit is the panel, not the data. The numbers below are ` +
    `real arithmetic on real bars and describe ${markets === 1 ? "that one market" : "those markets"} ` +
    `only. Add a market from another bloc — gold, an index or an FX pair — for a claim about a rule ` +
    `rather than about ${markets === 1 ? "one market" : "one bloc"}.`
  );
}

/**
 * Whether this many draws can produce a finding at all, over this many cells.
 *
 * FOUND BY A FAILING TEST, and worth stating plainly because it is the kind of
 * mistake that produces a confident wrong answer rather than an error.
 *
 * A bootstrap over `draws` replicates cannot report a p-value below
 * `1 / (draws + 1)` — `resample.ts` deliberately refuses to claim an exact zero
 * from a finite number of draws. Benjamini-Hochberg then multiplies the smallest
 * p by `cells / rank`, so the best q ANY cell can reach is
 *
 *     cells / (draws + 1)
 *
 * With 75 cells and 200 draws that is 0.37 — nowhere near the 10% threshold. The
 * survey would test every cell, find nothing, and report "nothing survived" in
 * the same words it uses for a genuine null result. The data would be irrelevant:
 * a rule with a colossal edge would be reported as noise.
 *
 * Lowering `draws` for a responsive UI is a reasonable thing to want, which is
 * exactly why this cannot be left implicit.
 */
export function resolutionLimit(cells: number, draws: number, fdr = FDR): string | null {
  if (cells === 0 || draws <= 0) return null;
  const best = cells / (draws + 1);
  if (best <= fdr) return null;
  const needed = Math.ceil(cells / fdr) - 1;
  return (
    `Underpowered: ${draws} bootstrap draws over ${cells} cells cannot produce a q-value below ` +
    `${best.toFixed(2)}, and the threshold is ${fdr.toFixed(2)}. NOTHING can be reported as holding ` +
    `at this setting however strong the edge — the limit is the draw count, not the data. ` +
    `${needed.toLocaleString()} draws or more are needed for ${cells} cells.`
  );
}

/**
 * Per-market trade floor inside a cell.
 *
 * `regime.ts` uses fifteen for the same reason and the argument is unchanged: a
 * sign computed from six trades is a coin. This is the threshold at which a
 * market's leg is allowed to count towards agreement — not the threshold for
 * testing the pooled cell, which is higher.
 */
export const MIN_CELL_TRADES = 15;

/**
 * Pooled trade floor before a cell is tested at all.
 *
 * Deliberately above `MIN_CELL_TRADES * 2`. A cell resting on two barely-
 * qualifying markets can reach significance on a run of luck in one of them, and
 * every such cell admitted also inflates the multiplicity correction for the
 * cells that deserve testing.
 */
export const MIN_CELL_TOTAL = 40;

/**
 * Independent blocs that must agree before a cell is called a style finding.
 *
 * Two, which is the minimum that means anything at all — one bloc is that
 * bloc's character, and there is no version of this survey where a single-bloc
 * result is evidence about a rule.
 */
export const MIN_BLOCS = 2;

/** Fraction of qualifying blocs that must be positive. Two of three. */
export const AGREE_RATIO = 0.66;

export interface SurveyOptions extends BacktestOptions {
  /** Rules to test. Defaults to every shipped spec. */
  specs?: readonly RuleSpec[];
  /** Bootstrap replicates. Lower for a responsive UI, never for a report. */
  draws?: number;
  /** Injected for tests. */
  now?: () => number;
  /**
   * A cost model PER MARKET, when one is known.
   *
   * THIS DESK RANKS MARKETS, SO THE HURDLE DECIDES THE RANKING. One flat spread
   * charged to every instrument means a market can rank below another for a cost
   * it does not pay — and measured against this operator's broker the flat 2bp
   * assumption is 4.8x the real spread on gold and 3.8x on EURUSD, which are not
   * the same distortion. Ranking them against each other on one number is the
   * comparison this option exists to make honest.
   *
   * ABSENT MEANS EXACTLY TODAY'S BEHAVIOUR, and returning undefined for a market
   * whose spread is not known falls back to `opts.costs` rather than guessing —
   * a market charged a made-up spread would be worse than one charged the
   * assumption, because nothing on screen would say which.
   */
  costsFor?: (symbol: string) => Costs | undefined;
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

/** A trade, plus which market and regime it belongs to. */
interface Tagged {
  readonly trade: Trade;
  readonly symbol: string;
  readonly regime: Regime;
  readonly specId: string;
  readonly style: StrategyStyle;
}

const REGIMES: readonly Regime[] = ["trend", "chop", "volatile"];

/**
 * Run every rule over every market, and tabulate.
 *
 * Synchronous and CPU-bound, like `runStudy`.
 *
 * MEASURED, on four markets of 6,000 hourly bars against all twenty-six rules:
 * 1.86 s in total, of which 0.73 s is the hundred and four backtests and 1.13 s
 * is the bootstrap. The STATISTICS are the hot path here, not the trading — which
 * is worth knowing before optimising the obvious-looking half. Sharing one
 * context per market (below) is a real saving but a modest one, about 1.3x on the
 * backtest portion: `rules.ts` only ever builds the columns a spec actually
 * names, so the overlap between twenty-six specs is smaller than it looks.
 */
export function runSurvey(markets: readonly SurveyMarket[], opts: SurveyOptions = {}): Survey {
  const clock = opts.now ?? Date.now;
  const started = clock();
  const specs = opts.specs ?? SPECS;
  const draws = opts.draws ?? DRAWS;

  const used: Survey["markets"] = [];
  const skipped: SkippedMarket[] = [];
  const tagged: Tagged[] = [];
  const regimeBars: Record<Regime, number> = { trend: 0, chop: 0, volatile: 0 };
  const caveats: string[] = [];

  const minCoverage = opts.minCoverage ?? 0.98;
  const timeframe = markets[0]?.timeframe ?? "";

  /* Compiled ONCE, not per market. `compileSpec` closes over the column set the
     spec references and is pure in its argument, so one compiled strategy is
     reusable across every series — and the twenty-six of them were otherwise
     being rebuilt for each market, twice over, just to read `warmup`. */
  const compiled = specs.map((spec) => ({ spec, strategy: compileSpec(spec) }));
  const maxWarmup = Math.max(...compiled.map((c) => c.strategy.warmup));

  for (const market of markets) {
    const entry = PANEL_BY_SYMBOL.get(market.symbol);
    const label = market.label ?? entry?.label ?? market.symbol;

    /* Refuse per market rather than per run. The engine would refuse each of the
       twenty-six runs individually with the same message; saying it once, about
       the market, is what makes the report readable. */
    if (market.containsDemo === true && opts.allowDemo !== true) {
      skipped.push({ symbol: market.symbol, reason: "series contains generated data" });
      continue;
    }
    if (market.coverage !== undefined && market.coverage < minCoverage) {
      skipped.push({
        symbol: market.symbol,
        reason: `coverage ${(market.coverage * 100).toFixed(1)}% is below the ${(minCoverage * 100).toFixed(0)}% floor`,
      });
      continue;
    }
    if (market.timeframe !== timeframe) {
      /* Mixing timeframes would pool a 1h rule's trades with a 1d rule's and
         report the mean as one number. The bars-held column alone would be
         meaningless, and expectancy would be quietly weighted by whichever
         timeframe traded more. */
      skipped.push({
        symbol: market.symbol,
        reason: `timeframe ${market.timeframe} does not match the survey's ${timeframe}`,
      });
      continue;
    }

    if (market.bars.length < maxWarmup + 50) {
      skipped.push({
        symbol: market.symbol,
        reason: `${market.bars.length} bars is below the ${maxWarmup + 50} this rule set needs`,
      });
      continue;
    }

    /* ONE context per market, shared across all twenty-six rules. `rules.ts`
       caches indicator columns against the context object, so EMA-50 is computed
       once here instead of once per rule that names it. */
    const ctx = makeContext(market.bars);
    const regimes = classifyRegimes(market.bars);
    for (const r of regimes) regimeBars[r]++;

    for (const { spec, strategy } of compiled) {
      /* PER MARKET WHEN KNOWN, the shared model otherwise. Spreading `opts`
         first means every other option is untouched and only the hurdle can
         differ — a survey where two markets differed in more than their costs
         would not be comparing what it claims to. */
      const marketCosts = opts.costsFor?.(market.symbol);
      const runOpts = marketCosts === undefined ? opts : { ...opts, costs: marketCosts };
      const run = runBacktest(strategy, market.bars, runOpts, ctx);
      if (run.refused) continue;
      for (const trade of run.trades) {
        const at = Math.max(0, Math.min(trade.entryIndex, regimes.length - 1));
        tagged.push({
          trade,
          symbol: market.symbol,
          /* ENTRY regime, matching `regime.ts`: the question is whether to take
             this setup in these conditions, which is decided with only what was
             known at entry. Scoring by the exit regime would grade the decision
             by an outcome it could not have seen. */
          regime: regimes[at] ?? "chop",
          specId: spec.id,
          style: spec.style,
        });
      }
    }

    used.push({
      symbol: market.symbol,
      label,
      bars: market.bars.length,
      bloc: entry?.bloc ?? null,
    });
  }

  const totalBars = REGIMES.reduce((a, r) => a + regimeBars[r], 0);
  const exposure: Record<Regime, number> = {
    trend: totalBars === 0 ? 0 : regimeBars.trend / totalBars,
    chop: totalBars === 0 ? 0 : regimeBars.chop / totalBars,
    volatile: totalBars === 0 ? 0 : regimeBars.volatile / totalBars,
  };

  // ------------------------------------------------------------ tabulate ---

  const styleIds = [...new Set(specs.map((s) => s.style))];
  const draft: DraftCell[] = [];

  for (const regime of REGIMES) {
    for (const style of styleIds) {
      draft.push(
        build(
          `${style}:${regime}`,
          `${STYLE_LABEL[style] ?? style} in a ${REGIME_LABEL[regime].toLowerCase()} market`,
          regime,
          style,
          null,
          tagged.filter((t) => t.regime === regime && t.style === style),
          used,
          draws,
        ),
      );
    }
  }

  const ruleDraft: DraftCell[] = [];
  for (const regime of REGIMES) {
    for (const spec of specs) {
      ruleDraft.push(
        build(
          `${spec.id}:${regime}`,
          `${spec.name} in a ${REGIME_LABEL[regime].toLowerCase()} market`,
          regime,
          null,
          spec.id,
          tagged.filter((t) => t.regime === regime && t.specId === spec.id),
          used,
          draws,
        ),
      );
    }
  }

  /**
   * ONE correction across BOTH tables.
   *
   * Style rows and rule rows are not independent hypotheses — a style row is an
   * aggregate of its own rule rows — but they are all cells a reader will scan
   * and pick from, and the multiplicity that matters is the number of cells
   * LOOKED AT, not the number of statistically distinct questions. Correcting
   * the two tables separately would let the same finding be reported at a
   * kinder q simply because it appears in the shorter table.
   */
  const all = [...draft, ...ruleDraft];
  const testable = all.filter((c) => c.standing !== "thin");
  const qs = benjaminiHochberg(testable.map((c) => c.boot.p));
  const qByKey = new Map<string, number>();
  testable.forEach((c, i) => qByKey.set(c.key, qs[i] as number));

  const finish = (c: DraftCell): Cell => {
    const q = qByKey.get(c.key) ?? 1;
    const standing = c.standing === "thin" ? "thin" : gradeCell(c, q);
    return { ...c, q, standing, verdict: sentenceFor(c, q, standing) };
  };

  const styles = draft.map(finish).sort(rank);
  const rules = ruleDraft.map(finish).sort(rank);

  const held = [...styles, ...rules].filter((c) => c.standing === "holds").length;

  /* THE STRUCTURAL BLOCKERS, checked after the cells are counted because both
     limits depend on what actually loaded and how many cells were testable.
     Reported FIRST, because when either fires every number below it is
     unreadable — and the panel limit outranks the draw count, since a
     single-bloc panel cannot report a finding at any draw count at all. */
  const loadedBlocs = new Set(used.map((m) => m.bloc ?? `?${m.symbol}`)).size;
  const blocked =
    panelLimit(loadedBlocs, used.length) ?? resolutionLimit(testable.length, draws);
  if (blocked) caveats.push(blocked);

  const caveat = panelCaveat(used.map((m) => m.symbol));
  if (caveat) caveats.push(caveat);
  if (skipped.length > 0) {
    caveats.push(
      `${skipped.length} market${skipped.length === 1 ? "" : "s"} did not contribute: ` +
        `${skipped.map((s) => `${s.symbol} (${s.reason})`).join("; ")}. Agreement is counted only ` +
        `over the ${used.length} that did.`,
    );
  }
  caveats.push(
    "Every cell is measured on the same history it was chosen from. The bootstrap accounts for " +
      "sampling noise, not for the fact that these rules were written by people who had already " +
      "seen these years. Run the winners through the lab's walk-forward before believing any of it.",
  );

  return {
    timeframe,
    markets: used,
    skipped,
    styles,
    rules,
    exposure,
    tested: testable.length,
    held,
    headline: blocked ?? headlineFor(used.length, testable.length, held, styles, rules),
    caveats,
    blocked,
    ms: clock() - started,
  };
}

/* ------------------------------------------------------------- internals */

type DraftCell = Omit<Cell, "q" | "verdict"> & { standing: CellStanding };

function build(
  key: string,
  label: string,
  regime: Regime,
  style: StrategyStyle | null,
  specId: string | null,
  rows: readonly Tagged[],
  markets: Survey["markets"],
  draws: number,
): DraftCell {
  const legs: MarketLeg[] = [];
  /* Per-market R series, in TIME order — the bootstrap resamples blocks of
     consecutive trades and that only means anything if they are consecutive. */
  const groups: number[][] = [];

  for (const market of markets) {
    const mine = rows
      .filter((r) => r.symbol === market.symbol)
      .map((r) => r.trade)
      .sort((a, b) => a.entryTime - b.entryTime);

    const rs = mine.map((t) => t.rMultiple);
    const wins = mine.filter((t) => t.returnPct > 0).length;
    legs.push({
      symbol: market.symbol,
      label: market.label,
      bloc: market.bloc,
      trades: mine.length,
      expectancyR: rs.length === 0 ? 0 : rs.reduce((a, v) => a + v, 0) / rs.length,
      winRate: mine.length === 0 ? 0 : wins / mine.length,
      qualifies: mine.length >= MIN_CELL_TRADES,
    });
    if (rs.length > 0) groups.push(rs);
  }

  const trades = rows.length;
  const wins = rows.filter((r) => r.trade.returnPct > 0).length;
  const pooledR = rows.reduce((a, r) => a + r.trade.rMultiple, 0);
  const expectancyR = trades === 0 ? 0 : pooledR / trades;

  const qualified = legs.filter((l) => l.qualifies);
  /* Agreement is counted by BLOC, not by symbol. BTC and ETH both liking a rule
     is one market liking it twice — see the header of `universe.ts`. */
  const blocSign = new Map<string, number>();
  for (const leg of qualified) {
    const bloc = leg.bloc ?? `?${leg.symbol}`;
    /* Within a bloc, the mean of its legs' expectancies decides the bloc's sign.
       Both legs must not each get a vote. */
    const prev = blocSign.get(bloc);
    blocSign.set(bloc, prev === undefined ? leg.expectancyR : (prev + leg.expectancyR) / 2);
  }
  const blocs = blocSign.size;
  const agree = [...blocSign.values()].filter((v) => v > 0).length;

  const testable = trades >= MIN_CELL_TOTAL && qualified.length >= 1;
  const boot = testable ? blockBootstrap(groups, draws) : NO_BOOTSTRAP;

  return {
    key,
    regime,
    style,
    specId,
    label,
    trades,
    expectancyR,
    winRate: trades === 0 ? 0 : wins / trades,
    medianR: median(qualified.map((l) => l.expectancyR)),
    legs,
    blocs,
    agree,
    boot,
    standing: testable ? "no-edge" : "thin",
  };
}

/**
 * The ladder, ordered so the strongest objection wins.
 *
 * Significance is necessary and NOT sufficient: a cell can be significant on
 * pooled trades and still be one market's character, which is why the bloc
 * checks come after the q-value rather than instead of it.
 */
function gradeCell(c: DraftCell, q: number): CellStanding {
  if (c.expectancyR <= 0 || q > FDR) return "no-edge";
  if (c.blocs < MIN_BLOCS) return "one-market";
  if (c.agree / c.blocs < AGREE_RATIO) return "mixed";
  return "holds";
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`;
const r = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}R`;

function sentenceFor(c: DraftCell, q: number, standing: CellStanding): string {
  const where = `${c.trades} trades across ${c.legs.filter((l) => l.trades > 0).length} markets`;

  switch (standing) {
    case "thin":
      return c.trades === 0
        ? "No trades in this condition — the rules never fired here."
        : `${c.trades} trades is below the ${MIN_CELL_TOTAL} floor, so this was not tested. Not "no edge": not measured.`;

    case "no-edge":
      return c.expectancyR <= 0
        ? `Loses money: ${r(c.expectancyR)} per trade over ${where}.`
        : `${r(c.expectancyR)} over ${where}, but q = ${q.toFixed(2)} once every cell in this survey ` +
            `is accounted for — indistinguishable from noise at a ${pct(FDR)} false-discovery rate.`;

    case "one-market": {
      const carrier = [...c.legs].sort((a, b) => b.trades - a.trades)[0];
      return (
        `${r(c.expectancyR)} over ${where} at q = ${q.toFixed(2)}, but only ` +
        `${c.blocs === 0 ? "no" : "one"} correlation bloc has a testable sample` +
        `${carrier ? ` (${carrier.label} carries it)` : ""}. This is a fact about that market, ` +
        `not about the rule. Add an unrelated market before treating it as either.`
      );
    }

    case "mixed":
      return (
        `${r(c.expectancyR)} pooled, but only ${c.agree} of ${c.blocs} independent blocs are ` +
        `positive — median across markets is ${r(c.medianR)}. The pooled figure is an average of ` +
        `markets that disagree, which is not a strategy.`
      );

    case "holds":
      return (
        `${r(c.expectancyR)} per trade over ${where}, median ${r(c.medianR)}, and ` +
        `${c.agree} of ${c.blocs} independent blocs agree (q = ${q.toFixed(2)}). ` +
        `Worth walking forward — it has not been yet.`
      );
  }
}

/** Best first: standing, then pooled expectancy. */
function rank(a: Cell, b: Cell): number {
  const order: Record<CellStanding, number> = {
    holds: 0,
    mixed: 1,
    "one-market": 2,
    "no-edge": 3,
    thin: 4,
  };
  const d = order[a.standing] - order[b.standing];
  return d !== 0 ? d : b.expectancyR - a.expectancyR;
}

function headlineFor(
  markets: number,
  tested: number,
  held: number,
  styles: readonly Cell[],
  rules: readonly Cell[],
): string {
  if (markets === 0) return "No market produced usable bars — there is nothing to survey.";
  if (tested === 0) {
    return (
      `Nothing was testable. ${markets} market${markets === 1 ? "" : "s"} loaded, but no ` +
      `rule-and-condition cell reached the ${MIN_CELL_TOTAL}-trade floor. More history, or a ` +
      `faster timeframe, before any of this means anything.`
    );
  }
  if (held === 0) {
    return (
      `Nothing survived. ${tested} cells were tested across ${markets} ` +
      `market${markets === 1 ? "" : "s"} and none showed a ` +
      `positive edge that independent markets agreed on at a ${pct(FDR)} false-discovery rate. ` +
      `That is the ordinary result, and it is the honest one: a table of ${tested} cells will ` +
      `always have a best row, and a best row is not a finding.`
    );
  }

  const bestStyle = styles.find((c) => c.standing === "holds");
  const bestRule = rules.find((c) => c.standing === "holds");
  const lead = bestStyle ?? bestRule;

  return (
    `${held} of ${tested} cells held across ${markets} market${markets === 1 ? "" : "s"}. ` +
    (lead
      ? `Strongest: ${lead.label} — ${r(lead.expectancyR)} per trade, ${lead.agree} of ` +
        `${lead.blocs} independent blocs agreeing. `
      : "") +
    `Held means "survived a ${pct(FDR)} false-discovery correction over ${tested} cells AND ` +
    `agreed across unrelated markets". It does not mean walked forward.`
  );
}

/* ---------------------------------------------------------- the payoff */

export interface Recommendation {
  readonly regime: Regime;
  /** Cells that held in this condition, best first. Empty is a real answer. */
  readonly holds: Cell[];
  /** Cells that lose money here — worth as much as the winners. */
  readonly avoid: Cell[];
  readonly text: string;
}

/**
 * What the survey says about the condition you are actually in.
 *
 * The point of the whole module. Computed here rather than in the UI for the same
 * reason `Study.headline` is: a table without a conclusion gets read as whichever
 * row is at the top, and the row at the top of a ranked table is the luckiest
 * one when nothing held.
 *
 * `avoid` is not filler. "Do not fade a violent market" is a more reliable
 * finding than any of the positive ones, because a rule has to be much worse than
 * nothing to show up as significantly negative, and the same multiplicity
 * correction applies.
 */
export function recommendFor(survey: Survey, regime: Regime, from: "styles" | "rules" = "styles"): Recommendation {
  const rows = (from === "styles" ? survey.styles : survey.rules).filter((c) => c.regime === regime);
  const holds = rows.filter((c) => c.standing === "holds");
  const avoid = rows
    .filter((c) => c.standing !== "thin" && c.expectancyR < 0 && c.blocs >= MIN_BLOCS)
    .sort((a, b) => a.expectancyR - b.expectancyR)
    .slice(0, 3);

  const condition = REGIME_LABEL[regime].toLowerCase();

  if (holds.length === 0) {
    const tried = rows.filter((c) => c.standing !== "thin").length;
    return {
      regime,
      holds,
      avoid,
      text:
        tried === 0
          ? `Nothing was testable in a ${condition} market — too few trades in this condition to measure anything.`
          : `Nothing held in a ${condition} market. ${tried} cells were tested and none beat noise ` +
            `across independent markets.` +
            (avoid.length > 0
              ? ` What the survey does say is what to avoid: ${avoid
                  .map((c) => `${c.label.split(" in a ")[0]} (${r(c.expectancyR)})`)
                  .join(", ")}.`
              : " Not a positive or a negative finding — an absence of one."),
    };
  }

  const best = holds[0] as Cell;
  return {
    regime,
    holds,
    avoid,
    text:
      `In a ${condition} market, ${holds
        .map((c) => c.label.split(" in a ")[0])
        .join(" and ")} held across independent markets. ` +
      `Strongest is ${best.label.split(" in a ")[0]} at ${r(best.expectancyR)} per trade ` +
      `(${best.trades} trades, ${best.agree}/${best.blocs} blocs, q = ${best.q.toFixed(2)}). ` +
      `Screening only — walk it forward before sizing anything on it.` +
      (avoid.length > 0
        ? ` Avoid ${avoid.map((c) => c.label.split(" in a ")[0]).join(", ")} here.`
        : ""),
  };
}

/** Bloc labels for a cell's legs, for the report. */
export function legBlocLabel(leg: MarketLeg): string {
  return leg.bloc ? BLOC_LABEL[leg.bloc] : "unclassified";
}
