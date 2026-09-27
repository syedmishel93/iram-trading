/**
 * THE SEARCH FIELD — which rule was tried in which state, and what cleared.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE QUESTION IS ALREADY BIPARTITE
 *
 * "Does this rule work in this STATE" puts rules on one side and market states
 * on the other with one arm per pair, which is a graph before anyone draws it.
 * `backtest/conditioned.ts` built its ids parseable for precisely this reason —
 * "`mc:<base>+<state>` — parseable, so a survivor can be traced to its pair".
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THE PICTURE HAS TO SAY, AND IT IS NOT GOOD NEWS
 *
 * Measured on this archive: deepening it from 42 days to 5 years took the median
 * arm from 58 trades to 821, dropped the hurdle from +0.450 to +0.102 — and the
 * best arm FELL from +0.374 to +0.070. ZERO of 69 deep arms cleared. That is the
 * most important result this project has produced, and a picture that drew all
 * 150 arms identically would turn it into decoration. So the sign of `deflated`
 * is the edge's value, and an arm that missed is drawn as missing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE HURDLE IS READ, NEVER RECOMPUTED
 *
 * Every row recorded the hurdle it actually had to clear, and that depends on
 * how wide the field was when it won. Re-deriving one now would judge an old row
 * against today's search — and the width of this field has already changed
 * twice. `study/stats.ts deflatedSharpe` is deliberately NOT imported here.
 */

import type { Discovered } from "../backtest/discovered";
import type { GraphEdge, GraphNode } from "./layout";

/** The prefix `conditionedId` writes. */
const PREFIX = "mc:";
const JOIN = "+";

/**
 * Read a conditioned id back to the pair that made it.
 *
 * SPLITS ON THE LAST SEPARATOR. A base rule id may itself contain a `+`, and
 * splitting on the first would cut the rule in half and invent a state out of
 * its own tail — an opaque key parsed by guessing, which this project already
 * records as a defect worth refusing over. Anything that is not the expected
 * shape returns null rather than being repaired.
 */
export function splitConditionedId(
  id: string,
): { readonly rule: string; readonly state: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const body = id.slice(PREFIX.length);
  const cut = body.lastIndexOf(JOIN);
  if (cut <= 0 || cut === body.length - 1) return null;
  return { rule: body.slice(0, cut), state: body.slice(cut + 1) };
}

export interface FieldSummary {
  /** Arms that could be placed on the picture. */
  readonly arms: number;
  /** Of those, how many beat the hurdle their own search set. */
  readonly cleared: number;
  /** Rows with no state to pair — a plain library rule. Counted, not hidden. */
  readonly unpaired: number;
  readonly why: string;
}

export interface FieldGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly summary: FieldSummary;
}

/**
 * Every kept arm, as a rule joined to the state it was tried in.
 *
 * The edge's value is the arm's DEFLATED Sharpe — what was left after the
 * best-of-N hurdle — so its SIGN is "did this beat what the search would have
 * found in nothing". Positive cleared; zero or below did not, which on this
 * archive is all of them.
 */
export function fieldGraph(rows: readonly Discovered[]): FieldGraph {
  const ruleArms = new Map<string, number>();
  const stateArms = new Map<string, number>();
  const edges: GraphEdge[] = [];
  let unpaired = 0;
  let cleared = 0;

  for (const r of rows) {
    const pair = splitConditionedId(r.spec.id);
    if (pair === null) {
      /* A LIBRARY RULE HAS NO STATE. Placing it somewhere on the state side
         would invent the very thing this picture is measuring. */
      unpaired += 1;
      continue;
    }
    ruleArms.set(pair.rule, (ruleArms.get(pair.rule) ?? 0) + 1);
    stateArms.set(pair.state, (stateArms.get(pair.state) ?? 0) + 1);
    const deflated = Number.isFinite(r.deflated) ? r.deflated : 0;
    if (deflated > 0) cleared += 1;
    edges.push({
      from: pair.rule,
      to: pair.state,
      /* Signed, and bounded so one freak arm cannot make every other edge
         hairline. The sign is the finding; the magnitude is the margin. */
      value: Math.max(-1, Math.min(1, deflated)),
      /* Trades are the only lever that lowers a hurdle, so a thin arm is a
         weaker claim whichever way it went. */
      confidence: Math.min(1, Math.max(0.15, r.trades / 500)),
    });
  }

  const maxRule = Math.max(1, ...ruleArms.values());
  const maxState = Math.max(1, ...stateArms.values());

  const nodes: GraphNode[] = [
    ...[...ruleArms.entries()].map(([id, n]) => ({
      id,
      label: id,
      group: "rule",
      /* SIZE IS HOW MANY ARMS IT SPENT. A search pays per arm, so a rule tried
         in six states cost six times as much of the hurdle as one tried once. */
      weight: n / maxRule,
    })),
    ...[...stateArms.entries()].map(([id, n]) => ({
      id,
      label: id,
      group: "state",
      weight: n / maxState,
    })),
  ];

  const arms = edges.length;
  const why =
    arms === 0
      ? unpaired > 0
        ? `nothing on the shelf was conditioned on a market state — ${unpaired} rule${unpaired === 1 ? "" : "s"} were kept without one`
        : "nothing has been kept yet, so there is no field to draw"
      : `${arms} arm${arms === 1 ? "" : "s"} over ${ruleArms.size} rule${ruleArms.size === 1 ? "" : "s"} and ` +
        `${stateArms.size} state${stateArms.size === 1 ? "" : "s"}. ` +
        `${cleared} beat the hurdle its own search set. ` +
        `Every arm added raises that hurdle for all of them, so a wider field needs a better winner to mean the same thing.`;

  return { nodes, edges, summary: { arms, cleared, unpaired, why } };
}
