/**
 * WHAT THE BROKER CHARGES, AGAINST WHAT THE BACKTEST ASSUMES.
 *
 * On the Calculator desk, whose own subtitle promises cost-adjusted P&L — the
 * question this answers is "am I being charged what I think I am", and that is
 * a calculator question rather than a system one.
 *
 * WHY IT LEADS WITH THE RATIO
 *
 * `DEFAULT_COSTS` charges a flat 2bp spread on every instrument. MEASURED
 * against this operator's broker, that is three to five times the real spread —
 * and because costs set the hurdle a strategy has to clear, the effect is not
 * harmless conservatism. It discards rules that would have cleared the real
 * spread, silently, with nothing on screen to say why. So the multiple is the
 * headline and the per-symbol table is the working.
 *
 * IT REPORTS, IT DOES NOT OVERWRITE. A figure that changed under the operator
 * because a background service answered would be worse than a disagreement they
 * can see — the stance the risk sizer's broker cross-check already takes.
 *
 * AND IT REFUSES PER ROW. A spread in points cannot be compared to a fraction
 * of price without the price, so a symbol with no live quote says so and is
 * excluded from the headline rather than being counted at a guess. That is the
 * rule a risk desk learned the hard way: a row whose unit is not KNOWN is
 * excluded and the total is labelled a floor.
 */

import { each, h } from "../dom";
import { signal, computed } from "../../core/signal";
import { pkWhy } from "../panelkit";
import { onShown } from "./shown";
import { brokerCosts, compareCost, type BrokerSpec, type CostComparison } from "../../data/brokercosts";
import { loadBrokerQuote } from "../../data/brokerquote";

/** The engine's assumed spread, as a fraction of price. */
const ASSUMED_SPREAD = 0.0002;

export function createCostCard(): { readonly el: HTMLElement; refresh(): void } {
  const rows = signal<readonly CostComparison[]>([]);
  /** Null until asked. `false` would claim the service is absent before asking. */
  const reachable = signal<boolean | null>(null);
  const why = signal("");
  const note = signal("");

  const refresh = (): void => {
    void brokerCosts().then(async (a) => {
      if (a.kind === "offline") {
        reachable.set(false);
        why.set(a.why);
        return;
      }
      reachable.set(true);
      why.set("");
      note.set(a.value.note ?? "");

      /* One spec per instrument, not per broker spelling. The sync files each
         spec under BOTH the canonical name and the suffixed one (`XAUUSD` and
         `XAUUSD.s`), so listing the raw keys would show every instrument twice
         with identical numbers. */
      const seen = new Set<string>();
      const specs: BrokerSpec[] = [];
      for (const s of Object.values(a.value.specs ?? {})) {
        const canon = (s.symbol || "").split(".")[0]?.toUpperCase() ?? "";
        if (!canon || seen.has(canon)) continue;
        seen.add(canon);
        specs.push(s);
      }

      const out = await Promise.all(
        specs.map(async (s) => {
          const canon = (s.symbol || "").split(".")[0] ?? s.symbol;
          /* THE PRICE ONLY. The live quote also carries a spread, and it is
             the more honest number for "what would I pay right now" — but it
             moves second to second, and this card is about a STANDING
             assumption. So the spec's nominal spread is what is compared, and
             the quote supplies only the price the points convert against. */
          let px = 0;
          try {
            const q = await loadBrokerQuote(canon);
            if (q.ok && Number.isFinite(q.bid) && Number.isFinite(q.ask)) {
              px = (q.bid + q.ask) / 2;
            }
          } catch {
            px = 0;
          }
          return compareCost({ ...s, symbol: canon }, px, ASSUMED_SPREAD);
        }),
      );
      out.sort((x, y) => (y.ratio ?? 0) - (x.ratio ?? 0));
      rows.set(out);
    });
  };

  /** Only the rows whose units are known. A guess is not averaged in. */
  const known = computed(() => rows().filter((r) => r.ratio !== null));

  const headline = (): string => {
    if (reachable() === null) return "Reading the broker's contract spec…";
    if (reachable() === false) return "Could not ask";
    const k = known();
    if (k.length === 0) {
      return rows().length > 0 ? "No live prices yet" : "No broker spec imported";
    }
    const ratios = k.map((r) => r.ratio as number).sort((a, b) => a - b);
    const lo = ratios[0] as number;
    const hi = ratios[ratios.length - 1] as number;
    if (hi <= 1.15 && lo >= 0.85) return "Costs look right";
    return lo === hi
      ? `${lo.toFixed(1)}x the real spread`
      : `${lo.toFixed(1)}–${hi.toFixed(1)}x the real spread`;
  };

  const sub = (): string => {
    if (reachable() === false) return why();
    const k = known();
    if (k.length === 0) {
      if (rows().length > 0) {
        /* Distinct from "no spec": the specs are here, the prices are not. */
        return "The contract spec is here but no live price is, so the two cannot be put in the same units.";
      }
      return note() || "Run the MT5 bridge so sizing and costs use the broker's real numbers.";
    }
    const over = k.filter((r) => r.verdict === "over").length;
    const under = k.filter((r) => r.verdict === "under").length;
    if (under > 0) {
      return (
        `Backtests charge LESS than this broker on ${under} of ${k.length} instruments. ` +
        `That flatters every result: nothing you could actually have traded was that cheap.`
      );
    }
    if (over === 0) return `Measured on ${k.length} instruments. The assumption matches closely enough to leave alone.`;
    return (
      `Backtests charge 2 basis points on everything. On ${over} of ${k.length} instruments this broker is cheaper, ` +
      `so the search is rejecting rules that would have cleared the real spread.`
    );
  };

  const row = (r: CostComparison): HTMLElement =>
    h(
      "div",
      { class: "bc-row", "data-verdict": r.verdict },
      h("span", { class: "bc-sym", text: r.symbol }),
      h("span", {
        class: "bc-n num",
        text: r.measuredBp === null ? "—" : `${r.measuredBp.toFixed(2)} bp`,
      }),
      h("span", { class: "bc-n bc-assumed num", text: `${r.assumedBp.toFixed(2)} bp` }),
      h("span", {
        class: "bc-ratio num",
        text: r.ratio === null ? "—" : `${r.ratio.toFixed(1)}x`,
      }),
      /* The refusal travels with the row it is about. */
      h("span", { class: "bc-why", text: r.ratio === null ? r.why : "" }),
    ) as HTMLElement;

  const list = h("div", { class: "bc-rows" }) as HTMLElement;
  /* `each`, never a hand-rolled function child — one that throws takes the
     whole list with it, silently. */
  each(list, () => [...rows()], (r) => r.symbol, row);

  const el = h(
    "section",
    { class: "dd-panel bc" },
    h("h3", { class: "pf-sub", text: "What your broker charges, against what the backtest assumes" }),

    h(
      "div",
      {
        class: "bc-head",
        "data-level": () => {
          if (reachable() === null) return "none";
          if (reachable() === false) return "unknown";
          const k = known();
          if (k.length === 0) return "unknown";
          if (k.some((r) => r.verdict === "under")) return "bad";
          return k.some((r) => r.verdict === "over") ? "attn" : "ok";
        },
      },
      h("div", { class: "bc-headline", text: headline }),
      h("p", { class: "bc-sub", text: sub }),
    ),

    h(
      "div",
      { class: "bc-rows bc-head-row", "data-on": () => String(rows().length > 0) },
      h(
        "div",
        { class: "bc-row bc-th" },
        h("span", { text: "" }),
        h("span", { class: "num", text: "Broker" }),
        h("span", { class: "num", text: "Assumed" }),
        h("span", { class: "num", text: "Ratio" }),
        h("span", { text: "" }),
      ),
    ),
    list,

    pkWhy(
      "A cost model is a hurdle, so an assumed cost is an assumed conclusion — these numbers decide which rules " +
        "survive a search. The backtester charges a flat 2 basis points of spread on every instrument; this reads " +
        "the spread your broker actually quotes, in points, and converts it using the live price. Nothing here " +
        "changes what the backtester does: a figure that moved under you because a service answered would be worse " +
        "than a disagreement you can see. A symbol with no live price is excluded rather than counted at a guess, " +
        "because a spread in points and a fraction of price are different units.",
      "Why the spread decides which strategies survive",
    ),
  ) as HTMLElement;

  refresh();
  onShown(el, refresh);
  return { el, refresh };
}
