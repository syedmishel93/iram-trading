/**
 * Hybrid strategies: one rule's TRIGGER under another rule's CONDITION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THAT DECIDES WHETHER A HYBRID TRADES AT ALL
 *
 * A `RuleSpec` condition is one of two things, and mixing them up produces a
 * strategy that looks reasonable and never fires:
 *
 *   EVENT   `crossabove` / `crossbelow` — true on ONE bar, the bar it happens.
 *   STATE   `>` `<` `>=` `<=`          — true for as long as it holds.
 *
 * Every condition in a group is ANDed, so a hybrid built from two EVENTS asks
 * for two crossings on the same bar. On 5,000 bars of BTCUSDT 1h, "EMA 9/21
 * cross" fires 300-odd times and "MACD cross" 200-odd; the bars where both
 * happen at once are a handful, and a handful of trades is not a strategy —
 * it is a sample too small for any of the statistics downstream to speak to.
 *
 * So the composition is deliberately asymmetric and always the same shape:
 *
 *     TRIGGER  every condition of A's entry (whatever it is made of)
 *     FILTER   only the STATE conditions of B's entry
 *
 * "Take A's setup, but only while B's world is true." That is also the thing
 * a trader actually asks for — "the pullback rule, but only in an uptrend" —
 * and it keeps A's trade count roughly intact, minus whatever B excludes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT A HYBRID INHERITS, AND WHY IT IS NOT A FREE CHOICE
 *
 * Exits, stop and target come from A, the trigger's owner, unchanged. The
 * alternative — mixing A's entry with B's stop — multiplies the search by the
 * number of risk shapes for no stated reason, and every extra arm makes the
 * best result look better by luck alone (see `study/stats.ts` `deflatedSharpe`,
 * which charges the search for exactly this). One composition per ordered pair,
 * counted once.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS REFUSED, RATHER THAN EMITTED AND LEFT TO FAIL LATER
 *
 *   - B offers no state condition: there is nothing to add, so A+B IS A.
 *   - every filter is already in A: same strategy, different name.
 *   - the filter contradicts the trigger (`rsi < 30` under `rsi > 70`, or
 *     `ema9 > ema21` under `ema9 < ema21`): it can never fire.
 *   - the result does not pass `validateSpec`, the real validator.
 *
 * A refused pair is REPORTED with its reason rather than dropped silently, so
 * "why is there no EMA-cross + RSI hybrid?" has an answer on screen, and so the
 * trial count downstream matches what was actually evaluated.
 */

import { validateSpec, type Condition, type ConditionGroup, type OperatorId, type RuleSpec } from "./rules";

/** Operators that are true on one bar only. See the header. */
const EVENT_OPS: ReadonlySet<OperatorId> = new Set<OperatorId>(["crossabove", "crossbelow"]);

export function isEvent(c: Condition): boolean {
  return EVENT_OPS.has(c[1]);
}

/** `ema9 > ema21` and `ema9>ema21` are the same condition. */
export function conditionKey(c: Condition): string {
  return `${c[0]}|${c[1]}|${String(c[2]).trim()}`;
}

const groupKey = (g: ConditionGroup): string => [...g].map(conditionKey).sort().join("&");

/** The opposite comparison, for the contradiction check. */
const OPPOSITE: Readonly<Partial<Record<OperatorId, OperatorId>>> = {
  ">": "<",
  "<": ">",
  ">=": "<=",
  "<=": ">=",
};

const num = (v: string): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Can these two conditions be true on the same bar?
 *
 * Deliberately narrow: it catches the two cases a generated hybrid actually
 * produces — the same pair of columns compared both ways, and the same column
 * bounded on both sides by numbers that leave no room. It does NOT attempt to
 * reason about indicators (that `rsi > 70` and `close < bbl` rarely co-occur is
 * a fact about markets, not logic, and the backtest is what should say so).
 */
export function contradicts(a: Condition, b: Condition): boolean {
  if (a[0] !== b[0]) return false;
  const ra = String(a[2]).trim();
  const rb = String(b[2]).trim();
  if (ra === rb && OPPOSITE[a[1]] === b[1]) return true;

  const na = num(ra);
  const nb = num(rb);
  if (na === null || nb === null) return false;
  const below = (op: OperatorId): boolean => op === "<" || op === "<=";
  const above = (op: OperatorId): boolean => op === ">" || op === ">=";
  /* x > 70 AND x < 30 — nothing sits in both. */
  if (above(a[1]) && below(b[1]) && na >= nb) return true;
  if (below(a[1]) && above(b[1]) && na <= nb) return true;
  return false;
}

export type HybridRefusal =
  | "no-filter"
  | "already-in-trigger"
  | "contradiction"
  | "invalid"
  | "duplicate";

export interface HybridSpec {
  readonly spec: RuleSpec;
  /** The trigger's id, then the filter's. Both are `SPECS` ids. */
  readonly trigger: string;
  readonly filter: string;
  /** The conditions B contributed, in plain text, for the card. */
  readonly added: readonly Condition[];
}

export interface HybridRejected {
  readonly trigger: string;
  readonly filter: string;
  readonly reason: HybridRefusal;
  /** One line, for "why is there no A+B?". */
  readonly why: string;
}

export interface HybridResult {
  readonly hybrids: readonly HybridSpec[];
  readonly rejected: readonly HybridRejected[];
  /** Pairs considered = hybrids + rejected. The search charges for these. */
  readonly considered: number;
}

/** State conditions of a group — what B can contribute. */
export function filterConditions(g: ConditionGroup | undefined): Condition[] {
  return (g ?? []).filter((c) => !isEvent(c));
}

const WHY: Readonly<Record<HybridRefusal, string>> = {
  "no-filter": "it has no standing condition to add — every one of its entry rules is a one-bar crossing",
  "already-in-trigger": "every condition it would add is already in the trigger, so the pair is the trigger",
  contradiction: "its condition cannot be true at the same time as the trigger's",
  invalid: "the combined rule did not pass the rule validator",
  duplicate: "another pair produces exactly the same rule",
};

/**
 * One hybrid from an ordered pair, or the reason there is none.
 *
 * `trigger` keeps its exits, stop and target; `filter` contributes only the
 * standing conditions of its own entry, mirrored on the short side when both
 * sides exist. A long-only trigger stays long-only.
 */
export function composePair(trigger: RuleSpec, filter: RuleSpec): HybridSpec | HybridRejected {
  const no = (reason: HybridRefusal): HybridRejected => ({ trigger: trigger.id, filter: filter.id, reason, why: WHY[reason] });

  const longFilters = filterConditions(filter.long);
  if (longFilters.length === 0) return no("no-filter");

  const have = new Set(trigger.long.map(conditionKey));
  const added = longFilters.filter((c) => !have.has(conditionKey(c)));
  if (added.length === 0) return no("already-in-trigger");
  for (const c of added) for (const t of trigger.long) if (contradicts(t, c)) return no("contradiction");

  /* The short side mirrors only when BOTH sides exist: adding a long-side
     filter to a short entry would be a rule nobody wrote. */
  const shortAdded =
    trigger.short && filter.short
      ? filterConditions(filter.short).filter((c) => !new Set(trigger.short?.map(conditionKey) ?? []).has(conditionKey(c)))
      : [];
  if (trigger.short && filter.short) {
    for (const c of shortAdded) for (const t of trigger.short) if (contradicts(t, c)) return no("contradiction");
  }

  const spec: RuleSpec = {
    id: `hy:${trigger.id}+${filter.id}`,
    name: `${trigger.name} · only while ${filter.name}`,
    style: "custom",
    long: [...trigger.long, ...added],
    ...(trigger.short ? { short: [...trigger.short, ...shortAdded] } : {}),
    ...(trigger.exitLong ? { exitLong: trigger.exitLong } : {}),
    ...(trigger.exitShort ? { exitShort: trigger.exitShort } : {}),
    stop: trigger.stop,
    target: trigger.target,
    note:
      `Built by the terminal: the entry, exits, stop and target of "${trigger.name}", ` +
      `taken only while the standing conditions of "${filter.name}" hold. Not hand-written, and not yet forward-tested.`,
  };
  if (validateSpec(spec).length > 0) return no("invalid");
  return { spec, trigger: trigger.id, filter: filter.id, added };
}

/**
 * Every hybrid of a library, deterministically, capped.
 *
 * ORDERED pairs: A-triggered-by-B and B-triggered-by-A are different
 * strategies (different entries, different exits, different risk), so both are
 * offered — but the cap counts them, because every arm of the search is
 * charged for in `deflatedSharpe`.
 *
 * The cap is a REFUSAL, not a truncation of the ranking: with 25 specs the
 * ordered pairs are 600, and 600 arms on 5,000 bars is both an hour of compute
 * and a hurdle so high that nothing clears it honestly. The caller passes what
 * it can afford; the result says how many pairs were left unbuilt.
 */
export interface HybridOptions {
  readonly max?: number;
  /** Only these ids may be triggers (default: all). */
  readonly triggers?: readonly string[];
}

export const DEFAULT_MAX_HYBRIDS = 60;

export function buildHybrids(specs: readonly RuleSpec[], opts: HybridOptions = {}): HybridResult & { readonly unbuilt: number } {
  const max = Math.max(0, Math.floor(opts.max ?? DEFAULT_MAX_HYBRIDS));
  const allowed = opts.triggers ? new Set(opts.triggers) : null;
  const hybrids: HybridSpec[] = [];
  const rejected: HybridRejected[] = [];
  const seen = new Set<string>();
  let considered = 0;
  let unbuilt = 0;

  for (const trigger of specs) {
    if (allowed && !allowed.has(trigger.id)) continue;
    for (const filter of specs) {
      if (filter.id === trigger.id) continue;
      if (hybrids.length >= max) {
        unbuilt += 1;
        continue;
      }
      considered += 1;
      const out = composePair(trigger, filter);
      if ("reason" in out) {
        rejected.push(out);
        continue;
      }
      const key = groupKey(out.spec.long) + "||" + groupKey(out.spec.short ?? []) + "||" + JSON.stringify(out.spec.stop) + JSON.stringify(out.spec.target);
      if (seen.has(key)) {
        rejected.push({ trigger: out.trigger, filter: out.filter, reason: "duplicate", why: WHY.duplicate });
        continue;
      }
      seen.add(key);
      hybrids.push(out);
    }
  }
  return { hybrids, rejected, considered, unbuilt };
}
