/**
 * The gates — your own rules, checked out loud.
 *
 * WHAT A GREEN CHECKLIST MEANS
 * That the setup passed YOUR gates. Not that the trade will win. Every string
 * in this file is phrased to keep that distinction, because the failure mode of
 * a card like this is that a row of ticks starts reading as a forecast.
 *
 * WHY BEING BLOCKED IS NOT A DIRECTION
 * `STAND DOWN` says nothing about which way price is going. A trader who reads
 * a blocked setup as "bearish" has been misled by the thing that was supposed
 * to protect them, so `verdict()` carries the unchanged read alongside the
 * refusal and the UI is required to show both.
 *
 * WHY EVERY GATE NAMES ITS THRESHOLD
 * "Blocked" is not actionable. "Heat 5.4% + this trade 1.0% = 6.4%, over your
 * 6.0% limit" tells you what to do about it and by how much. A gate you cannot
 * argue with is a gate you learn to switch off.
 */

import type { Prior } from "../learn/prior";
import { MIN_FOR_RATE } from "../learn/scorecard";
import { deflatedSharpe } from "../study/stats";

export type GateStatus = "pass" | "block" | "unknown";

export interface Gate {
  readonly id: string;
  readonly status: GateStatus;
  /**
   * One SHORT line: the measurement and the limit it was checked against.
   * Plain words — this is what the operator reads at a glance.
   */
  readonly text: string;
  /** What would clear it, when that is knowable. Short, and an action. */
  readonly clears?: string;
  /**
   * The longer explanation — where a number came from, why a rule exists,
   * what a failure does and does not mean. Shown behind "Why?", never deleted:
   * v59 moved it off the first line to make the card readable, not to hide it.
   */
  readonly why?: string;
}

/**
 * The width of the search a rule came out of, and how it did in it.
 *
 * `perTradeSharpe` MUST be per-trade — mean over standard deviation of the same
 * `trades` returns. An annualised Sharpe has been multiplied by
 * sqrt(periods per year) and produces a correction that appears to have happened
 * while barely moving the number.
 */
export interface SearchCost {
  /** Arms the search had, INCLUDING the ones it refused. */
  readonly trials: number;
  /** Out-of-sample per-trade Sharpe. Never the annualised equity figure. */
  readonly perTradeSharpe: number;
  /** Out-of-sample trades behind it. The only lever that lowers the hurdle. */
  readonly trades: number;
}

export interface GateInputs {
  /**
   * What the terminal's own resolved record says about this setup, or null when
   * the ledger is off or has nothing to say.
   *
   * THE LOOP THIS CLOSES.
   * `learn/` has recorded every claim the card made, before the outcome
   * existed, and marked each one right or wrong — and until now nothing in the
   * decision path read a word of it. The terminal made every call as though it
   * were the first, on instruments where it had already been wrong forty times.
   *
   * It is a `Prior`, not a number, because the sample size travels with it. A
   * hit rate detached from its `n` is the single most misleading figure a
   * decision aid can show, and this one arrives in front of a refusal.
   *
   * OPTIONAL, so a caller that has no ledger — a test, the headless engines,
   * the scanner — is not forced to fabricate one. Absent and "nothing on
   * record" are the same state and produce the same `unknown` gate.
   */
  readonly record?: Prior | null;

  /**
   * How wide the search was that produced this rule, when one did.
   *
   * ABSENT OR NULL MEANS A HAND-DRAWN SETUP, and no search check is shown at
   * all — a manual setup has no multiplicity to pay for, and a permanently
   * passing row saying so is the kind of noise that teaches an operator to skim
   * a list whose whole value is that every row on it is worth reading.
   *
   * THE HURDLE IS NOT AN INPUT HERE. These are the three raw facts and
   * `deflatedSharpe` does the arithmetic, because a caller supplying its own
   * `deflated` would be supplying the conclusion — and because that function is
   * the one owner of the correction, which matters more than usual here: it is
   * defined on a PER-TRADE Sharpe, and this repository has already recorded an
   * annualised figure put through it deflating 4.93 by 0.85 and printing as
   * though the search had been paid for.
   */
  readonly search?: SearchCost | null;
  /**
   * How old the last price update is, in ms, or null when that is not known.
   *
   * EVERY OTHER GATE IS DOWNSTREAM OF THIS ONE. The spread gate reads a live
   * quote, the heat gate marks open positions to market, the news gate asks
   * "how many minutes until the event" — and all three answer confidently
   * against a price that stopped arriving twenty minutes ago. A stale feed does
   * not make the gates fail; it makes them fail to MEAN anything, which is
   * worse, because they still render as ticks.
   */
  readonly dataAgeMs: number | null;
  /** Above this the feed is stale. Derived from the bar span by the caller. */
  readonly dataStaleAfterMs: number;
  /**
   * What is keeping the price current, or null when the caller does not know.
   *
   * `"none"` is the state that shipped for every forex, metals and equity
   * chart: no socket on the source and nothing polling it, so the price aged
   * from the moment it loaded. It is a refusal, not a warning.
   */
  readonly dataTransport: "socket" | "poll" | "none" | null;
  /**
   * The broker's measured clock offset in ms, or null when it was not measured.
   *
   * Null is NOT zero. Zero is the claim "this venue stamps in UTC"; null is the
   * absence of a claim, and the difference is worth a gate because the terminal
   * ran for months on an unmeasured broker clock that was three hours out — and
   * the news gate, which refuses trades, was reading that clock.
   */
  readonly clockOffsetMs: number | null;
  /** True when the loaded series comes from a venue with its own server clock. */
  readonly clockMatters: boolean;

  /** Minutes to the next high-impact calendar event, or null if unknown. */
  readonly minutesToEvent: number | null;
  readonly eventName: string | null;
  readonly embargoMinutes: number;

  /** Current spread in price, and the stop distance in price. */
  readonly spread: number | null;
  /**
   * Where `spread` came from, because the two sources answer different questions.
   *
   * `"dealing"` is the broker's own bid-ask — the literal cost of crossing, and
   * the thing this gate is actually about. `"cross-venue"` is the disagreement
   * between exchanges, which is a PROXY for cost and a poor one: it overstates
   * on a calm day and understates during exactly the dislocations where
   * entering is dangerous. It was the only number available for years, so the
   * gate has to keep accepting it — but it must say which one it used, because
   * "spread is 8% of your stop" means something different depending.
   */
  readonly spreadKind: "dealing" | "book" | "cross-venue" | null;
  readonly stopDistance: number;
  /** Spread as a share of the stop that you are willing to pay. */
  readonly spreadBudgetPct: number;

  /**
   * Units resting at the top of the book, and the units this plan would buy.
   *
   * ONLY MEANINGFUL FOR `spreadKind: "book"`. An exchange's best bid and ask
   * are the price of a trade THAT FITS INSIDE THEM; a larger order walks into
   * the next level and pays more than the quote says. Both null everywhere
   * else, and a null pair simply omits the sentence — a broker's dealing
   * spread has no top-of-book size to compare against, and inventing one would
   * be worse than saying nothing.
   */
  readonly topOfBookQty: number | null;
  readonly plannedQty: number | null;

  readonly openHeatPct: number;
  readonly thisTradeRiskPct: number;
  readonly maxHeatPct: number;

  readonly realisedTodayPct: number;
  readonly dailyLossLimitPct: number;

  /** Share of decision sources that answered, 0..1. */
  readonly coverage: number;
  /**
   * The most coverage THIS instrument could reach with every service healthy.
   *
   * 1 when nothing is structurally missing. Below 1 on anything the crypto
   * lanes do not cover: gold has no perpetual, no market-cap listing and one
   * book, so derivatives, fundamentals and cross-venue cannot answer on any
   * day. Measured on XAUUSD the ceiling is 79%, and the gate was checking a
   * 60% floor against it while saying "53% answered, your floor is 60%" — as
   * though the missing seven points were somewhere to be found.
   */
  readonly coverageCeiling: number;
  readonly coverageFloor: number;
  /**
   * Sources that TRIED and failed, by name.
   *
   * Distinct from the ones simply absent for this instrument. A failure is
   * fixable and an absence is not, and the coverage gate is the one place an
   * operator finds out which of the two is costing them a trade.
   */
  readonly sourcesFailed: readonly string[];

  readonly stopAtrMultiple: number;
  readonly saneAtrBand: readonly [number, number];
}

/**
 * A percentage, and never a rounded-away one.
 *
 * `toFixed(1)` turns every share under 0.05% into "0.0%", which reads as ZERO
 * — and a spread gate reporting "spread is 0.0% of the stop" is the same
 * sentence it would print if there were no spread at all. There is a real
 * measured cost there and it is simply small; "under 0.1%" says small, where
 * "0.0%" says none. The distinction cost this repository a bug report once
 * already, on a cross-instrument spread that genuinely was missing.
 */
/**
 * How far off an event is, in a unit a person reads without arithmetic.
 *
 * "in 2582 min" was measured on a live card. Nobody converts that; they see a
 * four-digit number next to the word "min" and either misread it as urgent or
 * skip the line. It is the same failure ui/countdown.ts documents fixing for
 * the bar clock — a minutes field with no hours branch counting down from
 * "239:59" — reappearing on a different clock a few hundred lines away.
 */
const awayIn = (mins: number): string => {
  if (mins < 90) return `${Math.round(mins)} min`;
  const hrs = mins / 60;
  if (hrs < 36) return `${hrs.toFixed(hrs < 10 ? 1 : 0)} hours`;
  const days = hrs / 24;
  return `${days.toFixed(days < 10 ? 1 : 0)} days`;
};

const pct = (n: number): string =>
  n > 0 && n < 0.05 ? "under 0.1%" : `${n.toFixed(n >= 10 ? 0 : 1)}%`;

/**
 * A quantity, at the precision the quantity deserves.
 *
 * Crypto sizes span eight orders of magnitude between a BTC position and a
 * SHIB one, so a fixed number of decimals either prints "0.00" for a real
 * position or six trailing zeros for a whole one.
 */
const trim = (n: number): string =>
  n >= 1000 ? n.toFixed(0) : n >= 1 ? String(Number(n.toFixed(3))) : n.toPrecision(3);

/** `18s` / `4m` / `2h` — an age, phrased the way you would say it out loud. */
function ageWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)}h`;
}

/**
 * Is the price underneath every other gate current, and on a clock we checked?
 *
 * Ordered worst-first. A feed nothing is refreshing is a harder failure than a
 * feed that is merely late, and both are harder than an unverified clock.
 */
function dataGate(i: GateInputs): Gate {
  if (i.dataTransport === "none") {
    return {
      id: "data",
      status: "block",
      text: "No live price — figures are from the last load.",
      clears: "Reload the symbol, or check Feed & network.",
      why: "Nothing is refreshing this instrument — no live stream and no poller — so every number below is as old as the last load.",
    };
  }

  if (i.dataAgeMs === null || !Number.isFinite(i.dataAgeMs)) {
    return {
      id: "data",
      status: "unknown",
      text: "Price age unknown.",
      why: "The age of the last price update is not available, so nothing below can be dated. This check has not passed; it has not been evaluated.",
    };
  }

  if (i.dataAgeMs > i.dataStaleAfterMs) {
    return {
      id: "data",
      status: "block",
      text: `Price is ${ageWords(i.dataAgeMs)} old (limit ${ageWords(i.dataStaleAfterMs)} on this timeframe).`,
      clears: "Wait for the feed, or check Feed & network.",
      why: "Spread, heat and event timing are all being read off this price, so a stale one makes them stale too.",
    };
  }

  /* An unmeasured broker clock is `unknown`, not `block`. It may well be
     correct — but "may well be" is exactly the state this gate exists to stop
     being invisible, and it was three hours wrong the one time it was checked. */
  if (i.clockMatters && i.clockOffsetMs === null) {
    return {
      id: "data",
      status: "unknown",
      text: "Broker clock not checked yet.",
      clears: "Feed & network shows it once the bridge reports one.",
      why: "This venue keeps its own server clock and the offset has not been measured, so bar times — and the news window read off them — are unverified. It was three hours wrong the one time it was checked.",
    };
  }

  const off = i.clockMatters && i.clockOffsetMs !== null && i.clockOffsetMs !== 0;
  return {
    id: "data",
    status: "pass",
    text: `Price is ${ageWords(i.dataAgeMs)} old${
      i.dataTransport === "poll" ? ", polled" : i.dataTransport === "socket" ? ", streaming" : ""
    }${off ? `, on a broker clock corrected by ${ageWords(Math.abs(i.clockOffsetMs as number))}` : ""}.`,
  };
}

/**
 * What the resolved record says, as a gate.
 *
 * Four states rather than pass/block, because "no record yet" and "a record
 * that supports this" are both passes and mean completely different things to
 * someone deciding whether to size up.
 */
function recordGate(record: Prior | null): Gate {
  if (record === null || record.standing === "unknown") {
    return {
      id: "record",
      status: "pass",
      /* PASS, not unknown — and the distinction matters more here than
         anywhere else on the card.
         
         The news gate answers `unknown` when the calendar fails to load,
         because an empty diary and a diary that did not arrive are different
         things and one of them is a hole in the evidence. An empty LEDGER is
         neither: it is the correct, expected state of every fresh install, and
         it stays that way until twenty claims resolve — which takes weeks.
         
         Answering `unknown` there would leave a permanently un-passable gate
         on a brand-new terminal, so the card would refuse every setup for its
         first month over an absence of history rather than a risk. The seven
         gates above are the safety checks; this one is a prior, and a prior
         with no data is silent, not negative. */
      text: `No track record for this setup yet (needs ${MIN_FOR_RATE} resolved calls).`,
      why: `A hit rate needs at least ${MIN_FOR_RATE} resolved calls on this setup. Until then this check passes and says nothing — an empty record is not evidence against the trade.`,
    };
  }

  if (record.standing === "against") {
    return {
      id: "record",
      status: "block",
      text: record.text,
      clears: "Nothing to change here — the record updates as more calls resolve.",
    };
  }

  return { id: "record", status: "pass", text: record.text };
}

/**
 * WAS THIS RULE BETTER THAN THE SEARCH THAT FOUND IT?
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A CHECK AND NOT A FOOTNOTE
 *
 * A search pays for every arm. Try 550 rules on a series with no edge at all and
 * the best of them still scores well above zero, purely because 550 draws from
 * noise have a maximum. `sqrt(2 ln N) / sqrt(n)` is what that maximum is worth,
 * and a winner below it is a result of the SEARCH rather than of the market.
 *
 * MEASURED ON THIS PRODUCT S OWN ARCHIVE. Deepening it from 42 days to 5 years
 * took the median arm from 58 trades to 821, which lowered the hurdle from +0.450
 * to +0.102 — and the best arm FELL from +0.374 to +0.070. Zero of 69 deep arms
 * cleared. The Simulation desk computes all of that and shows it; the card that
 * proposes the live trade did not consult it, so a rule that had not beaten noise
 * was offered with eight green ticks beside it, every one of them about the
 * market rather than about the rule s provenance.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * **It does not tune anything.** No threshold elsewhere on the card moves because
 * of this. It is an argument shown in the same voice as the rest, with its sample
 * attached, and the operator can read it and disagree.
 *
 * **It does not treat an uncountable search as a free one.** A zero or missing
 * trial count makes the hurdle zero and every rule clears it, which is the shape
 * of the status strip that painted "0 of 0 running" green. Unknown is its own
 * answer.
 */
function searchGate(s: SearchCost): Gate {
  const known =
    Number.isFinite(s.trials) &&
    s.trials >= 1 &&
    Number.isFinite(s.perTradeSharpe) &&
    Number.isFinite(s.trades) &&
    s.trades >= 1;
  if (!known) {
    return {
      id: "search",
      status: "unknown",
      text: "Cannot tell how wide the search was that found this rule.",
      clears:
        "Re-run the search, so the number of arms and the out-of-sample trades are recorded with the result.",
      why:
        "A rule found by trying many is worth less than the same rule chosen in advance, and the " +
        "correction needs both the number of arms and the out-of-sample trade count. Without them, " +
        "treating the search as free would make every rule clear a hurdle of zero.",
    };
  }

  /* ONE OWNER OF THE ARITHMETIC. `study/stats.ts` defines it on a per-trade
     Sharpe and takes a trade count; a second version of it here is a second
     place for the units to come apart, which is the whole risk. */
  const d = deflatedSharpe(s.perTradeSharpe, s.trials, s.trades);
  const arms = Math.round(s.trials).toLocaleString();
  const why =
    `${d.working} It was the best of ${arms} arms over ` +
    `${Math.round(s.trades).toLocaleString()} out-of-sample trades. The hurdle falls as the trades ` +
    `rise and rises as the arms do, so a wider search needs a better winner to mean the same thing.`;

  if (!(d.deflated > 0)) {
    return {
      id: "search",
      status: "block",
      text:
        `Best of ${arms} tried rules, and it did not beat what trying that many finds in nothing ` +
        `(${s.perTradeSharpe.toFixed(2)} against ${d.hurdle.toFixed(2)}).`,
      /* NOT ABOUT THIS TRADE. Nothing on this setup can fix a hurdle that
         belongs to the search, and offering "tighten the stop" would be a lie in
         the one place the operator is most likely to act on it. */
      clears:
        "Nothing on this trade changes it. The rule needs more out-of-sample trades behind it, or a " +
        "narrower search — a field padded with arms nobody believed in is charging for all of them.",
      why,
    };
  }

  return {
    id: "search",
    status: "pass",
    text:
      `Best of ${arms} tried rules, and it beat what trying that many finds in nothing by ` +
      `${d.deflated.toFixed(2)} of per-trade Sharpe.`,
    why,
  };
}

/**
 * Is the stop a sane distance, in ATR, against the operator's own band?
 *
 * Its own function so no branch of it can end `evaluateGates` early — one
 * did, and the track-record gate after it vanished whenever ATR was missing.
 */
function stopGate(i: GateInputs): Gate {
  const known = (...vals: number[]): boolean => vals.every((v) => Number.isFinite(v));
  const [lo, hi] = i.saneAtrBand;
  /* No plan means no stop. The view passes a stop distance of 0 then, and
     without this the multiple of 0 read as "0.00× ATR, too tight, widen it" —
     advice about a stop that did not exist. Same reading as the spread gate. */
  if (!(i.stopDistance > 0)) {
    return { id: "stop", status: "unknown", text: "No plan yet — no stop to check." };
  }
  if (!known(i.stopAtrMultiple, lo, hi)) {
    return {
      id: "stop",
      status: "unknown",
      text: "Stop size vs ATR not measurable yet.",
      why: "The stop distance could not be expressed in ATR — usually the chart has too few bars to measure one.",
    };
  }
  const sane = i.stopAtrMultiple >= lo && i.stopAtrMultiple <= hi;

  /**
   * WHAT THE ALTERNATIVE ACTUALLY COSTS, IN NUMBERS.
   *
   * "Wait for a closer level" was true and unusable: it named no level, no
   * size and no trade-off, so the only thing an operator could do with it was
   * either obey it or override it blind. Position size is inversely
   * proportional to stop distance, so the ratio between the current multiple
   * and the band edge IS the size difference, exactly, and it can be stated.
   *
   * The caveat is not optional and is why this is not a suggestion. Pulling
   * the stop in to the ceiling moves it INSIDE the structure the plan derived
   * it from — the level was chosen because price respects it, and a stop in
   * front of it gets taken out by the noise that level absorbs. A bigger
   * position behind a worse stop is not an improvement, and a card that
   * offered the arithmetic without that sentence would be recommending one.
   */
  const edge = i.stopAtrMultiple > hi ? hi : lo;
  const sizeRatio = i.stopAtrMultiple / edge;

  return {
    id: "stop",
    status: sane ? "pass" : "block",
    text: `Stop is ${i.stopAtrMultiple.toFixed(2)}× ATR (your range ${lo}–${hi}×).`,
    ...(sane
      ? {}
      : i.stopAtrMultiple < lo
        ? {
            clears: `Too tight — inside the noise. Widen it to ${lo}× ATR.`,
            why: `The stop is ${sizeRatio.toFixed(2)}× your ${lo}× minimum, so ordinary bar-to-bar movement reaches it. Widen it to ${lo}× ATR, or wait for a structure tight enough that ${lo}× clears the level.`,
          }
        : {
            clears: `Too wide — your size would be ${sizeRatio.toFixed(1)}× smaller. Wait for a closer level, or take the small size.`,
            why: `The stop is ${sizeRatio.toFixed(1)}× wider than your ${hi}× maximum, so the size is ${sizeRatio.toFixed(1)}× smaller than it would otherwise be. Pulling it in to ${hi}× ATR would put it INSIDE the level the plan took it from, where normal noise at that level would reach it — a bigger position behind a worse stop.`,
          }),
  };
}

/**
 * THE GATE INPUTS THAT ARE ABOUT THE MARKET, NOT ABOUT A PLAN.
 *
 * Of the twenty-six fields above, exactly four describe the trade being
 * proposed; the rest describe the feed, the calendar, the book, the account and
 * the operator's own thresholds, and are true whoever had the idea.
 *
 * Split out in v60.2 because the inspector's Autonomous card judges a plan that
 * came from a backtested rule rather than from a detector, and the owner asked
 * for the SAME eight checks. Building a second set of environment readings for
 * it would be two answers to "is there news in fourteen minutes" on one screen
 * — the class of defect `core/account.ts` records for equity. The Setup model
 * builds this once and both cards spend it.
 */
export type GateEnvironment = Omit<
  GateInputs,
  "record" | "stopDistance" | "plannedQty" | "thisTradeRiskPct" | "stopAtrMultiple"
>;

/** What a particular plan contributes to the checks. */
export interface PlanFacts {
  /** Entry to stop, in price. */
  readonly stopDistance: number;
  /** Null when the plan could not be sized — the spread gate then cannot ask
      whether the top of book holds it, and says so rather than assuming. */
  readonly plannedQty: number | null;
  readonly thisTradeRiskPct: number;
  /** The LIVE multiple, never the one frozen into the plan when it was drawn. */
  readonly stopAtrMultiple: number;
}

/**
 * The eight checks, over one environment and one plan.
 *
 * The only way to evaluate gates that both cards use, so neither can quietly
 * acquire a ninth check or drop one.
 */
/**
 * `search` IS REQUIRED, AND null IS A STATED ANSWER.
 *
 * Making it optional would let the live path silently omit the one check that
 * knows the rule came out of a 550-arm sweep, which is the state this argument
 * exists to end. A hand-drawn setup passes null and the search row is not shown
 * at all; a rule off the Discovered shelf passes its own recorded width. There is
 * no spelling of this call that forgets to decide.
 */
export function gatesFor(
  env: GateEnvironment,
  facts: PlanFacts,
  record: Prior | null,
  search: SearchCost | null,
): Gate[] {
  return evaluateGates({ ...env, ...facts, record, search });
}

export function evaluateGates(i: GateInputs): Gate[] {
  const gates: Gate[] = [];

  // --- the data the other gates are made of ------------------------------
  //
  // FIRST, because it is the one gate whose failure invalidates the rest. It
  // reports the WORST of three conditions rather than adding three rows to a
  // card that is already long: they have one answer between them — "should you
  // believe the numbers underneath" — and three separate ticks for it would be
  // three chances to skim past the one that mattered.
  gates.push(dataGate(i));

  // --- news embargo ------------------------------------------------------
  if (i.minutesToEvent === null) {
    gates.push({
      id: "news",
      status: "unknown",
      /* Unknown is NOT a pass. A calendar that failed to load must not read as
         "nothing scheduled" — that is the difference between an empty diary and
         no diary at all. */
      text: "News calendar unavailable.",
      clears: "Wait for it to load, or check the calendar yourself.",
      why: "The calendar did not answer, so a major release inside your no-trade window cannot be ruled out. A calendar that failed to load is not the same as an empty one.",
    });
  } else if (i.minutesToEvent <= i.embargoMinutes) {
    gates.push({
      id: "news",
      status: "block",
      text: `${i.eventName ?? "Major news"} in ${Math.max(0, Math.round(i.minutesToEvent))} min — inside your ${i.embargoMinutes}-min no-trade window.`,
      clears: `Wait ${Math.max(1, Math.ceil(i.minutesToEvent))} min.`,
    });
  } else {
    gates.push({
      id: "news",
      status: "pass",
      text: `No major news in the next ${i.embargoMinutes} min (next: ${i.eventName ?? "none scheduled"} in ${awayIn(i.minutesToEvent)}).`,
    });
  }

  // --- spread against the stop ------------------------------------------
  if (i.spread === null || !Number.isFinite(i.spread) || i.stopDistance <= 0) {
    gates.push({
      id: "spread",
      status: "unknown",
      text: "No spread data — entry cost not checked.",
    });
  } else {
    const share = (i.spread / i.stopDistance) * 100;
    const ok = share <= i.spreadBudgetPct;
    /* The stop distance at which this spread would exactly fit the budget. */
    const needed = i.spreadBudgetPct > 0 ? i.spread / (i.spreadBudgetPct / 100) : Infinity;
    const provenance =
      i.spreadKind === "dealing"
        ? "Measured from your broker's live bid-ask."
        : i.spreadKind === "book"
          ? "Measured from the live top of book at the venue that fills you."
          : i.spreadKind === "cross-venue"
            ? "Estimated from the gap between venues — a proxy for the dealing cost, not a measurement of it."
            : "";
    /* A two-word source tag on the short line: an ESTIMATE must never read as
       a measurement at a glance, even with the explanation folded away. */
    const source =
      i.spreadKind === "dealing" ? " (broker)" : i.spreadKind === "book" ? " (order book)" : i.spreadKind === "cross-venue" ? " (estimate)" : "";

    /**
     * Does the plan fit inside the quote it was priced with?
     *
     * A top-of-book spread is the cost of a trade that fits in the size
     * resting there. Quoting it for an order several times larger is the same
     * mistake the cross-venue basis made — a real number answering a different
     * question — so the one case where the quote does NOT apply gets said out
     * loud rather than being rounded into a pass.
     */
    const fit =
      i.spreadKind === "book" &&
      i.topOfBookQty !== null &&
      i.plannedQty !== null &&
      i.topOfBookQty > 0 &&
      i.plannedQty > 0
        ? i.plannedQty <= i.topOfBookQty
          ? ` Your ${trim(i.plannedQty)} fits inside the ${trim(i.topOfBookQty)} resting there.`
          : ` Your ${trim(i.plannedQty)} is larger than the ${trim(i.topOfBookQty)} resting there, so the real cost is higher than this — the rest walks the book.`
        : "";
    const why = `${provenance}${fit}`.trim();

    gates.push({
      id: "spread",
      status: ok ? "pass" : "block",
      text: `Spread is ${pct(share)} of the stop${source} — max ${pct(i.spreadBudgetPct)}.`,
      ...(why ? { why } : {}),
      ...(ok
        ? {}
        : {
            /**
             * THE ARITHMETIC, NOT THE ADVICE.
             *
             * "Wait for the spread to come in, or widen the stop deliberately"
             * is true and names no number, so the only two things it can
             * produce are obedience and a blind override. The stop distance
             * that WOULD fit the budget is a division, and stating it turns
             * the refusal into a choice: this is a scalp whose stop is too
             * tight for what the broker charges to enter, and the operator can
             * see by how much.
             *
             * A higher timeframe is named because it is the usual answer and
             * the cheapest: the same setup on a slower chart has a stop several
             * times wider and the same spread, so the share falls without
             * anybody taking more risk per trade.
             */
            clears: `Needs a stop of ${trim(needed)} or wider (${(needed / i.stopDistance).toFixed(1)}× the current ${trim(i.stopDistance)}). Wait for the spread to narrow, or use a higher timeframe.`,
          }),
    });
  }

  /**
   * AN INPUT THAT IS NOT A NUMBER IS `unknown`, NOT `block`.
   *
   * Every gate below is a `>=` or `<=` against a computed percentage, and
   * every comparison against NaN is false — so before this guard existed, an
   * unset account equity made `openHeatPct` NaN, the heat gate went to
   * `block`, and the card said "your heat limit is refusing this trade" while
   * printing `Open heat NaN% + this trade 1.0% = NaN%`.
   *
   * Failing closed was the right direction and the wrong CATEGORY. "Your rule
   * refused this" and "your rule could not be applied" send you to different
   * fixes — one to close a position, the other to Settings — and this file
   * already draws exactly that distinction for the news gate: an empty diary
   * is not the same as no diary. It now draws it everywhere.
   */
  const known = (...vals: number[]): boolean => vals.every((v) => Number.isFinite(v));

  // --- portfolio heat ----------------------------------------------------
  if (!known(i.openHeatPct, i.thisTradeRiskPct, i.maxHeatPct)) {
    gates.push({
      id: "heat",
      status: "unknown",
      text: "Open risk unknown — total-risk limit not checked.",
      clears: "Set your account equity in Settings ▸ Account & risk.",
    });
  } else {
    const after = i.openHeatPct + i.thisTradeRiskPct;
    const heatOk = after <= i.maxHeatPct;
    gates.push({
      id: "heat",
      status: heatOk ? "pass" : "block",
      text: `Open risk ${pct(i.openHeatPct)} + this trade ${pct(i.thisTradeRiskPct)} = ${pct(after)} (limit ${pct(i.maxHeatPct)}).`,
      ...(heatOk
        ? {}
        : { clears: `Close ${pct(after - i.maxHeatPct)} of open risk, or trade smaller.` }),
    });
  }

  // --- daily loss --------------------------------------------------------
  if (!known(i.realisedTodayPct, i.dailyLossLimitPct)) {
    gates.push({
      id: "daily",
      status: "unknown",
      text: "Today's P&L unknown — daily loss limit not checked.",
    });
  } else {
    const lossOk = i.realisedTodayPct > -i.dailyLossLimitPct;
    gates.push({
      id: "daily",
      status: lossOk ? "pass" : "block",
      text: `Today ${pct(i.realisedTodayPct)} (daily loss limit ${pct(-i.dailyLossLimitPct)}).`,
      ...(lossOk ? {} : { clears: "Tomorrow — the daily limit resets then." }),
    });
  }

  // --- coverage ----------------------------------------------------------
  if (!known(i.coverage, i.coverageFloor)) {
    gates.push({
      id: "coverage",
      status: "unknown",
      text: "Data coverage unknown.",
      why: "How many of the analysis sources answered is not known, so there is no way to say how much of the picture the read is based on.",
    });
  } else {
    const covPct = i.coverage * 100;
    const covOk = covPct >= i.coverageFloor;
    const ceilPct = Number.isFinite(i.coverageCeiling) ? i.coverageCeiling * 100 : 100;
    /* Only worth saying when it actually constrains: a ceiling of 100% is the
       normal case and mentioning it every time is noise. */
    const ceiling =
      ceilPct < 99.5
        ? ` The most this instrument can reach is ${pct(ceilPct)} — some sources do not exist for it.`
        : "";
    const coverageWhy =
      "Coverage is how much of the analysis actually answered, weighted by how much each source counts — a missing regime model matters more than a missing on-chain read.";
    /* A floor set above what the instrument can ever reach is not a rule being
       enforced, it is a rule that can never pass, and the operator has to be
       told which one they are looking at. */
    const unreachable = ceilPct < i.coverageFloor;

    /**
     * NAME THE SERVICE THAT IS DOWN, BECAUSE THAT IS THE ACTIONABLE HALF.
     *
     * "35% of sources answered — your floor is 60%" is true and useless: it
     * does not say whether this instrument simply has fewer sources or whether
     * something the operator could restart is not answering. Those two have
     * opposite responses — accept a thinner read, or go and start the service —
     * and the card was rendering them identically.
     *
     * `absent` sources are excluded on purpose: they are already accounted for
     * in the ceiling sentence above, and listing "cross-venue pricing covers
     * crypto pairs" as a fault on a gold chart would send somebody looking for
     * a problem that does not exist.
     */
    /* Defensive on a required field, deliberately. This function is the last
       thing between a read and a refusal, and the section above on NaN inputs
       makes the same argument: a gate that THROWS takes every other gate with
       it, so the card shows nothing at all rather than the six answers it had. */
    const failed = i.sourcesFailed ?? [];
    /* Stays on the short line: a failed source is the one actionable half. */
    const down = failed.length > 0 ? ` Failed: ${failed.join(", ")}.` : "";

    gates.push({
      id: "coverage",
      status: covOk ? "pass" : "block",
      /* "of the evidence", not "of sources". Coverage is answered WEIGHT over
         expected weight — a missing regime model and a missing on-chain read
         are not worth the same — so quoting it as a share of sources invited
         the reader to divide the visible counts and get a different number.
         Which is exactly what happened: the panel above said "8 of 13" while
         this line said 70%. */
      text: `Data coverage ${pct(covPct)} (min ${pct(i.coverageFloor)}).${down}`,
      why: `${coverageWhy}${ceiling}`,
      /* One `clears`, chosen by whether the floor is reachable at all. Two
         spreads here would have the second silently win — which it did, and the
         unreachable case never rendered. */
      ...(covOk
        ? {}
        : {
            clears: unreachable
              ? `This check cannot pass here: your ${pct(i.coverageFloor)} minimum is above the ${pct(ceilPct)} this instrument can reach. Lower the floor in Settings ▸ Trading rules.`
              : "Wait for the missing sources, or accept less data.",
          }),
    });
  }

  // --- stop sanity -------------------------------------------------------
  gates.push(stopGate(i));

  // --- the terminal's own record on this setup ---------------------------
  //
  // LAST, and that placement is the argument. Every gate above asks whether
  // the conditions are sane; this one asks whether this shape has ever WORKED
  // here — which is a different question and a weaker kind of evidence, and
  // putting it above the spread or the stop would give it a precedence the
  // sample size does not support.
  //
  // IT BLOCKS ONLY ON A SEPARATED INTERVAL, NEVER ON A POINT ESTIMATE.
  // Twelve losses from twenty is a 40% hit rate and an interval spanning 20%
  // to 64%, which is a coin toss with a bad run in it. Blocking on that would
  // be the terminal refusing trades because of noise, in the name of learning.
  // `Prior.standing` is "against" only when the whole Wilson interval sits
  // below even money over at least MIN_FOR_RATE resolved, out-of-sample claims.
  //
  // AND IT NEVER SILENTLY TUNES ANYTHING. No threshold above moves because of
  // this. The record is an argument shown in the same voice as the rest, with
  // its sample attached, and the operator can read it and disagree.
  /* --- what the search that found this rule cost -------------------------
   *
   * ABOVE THE RECORD AND BELOW EVERYTHING ELSE, and the placement is the
   * argument. Every gate above asks whether the conditions are sane right now.
   * This one asks whether the rule was ever real — a question about the EVIDENCE
   * rather than about the market — so it belongs with the record rather than
   * among the safety checks. It goes first of the two because it is the stronger
   * claim: the hurdle is computed from THIS rule s own out-of-sample trades,
   * where the record is a prior over a whole setup KIND.
   *
   * ONLY WHEN THERE WAS A SEARCH. A hand-drawn setup is not shown a row about a
   * search it never ran. */
  if (i.search !== undefined && i.search !== null) gates.push(searchGate(i.search));

  gates.push(recordGate(i.record ?? null));

  return gates;
}

/**
 * The five states, restored from v39.
 *
 * The rewrite shipped three and lost the two that describe most of a trading
 * day. `armed` is the state you are in almost all the time — the plan is
 * valid, your gates pass, and price simply has not arrived yet. Collapsing it
 * into `go` tells you to take a trade that is not available; collapsing it
 * into `stand-down` hides the level you are waiting for.
 *
 * `conflict` is v39's fourth: the gates pass and the macro lane disagrees with
 * the direction. Not a refusal — a reason to size down, said out loud.
 */
export type VerdictKind = "go" | "armed" | "conflict" | "stand-down" | "unknown";

/**
 * Net macro lean beyond which a disagreement is worth naming, 0..1.
 *
 * v39 used 0.15 and this keeps it. Below that the macro lane is not saying
 * anything a trade should be sized around, and flagging a conflict on a 0.04
 * lean would make the state meaningless through overuse.
 */
export const MACRO_CONFLICT_LEAN = 0.15;

export interface Verdict {
  readonly kind: VerdictKind;
  /** The headline. Never a claim about where price is going. */
  readonly headline: string;
  /** The read, repeated verbatim so a refusal is not misread as a direction. */
  readonly readLine: string;
  readonly blocking: readonly Gate[];
  readonly unknown: readonly Gate[];
  readonly passed: number;
  readonly total: number;
  /**
   * The price being waited for, when `armed`. Null in every other state.
   *
   * The nearest edge of the entry zone, so it is the level price actually has
   * to reach next — not the far edge, which would be a number you cannot act
   * on for another whole zone width.
   */
  readonly watchLevel: number | null;
  /** What the macro lane disagrees about, when `conflict`. */
  readonly conflictNote: string | null;
  /** The setup this plan came from, named. Null for a discretionary read. */
  readonly strategy: string | null;
}

export interface ReadContext {
  readonly direction: "long" | "short";
  readonly score: number;
  readonly coverage: number;
  /**
   * Where price is against the entry zone. Null when there is no plan.
   *
   * This is what separates `armed` from `go`: gates passing means you are
   * allowed to take the trade, not that the trade is there.
   */
  readonly trigger?: { readonly price: number; readonly entryLow: number; readonly entryHigh: number } | null;
  /**
   * Net macro lean, -1..+1, or null when nothing was measured.
   *
   * Null and zero are different: null is "the macro lane produced no evidence",
   * zero is "it measured, and it is neutral". Only the second is a finding.
   */
  readonly macroLean?: number | null;
  readonly strategy?: string | null;
}

/**
 * Turn the gates into a verdict.
 *
 * ANY block stands you down. That is deliberate and it is the user's own
 * standing choice: a checklist with a "mostly" is a checklist you negotiate
 * with. An `unknown` also stands you down, because a gate that could not be
 * checked has not been passed — the two are different words on screen but the
 * same answer, and the card says which.
 */
export function verdict(gates: readonly Gate[], read: ReadContext): Verdict {
  const blocking = gates.filter((g) => g.status === "block");
  const unknown = gates.filter((g) => g.status === "unknown");
  const passed = gates.filter((g) => g.status === "pass").length;

  const readLine = `Analysis leans ${read.direction.toUpperCase()} (score ${Math.round(read.score)}, ${Math.round(read.coverage * 100)}% of data).`;

  const strategy = read.strategy ?? null;
  const base = {
    readLine,
    blocking,
    unknown,
    passed,
    total: gates.length,
    watchLevel: null,
    conflictNote: null,
    strategy,
  } as const;

  /* Order is by CONSEQUENCE, most severe first — the same ordering rule
     `exit.ts` uses for its headline. A refusal outranks a warning, and a
     warning outranks an invitation. */

  if (blocking.length > 0) {
    return { ...base, kind: "stand-down", headline: "NO TRADE" };
  }

  if (unknown.length > 0) {
    return { ...base, kind: "unknown", headline: "CAN'T CHECK YET" };
  }

  /* CONFLICT — the gates pass and the macro lane disagrees.
     Not a refusal: the gates are your rules and they said yes. This is the
     card saying the wider tape is leaning the other way, which v39 phrased as
     "conviction LOW, size down or skip". */
  const lean = read.macroLean;
  if (lean !== null && lean !== undefined && Math.abs(lean) > MACRO_CONFLICT_LEAN) {
    const macroDir = lean > 0 ? "long" : "short";
    if (macroDir !== read.direction) {
      return {
        ...base,
        kind: "conflict",
        headline: `${read.direction.toUpperCase()} — against the wider market`,
        conflictNote:
          `Your checks pass, but the wider market leans ${macroDir} (${lean.toFixed(2)}). ` +
          `Low conviction: size down or skip. It is a correlation, not a rule — it can flip.`,
      };
    }
  }

  /* ARMED — everything passes and price simply has not arrived.
     The state you are in for most of a session, and the one the rewrite lost:
     folding it into `go` invites a trade that is not on offer, and folding it
     into `stand-down` hides the level you are waiting for. */
  const t = read.trigger;
  if (t) {
    const inZone = t.price >= t.entryLow && t.price <= t.entryHigh;
    if (!inZone) {
      /* The NEAR edge. The far edge is a price you cannot act on until a whole
         zone width later, and quoting it would make the level misleading. */
      const watch = t.price > t.entryHigh ? t.entryHigh : t.entryLow;
      const side = t.price > t.entryHigh ? "down to" : "up to";
      return {
        ...base,
        kind: "armed",
        headline: `ARMED — ${read.direction.toUpperCase()}`,
        watchLevel: watch,
        conflictNote: null,
        readLine:
          `${readLine} Waiting for price to come ${side} ${watch.toFixed(watch < 10 ? 4 : 2)}.`,
      };
    }
  }

  return {
    ...base,
    /* "your gates pass" — not "buy", not "good setup". The subject of this
       sentence is the rules, not the market. */
    kind: "go",
    headline: `${read.direction.toUpperCase()} — all checks pass`,
  };
}

/**
 * The line that must always be on the card.
 *
 * Not a tooltip, not a settings page. The PBO figure is the single most
 * important thing about the score this card is built on, and a card that
 * prints an entry, a stop and a lot size is exactly the surface that invites
 * someone to stop reading everything else.
 */
export const TRUST_LINE =
  "Caution: scores like this fail on new data about 9 times in 10 (PBO 89%). Use it as a prompt to look, never as a reason to trade.";
