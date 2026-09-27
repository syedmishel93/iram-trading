/**
 * The steered Research flow's pure logic: the question table, the
 * plain-language explanation, How-strict validation, and the data library's
 * used-by / what-was-learned / top-up planning.
 */

import { describe, expect, it } from "vitest";
import { inputsFor, methodsFor, QUESTIONS, questionLabel, questionOf } from "../src/study/question";
import { METHOD_BY_ID } from "../src/study/methods";
import { costsOf, foldsOf, newStudy, DEFAULT_FOLDS, MAX_FOLDS, MIN_FOLDS } from "../src/study/spec";
import { explainReport } from "../src/study/explain";
import { parameterBudget, splitWindow } from "../src/study/window";
import type { StudyReport, StepResult } from "../src/study/run";
import type { Contest } from "../src/study/steps";
import { createStudyStore, type StudyRecord } from "../src/study/store";
import { DEFAULT_GUARDS } from "../src/study/schedule";
import { createKV, memoryRawStore } from "../src/store/kv";
import { learnedItems, planTopUp, usedBy, TOPUP_PER_PASS } from "../src/ui/research/library";
import type { SeriesInventory } from "../src/store/barstore";
import { buildEntry, contextAt, type KnowledgeEntry } from "../src/learn/knowledge";

/* ── the question table ─────────────────────────────────────────────────── */

describe("questions", () => {
  it("every method a question names exists in the catalogue", () => {
    for (const q of QUESTIONS) {
      for (const id of [...q.core, ...q.withRelated]) expect(METHOD_BY_ID.has(id), `${q.id} → ${id}`).toBe(true);
    }
  });

  it("relationship checks are added only when something is related", () => {
    expect(methodsFor("direction", false)).toEqual(["regimes", "baserates", "classifier"]);
    expect(methodsFor("direction", true)).toEqual(["regimes", "baserates", "classifier", "crossasset", "leadlag", "corrmatrix"]);
  });

  it("only the setup question tests rules, so only it uses rounds and costs", () => {
    expect(QUESTIONS.filter((q) => q.usesRules).map((q) => q.id)).toEqual(["setup"]);
  });

  it("does not offer a price-range question it cannot answer", () => {
    expect(QUESTIONS.some((q) => /range/i.test(q.label))).toBe(false);
  });

  it("fills the horizon into the label, and defaults an unknown question", () => {
    expect(questionLabel(questionOf("direction"), 12)).toBe("Direction, next 12 bars");
    expect(questionOf(undefined).id).toBe("direction");
  });

  it("inputs are derived from the checks, so none is claimed that nothing reads", () => {
    const labels = (ms: string[], rel: number): string[] => inputsFor(ms, rel, "BTCUSDT").map((i) => i.label);
    expect(labels(["garch"], 3)).toEqual(["BTCUSDT returns", "Volatility history"]);
    expect(labels(["leadlag"], 3)).toContain("Related assets (3)");
    expect(labels(["leadlag"], 0)).not.toContain("Related assets (0)");
    expect(labels(["sweep-ema"], 0)).toContain("Rule trades");
  });
});

describe("How strict", () => {
  it("rounds default, clamp and survive a corrupted stored value", () => {
    expect(foldsOf({})).toBe(DEFAULT_FOLDS);
    expect(foldsOf({ folds: 99 })).toBe(MAX_FOLDS);
    expect(foldsOf({ folds: 1 })).toBe(MIN_FOLDS);
    expect(foldsOf({ folds: Number.NaN })).toBe(DEFAULT_FOLDS);
  });

  it("costs default to the engine's standard model", () => {
    expect(costsOf({})).toBe("standard");
    expect(costsOf({ costs: "none" })).toBe("none");
  });
});

/* ── the explanation ───────────────────────────────────────────────────── */

function step(methodId: string, label: string, outcome: StepResult["outcome"]): StepResult {
  return { methodId, label, group: "probability", tests: 1, outcome };
}

function okOutcome(headline: string, contest?: Contest): StepResult["outcome"] {
  return {
    state: "ok",
    ms: 1,
    headline,
    rows: [],
    caveats: [],
    profiles: [],
    pValues: [],
    ...(contest === undefined ? {} : { contest }),
  };
}

function report(steps: StepResult[], patch: Partial<StudyReport> = {}): StudyReport {
  return {
    specId: "s1",
    name: "BTCUSDT 1h",
    symbol: "BTCUSDT",
    timeframe: "1h",
    at: 0,
    ms: 1,
    window: { requestedFrom: 0, requestedTo: 1, from: 0, to: 1, spanMs: 1, limitedBy: [], shortfall: null, refusal: null },
    split: splitWindow(0, 24),
    budget: parameterBudget(0, 24),
    rows: 5000,
    panelWarnings: [],
    steps,
    hypotheses: 12,
    correction: {
      hypotheses: 12,
      claims: [],
      survivors: 0,
      sharpe: null,
      sharpeBasis: "",
      sharpeRefusal: null,
      rulesBefore: 0,
      rulesAfter: 0,
      pbo: null,
      text: "12 hypotheses were tested.",
    },
    headline: "The report's own headline.",
    limits: [],
    refusal: null,
    timings: {},
    holdout: "sealed",
    ...patch,
  };
}

describe("explainReport", () => {
  const direction = questionOf("direction");

  it("names the winner from the step's own contest, with its margin", () => {
    const x = explainReport(
      report([step("classifier", "Calibrated classifier", okOutcome("h", { winner: "lightgbm", baseline: "the base rate", beat: true, by: "4% skill on Brier, out of sample" }))]),
      direction,
      [],
    );
    expect(x.verdict).toBe("The report's own headline.");
    expect(x.winner).toContain("lightgbm beat the base rate");
    expect(x.winner).toContain("4% skill");
  });

  it("says nothing won when nothing beat its baseline — never picks the least bad", () => {
    const x = explainReport(
      report([step("garch", "Volatility model", okOutcome("h", { winner: "EWMA", baseline: "EWMA", beat: false, by: "0.0% on QLIKE, out of sample" }))]),
      direction,
      [],
    );
    expect(x.winner).toBe("Volatility model: nothing beat EWMA — 0.0% on QLIKE, out of sample. That is a result, and a common one.");
  });

  it("with several comparisons and no winner, says so for all of them", () => {
    const lose = (label: string): StepResult =>
      step(label, label, okOutcome("h", { winner: "x", baseline: "y", beat: false, by: "0" }));
    const x = explainReport(report([lose("garch"), lose("classifier")]), direction, []);
    expect(x.winner).toContain("all 2 comparisons came out level or worse");
    expect(x.contests).toHaveLength(2);
  });

  it("names no winner when no check compared a model with a baseline", () => {
    const x = explainReport(report([step("regimes", "Market condition", okOutcome("All three conditions are represented."))]), direction, []);
    expect(x.winner).toContain("no winner to name");
  });

  it("reports what the related assets added from the cross-asset contest", () => {
    const x = explainReport(
      report([
        step("crossasset", "Cross-asset panel", okOutcome("h", { winner: "the subject on its own", baseline: "the subject on its own", beat: false, by: "+0.004 AUC, 0.60 standard errors" })),
      ]),
      direction,
      ["^TNX", "SPX500"],
    );
    expect(x.related.join(" ")).toContain("did not improve the forecast over BTCUSDT alone: +0.004 AUC");
    /* The cross-asset contest is about the related assets, not a model winner. */
    expect(x.contests).toHaveLength(0);
  });

  it("says when the related assets cannot change the answer for this question", () => {
    const x = explainReport(report([step("regimes", "Market condition", okOutcome("h"))]), questionOf("volatility"), ["SPX500"]);
    expect(x.related[0]).toContain("cannot change the answer");
  });

  it("names series that loaded nothing, and steps that refused, with their reasons", () => {
    const x = explainReport(
      report([step("leadlag", "Lead and lag", { state: "refused", reason: "Needs 200 rows." })]),
      direction,
      ["^TNX"],
      ["^TNX"],
    );
    expect(x.related.join(" ")).toContain("^TNX loaded no bars");
    expect(x.unanswered).toEqual(["Lead and lag could not answer: Needs 200 rows."]);
  });

  it("a refused run explains the refusal and invents nothing", () => {
    const x = explainReport(report([], { refusal: "No bars were loaded for BTCUSDT." }), direction, ["SPX500"]);
    expect(x.verdict).toBe("No bars were loaded for BTCUSDT.");
    expect(x.related).toHaveLength(0);
    expect(x.contests).toHaveLength(0);
  });
});

/* ── the data library ──────────────────────────────────────────────────── */

const rec = (id: string, symbol: string, tf: string, runs = 0): StudyRecord => {
  const spec = newStudy(id, symbol, tf, 0);
  return {
    spec: { ...spec, name: `${symbol} ${tf}` },
    schedule: { cadence: "once", enabled: false, actions: [], guards: DEFAULT_GUARDS },
    runs: Array.from({ length: runs }, (_, i) => ({
      at: i,
      ms: 1,
      headline: `run ${i}`,
      rows: 1,
      hypotheses: 1,
      survivors: 0,
      strength: null,
      measure: "none",
      refusal: null,
    })),
    failures: 0,
    filed: false,
  };
};

const inv = (symbol: string, timeframe: string, newest: number, over: Partial<SeriesInventory> = {}): SeriesInventory => ({
  key: `binance|${symbol}|${timeframe}`,
  source: "binance",
  symbol,
  timeframe,
  segments: 1,
  bars: 100,
  approxBytes: 4800,
  oldest: 0,
  newest,
  qualities: ["live"],
  lastFetched: newest,
  ...over,
});

describe("usedBy", () => {
  const studies = [rec("a", "BTCUSDT", "1h"), rec("b", "XAUUSD", "4h")];

  it("counts a study's subject and its related assets, at the same timeframe only", () => {
    expect(usedBy(inv("BTCUSDT", "1h", 0), studies, new Set())).toEqual(["BTCUSDT 1h"]);
    expect(usedBy(inv("SPX500", "1h", 0), studies, new Set())).toEqual(["BTCUSDT 1h"]);
    expect(usedBy(inv("BTCUSDT", "4h", 0), studies, new Set())).toEqual([]);
  });

  it("names the chart when the series is pinned", () => {
    expect(usedBy(inv("ETHUSDT", "15m", 0), studies, new Set(["binance|ETHUSDT|15m"]))).toEqual(["the chart"]);
  });
});

describe("learnedItems", () => {
  it("lists run histories, knowledge by market and timings — and nothing when empty", () => {
    expect(learnedItems([rec("a", "BTCUSDT", "1h")], [], {})).toEqual([]);
    const at = Date.UTC(2024, 0, 3, 13);
    const entry = (symbol: string, timeframe: string, kind: string): KnowledgeEntry => {
      const e = buildEntry(
        {
          source: "replay",
          symbol,
          timeframe,
          kind,
          direction: "long",
          bars: 5000,
          rMultiple: 2,
          trials: Array.from({ length: 12 }, () => ({ at, outcome: "target" as const, r: 2, heldBars: 5, context: contextAt(at, "trend") })),
        },
        at,
      );
      if (e === null) throw new Error("fixture produced no entry");
      return e;
    };
    const items = learnedItems(
      [rec("a", "BTCUSDT", "1h", 3)],
      [entry("BTCUSDT", "1h", "choch"), entry("BTCUSDT", "1h", "bos"), entry("EURUSD", "4h", "choch")],
      { leadlag: { msPerKRow: 1, fixedMs: 1, runs: 2 } },
    );
    expect(items.map((i) => i.id)).toEqual(["study-runs:a", "knowledge:BTCUSDT|1h", "knowledge:EURUSD|4h", "timings:all"]);
    expect(items[0]?.count).toBe(3);
    expect(items[0]?.detail).toContain("latest: run 2");
    expect(items[1]?.count).toBe(2);
  });
});

describe("planTopUp", () => {
  const H = 3_600_000;
  const now = 1000 * H;

  it("refreshes stale series, stalest first, and leaves current ones alone", () => {
    const due = planTopUp([inv("A", "1h", now - H), inv("B", "1h", now - 10 * H), inv("C", "1h", now - 50 * H)], now);
    expect(due.map((d) => d.symbol)).toEqual(["C", "B"]);
    expect(due[0]?.missing).toBe(50);
  });

  it("judges a series by its freshest copy across sources", () => {
    const due = planTopUp(
      [inv("A", "1h", now - 40 * H), inv("A", "1h", now - H, { key: "proxy|A|1h", source: "proxy" })],
      now,
    );
    expect(due).toHaveLength(0);
  });

  it("skips demo-only series and respects the per-pass budget", () => {
    expect(planTopUp([inv("D", "1h", 0, { qualities: ["demo"] })], now)).toHaveLength(0);
    const many = Array.from({ length: 20 }, (_, i) => inv(`S${i}`, "1h", now - (i + 5) * H));
    expect(planTopUp(many, now)).toHaveLength(TOPUP_PER_PASS);
  });
});

describe("study store: forgetRuns", () => {
  it("drops the runs, keeps the study, and reports how many went", () => {
    const store = createStudyStore(createKV(memoryRawStore()));
    store.save({ ...rec("a", "BTCUSDT", "1h", 4), failures: 2 });
    expect(store.forgetRuns("a")).toBe(4);
    const after = store.get("a");
    expect(after?.runs).toHaveLength(0);
    expect(after?.failures).toBe(0);
    expect(after?.spec.symbol).toBe("BTCUSDT");
    expect(store.forgetRuns("a")).toBe(0);
    expect(store.forgetRuns("missing")).toBe(0);
  });
});
