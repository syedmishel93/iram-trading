/**
 * The Strategy desk's draft: rule LINES, each carrying who wrote it.
 *
 * WHY LINES AND NOT A RuleSpec
 * The engine's `RuleSpec` is groups of conditions plus one stop and one
 * target — it has nowhere to record that the analyst drafted "RSI crosses
 * above 30" and the operator added "ADX above 20". The desk's promise is "edit
 * any line · the AI marks its own", so the draft is a list of lines, each with
 * an author, and the spec is DERIVED from it (`specFromDraft`) at the moment it
 * is tested. There is one owner of the rules — this list — and the spec is a
 * reading of it, never a second copy that could disagree.
 *
 * AUTHORSHIP RULES
 *  - A line the analyst produced is "ai".
 *  - Any line the operator adds or edits becomes "you". Editing an AI line
 *    makes it yours: the words on screen are then yours, whoever wrote them
 *    first.
 *  - When the analyst redrafts, a line IDENTICAL to one already on the desk
 *    keeps its author and id (`linesFromSpec`). Without that, every redraft
 *    would re-stamp the operator's own rules as the AI's.
 *
 * NOTHING IS DEFAULTED. A draft with no stop is not given one: `specFromDraft`
 * refuses and names what is missing, because a stop the operator did not
 * choose would be tested and reported as their strategy.
 */

import {
  conditionText,
  stopText,
  targetText,
  validateSpec,
  COLUMNS,
  OPERATORS,
  type Condition,
  type ConditionGroup,
  type RuleSpec,
  type SpecProblem,
  type StopSpec,
  type TargetSpec,
} from "../../backtest/rules";
import type { Slot } from "../../store/kv";

export type Author = "ai" | "you";
export type Section = "long" | "short" | "exitLong" | "exitShort";

export const SECTIONS: readonly Section[] = ["long", "short", "exitLong", "exitShort"];

/** Plain words for each group. "Buy when", not "long". */
export const SECTION_LABEL: Readonly<Record<Section, string>> = {
  long: "Buy when",
  short: "Sell short when",
  exitLong: "Close a buy when",
  exitShort: "Close a short when",
};

export type RuleLine =
  | { readonly id: string; readonly author: Author; readonly kind: "cond"; readonly section: Section; readonly cond: Condition }
  | { readonly id: string; readonly author: Author; readonly kind: "stop"; readonly stop: StopSpec }
  | { readonly id: string; readonly author: Author; readonly kind: "target"; readonly target: TargetSpec };

/** Paper trading: forward-tested from `since`, for THIS version of the rules only. */
export interface PaperMark {
  readonly since: number;
  readonly fingerprint: string;
}

export interface Draft {
  readonly id: string;
  readonly name: string;
  readonly lines: readonly RuleLine[];
  readonly paper: PaperMark | null;
}

export interface ChatLine {
  readonly who: "you" | "ai" | "note";
  readonly text: string;
  readonly at: number;
}

/** One backtest, as the library remembers it. Numbers only — trades are not stored. */
export interface RunSummary {
  readonly at: number;
  readonly fingerprint: string;
  readonly name: string;
  readonly lines: readonly string[];
  readonly symbol: string;
  readonly timeframe: string;
  readonly bars: number;
  readonly trades: number;
  readonly expectancyR: number;
  /** Null when the walk-forward could not run. */
  readonly oosExpectancyR: number | null;
  readonly oosTrades: number;
}

export type DecisionKind = "iterate" | "paper" | "discard";

export const DECISION_LABEL: Readonly<Record<DecisionKind, string>> = {
  iterate: "Keep iterating",
  paper: "Paper trade it",
  discard: "Discard",
};

export interface DecisionRecord {
  readonly at: number;
  readonly kind: DecisionKind;
  readonly name: string;
  readonly fingerprint: string;
  readonly lines: readonly string[];
  /** Required for a discard; "" otherwise. */
  readonly reason: string;
  readonly symbol: string;
  readonly timeframe: string;
  /** The last backtest of this version, if there was one. */
  readonly result: RunSummary | null;
}

export interface FlowState {
  readonly draft: Draft;
  readonly chat: readonly ChatLine[];
  readonly library: readonly RunSummary[];
  readonly decisions: readonly DecisionRecord[];
}

/** Kept, newest last. Old enough runs stop being evidence about this market anyway. */
export const LIBRARY_CAP = 100;
export const CHAT_CAP = 60;
export const DECISION_CAP = 200;

export const emptyDraft = (id = `draft-${Date.now().toString(36)}`): Draft => ({
  id,
  name: "",
  lines: [],
  paper: null,
});

export const emptyFlow = (): FlowState => ({ draft: emptyDraft(), chat: [], library: [], decisions: [] });

// ----------------------------------------------------------------- lines ---

/** Canonical content of a line, author and id excluded. Two lines with the same key say the same thing. */
export function lineKey(l: RuleLine): string {
  if (l.kind === "cond") return `${l.section}|${l.cond[0]}|${l.cond[1]}|${String(l.cond[2]).trim()}`;
  if (l.kind === "stop") return l.stop.type === "atr" ? `stop|atr|${l.stop.mult}` : `stop|pct|${l.stop.value}`;
  return l.target.type === "none" ? "target|none" : `target|${l.target.type}|${l.target.value}`;
}

/** The line as a sentence, from the same data the engine reads. */
export function lineText(l: RuleLine): string {
  if (l.kind === "cond") return `${SECTION_LABEL[l.section]} ${conditionText(l.cond)}`;
  if (l.kind === "stop") return `Stop ${stopText(l.stop)}`;
  return `Target ${targetText(l.target)}`;
}

/** The next free id in a list: "l1", "l2", … Deterministic, so a test can name a line. */
export function nextLineId(lines: readonly RuleLine[]): string {
  let max = 0;
  for (const l of lines) {
    const n = Number(l.id.replace(/^l/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `l${max + 1}`;
}

/**
 * A spec as lines. Lines identical to one in `previous` keep that line's id
 * and AUTHOR; everything else is stamped `author`.
 */
export function linesFromSpec(spec: RuleSpec, author: Author, previous: readonly RuleLine[] = []): RuleLine[] {
  const prior = new Map<string, RuleLine>();
  for (const l of previous) if (!prior.has(lineKey(l))) prior.set(lineKey(l), l);

  const out: RuleLine[] = [];
  const used = new Set<string>();
  const take = (fresh: RuleLine): void => {
    const k = lineKey(fresh);
    const old = prior.get(k);
    if (old && !used.has(old.id)) {
      used.add(old.id);
      out.push({ ...fresh, id: old.id, author: old.author } as RuleLine);
      return;
    }
    const id = nextLineId([...previous, ...out]);
    out.push({ ...fresh, id } as RuleLine);
  };

  for (const section of SECTIONS) {
    const group: ConditionGroup = spec[section] ?? [];
    for (const cond of group) take({ id: "", author, kind: "cond", section, cond });
  }
  take({ id: "", author, kind: "stop", stop: spec.stop });
  take({ id: "", author, kind: "target", target: spec.target });
  return out;
}

export type DraftSpec =
  | { readonly ok: true; readonly spec: RuleSpec; readonly fingerprint: string }
  | { readonly ok: false; readonly problems: readonly SpecProblem[] };

/**
 * The draft as a spec the engine can run — or every reason it cannot be.
 *
 * Refuses rather than defaults: no stop, two stops, no target, or a target
 * with no size are named problems. `validateSpec`'s own messages follow,
 * verbatim, as the Playbook shows them.
 */
export function specFromDraft(d: Draft): DraftSpec {
  const problems: SpecProblem[] = [];
  const groups: Record<Section, Condition[]> = { long: [], short: [], exitLong: [], exitShort: [] };
  const stops: StopSpec[] = [];
  const targets: TargetSpec[] = [];
  for (const l of d.lines) {
    if (l.kind === "cond") groups[l.section].push(l.cond);
    else if (l.kind === "stop") stops.push(l.stop);
    else targets.push(l.target);
  }
  if (d.lines.length === 0) {
    return { ok: false, problems: [{ where: "rules", message: "There are no rules yet. Describe the idea above, or add your own rule." }] };
  }
  if (stops.length === 0) problems.push({ where: "stop", message: "A stop is required — add one. None is assumed." });
  if (stops.length > 1) problems.push({ where: "stop", message: `There are ${stops.length} stops; keep one.` });
  if (targets.length === 0) {
    problems.push({ where: "target", message: 'A target is required — choose "exit rule only" if it leaves only on its stop or a close rule.' });
  }
  if (targets.length > 1) problems.push({ where: "target", message: `There are ${targets.length} targets; keep one.` });
  const target = targets[0];
  if (target && target.type !== "none" && !(target.value > 0)) {
    problems.push({ where: "target", message: "A target needs a positive size." });
  }
  const stop = stops[0];
  if (!stop || !target) return { ok: false, problems };

  const spec: RuleSpec = {
    id: d.id,
    name: d.name.trim() || "Untitled draft",
    style: "custom",
    long: groups.long,
    ...(groups.short.length > 0 ? { short: groups.short } : {}),
    ...(groups.exitLong.length > 0 ? { exitLong: groups.exitLong } : {}),
    ...(groups.exitShort.length > 0 ? { exitShort: groups.exitShort } : {}),
    stop,
    target,
  };
  problems.push(...validateSpec(spec));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, spec, fingerprint: fingerprint(spec) };
}

/**
 * The rules' identity, independent of the order conditions were written in
 * (a group is an AND) and of the name. Two drafts with the same fingerprint
 * trade identically.
 */
export function fingerprint(spec: RuleSpec): string {
  const g = (c: ConditionGroup | undefined): string[] =>
    (c ?? []).map((x) => `${x[0]} ${x[1]} ${String(x[2]).trim()}`).sort();
  return JSON.stringify({
    l: g(spec.long),
    s: g(spec.short),
    xl: g(spec.exitLong),
    xs: g(spec.exitShort),
    stop: spec.stop,
    target: spec.target,
  });
}

// --------------------------------------------------------------- library ---

/** Distinct versions backtested on this market and timeframe. */
export function versionsTried(library: readonly RunSummary[], symbol: string, timeframe: string): number {
  const seen = new Set<string>();
  for (const r of library) if (r.symbol === symbol && r.timeframe === timeframe) seen.add(r.fingerprint);
  return seen.size;
}

/** Share of lines two versions have in common (Jaccard over their sentences). */
export function overlap(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

/** Below this share of lines in common, an earlier run is not "similar". */
export const SIMILAR_MIN = 0.5;

/**
 * Earlier versions sharing at least half their lines with these, newest run
 * of each, most similar first. The current version itself is excluded — it is
 * not "similar", it is this.
 */
export function similarRuns(
  library: readonly RunSummary[],
  lines: readonly string[],
  current: string | null,
  limit = 3,
): { run: RunSummary; overlap: number }[] {
  const latest = new Map<string, RunSummary>();
  for (const r of library) {
    if (r.fingerprint === current) continue;
    const prev = latest.get(r.fingerprint);
    if (!prev || r.at >= prev.at) latest.set(r.fingerprint, r);
  }
  return [...latest.values()]
    .map((run) => ({ run, overlap: overlap(lines, run.lines) }))
    .filter((x) => x.overlap >= SIMILAR_MIN)
    .sort((a, b) => b.overlap - a.overlap || b.run.at - a.run.at)
    .slice(0, limit);
}

// ----------------------------------------------------------- persistence ---

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readStop(v: unknown): StopSpec | null {
  if (!isObj(v)) return null;
  if (v["type"] === "atr" && isNum(v["mult"])) return { type: "atr", mult: v["mult"] };
  if (v["type"] === "pct" && isNum(v["value"])) return { type: "pct", value: v["value"] };
  return null;
}

function readTarget(v: unknown): TargetSpec | null {
  if (!isObj(v)) return null;
  if (v["type"] === "none") return { type: "none" };
  if ((v["type"] === "rr" || v["type"] === "pct") && isNum(v["value"])) return { type: v["type"], value: v["value"] };
  return null;
}

/**
 * One stored line, or null. The column and operator are checked against the
 * vocabulary: a line naming an indicator a later build removed is DROPPED on
 * load rather than taking the desk down — the same policy as the Playbook's
 * stored rules.
 */
export function readLine(v: unknown): RuleLine | null {
  if (!isObj(v) || !isStr(v["id"])) return null;
  const author = v["author"];
  if (author !== "ai" && author !== "you") return null;
  const id = v["id"];
  if (v["kind"] === "cond") {
    const section = v["section"];
    const c = v["cond"];
    if (!SECTIONS.includes(section as Section)) return null;
    if (!Array.isArray(c) || c.length !== 3 || !c.every(isStr)) return null;
    const [l, op, r] = c as [string, string, string];
    if (!Object.prototype.hasOwnProperty.call(COLUMNS, l)) return null;
    if (!Object.prototype.hasOwnProperty.call(OPERATORS, op)) return null;
    return { id, author, kind: "cond", section: section as Section, cond: [l, op, r] as unknown as Condition };
  }
  if (v["kind"] === "stop") {
    const stop = readStop(v["stop"]);
    return stop ? { id, author, kind: "stop", stop } : null;
  }
  if (v["kind"] === "target") {
    const target = readTarget(v["target"]);
    return target ? { id, author, kind: "target", target } : null;
  }
  return null;
}

function readSummary(v: unknown): RunSummary | null {
  if (!isObj(v)) return null;
  const { at, fingerprint: fp, name, lines, symbol, timeframe, bars, trades, expectancyR, oosExpectancyR, oosTrades } = v;
  if (!isNum(at) || !isStr(fp) || !isStr(name) || !Array.isArray(lines) || !lines.every(isStr)) return null;
  if (!isStr(symbol) || !isStr(timeframe) || !isNum(bars) || !isNum(trades) || !isNum(expectancyR)) return null;
  if (!(oosExpectancyR === null || isNum(oosExpectancyR)) || !isNum(oosTrades)) return null;
  return {
    at,
    fingerprint: fp,
    name,
    lines: lines as string[],
    symbol,
    timeframe,
    bars,
    trades,
    expectancyR,
    oosExpectancyR: oosExpectancyR as number | null,
    oosTrades,
  };
}

function readDecision(v: unknown): DecisionRecord | null {
  if (!isObj(v)) return null;
  const { at, kind, name, fingerprint: fp, lines, reason, symbol, timeframe, result } = v;
  if (!isNum(at) || !(kind === "iterate" || kind === "paper" || kind === "discard")) return null;
  if (!isStr(name) || !isStr(fp) || !Array.isArray(lines) || !lines.every(isStr) || !isStr(reason)) return null;
  if (!isStr(symbol) || !isStr(timeframe)) return null;
  return { at, kind, name, fingerprint: fp, lines: lines as string[], reason, symbol, timeframe, result: readSummary(result) };
}

export function readFlow(v: unknown): FlowState | null {
  if (!isObj(v) || !isObj(v["draft"])) return null;
  const d = v["draft"];
  const lines = Array.isArray(d["lines"]) ? d["lines"].map(readLine).filter((l): l is RuleLine => l !== null) : [];
  const p = d["paper"];
  const paper: PaperMark | null =
    isObj(p) && isNum(p["since"]) && isStr(p["fingerprint"]) ? { since: p["since"], fingerprint: p["fingerprint"] } : null;
  const draft: Draft = {
    id: isStr(d["id"]) ? d["id"] : emptyDraft().id,
    name: isStr(d["name"]) ? d["name"] : "",
    lines,
    paper,
  };
  const chat = Array.isArray(v["chat"])
    ? v["chat"].filter(
        (c): c is ChatLine =>
          isObj(c) && (c["who"] === "you" || c["who"] === "ai" || c["who"] === "note") && isStr(c["text"]) && isNum(c["at"]),
      )
    : [];
  const library = Array.isArray(v["library"])
    ? v["library"].map(readSummary).filter((r): r is RunSummary => r !== null)
    : [];
  const decisions = Array.isArray(v["decisions"])
    ? v["decisions"].map(readDecision).filter((r): r is DecisionRecord => r !== null)
    : [];
  return { draft, chat, library, decisions };
}

export const FLOW_SLOT: Slot<FlowState> = {
  key: "strategy.flow",
  version: 1,
  fallback: emptyFlow,
  validate: readFlow,
};

/** Append, keeping the newest `cap`. */
export const capped = <T>(list: readonly T[], item: T, cap: number): T[] => [...list, item].slice(-cap);
