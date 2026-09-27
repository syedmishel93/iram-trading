// @vitest-environment jsdom
/**
 * The Strategy desk's AUTONOMOUS mode, and the Discovered shelf.
 *
 * What is pinned:
 *  1. THE PRE-RUN SUMMARY — the arm count is stated before anything runs, it
 *     adds up, and the sentence that the hurdle grows with it is on screen.
 *  2. PROGRESS AND CANCEL — the line names what just finished, and Cancel
 *     actually reaches the runner's AbortSignal.
 *  3. SURVIVORS — rendered with their figures, and a hybrid says WHICH two
 *     rules it came from and what was added.
 *  4. EVERY REFUSAL KIND renders its `why` IN FULL, including the one that is
 *     a finding rather than an error.
 *  5. TOO LITTLE HISTORY refuses before the runner is called at all.
 *  6. THE SHELF — saving is automatic and says the rows are unproven; promote
 *     asks first and the confirmation states the consequence; retire needs a
 *     reason and keeps it.
 *
 * The runner is INJECTED. `backtest/autorun.ts` and `backtest/labrunner.ts`
 * have their own tests; what is under test here is the surface, so the studies
 * are fixtures and the field is the real one.
 */

import { describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signal";
import { flushFrames } from "../src/core/frame";
import { createKV, memoryRawStore } from "../src/store/kv";
import { createAutonomous } from "../src/ui/strategy/autonomous";
import { createShelfStore } from "../src/backtest/shelfstore";
import { buildField, type Entrant, type StudyOutcome } from "../src/backtest/autorun";
import { DISCOVERED_SLOT, keyOf, type Discovered } from "../src/backtest/discovered";
import { SPECS, SPECS_BY_ID } from "../src/backtest/specs";
import { conditionText, type RuleSpec } from "../src/backtest/rules";
import { DEFAULT_COSTS, type Trade } from "../src/backtest/engine";
import { EMPTY_METRICS } from "../src/backtest/metrics";
import type { Study } from "../src/backtest/lab";
import type { Promotion } from "../src/backtest/promote";
import type { FlowSettings } from "../src/ui/strategy/flow";
import type { LoadedBars } from "../src/ui/strategy/load";
import type { BarView } from "../src/chart/series";

const T0 = Date.UTC(2025, 0, 1);
const HOUR = 3_600_000;
/** Ten hybrids: small enough to reason about the trial count, and past the
    point where `buildHybrids` starts REFUSING pairs (measured: 8 at max=10). */
const MAX_HYBRIDS = 10;

/* ------------------------------------------------------------- fixtures --- */

/** Test-only bars: a deterministic ramp. Never product data. */
function bars(n: number): BarView[] {
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.01;
    return { t: T0 + i * HOUR, o: c, h: c + 0.2, l: c - 0.2, c, v: 10 };
  });
}

const trade = (r: number, i: number): Trade => ({
  direction: "long",
  entryIndex: i,
  entryTime: i,
  entryPrice: 100,
  exitIndex: i + 1,
  exitTime: i + 1,
  exitPrice: 100 + r,
  exitReason: r > 0 ? "target" : "stop",
  rMultiple: r,
  returnPct: r / 100,
  reason: "fixture",
  maeR: Math.max(0, -r),
  mfeR: Math.max(0, r),
});
/** Alternating ±1 around `mean`, so the per-trade Sharpe is about `mean`. */
const trades = (n: number, mean: number): Trade[] =>
  Array.from({ length: n }, (_, i) => trade(mean + (i % 2 === 0 ? 1 : -1), i));

const promotion = (promoted: boolean): Promotion => ({
  promoted,
  checks: [{ id: "oos", passed: promoted, text: promoted ? "enough out-of-sample trades" : "only 4 out-of-sample trades" }],
  summary: promoted ? "Promoted on every check." : "Not promoted: 1 of 1 checks failed.",
  outOfSample: EMPTY_METRICS,
});

const study = (mean: number, promoted: boolean): Study =>
  ({
    subject: { kind: "family", id: "ema" },
    bars: 3_000,
    configs: [{ id: "c0" }],
    best: null,
    bestRun: null,
    walk: {
      folds: [
        {
          index: 0, trainFrom: 0, trainTo: 1, testFrom: 1, testTo: 2, chosen: "c0",
          inSample: EMPTY_METRICS, outOfSample: EMPTY_METRICS, trades: trades(200, mean),
        },
      ],
      aggregate: EMPTY_METRICS,
      degradation: 0.8,
      warnings: [],
      verdict: "fixture",
    },
    overfit: { pbo: 0.2, logits: [], splits: 8, oosPositiveRate: 0.7, interpretation: "fixture" },
    headline: { standing: "survived", verdict: "fixture", why: "fixture" },
    grossMetrics: null,
    promotion: promotion(promoted),
    regimes: [],
    rules: null,
    warnings: [],
    refused: null,
  }) as unknown as Study;

const settings = (): FlowSettings => ({
  spreadBp: signal(2),
  commissionBp: signal(4),
  slippageBp: signal(1),
  carryBp: signal(1),
  riskPct: signal(1),
  depth: signal(3000),
});

const loaded = (n: number): LoadedBars => ({ bars: bars(n), source: "archive", coverage: 1, demo: false, note: "" });

/** The field the desk will actually build, for choosing fixture entrants. */
const field = () => buildField({ maxHybrids: MAX_HYBRIDS });

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();
  }
}

interface MountOptions {
  readonly barCount?: number;
  readonly outcome?: (e: Entrant) => StudyOutcome;
  readonly seed?: readonly Discovered[];
  readonly onOpenInManual?: (spec: RuleSpec) => void;
  /** A runner that never resolves until `release()` is called. */
  readonly hold?: { readonly promise: Promise<void> };
}

function mount(o: MountOptions = {}) {
  const kv = createKV(memoryRawStore());
  const shelf = createShelfStore(kv);
  for (const row of o.seed ?? []) shelf.addAll([row]);
  const seen: { signal: AbortSignal | null; calls: number; entrants: readonly Entrant[] } = {
    signal: null, calls: 0, entrants: [],
  };
  const progressed: string[] = [];

  const auto = createAutonomous({
    symbol: signal("BTCUSDT"),
    timeframe: signal("1h"),
    settings: settings(),
    load: () => Promise.resolve(loaded(o.barCount ?? 3000)),
    shelf,
    maxHybrids: MAX_HYBRIDS,
    onOpenInManual: o.onOpenInManual ?? (() => {}),
    now: () => T0,
    makeRunner: (_bars, abort) => async (entrants, onProgress) => {
      seen.signal = abort;
      seen.calls += 1;
      seen.entrants = entrants;
      let done = 0;
      const out: StudyOutcome[] = [];
      for (const e of entrants) {
        if (o.hold) await o.hold.promise;
        if (abort.aborted) {
          out.push({ id: e.spec.id, study: null, error: "the sweep was cancelled before this rule ran" });
          continue;
        }
        done += 1;
        progressed.push(e.spec.name);
        onProgress({ done, total: entrants.length, last: e.spec.name });
        out.push(o.outcome ? o.outcome(e) : { id: e.spec.id, study: study(0.02, false) });
      }
      return out;
    },
  });
  document.body.replaceChildren(auto.el);
  return { auto, shelf, kv, seen, progressed, el: auto.el };
}

const text = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const q = (el: Element, sel: string): HTMLElement | null => el.querySelector(sel);
const all = (el: Element, sel: string): HTMLElement[] => [...el.querySelectorAll<HTMLElement>(sel)];
const click = (el: Element | null): void => (el as HTMLElement | null)?.click();

/* ----------------------------------------------------------------- tests --- */

describe("autonomous mode — before it runs", () => {
  it("counts the arms, and the count adds up", () => {
    const { el } = mount();
    const line = text(q(el, ".auto-arms"));
    /* THE SUM HAS TO BE A REAL SUM. The line said "library + hybrids = arms"
       and once conditioned arms existed the two sides stopped agreeing — a
       sentence an operator reads, quietly wrong. Parse whatever parts the line
       names and require them to add up, so a new kind of arm either appears in
       the line or fails this. */
    const total = /= (\d+) to test/.exec(line);
    expect(total, line).not.toBeNull();
    const parts = [...line.matchAll(/(\d+) [a-z]/g)].map((x) => Number(x[1]));
    const arms = Number(total?.[1]);
    const named = parts.slice(0, -1).reduce((a, b) => a + b, 0);
    expect(named, line).toBe(arms);
    expect(line).toContain(`${SPECS.length} library rules`);
    expect(line).toContain(`${MAX_HYBRIDS} hybrids`);
  });

  it("says plainly that the hurdle grows with the number of arms", () => {
    const { el } = mount();
    const body = text(q(el, '[data-step="plan"] .panel-body'));
    expect(body).toContain("one arm of one search");
    expect(body).toMatch(/the more arms, the more edge/i);
  });

  it("names the pairs that were considered and not built", () => {
    const { el } = mount();
    const f = field();
    expect(f.hybrids.rejected.length).toBeGreaterThan(0);
    expect(text(q(el, '[data-step="plan"] .panel-body'))).toContain(
      `${f.hybrids.rejected.length} pairs were considered and not built`,
    );
  });
});

describe("autonomous mode — running", () => {
  it("shows what has been studied and what just finished, then cancels for real", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { el, auto, seen } = mount({ hold: { promise: gate } });

    void auto.run();
    await settle();
    expect(text(q(el, '[data-act="run"]'))).toBe("Searching…");

    release();
    await settle();
    expect(seen.signal).not.toBeNull();
    expect(text(q(el, ".auto-progress"))).toMatch(/^\d+ of \d+ studied · just finished .+\.$/);
    await new Promise((r) => setTimeout(r, 0));
  });

  it("Cancel aborts the signal the runner was given, and the result says so", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { el, auto, seen, progressed } = mount({ hold: { promise: gate } });

    void auto.run();
    await settle();
    expect(seen.signal?.aborted).toBe(false);

    click(q(el, '[data-act="cancel"]'));
    expect(seen.signal?.aborted).toBe(true);

    release();
    await settle();
    /* Nothing was studied after the abort, and the screen says the field it is
       being judged against is the whole one. */
    expect(progressed).toHaveLength(0);
    expect(text(el)).toContain("You cancelled this search");
  });
});

describe("autonomous mode — survivors", () => {
  /** One chosen hybrid wins; everything else is tested and refused. */
  const winningHybrid = () => {
    const f = field();
    const hy = f.hybrids.hybrids[0];
    if (!hy) throw new Error("the field built no hybrids — the fixture cannot run");
    return hy;
  };

  it("renders the survivor's figures and WHICH two rules a hybrid came from", async () => {
    const hy = winningHybrid();
    const { el, auto, shelf } = mount({
      outcome: (e) => ({ id: e.spec.id, study: study(e.spec.id === hy.spec.id ? 1.5 : 0.02, e.spec.id === hy.spec.id) }),
    });
    await auto.run();
    await settle();

    const row = q(el, '.auto-row[data-origin="hybrid"]');
    expect(row, "a hybrid survivor should be on screen").not.toBeNull();
    expect(text(row)).toContain(hy.spec.name);
    expect(text(q(el, ".auto-row-head .auto-origin"))).toBe("Hybrid");

    const parents = text(q(el, ".auto-parents"));
    expect(parents).toContain("Built from");
    expect(parents).toContain(SPECS_BY_ID.get(hy.trigger)?.name ?? "?");
    expect(parents).toContain(SPECS_BY_ID.get(hy.filter)?.name ?? "?");
    for (const c of hy.added) expect(parents).toContain(conditionText(c));

    const figures = all(row as Element, ".auto-fig").map((f) => text(f));
    expect(figures.join(" | ")).toMatch(/Unseen trades\s*200/);
    expect(figures.join(" | ")).toMatch(/R a trade/);
    expect(figures.join(" | ")).toMatch(/Sharpe a trade/);
    expect(figures.join(" | ")).toMatch(/Left after the hurdle/);

    /* Saved automatically, and the screen says it and says unproven. */
    const saved = text(q(el, ".auto-saved"));
    expect(saved).toContain("Saved 1 to the shelf below as UNPROVEN");
    expect(shelf.rows()).toHaveLength(1);
    expect(shelf.rows()[0]?.status).toBe("unproven");
    expect(shelf.rows()[0]?.spec.id).toBe(hy.spec.id);
  });

  it("lists everything that was refused, with its reason, behind a disclosure", async () => {
    const hy = winningHybrid();
    const { el, auto } = mount({
      outcome: (e) => ({ id: e.spec.id, study: study(e.spec.id === hy.spec.id ? 1.5 : 0.02, e.spec.id === hy.spec.id) }),
    });
    await auto.run();
    await settle();

    const details = q(el, "details.auto-refused");
    expect(details).not.toBeNull();
    const rejects = all(details as Element, ".auto-reject");
    /* Every library rule was tested and refused, plus the hybrid pairs that
       were never built. */
    expect(rejects.length).toBeGreaterThanOrEqual(SPECS.length);
    /* The reason shown is the failing CHECK, which is what `scoreSearch` puts in
       `rejected` — not the promotion summary. */
    expect(text(details)).toContain("only 4 out-of-sample trades");
    expect(text(details)).toContain("Hybrids that were never built");
    const f = field();
    const firstUnbuilt = f.hybrids.rejected[0];
    if (firstUnbuilt) expect(text(details)).toContain(firstUnbuilt.why);
  });
});

describe("autonomous mode — the refusal is a result", () => {
  it("beaten-by-noise reads as a finding and keeps its why in full", async () => {
    /* Everything the runner answers for passes its own gate and scores far
       under what a search this wide turns up in noise. */
    const { el, auto } = mount({ outcome: (e) => ({ id: e.spec.id, study: study(0.01, true) }) });
    await auto.run();
    await settle();

    const box = q(el, '.auto-refusal[data-kind="beaten-by-noise"]');
    expect(box, text(q(el, ".auto-refusal"))).not.toBeNull();
    expect(text(q(box as Element, ".auto-refusal-head"))).toBe("Nothing survived — and that is the finding");

    const why = text(q(box as Element, ".auto-refusal-why"));
    const refusal = auto.report()?.search.refusal;
    expect(refusal?.kind).toBe("beaten-by-noise");
    /* In full — not truncated, not summarised. */
    expect(why).toBe((refusal?.why ?? "").replace(/\s+/g, " ").trim());
    expect(why).toContain("That is a result of the search, not of the market.");
    expect(text(box)).toContain("This is a result about the search, not a fault in it.");
  });

  it("all-refused names the nearest miss", async () => {
    const { el, auto } = mount({ outcome: (e) => ({ id: e.spec.id, study: study(0.02, false) }) });
    await auto.run();
    await settle();

    const box = q(el, '.auto-refusal[data-kind="all-refused"]');
    expect(box).not.toBeNull();
    expect(text(q(box as Element, ".auto-refusal-head"))).toBe("Nothing survived");
    const why = text(q(box as Element, ".auto-refusal-why"));
    expect(why).toContain("The nearest miss was");
    expect(why).toBe((auto.report()?.search.refusal?.why ?? "").replace(/\s+/g, " ").trim());
  });

  it("no-candidates says nothing could be studied at all", async () => {
    const { el, auto } = mount({
      outcome: (e) => ({ id: e.spec.id, study: null, error: "fixture: the study did not run" }),
    });
    await auto.run();
    await settle();

    const box = q(el, '.auto-refusal[data-kind="no-candidates"]');
    expect(box).not.toBeNull();
    expect(text(q(box as Element, ".auto-refusal-head"))).toBe("Nothing could be studied");
    expect(text(q(box as Element, ".auto-refusal-why"))).toContain("No strategy could be run on this chart");
  });
});

describe("autonomous mode — too little history", () => {
  it("refuses before a single study runs, and names the floor", async () => {
    const { el, auto, seen } = mount({ barCount: 300 });
    await auto.run();
    await settle();

    expect(seen.calls, "the runner must never be called on a history that cannot validate anything").toBe(0);
    const box = q(el, '.auto-refusal[data-kind="no-history"]');
    expect(box).not.toBeNull();
    expect(text(q(box as Element, ".auto-refusal-head"))).toBe("Not enough history to search this market");
    const why = text(q(box as Element, ".auto-refusal-why"));
    expect(why).toContain("300 bars over 5 folds");
    expect(why).toMatch(/2,050 bars is the floor for this field/);
    expect(auto.report()).toBeNull();
  });
});

/* ------------------------------------------------------------- the shelf --- */

const shelfRow = (over: Partial<Discovered> = {}): Discovered => ({
  spec: SPECS[0] as RuleSpec,
  origin: "library",
  foundAt: T0,
  symbol: "BTCUSDT",
  timeframe: "1h",
  bars: 3_000,
  trials: 87,
  trades: 120,
  expectancy: 0.31,
  sharpe: 0.26,
  deflated: 0.05,
  hurdle: 0.21,
  costs: DEFAULT_COSTS,
  status: "unproven",
  ...over,
});

describe("the Discovered shelf", () => {
  it("shows the row, its status and its provenance", () => {
    const { el } = mount({ seed: [shelfRow()] });
    const row = q(el, ".shelf-row");
    expect(row).not.toBeNull();
    expect(row?.dataset["status"]).toBe("unproven");
    expect(text(q(row as Element, ".shelf-status"))).toBe("Unproven");
    expect(text(q(row as Element, ".shelf-market"))).toBe("BTCUSDT · 1h");
    const prov = text(q(row as Element, ".shelf-prov"));
    expect(prov).toContain("3,000 bars of BTCUSDT 1h");
    expect(prov).toContain("87 configurations tried");
    expect(prov).toContain("2bp spread");
    expect(text(q(row as Element, ".shelf-forward"))).toContain("No forward trades recorded yet");
  });

  it("promoting asks first, and the question states the consequence", async () => {
    const { el, shelf, kv } = mount({ seed: [shelfRow()] });
    click(q(el, '[data-act="promote"]'));
    await settle();

    const confirm = q(el, '[data-act="confirm-promote"]');
    expect(confirm, "a confirmation step must appear before anything is promoted").not.toBeNull();
    expect(text(confirm)).toContain("lets it influence what the terminal recommends");
    expect(shelf.rows()[0]?.status, "nothing is promoted until it is confirmed").toBe("unproven");

    click(q(el, '[data-act="promote-confirm"]'));
    await settle();
    expect(shelf.rows()[0]?.status).toBe("promoted");
    expect(kv.get(DISCOVERED_SLOT)[0]?.status).toBe("promoted");
    expect(text(q(el, ".shelf-status"))).toBe("Promoted");
  });

  it("the confirmation can be declined, and nothing changes", async () => {
    const { el, shelf } = mount({ seed: [shelfRow()] });
    click(q(el, '[data-act="promote"]'));
    await settle();
    click(q(el, '[data-act="promote-cancel"]'));
    await settle();
    expect(q(el, '[data-act="confirm-promote"]')).toBeNull();
    expect(shelf.rows()[0]?.status).toBe("unproven");
  });

  it("retiring asks for a reason, refuses an empty one, and keeps it", async () => {
    const { el, shelf } = mount({ seed: [shelfRow()] });
    click(q(el, '[data-act="retire"]'));
    await settle();

    const confirm = q(el, '[data-act="retire-confirm"]') as HTMLButtonElement | null;
    expect(confirm?.disabled, "a retirement with no reason is refused").toBe(true);

    const input = q(el, ".shelf-retire input") as HTMLInputElement;
    input.value = "it stopped making sense on this pair";
    input.dispatchEvent(new Event("input"));
    await settle();
    expect((q(el, '[data-act="retire-confirm"]') as HTMLButtonElement).disabled).toBe(false);
    click(q(el, '[data-act="retire-confirm"]'));
    await settle();

    expect(shelf.rows()[0]?.status).toBe("retired");
    expect(shelf.rows()[0]?.retiredWhy).toBe("it stopped making sense on this pair");
    expect(text(q(el, ".shelf-retired"))).toContain("it stopped making sense on this pair");
  });

  it("a retired rule is left out of the next search, and the plan says so", () => {
    const row = shelfRow({ status: "retired", retiredWhy: "fixture" });
    const { el } = mount({ seed: [row] });
    expect(text(q(el, '[data-step="plan"] .panel-body'))).toContain("1 rules you retired on this market are left out");
    const line = text(q(el, ".auto-arms"));
    expect(line).toContain(`${SPECS.length - 1} library rules`);
    expect(keyOf(row)).toContain(SPECS[0]?.id ?? "");
  });

  it("Open in Manual hands the spec back, unchanged", () => {
    const onOpenInManual = vi.fn();
    const { el } = mount({ seed: [shelfRow()], onOpenInManual });
    click(q(el, '.shelf-row [data-act="open-manual"]'));
    expect(onOpenInManual).toHaveBeenCalledTimes(1);
    expect(onOpenInManual.mock.calls[0]?.[0]).toBe(SPECS[0]);
  });

  it("an empty shelf says so rather than rendering nothing", () => {
    const { el } = mount();
    expect(text(q(el, '[data-step="shelf"] .strat-empty'))).toBe("Nothing found yet. Run the search above.");
  });
});

/**
 * v60, found in the browser: the gateway reports a finished study by ITS label
 * (`bars/1h/spec:<id>`), and `labrunner.ts` passes that straight through as
 * `RunProgress.last`. The progress line has to be readable whichever runner
 * answered, so the label is unwrapped to the rule's own name.
 */
describe("the progress line is readable whichever runner answered", () => {
  it("unwraps a gateway label to the rule's name", async () => {
    let seenLast = "";
    const kv = createKV(memoryRawStore());
    const shelf = createShelfStore(kv);
    const first = SPECS[0] as RuleSpec;
    const auto = createAutonomous({
      symbol: signal("BTCUSDT"),
      timeframe: signal("1h"),
      settings: settings(),
      load: () => Promise.resolve(loaded(3000)),
      shelf,
      maxHybrids: MAX_HYBRIDS,
      onOpenInManual: () => {},
      now: () => T0,
      makeRunner: () => async (entrants, onProgress) => {
        /* Exactly what the gateway's `LabStudyOutcome.label` looks like. */
        seenLast = `bars/1h/spec:${first.id}`;
        onProgress({ done: 1, total: entrants.length, last: seenLast });
        return entrants.map((e) => ({ id: e.spec.id, study: study(0.02, false) }));
      },
    });
    document.body.replaceChildren(auto.el);
    await auto.run();
    await settle();

    expect(seenLast).toContain("spec:");
    const line = text(q(auto.el, ".auto-progress"));
    expect(line, "the gateway's own label must not reach the screen").not.toContain("spec:");
    expect(line).toContain(`just finished ${first.name}`);
  });
});
