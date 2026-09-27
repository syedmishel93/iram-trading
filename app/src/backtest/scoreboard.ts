/**
 * WHAT HAS BEEN TESTED, ON WHAT, AND WHAT SURVIVED.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A BOARD THAT LISTS ONLY WINNERS IS AN ADVERT
 *
 * The shelf (`discovered.ts`) holds what came out of a search. On its own it
 * answers "what do I have" and cannot answer "does any of this work", because
 * a market where every rule failed leaves NO ROW — so a shelf with four entries
 * looks identical whether those four came out of four searches or four hundred.
 * That is survivorship bias in its purest form, and it is the reason a strategy
 * library always looks better than the strategies in it.
 *
 * `SWEEP_SLOT` is the half that knows. It records every search: the market, the
 * bars, how many rules entered, how many CONFIGURATIONS were charged for, how
 * many survived, and the refusal when none did.
 *
 * MEASURED before this file existed: it had a writer in `sweepdriver.ts` and
 * **no reader anywhere in the product**. The record of everything the terminal
 * has ever tried was being kept and shown to nobody — the fourth store with a
 * writer and no reader this project has found.
 *
 * Joining the two is the whole job. The board lists the market where nothing
 * cleared the hurdle beside the one where something did, and says which is
 * which.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * IT RANKS ON THE DEFLATED FIGURE, NEVER THE RAW ONE
 *
 * A market searched with 85 rules over 765 configurations and one searched with
 * 8 are not comparable on a best-of figure: the wider search gets a better best
 * by luck alone. `study/stats.ts` `deflatedSharpe` already charges for that, and
 * `Discovered` stores what was left after the charge. That number is the only
 * one that means the same thing in both rows.
 */

import { keyOf, type Discovered } from "./discovered";
import type { SweepSummary } from "./sweepcache";

/**
 * Below this many out-of-sample trades, no market gets a verdict.
 *
 * It matches `MIN_FORWARD_TRADES` in `discovered.ts` for the same reason that
 * number exists: a per-trade figure on a handful of trades has a confidence
 * interval wider than any difference anybody would act on.
 */
export const MIN_TRADES_FOR_VERDICT = 30;

export type ScoreVerdict = "working" | "unproven" | "nothing" | "not searched";

export interface AssetScore {
  readonly symbol: string;
  readonly timeframe: string;
  /** How many searches have been run on this subject. */
  readonly searches: number;
  /** Configurations charged for, summed — the width of everything tried. */
  readonly trials: number;
  readonly lastSearched: number;
  /** Rules still on the shelf for it. Retired rows do not count. */
  readonly kept: number;
  /** The best kept rule by what survived the hurdle, or null. */
  readonly best: Discovered | null;
  readonly verdict: ScoreVerdict;
  /** One sentence. No verdict is ever shown as a bare word. */
  readonly why: string;
}

const subject = (symbol: string, timeframe: string): string =>
  `${symbol.toUpperCase()}|${timeframe}`;

const r2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : "—");

/**
 * Join the shelf and the sweep log into one row per (market, bar size).
 *
 * THE MARKET AND THE BAR SIZE STAY TOGETHER. BTCUSDT 1h and BTCUSDT 1d have
 * different base rates, different costs as a share of the move, and different
 * trade counts; merging them would average two different questions into a
 * number that answers neither.
 */
export function scoreboard(
  shelf: readonly Discovered[],
  sweeps: readonly SweepSummary[],
): AssetScore[] {
  const keys = new Set<string>();
  for (const d of shelf) keys.add(subject(d.symbol, d.timeframe));
  for (const s of sweeps) keys.add(subject(s.symbol, s.timeframe));

  const rows: AssetScore[] = [];

  for (const key of keys) {
    const [symbol = "", timeframe = ""] = key.split("|");

    const mine = sweeps.filter((s) => subject(s.symbol, s.timeframe) === key);
    const searches = mine.length;
    const trials = mine.reduce((a, s) => a + (Number.isFinite(s.trials) ? s.trials : 0), 0);
    /* THE MOST RECENT SEARCH'S REASON, not the first. An old refusal quoted
       against a fresh search is a sentence about a question nobody asked. */
    const newest = mine.reduce<SweepSummary | null>(
      (a, s) => (a === null || s.at > a.at ? s : a),
      null,
    );
    const lastSearched = newest?.at ?? 0;

    /* A RETIRED ROW IS NOT A SURVIVOR. It was found and then found wanting, and
       counting it would make a market that failed forward look like one that
       never did. */
    const live = shelf.filter(
      (d) => subject(d.symbol, d.timeframe) === key && d.status !== "retired",
    );
    const best = live.reduce<Discovered | null>(
      (a, d) => (a === null || (d.deflated ?? -Infinity) > (a.deflated ?? -Infinity) ? d : a),
      null,
    );

    let verdict: ScoreVerdict;
    let why: string;

    if (searches === 0) {
      verdict = "not searched";
      why =
        live.length > 0
          ? `${live.length} rule${live.length === 1 ? "" : "s"} on the shelf, but this subject has not been searched since the log was kept — the width they cleared is not recorded here`
          : "this subject has not been searched";
    } else if (best === null) {
      verdict = "nothing";
      why =
        `searched ${searches} time${searches === 1 ? "" : "s"} over ${trials.toLocaleString()} configurations — ` +
        `nothing cleared the hurdle. ${newest?.nearest ?? newest?.refusal ?? ""}`.trim();
    } else if (!Number.isFinite(best.trades) || best.trades < MIN_TRADES_FOR_VERDICT) {
      verdict = "unproven";
      why =
        `best rule is "${best.spec.name}" on ${best.trades} trades — ` +
        `below the ${MIN_TRADES_FOR_VERDICT} this desk needs before quoting a per-trade figure`;
    } else if (!Number.isFinite(best.deflated) || best.deflated <= 0) {
      verdict = "unproven";
      why =
        `best rule is "${best.spec.name}" at ${r2(best.sharpe)} per trade against a ` +
        `hurdle of ${r2(best.hurdle)} for a ${best.trials.toLocaleString()}-arm search — ` +
        `it did not beat its own search`;
    } else {
      verdict = "working";
      why =
        `"${best.spec.name}" kept ${r2(best.deflated)} per trade after the hurdle ` +
        `(${r2(best.sharpe)} measured, ${r2(best.hurdle)} charged for a ${best.trials.toLocaleString()}-arm search), ` +
        `on ${best.trades} out-of-sample trades`;
    }

    rows.push({
      symbol,
      timeframe,
      searches,
      trials,
      lastSearched,
      kept: live.length,
      best,
      verdict,
      why,
    });
  }

  /* ORDER: something that works, then something that might, then a market that
     answered no, then one nobody has asked. Within a tier, by what survived the
     hurdle — never by the raw figure. */
  const tier: Readonly<Record<ScoreVerdict, number>> = {
    working: 0,
    unproven: 1,
    nothing: 2,
    "not searched": 3,
  };
  return rows.sort((a, b) => {
    const t = tier[a.verdict] - tier[b.verdict];
    if (t !== 0) return t;
    const ad = a.best?.deflated ?? -Infinity;
    const bd = b.best?.deflated ?? -Infinity;
    if (bd !== ad) return bd - ad;
    return b.lastSearched - a.lastSearched;
  });
}

/** Headline counts, so the desk never has to recount what the board holds. */
export interface ScoreTotals {
  readonly subjects: number;
  readonly working: number;
  readonly unproven: number;
  readonly nothing: number;
  readonly notSearched: number;
  readonly searches: number;
  readonly trials: number;
  /** One sentence for the top of the desk. */
  readonly line: string;
}

export function scoreTotals(rows: readonly AssetScore[]): ScoreTotals {
  const count = (v: ScoreVerdict): number => rows.filter((r) => r.verdict === v).length;
  const working = count("working");
  const unproven = count("unproven");
  const nothing = count("nothing");
  const notSearched = count("not searched");
  const searches = rows.reduce((a, r) => a + r.searches, 0);
  const trials = rows.reduce((a, r) => a + r.trials, 0);

  /* THE DENOMINATOR IS THE POINT. "Two rules found" means nothing; "two of
     nineteen subjects, out of 41,000 configurations" is the same fact with the
     search it came out of attached, and that is what makes it readable. */
  const line =
    rows.length === 0
      ? "Nothing has been searched yet."
      : `${working} of ${rows.length} subject${rows.length === 1 ? "" : "s"} ${working === 1 ? "has" : "have"} something that beat its own search` +
        `, from ${searches} search${searches === 1 ? "" : "es"} over ${trials.toLocaleString()} configurations. ` +
        `${nothing} answered no.`;

  return { subjects: rows.length, working, unproven, nothing, notSearched, searches, trials, line };
}

/** Stable identity for a row, so the desk can key on it. */
export const scoreKey = (r: AssetScore): string =>
  r.best !== null ? keyOf(r.best) : `${r.symbol}|${r.timeframe}`;

/* ------------------------------------------------------------ the model --- */

/**
 * Scored candidates below this and no verdict is offered.
 *
 * The router service has its own floor and this is the DESK'S. Trusting an
 * upstream `skill: true` on forty scored rows would be quoting a figure whose
 * confidence interval covers everything — and `skill` is a boolean, so it
 * carries no interval of its own to inspect.
 */
export const MIN_SCORED = 120;

/**
 * Below this AUC, the model cannot rank one setup above another.
 *
 * 0.5 is a coin. 0.55 is the floor at which an ordering carries any information
 * at all, and it is enforced SEPARATELY from accuracy because the two can
 * disagree completely: MEASURED on this operator's own fitted models, SPX 1h
 * reported 74% accuracy with an AUC of 0.51 — the majority class wearing a hat.
 * "An AUC near 0.5 presented as 62% confident loses money with conviction."
 */
export const MIN_AUC = 0.55;

/**
 * The accuracy of always predicting the commonest outcome.
 *
 * THE ONLY HONEST THING TO COMPARE AN ACCURACY TO. `baseRate` from the service
 * is the share of the POSITIVE class, so a base rate of 0.27 means always
 * predicting the negative one scores 0.73 — and a board quoting "74% against a
 * base rate of 27%" makes one point of nothing look like forty-seven. Found by
 * reading the panel's own output on live data; the service's `lift` field had
 * been right all along.
 */
export const noInfoRate = (baseRate: number): number =>
  Number.isFinite(baseRate) ? Math.max(baseRate, 1 - baseRate) : Number.NaN;

export type ModelVerdict = "skill" | "no skill" | "too few" | "could not ask";

export interface ModelScore {
  readonly symbol: string;
  readonly timeframe: string;
  readonly verdict: ModelVerdict;
  readonly auc: number;
  readonly accuracy: number;
  readonly baseRate: number;
  readonly lift: number;
  readonly scored: number;
  readonly why: string;
}

/**
 * ONE DECIMAL, because two rounded figures beside a lift contradict each other.
 * MEASURED on the live panel: SOLUSDT 1h showed "72% accurate against 72% for
 * always predicting the commonest outcome" next to "+1pts" — both true at whole
 * percents, and visibly at odds. A reader who spots that stops trusting the row.
 */
const pc = (v: number): string => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "—");

/**
 * What the model has learned, per market.
 *
 * ACCURACY IS NOT SKILL, and this is the surface where that matters most. A
 * classifier predicting the majority class scores the base rate exactly, so
 * "58% accurate" on a sample that is 58% winners has learned nothing and reads
 * as a result. The two numbers are carried together, always.
 *
 * THREE OUTCOMES, NEVER TWO. A model that learned nothing is an ANSWER — the
 * most common honest one a router gives — and filing it with "the service is
 * not running" buries it. `could not ask` is silence; `no skill` is a finding.
 *
 * It reads `autoResults()`, the same call the Simulation desk uses. Two readers
 * of one function, which is the reason it is a function; the Simulation desk
 * answers about ONE market in depth and this answers across all of them.
 */
export function modelBoard(
  results: readonly { readonly sym: string; readonly tf: string; readonly router: unknown }[],
): ModelScore[] {
  const rows: ModelScore[] = [];

  for (const r of results) {
    const router = r.router as Record<string, unknown> | null;
    const base = { symbol: r.sym, timeframe: r.tf };

    if (router === null || router["ok"] !== true) {
      rows.push({
        ...base,
        verdict: "could not ask",
        auc: Number.NaN,
        accuracy: Number.NaN,
        baseRate: Number.NaN,
        lift: Number.NaN,
        scored: 0,
        /* THE SERVICE'S OWN SENTENCE, verbatim. It knows why it refused and a
           replacement written here would be a second, worse answer. */
        why: String(router?.["why"] ?? "no model has been fitted for this market yet"),
      });
      continue;
    }

    const num = (k: string): number =>
      typeof router[k] === "number" && Number.isFinite(router[k]) ? (router[k] as number) : Number.NaN;
    const scored = num("scored");
    const auc = num("auc");
    const accuracy = num("accuracy");
    const baseRate = num("baseRate");
    const lift = num("lift");

    let verdict: ModelVerdict;
    let why: string;

    if (!Number.isFinite(scored) || scored < MIN_SCORED) {
      verdict = "too few";
      why =
        `${Number.isFinite(scored) ? scored : 0} scored setups — below the ${MIN_SCORED} ` +
        `this desk needs before reading a hit rate, whatever the fit reported`;
    } else if (router["skill"] !== true || !(auc >= MIN_AUC)) {
      /* BOTH TESTS, and either one alone is insufficient. The service's `skill`
         flag compares accuracy to the no-information rate; AUC asks whether the
         model can ORDER setups at all. A model can pass the first and fail the
         second by predicting the majority class with a rounding error on top,
         which is what most of this operator's fitted models actually do. */
      verdict = "no skill";
      why =
        `${pc(accuracy)} accurate against ${pc(noInfoRate(baseRate))} for always predicting ` +
        `the commonest outcome` +
        (Number.isFinite(auc) ? `, and AUC ${auc.toFixed(2)} — it cannot rank one setup above another` : "") +
        `. That is an answer about this market, not a failure of the model.`;
    } else {
      verdict = "skill";
      why =
        `${pc(accuracy)} accurate against ${pc(noInfoRate(baseRate))} for always predicting ` +
        `the commonest outcome, AUC ${auc.toFixed(2)}, on ${scored} scored setups out of sample`;
    }

    rows.push({ ...base, verdict, auc, accuracy, baseRate, lift, scored, why });
  }

  const tier: Readonly<Record<ModelVerdict, number>> = {
    skill: 0,
    "no skill": 1,
    "too few": 2,
    "could not ask": 3,
  };
  return rows.sort((a, b) => {
    const t = tier[a.verdict] - tier[b.verdict];
    if (t !== 0) return t;
    const al = Number.isFinite(a.lift) ? a.lift : -Infinity;
    const bl = Number.isFinite(b.lift) ? b.lift : -Infinity;
    return bl - al;
  });
}
