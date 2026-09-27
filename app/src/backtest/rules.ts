/**
 * Declarative strategies: rules as data, not as code.
 *
 * WHAT THIS IS FOR
 * The six strategies in `strategies.ts` are hand-written TypeScript. That is
 * the right shape for a strategy with real logic in it — the squeeze breakout
 * needs a rolling percentile, and expressing that as data would be worse than
 * expressing it as a function. But it makes every strategy a code change, which
 * means you cannot write one, and it means the terminal ships however many
 * somebody had time to write.
 *
 * A rule spec is `{ long, short, exitLong, exitShort, stop, tp }` where each
 * condition group is a list of `[left, operator, right]` triples ANDed
 * together, over a fixed vocabulary of indicator columns. That covers the large
 * majority of what published strategies actually do, it can be rendered back to
 * the reader in English, and — the point — it can be EDITED at runtime.
 *
 * WHAT THIS DELIBERATELY IS NOT
 * It is not a scripting language. There are no user-defined functions, no
 * arithmetic between operands, no loops, and no `eval` anywhere near it. A
 * condition is three tokens from a closed vocabulary, validated before it runs.
 * The reason is not sandbox paranoia so much as legibility: every rule in this
 * system can be printed as a sentence, and a rule that cannot be printed is a
 * rule you cannot check.
 *
 * THE COUNT, HONESTLY
 * The terminal this was recovered from advertised 35 strategies. They were 35
 * NAMES dispatched through a regular expression over the name itself, and they
 * collapsed onto roughly 18 distinct behaviours: all eight market-maker entries
 * — Avellaneda–Stoikov, order-flow imbalance, gamma scalping, cash-and-carry,
 * VWAP/TWAP execution and the rest — resolved to one Bollinger band-fade, and
 * the SMC entries (liquidity sweep, FVG retest, PDH/PDL) resolved to a second
 * one. To its credit the old build labelled several of those "Proxy" and
 * "Simplified model" in the note.
 *
 * This module ships the distinct behaviours, named for what they DO. A menu of
 * eight market-making strategies that are one mean-reversion rule in eight
 * costumes is not more choice; it is the same choice, obscured.
 */

import { ema, rsi, atr, macd, bollinger, vwap, stochastic, adx, roc, williamsR, cci, mfi, supertrendDirection, chandelier, donchian, ichimoku, keltner, squeeze } from "../chart/indicators";
import type { StrategyContext, EntrySignal } from "./engine";
import type { DocumentedStrategy } from "./strategies";
import {
  structuralColumns,
  STRUCTURAL_COLUMNS,
  type StructuralColumnId,
} from "./structural";

/* ------------------------------------------------------------- vocabulary */

/**
 * Every column a rule may name.
 *
 * A closed list, exported, because the editor renders exactly this and a rule
 * naming anything else is rejected at validation rather than evaluating to NaN
 * and quietly never firing — which is the failure mode that makes a broken
 * strategy look like a strategy with no signals.
 */
export const COLUMNS = {
  open: "Open",
  high: "High",
  low: "Low",
  close: "Close",
  ema9: "EMA 9",
  ema20: "EMA 20",
  ema21: "EMA 21",
  ema50: "EMA 50",
  ema200: "EMA 200",
  rsi: "RSI(14)",
  atr: "ATR(14)",
  macd: "MACD line",
  macds: "MACD signal",
  macdh: "MACD histogram",
  stochk: "Stochastic %K",
  stochd: "Stochastic %D",
  cci: "CCI(20)",
  willr: "Williams %R(14)",
  bbu: "Bollinger upper",
  bbm: "Bollinger middle",
  bbl: "Bollinger lower",
  stdir: "Supertrend direction",
  vwap: "VWAP",
  roc: "ROC(12) %",
  adx: "ADX(14)",
  mfi: "MFI(14)",

  /* v49 bands and systems. Every one of these uses the RANGE or a second
     instrument rather than rearranging close a sixth time — see the note at
     the foot of `chart/indicators.ts`. */
  kcu: "Keltner upper",
  kcm: "Keltner middle",
  kcl: "Keltner lower",
  dcu: "Donchian upper (excl. current bar)",
  dcl: "Donchian lower (excl. current bar)",
  squeeze: "Squeeze on (1 / 0)",
  celong: "Chandelier exit, long",
  ceshort: "Chandelier exit, short",
  tenkan: "Ichimoku conversion",
  kijun: "Ichimoku base",

  /* v49 structure. These are what the DETECTORS found, compiled to columns —
     see `backtest/structural.ts` for why every event is written at the bar it
     became knowable and never at the bar it began. */
  ...STRUCTURAL_COLUMNS,

  /* v63.21 CONTEXT. These are the only columns that come from a SECOND
     INSTRUMENT, and they exist because the shipped rules have no standalone
     edge: measured over 5 years and 821 trades per arm the best per-trade
     Sharpe was +0.070 against a hurdle of +0.102. The remaining question is
     not "which rule works" but "in which STATE does one work", and a state
     needs a second series.

     A CHANGE is computed on the context series' OWN bars before alignment —
     `dxy_chg5` is five DXY trading days, never five rows of a value carried
     across a weekend. `copper_gold` is DERIVED at read time: a ratio of two
     stored series is not a third series, only a second place to disagree. */
  dxy: "US dollar index",
  dxy_chg5: "US dollar index, 5-day change",
  us10y: "US 10-year yield",
  us10y_chg5: "US 10-year yield, 5-day change",
  us02y: "US 2-year yield",
  vix: "VIX",
  vix_chg5: "VIX, 5-day change",
  spx: "S&P 500",
  spx_chg5: "S&P 500, 5-day change",
  usdjpy: "USD/JPY",
  copper_gold: "Copper / gold ratio",
} as const;

/** The columns that come from a context series rather than from these bars. */
export const MACRO_COLUMNS = [
  "dxy", "dxy_chg5", "us10y", "us10y_chg5", "us02y",
  "vix", "vix_chg5", "spx", "spx_chg5", "usdjpy", "copper_gold",
] as const;

export type MacroColumnId = (typeof MACRO_COLUMNS)[number];

const MACRO_SET: ReadonlySet<string> = new Set(MACRO_COLUMNS);

export function isMacroColumn(v: string): v is MacroColumnId {
  return MACRO_SET.has(v);
}

export type ColumnId = keyof typeof COLUMNS;

export const OPERATORS = {
  ">": "is above",
  "<": "is below",
  ">=": "is at or above",
  "<=": "is at or below",
  crossabove: "crosses above",
  crossbelow: "crosses below",
} as const;

export type OperatorId = keyof typeof OPERATORS;

/** Right-hand side: another column, or a literal number written as a string. */
export type Operand = ColumnId | string;

/** `[left, operator, right]`. Left is always a column. */
export type Condition = readonly [ColumnId, OperatorId, Operand];

/** Conditions ANDed together. An empty group never fires. */
export type ConditionGroup = readonly Condition[];

export type StopSpec =
  | { readonly type: "atr"; readonly mult: number }
  | { readonly type: "pct"; readonly value: number };

export type TargetSpec =
  | { readonly type: "rr"; readonly value: number }
  | { readonly type: "pct"; readonly value: number }
  | { readonly type: "none" };

export type StrategyStyle = "scalp" | "intraday" | "swing" | "reversion" | "custom";

export interface RuleSpec {
  readonly id: string;
  readonly name: string;
  readonly style: StrategyStyle;
  readonly long: ConditionGroup;
  readonly short?: ConditionGroup;
  readonly exitLong?: ConditionGroup;
  readonly exitShort?: ConditionGroup;
  readonly stop: StopSpec;
  readonly target: TargetSpec;
  /** What it is trying to do, and anything the reader should distrust. */
  readonly note?: string;
}

/* -------------------------------------------------------------- validation */

export interface SpecProblem {
  readonly where: string;
  readonly message: string;
}

const isColumn = (v: string): v is ColumnId => Object.prototype.hasOwnProperty.call(COLUMNS, v);

/**
 * Read an operand: a column id, or a finite number.
 *
 * Returns null for anything else, which is what makes the validator able to
 * name the bad token instead of the rule failing silently at bar 200.
 */
export function parseOperand(v: Operand): { kind: "column"; id: ColumnId } | { kind: "number"; value: number } | null {
  if (typeof v !== "string") return null;
  if (isColumn(v)) return { kind: "column", id: v };
  /* `Number("")` and `Number("   ")` are both 0, so an EMPTY right-hand side
     would parse as a perfectly valid threshold of zero. In the editor that is
     a field the user has not filled in yet, and `RSI > 0` is true on every bar
     — the rule would fire constantly and look like it was working. Trimmed and
     rejected before the numeric conversion ever sees it. */
  const trimmed = v.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? { kind: "number", value: n } : null;
}

export function validateSpec(spec: RuleSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];

  const checkGroup = (group: ConditionGroup | undefined, where: string): void => {
    if (!group) return;
    group.forEach((cond, i) => {
      const at = `${where}[${i}]`;
      if (!Array.isArray(cond) || cond.length !== 3) {
        problems.push({ where: at, message: "A condition must be exactly [column, operator, value]." });
        return;
      }
      const [l, op, r] = cond;
      if (!isColumn(l)) problems.push({ where: at, message: `"${l}" is not an indicator this build computes.` });
      if (!Object.prototype.hasOwnProperty.call(OPERATORS, op)) {
        problems.push({ where: at, message: `"${op}" is not an operator.` });
      }
      if (parseOperand(r) === null) {
        problems.push({ where: at, message: `"${r}" is neither an indicator nor a number.` });
      }
    });
  };

  if (spec.long.length === 0 && (spec.short?.length ?? 0) === 0) {
    problems.push({ where: "entry", message: "A strategy with no entry condition never trades." });
  }
  checkGroup(spec.long, "long");
  checkGroup(spec.short, "short");
  checkGroup(spec.exitLong, "exitLong");
  checkGroup(spec.exitShort, "exitShort");

  if (spec.stop.type === "atr" && !(spec.stop.mult > 0)) {
    problems.push({ where: "stop", message: "An ATR stop needs a positive multiple." });
  }
  if (spec.stop.type === "pct" && !(spec.stop.value > 0)) {
    problems.push({ where: "stop", message: "A percent stop needs a positive distance." });
  }
  /* No stop is not a strategy the engine can test, and a strategy that cannot
     be tested must not be offered as one. */
  return problems;
}

/* -------------------------------------------------------------- evaluation */

type Columns = Partial<Record<ColumnId, Float64Array>>;

const cache = new WeakMap<StrategyContext, Columns>();

/**
 * Compute the columns a spec actually names, once per context.
 *
 * Only what is referenced: a rule using three indicators must not pay for
 * twenty-six, and the sweep in `lab.ts` runs hundreds of specs over the same
 * bars.
 */
function columnsFor(ctx: StrategyContext, needed: ReadonlySet<ColumnId>): Columns {
  let table = cache.get(ctx);
  if (!table) {
    table = {};
    cache.set(ctx, table);
  }
  const t = table;

  const want = (id: ColumnId, build: () => Float64Array): void => {
    if (!needed.has(id) || t[id]) return;
    t[id] = build();
  };

  want("open", () => ctx.open);
  want("high", () => ctx.high);
  want("low", () => ctx.low);
  want("close", () => ctx.close);
  want("ema9", () => ema(ctx.close, 9));
  want("ema20", () => ema(ctx.close, 20));
  want("ema21", () => ema(ctx.close, 21));
  want("ema50", () => ema(ctx.close, 50));
  want("ema200", () => ema(ctx.close, 200));
  want("rsi", () => rsi(ctx.close, 14));
  want("atr", () => atr(ctx.high, ctx.low, ctx.close, 14));
  want("roc", () => roc(ctx.close, 12));
  want("willr", () => williamsR(ctx.high, ctx.low, ctx.close, 14));
  want("cci", () => cci(ctx.high, ctx.low, ctx.close, 20));
  want("mfi", () => mfi(ctx.high, ctx.low, ctx.close, ctx.volume, 14));
  want("stdir", () => supertrendDirection(ctx.high, ctx.low, ctx.close, 10, 3));
  /* Session VWAP, reset daily. The reset boundary is part of the indicator:
     a VWAP accumulated across the whole series is a running average of the
     entire history, which is not what "VWAP" means to anyone reading it. */
  want("vwap", () => vwap(ctx.high, ctx.low, ctx.close, ctx.volume, ctx.time));
  want("adx", () => adx(ctx.high, ctx.low, ctx.close, 14).adx);
  want("squeeze", () => squeeze(ctx.high, ctx.low, ctx.close));

  if ((needed.has("kcu") || needed.has("kcm") || needed.has("kcl")) && !t.kcm) {
    const k = keltner(ctx.high, ctx.low, ctx.close);
    t.kcu = k.upper;
    t.kcm = k.middle;
    t.kcl = k.lower;
  }
  if ((needed.has("dcu") || needed.has("dcl")) && !t.dcu) {
    /* Current bar EXCLUDED. A channel that contains the bar being tested can
       never be broken by it, which turns every breakout rule built on it into
       a rule that never fires. */
    const d = donchian(ctx.high, ctx.low, 20, true);
    t.dcu = d.upper;
    t.dcl = d.lower;
  }
  if ((needed.has("celong") || needed.has("ceshort")) && !t.celong) {
    const ce = chandelier(ctx.high, ctx.low, ctx.close);
    t.celong = ce.long;
    t.ceshort = ce.short;
  }
  if ((needed.has("tenkan") || needed.has("kijun")) && !t.tenkan) {
    const ic = ichimoku(ctx.high, ctx.low, ctx.close);
    t.tenkan = ic.conversion;
    t.kijun = ic.base;
  }

  /* CONTEXT columns are supplied ALREADY ALIGNED on `ctx.macro` — see
     `backtest/macro.ts`. When the caller had no context series, the column is
     filled with NaN rather than zero: every comparison against NaN is false,
     so a rule conditioned on data nobody loaded simply never fires. A zero
     would read as a real dollar index of nought and the rule would fire on it. */
  for (const id of MACRO_COLUMNS) {
    if (!needed.has(id) || t[id]) continue;
    const supplied = ctx.macro?.[id];
    t[id] = supplied && supplied.length === ctx.close.length
      ? supplied
      : new Float64Array(ctx.close.length).fill(NaN);
  }

  /* Structural columns come from the detectors rather than from arithmetic,
     and are built in one pass for whichever of them the spec references. */
  const structural = structuralColumns(ctx, needed as ReadonlySet<string>);
  for (const [id, col] of Object.entries(structural)) {
    if (needed.has(id as ColumnId) && col !== undefined) {
      t[id as StructuralColumnId] = col;
    }
  }

  if ((needed.has("macd") || needed.has("macds") || needed.has("macdh")) && !t.macd) {
    const m = macd(ctx.close, 12, 26, 9);
    t.macd = m.macd;
    t.macds = m.signal;
    t.macdh = m.histogram;
  }
  if ((needed.has("stochk") || needed.has("stochd")) && !t.stochk) {
    const s = stochastic(ctx.high, ctx.low, ctx.close, 14, 3, 3);
    t.stochk = s.k;
    t.stochd = s.d;
  }
  if ((needed.has("bbu") || needed.has("bbm") || needed.has("bbl")) && !t.bbm) {
    const b = bollinger(ctx.close, 20, 2);
    t.bbu = b.upper;
    t.bbm = b.middle;
    t.bbl = b.lower;
  }

  return t;
}

function referenced(spec: RuleSpec): Set<ColumnId> {
  const out = new Set<ColumnId>();
  const scan = (g: ConditionGroup | undefined): void => {
    for (const [l, , r] of g ?? []) {
      out.add(l);
      const p = parseOperand(r);
      if (p?.kind === "column") out.add(p.id);
    }
  };
  scan(spec.long);
  scan(spec.short);
  scan(spec.exitLong);
  scan(spec.exitShort);
  /* Every ATR stop needs ATR whether or not a condition mentions it. */
  if (spec.stop.type === "atr") out.add("atr");
  return out;
}

const at = (col: Float64Array | undefined, i: number): number =>
  col === undefined || i < 0 || i >= col.length ? NaN : (col[i] as number);

/**
 * Evaluate one condition at bar `i`.
 *
 * A cross needs bar `i-1`, and any NaN anywhere makes the condition FALSE
 * rather than throwing or being treated as zero. During warm-up most columns
 * are NaN, and a rule that reads NaN as 0 fires a torrent of entries in the
 * first fifty bars of every backtest.
 */
function evalCondition(cond: Condition, cols: Columns, i: number): boolean {
  const [leftId, op, right] = cond;
  const left = cols[leftId];
  const now = at(left, i);
  if (!Number.isFinite(now)) return false;

  const p = parseOperand(right);
  if (p === null) return false;

  const rNow = p.kind === "number" ? p.value : at(cols[p.id], i);
  if (!Number.isFinite(rNow)) return false;

  switch (op) {
    case ">":
      return now > rNow;
    case "<":
      return now < rNow;
    case ">=":
      return now >= rNow;
    case "<=":
      return now <= rNow;
    case "crossabove":
    case "crossbelow": {
      const prev = at(left, i - 1);
      const rPrev = p.kind === "number" ? p.value : at(cols[p.id], i - 1);
      if (!Number.isFinite(prev) || !Number.isFinite(rPrev)) return false;
      return op === "crossabove" ? prev <= rPrev && now > rNow : prev >= rPrev && now < rNow;
    }
    default:
      return false;
  }
}

/** All conditions must hold. An EMPTY group is false — it is not "no filter". */
function evalGroup(group: ConditionGroup | undefined, cols: Columns, i: number): boolean {
  if (!group || group.length === 0) return false;
  for (const c of group) if (!evalCondition(c, cols, i)) return false;
  return true;
}

/* ------------------------------------------------------------------ render */

const operandLabel = (v: Operand): string => {
  const p = parseOperand(v);
  if (p === null) return String(v);
  return p.kind === "column" ? COLUMNS[p.id] : String(p.value);
};

/** One condition as English. */
export function conditionText(c: Condition): string {
  return `${COLUMNS[c[0]] ?? c[0]} ${OPERATORS[c[1]] ?? c[1]} ${operandLabel(c[2])}`;
}

/** A group as English, with the AND made explicit. */
export function groupText(g: ConditionGroup | undefined): string {
  if (!g || g.length === 0) return "—";
  return g.map(conditionText).join(" AND ");
}

export function stopText(s: StopSpec): string {
  return s.type === "atr" ? `${s.mult} × ATR(14) from entry` : `${s.value}% from entry`;
}

export function targetText(t: TargetSpec): string {
  if (t.type === "rr") return `${t.value}× the risk`;
  if (t.type === "pct") return `${t.value}% from entry`;
  return "exit rule only";
}

/* ----------------------------------------------------------------- compile */

/**
 * Warm-up: the longest lookback any referenced column needs, plus slack.
 *
 * EMA 200 is the binding constraint when present. Getting this wrong is not
 * cosmetic — the engine refuses to trade during warm-up, so understating it
 * means trading on values that are still converging.
 */
function warmupFor(needed: ReadonlySet<ColumnId>): number {
  let n = 20;
  if (needed.has("ema200")) n = Math.max(n, 200);
  if (needed.has("ema50")) n = Math.max(n, 50);
  if (needed.has("ema21")) n = Math.max(n, 21);
  if (needed.has("ema20")) n = Math.max(n, 20);
  if (needed.has("bbu") || needed.has("bbm") || needed.has("bbl")) n = Math.max(n, 20);
  if (needed.has("cci")) n = Math.max(n, 20);
  if (needed.has("adx")) n = Math.max(n, 28);
  if (needed.has("stdir")) n = Math.max(n, 20);
  if (needed.has("mfi") || needed.has("rsi") || needed.has("willr") || needed.has("stochk") || needed.has("stochd")) {
    n = Math.max(n, 18);
  }
  if (needed.has("macd") || needed.has("macds") || needed.has("macdh")) n = Math.max(n, 35);
  return n + 5;
}

/**
 * Turn a spec into a strategy the existing engine can run.
 *
 * The result is a normal `DocumentedStrategy`, so a declarative strategy goes
 * through the same walk-forward, the same cost model and the same overfitting
 * checks as a hand-written one. There is no second, more forgiving path for
 * strategies you wrote in the UI — that would be exactly the wrong place to be
 * lenient.
 */
export function compileSpec(spec: RuleSpec): DocumentedStrategy {
  const needed = referenced(spec);
  const warmup = warmupFor(needed);

  return {
    id: spec.id,
    label: spec.name,
    warmup,
    params: {
      stop: spec.stop.type === "atr" ? spec.stop.mult : spec.stop.value,
      target: spec.target.type === "none" ? 0 : spec.target.value,
    },
    rules: {
      entry: `LONG when ${groupText(spec.long)}${spec.short ? `; SHORT when ${groupText(spec.short)}` : ""}`,
      stop: stopText(spec.stop),
      exit:
        spec.target.type === "none"
          ? `exit rule: ${groupText(spec.exitLong)}`
          : `${targetText(spec.target)}, or the exit rule (${groupText(spec.exitLong)})`,
      ...(spec.note ? { note: spec.note } : {}),
    },

    entry(ctx: StrategyContext, i: number): EntrySignal | null {
      const cols = columnsFor(ctx, needed);
      const long = evalGroup(spec.long, cols, i);
      const short = !long && evalGroup(spec.short, cols, i);
      if (!long && !short) return null;

      const price = ctx.close[i] as number;
      if (!Number.isFinite(price) || price <= 0) return null;

      let risk: number;
      if (spec.stop.type === "atr") {
        const a = at(cols.atr, i);
        if (!Number.isFinite(a) || a <= 0) return null;
        risk = a * spec.stop.mult;
      } else {
        risk = (price * spec.stop.value) / 100;
      }
      if (!(risk > 0)) return null;

      const dir = long ? 1 : -1;
      const stop = price - dir * risk;

      let target: number | undefined;
      if (spec.target.type === "rr") target = price + dir * risk * spec.target.value;
      else if (spec.target.type === "pct") target = price * (1 + (dir * spec.target.value) / 100);

      return {
        direction: long ? "long" : "short",
        stop,
        ...(target !== undefined ? { target } : {}),
        reason: long ? groupText(spec.long) : groupText(spec.short),
      } satisfies EntrySignal;
    },

    exit(ctx: StrategyContext, position: { direction: "long" | "short" }, i: number): string | null {
      const group = position.direction === "long" ? spec.exitLong : spec.exitShort;
      if (!group || group.length === 0) return null;
      const cols = columnsFor(ctx, needed);
      return evalGroup(group, cols, i) ? `Exit rule: ${groupText(group)}` : null;
    },
  };
}
