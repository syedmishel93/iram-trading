// @vitest-environment jsdom
/**
 * The Setup card's rendered structure.
 *
 * The row and label classes are `pk-*` — the card was the first thing to get
 * this treatment, and the markup has since been lifted into `ui/panelkit.ts`
 * so the other eight dock panels speak the same grammar. These assertions
 * moved with it; they are about the SHAPE, which did not change.
 *
 * WHY A DOM TEST AND NOT A LAYOUT ONE
 * The bug that produced "the right side card is too big" was a CSS grid whose
 * value column was `auto` — it took its max-content width and starved every
 * label to 25px, so "Target 1 · 1R" wrapped to three lines. jsdom has no
 * layout engine, so no test here can catch that; only the browser can, and it
 * did.
 *
 * What a test CAN pin is the structure the fix depends on. The grid can only
 * size a label column against labels if the qualifier that used to be glued
 * onto the value ("458.2093 · 1.00× ATR, from volatility") is a separate node,
 * and the section label can only stay one line if its term and its sentence
 * are separate nodes. Both are invariants a future edit could quietly undo by
 * going back to string concatenation, and the card would grow by a third again
 * with every test still green.
 *
 * The plan-visibility rules are here for the same reason: they have been
 * reversed once already.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { signal } from "../src/core/signal";
import { createSetupCard, type SetupView } from "../src/setup/ui";
import type { Gate, Verdict, VerdictKind } from "../src/setup/gates";
import type { TradePlan } from "../src/setup/plan";

const PLAN: TradePlan = {
  direction: "long",
  entryLow: 76_989.45,
  entryHigh: 77_218.55,
  entry: 77_104,
  stop: 77_562.21,
  target1: 76_645.79,
  target2: 76_187.58,
  r: 458.2093,
  stopAtrMultiple: 1,
  stopFrom: "volatility",
  structureOutOfReach: null,
  drawnAt: 77_104,
};

const GATES: readonly Gate[] = [
  { id: "event", status: "pass", text: "No high-impact event within 30 min." },
  { id: "spread", status: "block", text: "Spread is 4.1× its median.", clears: "Wait for it to settle." },
];

const verdictOf = (kind: VerdictKind): Verdict => ({
  kind,
  headline: kind === "stand-down" ? "STAND DOWN" : "GO",
  readLine: "The read is unchanged: SHORT, score 21, on 24% coverage.",
  blocking: kind === "stand-down" ? [GATES[1] as Gate] : [],
  unknown: [],
  passed: 1,
  total: 2,
  watchLevel: null,
  conflictNote: null,
  strategy: "bos",
});

const viewOf = (kind: VerdictKind): SetupView => ({
  verdict: verdictOf(kind),
  plan: PLAN,
  /* The LIVE ratio, not `PLAN.stopAtrMultiple`. They are the same here and
     deliberately not the same thing: the plan's copy freezes at draw time
     while the plan is held still, and rendering that one made the card state a
     ratio from a moment that had passed. See `stopAtrNow` in setup/plan.ts. */
  stopAtrLive: 1,
  planProblem: null,
  size: {
    qty: "0.1297",
    riskMoney: "USD 59.43",
    riskPct: "0.59% of equity",
    notional: "USD 10,000",
    margin: "USD 100",
  },
  gates: GATES,
  symbol: "BTCUSDT",
  timeframe: "1h",
  record: null,
  learned: null,
  exit: null,
  evidence: null,
  history: null,
});

const render = (view: SetupView | null): HTMLElement => {
  const s = signal<SetupView | null>(view);
  return createSetupCard({
    view: s,
    onCopyToCalculator: () => {},
    onOpenDecision: () => {},
    onDeepen: () => {},
  });
};

const texts = (el: HTMLElement, sel: string): string[] =>
  [...el.querySelectorAll(sel)].map((n) => (n.textContent ?? "").trim());

/**
 * The base-rate strip.
 *
 * What is pinned here is what the strip must NEVER do: print a rate without
 * the sample behind it, print a hit rate without the break-even the plan's R
 * demands, or offer a control that cannot change the answer.
 */
describe("the history strip", () => {
  const HIST = {
    note: "41 of 87 reached target — 47%, at least 37% with 95% confidence, +0.02R per attempt at 2R.",
    n: 87,
    wins: 41,
    hitRate: 0.47,
    hitLow: 0.37,
    expectancy: 0.02,
    breakEven: 1 / 3,
    medianBars: 6,
    enough: true,
    adverse: false,
    bars: 5998,
    canDeepen: false,
    busy: false,
    progress: "",
    disagreement: "",
    alternatives: [] as string[],
    fieldNote: "10 setup kinds have a record here; 3 clear break-even.",
  };
  const withHist = (over: Partial<typeof HIST> = {}): SetupView => ({
    ...viewOf("go"),
    history: { ...HIST, ...over },
  });

  it("shows the sample size before any rate", () => {
    const card = render(withHist());
    const keys = texts(card, ".setup-hist-k");
    expect(keys[0]).toBe("sample");
    expect(texts(card, ".setup-hist-v")[0]).toBe("87");
  });

  it("prints the break-even beside the hit rate, never alone", () => {
    /* 47% is a losing setup at 2R. A card showing the hit rate with no
       reference point invites the reader to supply 50%, which is right at 1R
       and wrong here. */
    const card = render(withHist());
    const keys = texts(card, ".setup-hist-k");
    expect(keys).toContain("hit");
    expect(keys).toContain("break-even");
  });

  it("suppresses every rate on a thin sample rather than dimming it", () => {
    /* A greyed-out number still gets read. */
    const card = render(withHist({ n: 4, wins: 3, enough: false }));
    const keys = texts(card, ".setup-hist-k");
    expect(keys).toEqual(["sample"]);
    expect(card.querySelector(".setup-hist-stat[data-tone='thin']")).not.toBeNull();
  });

  it("says an adverse history in words, not only in colour", () => {
    const card = render(withHist({ adverse: true }));
    expect(card.querySelector(".setup-hist-warn")?.textContent ?? "").toMatch(/reason to skip it/i);
  });

  it("offers to reach further back only when that could change the answer", () => {
    expect(render(withHist({ n: 4, enough: false, canDeepen: true })).querySelector(".setup-hist-deepen")).not.toBeNull();
    /* Already deep: the button would page a vendor and return the same sample. */
    expect(render(withHist({ n: 4, enough: false, canDeepen: false })).querySelector(".setup-hist-deepen")).toBeNull();
    /* Already enough: nothing to fix. */
    expect(render(withHist({ canDeepen: true })).querySelector(".setup-hist-deepen")).toBeNull();
  });

  it("renders the disagreement between the ranking and the record", () => {
    const card = render(
      withHist({ disagreement: "CHoCH has the better record here: 37% against 21%." }),
    );
    expect(card.querySelector(".setup-hist-dis")?.textContent ?? "").toMatch(/better record/i);
  });

  it("states the field even when there is no good news in it", () => {
    /* The absence of an edge is the more useful half of this module, and a
       strip that only renders alternatives when they exist only ever delivers
       good news. */
    const card = render(
      withHist({ fieldNote: "10 setup kinds have a record here, and none of them clears break-even." }),
    );
    expect(card.querySelector(".setup-hist-field")?.textContent ?? "").toMatch(/none of them clears/i);
  });

  it("always carries the in-sample caveat", () => {
    const card = render(withHist());
    expect(card.querySelector(".setup-hist-caveat")?.textContent ?? "").toMatch(/same history the pattern was found in/i);
  });

  it("renders nothing at all when there is no history to show", () => {
    expect(render(viewOf("go")).querySelector(".setup-hist")).toBeNull();
  });
});

describe("the value / qualifier split", () => {
  let card: HTMLElement;
  beforeEach(() => {
    card = render(viewOf("stand-down"));
  });

  /**
   * THE BUG THIS PINS. "458.2093 · 1.00× ATR, from volatility" was one string,
   * 38 characters wide, and the grid handed the value column every pixel it
   * asked for. The number and its provenance have to be separate nodes.
   */
  it("keeps a qualifier out of the value it qualifies", () => {
    const vals = texts(card, ".pk-val");
    expect(vals).toContain("458.2093");
    for (const v of vals) expect(v).not.toMatch(/ATR, from/);
  });

  it("renders the qualifier as its own note", () => {
    expect(texts(card, ".pk-note")).toContain("1.00× ATR, from volatility");
  });

  it("splits the risk percentage off the risk amount the same way", () => {
    expect(texts(card, ".pk-val")).toContain("USD 59.43");
    expect(texts(card, ".pk-note")).toContain("0.59% of equity");
  });

  /* A row with nothing to qualify must not grow an empty second line. */
  it("emits no note for a plain row", () => {
    const rows = [...card.querySelectorAll(".pk-v")];
    const plain = rows.filter((r) => r.querySelector(".pk-note") === null);
    expect(plain.length).toBeGreaterThan(0);
    expect(texts(card, ".pk-note").every((t) => t.length > 0)).toBe(true);
  });

  it("gives every value cell exactly one value node", () => {
    for (const cell of card.querySelectorAll(".pk-v")) {
      expect(cell.querySelectorAll(".pk-val")).toHaveLength(1);
    }
  });
});

describe("section labels", () => {
  /**
   * "The plan · NOT LIVE, a gate is refusing it" as one tracked-uppercase
   * string wrapped to two lines of red capitals in a 307px card. The term is
   * the label; the rest is a sentence and must not be typeset as one.
   */
  it("splits every label into a term and a sentence", () => {
    const card = render(viewOf("stand-down"));
    const labels = [...card.querySelectorAll(".pk-lbl")];
    expect(labels.length).toBeGreaterThanOrEqual(3);
    for (const l of labels) {
      expect(l.querySelector(".pk-lbl-term")).not.toBeNull();
      expect(l.querySelector(".pk-lbl-note")).not.toBeNull();
    }
  });

  it("keeps the terms short enough to stay on one line", () => {
    const card = render(viewOf("stand-down"));
    for (const t of texts(card, ".pk-lbl-term")) expect(t.length).toBeLessThanOrEqual(12);
  });

  it("says in the label itself that a refused plan is not live", () => {
    const card = render(viewOf("stand-down"));
    expect(texts(card, ".pk-lbl-note").join(" ")).toMatch(/not live/i);
  });

  it("does not say that when nothing is refusing", () => {
    const card = render(viewOf("go"));
    expect(texts(card, ".pk-lbl-note").join(" ")).not.toMatch(/not live/i);
  });
});

describe("the plan is shown in every state", () => {
  /**
   * Reversed once already. v39 rendered the plan always and dimmed it; the
   * rewrite hid it on any block, which made the card unable to answer the
   * question it exists for in the states it is in most of the time.
   */
  for (const kind of ["go", "armed", "conflict", "stand-down", "unknown"] as const) {
    it(`renders the entry, stop and targets on ${kind}`, () => {
      const card = render(viewOf(kind));
      const vals = texts(card, ".pk-val").join(" ");
      expect(vals).toMatch(/76,989.45/);
      expect(vals).toMatch(/77,562.21/);
      expect(vals).toMatch(/76,645.79/);
    });
  }

  it("marks the refused sections as refused, so the dimming has something to hang on", () => {
    const card = render(viewOf("stand-down"));
    expect([...card.querySelectorAll('.setup-sec[data-refused="true"]')].length).toBe(2);
  });

  it("marks nothing refused when the gates pass", () => {
    const card = render(viewOf("armed"));
    expect(card.querySelector('.setup-sec[data-refused="true"]')).toBeNull();
  });
});

describe("the guard that matters", () => {
  const copyBtn = (card: HTMLElement): HTMLButtonElement =>
    [...card.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Copy to Calculator"),
    ) as HTMLButtonElement;

  /* Reading a refused plan is not the operational error. Acting on one in a
     single click is — so that is what stays disabled. */
  it("disables Copy to Calculator while a gate refuses", () => {
    expect(copyBtn(render(viewOf("stand-down"))).disabled).toBe(true);
    expect(copyBtn(render(viewOf("unknown"))).disabled).toBe(true);
  });

  it("enables it in the states that pass", () => {
    for (const kind of ["go", "armed", "conflict"] as const) {
      expect(copyBtn(render(viewOf(kind))).disabled, kind).toBe(false);
    }
  });
});

describe("the header", () => {
  it("always names a strategy, falling back to discretionary", () => {
    const card = render(viewOf("go"));
    expect(texts(card, ".setup-strat")).toEqual(["bos"]);

    const v = viewOf("go");
    const none = render({ ...v, verdict: { ...v.verdict, strategy: null } });
    expect(texts(none, ".setup-strat")).toEqual(["discretionary"]);
    expect(none.querySelector(".setup-strat")?.getAttribute("data-none")).toBe("true");
  });
});

/* ==========================================================================
   WHAT THE READ IS STANDING ON

   The verdict line said "on 24% coverage" and stopped. That figure is the
   single most important qualifier on the card — four sources agreeing out of
   four is not four out of seventeen — and it was unactionable, because nothing
   said which sources were silent or whether the silence was fixable.

   Measured, the answer was that most of them had never been asked: regime,
   forecast, derivatives and the cross-venue spread all sat behind panels the
   user had not opened. Same instrument, same minute, after wiring them up:
   24% → 56%. A thin market and an incurious terminal were rendering
   identically, and only one of them is a reason not to trade.
   ========================================================================== */

describe("the evidence block", () => {
  const withEvidence = (over: Partial<SetupView["evidence"] & object> = {}): SetupView => ({
    ...viewOf("stand-down"),
    evidence: {
      coverage: 0.56,
      answered: [
        { label: "Market structure", reason: "Break of structure, long." },
        { label: "Regime model", reason: "Trending." },
      ],
      missing: [
        { label: "Higher timeframes", reason: "No higher timeframe is enabled.", kind: "absent" },
        { label: "Derivatives", reason: "The venue refused.", kind: "failed" },
        { label: "On-chain", reason: "No watcher in this build.", kind: "unavailable" },
      ],
      loading: false,
      ...over,
    },
  });

  it("is not rendered at all when there is no evidence to describe", () => {
    expect(render(viewOf("go")).querySelector(".setup-ev")).toBeNull();
  });

  it("counts sources, and leaves the unavailable one out of the count", () => {
    const el = render(withEvidence());
    /* 2 answered, 2 real gaps. On-chain is listed below but is not a source
       that failed to answer, so it must not appear in the denominator — the
       card would otherwise contradict the coverage figure it just printed. */
    expect(el.querySelector(".setup-ev-cov")?.textContent).toBe("Data: 2 of 4 sources (56%)");
  });

  it("still lists the unavailable source, so nothing is hidden by not counting it", () => {
    const labels = texts(render(withEvidence()), ".setup-ev-label");
    expect(labels).toContain("On-chain");
  });

  /**
   * THREE MARKS FOR THREE FACTS. A source that ERRORED is something you can go
   * and fix; one that had nothing to say is the market; one this build does not
   * have is neither. Rendering them alike is what made "24%" unactionable.
   */
  it("distinguishes a fixable failure from an empty answer", () => {
    const el = render(withEvidence());
    const kinds = [...el.querySelectorAll(".setup-ev-row")].map((r) =>
      (r as HTMLElement).dataset["kind"],
    );
    expect(kinds).toEqual(["answered", "answered", "absent", "failed", "unavailable"]);
    expect(el.querySelector(".setup-ev-note")?.textContent).toMatch(/1 failed/);
  });

  /* Silence while a lane is still in flight is not an answer, and the summary
     must not let it read as one. */
  it("says the number is still moving while lanes are loading", () => {
    const el = render(withEvidence({ loading: true }));
    expect(el.querySelector(".setup-ev-note")?.textContent).toMatch(/still loading/);
  });

  it("marks a thin read so the figure stops being a footnote", () => {
    expect(
      render(withEvidence({ coverage: 0.2 })).querySelector<HTMLElement>(".setup-ev-cov")?.dataset[
        "thin"
      ],
    ).toBe("true");
    expect(
      render(withEvidence({ coverage: 0.8 })).querySelector<HTMLElement>(".setup-ev-cov")?.dataset[
        "thin"
      ],
    ).toBe("false");
  });

  it("says so plainly when everything answered", () => {
    const el = render(
      withEvidence({ missing: [], coverage: 1 }),
    );
    expect(el.querySelector(".setup-ev-note")?.textContent).toMatch(/all sources answered/);
  });

  /* Collapsed by default: on a healthy read this is a one-line reassurance. */
  it("starts closed, so it costs one line until it is wanted", () => {
    expect(render(withEvidence()).querySelector<HTMLDetailsElement>(".setup-ev")?.open).toBe(false);
  });
});

/**
 * The card's own track record.
 *
 * Distinct from `record`, which measures the operator's trades. This measures
 * the CARD's claims, and the two sit together so that a card cannot report on
 * how you traded while staying silent about how it read.
 */
describe("the card's own track record", () => {
  it("renders nothing at all when there is nothing to say", () => {
    /* A row reading "not enough data" on every render trains people to skip
       the trust block — which is where the PBO line lives. */
    const card = render({ ...viewOf("stand-down"), learned: null });
    expect(card.querySelectorAll(".setup-learned")).toHaveLength(0);
    /* And the PBO line is still there, which is the thing being protected. */
    expect(card.querySelectorAll(".setup-pbo")).toHaveLength(1);
  });

  it("renders the line when there is one", () => {
    const card = render({
      ...viewOf("stand-down"),
      learned: "On BTCUSDT, this card's reads have been right 55% of the time (41%–68%), +0.20R per read.",
    });
    expect(texts(card, ".setup-learned")).toEqual([
      "On BTCUSDT, this card's reads have been right 55% of the time (41%–68%), +0.20R per read.",
    ]);
  });

  /* Both live in the trust block, and neither replaces the other. */
  it("shows the journal record and the card's record together", () => {
    const card = render({
      ...viewOf("stand-down"),
      record: "This setup type: 40 trades, +0.30R expectancy, 52% hit rate (±15 points at 95%).",
      learned: "Across every instrument, this card's reads have been right 48% of the time (39%–57%), -0.05R per read.",
    });
    expect(card.querySelectorAll(".setup-trust .setup-record")).toHaveLength(1);
    expect(card.querySelectorAll(".setup-trust .setup-learned")).toHaveLength(1);
    expect(card.querySelectorAll(".setup-trust .setup-pbo")).toHaveLength(1);
  });
});

describe("no setup means no plan", () => {
  /**
   * THE BUG THIS PINS, WHICH HAS NOW SHIPPED TWICE.
   *
   * `chooseSetup` returns `best: null` with the refusal "There is no setup
   * here — this is not a gate refusing one". The shell nevertheless built a
   * plan anyway, because the stop had a `?? nearestSwing` fallback that ran
   * whether or not a setup existed. The card then rendered, on one screen:
   *
   *   "There is no setup here — this is not a gate refusing one"
   *   "THE PLAN · NOT LIVE — a gate is refusing it"
   *   Entry zone 4,472.50 – 4,481.34   Stop 4,459.22   Target 1 4,494.62
   *
   * Three accounts of one moment, one of them an actionable price drawn from a
   * support level with no relationship to any idea. `shell.ts` carries a note
   * saying this was fixed at v49; only half of it was, and the operator
   * photographed it again at v55.
   *
   * The guard lives where the plan is BUILT, so these tests pin the card's
   * half: given no plan, it must not print prices and must not blame a gate.
   */
  const noPlan = (kind: VerdictKind = "stand-down"): SetupView => ({
    ...viewOf(kind),
    plan: null,
    planProblem: null,
    size: null,
  });

  it("prints no entry, stop or target when there is no plan", () => {
    const text = render(noPlan()).textContent ?? "";
    for (const forbidden of ["Entry zone", "Target 1", "Target 2", "Stop distance"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("never blames a gate when there is no plan for a gate to refuse", () => {
    /* The sentence that contradicted the engine's own refusal. */
    expect(render(noPlan()).textContent ?? "").not.toContain("a check is failing");
  });

  it("prints no price at all, on any verdict, when there is no plan", () => {
    /* Broader than the labels: any of the plan's numbers appearing means a
       block rendered that should not have. */
    for (const kind of ["stand-down", "unknown", "armed", "go", "conflict"] as VerdictKind[]) {
      const text = render(noPlan(kind)).textContent ?? "";
      for (const price of ["76,989", "77,218", "77,562", "76,645", "76,187"]) {
        expect(text, `${kind} leaked ${price}`).not.toContain(price);
      }
    }
  });

  it("still shows the gates, because they are what the operator came to read", () => {
    /* The fix must not hide the rest of the card. A stand-down with no plan is
       still a card that has to explain itself. */
    expect(render(noPlan()).textContent ?? "").toContain("Spread is 4.1");
  });

  it("shows a plan when there IS one, so the guard cannot be over-applied", () => {
    const text = render(viewOf("stand-down")).textContent ?? "";
    expect(text).toContain("Entry zone");
  });
});
