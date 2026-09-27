/**
 * The gate thresholds — the numbers the Setup card calls "yours".
 *
 * WHY THIS EXISTS
 * The card has always said "your limit is 6.0%", "your floor is 60%", "inside
 * your 30-minute embargo". Every one of those was a literal in `shell.ts` that
 * the user had never seen, let alone chosen. That is a small lie told six times
 * on the most consequential surface in the terminal, and it undermines the one
 * thing the gates are for: a rule you did not set is a rule you have no reason
 * to respect, and a rule you cannot see is one you will eventually talk
 * yourself past.
 *
 * WHY THE LIMITS ARE CLAMPED AND NOT MERELY VALIDATED
 * A threshold typed as `0` is not a threshold, it is a gate that never fires,
 * and a daily loss limit of 0% would stand you down permanently. Both are worse
 * than a wrong number because both LOOK like a working configuration. Every
 * field is clamped into a range where it still means something, and the clamp
 * is applied on read as well as on write so a preferences file edited by hand —
 * or written by an older version — cannot produce a card that quietly refuses
 * everything.
 *
 * WHAT IS DELIBERATELY NOT CONFIGURABLE
 * Whether a blocked gate stands you down. That is the one rule the card is,
 * and a "warn me but let me through" setting would turn it into decoration.
 */

export interface GateRules {
  /** Minutes either side of a high-impact event that block a new trade. */
  readonly embargoMinutes: number;
  /** Most of the stop distance you will pay in spread, as a percentage. */
  readonly spreadBudgetPct: number;
  /** Most total open risk you will carry, as a percentage of equity. */
  readonly maxHeatPct: number;
  /** How far down on the day you will go before stopping, as a percentage. */
  readonly dailyLossLimitPct: number;
  /** Share of decision sources that must answer, as a percentage. */
  readonly coverageFloor: number;
  /** The stop distance, in ATR, you consider sane. */
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
}

export const DEFAULT_RULES: GateRules = {
  embargoMinutes: 30,
  spreadBudgetPct: 15,
  maxHeatPct: 6,
  dailyLossLimitPct: 3,
  coverageFloor: 60,
  minStopAtr: 0.5,
  maxStopAtr: 3,
};

/**
 * The range each field is allowed to take, and why the ends are where they are.
 *
 * These are not taste. Each floor is the point below which the gate stops being
 * a gate, and each ceiling is the point above which it stops being passable.
 */
export const RULE_LIMITS = {
  /* 0 would switch the news gate off silently. 240 is four hours, beyond which
     nearly every session is inside some embargo. */
  embargoMinutes: [1, 240],
  /* Under 1% no real spread ever passes; over 100% the spread exceeds the stop
     and the trade is arithmetically dead on entry. */
  spreadBudgetPct: [1, 100],
  /* Under 0.1% no position can be opened at all. */
  maxHeatPct: [0.1, 100],
  /* 0 would stand you down before the first trade of the day. */
  dailyLossLimitPct: [0.1, 100],
  /* 0 accepts a read built on nothing. */
  coverageFloor: [1, 100],
  minStopAtr: [0.1, 5],
  maxStopAtr: [0.5, 20],
} as const satisfies Record<keyof GateRules, readonly [number, number]>;

const clamp = (v: unknown, [lo, hi]: readonly [number, number], fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Read a stored value into usable rules.
 *
 * Never throws and never returns a partial object: an unreadable field falls
 * back to its default rather than to zero, because a gate silently set to zero
 * is indistinguishable on screen from a gate that is working.
 */
export function sanitiseRules(value: unknown): GateRules {
  const v = (value ?? {}) as Record<string, unknown>;
  const out: GateRules = {
    embargoMinutes: clamp(v["embargoMinutes"], RULE_LIMITS.embargoMinutes, DEFAULT_RULES.embargoMinutes),
    spreadBudgetPct: clamp(v["spreadBudgetPct"], RULE_LIMITS.spreadBudgetPct, DEFAULT_RULES.spreadBudgetPct),
    maxHeatPct: clamp(v["maxHeatPct"], RULE_LIMITS.maxHeatPct, DEFAULT_RULES.maxHeatPct),
    dailyLossLimitPct: clamp(
      v["dailyLossLimitPct"],
      RULE_LIMITS.dailyLossLimitPct,
      DEFAULT_RULES.dailyLossLimitPct,
    ),
    coverageFloor: clamp(v["coverageFloor"], RULE_LIMITS.coverageFloor, DEFAULT_RULES.coverageFloor),
    minStopAtr: clamp(v["minStopAtr"], RULE_LIMITS.minStopAtr, DEFAULT_RULES.minStopAtr),
    maxStopAtr: clamp(v["maxStopAtr"], RULE_LIMITS.maxStopAtr, DEFAULT_RULES.maxStopAtr),
  };

  /* An inverted band is not clamped into shape silently — a min above the max
     would make the stop gate refuse every trade while each field on its own
     looked reasonable. The pair is restored to the defaults' relationship. */
  if (out.minStopAtr >= out.maxStopAtr) {
    return { ...out, minStopAtr: DEFAULT_RULES.minStopAtr, maxStopAtr: DEFAULT_RULES.maxStopAtr };
  }
  return out;
}

/** True when the rules are untouched, so the UI can offer a meaningful reset. */
export function rulesAreDefault(r: GateRules): boolean {
  return (Object.keys(DEFAULT_RULES) as (keyof GateRules)[]).every((k) => r[k] === DEFAULT_RULES[k]);
}
