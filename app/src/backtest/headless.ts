/**
 * The strategy lab, without a browser.
 *
 * SAME CHOICE AS `alert/headless.ts`, FOR THE SAME REASON
 * The tempting way to move a study off the browser thread is to rewrite the
 * engine in Python next to the data server, where numpy and every core are
 * already waiting. That gives two backtest engines, and the day they disagree
 * you find out from a strategy you promoted on the server's numbers and traded
 * on the terminal's. `vite.headless.config.ts` rejected exactly that trade-off
 * for the alert rules; a backtester is the one place where a silent divergence
 * is worth more money, not less.
 *
 * So this compiles the SHIPPED lab — `runStudy`, the same grid, the same
 * walk-forward, the same CSCV — into an ES module Node can import.
 *
 * THE UNIT OF PARALLELISM IS A STUDY, NOT A CONFIG.
 * `runStudy` owns its own grid, walk-forward and CSCV; those stages are not
 * independent of each other and splitting them across processes would mean
 * reaching inside the function this file exists to leave alone. What IS
 * independent is one study from the next, and that is the shape the work
 * actually arrives in — the Playbook runs three families against the same bars,
 * and a scan runs one family across a watchlist. Sixteen studies over eight
 * cores is the win; a thirteen-config grid split four ways is not.
 *
 * WHAT MOVING IT SERVER-SIDE BUYS, CONCRETELY
 *   * The grid runs across every core instead of one, and nothing about the
 *     study changes when it does — each config is independent by construction.
 *   * A study can outlive the tab that asked for it. `ui/strategy.ts` yields to
 *     the frame before calling `runStudy` so the button can show a running
 *     state, which is the whole vocabulary a synchronous browser call has for
 *     "this is taking a while".
 *   * A sweep can get big enough to be worth validating. PBO is only meaningful
 *     relative to how many variants were actually tried, and a grid sized to
 *     keep a tab responsive is a grid sized to make PBO look good.
 *
 * NOTHING HERE TOUCHES THE DOM, FETCHES, OR READS A CLOCK. Bars arrive as an
 * argument, results leave as a return value. That is what makes one study safe
 * to hand to a process that knows nothing about the others.
 */

import type { BarView } from "../chart/series";
import {
  FAMILIES,
  familyGrid,
  runStudy,
  runSpecStudy,
  runSubjectStudy,
  specGrid,
  subjectLabel,
  type Family,
  type Study,
  type StudyOptions,
  type StudySubject,
} from "./lab";
import {
  validateSpec,
  type ConditionGroup,
  type RuleSpec,
  type StopSpec,
  type StrategyStyle,
  type TargetSpec,
} from "./rules";

export { FAMILIES, familyGrid, runStudy, runSpecStudy, runSubjectStudy, specGrid, subjectLabel };
export { SPECS } from "./specs";
export type { Family, Study, StudyOptions, StudySubject, RuleSpec, BarView };

/* The ledger side of the engine. Same modules the browser uses, compiled into
   the same bundle, so a result computed on the server and a result computed in
   a tab cannot come from different arithmetic. */
import { collectSignals } from "./collect";
import { buildLedger, baseRate } from "./ledger";
import { simulateAccount } from "./account";
import { computeMetrics } from "./metrics";
import { runBacktest, DEFAULT_COSTS, type Costs } from "./engine";
import { compileSpec } from "./rules";
import { buildMacroColumns, type ContextSeries, type MacroBar } from "./macro";
import { SPECS as SHIPPED_SPECS } from "./specs";

export interface JobResult {
  /** Context series this job was actually given. Empty means none arrived. */
  context?: readonly string[];
  /** What was studied: `{kind:"family",id}` or `{kind:"spec",id,spec}`. */
  subject: StudySubject;
  /**
   * How many configurations were actually evaluated.
   *
   * Read off the STUDY, not off the grid. It used to be `familyGrid(f).length`,
   * which is the grid's SIZE — and on the refusal path the study evaluates
   * nothing while that expression still reported twelve. The two agree on every
   * path that ran, so the change is invisible except where it was wrong.
   */
  configs: number;
  study: Study;
  /** Wall-clock milliseconds, for the fan-out report. */
  ms: number;
}

export interface ParsedJob {
  subject: StudySubject;
  bars: BarView[];
  opts: StudyOptions;
  /** The context series the job supplied, if any. Absent means none were sent. */
  context?: ContextSeries;
}

/**
 * `{ SYMBOL: [{t, c}, …] }` or nothing.
 *
 * REFUSES rather than repairs. A context series that cannot be read is not an
 * empty one: silently dropping it would leave every conditioned arm reading NaN
 * and never firing, which looks exactly like a rule that had no signal — the
 * worst available failure, because the run completes and reports a number.
 */
export function parseContext(raw: unknown): ContextSeries | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Record<string, MacroBar[]> = {};
  for (const [symbol, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) {
      throw new Error(`context.${symbol} must be an array of {t, c} bars`);
    }
    const bars: MacroBar[] = [];
    for (let i = 0; i < v.length; i += 1) {
      const b = v[i] as Record<string, unknown>;
      const t = b?.["t"];
      const c = b?.["c"];
      if (typeof t !== "number" || !Number.isFinite(t) || typeof c !== "number" || !Number.isFinite(c)) {
        throw new Error(`context.${symbol}[${i}] needs a finite t and c`);
      }
      bars.push({ t, c });
    }
    /* ASCENDING, because `alignMacro` walks both series once together and an
       out-of-order bar would be read as the newest known value at the wrong
       moment. Sorting here is cheap; discovering it downstream is not. */
    bars.sort((a, b) => a.t - b.t);
    out[symbol] = bars;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Every style the editor can produce, exhaustively.
 *
 * A `Record<StrategyStyle, true>` object literal cannot miss a member and
 * cannot carry an extra one, so this list is checked against the real union by
 * the compiler rather than by whoever last added a style. A hand-written
 * `readonly string[]` would have drifted silently, which is the exact trap
 * CLAUDE.md records three times over.
 */
const STYLES: Record<StrategyStyle, true> = {
  scalp: true,
  intraday: true,
  swing: true,
  reversion: true,
  custom: true,
};

const str = (o: Record<string, unknown>, k: string, where: string): string => {
  const v = o[k];
  if (typeof v !== "string" || v.trim() === "") throw new Error(`${where}.${k} must be a non-empty string`);
  return v;
};

const group = (o: Record<string, unknown>, k: string, where: string): ConditionGroup => {
  const v = o[k];
  if (!Array.isArray(v)) throw new Error(`${where}.${k} must be an array of conditions`);
  /* The CONTENTS are `validateSpec`'s job, and it names the offending token and
     the index. Duplicating that check here would give two answers to the same
     question and they would disagree the first time the vocabulary grows. */
  return v as ConditionGroup;
};

function parseStop(raw: unknown): StopSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("spec.stop must be an object");
  const o = raw as Record<string, unknown>;
  const value = o["type"] === "atr" ? o["mult"] : o["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`spec.stop.${o["type"] === "atr" ? "mult" : "value"} must be a finite number`);
  }
  if (o["type"] === "atr") return { type: "atr", mult: value };
  if (o["type"] === "pct") return { type: "pct", value };
  throw new Error(`spec.stop.type must be "atr" or "pct", not ${JSON.stringify(o["type"])}`);
}

function parseTarget(raw: unknown): TargetSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("spec.target must be an object");
  const o = raw as Record<string, unknown>;
  if (o["type"] === "none") return { type: "none" };
  const value = o["value"];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("spec.target.value must be a finite number");
  }
  if (o["type"] === "rr") return { type: "rr", value };
  if (o["type"] === "pct") return { type: "pct", value };
  throw new Error(`spec.target.type must be "rr", "pct" or "none", not ${JSON.stringify(o["type"])}`);
}

/**
 * Read a `RuleSpec` off the wire.
 *
 * Two layers, on purpose. This one checks the SHAPE — that `stop` is an object
 * with a type this build knows and a finite number in it — because
 * `validateSpec` reads `spec.stop.type` and `spec.long.length` directly and
 * would throw a `TypeError` on `{"stop": 7}` rather than say what was wrong.
 * `validateSpec` then checks the CONTENT, which is the part that has to stay in
 * one place: it is the same function the editor calls, so a rule the editor
 * accepted cannot be refused here for a reason the editor never mentioned.
 */
export function parseSpec(raw: unknown): RuleSpec {
  if (typeof raw !== "object" || raw === null) throw new Error("spec must be an object");
  const o = raw as Record<string, unknown>;

  const style = str(o, "style", "spec");
  if (!Object.prototype.hasOwnProperty.call(STYLES, style)) {
    throw new Error(`spec.style ${JSON.stringify(style)} is not one of ${Object.keys(STYLES).join(", ")}`);
  }

  const note = o["note"];
  if (note !== undefined && typeof note !== "string") throw new Error("spec.note must be a string");

  const spec: RuleSpec = {
    id: str(o, "id", "spec"),
    name: str(o, "name", "spec"),
    style: style as StrategyStyle,
    long: group(o, "long", "spec"),
    ...(o["short"] !== undefined ? { short: group(o, "short", "spec") } : {}),
    ...(o["exitLong"] !== undefined ? { exitLong: group(o, "exitLong", "spec") } : {}),
    ...(o["exitShort"] !== undefined ? { exitShort: group(o, "exitShort", "spec") } : {}),
    stop: parseStop(o["stop"]),
    target: parseTarget(o["target"]),
    ...(typeof note === "string" ? { note } : {}),
  };

  const problems = validateSpec(spec);
  if (problems.length > 0) {
    throw new Error(`spec is not testable: ${problems.map((p) => `${p.where} — ${p.message}`).join("; ")}`);
  }
  return spec;
}

/**
 * Validate a job that arrived as JSON from another process.
 *
 * Everything crossing a process boundary is untrusted input, including input
 * this repo sent itself: a version skew between the gateway and a stale
 * `lab-engine.mjs` looks exactly like a malformed job, and saying so beats a
 * `TypeError` inside a strategy on bar 4,000.
 *
 * TWO SHAPES, AND EXACTLY ONE OF THEM PER JOB.
 *   {"family":"ema",  "bars":[...], "opts":{}}   — unchanged, byte for byte
 *   {"spec":{...},    "bars":[...], "opts":{}}
 * Neither is a job with no subject; both is a job whose subject is a guess.
 * Refusing both cases beats picking one and being right half the time.
 */
export function parseJob(raw: unknown): ParsedJob {
  if (typeof raw !== "object" || raw === null) throw new Error("job must be an object");
  const job = raw as Record<string, unknown>;

  const hasFamily = job["family"] !== undefined && job["family"] !== null;
  const hasSpec = job["spec"] !== undefined && job["spec"] !== null;
  if (hasFamily && hasSpec) {
    throw new Error("job names both `family` and `spec` — a study has one subject, so which one is a guess");
  }
  if (!hasFamily && !hasSpec) {
    throw new Error("job names neither `family` nor `spec` — nothing to study");
  }

  let subject: StudySubject;
  if (hasFamily) {
    const family = job["family"];
    if (typeof family !== "string" || !FAMILIES.some((f) => f.id === family)) {
      throw new Error(`unknown family ${JSON.stringify(family)} — expected one of ${FAMILIES.map((f) => f.id).join(", ")}`);
    }
    subject = { kind: "family", id: family as Family };
  } else {
    const spec = parseSpec(job["spec"]);
    subject = { kind: "spec", id: spec.id, spec };
  }

  const rawBars = job["bars"];
  if (!Array.isArray(rawBars)) throw new Error("job.bars must be an array");

  const bars: BarView[] = rawBars.map((b, i) => {
    const bar = b as Record<string, unknown>;
    const num = (k: string): number => {
      const v = bar[k];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`bars[${i}].${k} is not a finite number`);
      }
      return v;
    };
    return { t: num("t"), o: num("o"), h: num("h"), l: num("l"), c: num("c"), v: num("v") };
  });

  // Ascending and strictly increasing is the contract `Series` documents, and a
  // backtest on out-of-order bars produces plausible nonsense rather than an
  // error — the failure mode this whole file exists to avoid.
  for (let i = 1; i < bars.length; i++) {
    if ((bars[i] as BarView).t <= (bars[i - 1] as BarView).t) {
      throw new Error(`bars[${i}].t is not after bars[${i - 1}].t — bars must be ascending and unique`);
    }
  }

  const rawOpts = (typeof job["opts"] === "object" && job["opts"] !== null ? job["opts"] : {}) as StudyOptions;

  /* CONTEXT SERIES, ALIGNED ONCE PER JOB.
     `job.context` is `{ SYMBOL: [{t, c}, …] }` at DAILY bars — the spine a
     conditioned rule is filtered by. It is aligned here, once, rather than per
     arm: a 44,000-bar study against a 25,000-bar daily series would otherwise
     redo the walk for every one of 150 conditioned arms.
     `buildMacroColumns` owns the look-ahead rule; see its header. */
  const parsed = parseContext(job["context"]);
  const opts: StudyOptions =
    parsed === null
      ? rawOpts
      : { ...rawOpts, macro: buildMacroColumns(bars.map((b) => b.t), parsed).columns };

  return { subject, bars, opts, ...(parsed === null ? {} : { context: parsed }) };
}

/** One ledger row, in the shape `svc/router.py` reads. */
export interface LedgerRow {
  t: number;
  outcome: string;
  features: Record<string, number>;
}

/**
 * A cost model from a job, or the default — never a mixture of the two.
 *
 * ALL THREE TERMS OR NONE. Taking the spread from the job and leaving commission
 * and slippage at their defaults would produce a third cost model that is
 * neither what was asked for nor what was assumed, and a result charged with it
 * could not be reproduced from either. That is the same shape as the unit
 * defaults this project records: a figure that is wrong with no symptom.
 *
 * A term that is absent, negative, NaN or not a number makes the whole thing a
 * refusal, and the refusal is the DEFAULT rather than an error — the autonomous
 * loop must not stop searching because a caller sent a bad field, and the result
 * says which model it used either way.
 */
export function readCosts(raw: unknown): Costs {
  if (typeof raw !== "object" || raw === null) return DEFAULT_COSTS;
  const o = raw as Record<string, unknown>;
  const term = (k: string): number | null => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  };
  const spread = term("spread");
  const commission = term("commission");
  const slippage = term("slippage");
  /* CARRY IS OPTIONAL ON THE WIRE AND ONLY BECAUSE OF THE FORMAT. `lab.py` and
     its tests describe a three-term cost object, and a job written before this
     field existed is a valid job, not a bad one. An ABSENT carry therefore takes
     the DEFAULT rate rather than zero: zero is the cost model this engine was
     wrong about for its whole life, and reinstating it for every older caller
     would undo the fix quietly. A PRESENT but malformed carry is a bad field and
     refuses the whole object, like the other three. */
  const carryRaw = o["carryPerNight"];
  const carry =
    carryRaw === undefined
      ? DEFAULT_COSTS.carryPerNight
      : typeof carryRaw === "number" && Number.isFinite(carryRaw) && carryRaw >= 0
        ? carryRaw
        : null;
  if (spread === null || commission === null || slippage === null || carry === null) {
    return DEFAULT_COSTS;
  }
  return { spread, commission, slippage, carryPerNight: carry };
}

export interface LedgerJobResult {
  subject: StudySubject;
  /**
   * What this run was CHARGED, stated rather than assumed.
   *
   * Two runs of one rule under different spreads are different findings, so a
   * result that does not carry its cost model cannot be compared with another
   * or re-derived later. Always present; equal to `DEFAULT_COSTS` unless the
   * job asked for something else.
   */
  costs: Costs;
  /** The rows a router trains on. */
  rows: LedgerRow[];
  /** What the sample is and what it lost, so a total is never reported alone. */
  sample: {
    found: number;
    resolved: number;
    baseRate: number;
    measuredShare: number;
    /** Setups the feature matrix could not describe, dropped rather than filled. */
    unfeatured: number;
    /** Bars the strategy was asked about at all. */
    asked: number;
    /** Signals the ledger could not resolve, with the reason. */
    skipped: number;
    why: string;
    /** Feature columns this series could not support. */
    omitted: string[];
  };
  /** The rule's own result over the same bars, in R and in money. */
  metrics: ReturnType<typeof computeMetrics>;
  account: ReturnType<typeof simulateAccount>;
  bars: number;
  from: number;
  to: number;
  ms: number;
}

/**
 * The shipped rule library, so a caller need not hold a second copy of it.
 *
 * The autonomous loop studies every rule in the library and had no way to learn
 * what that library is — the alternative was a list in Python that would drift
 * from `specs.ts` the first time a rule was added, which is the two-lists defect
 * CLAUDE.md records for the desk groups.
 */
export function specCatalogue(): RuleSpec[] {
  /* THE WHOLE SPEC, NOT A LABEL FOR IT. The first version returned
     `{id, name, style}` and was useless for its own purpose: a caller listing
     the library then had nothing it could run, because a ledger job needs the
     RULE. Driving the worker found it on the first attempt —
     "spec.style must be a non-empty string" against a bare id. */
  return SHIPPED_SPECS.map((sp) => ({ ...sp }));
}

/**
 * Run one rule over one series and record EVERY setup it produced.
 *
 * Not a grid search: one spec, one pass, the ledger a router can be trained on
 * plus what the same rule did to an account. `opts.balance` and `opts.riskPct`
 * are the account's, and `opts.horizon` is how long a setup has to resolve
 * before it is called a timeout — a constant across rules on purpose, because a
 * horizon that moved with the rule would make two rules' base rates
 * incomparable, and the base rate is the number a router has to beat.
 */
export function runLedgerJob(raw: unknown): LedgerJobResult {
  const started = Date.now();
  /* `specId` names a SHIPPED rule, so a caller running the library sends an id
     and not a copy of the rule. A copy is a second definition free to drift —
     the same argument the catalogue exists for, from the other direction. */
  const job = (typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >;
  const wantedId = job["specId"];
  if (typeof wantedId === "string" && job["spec"] === undefined) {
    const found = SHIPPED_SPECS.find((sp) => sp.id === wantedId);
    if (found === undefined) {
      throw new Error(
        `no shipped rule called ${JSON.stringify(wantedId)} — the library has ` +
          `${SHIPPED_SPECS.length}, and a ledger cannot be built for one that does not exist`,
      );
    }
    job["spec"] = found;
  }
  const { subject, bars, opts } = parseJob(job);
  if (subject.kind !== "spec") {
    throw new Error("a ledger job needs a `spec` — a family is a grid search, and a ledger is one rule");
  }

  const o = opts as unknown as Record<string, unknown>;
  const num = (k: string, fallback: number): number => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const horizon = Math.floor(num("horizon", 100));
  const balance = num("balance", 500);
  const riskPct = num("riskPct", 1);

  /*
   * THE HURDLE IS NOW SAYABLE, AND ITS DEFAULT HAS NOT MOVED.
   *
   * `DEFAULT_COSTS` was hardcoded here, and this is the AUTONOMOUS SEARCH — 85
   * rules, nobody watching. A COST MODEL IS A HURDLE, so charging a flat 2bp
   * silently discards rules that would have cleared the real spread; measured
   * against this operator's broker that assumption is 4.8x the true figure on
   * gold. Overcharging a search is not the safe direction.
   *
   * It is NOT switched to the measured spread here, and that is deliberate: a
   * figure that moves under the operator because a service answered is worse
   * than a disagreement they can see, and the machine's promotions would change
   * with no press behind them. So the job may CARRY costs, the default is
   * exactly what it always was, and the result states which it used — the
   * caller decides, and nothing decides for them.
   */
  const costs = readCosts(o["costs"]);

  const strategy = compileSpec(subject.spec);
  const got = collectSignals(strategy, bars);
  const led = buildLedger(bars, got.signals, { horizon, costs });
  const base = baseRate(led);

  const bt = runBacktest(strategy, bars, { costs, riskPerTrade: riskPct / 100 });
  const metrics = computeMetrics(bt.trades, bt.equity);
  const account = simulateAccount(bt.trades, { balance, riskPct });

  return {
    subject,
    costs,
    /* Only what the router reads. A candidate also carries prices, stops and
       an R multiple, and shipping 1,800 of those per rule over a pipe for a
       model that never looks at them is bytes nobody asked for. */
    rows: led.candidates.map((c) => ({
      t: c.time,
      outcome: c.outcome,
      features: c.features as Record<string, number>,
    })),
    sample: {
      found: led.candidates.length,
      resolved: base.decided,
      baseRate: base.rate,
      measuredShare: led.measuredShare,
      unfeatured: got.unfeatured,
      asked: got.asked,
      skipped: led.skipped,
      why: led.why,
      omitted: [...got.matrix.omitted],
    },
    metrics,
    account,
    bars: bars.length,
    from: bars.length > 0 ? (bars[0] as BarView).t : 0,
    to: bars.length > 0 ? (bars[bars.length - 1] as BarView).t : 0,
    ms: Date.now() - started,
  };
}

/** Run one study, start to finish. This is what a worker process does. */
export function runJob(raw: unknown): JobResult {
  const { subject, bars, opts, context } = parseJob(raw);
  const started = Date.now();
  const study = runSubjectStudy(subject, bars, opts);
  /* A run that had no context is not the same as one whose rules found
     nothing, and from the outside they look identical: both complete and both
     report numbers. Say which this was. */
  const conditioned = context ? Object.keys(context).sort() : [];
  return {
    subject,
    configs: study.configs.length,
    study,
    ms: Date.now() - started,
    context: conditioned,
  };
}
