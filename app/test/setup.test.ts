import { describe, expect, it } from "vitest";
import {
  buildPlan,
  planIsStale,
  stopAtrNow,
  REDRAW_ATR,
  stablePlan,
  type PlanResult,
  type TradePlan,
} from "../src/setup/plan";
import {
  evaluateGates,
  MACRO_CONFLICT_LEAN,
  TRUST_LINE,
  verdict,
  type Gate,
  type GateInputs,
} from "../src/setup/gates";

/** Everything the card lets the operator read about a gate: the short line,
    the action, and the explanation behind "Why?" (v59). A fact asserted here
    is a fact still on the card, whichever of the three it now lives in. */
const full = (g: Gate | undefined): string => [g?.text, g?.clears, g?.why].filter(Boolean).join(" ");

// ------------------------------------------------------------------ plan ---

const base = { direction: "long" as const, price: 100, atr: 2, swing: null };

const planOf = (over: Partial<typeof base> = {}) => {
  const r = buildPlan({ ...base, ...over });
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("buildPlan", () => {
  it("places the stop at the ATR floor when there is no swing", () => {
    const p = planOf();
    expect(p.stop).toBeCloseTo(98, 6);
    expect(p.stopFrom).toBe("volatility");
  });

  it("prefers a swing stop when it sits FURTHER from entry", () => {
    /* The swing is the level that would invalidate the idea; the ATR floor is
       only there so a tight swing cannot put the stop inside the noise. */
    const p = planOf({ swing: 96 });
    expect(p.stop).toBeCloseTo(96 - 2 * 0.15, 6);
    expect(p.stopFrom).toBe("structure");
  });

  it("keeps the ATR floor when the swing is nearer than the noise", () => {
    const p = planOf({ swing: 99.5 });
    expect(p.stop).toBeCloseTo(98, 6);
    expect(p.stopFrom).toBe("volatility");
  });

  it("mirrors correctly for a short", () => {
    const p = planOf({ direction: "short", swing: 104 });
    expect(p.stop).toBeCloseTo(104 + 0.3, 6);
    expect(p.target1).toBeLessThan(p.entry);
    expect(p.target2).toBeLessThan(p.target1);
  });

  it("puts targets at 1R and 2R", () => {
    const p = planOf();
    expect(p.r).toBeCloseTo(2, 6);
    expect(p.target1).toBeCloseTo(102, 6);
    expect(p.target2).toBeCloseTo(104, 6);
  });

  it("gives an entry ZONE, not a single tick", () => {
    const p = planOf();
    expect(p.entryLow).toBeLessThan(p.entry);
    expect(p.entryHigh).toBeGreaterThan(p.entry);
  });

  it("REFUSES when ATR is unavailable rather than inventing volatility", () => {
    /* A made-up volatility produces a real-looking stop and a real-looking
       size, which is the worst possible failure for this card. */
    const r = buildPlan({ ...base, atr: Number.NaN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ATR");
  });

  it("refuses without a price", () => {
    expect(buildPlan({ ...base, price: 0 }).ok).toBe(false);
  });

  it("refuses a stop that would land at or below zero", () => {
    expect(buildPlan({ ...base, price: 1, atr: 5 }).ok).toBe(false);
  });

  it("reports the stop distance in ATR", () => {
    expect(planOf({ swing: 94 }).stopAtrMultiple).toBeCloseTo((100 - (94 - 0.3)) / 2, 6);
  });
});

/* ==========================================================================
   THE PLAN AND THE GATE WERE FIGHTING EACH OTHER

   `buildPlan` prefers the structural stop whenever it sits further from entry
   than the volatility floor, with nothing bounding how far that is. The
   stop-sanity gate then refuses anything past the operator's ceiling. So on
   any chart whose nearest level happened to be more than a few ATR away, the
   builder chose a stop the gate was guaranteed to reject — every time — and
   the only thing the card could say was "wait for a closer level".

   Two individually correct rules pointing in opposite directions, producing a
   permanent stand-down that no market condition would ever clear. This is what
   "it is always stand down" turned out to mean.
   ========================================================================== */

describe("a structural stop the operator's own ceiling forbids", () => {
  /* price 100, atr 2, ceiling 3× — so any stop past 6 points is unusable. */
  const far = (): PlanResult =>
    buildPlan({ direction: "long", price: 100, atr: 2, swing: 70, maxAtrMultiple: 3 });

  it("is not proposed, because it could not be taken", () => {
    const p = far();
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.stopFrom).toBe("volatility");
    expect(p.stopAtrMultiple).toBeCloseTo(1, 6);
  });

  it("produces a plan the sanity gate actually passes", () => {
    const p = far();
    if (!p.ok) return;
    const gate = evaluateGates({ ...gateInput, stopAtrMultiple: p.stopAtrMultiple }).find(
      (g) => g.id === "stop",
    );
    expect(gate?.status).toBe("pass");
  });

  it("reports what it gave up rather than swallowing it", () => {
    /* The trade-off is real and belongs on screen: this stop can be hit
       without the idea being wrong. "Wait for a closer level" named nothing an
       operator could act on; a distance in ATR does. */
    const p = far();
    if (!p.ok) return;
    expect(p.structureOutOfReach).toBeCloseTo((100 - (70 - 0.3)) / 2, 6);
  });

  it("still takes a structural stop that fits inside the ceiling", () => {
    /* The preference is not being removed — the swing is the reason the trade
       is wrong if it breaks, and it stays the better stop whenever it is
       usable. */
    const p = buildPlan({ direction: "long", price: 100, atr: 2, swing: 96, maxAtrMultiple: 3 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.stopFrom).toBe("structure");
    expect(p.structureOutOfReach).toBeNull();
  });

  it("is unbounded when no ceiling is supplied, which is the old behaviour", () => {
    const p = buildPlan({ direction: "long", price: 100, atr: 2, swing: 70 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.stopFrom).toBe("structure");
    expect(p.structureOutOfReach).toBeNull();
  });

  it("applies to shorts on the correct side", () => {
    const p = buildPlan({ direction: "short", price: 100, atr: 2, swing: 130, maxAtrMultiple: 3 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.stopFrom).toBe("volatility");
    expect(p.stop).toBeCloseTo(102, 6);
    expect(p.structureOutOfReach).toBeGreaterThan(3);
  });
});

/* ==========================================================================
   THE STALE DENOMINATOR

   A plan is held still once drawn, on purpose — a stop that moves while you
   are reading it is a plan you cannot act on. `stopAtrMultiple` freezes with
   it, and the stop-sanity gate was reading that frozen field as if it were
   current. So the gate was answering a question about a moment that had
   passed.

   Measured on XAUUSD, switching 1m → 1h → 1m and touching nothing else:

       chart ATR      1.45  →  18.80  →  1.49
       card said     23.84× → 23.84× → 23.84×
       truth on 1h                1.83×

   On the hourly the card refused the trade for a stop "23.84× ATR, your sane
   band is 0.5–3×" when the real figure was 1.83× and would have passed. A
   permanent, unexplained stand-down out of a denominator nobody updated.
   ========================================================================== */

describe("stopAtrNow", () => {
  it("measures the stop against the ATR now, not the one it was drawn with", () => {
    const p = planOf({ atr: 2 });
    expect(p.stopAtrMultiple).toBeCloseTo(1, 6);
    /* Volatility has since risen fourfold. The stop has not moved and is now a
       quarter of the ATR — which is the number a sanity gate needs. */
    expect(stopAtrNow(p, 8)).toBeCloseTo(0.25, 6);
    /* And fallen. */
    expect(stopAtrNow(p, 0.5)).toBeCloseTo(4, 6);
  });

  it("agrees with the stored field at the moment of drawing", () => {
    const p = planOf({ atr: 2 });
    expect(stopAtrNow(p, 2)).toBeCloseTo(p.stopAtrMultiple, 9);
  });

  it("returns NaN rather than a number when there is no ATR to divide by", () => {
    /* Zero would read as "the stop is nothing", and the gate treats a
       non-finite input as `unknown` rather than as a block — which is the
       honest outcome when the denominator is missing. */
    const p = planOf({ atr: 2 });
    expect(Number.isNaN(stopAtrNow(p, 0))).toBe(true);
    expect(Number.isNaN(stopAtrNow(p, NaN))).toBe(true);
  });
});

describe("plan stability", () => {
  const drawn = (): TradePlan => planOf();

  it("is not stale while price stays near where it was drawn", () => {
    expect(planIsStale(drawn(), 100.5, 2, "long")).toBe(false);
  });

  it("is stale once price walks past the redraw distance", () => {
    /* Bracketed rather than tested AT the threshold: `100 + REDRAW_ATR * 2`
       minus 100 is 0.79999… in binary, so an exact-boundary assertion tests
       floating-point rounding rather than the rule. Price moves continuously,
       so the boundary is never landed on exactly in practice. */
    const threshold = REDRAW_ATR * 2; // 0.8 at atr 2
    expect(planIsStale(drawn(), 100 + threshold * 0.99, 2, "long")).toBe(false);
    expect(planIsStale(drawn(), 100 + threshold * 1.01, 2, "long")).toBe(true);
    expect(planIsStale(drawn(), 100 - threshold * 1.01, 2, "long")).toBe(true);
  });

  it("is stale the moment the direction flips", () => {
    expect(planIsStale(drawn(), 100, 2, "short")).toBe(true);
  });

  it("stablePlan returns the SAME numbers rather than nudged ones", () => {
    /* The point of the rule: a stop that moved while you were reading it is a
       plan you cannot act on. */
    const first = drawn();
    const again = stablePlan(first, { ...base, price: 100.6 });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.stop).toBe(first.stop);
      expect(again.entry).toBe(first.entry);
      expect(again.drawnAt).toBe(first.drawnAt);
    }
  });

  it("stablePlan redraws once price has genuinely moved", () => {
    const first = drawn();
    const again = stablePlan(first, { ...base, price: 101 });
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.drawnAt).toBe(101);
  });

  it("stablePlan draws fresh when there is nothing to keep", () => {
    expect(stablePlan(null, base).ok).toBe(true);
  });
});

// ----------------------------------------------------------------- gates ---

const gateInput: GateInputs = {
  /* A healthy feed, so the data gate is not the subject of these cases.
     See the "the data gate" block below for when it is. */
  dataAgeMs: 2_000,
  dataStaleAfterMs: 180_000,
  dataTransport: "socket",
  clockOffsetMs: 0,
  clockMatters: false,
  minutesToEvent: 600,
  eventName: "CPI",
  embargoMinutes: 30,
  spread: 1,
  spreadKind: "dealing",
  stopDistance: 100,
  spreadBudgetPct: 15,
  openHeatPct: 2,
  thisTradeRiskPct: 1,
  maxHeatPct: 6,
  realisedTodayPct: -0.4,
  dailyLossLimitPct: 3,
  coverage: 0.86,
  coverageFloor: 60,
  stopAtrMultiple: 1,
  saneAtrBand: [0.5, 3],
};

const byId = (i: Partial<GateInputs> = {}) => {
  const gates = evaluateGates({ ...gateInput, ...i });
  return new Map(gates.map((g) => [g.id, g]));
};

describe("evaluateGates", () => {
  it("passes a clean setup on every gate", () => {
    const gates = evaluateGates(gateInput);
    expect(gates.every((g) => g.status === "pass")).toBe(true);
    /* Eight since the record gate. The data gate is FIRST, because every gate
       after it is computed from a price, and a price nobody is refreshing makes
       the rest render as ticks without meaning anything. The record gate is
       LAST, because "has this shape worked here" is weaker evidence than any
       condition above it and must not outrank them. */
    expect(gates).toHaveLength(8);
    expect(gates[gates.length - 1]?.id).toBe("record");
    expect(gates[0]?.id).toBe("data");
  });

  it("blocks inside the news embargo and says how long to wait", () => {
    const g = byId({ minutesToEvent: 18, eventName: "FOMC statement" }).get("news");
    expect(g?.status).toBe("block");
    expect(g?.text).toContain("FOMC statement");
    expect(g?.clears).toContain("18");
  });

  it("treats a calendar that did not answer as UNKNOWN, never as a pass", () => {
    /* An empty diary and no diary at all are different facts. */
    const g = byId({ minutesToEvent: null }).get("news");
    expect(g?.status).toBe("unknown");
  });

  it("blocks when the spread eats too much of the stop, naming both numbers", () => {
    const g = byId({ spread: 30, stopDistance: 100 }).get("spread");
    expect(g?.status).toBe("block");
    expect(g?.text).toContain("30");
    expect(g?.text).toContain("15");
  });

  it("treats a missing spread as unknown rather than free", () => {
    expect(byId({ spread: null }).get("spread")?.status).toBe("unknown");
  });

  it("blocks on heat and says how much to close", () => {
    const g = byId({ openHeatPct: 5.4 }).get("heat");
    expect(g?.status).toBe("block");
    expect(g?.text).toContain("6.4");
    expect(g?.clears).toContain("0.4");
  });

  it("blocks once the daily loss limit is reached", () => {
    const g = byId({ realisedTodayPct: -3 }).get("daily");
    expect(g?.status).toBe("block");
    expect(g?.clears).toContain("Tomorrow");
  });

  it("blocks on thin coverage", () => {
    expect(byId({ coverage: 0.4 }).get("coverage")?.status).toBe("block");
  });

  it("blocks a stop inside the noise and one absurdly far away, differently", () => {
    const tight = byId({ stopAtrMultiple: 0.2 }).get("stop");
    const wide = byId({ stopAtrMultiple: 9 }).get("stop");
    expect(tight?.status).toBe("block");
    expect(wide?.status).toBe("block");
    expect(tight?.clears).toContain("inside the noise");
    expect(full(wide)).toContain("smaller than it would otherwise be");
  });

  it("a blocked stop states the size difference, not just that there is one", () => {
    /* "Wait for a closer level" named no level, no size and no trade-off, so
       the only two things it could produce were obedience and a blind
       override. Size is inversely proportional to stop distance, which makes
       the ratio an exact figure rather than an impression. */
    const wide = byId({ stopAtrMultiple: 9, saneAtrBand: [0.5, 3] }).get("stop");
    expect(wide?.clears).toContain("3.0×");
  });

  it("offering the tighter stop also states what it costs", () => {
    /* The arithmetic on its own reads as a recommendation. Pulling the stop in
       to the ceiling puts it inside the level the plan took it from, and a
       bigger position behind a worse stop is not an improvement. */
    const wide = byId({ stopAtrMultiple: 9 }).get("stop");
    expect(full(wide)).toContain("INSIDE the level");
  });

  it("every gate names its threshold, not just its result", () => {
    /* A gate you cannot argue with is a gate you learn to switch off. */
    for (const g of evaluateGates(gateInput)) {
      expect(g.text.length).toBeGreaterThan(20);
      expect(/\d/.test(g.text)).toBe(true);
    }
  });
});

describe("verdict", () => {
  const read = { direction: "long" as const, score: 78, coverage: 0.86 };

  it("passes when every gate passes, and says the RULES passed", () => {
    const v = verdict(evaluateGates(gateInput), read);
    expect(v.kind).toBe("go");
    expect(v.headline).toBe("LONG — all checks pass");
    // Eight with the record gate. It passes on an empty ledger, which is the
    // state of every fresh install — see `recordGate` for why "no history" is
    // a pass rather than an unknown.
    expect(v.passed).toBe(8);
  });

  it("ANY block stands you down", () => {
    const v = verdict(evaluateGates({ ...gateInput, openHeatPct: 5.4 }), read);
    expect(v.kind).toBe("stand-down");
    expect(v.blocking.map((g) => g.id)).toEqual(["heat"]);
  });

  it("an UNKNOWN gate also stands you down — not checked is not passed", () => {
    const v = verdict(evaluateGates({ ...gateInput, minutesToEvent: null }), read);
    expect(v.kind).toBe("unknown");
    expect(v.headline).toBe("CAN'T CHECK YET");
  });

  it("STAND DOWN carries the unchanged read, so it is never a direction", () => {
    /* A trader who reads a blocked setup as "bearish" has been misled by the
       thing meant to protect them. */
    const v = verdict(evaluateGates({ ...gateInput, openHeatPct: 9 }), read);
    expect(v.readLine).toContain("LONG");
    expect(v.readLine).toContain("78");
    expect(v.readLine).toContain("86%");
  });

  it("reports several blocks at once rather than only the first", () => {
    const v = verdict(
      evaluateGates({ ...gateInput, openHeatPct: 9, minutesToEvent: 5 }),
      read,
    );
    expect(v.blocking.map((g) => g.id).sort()).toEqual(["heat", "news"]);
  });

  it("the trust line names PBO and refuses to be a reason to trade", () => {
    expect(TRUST_LINE).toContain("89%");
    expect(TRUST_LINE.toLowerCase()).toContain("never as a reason to trade");
  });
});

/**
 * The two states v39 had and the rewrite lost.
 *
 * `armed` describes most of a trading day — plan valid, gates green, price not
 * there yet — and folding it into `go` invites a trade that is not on offer
 * while folding it into `stand-down` hides the level you are waiting for.
 */
describe("verdict · armed", () => {
  const read = { direction: "long" as const, score: 78, coverage: 0.86 };
  const zone = { entryLow: 100, entryHigh: 102 };
  const armed = (price: number) =>
    verdict(evaluateGates(gateInput), { ...read, trigger: { price, ...zone } });

  it("is GO only when price is actually inside the entry zone", () => {
    expect(armed(101).kind).toBe("go");
    expect(armed(100).kind).toBe("go");
    expect(armed(102).kind).toBe("go");
  });

  it("arms when price is above the zone, and watches the near edge", () => {
    const v = armed(110);
    expect(v.kind).toBe("armed");
    /* The NEAR edge — 102, not 100. The far edge is a price you cannot act on
       until a whole zone width later. */
    expect(v.watchLevel).toBe(102);
    expect(v.readLine).toContain("down to");
  });

  it("arms when price is below the zone, and watches the near edge there too", () => {
    const v = armed(90);
    expect(v.kind).toBe("armed");
    expect(v.watchLevel).toBe(100);
    expect(v.readLine).toContain("up to");
  });

  it("still names the direction, because armed is not a refusal", () => {
    expect(armed(110).headline).toBe("ARMED — LONG");
  });

  it("stays GO when there is no plan to compare price against", () => {
    expect(verdict(evaluateGates(gateInput), { ...read, trigger: null }).kind).toBe("go");
  });

  /* A blocking gate outranks everything: you cannot be armed for a trade your
     own rules are refusing. */
  it("never arms over a blocking gate", () => {
    const v = verdict(evaluateGates({ ...gateInput, openHeatPct: 9 }), {
      ...read,
      trigger: { price: 110, ...zone },
    });
    expect(v.kind).toBe("stand-down");
    expect(v.watchLevel).toBeNull();
  });
});

describe("verdict · conflict", () => {
  const read = { direction: "long" as const, score: 78, coverage: 0.86 };
  const withLean = (macroLean: number | null) =>
    verdict(evaluateGates(gateInput), {
      ...read,
      macroLean,
      trigger: { price: 101, entryLow: 100, entryHigh: 102 },
    });

  it("flags a macro lane leaning the other way", () => {
    const v = withLean(-0.5);
    expect(v.kind).toBe("conflict");
    expect(v.conflictNote).toContain("size down or skip");
    expect(v.conflictNote).toContain("short");
  });

  it("says nothing when the macro lane agrees", () => {
    expect(withLean(0.5).kind).toBe("go");
  });

  it("ignores a lean too small to be worth sizing around", () => {
    expect(withLean(-0.1).kind).toBe("go");
    expect(withLean(-MACRO_CONFLICT_LEAN).kind).toBe("go");
  });

  /**
   * Null and zero are different facts. Null is "no macro series is loaded or
   * correlated enough to speak"; zero is "measured, and neutral". Only the
   * second is a finding, and neither should raise a conflict.
   */
  it("treats an absent macro read as absent, not as neutral disagreement", () => {
    expect(withLean(null).kind).toBe("go");
    expect(withLean(0).kind).toBe("go");
  });

  /* Conflict is a warning, not a refusal — but a real refusal still outranks
     it, or a blocked trade would be reported as merely low-conviction. */
  it("never outranks a blocking gate", () => {
    const v = verdict(evaluateGates({ ...gateInput, openHeatPct: 9 }), {
      ...read,
      macroLean: -0.9,
    });
    expect(v.kind).toBe("stand-down");
    expect(v.conflictNote).toBeNull();
  });

  it("admits the correlation is current rather than a rule", () => {
    expect(withLean(-0.5).conflictNote).toMatch(/not a rule/);
  });
});

describe("verdict · the named strategy", () => {
  const read = { direction: "long" as const, score: 78, coverage: 0.86 };

  /* v39 named the setup that fired. Without it "STAND DOWN" has no subject and
     you cannot tell which of thirteen detectors the card means. */
  it("carries the strategy through every state", () => {
    for (const extra of [
      {},
      { trigger: { price: 110, entryLow: 100, entryHigh: 102 } },
      { macroLean: -0.9, trigger: { price: 101, entryLow: 100, entryHigh: 102 } },
    ]) {
      const v = verdict(evaluateGates(gateInput), { ...read, ...extra, strategy: "sweep-reclaim" });
      expect(v.strategy, v.kind).toBe("sweep-reclaim");
    }
  });

  it("is null for a discretionary read rather than inventing a name", () => {
    expect(verdict(evaluateGates(gateInput), read).strategy).toBeNull();
  });
});

/* ===========================================================================
   A GATE THAT CANNOT BE MEASURED IS `unknown`, NOT `block`

   These failed in the SAFE direction — NaN fails every comparison, so the gate
   went to `block` — and in the WRONG CATEGORY. The card then said "your heat
   limit is refusing this trade" while printing `Open heat NaN% + this trade
   1.0% = NaN%`. "Your rule refused this" and "your rule could not be applied"
   send you to different fixes: one to close a position, the other to Settings.

   This file already drew that distinction for the news gate — an empty diary
   is not the same as no diary at all. It now draws it everywhere.
   ========================================================================= */

describe("gates with unmeasured inputs", () => {
  const gi: GateInputs = {
    /* A healthy feed, so the data gate is not the subject of these cases.
       See the "the data gate" block below for when it is. */
    dataAgeMs: 2_000,
    dataStaleAfterMs: 180_000,
    dataTransport: "socket",
    clockOffsetMs: 0,
    clockMatters: false,
    minutesToEvent: 120,
    eventName: "CPI",
    embargoMinutes: 30,
    spread: 0.5,
    spreadKind: "dealing",
    stopDistance: 10,
    spreadBudgetPct: 10,
    openHeatPct: 1,
    thisTradeRiskPct: 1,
    maxHeatPct: 6,
    realisedTodayPct: -0.5,
    dailyLossLimitPct: 3,
    coverage: 0.8,
    coverageCeiling: 1,
    coverageFloor: 40,
    stopAtrMultiple: 1,
    saneAtrBand: [0.5, 4],
  };

  const statusOf = (i: GateInputs, id: string): string =>
    evaluateGates(i).find((g) => g.id === id)?.status ?? "missing";
  const textOf = (i: GateInputs, id: string): string =>
    evaluateGates(i).find((g) => g.id === id)?.text ?? "";

  it("passes everything when every input is known", () => {
    expect(evaluateGates(gi).every((g) => g.status === "pass")).toBe(true);
  });

  it("marks heat unknown when equity upstream made it NaN", () => {
    expect(statusOf({ ...gi, openHeatPct: NaN }, "heat")).toBe("unknown");
    expect(statusOf({ ...gi, thisTradeRiskPct: NaN }, "heat")).toBe("unknown");
  });

  it("marks the daily stop unknown when the day's P&L has not loaded", () => {
    expect(statusOf({ ...gi, realisedTodayPct: NaN }, "daily")).toBe("unknown");
  });

  it("marks coverage unknown rather than failing it", () => {
    expect(statusOf({ ...gi, coverage: NaN }, "coverage")).toBe("unknown");
  });

  it("marks the stop gate unknown when no ATR was measured", () => {
    expect(statusOf({ ...gi, stopAtrMultiple: NaN }, "stop")).toBe("unknown");
  });

  /* "NaN%" on the face of a card that decides position size is not a cosmetic
     defect — it is the tool telling you a number it does not have. */
  it("never prints NaN in a gate's own sentence", () => {
    for (const broken of [
      { ...gi, openHeatPct: NaN },
      { ...gi, realisedTodayPct: NaN },
      { ...gi, coverage: NaN },
      { ...gi, stopAtrMultiple: NaN },
      { ...gi, thisTradeRiskPct: NaN },
    ]) {
      for (const g of evaluateGates(broken)) {
        expect(g.text, `${g.id}: ${g.text}`).not.toMatch(/NaN/);
        expect(g.clears ?? "").not.toMatch(/NaN/);
      }
    }
  });

  /* Still refuses to let the trade through — the direction was always right. */
  it("does not turn an unmeasured gate into a passing one", () => {
    for (const broken of [
      { ...gi, openHeatPct: NaN },
      { ...gi, realisedTodayPct: NaN },
      { ...gi, coverage: NaN },
    ]) {
      expect(evaluateGates(broken).every((g) => g.status === "pass")).toBe(false);
    }
  });

  it("keeps the stop gate reporting a real out-of-band multiple as a block", () => {
    expect(statusOf({ ...gi, stopAtrMultiple: 9 }, "stop")).toBe("block");
    expect(textOf({ ...gi, stopAtrMultiple: 9 }, "stop")).toMatch(/9\.00× ATR/);
  });
});

/* ==========================================================================
   THE DATA GATE

   Added after the terminal was measured running on a broker feed stamped
   exactly three hours into the future, with nothing polling it. Both faults
   were invisible: the chart drew, the gates ticked, and the six checks below
   this one were all being computed against a price that had stopped arriving
   and a clock nobody had verified.

   A gate is the right home for it because a gate REFUSES. A coloured chip does
   not.
   ========================================================================== */

describe("the stop gate with no plan", () => {
  /* v59, seen on screen: with no setup there is no plan, the view passes a
     stop distance of 0 and a stop-ATR multiple of 0, and the card said "Stop
     is 0.00× ATR — too tight, widen it to 0.5× ATR" about a stop that did not
     exist. A check with nothing to check is unknown, never a refusal with
     advice attached. The spread gate beside it already reads it that way. */
  const noPlan: GateInputs = { ...gateInput, stopDistance: 0, stopAtrMultiple: 0 };

  it("does not refuse a stop that does not exist", () => {
    const g = evaluateGates(noPlan).find((x) => x.id === "stop");
    expect(g?.status).toBe("unknown");
    expect(g?.clears).toBeUndefined();
    expect(g?.text).not.toMatch(/0\.00× ATR/);
    /* ONE stop gate. A half-done fix pushed the unknown one AND fell through to
       the refusal; `find` returned the first and this test passed anyway. */
    expect(evaluateGates(noPlan).filter((x) => x.id === "stop")).toHaveLength(1);
  });

  it("keeps checking the gates after it when the stop cannot be measured", () => {
    /* The unmeasurable branch used to `return gates` early, so the track-record
       gate after it silently vanished from the card whenever ATR was missing. */
    const ids = evaluateGates({ ...gateInput, stopAtrMultiple: NaN }).map((g) => g.id);
    expect(ids).toContain("stop");
    expect(ids).toContain("record");
  });

  it("still refuses a real stop that is too tight", () => {
    const g = evaluateGates({ ...gateInput, stopAtrMultiple: 0.2 }).find((x) => x.id === "stop");
    expect(g?.status).toBe("block");
  });
});

describe("the data gate", () => {
  const base: GateInputs = {
    dataAgeMs: 2_000,
    dataStaleAfterMs: 180_000,
    dataTransport: "socket",
    clockOffsetMs: 0,
    clockMatters: false,
    minutesToEvent: 600,
    eventName: "CPI",
    embargoMinutes: 30,
    spread: 1,
    spreadKind: "dealing",
    stopDistance: 100,
    spreadBudgetPct: 15,
    openHeatPct: 2,
    thisTradeRiskPct: 1,
    maxHeatPct: 6,
    realisedTodayPct: 0,
    dailyLossLimitPct: 3,
    coverage: 0.9,
    coverageCeiling: 1,
    coverageFloor: 0.6,
    sourcesFailed: [],
    stopAtrMultiple: 1.5,
    saneAtrBand: [0.5, 4],
  };
  const data = (over: Partial<GateInputs>): Gate =>
    evaluateGates({ ...base, ...over }).find((g) => g.id === "data") as Gate;

  it("is the first gate, ahead of everything computed from the price", () => {
    expect(evaluateGates(base)[0]?.id).toBe("data");
  });

  it("passes a current streaming feed and says how old the price is", () => {
    const g = data({});
    expect(g.status).toBe("pass");
    expect(g.text).toMatch(/2s old/);
    expect(g.text).toMatch(/streaming/);
  });

  /**
   * THE SHIPPED FAULT. `startLive` found no socket on the MT5 source and
   * returned, so nothing anywhere was ever going to ask again. This is a
   * refusal, not a warning: the price is as old as the page.
   */
  it("refuses outright when nothing at all is refreshing the price", () => {
    const g = data({ dataTransport: "none", dataAgeMs: 1_000 });
    expect(g.status).toBe("block");
    expect(full(g)).toMatch(/no live stream and no poller/i);
  });

  it("refuses a stale feed and names both the age and the threshold", () => {
    const g = data({ dataAgeMs: 218_000 });
    expect(g.status).toBe("block");
    expect(g.text).toMatch(/4 min old/);
    expect(g.text).toMatch(/3 min/);
    /* Naming what else is downstream is the point — the operator must not read
       "stale feed" as cosmetic while the spread gate ticks beneath it. */
    expect(full(g)).toMatch(/Spread, heat and event timing/);
  });

  /**
   * `unknown`, not `block`, and NOT `pass`. The clock may well be right; it was
   * three hours wrong the one time anybody measured it. An unverified clock is
   * a thing to be told about, not a thing to be refused for.
   */
  it("says so when a broker's own clock has not been measured", () => {
    const g = data({ clockMatters: true, clockOffsetMs: null });
    expect(g.status).toBe("unknown");
    expect(full(g)).toMatch(/own server clock/);
  });

  /* A venue that stamps in UTC has nothing to verify, and putting a permanent
     "unverified" on Binance would teach the operator to ignore the row. */
  it("does not ask a UTC venue to prove a clock it does not keep", () => {
    expect(data({ clockMatters: false, clockOffsetMs: null }).status).toBe("pass");
  });

  it("reports a correction that was applied rather than hiding it", () => {
    const g = data({ clockMatters: true, clockOffsetMs: 10_800_000, dataTransport: "poll" });
    expect(g.status).toBe("pass");
    expect(g.text).toMatch(/polled/);
    expect(g.text).toMatch(/corrected by 3h/);
  });

  it("is unknown, never pass, when the age itself is unavailable", () => {
    const g = data({ dataAgeMs: null });
    expect(g.status).toBe("unknown");
    expect(full(g)).toMatch(/not available/);
  });

  /* Order matters: a feed that is BOTH unpolled and stale is a "nothing is
     asking" problem, and telling the operator to wait for it to catch up would
     be advice that never comes good. */
  it("reports the harder fault first when two apply at once", () => {
    expect(full(data({ dataTransport: "none", dataAgeMs: 900_000 }))).toMatch(/no live stream/i);
  });
});

/* ==========================================================================
   WHICH SPREAD

   The spread gate asks what entering COSTS. For years the only number it could
   have was `data/spread.ts`'s cross-venue basis — the disagreement between
   exchanges — which is a proxy for the dealing cost and a poor one: it
   overstates on a calm day and understates during exactly the dislocations
   where entering is dangerous. On anything the crypto venues do not quote there
   was no number at all, so on every forex and metals instrument this gate said
   "cannot be checked" while `mt5_bridge.tick()` had the real bid-ask the whole
   time and nothing had ever called it.

   Both sources stay accepted. The gate has to SAY which one it used, because
   "8% of your stop" means something different depending.
   ========================================================================== */

describe("the spread gate names its source", () => {
  const spreadGate = (over: Partial<GateInputs>): Gate =>
    evaluateGates({ ...gateInput, ...over }).find((g) => g.id === "spread") as Gate;

  it("says when the cost was measured rather than inferred", () => {
    const g = spreadGate({ spread: 1, stopDistance: 100, spreadKind: "dealing" });
    expect(g.status).toBe("pass");
    expect(full(g)).toMatch(/broker's live bid-ask/);
  });

  it("distinguishes an exchange's top of book from a broker's quote", () => {
    /* Both are dealing costs, and they carry different guarantees. A broker's
       quote is the price it will deal at. An exchange's best bid and ask are
       resting orders you have to fit inside. */
    const g = spreadGate({ spread: 0.01, stopDistance: 134, spreadKind: "book" });
    expect(g.status).toBe("pass");
    expect(full(g)).toMatch(/live top of book/);
  });

  it("says when the plan is larger than the quote it was priced with", () => {
    /* Quoting a top-of-book spread for an order several times larger is the
       same mistake as the cross-venue basis: a real number answering a
       different question. The rest of the order walks the book. */
    const g = spreadGate({
      spread: 0.01,
      stopDistance: 134,
      spreadKind: "book",
      topOfBookQty: 1.4,
      plannedQty: 5,
    });
    expect(full(g)).toMatch(/larger than/);
    expect(full(g)).toMatch(/walks the book/);
  });

  it("says when it fits, so the quote can be believed", () => {
    const g = spreadGate({
      spread: 0.01,
      stopDistance: 134,
      spreadKind: "book",
      topOfBookQty: 1.4,
      plannedQty: 0.13,
    });
    expect(full(g)).toMatch(/fits inside/);
  });

  it("says nothing about depth for a broker quote, which has none to compare", () => {
    const g = spreadGate({
      spread: 1,
      stopDistance: 100,
      spreadKind: "dealing",
      topOfBookQty: 1.4,
      plannedQty: 5,
    });
    expect(g.text).not.toMatch(/resting there/);
  });

  it("says what stop WOULD fit the spread, rather than only refusing", () => {
    /* Measured on XAUUSD 1m: broker spread 0.18 against a 1.2-point stop is
       15% of the risk before the trade starts. That refusal is correct and it
       was a dead end — "wait for the spread to come in" names no number, so
       the only two responses are obedience and a blind override. */
    const g = spreadGate({ spread: 0.18, stopDistance: 1.2, spreadKind: "dealing", spreadBudgetPct: 10 });
    expect(g.status).toBe("block");
    expect(g.clears).toMatch(/1\.8/);
    expect(g.clears).toMatch(/higher timeframe/);
  });

  it("never prints a real cost as 0.0%", () => {
    /* A real spread rounded to "0.0%" is the same sentence the card prints
       when there is no spread reading at all. Small and absent are different
       findings and this repository has already shipped one as the other. */
    const g = spreadGate({ spread: 0.01, stopDistance: 134, spreadKind: "book" });
    expect(g.text).not.toMatch(/is 0\.0% of the stop/);
    expect(g.text).toMatch(/under 0\.1%/);
  });

  /* The proxy is still allowed. It just has to admit what it is. */
  it("marks a cross-venue estimate as an estimate", () => {
    const g = spreadGate({ spread: 1, stopDistance: 100, spreadKind: "cross-venue" });
    expect(full(g)).toMatch(/proxy for the dealing cost, not a measurement/);
  });

  it("still blocks on cost, whichever source it came from", () => {
    for (const kind of ["dealing", "cross-venue"] as const) {
      const g = spreadGate({ spread: 40, stopDistance: 100, spreadKind: kind });
      expect(g.status, kind).toBe("block");
    }
  });

  /* No source is `unknown`, never `pass` — an unmeasured cost is not a free one. */
  it("refuses to check when there is no spread at all", () => {
    const g = spreadGate({ spread: null, spreadKind: null });
    expect(g.status).toBe("unknown");
  });
});

/* ==========================================================================
   A FLOOR ABOVE THE CEILING

   The coverage gate refuses a read standing on too little evidence, and the
   floor is the operator's own rule. What it never checked was whether the floor
   was REACHABLE on the instrument in front of it.

   Measured on XAUUSD: gold has no perpetual, no market-cap listing and one
   book, so derivatives (0.7), fundamentals (0.4) and cross-venue (0.3) cannot
   answer on any day, at any hour, however healthy every service is. That is 21%
   of the expected weight, permanently. A 60% floor was therefore being asked of
   a 79% ceiling — and the card said "53% of sources answered — your floor is
   60%", which reads as though the missing seven points were somewhere to be
   found.

   A gate that cannot pass is still allowed to refuse. It is not allowed to
   refuse silently, as though the operator had failed to do something.
   ========================================================================== */

describe("the coverage gate knows what was reachable", () => {
  const cov = (over: Partial<GateInputs>): Gate =>
    evaluateGates({ ...gateInput, ...over }).find((g) => g.id === "coverage") as Gate;

  it("says nothing about a ceiling when everything could have answered", () => {
    const g = cov({ coverage: 0.9, coverageCeiling: 1, coverageFloor: 60 });
    expect(g.status).toBe("pass");
    expect(g.text).not.toMatch(/ceiling|can reach/i);
  });

  it("names the ceiling when the instrument cannot reach 100%", () => {
    const g = cov({ coverage: 0.53, coverageCeiling: 0.79, coverageFloor: 60 });
    expect(g.status).toBe("block");
    expect(full(g)).toMatch(/most this instrument can reach is 79%/);
  });

  /**
   * THE ONE THAT WAS SILENTLY UNWINNABLE. A floor above the ceiling is not a
   * rule being enforced — it is a rule that can never pass, and every trade on
   * that instrument is refused for a reason the operator cannot act on until
   * somebody tells them the rule itself is the problem.
   */
  it("says plainly when the floor can never be met on this instrument", () => {
    const g = cov({ coverage: 0.53, coverageCeiling: 0.55, coverageFloor: 60 });
    expect(g.status).toBe("block");
    expect(g.clears).toMatch(/cannot pass here/);
    expect(g.clears).toMatch(/Lower the floor/);
  });

  /* When the floor IS reachable, the advice must not say it is hopeless — the
     operator can load the missing lanes. */
  it("does not cry unwinnable when the gap is merely unfilled", () => {
    const g = cov({ coverage: 0.4, coverageCeiling: 0.9, coverageFloor: 60 });
    expect(g.status).toBe("block");
    expect(g.clears ?? "").not.toMatch(/cannot pass here/);
  });

  it("still passes on a reachable floor with a reduced ceiling", () => {
    expect(cov({ coverage: 0.75, coverageCeiling: 0.79, coverageFloor: 60 }).status).toBe("pass");
  });
});
