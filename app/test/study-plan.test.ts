/**
 * The spec, the catalogue, the plan, the guards and the store.
 *
 * The one number this file exists to protect is the HYPOTHESIS COUNT. Every
 * honesty mechanic in the product hangs off it: the deflation, the
 * Benjamini-Hochberg adjustment, the sentence that says how many results would
 * clear 5% on noise. Under-count it by dropping a method's tests and the whole
 * correction quietly becomes decoration.
 */

import { describe, expect, it } from "vitest";
import {
  blocking,
  featureColumns,
  independentSeries,
  newStudy,
  roleForDriver,
  sliceSeries,
  specProblems,
  type ContextSeries,
  type StudySpec,
} from "../src/study/spec";
import { availability, MAX_LAG, METHOD_BY_ID, type MethodContext } from "../src/study/methods";
import { buildPlan, correctionFor, durationLabel, recordTiming, stepAvailability } from "../src/study/plan";
import {
  armable,
  DEFAULT_GUARDS,
  guardCheck,
  nextRunAt,
  readDecay,
  type Schedule,
  type StrengthPoint,
} from "../src/study/schedule";
import {
  createStudyStore,
  STUDIES_SLOT,
  strengthOf,
  summarise,
  type StudyRecord,
} from "../src/study/store";
import type { StudyReport } from "../src/study/run";
import type { QuantHealth } from "../src/data/quant";
import { createKV, memoryRawStore } from "../src/store/kv";

const HEALTHY: QuantHealth = {
  service: "iram-quant",
  python: "3.12.0",
  present: { numpy: "2.0", pandas: "2.2", statsmodels: "0.14", arch: "7.0", sklearn: "1.5" },
  missing: { prophet: "session and day-of-week seasonality" },
  degraded: ["session and day-of-week seasonality"],
};

function ctx(patch: Partial<MethodContext> = {}): MethodContext {
  return { checked: true, rows: 20_000, featureColumns: 4, driverColumns: 2, sliceSeries: 1, health: HEALTHY, ...patch };
}

function series(symbol: string, role: ContextSeries["role"]): ContextSeries {
  return { symbol, label: symbol, role, why: "stated" };
}

function spec(patch: Partial<StudySpec> = {}): StudySpec {
  return { ...newStudy("s1", "BTCUSDT", "1h", 0), methods: ["leadlag"], ...patch };
}

/* ── spec ───────────────────────────────────────────────────────────────── */

describe("roleForDriver", () => {
  it("makes a leading series a driver", () => {
    expect(roleForDriver("BTCUSDT", "US10Y", "lead")).toBe("driver");
  });

  it("makes a same-family context series a peer", () => {
    expect(roleForDriver("BTCUSDT", "ETHUSDT", "context")).toBe("peer");
  });

  it("makes an out-of-family context series a regime proxy", () => {
    expect(roleForDriver("BTCUSDT", "DXY", "context")).toBe("regime");
    expect(roleForDriver("BTCUSDT", "XAUUSD", "context")).toBe("regime");
  });
});

describe("featureColumns", () => {
  it("counts drivers, peers and controls but not regime proxies", () => {
    const s = spec({
      context: [
        series("US10Y", "driver"),
        series("ETHUSDT", "peer"),
        series("SPX500", "control"),
        series("DXY", "regime"),
      ],
    });
    expect(featureColumns(s)).toBe(3);
    expect(sliceSeries(s).map((c) => c.symbol)).toEqual(["DXY"]);
  });

  it("counts only drivers and controls as independent evidence", () => {
    const s = spec({
      context: [series("US10Y", "driver"), series("ETHUSDT", "peer"), series("DXY", "regime")],
    });
    expect(independentSeries(s)).toBe(1);
  });
});

describe("specProblems", () => {
  it("blocks the subject appearing as its own column", () => {
    const p = specProblems(spec({ context: [series("BTCUSDT", "driver")] }));
    expect(blocking(p).some((x) => x.text.includes("predicts the target perfectly"))).toBe(true);
  });

  it("blocks a duplicated series", () => {
    const p = specProblems(spec({ context: [series("DXY", "driver"), series("DXY", "regime")] }));
    expect(blocking(p).some((x) => x.text.includes("twice"))).toBe(true);
  });

  it("blocks a spec with no method chosen", () => {
    expect(blocking(specProblems(spec({ methods: [] }))).some((x) => x.field === "methods")).toBe(true);
  });

  it("cautions rather than blocks when every series is a peer or a proxy", () => {
    const p = specProblems(spec({ context: [series("ETHUSDT", "peer"), series("DXY", "regime")] }));
    expect(blocking(p)).toHaveLength(0);
    expect(p.some((x) => x.severity === "caution" && x.text.includes("independently confirm"))).toBe(true);
  });

  it("accepts a well-formed spec", () => {
    expect(blocking(specProblems(spec({ context: [series("DXY", "driver")] })))).toHaveLength(0);
  });
});

/* ── methods ────────────────────────────────────────────────────────────── */

describe("availability", () => {
  const leadlag = METHOD_BY_ID.get("leadlag");
  const seasonality = METHOD_BY_ID.get("seasonality");
  const garch = METHOD_BY_ID.get("garch");

  it("names the missing library AND what it costs", () => {
    const a = availability(seasonality!, ctx());
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") {
      expect(a.reason).toContain("prophet");
      expect(a.reason).toContain("session and day-of-week seasonality");
      expect(a.fixable).toBe(false);
    }
  });

  it("allows a method whose library is present", () => {
    expect(availability(garch!, ctx()).state).toBe("ready");
  });

  it("distinguishes an unreachable service from a missing package", () => {
    const a = availability(garch!, ctx({ health: null }));
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") expect(a.reason).toContain("python run.py");
  });

  it("marks a missing driver as fixable and a missing library as not", () => {
    const a = availability(leadlag!, ctx({ driverColumns: 0 }));
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") {
      expect(a.fixable).toBe(true);
      expect(a.reason).toContain("Driver");
    }
  });

  it("blocks on too few rows and says how many there are", () => {
    const a = availability(leadlag!, ctx({ rows: 100 }));
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") expect(a.reason).toContain("100");
  });

  it("does not claim a window holds zero rows before one was measured", () => {
    /* The screen said "the joint window holds 0" on a study where nothing had
       been fetched at all — which asserts that a window was computed and came
       back empty. Zero is a measurement; not having looked is not. */
    const a = availability(leadlag!, ctx({ checked: false, rows: 0 }));
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") {
      expect(a.reason).toContain("no bars have been fetched yet");
      expect(a.reason).not.toContain("holds 0");
    }
  });
});

/* ── plan ───────────────────────────────────────────────────────────────── */

describe("buildPlan", () => {
  it("counts every lag of every driver as a hypothesis", () => {
    /* 97 lags × 4 drivers. If this ever reads 1, the correction has stopped
       knowing what the study did. */
    const p = buildPlan(["leadlag"], ctx({ driverColumns: 4 }));
    expect(p.hypotheses).toBe((2 * MAX_LAG + 1) * 4);
  });

  it("puts a step after the one it reads", () => {
    const p = buildPlan(["baserates", "regimes"], ctx());
    expect(p.steps.map((s) => s.method.id)).toEqual(["regimes", "baserates"]);
  });

  it("blocks a step whose input was not selected", () => {
    const p = buildPlan(["excursion"], ctx());
    expect(p.steps).toHaveLength(0);
    expect(p.blocked[0]?.availability.state).toBe("blocked");
    if (p.blocked[0]?.availability.state === "blocked") {
      expect(p.blocked[0].availability.reason).toContain("Trend rules");
    }
  });

  it("unblocks it when ANY of its alternatives is selected", () => {
    const p = buildPlan(["sweep-rsi", "excursion"], ctx());
    expect(p.steps.map((s) => s.method.id)).toEqual(["sweep-rsi", "excursion"]);
  });

  it("does not count a blocked step's tests towards the correction", () => {
    const withBlocked = buildPlan(["leadlag", "seasonality"], ctx({ driverColumns: 1 }));
    const alone = buildPlan(["leadlag"], ctx({ driverColumns: 1 }));
    expect(withBlocked.hypotheses).toBe(alone.hypotheses);
  });

  it("refuses when nothing is selected, and says which kind of nothing", () => {
    expect(buildPlan([], ctx()).refusal).toContain("nothing to run");
    expect(buildPlan(["seasonality"], ctx()).refusal).toContain("Every method selected is blocked");
  });

  it("labels an estimate as a guess until a real run replaces it", () => {
    const first = buildPlan(["leadlag"], ctx());
    expect(first.steps[0]?.estimateFrom).toBe("guess");
    expect(first.anyMeasured).toBe(false);

    const timings = recordTiming({}, "leadlag", 20_000, 900);
    const second = buildPlan(["leadlag"], ctx(), timings);
    expect(second.steps[0]?.estimateFrom).toBe("measured");
    expect(second.anyMeasured).toBe(true);
  });
});

describe("stepAvailability", () => {
  /*
   * THE DEFECT THIS EXISTS FOR, found by using the desk rather than by any
   * type or test: the catalogue read its verdicts out of the PLAN, and the
   * plan holds only what is already selected. So every unselected card
   * rendered available — fifteen of them, on a study whose one Driver had
   * loaded no bars — and the operator discovered a method could not run by
   * clicking it.
   *
   * The distinguishing property is that these are asked with an EMPTY
   * selection, which is exactly the state the plan cannot answer for.
   */
  const none = new Set<string>();

  it("blocks a method on a missing library even when nothing is selected", () => {
    const a = stepAvailability(METHOD_BY_ID.get("seasonality")!, ctx(), none);
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") expect(a.reason).toContain("prophet");
  });

  it("blocks a method on a missing driver even when nothing is selected", () => {
    const a = stepAvailability(METHOD_BY_ID.get("leadlag")!, ctx({ driverColumns: 0 }), none);
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") expect(a.reason).toContain("Driver");
  });

  it("blocks a dependent method when its input is not selected", () => {
    const a = stepAvailability(METHOD_BY_ID.get("excursion")!, ctx(), none);
    expect(a.state).toBe("blocked");
    if (a.state === "blocked") expect(a.reason).toContain("Reads the output");
  });

  it("clears the dependent once any one of its inputs is selected", () => {
    const a = stepAvailability(METHOD_BY_ID.get("excursion")!, ctx(), new Set(["sweep-confluence"]));
    expect(a.state).toBe("ready");
  });

  it("agrees with the plan for a method that IS selected", () => {
    const viaPlan = buildPlan(["seasonality"], ctx()).blocked[0]?.availability;
    const direct = stepAvailability(METHOD_BY_ID.get("seasonality")!, ctx(), new Set(["seasonality"]));
    expect(viaPlan).toEqual(direct);
  });
});

describe("correctionFor", () => {
  it("states how many results would clear 5% on noise", () => {
    const c = correctionFor(480);
    expect(c.expectedByChance).toBeCloseTo(24, 6);
    expect(c.text).toContain("480");
    expect(c.text).toContain("24");
  });

  it("says nothing is being tested when nothing is", () => {
    expect(correctionFor(0).text).toContain("nothing to correct");
  });
});

describe("durationLabel", () => {
  it("speaks in minutes and seconds", () => {
    expect(durationLabel(134_000)).toBe("2m 14s");
    expect(durationLabel(38_000)).toBe("38s");
    expect(durationLabel(120_000)).toBe("2m");
    expect(durationLabel(400)).toBe("under a second");
  });
});

/* ── schedule ───────────────────────────────────────────────────────────── */

function report(patch: Partial<StudyReport> = {}): StudyReport {
  const base: StudyReport = {
    specId: "s1",
    name: "BTCUSDT 1h",
    symbol: "BTCUSDT",
    timeframe: "1h",
    at: 0,
    ms: 1,
    window: {
      requestedFrom: 0,
      requestedTo: 1,
      from: 0,
      to: 1,
      spanMs: 1,
      limitedBy: [],
      shortfall: null,
      refusal: null,
    },
    split: {
      total: 0,
      train: { name: "train", from: 0, to: 0, bars: 0 },
      validate: { name: "validate", from: 0, to: 0, bars: 0 },
      holdout: { name: "holdout", from: 0, to: 0, bars: 0 },
      embargo: 48,
      discarded: 96,
      refusal: null,
    },
    budget: { trainRows: 0, horizon: 24, effectiveN: 0, budget: 0, working: "" },
    rows: 0,
    panelWarnings: [],
    steps: [],
    hypotheses: 480,
    correction: {
      hypotheses: 480,
      claims: [],
      survivors: 1,
      sharpe: null,
      sharpeBasis: "",
      sharpeRefusal: null,
      rulesBefore: 0,
      rulesAfter: 0,
      pbo: null,
      text: "",
    },
    headline: "",
    limits: [],
    refusal: null,
    timings: {},
    holdout: "sealed",
  };
  return { ...base, ...patch };
}

describe("armable", () => {
  it("refuses while the holdout has never been opened", () => {
    const v = armable(report());
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("holdout has never been opened");
  });

  it("refuses when nothing survived the correction", () => {
    const v = armable(
      report({
        holdout: "opened",
        correction: { ...report().correction, survivors: 0 },
      }),
    );
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("480");
  });

  it("allows an opened holdout with a survivor", () => {
    expect(armable(report({ holdout: "opened" })).allowed).toBe(true);
  });

  it("refuses when there is no report at all", () => {
    expect(armable(null).allowed).toBe(false);
  });
});

describe("guardCheck", () => {
  const sched: Schedule = { cadence: "daily", enabled: true, actions: [], guards: DEFAULT_GUARDS };

  it("stops after the failure ceiling", () => {
    const v = guardCheck(sched, 0, 3);
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain("Disarmed");
  });

  it("stops at the daily ceiling", () => {
    expect(guardCheck(sched, 4, 0).allowed).toBe(false);
  });

  it("allows a normal run", () => {
    expect(guardCheck(sched, 1, 1).allowed).toBe(true);
  });

  it("refuses a schedule that is switched off", () => {
    expect(guardCheck({ ...sched, enabled: false }, 0, 0).allowed).toBe(false);
  });
});

describe("nextRunAt", () => {
  const sched: Schedule = { cadence: "daily", enabled: true, actions: [], guards: DEFAULT_GUARDS };

  it("adds a day for daily and a week for weekly", () => {
    expect(nextRunAt(sched, 1_000, 3_600_000)).toBe(1_000 + 86_400_000);
    expect(nextRunAt({ ...sched, cadence: "weekly" }, 0, 0)).toBe(7 * 86_400_000);
  });

  it("uses the bar interval for every-close, with a floor of a minute", () => {
    expect(nextRunAt({ ...sched, cadence: "bar" }, 0, 3_600_000)).toBe(3_600_000);
    expect(nextRunAt({ ...sched, cadence: "bar" }, 0, 1_000)).toBe(60_000);
  });

  it("never schedules a second run for once, and never any for a trigger", () => {
    expect(nextRunAt({ ...sched, cadence: "once" }, 5, 0)).toBeNull();
    expect(nextRunAt({ ...sched, cadence: "trigger" }, null, 0)).toBeNull();
  });
});

describe("readDecay", () => {
  const pts = (vals: readonly number[], measure = "Deflated Sharpe per trade"): StrengthPoint[] =>
    vals.map((value, i) => ({ at: i, value, measure }));

  it("calls a falling series decaying", () => {
    const d = readDecay(pts([0.72, 0.68, 0.6, 0.58, 0.51]), 0.55);
    expect(d.decaying).toBe(true);
    expect(d.belowFloor).toBe(true);
    expect(d.slope).toBeLessThan(0);
  });

  it("does not call a flat series decaying", () => {
    const d = readDecay(pts([0.7, 0.71, 0.69, 0.72, 0.7]), 0.55);
    expect(d.decaying).toBe(false);
    expect(d.belowFloor).toBe(false);
  });

  it("refuses a history whose measure changed", () => {
    const mixed = [...pts([0.8, 0.79], "Deflated Sharpe per trade"), ...pts([0.6, 0.55], "1 − smallest adjusted p")];
    const d = readDecay(mixed, 0.55);
    expect(d.refusal).toContain("not all report the same measure");
    expect(d.decaying).toBe(false);
  });

  it("refuses before there are enough runs to draw a line", () => {
    expect(readDecay(pts([0.8, 0.7, 0.6]), 0.55).refusal).toContain("floor before a trend");
  });
});

/* ── store ──────────────────────────────────────────────────────────────── */

describe("strengthOf", () => {
  it("prefers the deflated Sharpe, because it is the only penalised figure", () => {
    const r = report({
      correction: {
        ...report().correction,
        sharpe: {
          observed: 1.84,
          tries: 480,
          observations: 120,
          standardError: 0.15,
          hurdle: 1.13,
          deflated: 0.71,
          working: "",
        },
        claims: [{ label: "x", p: 0.01, q: 0.04, survives: true }],
      },
    });
    expect(strengthOf(r)).toEqual({ value: 0.71, measure: "Deflated Sharpe per trade" });
  });

  it("falls back to the adjusted p, under its own name", () => {
    const r = report({
      correction: {
        ...report().correction,
        claims: [
          { label: "x", p: 0.01, q: 0.04, survives: true },
          { label: "y", p: 0.4, q: 0.4, survives: false },
        ],
      },
    });
    expect(strengthOf(r)).toEqual({ value: 0.96, measure: "1 − smallest adjusted p" });
  });

  it("reports nothing rather than inventing a number", () => {
    expect(strengthOf(report()).value).toBeNull();
  });
});

describe("createStudyStore", () => {
  const rec = (id: string): StudyRecord => ({
    spec: { ...newStudy(id, "BTCUSDT", "1h", 0), methods: ["leadlag"] },
    schedule: { cadence: "once", enabled: false, actions: [], guards: DEFAULT_GUARDS },
    runs: [],
    failures: 0,
    filed: false,
  });

  it("saves, reads back and replaces by id", () => {
    const store = createStudyStore(createKV(memoryRawStore()));
    store.save(rec("a"));
    store.save(rec("b"));
    expect(store.list()).toHaveLength(2);
    store.save({ ...rec("a"), filed: true });
    expect(store.list()).toHaveLength(2);
    expect(store.get("a")?.filed).toBe(true);
  });

  it("counts a refusal as a failure and a result as a reset", () => {
    const store = createStudyStore(createKV(memoryRawStore()));
    store.save(rec("a"));
    store.record("a", summarise(report({ refusal: "no bars" })));
    store.record("a", summarise(report({ refusal: "still no bars" })));
    expect(store.get("a")?.failures).toBe(2);
    expect(store.get("a")?.runs).toHaveLength(2);
    store.record("a", summarise(report()));
    expect(store.get("a")?.failures).toBe(0);
    expect(store.get("a")?.runs).toHaveLength(3);
  });

  it("refuses to record against a study that is not stored", () => {
    const store = createStudyStore(createKV(memoryRawStore()));
    expect(store.record("ghost", summarise(report())).ok).toBe(false);
  });

  it("drops one corrupt study without losing the others", () => {
    const kv = createKV(memoryRawStore());
    const store = createStudyStore(kv);
    store.save(rec("a"));
    store.save(rec("b"));
    const list: unknown[] = kv.get(STUDIES_SLOT);
    kv.write(STUDIES_SLOT, [list[0], { spec: { id: 7 } }, list[1]] as never);
    expect(store.list()).toHaveLength(2);
    expect(store.list().map((r) => r.spec.id)).toEqual(["a", "b"]);
  });
});
