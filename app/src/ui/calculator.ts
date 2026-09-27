/**
 * The Trade Calculator desk.
 *
 * The broker-style calculator: an account, an instrument, a trade and a cost
 * model in; lots, pips, margin and the profit that survives costs out. It was
 * in the previous terminal, it was not in this one, and its absence is the gap
 * that matters most — the Risk desk sizes in units against a percentage, which
 * is the right tool for spot crypto and the wrong one for anything quoted in
 * lots and pips.
 *
 * WHY THE RESULTS COLUMN LEADS WITH LOT SIZE
 * Every other figure here is a consequence. The lot size is the decision, and
 * it is the number people come to a calculator to get — so it is the largest
 * thing on the desk, with the size you actually typed next to it and the
 * difference between them stated rather than left to be noticed.
 *
 * WHY PIP VALUE IS SHOWN WITH ITS DERIVATION ATTACHED
 * Pip value is the hinge: recommended lots is `risk / (stopPips × pipValue)`,
 * so an error there is an error in the position. For most instruments it is
 * exact arithmetic. For three it is derived from the price you typed. For seven
 * it needs a rate nothing here fetched. Those are three different levels of
 * confidence in the same number and the desk prints which one is in force,
 * because a figure that is sometimes exact and sometimes assumed must say
 * which, every time.
 */

import { h } from "./dom";
import { createCostCard } from "./cards/costcard";
import { pkWhy } from "./panelkit";
import { accountField, type AccountStore } from "../core/account";
import { signal, computed, renderEffect, type Signal } from "../core/signal";
import type { KV } from "../store/kv";
import {
  INSTRUMENTS,
  CLASS_LABEL,
  CROSS_RATE_SYMBOL,
  findInstrument,
  needsCrossRate,
  type AssetClass,
  type InstrumentSpec,
} from "../risk/instruments";
import { calculate, type CalcResult, type CostModel } from "../risk/calculator";

export interface CalculatorOptions {
  /** The one owner of balance, equity, leverage and risk. */
  readonly account: AccountStore;
  /** The symbol on the chart, so the desk can follow what you are looking at. */
  readonly symbol: () => string;
  /** Last traded price on the chart, for the "Last" buttons. */
  readonly lastPrice: () => number;
  readonly kv: KV;
}

interface Saved {
  symbol: string;
  balance: number;
  equity: number;
  leverage: number;
  riskPct: number;
  spreadPips: number;
  commissionPerLot: number;
  swapPerNight: number;
  nights: number;
  slippagePips: number;
  crossRate: number;
}

const DEFAULTS: Saved = {
  symbol: "EURUSD",
  balance: 10_000,
  equity: 10_000,
  leverage: 100,
  riskPct: 1,
  spreadPips: 0,
  commissionPerLot: 0,
  swapPerNight: 0,
  nights: 0,
  slippagePips: 0,
  crossRate: 0,
};

const SLOT = {
  key: "calculator.v1",
  version: 1,
  fallback: (): Saved => ({ ...DEFAULTS }),
  validate: (v: unknown): Saved | null => {
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const out = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Saved)[]) {
      const got = o[k];
      if (k === "symbol") {
        if (typeof got === "string") out.symbol = got;
      } else if (typeof got === "number" && Number.isFinite(got)) {
        (out[k] as number) = got;
      }
    }
    return out;
  },
};

const money = (n: number): string => {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
};

/**
 * Render a list into a container and keep it in step with its source.
 *
 * A reactive slot in `h()` resolves to ONE node, so a list has to be mounted
 * through a ref. Rebuilding the whole container is right here: these lists are
 * a handful of rows that change only when an input changes, and a keyed
 * reconciler would be more machinery than the problem has.
 */
const list = (cls: string, rows: () => HTMLElement[]) =>
  h("div", {
    class: cls,
    ref: (el: HTMLElement) =>
      renderEffect(() => {
        el.textContent = "";
        for (const r of rows()) el.appendChild(r);
      }),
  });

const num = (n: number, dp = 2): string => (Number.isFinite(n) ? n.toFixed(dp) : "—");

/** Enough decimals to show a pip of this instrument, and no more. */
function priceDecimals(spec: InstrumentSpec): number {
  const s = spec.pip.toExponential();
  const exp = Number(s.slice(s.indexOf("e") + 1));
  return Math.max(0, Math.min(10, -exp));
}

export function createCalculator(opts: CalculatorOptions) {
  const stored = opts.kv.read(SLOT).value;

  const symbol = signal(stored.symbol);
  /**
   * Balance, equity, leverage and risk are VIEWS over the shared account, not
   * local copies.
   *
   * They used to be four `signal(stored.x)` reads out of `calculator.v1`, while
   * the Risk desk held its own equity and riskPct in `risk.config`. Setting your
   * equity on one desk left the other sizing off a stale number with nothing on
   * screen saying so. See `core/account.ts`.
   */
  const balance = accountField(opts.account, "balance");
  const equity = accountField(opts.account, "equity");
  const leverage = accountField(opts.account, "leverage");
  const riskPct = accountField(opts.account, "riskPct");
  const direction = signal<"buy" | "sell">("buy");
  const entry = signal(0);
  const stop = signal(0);
  const target = signal(0);
  const lots = signal(0.1);
  const crossRate = signal(stored.crossRate);

  const spreadPips = signal(stored.spreadPips);
  const commissionPerLot = signal(stored.commissionPerLot);
  const swapPerNight = signal(stored.swapPerNight);
  const nights = signal(stored.nights);
  const slippagePips = signal(stored.slippagePips);

  const persist = (): void => {
    opts.kv.write(SLOT, {
      symbol: symbol(),
      balance: balance(),
      equity: equity(),
      leverage: leverage(),
      riskPct: riskPct(),
      spreadPips: spreadPips(),
      commissionPerLot: commissionPerLot(),
      swapPerNight: swapPerNight(),
      nights: nights(),
      slippagePips: slippagePips(),
      crossRate: crossRate(),
    });
  };

  const spec = computed<InstrumentSpec>(
    () => findInstrument(symbol()) ?? INSTRUMENTS[0] as InstrumentSpec,
  );

  const costs = computed<CostModel>(() => ({
    spreadPips: spreadPips(),
    commissionPerLot: commissionPerLot(),
    swapPerNight: swapPerNight(),
    nights: nights(),
    slippagePips: slippagePips(),
  }));

  const result = computed<CalcResult>(() => {
    const s = spec();
    const tp = target();
    const rate = crossRate();
    return calculate({
      spec: s,
      balance: balance(),
      equity: equity(),
      leverage: leverage(),
      riskPct: riskPct(),
      direction: direction(),
      entry: entry(),
      stop: stop(),
      ...(tp > 0 ? { takeProfit: tp } : {}),
      lots: lots(),
      ...(rate > 0 ? { crossRate: rate } : {}),
      costs: costs(),
    });
  });

  // ------------------------------------------------------------- fields ---

  const numField = (
    label: string,
    sig: Signal<number>,
    hint?: string,
    extra?: { step?: string; suffix?: string },
  ) =>
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", text: label }),
      h("input", {
        class: "field-input num",
        type: "number",
        step: extra?.step ?? "any",
        value: () => String(sig()),
        oninput: (e: Event) => {
          sig.set(Number((e.target as HTMLInputElement).value) || 0);
          persist();
        },
      }),
      hint ? h("div", { class: "field-hint", text: hint }) : null,
    );

  /** A price field with a button that takes the last price off the chart. */
  const priceField = (label: string, sig: Signal<number>, hint: string) =>
    h(
      "div",
      { class: "field" },
      h("label", { class: "field-label", text: label }),
      h(
        "div",
        { class: "risk-inline" },
        h("input", {
          class: "field-input num",
          type: "number",
          step: "any",
          value: () => String(sig()),
          oninput: (e: Event) => sig.set(Number((e.target as HTMLInputElement).value) || 0),
        }),
        h("button", {
          class: "ghost-btn tiny",
          type: "button",
          text: "Last",
          title: "The last traded price on the chart",
          onclick: () => {
            const p = opts.lastPrice();
            if (p > 0) sig.set(Number(p.toFixed(priceDecimals(spec()))));
          },
        }),
      ),
      h("div", { class: "field-hint", text: hint }),
    );

  const instrumentPicker = h(
    "div",
    { class: "field" },
    h("label", { class: "field-label", text: "Instrument" }),
    h(
      "div",
      { class: "risk-inline" },
      h(
        "select",
        {
          class: "field-input",
          value: () => symbol(),
          onchange: (e: Event) => {
            symbol.set((e.target as HTMLSelectElement).value);
            persist();
          },
        },
        ...(Object.keys(CLASS_LABEL) as AssetClass[]).map((cls) =>
          h(
            "optgroup",
            { label: CLASS_LABEL[cls] },
            ...INSTRUMENTS.filter((i) => i.cls === cls).map((i) =>
              h("option", { value: i.symbol, text: `${i.symbol} — ${i.name}` }),
            ),
          ),
        ),
      ),
      h("button", {
        class: "ghost-btn tiny",
        type: "button",
        text: "Chart",
        title: "Use the instrument currently on the chart, if this table knows it",
        onclick: () => {
          const found = findInstrument(opts.symbol());
          if (found) {
            symbol.set(found.symbol);
            persist();
          }
        },
      }),
    ),
    h("div", {
      class: "field-hint",
      /* The lookup is deliberately loud about failing. Silently leaving the old
         instrument selected while the chart shows another one is how you size a
         trade against the wrong contract. */
      text: () =>
        findInstrument(opts.symbol())
          ? `The chart is on ${opts.symbol()}.`
          : `${opts.symbol()} is not in the specification table — pick the closest match, or use Custom fields on a broker sheet.`,
    }),
  );

  const specLine = h("div", {
    class: "calc-spec",
    text: () => {
      const s = spec();
      return `contract ${s.contractSize.toLocaleString()} ${s.base}  ·  pip ${s.pip}  ·  quoted in ${s.quote}`;
    },
  });

  const crossField = h(
    "div",
    {
      class: "field calc-cross",
      "data-need": () => String(needsCrossRate(spec())),
    },
    h("label", {
      class: "field-label",
      text: () => `${CROSS_RATE_SYMBOL[spec().quote] ?? "Conversion"} rate`,
    }),
    h("input", {
      class: "field-input num",
      type: "number",
      step: "any",
      value: () => String(crossRate()),
      oninput: (e: Event) => {
        crossRate.set(Number((e.target as HTMLInputElement).value) || 0);
        persist();
      },
    }),
    h("div", {
      class: "field-hint",
      text: () =>
        `${spec().name} settles in ${spec().quote}, so a pip is not a dollar. ` +
        "Nothing here fetches this rate — type the one your broker is using.",
    }),
  );

  // ------------------------------------------------------------ results ---

  const stat = (k: string, v: () => string, tone?: () => string, title?: string) =>
    h(
      "div",
      { class: "calc-stat", ...(tone ? { "data-tone": tone } : {}), ...(title ? { title } : {}) },
      h("span", { class: "calc-stat-k", text: k }),
      h("span", { class: "calc-stat-v num", text: v }),
    );

  const row = (k: string, v: () => string, tone?: () => string) =>
    h(
      "div",
      { class: "calc-row", ...(tone ? { "data-tone": tone } : {}) },
      h("span", { class: "calc-row-k", text: k }),
      h("span", { class: "calc-row-v num", text: v }),
    );

  const blockedNote = h(
    "div",
    { class: "calc-blocked", "data-on": () => String(!result().ok) },
    h("div", { class: "calc-blocked-title", text: "No numbers" }),
    h("div", { class: "calc-blocked-body", text: () => result().blocked ?? "" }),
  );

  const headline = h(
    "div",
    { class: "calc-headline", "data-on": () => String(result().ok) },
    h(
      "div",
      { class: "calc-hero" },
      h("span", { class: "calc-hero-k", text: "Lot size your rule allows" }),
      h("span", {
        class: "calc-hero-v num",
        text: () => num(result().recommendedLots, 3),
      }),
      h("span", {
        class: "calc-hero-note",
        text: () => {
          const r = result();
          if (!r.ok) return "";
          if (!Number.isFinite(r.recommendedLots)) return "";
          return `${riskPct()}% of ${money(balance())} is ${money(r.riskAmount)} at a ${num(r.stopPips, 1)} pip stop.`;
        },
      }),
    ),
    h(
      "div",
      { class: "calc-hero-cmp", "data-tone": () => (result().withinRisk ? "pos" : "neg") },
      h("span", { class: "calc-hero-k", text: "The size you entered" }),
      h("span", { class: "calc-hero-v num", text: () => num(lots(), 3) }),
      h("span", {
        class: "calc-hero-note",
        text: () => {
          const r = result();
          if (!r.ok) return "";
          return `risks ${money(r.actualRisk)} — ${num(r.actualRiskPct, 2)}% of the balance`;
        },
      }),
    ),
  );

  const pipPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "What a pip is worth here" }),
    h("div", { class: "calc-pip" },
      h("span", { class: "calc-pip-v num", text: () => money(result().pipValue) }),
      h("span", { class: "calc-pip-k", text: "per pip, per lot" }),
    ),
    h("p", {
      class: "pf-hint",
      /* The three confidence levels, named. This is the sentence that stops the
         number being read as uniformly exact when for seven instruments it is
         a rate somebody typed in. */
      text: () => {
        const b = result().pipBasis;
        const s = spec();
        switch (b.kind) {
          case "quote-usd":
            return `Exact: ${s.pip} × ${s.contractSize.toLocaleString()} units, and ${s.quote} is the dollar. Nothing is assumed.`;
          case "base-usd":
            return `Exact, but it MOVES: ${s.symbol} quotes ${s.quote} per USD, so this is ${s.pip} × ${s.contractSize.toLocaleString()} ÷ ${b.price}. Change the entry and this changes.`;
          case "cross":
            return `Converted at ${b.rateSymbol} = ${b.rate}, a rate you supplied. Nothing here fetched or checked it, and every dollar figure on this desk moves with it.`;
          default:
            return `Needs the ${b.rateSymbol} rate before any dollar figure can be computed.`;
        }
      },
    }),
  );

  const tradePanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "The trade" }),
    stat("Stop distance", () => `${num(result().stopPips, 1)} pips`),
    stat("Target distance", () => (Number.isFinite(result().targetPips) ? `${num(result().targetPips, 1)} pips` : "no target")),
    stat(
      "Reward : risk",
      () => num(result().rr, 2),
      () => {
        const rr = result().rr;
        if (!Number.isFinite(rr)) return "";
        return rr >= 2 ? "pos" : rr >= 1 ? "" : "neg";
      },
      "Before costs. The figure that decides anything is the one after them, below.",
    ),
    stat("Risk budget", () => money(result().riskAmount)),
    stat("Loss if the stop trades", () => money(-result().grossLoss), () => "neg"),
    stat("Win if the target trades", () => money(result().grossProfit), () => "pos"),
  );

  const marginPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "What it ties up" }),
    row("Position notional", () => money(result().notional)),
    row("Margin required", () => money(result().margin)),
    row("Free margin left", () => money(result().freeMargin), () => (result().freeMargin < 0 ? "neg" : "")),
    row(
      "Margin level",
      () => (Number.isFinite(result().marginLevel) ? `${num(result().marginLevel, 0)}%` : "—"),
      () => {
        const m = result().marginLevel;
        if (!Number.isFinite(m)) return "";
        return m >= 200 ? "pos" : m >= 100 ? "" : "neg";
      },
    ),
    pkWhy(
      "Notional is converted to dollars through the same rate as the pip value, which is why it is right for pairs where USD is the base — one lot of USD/JPY ties up $100,000, not the yen equivalent.",
    ),
  );

  const costPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "What it costs, and what survives" }),
    row("Spread", () => money(result().costBreakdown.spread)),
    row("Commission (both sides)", () => money(result().costBreakdown.commission)),
    row("Swap", () => money(result().costBreakdown.swap)),
    row("Slippage", () => money(result().costBreakdown.slippage)),
    row("Total round trip", () => money(result().costBreakdown.total), () => "neg"),
    h("div", { class: "calc-divide" }),
    row("Net win at target", () => money(result().netProfit), () => "pos"),
    row("Net loss at stop", () => money(-result().netLoss), () => "neg"),
    row(
      "Reward : risk after costs",
      () => num(result().netRr, 2),
      () => {
        const rr = result().netRr;
        if (!Number.isFinite(rr)) return "";
        return rr >= 2 ? "pos" : rr >= 1 ? "" : "neg";
      },
    ),
    row("Move needed to break even", () => `${num(result().breakEvenPips, 1)} pips`),
    row(
      "Costs as a share of the win",
      () => (Number.isFinite(result().costShareOfWin) ? `${num(result().costShareOfWin, 1)}%` : "—"),
    ),
  );

  const ladderPanel = h(
    "section",
    { class: "dd-panel" },
    h("h3", { class: "pf-sub", text: "Where the R multiples sit" }),
    pkWhy(
      "The stop distance, stepped away from the entry. These are arithmetic, not levels — nothing here has looked at the chart to decide whether price is likely to reach them.",
      "Arithmetic, not levels",
    ),
    list("calc-ladder", () => {
      const r = result();
      const dp = priceDecimals(spec());
      return r.rLevels.map((l) =>
        h(
          "div",
          { class: "calc-ladder-row" },
          h("span", { class: "calc-ladder-r", text: `${l.r}R` }),
          h("span", { class: "calc-ladder-px num", text: l.price.toFixed(dp) }),
          h("span", { class: "calc-ladder-pnl num", text: money(l.r * r.grossLoss) }),
        ),
      );
    }),
  );

  /* WHAT THE BROKER ACTUALLY CHARGES, as against what a BACKTEST assumes.
     Distinct from `costPanel` above, which prices the trade in the form —
     `tsc` caught me reusing that name, which is the honest reason this one is
     spelled out. `/svc/costs` had no caller anywhere in the frontend, and the
     assumption it contradicts decides which strategies survive a search:
     measured, three to five times the real spread on this broker. */
  const brokerCostPanel = createCostCard().el;

  const noticesPanel = h(
    "section",
    { class: "dd-panel calc-notices", "data-on": () => String(result().warnings.length + result().assumptions.length > 0) },
    list("calc-warn-list", () =>
      result().warnings.map((w) =>
        h("div", { class: "calc-warn" }, h("span", { class: "calc-warn-dot" }), h("span", { text: w })),
      ),
    ),
    list("calc-assume-list", () =>
      result().assumptions.map((a) => h("div", { class: "calc-assume", text: a })),
    ),
  );

  const el = h(
    "div",
    { class: "dd calc-desk" },
    h(
      "div",
      { class: "desk-head" },
      h("h1", { class: "view-title", text: "Trade calculator" }),
      h("p", {
        class: "view-sub",
        text: "Lots, pips, margin, and the profit that survives costs. Arithmetic on your numbers — it does not choose a trade and it cannot place one.",
      }),
    ),
    h(
      "div",
      { class: "calc-grid" },
      h(
        "div",
        { class: "calc-col-inputs" },
        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Account" }),
          numField("Balance", balance, "Risk per trade is a percent of this."),
          numField("Equity", equity, "Drives free margin and the margin level."),
          numField("Leverage 1:", leverage, "Your account leverage, as your broker states it.", { step: "1" }),
          numField("Risk per trade %", riskPct, "Yours to choose. Nothing here suggests a number."),
        ),
        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Instrument" }),
          instrumentPicker,
          specLine,
          crossField,
        ),
        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Trade" }),
          h(
            "div",
            { class: "field" },
            h("label", { class: "field-label", text: "Direction" }),
            h(
              "div",
              { class: "calc-dir" },
              h("button", {
                class: "calc-dir-btn",
                type: "button",
                text: "Buy",
                "data-on": () => String(direction() === "buy"),
                onclick: () => direction.set("buy"),
              }),
              h("button", {
                class: "calc-dir-btn",
                type: "button",
                text: "Sell",
                "data-on": () => String(direction() === "sell"),
                onclick: () => direction.set("sell"),
              }),
            ),
          ),
          priceField("Entry", entry, "The price you expect to get, not the one you want."),
          priceField("Stop loss", stop, "Below the entry for a buy, above it for a sell."),
          priceField("Take profit", target, "Optional. Without it there is no reward figure."),
          numField("Lot size", lots, "What you intend to trade, for comparison against the recommendation."),
        ),
        h(
          "section",
          { class: "dd-panel" },
          h("h3", { class: "pf-sub", text: "Broker costs" }),
          h("p", {
            class: "pf-hint",
            text: "Left at zero these are not free — they are unfilled, and the desk says so beside the results.",
          }),
          numField("Spread (pips)", spreadPips),
          numField("Commission per lot, per side", commissionPerLot),
          numField("Swap per lot, per night", swapPerNight, "Negative if your broker credits it."),
          numField("Nights held", nights, undefined, { step: "1" }),
          numField("Slippage (pips)", slippagePips),
        ),
      ),
      h(
        "div",
        { class: "calc-col-results" },
        blockedNote,
        headline,
        pipPanel,
        tradePanel,
        marginPanel,
        costPanel,
        brokerCostPanel,
        ladderPanel,
        noticesPanel,
      ),
    ),
  );

  return { el, result, symbol, entry, stop, lots };
}
