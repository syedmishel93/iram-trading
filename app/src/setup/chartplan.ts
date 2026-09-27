/**
 * The trade plan, drawn on the chart.
 *
 * WHY. The terminal computed an entry zone, a stop and two targets for every
 * setup and showed them only as numbers in the inspector. "Which area should I
 * enter" is a question about a PLACE on the chart, and a price in a table has
 * to be found on the axis by eye before it means anything. Drawn, the zone and
 * the levels sit on the structure they came from.
 *
 * WHAT IT REFUSES. A plan the gates do not clear is still drawn — the levels
 * are real, and knowing where the trade WOULD be is how you watch it — but
 * dashed, and labelled "(not live)" on the chart itself, so a screenshot of
 * the chart alone cannot be mistaken for an actionable plan. `armed` is live:
 * the gates pass and price has not reached the zone yet, which is exactly the
 * moment the zone is most worth seeing.
 *
 * No plan, no shapes. There is no fallback drawing of "the nearest level",
 * for the reason in "NO SETUP, NO PLAN" in ui/shell.ts.
 */

import type { Shape } from "../detect/types";
import type { VerdictKind } from "./gates";
import type { TradePlan } from "./plan";

/** How many bars back from the live edge the drawing starts. */
export const PLAN_LOOKBACK = 12;

const LIVE: ReadonlySet<VerdictKind> = new Set<VerdictKind>(["go", "armed"]);

export function planShapes(plan: TradePlan | null, atBar: number, kind: VerdictKind): Shape[] {
  if (plan === null || !(atBar >= 0)) return [];
  const live = LIVE.has(kind);
  const dashed = !live;
  const suffix = live ? "" : " (not live)";
  const x0 = Math.max(0, atBar - PLAN_LOOKBACK);
  return [
    {
      type: "box",
      x0,
      x1: atBar,
      y0: Math.min(plan.entryLow, plan.entryHigh),
      y1: Math.max(plan.entryLow, plan.entryHigh),
      tone: "accent",
      label: `Entry zone${suffix}`,
      extend: true,
      dashed,
    },
    /* The stop is where the plan LOSES and the targets where it pays, whichever
       way the trade faces — so the tones follow the outcome, not the side. */
    { type: "level", x0, y: plan.stop, tone: "bear", label: "Stop", dashed },
    { type: "level", x0, y: plan.target1, tone: "bull", label: "Target 1", dashed },
    { type: "level", x0, y: plan.target2, tone: "bull", label: "Target 2", dashed },
  ];
}
