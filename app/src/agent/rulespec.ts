/**
 * A rule set, as a language model writes it.
 *
 * WHY THIS IS NOT JUST `validateSpec`
 * `validateSpec` in backtest/rules.ts checks a value that is already a
 * `RuleSpec` — its columns, its operators, its stop. A tool input is `unknown`:
 * JSON a model produced, which may be missing `long`, may carry a condition of
 * two elements, may write the threshold `30` as a number where the vocabulary
 * wants the string `"30"`. Handing that straight to `validateSpec` would throw
 * on `spec.long.length` before it could name what was wrong, and a thrown
 * TypeError is useless to a model trying to correct itself.
 *
 * So this is the boundary: shape first, with every problem named by path, then
 * the terminal's own validator, verbatim. The two lists are concatenated and
 * returned whole so the model can fix everything in one retry instead of one
 * problem per round trip.
 *
 * WHAT IT DOES NOT DO
 * It never repairs a rule. A missing stop is reported, not defaulted: a default
 * the model did not choose would be tested and reported as its strategy.
 */

import {
  COLUMNS,
  OPERATORS,
  validateSpec,
  type Condition,
  type ConditionGroup,
  type RuleSpec,
  type SpecProblem,
  type StopSpec,
  type TargetSpec,
} from "../backtest/rules";

export type ParsedSpec =
  | { readonly ok: true; readonly spec: RuleSpec }
  | { readonly ok: false; readonly problems: readonly SpecProblem[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const COLUMN_IDS = Object.keys(COLUMNS);
const OPERATOR_IDS = Object.keys(OPERATORS);

/**
 * The tool's input schema, derived from the vocabulary rather than restated.
 *
 * Column and operator lists are read from `COLUMNS` and `OPERATORS`, so a
 * column added to the rule language appears here without anyone remembering
 * to add it — and a model is never offered a column the evaluator lacks.
 */
export function ruleSpecSchema(): {
  readonly type: "object";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[];
} {
  const condition = {
    type: "array",
    minItems: 3,
    maxItems: 3,
    items: { type: "string" },
    description:
      "One condition: [column, operator, value]. column is one of the column ids; operator is one of " +
      `${OPERATOR_IDS.join(", ")}; value is another column id or a number written as a string, e.g. "30".`,
  };
  const group = (what: string): Record<string, unknown> => ({
    type: "array",
    items: condition,
    description: `${what} All conditions in the list must hold on the same closed bar (AND). An empty list never fires.`,
  });
  return {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name for the rule set." },
      long: group("Enter LONG when every condition holds."),
      short: group("Optional. Enter SHORT when every condition holds (checked only if long did not fire)."),
      exitLong: group("Optional. Close a long early when every condition holds."),
      exitShort: group("Optional. Close a short early when every condition holds."),
      stop: {
        type: "object",
        description:
          'Required. {"type":"atr","mult":2} puts the stop 2 x ATR(14) from entry; {"type":"pct","value":1.5} puts it 1.5% from entry.',
        properties: {
          type: { type: "string", enum: ["atr", "pct"] },
          mult: { type: "number", description: "ATR multiple, for type atr." },
          value: { type: "number", description: "Percent distance, for type pct." },
        },
        required: ["type"],
      },
      target: {
        type: "object",
        description:
          'Required. {"type":"rr","value":2} targets 2 x the risk; {"type":"pct","value":3} targets 3% from entry; {"type":"none"} exits only on the stop or the exit rule.',
        properties: {
          type: { type: "string", enum: ["rr", "pct", "none"] },
          value: { type: "number" },
        },
        required: ["type"],
      },
      note: { type: "string", description: "Optional. What the rule is trying to capture." },
    },
    required: ["long", "stop", "target"],
  };
}

/** Column ids, for the tool description. */
export const RULE_COLUMN_IDS: readonly string[] = COLUMN_IDS;

function readGroup(raw: unknown, where: string, problems: SpecProblem[]): ConditionGroup | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    problems.push({ where, message: "Must be a list of [column, operator, value] conditions." });
    return undefined;
  }
  const out: Condition[] = [];
  raw.forEach((cond: unknown, i) => {
    const at = `${where}[${i}]`;
    if (!Array.isArray(cond) || cond.length !== 3) {
      problems.push({ where: at, message: "A condition must be exactly [column, operator, value]." });
      return;
    }
    const [l, op, r] = cond as readonly unknown[];
    if (typeof l !== "string" || typeof op !== "string") {
      problems.push({ where: at, message: "The column and the operator must be strings." });
      return;
    }
    /* A number where the vocabulary wants a numeric STRING is the one
       coercion made, because it is lossless: 30 and "30" are the same
       threshold. Anything else is reported. */
    const right = typeof r === "number" && Number.isFinite(r) ? String(r) : r;
    if (typeof right !== "string") {
      problems.push({ where: at, message: "The value must be a column id or a number." });
      return;
    }
    /* Cast, not check: `validateSpec` below names an unknown column or
       operator with the terminal's own wording, which is the point of
       calling it rather than duplicating it here. */
    out.push([l, op, right] as unknown as Condition);
  });
  return out;
}

function readStop(raw: unknown, problems: SpecProblem[]): StopSpec | null {
  if (!isObj(raw)) {
    problems.push({ where: "stop", message: 'A stop is required, e.g. {"type":"atr","mult":2}. None is assumed.' });
    return null;
  }
  if (raw["type"] === "atr") {
    const mult = raw["mult"] ?? raw["value"];
    if (typeof mult !== "number") {
      problems.push({ where: "stop", message: "An ATR stop needs a numeric mult." });
      return null;
    }
    return { type: "atr", mult };
  }
  if (raw["type"] === "pct") {
    if (typeof raw["value"] !== "number") {
      problems.push({ where: "stop", message: "A percent stop needs a numeric value." });
      return null;
    }
    return { type: "pct", value: raw["value"] };
  }
  problems.push({ where: "stop.type", message: `"${String(raw["type"])}" is not a stop type. Use "atr" or "pct".` });
  return null;
}

function readTarget(raw: unknown, problems: SpecProblem[]): TargetSpec | null {
  if (!isObj(raw)) {
    problems.push({ where: "target", message: 'A target is required — {"type":"none"} if the rule exits only on its stop or exit rule.' });
    return null;
  }
  const t = raw["type"];
  if (t === "none") return { type: "none" };
  if (t === "rr" || t === "pct") {
    const v = raw["value"];
    if (typeof v !== "number" || !(v > 0)) {
      problems.push({ where: "target", message: `A "${t}" target needs a positive numeric value.` });
      return null;
    }
    return { type: t, value: v };
  }
  problems.push({ where: "target.type", message: `"${String(t)}" is not a target type. Use "rr", "pct" or "none".` });
  return null;
}

/**
 * `unknown` → a `RuleSpec` the engine can compile, or every problem found.
 *
 * `validateSpec`'s messages are appended VERBATIM — they are the terminal's
 * own wording, the same the Playbook editor shows.
 */
export function parseRuleSpec(raw: unknown): ParsedSpec {
  const problems: SpecProblem[] = [];
  if (!isObj(raw)) {
    return { ok: false, problems: [{ where: "spec", message: "The rule set must be a JSON object." }] };
  }

  const long = readGroup(raw["long"], "long", problems) ?? [];
  const short = readGroup(raw["short"], "short", problems);
  const exitLong = readGroup(raw["exitLong"], "exitLong", problems);
  const exitShort = readGroup(raw["exitShort"], "exitShort", problems);
  const stop = readStop(raw["stop"], problems);
  const target = readTarget(raw["target"], problems);
  const name = typeof raw["name"] === "string" && raw["name"].trim() ? raw["name"].trim() : "Analyst draft";
  const note = typeof raw["note"] === "string" && raw["note"].trim() ? raw["note"].trim() : undefined;

  if (stop === null || target === null) return { ok: false, problems };

  const spec: RuleSpec = {
    id: "analyst-draft",
    name,
    style: "custom",
    long,
    ...(short !== undefined ? { short } : {}),
    ...(exitLong !== undefined ? { exitLong } : {}),
    ...(exitShort !== undefined ? { exitShort } : {}),
    stop,
    target,
    ...(note !== undefined ? { note } : {}),
  };
  problems.push(...validateSpec(spec));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, spec };
}
