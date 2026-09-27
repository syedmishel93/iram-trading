/**
 * Plain words for the terminal's jargon, and the rule for using them.
 *
 * THE PROBLEM, STATED HONESTLY
 * This application says PBO, AUC, Brier skill, triple-barrier, purged
 * walk-forward, GARCH, funding basis, confluence and coverage. Every one of
 * those is the correct term, and every one of them is opaque to somebody who
 * did not build it. The usual fix is to delete them and write something
 * friendly, which trades precision for comfort and produces a terminal that
 * cannot say what it means.
 *
 * THE RULE HERE IS THE OPPOSITE ORDER, NOT A SUBSTITUTION
 *
 *     Lead with the plain sentence. Keep the term, small, beside it.
 *
 * So a panel says "How often it was right when it was confident" and carries
 * `calibration` as a quiet tag. A reader who does not know the word learns
 * what the panel measures; a reader who does know it can see exactly which
 * statistic is on screen and go argue with it. Nothing is dumbed down and
 * nothing is unreadable — which is achievable, and only because the plain
 * phrasing and the term are allowed to coexist rather than compete.
 *
 * WHY A TABLE AND NOT PROSE AT EACH CALL SITE
 * Because the same term appears on five desks and drifted into five different
 * explanations, two of which were wrong. A glossary is a single place to be
 * right, and a single place to be corrected.
 */

export interface Term {
  /** The jargon, exactly as the field uses it. Never softened. */
  readonly term: string;
  /** What to lead with. A phrase, not a definition — it goes in a heading. */
  readonly plain: string;
  /** One sentence, for the tooltip and the expandable note. */
  readonly says: string;
  /**
   * What a reader would get WRONG about it, when there is a common mistake.
   *
   * This field earns its place more than `says` does. Most of these terms are
   * misread in one specific, predictable way — a hit rate read as profit, an
   * AUC read as accuracy — and naming that mistake is worth more than another
   * paraphrase of the definition.
   */
  readonly notThe?: string;
}

const TERMS: readonly Term[] = [
  {
    term: "coverage",
    plain: "How much of the evidence answered",
    says: "The share of the sources this read expects to hear from that actually replied this time.",
    notThe: "Not how strong the signal is. A read can be 100% covered and say nothing useful.",
  },
  {
    term: "confluence score",
    plain: "How much the evidence agrees",
    says: "Every source that answered, weighted, pulling one way or the other on a scale from −1 to +1.",
    notThe: "Not a probability. A score of 0.6 does not mean a 60% chance of anything.",
  },
  {
    term: "PBO",
    plain: "How often picking the best backtest is picking noise",
    says: "Run the whole selection again on data it has not seen: this is how often the winner turns out to be worse than average.",
    notThe: "Not a property of any one strategy. It is a property of the SET you chose from — a sound strategy can sit inside a hopeless set.",
  },
  {
    term: "AUC",
    plain: "Whether it ranks better than a coin",
    says: "Pick one winner and one loser at random; this is how often the model scored the winner higher. 0.5 is a coin.",
    notThe: "Not accuracy, and not a hit rate. A model can rank perfectly and still give probabilities that are all wrong.",
  },
  {
    term: "Brier skill",
    plain: "Whether its percentages beat just guessing the average",
    says: "How much better its probabilities are than always predicting the long-run base rate. Negative means worse than that.",
    notThe: "Separate from AUC on purpose: a model routinely ranks well and scores negative here, which means use it to sort, never to size.",
  },
  {
    term: "calibration",
    plain: "Whether its percentages mean anything",
    says: "Of everything it called 60%, did about 60% happen? A model can rank correctly and still be badly calibrated.",
  },
  {
    term: "expectancy",
    plain: "What an average claim actually made",
    says: "Average result per claim, measured in R — multiples of what was risked.",
    notThe: "Not the hit rate. A 70% hit rate at small targets loses money; a 35% hit rate at large ones makes it.",
  },
  {
    term: "R",
    plain: "One unit of what you risked",
    says: "The distance from entry to stop. A 2R win makes twice what the stop would have cost.",
  },
  {
    term: "triple-barrier",
    plain: "Right, wrong, or ran out of time",
    says: "Every claim gets an upper level, a lower level and a deadline, and whichever it touches first is the answer.",
  },
  {
    term: "purged walk-forward",
    plain: "Tested only on what came after",
    says: "The model is always fitted on earlier bars and scored on later ones, with a gap between them so no answer leaks backwards.",
  },
  {
    term: "look-ahead",
    plain: "Using tomorrow's data by accident",
    says: "Any point where a calculation touches information that did not exist yet. It is the single most common reason a backtest looks brilliant and dies live.",
  },
  {
    term: "base rate",
    plain: "What you would get for free",
    says: "How often the thing happens anyway, with no model at all. Every score worth reading is a score against this.",
  },
  {
    term: "GARCH",
    plain: "How violent it has been, and what that implies next",
    says: "A volatility model: quiet periods cluster and so do violent ones, and it estimates how long the current one tends to last.",
    notThe: "Says nothing about direction.",
  },
  {
    term: "funding",
    plain: "What holders of perpetuals are paying each other",
    says: "A periodic payment between long and short holders that keeps a perpetual future near spot. Persistently positive means longs are paying to stay long.",
  },
  {
    term: "basis",
    plain: "The gap between two venues' prices",
    says: "Same instrument, different places, different price. It widens when the venues disagree or one of them is under stress.",
    notThe: "Not your dealing cost. Your dealing cost is the bid-ask at the venue that actually fills you.",
  },
  {
    term: "spread",
    plain: "What it costs to get in",
    says: "The gap between the bid and the ask at your own broker — paid in full, immediately, on every entry.",
  },
  {
    term: "Wilson interval",
    plain: "The range the true rate could be in",
    says: "Three wins out of four is 75% and also consistent with 30%. This is the honest range around a rate from a small sample.",
  },
  {
    term: "drawdown",
    plain: "The worst run from a peak",
    says: "How far the account fell from its high before recovering — the number that decides whether a strategy is survivable.",
  },
  {
    term: "regime",
    plain: "What kind of market this currently is",
    says: "Trending, ranging, or violent. The same setup has different odds in each, which is why it is worth naming.",
  },
  {
    term: "structural",
    plain: "A source that cannot exist here",
    says: "Some evidence simply does not apply to some instruments — gold has no funding rate — so it is listed and not counted as missing.",
  },
];

const BY_TERM = new Map(TERMS.map((t) => [t.term.toLowerCase(), t]));

export function lookup(term: string): Term | null {
  return BY_TERM.get(term.toLowerCase()) ?? null;
}

export function allTerms(): readonly Term[] {
  return [...TERMS].sort((a, b) => a.term.localeCompare(b.term));
}

/**
 * The `title` text for a term, assembled from the parts that exist.
 *
 * `notThe` comes last and reads as a correction because that is what it is —
 * the reader arrives with a wrong idea more often than with no idea.
 */
export function explain(term: string): string {
  const t = lookup(term);
  if (t === null) return "";
  return t.notThe ? `${t.says} ${t.notThe}` : t.says;
}

/**
 * Plain heading for a term, falling back to the term itself.
 *
 * Falling back rather than throwing: a heading that renders the raw term is a
 * small wart, and a heading that renders nothing because somebody typed a term
 * that is not in the table is a blank panel.
 */
export function plainly(term: string): string {
  return lookup(term)?.plain ?? term;
}
