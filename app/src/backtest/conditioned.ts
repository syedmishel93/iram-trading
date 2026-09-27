/**
 * "DOES THIS RULE WORK IN THIS STATE?" — the only question left worth asking.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY, MEASURED
 *
 * Across 22 markets and 334 graded arms the shipped rules had a median
 * per-trade Sharpe of −0.109 and 35% above zero. Then the archive went from 42
 * days to 5 years, and the test that could finally answer said:
 *
 *     median trades per arm   58  ->  821
 *     best per-trade Sharpe  +0.374 -> +0.070
 *     hurdle                 +0.450 -> +0.102
 *     arms clearing it            0 ->      0
 *
 * The best shallow result COLLAPSED on 14x more data. The library has no
 * standalone edge, and that is now measured rather than suspected. So the
 * question stops being "which rule works" — none does — and becomes "is there a
 * STATE in which one does".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE STATE LIST IS SHORT, AND WHY THAT IS THE DESIGN
 *
 * A search pays for every arm. The hurdle is `sqrt(2 ln N)/sqrt(n)`, so every
 * state added multiplies the field by the library size and raises the bar for
 * every rule in it. Six states over 25 rules is 150 arms; sixty states would be
 * 1,500 and would need a materially better winner to say anything at all.
 *
 * So these are not a grid. Each is one axis at one sign, and each carries the
 * PRIOR that justifies spending arms on it — written down here in advance so
 * that a result can be read against what was expected, rather than a story
 * being fitted to whatever came back. Three axes, two signs each:
 *
 *   * **The dollar.** Gold and crypto are priced in it; a falling dollar is a
 *     mechanical tailwind for both, not a correlation somebody noticed.
 *   * **Yields.** Rising long yields raise the discount rate on every
 *     duration-sensitive asset, and gold pays no coupon to compensate.
 *   * **Volatility.** Rising volatility is when trend-following is supposed to
 *     pay and mean-reversion is supposed to be run over. Both halves of the
 *     library make a claim about this, and neither has been asked.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * **It does not apply a state to one direction only.** A dollar prior says a
 * falling dollar helps gold, which would make it a LONG filter — and encoding
 * that here would bake in the answer the test exists to find. The state gates
 * both directions and the measurement decides.
 *
 * **It does not invent thresholds.** Every state is a sign test against zero on
 * a CHANGE, never `vix > 20`, because 20 is a number somebody chose and a
 * threshold search is a second search nobody charged for.
 */

import type { Condition, RuleSpec } from "./rules";

/** One market state, with the reason it is worth an arm. */
export interface MacroState {
  readonly id: string;
  /** Reads into "… only while <label>". */
  readonly label: string;
  /** The prior, recorded BEFORE the result, so a finding can be read against it. */
  readonly why: string;
  readonly condition: Condition;
}

/**
 * Three axes, two signs. A sign test against zero on a CHANGE — never a level
 * threshold, which would be a number somebody chose and a search nobody
 * charged for.
 */
export const MACRO_STATES: readonly MacroState[] = [
  {
    id: "usd-down",
    label: "the dollar is falling",
    why: "gold and crypto are priced in dollars, so a falling dollar is a mechanical tailwind rather than a noticed correlation",
    condition: ["dxy_chg5", "<", "0"],
  },
  {
    id: "usd-up",
    label: "the dollar is rising",
    why: "the same mechanism with the sign reversed; a rule that only survives here is doing something other than riding the currency",
    condition: ["dxy_chg5", ">", "0"],
  },
  {
    id: "yields-up",
    label: "long yields are rising",
    why: "a rising discount rate pressures every duration-sensitive asset, and gold pays no coupon to compensate",
    condition: ["us10y_chg5", ">", "0"],
  },
  {
    id: "yields-down",
    label: "long yields are falling",
    why: "the reverse, and the state in which a non-yielding asset is least disadvantaged",
    condition: ["us10y_chg5", "<", "0"],
  },
  {
    id: "vol-up",
    label: "volatility is rising",
    why: "trend-following claims to pay here and mean-reversion claims to be run over; the library contains both and neither has been asked",
    condition: ["vix_chg5", ">", "0"],
  },
  {
    id: "vol-down",
    label: "volatility is falling",
    why: "the quiet half, where reversion is supposed to earn its keep",
    condition: ["vix_chg5", "<", "0"],
  },
];

/** A cap, because the field's width sets the hurdle for every arm in it. */
export const DEFAULT_MAX_CONDITIONED = 180;

export interface ConditionedResult {
  readonly specs: readonly RuleSpec[];
  /** Pairs not built, each with the reason. A silent drop lowers the hurdle. */
  readonly refused: readonly { readonly id: string; readonly why: string }[];
  /** How many pairs the cap discarded. Counted, because it changes the width. */
  readonly capped: number;
}

/** `mc:<base>+<state>` — parseable, so a survivor can be traced to its pair. */
export function conditionedId(baseId: string, stateId: string): string {
  return `mc:${baseId}+${stateId}`;
}

/**
 * Pair every base rule with every state.
 *
 * The state is ANDed onto the entry of BOTH directions. A rule with no short
 * side keeps none — adding one would be inventing a strategy, not conditioning
 * an existing one.
 */
export function buildConditioned(
  library: readonly RuleSpec[],
  opts: {
    readonly states?: readonly MacroState[];
    readonly max?: number;
    readonly exclude?: readonly string[];
  } = {},
): ConditionedResult {
  const states = opts.states ?? MACRO_STATES;
  const max = Math.max(0, Math.floor(opts.max ?? DEFAULT_MAX_CONDITIONED));
  const excluded = new Set(opts.exclude ?? []);
  const specs: RuleSpec[] = [];
  const refused: { id: string; why: string }[] = [];
  let capped = 0;

  for (const base of library) {
    for (const state of states) {
      const id = conditionedId(base.id, state.id);
      if (excluded.has(id)) continue;
      if (base.long.length === 0) {
        refused.push({ id, why: `${base.name} has no entry to condition` });
        continue;
      }
      /* Already conditioned on this exact column? Adding a second test on the
         same series is not a new state, it is the same one written twice, and
         it would spend an arm on a duplicate. */
      if (base.long.some((c) => c[0] === state.condition[0])) {
        refused.push({ id, why: `${base.name} already tests ${state.condition[0]}` });
        continue;
      }
      if (specs.length >= max) {
        capped += 1;
        continue;
      }
      specs.push({
        id,
        name: `${base.name} · only while ${state.label}`,
        style: "custom",
        long: [...base.long, state.condition],
        ...(base.short ? { short: [...base.short, state.condition] } : {}),
        ...(base.exitLong ? { exitLong: base.exitLong } : {}),
        ...(base.exitShort ? { exitShort: base.exitShort } : {}),
        stop: base.stop,
        target: base.target,
        note:
          `${base.name}, taken only while ${state.label}. Expected before the run: ` +
          `${state.why}. The state gates BOTH directions — encoding a directional ` +
          `prior here would bake in the answer this is meant to find. It is measured ` +
          `on the context series' own bars and read only once that bar has CLOSED, ` +
          `so nothing here knows a price before it existed.`,
      });
    }
  }

  return { specs, refused, capped };
}
