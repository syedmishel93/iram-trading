/**
 * The operator's question, and the checks the AI picks to answer it.
 *
 * The steered Research flow asks "what do you want to predict?" instead of
 * "which of fifteen methods?". This file is the translation, and it is a
 * TABLE on purpose: the operator can read exactly which checks a question
 * turns into, switch any of them off, and open the full method list to add
 * others. Nothing here is fitted or learned.
 *
 * WHAT IS NOT OFFERED, AND WHY
 * The approved design lists "Price range, next N bars". The study engine has
 * no range forecaster — the nearest thing is the volatility model, which
 * forecasts how much the price will move, not where. Offering "price range"
 * and answering with a volatility figure would be answering a different
 * question under the one that was asked, so it is left out and the
 * volatility question says what it does answer.
 */

export type QuestionId = "direction" | "setup" | "volatility" | "regime";

export interface Question {
  readonly id: QuestionId;
  /** Short, with the horizon filled in by `questionLabel`. */
  readonly label: string;
  /** What the answer will be, in one line. */
  readonly answers: string;
  /** Methods always used for this question. */
  readonly core: readonly string[];
  /** Methods added only when related assets are in the study. */
  readonly withRelated: readonly string[];
  /**
   * Whether the related assets can change the ANSWER, or are only measured
   * beside it. Said on screen, because otherwise an operator adds five series
   * to a question whose checks never read them and wonders why nothing moved.
   */
  readonly relatedRole: "model" | "measured";
  /** Whether walk-forward rounds and costs apply — only rule tests have trades. */
  readonly usesRules: boolean;
}

export const QUESTIONS: readonly Question[] = [
  {
    id: "direction",
    label: "Direction, next {n} bars",
    answers: "The odds of an up move over the horizon, before and after a model, and whether the related assets add anything.",
    core: ["regimes", "baserates", "classifier"],
    withRelated: ["crossasset", "leadlag", "corrmatrix"],
    relatedRole: "model",
    usesRules: false,
  },
  {
    id: "setup",
    label: "Win or loss of a setup",
    answers: "Whether plain trend, reversion and the terminal's own structure rules survive walk-forward testing after costs.",
    core: ["sweep-ema", "sweep-rsi", "sweep-confluence", "excursion", "montecarlo", "regimes"],
    withRelated: ["corrmatrix"],
    relatedRole: "measured",
    usesRules: true,
  },
  {
    id: "volatility",
    label: "Volatility, next {n} bars",
    answers: "How much the price is likely to move (not which way), and whether a volatility model beats a simple average.",
    core: ["regimes", "garch", "seasonality"],
    withRelated: ["corrmatrix"],
    relatedRole: "measured",
    usesRules: false,
  },
  {
    id: "regime",
    label: "Market regime",
    answers: "Which conditions the window contains, how the odds differ in each, and whether volatility clusters.",
    core: ["regimes", "baserates", "garch"],
    withRelated: ["leadlag", "corrmatrix"],
    relatedRole: "model",
    usesRules: false,
  },
];

export const DEFAULT_QUESTION: QuestionId = "direction";

export function questionOf(id: QuestionId | undefined): Question {
  return QUESTIONS.find((q) => q.id === id) ?? (QUESTIONS[0] as Question);
}

export function questionLabel(q: Question, horizon: number): string {
  return q.label.replace("{n}", String(horizon));
}

/**
 * The checks for a question, in declaration order, with no duplicates.
 *
 * `hasRelated` is whether ANY related asset is switched on: a relationship
 * check with nothing to relate is a refusal waiting to happen, and the plan
 * would count its hypotheses against the study for nothing.
 */
export function methodsFor(id: QuestionId, hasRelated: boolean): string[] {
  const q = questionOf(id);
  const out: string[] = [];
  for (const m of [...q.core, ...(hasRelated ? q.withRelated : [])]) if (!out.includes(m)) out.push(m);
  return out;
}

export interface InputTag {
  readonly label: string;
  readonly why: string;
}

/**
 * What the chosen checks will READ — derived from the methods, never declared
 * separately, so the list cannot claim an input nothing uses.
 */
export function inputsFor(methods: readonly string[], related: number, subject: string): InputTag[] {
  const has = (...ids: string[]): boolean => ids.some((id) => methods.includes(id));
  const out: InputTag[] = [
    { label: `${subject} returns`, why: "Every check starts from the subject's own bar-to-bar returns over the chosen history." },
  ];
  if (related > 0 && has("leadlag", "corrmatrix", "crossasset")) {
    out.push({
      label: `Related assets (${related})`,
      why: "Joined to the subject bar by bar on timestamps, never read from the future. Series that describe conditions slice the result instead of entering a model.",
    });
  }
  if (has("regimes", "baserates")) {
    out.push({ label: "Market condition", why: "Each bar labelled trend, chop or volatile from ADX and where its volatility sits against its own history." });
  }
  if (has("garch")) {
    out.push({ label: "Volatility history", why: "The size of past moves, to forecast the size of the next ones." });
  }
  if (has("seasonality")) {
    out.push({ label: "Hour and weekday", why: "When in the day and week each bar happened, to see whether timing carries any of the move." });
  }
  if (has("sweep-ema", "sweep-rsi", "sweep-confluence")) {
    out.push({ label: "Rule trades", why: "The entries and exits each rule would have taken, with the costs chosen under How strict." });
  }
  return out;
}
