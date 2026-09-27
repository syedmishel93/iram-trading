/**
 * Can a strategy the terminal FOUND be armed on the server?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT WAS CHECKED, AND WHAT IT TURNED OUT TO BE
 *
 * There are two server-side things that watch a market with the terminal shut,
 * and neither was written for a `RuleSpec`:
 *
 *   `/svc/sig/watch` → `sig_loop` (`server/svc/signals.py`) stores a strategy
 *   NAME and hands it to `server/sig_worker.js`, which extracts `sigScan` from
 *   the FROZEN root `index.html` and evaluates the built-in strategies by that
 *   name. There is no path by which a spec — conditions, columns, a stop, a
 *   target — reaches it. Arming there would store a row that matches no
 *   strategy the worker knows, and `sig_loop` would silently never fire it.
 *
 *   `/svc/alerts` → `alert_loop` (`server/svc/alerts.py`) stores
 *   `(sym, op, price)` and compares ONE yfinance quote with ONE number every
 *   `MISHEL_ALERT_SEC`. That is a real, working, always-on evaluator — of a
 *   price threshold, and of nothing else.
 *
 * So this module asks the only answerable question: is this rule's ENTRY a
 * single price threshold? When it is, the alert loop evaluates exactly the
 * same condition the backtest did and arming is honest. When it is not — which
 * is every rule in `specs.ts`, all of which read indicators — the answer is a
 * refusal that NAMES the gap, and the desk disables the button rather than
 * arming something weaker than the strategy and calling it armed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT AN ARMED ALERT IS NOT, EVEN WHEN IT IS EXACT
 *
 * It is the entry, and only the entry. The stop, the target and the exit rule
 * are not sent anywhere and nothing enforces them; the row fires ONCE and is
 * never re-armed (`alert_loop` sets `fired` and stops looking); and the price
 * it reads is a yfinance quote, which may be ~15 minutes behind the chart and
 * is not the broker's. `armedNote` says all of that, and the caller is expected
 * to put it on screen rather than in a tooltip.
 */

import { COLUMNS, OPERATORS, conditionText, parseOperand, type Condition, type RuleSpec } from "./rules";
import type { AlertOp } from "../data/pricealerts";

/** Columns the server's quote IS. Everything else needs an indicator it has not got. */
const PRICE_COLUMNS: ReadonlySet<string> = new Set(["close", "open", "high", "low"]);

/** Where an armed alert reaches the operator, stated once. */
export const ARM_WHERE =
  "It is checked on the server every 30 seconds with the terminal closed, and reaches you as a Telegram message if " +
  "the bot is connected in Settings. The fire is recorded either way — the Price alerts card lists it.";

export const ARM_LIMITS =
  "An armed alert is the ENTRY only: the stop, the target and the exit rule are not sent anywhere and nothing " +
  "enforces them. It fires once and is not re-armed. The price is a yfinance quote, which may be ~15 minutes behind " +
  "the chart and is not your broker's.";

/**
 * The reason `sig_loop` cannot take a spec. Quoted wherever a refusal is shown,
 * because "the server cannot arm this" without the mechanism is a dead end.
 */
export const SIG_WORKER_WHY =
  "The server's signal worker only knows the built-in strategies by name — it reads them out of the frozen terminal " +
  "— so it cannot evaluate a rule written here. That leaves the price-alert loop, which is the only server-side " +
  "evaluator a rule from this shelf can reach.";

export type Armable =
  | {
      readonly ok: true;
      readonly op: AlertOp;
      readonly price: number;
      /** The condition as English, for the alert's note and the screen. */
      readonly condition: string;
      readonly note: string;
    }
  | { readonly ok: false; readonly why: string };

const opFor = (id: Condition[1]): AlertOp | null =>
  id === ">" || id === ">=" ? "above" : id === "<" || id === "<=" ? "below" : null;

/**
 * Whether this rule's entry can be armed as a server price alert — and if not,
 * the true reason, naming what the rule asks for and what the loop has.
 */
export function armable(spec: RuleSpec): Armable {
  const no = (why: string): Armable => ({ ok: false, why: `${why} ${SIG_WORKER_WHY}` });

  if (spec.short && spec.short.length > 0) {
    return no(
      "This rule trades both ways, and a price alert is one threshold in one direction. Arming only its long side " +
        "would arm something weaker than the strategy and report it as armed.",
    );
  }

  const long = spec.long;
  if (long.length === 0) return no("This rule has no entry conditions, so there is nothing to watch for.");
  if (long.length > 1) {
    return no(
      `The server's alert loop compares one quote with one number. This rule's entry is ${long.length} conditions ` +
        `that must all hold on the same closed bar (${long.map(conditionText).join("; ")}), and the loop cannot ` +
        `evaluate the other ${long.length - 1}.`,
    );
  }

  const cond = long[0] as Condition;
  const [column, operator, operand] = cond;

  if (!PRICE_COLUMNS.has(column)) {
    return no(
      `This rule's entry is measured on ${COLUMNS[column] ?? column}, and the server's alert loop has only a price ` +
        "— it computes no indicators.",
    );
  }

  const op = opFor(operator);
  if (op === null) {
    return no(
      `This rule's entry asks whether ${COLUMNS[column] ?? column} ${OPERATORS[operator] ?? operator} something, ` +
        "which is a comparison between two bars. The alert loop reads the latest quote and keeps no previous one, so " +
        "it cannot tell a crossing from a level that was already true.",
    );
  }

  const right = parseOperand(operand);
  if (right === null) {
    return no(`The rule's threshold (${String(operand)}) is neither a number nor an indicator this build knows.`);
  }
  if (right.kind === "column") {
    return no(
      `This rule's entry compares ${COLUMNS[column] ?? column} with ${COLUMNS[right.id]}, not with a number. The ` +
        "alert loop holds one quote and one stored number, and has no second series to compare it against.",
    );
  }
  const price = right.value;
  if (!(price > 0)) {
    return no(`The threshold is ${price}, and the alert service stores prices above zero only.`);
  }

  return {
    ok: true,
    op,
    price,
    condition: conditionText(cond),
    note: `${spec.name} — ${conditionText(cond)} (armed from the terminal's own search; unproven)`,
  };
}
