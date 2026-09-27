/**
 * "Can I trade now?" — the risk governor's answer, as one line.
 *
 * The server already decides (`mishel_risk.evaluate`, served by
 * `/svc/risk/state`); this card only SAYS it. The decision is never
 * recomputed here: the headline follows `verdict`, and the rows below show
 * the four counters the decision was made from, each against its limit, so
 * the answer can be checked by eye.
 *
 * WHAT IT REFUSES TO DO
 * - Show a green answer when the service did not answer. Offline is its own
 *   state, and a poll that fails after a good one REPLACES the good one — a
 *   stale "Yes" is the most dangerous thing this card could print.
 * - Print 0.0R of open risk when the broker cannot be read. The server sends
 *   0.0 in that case because it summed nothing; `parseGov` turns it into null
 *   and this card prints "unknown".
 *
 * WORDS
 * The server's reasons are written as paragraphs in capitals. Each becomes
 * one plain line that still names its number and its limit, and the full
 * sentence moves behind "Why?" — moved, not deleted (CLAUDE.md, v59).
 *
 * The title ("Can I trade now?") belongs to the dock's card head, not here.
 */

import { signal } from "../../core/signal";
import { h } from "../dom";
import { pkChip, pkEmpty, pkRows, pkWhy, type PkRow } from "../panelkit";
import { loadGov, type GovReason, type GovResult, type GovState } from "../../data/riskgov";
import { isShown, onShown } from "./shown";

/** How often the card asks again while it is on screen. */
export const GOV_POLL_MS = 30_000;

export type GovTone = "pos" | "neg" | "attn" | "mute";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** R to two places, with its sign — a day's result reads as a result. */
const signedR = (v: number): string => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`;
/** A limit: as few places as it needs ("3", "2.5"). */
const lim = (v: number): string => String(Math.round(v * 100) / 100);

/** A reason's first sentence, for a rule this build does not know by name. */
function firstSentence(msg: string): string {
  const s = (msg.split(/(?<=[.!?])\s|\s—\s/)[0] ?? msg).trim().replace(/[.:]$/, "");
  const plain = s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s;
  return plain.length > 80 ? `${plain.slice(0, 79)}…` : plain;
}

/**
 * One plain line for a server reason, carrying its number and its limit.
 *
 * Keyed on `rule` and `level`, the two fields `evaluate` sets for machines;
 * `msg` is read only to tell the three `blind` reasons apart, and as the
 * fallback for a rule added after this was written.
 */
export function govShortReason(r: GovReason, g: GovState): string {
  const L = g.limits;
  switch (r.rule) {
    case "unprotected": {
      const n = g.unprotected.length;
      return `${plural(n, "open position")} with no stop${n > 0 ? ` (${g.unprotected.join(", ")})` : ""}`;
    }
    case "daily_loss":
      return r.level === "block"
        ? `daily loss limit hit: ${signedR(g.realizedRToday)}R of −${lim(L.maxDailyLossR)}R`
        : `${signedR(g.realizedRToday)}R today, near your −${lim(L.maxDailyLossR)}R daily limit`;
    case "cooldown":
      return r.level === "block"
        ? `${g.consecutiveLosses} losses in a row — ${L.cooldownMinutes} min cooldown`
        : `${g.consecutiveLosses} losses in a row; the cooldown is over`;
    case "trade_count":
      return `${g.tradesToday} trades today, limit ${L.maxTradesPerDay}`;
    case "open_risk":
      return `open risk over your ${lim(L.maxOpenRiskR)}R cap`;
    case "concentration":
      return r.level === "block"
        ? `too much on one currency (cap ${lim(L.maxConcentrationR)}R)`
        : `one currency near its ${lim(L.maxConcentrationR)}R cap`;
    case "per_trade":
      return `one trade risks more than your ${lim(L.maxRiskPerTradePct)}% rule`;
    case "coverage":
      return "some positions are not checked for currency overlap";
    case "blind":
      if (r.msg.startsWith("OPEN POSITIONS UNKNOWN")) return "open positions unknown — broker not reachable";
      if (r.msg.startsWith("No account equity")) return "no account balance to check sizes against";
      return `${r.msg.split(" ")[0] ?? "a position"}: risk unknown, not counted`;
    case "ok":
      return "within every limit";
    default:
      return firstSentence(r.msg);
  }
}

/** Reasons that are not the "all clear" line. */
const concerns = (g: GovState): GovReason[] => g.reasons.filter((r) => r.level !== "allow");

/**
 * The one line. Follows the SERVER's verdict, never the numbers: a block
 * reason inside a WARN verdict (an unprotected position with
 * `block_when_unprotected` off) reads as a warning, because that is what the
 * governor decided.
 */
export function govHeadline(r: GovResult): { readonly text: string; readonly tone: GovTone } {
  if (r.state === "offline") return { text: "The risk service is not answering.", tone: "mute" };
  const g = r.value;
  switch (g.verdict) {
    case "block": {
      const first = g.reasons.find((x) => x.level === "block");
      return { text: `No — ${first ? govShortReason(first, g) : "the risk governor says no"}`, tone: "neg" };
    }
    case "warn":
      return { text: `Careful — ${plural(concerns(g).length, "warning")}`, tone: "attn" };
    case "allow":
      return { text: "Yes — within your limits", tone: "pos" };
  }
}

/**
 * The four counters, each "value / limit". Tone follows STANDING against the
 * limit — at or past it is neg, inside the server's own early-warning band is
 * attn — never the size of the number.
 */
export function govRows(g: GovState): PkRow[] {
  const L = g.limits;
  const dayLim = -L.maxDailyLossR;

  let open: PkRow;
  if (g.openRiskR === null) {
    open = { label: "Open risk", value: `unknown / ${lim(L.maxOpenRiskR)} R`, tone: "attn", hint: "The broker is not reachable, so open positions cannot be read. Unknown is not zero." };
  } else {
    const over = g.openRiskR > L.maxOpenRiskR;
    open = {
      label: "Open risk",
      value: `${g.openRiskIsFloor ? "≥ " : ""}${g.openRiskR.toFixed(2)} / ${lim(L.maxOpenRiskR)} R`,
      ...(g.openRiskIsFloor ? { note: "some positions not counted" } : {}),
      ...(over ? { tone: "neg" as const } : g.openRiskIsFloor ? { tone: "attn" as const } : {}),
    };
  }

  const dayTone = g.realizedRToday <= dayLim ? "neg" : g.realizedRToday <= dayLim * 0.7 ? "attn" : undefined;
  const today: PkRow = {
    label: "Today",
    value: `${signedR(g.realizedRToday)} / −${lim(L.maxDailyLossR)} R`,
    ...(g.ungradedToday > 0 ? { note: `${plural(g.ungradedToday, "trade")} not graded, left out` } : {}),
    ...(dayTone ? { tone: dayTone } : {}),
    hint: "R realized today on graded trades, against your daily loss limit.",
  };

  const trades: PkRow = {
    label: "Trades today",
    value: `${g.tradesToday} / ${L.maxTradesPerDay}`,
    ...(g.tradesToday >= L.maxTradesPerDay ? { tone: "neg" as const } : {}),
  };

  const losses: PkRow = {
    label: "Losses in a row",
    value: `${g.consecutiveLosses} / ${L.consecutiveLossLimit}`,
    ...(g.consecutiveLosses >= L.consecutiveLossLimit ? { tone: "neg" as const } : {}),
    hint: `At the limit, a ${L.cooldownMinutes} min cooldown starts.`,
  };

  /* Paired for the two-column layout: Open risk | Trades today, Today | Losses. */
  return [open, trades, today, losses];
}

/** A chip beside the headline when the answer rests on less than the broker. */
function sourceChip(g: GovState): HTMLElement | null {
  if (g.positionSourceError !== null) return pkChip("book unknown", "attn");
  if (g.equitySource.startsWith("manual")) return pkChip("typed balance", "attn");
  return null;
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function renderResult(r: GovResult | null, checkedAt: number | null): HTMLElement {
  if (r === null) return pkEmpty("loading", "Asking the risk governor…");

  const head = govHeadline(r);
  if (r.state === "offline") {
    return h(
      "div",
      { class: "gov-body" },
      h("p", { class: "gov-head", "data-tone": head.tone, text: head.text }),
      pkWhy(r.reason, "Why?"),
    ) as HTMLElement;
  }

  const g = r.value;
  const chip = sourceChip(g);
  const list = concerns(g);
  return h(
    "div",
    { class: "gov-body", "data-verdict": g.verdict },
    h("div", { class: "gov-top" }, h("p", { class: "gov-head", "data-tone": head.tone, text: head.text }), chip),
    h("div", { class: "gov-rows" }, pkRows(govRows(g))),
    list.length === 0
      ? null
      : h(
          "ul",
          { class: "gov-reasons" },
          ...list.map((x) =>
            h(
              "li",
              { class: "gov-reason", "data-level": x.level },
              h("span", { class: "gov-reason-text", text: govShortReason(x, g) }),
              pkWhy(x.msg, "Why?"),
            ),
          ),
        ),
    h("p", {
      class: "gov-foot",
      text: `Limits: the server's risk governor${checkedAt === null ? "" : ` · ${clock(checkedAt)}`}`,
    }),
  ) as HTMLElement;
}

/**
 * The card body. Asks once on creation, then every 30 s while it is in the
 * document — a detached card (dock closed, card collapsed) skips its turn
 * rather than polling for nobody. `refresh()` asks now.
 */
export function createGovCard(): { readonly el: HTMLElement; refresh(): void } {
  /* One signal for the answer and when it came, so one poll is one render. */
  const view = signal<{ readonly result: GovResult | null; readonly at: number | null }>({ result: null, at: null });
  let inflight = false;

  const refresh = (): void => {
    if (inflight) return;
    inflight = true;
    void loadGov()
      .then((r) => view.set({ result: r, at: r.state === "ok" ? Date.now() : null }))
      .finally(() => {
        inflight = false;
      });
  };

  const el = h("div", { class: "gov-card" }, () => renderResult(view().result, view().at)) as HTMLElement;

  /* Polls only while drawn — see `./shown.ts` — and refreshes on coming back. */
  setInterval(() => {
    if (isShown(el)) refresh();
  }, GOV_POLL_MS);
  onShown(el, refresh);
  refresh();

  return { el, refresh };
}
